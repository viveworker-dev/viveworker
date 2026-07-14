import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridgeSource = readFileSync(new URL("../viveworker-bridge.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");

test("Codex completion history remains visible in the completed inbox", () => {
  assert.match(
    bridgeSource,
    /const completedKinds = new Set\(\["completion", "assistant_final", "approval", "moltbook_reply", "moltbook_draft", "thread_share", "a2a_task_result"\]\);/u,
    "The Codex SQLite completion scanner stores legacy completion history items that must not be filtered out"
  );
  assert.match(
    appSource,
    /const COMPLETED_CARD_KINDS = new Set\(\["completion", "assistant_final", "approval", "moltbook_reply", "moltbook_draft", "a2a_task_result", "thread_share"\]\);/u,
    "Legacy Codex completion items should use the completed-result card"
  );
});

test("SQLite reads wait briefly and retry transient busy locks", () => {
  assert.match(bridgeSource, /const SQLITE_QUERY_BUSY_TIMEOUT_MS = 1000;/u);
  assert.match(bridgeSource, /const SQLITE_QUERY_MAX_ATTEMPTS = 3;/u);
  assert.match(bridgeSource, /function isRetryableSqliteQueryError\(error\)[\s\S]*?database is locked[\s\S]*?database is busy[\s\S]*?sqlite_\(\?:busy\|locked\)/u);
  assert.match(bridgeSource, /async function runSqliteJsonQuery\(dbFile, sql\)[\s\S]*?runSqliteJsonQueryOnce\(dbFile, sql\)[\s\S]*?await sleep\(sqliteQueryRetryDelayMs\(attempt\)\)/u);
  assert.match(bridgeSource, /spawn\("sqlite3", \["-readonly", "-cmd", `\.timeout \$\{SQLITE_QUERY_BUSY_TIMEOUT_MS\}`, "-json", dbFile, sql\]/u);
});
