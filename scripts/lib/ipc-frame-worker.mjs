import { parentPort } from "node:worker_threads";

import { projectIpcMessage } from "./ipc-message-projector.mjs";

if (!parentPort) {
  throw new Error("ipc-frame-worker requires a parent port");
}

parentPort.on("message", (payload) => {
  if (payload?.type !== "frame" || !payload.frame) return;
  const startedAt = performance.now();
  const frame = Buffer.from(payload.frame.buffer, payload.frame.byteOffset, payload.frame.byteLength);
  try {
    const message = JSON.parse(frame.toString("utf8"));
    const parsedAt = performance.now();
    parentPort.postMessage({
      type: "message",
      message: projectIpcMessage(message),
      frameBytes: frame.length,
      parseMs: Math.round(parsedAt - startedAt),
      totalMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      error: String(error?.message || error || "IPC frame parse failed"),
      frameBytes: frame.length,
    });
  }
});
