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

/**
 * Hard cap on the cumulative wire bytes a single peer's outbox may hold.
 * Independent of MAX_BUFFERED_FRAMES so a small number of huge frames can't
 * sneak past the count limit. 8 MB is a generous ceiling — legitimate Noise
 * payloads are kilobytes; anything close to this means the peer is either
 * misbehaving or under attack.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Largest per-drain replay we'll ever blast at a freshly connected
 * counterparty. Even with a healthy outbox, dumping >4 MB into a single
 * WebSocket on attach is suspicious; the rest stays buffered (or ages
 * out via BUFFER_TTL_MS) and gets resumed via RESUME_REQ if needed.
 */
const MAX_DRAIN_BYTES = 4 * 1024 * 1024;

/**
 * Wire size of a Noise IK msg1 with an empty application payload:
 *   e          (32 bytes ephemeral pub)
 * + s_encrypted (32 + 16 AEAD tag = 48 bytes)
 * + payload    (0 + 16 AEAD tag = 16 bytes)
 *   = 96 bytes
 *
 * The DO can't (and shouldn't) decrypt msg1, but it can refuse to interpret
 * a wildly wrong-shaped DATA frame as "this is a fresh handshake, please
 * tear the bridge down on my behalf" — see prepareCounterpartyForFreshHandshake.
 * Anything else gets queued like ordinary DATA and the bridge will detect
 * the protocol mismatch on its own (slower, but no DoS amplification).
 */
const NOISE_IK_MSG1_BYTES = 96;

