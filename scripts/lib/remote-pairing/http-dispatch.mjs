/**
 * http-dispatch.mjs — Adapt RPC requests to a Node `(req, res) => void`
 * request listener.
 *
 * Why this exists:
 *   The bridge already has one big request handler that knows how to serve
 *   every PWA endpoint (auth, approvals, threads, share, …). Re-implementing
 *   that handler for relay-tunneled traffic would duplicate ~20k lines and
 *   guarantee drift. Instead, we synthesize Node IncomingMessage /
 *   ServerResponse objects from an RPC request, run the existing handler
 *   against them, and capture whatever the handler writes as the RPC
 *   response. The handler can't tell the difference between a relay-tunneled
 *   call and a LAN-HTTPS one — same headers, same cookies, same body.
 *
 * What the bridge handler actually touches (audited via grep):
 *   req.method, req.url, req.headers, req.on('data'|'end'),
 *   req.socket?.remoteAddress, req.destroy()
 *   res.statusCode, res.setHeader(), res.end()
 *
 * That's the surface this adapter implements. If the bridge starts using
 * other Node http APIs (writeHead, write streaming, getHeader, etc.) we'll
 * extend the synthetic objects rather than fall back to a real TCP loop —
 * the loopback-fetch alternative would force this module to know the
 * bridge's listening port + cert + auth scheme, all of which couples too
 * tightly.
 *
 * Body handling:
 *   RPC bodies arrive as a single string (utf8 or base64). We feed the
 *   bytes synchronously via one `data` event followed by `end`, which is
 *   what `parseFormBody` and similar helpers expect. The body is fully
 *   buffered before dispatch — chunked streaming is out of scope until
 *   the relay supports it (PWA payloads are JSON / form-encoded, all small).
 */

import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => (void | Promise<void>)} RequestListener
 */

/**
 * @typedef {Object} HttpDispatchOptions
 * @property {RequestListener} requestListener   bridge's HTTP handler
 * @property {string} [remoteAddressPrefix]      prepended to the synthetic
 *           remoteAddress (e.g. "remote-pair:") so log lines / rate
 *           limiters can distinguish relay traffic from LAN traffic.
 * @property {number} [responseTimeoutMs]        if > 0, return 504 if the
 *           listener doesn't call res.end() within this many ms. Default 0
 *           (wait forever; rely on the phone-side AbortSignal).
 * @property {{warn?: Function, error?: Function}} [logger]
 */

// ---------------------------------------------------------------------------
// Path gate — defense in depth
// ---------------------------------------------------------------------------
//
// Noise IK + the phonePub allowlist already authenticate the peer, so in
// principle the bridge can trust anything that arrives with `fromRelay:
// true`. We still gate the path here as a belt-and-braces measure: if a
// phone identity key ever leaks (extractable IndexedDB record on a stolen
// device, supply-chain XSS in the PWA host, etc.), the blast radius is the
// reachable HTTP surface, and there's no reason that surface should
// include LAN-bootstrap or pairing-management endpoints that only make
// sense over a local-only origin.
//
// The rules are intentionally minimal:
//   1. Only `/api/...` paths can ride the relay. The bridge serves the PWA
//      shell, the SW, static assets, and a few diagnostic pages on other
//      paths — none of those need to be reachable through the relay (the
//      PWA is hosted by the phone OS, not by the bridge over the relay).
//   2. A short deny list inside `/api/` blocks endpoints whose threat
//      model only makes sense over LAN: pairing enrollment / revoke /
//      LAN session bootstrap. These would already 403 in practice (no
//      session cookie, etc.), but locking them out at the dispatch layer
//      keeps a future relaxation of cookie auth from accidentally opening
//      them.
//
// Both checks return a synthetic 403 RPC response — they never invoke the
// bridge's request listener.

const RELAY_DENIED_PATHS = new Set([
  "/api/remote-pairing/lan-enroll",
  "/api/remote-pairing/revoke",
  "/api/session/pair",
]);

const RELAY_DENIED_PREFIXES = [
  "/admin/",
  "/internal/",
  "/__",
  "/api/internal/",
  "/api/admin/",
];

