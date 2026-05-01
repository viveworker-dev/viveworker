import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_BUILD_ID } from "../../web/build-id.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const BUILD_ID_PLACEHOLDER = "__VIVEWORKER_APP_BUILD_ID__";

async function readRepoFile(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("web build id has one source and browser assets use the bridge placeholder", async () => {
  assert.match(APP_BUILD_ID, /^\d{8}-[a-z0-9-]+$/u);

  const [bridge, appJs, swJs, indexHtml] = await Promise.all([
    readRepoFile("scripts/viveworker-bridge.mjs"),
    readRepoFile("web/app.js"),
    readRepoFile("web/sw.js"),
    readRepoFile("web/index.html"),
  ]);

  assert.match(bridge, /import \{ APP_BUILD_ID as WEB_APP_BUILD_ID \} from "\.\.\/web\/build-id\.js";/u);
  assert.match(bridge, /WEB_APP_BUILD_ID_PLACEHOLDER/u);
  assert.match(bridge, /renderWebAssetBuffer/u);

  assert.match(appJs, new RegExp(`APP_BUILD_ID = "${BUILD_ID_PLACEHOLDER}"`, "u"));
  assert.match(swJs, new RegExp(`APP_BUILD_ID = "${BUILD_ID_PLACEHOLDER}"`, "u"));
  assert.match(indexHtml, new RegExp(`v=${BUILD_ID_PLACEHOLDER}`, "u"));

  for (const [label, text] of [
    ["bridge", bridge],
    ["app.js", appJs],
    ["sw.js", swJs],
    ["index.html", indexHtml],
  ]) {
    assert.doesNotMatch(
      text,
      /202604\d{2}-[a-z0-9-]+/u,
      `${label} should not hardcode dated web build ids`
    );
  }
});
