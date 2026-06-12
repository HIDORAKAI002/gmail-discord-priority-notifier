import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import morgan from "morgan";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailDisposition, EmailLevel, OtpPurpose, RuleAction, ScoreConfidence } from "@prisma/client";
import {
  decryptSecret,
  encryptSecret,
  formatPriorityWhatsAppMessage,
  hashOtp,
  loadConfig,
  normalizeWhatsAppNumber,
  prisma,
  randomCode,
  sendOpenWaText,
  sha256,
  timingSafeEqualString
} from "@mailsync/shared";

const config = loadConfig();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDistCandidates = [
  path.resolve(process.cwd(), "apps/dashboard/dist"),
  path.resolve(process.cwd(), "../dashboard/dist"),
  path.resolve(__dirname, "../../../../../dashboard/dist"),
  path.resolve(__dirname, "../../../../dashboard/dist")
];
const dashboardDist = dashboardDistCandidates.find((candidate) => {
  try {
    return path.isAbsolute(candidate) && existsSync(path.join(candidate, "index.html"));
  } catch {
    return false;
  }
}) ?? dashboardDistCandidates[0];

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.CORS_ORIGIN.split(","), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

type SessionPayload = { sub: string; discordId: string; type: "session" };

function signSession(user: { id: string; discordId: string }) {
  return jwt.sign({ sub: user.id, discordId: user.discordId, type: "session" }, config.AUTH_SECRET, {
    expiresIn: `${config.SESSION_TTL_HOURS}h`
  });
}

function signState(payload: Record<string, unknown>) {
  return jwt.sign(payload, config.AUTH_SECRET, { expiresIn: "1h" });
}

function optionalSessionUserId(req: express.Request) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.AUTH_SECRET) as SessionPayload;
    return payload.sub;
  } catch {
    return null;
  }
}

function authUrl(base: string, params: Record<string, string | undefined>) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => value && url.searchParams.set(key, value));
  return url.toString();
}

