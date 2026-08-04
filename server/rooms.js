/**
 * Director's Cut — room core.
 *
 * Deliberately transport-agnostic: this file knows nothing about `ws`,
 * socket.io or HTTP. A "client" is any object with `{ id, role, send(msg) }`,
 * which lets the same rooms be driven by both transports in server.js and
 * exercised directly in tests.
 *
 * The server is a *rendezvous point only*. It sees room codes and opaque
 * signalling blobs; SDP payloads are relayed byte-for-byte and never parsed,
 * and once the peers are connected their traffic never comes back here.
 */
'use strict';

const SIG = {
  JOIN: 'join',
  JOINED: 'joined',
  PEER: 'peer',
  SIGNAL: 'signal',
  JOLT: 'jolt',
  LEAVE: 'leave',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
};

const LIMITS = {
  // A full mesh is O(n²) connections, so this is a comfort limit, not a protocol
  // one: 8 screens is 28 peer connections, which a laptop handles because the
  // channels only carry text. Past that the clock chatter starts to show.
  VIEWERS: 8,
  PHONES: 8,
  ROOM_CODE: /^[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){4}$/,  // Crockford base32, 5x4
  RATE_WINDOW_MS: 1000,
  // Interactive traffic is P2P, so this only has to cover a handshake burst —
  // but a mesh handshake is one offer/answer plus every ICE candidate times
  // every other viewer, which at 8 screens is well past the old 40.
  RATE_BURST: 200,
};

let nextId = 1;

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Map();   // id -> client
    this.createdAt = Date.now();
  }

  get viewers() {
    return [...this.clients.values()].filter((c) => c.role === 'viewer');
  }

  get phones() {
    return [...this.clients.values()].filter((c) => c.role === 'phone');
  }
}

class RoomHub {
  constructor({ log = () => {} } = {}) {
    this.rooms = new Map();
    this.log = log;
  }

  /** Wrap a transport socket in the shape the hub expects. */
  attach(sendFn, { role = 'viewer', fixedRole = false } = {}) {
    return {
      id: `p${nextId++}`,
      role,
      fixedRole,   // set by transports that decide the role themselves
      room: null,
      send: (msg) => { try { sendFn(msg); } catch { /* socket already gone */ } },
      rate: { count: 0, since: Date.now() },
      alive: true,
    };
  }

  /** Cheap token bucket: one misbehaving client cannot flood the others. */
  allow(client) {
    const now = Date.now();
    if (now - client.rate.since > LIMITS.RATE_WINDOW_MS) {
      client.rate.since = now;
      client.rate.count = 0;
    }
    if (++client.rate.count > LIMITS.RATE_BURST) {
      this.error(client, 'rate-limited', 'Too many messages.');
      return false;
    }
    return true;
  }

  error(client, code, message) {
    client.send({ t: SIG.ERROR, code, message });
  }

  handle(client, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    if (!this.allow(client)) return;

    switch (msg.t) {
      case SIG.JOIN:   this.join(client, msg); break;
      case SIG.SIGNAL: this.relaySignal(client, msg); break;
      case SIG.JOLT:   this.relayJolt(client, msg); break;
      case SIG.LEAVE:  this.leave(client); break;
      case SIG.PING:   client.send({ t: SIG.PONG, ts: msg.ts }); break;
      case SIG.PONG:   break;
      default:
        this.error(client, 'unknown-type', `Unsupported message: ${msg.t}`);
    }
  }

  join(client, msg) {
    const code = String(msg.room || '').trim().toUpperCase();
    if (!LIMITS.ROOM_CODE.test(code)) {
      this.error(client, 'bad-room', 'Room code must be 5 groups of 4 characters.');
      return;
    }
    if (client.room) this.leave(client, { silent: client.room === code });

    // A /bridge client cannot promote itself to 'viewer' — that would both take
    // a viewer slot and make the server relay SDP to a device that is a sink.
    if (!client.fixedRole && (msg.role === 'phone' || msg.role === 'viewer')) client.role = msg.role;
    const room = this.rooms.get(code) || new Room(code);
    this.rooms.set(code, room);

    const cap = client.role === 'phone' ? LIMITS.PHONES : LIMITS.VIEWERS;
    const taken = client.role === 'phone' ? room.phones.length : room.viewers.length;
    if (taken >= cap) {
      this.error(client, 'room-full', `This room already has ${cap} ${client.role}s.`);
      if (!room.clients.size) this.rooms.delete(code);
      return;
    }

    client.room = code;
    room.clients.set(client.id, client);

    // Viewers need the roster to elect negotiation roles; phones are pure sinks.
    const peers = room.viewers.filter((c) => c.id !== client.id).map((c) => c.id);
    client.send({ t: SIG.JOINED, room: code, peerId: client.id, peers, role: client.role });
    if (client.role === 'viewer') {
      this.broadcast(room, { t: SIG.PEER, event: 'join', peerId: client.id }, client.id, 'viewer');
    }
    this.log(`join ${code} ${client.id} (${client.role}) — ${room.clients.size} in room`);
  }

  leave(client, { silent = false } = {}) {
    const room = client.room && this.rooms.get(client.room);
    client.room = null;
    if (!room) return;
    room.clients.delete(client.id);
    if (!silent && client.role === 'viewer') {
      this.broadcast(room, { t: SIG.PEER, event: 'leave', peerId: client.id }, client.id, 'viewer');
    }
    if (!room.clients.size) this.rooms.delete(room.code);
    this.log(`leave ${room.code} ${client.id} — ${room.clients.size} left`);
  }

  /**
   * Opaque unicast relay: `data` is never inspected.
   *
   * `to` is required once a room holds more than two viewers — "the other one"
   * stops being a well-defined target. The extension always sends it; the
   * fallback only exists for a 1:1 room and hand-driven testing.
   */
  relaySignal(client, msg) {
    const room = client.room && this.rooms.get(client.room);
    if (!room) return this.error(client, 'not-joined', 'Join a room first.');
    const others = room.viewers.filter((c) => c.id !== client.id);
    const target = msg.to ? room.clients.get(msg.to)
      : others.length === 1 ? others[0] : null;
    if (!target) return this.error(client, 'no-peer', 'That peer is not in the room.');
    target.send({ t: SIG.SIGNAL, from: client.id, data: msg.data });
  }

  /**
   * A jolt fans out to everything else in the room — every other viewer's screen
   * and every paired phone. Only the pattern survives; nothing else is trusted.
   */
  relayJolt(client, msg) {
    const room = client.room && this.rooms.get(client.room);
    if (!room) return this.error(client, 'not-joined', 'Join a room first.');
    const pattern = Array.isArray(msg.pattern)
      ? msg.pattern.slice(0, 12).map((n) => Math.min(600, Math.max(0, Number(n) || 0)))
      : [90, 60, 140];
    const frame = {
      t: SIG.JOLT,
      from: client.id,
      pattern,
      intensity: Math.min(1, Math.max(0, Number(msg.intensity ?? 1) || 0)),
      at: Date.now(),
    };
    this.broadcast(room, frame, client.id);
  }

  broadcast(room, msg, exceptId, role) {
    for (const c of room.clients.values()) {
      if (c.id === exceptId) continue;
      if (role && c.role !== role) continue;
      c.send(msg);
    }
  }

  stats() {
    return {
      rooms: this.rooms.size,
      clients: [...this.rooms.values()].reduce((n, r) => n + r.clients.size, 0),
    };
  }
}

module.exports = { RoomHub, Room, SIG, LIMITS };
