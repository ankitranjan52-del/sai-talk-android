// Bounded jitter buffer for live audio. Never lets latency grow: when too deep it skips ahead instead of queueing.
// Opus frame = 20 ms (measured from the app source: 16 kHz, 320 samples, 20 kbps). Lost frames are reported so the decoder
// can run packet-loss concealment (Opus decode with null data) instead of playing silence.
export class JitterBuffer {
  constructor({ frameMs = 20, target = 3, max = 8, maxGapFrames = 3 } = {}) { Object.assign(this, { frameMs, target, max, maxGapFrames }); this.reset(); }
  reset() { this.buf = new Map(); this.next = null; this.started = false; this.m = { late: 0, lost: 0, skipped: 0, dup: 0 }; }
  push(frameIdx, data) {
    if (this.next != null && frameIdx < this.next) { if (this.started) { this.m.late++; return; } this.next = frameIdx; }   // before playout starts, reordering is fine
    if (this.buf.has(frameIdx)) { this.m.dup++; return; }
    this.buf.set(frameIdx, data); if (this.next == null) this.next = frameIdx;
    while (this.buf.size > this.max) {                      // bounded: drop oldest, jump forward
      const lo = Math.min(...this.buf.keys()); this.buf.delete(lo); this.m.skipped++; if (lo >= this.next) this.next = Math.min(...this.buf.keys());
    }
  }
  // Called every frameMs by the playout clock. Returns {data} | {plc:true} | null (nothing to play yet).
  pop() {
    if (this.next == null) return null;
    if (!this.started) { if (this.buf.size < this.target) return null; this.started = true; }
    const d = this.buf.get(this.next);
    if (d) { this.buf.delete(this.next); this.next++; return { data: d }; }
    if (this.buf.size === 0) return null;                   // underrun: wait (caller may insert comfort silence)
    const hi = Math.max(...this.buf.keys());
    if (hi - this.next > this.maxGapFrames) { const lo = Math.min(...this.buf.keys()); this.m.lost += lo - this.next; this.next = lo; return this.pop(); }
    this.m.lost++; this.next++; return { plc: true };
  }
  depth() { return this.buf.size; }
}
