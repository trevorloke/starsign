# Viber (Channels and bots)

Connector `viber` · networks `["viber"]` · `packages/connectors/src/viber.ts` · factory `createViberConnectors(env)`

Viber is widely used in Ukraine, the Balkans, Greece, Eastern Europe, the Philippines and Myanmar. Starsign connects two kinds of
Viber account, chosen in the connect form:

- **Viber Channel**: a broadcast channel. Starsign posts to it. Channels have no inbox.
- **Viber Bot**: a business chatbot. Starsign receives what people send it and answers. Since February 2024 Viber gives new bots
  only to businesses with a commercial agreement with Viber, and messages a bot sends are charged. Use a bot only if you already
  have one or have signed that agreement.

## What works
- **Connect** (`connectMethod: "bot_token"`). Inputs: `authToken` (secret) and `kind` (optional: `channel` or `bot`, default
  `channel`). `POST https://chatapi.viber.com/pa/get_account_info` (header `X-Viber-Auth-Token`) gives the account id, name, uri,
  `subscribers_count` and `members`.
  - Channel: the first member with role `superadmin` is the sender (`from`) of every post; a token without a superadmin is refused.
  - externalId = account id (`pa:…`), handle = uri, config `{ kind, accountId, name, uri, from, subscribersCount, webhookUrl,
    webhookSet }`.
- **Webhook**: with `STARSIGN_PUBLIC_URL` set, Starsign calls `set_webhook` with
  `${STARSIGN_PUBLIC_URL}/webhooks/viber?account=<account id>` (bots also subscribe to `subscribed`, `unsubscribed`,
  `conversation_started`, `delivered`, `seen`, `failed`). Viber checks the URL at once; on first connect that check usually fails
  because the account is not saved yet, so Starsign sets it again on the first poll (`fetchActivity`, once per process) and when a
  post is refused with status 10 (webhook not set; the post is then retried once). Channels need a webhook before Viber accepts
  posts.
- **Signatures**: `X-Viber-Content-Signature` = hex HMAC-SHA256 of the raw body with that account's auth token, checked in constant
  time. The handler uses `route` (the `account` query parameter) + `verifyAccount`, so a delivery verifies only against the
  account it names. 64-bit `message_token` values are read as strings so no digits are lost.
- **Inbox (bots)**: `message` callbacks (text, picture, video, file, location, contact, sticker, url) → `dm` with conversation
  `{ id: sender id, name: sender name, type: "direct" }`; non-text messages are summarised (`[Picture] caption`, `[File: price.pdf]`,
  `[Location: lat, lon]`, `[Contact: name]` without the phone number). `subscribed` → `follow`. `conversation_started`,
  `unsubscribed`, `delivered`, `seen`, `failed` and `webhook` are ignored. externalId `<user id>:<message token>`.
  Viber accepts any 200 response, so no special acknowledgement is needed.
- **Reply (bots)** `POST /pa/send_message` (`receiver`, `min_api_version: 1`, `sender.name` = account name cut to 28 characters,
  `type: "text"`). Channels refuse replies (no inbox).
- **Publish (channels)** `POST /pa/post` with `from` = the superadmin:
  - text (with `options.link` appended); a bare link (no text) → `type: "url"`;
  - image or GIF → `type: "picture"` with the text as caption when it fits (≤ 768 characters; otherwise a text message first),
    `options.thumbnailUrl` as `thumbnail`;
  - video → a text message (if any), then `type: "video"` with `media`, `size` (from the media record or the media fetcher, required),
    `duration`, `thumbnail`;
  - document → `type: "file"` with `size` and `file_name`.
  Media are fetched by Viber from their public HTTPS URLs; nothing is uploaded. externalId `<channel id>:<message token>`; extra
  messages are thread ids. Idempotent in-process. Bot accounts cannot publish (validation says so).
- **Metrics**: account only. `subscribers_count` from `get_account_info` → followers_total. Viber reports no per-post statistics
  through the API.
- **Errors** `{ status, status_message }`, 0 = ok: 2 (invalid token) → auth; 7/8/9/15 (blocked, not found, suspended, not
  authorised) → auth; 12 (too many requests) → rate_limit retryable; 5/6/11 (not registered, not subscribed, no suitable device) →
  rejected; 10 (webhook not set) → rejected after one automatic retry; 23/24 (free messages exceeded, no balance) → rejected; the
  rest → rejected. HTTP failures use the shared mapping.

## What Starsign can and cannot see
For a **channel**: nothing comes back. Viber sends no callbacks for channel posts, reactions or comments, so Starsign only publishes
and reads the subscriber count. For a **bot**: the messages people send to the bot and who subscribes, from the moment the webhook is
set. Starsign never sees Viber group chats, Communities, personal chats, or message history from before the webhook.

## Setup
- **Channel**: in the Viber app (17.7 or later), as a channel superadmin: Channel settings → Developer tools → copy the token.
- **Bot**: the bot's token from the Viber Admin Panel (partners.viber.com), available to bots under a commercial agreement.
- In Starsign: connect Viber, paste the token, type `channel` or `bot`.
- Webhook URL (set automatically): `${STARSIGN_PUBLIC_URL}/webhooks/viber?account=<account id>`. HTTPS with a certificate from a
  public CA is required (Viber rejects self-signed certificates).
- Env vars: none required. `STARSIGN_PUBLIC_URL` lets Starsign set webhooks; `VIBER_API_BASE` is an optional override.

## Review and access requirements
- Channels: only superadmins get API access; no review.
- Bots: since 2024, a commercial agreement with Viber (or a Viber partner) is required for new bots, with monthly fees and
  per-message charges for messages the bot initiates. Existing bots keep working under the new billing. TODO(verify) the current
  terms and whether replies within a session the person started are free.

## Limits and quotas
- Text up to 7,000 characters; picture captions up to 768; videos MP4 (H.264) up to 50 MB and 180 seconds; files up to 50 MB;
  thumbnails JPEG up to 100 KB; sender name up to 28 characters. TODO(verify) against the current reference.
- Rate limits are not published; status 12 means slow down.

## Unverified
- `TODO(verify)`: the limits above.
- `TODO(verify)`: which `event_types` a channel webhook accepts (none are sent for channels).
- `TODO(verify)`: channels report their audience in `subscribers_count` (bots certainly do).
- `TODO(verify)`: bot billing terms in 2026.

## Questions for the owner
- Do any clients have a Viber bot under a commercial agreement, or only channels?
- Should a long post with a picture go as two messages (text, then picture) as today, or be cut to fit the caption?
