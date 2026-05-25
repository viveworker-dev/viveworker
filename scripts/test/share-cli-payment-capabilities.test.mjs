import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-share-payments-"));
process.env.HOME = tmpHome;
await fs.mkdir(path.join(tmpHome, ".viveworker"), { recursive: true });
await fs.writeFile(
  path.join(tmpHome, ".viveworker", "a2a.env"),
  [
    "A2A_RELAY_USER_ID=seller",
    "A2A_API_KEY=secret",
    "VIVEWORKER_SHARE_URL=https://share.example.test",
    "",
  ].join("\n"),
  "utf8",
);

const { runShareCli } = await import("../share-cli.mjs");

test("share upload --accept sends multi-network payment options", async (t) => {
  const bridge = createServer((req, res) => {
    assert.equal(req.url, "/api/hazbase/status");
    assert.equal(req.headers["x-viveworker-hook-secret"], "bridge-secret");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      enabled: true,
      paymentCapabilities: [
        {
          network: "base-sepolia",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x1111111111111111111111111111111111111111",
          configured: true,
        },
        {
          network: "polygon-amoy",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x3333333333333333333333333333333333333333",
          configured: true,
        },
        {
          network: "polygon-amoy",
          asset: "jpyc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x3333333333333333333333333333333333333333",
          configured: true,
        },
        {
          network: "liquidtestnet",
          asset: "usdt",
          scheme: "exact-liquid-pset",
          payoutMethod: "external_liquid",
          payTo: "tlq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
          configured: true,
        },
      ],
    }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const port = bridge.address().port;
  await fs.writeFile(
    path.join(tmpHome, ".viveworker", "config.env"),
    [
      `NATIVE_APPROVAL_SERVER_PORT=${port}`,
      "SESSION_SECRET=bridge-secret",
      "",
    ].join("\n"),
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  const filePath = path.join(tmpHome, "paid.html");
  await fs.writeFile(filePath, "<!doctype html><p>paid</p>", "utf8");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://share.example.test/api/upload");
    assert.equal(init.method, "POST");
    assert.equal(init.body.get("price"), "0.10");
    const options = JSON.parse(init.body.get("paymentOptions"));
    assert.deepEqual(options.map((entry) => `${entry.network}:${entry.asset}`), [
      "base-sepolia:usdc",
      "polygon-amoy:usdc",
      "polygon-amoy:jpyc",
      "liquidtestnet:usdt",
    ]);
    assert.equal(options[0].payoutMethod, "hazbase_wallet");
    assert.equal(options[1].payoutMethod, "hazbase_wallet");
    assert.equal(options[2].payoutMethod, "hazbase_wallet");
    assert.equal(options[3].payoutMethod, "external_liquid");
    return new Response(JSON.stringify({
      ok: true,
      slug: "paid123",
      url: "https://share.example.test/v/paid123",
      size: 25,
      originalName: "paid.html",
      price: "100000",
      payTo: options[0].payTo,
      network: "base-sepolia",
      paymentOptions: options.map((entry) => ({
        ...entry,
        priceAtomic: entry.asset === "usdt" ? "10000000" : entry.asset === "jpyc" ? "100000000000000000" : "100000",
      })),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const output = await withCapturedConsole(() => runShareCli([
    "upload",
    filePath,
    "--price",
    "0.10",
    "--accept",
    "base-sepolia:usdc,polygon-amoy:usdc,polygon-amoy:jpyc,liquidtestnet:usdt",
    "--json",
  ]));
  assert.match(output, /"paymentOptions"/u);
});

test("share upload --accept wallet-defaults honors agent payment defaults", async (t) => {
  const bridge = createServer((req, res) => {
    assert.equal(req.url, "/api/hazbase/status");
    assert.equal(req.headers["x-viveworker-hook-secret"], "bridge-secret");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      enabled: true,
      agentPaymentDefaults: {
        mode: "custom",
        effectiveAccepts: [{ network: "liquidtestnet", asset: "usdt" }],
      },
      paymentCapabilities: [
        {
          network: "base-sepolia",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x1111111111111111111111111111111111111111",
          configured: true,
        },
        {
          network: "liquidtestnet",
          asset: "usdt",
          scheme: "exact-liquid-pset",
          payoutMethod: "external_liquid",
          payTo: "tlq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
          configured: true,
        },
      ],
    }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const port = bridge.address().port;
  await fs.writeFile(
    path.join(tmpHome, ".viveworker", "config.env"),
    [
      `NATIVE_APPROVAL_SERVER_PORT=${port}`,
      "SESSION_SECRET=bridge-secret",
      "",
    ].join("\n"),
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  const filePath = path.join(tmpHome, "defaults.html");
  await fs.writeFile(filePath, "<!doctype html><p>defaults</p>", "utf8");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://share.example.test/api/upload");
    assert.equal(init.method, "POST");
    const options = JSON.parse(init.body.get("paymentOptions"));
    assert.deepEqual(options.map((entry) => `${entry.network}:${entry.asset}`), [
      "liquidtestnet:usdt",
    ]);
    return new Response(JSON.stringify({
      ok: true,
      slug: "defaults123",
      url: "https://share.example.test/v/defaults123",
      size: 29,
      originalName: "defaults.html",
      price: "10000000",
      payTo: options[0].payTo,
      network: "liquidtestnet",
      paymentOptions: options.map((entry) => ({ ...entry, priceAtomic: "10000000" })),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const output = await withCapturedConsole(() => runShareCli([
    "upload",
    filePath,
    "--price",
    "0.10",
    "--accept",
    "wallet-defaults",
    "--json",
  ]));
  assert.match(output, /liquidtestnet/u);
});

test("share upload --accept wallet-defaults excludes mainnet capabilities before release", async (t) => {
  const bridge = createServer((req, res) => {
    assert.equal(req.url, "/api/hazbase/status");
    assert.equal(req.headers["x-viveworker-hook-secret"], "bridge-secret");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      enabled: true,
      agentPaymentDefaults: { mode: "configured", effectiveAccepts: [] },
      paymentCapabilities: [
        {
          network: "base-sepolia",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x1111111111111111111111111111111111111111",
          configured: true,
        },
        {
          network: "base",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x2222222222222222222222222222222222222222",
          configured: true,
        },
        {
          network: "polygon-amoy",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x3333333333333333333333333333333333333333",
          configured: true,
        },
        {
          network: "polygon",
          asset: "usdc",
          scheme: "exact",
          payoutMethod: "hazbase_wallet",
          payTo: "0x4444444444444444444444444444444444444444",
          configured: true,
        },
        {
          network: "liquidtestnet",
          asset: "usdt",
          scheme: "exact-liquid-pset",
          payoutMethod: "external_liquid",
          payTo: "tlq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
          configured: true,
        },
        {
          network: "liquidv1",
          asset: "usdt",
          scheme: "exact-liquid-pset",
          payoutMethod: "external_liquid",
          payTo: "lq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
          configured: true,
        },
      ],
    }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const port = bridge.address().port;
  await fs.writeFile(
    path.join(tmpHome, ".viveworker", "config.env"),
    [
      `NATIVE_APPROVAL_SERVER_PORT=${port}`,
      "SESSION_SECRET=bridge-secret",
      "",
    ].join("\n"),
    "utf8",
  );

  const originalFetch = globalThis.fetch;
  const filePath = path.join(tmpHome, "defaults-testnet-only.html");
  await fs.writeFile(filePath, "<!doctype html><p>defaults</p>", "utf8");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://share.example.test/api/upload");
    const options = JSON.parse(init.body.get("paymentOptions"));
    assert.deepEqual(options.map((entry) => `${entry.network}:${entry.asset}`), [
      "base-sepolia:usdc",
      "polygon-amoy:usdc",
      "liquidtestnet:usdt",
    ]);
    return new Response(JSON.stringify({
      ok: true,
      slug: "defaultsTestnet123",
      url: "https://share.example.test/v/defaultsTestnet123",
      size: 29,
      originalName: "defaults-testnet-only.html",
      price: "100000",
      payTo: options[0].payTo,
      network: "base-sepolia",
      paymentOptions: options.map((entry) => ({ ...entry, priceAtomic: entry.asset === "usdt" ? "10000000" : "100000" })),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const output = await withCapturedConsole(() => runShareCli([
    "upload",
    filePath,
    "--price",
    "0.10",
    "--accept",
    "wallet-defaults",
    "--json",
  ]));
  assert.match(output, /base-sepolia/u);
  assert.match(output, /polygon-amoy/u);
  assert.doesNotMatch(output, /liquidv1|polygon:usdc|0x2222222222222222222222222222222222222222|0x4444444444444444444444444444444444444444/u);
});

test("share upload rejects explicit mainnet accepts before release", async (t) => {
  const bridge = createServer((req, res) => {
    assert.equal(req.url, "/api/hazbase/status");
    assert.equal(req.headers["x-viveworker-hook-secret"], "bridge-secret");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ enabled: true, paymentCapabilities: [] }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const port = bridge.address().port;
  await fs.writeFile(
    path.join(tmpHome, ".viveworker", "config.env"),
    [
      `NATIVE_APPROVAL_SERVER_PORT=${port}`,
      "SESSION_SECRET=bridge-secret",
      "",
    ].join("\n"),
    "utf8",
  );

  const filePath = path.join(tmpHome, "mainnet-reject.html");
  await fs.writeFile(filePath, "<!doctype html><p>mainnet</p>", "utf8");
  await assert.rejects(
    () => runShareCli(["upload", filePath, "--price", "0.10", "--accept", "base:usdc", "--json"]),
    /coming soon/u,
  );
  await assert.rejects(
    () => runShareCli(["upload", filePath, "--price", "0.10", "--accept", "polygon:usdc", "--json"]),
    /coming soon/u,
  );
});

test("share pay dry-run selects a Liquid x402 requirement", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{
      scheme: "exact-liquid-pset",
      network: "liquidtestnet",
      maxAmountRequired: "10000000",
      resource: "https://share.example.test/v/liquid",
      description: "Unlock Liquid share",
      mimeType: "text/html; charset=utf-8",
      payTo: "tlq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      maxTimeoutSeconds: 60,
      asset: "b612eb46313a2cd6ebabd8b7a8eed5696e29898b87a43bff41c94f51acef9d73",
      extra: {
        paymentRequestId: "liquid_req_12345678",
        asset: "usdt",
        assetId: "b612eb46313a2cd6ebabd8b7a8eed5696e29898b87a43bff41c94f51acef9d73",
        decimals: 8,
      },
    }],
  }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });

  const output = await withCapturedConsole(() => runShareCli([
    "pay",
    "https://share.example.test/v/liquid",
    "--dry-run",
    "--json",
  ]));
  const parsed = JSON.parse(output);
  assert.equal(parsed.scheme, "exact-liquid-pset");
  assert.equal(parsed.network, "liquidtestnet");
  assert.equal(parsed.amount, "0.10");
  assert.equal(parsed.assetLabel, "USDt");
});

test("share pay dry-run selects a Polygon Amoy x402 requirement", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      network: "polygon-amoy",
      maxAmountRequired: "100000",
      resource: "https://share.example.test/v/polygon-amoy",
      description: "Unlock Polygon Amoy share",
      mimeType: "text/html; charset=utf-8",
      payTo: "0x3333333333333333333333333333333333333333",
      maxTimeoutSeconds: 60,
      asset: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      extra: {
        paymentRequestId: "polygon_amoy_req_12345678",
        asset: "usdc",
        decimals: 6,
      },
    }],
  }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });

  const output = await withCapturedConsole(() => runShareCli([
    "pay",
    "https://share.example.test/v/polygon-amoy",
    "--dry-run",
    "--json",
  ]));
  const parsed = JSON.parse(output);
  assert.equal(parsed.scheme, "exact");
  assert.equal(parsed.network, "polygon-amoy");
  assert.equal(parsed.chainId, 80002);
  assert.equal(parsed.amount, "0.10");
  assert.equal(parsed.assetLabel, "USDC");
});

test("share pay dry-run displays Polygon Amoy JPYC requirements", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      network: "polygon-amoy",
      maxAmountRequired: "150000000000000000000",
      resource: "https://share.example.test/v/polygon-amoy-jpyc",
      description: "Unlock Polygon Amoy JPYC share",
      mimeType: "text/html; charset=utf-8",
      payTo: "0x3333333333333333333333333333333333333333",
      maxTimeoutSeconds: 60,
      asset: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
      extra: {
        paymentRequestId: "polygon_amoy_jpyc_req_12345678",
        asset: "jpyc",
        decimals: 18,
      },
    }],
  }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });

  const output = await withCapturedConsole(() => runShareCli([
    "pay",
    "https://share.example.test/v/polygon-amoy-jpyc",
    "--dry-run",
    "--json",
  ]));
  const parsed = JSON.parse(output);
  assert.equal(parsed.scheme, "exact");
  assert.equal(parsed.network, "polygon-amoy");
  assert.equal(parsed.chainId, 80002);
  assert.equal(parsed.amount, "150.00");
  assert.equal(parsed.assetLabel, "JPYC");
});

async function withCapturedConsole(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}
