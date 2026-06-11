import {
  Client,
  Events,
  GatewayIntentBits,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { EmailDisposition, EmailLevel } from "@prisma/client";
import { loadConfig, prisma } from "@mailsync/shared";

const config = loadConfig();
const botStartedAt = new Date();

function gmailUrl(log: { gmailThreadId: string | null; gmailMessageId: string }) {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(log.gmailThreadId ?? log.gmailMessageId)}`;
}

function fieldValue(value: string | null | undefined, fallback = "Not available") {
  const clean = value?.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 1024) : fallback;
}

function clamp(value: string, length: number) {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 1))}...` : value;
}

function mailColumns(left: string, right: string, width = 34) {
  return `${clamp(left, width - 1).padEnd(width)}${clamp(right, width - 1)}`;
}

function levelRank(level: EmailLevel | string) {
  return {
    LOW: 0,
    NORMAL: 1,
    IMPORTANT: 2,
    CRITICAL: 3
  }[level] ?? 0;
}

function meetsMinimumLevel(level: EmailLevel | string, minimum: EmailLevel | string) {
  return levelRank(level) >= levelRank(minimum);
}

function splitBody(value: string, chunkSize = 950, maxChunks = 4) {
  const clean = value.replace(/\r/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  for (let index = 0; index < clean.length && chunks.length < maxChunks; index += chunkSize) {
    chunks.push(clean.slice(index, index + chunkSize));
  }
  if (clean.length > chunkSize * maxChunks && chunks.length) {
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1].slice(0, Math.max(0, chunkSize - 26))}\n[trimmed in Discord]`;
  }
  return chunks;
}

function buildMailComponent(log: {
  id: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  senderAddress: string | null;
  senderDomain: string | null;
  recipientAddress: string | null;
  subjectPreview: string | null;
  snippetPreview: string | null;
  bodyPreview: string | null;
  processedAt: Date;
  category: string;
  account: { emailAddress: string };
}) {
  const from = clamp(fieldValue(log.senderAddress ?? log.senderDomain, "Unknown sender"), 32);
  const to = clamp(fieldValue(log.recipientAddress ?? log.account.emailAddress, log.account.emailAddress), 32);
  const subject = clamp(fieldValue(log.subjectPreview, "Important email detected"), 180);
  const received = log.processedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const body = log.bodyPreview?.trim();
  const preview = body || log.snippetPreview?.replace(/\s+/g, " ").trim();
  const accent = log.category === "CRITICAL" ? 0xff6b35 : 0x28d17c;
  const components: Array<Record<string, unknown>> = [
    { type: 10, content: `# ${subject}` },
    { type: 14, divider: true, spacing: 1 },
    {
      type: 10,
      content: [
        `**Received**\n${received}`,
        "",
        "```text",
        mailColumns("From", "To"),
        mailColumns(from, to),
        "```"
      ].join("\n")
    }
  ];

  if (preview) {
    components.push(
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: body ? "**Email body**" : "**Preview**" },
      ...splitBody(preview).map((chunk) => ({ type: 10, content: chunk }))
    );
  }

  components.push({
    type: 1,
    components: [
      { type: 2, style: 5, label: "Open Gmail", url: gmailUrl(log) },
      { type: 2, style: 2, label: "Not important", custom_id: `not-important:${log.id}` },
      { type: 2, style: 2, label: "Mute domain", custom_id: `mute-domain:${log.id}` }
    ]
  });

  return {
    type: 17,
    accent_color: accent,
    components
  };
}

async function sendPriorityDm(client: Client, discordId: string, log: Parameters<typeof buildMailComponent>[0]) {
  const user = await client.users.fetch(discordId);
  const channel = await user.createDM();
  await client.rest.post(Routes.channelMessages(channel.id), {
    body: {
      flags: 32768,
      components: [buildMailComponent(log)],
      allowed_mentions: { parse: [] }
    }
  });
}

