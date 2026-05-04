import test from "node:test";
import assert from "node:assert/strict";

import { normalizeViveworkerTaskMetadata } from "../a2a-handler.mjs";
import {
  buildA2AExecutionInstruction,
  buildPaidUnlockResponse,
  resolveA2AExecutionOptions,
  shouldUploadPaidDeliverable,
  uploadPaidA2ADeliverable,
} from "../a2a-executor.mjs";

test("normalizes nested viveworker x402-pro metadata", () => {
  const normalized = normalizeViveworkerTaskMetadata({
    viveworker: {
      mode: "x402-pro",
      requestedTier: "premium",
      requestedExecutor: "Codex",
      requestedModel: "gpt-5.5",
      deliverableType: "research brief",
      payment: {
        price: "1.00",
        payTo: "0x1111111111111111111111111111111111111111",
      },
    },
  });

  assert.deepEqual(normalized, {
    mode: "x402-pro",
    requestedTier: "pro",
    requestedExecutor: "codex",
    requestedModel: "gpt-5.5",
    deliverableType: "research brief",
    paidDeliverable: true,
    payment: {
      enabled: true,
      price: "1.00",
      payTo: "0x1111111111111111111111111111111111111111",
      mode: "x402",
    },
  });
});

test("keeps malformed payment metadata on the paid path", () => {
  const normalized = normalizeViveworkerTaskMetadata({
    payment: {
      price: "1.0000001",
      payTo: "not-an-address",
    },
  });

  assert.equal(normalized.mode, "x402-pro");
  assert.equal(normalized.paidDeliverable, true);
  assert.equal(normalized.payment.invalid, true);
  assert.equal(normalized.payment.reason, "invalid-price-or-pay-to");
});

test("x402-pro execution options choose explicit model before pro default", () => {
  const explicit = resolveA2AExecutionOptions({
    viveworker: { requestedTier: "pro", requestedModel: "gpt-5.5" },
  }, { a2aProModel: "gpt-5.4" }, "codex");
  assert.equal(explicit.model, "gpt-5.5");

  const defaulted = resolveA2AExecutionOptions({
    viveworker: { requestedTier: "pro" },
  }, { a2aProModel: "gpt-5.4" }, "codex");
  assert.equal(defaulted.model, "gpt-5.4");

  const standard = resolveA2AExecutionOptions({
    viveworker: { requestedTier: "standard" },
  }, { a2aProModel: "gpt-5.4" }, "codex");
  assert.equal(standard.model, "");
});

test("pro tasks get a paid-deliverable execution wrapper", () => {
  const instruction = buildA2AExecutionInstruction("Research this market.", {
    viveworker: {
      requestedTier: "pro",
      deliverableType: "market brief",
    },
  });

  assert.match(instruction, /paid A2A Pro deliverable/u);
  assert.match(instruction, /Deliverable type: market brief/u);
  assert.match(instruction, /Research this market\./u);
});

test("paid unlock response returns only the unlock contract for requester", () => {
  const task = {
    viveworker: { deliverableType: "research brief" },
  };
  const response = buildPaidUnlockResponse({
    task,
    paidShare: {
      url: "https://share.viveworker.com/s/demo",
      price: "1.00",
      payTo: "0x1111111111111111111111111111111111111111",
      network: "base-sepolia",
    },
  });

  assert.equal(shouldUploadPaidDeliverable({ viveworker: { mode: "x402-pro" } }), true);
  assert.match(response, /Unlock URL: https:\/\/share\.viveworker\.com\/s\/demo/u);
  assert.match(response, /Price: 1\.00 USDC on base-sepolia/u);
  assert.match(response, /Pay to: 0x1111111111111111111111111111111111111111/u);
});

test("uploads paid A2A deliverable through File Share with x402 fields", async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    called = true;
    assert.equal(url, "https://share.example.test/api/upload");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-a2a-user"], "seller");
    assert.equal(init.headers["x-a2a-key"], "secret");
    assert.equal(init.body.get("price"), "1.00");
    assert.equal(init.body.get("payTo"), "0x1111111111111111111111111111111111111111");
    assert.equal(init.body.get("expiresDays"), "3");

    const file = init.body.get("file");
    assert.equal(file.name, "a2a-task-123-deliverable.html");
    assert.equal(file.type, "text/html; charset=utf-8");
    const html = await file.text();
    assert.match(html, /Paid agent deliverable/u);
    assert.match(html, /Research &amp; summarize/u);
    assert.match(html, /Useful &lt;result&gt;/u);

    return new Response(JSON.stringify({
      url: "https://share.example.test/v/abc",
      slug: "abc",
      price: "1000000",
      payTo: "0x1111111111111111111111111111111111111111",
      network: "base-sepolia",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const paidShare = await uploadPaidA2ADeliverable({
    config: {
      a2aRelayUserId: "seller",
      a2aApiKey: "secret",
      a2aShareUrl: "https://share.example.test",
      a2aProExpiresDays: "3",
    },
    task: {
      id: "task-123",
      instruction: "Research & summarize",
      viveworker: {
        payment: {
          price: "1.00",
          payTo: "0x1111111111111111111111111111111111111111",
        },
      },
    },
    resultText: "Useful <result>",
  });

  assert.equal(called, true);
  assert.deepEqual(paidShare, {
    url: "https://share.example.test/v/abc",
    slug: "abc",
    price: "1",
    priceAtomic: "1000000",
    payTo: "0x1111111111111111111111111111111111111111",
    network: "base-sepolia",
    expiresAtMs: 0,
  });
});
