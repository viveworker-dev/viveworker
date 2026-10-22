import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

import {
  PATCHED_NODE_RELEASES,
  RECOMMENDED_NODE_RELEASE,
  assessNodeRuntime,
  describeNodeRuntimeProblem,
  otherPatchedNodeReleases,
  parseNodeVersion,
} from "../lib/node-runtime.mjs";

test("package.json does not declare engines.node", async () => {
  // npm resolves a bare `npx viveworker` to the newest engine-compatible
  // release, so engines would send unpatched-Node users to an older,
  // ungated version. The requirement is enforced at runtime instead.
  const pkg = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines?.node, undefined);
  assert.ok(PATCHED_NODE_RELEASES.includes(RECOMMENDED_NODE_RELEASE));
});

test("parseNodeVersion accepts process.version and process.versions.node shapes", () => {
  assert.deepEqual(parseNodeVersion("v24.22.1"), [24, 22, 1]);
  assert.deepEqual(parseNodeVersion("22.23.4"), [22, 23, 4]);
  assert.deepEqual(parseNodeVersion("26.12.1-nightly2026"), [26, 12, 1]);
  assert.equal(parseNodeVersion(""), null);
  assert.equal(parseNodeVersion("latest"), null);
});

test("assessNodeRuntime matches ^22.23.4 || ^24.22.1 || >=26.12.1 (semver, prereleases included)", () => {
  const cases = [
    ["18.19.1", false, "unsupported-line"],
    ["20.19.0", false, "unsupported-line"],
    ["22.23.1", false, "unpatched"],
    ["22.23.4-rc.1", false, "unpatched"],
    ["22.23.4", true, ""],
    ["22.24.0", true, ""],
    ["23.11.0", false, "unsupported-line"],
    ["24.19.0", false, "unpatched"],
    ["24.22.1-rc.1", false, "unpatched"],
    ["v24.22.1", true, ""],
    ["24.23.0-rc.1", true, ""],
    ["25.2.0", false, "unsupported-line"],
    ["26.12.0", false, "unpatched"],
    ["26.12.1-nightly20261020", false, "unpatched"],
    ["26.12.1", true, ""],
    ["27.0.0", true, ""],
    ["not-a-version", false, "unknown"],
  ];
  for (const [version, supported, reason] of cases) {
    const runtime = assessNodeRuntime(version);
    assert.equal(runtime.supported, supported, version);
    assert.equal(runtime.reason, reason, version);
  }
  assert.equal(assessNodeRuntime("24.19.0").minimum, "24.22.1");
  assert.equal(assessNodeRuntime("20.19.0").minimum, RECOMMENDED_NODE_RELEASE);
});

test("describeNodeRuntimeProblem explains unsupported runtimes only", () => {
  assert.equal(describeNodeRuntimeProblem(assessNodeRuntime("24.22.1")), "");
  assert.match(describeNodeRuntimeProblem(assessNodeRuntime("24.19.0")), /v24\.19\.0 is missing .*v24\.22\.1 or later/u);
  assert.match(describeNodeRuntimeProblem(assessNodeRuntime("25.2.0")), /v25\.2\.0 is end-of-life .*Install Node\.js v24\.22\.1 \(or v22\.23\.4\+ \/ v26\.12\.1\+\)/u);
  assert.equal(otherPatchedNodeReleases("24.22.1"), "v22.23.4+ / v26.12.1+");
});
