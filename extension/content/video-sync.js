/**
 * Director's Cut — playback synchronisation engine.
 *
 * Scales from two screens to a room: every peer is measured separately, but the
 * room agrees on a single reference clock so nobody ends up chasing anybody.
 *
 * Three layers, in order of aggressiveness:
 *
 * 1. Shared clock, per peer. Timestamps are meaningless across machines until
 *    the clocks are aligned, so a tiny NTP-style exchange (`clock-ping`/
 *    `clock-pong`) estimates offset = peerClock - localClock for *each* peer,
 *    keeping the median of the lowest-RTT samples. Every position we receive is
 *    then aged by that sender's real transit time before it is used.
 *
 * 2. Intents. play / pause / seek / rate are discrete, sequenced commands, and
 *    anyone may issue one. They are applied immediately by everybody else, with
 *    echo suppression so the resulting local `play`/`seeked` event is not
 *    bounced back, and per-sender sequence numbers so two people acting at once
 *    cannot invalidate each other's commands.
 *
 * 3. Drift control. A 1 Hz state heartbeat lets every *follower* measure |drift|
 *    against the reference and correct it:
 *      > 1.00 s  hard seek        (buffer stall, tab throttling, ad break)
 *      > 0.12 s  playbackRate trim of at most ±5 % — invisible, no audio glitch
 *      < 0.03 s  restore the exact source rate
 *    So the steady-state delta stays far below the 1 s budget. The reference
 *    never moves on anyone else's account; it only reports the room's spread.
 */
