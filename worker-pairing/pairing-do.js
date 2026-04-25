/**
 * pairing-do.js — PairingChannel Durable Object.
 *
 * One DO instance per pairingId. Holds at most two WebSockets — one for
 * the phone, one for the PC bridge — and forwards envelope frames between
 * them without ever decrypting payload bytes.
 *
 * Hibernation model:
 *   We use the Hibernatable WebSocket API (state.acceptWebSocket) so that
 *   the DO unloads between messages and we don't pay for idle pairings.
 *   In-memory state (the replay buffer) does NOT survive hibernation; if
 *   a peer reconnects with RESUME_REQ after a cold wake, we honestly
 *   reply RESUME_FAIL(HIBERNATED) and the peer redoes the Noise handshake.
 *   This is intentional: persisting every frame to DO storage would be
 *   needlessly expensive for what's already a forward-secret transport.
 *
 * Replay buffer:
 *   Each peer's outbox keeps frames they've sent that the OTHER peer may
 *   not have received yet. ACKs from the other peer GC the outbox up to
 *   the acked seq. RESUME_REQ from a reconnecting peer replays unacked
 *   frames in their outbox-from-counterparty.
 *
 * Frame routing summary:
 *   FRAME_DATA       buffer + forward to peer
 *   FRAME_ACK        GC counterparty's outbox up to acked seq
 *   FRAME_PING       reply with PONG (relay-local)
 *   FRAME_PONG       drop (was just keepalive)
 *   FRAME_RESUME_REQ check buffer, reply OK + replay or FAIL
 *   FRAME_RESUME_OK
 *   FRAME_RESUME_FAIL  reject (clients shouldn't send these to relay)
 */

import {
  decode,
  encodePong,
  encodeResumeOk,
  encodeResumeFail,
  FRAME_DATA,
  FRAME_ACK,
  FRAME_PING,
  FRAME_PONG,
  FRAME_RESUME_REQ,
  FRAME_RESUME_OK,
  FRAME_RESUME_FAIL,
  RESUME_FAIL_BUFFER_EXPIRED,
  RESUME_FAIL_HIBERNATED,
  frameTypeName,
} from "../scripts/lib/remote-pairing/envelope.mjs";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Frames in an outbox older than this are dropped (peer must re-handshake). */
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Hard cap to prevent memory blow-up on a stuck peer. */
const MAX_BUFFERED_FRAMES = 1024;

/** Close codes (private 4xxx range, reserved for application protocols). */
const CODE_PROTOCOL_ERROR = 4001;
const CODE_REPLACED = 4003;
const CODE_HIBERNATED = 4004;
const CODE_INTERNAL = 4099;

const VALID_ROLES = new Set(["phone", "bridge"]);

// ---------------------------------------------------------------------------
// PairingChannel
// ---------------------------------------------------------------------------

export class PairingChannel {
  /**
   * @param {DurableObjectState} state
   * @param {object} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // role → PeerState. PeerState shape:
    //   {
    //     socket:   WebSocket | null  (current accepted ws; null if disconnected)
    //     outbox:   Array<{ seq, mid, ts, wire }>
    //                 frames this peer has SENT that the counterparty may
    //                 still need (replay candidates)
    //     lastSent: number
    //                 highest seq this peer has ever sent. Used by RESUME to
    //                 disambiguate "outbox empty because everything was
    //                 ACK'd" from "outbox empty because we hibernated".
    //     coldWake: boolean
    //                 true on hibernation wake — outbox is empty but the
    //                 peer might think we still have buffered state. We use
    //                 this to send HIBERNATED on RESUME_REQ.
    //   }
    /** @type {Map<string, { socket: WebSocket|null, outbox: Array<{seq:number, mid:Uint8Array, ts:number, wire:Uint8Array}>, lastSent: number, coldWake: boolean }>} */
    this.peers = new Map();