function gmailUrl(log: { gmailThreadId: string | null; gmailMessageId: string }) {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(log.gmailThreadId ?? log.gmailMessageId)}`;
}

function segmentForEmail(row: { disposition: EmailDisposition; subjectPreview: string | null; snippetPreview: string | null; senderDomain: string | null; requiresResponse?: boolean }) {
  const text = `${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""} ${row.senderDomain ?? ""}`.toLowerCase();
  if (isOtpText(text)) return "OTPs";
  if (row.requiresResponse || isReplyText(text)) return "Needs reply";
  if (row.disposition === "SPAM") return "Spam";
  if (/(unsubscribe|sale|offer|deal|promo|marketing|newsletter)/.test(text)) return "Promotions";
  if (/(update|receipt|invoice|statement|alert|notification|security)/.test(text)) return "Updates";
  if (/(linkedin|facebook|instagram|twitter|x.com|social|community)/.test(text)) return "Social";
  if (/(forum|thread|reply|discussion|reddit|stack)/.test(text)) return "Forums";
  return row.disposition === "USED" ? "Good" : "Not good";
}

function locationForDomain(domain: string | null | undefined) {
  if (!domain) return { country: "Unknown", code: "UN", location: "Not trackable", count: 0 };
  const tld = domain.split(".").pop()?.toLowerCase();
  const map: Record<string, { country: string; code: string }> = {
    in: { country: "India", code: "IN" },
    us: { country: "United States of America", code: "US" },
    uk: { country: "United Kingdom", code: "GB" },
    ca: { country: "Canada", code: "CA" },
    au: { country: "Australia", code: "AU" },
    de: { country: "Germany", code: "DE" },
    fr: { country: "France", code: "FR" },
    sg: { country: "Singapore", code: "SG" },
    ae: { country: "United Arab Emirates", code: "AE" },
    jp: { country: "Japan", code: "JP" },
    br: { country: "Brazil", code: "BR" },
    cn: { country: "China", code: "CN" },
    ru: { country: "Russia", code: "RU" },
    za: { country: "South Africa", code: "ZA" }
  };
  const resolved = tld ? map[tld] : undefined;
  return { country: resolved?.country ?? "Unknown", code: resolved?.code ?? "UN", location: domain, count: 0 };
}

function isOtpText(text: string) {
  return /(otp|one[- ]?time|verification code|security code|login code|2fa|two[- ]factor|auth code)/i.test(text);
}

function isReplyText(text: string) {
  return /(please reply|reply back|respond|confirm|confirmation needed|can you|could you|action required|waiting for your response|let me know|approve|approval)/i.test(text);
}

function emailKind(row: { disposition: EmailDisposition; subjectPreview: string | null; snippetPreview: string | null; requiresResponse?: boolean }) {
  const text = `${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""}`;
  if (isOtpText(text)) return "OTP";
  if (row.requiresResponse || isReplyText(text)) return "Reply";
  if (row.disposition === "IMPORTANT") return "Priority";
  if (row.disposition === "SPAM") return "Spam";
  if (row.disposition === "LOW_VALUE") return "Low value";
  return "Useful";
}

function toLogDto(row: {
  id: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  senderAddress: string | null;
  recipientAddress: string | null;
  senderDomain: string | null;
  subjectPreview: string | null;
  snippetPreview: string | null;
  bodyPreview?: string | null;
  disposition: EmailDisposition;
  category: EmailLevel;
  ensembleScore: number;
  wasNotified: boolean;
  userFeedback: string | null;
  requiresResponse: boolean;
  processedAt: Date;
  account: { emailAddress: string };
}) {
  const text = `${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""}`;
  return {
    id: row.id,
    gmailMessageId: row.gmailMessageId,
    gmailThreadId: row.gmailThreadId,
    senderAddress: row.senderAddress,
    recipientAddress: row.recipientAddress,
    senderDomain: row.senderDomain,
    subjectPreview: row.subjectPreview,
    snippetPreview: row.snippetPreview,
    bodyPreview: row.bodyPreview ?? null,
    disposition: row.disposition,
    category: row.category,
    kind: emailKind(row),
    ensembleScore: row.ensembleScore,
    wasNotified: row.wasNotified,
    userFeedback: row.userFeedback,
    requiresResponse: row.requiresResponse,
    isOtp: isOtpText(text),
    processedAt: row.processedAt,
    gmailUrl: gmailUrl(row),
    accountEmail: row.account.emailAddress,
    location: locationForDomain(row.senderDomain)
  };
}

async function requireUser(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Missing token" });
    const payload = jwt.verify(token, config.AUTH_SECRET) as SessionPayload;
    const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) } });
    if (!session || session.expiresAt <= new Date()) return res.status(401).json({ error: "Expired session" });
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: "User not found" });
    res.locals.user = user;
    res.locals.token = token;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

async function sendDiscordOtp(discordId: string, code: string, email: string) {
  if (!config.DISCORD_BOT_TOKEN) throw new Error("Discord bot token is not configured");
  const channelResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: discordId })
  });
  if (!channelResponse.ok) throw new Error(`Discord DM channel failed: ${channelResponse.status}`);
  const channel = await channelResponse.json() as { id: string };
  const messageResponse = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `Your MailSync OTP for ${email}: **${code}**\nExpires in 10 minutes.` })
  });
  if (!messageResponse.ok) throw new Error(`Discord OTP send failed: ${messageResponse.status}`);
}

function userOpenWaConfig(user: { whatsappAgentEnabled?: boolean; openWaBaseUrl?: string | null; openWaApiKey?: string | null; openWaSessionId?: string | null }) {
  const ownKey = user.openWaApiKey ? decryptSecret(user.openWaApiKey, config.ENCRYPTION_KEY) : null;
  return {
    enabled: Boolean(user.whatsappAgentEnabled && user.openWaBaseUrl && ownKey) || config.WHATSAPP_NOTIFICATIONS_ENABLED,
    baseUrl: user.whatsappAgentEnabled && user.openWaBaseUrl && ownKey ? user.openWaBaseUrl : config.OPENWA_BASE_URL,
    apiKey: user.whatsappAgentEnabled && user.openWaBaseUrl && ownKey ? ownKey : config.OPENWA_API_KEY,
    sessionId: user.whatsappAgentEnabled && user.openWaBaseUrl && ownKey ? user.openWaSessionId || "default" : config.OPENWA_SESSION_ID
  };
}

function decodePubSubData(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { emailAddress?: unknown; historyId?: unknown };
  return {
    emailAddress: typeof payload.emailAddress === "string" ? payload.emailAddress : undefined,
    historyId: payload.historyId == null ? undefined : String(payload.historyId)
  };
}

function gmailPushConfigured() {
  return Boolean(config.GMAIL_PUSH_ENABLED && config.GMAIL_PUBSUB_TOPIC && config.GMAIL_PUBSUB_VERIFICATION_TOKEN);
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "mailsync" }));
app.get("/health/ready", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, database: "mysql" });
});

app.post("/api/auth/discord", (req, res) => {
  const linkUserId = optionalSessionUserId(req);
  const state = signState({ purpose: "discord", nonce: crypto.randomUUID(), linkUserId });
  res.json({
    auth_url: authUrl("https://discord.com/oauth2/authorize", {
      client_id: config.DISCORD_CLIENT_ID,
      redirect_uri: config.DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: "identify email",
      prompt: "consent",
      state
    })
  });
});

app.get("/api/auth/discord/callback", async (req, res, next) => {
  try {
    const state = jwt.verify(String(req.query.state ?? ""), config.AUTH_SECRET) as { purpose: string; linkUserId?: string | null };
    if (state.purpose !== "discord") throw new Error("Invalid Discord state");
    const code = String(req.query.code ?? "");
    const body = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID ?? "",
      client_secret: config.DISCORD_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: config.DISCORD_REDIRECT_URI ?? ""
    });
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!tokenResponse.ok) throw new Error(`Discord token exchange failed: ${tokenResponse.status}`);
    const tokenJson = await tokenResponse.json() as { access_token: string };
    const profileResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });
    if (!profileResponse.ok) throw new Error(`Discord profile fetch failed: ${profileResponse.status}`);
    const profile = await profileResponse.json() as { id: string; username: string; global_name?: string; avatar?: string; email?: string };
    const existingDiscordUser = await prisma.user.findUnique({ where: { discordId: profile.id } });
    const user = state.linkUserId && !existingDiscordUser
      ? await prisma.user.update({
        where: { id: state.linkUserId },
        data: { discordId: profile.id, discordUsername: profile.global_name ?? profile.username, discordEmail: profile.email }
      })
      : await prisma.user.upsert({
        where: { discordId: profile.id },
        create: { discordId: profile.id, discordUsername: profile.global_name ?? profile.username, discordEmail: profile.email },
        update: { discordUsername: profile.global_name ?? profile.username, discordEmail: profile.email }
      });
    const sessionToken = signSession(user);
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(sessionToken),
        expiresAt: new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000)
      }
    });
    res.redirect(`${config.DASHBOARD_URL}/auth/callback?token=${encodeURIComponent(sessionToken)}`);
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/whatsapp/init", async (req, res, next) => {
  try {
    const normalized = normalizeWhatsAppNumber(String(req.body.number ?? ""));
    if (!normalized) return res.status(400).json({ error: "Enter a valid WhatsApp number with country code" });
    const code = randomCode();
    const user = await prisma.user.upsert({
      where: { discordId: `whatsapp:${normalized.slice(1)}` },
      create: {
        discordId: `whatsapp:${normalized.slice(1)}`,
        discordUsername: `WhatsApp ${normalized}`,
        whatsappNumber: normalized,
        whatsappEnabled: true
      },
      update: { whatsappNumber: normalized, whatsappEnabled: true }
    });
    await prisma.otpLog.create({
      data: {
        userId: user.id,
        emailAddress: normalized,
        purpose: OtpPurpose.SETTINGS_CHANGE,
        expiresAt: new Date(Date.now() + config.OTP_TTL_MINUTES * 60 * 1000),
        otpHash: hashOtp(code, config.OTP_PEPPER),
        payloadJson: { login: "whatsapp", number: normalized }
      }
    });
    await sendOpenWaText(userOpenWaConfig(user), normalized, `Your MailSync login code is ${code}. It expires in ${config.OTP_TTL_MINUTES} minutes.`);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/whatsapp/verify", async (req, res) => {
  const normalized = normalizeWhatsAppNumber(String(req.body.number ?? ""));
  if (!normalized) return res.status(400).json({ error: "Enter a valid WhatsApp number with country code" });
  const user = await prisma.user.findUnique({ where: { discordId: `whatsapp:${normalized.slice(1)}` } });
  if (!user) return res.status(400).json({ error: "No active WhatsApp login code" });
  const otp = await prisma.otpLog.findFirst({
    where: { userId: user.id, purpose: OtpPurpose.SETTINGS_CHANGE, verified: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" }
  });
  if (!otp) return res.status(400).json({ error: "No active WhatsApp login code" });
  const ok = timingSafeEqualString(hashOtp(String(req.body.otp ?? ""), config.OTP_PEPPER), otp.otpHash);
  await prisma.otpLog.update({ where: { id: otp.id }, data: { verified: ok, verifiedAt: ok ? new Date() : undefined, attemptCount: { increment: 1 } } });
  if (!ok) return res.status(400).json({ error: "Invalid OTP" });
  const sessionToken = signSession(user);
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: sha256(sessionToken),
      expiresAt: new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000)
    }
  });
  res.json({ token: sessionToken });
});

app.post("/api/auth/gmail/init", requireUser, (_req, res) => {
  const user = res.locals.user as { id: string };
  const state = signState({ purpose: "gmail", userId: user.id, nonce: crypto.randomUUID() });
  res.json({
    auth_url: authUrl("https://accounts.google.com/o/oauth2/v2/auth", {
      client_id: config.GMAIL_CLIENT_ID,
      redirect_uri: config.GMAIL_REDIRECT_URI,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.metadata",
      access_type: "offline",
      prompt: "consent",
      state
    })
  });
});

app.get("/api/auth/gmail/callback", async (req, res, next) => {
  try {
    const state = jwt.verify(String(req.query.state ?? ""), config.AUTH_SECRET) as { userId: string; purpose: string };
    if (state.purpose !== "gmail") throw new Error("Invalid Gmail state");
    const body = new URLSearchParams({
      client_id: config.GMAIL_CLIENT_ID ?? "",
      client_secret: config.GMAIL_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code: String(req.query.code ?? ""),
      redirect_uri: config.GMAIL_REDIRECT_URI ?? ""
    });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!tokenResponse.ok) throw new Error(`Google token exchange failed: ${tokenResponse.status}`);
    const tokenJson = await tokenResponse.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });
    const profile = await profileResponse.json() as { id: string; email: string };
    if (!tokenJson.refresh_token) throw new Error("Google did not return refresh token. Retry consent.");
    const code = randomCode();
    await prisma.otpLog.create({
      data: {
        userId: state.userId,
        emailAddress: profile.email,
        purpose: OtpPurpose.CONNECT_GMAIL,
        expiresAt: new Date(Date.now() + config.OTP_TTL_MINUTES * 60 * 1000),
        otpHash: hashOtp(code, config.OTP_PEPPER),
        payloadJson: {
          email: profile.email,
          googleUserId: profile.id,
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token,
          expiresIn: tokenJson.expires_in
        }
      }
    });
    const user = await prisma.user.findUnique({ where: { id: state.userId } });
    let otpDelivery = "dashboard";
    if (user && config.OTP_DELIVERY_MODE === "discord") {
      try {
        await sendDiscordOtp(user.discordId, code, profile.email);
        otpDelivery = "discord";
      } catch (error) {
        console.error(error);
        otpDelivery = "dashboard";
      }
    }
    const otpHint = otpDelivery === "dashboard" ? `&otp_hint=${encodeURIComponent(code)}` : "";
    res.redirect(`${config.DASHBOARD_URL}/auth/gmail-callback?email=${encodeURIComponent(profile.email)}&otp_delivery=${otpDelivery}${otpHint}`);
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/verify-otp", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const otp = await prisma.otpLog.findFirst({
    where: { userId: user.id, purpose: OtpPurpose.CONNECT_GMAIL, verified: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" }
  });
  if (!otp) return res.status(400).json({ error: "No active OTP" });
  const ok = timingSafeEqualString(hashOtp(String(req.body.otp ?? ""), config.OTP_PEPPER), otp.otpHash);
  await prisma.otpLog.update({ where: { id: otp.id }, data: { verified: ok, verifiedAt: ok ? new Date() : undefined, attemptCount: { increment: 1 } } });
  if (!ok) return res.status(400).json({ error: "Invalid OTP" });
  const payload = otp.payloadJson as { email: string; googleUserId: string; accessToken: string; refreshToken: string; expiresIn?: number };
  const account = await prisma.emailAccount.upsert({
    where: { userId_emailAddress: { userId: user.id, emailAddress: payload.email } },
    create: {
      userId: user.id,
      emailAddress: payload.email,
      googleUserId: payload.googleUserId,
      gmailAccessToken: encryptSecret(payload.accessToken, config.ENCRYPTION_KEY),
      gmailRefreshToken: encryptSecret(payload.refreshToken, config.ENCRYPTION_KEY),
      tokenExpiresAt: payload.expiresIn ? new Date(Date.now() + payload.expiresIn * 1000) : null,
      preferences: { create: { dmMinLevel: EmailLevel.CRITICAL } },
      thresholds: { create: {} }
    },
    update: { status: "ACTIVE" }
  });
  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { syncRequestedAt: new Date(), syncRequestedReason: "gmail-connected" }
  });
  res.json({ success: true, account });
});

app.post("/api/webhooks/gmail", async (req, res, next) => {
  try {
    if (!gmailPushConfigured()) return res.status(202).json({ ok: true, push_enabled: false });
    const expectedToken = config.GMAIL_PUBSUB_VERIFICATION_TOKEN as string;
    const token = String(req.query.token ?? req.header("x-mailsync-webhook-token") ?? "");
    if (!timingSafeEqualString(sha256(token), sha256(expectedToken))) return res.status(401).json({ error: "Invalid webhook token" });
    const dataValue = req.body?.message?.data;
    if (typeof dataValue !== "string") {
      console.warn("Gmail Pub/Sub webhook ignored: missing message.data");
      return res.status(204).end();
    }
    let payload: { emailAddress?: string; historyId?: string };
    try {
      payload = decodePubSubData(dataValue);
    } catch (error) {
      console.warn(`Gmail Pub/Sub webhook ignored: invalid message.data (${error instanceof Error ? error.message : "unknown parse error"})`);
      return res.status(204).end();
    }
    if (!payload.emailAddress) {
      console.warn("Gmail Pub/Sub webhook ignored: missing emailAddress");
      return res.status(204).end();
    }
    const account = await prisma.emailAccount.findFirst({
      where: { emailAddress: payload.emailAddress, status: { in: ["ACTIVE", "ERROR"] } },
      select: { id: true }
    });
    if (account) {
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: {
          lastPushHistoryId: payload.historyId ?? null,
          syncRequestedAt: new Date(),
          syncRequestedReason: "gmail-pubsub"
        }
      });
    }
    res.status(204).end();
  } catch (error) {
    console.error(`Gmail Pub/Sub webhook failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    res.status(204).end();
  }
});