/**
 * @param {string} rawPath
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function classifyRelayPath(rawPath) {
  const path = String(rawPath || "");
  let pathname;
  try {
    pathname = new URL(path, "http://relay.local/").pathname;
  } catch {
    return { allowed: false, reason: "invalid-path" };
  }
  if (!pathname.startsWith("/api/")) {
    return { allowed: false, reason: "non-api-path" };
  }
  for (const prefix of RELAY_DENIED_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return { allowed: false, reason: "denied-prefix" };
    }
  }
  if (RELAY_DENIED_PATHS.has(pathname)) {
    return { allowed: false, reason: "denied-path" };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `dispatch` function suitable for `BridgeRelayClient`. The returned
 * function takes the unwrapped RPC request fields (method, path, headers,
 * body, signal, pairing) and returns `{ status, headers, body, bodyEncoding }`.
 *
 * @param {HttpDispatchOptions} opts
 */
export function createHttpDispatch(opts) {
  if (typeof opts?.requestListener !== "function") {
    throw new TypeError("createHttpDispatch: requestListener function required");
  }
  const listener = opts.requestListener;
  const addrPrefix = opts.remoteAddressPrefix ?? "remote-pair:";
  const responseTimeoutMs = Math.max(0, Number(opts.responseTimeoutMs ?? 0) || 0);
  const log = opts.logger ?? {};

  /**
   * @param {{
   *   method: string,
   *   path: string,
   *   headers: Record<string,string>,
   *   body?: string,
   *   bodyEncoding?: "utf8" | "base64",
   *   signal: AbortSignal,
   *   pairing: import("./pairings.mjs").Pairing,
   *   channelBinding: Uint8Array,
   * }} rpcReq
   */
  return async function httpDispatch(rpcReq) {
    // Defense-in-depth path gate — see RELAY_DENIED_* above.
    const gate = classifyRelayPath(rpcReq.path);
    if (!gate.allowed) {
      log.warn?.(
        `[http-dispatch] denied relay request ` +
        `(${gate.reason}) ${String(rpcReq.method || "").toUpperCase()} ${redactPathForLog(rpcReq.path)}`,
      );
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "path-not-allowed-via-relay" }),
      };
    }

    const bodyBuf = decodeBody(rpcReq.body, rpcReq.bodyEncoding);
    const remoteAddress = `${addrPrefix}${rpcReq.pairing.phoneFingerprint}`;

    const req = buildSyntheticRequest({
      method: rpcReq.method,
      url: rpcReq.path,
      headers: rpcReq.headers ?? {},
      body: bodyBuf,
      remoteAddress,
    });

    // Attach relay context so the bridge's auth gates can recognize this
    // as a trusted off-LAN call. The Noise channel binding + pairing
    // identity is the auth here:
    //   - HttpOnly session cookies don't ride the relay (the PWA's JS
    //     can't read them, the RPC layer doesn't carry them), so cookie
    //     auth alone would 401 every relay request.
    //   - There's no browser-side CSRF surface — an attacker can't
    //     establish a Noise channel without the pairing's static key,
    //     so Origin / Referer checks have nothing to add.
    // Bridge code reads `req.viveworker.fromRelay` to take the relay
    // path through readSession() / requireTrustedMutationOrigin().
    req.viveworker = {
      fromRelay: true,
      pairing: rpcReq.pairing,
      channelBinding: rpcReq.channelBinding,
    };

    const res = new SyntheticResponse(req);

    // If the caller cancels, surface it to the handler as a destroyed
    // request — most Node-style handlers stop processing on `req.destroy()`.
    const onAbort = () => {
      // Pass no error to destroy() — listeners that care can check
      // req.destroyed; we don't want a stray "error" event for what's
      // really a cooperative cancel.
      try { req.destroy(); } catch {}
      try { res._abort(); } catch {}
    };
    if (rpcReq.signal?.aborted) onAbort();
    else rpcReq.signal?.addEventListener("abort", onAbort, { once: true });

    // Invoke the listener. Let it throw — the BridgeRelayClient's catch
    // block already converts dispatcher errors into 500s. We do NOT swallow
    // the rejection here.
    let listenerResult;
    try {
      listenerResult = listener(req, res);
    } catch (err) {
      // Synchronous throw before the listener could write anything.
      throw err;
    }

    // Wait for the listener's response. Two completion paths:
    //   - res.end() runs (normal case) → donePromise resolves
    //   - listener's own promise rejects → propagate the rejection
    // A listener that returns synchronously hasn't necessarily called
    // res.end() yet (the body may arrive via async req.on('data') events),
    // so we MUST wait on donePromise rather than the listener's return.
    //
    // To detect a misbehaving listener that returns without ever calling
    // res.end(), the caller can pass `responseTimeoutMs`. Without it, we
    // wait indefinitely; the phone-side AbortSignal is the real backstop.
    const listenerPromise = Promise.resolve(listenerResult).catch((err) => {
      // Capture and rethrow once we know the response state. We can't
      // throw from here because that would race with the await below.
      res._listenerError = err;
    });

    try {
      const racers = [res.donePromise, listenerPromise.then(() => {
        // After the listener settles, give it one microtask to flush any
        // synchronous res.end() inside callbacks, then yield. If donePromise
        // wins by then, great. If not, we fall through to the next check.
      })];
      if (responseTimeoutMs > 0) {
        racers.push(new Promise((resolve) => setTimeout(resolve, responseTimeoutMs)).then(() => {
          res._timedOut = true;
        }));
      }
      // First settle.
      await Promise.race(racers);

      // If the listener errored and nothing was written, propagate.
      if (res._listenerError && !res._ended) {
        throw res._listenerError;
      }

      // If the listener returned a value (sync or async) and we didn't
      // get a res.end yet, wait for donePromise — the listener may still
      // be running async work.
      if (!res._ended && !res._timedOut) {
        await res.donePromise;
      }

      if (!res._ended && res._timedOut) {
        log.warn?.(`[http-dispatch] listener did not respond within ${responseTimeoutMs}ms (path=${rpcReq.path})`);
        return {
          status: 504,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "bridge-listener-timeout" }),
        };
      }

      // If the listener errored AFTER writing a partial response, prefer
      // the response (the listener wrote something deliberately); if the
      // error happened before any write, propagate.
      if (res._listenerError && !res._headersSent && !res._chunks.length && !res._ended) {
        throw res._listenerError;
      }
    } finally {
      rpcReq.signal?.removeEventListener?.("abort", onAbort);
    }

    return res._toRpcResponse();
  };
}

