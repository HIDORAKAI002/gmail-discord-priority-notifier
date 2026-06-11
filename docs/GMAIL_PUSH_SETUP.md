# Gmail Push Notification Setup

MailSync can process new inbox mail in two modes:

- **Instant push mode:** Gmail publishes mailbox changes to Google Cloud Pub/Sub, and Pub/Sub calls `https://mambo.shammy.dev/api/webhooks/gmail`.
- **Fallback polling mode:** the worker checks Gmail every `POLLING_INTERVAL_MS`.

If `GMAIL_PUSH_ENABLED=false`, or if the topic/token are missing, MailSync is polling. No code change can make Gmail call the app until Pub/Sub is configured in Google Cloud.

## 1. Enable Google APIs

In the same Google Cloud project used for Gmail OAuth:

1. Enable **Gmail API**.
2. Enable **Cloud Pub/Sub API**.

## 2. Create A Pub/Sub Topic

Create a topic named:

```text
mailsync-gmail
```

The full topic value for `.env` must look like:

```env
GMAIL_PUBSUB_TOPIC=projects/YOUR_GOOGLE_PROJECT_ID/topics/mailsync-gmail
```

## 3. Grant Gmail Permission To Publish

On the Pub/Sub topic, grant this Google-managed service account the **Pub/Sub Publisher** role:

```text
gmail-api-push@system.gserviceaccount.com
```

Without this permission, Gmail `watch` renewal will fail and no instant notifications will arrive.

## 4. Create A Push Subscription

Create a Pub/Sub subscription attached to the `mailsync-gmail` topic.

Use **Push** delivery and set the endpoint to:

```text
https://mambo.shammy.dev/api/webhooks/gmail?token=YOUR_LONG_RANDOM_TOKEN
```

Use the same token in `.env`:

```env
GMAIL_PUBSUB_VERIFICATION_TOKEN=YOUR_LONG_RANDOM_TOKEN
```

Generate a token locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Set Pterodactyl Env

Set these in the private Pterodactyl `.env`:

```env
GMAIL_PUSH_ENABLED=true
GMAIL_PUBSUB_TOPIC=projects/YOUR_GOOGLE_PROJECT_ID/topics/mailsync-gmail
GMAIL_PUBSUB_VERIFICATION_TOKEN=YOUR_LONG_RANDOM_TOKEN
GMAIL_PUSH_SYNC_INTERVAL_MS=2500
GMAIL_WATCH_RENEWAL_HOURS=24
POLLING_INTERVAL_MS=60000
```

Keep polling enabled as a safety fallback. With push configured, it should rarely be the path that finds new mail.

## 6. Restart And Confirm

Restart the Pterodactyl server.

Expected log after restart:

```text
Gmail push watch renewed for user@example.com
```

Expected log after a new inbox message:

```text
worker push sync: 1 account(s), 1 new email(s), 0 WhatsApp alert(s)
```

In the dashboard settings page, each mailbox should show **Instant Gmail push active**. If it shows **Fallback polling active until Pub/Sub is configured**, one of these is missing:

- `GMAIL_PUSH_ENABLED=true`
- `GMAIL_PUBSUB_TOPIC`
- `GMAIL_PUBSUB_VERIFICATION_TOKEN`
- Pub/Sub push subscription pointed at the MailSync webhook
- Gmail publisher permission on the topic

## 7. Reconnect Gmail If Needed

MailSync renews Gmail `watch` for active connected accounts. If a mailbox was connected before push setup and does not renew cleanly after restart, remove and reconnect that Gmail account from the dashboard.

