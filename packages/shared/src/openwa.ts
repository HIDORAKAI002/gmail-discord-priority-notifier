import type { AppConfig } from "./config.js";

export type OpenWaDeliveryConfig = {
  enabled: boolean;
  baseUrl?: string | null;
  apiKey?: string | null;
  sessionId?: string | null;
};

export function normalizeWhatsAppNumber(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export function whatsappChatId(value: string) {
  const normalized = normalizeWhatsAppNumber(value);
  return normalized ? `${normalized.slice(1)}@c.us` : null;
}

export function formatPriorityWhatsAppMessage(log: {
  subjectPreview: string | null;
  senderAddress: string | null;
  senderDomain: string | null;
  recipientAddress: string | null;
  snippetPreview: string | null;
  bodyPreview?: string | null;
  processedAt: Date;
  account: { emailAddress: string };
}) {
  const subject = log.subjectPreview?.trim() || "Important email detected";
  const from = log.senderAddress || log.senderDomain || "Unknown sender";
  const to = log.recipientAddress || log.account.emailAddress;
  const preview = (log.bodyPreview || log.snippetPreview)?.replace(/\s+/g, " ").trim();
  const lines = [
    "MailSync priority email",
    "",
    subject,
    "",
    `From: ${from}`,
    `To: ${to}`,
    `Received: ${log.processedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
  ];
  if (preview) lines.push("", `Preview: ${preview.slice(0, 900)}`);
  return lines.join("\n");
}

export function openWaFromAppConfig(config: AppConfig): OpenWaDeliveryConfig {
  return {
    enabled: config.WHATSAPP_NOTIFICATIONS_ENABLED,
    baseUrl: config.OPENWA_BASE_URL,
    apiKey: config.OPENWA_API_KEY,
    sessionId: config.OPENWA_SESSION_ID
  };
}

export async function sendOpenWaText(config: OpenWaDeliveryConfig | AppConfig, number: string, text: string) {
  const deliveryConfig = "WHATSAPP_NOTIFICATIONS_ENABLED" in config ? openWaFromAppConfig(config) : config;
  if (!deliveryConfig.enabled) throw new Error("WhatsApp notifications are disabled");
  if (!deliveryConfig.baseUrl || !deliveryConfig.apiKey) throw new Error("OpenWA base URL or API key is not configured");
  const chatId = whatsappChatId(number);
  if (!chatId) throw new Error("Invalid WhatsApp number");
  const baseUrl = deliveryConfig.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(deliveryConfig.sessionId || "default")}/messages/send-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": deliveryConfig.apiKey
    },
    body: JSON.stringify({ chatId, text })
  });
  if (!response.ok) throw new Error(`OpenWA send failed: ${response.status} ${await response.text()}`);
  return response.json().catch(() => ({ ok: true })) as Promise<unknown>;
}
