// Binary packet envelope for Sai Talk offline mesh (protocol v1).
// Header (26 bytes):  0 ver | 1 type | 2 flags | 3 ttl* | 4 hops* | 5-8 eventId | 9-10 channelId | 11 keyId
//                     12-15 senderId | 16-19 streamId | 20-21 seq | 22-25 tsMs (ms since stream start)
// Bytes marked * change in transit and are NOT covered by authentication (see docs/SECURITY.md).
export const VERSION = 1;
export const T = { HELLO: 1, STREAM_START: 2, AUDIO: 3, CTRL: 4, ACK: 5 };
export const F = { END: 1, RELAY: 2, ACKREQ: 4 };
export const HEADER_LEN = 26, MAX_TTL = 6, MAX_PACKET = 1200;
export const CODEC = { opus: 1, ulaw: 2 };

export function encodeHeader(h) {
  const b = new Uint8Array(HEADER_LEN), v = new DataView(b.buffer);
  b[0] = VERSION; b[1] = h.type; b[2] = h.flags | 0; b[3] = Math.min(h.ttl ?? MAX_TTL, MAX_TTL); b[4] = h.hops | 0;
  v.setUint32(5, h.eventId >>> 0); v.setUint16(9, h.channelId & 0xffff); b[11] = h.keyId & 0xff;
  v.setUint32(12, h.senderId >>> 0); v.setUint32(16, h.streamId >>> 0); v.setUint16(20, h.seq & 0xffff); v.setUint32(22, h.tsMs >>> 0);
  return b;
}
export function decodeHeader(b) {
  if (!(b instanceof Uint8Array) || b.length < HEADER_LEN || b.length > MAX_PACKET) return null;
  if (b[0] !== VERSION) return null;
  const type = b[1]; if (type < 1 || type > 5) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { ver: b[0], type, flags: b[2], ttl: b[3], hops: b[4], eventId: v.getUint32(5), channelId: v.getUint16(9), keyId: b[11],
    senderId: v.getUint32(12), streamId: v.getUint32(16), seq: v.getUint16(20), tsMs: v.getUint32(22) };
}
// Authenticated part of the header (everything except ttl/hops).
export function authHeader(b) { const o = new Uint8Array(HEADER_LEN - 2); o[0] = b[0]; o[1] = b[1]; o[2] = b[2]; o.set(b.subarray(5, HEADER_LEN), 3); return o; }
export function withHop(b) { const o = b.slice(); o[3] = Math.max(0, o[3] - 1); o[4] = Math.min(255, o[4] + 1); return o; }
export const concat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

// STREAM_START body: codec(1) rateDiv10(2) frameMs(1) bundle(1) expirySecs(4) cert(CERT_LEN) sig(64)
export const CERT_LEN = 143, SIG_LEN = 64, SS_FIXED = 9;
export function encodeStreamStartBody(o) {
  const b = new Uint8Array(SS_FIXED), v = new DataView(b.buffer);
  b[0] = o.codec; v.setUint16(1, Math.round(o.rate / 10)); b[3] = o.frameMs; b[4] = o.bundle; v.setUint32(5, o.expiry >>> 0); return b;
}
export function decodeStreamStartBody(b) {
  if (b.length !== SS_FIXED + CERT_LEN + SIG_LEN) return null; const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { codec: b[0], rate: v.getUint16(1) * 10, frameMs: b[3], bundle: b[4], expiry: v.getUint32(5), fixed: b.slice(0, SS_FIXED), cert: b.slice(SS_FIXED, SS_FIXED + CERT_LEN), sig: b.slice(SS_FIXED + CERT_LEN) };
}
// AUDIO body (before encryption): n(1) then n x [len(1) data]. Encrypted body = ciphertext + 12-byte tag.
export function packFrames(frames) { if (frames.length > 8) throw new Error('bundle'); const parts = [Uint8Array.of(frames.length)]; for (const f of frames) { if (f.length > 255) throw new Error('frame'); parts.push(Uint8Array.of(f.length), f); } return concat(...parts); }
export function unpackFrames(b) {
  if (!b.length) return null; const n = b[0]; let p = 1; const out = []; if (n > 8) return null;
  for (let i = 0; i < n; i++) { if (p >= b.length) return null; const l = b[p++]; if (p + l > b.length) return null; out.push(b.slice(p, p + l)); p += l; }
  return p === b.length ? out : null;
}
export const TAG_BYTES = 12;
