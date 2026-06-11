import { z } from "zod";

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().optional());
const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(3000),
  DASHBOARD_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_CLIENT_SECRET: optionalString,
  DISCORD_REDIRECT_URI: optionalString,
  GMAIL_CLIENT_ID: optionalString,
  GMAIL_CLIENT_SECRET: optionalString,
  GMAIL_REDIRECT_URI: optionalString,
  GMAIL_PUSH_ENABLED: z.coerce.boolean().default(false),
  GMAIL_PUBSUB_TOPIC: optionalString,
  GMAIL_PUBSUB_VERIFICATION_TOKEN: optionalString,
  GMAIL_PUSH_SYNC_INTERVAL_MS: z.coerce.number().default(2500),
  GMAIL_WATCH_RENEWAL_HOURS: z.coerce.number().default(24),
  GEMINI_API_KEY: optionalString,
  GROQ_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  AUTH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  OTP_PEPPER: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().default(720),
  OTP_TTL_MINUTES: z.coerce.number().default(10),
  OTP_DELIVERY_MODE: z.enum(["discord", "dashboard"]).default("discord"),
  POLLING_INTERVAL_MS: z.coerce.number().default(60000),
  DISCORD_DELIVERY_INTERVAL_MS: z.coerce.number().default(5000),
  GMAIL_SYNC_LOOKBACK_MS: z.coerce.number().default(15 * 60 * 1000),
  GMAIL_MAX_MESSAGES_PER_SYNC: z.coerce.number().default(100),
  DEFAULT_IMPORTANT_THRESHOLD: z.coerce.number().default(72),
  DEFAULT_CRITICAL_THRESHOLD: z.coerce.number().default(88),
  OPENWA_BASE_URL: optionalUrl,
  OPENWA_API_KEY: optionalString,
  OPENWA_SESSION_ID: z.string().default("default"),
  WHATSAPP_NOTIFICATIONS_ENABLED: z.coerce.boolean().default(false)
});

export type AppConfig = z.infer<typeof envSchema>;
export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
