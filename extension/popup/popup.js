/**
 * Director's Cut — popup controller.
 *
 * The popup is a thin remote control: it never touches WebRTC or the DOM of the
 * page. Every action is an RPC to the service worker, which owns the session, and
 * the worker pushes `{t:'state'}` broadcasts back so the panel stays live while
 * it is open (a popup is destroyed the moment it closes, so there is nothing to
 * keep in sync beyond that).
 */
(() => {
  const NS = globalThis.DirectorsCut;
  const COLORS = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f8f9fa'];

  const $ = (id) => document.getElementById(id);
  const el = {
    pill: $('pill'),
    setup: $('setup'), live: $('live'),
    create: $('create'), joinForm: $('join-form'), roomInput: $('room-input'),
    setupHint: $('setup-hint'),
    roomCode: $('room-code'), copy: $('copy'),
    statPeer: $('stat-peer'), statLink: $('stat-link'), statDrift: $('stat-drift'),
    brush: $('brush'), toolbar: $('toolbar'), jolt: $('jolt'), stop: $('stop'),
    swatches: $('swatches'), width: $('width'), emoji: $('emoji'),
    signalUrl: $('signal-url'), bridgeUrl: $('bridge-url'),
    bridgeEnabled: $('bridge-enabled'), grant: $('grant'),
    turnUrl: $('turn-url'), turnUsername: $('turn-username'),
    turnCredential: $('turn-credential'),
    advancedHint: $('advanced-hint'), err: $('err'),
  };

  let settings = { ...NS.DEFAULTS };
  let tabId = null;
  let tabUrl = '';
  let brushOn = false;

  const rpc = (msg) => chrome.runtime.sendMessage(msg);

  function fail(err) {
    const text = String(err?.message || err || '');
    el.err.hidden = !text;
    el.err.textContent = text;
  }

  // ---- rendering ----------------------------------------------------------

  const LINK_LABEL = {
    connected: 'synced', connecting: 'linking…', waiting: 'waiting for peer',
    failed: 'link failed', idle: 'offline',
  };

  function render(state) {
    const live = Boolean(state?.room);
    el.setup.hidden = live;
    el.live.hidden = !live;

    // The pill shows whichever layer is the current bottleneck: no signalling
    // socket is a more useful thing to report than "waiting for peer".
    const signal = state?.signal;
    const link = state?.link || 'idle';
    const status = !live ? 'idle'
      : signal === 'error' || signal === 'closed' ? 'error'
      : signal !== 'open' ? 'connecting'
      : link;
    el.pill.dataset.state = status;
    // A server that answered and *rejected* us is not an unreachable server, so
    // surface the server's own error code when there is one.
    const code = /^([a-z][a-z-]+):/.exec(state?.error || '')?.[1];
    el.pill.textContent = !live ? 'offline'
      : status === 'error' ? (code || 'server unreachable')
      : LINK_LABEL[status] || status;

    if (!live) {
      fail(state?.error);
      return;
    }
    el.roomCode.value = state.room;
    const peers = (state.peers || []).filter((p) => p !== state.peerId);
    // A room can hold a whole group now, so the count is the useful number.
    el.statPeer.textContent = peers.length
      ? `you + ${peers.length}` : 'just you';
    el.statLink.textContent = LINK_LABEL[link] || link;
    el.statDrift.textContent = Number.isFinite(state.drift)
      ? `${Math.abs(state.drift).toFixed(2)} s` : '—';
    fail(state.error);
  }

  function renderSettings(next) {
    settings = { ...settings, ...next };
    el.signalUrl.value = settings.signalUrl || '';
    el.bridgeUrl.value = settings.bridgeUrl || '';
    el.bridgeEnabled.checked = settings.bridgeEnabled !== false;
    el.turnUrl.value = settings.turnUrl || '';
    el.turnUsername.value = settings.turnUsername || '';
    el.turnCredential.value = settings.turnCredential || '';
    el.width.value = String(settings.brushWidth || 5);
    el.toolbar.dataset.on = String(settings.toolbar !== false);
    for (const dot of el.swatches.children) {
      dot.dataset.on = String(dot.dataset.color === settings.brushColor);
    }
  }

  function buildPalettes() {
    for (const color of COLORS) {
      const dot = document.createElement('button');
      dot.className = 'swatch';
      dot.dataset.color = color;
      dot.style.background = color;
      dot.title = `Brush colour ${color}`;
      dot.addEventListener('click', () => save({ brushColor: color }));
      el.swatches.appendChild(dot);
    }
    for (const glyph of NS.EMOJI) {
      const btn = document.createElement('button');
      btn.textContent = glyph;
      btn.title = `Launch ${glyph}`;
      btn.addEventListener('click', () => rpc({ t: 'tool', action: 'emoji', value: glyph }));
      el.emoji.appendChild(btn);
    }
  }

  async function save(patch) {
    renderSettings(patch);           // optimistic: the panel must feel instant
    const res = await rpc({ t: 'settings', patch });
    if (res?.settings) renderSettings(res.settings);
  }

  // ---- actions ------------------------------------------------------------

  async function refresh() {
    const res = await rpc({ t: 'get-state' });
    if (res?.settings) renderSettings(res.settings);
    render(res?.state);
  }

  el.create.addEventListener('click', async () => {
    fail(null);
    const res = await rpc({ t: 'create', tabId });
    if (res?.error) return fail(res.error);
    render(res.state);
    // Hand the code over immediately — that is the only thing left to do.
    try { await navigator.clipboard.writeText(res.state.room); } catch { /* not fatal */ }
    el.copy.textContent = 'Copied';
  });

  el.joinForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    fail(null);
    const room = NS.normalizeRoomId(el.roomInput.value);
    if (!room) return fail('That room code does not look right.');
    const res = await rpc({ t: 'join', room, tabId });
    if (res?.error) return fail(res.error);
    render(res.state);
  });

  el.roomInput.addEventListener('input', () => {
    el.setupHint.textContent = NS.normalizeRoomId(el.roomInput.value)
      ? 'Looks good — press Join.'
      : 'Both of you need the same room code.';
  });

  el.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.roomCode.value);
      el.copy.textContent = 'Copied';
      setTimeout(() => { el.copy.textContent = 'Copy'; }, 1200);
    } catch {
      el.roomCode.select(); // clipboard denied: at least pre-select it
    }
  });

  el.stop.addEventListener('click', async () => render((await rpc({ t: 'stop' }))?.state));

  el.brush.addEventListener('click', () => {
    brushOn = !brushOn;
    el.brush.dataset.on = String(brushOn);
    rpc({ t: 'tool', action: 'brush', value: brushOn });
  });

  el.toolbar.addEventListener('click', () => {
    const next = el.toolbar.dataset.on !== 'true';
    save({ toolbar: next });
    rpc({ t: 'tool', action: 'toolbar', value: next });
  });

  el.jolt.addEventListener('click', () => rpc({ t: 'jolt', pattern: settings.joltPattern }));

  el.width.addEventListener('change', () => save({ brushWidth: Number(el.width.value) }));
  el.signalUrl.addEventListener('change', () => save({ signalUrl: el.signalUrl.value.trim() }));
  el.bridgeUrl.addEventListener('change', () => save({ bridgeUrl: el.bridgeUrl.value.trim() }));
  el.bridgeEnabled.addEventListener('change', () => save({ bridgeEnabled: el.bridgeEnabled.checked }));
  // A relay is only consulted while a connection is being built, so a change here
  // reaches the peers you connect to from now on, not the ones already up.
  el.turnUrl.addEventListener('change', () => save({ turnUrl: el.turnUrl.value.trim() }));
  el.turnUsername.addEventListener('change', () => save({ turnUsername: el.turnUsername.value.trim() }));
  el.turnCredential.addEventListener('change', () => save({ turnCredential: el.turnCredential.value }));

  /**
   * The overlay is matched on every http(s) page, so this is a rescue hatch, not
   * the normal path: it re-injects the content scripts into a tab that was
   * already open (or that loaded before the extension did) so the user does not
   * have to reload. `permissions.request` must be the first thing the click does
   * — an await in front of it would spend the user gesture and Chrome would
   * reject the prompt.
   */
  el.grant.addEventListener('click', () => {
    if (!tabId || !tabUrl.startsWith('http')) return fail('Open a normal web page first.');
    const url = new URL(tabUrl);
    const origin = `${url.protocol}//${url.hostname}/*`;
    chrome.permissions.request({ origins: [origin] }, async (granted) => {
      if (!granted) return fail('Permission declined.');
      const res = await rpc({ t: 'grant', tabId });
      el.advancedHint.textContent = res?.error
        ? `Injection failed: ${res.error}`
        : `Re-scanned ${url.hostname}. Reload the tab if the toolbar is still missing.`;
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.t === 'state') render(msg.state);
  });

  (async () => {
    buildPalettes();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
    tabUrl = tab?.url || '';
    el.advancedHint.textContent = tabUrl.startsWith('http')
      ? '' : 'Open a page with a video to use the overlay.';
    await refresh();
  })().catch(fail);
})();