app.post("/api/auth/dev/session", async (_req, res) => {
  if (config.NODE_ENV === "production") return res.status(404).json({ error: "Not found" });
  const user = await prisma.user.upsert({
    where: { discordId: "dev-discord-user" },
    create: { discordId: "dev-discord-user", discordUsername: "Dev User" },
    update: {}
  });
  const token = signSession(user);
  await prisma.session.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000) } });
  res.json({ token });
});

app.delete("/api/me", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const accounts = await prisma.emailAccount.findMany({ where: { userId: user.id }, select: { id: true } });
  const accountIds = accounts.map((account) => account.id);
  await prisma.$transaction([
    prisma.emailLog.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.senderRule.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.notificationPreference.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.aiThreshold.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.emailAccount.deleteMany({ where: { id: { in: accountIds } } }),
    prisma.otpLog.deleteMany({ where: { userId: user.id } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
    prisma.auditLog.deleteMany({ where: { userId: user.id } }),
    prisma.user.delete({ where: { id: user.id } })
  ]);
  res.json({ ok: true });
});

app.get("/api/whatsapp", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { whatsappNumber: true, whatsappEnabled: true, whatsappAgentEnabled: true, openWaBaseUrl: true, openWaApiKey: true, openWaSessionId: true }
  });
  const ownConfigured = Boolean(profile?.whatsappAgentEnabled && profile.openWaBaseUrl && profile.openWaApiKey);
  const globalConfigured = Boolean(config.OPENWA_BASE_URL && config.OPENWA_API_KEY && config.WHATSAPP_NOTIFICATIONS_ENABLED);
  res.json({
    configured: ownConfigured || globalConfigured,
    globalConfigured,
    ownConfigured,
    hasOwnApiKey: Boolean(profile?.openWaApiKey),
    baseUrl: profile?.openWaBaseUrl ?? "",
    sessionId: profile?.openWaSessionId ?? config.OPENWA_SESSION_ID,
    agentEnabled: profile?.whatsappAgentEnabled ?? false,
    number: profile?.whatsappNumber ?? "",
    enabled: profile?.whatsappEnabled ?? false
  });
});

