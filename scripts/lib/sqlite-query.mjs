import { Worker } from "node:worker_threads";

export function querySqliteNative(dbFile, sql, { busyTimeoutMs = 1000, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sqlite-query-worker.mjs", import.meta.url), {
      workerData: { dbFile, sql, busyTimeoutMs },
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("sqlite-query-timeout")), timeoutMs);
    function finish(error, rows) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Wait for native database handles to close before callers reuse/delete
      // the file (Windows does not allow deleting an open database).
      worker.terminate().then(() => error ? reject(error) : resolve(rows), reject);
    }
    worker.once("message", (message) => message.error
      ? finish(new Error(message.error)) : finish(null, message.rows));
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error("sqlite-worker-exit-" + code));
    });
  });
}
