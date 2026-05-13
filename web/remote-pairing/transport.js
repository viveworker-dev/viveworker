/**
 * web/remote-pairing/transport.js — Browser WS client with reconnect + RESUME.
 *
 * Owns the lifecycle of one relay WebSocket: open → Noise IK handshake →
 * encrypted transport → graceful or surprise disconnect → reconnect (with
 * RESUME_REQ if we have a live noise session) → repeat. Application code
 * sees `connect()` / `send()` / `close()` and a stream of `onMessage` /
 * `onStateChange` / `onError` callbacks.
 *
 * State machine:
 *
 *      disconnected ──connect()──▶ opening
 *                                     │ ws onopen
 *                                     ▼
 *                       ┌─── have session ───▶ resuming
 *                       │                        │ RESUME_OK   ▶ connected
 *                       │                        │ RESUME_FAIL ▶ handshaking
 *                       └── no session ────▶ handshaking ─finish─▶ connected
 *
 *      {opening, handshaking, resuming, connected} ──ws onclose──▶ disconnected
 *                                                                  └─backoff─▶ opening
 *      {handshaking, resuming} ──crypto/decrypt failure──▶ failed (terminal)
 *      close() → disconnected (terminal until next connect()).
 *
 * Sequencing:
 *   `_outboundSeq` and `_lastSeenPeerSeq` are monotonic across the entire
 *   transport lifetime — including across re-handshakes triggered by
 *   RESUME_FAIL. The relay's per-peer outbox is append-only; restarting
 *   counters mid-transport would race with stale ACKs.
 *
 * Why ACK every inbound DATA:
 *   The relay doesn't know whether we've successfully consumed a frame
 *   (it can't peek inside the Noise envelope). Per-frame ACKs let the DO
 *   GC the peer's outbox tightly, which matters because the buffer ages
 *   out at 5 minutes — we want to keep it small for the times we DO need
 *   to replay (Web Push wake, cellular handoff, lid-close).
 *
 * Why no client-side outbox:
 *   The relay holds the replay buffer (see worker-pairing/pairing-do.js).
 *   On reconnect we send RESUME_REQ(lastSeenPeerSeq) and the relay replays
 *   anything we missed. Adding a second outbox on the client would just
 *   duplicate state and risk the two diverging.
 */

import {
  createInitiator,
  createResponder,
  decode,
  encodeData,
  encodeAck,
  encodePing,
  encodeResumeReq,
  generateMid,
  FRAME_DATA,
  FRAME_ACK,
  FRAME_PING,
  FRAME_PONG,
  FRAME_RESUME_OK,
  FRAME_RESUME_FAIL,
  RESUME_FAIL_BUFFER_EXPIRED,
  RESUME_FAIL_UNKNOWN_PAIRING,
  RESUME_FAIL_HIBERNATED,
} from "../remote-pairing.bundle.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Public state strings — surfaced to callers via `transport.state` and the
 * `onStateChange` callback. Frozen so consumers can compare with `===`.
 */
export const STATE = Object.freeze({
  DISCONNECTED: "disconnected",
  OPENING: "opening",
  HANDSHAKING: "handshaking",
  RESUMING: "resuming",
  CONNECTED: "connected",
  FAILED: "failed",
});

const DEFAULT_PING_INTERVAL_MS = 30_000;          // CF idle timeout is ~100s
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_PRE_CONNECT_BACKOFF_MS = 4_000;
const RELAY_RESET_RECONNECT_MS = 250;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_FAILURE_THRESHOLD = 4;
const DEFAULT_CIRCUIT_BREAKER_MS = 60_000;
const DEFAULT_MAX_CIRCUIT_BREAKER_MS = 10 * 60_000;
const DEFAULT_STABLE_CONNECTION_MS = 15_000;
const DEFAULT_PROLOGUE = new TextEncoder().encode("viveworker/remote-pairing/v1");

