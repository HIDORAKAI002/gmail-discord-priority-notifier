import { AccountStatus, EmailDisposition, ScoreConfidence } from "@prisma/client";
import {
  classifyLevel,
  decryptSecret,
  dispositionForEmail,
  encryptSecret,
  formatPriorityWhatsAppMessage,
  hashedEmailFields,
  loadConfig,
  prisma,
  sendOpenWaText
} from "@mailsync/shared";

const config = loadConfig();
const workerStartedAt = new Date();
const gmailBase = "https://gmail.googleapis.com/gmail/v1/users/me";

type GmailListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
};

type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    body?: { data?: string };
    headers?: Array<{ name: string; value: string }>;
    parts?: GmailMessage["payload"][];
  };
};

type GmailWatchResponse = {
  historyId?: string;
  expiration?: string;
};

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value.split(",")[0] ?? "").trim().replace(/^"|"$/g, "").slice(0, 255);
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function htmlToText(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function cleanBody(value: string) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 6000);
}

function levelRank(level: string) {
  return {
    LOW: 0,
    NORMAL: 1,
    IMPORTANT: 2,
    CRITICAL: 3
  }[level] ?? 0;
}

function meetsMinimumLevel(level: string, minimum: string) {
  return levelRank(level) >= levelRank(minimum);
}

function gmailPushConfigured() {
  return Boolean(config.GMAIL_PUSH_ENABLED && config.GMAIL_PUBSUB_TOPIC && config.GMAIL_PUBSUB_VERIFICATION_TOKEN);
}

function extractBody(payload: GmailMessage["payload"]): string {
  if (!payload) return "";
  const direct = payload.body?.data ? decodeBase64Url(payload.body.data) : "";
  if (direct && payload.mimeType === "text/plain") return cleanBody(direct);
  const childBodies = (payload.parts ?? []).map((part) => extractBody(part)).filter(Boolean);
  if (childBodies.length) return cleanBody(childBodies.join("\n\n"));
  if (direct && payload.mimeType === "text/html") return cleanBody(htmlToText(direct));
  return direct ? cleanBody(direct) : "";
}

function scoreEmail(input: { subject: string; snippet: string; body: string; labels: string[]; from: string }) {
  const text = `${input.subject} ${input.snippet}`.toLowerCase();
  const bodyText = input.body.toLowerCase();
  const sender = input.from.toLowerCase();
  const highSignalTerms = [
    "urgent",
    "asap",
    "deadline",
    "action required",
    "approve",
    "approval",
    "contract",
    "invoice",
    "payment",
    "credit",
    "selection",
    "selected",
    "shortlisted",
    "application",
    "admission",
    "ncc",
    "security",
    "production",
    "server",
    "outage",
    "failed payment",
    "legal",
    "signed",
    "wire transfer"
  ];
  const mediumSignalTerms = [
    "client",
    "proposal",
    "follow up",
    "meeting moved",
    "final reminder",
    "due today",
    "confirm by"
  ];
  const weakTerms = ["important", "review", "meeting", "update"];
  const replyTerms = [
    "please reply",
    "reply back",
    "respond",
    "confirm",
    "confirmation needed",
    "can you",
    "could you",
    "action required",
    "waiting for your response",
    "let me know",
    "approve",
    "approval"
  ];
  const otpTerms = ["otp", "one-time", "one time", "verification code", "security code", "login code", "2fa", "passcode", "authentication code"];
  const lowValueTerms = [
    "winner",
    "prize",
    "casino",
    "claim now",
    "limited offer",
    "unsubscribe",
    "free gift",
    "lottery",
    "act now",
    "newsletter",
    "webinar",
    "sale",
    "discount",
    "promo",
    "promotion",
    "coupon",
    "unsubscribe"
  ];
  const textAndBody = `${text} ${bodyText}`;
  const highHits = highSignalTerms.filter((term) => textAndBody.includes(term)).length;
  const mediumHits = mediumSignalTerms.filter((term) => textAndBody.includes(term)).length;
  const weakHits = weakTerms.filter((term) => text.includes(term)).length;
  const replyHits = replyTerms.filter((term) => textAndBody.includes(term)).length;
  const otpHits = otpTerms.filter((term) => textAndBody.includes(term)).length;
  const lowValueHits = lowValueTerms.filter((term) => textAndBody.includes(term) || sender.includes(term)).length;
  const automatedPenalty = /(noreply|no-reply|newsletter|marketing|promo|notification|updates?@|hello@)/i.test(input.from) ? 16 : 0;
  const gmailImportantBoost = input.labels.includes("IMPORTANT") && highHits + replyHits > 0 ? 10 : 0;
  const personalBoost = input.from && automatedPenalty === 0 ? 5 : 0;
  const ruleScore = Math.max(
    0,
    Math.min(100, 18 + highHits * 17 + mediumHits * 8 + weakHits * 3 + replyHits * 10 + otpHits * 16 + gmailImportantBoost + personalBoost - lowValueHits * 18 - automatedPenalty)
  );
  return { ruleScore, spamScore: lowValueHits * 32 + automatedPenalty, requiresResponse: replyHits > 0 && lowValueHits === 0, isOtp: otpHits > 0 };
}

