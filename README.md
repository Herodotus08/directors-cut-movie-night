# Director's Cut: Interactive Movie Night

https://github.com/user-attachments/assets/4befddb9-3ed5-49cd-b180-fa5a5f7333ec

A Manifest V3 browser extension that turns separate streaming tabs — up to eight
of them, in as many countries — into one shared room: sub-second playback sync, a
shared sketchpad that draws over the video, emoji missiles that fly across every
screen, and "jolts" that buzz a paired phone.

Everything interactive runs **peer-to-peer over WebRTC data channels**, in a full
mesh. The bundled Node server is a rendezvous point only — it brokers the
handshake, then goes quiet.

```
extension/
  manifest.json
  lib/        protocol.js (shared constants + message maps), id.js (room codes)
  background/ service-worker.js — owns the signalling socket + session state
  content/    rtc.js, video-sync.js, overlay.js, sketchpad.js, emoji.js, content.js
  popup/      popup.html/css/js — create or join a room
server/
  server.js   HTTP + ws (/signal, /bridge) + optional socket.io, one port
  rooms.js    transport-agnostic room core
  public/     mobile.html + jolt.js — the reference phone haptic sink
  Dockerfile  container image for hosts that want one
render.yaml   one-click deploy of server/ as a public wss:// rendezvous
```

## Quick start

**1. Run the signalling server**

```bash
cd server
npm install
npm start          # ws://localhost:8080/signal  and  ws://localhost:8080/bridge
```

