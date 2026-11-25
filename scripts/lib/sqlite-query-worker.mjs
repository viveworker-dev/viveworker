import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

let database;
try {
  database = new DatabaseSync(workerData.dbFile, { readOnly: true });
  database.exec("PRAGMA busy_timeout = " + Math.max(0, Math.trunc(workerData.busyTimeoutMs)));
  parentPort.postMessage({ rows: database.prepare(workerData.sql).all() });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  database?.close();
}