function redactPathForLog(rawPath) {
  const value = String(rawPath || "");
  try {
    const parsed = new URL(value, "http://relay.local/");
    const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 3);
    return `/${segments.join("/")}`;
  } catch {
    return value.split("?")[0].slice(0, 64);
  }
}

// ---------------------------------------------------------------------------
// Internals — synthetic IncomingMessage / ServerResponse
// ---------------------------------------------------------------------------

/**
 * Build a Readable that quacks like http.IncomingMessage. We use Readable
 * directly (instead of subclassing IncomingMessage) because IncomingMessage
 * insists on a real Socket. The handler only reads:
 *   .method .url .headers .socket?.remoteAddress
 *   .on('data', ...), .on('end', ...), .on('error', ...)
 *   .destroy()
 * which are all available on a Readable + a few attached properties.
 */
function buildSyntheticRequest({ method, url, headers, body, remoteAddress }) {
  // One-shot Readable that yields the buffered body then ends.
  const stream = Readable.from(body.length > 0 ? [body] : [], { objectMode: false });
  stream.method = method;
  stream.url = url;
  // Lowercase by convention — matches what real http.IncomingMessage does.
  // Our RPC encoder already lowercases, but we don't want to depend on that
  // from inside the dispatch path.
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  stream.headers = lower;
  // rawHeaders pairs [k1, v1, k2, v2, …] — some libraries inspect it. We
  // produce it from the lowercased map for consistency.
  const rawHeaders = [];
  for (const [k, v] of Object.entries(lower)) rawHeaders.push(k, v);
  stream.rawHeaders = rawHeaders;
  stream.httpVersion = "1.1";
  stream.httpVersionMajor = 1;
  stream.httpVersionMinor = 1;
  stream.complete = false;
  stream.socket = {
    remoteAddress,
    remoteFamily: "IPv4",
    remotePort: 0,
    localAddress: "127.0.0.1",
    localPort: 0,
    encrypted: true, // Noise channel is encrypted; some auth code checks this
    destroy: () => {},
  };
  // Some handlers use this for keep-alive heuristics; null is harmless.
  stream.connection = stream.socket;

  // When the stream ends naturally, mark complete so any code that polls
  // for it sees the right state.
  stream.once("end", () => { stream.complete = true; });

  // Default no-op `error` handler. Real http.IncomingMessage is paired with
  // an HTTP server that catches its errors; ours stands alone, and a
  // listener-less stream that destroy(err)'s would surface as an uncaught
  // exception. We don't want abort-on-cancel to crash the process.
  stream.on("error", () => {});

  return stream;
}

