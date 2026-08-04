/**
 * Director's Cut — content-script orchestrator.
 *
 * Wiring, in one place:
 *
 *   service worker  ──chrome.runtime port──┐
 *                                          ├─ PeerLink (RTCPeerConnection)
 *   peer browser  ──WebRTC data channels──┘        │
 *                                                  ├─ VideoSync  (play/pause/seek/drift)
 *                                                  └─ Overlay    (canvas + emoji + toolbar)
 *
 * The service worker owns the signaling socket, so every SDP/ICE blob is relayed
 * through the port; once the data channels are up the socket is idle and all
 * interactive traffic is peer-to-peer.
 *
 * With `all_frames: true` this script runs in every frame of every http(s) page.
 * Only a frame that actually finds a plausible player opens a port, CLAIMing the
 * session with a film-likeness score, and the worker ACTIVATEs exactly one
 * winner — so an <iframe>d player wins over its host page, and an aggregator's
 * embed wins over the muted preview reels on the page around it, without any
 * hard-coded site knowledge.
 */
(() => {
  const NS = globalThis.DirectorsCut;
  if (!NS || window.__directorsCutLoaded) return;
  window.__directorsCutLoaded = true;

  const { MSG, PORT } = NS;
  const CLAIM_STEPS = [0, 400, 1200];   // players mount late; claim a few times
  const CLAIM_INTERVAL_MS = 5000;       // then keep an eye on the video set
  const CLAIM_DEBOUNCE_MS = 800;        // DOM churn is constant; scanning is not free
  const MIN_VIDEO_AREA = 120 * 90;      // ignore thumbnail-sized decorative video
  const FEATURE_SEC = 45;               // shorter than this is a trailer or a hover loop
  const SHADOW_DEPTH = 6;               // give up before pathological component trees

  const state = {
    port: null,
    active: false,
    applying: false,      // guard so a settings echo does not bounce back out
    session: null,
    settings: { ...NS.DEFAULTS },
    video: null,
    overlay: null,
    sync: null,
    link: null,
    linkState: 'idle',
    claimTimer: 0,
    claimSoonTimer: 0,
    observer: null,
    lastUrl: location.href,
  };

  // ---- video detection ----------------------------------------------------

  /**
   * Every <video> this frame can reach. The light DOM covers almost everything
   * and costs one selector call, so the shadow walk is a fallback: custom-element
   * players (and a lot of aggregator skins) hide the media inside an *open*
   * shadow root, which `querySelectorAll` does not cross. Closed roots stay
   * invisible — that is a hard limit of the platform, not a bug here.
   */
  function collectVideos() {
    const found = [...document.querySelectorAll('video')];
    if (found.length) return found;
    const walk = (root, depth) => {
      if (depth > SHADOW_DEPTH) return;
      for (const el of root.querySelectorAll('*')) {
        const sr = el.shadowRoot;
        if (!sr) continue;
        found.push(...sr.querySelectorAll('video'));
        walk(sr, depth + 1);
      }
    };
    walk(document, 0);
    return found;
  }

  /**
   * How much this element looks like "the film". Pixel area is the backbone —
   * the feature is the biggest thing on screen — and the rest separates it from
   * the muted preview reels an aggregator index page is paved with.
   */
  function scoreVideo(v) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < MIN_VIDEO_AREA) return 0;

    let score = area;
    // Something with decoded frames or a source beats a bigger empty element.
    if (!(v.readyState > 0 || v.currentSrc || v.srcObject)) score *= 0.25;
    // A feature, or a live stream (which reports Infinity), beats a short loop.
    // NaN — metadata has not landed yet — deliberately falls through untouched.
    const d = v.duration;
    if (d === Infinity || d >= FEATURE_SEC) score *= 2;
    else if (Number.isFinite(d) && d > 0 && d < 12) score *= 0.35;
    if (v.muted && v.loop) score *= 0.4;   // the classic autoplaying background reel
    if (r.bottom <= 0 || r.top >= innerHeight) score *= 0.5;  // scrolled out of sight
    return score;
  }

  /** The most film-like <video> in this frame. */
  function findVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of collectVideos()) {
      const score = scoreVideo(v);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best ? { video: best, score: bestScore } : null;
  }

  /**
   * Claiming is also what opens the port: the content script now runs in every
   * frame of every page, and a frame with no video has nothing to say to the
   * worker — hundreds of idle ports would just pin the service worker awake.
   */
  function claim() {
    const found = findVideo();
    if (!found) return;
    ensurePort();
    post({ t: PORT.CLAIM, area: Math.round(found.score), url: location.href });
    if (state.active) adoptVideo(found.video);
  }

  function scheduleClaims() {
    for (const delay of CLAIM_STEPS) setTimeout(claim, delay);
    clearInterval(state.claimTimer);
    state.claimTimer = setInterval(claim, CLAIM_INTERVAL_MS);
  }

  /** Trailing-edge coalescing: a busy page mutates far faster than it re-lays-out. */
  function claimSoon() {
    if (state.claimSoonTimer) return;
    state.claimSoonTimer = setTimeout(() => {
      state.claimSoonTimer = 0;
      claim();
    }, CLAIM_DEBOUNCE_MS);
  }

  /** SPA navigations swap the player without a document load. */
  function watchDom() {
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        state.sync?.detach();
        state.video = null;
      }
      if (!state.video || !state.video.isConnected) claimSoon();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * Wire a <video> into the overlay and the sync engine. The guard checks the
   * sync engine's own element, not just `state.video`: a claim that lands while
   * `ensureUi()` is awaiting the overlay stylesheet would otherwise record the
   * video before `state.sync` exists and then be skipped forever, leaving the
   * sync engine detached (drawings work, playback never syncs).
   */
  function adoptVideo(video) {
    if (!video) return;
    if (state.video === video && (!state.sync || state.sync.video === video)) return;
    state.video = video;
    state.overlay?.setVideo(video);
    state.sync?.attach(video);
    if (state.linkState === 'connected') state.sync?.onLinkUp(roster());
  }

  // ---- port to the service worker -----------------------------------------

  function post(msg) {
    try { state.port?.postMessage(msg); } catch { /* port died; onDisconnect will reconnect */ }
  }

  function ensurePort() {
    if (state.port) return;
    try {
      state.port = chrome.runtime.connect({ name: PORT.NAME });
    } catch {
      return; // extension context gone (reload/update) — nothing to do
    }
    state.port.onMessage.addListener(onPortMessage);
    state.port.onDisconnect.addListener(() => {
      state.port = null;
      // The worker was evicted, not uninstalled: the next claim revives both.
      setTimeout(claim, 500);
    });
  }

  async function onPortMessage(msg) {
    switch (msg.t) {
      case PORT.ACTIVATE:
        state.active = true;
        if (msg.settings) state.settings = { ...state.settings, ...msg.settings };
        await activate(msg.session);
        break;

      case PORT.STANDBY:
        if (state.active) teardown();
        state.active = false;
        break;

      case PORT.SESSION:
        if (state.active) await activate(msg.session);
        break;

      case PORT.SIGNAL:
        state.link?.handleSignal(msg.from, msg.data);
        break;

      case PORT.JOLT:
        state.overlay?.shake();
        break;

      case PORT.TOOL:
        applyTool(msg);
        break;
    }
  }

  /**
   * Popup toolbar commands, relayed by the worker as {action, value}.
   * `applying` stops a settings echo from bouncing straight back out again.
   */
  function applyTool(msg) {
    switch (msg.action) {
      case 'settings':
        state.settings = { ...state.settings, ...(msg.settings || {}) };
        state.applying = true;
        state.overlay?.setSettings(msg.settings || {});
        state.applying = false;
        // A relay is only read while a connection is being built, so this reaches
        // peers connected from now on — including the retry of a failed one.
        if (state.link && state.session?.room) {
          state.link.configure({
            selfId: state.session.peerId,
            peers: state.session.peers,
            iceServers: NS.iceServersFrom(state.settings),
          });
        }
        break;
      case 'brush':   state.overlay?.setBrush(msg.value); break;
      case 'toolbar': state.overlay?.setToolbar(msg.value); break;
      case 'emoji':   if (msg.value) sendEmoji(msg.value); break;
      case 'jolt':    sendJolt({ bridge: false }); break; // worker already pinged the bridge
    }
  }

  // ---- session lifecycle ---------------------------------------------------

  function roster() {
    const s = state.session;
    const self = s?.peerId || null;
    const peers = (s?.peers || []).filter((p) => p && p !== self);
    return { selfId: self, peerIds: peers, leaderId: NS.leaderOf([self, ...peers]) };
  }

  async function activate(session) {
    state.session = session || null;
    await ensureUi();

    if (!session?.room) {
      state.link?.close();
      setLink('idle');
      return;
    }
    state.link.configure({
      selfId: session.peerId,
      peers: session.peers,
      iceServers: NS.iceServersFrom(state.settings),
    });
    // Somebody joining or leaving can move the reference clock, so the sync
    // engine is told about every roster change, not just the first one.
    state.sync?.setRoster(roster());
    if (session.link && session.link !== 'connected') {
      // Signalling is still coming up; show that rather than a stale "synced".
      if (state.linkState !== 'connected') setLink(session.link);
    }
  }

  async function ensureUi() {
    if (!state.overlay) {
      state.overlay = new NS.Overlay({ settings: state.settings, handlers: overlayHandlers() });
      await state.overlay.mount(state.video || findVideo()?.video);
      state.applying = true;
      state.overlay.setToolbar(state.settings.toolbar !== false);
      state.applying = false;
    }
    if (!state.sync) {
      state.sync = new NS.VideoSync({
        // `to` is optional: omit it to reach the whole room, pass a peer id for
        // clock replies and for greeting a newcomer.
        send: (msg, to) => state.link?.send(msg, 'ctl', to),
        onDrift: (drift) => {
          state.overlay?.setStatus({ link: state.linkState, drift });
          post({ t: PORT.STATUS, link: state.linkState, drift });
        },
        onBlocked: () => {
          // Autoplay policy: the peer pressed play but this tab has had no gesture.
          state.overlay?.setStatus({ link: state.linkState, drift: null });
        },
      });
    }
    if (!state.link) state.link = buildLink();
    const found = state.video || findVideo()?.video;
    if (found) adoptVideo(found);
  }

  function buildLink() {
    return new NS.PeerLink({
      sendSignal: (to, data) => post({ t: PORT.SIGNAL, to, data }),
      onMessage: onPeerMessage,
      onStatus: (status) => {
        setLink(status);
        if (status === 'connected') state.sync?.onLinkUp(roster());
        else state.sync?.onLinkDown();
      },
      // Greet only the peer whose channel just opened: a broadcast HELLO would
      // make the whole room re-align every time anybody joins.
      onOpen: (peerId) => {
        state.link.send({ t: MSG.HELLO, version: NS.VERSION || 1 }, 'ctl', peerId);
        state.sync?.onPeerUp(peerId);
      },
      onClose: (peerId) => state.sync?.onPeerDown(peerId),
    });
  }

  function setLink(status) {
    state.linkState = status;
    state.overlay?.setStatus({ link: status, drift: state.sync?.drift });
    post({ t: PORT.STATUS, link: status, drift: state.sync?.drift });
  }

  // ---- inbound peer traffic ------------------------------------------------

  /** `from` is the sender's peer id: it selects the clock and sequence counter. */
  function onPeerMessage(msg, from) {
    switch (msg.t) {
      case MSG.STROKE_BEGIN:  state.overlay?.remoteStrokeBegin(msg); break;
      case MSG.STROKE_POINTS: state.overlay?.remoteStrokePoints(msg); break;
      case MSG.STROKE_END:    state.overlay?.remoteStrokeEnd(msg); break;
      case MSG.EMOJI:         state.overlay?.launchEmoji(msg.spec || msg); break;
      case MSG.JOLT:
        state.overlay?.shake();
        break;
      case MSG.HELLO:
        // That peer (re)joined the channel: re-align with them alone.
        state.sync?.onPeerUp(from);
        break;
      default:
        state.sync?.onMessage(msg, from);
    }
  }

  // ---- outbound local actions ----------------------------------------------

  function sendEmoji(glyph) {
    const spec = NS.EmojiLayer.spec(glyph);
    state.overlay?.launchEmoji(spec);            // instant local feedback
    state.link?.send({ t: MSG.EMOJI, spec }, 'ctl');
  }

  /** A jolt goes to the peer's screen *and*, via the worker, to any phone. */
  function sendJolt({ bridge = true } = {}) {
    state.overlay?.shake();
    state.link?.send({ t: MSG.JOLT, at: NS.now() }, 'ctl');
    if (bridge) post({ t: PORT.JOLT, pattern: state.settings.joltPattern, intensity: 1 });
  }

  function overlayHandlers() {
    return {
      onStrokeBegin: (s) => state.link?.send({ t: MSG.STROKE_BEGIN, ...s }, 'fx'),
      onStrokePoints: (s) => state.link?.send({ t: MSG.STROKE_POINTS, ...s }, 'fx'),
      onStrokeEnd: (s) => state.link?.send({ t: MSG.STROKE_END, ...s }, 'fx'),
      onEmoji: sendEmoji,
      onJolt: () => sendJolt(),
      // Toolbar edits made on the page are persisted through the worker so the
      // popup and the next session agree with what the user just did.
      onSettings: (patch) => {
        if (state.applying) return;
        chrome.runtime.sendMessage({ t: 'settings', patch }).catch(() => {});
      },
    };
  }

  // ---- shutdown ------------------------------------------------------------

  function teardown() {
    clearTimeout(state.claimSoonTimer);
    state.claimSoonTimer = 0;
    state.sync?.detach();
    state.link?.close();
    state.overlay?.unmount();
    state.sync = null;
    state.link = null;
    state.overlay = null;
    state.video = null;
    state.linkState = 'idle';
  }

  addEventListener('pagehide', teardown, { once: true });

  scheduleClaims();
  watchDom();
})();
