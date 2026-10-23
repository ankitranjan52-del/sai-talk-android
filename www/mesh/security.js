// Offline security for Sai Talk mesh. Uses WebCrypto only (browser, Node 22, Capacitor webview).
//  - Server (online, ahead of the event) signs a short-lived DEVICE CERTIFICATE for each staff device (ECDSA P-256).
//  - Server hands each member the CHANNEL KEY (random 256 bit, per channel, with expiry) over the authenticated TLS API.
//  - Each talk burst: STREAM_START is signed by the device key (sender authenticity), audio frames are AES-GCM sealed with
//    a per-stream key HKDF(channelKey, sender, stream) (confidentiality + outsider rejection).
//  - Nothing permanent is in the app bundle: only the server PUBLIC key is trusted, delivered with the credentials.
import { authHeader, concat } from './packet.js';
const subtle = globalThis.crypto.subtle, te = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export async function generateDeviceKey() {
  const kp = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicRaw: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) };
}
export const importPublic = (raw) => subtle.importKey('raw', raw, ECDSA, true, ['verify']);
export const sign = async (priv, data) => new Uint8Array(await subtle.sign(SIGN, priv, data));
export const verify = (pub, sig, data) => subtle.verify(SIGN, pub, sig, data).catch(() => false);

// Certificate (143 bytes): ver(1) eventId(4) userId(4) flags(1) expirySecs(4) pubRaw(65) sig(64)
export const CERT_FLAG_RELAY = 1;
export function certBody({ eventId, userId, flags, exp, pubRaw }) {
  const b = new Uint8Array(14 + 65), v = new DataView(b.buffer); b[0] = 1; v.setUint32(1, eventId >>> 0); v.setUint32(5, userId >>> 0); b[9] = flags; v.setUint32(10, exp >>> 0); b.set(pubRaw, 14); return b;
}
export async function signCert(serverPriv, fields) { const body = certBody(fields); return concat(body, await sign(serverPriv, body)); }
// Returns {eventId,userId,flags,exp,pubRaw} or null. nowMs from device clock; skewMs tolerated.
export async function verifyCert(cert, serverPub, { nowMs, eventId, skewMs = 120000 }) {
  if (!(cert instanceof Uint8Array) || cert.length !== 143 || cert[0] !== 1) return null;
  const body = cert.subarray(0, 79), sig = cert.subarray(79); const v = new DataView(cert.buffer, cert.byteOffset, cert.byteLength);
  if (!(await verify(serverPub, sig, body))) return null;
  const c = { eventId: v.getUint32(1), userId: v.getUint32(5), flags: cert[9], exp: v.getUint32(10), pubRaw: cert.slice(14, 79) };
  if (eventId != null && c.eventId !== (eventId >>> 0)) return null;
  if (c.exp * 1000 + skewMs < nowMs) return null;                 // expired
  return c;
}

// ---- audio sealing ----
export async function importChannelKey(raw32) { return subtle.importKey('raw', raw32, 'HKDF', false, ['deriveKey']); }
export async function deriveStreamKey(channelKey, senderId, streamId) {
  const info = new Uint8Array(8), v = new DataView(info.buffer); v.setUint32(0, senderId >>> 0); v.setUint32(4, streamId >>> 0);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('sai-talk-v1'), info }, channelKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const nonce = (seq) => { const n = new Uint8Array(12); new DataView(n.buffer).setUint32(8, seq >>> 0); return n; };   // unique per stream key
export async function seal(streamKey, headerBytes, seq, plaintext) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(seq), additionalData: authHeader(headerBytes), tagLength: 96 }, streamKey, plaintext));
}
export async function open(streamKey, headerBytes, seq, ciphertext) {
  try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(seq), additionalData: authHeader(headerBytes), tagLength: 96 }, streamKey, ciphertext)); } catch { return null; }
}

// ---- replay protection ----
// A stream is identified by (sender, streamId). Streams must start inside the clock-skew window and expire; per-stream a
// sliding 64-packet window rejects repeated/old sequence numbers. State is bounded and evicted by expiry.
export class ReplayGuard {
  constructor({ maxStreams = 512, now = Date.now } = {}) { this.s = new Map(); this.max = maxStreams; this.now = now; }
  startStream(senderId, streamId, expiryMs) {
    this.sweep(); const k = senderId + ':' + streamId; if (this.s.has(k)) return false;   // replayed STREAM_START
    if (this.s.size >= this.max) return false; this.s.set(k, { exp: expiryMs, hi: -1, mask: 0n }); return true;
  }
  accept(senderId, streamId, seq) {
    const st = this.s.get(senderId + ':' + streamId); if (!st || st.exp < this.now()) return false;
    if (st.hi < 0) { st.hi = seq; st.mask = 1n; return true; }
    const d = (seq - st.hi) & 0xffff;
    if (d === 0) return false;
    if (d < 0x8000) { st.mask = ((st.mask << BigInt(d)) | 1n) & ((1n << 64n) - 1n); st.hi = seq; return true; }
    const back = (st.hi - seq) & 0xffff; if (back >= 64) return false; const bit = 1n << BigInt(back);
    if (st.mask & bit) return false; st.mask |= bit; return true;
  }
  sweep() { const n = this.now(); for (const [k, v] of this.s) if (v.exp < n) this.s.delete(k); }
}
