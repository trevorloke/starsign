# Zalo (Official Accounts)

Connector `zalo` · networks `["zalo"]` · `packages/connectors/src/zalo.ts` · factory `createZaloConnectors(env)`

Zalo is Vietnam's main messenger. Businesses reach people through a Zalo Official Account (OA). Starsign connects an OA:
it receives the messages people send to it, answers them, and publishes OA articles.

## What works
- **Connect** (`connectMethod: "oauth"`, OAuth v4 for OA with PKCE S256). Authorize
  `https://oauth.zaloapp.com/v4/oa/permission` (`app_id`, `redirect_uri`, `code_challenge`, `state`); token
  `https://oauth.zaloapp.com/v4/oa/access_token` (form: `app_id`, `code`, `grant_type`, `code_verifier`; header `secret_key` =
  app secret). The OA administrator picks the OA on Zalo's screen; the callback names it in `oa_id`, which must match the token's
  OA. `GET /v2.0/oa/getoa` gives the OA's id, name, avatar and verification. externalId = `oa_id`, handle = OA name, config
  `{ oaId, name, avatar, verified, broadcast }`. One login = one OA. `connectConfigured` needs `ZALO_APP_ID` and `ZALO_APP_SECRET`.
- **Connect form**: one question, "Also broadcast each new article to all followers? yes or no" (Starsign's OAuth form has no
  optional fields, so answer `no` to skip). It is kept in the account config as `broadcast`.
- **Refresh**: access tokens last about 25 hours; refresh tokens last about 3 months and are **single-use** (rotated on every
  refresh). Concurrent refreshes in one process share one request so the old token is never spent twice.
- **API calls**: `https://openapi.zalo.me`, header `access_token`. Responses are `{ error, message, data }`; `error` 0 is success.
- **Inbox (webhook)** `POST ${STARSIGN_PUBLIC_URL}/webhooks/zalo`: one app-level webhook for every OA authorised to the app.
  `X-ZEvent-Signature: mac=<hex sha256(app_id + raw body + timestamp + OA secret key)>`, checked in constant time; deliveries
  for another app id never verify. Events:
  - `user_send_text`, `user_send_image`, `user_send_gif`, `user_send_link`, `user_send_sticker`, `user_send_file`,
    `user_send_location`, `user_send_audio`, `user_send_video`, `user_send_business_card` → `dm` with conversation
    `{ id: sender id, type: "direct" }`. Non-text messages are summarised (`[Image]`, `[File: menu.pdf]`, `[Location: lat, lon]`);
    nothing is downloaded. externalId `<user id>:<msg_id>`.
  - `follow` → `follow`. `unfollow`, `oa_send_*`, `user_seen_message` and the rest are ignored.
  The batch goes to the OA named by `recipient.id` (or `oa_id`).
- **Reply** `POST /v3.0/oa/message/cs` (`recipient.user_id`, `message.text`): a customer-service message. Zalo allows these only
  for a limited time after the person last wrote to the OA; outside it Starsign returns a clear "the window has closed" error.
- **Publish** OA articles: `POST /v2.0/article/create` (`type: "normal"`, `title` from `options.title` (required), `author` = OA
  name, `cover` = `options.thumbnailUrl` or the first image (required), `description` = the first 300 characters, `body` = the text
  as HTML paragraphs plus `options.link` plus the other images, `status: "show"`, `comment: "show"`) → a token;
  `POST /v2.0/article/verify` turns it into the article id (polled up to 5 times with back-off; if still processing, a retryable
  error, and the retry resumes the same token instead of creating a second article). externalId `article:<id>`.
  With `broadcast` on, the article is then broadcast to followers (`POST /v2.0/oa/message`, article media template); a failed
  broadcast is reported in the result's `raw.broadcast` and does not fail the publish.
- **Metrics**: account only. `num_follower` from `getoa` → followers_total. No per-article statistics yet.
- **Errors**: −216/−124 (invalid or expired token) → auth; −213/−230 (not a follower / outside the reply window) → rejected with
  an explanation; −32 and quota messages → rate_limit retryable; other codes → rejected; HTTP failures use the shared mapping.

## What Starsign can and cannot see
Starsign sees the messages people send to the connected Official Account, and who follows it, from the moment the webhook is
set up. It does not see message history from before, people's personal chats, Zalo groups, or anything on personal Zalo
accounts (Zalo offers no official API for those). It cannot start a conversation: it can only answer someone who wrote to the OA
recently.

## Setup
1. At https://developers.zalo.me create an app and link it to the Official Account (the OA's admin must approve the link).
2. Official Account → settings: callback (redirect) URL `${STARSIGN_PUBLIC_URL}/oauth/zalo/callback`.
3. Webhook: URL `${STARSIGN_PUBLIC_URL}/webhooks/zalo`; turn on the user message events and `follow`. Copy the **OA Secret Key**
   shown there.
4. Request the OA API permissions the app needs (messages, articles, OA information).
- Env vars: `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OA_SECRET_KEY` (webhook signatures; without it every delivery is refused).

## Review and access requirements
- The app must be linked to the OA, and the OA's administrator authorises it. Some APIs (articles, broadcasts) need the OA to be
  verified or on a paid OA package. TODO(verify) which package unlocks which API in 2026.
- Zalo can review the app's webhook domain (domain verification file). TODO(verify).
- Before access is granted, calls fail with permission errors (mapped to rejected).

## Limits and quotas
- Customer-service replies: only within the window after the person's last message. TODO(verify) the current window (7 days per
  Zalo's 2023 policy; some sources say 48 hours) and per-message pricing on newer OA packages.
- Broadcasts: a monthly quota per OA (and per follower), set by the OA package.
- Article titles about 150 characters, descriptions about 300 (TODO(verify)). Text messages up to 2,000 characters.

## Unverified
- `TODO(verify)`: the exact webhook signature formula (`app_id + raw body + timestamp + OA secret key`, sha256 hex, `mac=` prefix)
  and whether "data" means the raw body.
- `TODO(verify)`: error codes (−216, −124, −14014, −14019, −213, −230, −32) and their meanings.
- `TODO(verify)`: the reply window (7 days or 48 hours).
- `TODO(verify)`: `/v2.0/article/verify` answers `{ data: { id } }` once processed and an error while processing.
- `TODO(verify)`: the broadcast endpoint and payload (`/v2.0/oa/message` with a target and an article media template); Zalo has been
  moving broadcasts to paid promotion messages.
- `TODO(verify)`: article field limits (title 150, description 300, author 50).
- `TODO(verify)`: a public URL for an OA article (the API returns only the id; url is null).

## Questions for the owner
- Should new articles be broadcast to followers by default? It uses the OA's monthly quota.
- Which OA package does each client have (it decides which APIs and quotas apply)?
- Do you want paid ZNS (Zalo Notification Service) template messages later? That is a separate business-messaging feature.
