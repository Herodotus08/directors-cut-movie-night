/**
 * Director's Cut — MV3 service worker.
 *
 * Why the socket lives here and the RTCPeerConnection does not:
 *  - A service worker has no RTCPeerConnection, so the peer connection has to
 *    live in the content script.
 *  - A content-script WebSocket is subject to the *page's* CSP and dies on every
 *    navigation, so the signalling socket has to live here.
 * The worker therefore owns: signalling, session state, frame arbitration and
 * the haptic bridge. It relays everything else to the winning content frame.
 */
importScripts('../lib/protocol.js', '../lib/id.js');

const NS = globalThis.DirectorsCut;
const { SIG, PORT, DEFAULTS } = NS;

const KEY_SETTINGS = 'settings';
const KEY_SESSION = 'session';
const KEEPALIVE_ALARM = 'dc-keepalive';

/** Single active session per browser profile. */
const session = {
  room: null,
  peerId: null,   // assigned by the signalling server, stable across reloads
  peers: [],      // other viewer peers in the room
  tabId: null,
  signal: 'idle', // idle | connecting | open | closed | error
  error: null,
  link: 'idle',   // RTC status mirrored up from the content script
  drift: null,    // last measured playback delta, seconds
};

let ws = null;
let bridge = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

const ports = new Map();        // "tabId:frameId" -> chrome.runtime.Port
const claims = new Map();       // tabId -> last CLAIM timestamp
let winner = null;              // { key, tabId, frameId, area }
let boundAt = 0;                // when session.tabId was last decided

const CLAIM_STALE_MS = 8000;    // frames re-claim every 5 s, so 8 s means "gone"

const keyOf = (tabId, frameId) => `${tabId}:${frameId}`;

// ---------------------------------------------------------------------------
// settings + persistence
// ---------------------------------------------------------------------------

async function getSettings() {
  const got = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...DEFAULTS, ...(got[KEY_SETTINGS] || {}) };
}

async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
  return next;
}

async function persistSession() {
  if (session.room) {
    await chrome.storage.session.set({
      [KEY_SESSION]: { room: session.room, tabId: session.tabId },
    });
  } else {
    await chrome.storage.session.remove(KEY_SESSION);
  }
}

/** The worker is evicted after ~30 s idle; rehydrate whatever it was doing. */
async function restore() {
  const got = await chrome.storage.session.get(KEY_SESSION);
  const saved = got[KEY_SESSION];
  if (!saved?.room) return;
  session.room = saved.room;
  session.tabId = saved.tabId ?? null;
  boundAt = Date.now();
  openSignal();
}

// ---------------------------------------------------------------------------
// signalling socket
// ---------------------------------------------------------------------------

