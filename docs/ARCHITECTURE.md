# MailSync Clean Architecture

## Summary

MailSync is implemented as a TypeScript monorepo for a single VPS deployment. The system uses Express, React, discord.js, a worker process, Prisma, and MySQL. This replaces the contradictory PRD references to PostgreSQL, managed hosted databases, and provider-specific login assumptions.

## Services

- API service: OAuth, sessions, OTP, account settings, stats, health checks, and webhook intake.
- Dashboard: authenticated command center with dense analytics, account controls, and classification visibility.
- Worker: Gmail history/PubSub fan-in point, parser, sanitizer, AI/rule scorer, and metadata logger.
- Discord bot: slash commands, notification embeds, buttons for feedback/mute/snooze, and notification dispatch.
- MySQL: durable users, encrypted tokens, sessions, OTP logs, audit logs, settings, rules, and email classification metadata.

## Data Flow

1. User signs in with Discord OAuth.
2. User starts Gmail OAuth from the dashboard.
3. API receives Gmail callback, creates an OTP challenge, sends the code by Discord DM, and stores temporary token payload only in the OTP record.
4. User verifies OTP.
5. API encrypts Gmail access/refresh tokens and stores them in MySQL.
6. Worker receives a Gmail signal or polls history, extracts metadata and previews, classifies the message, and writes an email log.
7. Bot dispatches Discord notifications only for logs classified as important.
8. Dashboard reads `/api/stats` and `/api/accounts` for interactive analytics.

## Security Boundaries

- Discord user ID is the root account identity.
- Gmail accounts are always attached to an internal user ID.
- All dashboard APIs require a signed session token that is also present in the sessions table.
- OAuth state tokens are signed and scoped by purpose.
- Gmail tokens use AES-256-GCM encryption.
- OTP codes are delivered by Discord DM, use PBKDF2 hashing with a server pepper, five-attempt cap, and short expiry.
- Analytics store hashes and previews, not full email content.

## Gmail Scope Policy

The implementation uses read-only Gmail scopes:

- `openid`
- `email`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.metadata`

Because of that policy, the Discord notification does not include a "Mark as Read" action. It includes safe actions: Open in Gmail, Not important, Mute sender, and Snooze.

## Dashboard UX

The dashboard follows the provided references with a dark, dense command-center layout:

- Top-level counters for filtered mail, spam, important mail, and mail used for analytics.
- Timeline chart for classification volume.
- Donut chart for disposition distribution.
- Bar chart for importance categories.
- Connected mailbox panel with encryption trust cues.
- Recent classification stream.
- AI summary panel explaining current signal quality.

## Database Highlights

Important MySQL-backed entities:

- `User`
- `EmailAccount`
- `NotificationPreference`
- `AiThreshold`
- `SenderRule`
- `EmailLog`
- `Session`
- `OtpLog`
- `AuditLog`

`EmailLog.disposition` separates `IMPORTANT`, `SPAM`, `USED`, `LOW_VALUE`, and `DUPLICATE` so the dashboard can show the exact statistics requested.
