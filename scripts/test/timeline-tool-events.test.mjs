import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const bridgeSource = readFileSync(new URL("../viveworker-bridge.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../../web/i18n.js", import.meta.url), "utf8");

test("timeline supports read/search file events and separate command events", () => {
  assert.match(bridgeSource, /\["read",\s*"search",\s*"command",\s*"write",\s*"create",\s*"delete",\s*"rename"\]/);
  assert.match(bridgeSource, /"file_event",\s*"command_event"/);
  assert.match(bridgeSource, /const kind = normalizedType === "command" \? "command_event" : "file_event"/);
  assert.match(bridgeSource, /rawKind === "file_event" && fileEventType === "command" \? "command_event" : rawKind/);
  assert.match(i18nSource, /"fileEvent\.search"/);
  assert.match(i18nSource, /"common\.commandEvent"/);
  assert.match(i18nSource, /"timeline\.kindFilter\.commands"/);
  assert.match(appSource, /case "search":\s*return L\("fileEvent\.search"\);/);
  assert.match(appSource, /case "command_event":\s*return \{ label: L\("common\.commandEvent"\)/);
  assert.match(appSource, /case "commands":\s*return kind === "command_event";/);
  assert.match(appSource, /<pre class="timeline-entry__command"><code>/);
  assert.match(appSource, /function timelineCommandEventCommand/);
  assert.match(appSource, /function renderCommandEventDetail/);
  assert.match(appSource, /<pre class="detail-command-block"><code>/);
});

test("Codex exec_command calls become timeline operation events", () => {
  assert.match(bridgeSource, /payloadType === "function_call" && cleanText\(payload\?\.name \|\| ""\) === "exec_command"/);
  assert.match(bridgeSource, /classifyTimelineCommand\(commandText\)/);
  assert.match(bridgeSource, /buildToolTimelineEntry\(\{\s*provider: "codex"/);
});

test("Claude tool_use blocks become timeline operation events", () => {
  assert.match(bridgeSource, /function buildClaudeToolTimelineEntries/);
  assert.match(bridgeSource, /block\.type !== "tool_use"/);
  assert.match(bridgeSource, /lowerToolName === "bash"/);
  assert.match(bridgeSource, /\["grep",\s*"glob",\s*"websearch",\s*"webfetch"\]\.includes\(lowerToolName\)/);
  assert.match(bridgeSource, /source: "claude-tool"/);
});

test("timeline operation details include command context but not command output", () => {
  assert.match(bridgeSource, /function timelineCommandMessage/);
  assert.match(bridgeSource, /function firstMarkdownCodeFenceText/);
  assert.match(bridgeSource, /commandText,\s*fileRefs:/);
  assert.match(bridgeSource, /redactTimelineCommandText/);
  assert.doesNotMatch(bridgeSource, /payload\.output[\s\S]{0,120}messageText/);
});