function wsSend(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

async function openSignal() {
  if (!session.room) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);

  const { signalUrl } = await getSettings();
  setSignalState('connecting', null);

  try {
    ws = new WebSocket(signalUrl);
  } catch (err) {
    setSignalState('error', String(err?.message || err));
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    setSignalState('open', null);
    wsSend({ t: SIG.JOIN, room: session.room, role: 'viewer', version: NS.VERSION });
  };
  ws.onmessage = (ev) => handleSignal(NS.safeParse(ev.data));
  ws.onerror = () => setSignalState('error', 'signalling socket error');
  ws.onclose = () => {
    ws = null;
    if (session.room) {
      setSignalState('closed', session.error);
      scheduleReconnect();
    } else {
      setSignalState('idle', null);
    }
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(openSignal, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000); // capped exponential backoff
}

function closeSignal() {
  clearTimeout(reconnectTimer);
  if (ws) {
    wsSend({ t: SIG.LEAVE });
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  session.peers = [];
  session.peerId = null;
  setSignalState('idle', null);
}

function setSignalState(state, error) {
  session.signal = state;
  session.error = error || null;
  broadcastSession();
}

function handleSignal(msg) {
  if (!msg) return;
  switch (msg.t) {
    case SIG.JOINED:
      session.peerId = msg.peerId;
      session.peers = msg.peers || [];
      broadcastSession();
      toContent({ t: PORT.SESSION, session: publicSession() });
      break;

    case SIG.PEER:
      if (msg.event === 'join') {
        if (!session.peers.includes(msg.peerId)) session.peers.push(msg.peerId);
      } else {
        session.peers = session.peers.filter((p) => p !== msg.peerId);
      }
      broadcastSession();
      toContent({ t: PORT.SESSION, session: publicSession(), peerEvent: msg });
      break;

    case SIG.SIGNAL:
      // Opaque SDP/ICE envelope — the worker never inspects it.
      toContent({ t: PORT.SIGNAL, from: msg.from, data: msg.data });
      break;

    case SIG.PING:
      wsSend({ t: SIG.PONG, ts: msg.ts });
      break;

    case SIG.ERROR:
      setSignalState('error', `${msg.code}: ${msg.message}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// haptic bridge — abstract WebSocket hook for phones / wearables
//
// Deliberately decoupled from WebRTC: a phone lying on the sofa is not a peer in
// the watch party, it is a *sink* that receives tiny {t:'jolt', pattern} frames
// and replays them through navigator.vibrate(). Any server speaking this frame
// works; server/public/mobile.html is the reference sink.
// ---------------------------------------------------------------------------

async function openBridge() {
  const { bridgeEnabled, bridgeUrl } = await getSettings();
  if (!bridgeEnabled || !session.room) return;
  if (bridge && (bridge.readyState === WebSocket.OPEN || bridge.readyState === WebSocket.CONNECTING)) return;
  try {
    bridge = new WebSocket(bridgeUrl);
  } catch {
    bridge = null;
    return;
  }
  // No role is claimed: the bridge transport decides it. Asking for 'viewer'
  // here would burn one of the room's two viewer slots on our own jolt sender
  // and lock the actual peer out with room-full.
  bridge.onopen = () => bridgeSend({ t: SIG.JOIN, room: session.room });
  bridge.onclose = () => { bridge = null; };
  bridge.onerror = () => { /* non-fatal: haptics are best-effort */ };
}

function bridgeSend(msg) {
  if (bridge?.readyState === WebSocket.OPEN) {
    bridge.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function closeBridge() {
  if (bridge) {
    bridge.onclose = null;
    bridge.close();
    bridge = null;
  }
}

async function relayJolt(payload) {
  const { joltPattern } = await getSettings();
  const frame = {
    t: SIG.JOLT,
    room: session.room,
    from: session.peerId,
    pattern: payload?.pattern || joltPattern,
    intensity: NS.clamp(Number(payload?.intensity ?? 1), 0, 1),
    at: NS.now(),
  };
  if (!bridgeSend(frame)) {
    await openBridge();          // lazy connect, deliver on the next jolt
    wsSend(frame);               // signalling server also fans jolts out
  }
}

// ---------------------------------------------------------------------------
// session control
// ---------------------------------------------------------------------------

function publicSession() {
  return {
    room: session.room,
    peerId: session.peerId,
    peers: session.peers,
    tabId: session.tabId,
    signal: session.signal,
    error: session.error,
    link: session.link,
    drift: session.drift,
    frameKey: winner?.key || null,
  };
}

async function startSession({ room, tabId }) {
  const normalized = NS.normalizeRoomId(room);
  if (!normalized) throw new Error('Invalid room code');
  await stopSession({ keepPorts: true });
  session.room = normalized;
  session.tabId = tabId ?? null;
  boundAt = Date.now();
  session.link = 'idle';
  session.drift = null;
  await persistSession();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await openSignal();
  await openBridge();
  return publicSession();
}

async function stopSession({ keepPorts = false } = {}) {
  closeSignal();
  closeBridge();
  session.room = null;
  session.tabId = null;
  session.link = 'idle';
  session.drift = null;
  session.error = null;
  winner = null;
  claims.clear();
  boundAt = 0;
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  await persistSession();
  if (!keepPorts) for (const port of ports.values()) post(port, { t: PORT.STANDBY });
  broadcastSession();
  return publicSession();
}

// ---------------------------------------------------------------------------
// content-script ports + frame arbitration
//
// content_scripts run on *://*/* with all_frames:true, because players are often
// iframed and a watch party should not need a hard-coded site list. Only frames
// that actually found a <video> open a port, and each one repeatedly CLAIMs it
// with a film-likeness score; the largest claim wins and every other frame is
// told to stand by. Re-claims every few seconds make this self-healing when an
// SPA swaps the player in late — and let the session hop to another tab when the
// bound one stops claiming, which is how aggregators that spawn a player tab work.
// ---------------------------------------------------------------------------

function post(port, msg) {
  try { port.postMessage(msg); } catch { /* port already torn down */ }
}

function toContent(msg) {
  const port = winner && ports.get(winner.key);
  if (port) post(port, msg);
}

function broadcastSession() {
  chrome.runtime.sendMessage({ t: 'state', state: publicSession() }).catch(() => {});
}

/** Is the tab we are bound to still reporting a player? */
function tabIsClaiming(tabId) {
  const at = claims.get(tabId);
  return Boolean(at && Date.now() - at < CLAIM_STALE_MS);
}

/**
 * Bind the session to whichever tab is actually playing something. The bound tab
 * keeps priority for as long as it claims; once it goes quiet — navigated away,
 * lost its player, or closed — the next claim from anywhere inherits the room
 * instead of the user being stranded in permanent standby.
 */
async function bindTab(tabId) {
  if (session.tabId === tabId) return true;
  // A freshly chosen tab gets one staleness window to produce its first claim,
  // so a video sitting in some background tab cannot steal the session in the
  // seconds before the tab the user actually started on reports in.
  const fresh = Date.now() - boundAt < CLAIM_STALE_MS;
  if (session.tabId != null && (fresh || tabIsClaiming(session.tabId))) return false;
  session.tabId = tabId;
  boundAt = Date.now();
  winner = null;
  await persistSession();
  return true;
}

async function onClaim(port, meta, msg) {
  if (!session.room) {
    post(port, { t: PORT.STANDBY });
    return;
  }
  claims.set(meta.tabId, Date.now());
  if (!(await bindTab(meta.tabId))) {
    post(port, { t: PORT.STANDBY });
    return;
  }
  const area = Number(msg.area) || 0;
  const incumbentAlive = winner && ports.has(winner.key);
  const isIncumbent = winner?.key === meta.key;
  if (incumbentAlive && !isIncumbent && area <= winner.area * 1.25) {
    post(port, { t: PORT.STANDBY });
    return;
  }
  winner = { ...meta, area };
  post(port, {
    t: PORT.ACTIVATE,
    session: publicSession(),
    settings: await getSettings(),
  });
  for (const [key, other] of ports) if (key !== meta.key) post(other, { t: PORT.STANDBY });
  broadcastSession();
}

function onPortMessage(port, meta, msg) {
  switch (msg?.t) {
    case PORT.CLAIM:
      onClaim(port, meta, msg);
      break;
    case PORT.SIGNAL:
      wsSend({ t: SIG.SIGNAL, to: msg.to, data: msg.data });
      break;
    case PORT.JOLT:
      relayJolt(msg);
      break;
    case PORT.STATUS:
      session.link = msg.link ?? session.link;
      session.drift = msg.drift ?? null;
      broadcastSession();
      break;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT.NAME) return;
  const tabId = port.sender?.tab?.id ?? -1;
  const frameId = port.sender?.frameId ?? 0;
  const meta = { key: keyOf(tabId, frameId), tabId, frameId };
  ports.set(meta.key, port);
  port.onMessage.addListener((msg) => onPortMessage(port, meta, msg));
  port.onDisconnect.addListener(() => {
    ports.delete(meta.key);
    if (winner?.key === meta.key) {
      winner = null;
      session.link = 'idle';
      session.drift = null;
      broadcastSession();
    }
  });
  post(port, { t: PORT.SESSION, session: publicSession() });
});

// ---------------------------------------------------------------------------
// popup RPC
// ---------------------------------------------------------------------------

async function handleRpc(msg) {
  switch (msg?.t) {
    case 'get-state':
      return { state: publicSession(), settings: await getSettings(), emoji: NS.EMOJI };

    case 'create':
      return { state: await startSession({ room: NS.createRoomId(), tabId: msg.tabId }) };

    case 'join':
      return { state: await startSession({ room: msg.room, tabId: msg.tabId }) };

    case 'stop':
      return { state: await stopSession() };

    case 'settings': {
      const settings = await patchSettings(msg.patch || {});
      toContent({ t: PORT.TOOL, action: 'settings', settings });
      if (msg.patch?.signalUrl && session.room) { closeSignal(); await openSignal(); }
      if (msg.patch?.bridgeUrl || msg.patch?.bridgeEnabled !== undefined) {
        closeBridge();
        await openBridge();
      }
      return { settings };
    }

    case 'tool':
      toContent({ t: PORT.TOOL, action: msg.action, value: msg.value });
      return { ok: true };

    case 'jolt':
      toContent({ t: PORT.TOOL, action: 'jolt' });
      await relayJolt(msg);
      return { ok: true };

    case 'grant':
      await chrome.scripting.executeScript({
        target: { tabId: msg.tabId, allFrames: true },
        files: NS.CONTENT_FILES,
      });
      return { ok: true };

    default:
      return { error: 'unknown-request' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.t === 'state') return; // our own broadcast echoing back
  handleRpc(msg).then(respond, (err) => respond({ error: String(err?.message || err) }));
  return true; // async response
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

// The worker is evicted after ~30 s idle. Inbound socket traffic resets that
// timer, and this alarm resurrects us (and the socket) if it fired anyway.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM || !session.room) return;
  if (ws?.readyState === WebSocket.OPEN) wsSend({ t: SIG.PING, ts: NS.now() });
  else openSignal();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  claims.delete(tabId);
  if (!session.room || tabId !== session.tabId) return;
  // Release the binding instead of ending the session: closing an aggregator's
  // index tab after it spawned the player tab must not kill the watch party.
  // The next claim from any surviving tab inherits the room within ~5 s.
  session.tabId = null;
  boundAt = 0;
  session.link = 'idle';
  session.drift = null;
  winner = null;
  persistSession();
  broadcastSession();
});

chrome.runtime.onStartup.addListener(restore);
chrome.runtime.onInstalled.addListener(restore);
restore(); // also covers a plain worker respawn, which fires neither event above

