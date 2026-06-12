import { PrismaClient } from "@prisma/client";

function databaseTarget() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.protocol}//${url.hostname}:${url.port || "3306"}${url.pathname}`;
  } catch {
    return "invalid DATABASE_URL";
  }
}

const prisma = new PrismaClient();

try {
  await prisma.$queryRaw`SELECT 1`;
  console.log(`Database reachable: ${databaseTarget()}`);
} catch (error) {
  console.error(`Database unreachable: ${databaseTarget()}`);
  console.error(error instanceof Error ? error.message : "Unknown database connection error");
  console.error("Check the private .env DATABASE_URL uploaded to Pterodactyl. It must point at the MySQL host reachable from the container.");
  process.exit(1);
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

