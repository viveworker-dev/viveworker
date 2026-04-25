/**
 * envelope.mjs — Wire envelope for the viveworker remote-pairing relay.
 *
 * Sits ABOVE the WSS framing and BELOW the Noise transport message.
 * The relay (CF Worker + Durable Object) reads the envelope to route
 * frames; it never decrypts the payload.
 *
 *   WSS frame body
 *   └── envelope (this module)              ← visible to relay
 *       ├── type          (1 byte)          ← routes / control
 *       ├── seq           (4 bytes BE u32)  ← per-direction monotonic counter
 *       ├── mid           (16 bytes UUID)   ← dedup key
 *       └── payload       (N bytes)         ← Noise transport message (opaque)
 *
 * Three classes of frame:
 *
 *   DATA frames carry application payload (Noise ciphertext) plus seq + mid.
 *   These are the frames that hit the replay buffer and earn ACKs.
 *
 *   CONTROL frames (PING, PONG, ACK, RESUME_*) are short fixed-format frames
 *   that the relay handles or echoes; they don't go in the replay buffer.
 *
 *   The handshake itself rides as plain DATA frames — the relay can't tell
 *   the difference between handshake and post-handshake transport, which is
 *   exactly what we want (no special-cased path for sensitive moments).
 *
 * Byte ordering: big-endian u32 (network order — matches WSS / IETF
 * convention; one less footgun for anyone reading hex dumps).
 */

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

export const FRAME_DATA = 0x01;
export const FRAME_ACK = 0x02;
export const FRAME_PING = 0x03;
export const FRAME_PONG = 0x04;
export const FRAME_RESUME_REQ = 0x05;
export const FRAME_RESUME_OK = 0x06;
export const FRAME_RESUME_FAIL = 0x07;

// Reasons for RESUME_FAIL — picked to surface the right user-facing message.
export const RESUME_FAIL_BUFFER_EXPIRED = 0x01; // requested seq is older than buffer's earliest
export const RESUME_FAIL_UNKNOWN_PAIRING = 0x02; // DO has no record of this pairing
export const RESUME_FAIL_HIBERNATED = 0x03;     // DO came back from cold; in-memory state lost

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

export const MID_BYTES = 16;
const HEADER_DATA = 1 + 4 + MID_BYTES; // type + seq + mid = 21
const HEADER_ACK = 1 + 4;
const HEADER_PING = 1;
const HEADER_PONG = 1;
const HEADER_RESUME_REQ = 1 + 4;
const HEADER_RESUME_OK = 1 + 4;
const HEADER_RESUME_FAIL = 1 + 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asU8(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError(`unsupported envelope input: ${typeof input}`);
}

function readU32BE(view, offset) {
  return view.getUint32(offset, false);
}

function writeU32BE(view, offset, value) {
  if (value < 0 || value > 0xffff_ffff) throw new RangeError(`u32 out of range: ${value}`);
  view.setUint32(offset, value >>> 0, false);
}

/**
 * Generate a 16-byte random message id. Uses crypto.getRandomValues which is
 * available in Node 19+, browsers, and Cloudflare Workers.
 */
