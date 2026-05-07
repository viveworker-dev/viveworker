import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const bridgeSource = readFileSync(new URL("../viveworker-bridge.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");

test("Auto Pilot history is projected to the settings page without relying on stableId", () => {
  assert.match(bridgeSource, /function timelineAutoPilotProjection/);
  assert.match(bridgeSource, /\.\.\.timelineAutoPilotProjection\(entry\)/);
  assert.match(bridgeSource, /autoPilotMode: "read"/);
  assert.match(bridgeSource, /autoPilotMode: "write"/);
  assert.match(bridgeSource, /autoPilotWriteLane: lane/);

  assert.match(appSource, /entry\?\.autoPilotMode/);
  assert.match(appSource, /item\?\.autoPilotMode/);
  assert.match(appSource, /item\?\.autoPilotWriteLane/);
  assert.match(appSource, /stableId\.endsWith\(":autopilot"\)/);
});