function gmailTime(message: GmailMessage) {
  return message.internalDate ? new Date(Number(message.internalDate)) : new Date();
}

function matchesRule(pattern: string, input: { from: string; subject: string; snippet: string }) {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return false;
  const haystack = `${input.from} ${input.subject} ${input.snippet}`.toLowerCase();
  return haystack.includes(needle);
}

async function refreshAccessToken(account: { id: string; gmailRefreshToken: string }) {
  const refreshToken = decryptSecret(account.gmailRefreshToken, config.ENCRYPTION_KEY);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GMAIL_CLIENT_ID ?? "",
      client_secret: config.GMAIL_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  if (!response.ok) throw new Error(`Google refresh failed: ${response.status} ${await response.text()}`);
  const token = await response.json() as { access_token: string; expires_in?: number };
  await prisma.emailAccount.update({
    where: { id: account.id },
    data: {
      gmailAccessToken: encryptSecret(token.access_token, config.ENCRYPTION_KEY),
      tokenExpiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null
    }
  });
  return token.access_token;
}

async function accessTokenFor(account: { id: string; gmailAccessToken: string | null; gmailRefreshToken: string; tokenExpiresAt: Date | null }) {
  if (!account.gmailAccessToken || !account.tokenExpiresAt || account.tokenExpiresAt.getTime() < Date.now() + 120_000) {
    return refreshAccessToken(account);
  }
  return decryptSecret(account.gmailAccessToken, config.ENCRYPTION_KEY);
}