export function generateMid() {
  const out = new Uint8Array(MID_BYTES);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(out);
  } else {
    // Last-resort fallback (shouldn't trigger on supported targets).
    for (let i = 0; i < MID_BYTES; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

export function midToHex(mid) {
  let out = "";
  for (let i = 0; i < mid.length; i++) out += mid[i].toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

export function encodeData({ seq, mid, payload }) {
  const pl = asU8(payload);
  if (mid.length !== MID_BYTES) throw new RangeError("mid must be 16 bytes");
  const out = new Uint8Array(HEADER_DATA + pl.length);
  const view = new DataView(out.buffer);
  out[0] = FRAME_DATA;
  writeU32BE(view, 1, seq);
  out.set(mid, 5);
  out.set(pl, HEADER_DATA);
  return out;
}

export function encodeAck(seq) {
  const out = new Uint8Array(HEADER_ACK);
  const view = new DataView(out.buffer);
  out[0] = FRAME_ACK;
  writeU32BE(view, 1, seq);
  return out;
}

export function encodePing() {
  return new Uint8Array([FRAME_PING]);
}

export function encodePong() {
  return new Uint8Array([FRAME_PONG]);
}

export function encodeResumeReq(lastSeenSeq) {
  const out = new Uint8Array(HEADER_RESUME_REQ);
  const view = new DataView(out.buffer);
  out[0] = FRAME_RESUME_REQ;
  writeU32BE(view, 1, lastSeenSeq);
  return out;
}

export function encodeResumeOk(currentSeq) {
  const out = new Uint8Array(HEADER_RESUME_OK);
  const view = new DataView(out.buffer);
  out[0] = FRAME_RESUME_OK;
  writeU32BE(view, 1, currentSeq);
  return out;
}

export function encodeResumeFail(reason) {
  return new Uint8Array([FRAME_RESUME_FAIL, reason & 0xff]);
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Decode an envelope frame. Returns one of:
 *   { type: FRAME_DATA, seq, mid, payload }
 *   { type: FRAME_ACK, seq }
 *   { type: FRAME_PING | FRAME_PONG }
 *   { type: FRAME_RESUME_REQ, lastSeenSeq }
 *   { type: FRAME_RESUME_OK, currentSeq }
 *   { type: FRAME_RESUME_FAIL, reason }
 *
 * Throws on malformed input. Callers should treat throws as protocol
 * violations — log + close the WS with code 4001.
 */
export function decode(bytes) {
  const u8 = asU8(bytes);
  if (u8.length < 1) throw new Error("envelope: empty frame");
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const type = u8[0];

  switch (type) {
    case FRAME_DATA: {
      if (u8.length < HEADER_DATA) throw new Error("envelope: DATA frame too short");
      const seq = readU32BE(view, 1);
      const mid = u8.slice(5, 5 + MID_BYTES);
      const payload = u8.slice(HEADER_DATA);
      return { type, seq, mid, payload };
    }
    case FRAME_ACK: {
      if (u8.length !== HEADER_ACK) throw new Error("envelope: ACK frame wrong length");
      return { type, seq: readU32BE(view, 1) };
    }
    case FRAME_PING:
      if (u8.length !== HEADER_PING) throw new Error("envelope: PING frame wrong length");
      return { type };
    case FRAME_PONG:
      if (u8.length !== HEADER_PONG) throw new Error("envelope: PONG frame wrong length");
      return { type };
    case FRAME_RESUME_REQ: {
      if (u8.length !== HEADER_RESUME_REQ) throw new Error("envelope: RESUME_REQ frame wrong length");
      return { type, lastSeenSeq: readU32BE(view, 1) };
    }
    case FRAME_RESUME_OK: {
      if (u8.length !== HEADER_RESUME_OK) throw new Error("envelope: RESUME_OK frame wrong length");
      return { type, currentSeq: readU32BE(view, 1) };
    }
    case FRAME_RESUME_FAIL: {
      if (u8.length !== HEADER_RESUME_FAIL) throw new Error("envelope: RESUME_FAIL frame wrong length");
      return { type, reason: u8[1] };
    }
    default:
      throw new Error(`envelope: unknown frame type 0x${type.toString(16)}`);
  }
}

/** Stringify a frame type for logs. */
export function frameTypeName(type) {
  switch (type) {
    case FRAME_DATA: return "DATA";
    case FRAME_ACK: return "ACK";
    case FRAME_PING: return "PING";
    case FRAME_PONG: return "PONG";
    case FRAME_RESUME_REQ: return "RESUME_REQ";
    case FRAME_RESUME_OK: return "RESUME_OK";
    case FRAME_RESUME_FAIL: return "RESUME_FAIL";
    default: return `UNKNOWN(0x${type.toString(16)})`;
  }
}