app.put("/api/whatsapp", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const enabled = Boolean(req.body.enabled);
  const numberInput = String(req.body.number ?? "");
  const normalized = normalizeWhatsAppNumber(numberInput);
  if (enabled && !normalized) return res.status(400).json({ error: "Enter a valid WhatsApp number with country code" });
  const baseUrl = String(req.body.baseUrl ?? "").trim().replace(/\/+$/, "").slice(0, 512);
  const sessionId = String(req.body.sessionId ?? "default").trim().slice(0, 120) || "default";
  const apiKeyInput = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
  const agentEnabled = Boolean(req.body.agentEnabled);
  if (agentEnabled && !baseUrl) return res.status(400).json({ error: "OpenWA base URL is required for a custom WhatsApp agent" });
  const profile = await prisma.user.update({
    where: { id: user.id },
    data: {
      whatsappNumber: normalized,
      whatsappEnabled: enabled && Boolean(normalized),
      whatsappAgentEnabled: agentEnabled,
      openWaBaseUrl: baseUrl || null,
      openWaSessionId: sessionId,
      ...(apiKeyInput ? { openWaApiKey: encryptSecret(apiKeyInput, config.ENCRYPTION_KEY) } : {})
    },
    select: { whatsappNumber: true, whatsappEnabled: true, whatsappAgentEnabled: true, openWaBaseUrl: true, openWaApiKey: true, openWaSessionId: true }
  });
  res.json({
    number: profile.whatsappNumber ?? "",
    enabled: profile.whatsappEnabled,
    agentEnabled: profile.whatsappAgentEnabled,
    baseUrl: profile.openWaBaseUrl ?? "",
    sessionId: profile.openWaSessionId ?? "default",
    hasOwnApiKey: Boolean(profile.openWaApiKey)
  });
});

