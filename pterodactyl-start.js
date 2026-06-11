import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const requiredPaths = [
  "package.json",
  "packages/database/prisma/schema.prisma",
  "packages/shared/package.json",
  "apps/api/package.json",
  "apps/dashboard/package.json",
  "apps/bot/package.json",
  "apps/worker/package.json",
  "scripts/ensure-additive-schema.js"
];

const missingPaths = requiredPaths.filter((filePath) => !existsSync(filePath));

if (missingPaths.length > 0) {
  console.error("MailSync deployment is incomplete. Missing required files:");
  for (const filePath of missingPaths) {
    console.error(`- ${filePath}`);
  }
  console.error("Upload the full project folder, not only package.json or pterodactyl-start.js.");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

run("npm", ["install", "--include=dev"]);
run("npm", ["run", "db:generate"]);
const dbPush = run("npm", ["run", "db:push"], { allowFailure: true });
if (dbPush.status !== 0) {
  console.warn("Prisma db:push failed; applying additive MailSync schema fallback.");
  run("node", ["scripts/ensure-additive-schema.js"]);
}
run("npm", ["run", "build"]);

const child = spawn("npm", ["run", "start:prod"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code) => process.exit(code ?? 0));
