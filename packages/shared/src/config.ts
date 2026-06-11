import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(3000),
  DASHBOARD_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_REDIRECT_URI: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REDIRECT_URI: z.string().optional(),
  GMAIL_PUSH_ENABLED: z.coerce.boolean().default(false),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_PUBSUB_VERIFICATION_TOKEN: z.string().optional(),
  GMAIL_PUSH_SYNC_INTERVAL_MS: z.coerce.number().default(2500),
  GMAIL_WATCH_RENEWAL_HOURS: z.coerce.number().default(24),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  AUTH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  OTP_PEPPER: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().default(720),
  OTP_TTL_MINUTES: z.coerce.number().default(10),
  OTP_DELIVERY_MODE: z.enum(["discord", "dashboard"]).default("discord"),
  POLLING_INTERVAL_MS: z.coerce.number().default(60000),
  DEFAULT_IMPORTANT_THRESHOLD: z.coerce.number().default(72),
  DEFAULT_CRITICAL_THRESHOLD: z.coerce.number().default(88),
  OPENWA_BASE_URL: z.string().url().optional(),
  OPENWA_API_KEY: z.string().optional(),
  OPENWA_SESSION_ID: z.string().default("default"),
  WHATSAPP_NOTIFICATIONS_ENABLED: z.coerce.boolean().default(false)
});

export type AppConfig = z.infer<typeof envSchema>;
export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
