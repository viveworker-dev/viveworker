/**
 * rpc.mjs — Application-level RPC framing carried inside the Noise channel.
 *
 * The transport (Noise + envelope) gives us an authenticated, encrypted,
 * ordered byte stream between phone and bridge. On top of it we need an
 * HTTP-shaped request/response abstraction so the bridge can keep using
 * its existing `(req, res)` handlers and the phone PWA can keep doing
 * `fetch()` whether it's on LAN or going through the relay.
 *
 * Wire format (UTF-8 JSON, one frame per Noise transport message):
 *
 *   // phone → bridge: HTTP-like request
 *   { "t":"req", "id":"r1", "method":"GET", "path":"/api/state",
 *     "headers":{"cookie":"viveworker_session=..."},
 *     "body":"" }
 *
 *   // bridge → phone: full response (single frame; chunked variant TBD)
 *   { "t":"res", "id":"r1", "status":200,
 *     "headers":{"content-type":"application/json"},
 *     "body":"{...}" }
 *
 *   // phone → bridge: cancel an in-flight request (e.g. user navigated
 *   // away during a long-poll). The bridge MAY abort and skip sending res.
 *   { "t":"cancel", "id":"r1" }
 *
 *   // bridge → phone: server-pushed event, no client request to correlate
 *   // against (e.g., "new approval item arrived; refresh inbox").
 *   { "t":"evt", "topic":"inbox-changed", "data":{...} }
 *
 * Why JSON (not CBOR / Protobuf):
 *   The Noise channel already gave us the cheap transport. Most viveworker
 *   API payloads are JSON to begin with, so the only thing we save by
 *   going binary is a few characters per request — not worth the parser
 *   surface or the loss of ad-hoc debuggability. Bodies are always
 *   strings; binary bodies (rare, e.g. /uploads) base64 themselves and
 *   set `bodyEncoding: "base64"`.
 *
 * Validation philosophy:
 *   We enforce types and a few bounds (max id length, max headers count,
 *   max body size) so a misbehaving peer can't DoS the dispatcher. Past
 *   those bounds we trust the peer because the Noise handshake already
 *   gave us mutual auth — there's no value in being defensive against a
 *   peer that's already inside the encrypted channel.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

// ---------------------------------------------------------------------------
// Limits — defensive caps. Generous enough to never bite real traffic but
// tight enough to protect the dispatcher from a runaway peer.
// ---------------------------------------------------------------------------

/** Max ID length (UUIDs are 36 chars; 64 leaves room for prefixes). */
export const MAX_RPC_ID_LEN = 64;

/** Max number of header entries we accept. */
export const MAX_HEADERS = 64;

/** Max length of any single header name OR value. */
export const MAX_HEADER_LEN = 8 * 1024;

/** Max method string length (`GET`, `OPTIONS`, etc. — 16 covers everything reasonable). */
export const MAX_METHOD_LEN = 16;

/** Max URL path length. */
export const MAX_PATH_LEN = 4 * 1024;

/** Max body size — 4 MiB. Fits long-poll JSONs, inbox dumps, x402 payloads. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Max topic name length (server-pushed events). */
export const MAX_TOPIC_LEN = 128;

/**
 * Frame type discriminators. Frozen so application code can compare with
 * `===` and not worry about typos surviving as silently-different strings.
 */
export const RPC = Object.freeze({
  REQUEST: "req",
  RESPONSE: "res",
  CANCEL: "cancel",
  EVENT: "evt",
});

const VALID_TYPES = new Set([RPC.REQUEST, RPC.RESPONSE, RPC.CANCEL, RPC.EVENT]);

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RpcRequest
 * @property {string} id            client-chosen correlation id
 * @property {string} method        "GET" | "POST" | …
 * @property {string} path          URL path including query, e.g. "/api/x?foo=1"
 * @property {Record<string,string>} [headers]
 * @property {string} [body]        UTF-8 string; binary callers must base64 + set bodyEncoding
 * @property {"utf8" | "base64"} [bodyEncoding]
 */

/**
 * @typedef {Object} RpcResponse
 * @property {string} id
 * @property {number} status        HTTP status code 100..599
 * @property {Record<string,string>} [headers]
 * @property {string} [body]
 * @property {"utf8" | "base64"} [bodyEncoding]
 */

/**
 * @typedef {Object} RpcCancel
 * @property {string} id
 */

/**
 * @typedef {Object} RpcEvent
 * @property {string} topic
 * @property {unknown} [data]
 */

