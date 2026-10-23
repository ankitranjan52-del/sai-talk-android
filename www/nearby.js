// Nearby mode glue (Android app only): provisions offline credentials while online, then talks to nearby phones
// with no internet through the native SaiNearby plugin (Google Nearby Connections) + the mesh core in ./mesh.
// Not verified on real phones yet: see docs/ANDROID-STATUS.md.
import { MeshNode } from './mesh/node.js';
import { generateDeviceKey, importPublic, importChannelKey } from './mesh/security.js';
import { CODEC } from './mesh/packet.js';

const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const CODEC_NAME = { 1: 'opus', 2: 'ulaw' };

const N = { node: null, plugin: null, started: false, peers: 0, creds: null, handlers: {}, base: '' };
const cap = window.Capacitor;
N.native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
N.plugin = N.native && cap.registerPlugin ? cap.registerPlugin('SaiNearby') : null;
N.on = (e, f) => { (N.handlers[e] ||= []).push(f); return N; };
const emit = (e, ...a) => (N.handlers[e] || []).forEach((f) => { try { f(...a); } catch {} });
N.available = () => !!N.plugin;
N.ready = () => !!(N.started && N.node);
N.peerCount = () => N.peers;

// ---- device key + credentials ----
async function deviceKey() {
  const saved = ls.get('nb_dev');
  if (saved) { try { const j = JSON.parse(saved); const privateKey = await crypto.subtle.importKey('jwk', j.priv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']); return { privateKey, publicRaw: unb64(j.pub) }; } catch {} }
  const k = await generateDeviceKey(); ls.set('nb_dev', JSON.stringify({ priv: await crypto.subtle.exportKey('jwk', k.privateKey), pub: b64(k.publicRaw) })); return k;
}
// Call while online (after login). Fetches this phone's certificate + channel keys.
N.enroll = async (base, token) => {
  N.base = base; const cur = JSON.parse(ls.get('nb_creds') || 'null');
  if (cur && cur.exp * 1000 - Date.now() > 3600e3 && cur.token === token && Date.now() - (cur.at || 0) < 6 * 3600e3) return true;
  const dk = await deviceKey();
  const r = await fetch(base + '/api/offline/enroll', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ pub: b64(dk.publicRaw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }) });
  if (!r.ok) return false; const j = await r.json(); j.token = token; j.at = Date.now(); ls.set('nb_creds', JSON.stringify(j)); return true;
};
N.rememberNames = (users) => ls.set('nb_names', JSON.stringify(Object.fromEntries((users || []).map((u) => [u.id, u.name]))));
N.nameOf = (id) => { try { return JSON.parse(ls.get('nb_names') || '{}')[id] || 'User ' + id; } catch { return 'User ' + id; } };
N.hasCreds = () => { try { const c = JSON.parse(ls.get('nb_creds') || 'null'); return !!c && c.exp * 1000 > Date.now(); } catch { return false; } };

async function buildNode() {
  const c = JSON.parse(ls.get('nb_creds')); const dk = await deviceKey();
  const channels = new Map(); for (const ch of c.channels) channels.set(ch.id, { keyId: ch.keyId, key: await importChannelKey(unb64(ch.key)) });
  const link = { maxPayload: 1000, onReceive: null, onPeerUp: null, onPeerDown: null,
    broadcast: (u8) => N.plugin.broadcast({ data: b64(u8) }), send: (peer, u8) => N.plugin.send({ peer, data: b64(u8) }) };
  N.link = link;
  const node = new MeshNode({ creds: { eventId: c.eventId, userId: c.userId, cert: unb64(c.cert), serverPub: await importPublic(unb64(c.serverPub)), devicePriv: dk.privateKey, channels, isRelay: !!c.relay }, link });
  node.on('peers', (n) => { N.peers = n; emit('peers', n); });
  for (const e of ['stream-start', 'audio', 'stream-end', 'floor-lost']) node.on(e, (x) => emit(e, x));
  return node;
}

N.start = async () => {
  if (!N.plugin || N.started || !N.hasCreds()) return false;
  let p = await N.plugin.permissions(); if (!p.granted) { await N.plugin.requestPermissions(); for (let i = 0; i < 60 && !(p = await N.plugin.permissions()).granted; i++) await new Promise((r) => setTimeout(r, 500)); if (!p.granted) { emit('error', 'permissions'); return false; } }
  N.node = await buildNode(); const me = N.node.id;
  if (!N.wired) { N.wired = true;
    N.plugin.addListener('packet', (e) => N.node && N.link.onReceive && N.link.onReceive(e.peer, unb64(e.data), -60));
    N.plugin.addListener('peerUp', () => N.node && N.node.hello());
    N.plugin.addListener('peerDown', (e) => N.link.onPeerDown && N.link.onPeerDown(e.peer));
    N.plugin.addListener('error', (e) => emit('error', e.detail));
  }
  await N.plugin.start({ name: me + '-' + Math.random().toString(36).slice(2, 6) }); N.started = true;
  // The native service ticks every second. Native events are not throttled when the screen is off,
  // whereas JS timers in a hidden WebView are, so discovery and routing are driven from the native clock.
  N.tk = 0; N.tickL = await N.plugin.addListener('tick', () => { if (!N.node) return; N.node.tickRouter(); if ((++N.tk & 1) === 0) N.node.hello(); });
  emit('state', true); return true;
};
N.stop = async () => {
  if (!N.started) return; try { N.tickL && N.tickL.remove(); } catch {} N.started = false; N.node = null; N.peers = 0;
  try { await N.plugin.stop(); } catch {} emit('state', false);
};
// transmit one push-to-talk burst
N.startStream = (ch, codec) => N.node.startStream(ch, { codec: codec === 'opus' ? 'opus' : 'ulaw' });
N.codecName = (n) => CODEC_NAME[n] || 'ulaw';
window.Nearby = N;