    // Re-attach any sockets that survived hibernation. Their attachment
    // tells us which role they belong to. The outbox is empty — we treat
    // any further RESUME_REQ as a hibernation event.
    for (const ws of state.getWebSockets()) {
      const att = safeAttachment(ws);
      const role = att?.role;
      if (!role || !VALID_ROLES.has(role)) {
        try { ws.close(CODE_INTERNAL, "rehydrate failed"); } catch {}
        continue;
      }
      this.peers.set(role, {
        socket: ws,
        outbox: [],
        lastSent: 0,
        coldWake: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // HTTP entry point — WebSocket upgrade
  // -------------------------------------------------------------------------

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected WebSocket upgrade", { status: 426 });
    }
    const role = url.searchParams.get("role");
    if (!role || !VALID_ROLES.has(role)) {
      return new Response("invalid role", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // If a peer already holds this role slot, kick the old one. This makes
    // visibility-change reconnects on the phone "just work" — the new socket
    // takes over and the old one closes with a recognisable code.
    const existing = this.peers.get(role);
    if (existing?.socket) {
      try {
        existing.socket.close(CODE_REPLACED, "replaced");
      } catch {
        // Already closed — fine.
      }
    }

    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    // Preserve any existing outbox + lastSent so a reconnecting peer can
    // RESUME. lastSent is what lets us answer "yes, you've seen everything"
    // even after the outbox has been fully GC'd by ACKs.
    const existingOutbox = existing?.outbox ?? [];
    const existingLastSent = existing?.lastSent ?? 0;
    this.peers.set(role, {
      socket: server,
      outbox: existingOutbox,
      lastSent: existingLastSent,
      coldWake: false,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle (called by the runtime)
  // -------------------------------------------------------------------------

  /**
   * @param {WebSocket} ws
   * @param {ArrayBuffer | string} message
   */
  async webSocketMessage(ws, message) {
    if (typeof message === "string") {
      this._closeWithError(ws, CODE_PROTOCOL_ERROR, "binary frames only");
      return;
    }

    const role = roleOf(ws);
    if (!role) {
      this._closeWithError(ws, CODE_INTERNAL, "missing role attachment");
      return;
    }

    let frame;
    try {
      frame = decode(message);
    } catch (err) {
      this._closeWithError(ws, CODE_PROTOCOL_ERROR, `envelope: ${err.message}`);
      return;
    }

    const peer = this.peers.get(role);
    if (!peer) {
      // Cold wake without a matching attachment — should be rare.
      this._closeWithError(ws, CODE_INTERNAL, "no peer state");
      return;
    }

    const otherRole = role === "phone" ? "bridge" : "phone";
    const other = this.peers.get(otherRole);

    switch (frame.type) {
      case FRAME_DATA: {
        // Stash for potential replay on counterparty reconnect.
        const wire = toUint8(message);
        peer.outbox.push({ seq: frame.seq, mid: frame.mid, ts: Date.now(), wire });
        if (frame.seq > peer.lastSent) peer.lastSent = frame.seq;
        peer.coldWake = false; // any successful message clears the cold flag
        trimOutbox(peer.outbox);
        // Forward to peer if they're connected.
        if (other?.socket && isOpen(other.socket)) {
          trySend(other.socket, wire);
        }
        // (If the other peer is offline, the frame just sits in our outbox
        // until they reconnect with RESUME_REQ or the buffer ages out.)
        break;
      }

      case FRAME_ACK: {
        // The acked seq belongs to the OTHER peer's send-side counter.
        // We GC their outbox up to (and including) that seq.
        if (other) {
          other.outbox = other.outbox.filter((e) => e.seq > frame.seq);
        }
        break;
      }

      case FRAME_PING: {
        trySend(ws, encodePong());
        break;
      }

      case FRAME_PONG: {
        // Echo of our PING — keepalive only, no action.
        break;
      }

      case FRAME_RESUME_REQ: {
        this._handleResume(ws, peer, other, frame.lastSeenSeq);
        break;
      }

      case FRAME_RESUME_OK:
      case FRAME_RESUME_FAIL: {
        // Clients only emit RESUME_REQ; OK/FAIL are server-to-client.
        this._closeWithError(ws, CODE_PROTOCOL_ERROR, `unexpected ${frameTypeName(frame.type)} from client`);
        break;
      }

      default:
        this._closeWithError(ws, CODE_PROTOCOL_ERROR, "unknown frame type");
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {number} code
   * @param {string} reason
   * @param {boolean} wasClean
   */
  async webSocketClose(ws, code, reason, wasClean) {
    const role = roleOf(ws);
    if (!role) return;
    const peer = this.peers.get(role);
    if (peer && peer.socket === ws) {
      peer.socket = null;
      // Keep the outbox so a quick reconnect can RESUME from here.
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {Error} error
   */
  async webSocketError(ws, error) {
    await this.webSocketClose(ws, 1011, String(error?.message ?? error), false);
  }

  // -------------------------------------------------------------------------
  // RESUME handling
  // -------------------------------------------------------------------------

  _handleResume(ws, peer, other, lastSeenSeq) {
    // The peer is saying "I last saw seq=lastSeenSeq from the other side."
    // We need to replay frames in OTHER's outbox with seq > lastSeenSeq.
    if (peer.coldWake) {
      trySend(ws, encodeResumeFail(RESUME_FAIL_HIBERNATED));
      peer.coldWake = false;
      return;
    }

    const otherLastSent = other?.lastSent ?? 0;

    // Peer is fully caught up — they've seen everything the other side
    // ever sent. This is the common case after a clean disconnect (the ACK
    // for the last DATA already GC'd the outbox). Also covers the fresh
    // session start where both sides are at 0.
    if (lastSeenSeq >= otherLastSent) {
      trySend(ws, encodeResumeOk(otherLastSent));
      return;
    }

    if (!other || other.outbox.length === 0) {
      // Other has sent more than peer claims to have seen, but our buffer
      // is empty. Either we hibernated (lost the buffer), or peer's
      // counter is desynced. Either way, force a re-handshake.
      trySend(ws, encodeResumeFail(RESUME_FAIL_HIBERNATED));
      return;
    }

    const earliestBuffered = other.outbox[0].seq;

    if (lastSeenSeq + 1 < earliestBuffered) {
      // Gap: we'd skip frames the peer hasn't seen. Force re-handshake.
      trySend(ws, encodeResumeFail(RESUME_FAIL_BUFFER_EXPIRED));
      return;
    }

    // OK — confirm the resume point, then replay everything strictly after
    // lastSeenSeq. We send RESUME_OK first so the peer knows the bounds.
    trySend(ws, encodeResumeOk(otherLastSent));
    for (const entry of other.outbox) {
      if (entry.seq > lastSeenSeq) {
        trySend(ws, entry.wire);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _closeWithError(ws, code, reason) {
    try {
      ws.close(code, reason.slice(0, 120)); // CF caps reason length
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function safeAttachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function roleOf(ws) {
  const att = safeAttachment(ws);
  return att?.role && VALID_ROLES.has(att.role) ? att.role : null;
}

function trySend(ws, data) {
  try {
    ws.send(data);
  } catch {
    // Socket closed under us; the close handler will clean up.
  }
}

function isOpen(ws) {
  // 1 === OPEN, both in CF Workers (`WebSocket.READY_STATE_OPEN`) and standard
  // browser/Node WebSocket implementations. We avoid the named constant so
  // this module can run under a unit-test harness without a `WebSocket` global.
  return ws.readyState === 1;
}

function toUint8(message) {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  // Defensive: shouldn't happen — webSocketMessage gives us ArrayBuffer for binary.
  return new Uint8Array(message);
}

function trimOutbox(outbox) {
  // Drop entries older than BUFFER_TTL_MS.
  const cutoff = Date.now() - BUFFER_TTL_MS;
  while (outbox.length > 0 && outbox[0].ts < cutoff) {
    outbox.shift();
  }
  // Hard cap (defends against stuck peers / unsent backlog).
  while (outbox.length > MAX_BUFFERED_FRAMES) {
    outbox.shift();
  }
}