// CloseEvent codes we emit. 1000 is normal; 4xxx is application-defined.
const CLOSE_NORMAL = 1000;
const CLOSE_HANDSHAKE_TIMEOUT = 4001;
const CLOSE_FATAL = 4002;
const CLOSE_RELAY_RESET_SESSION = 4004;

// ---------------------------------------------------------------------------
// RemotePairingTransport
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TransportOptions
 * @property {string} relayUrl                      e.g. "wss://pairing.viveworker.com"
 * @property {string} pairingId                     pairing slot identifier
 * @property {string} relayToken                    relay capability token
 * @property {"phone" | "bridge"} role
 * @property {{priv: Uint8Array, pub: Uint8Array}} identityKeypair
 * @property {Uint8Array} [remoteStatic]            required for the initiator role
 * @property {boolean} [initiator]                  defaults true if role==="phone"
 * @property {Uint8Array} [prologue]                bound into the handshake transcript
 * @property {(plaintext: Uint8Array) => void} [onMessage]
 * @property {(state: string, prev: string, info?: object) => void} [onStateChange]
 * @property {(err: Error) => void} [onError]
 * @property {(info: { channelBinding: Uint8Array, remoteStatic: Uint8Array }) => void} [onHandshakeComplete]
 * @property {number} [pingIntervalMs]
 * @property {number[]} [backoffMs]
 * @property {number} [handshakeTimeoutMs]
 * @property {number} [failureWindowMs]
 * @property {number} [failureThreshold]
 * @property {number} [circuitBreakerMs]
 * @property {number} [maxCircuitBreakerMs]
 * @property {number} [stableConnectionMs]
 * @property {typeof WebSocket} [WebSocketImpl]     injectable for Node-side tests
 * @property {{debug?: Function, warn?: Function}} [logger]
 */