/**
 * Synthetic ServerResponse. Captures statusCode + headers + body, exposes
 * a `donePromise` that resolves when the listener calls `res.end()`.
 */
class SyntheticResponse {
  constructor(req) {
    this._req = req;
    this.statusCode = 200;
    this.statusMessage = "";
    /** @type {Record<string,string>} */
    this._headers = {};
    /** @type {Buffer[]} */
    this._chunks = [];
    this._ended = false;
    this._aborted = false;
    this._headersSent = false;

    this.donePromise = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
  }

  // ----- Header API -----

  setHeader(name, value) {
    if (this._ended) return;
    if (Array.isArray(value)) value = value.join(", ");
    this._headers[String(name).toLowerCase()] = String(value);
  }

  getHeader(name) {
    return this._headers[String(name).toLowerCase()];
  }

  hasHeader(name) {
    return Object.prototype.hasOwnProperty.call(this._headers, String(name).toLowerCase());
  }

  removeHeader(name) {
    delete this._headers[String(name).toLowerCase()];
  }

  getHeaders() {
    return { ...this._headers };
  }

  writeHead(statusCode, statusMessageOrHeaders, headersMaybe) {
    if (this._ended) return this;
    this.statusCode = statusCode;
    let headers = null;
    if (typeof statusMessageOrHeaders === "string") {
      this.statusMessage = statusMessageOrHeaders;
      headers = headersMaybe ?? null;
    } else {
      headers = statusMessageOrHeaders ?? null;
    }
    if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    }
    this._headersSent = true;
    return this;
  }

  flushHeaders() {
    this._headersSent = true;
  }

  // ----- Body API -----

  write(chunk, encoding) {
    if (this._ended) return false;
    this._chunks.push(toBuffer(chunk, encoding));
    return true;
  }

  end(chunk, encoding) {
    if (this._ended) return this;
    if (chunk != null) this._chunks.push(toBuffer(chunk, encoding));
    this._ended = true;
    this._headersSent = true;
    this._resolveDone();
    return this;
  }

  // ----- Adapter glue -----

  _abort() {
    // The peer cancelled before the listener wrote res.end(). Mark ended so
    // the wrapper stops waiting; the BridgeRelayClient won't send a
    // response anyway because the AbortSignal already fired.
    if (this._ended) return;
    this._aborted = true;
    this._ended = true;
    this._resolveDone();
  }

  _toRpcResponse() {
    const buf = Buffer.concat(this._chunks);
    const status = this.statusCode;
    // We always lowercase header keys (matches RPC convention; the
    // RemotePairingTransport doesn't care, the phone-side adapter prefers
    // it).
    const headers = { ...this._headers };

    // Pick body encoding: utf8 if the bytes are valid UTF-8 AND the
    // content-type isn't obviously binary; otherwise base64. This keeps
    // the wire compact for JSON/HTML responses and round-trips binaries
    // (PDFs, images) safely.
    if (buf.length === 0) {
      return { status, headers };
    }
    const ct = (headers["content-type"] ?? "").toLowerCase();
    const isBinary = isBinaryContentType(ct) || !isValidUtf8(buf);
    if (isBinary) {
      return {
        status,
        headers,
        body: buf.toString("base64"),
        bodyEncoding: "base64",
      };
    }
    return { status, headers, body: buf.toString("utf8"), bodyEncoding: "utf8" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBody(body, encoding) {
  if (body == null || body === "") return Buffer.alloc(0);
  if (typeof body !== "string") {
    throw new TypeError("rpc body must be a string");
  }
  if (encoding === "base64") return Buffer.from(body, "base64");
  // Default utf8 — the RPC layer already validates this.
  return Buffer.from(body, "utf8");
}

function toBuffer(chunk, encoding) {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  throw new TypeError(`unsupported response chunk type: ${typeof chunk}`);
}

function isBinaryContentType(ct) {
  if (!ct) return false;
  // Anything explicitly text/* or json or xml is text. application/octet-stream,
  // image/*, application/pdf, etc. are binary.
  if (ct.startsWith("text/")) return false;
  if (ct.includes("json") || ct.includes("xml") || ct.includes("javascript") ||
      ct.includes("urlencoded") || ct.includes("html")) {
    return false;
  }
  return true;
}

/**
 * Lightweight UTF-8 validation. Buffer doesn't expose a "did this round-trip"
 * helper, so we use TextDecoder in fatal mode and catch the error.
 */
function isValidUtf8(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}
