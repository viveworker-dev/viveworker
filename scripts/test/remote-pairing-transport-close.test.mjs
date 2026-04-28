import test from "node:test";
import assert from "node:assert/strict";

import {
  RemotePairingTransport,
  STATE,
} from "../../web/remote-pairing/transport.js";
import { generateIdentityKeypair } from "../lib/remote-pairing/noise.mjs";
import { generateRelayToken } from "../lib/remote-pairing/pairings.mjs";

class FakeWebSocket {
  constructor() {
    this.readyState = 0;
  }
  addEventListener() {}
  close() {
    this.readyState = 3;
  }
}

function makeTransport() {
  const pairingId = `close-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const debug = [];
  return new RemotePairingTransport({
    relayUrl: "wss://example.test",
    pairingId,
    relayToken: generateRelayToken(pairingId),
    role: "phone",
    identityKeypair: generateIdentityKeypair(),
    remoteStatic: generateIdentityKeypair().pub,
    WebSocketImpl: FakeWebSocket,
    backoffMs: [60_000],
    logger: { debug: (line) => debug.push(line) },
  });
}

function fakeSession() {
  return {
    getChannelBinding() {
      return new Uint8Array(32);
    },
  };
}

test("relay close code 4004 drops stale Noise session before reconnect", () => {
  const transport = makeTransport();
  transport._session = fakeSession();
  transport._handshake = { stale: true };
  transport._setState(STATE.CONNECTED);
  transport._reconnectAttempt = 5;

  transport._handleClose({ code: 4004, reason: "expected-fresh-handshake" });

  try {
    assert.equal(transport._session, null);
    assert.equal(transport._handshake, null);
    assert.equal(transport.state, STATE.DISCONNECTED);
    assert.equal(transport._reconnectAttempt, 0);
    assert.equal(transport._reconnectTimer != null, true);
  } finally {
    transport.close();
  }
});

test("ordinary network close preserves Noise session for RESUME", () => {
  const transport = makeTransport();
  const session = fakeSession();
  transport._session = session;
  transport._setState(STATE.CONNECTED);
  transport._reconnectAttempt = 3;

  transport._handleClose({ code: 1006, reason: "" });

  try {
    assert.equal(transport._session, session);
    assert.equal(transport.state, STATE.DISCONNECTED);
    assert.equal(transport._reconnectAttempt, 4);
  } finally {
    transport.close();
  }
});

test("successful connection resets ordinary reconnect backoff", () => {
  const transport = makeTransport();
  transport._reconnectAttempt = 4;

  transport._setState(STATE.CONNECTED);

  try {
    assert.equal(transport._reconnectAttempt, 0);
  } finally {
    transport.close();
  }
});
