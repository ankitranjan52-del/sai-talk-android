// Offline half-duplex floor control per channel (no server to grant the floor).
// Rules: an active stream blocks new starts from others. If two starts collide within COLLISION_MS, the earlier wall-clock
// start wins; ties go to the lower senderId. The loser must stop transmitting. Streams expire after MAX_MS (same as online, 60 s).
export const COLLISION_MS = 300, MAX_MS = 60000;
export class FloorArbiter {
  constructor({ now = Date.now, selfId } = {}) { this.now = now; this.selfId = selfId; this.floors = new Map(); }
  #cur(ch) { const f = this.floors.get(ch); if (f && f.until < this.now()) { this.floors.delete(ch); return null; } return f || null; }
  // Called for every authenticated STREAM_START (remote) and before starting our own (local). startMs = sender's claimed start.
  request(ch, senderId, streamId, startMs) {
    const f = this.#cur(ch), me = senderId === this.selfId;
    if (!f) { this.floors.set(ch, { senderId, streamId, startMs, until: this.now() + MAX_MS }); return { granted: true }; }
    if (f.senderId === senderId && f.streamId === streamId) return { granted: true };
    const collision = Math.abs(startMs - f.startMs) <= COLLISION_MS;
    if (collision && (startMs < f.startMs || (startMs === f.startMs && senderId < f.senderId))) {
      const preempted = f; this.floors.set(ch, { senderId, streamId, startMs, until: this.now() + MAX_MS });
      return { granted: true, preempted, mustStop: preempted.senderId === this.selfId };
    }
    return { granted: false, busyWith: f.senderId, mustStop: me && collision };
  }
  release(ch, senderId, streamId) { const f = this.floors.get(ch); if (f && f.senderId === senderId && f.streamId === streamId) this.floors.delete(ch); }
  holder(ch) { return this.#cur(ch); }
}
// Prevents the same voice burst playing twice when online and offline transports overlap during a switch.
// First transport that delivers a burst from (sender, channel) owns it for LOCK_MS; the other transport's copy is ignored.
export class StreamDeduper {
  constructor({ now = Date.now, lockMs = 2500 } = {}) { this.now = now; this.lockMs = lockMs; this.m = new Map(); }
  claim(transport, senderId, ch) {
    const k = senderId + ':' + ch, t = this.now(), e = this.m.get(k);
    if (e && t - e.last <= this.lockMs && e.transport !== transport) return false;
    this.m.set(k, { transport, last: t }); if (this.m.size > 256) for (const [kk, v] of this.m) if (t - v.last > this.lockMs) this.m.delete(kk);
    return true;
  }
}