`GET /health` returns `{ ok, rooms, clients, max, uptime }`. Everyone must reach
the same server: for anything beyond one machine, put it behind TLS and use a
`wss://` URL (a `ws://` origin is blocked from an `https://` streaming page). See
[Watching from different countries](#watching-from-different-countries).

**2. Load the extension**

`chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension/` folder. Chrome 116+.

**3. Pair**

One person clicks **Start a movie night** — the room code is copied to the
clipboard automatically. Everyone else pastes it into **join a room** and presses
**Join**. The status pill goes `linking… → synced`, and **Watching** in the popup
counts the room (`you + 3`).

Open the same title in every tab and press play once. From there play, pause and
seek propagate — anyone can drive.

**4. (Optional) Pair a phone for haptics**

Open `http://<server-host>:8080/` on the phone, enter the same room code, and
tap once to arm vibration (browsers refuse to vibrate without a gesture).
`?room=XXXX-...` in the URL auto-pairs, so a QR code can carry the code.

## Controls

| Action | Where |
| --- | --- |
| Toggle sketchpad | toolbar ✏️, popup **Sketch**, or `Alt+D` |
| Fire an emoji | toolbar picker or the popup emoji grid |
| Send a jolt | toolbar ⚡, popup **Jolt**, or `Alt+J` |
| Hide/show the toolbar | toolbar ✕, popup **Toolbar**, or `Alt+H` |
| End the session | popup **End session** |

Brush colour and width live in the popup and are shared through
`chrome.storage`, so they survive a reload.

## How the synchronisation works

Three layers, each solving a different problem.

**A shared clock.** Peers exchange NTP-style probes over the reliable `ctl`
channel: `offset = t1 − (t0 + t3)/2`, `rtt = t3 − t0`. The reported offset is the
median of the lowest-RTT half of a rolling window, which throws away samples
that were delayed in one direction only.

**Sequenced intents, not state mirroring.** Play/pause/seek are sent as
monotonically numbered intents carrying the position *and* the wall-clock time
they were taken. The receiver projects the position forward by the elapsed
shared-clock time before applying it, so a 200 ms flight does not become 200 ms
of drift. Every locally applied change records a state fingerprint, and the
`play`/`pause`/`seeked` event it provokes is matched against that fingerprint
and swallowed — without this, each peer would echo the other forever.

**Continuous drift control, with the gentlest tool that will work.** Once per
second every peer broadcasts its position, and each follower compares its own
`currentTime` against the *reference's* projected position:

| Drift | Correction |
| --- | --- |
| > 1.0 s | hard seek (`fastSeek` where available), biased by half the RTT |
| > 0.12 s | trim `playbackRate` by up to ±5 % and glide back |
| < 0.03 s | restore the base rate |

**One reference clock, chosen without negotiating.** Everybody chasing everybody
is what makes naive implementations oscillate, so the room elects a **leader**:
the lowest server-assigned id present. Every peer derives the same answer from
the same roster, so no extra round trip is needed, and the election re-runs
whenever somebody joins or leaves. Only followers correct. The leader never moves
on anyone else's account — it instead reports the room's *worst* delta, which is
the one number that says whether the party is actually together.

Clock offsets are per peer, not per room: clock error is a property of the path,
so one shared offset would be wrong for everyone except whoever answered last.
Sequence numbers are per sender too — a single counter would let the busiest
peer's numbers swallow everybody else's intents. Intents are applied by everyone
and never rebroadcast, because the mesh is already complete and a relay would
loop forever.

Buffering is explicit rather than inferred: a stalled player broadcasts `stall`,
everyone pauses with a `pausedForPeer` flag, and the room resumes once *every*
stalled peer has sent `resume` (or left). The 1 second hard-seek threshold is the
requirement this layer exists to satisfy — in practice the rate trim keeps the
delta an order of magnitude below it.

## Architecture notes

**The service worker owns the WebSocket; the content script owns the peer
connection.** `RTCPeerConnection` does not exist in a service worker, and a
signalling socket opened from a content script would be subject to the page's
CSP and would die on every navigation. They are bridged by a long-lived
`chrome.runtime` port, and the content script re-opens that port after a
disconnect to revive an evicted worker (`chrome.alarms` keeps it warm otherwise).

**Perfect negotiation, per pair.** Every viewer connects straight to every other
viewer, so a room of *n* screens is *n(n−1)/2* peer connections. Routing
everything through one host would be fewer sockets, but it would also make one
person's laptop the single point of failure and double everyone else's latency;
these channels carry short JSON frames and never media, so the mesh stays cheap
at the sizes a watch party actually reaches. Within each pair the higher id is
**polite** and rolls back its own offer on collision instead of failing, so a
reload anywhere cannot deadlock a handshake. A per-instance epoch detects a peer
reload, `restartIce()` (impolite side only) handles a network change mid-session,
and a 4 s sweep re-asks for an offer that never arrived.

**Two data channels.** `ctl` is ordered and reliable (intents, clock probes).
`fx` is unordered with `maxRetransmits: 1` — a lost stroke point should never
hold up the next one.

**The overlay lives in a closed shadow root** so page CSS cannot reach it, and
its stylesheet is `fetch`ed into a constructable `CSSStyleSheet` (a content
script's fetch is exempt from page CSP, unlike a `<link>` the page can block).
The host re-parents itself into `document.fullscreenElement` when you go
fullscreen. Stroke coordinates are normalised to 0..1 against the video box, so
two different window sizes still see the same drawing; each point carries its
own birth timestamp so strokes dissolve tail-first over 3 s.

**With `all_frames: true`, frames arbitrate.** Each frame reports the pixel area
of the largest video it can see; the worker keeps the biggest and tells the rest
to stand down. A challenger must be 1.25× larger to displace the incumbent,
which stops two similar frames from trading the role back and forth.

**Room codes are capabilities.** 100 bits from `crypto.getRandomValues`,
Crockford base32 (no I/L/O/U), grouped `XXXX-XXXX-XXXX-XXXX-XXXX`. The server
validates the shape, caps a room at 8 viewers + 8 phones, rate-limits each client
to 200 messages/second (a mesh handshake is one offer/answer plus every ICE
candidate times every other viewer, so the burst is much larger than a pairwise
one), and refuses new sockets past a whole-process `MAX_CLIENTS` ceiling. It never
parses SDP — payloads are relayed byte-for-byte. Data channels are DTLS-encrypted
end to end, so there is no app-layer crypto to get wrong.

## Watching from different countries

Two things have to change for a long-distance room.

**1. A signalling server everyone can reach, over `wss://`.** `render.yaml` is a
Render blueprint that deploys `server/` as-is: push this repo, then Render → New →
Blueprint → pick it. Any host that gives you a TLS URL and supports WebSocket
upgrades works the same way — the process honours `PORT`, answers `/health`, and
`server/Dockerfile` covers hosts that want a container. Paste the resulting
`wss://<host>/signal` into popup → **Advanced** → **Signaling server**; do the
same with `wss://<host>/bridge` if you use phone haptics.

`ws://` will not work from a remote host: the streaming page is `https`, so an
insecure socket is blocked as mixed content.

**2. A TURN relay, if a direct path cannot be found.** STUN only *discovers* an
address; it cannot help two people who are both behind a symmetric NAT or a
locked-down corporate/university network, and that is the usual reason a link
sits on `linking…` forever. Put a relay in popup → **Advanced** → **TURN relay**
with its username and password (several URLs may be given comma- or
space-separated, so one credential pair can cover udp/tcp/tls). Relaying is
affordable here because only these JSON frames traverse it — never the video.

A change to the relay applies to connections built from then on, so if a link has
already failed, **End session** and rejoin.

## Sites

The overlay is matched on every `http`/`https` page, in every frame, so streaming
sites, embed aggregators and self-hosted `<video>` all work with no site list to
maintain. Frames without a plausible player never even open a port to the worker.

Picking "the film" out of a page is a score, not a rule: pixel area, whether the
element has decoded frames or a source, a bonus for a feature-length or live
duration, and a penalty for the short muted loops an aggregator index page is
paved with. If the light DOM has no `<video>` at all, open shadow roots are
walked as a fallback for custom-element players.

Aggregators that open the real player in a **new tab** are handled by letting the
session follow: the bound tab keeps priority for as long as it keeps claiming
(every 5 s), and once it goes quiet — navigated away, lost its player, or closed
— the next claim from any tab inherits the room within a few seconds. Closing the
index tab therefore no longer ends the session; use **End session** for that.

If a tab was already open before the extension loaded, the popup → **Advanced** →
**Re-scan this tab** injects the content scripts on the spot instead of making
you reload.

## Known limits

- **DRM/EME players.** Playback control works, but the extension never touches
  protected frames, so nothing is captured or re-streamed — you each stream
  your own copy. Both people need their own subscription.
- **Netflix's custom player** swallows some synthetic events; a hard seek
  occasionally needs a second nudge.
- **Closed shadow roots and sandboxed cross-origin iframes** are invisible to a
  content script. A player hidden in either one cannot be found, and in a
  sandboxed frame `chrome.runtime` may not exist at all.
- **No TURN server is configured by default.** Two peers both behind symmetric
  NAT will fail to connect until one is added in popup → **Advanced**; see
  [Watching from different countries](#watching-from-different-countries).
- **Eight viewers per room.** A full mesh is *n(n−1)/2* connections, so this is a
  comfort limit rather than a protocol one; past that the clock chatter starts to
  show. Raise `LIMITS.VIEWERS` in `server/rooms.js` if you want to find out.
- **No icon assets.** Chrome shows a default puzzle piece; drop PNGs in and add
  an `icons` block if you care.
- **`ws://localhost` is the default.** A remote server must be `wss://`.
- **Ad breaks desync.** Different ad pods on each side are indistinguishable
  from a seek; pause until everyone is back.
