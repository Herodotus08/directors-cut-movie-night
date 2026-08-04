/**
 * Director's Cut — wire protocol + tunables.
 *
 * Loaded as a *classic* script so the exact same file can be consumed by:
 *   - the MV3 service worker  (importScripts)
 *   - the isolated-world content scripts (manifest content_scripts.js array)
 *   - the popup (<script src>)
 * Everything hangs off a single `globalThis.DirectorsCut` namespace because
 * content scripts listed in one manifest entry share a global scope.
 */
(() => {
  const NS = (globalThis.DirectorsCut ||= {});
  NS.VERSION = 1;

  /** Signalling messages: client <-> Node signalling server (JSON over WS). */
  NS.SIG = {
    JOIN: 'join',       // C->S {room, role}
    JOINED: 'joined',   // S->C {room, peerId, peers[]}
    PEER: 'peer',       // S->C {event:'join'|'leave', peerId}
    SIGNAL: 'signal',   // C->S {to, data} / S->C {from, data}
    JOLT: 'jolt',       // C->S {pattern} -> fanned out to phone clients
    LEAVE: 'leave',     // C->S {}
    PING: 'ping',
    PONG: 'pong',
    ERROR: 'error',     // S->C {code, message}
  };

  /** Peer-to-peer messages carried by the WebRTC data channels. */
  NS.MSG = {
    HELLO: 'hello',
    CLOCK_PING: 'clock-ping',
    CLOCK_PONG: 'clock-pong',
    INTENT: 'video-intent',   // discrete play/pause/seek command
    STATE: 'video-state',     // 1 Hz heartbeat used for drift correction
    STROKE_BEGIN: 'stroke-begin',
    STROKE_POINTS: 'stroke-points',
    STROKE_END: 'stroke-end',
    EMOJI: 'emoji',
    JOLT: 'jolt',
  };

  /** Envelope kinds nested inside SIG.SIGNAL payloads. */
  NS.RTC = {
    NEED_OFFER: 'need-offer',
    OFFER: 'offer',
    ANSWER: 'answer',
    ICE: 'ice',
  };

  /** Messages between content scripts and the service worker (chrome ports). */
  NS.PORT = {
    NAME: 'directors-cut',
    CLAIM: 'claim',         // CS->SW  "I own a <video> of N px²"
    ACTIVATE: 'activate',   // SW->CS  "you are the session frame"
    STANDBY: 'standby',     // SW->CS  "another frame won, stay dormant"
    SESSION: 'session',     // SW->CS  current room / peer list / settings
    SIGNAL: 'signal',
    JOLT: 'jolt',
    TOOL: 'tool',           // SW->CS  popup toolbar command
    STATUS: 'status',       // CS->SW  link + drift telemetry for the popup
  };

  /**
   * Synchronisation tunables.
   *
   * The contract is "peers stay < 1 s apart":
   *   |drift| > HARD_SEEK_SEC  -> hard seek (rare, e.g. after a buffer stall)
   *   |drift| > SOFT_DRIFT_SEC -> ease playbackRate by <= RATE_TRIM so the
   *                               follower slides back into place invisibly
   *   |drift| < SETTLED_SEC    -> restore the exact source playbackRate
   */
  NS.SYNC = {
    HARD_SEEK_SEC: 1.0,
    SOFT_DRIFT_SEC: 0.12,
    SETTLED_SEC: 0.03,
    RATE_TRIM: 0.05,
    STATE_INTERVAL_MS: 1000,
    CLOCK_FAST_MS: 700,
    CLOCK_SLOW_MS: 5000,
    CLOCK_SAMPLES: 9,
    ECHO_GUARD_MS: 700,
    SEEK_SETTLE_MS: 400,
  };

  NS.DEFAULTS = {
    signalUrl: 'ws://localhost:8080/signal',
    bridgeUrl: 'ws://localhost:8080/bridge',
    bridgeEnabled: true,
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ],
    // STUN only discovers an address; it cannot help two people who are both
    // behind a symmetric NAT or a locked-down corporate network. A TURN relay
    // can, and relaying is affordable here because these channels carry short
    // JSON frames, never the video itself.
    turnUrl: '',
    turnUsername: '',
    turnCredential: '',
    brushColor: '#ffd166',
    brushWidth: 5,
    fadeMs: 3000,          // sketch lifetime — requirement: clear after 3 s
    joltPattern: [90, 60, 140],
    toolbar: true,
  };

  /**
   * ICE servers for an `RTCPeerConnection`, with the user's TURN relay appended
   * when they have configured one. Several `urls` may be given, whitespace- or
   * comma-separated, so one credential pair can cover udp/tcp/tls entries.
   */
  NS.iceServersFrom = (settings = {}) => {
    const base = settings.iceServers?.length ? settings.iceServers : NS.DEFAULTS.iceServers;
    const urls = String(settings.turnUrl || '')
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter((u) => /^turns?:/i.test(u));
    if (!urls.length) return base;
    return [...base, {
      urls,
      username: String(settings.turnUsername || ''),
      credential: String(settings.turnCredential || ''),
    }];
  };

  /**
   * The room's reference clock: the lowest id present. Server ids are `p1`,
   * `p2`, … so this is a string compare — `'p10' < 'p2'` is unintuitive but it
   * is a *consistent* total order that every peer computes identically from the
   * same roster, which is the only property leader election needs.
   */
  NS.leaderOf = (ids) => {
    let best = null;
    for (const id of ids) {
      if (!id) continue;
      if (best === null || id < best) best = id;
    }
    return best;
  };

  /** Files re-injected by the popup when the user grants an unlisted site. */
  NS.CONTENT_FILES = [
    'lib/protocol.js',
    'lib/id.js',
    'content/rtc.js',
    'content/sketchpad.js',
    'content/emoji.js',
    'content/overlay.js',
    'content/video-sync.js',
    'content/content.js',
  ];

  NS.EMOJI = ['😂', '😍', '😱', '🤯', '🔥', '💀', '👏', '🍿', '❤️', '🤔', '😴', '🚀'];

  /** High-resolution, monotonic-ish epoch clock (ms). Used for all timestamps. */
  NS.now = () => performance.timeOrigin + performance.now();

  NS.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /** Median of a numeric array (clock offset estimation). */
  NS.median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  NS.safeParse = (raw) => {
    try { return JSON.parse(raw); } catch { return null; }
  };
})();
