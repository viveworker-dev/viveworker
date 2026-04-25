/**
 * _browser-bundle-entry.mjs — Aggregator for the browser bundle.
 *
 * The PWA can't pull npm packages directly (no build step on the
 * served-files side). This module is the input to esbuild — it pulls in
 * noise.mjs + envelope.mjs + keys-core.mjs and their @noble/* dependencies
 * so the bundler can produce a single self-contained ESM file
 * (`web/remote-pairing.bundle.js`).
 *
 * To regenerate the bundle:
 *
 *   node scripts/build-remote-pairing-bundle.mjs
 *
 * Anything Node-specific (load/save/ensure helpers from keys.mjs, the
 * stdio demo, the wrangler-driven smoke test) must NOT be re-exported
 * here — those would either fail to bundle or pull node_modules into
 * the browser payload.
 */

// Crypto / handshake / session
export {
  PROTOCOL_NAME,
  HASHLEN,
  KEYLEN,
  DHLEN,
  TAGLEN,
  HandshakeState,
  NoiseSession,
  createInitiator,
  createResponder,
} from "./noise.mjs";

// Wire envelope (frame types, encoders, decoder, helpers)
export {
  FRAME_DATA,
  FRAME_ACK,
  FRAME_PING,
  FRAME_PONG,
  FRAME_RESUME_REQ,
  FRAME_RESUME_OK,
  FRAME_RESUME_FAIL,
  RESUME_FAIL_BUFFER_EXPIRED,
  RESUME_FAIL_UNKNOWN_PAIRING,
  RESUME_FAIL_HIBERNATED,
  MID_BYTES,
  encodeData,
  encodeAck,
  encodePing,
  encodePong,
  encodeResumeReq,
  encodeResumeOk,
  encodeResumeFail,
  decode,
  generateMid,
  midToHex,
  frameTypeName,
} from "./envelope.mjs";

// Pure key helpers (encoding, derivation, fingerprint). The browser side
// layers IndexedDB-backed persistence over these in web/remote-pairing/keys.js.
export {
  IDENTITY_KEY_BYTES,
  bytesToHex,
  hexToBytes,
  generateIdentityKeypair,
  publicFromPrivate,
  fingerprintIdentity,
} from "./keys-core.mjs";

// Application-level RPC framing carried inside the Noise channel. Phone-side
// rpc-client.js imports these to encode requests / decode responses + events.
export {
  RPC,
  MAX_RPC_ID_LEN,
  MAX_HEADERS,
  MAX_HEADER_LEN,
  MAX_METHOD_LEN,
  MAX_PATH_LEN,
  MAX_BODY_BYTES,
  MAX_TOPIC_LEN,
  encodeRequest,
  encodeResponse,
  encodeCancel,
  encodeEvent,
  decode as decodeRpc,
} from "./rpc.mjs";