/** First envelope-level seq number a fresh socket should ever send. */
const FIRST_DATA_SEQ = 1;

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
    //     awaitingFirstFrame: boolean
    //                 true immediately after a socket connects. If the first
    //                 meaningful frame is DATA, this is a fresh handshake
    //                 rather than RESUME, so stale same-role outbox entries
    //                 from earlier failed handshakes must be discarded.
    //     expectFreshHandshake: boolean
    //                 true after this peer received RESUME_FAIL. Clients keep
    //                 envelope seq monotonic across re-handshakes, so the
    //                 next fresh Noise msg1 may have seq>1.
    //     freshHandshakeBuffered: boolean
    //                 true when the outbox contains a buffered fresh msg1
    //                 that may be rendezvous-drained to a waiting bridge.
    //   }
    /** @type {Map<string, { socket: WebSocket|null, outbox: Array<{seq:number, mid:Uint8Array, ts:number, wire:Uint8Array}>, lastSent: number, coldWake: boolean, awaitingFirstFrame?: boolean, expectFreshHandshake?: boolean, freshHandshakeBuffered?: boolean }>} */
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
        awaitingFirstFrame: true,
        expectFreshHandshake: false,
        freshHandshakeBuffered: false,
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
    const pairingHint = shortPairingFromUrl(url);

    const existing = this.peers.get(role);
    const replacing = Boolean(existing?.socket && isOpen(existing.socket));
    if (existing?.socket && isOpen(existing.socket)) {
      // Controlled same-role replace. iOS can briefly keep the old PWA WS
      // alive while a foregrounded/reloaded tab opens the new one; rejecting
      // that second socket leaves legitimate off-LAN reconnects stuck. The
      // relay token + rate limit gate admission, and Noise/allowlist still
      // authenticate the channel before any bridge RPC is served.
      try {
        existing.socket.close(CODE_REPLACED, "replaced");
      } catch {
        // Already closed — fine.
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, pairing: pairingHint });

    // Preserve any existing outbox + lastSent so a reconnecting peer can
    // RESUME. lastSent is what lets us answer "yes, you've seen everything"
    // even after the outbox has been fully GC'd by ACKs.
    const existingOutbox = existing?.outbox ?? [];
    const existingLastSent = existing?.lastSent ?? 0;
    const existingColdWake = existing?.coldWake === true;
    const existingExpectFreshHandshake = existing?.expectFreshHandshake === true;
    const existingFreshHandshakeBuffered = existing?.freshHandshakeBuffered === true;
    this.peers.set(role, {
      socket: server,
      outbox: existingOutbox,
      lastSent: existingLastSent,
      coldWake: existingColdWake,
      awaitingFirstFrame: true,
      expectFreshHandshake: existingExpectFreshHandshake,
      freshHandshakeBuffered: existingFreshHandshakeBuffered,
    });

    const otherRole = role === "phone" ? "bridge" : "phone";
    const other = this.peers.get(otherRole);
    console.log(
      `[relay-do-accept] pairing=${pairingHint} role=${role}` +
      ` replacing=${replacing ? "1" : "0"}` +
      ` otherOpen=${other?.socket && isOpen(other.socket) ? "1" : "0"}` +
      ` cold=${existingColdWake ? "1" : "0"}` +
      ` outbox=${existingOutbox.length}` +
      ` lastSent=${existingLastSent}`,
    );
    emitRelayMetric(this.env, {
      type: "do_accept",
      role,
      outcome: "success",
    });
    if (replacing) {
      emitRelayMetric(this.env, {
        type: "same_role_replace",
        role,
        outcome: "success",
      });
    }
    if (other?.socket && isOpen(other.socket)) {
      emitRelayMetric(this.env, {
        type: "relay_success",
        role,
        outcome: "success",
      });
    }

    // Note: replay/drain on attach used to live here. It's now driven
    // exclusively by the RESUME_REQ path — every reconnecting transport
    // (live session OR fresh process) sends RESUME_REQ as its first frame
    // after WS open, so the same replay code handles both cases coherently
    // and there's no double-delivery race with shouldDrainOnAccept firing
    // before the inbound RESUME_REQ arrives.

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
    if (peer.socket !== ws) {
      // A same-role replacement can race with frames already in flight from
      // the old socket. Those frames belong to a stale transport session and
      // must not be routed through the newly accepted peer slot.
      console.log(`[relay-do-stale-socket] pairing=${pairingOf(ws)} role=${role}`);
      try { ws.close(CODE_REPLACED, "stale-socket"); } catch {}
      return;
    }

    const otherRole = role === "phone" ? "bridge" : "phone";
    const other = this.peers.get(otherRole);
    const pairingHint = pairingOf(ws);

    switch (frame.type) {
      case FRAME_DATA: {
        // Only treat the very first DATA frame on a brand-new socket as a
        // potential Noise handshake restart, AND only if its shape is
        // consistent with a real Noise IK msg1. The PoW relay token blocks
        // anonymous spam but isn't a secret — anyone who pays the
        // proof-of-work can knock on this DO. We don't want such a knock
        // to convince the DO to evict the bridge socket on the basis of
        // arbitrary garbage in `frame.payload`.
        const looksLikeFirstFreshMsg1 =
          role === "phone" &&
          frame.payload?.length === NOISE_IK_MSG1_BYTES &&
          frame.seq === FIRST_DATA_SEQ &&
          (
            peer.awaitingFirstFrame === true ||
            peer.lastSent === 0
          );
        const looksLikeFreshMsg1 =
          role === "phone" &&
          frame.payload?.length === NOISE_IK_MSG1_BYTES &&
          (looksLikeFirstFreshMsg1 || peer.expectFreshHandshake === true);
        if (peer.awaitingFirstFrame || looksLikeFreshMsg1) {
          console.log(
            `[relay-do-data] pairing=${pairingHint} role=${role}` +
            ` seq=${frame.seq}` +
            ` bytes=${frame.payload?.length ?? 0}` +
            ` freshMsg1=${looksLikeFreshMsg1 ? "1" : "0"}` +
            ` otherOpen=${other?.socket && isOpen(other.socket) ? "1" : "0"}` +
            ` otherAwait=${other?.awaitingFirstFrame ? "1" : "0"}`,
          );
        }
        if (looksLikeFreshMsg1) {
          applyFreshHandshakeReset(peer);
          prepareCounterpartyForFreshHandshake(other);
        } else if (peer.expectFreshHandshake) {
          // We explicitly told this peer to discard stale Noise keys. Any
          // non-msg1 DATA here is stale ciphertext; buffering it would poison
          // the next rendezvous attempt.
          peer.outbox = [];
          peer.lastSent = 0;
          peer.freshHandshakeBuffered = false;
          this._closeWithError(ws, CODE_HIBERNATED, "expected-fresh-handshake");
          return;
        } else if (peer.awaitingFirstFrame) {
          // We've now seen a non-fresh-handshake first frame. Clear the flag
          // so we don't keep evaluating the kick condition for every
          // subsequent DATA on this socket. The frame itself is forwarded
          // normally; if the bridge can't decrypt it, the bridge will tear
          // its own transport down on the application side (no DoS
          // amplification through the relay).
          peer.awaitingFirstFrame = false;
        }
        // Stash for potential replay on counterparty reconnect.
        const wire = toUint8(message);
        peer.outbox.push({ seq: frame.seq, mid: frame.mid, ts: Date.now(), wire });
        if (frame.seq > peer.lastSent) peer.lastSent = frame.seq;
        peer.coldWake = false; // any successful message clears the cold flag
        peer.freshHandshakeBuffered = looksLikeFreshMsg1;
        trimOutbox(peer.outbox);
        // Forward to peer only after it has announced itself with RESUME_REQ
        // (which clears awaitingFirstFrame). If a phone msg1 races ahead of
        // the bridge's RESUME_REQ, buffer it and let the resume path replay
        // it once; direct-forwarding here would let the bridge receive msg1
        // twice (direct + replay) and fail the Noise transcript.
        if (
          other?.socket &&
          isOpen(other.socket) &&
          other.awaitingFirstFrame !== true
        ) {
          const sent = trySend(other.socket, wire);
          if (looksLikeFreshMsg1 || !sent) {
            console.log(
              `[relay-do-forward] pairing=${pairingHint} role=${role}` +
              ` to=${otherRole}` +
              ` seq=${frame.seq}` +
              ` freshMsg1=${looksLikeFreshMsg1 ? "1" : "0"}` +
              ` sent=${sent ? "1" : "0"}`,
            );
          }
        }
        // (If the other peer is offline or still awaiting its first frame,
        // the frame just sits in our outbox until they reconnect with
        // RESUME_REQ or the buffer ages out.)
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
        peer.awaitingFirstFrame = false;
        console.log(
          `[relay-do-resume-req] pairing=${pairingHint} role=${role}` +
          ` lastSeen=${frame.lastSeenSeq}` +
          ` cold=${peer.coldWake ? "1" : "0"}` +
          ` lastSent=${peer.lastSent}` +
          ` otherLastSent=${other?.lastSent ?? 0}` +
          ` otherOutbox=${other?.outbox?.length ?? 0}`,
        );
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
      console.log(`[relay-do-close] pairing=${pairingOf(ws)} role=${role} code=${code} reason=${String(reason || "").slice(0, 48)}`);
      emitRelayMetric(this.env, {
        type: "close",
        role,
        code,
        outcome: wasClean ? "success" : "failure",
      });
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
    const role = roleOf(ws) || "unknown";
    if (peer.coldWake) {
      console.log(`[relay-do-resume-fail] pairing=${pairingOf(ws)} role=${role} reason=HIBERNATED cold=1`);
      emitRelayMetric(this.env, {
        type: "resume_fail",
        role,
        outcome: "failure",
      });
      sendResumeFailAndMaybeDrainFreshHandshake(ws, peer, other, RESUME_FAIL_HIBERNATED);
      peer.coldWake = false;
      return;
    }

    // State-loss heuristic: if the peer says it's seen nothing yet
    // (lastSeenSeq=0) BUT it had previously been active (peer.lastSent>0,
    // i.e., the DO has buffered frames this peer once sent), the peer must
    // have lost its in-memory transport session — process restart, fresh
    // PWA install, etc. Replaying counterparty frames into a peer that
    // can't decrypt them just produces an AEAD-fail loop, so treat this
    // exactly like a RESUME_FAIL: the new peer has to redo the handshake,
    // and the counterparty has to come along for the ride (otherwise it'd
    // keep shipping ciphertext encrypted with the dead session's keys).
    if (lastSeenSeq === 0 && peer.lastSent > 0) {
      console.log(`[relay-do-resume-fail] pairing=${pairingOf(ws)} role=${role} reason=STATE_LOSS`);
      emitRelayMetric(this.env, {
        type: "resume_fail",
        role,
        outcome: "failure",
      });
      sendResumeFailAndMaybeDrainFreshHandshake(ws, peer, other, RESUME_FAIL_HIBERNATED);
      return;
    }

    const otherLastSent = other?.lastSent ?? 0;

    // Peer is fully caught up — they've seen everything the other side
    // ever sent. This is the common case after a clean disconnect (the ACK
    // for the last DATA already GC'd the outbox). Also covers the fresh
    // session start where both sides are at 0.
    if (lastSeenSeq >= otherLastSent) {
      console.log(`[relay-do-resume-ok] pairing=${pairingOf(ws)} role=${role} currentSeq=${otherLastSent} replay=0`);
      emitRelayMetric(this.env, {
        type: "resume_ok",
        role,
        outcome: "success",
      });
      trySend(ws, encodeResumeOk(otherLastSent));
      return;
    }

    if (!other || other.outbox.length === 0) {
      // Other has sent more than peer claims to have seen, but our buffer
      // is empty. Either we hibernated (lost the buffer), or peer's
      // counter is desynced. Either way, force a re-handshake.
      console.log(`[relay-do-resume-fail] pairing=${pairingOf(ws)} role=${role} reason=EMPTY_BUFFER`);
      emitRelayMetric(this.env, {
        type: "resume_fail",
        role,
        outcome: "failure",
      });
      sendResumeFailAndMaybeDrainFreshHandshake(ws, peer, other, RESUME_FAIL_HIBERNATED);
      return;
    }

    const earliestBuffered = other.outbox[0].seq;

    if (lastSeenSeq + 1 < earliestBuffered) {
      // Gap: we'd skip frames the peer hasn't seen. Force re-handshake.
      console.log(`[relay-do-resume-fail] pairing=${pairingOf(ws)} role=${role} reason=BUFFER_EXPIRED`);
      emitRelayMetric(this.env, {
        type: "resume_fail",
        role,
        outcome: "failure",
      });
      sendResumeFailAndMaybeDrainFreshHandshake(ws, peer, other, RESUME_FAIL_BUFFER_EXPIRED);
      return;
    }

    // OK — confirm the resume point, then replay everything strictly after
    // lastSeenSeq. We send RESUME_OK first so the peer knows the bounds.
    trySend(ws, encodeResumeOk(otherLastSent));
    let replayed = 0;
    for (const entry of other.outbox) {
      if (entry.seq > lastSeenSeq) {
        if (trySend(ws, entry.wire)) replayed++;
      }
    }
    console.log(`[relay-do-resume-ok] pairing=${pairingOf(ws)} role=${role} currentSeq=${otherLastSent} replay=${replayed}`);
    emitRelayMetric(this.env, {
      type: "resume_ok",
      role,
      outcome: "success",
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _closeWithError(ws, code, reason) {
    emitRelayMetric(this.env, {
      type: "protocol_error",
      role: roleOf(ws),
      code,
      outcome: "failure",
    });
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

function pairingOf(ws) {
  const att = safeAttachment(ws);
  return typeof att?.pairing === "string" && att.pairing ? att.pairing : "unknown";
}

function shortPairingFromUrl(url) {
  const match = String(url?.pathname || "").match(/^\/v1\/pairing\/([^/]+)\/ws$/);
  return match ? String(match[1]).slice(0, 8) : "unknown";
}

function applyFreshHandshakeReset(peer) {
  // A DATA frame as the first meaningful frame means this socket is starting
  // a fresh Noise handshake. Any same-role DATA left over from previous
  // failed handshakes would corrupt the new transcript if replayed later.
  peer.awaitingFirstFrame = false;
  peer.expectFreshHandshake = false;
  peer.freshHandshakeBuffered = false;
  peer.outbox = [];
  peer.lastSent = 0;
  peer.coldWake = false;
}

function prepareCounterpartyForFreshHandshake(peer) {
  if (!peer) return;

  // Don't kick a counterparty that has no live session yet. A peer with
  // `lastSent === 0` and an empty outbox has either just attached and only
  // sent RESUME_REQ(0) (so it's already in handshake mode waiting for
  // msg1/msg2), or it's been freshly reset by sendResumeFailAndMaybeDrain
  // FreshHandshake. Kicking in either case would trigger a feedback loop:
  // peer reconnects → RESUME_REQ(0) → state-loss heuristic → counterparty
  // gets closed by sendResumeFail... → counterparty reconnects → fresh
  // msg1 → kick again → ...
  //
  // Exception: after Durable Object hibernation, a WebSocket can survive
  // while the in-memory Noise/outbox state is gone. The client behind that
  // socket may still believe it is CONNECTED with old keys, but the DO sees
  // `lastSent=0/outbox=[]/awaitingFirstFrame=true`. If a fresh phone msg1
  // arrives in that state, the safe and fast move is to close the cold-wake
  // socket with 4004 so the bridge reconnects and receives the buffered msg1,
  // rather than leaving the phone to wait for its handshake timeout.
  if (peer.lastSent === 0 && peer.outbox.length === 0 && peer.coldWake !== true) {
    return;
  }

  peer.outbox = [];
  peer.lastSent = 0;

  // If the counterparty is already connected but has moved past its first
  // frame, it is holding an old Noise session. A fresh msg1 from the phone
  // would decrypt as "invalid tag" on that old session. Close it and force
  // its next RESUME_REQ to get RESUME_FAIL; once it re-enters HANDSHAKING we
  // can replay the buffered msg1 into the fresh responder.
  if (peer.socket && isOpen(peer.socket) && (!peer.awaitingFirstFrame || peer.coldWake === true)) {
    peer.coldWake = true;
    try {
      peer.socket.close(CODE_HIBERNATED, "fresh-handshake");
    } catch {
      // Already closed.
    }
    peer.socket = null;
    peer.awaitingFirstFrame = true;
    return;
  }

  // Offline counterparties with an old session must also be forced through
  // RESUME_FAIL when they return; otherwise they'd resume into stale keys.
  if (!peer.socket) {
    peer.coldWake = true;
  }
}

function sendResumeFailAndMaybeDrainFreshHandshake(ws, peer, other, reason) {
  const role = roleOf(ws);
  trySend(ws, encodeResumeFail(reason));

  // The peer that just received RESUME_FAIL will discard its session and
  // do a fresh handshake. Anything still queued in its DO outbox was
  // encrypted with the soon-to-be-discarded transport keys, so the new
  // session can't replay it — drop the buffer instead of leaking stale
  // ciphertext into the next handshake.
  if (peer) {
    peer.outbox = [];
    peer.lastSent = 0;
    // Only the phone/initiator's next DATA should be a Noise IK msg1. The
    // bridge is the responder; after RESUME_FAIL it waits for msg1 and then
    // sends msg2. Marking bridge as expectFreshHandshake causes that valid
    // msg2 to be rejected as "expected-fresh-handshake".
    peer.expectFreshHandshake = role === "phone";
    peer.freshHandshakeBuffered = false;
  }

  if (role !== "bridge") {
    // Phone got RESUME_FAIL — phone-side transport drops its session and
    // restarts the handshake on its own; no further DO-side action needed.
    return;
  }

  // Bridge got RESUME_FAIL → bridge will sit in handshake mode (responder)
  // waiting for a *fresh* msg1 from phone. Three cases for the phone slot:
  //
  //   (a) phone has a buffered fresh-handshake msg1
  //         Either it just connected (awaitingFirstFrame=true) or it already
  //         pushed its msg1 (the applyFreshHandshakeReset path leaves outbox
  //         = [msg1] with seq=1 / 96-byte payload). Drain that to the bridge
  //         so the handshake can complete.
  //
  //   (b) phone has stale post-handshake transport DATA
  //         The outbox is encrypted with keys the new bridge transport will
  //         never have. Forwarding it would AEAD-fail in a tight loop and
  //         starve the bridge of a real msg1. Close the phone WS so the
  //         phone-side transport drops its session and reconnects with
  //         fresh handshake state.
  //
  //   (c) phone has nothing buffered and is idle
  //         No fresh msg1 either. Close the WS for the same reason as (b).
  if (other?.awaitingFirstFrame || phoneOutboxLooksLikeFreshHandshake(other)) {
    drainOutboxToSocket(other, ws);
    return;
  }
  if (other?.socket && isOpen(other.socket)) {
    other.outbox = [];
    other.lastSent = 0;
    other.coldWake = true;
    other.awaitingFirstFrame = true;
    other.expectFreshHandshake = false;
    other.freshHandshakeBuffered = false;
    try {
      other.socket.close(CODE_HIBERNATED, "counterparty-reset");
    } catch {
      // Already closed — nothing to do.
    }
    other.socket = null;
  }
}

/**
 * Heuristic: does this peer's DO outbox look like the result of an
 * applyFreshHandshakeReset → push(msg1) sequence?
 *
 * applyFreshHandshakeReset truncates the outbox to [] and resets lastSent=0.
 * The triggering frame (a Noise IK msg1, 96-byte payload) is then pushed.
 * The frame may have seq>1 after RESUME_FAIL because clients keep envelope
 * sequencing monotonic across re-handshakes, so we track the fresh marker
 * explicitly instead of inferring it from seq.
 */
function phoneOutboxLooksLikeFreshHandshake(peer) {
  if (peer?.freshHandshakeBuffered !== true) return false;
  if (!peer?.outbox || peer.outbox.length !== 1) return false;
  try {
    const frame = decode(peer.outbox[0].wire);
    return frame.type === FRAME_DATA && frame.payload?.length === NOISE_IK_MSG1_BYTES;
  } catch {
    return false;
  }
}

function drainOutboxToSocket(peer, ws) {
  // Only rendezvous-drain for a peer that is still connected and waiting.
  // If that peer has already gone away, its buffered handshake frames are
  // stale and should not be replayed into a future fresh handshake.
  const allowAwaitingFreshHandshake = phoneOutboxLooksLikeFreshHandshake(peer);
  if (
    !peer?.socket ||
    !isOpen(peer.socket) ||
    (peer.awaitingFirstFrame && !allowAwaitingFreshHandshake) ||
    !peer.outbox?.length ||
    !ws ||
    !isOpen(ws)
  ) {
    return 0;
  }
  let sent = 0;
  let bytesSent = 0;
  for (const entry of peer.outbox) {
    const size = entry.wire?.length ?? 0;
    // Defense in depth: if the buffered frames exceed the per-drain cap,
    // stop replaying. The remaining frames stay in the outbox; if the
    // counterparty really needs them they'll come through RESUME_REQ on
    // the next reconnect (or age out via BUFFER_TTL_MS).
    if (bytesSent + size > MAX_DRAIN_BYTES) break;
    if (trySend(ws, entry.wire)) {
      sent += 1;
      bytesSent += size;
    }
  }
  return sent;
}

function trySend(ws, data) {
  try {
    ws.send(data);
    return true;
  } catch {
    // Socket closed under us; the close handler will clean up.
    return false;
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
  // Hard caps (defend against stuck peers / unsent backlog / huge frames).
  while (outbox.length > MAX_BUFFERED_FRAMES) {
    outbox.shift();
  }
  let totalBytes = 0;
  for (const entry of outbox) totalBytes += entry.wire?.length ?? 0;
  while (totalBytes > MAX_BUFFERED_BYTES && outbox.length > 0) {
    const dropped = outbox.shift();
    totalBytes -= dropped.wire?.length ?? 0;
  }
}

function emitRelayMetric(env, event) {
  try {
    if (!env?.RELAY_ANALYTICS) return;
    const stub = env.RELAY_ANALYTICS.get(env.RELAY_ANALYTICS.idFromName("global-v1"));
    const result = stub.fetch("https://relay-analytics.local/v1/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ atMs: Date.now(), ...event }),
    });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Metrics are intentionally best-effort.
  }
}
