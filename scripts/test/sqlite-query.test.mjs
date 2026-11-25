import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { querySqliteNative } from "../lib/sqlite-query.mjs";

test("native SQLite reads WAL-backed rows and prevents writes without sqlite3", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-sqlite-"));
  const dbFile = path.join(tmp, "日本語 logs.sqlite");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE logs (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO logs VALUES (1, '日本語');");
    assert.deepEqual(await querySqliteNative(dbFile, "SELECT id, text FROM logs"), [{ id: 1, text: "日本語" }]);
    await assert.rejects(querySqliteNative(dbFile, "INSERT INTO logs VALUES (2, 'no') RETURNING id"), /readonly|read.only/iu);
    assert.deepEqual(await querySqliteNative(dbFile, "SELECT count(*) AS count FROM logs"), [{ count: 1 }]);
    await assert.rejects(querySqliteNative(path.join(tmp, "missing.sqlite"), "SELECT 1"), /unable to open/iu);
  } finally {
    db.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