app.post("/api/whatsapp/test", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { whatsappNumber: true, whatsappEnabled: true, whatsappAgentEnabled: true, openWaBaseUrl: true, openWaApiKey: true, openWaSessionId: true }
  });
  if (!profile?.whatsappNumber || !profile.whatsappEnabled) return res.status(400).json({ error: "WhatsApp delivery is not enabled for this account" });
  await sendOpenWaText(
    userOpenWaConfig(profile),
    profile.whatsappNumber,
    formatPriorityWhatsAppMessage({
      subjectPreview: "MailSync WhatsApp test",
      senderAddress: "test@mailsync.local",
      senderDomain: "mailsync.local",
      recipientAddress: profile.whatsappNumber,
      snippetPreview: "Your WhatsApp connector is ready for high-priority email alerts.",
      processedAt: new Date(),
      account: { emailAddress: "dashboard@mailsync.local" }
    })
  );
  res.json({ ok: true });
});

app.get("/api/accounts", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: user.id, status: { not: "REVOKED" } },
    include: { preferences: true, thresholds: true, _count: { select: { logs: true } } }
  });
  res.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.emailAddress,
      status: a.status,
      connectedAt: a.connectedAt,
      lastSyncAt: a.lastSyncAt,
      watchExpiresAt: a.watchExpiresAt,
      syncRequestedAt: a.syncRequestedAt,
      pushEnabled: config.GMAIL_PUSH_ENABLED,
      pushConfigured: gmailPushConfigured(),
      preferences: {
        dmEnabled: a.preferences?.dmEnabled ?? true,
        dmMinLevel: a.preferences?.dmMinLevel ?? EmailLevel.CRITICAL
      },
      stats: { emails_processed: a._count.logs }
    }))
  });
});

