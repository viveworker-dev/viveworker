import { promises as fs } from "node:fs";
import { openBridgeControlServer } from "../../lib/managed-bridge.mjs";

const settings = JSON.parse(await fs.readFile(process.argv[process.argv.indexOf("--env-file") + 1], "utf8"));
if (settings.fail) process.exit(2);
if (settings.hang) await new Promise(() => setInterval(() => {}, 1000));
const control = await openBridgeControlServer({
  onStop: () => {
    if (settings.ignoreStop) return;
    setTimeout(async () => {
      await fs.writeFile(settings.marker, "flushed");
      await control.close();
    }, 30);
  },
});