/** @param {RpcRequest} req @returns {Uint8Array} */
export function encodeRequest(req) {
  if (typeof req?.id !== "string") throw new TypeError("request.id required (string)");
  if (typeof req.method !== "string") throw new TypeError("request.method required (string)");
  if (typeof req.path !== "string") throw new TypeError("request.path required (string)");
  assertIdLen(req.id);
  assertMethod(req.method);
  assertPath(req.path);
  const headers = normalizeHeaders(req.headers);
  const { body, bodyEncoding } = normalizeBody(req.body, req.bodyEncoding);

  const obj = { t: RPC.REQUEST, id: req.id, method: req.method, path: req.path };
  if (headers) obj.headers = headers;
  if (body !== undefined) {
    obj.body = body;
    if (bodyEncoding && bodyEncoding !== "utf8") obj.bodyEncoding = bodyEncoding;
  }
  return encodeJson(obj);
}

/** @param {RpcResponse} res @returns {Uint8Array} */
export function encodeResponse(res) {
  if (typeof res?.id !== "string") throw new TypeError("response.id required (string)");
  if (!Number.isInteger(res.status) || res.status < 100 || res.status > 599) {
    throw new RangeError("response.status must be an integer in [100, 599]");
  }
  assertIdLen(res.id);
  const headers = normalizeHeaders(res.headers);
  const { body, bodyEncoding } = normalizeBody(res.body, res.bodyEncoding);

  const obj = { t: RPC.RESPONSE, id: res.id, status: res.status };
  if (headers) obj.headers = headers;
  if (body !== undefined) {
    obj.body = body;
    if (bodyEncoding && bodyEncoding !== "utf8") obj.bodyEncoding = bodyEncoding;
  }
  return encodeJson(obj);
}

/** @param {string} id @returns {Uint8Array} */
export function encodeCancel(id) {
  if (typeof id !== "string") throw new TypeError("cancel.id required (string)");
  assertIdLen(id);
  return encodeJson({ t: RPC.CANCEL, id });
}

/** @param {RpcEvent} ev @returns {Uint8Array} */
export function encodeEvent(ev) {
  if (typeof ev?.topic !== "string") throw new TypeError("event.topic required (string)");
  if (ev.topic.length > MAX_TOPIC_LEN) {
    throw new RangeError(`event.topic exceeds ${MAX_TOPIC_LEN} chars`);
  }
  const obj = { t: RPC.EVENT, topic: ev.topic };
  if (ev.data !== undefined) obj.data = ev.data;
  return encodeJson(obj);
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Decode a Noise plaintext frame into a typed RPC object. Throws on
 * malformed JSON, missing required fields, or out-of-bounds values.
 *
 * @param {Uint8Array} bytes
 * @returns {{type: "req"} & RpcRequest
 *         | {type: "res"} & RpcResponse
 *         | {type: "cancel"} & RpcCancel
 *         | {type: "evt"} & RpcEvent}
 */
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("decode requires Uint8Array");
  }
  if (bytes.length > MAX_BODY_BYTES + 64 * 1024) {
    // 64 KiB headroom for envelope JSON beyond the body itself.
    throw new RangeError(`rpc frame too large: ${bytes.length} bytes`);
  }
  let str;
  try {
    str = TEXT_DECODER.decode(bytes);
  } catch (err) {
    throw new Error(`rpc frame: invalid UTF-8 (${err.message})`);
  }
  let obj;
  try {
    obj = JSON.parse(str);
  } catch (err) {
    throw new Error(`rpc frame: invalid JSON (${err.message})`);
  }
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("rpc frame: not a JSON object");
  }
  const type = obj.t;
  if (typeof type !== "string" || !VALID_TYPES.has(type)) {
    throw new Error(`rpc frame: unknown type ${JSON.stringify(type)}`);
  }

  switch (type) {
    case RPC.REQUEST: return decodeRequest(obj);
    case RPC.RESPONSE: return decodeResponse(obj);
    case RPC.CANCEL: return decodeCancel(obj);
    case RPC.EVENT: return decodeEvent(obj);
  }
  // Unreachable — switch above is exhaustive over VALID_TYPES.
  throw new Error("unreachable");
}

function decodeRequest(obj) {
  const id = requireStr(obj.id, "id");
  const method = requireStr(obj.method, "method");
  const path = requireStr(obj.path, "path");
  assertIdLen(id);
  assertMethod(method);
  assertPath(path);
  const headers = decodeHeaders(obj.headers);
  const { body, bodyEncoding } = decodeBody(obj);
  return { type: RPC.REQUEST, id, method, path, headers, body, bodyEncoding };
}

function decodeResponse(obj) {
  const id = requireStr(obj.id, "id");
  assertIdLen(id);
  const status = obj.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError("response.status must be an integer in [100, 599]");
  }
  const headers = decodeHeaders(obj.headers);
  const { body, bodyEncoding } = decodeBody(obj);
  return { type: RPC.RESPONSE, id, status, headers, body, bodyEncoding };
}

