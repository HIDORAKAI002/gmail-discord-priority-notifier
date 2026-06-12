# Gmail Push Notification Setup

MailSync can process new inbox mail in two modes:

- **Instant push mode:** Gmail publishes mailbox changes to Google Cloud Pub/Sub, and Pub/Sub calls `https://your-domain.example/api/webhooks/gmail`.
- **Fallback polling mode:** the worker checks Gmail every `POLLING_INTERVAL_MS`.

If `GMAIL_PUSH_ENABLED=false`, or if the topic/token are missing, MailSync is polling. No code change can make Gmail call the app until Pub/Sub is configured in Google Cloud.

## 1. Fast Cloud Shell Setup

Open Google Cloud Shell in the same Google Cloud project used for Gmail OAuth:

```text
https://console.cloud.google.com/?project=YOUR_GOOGLE_PROJECT_ID&cloudshell=true
```

Paste this block, replacing `YOUR_GOOGLE_PROJECT_ID` and `YOUR_DOMAIN`:

```bash
PROJECT_ID="YOUR_GOOGLE_PROJECT_ID"
TOPIC_ID="mailsync-gmail"
SUB_ID="mailsync-gmail-push"
TOKEN="$(openssl rand -hex 32)"
ENDPOINT="https://YOUR_DOMAIN/api/webhooks/gmail?token=${TOKEN}"

gcloud config set project "$PROJECT_ID"
gcloud services enable pubsub.googleapis.com gmail.googleapis.com

gcloud pubsub topics create "$TOPIC_ID" || true

gcloud pubsub topics add-iam-policy-binding "$TOPIC_ID" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud pubsub subscriptions create "$SUB_ID" \
  --topic="$TOPIC_ID" \
  --push-endpoint="$ENDPOINT" || true

echo ""
echo "PUT THESE IN YOUR SERVER .env:"
echo "GMAIL_PUSH_ENABLED=true"
echo "GMAIL_PUBSUB_TOPIC=projects/${PROJECT_ID}/topics/${TOPIC_ID}"
echo "GMAIL_PUBSUB_VERIFICATION_TOKEN=${TOKEN}"
echo "GMAIL_PUSH_SYNC_INTERVAL_MS=2500"
echo "POLLING_INTERVAL_MS=60000"
```

Copy the printed env values into your server `.env`, restart, and confirm the worker logs show Gmail watch renewal.

## 2. Manual Google Cloud Setup

Use this section only if you prefer clicking through the Google Cloud UI.

### Enable Google APIs

In the same Google Cloud project used for Gmail OAuth:

1. Enable **Gmail API**.
2. Enable **Cloud Pub/Sub API**.

### Create A Pub/Sub Topic

Create a topic named:

```text
mailsync-gmail
```

The full topic value for `.env` must look like:

```env
GMAIL_PUBSUB_TOPIC=projects/YOUR_GOOGLE_PROJECT_ID/topics/mailsync-gmail
```

### Grant Gmail Permission To Publish

On the Pub/Sub topic, grant this Google-managed service account the **Pub/Sub Publisher** role:

```text
gmail-api-push@system.gserviceaccount.com
```

Without this permission, Gmail `watch` renewal will fail and no instant notifications will arrive.

### Create A Push Subscription

Create a Pub/Sub subscription attached to the `mailsync-gmail` topic.

Use **Push** delivery and set the endpoint to:

```text
https://YOUR_DOMAIN/api/webhooks/gmail?token=YOUR_LONG_RANDOM_TOKEN
```

Use the same token in `.env`:

```env
GMAIL_PUBSUB_VERIFICATION_TOKEN=YOUR_LONG_RANDOM_TOKEN
```

Generate a token locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Set Server Env

Set these in the server `.env`:

```env
GMAIL_PUSH_ENABLED=true
GMAIL_PUBSUB_TOPIC=projects/YOUR_GOOGLE_PROJECT_ID/topics/mailsync-gmail
GMAIL_PUBSUB_VERIFICATION_TOKEN=YOUR_LONG_RANDOM_TOKEN
GMAIL_PUSH_SYNC_INTERVAL_MS=2500
GMAIL_WATCH_RENEWAL_HOURS=24
POLLING_INTERVAL_MS=60000
```

Keep polling enabled as a safety fallback. With push configured, it should rarely be the path that finds new mail.

## 4. Restart And Confirm

Restart the server.

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

## 5. Reconnect Gmail If Needed

MailSync renews Gmail `watch` for active connected accounts. If a mailbox was connected before push setup and does not renew cleanly after restart, remove and reconnect that Gmail account from the dashboard.
