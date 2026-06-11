# MailSync

MailSync is a self-hosted email importance notifier and analytics dashboard. It lets one user identity connect one or more Gmail accounts, classify new incoming mail, store searchable mail decisions in MySQL, and send high-priority alerts to Discord and optionally WhatsApp through OpenWA.

The project is designed for VPS or panel hosting. It can also run locally for development.

No production credentials are included in this repository. Every domain, port, OAuth client, bot token, database password, API key, and webhook token must be created by the operator and placed in a private `.env` file.

## Table Of Contents

- [What MailSync Does](#what-mailsync-does)
- [What MailSync Does Not Do](#what-mailsync-does-not-do)
- [Repository Layout](#repository-layout)
- [Runtime Architecture](#runtime-architecture)
- [Request Flow](#request-flow)
- [Database Model](#database-model)
- [Authentication Model](#authentication-model)
- [Email Processing Model](#email-processing-model)
- [Notification Model](#notification-model)
- [Dashboard Pages](#dashboard-pages)
- [Environment Variables](#environment-variables)
- [Secret Generation](#secret-generation)
- [Local Development](#local-development)
- [Production Hosting](#production-hosting)
- [Pterodactyl Hosting](#pterodactyl-hosting)
- [Reverse Proxy](#reverse-proxy)
- [Discord Setup](#discord-setup)
- [Google OAuth And Gmail Setup](#google-oauth-and-gmail-setup)
- [Optional Gmail Push Notifications](#optional-gmail-push-notifications)
- [Optional WhatsApp/OpenWA Setup](#optional-whatsappopenwa-setup)
- [Database Setup](#database-setup)
- [Build And Runtime Commands](#build-and-runtime-commands)
- [Security Checklist](#security-checklist)
- [Customization Guide](#customization-guide)
- [Troubleshooting](#troubleshooting)
- [Deployment Checklist](#deployment-checklist)

## What MailSync Does

MailSync provides:

- Discord login for the primary user account.
- WhatsApp-number login through OpenWA OTP when an OpenWA agent is configured.
- Gmail OAuth connection for one or more Gmail accounts under the same user.
- New-mail processing across all connected Gmail accounts.
- Spam, low-value, useful, important, critical, OTP, and reply-needed classification.
- Priority keyword and sender/domain rules.
- Discord DM delivery for important messages.
- Optional WhatsApp delivery for important messages.
- Interactive dashboard with overview, insights, graphs, world map, priority rules, logs, replies, OTPs, and settings.
- Per-account severity controls for Discord/WhatsApp alerting.
- Per-user OpenWA configuration, so each user can bring their own WhatsApp agent.
- Account/data deletion from the dashboard.
- MySQL-backed persistence.
- Optional Gmail Push Notifications through Google Cloud Pub/Sub for lower-latency sync.

## What MailSync Does Not Do

MailSync intentionally does not:

- Send or compose emails.
- Delete Gmail messages.
- Mark Gmail messages as read.
- Modify Gmail labels.
- Require a managed database provider.
- Require Kimi, Supabase, Railway, or any other specific managed platform.
- Include production credentials.
- Guarantee instant Gmail delivery without Pub/Sub setup.

## Repository Layout

```text
.
├── apps
│   ├── api
│   │   └── Express API, OAuth callbacks, dashboard API, webhook intake, static dashboard serving
│   ├── bot
│   │   └── Discord bot process and Discord message delivery
│   ├── dashboard
│   │   └── React/Vite dashboard UI
│   └── worker
│       └── Gmail sync, scoring, reply detection, WhatsApp delivery
├── packages
│   ├── database
│   │   └── Prisma schema and generated Prisma client target
│   └── shared
│       └── Config, Prisma singleton, crypto helpers, scoring helpers, OpenWA helpers
├── scripts
│   └── ensure-additive-schema.js
│       └── Safety fallback for adding new MySQL columns when Prisma db push fails
├── docs
│   └── VPS_DEPLOYMENT.md
├── docker-compose.yml
├── package.json
├── pterodactyl-start.js
├── .env.example
└── README.md
```

## Runtime Architecture

MailSync runs four application workspaces:

### `apps/api`

The API is the public HTTP service. It handles:

- Health checks.
- Discord OAuth login.
- WhatsApp OTP login.
- Gmail OAuth connection.
- Gmail connection OTP verification.
- User sessions.
- User data deletion.
- Dashboard data endpoints.
- Priority rule endpoints.
- WhatsApp settings endpoints.
- Gmail Pub/Sub webhook endpoint.
- Serving the built dashboard in production.

In production, the API listens on `API_PORT`.

### `apps/dashboard`

The dashboard is a React/Vite frontend. In development it runs as a separate Vite dev server. In production it is built into static files and served by `apps/api`.

Dashboard features include:

- Onboarding.
- Theme selection.
- Discord login.
- WhatsApp login.
- Gmail connection flow.
- Overview metrics.
- Email type distribution.
- Activity streaks.
- Graphs and time series.
- World map view.
- Priority keyword/rule management.
- Logs with filters.
- Reply-needed view.
- OTP view.
- Settings.
- WhatsApp connector configuration.
- Data deletion.

### `apps/bot`

The Discord bot process logs into Discord with `DISCORD_BOT_TOKEN`. It sends rich DM embeds for priority mail and handles Discord-side delivery behavior.

The bot requires:

- A Discord application.
- A bot token.
- The user to allow DMs from the bot or share a server where DMs are allowed.

### `apps/worker`

The worker is the background processor. It:

- Finds connected Gmail accounts.
- Refreshes Gmail OAuth access tokens.
- Reads new Gmail messages.
- Skips old mail on first connection.
- Classifies messages.
- Applies keyword/sender rules.
- Creates `EmailLog` records.
- Checks sent mail to clear reply-needed items.
- Sends WhatsApp alerts when configured.
- Renews Gmail Push watches when enabled.
- Processes Pub/Sub-triggered sync requests quickly.

The worker must run continuously.

## Request Flow

### Dashboard Login Flow

```text
Browser -> API /api/auth/discord -> Discord OAuth -> API callback -> session token -> dashboard localStorage
```

The browser stores a JWT session token in `localStorage`. API requests include:

```http
Authorization: Bearer <session-token>
```

If the session expires, the dashboard clears the stale token and asks the user to sign in again. This does not delete Gmail accounts or mail logs.

### Gmail Connection Flow

```text
Dashboard -> API /api/auth/gmail/init
API -> Google OAuth consent
Google -> API /api/auth/gmail/callback
API -> stores temporary encrypted OAuth payload inside OTP log
API -> sends OTP by Discord DM or dashboard fallback
Dashboard -> /api/auth/verify-otp
API -> creates or updates EmailAccount
Worker -> sets first-sync baseline and skips old inbox mail
```

Important behavior:

- Existing inbox messages are skipped on first connection.
- Only messages after `lastSyncAt` are processed.
- This prevents initial Discord spam from old messages.

### New Email Flow With Polling

```text
Worker timer -> Gmail messages list -> fetch new messages -> classify -> write EmailLog -> bot/WhatsApp delivery
```

The default polling interval is:

```env
POLLING_INTERVAL_MS=60000
```

That means notifications can be delayed by about one minute unless Gmail Push is enabled.

### New Email Flow With Gmail Push

```text
Gmail -> Pub/Sub topic -> Pub/Sub push subscription -> API webhook -> mark account syncRequestedAt -> worker fast loop -> classify -> notify
```

Gmail Push is optional but recommended for production.

## Database Model

MailSync uses Prisma with MySQL.

Main models:

- `User`
- `EmailAccount`
- `NotificationPreference`
- `AiThreshold`
- `SenderRule`
- `EmailLog`
- `Session`
- `OtpLog`
- `AuditLog`

### `User`

Stores one dashboard identity.

Important fields:

- `discordId`
- `discordUsername`
- `discordEmail`
- `whatsappNumber`
- `whatsappEnabled`
- `whatsappAgentEnabled`
- `openWaBaseUrl`
- `openWaApiKey`
- `openWaSessionId`
- `timezone`
- `isActive`

`openWaApiKey` is encrypted before storage.

### `EmailAccount`

Stores a connected Gmail mailbox.

Important fields:

- `userId`
- `emailAddress`
- `googleUserId`
- `gmailRefreshToken`
- `gmailAccessToken`
- `tokenExpiresAt`
- `historyId`
- `lastPushHistoryId`
- `watchExpiresAt`
- `syncRequestedAt`
- `syncRequestedReason`
- `status`
- `lastSyncAt`
- `lastError`
- `errorCount`

Gmail tokens are encrypted before storage.

### `EmailLog`

Stores processed mail decisions.

Important fields:

- `gmailMessageId`
- `gmailThreadId`
- `senderAddress`
- `recipientAddress`
- `senderDomain`
- `subjectPreview`
- `snippetPreview`
- `bodyPreview`
- `ensembleScore`
- `category`
- `disposition`
- `requiresResponse`
- `wasNotified`
- `notificationSentAt`
- `whatsappNotifiedAt`
- `userFeedback`
- `processedAt`

`bodyPreview` is stored when the Gmail token can fetch full message bodies. If the connected OAuth token only has metadata scope, MailSync falls back to metadata and snippet fields.

## Authentication Model

MailSync supports two login paths:

### Discord Login

Discord login is the primary owner identity.

Required env:

```env
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=
```

### WhatsApp Login

WhatsApp login uses a WhatsApp OTP sent through OpenWA.

It requires either:

- Platform-wide OpenWA env vars, or
- A user-configured OpenWA agent after a user exists.

For first-time WhatsApp login, platform-wide OpenWA is the practical route because the app needs an agent to send the first OTP.

## Email Processing Model

The worker scores messages using deterministic local rules. Optional AI provider keys may be added later or used where supported, but the app does not require AI keys to run.

Classification concepts:

- `CRITICAL`
- `IMPORTANT`
- `NORMAL`
- `LOW`

Disposition concepts:

- `IMPORTANT`
- `USED`
- `SPAM`
- `LOW_VALUE`
- `DUPLICATE`

The alert threshold defaults are:

```env
DEFAULT_IMPORTANT_THRESHOLD=72
DEFAULT_CRITICAL_THRESHOLD=88
```

Users can configure per-account DM severity:

- Critical only.
- Important and critical.
- Normal and above.

## Notification Model

### Discord

Discord sends priority notifications by DM.

Requirements:

- `DISCORD_BOT_TOKEN`.
- The bot must be running.
- The recipient must be reachable by DM.

### WhatsApp

WhatsApp uses OpenWA.

Delivery selection:

1. If a user enabled their own OpenWA agent, use the user's encrypted agent settings.
2. Otherwise use platform-wide env OpenWA settings.
3. If neither is configured, skip WhatsApp delivery and keep Discord/dashboard behavior.

## Dashboard Pages

### Overview

Shows high-level processed mail counts, email type breakdowns, recent activity, daily streaks, and quick operational context.

### Insights

Shows aggregate usage and processed-mail intelligence across all connected Gmail accounts.

### Graphs

Shows time-series and distribution charts for processed, important, spam, and useful mail.

### Map

Shows an approximate world map view based on sender domain TLD or trackable sender location data. Domain-only location is not guaranteed to reflect physical sender location.

### Priorities

Lets users add, edit, and delete rules:

- Always notify.
- Never notify.
- Mark spam.
- Boost.

Rules can be applied per mailbox or across all linked mailboxes.

### Logs

Shows previous processed emails with filters for:

- Mailbox.
- Disposition.
- Kind.
- Date.
- Search.

### Replies

Shows messages MailSync believes may need a response. The worker checks sent mail and clears items when a reply is detected.

### OTPs

Shows OTP/security-code-like messages separately.

### Settings

Includes:

- Theme selection.
- Gmail account status.
- Discord DM severity.
- WhatsApp number.
- Custom OpenWA settings.
- Test WhatsApp delivery.
- Data deletion.

## Environment Variables

Copy `.env.example` to `.env`.

```bash
cp .env.example .env
```

Never commit a real `.env`.

### Runtime

```env
NODE_ENV=development
API_PORT=3000
DASHBOARD_PORT=5173
API_BASE_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:5173
LANDING_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173
```

Meaning:

- `NODE_ENV`: use `production` on a server.
- `API_PORT`: port the Express API listens on.
- `DASHBOARD_PORT`: Vite dev-server port for local frontend development.
- `API_BASE_URL`: public API base URL.
- `DASHBOARD_URL`: public dashboard URL used for OAuth redirects after callbacks.
- `LANDING_URL`: optional public landing URL.
- `CORS_ORIGIN`: comma-separated origins allowed to call the API.

Production example:

```env
NODE_ENV=production
API_PORT=3000
API_BASE_URL=https://your-domain.example
DASHBOARD_URL=https://your-domain.example
LANDING_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
```

Panel hosts such as Pterodactyl may force a specific public/internal port. In that case set `API_PORT` to the port assigned by the panel.

### Database

```env
DATABASE_URL=mysql://mailsync:change_me@127.0.0.1:3306/mailsync
REDIS_URL=redis://127.0.0.1:6379
```

`DATABASE_URL` is required.

`REDIS_URL` is currently optional and reserved for future queue/rate-limit expansion.

MySQL URL format:

```text
mysql://USER:PASSWORD@HOST:PORT/DATABASE
```

If your password contains special characters, URL-encode it.

### Discord

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/discord/callback
DISCORD_PUBLIC_KEY=
```

Required for Discord login and DM delivery:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`

`DISCORD_PUBLIC_KEY` is included for future interaction verification and is not currently central to the main OAuth flow.

### Gmail

```env
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=http://localhost:3000/api/auth/gmail/callback
```

Required for Gmail connection:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI`

### Gmail Push

```env
GMAIL_PUSH_ENABLED=false
GMAIL_PUBSUB_TOPIC=
GMAIL_PUBSUB_VERIFICATION_TOKEN=
GMAIL_PUSH_SYNC_INTERVAL_MS=2500
GMAIL_WATCH_RENEWAL_HOURS=24
```

Set `GMAIL_PUSH_ENABLED=true` only after Pub/Sub is configured.

### Optional AI Providers

```env
GEMINI_API_KEY=
GROQ_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
GROQ_MODEL=llama-3.3-70b-versatile
```

The app can run without these keys.

### Security

```env
AUTH_SECRET=replace_with_at_least_32_random_characters
ENCRYPTION_KEY=replace_with_64_hex_chars_generated_by_openssl_rand_hex_32
OTP_PEPPER=replace_with_at_least_16_random_characters
SESSION_TTL_HOURS=720
OTP_TTL_MINUTES=10
OTP_DELIVERY_MODE=discord
```

Meaning:

- `AUTH_SECRET`: signs dashboard sessions and OAuth state.
- `ENCRYPTION_KEY`: encrypts Gmail tokens and user OpenWA keys.
- `OTP_PEPPER`: hashes OTP codes before database storage.
- `SESSION_TTL_HOURS`: session lifetime. `720` is 30 days.
- `OTP_TTL_MINUTES`: OTP expiry.
- `OTP_DELIVERY_MODE`: `discord` or `dashboard`.

Do not rotate `ENCRYPTION_KEY` casually. Existing encrypted Gmail refresh tokens and OpenWA API keys become unreadable if the key changes.

### Email Processing

```env
POLLING_INTERVAL_MS=60000
MAX_EMAILS_PER_BATCH=50
DEFAULT_IMPORTANT_THRESHOLD=72
DEFAULT_CRITICAL_THRESHOLD=88
```

`POLLING_INTERVAL_MS` controls fallback Gmail polling.

### WhatsApp/OpenWA

```env
WHATSAPP_NOTIFICATIONS_ENABLED=false
OPENWA_BASE_URL=
OPENWA_API_KEY=
OPENWA_SESSION_ID=default
```

These configure a platform-wide OpenWA agent. Users can override OpenWA settings from the dashboard.

## Secret Generation

Generate `AUTH_SECRET`:

```bash
openssl rand -hex 32
```

Generate `ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

Generate `OTP_PEPPER`:

```bash
openssl rand -hex 24
```

Windows PowerShell alternative:

```powershell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

Use different values for every deployment.

## Local Development

### Requirements

- Node.js 20.
- npm 10 or newer.
- Docker Desktop, if using the included local MySQL compose file.
- A Discord application, if testing real Discord login.
- A Google OAuth client, if testing real Gmail connection.

### Install Dependencies

```bash
npm install
```

### Start Local MySQL

```bash
docker compose up -d mysql
```

Optional Redis:

```bash
docker compose up -d redis
```

### Configure `.env`

Use local defaults:

```env
NODE_ENV=development
API_PORT=3000
DASHBOARD_PORT=5173
API_BASE_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=mysql://mailsync:change_me@127.0.0.1:3306/mailsync
```

### Generate Prisma Client

```bash
npm run db:generate
```

### Push Schema To Local MySQL

```bash
npm run db:push
```

### Run Development Servers

```bash
npm run dev
```

Development URLs:

```text
API:       http://localhost:3000
Dashboard: http://localhost:5173
```

### Development Session

In non-production mode, the API includes:

```text
POST /api/auth/dev/session
```

This is useful for UI testing before Discord OAuth is configured.

Set `NODE_ENV=production` on real servers to disable this endpoint.

## Production Hosting

MailSync can run on:

- A VPS.
- Pterodactyl Node.js egg/container.
- Docker-based host.
- Any server that can run Node.js 20 and reach MySQL.

Minimum practical server:

- 1 CPU core.
- 1 GB RAM for low traffic.
- 2 GB RAM recommended.
- Node.js 20.
- MySQL 8 or compatible hosted MySQL.
- HTTPS-capable reverse proxy or panel proxy.

Recommended production server:

- 2 CPU cores.
- 2 GB RAM or more.
- MySQL on the same private network or host.
- Nginx or Caddy for TLS.
- Process manager such as `systemd`, `pm2`, Docker, or Pterodactyl.

## Pterodactyl Hosting

Use a Node.js 20 image such as:

```text
ghcr.io/pterodactyl/yolks:nodejs_20
```

Startup command:

```bash
node pterodactyl-start.js
```

The startup script:

1. Checks required project files exist.
2. Runs `npm install --include=dev`.
3. Runs `npm run db:generate`.
4. Runs `npm run db:push`.
5. If `db:push` fails, runs `scripts/ensure-additive-schema.js`.
6. Runs `npm run build`.
7. Runs `npm run start:prod`.

Pterodactyl configuration:

- Upload the full project folder.
- Do not upload only `package.json`.
- Set `API_PORT` to the server allocation port.
- Set `DASHBOARD_URL` to the public HTTPS domain.
- Set `CORS_ORIGIN` to the public HTTPS domain.
- Put real secrets in the panel environment or private `.env`.
- Do not commit real `.env`.

Example production panel env:

```env
NODE_ENV=production
API_PORT=YOUR_ASSIGNED_PORT
DASHBOARD_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
DATABASE_URL=mysql://USER:ENCODED_PASSWORD@MYSQL_HOST:3306/DATABASE
```

If your panel maps a public domain to an internal allocation port, users should visit the domain, not the raw internal port.

## Reverse Proxy

In production the API serves both API routes and dashboard static files.

Proxy all traffic for your domain to the API process:

```text
https://your-domain.example -> http://127.0.0.1:API_PORT
```

Important paths:

```text
/health
/health/ready
/api/*
/auth/callback
/auth/gmail-callback
/privacy
/terms
/*
```

Nginx example:

```nginx
server {
    listen 80;
    server_name your-domain.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.example;

    ssl_certificate /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy example:

```caddy
your-domain.example {
    reverse_proxy 127.0.0.1:3000
}
```

## Discord Setup

1. Open the Discord Developer Portal.
2. Create an application.
3. Add a bot.
4. Copy the bot token into `DISCORD_BOT_TOKEN`.
5. Copy the application client ID into `DISCORD_CLIENT_ID`.
6. Copy the OAuth client secret into `DISCORD_CLIENT_SECRET`.
7. Add this OAuth redirect URI:

```text
https://your-domain.example/api/auth/discord/callback
```

For local development:

```text
http://localhost:3000/api/auth/discord/callback
```

Set:

```env
DISCORD_REDIRECT_URI=https://your-domain.example/api/auth/discord/callback
```

OAuth scopes used:

```text
identify email
```

Bot permissions:

- The bot must be able to create DMs with the user.
- If DMs fail with 403, the user may need to share a server with the bot or allow server DMs.

## Google OAuth And Gmail Setup

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable Gmail API.
4. Configure OAuth consent screen.
5. Add authorized domain:

```text
your-domain.example
```

6. Create OAuth client ID.
7. Choose application type:

```text
Web application
```

8. Add authorized JavaScript origin:

```text
https://your-domain.example
```

Do not include a path in JavaScript origins.

9. Add authorized redirect URI:

```text
https://your-domain.example/api/auth/gmail/callback
```

For local development:

```text
http://localhost:3000/api/auth/gmail/callback
```

Set:

```env
GMAIL_CLIENT_ID=your-google-client-id
GMAIL_CLIENT_SECRET=your-google-client-secret
GMAIL_REDIRECT_URI=https://your-domain.example/api/auth/gmail/callback
```

Requested scopes:

```text
openid
email
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.metadata
```

Testing mode:

- If the Google OAuth app is in testing mode, only added test users can log in.
- To allow public users, complete Google's verification process.

## Optional Gmail Push Notifications

Gmail does not call your app directly for new email. Gmail publishes notifications to Google Cloud Pub/Sub. Pub/Sub then pushes to your HTTPS endpoint.

Without this setup, MailSync still works through polling.

### Enable Gmail Push

Set:

```env
GMAIL_PUSH_ENABLED=true
GMAIL_PUBSUB_TOPIC=projects/YOUR_GOOGLE_PROJECT_ID/topics/YOUR_TOPIC_NAME
GMAIL_PUBSUB_VERIFICATION_TOKEN=replace_with_long_random_secret
GMAIL_PUSH_SYNC_INTERVAL_MS=2500
GMAIL_WATCH_RENEWAL_HOURS=24
```

### Create Pub/Sub Topic

Topic name example:

```text
mailsync-gmail
```

Full topic name format:

```text
projects/YOUR_GOOGLE_PROJECT_ID/topics/mailsync-gmail
```

### Grant Gmail Publisher Permission

Grant this Google-managed service account Pub/Sub Publisher on the topic:

```text
gmail-api-push@system.gserviceaccount.com
```

### Create Push Subscription

Push endpoint:

```text
https://your-domain.example/api/webhooks/gmail?token=YOUR_GMAIL_PUBSUB_VERIFICATION_TOKEN
```

The token in the URL must exactly match `GMAIL_PUBSUB_VERIFICATION_TOKEN`.

### Watch Renewal

The worker calls Gmail `users.watch` for connected accounts and stores:

- `historyId`
- `watchExpiresAt`

Gmail watches expire, so the worker renews them before expiration.

## Optional WhatsApp/OpenWA Setup

MailSync integrates with OpenWA-compatible REST endpoints.

Platform-wide env:

```env
WHATSAPP_NOTIFICATIONS_ENABLED=true
OPENWA_BASE_URL=https://your-openwa-host.example
OPENWA_API_KEY=your-openwa-api-key
OPENWA_SESSION_ID=default
```

Expected send endpoint:

```text
POST /api/sessions/:sessionId/messages/send-text
```

MailSync sends:

```json
{
  "chatId": "15551234567@c.us",
  "text": "message body"
}
```

Header:

```http
X-API-Key: your-openwa-api-key
```

Dashboard user override:

- Users can enter their own OpenWA base URL.
- Users can enter their own OpenWA session ID.
- Users can enter their own OpenWA API key.
- User keys are encrypted in MySQL.
- User keys are never sent back to the browser.

## Database Setup

### Local MySQL With Docker

```bash
docker compose up -d mysql
```

Default local credentials from `docker-compose.yml`:

```text
database: mailsync
user: mailsync
password: change_me
host: 127.0.0.1
port: 3306
```

Local URL:

```env
DATABASE_URL=mysql://mailsync:change_me@127.0.0.1:3306/mailsync
```

### Production MySQL

Create:

- A database.
- A non-root database user.
- A strong password.
- Network access from the app server to MySQL.

Grant only the permissions needed for the MailSync database.

Example SQL:

```sql
CREATE DATABASE mailsync CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mailsync'@'%' IDENTIFIED BY 'replace_with_strong_password';
GRANT ALL PRIVILEGES ON mailsync.* TO 'mailsync'@'%';
FLUSH PRIVILEGES;
```

Then set:

```env
DATABASE_URL=mysql://mailsync:URL_ENCODED_PASSWORD@MYSQL_HOST:3306/mailsync
```

## Build And Runtime Commands

Install:

```bash
npm install
```

Generate Prisma:

```bash
npm run db:generate
```

Push schema:

```bash
npm run db:push
```

Typecheck:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Development:

```bash
npm run dev
```

Production:

```bash
npm run start:prod
```

Pterodactyl:

```bash
node pterodactyl-start.js
```

## Security Checklist

Before production:

- Replace every placeholder in `.env`.
- Keep `.env` out of git.
- Rotate any credential ever pasted into chat, logs, screenshots, or public repos.
- Use HTTPS.
- Use a non-root MySQL user.
- Use a strong MySQL password.
- Use a long random `AUTH_SECRET`.
- Use a 64-hex-character `ENCRYPTION_KEY`.
- Back up `ENCRYPTION_KEY` securely.
- Do not rotate `ENCRYPTION_KEY` unless you are ready to reconnect all Gmail/OpenWA secrets.
- Set `NODE_ENV=production`.
- Verify Discord redirect URI exactly matches `.env`.
- Verify Google redirect URI exactly matches `.env`.
- Verify `CORS_ORIGIN` matches your public dashboard origin.
- Restrict MySQL network access when possible.
- Protect OpenWA with an API key and HTTPS.
- Use separate Google/Discord apps for staging and production.

## Customization Guide

### Change Domain

Update:

```env
API_BASE_URL=https://your-domain.example
DASHBOARD_URL=https://your-domain.example
LANDING_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
DISCORD_REDIRECT_URI=https://your-domain.example/api/auth/discord/callback
GMAIL_REDIRECT_URI=https://your-domain.example/api/auth/gmail/callback
```

Then update the same URLs in:

- Discord Developer Portal.
- Google OAuth client.
- Pub/Sub push subscription, if Gmail Push is enabled.

### Change Port

Update:

```env
API_PORT=YOUR_PORT
```

If using a reverse proxy, update the proxy upstream.

If using Pterodactyl, use the assigned allocation port.

### Change Alert Strictness

Update defaults:

```env
DEFAULT_IMPORTANT_THRESHOLD=72
DEFAULT_CRITICAL_THRESHOLD=88
```

Users can also set per-account DM severity in the dashboard.

### Change Polling Frequency

Update:

```env
POLLING_INTERVAL_MS=60000
```

Lower values reduce delay but increase Gmail API calls.

For near-real-time behavior, use Gmail Push instead.

### Change Dashboard Contact Text

Edit:

```text
apps/dashboard/src/main.tsx
```

Search for:

```text
your-support-email@example.com
```

Replace it with your support address or support page.

## Troubleshooting

### Dashboard Shows 401

Meaning:

- Session token is missing, expired, or invalid.

Fix:

- Sign in again.
- Confirm `AUTH_SECRET` did not change between restarts.
- Confirm the `Session` row still exists.

Data is not necessarily deleted. If the worker logs `1 account(s)` or more, Gmail accounts still exist.

### Discord DM Fails With 403

Meaning:

- Discord refused DM delivery.

Fix:

- Make sure the user shares a server with the bot.
- Make sure user DMs are allowed.
- Make sure the bot token is valid.

### Gmail OAuth Says Access Blocked

Meaning:

- Google OAuth app is in testing mode and the Gmail address is not a test user, or app verification is incomplete.

Fix:

- Add the Gmail address under OAuth Audience/Test users, or complete Google verification for public access.

### Gmail Callback Fails

Check:

- `GMAIL_REDIRECT_URI` in `.env`.
- Google OAuth authorized redirect URI.
- Public domain HTTPS.
- API server reachable.

The URL must match exactly.

### Old Emails Were Processed

Expected behavior is:

- First connection sets a baseline.
- Existing inbox mail is skipped.
- Only new mail after baseline is processed.

If old mail appears:

- Check whether `lastSyncAt` was reset.
- Check whether account rows were deleted and reconnected.
- Check worker logs around first sync.

### Notifications Are Late

Polling mode delay is normal.

Fix:

- Lower `POLLING_INTERVAL_MS`, or
- Configure Gmail Push with Pub/Sub.

### Gmail Push Does Not Trigger

Check:

- `GMAIL_PUSH_ENABLED=true`.
- `GMAIL_PUBSUB_TOPIC` is correct.
- Pub/Sub topic exists.
- Gmail publisher service account has Pub/Sub Publisher role.
- Push subscription URL is correct.
- Webhook token matches.
- Your domain has valid HTTPS.
- Worker logs show watch renewal.

### WhatsApp Test Fails

Check:

- `WHATSAPP_NOTIFICATIONS_ENABLED=true`, or user custom agent enabled.
- OpenWA base URL is reachable from the app server.
- OpenWA API key is correct.
- OpenWA session is connected.
- Phone number includes country code.

### Prisma `db:push` Fails On Pterodactyl

The startup script will run:

```bash
node scripts/ensure-additive-schema.js
```

This fallback only adds missing columns used by the current app. For serious production versioning, use Prisma migrations.

### Build Warns About Large Chunks

Vite may warn that the dashboard JavaScript bundle is larger than 500 kB. This is not a build failure. The dashboard includes charting, maps, icons, and animation libraries.

Future optimization:

- Dynamic import dashboard pages.
- Split chart/map bundles.
- Manual Rollup chunks.

## Deployment Checklist

Before pushing to a server:

1. Confirm `.env` has no placeholders.
2. Confirm `.env` is not committed.
3. Confirm `DATABASE_URL` reaches MySQL from the server.
4. Run `npm install`.
5. Run `npm run db:generate`.
6. Run `npm run db:push`.
7. Run `npm run typecheck`.
8. Run `npm run build`.
9. Set Discord OAuth redirect URI.
10. Set Gmail OAuth redirect URI.
11. Set `NODE_ENV=production`.
12. Start with `npm run start:prod` or `node pterodactyl-start.js`.
13. Visit `/health`.
14. Visit `/health/ready`.
15. Connect Discord.
16. Connect Gmail.
17. Send a new email after Gmail connection.
18. Confirm the worker processes only new mail.
19. Confirm important mail appears in Discord/WhatsApp according to severity settings.
20. Confirm spam/low-value mail stays dashboard-only.

## Minimal Production `.env` Example

```env
NODE_ENV=production
API_PORT=3000
API_BASE_URL=https://your-domain.example
DASHBOARD_URL=https://your-domain.example
LANDING_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example

DATABASE_URL=mysql://USER:URL_ENCODED_PASSWORD@MYSQL_HOST:3306/DATABASE

DISCORD_BOT_TOKEN=replace_me
DISCORD_CLIENT_ID=replace_me
DISCORD_CLIENT_SECRET=replace_me
DISCORD_REDIRECT_URI=https://your-domain.example/api/auth/discord/callback

GMAIL_CLIENT_ID=replace_me
GMAIL_CLIENT_SECRET=replace_me
GMAIL_REDIRECT_URI=https://your-domain.example/api/auth/gmail/callback

AUTH_SECRET=replace_with_at_least_32_random_characters
ENCRYPTION_KEY=replace_with_64_hex_chars
OTP_PEPPER=replace_with_at_least_16_random_characters

SESSION_TTL_HOURS=720
OTP_TTL_MINUTES=10
OTP_DELIVERY_MODE=discord
POLLING_INTERVAL_MS=60000
DEFAULT_IMPORTANT_THRESHOLD=72
DEFAULT_CRITICAL_THRESHOLD=88

WHATSAPP_NOTIFICATIONS_ENABLED=false
```

## License And Ownership

Add your own license before publishing this repository publicly.

Before making the repository public, rotate any credential that was ever stored in a local file, pasted into chat, uploaded in logs, or exposed in screenshots.