function decodeCancel(obj) {
  const id = requireStr(obj.id, "id");
  assertIdLen(id);
  return { type: RPC.CANCEL, id };
}

function decodeEvent(obj) {
  const topic = requireStr(obj.topic, "topic");
  if (topic.length > MAX_TOPIC_LEN) {
    throw new RangeError(`event.topic exceeds ${MAX_TOPIC_LEN} chars`);
  }
  return { type: RPC.EVENT, topic, data: obj.data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireStr(v, name) {
  if (typeof v !== "string") throw new TypeError(`${name} required (string)`);
  return v;
}

function assertIdLen(id) {
  if (id.length === 0) throw new RangeError("id must be non-empty");
  if (id.length > MAX_RPC_ID_LEN) throw new RangeError(`id exceeds ${MAX_RPC_ID_LEN} chars`);
}

function assertMethod(m) {
  if (m.length === 0) throw new RangeError("method must be non-empty");
  if (m.length > MAX_METHOD_LEN) throw new RangeError(`method exceeds ${MAX_METHOD_LEN} chars`);
}

function assertPath(p) {
  if (!p.startsWith("/")) throw new RangeError(`path must start with "/" (got ${JSON.stringify(p.slice(0, 32))})`);
  if (p.length > MAX_PATH_LEN) throw new RangeError(`path exceeds ${MAX_PATH_LEN} chars`);
}

/**
 * Normalize headers for encoding. Returns a plain object or undefined.
 * Lowercases keys (matches Node's IncomingMessage convention) and rejects
 * non-string values.
 */
function normalizeHeaders(headers) {
  if (headers == null) return undefined;
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("headers must be a plain object");
  }
  const entries = Object.entries(headers);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_HEADERS) {
    throw new RangeError(`headers exceeds ${MAX_HEADERS} entries`);
  }
  const out = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || typeof v !== "string") {
      throw new TypeError(`headers must be string→string (got ${k}=${typeof v})`);
    }
    if (k.length > MAX_HEADER_LEN || v.length > MAX_HEADER_LEN) {
      throw new RangeError(`header ${JSON.stringify(k)} exceeds ${MAX_HEADER_LEN} chars`);
    }
    out[k.toLowerCase()] = v;
  }
  return out;
}

function decodeHeaders(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("headers must be a JSON object");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADERS) {
    throw new RangeError(`headers exceeds ${MAX_HEADERS} entries`);
  }
  const out = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || typeof v !== "string") {
      throw new Error(`headers must be string→string (got ${k}=${typeof v})`);
    }
    if (k.length > MAX_HEADER_LEN || v.length > MAX_HEADER_LEN) {
      throw new RangeError(`header ${JSON.stringify(k)} exceeds ${MAX_HEADER_LEN} chars`);
    }
    out[k.toLowerCase()] = v;
  }
  return out;
}

function normalizeBody(body, bodyEncoding) {
  if (body === undefined || body === null || body === "") return { body: undefined };
  if (typeof body !== "string") {
    throw new TypeError("body must be a string (binary callers: base64-encode and set bodyEncoding=\"base64\")");
  }
  if (bodyEncoding != null && bodyEncoding !== "utf8" && bodyEncoding !== "base64") {
    throw new RangeError(`bodyEncoding must be "utf8" or "base64" (got ${JSON.stringify(bodyEncoding)})`);
  }
  // Approximate size check on the encoded JSON. We allow the body string
  // to be up to MAX_BODY_BYTES — JSON.stringify's escaping can add a few
  // bytes, but the outer bytes-length check in `decode` is the real cap.
  if (body.length > MAX_BODY_BYTES) {
    throw new RangeError(`body exceeds ${MAX_BODY_BYTES} chars`);
  }
  return { body, bodyEncoding: bodyEncoding ?? "utf8" };
}

function decodeBody(obj) {
  if (obj.body === undefined) return { body: undefined };
  if (typeof obj.body !== "string") throw new Error("body must be a string");
  if (obj.body.length > MAX_BODY_BYTES) {
    throw new RangeError(`body exceeds ${MAX_BODY_BYTES} chars`);
  }
  let bodyEncoding = "utf8";
  if (obj.bodyEncoding !== undefined) {
    if (obj.bodyEncoding !== "utf8" && obj.bodyEncoding !== "base64") {
      throw new Error(`bodyEncoding must be "utf8" or "base64"`);
    }
    bodyEncoding = obj.bodyEncoding;
  }
  return { body: obj.body, bodyEncoding };
}

function encodeJson(obj) {
  // JSON.stringify rejects undefined values automatically; we explicitly
  // omit them above. Use TextEncoder so the wire is canonical UTF-8 (no
  // BOM, no surprise locale handling).
  return TEXT_ENCODER.encode(JSON.stringify(obj));
}
