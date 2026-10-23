// Transport abstraction. The push-to-talk controller only talks to CommunicationTransport; Online and Offline are interchangeable.
// events: 'stream-start' {channelId,senderId,streamId,codec,rate}, 'audio' {channelId,senderId,streamId,seq,frames,bundle}, 'stream-end' {...}
export class CommunicationTransport {
  get name() { throw new Error('abstract'); }
  async start() {} async stop() {}
  async startStream(channelId, opts) { throw new Error('abstract'); }     // -> {sendFrames(frames[]), end()} | {busy:true,by}
  on(e, f) { (this._ev ||= new Map()); (this._ev.get(e) || this._ev.set(e, []).get(e)).push(f); return this; }
  emit(e, ...a) { for (const f of this._ev?.get(e) || []) f(...a); }
}
// Contract the NATIVE layer must implement (Android: Nearby Connections / Wi-Fi Aware; iOS: Network.framework / Wi-Fi Aware / BLE).
//   broadcast(bytes)            best-effort send to all connected peers
//   send(peerId, bytes)         unicast to one connected peer
//   onReceive(peerId, bytes, rssi)   called per received datagram (<= maxPayload bytes)
//   onPeerUp(peerId) / onPeerDown(peerId)
//   maxPayload                  largest datagram the link carries (Nearby BYTES payloads are limited; measure on device)
export class PeerLink { maxPayload = 1000; broadcast(b) {} send(id, b) {} onReceive = () => {}; onPeerUp = () => {}; onPeerDown = () => {}; }

// Offline transport = MeshNode behind the common interface.
export class OfflinePeerTransport extends CommunicationTransport {
  constructor(node) { super(); this.node = node; for (const e of ['stream-start', 'audio', 'stream-end']) node.on(e, (x) => this.emit(e, x)); }
  get name() { return 'offline'; }
  startStream(channelId, opts) { return this.node.startStream(channelId, opts); }
}
// Online transport: the existing Cloudflare WebSocket protocol (tx_start/tx_grant/binary frames/rx_start/rx_end). Same wire format as the
// shipped app and Worker; kept here so it can be tested against the Worker protocol without a browser.
export class OnlineTransport extends CommunicationTransport {
  constructor({ ws }) { super(); this.ws = ws; this.rx = new Map(); this.pendingTx = null; ws.onmessage = (e) => this.#msg(e.data); }
  get name() { return 'online'; }
  startStream(channelId, { codec = 'opus', rate = 16000 } = {}) {
    return new Promise((res) => {
      this.pendingTx = { channelId, res: (r) => { this.pendingTx = null; res(r); } };
      this.ws.send(JSON.stringify({ t: 'tx_start', ch: channelId, codec, rate }));
    });
  }
  #msg(d) {
    if (typeof d !== 'string') { const u = new Uint8Array(d); if (u[0] !== 1) return; const tx = new DataView(u.buffer, u.byteOffset).getUint32(1); const r = this.rx.get(tx); if (r) this.emit('audio', { channelId: r.ch, senderId: r.from, streamId: tx, frames: [u.slice(5)], bundle: 1, seq: r.n++ }); return; }
    const m = JSON.parse(d); const p = this.pendingTx;
    if (m.t === 'tx_grant' && p) { const ws = this.ws; p.res({ streamId: m.tx, sendFrames: async (fr) => { for (const f of fr) ws.send(f); }, end: async () => ws.send(JSON.stringify({ t: 'tx_end', ch: p.channelId })) }); }
    else if (m.t === 'tx_busy' && p) p.res({ busy: true, by: m.by });
    else if (m.t === 'rx_start') { this.rx.set(m.tx, { ch: m.ch, from: m.from, n: 0 }); this.emit('stream-start', { channelId: m.ch, senderId: m.from, streamId: m.tx, codec: m.codec, rate: m.rate }); }
    else if (m.t === 'rx_end') { const r = this.rx.get(m.tx); this.rx.delete(m.tx); if (r) this.emit('stream-end', { channelId: r.ch, senderId: r.from, streamId: m.tx }); }
  }
}