export class RemotePairingTransport {
  /** @param {TransportOptions} opts */
  constructor(opts) {
    if (!opts?.relayUrl) throw new TypeError("relayUrl required");
    if (!opts.pairingId) throw new TypeError("pairingId required");
    if (!opts.relayToken) throw new TypeError("relayToken required");
    if (opts.role !== "phone" && opts.role !== "bridge") {
      throw new TypeError(`role must be "phone" or "bridge", got ${JSON.stringify(opts.role)}`);
    }
    if (!opts.identityKeypair?.priv || !opts.identityKeypair?.pub) {
      throw new TypeError("identityKeypair { priv, pub } required");
    }

    // Normalize URL: strip trailing slash so we can `${relayUrl}/v1/...` cleanly.
    this._relayUrl = opts.relayUrl.replace(/\/+$/, "");
    this._pairingId = opts.pairingId;
    this._relayToken = opts.relayToken;
    this._role = opts.role;
    this._identityKeypair = opts.identityKeypair;
    // Default: phone is the initiator (knows bridge's static pubkey from LAN
    // pairing), bridge is the responder. Allow override for symmetry.
    this._initiator = opts.initiator ?? (opts.role === "phone");
    if (this._initiator && !opts.remoteStatic) {
      throw new TypeError("initiator requires remoteStatic");
    }
    this._remoteStatic = opts.remoteStatic ? new Uint8Array(opts.remoteStatic) : null;
    this._prologue = opts.prologue ?? DEFAULT_PROLOGUE;

    this._onMessage = opts.onMessage ?? noop;
    this._onStateChange = opts.onStateChange ?? noop;
    this._onError = opts.onError ?? noop;
    this._onHandshakeComplete = opts.onHandshakeComplete ?? noop;

    this._pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this._backoffMs = (opts.backoffMs ?? DEFAULT_BACKOFF_MS).slice();
    if (this._backoffMs.length === 0) this._backoffMs = [1_000];
    this._handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this._failureWindowMs = opts.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this._failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this._circuitBreakerMs = opts.circuitBreakerMs ?? DEFAULT_CIRCUIT_BREAKER_MS;
    this._maxCircuitBreakerMs = opts.maxCircuitBreakerMs ?? DEFAULT_MAX_CIRCUIT_BREAKER_MS;
    this._stableConnectionMs = opts.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;

    this._WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
    if (typeof this._WebSocketImpl !== "function") {
      throw new TypeError(
        "no WebSocket implementation available — pass `WebSocketImpl` for non-browser environments",
      );
    }

    this._log = normalizeLogger(opts.logger);

    // ---- mutable state ----
    /** @type {string} */
    this._state = STATE.DISCONNECTED;
    /** Set true once close() runs; blocks any further reconnect attempts. */
    this._closed = false;
    /**
     * True after the first connect() call, false after close(). Guards kick()
     * so wake events that fire before the application opted into the
     * transport (e.g., visibilitychange during initial page paint) can't
     * spontaneously open a WebSocket.
     */
    this._started = false;
    /** @type {{promise: Promise<void>, resolve: () => void, reject: (e: Error) => void} | null} */
    this._connectPromise = null;
    /** @type {WebSocket | null} */
    this._ws = null;
    /** Index into _backoffMs; reset on successful CONNECTED. */
    this._reconnectAttempt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._reconnectTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._pingTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._handshakeTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._stableConnectionTimer = null;
    /** @type {number[]} recent reconnect-triggering failures. */
    this._recentFailureAtMs = [];
    /** If > Date.now(), reconnect attempts are intentionally delayed. */
    this._circuitOpenUntilMs = 0;
    /** Consecutive circuit openings, used to lengthen persistent outages. */
    this._circuitOpenCount = 0;

    // ---- crypto state (persists across reconnects until RESUME_FAIL) ----
    /** @type {import("../remote-pairing.bundle.js").NoiseSession | null} */
    this._session = null;
    /** @type {import("../remote-pairing.bundle.js").HandshakeState | null} */
    this._handshake = null;

    // ---- sequencing (monotonic across the transport lifetime) ----
    this._outboundSeq = 0;
    this._lastSeenPeerSeq = 0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current state machine label (one of STATE.*). */
  get state() {
    return this._state;
  }

  /**
   * Snapshot of the channel binding (handshake hash). `null` until the first
   * handshake completes. Use to pin higher-level auth (e.g., Passkey challenges)
   * to this Noise session.
   */
  get channelBinding() {
    return this._session ? this._session.getChannelBinding() : null;
  }

  /** True iff the encrypted channel is up and `send()` will succeed. */
  get isConnected() {
    return this._state === STATE.CONNECTED && this._session != null;
  }

  /**
   * Open the WebSocket, run the Noise handshake, and resolve when the
   * encrypted channel is up.
   *
   * Subsequent reconnects happen automatically — the returned promise is
   * settled only by the FIRST successful connection (or by `close()` /
   * fatal failure).
   */
  connect() {
    if (this._state === STATE.FAILED) {
      return Promise.reject(new Error("transport in failed state — construct a new one"));
    }
    if (this._state === STATE.CONNECTED) {
      return Promise.resolve();
    }
    this._closed = false;
    this._started = true;
    if (!this._connectPromise) {
      this._connectPromise = deferred();
    }
    // Only kick off a fresh _open() if we're not already mid-attempt and no
    // reconnect timer is queued. Otherwise the in-flight cycle will
    // eventually transition to CONNECTED (or FAILED) and settle the promise.
    if (this._state === STATE.DISCONNECTED && this._reconnectTimer == null) {
      this._open();
    }
    return this._connectPromise.promise;
  }

  /**
   * Force an immediate reconnect attempt, bypassing any queued backoff.
   * Useful for visibilitychange / Web Push wake events where we want to
   * shortcut the exponential backoff window.
   *
   * Idempotent. No-ops if we're already opening/connected/closed/failed.
   */
  kick() {
    if (!this._started) return; // application never called connect() — nothing to kick
    if (this._closed || this._state === STATE.FAILED) return;
    if (this._state === STATE.CONNECTED) return;
    this._reconnectAttempt = 0;
    this._cancelReconnectTimer();
    if (this._state === STATE.DISCONNECTED) {
      this._open();
    }
    // If state is OPENING/HANDSHAKING/RESUMING we leave the in-flight
    // attempt alone — it'll either succeed soon or fall back to reconnect.
  }

  /**
   * Encrypt + frame `plaintext` and send. Optional `ad` (additional data)
   * is bound into the AEAD so a tampered envelope can't pair with valid
   * ciphertext.
   *
   * Throws synchronously if the transport isn't connected — application
   * code is responsible for awaiting `connect()` first (or queuing).
   *
   * @param {Uint8Array} plaintext
   * @param {Uint8Array} [ad]
   */
  send(plaintext, ad) {
    if (!this.isConnected) {
      throw new Error(`transport not connected (state=${this._state})`);
    }
    const ciphertext = this._session.send(plaintext, ad ?? new Uint8Array(0));
    this._sendData(ciphertext);
  }

  /**
   * Tear down the transport. Idempotent. After `close()`, no reconnects
   * will fire and the connect promise (if any) is rejected.
   */
  close() {
    this._closed = true;
    this._started = false;
    this._cancelReconnectTimer();
    this._cancelStableConnectionTimer();
    this._stopPing();
    this._stopHandshakeTimer();
    if (this._ws) {
      try { this._ws.close(CLOSE_NORMAL, "client closing"); } catch {}
      this._ws = null;
    }
    if (this._connectPromise) {
      this._connectPromise.reject(new Error("transport closed before first connect"));
      this._connectPromise = null;
    }
    if (this._state !== STATE.FAILED) {
      this._setState(STATE.DISCONNECTED, { reason: "closed" });
    }
  }

  // -------------------------------------------------------------------------
  // WS lifecycle
  // -------------------------------------------------------------------------

  _open() {
    this._cancelReconnectTimer();
    const circuitDelay = this._circuitDelayMs();
    if (circuitDelay > 0) {
      this._log.warn?.(`relay reconnect circuit open for ${circuitDelay}ms`);
      this._scheduleReconnect();
      return;
    }
    this._setState(STATE.OPENING);

    const url =
      `${this._relayUrl}/v1/pairing/${encodeURIComponent(this._pairingId)}` +
      `/ws?role=${encodeURIComponent(this._role)}` +
      `&token=${encodeURIComponent(this._relayToken)}`;

    let ws;
    try {
      ws = new this._WebSocketImpl(url);
    } catch (err) {
      this._onError(err);
      this._setState(STATE.DISCONNECTED, { reason: "open-threw", error: err });
      this._scheduleReconnect();
      return;
    }
    // Receive binary as ArrayBuffer (works for both browser WebSocket and the
    // Node `ws` package). Default for `ws` is Buffer; default for browsers
    // is Blob — neither is what `decode()` wants.
    try { ws.binaryType = "arraybuffer"; } catch {}

    this._ws = ws;
    ws.addEventListener("open", () => this._handleOpen());
    ws.addEventListener("message", (evt) => this._handleMessage(evt));
    ws.addEventListener("close", (evt) => this._handleClose(evt));
    ws.addEventListener("error", (evt) => this._handleError(evt));
  }

  _handleOpen() {
    if (this._closed) {
      try { this._ws?.close(CLOSE_NORMAL, "closed during open"); } catch {}
      return;
    }
    if (this._session) {
      // We have a live noise session from a previous connection — try to
      // resume rather than re-handshaking. `lastSeenPeerSeq` tells the relay
      // which peer-side frames we still need replayed.
      this._setState(STATE.RESUMING, { lastSeenPeerSeq: this._lastSeenPeerSeq });
      this._sendResumeReq(this._lastSeenPeerSeq);
      this._startHandshakeTimer(); // doubles as resume timeout
    } else {
      // No session — process restart, fresh PWA install, etc. We still
      // announce ourselves with RESUME_REQ(0) so the relay can detect the
      // state-loss case (peer.lastSent > 0 vs lastSeenSeq = 0) and force the
      // counterparty into a fresh handshake too. Without this, a peer that
      // still has a live session keeps sending transport DATA encrypted
      // with the old keys, and the responder side reads them as malformed
      // msg1 frames in a tight AEAD-failure loop.
      //
      // We don't enter RESUMING state for this case — there's no session to
      // feed replay frames into anyway. RESUME_OK / RESUME_FAIL responses
      // arrive while we're already in HANDSHAKING and get warn-logged-and-
      // ignored by the existing `state !== RESUMING` guards.
      this._sendResumeReq(0);
      this._beginHandshake();
    }
  }

  _handleMessage(evt) {
    let frame;
    try {
      frame = decode(asU8(evt.data));
    } catch (err) {
      this._onError(new Error(`envelope decode failed: ${err.message}`));
      return;
    }

    switch (frame.type) {
      case FRAME_DATA:
        this._handleDataFrame(frame);
        break;
      case FRAME_ACK:
        // The relay forwards peer ACKs only as outbox-GC signals on its end.
        // We don't run a client outbox, so nothing to do.
        break;
      case FRAME_PING:
        // The relay handles its own keepalive; we shouldn't see PINGs from
        // it. Defensive ignore.
        break;
      case FRAME_PONG:
        // Reply to our PING. We don't currently watchdog this — a dead
        // connection will surface via `close` shortly.
        break;
      case FRAME_RESUME_OK:
        this._handleResumeOk(frame);
        break;
      case FRAME_RESUME_FAIL:
        this._handleResumeFail(frame);
        break;
      default:
        this._onError(new Error(`unexpected frame type 0x${frame.type.toString(16)}`));
    }
  }

  _handleDataFrame(frame) {
    // Always ACK first so the relay can tighten its outbox even if our
    // crypto step throws.
    if (frame.seq > this._lastSeenPeerSeq) {
      this._lastSeenPeerSeq = frame.seq;
    }
    this._sendAck(frame.seq);

    try {
      this._dispatchData(frame);
    } catch (err) {
      // Crypto / state-machine errors during a handshake are fatal — re-
      // running the handshake won't help if the static keys are wrong.
      // During CONNECTED state we treat them the same to avoid silently
      // skipping bad frames; the user will need to re-pair.
      this._fail(err);
    }
  }

  _handleResumeOk(frame) {
    if (this._state !== STATE.RESUMING) {
      if (this._state === STATE.HANDSHAKING && !this._session) {
        this._log.debug?.(`ignoring RESUME_OK during fresh handshake currentSeq=${frame.currentSeq}`);
        return;
      }
      this._log.warn?.(`unexpected RESUME_OK in state=${this._state}`);
      return;
    }
    this._stopHandshakeTimer();
    this._setState(STATE.CONNECTED, { resumed: true, currentSeq: frame.currentSeq });
    this._startPing();
    this._resolveConnect();
    // Any DATA frames buffered on the relay arrive after this RESUME_OK and
    // are processed by the regular CONNECTED branch in _dispatchData.
  }

  _handleResumeFail(frame) {
    if (this._state !== STATE.RESUMING) {
      if (this._state === STATE.HANDSHAKING && !this._session) {
        this._log.debug?.(`ignoring RESUME_FAIL during fresh handshake reason=${describeResumeFail(frame.reason)}`);
        return;
      }
      this._log.warn?.(`unexpected RESUME_FAIL in state=${this._state}`);
      return;
    }
    this._stopHandshakeTimer();
    this._log.debug?.(`RESUME_FAIL reason=${describeResumeFail(frame.reason)} — re-handshaking`);
    // Drop the stale session. Counters stay monotonic so any leftover
    // entries in the relay's outbox naturally GC under the new session's
    // ACK flow (or simply age out at the 5-minute TTL).
    this._session = null;
    this._beginHandshake();
  }

  _handleClose(evt) {
    this._stopPing();
    this._stopHandshakeTimer();
    this._ws = null;

    if (this._closed) return;          // user-initiated; close() already settled
    if (this._state === STATE.FAILED) return; // already terminal

    const isRelayReset = Number(evt?.code) === CLOSE_RELAY_RESET_SESSION;
    if (isRelayReset) {
      this._log.debug?.(`relay requested fresh handshake reason=${evt?.reason || ""}`);
      this._dropNoiseState();
    }

    this._log.debug?.(`ws closed code=${evt?.code} reason=${evt?.reason}`);
    this._setState(STATE.DISCONNECTED, { code: evt?.code, reason: evt?.reason });
    if (Number(evt?.code) !== CLOSE_NORMAL) {
      this._recordReconnectFailure({
        code: Number(evt?.code) || 0,
        reason: String(evt?.reason || ""),
      });
    }
    if (isRelayReset) {
      this._scheduleRelayResetReconnect();
    } else {
      this._scheduleReconnect();
    }
  }

  _handleError(evt) {
    // Browsers don't surface details on the `error` event; bubble up a
    // generic notice and rely on the `close` event (which fires immediately
    // afterward) to drive recovery.
    const err = evt?.error ?? new Error("websocket error");
    this._onError(err);
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  _beginHandshake() {
    this._setState(STATE.HANDSHAKING);
    this._handshake = this._initiator
      ? createInitiator({
          staticKeypair: this._identityKeypair,
          remoteStatic: this._remoteStatic,
          prologue: this._prologue,
        })
      : createResponder({
          staticKeypair: this._identityKeypair,
          prologue: this._prologue,
        });

    if (this._initiator) {
      this._startHandshakeTimer();
      // Send msg1 immediately. We don't piggy-back application data on the
      // handshake transcript — the encrypted channel carries that after
      // CONNECTED. Empty payload keeps the wire shape predictable.
      let msg1;
      try {
        msg1 = this._handshake.writeMessage(new Uint8Array(0));
      } catch (err) {
        this._fail(err);
        return;
      }
      this._sendData(msg1);
    } else {
      // The bridge/responder can legitimately sit here waiting for a phone
      // to arrive through the relay. Do not start the handshake timeout until
      // msg1 is actually received; keep the relay socket alive instead.
      this._startPing();
    }
    // Responder waits passively — _dispatchData picks up msg1 when it arrives.
  }

  _dispatchData(frame) {
    if (this._state === STATE.CONNECTED) {
      const pt = this._session.recv(frame.payload);
      this._onMessage(pt);
      return;
    }

    if (this._state === STATE.HANDSHAKING && this._handshake) {
      if (this._initiator) {
        // Inbound msg2 from responder.
        this._handshake.readMessage(frame.payload);
      } else {
        // Inbound msg1 from initiator → reply with msg2.
        this._startHandshakeTimer();
        this._handshake.readMessage(frame.payload);
        const msg2 = this._handshake.writeMessage(new Uint8Array(0));
        this._sendData(msg2);
      }
      if (this._handshake.isHandshakeFinished()) {
        const session = this._handshake.intoSession();
        this._session = session;
        this._handshake = null;
        this._stopHandshakeTimer();
        this._setState(STATE.CONNECTED, { resumed: false });
        this._startPing();
        // Snapshot the binding + remote pub for the caller — both are
        // commonly used to bind higher-level auth (Passkey, etc.).
        const channelBinding = session.getChannelBinding();
        const remoteStatic = session.remoteStatic
          ? new Uint8Array(session.remoteStatic)
          : null;
        try {
          this._onHandshakeComplete({ channelBinding, remoteStatic });
        } catch (err) {
          this._log.warn?.(`onHandshakeComplete threw: ${err?.message}`);
        }
        this._resolveConnect();
      }
      return;
    }

    if (this._state === STATE.RESUMING && this._session) {
      // The relay sometimes sends replayed DATA frames before / interleaved
      // with the RESUME_OK control frame. We just decrypt + emit them on the
      // existing session; the resume flow completes when RESUME_OK arrives.
      const pt = this._session.recv(frame.payload);
      this._onMessage(pt);
      return;
    }

    throw new Error(`unexpected DATA frame in state=${this._state}`);
  }

  _startHandshakeTimer() {
    this._stopHandshakeTimer();
    this._handshakeTimer = setTimeout(() => {
      this._handshakeTimer = null;
      if (this._state === STATE.HANDSHAKING || this._state === STATE.RESUMING) {
        this._log.warn?.(`handshake/resume timed out (state=${this._state})`);
        // Closing the WS lets the regular onclose path schedule a retry.
        try { this._ws?.close(CLOSE_HANDSHAKE_TIMEOUT, "handshake-timeout"); } catch {}
      }
    }, this._handshakeTimeoutMs);
  }

  _stopHandshakeTimer() {
    if (this._handshakeTimer != null) {
      clearTimeout(this._handshakeTimer);
      this._handshakeTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reconnect / ping
  // -------------------------------------------------------------------------

  _scheduleReconnect() {
    if (this._closed) return;
    const idx = Math.min(this._reconnectAttempt, this._backoffMs.length - 1);
    const waitingForFirstConnect = this._connectPromise != null && this._session == null;
    const rawDelay = this._backoffMs[idx];
    const backoffDelay = waitingForFirstConnect
      ? Math.min(rawDelay, MAX_PRE_CONNECT_BACKOFF_MS)
      : rawDelay;
    const delay = Math.max(backoffDelay, this._circuitDelayMs());
    this._reconnectAttempt += 1;
    this._log.debug?.(`reconnect in ${delay}ms (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this._open();
    }, delay);
  }

  _scheduleRelayResetReconnect() {
    if (this._closed) return;
    // 4004 means the relay wants both peers to discard stale Noise state and
    // rendezvous again. Treat it as a protocol reset, not a network failure,
    // so app boot does not sit behind the exponential backoff ladder.
    this._reconnectAttempt = 0;
    const delay = Math.max(RELAY_RESET_RECONNECT_MS, this._circuitDelayMs());
    this._log.debug?.(`reconnect in ${delay}ms (relay reset)`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this._open();
    }, delay);
  }

  _cancelReconnectTimer() {
    if (this._reconnectTimer != null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _scheduleStableConnectionReset() {
    const delay = Math.max(0, Number(this._stableConnectionMs) || 0);
    this._stableConnectionTimer = setTimeout(() => {
      this._stableConnectionTimer = null;
      if (this._closed || this._state !== STATE.CONNECTED) return;
      this._recentFailureAtMs = [];
      this._circuitOpenUntilMs = 0;
      this._circuitOpenCount = 0;
    }, delay);
  }

  _cancelStableConnectionTimer() {
    if (this._stableConnectionTimer != null) {
      clearTimeout(this._stableConnectionTimer);
      this._stableConnectionTimer = null;
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._sendPing();
    }, this._pingIntervalMs);
  }

  _stopPing() {
    if (this._pingTimer != null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Frame sends
  // -------------------------------------------------------------------------

  _sendData(payload) {
    this._outboundSeq += 1;
    const wire = encodeData({
      seq: this._outboundSeq,
      mid: generateMid(),
      payload,
    });
    this._wireSend(wire);
  }

  _sendAck(seq) {
    this._wireSend(encodeAck(seq));
  }

  _sendPing() {
    this._wireSend(encodePing());
  }

  _sendResumeReq(lastSeenSeq) {
    this._wireSend(encodeResumeReq(lastSeenSeq));
  }

  _wireSend(bytes) {
    if (!this._ws || this._ws.readyState !== 1 /* OPEN */) {
      this._log.warn?.("send while WS not open — dropping");
      return;
    }
    try {
      this._ws.send(bytes);
    } catch (err) {
      this._onError(err);
    }
  }

  // -------------------------------------------------------------------------
  // State / errors
  // -------------------------------------------------------------------------

  _setState(newState, info) {
    if (this._state === newState) return;
    const prev = this._state;
    this._state = newState;
    this._cancelStableConnectionTimer();
    if (newState === STATE.CONNECTED) {
      this._reconnectAttempt = 0;
      this._scheduleStableConnectionReset();
    }
    try {
      this._onStateChange(newState, prev, info);
    } catch (err) {
      this._log.warn?.(`onStateChange threw: ${err?.message}`);
    }
  }

  _resolveConnect() {
    if (this._connectPromise) {
      this._connectPromise.resolve();
      this._connectPromise = null;
    }
  }

  _fail(err) {
    this._recordReconnectFailure({
      code: CLOSE_FATAL,
      reason: err?.message || "fatal-error",
    });
    this._setState(STATE.FAILED, { error: err });
    this._stopPing();
    this._stopHandshakeTimer();
    this._cancelReconnectTimer();
    this._cancelStableConnectionTimer();
    if (this._ws) {
      try { this._ws.close(CLOSE_FATAL, "fatal-error"); } catch {}
      this._ws = null;
    }
    try { this._onError(err); } catch {}
    if (this._connectPromise) {
      this._connectPromise.reject(err);
      this._connectPromise = null;
    }
  }

  _dropNoiseState() {
    this._session = null;
    this._handshake = null;
  }

  _recordReconnectFailure(info = {}) {
    const now = Date.now();
    const windowMs = Math.max(1_000, Number(this._failureWindowMs) || DEFAULT_FAILURE_WINDOW_MS);
    this._recentFailureAtMs = this._recentFailureAtMs.filter((at) => now - at <= windowMs);
    this._recentFailureAtMs.push(now);
    const threshold = Math.max(2, Math.floor(Number(this._failureThreshold) || DEFAULT_FAILURE_THRESHOLD));
    if (this._recentFailureAtMs.length < threshold) return;

    const baseCooldownMs = Math.max(1_000, Number(this._circuitBreakerMs) || DEFAULT_CIRCUIT_BREAKER_MS);
    const maxCooldownMs = Math.max(baseCooldownMs, Number(this._maxCircuitBreakerMs) || DEFAULT_MAX_CIRCUIT_BREAKER_MS);
    const multiplier = Math.min(16, 2 ** this._circuitOpenCount);
    const cooldownMs = Math.min(maxCooldownMs, baseCooldownMs * multiplier);
    this._circuitOpenCount += 1;
    this._circuitOpenUntilMs = Math.max(this._circuitOpenUntilMs, now + cooldownMs);
    this._recentFailureAtMs = [];
    this._dropNoiseState();
    this._log.warn?.(
      `relay reconnect circuit opened for ${cooldownMs}ms` +
      `${info?.code ? ` after close=${info.code}` : ""}` +
      `${info?.reason ? ` (${String(info.reason).slice(0, 64)})` : ""}`,
    );
  }

  _circuitDelayMs() {
    return Math.max(0, this._circuitOpenUntilMs - Date.now());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop() {}

function normalizeLogger(logger) {
  // Silent default — opting into prefixed console output is the caller's
  // call. Only pull `debug` / `warn` so we don't accidentally invoke
  // arbitrary methods.
  if (!logger) return {};
  return {
    debug: typeof logger.debug === "function" ? logger.debug.bind(logger) : undefined,
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : undefined,
  };
}

function asU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    throw new Error("Blob frames not supported; ensure ws.binaryType is 'arraybuffer'");
  }
  if (typeof data === "string") {
    // Shouldn't happen on a binary protocol, but encode to UTF-8 so the
    // decoder fails with a "wrong frame" error instead of a type confusion.
    return new TextEncoder().encode(data);
  }
  throw new TypeError(`unsupported WS message data type: ${typeof data}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function describeResumeFail(reason) {
  switch (reason) {
    case RESUME_FAIL_BUFFER_EXPIRED: return "BUFFER_EXPIRED";
    case RESUME_FAIL_UNKNOWN_PAIRING: return "UNKNOWN_PAIRING";
    case RESUME_FAIL_HIBERNATED: return "HIBERNATED";
    default: return `0x${(reason ?? 0).toString(16)}`;
  }
}
