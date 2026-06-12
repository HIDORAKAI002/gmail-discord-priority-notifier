import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function columnExists(tableName, columnName) {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    tableName,
    columnName
  );
  return Number(rows?.[0]?.count ?? 0) > 0;
}

async function addColumn(tableName, columnName, definition) {
  if (await columnExists(tableName, columnName)) {
    console.log(`Column ${tableName}.${columnName} already exists`);
    return;
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  console.log(`Added ${tableName}.${columnName}`);
}

try {
  await addColumn("User", "whatsappNumber", "VARCHAR(32) NULL");
  await addColumn("User", "whatsappEnabled", "BOOLEAN NOT NULL DEFAULT false");
  await addColumn("User", "whatsappAgentEnabled", "BOOLEAN NOT NULL DEFAULT false");
  await addColumn("User", "openWaBaseUrl", "VARCHAR(512) NULL");
  await addColumn("User", "openWaApiKey", "TEXT NULL");
  await addColumn("User", "openWaSessionId", "VARCHAR(120) NULL");
  await addColumn("EmailAccount", "lastPushHistoryId", "VARCHAR(120) NULL");
  await addColumn("EmailAccount", "watchExpiresAt", "DATETIME(3) NULL");
  await addColumn("EmailAccount", "syncRequestedAt", "DATETIME(3) NULL");
  await addColumn("EmailAccount", "syncRequestedReason", "VARCHAR(120) NULL");
  await addColumn("EmailLog", "bodyPreview", "TEXT NULL");
  await addColumn("EmailLog", "whatsappNotifiedAt", "DATETIME(3) NULL");
  await addColumn("EmailLog", "whatsappError", "TEXT NULL");
} catch (error) {
  console.error("Additive schema fallback failed.");
  console.error(error instanceof Error ? error.message : "Unknown schema fallback error");
  console.error("Check DATABASE_URL and MySQL reachability before restarting MailSync.");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
