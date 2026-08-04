/**
 * Director's Cut — phone jolt sink.
 *
 * The reference implementation of the haptic bridge contract: connect to
 * ws://host/bridge, JOIN a room as role `phone`, then translate every inbound
 * `jolt` frame into navigator.vibrate(). A phone is a pure sink — it never
 * signals, never joins the WebRTC mesh, and the server never routes SDP to it.
 *
 * Vibration needs a prior user gesture on every mobile browser, so the page is
 * explicitly "armed" by a tap before it will buzz.
 */
(() => {
  'use strict';

  const ROOM_RE = /^[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){4}$/;
  const RETRY_MS = [500, 1000, 2000, 4000, 8000];
  const LOG_MAX = 6;

  const $ = (id) => document.getElementById(id);
  const el = {
    pill: $('pill'), form: $('join'), room: $('room'), connect: $('connect'),
    hint: $('hint'), stage: $('stage'), title: $('stage-title'),
    note: $('stage-note'), bolt: $('bolt'), log: $('log'),
  };

  const state = { ws: null, room: '', armed: false, tries: 0, timer: 0, closing: false };

  const canVibrate = typeof navigator.vibrate === 'function';

  // ---- plumbing -----------------------------------------------------------

  /** Accept whatever the user pastes: strip separators, re-group into 5x4. */
  function normalize(raw) {
    const body = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
    if (body.length !== 20) return '';
    const code = body.match(/.{4}/g).join('-');
    return ROOM_RE.test(code) ? code : '';
  }

  function setStatus(status, label) {
    el.pill.dataset.state = status;
    el.pill.textContent = label;
  }

  function log(line) {
    const li = document.createElement('li');
    const now = new Date();
    li.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes())
      .padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}  ${line}`;
    el.log.prepend(li);
    while (el.log.children.length > LOG_MAX) el.log.lastElementChild.remove();
  }

  function bridgeUrl(room) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${scheme}//${location.host}/bridge`);
    url.searchParams.set('room', room); // convenience for proxies/logs; JOIN is authoritative
    return url.toString();
  }

  // ---- socket ------------------------------------------------------------

  function connect(room) {
    disconnect({ quiet: true });
    state.room = room;
    state.closing = false;
    setStatus('connecting', 'pairing…');

    let ws;
    try {
      ws = new WebSocket(bridgeUrl(room));
    } catch (err) {
      setStatus('error', 'bad address');
      log(`connect failed: ${err.message}`);
      return;
    }
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.tries = 0;
      setStatus('connecting', 'joining…');
      send({ t: 'join', room, role: 'phone' });
    });

    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onFrame(msg);
    });

    ws.addEventListener('error', () => setStatus('error', 'connection error'));

    ws.addEventListener('close', () => {
      if (state.ws === ws) state.ws = null;
      if (state.closing) {
        setStatus('idle', 'offline');
        return;
      }
      setStatus('closed', 'reconnecting…');
      retry();
    });
  }

  function retry() {
    if (!state.room) return;
    const wait = RETRY_MS[Math.min(state.tries++, RETRY_MS.length - 1)];
    clearTimeout(state.timer);
    state.timer = setTimeout(() => connect(state.room), wait);
  }

  function disconnect({ quiet = false } = {}) {
    clearTimeout(state.timer);
    state.closing = true;
    const ws = state.ws;
    state.ws = null;
    if (!ws) return;
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'leave' })); } catch { /* gone */ }
    try { ws.close(); } catch { /* gone */ }
    if (!quiet) setStatus('idle', 'offline');
  }

  function send(msg) {
    const ws = state.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // ---- protocol ----------------------------------------------------------

  function onFrame(msg) {
    switch (msg?.t) {
      case 'joined':
        setStatus('open', 'paired');
        el.hint.textContent = `Paired to ${msg.room}. Leave this page open.`;
        log(`joined as ${msg.peerId}`);
        localStorage.setItem('dc.room', msg.room);
        break;
      case 'jolt':
        jolt(msg);
        break;
      case 'peer':
        log(`peer ${msg.event}: ${msg.peerId}`);
        break;
      case 'ping':
        send({ t: 'pong', ts: msg.ts });
        break;
      case 'error':
        setStatus('error', msg.code || 'error');
        el.hint.textContent = msg.message || 'The server rejected that room code.';
        log(`error: ${msg.code}`);
        // A rejected code is permanent — stop the reconnect ladder.
        if (msg.code === 'bad-room' || msg.code === 'room-full') {
          state.room = '';
          clearTimeout(state.timer);
        }
        break;
      default:
        break;
    }
  }

  /**
   * `pattern` is already sanitised server-side (<=12 entries, 0..600 ms each),
   * so the only work left is scaling it by intensity and flashing the stage so
   * a phone lying face-up still shows that something arrived.
   */
  function jolt(msg) {
    const raw = Array.isArray(msg.pattern) && msg.pattern.length ? msg.pattern : [90, 60, 140];
    const intensity = Number.isFinite(msg.intensity) ? Math.min(1, Math.max(0.1, msg.intensity)) : 1;
    const pattern = raw.map((n, i) => (i % 2 === 0 ? Math.round(n * intensity) : Math.round(n)));

    flash();
    if (!state.armed) {
      log('jolt ignored — tap to arm');
      return;
    }
    if (!canVibrate) {
      log('jolt (no vibration motor)');
      return;
    }
    try {
      navigator.vibrate(pattern);
      log(`jolt ${pattern.join('/')}ms`);
    } catch (err) {
      log(`vibrate failed: ${err.message}`);
    }
  }

  let flashTimer = 0;
  function flash() {
    el.stage.dataset.hit = 'true';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.stage.dataset.hit = 'false'; }, 240);
  }

  // ---- arming + UI -------------------------------------------------------

  /** One tap unlocks the motor for the rest of the page's life. */
  function arm() {
    if (state.armed) return;
    state.armed = true;
    el.stage.dataset.armed = 'true';
    if (canVibrate) {
      try { navigator.vibrate(30); } catch { /* ignore */ }
      el.title.textContent = 'Armed — waiting for jolts';
      el.note.textContent = 'Keep this tab in the foreground; background tabs cannot vibrate.';
    } else {
      el.title.textContent = 'Armed — no vibration motor';
      el.note.textContent = 'This device has no Vibration API, so jolts will only flash.';
    }
    log('vibration armed');
  }

  el.stage.addEventListener('click', arm);
  el.stage.addEventListener('touchstart', arm, { passive: true });

  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const room = normalize(el.room.value);
    if (!room) {
      el.hint.textContent = 'A room code is 20 characters in 5 groups of 4.';
      setStatus('error', 'bad code');
      return;
    }
    el.room.value = room;
    el.room.blur();
    state.tries = 0;
    arm();                        // the submit tap is a gesture — spend it
    el.hint.textContent = 'Pairing…';
    connect(room);
  });

  el.room.addEventListener('input', () => {
    el.hint.textContent = normalize(el.room.value)
      ? 'Looks good — press Pair.'
      : 'Type the room code shown in the extension popup.';
  });

  // Reconnect quickly after the screen locks and comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.room && !state.ws) { state.tries = 0; connect(state.room); }
  });

  window.addEventListener('pagehide', () => disconnect({ quiet: true }));

  // Prefill from the last pairing and from ?room= so a QR code can carry it.
  const fromQuery = normalize(new URL(location.href).searchParams.get('room'));
  const remembered = normalize(localStorage.getItem('dc.room'));
  el.room.value = fromQuery || remembered || '';
  if (fromQuery) el.form.requestSubmit();
  else if (remembered) el.hint.textContent = 'Last room restored — press Pair.';
})();


