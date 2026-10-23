// MeshRouter: neighbour/link tracking, loop-free bounded forwarding, route table, outbox backpressure, reliable control.
// Pure logic (no crypto, no I/O) so it can be unit-tested and simulated. It only ever sees AUTHENTICATED packets.
export const DEFAULTS = {
  maxHops: 5, neighborTimeoutMs: 6000, minLinkQuality: 0.25, routeTtlMs: 20000, seenTtlMs: 15000, seenMax: 4096,
  jitterMs: 25, suppressK: 2,                      // wait 0-25 ms; skip forwarding if >=2 neighbours already repeated it
  forwardPerSec: 120, outboxMax: 24,               // per-node forwarding budget; per-neighbour queue bound
  ctrlRetries: 3, ctrlBaseMs: 300,
};
export class MeshRouter {
  constructor({ selfId, isRelay = true, now = Date.now, rng = Math.random, timer = (ms, f) => setTimeout(f, ms), send, cfg = {} }) {
    Object.assign(this, { selfId, isRelay, now, rng, timer, send }); this.cfg = { ...DEFAULTS, ...cfg };
    this.nb = new Map(); this.seen = new Map(); this.pending = new Map(); this.routes = new Map(); this.streams = new Map();
    this.tokens = this.cfg.forwardPerSec; this.tokenAt = now(); this.outbox = new Map(); this.ctrl = new Map();
    this.m = { pruned: 0, forwarded: 0, suppressed: 0, dups: 0, dropped: 0, ttlDrops: 0, budgetDrops: 0, queueDrops: 0 };
  }
  // ----- neighbours / link quality -----
  onHello(id, helloSeq, { relay = true, rssi = null, userId = id, nbrs = null } = {}) {
    const t = this.now(); let n = this.nb.get(id);
    if (!n) { n = { id, userId, lq: 0.6, lastSeq: helloSeq, lastSeen: t, relay, rssi, nbrs: null }; this.nb.set(id, n); }
    else { const gap = Math.max(1, ((helloSeq - n.lastSeq) & 0xffff) || 1); const sample = gap > 200 ? 0.5 : 1 / gap; n.lq = 0.8 * n.lq + 0.2 * sample; n.lastSeq = helloSeq; n.lastSeen = t; n.relay = relay; n.rssi = rssi; }
    if (nbrs) n.nbrs = new Set(nbrs);
    return n;
  }
  onNeighborDown(id) { this.nb.delete(id); for (const [s, r] of this.routes) if (r.next === id) this.routes.delete(s); this.outbox.delete(id); }
  neighbors() { const t = this.now(), c = this.cfg; return [...this.nb.values()].filter((n) => t - n.lastSeen <= c.neighborTimeoutMs && n.lq >= c.minLinkQuality); }
  linkQuality(id) { const n = this.nb.get(id); return n ? n.lq : 0; }
  // ----- routes (reverse path learned from authenticated packets) -----
  learnRoute(source, via, hops) {
    if (source === this.selfId) return; const t = this.now(), r = this.routes.get(source), lq = this.linkQuality(via);
    if (!r || r.exp < t || hops < r.hops || (hops === r.hops && lq > r.lq + 0.1)) this.routes.set(source, { next: via, hops, lq, exp: t + this.cfg.routeTtlMs });
    else if (r.next === via) r.exp = t + this.cfg.routeTtlMs;
  }
  routeTo(source) { const r = this.routes.get(source); if (!r) return null; if (r.exp < this.now()) { this.routes.delete(source); return null; } return r; }
  expire() {
    const t = this.now(); for (const [k, r] of this.routes) if (r.exp < t) this.routes.delete(k);
    for (const [k, ts] of this.seen) if (t - ts > this.cfg.seenTtlMs) this.seen.delete(k);
    for (const [k, e] of this.streams) if (e < t) this.streams.delete(k);
  }
  maxHopReach() { let h = 0; for (const r of this.routes.values()) if (r.exp >= this.now()) h = Math.max(h, r.hops); return h; }
  // ----- streams -----
  noteStream(sender, streamId, expMs) { this.streams.set(sender + ':' + streamId, expMs); }
  streamKnown(sender, streamId) { const e = this.streams.get(sender + ':' + streamId); return e != null && e >= this.now(); }
  // ----- core decision -----
  // hdr: decoded header; raw: received bytes. Returns {fresh:boolean, reason}. Schedules a (possibly suppressed) forward.
  accept(fromId, hdr, raw) {
    const t = this.now(), key = `${hdr.type}:${hdr.senderId}:${hdr.streamId}:${hdr.seq}`;
    if (hdr.senderId === this.selfId) return { fresh: false, reason: 'self' };                    // loop prevention
    if (this.seen.has(key)) { this.m.dups++; const p = this.pending.get(key); if (p) p.dups++; return { fresh: false, reason: 'dup' }; }
    this.seen.set(key, t); if (this.seen.size > this.cfg.seenMax) this.seen.delete(this.seen.keys().next().value);
    this.learnRoute(hdr.senderId, fromId, hdr.hops + 1);
    this.#maybeForward(fromId, hdr, raw, key);
    return { fresh: true, reason: 'ok' };
  }
  #maybeForward(fromId, hdr, raw, key) {
    const c = this.cfg; if (!this.isRelay) return;
    if (hdr.ttl <= 1 || hdr.hops + 1 > c.maxHops) { this.m.ttlDrops++; return; }
    if (hdr.type === 3 && !this.streamKnown(hdr.senderId, hdr.streamId)) return;               // audio only for streams we saw start
    // Self-pruning: forward only if some neighbour of mine is NOT already covered by the node I heard this from.
    // (If I do not know that node's neighbour list yet, assume nothing is covered, i.e. forward: safe default.)
    const from = this.nb.get(fromId), covered = from && from.nbrs ? from.nbrs : new Set();
    const next = this.neighbors().filter((n) => n.id !== fromId && n.userId !== hdr.senderId && !(from && n.userId === from.userId));
    if (!next.length) return;
    if (!next.some((n) => !covered.has(n.userId))) { this.m.pruned++; return; }
    const rec = { dups: 0 }; this.pending.set(key, rec);
    const delay = this.rng() * c.jitterMs * (1.6 - Math.min(1, this.linkQuality(fromId)));
    this.timer(delay, () => {
      this.pending.delete(key);
      if (rec.dups >= c.suppressK) { this.m.suppressed++; return; }                            // enough neighbours already repeated it
      if (!this.#budget()) { this.m.budgetDrops++; return; }
      const out = raw.slice(); out[3] = hdr.ttl - 1; out[4] = hdr.hops + 1;                    // hop accounting
      const droppable = hdr.type === 3; this.m.forwarded++;
      for (const n of this.neighbors()) if (n.id !== fromId && n.userId !== hdr.senderId) this.enqueue(n.id, out, droppable);
    });
  }
  #budget() { const t = this.now(); this.tokens = Math.min(this.cfg.forwardPerSec, this.tokens + (t - this.tokenAt) * this.cfg.forwardPerSec / 1000); this.tokenAt = t; if (this.tokens < 1) return false; this.tokens--; return true; }
  // ----- outbox with backpressure: live audio is dropped oldest-first, control is never dropped for audio -----
  enqueue(id, bytes, droppable) {
    let q = this.outbox.get(id); if (!q) { q = []; this.outbox.set(id, q); }
    if (q.length >= this.cfg.outboxMax) { const i = q.findIndex((e) => e.droppable); if (i >= 0) { q.splice(i, 1); this.m.queueDrops++; } else if (droppable) { this.m.queueDrops++; return; } else { q.shift(); this.m.queueDrops++; } }
    q.push({ bytes, droppable }); this.drain(id);
  }
  drain(id, max = Infinity) { const q = this.outbox.get(id); let n = 0; while (q && q.length && n < max) { this.send(id, q.shift().bytes); n++; } return n; }
  // ----- reliable control: bounded retransmission until ACK -----
  sendControl(destId, ctrlId, bytes, onResult = () => {}) {
    const c = this.cfg; const st = { tries: 0, done: false }; this.ctrl.set(ctrlId, st);
    const attempt = () => {
      if (st.done) return; if (st.tries >= c.ctrlRetries + 1) { st.done = true; this.ctrl.delete(ctrlId); return onResult(false); }
      const via = destId == null ? null : this.routeTo(destId)?.next; st.tries++;
      for (const n of via != null ? [{ id: via }] : this.neighbors()) this.enqueue(n.id, bytes, false);
      this.timer(c.ctrlBaseMs * 2 ** (st.tries - 1), attempt);
    }; attempt();
  }
  onAck(ctrlId) { const st = this.ctrl.get(ctrlId); if (st && !st.done) { st.done = true; this.ctrl.delete(ctrlId); st.onResult?.(true); return true; } return false; }
}
