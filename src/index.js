import { watch } from "node:fs";
import { ensureModelMetadata, loadConfig } from "./config.js";
import { connectMessenger } from "./messenger-browser.js";
import { createWatcher } from "./watcher.js";

let config = loadConfig();
ensureModelMetadata(config.chatbotModel);
config = loadConfig();
let detectedUserName = "";
let reloadTimer;
const envWatcher = watch(".env", () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      const requestedConfig = loadConfig();
      ensureModelMetadata(requestedConfig.chatbotModel);
      const nextConfig = loadConfig();
    Object.assign(config, nextConfig);
    if (!nextConfig.userName) config.userName = detectedUserName;
    console.log(`[watcher] configuration reloaded: idle=${config.idleMs / 1000}s dryRun=${config.dryRun}`);
  }, 200);
});

console.log("[watcher] starting local Messenger browser watcher");
console.log(`[watcher] mode=${config.dryRun ? "DRY RUN" : "LIVE"} idle=${config.idleMs / 60000}m`);

try {
  const { page, userName } = await connectMessenger(config);
  detectedUserName = userName;
  if (detectedUserName && !config.userName) {
    config.userName = detectedUserName;
    console.log(`[watcher] detected logged-in account: ${detectedUserName}`);
  }
  const watcher = createWatcher({ page, config });
  process.on("SIGINT", () => {
    envWatcher.close();
    watcher.stop();
    console.log("\n[watcher] stopped");
  });
  await watcher.start();
} catch (error) {
  console.error(`[watcher] ${error.message}`);
  console.error("[watcher] Start Chromium with remote debugging and keep Messenger logged in.");
  process.exitCode = 1;
}
