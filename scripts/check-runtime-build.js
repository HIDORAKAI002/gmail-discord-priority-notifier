import { existsSync, readFileSync } from "node:fs";

const apiBuildPath = "apps/api/dist/apps/api/src/index.js";

if (!existsSync(apiBuildPath)) {
  console.error(`Runtime build check failed: ${apiBuildPath} does not exist.`);
  console.error("Run npm run build before starting production.");
  process.exit(1);
}

const apiBuild = readFileSync(apiBuildPath, "utf8");

if (!apiBuild.includes("String(payload.historyId)")) {
  console.error("Runtime build check failed: Gmail Pub/Sub history IDs are not normalized.");
  console.error("This build can still throw: Argument lastPushHistoryId expected String, provided Int.");
  console.error("Upload the latest MailSync_PTERODACTYL_PRIVATE folder and restart Pterodactyl.");
  process.exit(1);
}

console.log("Runtime build check passed: Gmail Pub/Sub history IDs are normalized.");
