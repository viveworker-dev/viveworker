import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-share-cli-"));
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

test("share update --file PATCHes multipart bytes to the existing slug", async (t) => {
  const originalFetch = globalThis.fetch;
  const filePath = path.join(tmpHome, "replacement.html");
  await fs.writeFile(filePath, "<!doctype html><p>replacement</p>", "utf8");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let called = false;
  globalThis.fetch = async (url, init) => {
    called = true;
    assert.equal(url, "https://share.example.test/api/share/abc123");
    assert.equal(init.method, "PATCH");
    assert.equal(init.headers["x-a2a-user"], "seller");
    assert.equal(init.headers["x-a2a-key"], "secret");
    assert.equal(init.headers["content-type"], undefined);
    assert.equal(init.body.get("expiresDays"), "7");

    const file = init.body.get("file");
    assert.equal(file.name, "replacement.html");
    assert.equal(file.type, "text/html; charset=utf-8");
    assert.equal(await file.text(), "<!doctype html><p>replacement</p>");

    return new Response(JSON.stringify({
      ok: true,
      slug: "abc123",
      url: "https://share.example.test/v/abc123",
      size: 34,
      originalName: "replacement.html",
      fileReplaced: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await withCapturedConsole(() => runShareCli([
    "update",
    "abc123",
    "--file",
    filePath,
    "--expires-days",
    "7",
    "--json",
  ]));

  assert.equal(called, true);
});

test("share replace is a shorthand for replacing the existing slug body", async (t) => {
  const originalFetch = globalThis.fetch;
  const filePath = path.join(tmpHome, "replace.html");
  await fs.writeFile(filePath, "<html><body>replace alias</body></html>", "utf8");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://share.example.test/api/share/slug456");
    assert.equal(init.method, "PATCH");
    assert.equal(init.body.get("file").name, "replace.html");
    return new Response(JSON.stringify({
      ok: true,
      slug: "slug456",
      url: "https://share.example.test/v/slug456",
      size: 39,
      originalName: "replace.html",
      fileReplaced: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const output = await withCapturedConsole(() => runShareCli([
    "replace",
    "slug456",
    filePath,
  ]));

  assert.match(output, /Replaced file for slug456/u);
  assert.match(output, /https:\/\/share\.example\.test\/v\/slug456/u);
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
