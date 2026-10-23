// ConnectionManager: explicit state machine driven by EVIDENCE, with hysteresis so a slow server never flips the app offline.
export const S = { ONLINE_CONNECTED: 'ONLINE_CONNECTED', ONLINE_DEGRADED: 'ONLINE_DEGRADED', OFFLINE_DISCOVERING: 'OFFLINE_DISCOVERING',
  OFFLINE_DIRECT_CONNECTED: 'OFFLINE_DIRECT_CONNECTED', OFFLINE_MESH_CONNECTED: 'OFFLINE_MESH_CONNECTED', OFFLINE_PARTITIONED: 'OFFLINE_PARTITIONED', DISCONNECTED: 'DISCONNECTED' };
export const CFG = { serverOkMs: 8000, degradedRttMs: 1500, serverDownMs: 15000, recoverOk: 2, peerFreshMs: 8000, meshFreshMs: 20000, partitionHoldMs: 60000 };
export class ConnectionManager {
  constructor({ now = Date.now, offlineAvailable = false, cfg = {}, onChange = () => {} } = {}) {
    this.now = now; this.cfg = { ...CFG, ...cfg }; this.offlineAvailable = offlineAvailable; this.onChange = onChange;
    this.srv = { wsOpen: false, lastOk: 0, rtt: null, okRun: 0, failSince: null }; this.peer = { lastDirect: 0, lastMulti: 0, count: 0, hadPeers: false, lostAt: null };
    this.srv.failSince = now(); this.state = S.DISCONNECTED; this.since = now();
  }
  // --- evidence in ---
  wsOpen() { this.srv.wsOpen = true; this.tick(); }
  wsClosed() { this.srv.wsOpen = false; this.srv.okRun = 0; if (this.srv.failSince == null) this.srv.failSince = this.now(); this.tick(); }
  serverReply(rttMs) { const s = this.srv; s.lastOk = this.now(); s.rtt = rttMs; s.failSince = null; s.okRun++; this.tick(); }   // pong, ack, voice frame...
  serverTimeout() { if (this.srv.failSince == null) this.srv.failSince = this.now(); this.srv.okRun = 0; this.tick(); }
  peerHeard({ hops = 0 } = {}) { const t = this.now(); this.peer.lastDirect = t; if (hops > 0) this.peer.lastMulti = t; this.peer.hadPeers = true; this.peer.lostAt = null; this.tick(); }   // authenticated packet delivered
  peerCount(n) { if (n === 0 && this.peer.count > 0) this.peer.lostAt = this.now(); this.peer.count = n; this.tick(); }
  // --- evaluation ---
  evaluate() {
    const t = this.now(), c = this.cfg, s = this.srv, p = this.peer;
    const fresh = !!s.lastOk && t - s.lastOk <= c.serverOkMs;
    const failedLong = s.failSince != null && t - s.failSince >= c.serverDownMs;
    if (s.wsOpen && fresh) return (s.rtt != null && s.rtt > c.degradedRttMs) ? S.ONLINE_DEGRADED : S.ONLINE_CONNECTED;
    if (!failedLong) {                                   // not enough evidence that the server is gone: hold, never flip on one slow reply
      if (s.wsOpen || this.state.startsWith('ONLINE')) return S.ONLINE_DEGRADED;
      return this.state.startsWith('OFFLINE') ? this.state : S.DISCONNECTED;
    }
    if (!this.offlineAvailable) return S.DISCONNECTED;
    if (p.count > 0 && p.lastMulti && t - p.lastMulti <= c.meshFreshMs) return S.OFFLINE_MESH_CONNECTED;
    if (p.count > 0 && t - p.lastDirect <= c.peerFreshMs) return S.OFFLINE_DIRECT_CONNECTED;
    if (p.hadPeers && p.lostAt != null && t - p.lostAt <= c.partitionHoldMs) return S.OFFLINE_PARTITIONED;
    return p.hadPeers ? S.DISCONNECTED : S.OFFLINE_DISCOVERING;
  }
  tick() {
    let next = this.evaluate();
    // returning online needs repeated server evidence, not a single reply
    if (this.state.startsWith('OFFLINE') && next.startsWith('ONLINE') && this.srv.okRun < this.cfg.recoverOk) next = this.state;
    if (next !== this.state) { const prev = this.state; this.state = next; this.since = this.now(); this.onChange(next, prev); }
    return this.state;
  }
  // Which transport may carry a NEW voice stream right now (sticky per stream; callers must not switch mid-stream).
  transportForNewStream() { const s = this.state; if (s === S.ONLINE_CONNECTED || s === S.ONLINE_DEGRADED) return 'online'; if (s === S.OFFLINE_DIRECT_CONNECTED || s === S.OFFLINE_MESH_CONNECTED) return 'offline'; return 'none'; }
  describe() {
    return { ONLINE_CONNECTED: 'Online', ONLINE_DEGRADED: 'Online (slow)', OFFLINE_DISCOVERING: 'Offline: looking for nearby staff', OFFLINE_DIRECT_CONNECTED: 'Offline: connected to nearby staff',
      OFFLINE_MESH_CONNECTED: 'Offline: relayed through staff phones', OFFLINE_PARTITIONED: 'Offline: lost contact, retrying', DISCONNECTED: 'Not connected' }[this.state];
  }
}