(() => {
  const NS = globalThis.DirectorsCut;
  const { MSG, SYNC } = NS;

  const MAX_SAMPLES = 24;

  class VideoSync {
    constructor({ send, onDrift, onBlocked }) {
      this.send = send;              // (msg, to?) — omit `to` to reach everyone
      this.onDrift = onDrift || (() => {});
      this.onBlocked = onBlocked || (() => {});

      this.video = null;
      this.selfId = null;
      this.leaderId = null;          // the room's reference clock
      this.peerIds = [];
      this.follower = false;
      this.seq = 0;
      this.pingId = 0;

      /** peerId -> { offset (ms, peerClock - localClock), rtt, samples } */
      this.clocks = new Map();
      /** peerId -> that peer's last state heartbeat or intent */
      this.states = new Map();
      /** peerId -> last applied sequence number */
      this.remoteSeq = new Map();
      /** peers currently buffering; the room waits for all of them */
      this.stalledPeers = new Set();

      this.drift = null;
      this.baseRate = 1;
      this.trimmed = false;
      this.adjustingRate = false;
      this.pausedForPeer = false;
      this.stalled = false;
      this.forceSnap = true;    // first alignment after a link comes up
      this.expect = null;       // echo-suppression fingerprint
      this.bound = [];
      this.clockTimer = 0;
      this.stateTimer = 0;
    }

    // ---- lifecycle --------------------------------------------------------

    attach(video) {
      if (this.video === video) return;
      this.detach();
      this.video = video;
      this.baseRate = video.playbackRate || 1;

      const on = (type, fn) => {
        video.addEventListener(type, fn);
        this.bound.push([type, fn]);
      };
      on('play', () => this.localIntent('play'));
      on('pause', () => this.localIntent('pause'));
      on('seeked', () => this.localIntent('seek'));
      on('ratechange', () => this.localRateChange());
      on('waiting', () => this.localStall(true));
      on('playing', () => this.localStall(false));
      on('emptied', () => { this.states.clear(); this.forceSnap = true; });

      this.stateTimer = setInterval(() => this.heartbeat(), SYNC.STATE_INTERVAL_MS);
    }

    detach() {
      if (this.video) {
        for (const [type, fn] of this.bound) this.video.removeEventListener(type, fn);
        this.restoreRate();
      }
      this.bound = [];
      clearInterval(this.stateTimer);
      clearTimeout(this.clockTimer);
      this.stateTimer = this.clockTimer = 0;
      this.video = null;
      this.states.clear();
      this.drift = null;
    }

    /**
     * The whole room must agree on one reference clock or everybody chases
     * everybody. Lowest id wins: every peer computes the same minimum from the
     * same roster, so no extra negotiation round is needed.
     */
    setRoster({ selfId, leaderId, peerIds }) {
      if (selfId) this.selfId = selfId;
      this.peerIds = [...(peerIds || [])];
      const nextLeader = leaderId || this.leaderId;
      if (nextLeader !== this.leaderId) {
        this.leaderId = nextLeader;
        this.forceSnap = true;        // a new reference means a fresh alignment
      }
      this.follower = Boolean(this.selfId && this.leaderId && this.selfId !== this.leaderId);

      // Forget peers who left: their stale snapshots would keep feeding the
      // spread report, and their sequence numbers would reject a rejoin.
      const live = new Set(this.peerIds);
      for (const map of [this.clocks, this.states, this.remoteSeq]) {
        for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
      }
      for (const id of [...this.stalledPeers]) if (!live.has(id)) this.stalledPeers.delete(id);
      if (this.pausedForPeer && !this.stalledPeers.size) this.releaseHold();
      if (!this.follower) this.restoreRate();
    }

    /** Called when the mesh comes up (or re-forms after a reconnect). */
    onLinkUp({ selfId, leaderId, peerIds }) {
      this.setRoster({ selfId, leaderId, peerIds });
      this.forceSnap = true;
      this.remoteSeq.clear();
      this.clocks.clear();
      this.startClock();
      this.heartbeat();
      if (!this.follower) this.localIntent('sync', true); // reference states its position
    }

    onLinkDown() {
      clearTimeout(this.clockTimer);
      this.clockTimer = 0;
      this.restoreRate();
      this.states.clear();
      this.clocks.clear();
      this.stalledPeers.clear();
      this.drift = null;
      this.pausedForPeer = false;
    }

    /** One peer's channel just opened: align with them, leave the rest alone. */
    onPeerUp(id) {
      if (!id) return;
      if (!this.peerIds.includes(id)) this.peerIds.push(id);
      // A rejoin reuses the id but not the clock: old samples were measured
      // against a process that no longer exists.
      this.clocks.delete(id);
      this.states.delete(id);
      this.remoteSeq.delete(id);
      this.stalledPeers.delete(id);
      this.pingPeer(id);
      if (!this.follower) this.sendSync(id);        // tell the newcomer where we are
      else if (id === this.leaderId) this.forceSnap = true;
      if (!this.clockTimer) this.startClock();
    }

    onPeerDown(id) {
      this.clocks.delete(id);
      this.states.delete(id);
      this.remoteSeq.delete(id);
      this.peerIds = this.peerIds.filter((p) => p !== id);
      // Somebody who vanished mid-stall would otherwise wedge the room paused.
      if (this.stalledPeers.delete(id) && !this.stalledPeers.size) this.releaseHold();
    }

    /** Come out of a "wait for me" hold once nobody is buffering any more. */
    releaseHold() {
      if (!this.pausedForPeer || !this.video) return;
      this.pausedForPeer = false;
      const r = this.states.get(this.leaderId);
      if (r?.paused) return;                       // the room is paused on purpose
      if (r) {
        const target = this.projected(r, this.leaderId);
        this.expectState({ paused: false, position: target });
        this.seekTo(target);
      } else {
        this.expectState({ paused: false, position: this.video.currentTime });
      }
      this.play();
    }

    // ---- shared clock -----------------------------------------------------

    /**
     * One probe per peer per tick. Clock error is a property of the *path*, so a
     * single room-wide offset would be wrong for everybody except the peer that
     * happened to answer last.
     */
    startClock() {
      clearTimeout(this.clockTimer);
      const tick = () => {
        for (const id of this.peerIds) this.pingPeer(id);
        // Probe quickly until the noisiest link has a full window, then back off.
        const fast = this.peerIds.some(
          (id) => (this.clocks.get(id)?.samples.length || 0) < SYNC.CLOCK_SAMPLES,
        );
        this.clockTimer = setTimeout(tick, fast ? SYNC.CLOCK_FAST_MS : SYNC.CLOCK_SLOW_MS);
      };
      tick();
    }

    pingPeer(id) {
      this.send({ t: MSG.CLOCK_PING, id: ++this.pingId, t0: NS.now() }, id);
    }

    clockFor(id) {
      let clock = this.clocks.get(id);
      if (!clock) {
        clock = { offset: 0, rtt: 0, samples: [] };
        this.clocks.set(id, clock);
      }
      return clock;
    }

    onClockPong(msg, from) {
      const t3 = NS.now();
      const rtt = t3 - msg.t0;
      if (rtt < 0 || rtt > 4000) return;                     // absurd sample, drop it
      const offset = msg.t1 - (msg.t0 + t3) / 2;             // midpoint estimate
      const clock = this.clockFor(from);
      clock.samples.push({ rtt, offset });
      if (clock.samples.length > MAX_SAMPLES) clock.samples.shift();

      // Classic NTP filter: the lowest-RTT half of the window carries the least
      // queuing noise, so trust its median and ignore the rest.
      const ranked = [...clock.samples].sort((a, b) => a.rtt - b.rtt);
      const best = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
      clock.offset = NS.median(best.map((s) => s.offset));
      clock.rtt = ranked[0].rtt;
    }

    /** Convert a timestamp taken on `from`'s clock into our own. */
    toLocal(peerTs, from) {
      return peerTs - (this.clocks.get(from)?.offset || 0);
    }

    /**
     * Where that peer's playhead is *right now*, extrapolated from the snapshot.
     * This is what removes network latency from the comparison.
     */
    projected(snapshot, from) {
      const rate = snapshot.rate || 1;
      if (snapshot.paused) return snapshot.position;
      const ageMs = Math.max(0, NS.now() - this.toLocal(snapshot.at, from));
      return snapshot.position + (ageMs / 1000) * rate;
    }

    /** Only the reference's path matters when biasing a corrective seek. */
    leaderRtt() {
      return this.clocks.get(this.leaderId)?.rtt || 0;
    }

    // ---- outbound: local user actions -------------------------------------

    snapshot() {
      const v = this.video;
      return {
        position: v.currentTime,
        paused: v.paused,
        rate: this.baseRate,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        at: NS.now(),
      };
    }

    localIntent(kind, force = false) {
      if (!this.video) return;
      if (!force && this.isEcho(kind)) return;
      this.send({ t: MSG.INTENT, kind, seq: ++this.seq, ...this.snapshot() });
    }

    /** A private "here is my position", for a peer who just walked in. */
    sendSync(to) {
      if (!this.video) return;
      this.send({ t: MSG.INTENT, kind: 'sync', seq: ++this.seq, ...this.snapshot() }, to);
    }

    localRateChange() {
      if (!this.video || this.adjustingRate) return; // our own drift trim
      this.baseRate = this.video.playbackRate;
      this.trimmed = false;
      this.localIntent('rate', true);
    }

    /**
     * "Wait for me": when our buffer runs dry we ask the *room* to hold, then
     * release it once we are playing again. Only while genuinely playing, so a
     * deliberate pause is never mistaken for a stall.
     */
    localStall(active) {
      if (!this.video || this.video.paused) return;
      if (active === this.stalled) return;
      this.stalled = active;
      this.send({ t: MSG.INTENT, kind: active ? 'stall' : 'resume', seq: ++this.seq, ...this.snapshot() });
    }

    /** Everyone broadcasts, so the reference can measure the room's spread. */
    heartbeat() {
      if (!this.video) return;
      this.send({ t: MSG.STATE, ...this.snapshot(), stalled: this.stalled });
      this.evaluate();
    }

    // ---- echo suppression --------------------------------------------------

    /** Remember what we just forced onto the element, and for how long. */
    expectState({ paused, position }) {
      this.expect = { paused, position, until: NS.now() + SYNC.ECHO_GUARD_MS };
    }

    /**
     * True when a local media event is merely the consequence of a remote command.
     * Matching on the resulting *state* (not just a time window) means a real user
     * action inside the guard window still propagates.
     */
    isEcho(kind) {
      const e = this.expect;
      if (!e || NS.now() > e.until) return false;
      if (kind === 'play') return e.paused === false;
      if (kind === 'pause') return e.paused === true;
      if (kind === 'seek') {
        return Number.isFinite(e.position) &&
          Math.abs(this.video.currentTime - e.position) < 0.35;
      }
      return false;
    }

    // ---- inbound -----------------------------------------------------------

    onMessage(msg, from) {
      if (!from) return;   // every inbound frame is attributed, or it is unusable
      switch (msg.t) {
        case MSG.CLOCK_PING:
          // Unicast the reply: a broadcast pong would corrupt every other peer's
          // round-trip measurement with a t0 that was never theirs.
          this.send({ t: MSG.CLOCK_PONG, id: msg.id, t0: msg.t0, t1: NS.now() }, from);
          break;
        case MSG.CLOCK_PONG:
          this.onClockPong(msg, from);
          break;
        case MSG.INTENT:
          this.applyIntent(msg, from);
          break;
        case MSG.STATE:
          this.states.set(from, msg);
          this.evaluate();
          break;
      }
    }

    /**
     * Anyone may issue an intent and everybody applies it. Nothing is ever
     * rebroadcast: the mesh is complete, so a relay would loop forever.
     */
    applyIntent(msg, from) {
      const v = this.video;
      if (!v) return;
      // Sequence numbers are per sender — a single counter would let the busiest
      // peer's numbers swallow everybody else's intents.
      const last = this.remoteSeq.get(from) ?? -1;
      if (msg.kind !== 'sync' && msg.seq <= last) return; // stale / replayed
      this.remoteSeq.set(from, msg.seq);
      this.states.set(from, msg);

      switch (msg.kind) {
        case 'pause':
          // Land on the sender's exact frame — no extrapolation while frozen.
          this.expectState({ paused: true, position: msg.position });
          this.seekTo(msg.position);
          v.pause();
          break;

        case 'play':
        case 'seek':
        case 'sync': {
          const target = this.projected(msg, from);
          this.expectState({ paused: msg.paused, position: target });
          this.seekTo(target);
          if (msg.paused) v.pause();
          else if (v.paused || msg.kind === 'play') this.play();
          break;
        }

        case 'rate':
          this.baseRate = msg.rate || 1;
          this.trimmed = false;
          this.applyRate(this.baseRate);
          break;

        case 'stall':
          // The room waits for *all* of them, so track who is buffering.
          this.stalledPeers.add(from);
          if (!v.paused) {
            this.pausedForPeer = true;
            this.expectState({ paused: true, position: v.currentTime });
            v.pause();
          }
          break;

        case 'resume':
          this.stalledPeers.delete(from);
          if (this.pausedForPeer && !this.stalledPeers.size) {
            this.pausedForPeer = false;
            const target = this.projected(msg, from);
            this.expectState({ paused: false, position: target });
            this.seekTo(target);
            this.play();
          }
          break;
      }
    }

    // ---- drift control -----------------------------------------------------

    /**
     * Runs on every heartbeat (ours and everybody else's). A follower measures
     * |drift| against the *reference's* projected position — never against the
     * chattiest peer — and corrects it with the gentlest tool that will work.
     */
    evaluate() {
      const v = this.video;
      if (!v) return;

      // Only followers correct, otherwise everybody chases everybody. The
      // reference never moves on anyone else's account; it only reports.
      if (!this.follower) {
        this.reportSpread();
        return;
      }

      const r = this.states.get(this.leaderId);
      if (!r) return;

      const expected = this.projected(r, this.leaderId);
      const drift = v.currentTime - expected;   // > 0 means we are ahead
      this.drift = drift;
      this.onDrift(drift);

      // Never fight the browser mid-seek, and never fight a hold we entered on
      // somebody else's behalf.
      if (v.seeking || this.pausedForPeer) return;

      if (this.forceSnap) {
        this.forceSnap = false;
        this.snapTo(r, this.leaderId);
        return;
      }

      // A paused room has no drift to bleed off; rate trimming would be pointless
      // (and would leave a stale rate behind on resume).
      if (r.paused || v.paused) {
        this.restoreRate();
        return;
      }

      const mag = Math.abs(drift);
      if (mag > SYNC.HARD_SEEK_SEC) {
        // Buffer stall, throttled background tab, or an ad break: jump.
        this.restoreRate();
        const target = expected + Math.min(0.08, this.leaderRtt() / 2000);
        this.expectState({ paused: false, position: target });
        this.seekTo(target, 0.08);
      } else if (mag > SYNC.SOFT_DRIFT_SEC) {
        // Bleed the error off over a few seconds. Capped at ±5 %, which is below
        // the threshold where pitch shift becomes audible.
        const trim = NS.clamp(-drift * 0.35, -SYNC.RATE_TRIM, SYNC.RATE_TRIM);
        this.trimmed = true;
        this.applyRate(this.baseRate * (1 + trim));
      } else if (mag < SYNC.SETTLED_SEC) {
        this.restoreRate();
      }
    }

    /**
     * The reference has no drift of its own, so it shows the room's worst delta
     * instead — the one number that says whether the party is actually together.
     */
    reportSpread() {
      const v = this.video;
      let worst = null;
      for (const [id, snapshot] of this.states) {
        if (id === this.selfId) continue;
        const d = this.projected(snapshot, id) - v.currentTime;
        if (worst === null || Math.abs(d) > Math.abs(worst)) worst = d;
      }
      this.drift = worst;
      this.onDrift(worst);
    }

    /** Unconditional alignment: used on link-up, where any drift is expected. */
    snapTo(snapshot, from) {
      const v = this.video;
      const target = snapshot.paused ? snapshot.position : this.projected(snapshot, from);
      this.restoreRate();
      this.expectState({ paused: snapshot.paused, position: target });
      this.seekTo(target, 0);
      if (snapshot.paused && !v.paused) v.pause();
      else if (!snapshot.paused && v.paused) this.play();
    }

    // ---- element helpers ---------------------------------------------------

    seekTo(target, minDelta = 0.05) {
      const v = this.video;
      if (!v || !Number.isFinite(target)) return;
      const end = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : Infinity;
      const clamped = NS.clamp(target, 0, end);
      if (Math.abs(v.currentTime - clamped) <= minDelta) return; // already close enough
      try {
        // fastSeek trades frame accuracy for speed; we are well inside our budget
        // and it avoids a full keyframe-accurate decode on long files.
        if (minDelta > 0 && typeof v.fastSeek === 'function') v.fastSeek(clamped);
        else v.currentTime = clamped;
      } catch { /* some players reject writes until metadata is loaded */ }
    }

    /** play() rejects when the site has not yet had a user gesture — surface it. */
    play() {
      const p = this.video?.play();
      if (p && typeof p.catch === 'function') p.catch((err) => this.onBlocked(err));
    }

    /** Marked so the resulting `ratechange` is not mistaken for a user action. */
    applyRate(rate) {
      const v = this.video;
      if (!v) return;
      const next = NS.clamp(rate, 0.0625, 16);
      if (Math.abs(v.playbackRate - next) < 1e-4) return;
      this.adjustingRate = true;
      try { v.playbackRate = next; } catch { /* ignore */ }
      setTimeout(() => { this.adjustingRate = false; }, 100);
    }

    restoreRate() {
      if (!this.trimmed) return;
      this.trimmed = false;
      this.applyRate(this.baseRate);
    }

    status() {
      return {
        drift: this.drift,
        rtt: this.leaderRtt(),
        offset: this.clocks.get(this.leaderId)?.offset || 0,
        follower: this.follower,
        trimmed: this.trimmed,
        peers: this.peerIds.length,
      };
    }
  }

  NS.VideoSync = VideoSync;
})();
