import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  RemotePairingTransport,
  STATE,
  TEXT_KEEPALIVE_PING,
} from "../../web/remote-pairing/transport.js";
import { generateIdentityKeypair } from "../lib/remote-pairing/noise.mjs";
import { generateRelayToken } from "../lib/remote-pairing/pairings.mjs";

class FakeWebSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
  }
  addEventListener() {}
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

function makeTransport(transportOptions = {}) {
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
    ...transportOptions,
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

test("short-lived relay reset loops open the reconnect circuit", () => {
  const transport = makeTransport({
    failureThreshold: 3,
    circuitBreakerMs: 5_000,
    maxCircuitBreakerMs: 5_000,
    stableConnectionMs: 60_000,
  });

  try {
    for (let i = 0; i < 3; i++) {
      transport._setState(STATE.CONNECTED);
      transport._handleClose({ code: 4004, reason: "fresh-handshake" });
      transport._cancelReconnectTimer();
    }
    assert.ok(
      transport._circuitDelayMs() > 0,
      "rapid connected→4004 cycles should keep failure history and open circuit",
    );
  } finally {
    transport.close();
  }
});

test("stable connection clears reconnect circuit history", async () => {
  const transport = makeTransport({
    stableConnectionMs: 5,
  });

  try {
    transport._recentFailureAtMs = [Date.now()];
    transport._circuitOpenUntilMs = Date.now() + 60_000;
    transport._circuitOpenCount = 2;
    transport._setState(STATE.CONNECTED);

    await sleep(20);

    assert.equal(transport._recentFailureAtMs.length, 0);
    assert.equal(transport._circuitOpenUntilMs, 0);
    assert.equal(transport._circuitOpenCount, 0);
  } finally {
    transport.close();
  }
});

test("keepalive ping uses text frames for Durable Object auto-response", () => {
  const transport = makeTransport();
  const ws = new FakeWebSocket();
  ws.readyState = 1;
  transport._ws = ws;

  try {
    transport._sendPing();

    assert.deepEqual(ws.sent, [TEXT_KEEPALIVE_PING]);
  } finally {
    transport.close();
  }
});

test("activity delays the next adaptive keepalive ping", async () => {
  const transport = makeTransport({ pingIntervalMs: 20 });
  const ws = new FakeWebSocket();
  ws.readyState = 1;
  transport._ws = ws;
  transport._lastActivityAtMs = Date.now() - 10_000;

  try {
    transport._startPing();
    transport._markActivity();
    await sleep(30);

    assert.deepEqual(ws.sent, []);
  } finally {
    transport.close();
  }
});