async function gmailGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${gmailBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail API failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function gmailGetResponse<T>(path: string, token: string): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const response = await fetch(`${gmailBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.ok) return { ok: true, data: await response.json() as T };
  return { ok: false, status: response.status, text: await response.text() };
}

async function gmailPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(`${gmailBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Gmail API failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function listCandidateMessages(token: string) {
  const params = new URLSearchParams({
    maxResults: String(config.GMAIL_MAX_MESSAGES_PER_SYNC),
    includeSpamTrash: "false"
  });
  params.append("labelIds", "INBOX");
  return gmailGet<GmailListResponse>(`/messages?${params.toString()}`, token);
}

async function listSentMessages(token: string) {
  const params = new URLSearchParams({
    maxResults: "20",
    includeSpamTrash: "false"
  });
  params.append("labelIds", "SENT");
  return gmailGet<GmailListResponse>(`/messages?${params.toString()}`, token);
}

async function fetchMessage(token: string, id: string) {
  const fullParams = new URLSearchParams({ format: "full" });
  const full = await gmailGetResponse<GmailMessage>(`/messages/${encodeURIComponent(id)}?${fullParams.toString()}`, token);
  if (full.ok) return { message: full.data, bodyAvailable: true };

  if (full.status !== 403 || !/Metadata scope doesn't allow format FULL/i.test(full.text)) {
    throw new Error(`Gmail API failed: ${full.status} ${full.text}`);
  }

  const metadataParams = new URLSearchParams({ format: "metadata" });
  for (const item of ["From", "To", "Cc", "Subject", "Date"]) metadataParams.append("metadataHeaders", item);
  const metadata = await gmailGet<GmailMessage>(`/messages/${encodeURIComponent(id)}?${metadataParams.toString()}`, token);
  return { message: metadata, bodyAvailable: false };
}

async function ensureGmailWatch(account: {
  id: string;
  emailAddress: string;
  gmailAccessToken: string | null;
  gmailRefreshToken: string;
  tokenExpiresAt: Date | null;
  watchExpiresAt: Date | null;
}) {
  if (!gmailPushConfigured()) return;
  const renewBefore = new Date(Date.now() + config.GMAIL_WATCH_RENEWAL_HOURS * 60 * 60 * 1000);
  if (account.watchExpiresAt && account.watchExpiresAt > renewBefore) return;
  const token = await accessTokenFor(account);
  const watch = await gmailPost<GmailWatchResponse>("/watch", token, {
    topicName: config.GMAIL_PUBSUB_TOPIC,
    labelIds: ["INBOX"],
    labelFilterBehavior: "INCLUDE"
  });
  await prisma.emailAccount.update({
    where: { id: account.id },
    data: {
      historyId: watch.historyId ?? null,
      watchExpiresAt: watch.expiration ? new Date(Number(watch.expiration)) : null,
      lastError: null,
      errorCount: 0,
      status: AccountStatus.ACTIVE
    }
  });
  console.log(`Gmail push watch renewed for ${account.emailAddress}`);
}

async function resolveRepliedThreads(accountId: string, token: string) {
  const sent = await listSentMessages(token);
  for (const item of sent.messages ?? []) {
    const { message: sentMessage } = await fetchMessage(token, item.id);
    const threadId = sentMessage.threadId;
    if (!threadId) continue;
    const sentAt = gmailTime(sentMessage);
    await prisma.emailLog.updateMany({
      where: {
        accountId,
        gmailThreadId: threadId,
        requiresResponse: true,
        processedAt: { lt: sentAt }
      },
      data: {
        requiresResponse: false,
        userFeedback: "CORRECT",
        feedbackNotes: "Reply detected from Sent mail"
      }
    });
  }
}

async function syncAccount(account: {
  id: string;
  emailAddress: string;
  gmailAccessToken: string | null;
  gmailRefreshToken: string;
  tokenExpiresAt: Date | null;
  lastSyncAt: Date | null;
  watchExpiresAt?: Date | null;
  thresholds: { importantThreshold: number; criticalThreshold: number } | null;
  rules: Array<{ pattern: string; action: "ALWAYS_NOTIFY" | "NEVER_NOTIFY" | "MARK_SPAM" | "BOOST" }>;
}) {
  const token = await accessTokenFor(account);
  await resolveRepliedThreads(account.id, token);
  const list = await listCandidateMessages(token);
  const messages = list.messages ?? [];
  let created = 0;
  const baseline = account.lastSyncAt ? new Date(account.lastSyncAt.getTime() - config.GMAIL_SYNC_LOOKBACK_MS) : new Date();

  if (!account.lastSyncAt) {
    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: baseline, lastError: null, errorCount: 0, status: AccountStatus.ACTIVE }
    });
    console.log(`worker baseline set for ${account.emailAddress}; existing inbox skipped`);
    return 0;
  }

  for (const item of messages.reverse()) {
    const exists = await prisma.emailLog.findUnique({
      where: { accountId_gmailMessageId: { accountId: account.id, gmailMessageId: item.id } },
      select: { id: true }
    });
    if (exists) continue;

    const { message, bodyAvailable } = await fetchMessage(token, item.id);
    const receivedAt = gmailTime(message);
    if (receivedAt <= baseline) continue;

    const from = parseAddress(header(message, "From"));
    const to = parseAddress(header(message, "To")) || account.emailAddress;
    const subject = header(message, "Subject") || "(No subject)";
    const snippet = message.snippet ?? "";
    const body = extractBody(message.payload);
    const score = scoreEmail({ subject, snippet, body, labels: message.labelIds ?? [], from });
    const matchedRules = account.rules.filter((rule) => matchesRule(rule.pattern, { from, subject, snippet }));
    const muted = matchedRules.some((rule) => rule.action === "NEVER_NOTIFY" || rule.action === "MARK_SPAM");
    const boosted = matchedRules.some((rule) => rule.action === "ALWAYS_NOTIFY" || rule.action === "BOOST");
    const finalScore = score.isOtp ? 100 : muted ? Math.min(score.ruleScore, 10) : boosted ? Math.max(score.ruleScore, 92) : score.ruleScore;
    const spamScore = muted ? 90 : score.spamScore;
    const category = score.isOtp ? "CRITICAL" : classifyLevel(
      finalScore,
      account.thresholds?.importantThreshold ?? config.DEFAULT_IMPORTANT_THRESHOLD,
      account.thresholds?.criticalThreshold ?? config.DEFAULT_CRITICAL_THRESHOLD
    );
    const disposition = score.isOtp ? EmailDisposition.IMPORTANT : dispositionForEmail(category, spamScore);

    await prisma.emailLog.create({
      data: {
        accountId: account.id,
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        ...hashedEmailFields({ messageId: message.id, threadId: message.threadId, from, subject, snippet }),
        senderAddress: from || null,
        recipientAddress: to || account.emailAddress,
        bodyPreview: body || null,
        ruleScore: finalScore,
        ensembleScore: finalScore,
        confidence: ScoreConfidence.HIGH,
        category,
        disposition,
        requiresResponse: score.requiresResponse,
        wasNotified: muted,
        feedbackNotes: bodyAvailable ? null : "Gmail token has metadata scope only; reconnect Gmail to enable full email body in alerts",
        processedAt: receivedAt
      }
    });
    created += 1;
  }

  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { lastSyncAt: new Date(), lastError: null, errorCount: 0, status: AccountStatus.ACTIVE }
  });
  return created;
}