app.put("/api/accounts/:id/preferences", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const account = await prisma.emailAccount.findFirst({ where: { id: req.params.id, userId: user.id }, include: { preferences: true } });
  if (!account) return res.status(404).json({ error: "Account not found" });
  const requestedDmMinLevel = String(req.body.dmMinLevel ?? account.preferences?.dmMinLevel ?? EmailLevel.CRITICAL);
  const dmEnabled = typeof req.body.dmEnabled === "boolean" ? req.body.dmEnabled : account.preferences?.dmEnabled ?? true;
  if (!["CRITICAL", "IMPORTANT", "NORMAL"].includes(requestedDmMinLevel)) return res.status(400).json({ error: "Invalid DM severity" });
  const dmMinLevel = requestedDmMinLevel as EmailLevel;
  const preferences = await prisma.notificationPreference.upsert({
    where: { accountId: account.id },
    create: { accountId: account.id, dmEnabled, dmMinLevel },
    update: { dmEnabled, dmMinLevel }
  });
  res.json({ preferences });
});

app.get("/api/rules", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const rules = await prisma.senderRule.findMany({
    where: { account: { userId: user.id } },
    include: { account: { select: { emailAddress: true } } },
    orderBy: { createdAt: "desc" }
  });
  res.json({
    rules: rules.map((rule) => ({
      id: rule.id,
      accountId: rule.accountId,
      accountEmail: rule.account.emailAddress,
      pattern: rule.pattern,
      action: rule.action,
      description: rule.description,
      createdAt: rule.createdAt
    }))
  });
});

app.post("/api/rules", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const pattern = String(req.body.pattern ?? "").trim().slice(0, 255);
  const accountId = String(req.body.accountId ?? "");
  const action = String(req.body.action ?? "BOOST") as RuleAction;
  if (!pattern) return res.status(400).json({ error: "Pattern is required" });
  if (!["ALWAYS_NOTIFY", "NEVER_NOTIFY", "MARK_SPAM", "BOOST"].includes(action)) return res.status(400).json({ error: "Invalid action" });
  const account = await prisma.emailAccount.findFirst({ where: { id: accountId, userId: user.id } });
  if (!account) return res.status(404).json({ error: "Account not found" });
  const description = action === "BOOST" || action === "ALWAYS_NOTIFY" ? "Priority keyword" : "Suppression rule";
  const existingRule = await prisma.senderRule.findFirst({ where: { accountId: account.id, pattern, action } });
  const rule = existingRule
    ? await prisma.senderRule.update({ where: { id: existingRule.id }, data: { description } })
    : await prisma.senderRule.create({ data: { accountId: account.id, pattern, action, description } });
  res.json({ rule });
});

app.put("/api/rules/:id", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const rule = await prisma.senderRule.findFirst({ where: { id: req.params.id, account: { userId: user.id } } });
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  const pattern = String(req.body.pattern ?? rule.pattern).trim().slice(0, 255);
  const action = String(req.body.action ?? rule.action) as RuleAction;
  if (!pattern) return res.status(400).json({ error: "Pattern is required" });
  if (!["ALWAYS_NOTIFY", "NEVER_NOTIFY", "MARK_SPAM", "BOOST"].includes(action)) return res.status(400).json({ error: "Invalid action" });
  const updated = await prisma.senderRule.update({
    where: { id: rule.id },
    data: { pattern, action, description: action === "BOOST" || action === "ALWAYS_NOTIFY" ? "Priority keyword" : "Suppression rule" }
  });
  res.json({ rule: updated });
});