if (!config.DISCORD_BOT_TOKEN) {
  console.log("DISCORD_BOT_TOKEN missing; bot idle.");
  setInterval(() => undefined, 60000);
} else {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`MailSync bot ready as ${ready.user.tag}`);
    const suppressed = await prisma.emailLog.updateMany({
      where: { disposition: EmailDisposition.IMPORTANT, wasNotified: false, processedAt: { lt: botStartedAt } },
      data: { wasNotified: true, feedbackNotes: "Suppressed old backlog on bot startup" }
    });
    if (suppressed.count) console.log(`Suppressed ${suppressed.count} old priority backlog item(s)`);
    await ready.application.commands.set([
      new SlashCommandBuilder().setName("connect").setDescription("Open your MailSync dashboard"),
      new SlashCommandBuilder().setName("status").setDescription("Show MailSync status"),
      new SlashCommandBuilder().setName("delete-data").setDescription("Open the MailSync data deletion panel")
    ]);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "connect") {
        await interaction.reply({ ephemeral: true, content: `Open ${config.DASHBOARD_URL}` });
      }
      if (interaction.commandName === "status") {
        const user = await prisma.user.findUnique({ where: { discordId: interaction.user.id }, include: { accounts: true } });
        await interaction.reply({ ephemeral: true, content: user ? `${user.accounts.length} account(s) linked.` : "No account linked yet." });
      }
      if (interaction.commandName === "delete-data") {
        await interaction.reply({ ephemeral: true, content: `Open ${config.DASHBOARD_URL} and go to Settings to delete your MailSync data.` });
      }
    }

    if (interaction.isButton()) {
      const [action, logId] = interaction.customId.split(":");
      const log = await prisma.emailLog.findUnique({ where: { id: logId }, include: { account: { include: { user: true } } } });
      if (!log || log.account.user.discordId !== interaction.user.id) {
        await interaction.reply({ ephemeral: true, content: "This action is only available to the linked mailbox owner." });
        return;
      }

      if (action === "not-important") {
        await prisma.emailLog.update({ where: { id: log.id }, data: { userFeedback: "FALSE_POSITIVE" } });
        await interaction.reply({ ephemeral: true, content: "Feedback saved. You can revert it from the dashboard." });
      }

      if (action === "mute-domain" && log.senderDomain) {
        const existingRule = await prisma.senderRule.findFirst({
          where: { accountId: log.accountId, pattern: log.senderDomain, action: "NEVER_NOTIFY" }
        });
        if (existingRule) {
          await prisma.senderRule.update({
            where: { id: existingRule.id },
            data: { description: "Muted from Discord notification" }
          });
        } else {
          await prisma.senderRule.create({
            data: {
              accountId: log.accountId,
              pattern: log.senderDomain,
              action: "NEVER_NOTIFY",
              description: "Muted from Discord notification"
            }
          });
        }
        await interaction.reply({ ephemeral: true, content: `${log.senderDomain} muted. You can unmute it from the dashboard.` });
      }
    }
  });

  setInterval(async () => {
    const logs = await prisma.emailLog.findMany({
      where: { disposition: EmailDisposition.IMPORTANT, wasNotified: false },
      include: { account: { include: { user: true, preferences: true } } },
      orderBy: { processedAt: "asc" },
      take: 10
    });

    for (const log of logs) {
      try {
        const preference = log.account.preferences;
        const minLevel = preference?.dmMinLevel ?? EmailLevel.CRITICAL;
        if (preference?.dmEnabled === false || !meetsMinimumLevel(log.category, minLevel)) {
          await prisma.emailLog.update({
            where: { id: log.id },
            data: {
              wasNotified: true,
              feedbackNotes: preference?.dmEnabled === false ? "Discord DM skipped because delivery is disabled" : `Discord DM skipped below ${minLevel} severity`
            }
          });
          continue;
        }
        await sendPriorityDm(client, log.account.user.discordId, log);
        await prisma.emailLog.update({
          where: { id: log.id },
          data: { wasNotified: true, notificationSentAt: new Date(), notificationChannel: "DM" }
        });
      } catch (error) {
        console.error(error);
      }
    }
  }, config.DISCORD_DELIVERY_INTERVAL_MS);

  await client.login(config.DISCORD_BOT_TOKEN);
}