async function tick() {
  const accounts = await prisma.emailAccount.findMany({
    where: { status: { in: [AccountStatus.ACTIVE, AccountStatus.ERROR] } },
    include: { thresholds: true, rules: true }
  });
  let created = 0;

  for (const account of accounts) {
    try {
      await ensureGmailWatch(account);
      created += await syncAccount(account);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Gmail sync error";
      console.error(`Gmail sync failed for ${account.emailAddress}: ${message}`);
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { status: AccountStatus.ERROR, lastError: message.slice(0, 2000), errorCount: { increment: 1 } }
      });
    }
  }

  const whatsappSent = await sendWhatsappNotifications();
  console.log(`worker tick: ${accounts.length} account(s), ${created} new email(s), ${whatsappSent} WhatsApp alert(s)`);
}

let pushSyncRunning = false;

async function processRequestedSyncs() {
  if (pushSyncRunning) return;
  pushSyncRunning = true;
  try {
    const accounts = await prisma.emailAccount.findMany({
      where: {
        status: { in: [AccountStatus.ACTIVE, AccountStatus.ERROR] },
        syncRequestedAt: { not: null }
      },
      include: { thresholds: true, rules: true },
      orderBy: { syncRequestedAt: "asc" },
      take: 10
    });
    let created = 0;
    for (const account of accounts) {
      try {
        await ensureGmailWatch(account);
        created += await syncAccount(account);
        await prisma.emailAccount.update({
          where: { id: account.id },
          data: { syncRequestedAt: null, syncRequestedReason: null }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown Gmail push sync error";
        console.error(`Gmail push sync failed for ${account.emailAddress}: ${message}`);
        await prisma.emailAccount.update({
          where: { id: account.id },
          data: { status: AccountStatus.ERROR, lastError: message.slice(0, 2000), errorCount: { increment: 1 }, syncRequestedAt: null, syncRequestedReason: null }
        });
      }
    }
    if (accounts.length) {
      const whatsappSent = await sendWhatsappNotifications();
      console.log(`worker push sync: ${accounts.length} account(s), ${created} new email(s), ${whatsappSent} WhatsApp alert(s)`);
    }
  } finally {
    pushSyncRunning = false;
  }
}

function userOpenWaConfig(user: {
  whatsappAgentEnabled: boolean;
  openWaBaseUrl: string | null;
  openWaApiKey: string | null;
  openWaSessionId: string | null;
}) {
  const ownKey = user.openWaApiKey ? decryptSecret(user.openWaApiKey, config.ENCRYPTION_KEY) : null;
  const useOwn = Boolean(user.whatsappAgentEnabled && user.openWaBaseUrl && ownKey);
  return {
    enabled: useOwn || config.WHATSAPP_NOTIFICATIONS_ENABLED,
    baseUrl: useOwn ? user.openWaBaseUrl : config.OPENWA_BASE_URL,
    apiKey: useOwn ? ownKey : config.OPENWA_API_KEY,
    sessionId: useOwn ? user.openWaSessionId || "default" : config.OPENWA_SESSION_ID
  };
}

async function sendWhatsappNotifications() {
  const logs = await prisma.emailLog.findMany({
    where: {
      disposition: EmailDisposition.IMPORTANT,
      whatsappNotifiedAt: null,
      processedAt: { gte: workerStartedAt },
      account: {
        user: {
          whatsappEnabled: true,
          whatsappNumber: { not: null }
        }
      }
    },
    include: { account: { include: { user: true, preferences: true } } },
    orderBy: { processedAt: "asc" },
    take: 10
  });
  let sent = 0;

  for (const log of logs) {
    const number = log.account.user.whatsappNumber;
    if (!number) continue;
    const minLevel = log.account.preferences?.dmMinLevel ?? "CRITICAL";
    if (!meetsMinimumLevel(log.category, minLevel)) {
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { whatsappNotifiedAt: new Date(), whatsappError: `WhatsApp skipped below ${minLevel} severity` }
      });
      continue;
    }
    try {
      await sendOpenWaText(userOpenWaConfig(log.account.user), number, formatPriorityWhatsAppMessage(log));
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { whatsappNotifiedAt: new Date(), whatsappError: null }
      });
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OpenWA delivery error";
      console.error(`WhatsApp send failed for ${log.id}: ${message}`);
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { whatsappError: message.slice(0, 2000) }
      });
    }
  }

  return sent;
}

tick().catch(console.error);
processRequestedSyncs().catch(console.error);
setInterval(() => processRequestedSyncs().catch(console.error), config.GMAIL_PUSH_SYNC_INTERVAL_MS);
setInterval(() => tick().catch(console.error), config.POLLING_INTERVAL_MS);