app.delete("/api/rules/:id", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const rule = await prisma.senderRule.findFirst({ where: { id: req.params.id, account: { userId: user.id } } });
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  await prisma.senderRule.delete({ where: { id: rule.id } });
  res.json({ ok: true });
});

app.post("/api/logs/:id/revert-feedback", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const log = await prisma.emailLog.findFirst({ where: { id: req.params.id, account: { userId: user.id } } });
  if (!log) return res.status(404).json({ error: "Log not found" });
  const updated = await prisma.emailLog.update({ where: { id: log.id }, data: { userFeedback: null, feedbackNotes: null } });
  res.json({ log: updated });
});

app.post("/api/replies/:id/done", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const log = await prisma.emailLog.findFirst({ where: { id: req.params.id, account: { userId: user.id } } });
  if (!log) return res.status(404).json({ error: "Log not found" });
  const updated = await prisma.emailLog.update({
    where: { id: log.id },
    data: { requiresResponse: false, userFeedback: "CORRECT", feedbackNotes: "Marked replied from dashboard" }
  });
  res.json({ log: updated });
});

app.get("/api/logs", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const accountIds = (await prisma.emailAccount.findMany({ where: { userId: user.id }, select: { id: true } })).map((a) => a.id);
  const disposition = typeof req.query.disposition === "string" && req.query.disposition ? req.query.disposition as EmailDisposition : undefined;
  const category = typeof req.query.category === "string" && req.query.category ? req.query.category as EmailLevel : undefined;
  const accountId = typeof req.query.accountId === "string" && accountIds.includes(req.query.accountId) ? req.query.accountId : undefined;
  const dateFrom = typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : undefined;
  const dateTo = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : undefined;
  const requiresResponse = req.query.requiresResponse === "true";
  const onlyOtp = req.query.otp === "true";
  const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
  const limit = Math.min(Number(req.query.limit ?? 80) || 80, 200);
  const rows = await prisma.emailLog.findMany({
    where: {
      accountId: { in: accountId ? [accountId] : accountIds },
      ...(disposition ? { disposition } : {}),
      ...(category ? { category } : {}),
      ...(requiresResponse ? { requiresResponse: true } : {}),
      ...(dateFrom || dateTo ? { processedAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } } : {})
    },
    include: { account: { select: { emailAddress: true } } },
    orderBy: { processedAt: "desc" },
    take: limit
  });
  const filtered = rows
    .filter((row) => !onlyOtp || isOtpText(`${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""}`))
    .filter((row) => !search || `${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""} ${row.senderAddress ?? ""} ${row.senderDomain ?? ""}`.toLowerCase().includes(search));
  res.json({ logs: filtered.map(toLogDto) });
});

app.get("/api/replies", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const rows = await prisma.emailLog.findMany({
    where: { account: { userId: user.id }, requiresResponse: true },
    include: { account: { select: { emailAddress: true } } },
    orderBy: { processedAt: "desc" },
    take: 100
  });
  res.json({ replies: rows.map(toLogDto) });
});

app.get("/api/otps", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const rows = await prisma.emailLog.findMany({
    where: { account: { userId: user.id } },
    include: { account: { select: { emailAddress: true } } },
    orderBy: { processedAt: "desc" },
    take: 200
  });
  res.json({ otps: rows.filter((row) => isOtpText(`${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""}`)).map(toLogDto) });
});

