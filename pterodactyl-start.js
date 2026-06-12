import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const requiredPaths = [
  "package.json",
  "packages/database/prisma/schema.prisma",
  "packages/shared/package.json",
  "apps/api/package.json",
  "apps/dashboard/package.json",
  "apps/bot/package.json",
  "apps/worker/package.json",
  "scripts/check-database.js",
  "scripts/check-runtime-build.js",
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

function parseDotenvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) return null;
  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (!key) return null;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadEnvFile() {
  if (!existsSync(".env")) {
    console.error("Missing .env. Upload the private Pterodactyl .env before starting MailSync.");
    process.exit(1);
  }

  const contents = readFileSync(".env", "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    process.env[key] = value;
  }
}

function databaseTarget() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.protocol}//${url.hostname}:${url.port || "3306"}${url.pathname}`;
  } catch {
    return "invalid DATABASE_URL";
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env
  });

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

loadEnvFile();
console.log(`MailSync database target: ${databaseTarget()}`);

run("npm", ["install", "--include=dev"]);
run("npm", ["run", "db:generate"]);
run("node", ["scripts/check-database.js"]);
const dbPush = run("npm", ["run", "db:push"], { allowFailure: true });
if (dbPush.status !== 0) {
  console.warn("Prisma db:push failed; applying additive MailSync schema fallback.");
  run("node", ["scripts/ensure-additive-schema.js"]);
}
run("npm", ["run", "build"]);
run("node", ["scripts/check-runtime-build.js"]);

const child = spawn("npm", ["run", "start:prod"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env
});

child.on("exit", (code) => process.exit(code ?? 0));
