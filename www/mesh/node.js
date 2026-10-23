// MeshNode: one phone's offline stack = PeerLink (native radio) + security + router + floor control.
// It talks to the platform only through the PeerLink contract (see transport.js), so Android/iOS native code can be swapped in.
import { T, F, CODEC, HEADER_LEN, MAX_TTL, encodeHeader, decodeHeader, authHeader, concat, CERT_LEN, SIG_LEN, SS_FIXED,
  encodeStreamStartBody, decodeStreamStartBody, packFrames, unpackFrames, TAG_BYTES } from './packet.js';
import { sign, verify, verifyCert, importPublic, deriveStreamKey, seal, open, ReplayGuard, CERT_FLAG_RELAY } from './security.js';
import { MeshRouter } from './router.js';
import { FloorArbiter, MAX_MS } from './arbitration.js';

const rnd32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
export class MeshNode {
  // creds: {eventId, userId, cert(Uint8Array 143), serverPub(CryptoKey), devicePriv(CryptoKey), channels: Map<channelId,{keyId,key(HKDF CryptoKey)}>, isRelay}
  constructor({ creds, link, now = Date.now, timer = (ms, f) => setTimeout(f, ms), rng = Math.random, cfg = {} }) {
    this.c = creds; this.link = link; this.now = now; this.timer = timer; this.id = creds.userId; this.ev = new Map();
    this.router = new MeshRouter({ selfId: this.id, isRelay: creds.isRelay, now, rng, timer, cfg, send: (peer, bytes) => this.link.send(peer, bytes) });
    this.replay = new ReplayGuard({ now }); this.arb = new FloorArbiter({ now, selfId: this.id }); this.certs = new Map(); this.streams = new Map();
    this.busy = 0; this.pend = new Map(); this.helloSeq = 0; this.stats = { rxBad: 0, rxAuthFail: 0, rxReplay: 0, rxWrongEvent: 0, rxOk: 0, tx: 0 };
    link.onReceive = (peer, bytes, rssi) => this.#rx(peer, bytes, rssi); link.onPeerDown = (p) => { this.router.onNeighborDown(p); this.emit('peers', this.router.neighbors().length); };
  }
  on(e, f) { (this.ev.get(e) || this.ev.set(e, []).get(e)).push(f); return this; }
  emit(e, ...a) { for (const f of this.ev.get(e) || []) f(...a); }
  // ----- lifecycle -----
  async hello() {
    const h = encodeHeader({ type: T.HELLO, flags: this.c.isRelay ? F.RELAY : 0, ttl: 1, hops: 0, eventId: this.c.eventId, channelId: 0, keyId: 0, senderId: this.id, streamId: 0, seq: this.helloSeq++ & 0xffff, tsMs: 0 });
    const ids = this.router.neighbors().slice(0, 16).map((x) => x.userId), nb = new Uint8Array(1 + ids.length * 4), v = new DataView(nb.buffer); nb[0] = ids.length; ids.forEach((u, i) => v.setUint32(1 + i * 4, u));
    const sig = await sign(this.c.devicePriv, concat(authHeader(h), this.c.cert, nb)); this.link.broadcast(concat(h, this.c.cert, nb, sig));
  }
  tickRouter() { this.router.expire(); }
  neighborCount() { return this.router.neighbors().length; }
  // ----- transmit -----
  async startStream(channelId, { codec = 'opus', rate = 16000, frameMs = 20, bundle = 2 } = {}) {
    const ck = this.c.channels.get(channelId); if (!ck) throw new Error('not a member of channel');
    const streamId = rnd32(), start = this.now();
    const g = this.arb.request(channelId, this.id, streamId, start); if (!g.granted) return { busy: true, by: g.busyWith };
    const streamKey = await deriveStreamKey(ck.key, this.id, streamId);
    const h = encodeHeader({ type: T.STREAM_START, flags: this.c.isRelay ? F.RELAY : 0, ttl: MAX_TTL, hops: 0, eventId: this.c.eventId, channelId, keyId: ck.keyId, senderId: this.id, streamId, seq: 0, tsMs: start >>> 0 });   // STREAM_START carries its wall-clock start (low 32 bits, authenticated)
    const fixed = encodeStreamStartBody({ codec: CODEC[codec], rate, frameMs, bundle, expiry: Math.floor((start + MAX_MS + 5000) / 1000) });
    const sig = await sign(this.c.devicePriv, concat(authHeader(h), fixed, this.c.cert)); const pkt = concat(h, fixed, this.c.cert, sig);
    this.router.noteStream(this.id, streamId, start + MAX_MS + 5000); this.router.seen.set(`${T.STREAM_START}:${this.id}:${streamId}:0`, start);
    this.link.broadcast(pkt); this.timer(60, () => this.link.broadcast(pkt));            // one redundant copy: control is cheap, loss is likely
    const st = { channelId, streamId, start, seq: 1, keyId: ck.keyId, streamKey, bundle, frameMs, ended: false };
    const self = this;
    return { streamId, async sendFrames(frames) {
      if (st.ended) return; const hdr = encodeHeader({ type: T.AUDIO, flags: 0, ttl: MAX_TTL, hops: 0, eventId: self.c.eventId, channelId, keyId: st.keyId, senderId: self.id, streamId, seq: st.seq, tsMs: self.now() - st.start });
      const body = await seal(st.streamKey, hdr, st.seq, packFrames(frames)); st.seq = (st.seq + 1) & 0xffff; self.stats.tx++; self.link.broadcast(concat(hdr, body));
    }, async end() {
      if (st.ended) return; st.ended = true; for (let i = 0; i < 3; i++) {                  // END marker, repeated so listeners release the floor
        const hdr = encodeHeader({ type: T.AUDIO, flags: F.END, ttl: MAX_TTL, hops: 0, eventId: self.c.eventId, channelId, keyId: st.keyId, senderId: self.id, streamId, seq: (st.seq + i) & 0xffff, tsMs: self.now() - st.start });
        self.link.broadcast(concat(hdr, await seal(st.streamKey, hdr, (st.seq + i) & 0xffff, packFrames([])))); }
      self.arb.release(channelId, self.id, streamId);
    } };
  }
  // ----- receive -----
  async #certFor(senderId, certBytes) {
    const c = this.certs.get(senderId); if (c && c.raw.length === certBytes.length && c.raw.every((b, i) => b === certBytes[i]) && c.exp * 1000 + 120000 >= this.now()) return c;
    const v = await verifyCert(certBytes, this.c.serverPub, { nowMs: this.now(), eventId: this.c.eventId }); if (!v || v.userId !== senderId) return null;
    const rec = { ...v, raw: certBytes.slice(), pub: await importPublic(v.pubRaw) }; this.certs.set(senderId, rec); return rec;
  }
  async #rx(peer, bytes, rssi) {
    this.busy++; try { await this.#rx2(peer, bytes, rssi); } finally { this.busy--; }
  }
  async #rx2(peer, bytes, rssi) {
    const h = decodeHeader(bytes); if (!h) { this.stats.rxBad++; return; }
    if (h.eventId !== this.c.eventId >>> 0) { this.stats.rxWrongEvent++; return; }
    if (h.senderId === this.id) return;
    const key = `${h.type}:${h.senderId}:${h.streamId}:${h.seq}`;
    if (this.router.seen.has(key)) { this.router.accept(peer, h, bytes); return; }          // cheap duplicate path (no crypto)
    try {
      if (h.type === T.HELLO) return await this.#hello(peer, h, bytes, rssi);
      if (h.type === T.STREAM_START) return await this.#start(peer, h, bytes);
      if (h.type === T.AUDIO) return await this.#audio(peer, h, bytes);
    } catch { this.stats.rxBad++; }
  }
  async #hello(peer, h, b, rssi) {
    const base = HEADER_LEN + CERT_LEN; if (b.length < base + 1 + SIG_LEN) { this.stats.rxBad++; return; }
    const cnt = b[base]; if (cnt > 16 || b.length !== base + 1 + cnt * 4 + SIG_LEN) { this.stats.rxBad++; return; }
    const cert = b.subarray(HEADER_LEN, base), nb = b.subarray(base, base + 1 + cnt * 4), sig = b.subarray(base + 1 + cnt * 4);
    const rec = await this.#certFor(h.senderId, cert); if (!rec) { this.stats.rxAuthFail++; return; }
    if (!(await verify(rec.pub, sig, concat(authHeader(b), cert, nb)))) { this.stats.rxAuthFail++; return; }
    const v = new DataView(nb.buffer, nb.byteOffset, nb.byteLength), nbrs = []; for (let i = 0; i < cnt; i++) nbrs.push(v.getUint32(1 + i * 4));
    this.router.onHello(peer, h.seq, { relay: !!(rec.flags & CERT_FLAG_RELAY), rssi, userId: h.senderId, nbrs }); this.stats.rxOk++; this.emit('peers', this.router.neighbors().length); this.emit('heard', { hops: 0, senderId: h.senderId });
  }
  async #start(peer, h, b) {
    const body = decodeStreamStartBody(b.subarray(HEADER_LEN)); if (!body) { this.stats.rxBad++; return; }
    const rec = await this.#certFor(h.senderId, body.cert); if (!rec) { this.stats.rxAuthFail++; return; }
    if (!(await verify(rec.pub, body.sig, concat(authHeader(b), body.fixed, body.cert)))) { this.stats.rxAuthFail++; return; }
    const t = this.now(), expMs = body.expiry * 1000;
    if (expMs < t || expMs > t + MAX_MS + 130000) { this.stats.rxReplay++; return; }        // expired, or claims an absurdly long life
    if (!this.replay.startStream(h.senderId, h.streamId, expMs)) { this.stats.rxReplay++; return; }
    const ck = this.c.channels.get(h.channelId); this.stats.rxOk++;
    this.router.noteStream(h.senderId, h.streamId, expMs);
    this.router.accept(peer, h, b);                                                          // relays forward even without the channel key
    this.emit('heard', { hops: h.hops, senderId: h.senderId });
    if (!ck) return;                                                                         // not our channel: relay only
    const startFull = t - (((t >>> 0) - h.tsMs) | 0);   // rebuild full start time from its low 32 bits if (Math.abs(t - startFull) > MAX_MS + 130000) { this.stats.rxReplay++; return; }
    const g = this.arb.request(h.channelId, h.senderId, h.streamId, startFull);
    this.streams.set(h.senderId + ':' + h.streamId, { channelId: h.channelId, senderId: h.senderId, codec: body.codec, rate: body.rate, frameMs: body.frameMs, bundle: body.bundle, keyId: h.keyId, key: await deriveStreamKey(ck.key, h.senderId, h.streamId), cert: rec });
    const held = this.pend.get(h.senderId + ':' + h.streamId); this.pend.delete(h.senderId + ':' + h.streamId);
    if (g.mustStop) this.emit('floor-lost', { channelId: h.channelId, to: h.senderId });
    if (g.granted) this.emit('stream-start', { channelId: h.channelId, senderId: h.senderId, streamId: h.streamId, codec: body.codec, rate: body.rate, frameMs: body.frameMs, bundle: body.bundle, hops: h.hops });
    if (held) for (const [p, bb] of held.p) await this.#rx2(p, bb);                           // release audio that beat its START
  }
  async #audio(peer, h, b) {
    const s = this.streams.get(h.senderId + ':' + h.streamId);
    if (!s) {                                                                                 // never relay/play audio of a stream we did not authenticate yet,
      const k = h.senderId + ':' + h.streamId, q = this.pend.get(k) || { t: this.now(), p: [] };  // but hold a few packets: START may be verifying or arriving late
      if (this.now() - q.t < 1000 && q.p.length < 12) { q.p.push([peer, b]); this.pend.set(k, q); }
      if (this.pend.size > 32) this.pend.delete(this.pend.keys().next().value); return;
    }
    if (h.keyId !== s.keyId || h.channelId !== s.channelId) { this.stats.rxAuthFail++; return; }
    if (!this.replay.accept(h.senderId, h.streamId, h.seq)) { this.stats.rxReplay++; return; }
    const pt = await open(s.key, b.subarray(0, HEADER_LEN), h.seq, b.subarray(HEADER_LEN)); if (!pt) { this.stats.rxAuthFail++; return; }
    const frames = unpackFrames(pt); if (!frames) { this.stats.rxBad++; return; }
    this.stats.rxOk++; this.router.accept(peer, h, b); this.emit('heard', { hops: h.hops, senderId: h.senderId });
    if (h.flags & F.END) {                                                                    // END is repeated 3x and may be processed concurrently: act once
      if (!this.streams.delete(h.senderId + ':' + h.streamId)) return;
      this.arb.release(h.channelId, h.senderId, h.streamId); this.emit('stream-end', { channelId: h.channelId, senderId: h.senderId, streamId: h.streamId }); return;
    }
    this.emit('audio', { channelId: h.channelId, senderId: h.senderId, streamId: h.streamId, seq: h.seq, bundle: s.bundle, frames, hops: h.hops });
  }
}
