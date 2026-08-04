/**
 * Director's Cut — WebRTC mesh (content script).
 *
 * Every viewer connects straight to every other viewer, so a room of n screens
 * is n(n−1)/2 peer connections. Routing everything through one host would be
 * fewer sockets, but it would also make one person's laptop the single point of
 * failure for the whole party and double the latency of everything the others
 * send. These channels carry short JSON frames and never media, so the mesh
 * stays cheap at the sizes a watch party actually reaches.
 *
 * Two data channels per peer, chosen for what they carry:
 *   ctl : ordered + reliable   -> play/pause/seek intents, clock sync, emoji
 *   fx  : unordered + lossy    -> stroke points, where a late packet is worse
 *                                 than a lost one (no head-of-line blocking)
 *
 * Negotiation is "perfect negotiation" applied per pair, so a reload anywhere
 * cannot deadlock a handshake: within each pair the higher id is *polite* and
 * rolls back its own offer when it collides with an incoming one.
 */
(() => {
  const NS = globalThis.DirectorsCut;
  const { RTC } = NS;

  const MAX_QUEUE = 64;         // ctl messages buffered per peer before dropping
  const RENEGOTIATE_MS = 4000;  // ignore repeat offer requests inside this window
  const SWEEP_MS = 4000;        // retry peers whose handshake never landed
  const DEAD = new Set(['failed', 'closed']);

  class PeerLink {
    constructor({ sendSignal, onMessage, onStatus, onOpen, onClose }) {
      this.sendSignal = sendSignal;
      this.onMessage = onMessage;
      this.onStatus = onStatus || (() => {});
      this.onOpen = onOpen || (() => {});
      this.onClose = onClose || (() => {});

      this.epoch = NS.shortId(6);   // identifies *this* content-script instance
      this.selfId = null;
      this.iceServers = NS.DEFAULTS.iceServers;

      /** id -> { pc, ctl, fx, polite, remoteEpoch, queue, builtAt, askedAt } */
      this.peers = new Map();
      this.status = 'idle';
      this.sweepTimer = 0;
    }

    // ---- roster -------------------------------------------------------------

    /** Called whenever the signalling server reports a new peer roster. */
    configure({ selfId, peers, iceServers }) {
      if (iceServers?.length) this.iceServers = iceServers;
      this.selfId = selfId || this.selfId;

      const roster = new Set((peers || []).filter((p) => p && p !== this.selfId));
      for (const id of [...this.peers.keys()]) if (!roster.has(id)) this.dropPeer(id);
      if (this.selfId) for (const id of roster) this.openPeer(id);

      this.startSweep();
      this.refreshStatus();
    }

    peerFor(id) {
      let peer = this.peers.get(id);
      if (!peer) {
        peer = {
          id, pc: null, ctl: null, fx: null, remoteEpoch: null,
          makingOffer: false, ignoreOffer: false, queue: [], builtAt: 0, askedAt: 0,
        };
        this.peers.set(id, peer);
      }
      // Deterministic roles from the two server-assigned ids: no coin flips, and
      // both sides reach the same answer without another round trip.
      peer.polite = Boolean(this.selfId && this.selfId > id);
      return peer;
    }

    openPeer(id) {
      const peer = this.peerFor(id);
      if (peer.pc) return peer;
      if (!peer.polite) { this.ensurePeer(peer, true); return peer; }
      // The polite side asks for an offer instead of making one. The cooldown
      // matters when several people join at once: every join broadcasts a fresh
      // roster to everyone, so without it each pair would keep asking each other
      // to start over and no handshake would ever finish.
      if (NS.now() - peer.askedAt < RENEGOTIATE_MS) return peer;
      peer.askedAt = NS.now();
      this.signal(peer, { kind: RTC.NEED_OFFER });
      return peer;
    }

    dropPeer(id) {
      const peer = this.peers.get(id);
      if (!peer) return;
      this.teardown(peer);
      this.peers.delete(id);
      this.onClose(id);
    }

    /** A dropped NEED_OFFER would otherwise wait for the next roster change. */
    startSweep() {
      if (this.sweepTimer) return;
      this.sweepTimer = setInterval(() => {
        if (!this.selfId) return;
        for (const id of this.peers.keys()) this.openPeer(id);
        this.refreshStatus();
      }, SWEEP_MS);
    }

    // ---- aggregate status ---------------------------------------------------

    setStatus(next) {
      if (this.status === next) return;
      this.status = next;
      this.onStatus(next);
    }

    /**
     * One pill has to describe n links. Precedence is deliberate: any peer we
     * can talk to means the party is usable, so one unreachable friend must not
     * report the whole room as failed — only *everybody* failing does.
     */
    refreshStatus() {
      if (!this.peers.size) {
        this.setStatus(this.selfId ? 'waiting' : 'idle');
        return;
      }
      let open = 0;
      let dead = 0;
      for (const peer of this.peers.values()) {
        if (peer.ctl?.readyState === 'open') open++;
        else if (peer.pc && DEAD.has(peer.pc.connectionState)) dead++;
      }
      if (open) this.setStatus('connected');
      else if (dead === this.peers.size) this.setStatus('failed');
      else this.setStatus('connecting');
    }

    /** Peers with an open control channel, for callers that need a live count. */
    livePeers() {
      const live = [];
      for (const peer of this.peers.values()) {
        if (peer.ctl?.readyState === 'open') live.push(peer.id);
      }
      return live;
    }

    // ---- negotiation --------------------------------------------------------

    signal(peer, data) {
      this.sendSignal(peer.id, { ...data, epoch: this.epoch });
    }

    ensurePeer(peer, createChannels) {
      if (peer.pc) return peer.pc;
      const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
      peer.pc = pc;
      peer.builtAt = NS.now();

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.signal(peer, { kind: RTC.ICE, candidate: candidate.toJSON() });
      };

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          this.signal(peer, { kind: RTC.OFFER, sdp: pc.localDescription });
        } catch (err) {
          console.warn('[DC] negotiation failed', err);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        // Only the impolite side restarts ICE, for the same reason it makes the
        // offers: two simultaneous restarts collide.
        if (pc.connectionState === 'failed' && !peer.polite) pc.restartIce();
        this.refreshStatus();
      };

      pc.ondatachannel = ({ channel }) => this.bindChannel(peer, channel);

      // Only the impolite peer creates channels, so a glare cannot leave the
      // pair with two half-used sets.
      if (createChannels) {
        this.bindChannel(peer, pc.createDataChannel('ctl', { ordered: true }));
        this.bindChannel(peer, pc.createDataChannel('fx', { ordered: false, maxRetransmits: 1 }));
      }
      this.refreshStatus();
      return pc;
    }

    bindChannel(peer, channel) {
      channel.binaryType = 'arraybuffer';
      if (channel.label === 'fx') peer.fx = channel;
      else peer.ctl = channel;

      channel.onopen = () => {
        if (channel.label !== 'ctl') return;
        this.refreshStatus();
        const pending = peer.queue.splice(0);
        for (const msg of pending) this.sendTo(peer, msg, 'ctl');
        this.onOpen(peer.id);
      };
      channel.onclose = () => {
        if (channel.label === 'ctl') this.refreshStatus();
      };
      channel.onmessage = (ev) => {
        const msg = NS.safeParse(ev.data);
        // The sender id travels with the message: with n peers, "who sent this"
        // decides which clock offset and which sequence counter apply to it.
        if (msg) this.onMessage(msg, peer.id);
      };
    }

    async handleSignal(from, data) {
      if (!data || !from || from === this.selfId) return;
      // A signal can arrive before the roster does; the record is created either
      // way and `polite` is recomputed on every touch.
      const peer = this.peerFor(from);

      // A different epoch means that peer reloaded: drop the stale connection
      // before touching it, otherwise the SDP state machines get out of sync.
      if (data.epoch) {
        if (peer.remoteEpoch && peer.remoteEpoch !== data.epoch) this.teardown(peer);
        peer.remoteEpoch = data.epoch;
      }

      if (data.kind === RTC.NEED_OFFER) {
        // Ignore a repeat ask while our offer is still in flight. A genuine
        // reload already tore the connection down in the epoch check above, so
        // this only swallows the duplicates a multi-peer join storm produces.
        if (peer.pc && NS.now() - peer.builtAt < RENEGOTIATE_MS) return;
        this.teardown(peer);
        this.ensurePeer(peer, true);
        return;
      }
      if (data.kind === RTC.ICE) {
        try { await peer.pc?.addIceCandidate(data.candidate); }
        catch (err) { if (!peer.ignoreOffer) console.warn('[DC] ICE rejected', err); }
        return;
      }
      await this.handleDescription(peer, data);
    }

    /** Perfect-negotiation offer/answer handling, scoped to one peer. */
    async handleDescription(peer, data) {
      const description = data.sdp;
      if (!description) return;
      const pc = this.ensurePeer(peer, false);

      const offerCollision =
        description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;                 // impolite peer wins the race

      try {
        await pc.setRemoteDescription(description); // implicit rollback when polite
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.signal(peer, { kind: RTC.ANSWER, sdp: pc.localDescription });
        }
      } catch (err) {
        console.warn('[DC] setRemoteDescription failed', err);
      }
    }

    // ---- traffic ------------------------------------------------------------

    /**
     * @param {object} msg
     * @param {'ctl'|'fx'} lane
     * @param {string|null} to  one peer, or every peer when omitted
     */
    send(msg, lane = 'ctl', to = null) {
      if (to) {
        const peer = this.peers.get(to);
        return peer ? this.sendTo(peer, msg, lane) : false;
      }
      if (!this.peers.size) return false;
      // One serialisation for the whole mesh: strokes broadcast ~25 times a
      // second and re-stringifying per peer is the only cost that scales here.
      const wire = JSON.stringify(msg);
      let any = false;
      for (const peer of this.peers.values()) {
        if (this.sendTo(peer, msg, lane, wire)) any = true;
      }
      return any;
    }

    sendTo(peer, msg, lane, wire) {
      const channel = lane === 'fx' ? (peer.fx || peer.ctl) : peer.ctl;
      if (channel?.readyState === 'open') {
        channel.send(wire ?? JSON.stringify(msg));
        return true;
      }
      // Buffer only control traffic: replaying stale stroke points is pointless.
      if (lane === 'ctl' && peer.queue.length < MAX_QUEUE) peer.queue.push(msg);
      return false;
    }

    // ---- shutdown -----------------------------------------------------------

    /** Drop one peer's connection but keep its record, so it can be rebuilt. */
    teardown(peer) {
      for (const channel of [peer.ctl, peer.fx]) {
        if (!channel) continue;
        channel.onmessage = channel.onopen = channel.onclose = null;
        try { channel.close(); } catch {}
      }
      peer.ctl = peer.fx = null;
      if (peer.pc) {
        peer.pc.onicecandidate = peer.pc.onnegotiationneeded = null;
        peer.pc.onconnectionstatechange = peer.pc.ondatachannel = null;
        try { peer.pc.close(); } catch {}
        peer.pc = null;
      }
      peer.makingOffer = false;
      peer.ignoreOffer = false;
      peer.queue.length = 0;
      peer.builtAt = 0;
      // Clearing the cooldown is what lets the sweep re-ask straight away after
      // a reload, instead of sitting out the rest of the window.
      peer.askedAt = 0;
      this.refreshStatus();
    }

    close() {
      clearInterval(this.sweepTimer);
      this.sweepTimer = 0;
      for (const id of [...this.peers.keys()]) this.dropPeer(id);
      this.setStatus('idle');
    }
  }

  NS.PeerLink = PeerLink;
})();
