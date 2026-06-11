# VPS Deployment Guide

## Prerequisites

- Node.js 20 LTS
- MySQL 8
- Optional Redis 7
- Nginx or Caddy for TLS/reverse proxy
- Discord application and bot token
- Google OAuth client with Gmail API enabled
- Gemini and Groq API keys if AI scoring should go beyond the local rule engine

## Environment

Create `.env` from `.env.example` and set:

- `DATABASE_URL`
- `AUTH_SECRET`
- `ENCRYPTION_KEY`
- `OTP_PEPPER`
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`

## Install

```bash
npm install
npm run db:generate
npm run db:push
npm run build
```

## Process Layout

For Pterodactyl with `ghcr.io/pterodactyl/yolks:nodejs_20`, use this startup command:

```bash
node pterodactyl-start.js
```

The script installs dependencies, generates Prisma, pushes the MySQL schema, builds all packages, then starts API, bot, and worker together. The API serves the built dashboard on the same public port in production.

If you ever run the process manually, the final runtime command is:

```bash
npm run start:prod
```

## Public OAuth URLs

Use callback URLs that match your own public domain:

```text
https://your-domain.example/api/auth/discord/callback
https://your-domain.example/api/auth/gmail/callback
```

Google OAuth testing mode still requires adding your Gmail address under Audience -> Test users.

For production, prefer process manager entries that set the working directory to the repo root and load the same `.env` file.

## Reverse Proxy

- Route `/api/*`, `/webhook/*`, and `/health*` to the API service.
- Route dashboard traffic to the built dashboard preview/static server or serve `apps/dashboard/dist` directly.
- Use HTTPS for all OAuth callbacks.

## Migration Policy

Use Prisma migrations once the first production database exists:

```bash
npm run db:migrate
```

For early development against a disposable DB:

```bash
npm run db:push
```