app.get("/api/stats", requireUser, async (_req, res) => {
  const user = res.locals.user as { id: string };
  const accountIds = (await prisma.emailAccount.findMany({ where: { userId: user.id }, select: { id: true } })).map((a) => a.id);
  const [total, grouped, categoryGrouped, recent, allRecent, allLogs, allActivity, rules] = await Promise.all([
    prisma.emailLog.count({ where: { accountId: { in: accountIds } } }),
    prisma.emailLog.groupBy({ by: ["disposition"], where: { accountId: { in: accountIds } }, _count: true }),
    prisma.emailLog.groupBy({ by: ["category"], where: { accountId: { in: accountIds } }, _count: true, _avg: { ensembleScore: true } }),
    prisma.emailLog.findMany({ where: { accountId: { in: accountIds } }, include: { account: { select: { emailAddress: true } } }, orderBy: { processedAt: "desc" }, take: 16 }),
    prisma.emailLog.findMany({
      where: { accountId: { in: accountIds }, processedAt: { gte: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000) } },
      select: { processedAt: true, disposition: true, category: true }
    }),
    prisma.emailLog.findMany({
      where: { accountId: { in: accountIds } },
      select: { disposition: true, subjectPreview: true, snippetPreview: true, senderDomain: true, requiresResponse: true }
    }),
    prisma.emailLog.findMany({
      where: { accountId: { in: accountIds }, processedAt: { gte: new Date(Date.now() - 125 * 24 * 60 * 60 * 1000) } },
      select: { processedAt: true }
    }),
    prisma.senderRule.findMany({ where: { accountId: { in: accountIds } }, orderBy: { createdAt: "desc" } })
  ]);
  const count = (d: EmailDisposition) => grouped.find((r) => r.disposition === d)?._count ?? 0;
  const timeline = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(Date.now() - (13 - index) * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    const rows = allRecent.filter((row) => row.processedAt.toISOString().slice(0, 10) === key);
    return {
      date: key,
      processed: rows.length,
      important: rows.filter((row) => row.disposition === "IMPORTANT").length,
      spam: rows.filter((row) => row.disposition === "SPAM").length,
      used: rows.filter((row) => row.disposition === "USED").length
    };
  });
  const segmentCounts = new Map<string, number>();
  for (const row of allLogs) {
    const segment = segmentForEmail(row);
    segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
  }
  const locationCounts = new Map<string, { country: string; code: string; location: string; count: number }>();
  for (const row of allLogs) {
    const location = locationForDomain(row.senderDomain);
    const key = `${location.country}:${location.location}`;
    const current = locationCounts.get(key) ?? location;
    current.count += 1;
    locationCounts.set(key, current);
  }
  const activity = Array.from({ length: 126 }, (_, index) => {
    const date = new Date(Date.now() - (125 - index) * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    const countValue = allActivity.filter((row) => row.processedAt.toISOString().slice(0, 10) === key).length;
    return { date: key, count: countValue, level: countValue === 0 ? 0 : countValue < 3 ? 1 : countValue < 8 ? 2 : 3 };
  });
  let currentStreak = 0;
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    if (activity[index].count === 0) break;
    currentStreak += 1;
  }
  let longestStreak = 0;
  let streakCursor = 0;
  for (const day of activity) {
    streakCursor = day.count > 0 ? streakCursor + 1 : 0;
    longestStreak = Math.max(longestStreak, streakCursor);
  }
  const replyCount = allLogs.filter((row) => row.requiresResponse || isReplyText(`${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""}`)).length;
  const otpCount = allLogs.filter((row) => isOtpText(`${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""}`)).length;
  const segments = Array.from(segmentCounts.entries()).map(([name, countValue]) => ({
    name,
    count: countValue,
    percent: total ? Math.round((countValue / total) * 100) : 0
  }));
  res.json({
    totals: {
      processed: total,
      important: count("IMPORTANT"),
      spam: count("SPAM"),
      used: count("USED"),
      low_value: count("LOW_VALUE"),
      duplicate: count("DUPLICATE"),
      replies: replyCount,
      otps: otpCount
    },
    timeline,
    by_category: categoryGrouped,
    segments,
    locations: Array.from(locationCounts.values()).sort((a, b) => b.count - a.count).slice(0, 8),
    activity,
    streaks: { current: currentStreak, longest: longestStreak },
    rules,
    recent: recent.map(toLogDto)
  });
});

app.post("/api/test-mail", requireUser, async (req, res) => {
  const user = res.locals.user as { id: string };
  const variant = String(req.body.variant ?? "important");
  const account = await prisma.emailAccount.findFirst({ where: { userId: user.id, status: "ACTIVE" } });
  if (!account) return res.status(400).json({ error: "Connect and verify Gmail before creating test classifications." });

  const isSpam = variant === "spam";
  const now = Date.now();
  const subject = isSpam ? "Winner claim now limited prize" : "Urgent contract approval needed today";
  const snippet = isSpam
    ? "You won a free prize. Claim now by clicking this limited offer."
    : "Please review and approve the updated contract before the deadline.";

  const log = await prisma.emailLog.create({
    data: {
      accountId: account.id,
      gmailMessageId: `test-${variant}-${now}`,
      senderHash: sha256(isSpam ? "promo@spam.test" : "client@important.test"),
      senderAddress: isSpam ? "promo@spam.test" : "client@important.test",
      recipientAddress: account.emailAddress,
      senderDomain: isSpam ? "spam.test" : "important.test",
      subjectHash: sha256(subject.toLowerCase()),
      subjectPreview: subject,
      snippetPreview: snippet,
      ruleScore: isSpam ? 4 : 94,
      ensembleScore: isSpam ? 4 : 94,
      confidence: ScoreConfidence.HIGH,
      category: isSpam ? EmailLevel.LOW : EmailLevel.CRITICAL,
      disposition: isSpam ? EmailDisposition.SPAM : EmailDisposition.IMPORTANT,
      requiresResponse: !isSpam
    }
  });

  res.json({
    ok: true,
    expected: isSpam ? "Spam test created. It should appear in dashboard stats only." : "Important test created. The bot should DM it shortly.",
    log
  });
});

app.use(express.static(dashboardDist));
app.get("*", (_req, res) => res.sendFile(path.join(dashboardDist, "index.html")));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
});

app.listen(config.API_PORT, () => console.log(`MailSync listening on ${config.API_PORT}`));
