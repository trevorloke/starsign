# WeCom (企业微信)

Connector `wecom` · networks `["wecom"]` · `packages/connectors/src/wecom.ts` (uses `wechat-crypto.ts`) · factory `createWeComConnectors(env)`

Uses WeCom's official server API (`qyapi.weixin.qq.com`) only. No personal-account automation, no web-client scraping, no hooks into the WeCom or WeChat desktop apps.

One Starsign account holds up to two parts, each optional:

- **WeChat Customer Service (微信客服)**: the official way for a business to chat with WeChat users. Customers tap a link or scan a QR code inside WeChat and talk to the business; they stay in WeChat, the business answers from WeCom or through the API. Starsign listens and replies.
- **Group bot (群机器人)**: a webhook that posts into one internal WeCom group. Starsign publishes there; bots cannot read.

An account with only a bot URL is publish-only. An account with only customer service is listen and reply only.

## What Starsign can and cannot see
- **Customer service chats: yes.** Messages customers send to your WeChat Customer Service account (text, plus short summaries of images, voice, video, files, locations, links and mini programs, and a note when a customer opens the chat), with the customer's WeChat nickname when WeCom provides it. Starsign can answer them within WeCom's limits (48 hours, 5 messages).
- **Internal WeCom groups: posting only, through group bots.** A bot can post into the group it was added to. It cannot read anything in the group.
- **External customer groups (客户群): not here.** WeCom's customer-contact APIs give group metadata (name, owner, members) only. Message contents are available only through the paid **会话内容存档 (conversation content archive)**, which needs the archive licence, member consent notices, and WeCom's native C/C++ SDK with an RSA key pair. Starsign does not support it.
- **Personal WeChat chats and personal WeChat groups: never.** No official API exposes them, and Starsign does not use unofficial tools that log in as a personal account (they get accounts banned).
- Starsign does not see customer phone numbers or real names; the customer id is WeCom's opaque `external_userid`.

## What works
- **Connect** (`connectMethod: "api_key"`), every input optional, at least one part required:
  - Customer service: `corpId` (CorpID, `ww…`), `kfSecret` (secret; the Customer Service Secret from 微信客服 → API), `token` (secret; the callback Token), `encodingAesKey` (secret; 43 characters), `openKfId` (optional; the customer service account `wk…`, default: the first one from `kf/account/list`). If any of these is filled, the first four are required.
  - Group bot: `botWebhookUrl` (secret; `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`).
  - `connectWithInputs` validates formats (never echoing values). Customer service is checked by `GET /cgi-bin/gettoken?corpid&corpsecret` and `POST /cgi-bin/kf/account/list` `{ offset: 0, limit: 100 }` (proves the secret, the trusted IP and API access, and resolves/validates `open_kfid`). A bot URL cannot be checked without posting into the group, so only its shape is validated.
  - Identity: externalId = CorpID when customer service is set (handle and displayName = the customer service account's name); bot-only: externalId = `bot-<first 16 hex of sha256(key)>` (the key itself is secret), handle "WeCom group bot".
  - Auth blob: `{ corpId?, kfSecret?, token?, encodingAesKey?, openKfId?, botKey? }`. Config: `{ parts: ["customer_service"?, "group_bot"?], corpId?, openKfId?, webhookUrl? }` where `webhookUrl` is the callback URL to paste into WeCom.
- **Access token**: `/cgi-bin/gettoken`, cached in memory per CorpID + secret (7200 s, renewed 5 minutes early; concurrent calls share one fetch). On 40014/41001/42001 the token is refetched once and the call retried.
- **Callback** (`/webhooks/wecom?account=<CorpID>`, per-account Token and AES key):
  - `route`: `?account=` (must look like a CorpID), else the envelope's `ToUserName`.
  - `challengeAccount` (GET URL check): `msg_signature == sha1(sort([token, timestamp, nonce, echostr]))` (constant time), timestamp within 5 minutes; `echostr` is decrypted (AES-256-CBC with the EncodingAESKey, receiveid = CorpID, via `wechat-crypto.ts`) and the plaintext is the answer. An echostr encrypted for another CorpID gives no answer.
  - `verifyAccount`: `msg_signature == sha1(sort([token, timestamp, nonce, Encrypt]))`, timestamp within 5 minutes. Unencrypted deliveries are refused.
  - `decodeAccount`: decrypts `Encrypt` (the trailing receiveid must equal the account's CorpID).
  - `parse`: the callback only says "new messages" (`MsgType=event`, `Event=kf_msg_or_event`, `Token`, `OpenKfId`). Parse is synchronous, so it stores the sync `Token` (valid 10 minutes) for that CorpID + open_kfid and returns **no items**. `ack`: empty body, HTTP 200.
- **Listening** (`fetchActivity`, run by the workers' ingest job every 5 minutes): `POST /cgi-bin/kf/sync_msg` `{ cursor?, token?, limit: 1000, voice_format: 0, open_kfid }`, following `next_cursor` while `has_more` (up to 10 pages). It uses the callback's token when one arrived in the last ~9 minutes (sync_msg without a token is strictly rate limited); if WeCom rejects the token, the pull is repeated without it. The cursor is kept in memory per account + open_kfid; after a restart (no cursor) sync_msg returns the last 3 days and only messages newer than `since` are returned (core dedupes the rest). Customer nicknames come from `POST /cgi-bin/kf/customer/batchget` (best effort, cached; a permission error leaves `authorName` null).
  - Mapping (only customer messages, `origin: 3`; staff replies `origin: 5` and other system events are skipped): `text` → its content; `image`/`voice`/`video`/`file` → `[image]` etc. (media ids stay in `raw`); `location` → `[location] <name>, <address> (lat, lng)`; `link` → `[link] <title> <desc> <url>` (url set); `miniprogram` → `[mini program] <title>`; other types → `[<type>]`; event `enter_session` → `[opened the chat from scene <scene> (<scene_param>)]`. All are kind `"dm"`, `conversation: { id: external_userid, type: "direct" }`, `authorHandle` = external_userid, `occurredAt` from `send_time`, externalId **`<open_kfid>:<external_userid>:<msgid>`**.
- **reply**: `POST /cgi-bin/kf/send_msg` `{ touser, open_kfid, msgid, msgtype: "text", text: { content } }`, with the customer and account read from the parent's externalId. `msgid` is derived from the idempotency key (32 hex) so WeCom can refuse a repeat; idempotent in-process too. Result externalId `<open_kfid>:<external_userid>:<msgid>`.
- **publish (group bot)**: `POST /cgi-bin/webhook/send?key=…`.
  - With `options.link` and a title (`options.title`, or `kind: "link"` with the first line as title): one **news card** `{ msgtype: "news", news: { articles: [{ title, description, url, picurl? }] } }` (picurl = the first image's public URL).
  - Otherwise: a **markdown** message with the text (WeCom markdown: headings, bold, links, quotes, font colours), with `options.link` appended when not already in the text; then each image as `{ msgtype: "image", image: { base64, md5 } }` (md5 of the raw bytes; JPG/PNG up to 2 MB). If an image fails after the text went out, the error carries `partial`.
  - No message id comes back; externalId = `<bot account id>:<hash of the idempotency key>`, url null.
- **Errors** (HTTP 200 with `errcode`): -1 → network retryable; 40001 (secret) / 40013 (CorpID) → auth; 40014/41001/42001 → auth after one refresh; 60020 → rejected "add this server's IP as a trusted IP"; 48002 → rejected (API not enabled for this secret); 45009/45033 → rate_limit retryable; 95018 → rejected "only within 48 hours / 5 messages, and only while the chat is new or handled by the API, not by staff or after it ended"; 95001 → rejected (5-message cap); 95013 → rejected (session ended); 95000/95004 → rejected (unknown open_kfid); 95007/95008 → bad sync token; 93000/93004 → auth (bot URL invalid / bot removed). Secrets, access tokens and the bot key are scrubbed from error text; URLs are never included.
- **Not supported**: `moderate`, metrics (WeCom gives none for these messages), account metrics, reading internal or customer groups, files/voice/video through the bot.

## Setup
Customer service (微信客服):
1. WeCom admin console (work.weixin.qq.com) → **应用管理 → 微信客服** (or the standalone 微信客服 admin at kf.weixin.qq.com): create a customer service account and note its ID if you have several.
2. 微信客服 → **API**: enable API access, note the **Secret** (the Customer Service Secret), and set the **callback**: URL = `${STARSIGN_PUBLIC_URL}/webhooks/wecom?account=<CorpID>`, Token and EncodingAESKey (generate them there). Save after connecting in Starsign (step 4), because WeCom checks the URL when you save.
3. Add the Starsign servers' static outbound IPs as **trusted IPs (企业可信IP)** for the customer service API.
4. In Starsign, connect WeCom with CorpID (My Company → Company Information → 企业ID), the Secret, Token, EncodingAESKey and optionally the customer service account ID. Then save the callback in WeCom.
5. Hand the customer service link or QR code to customers (in WeChat, on the website, in a mini program).
6. When an account is managed by the API, its chats are handled by the API/bot ("智能助手") until a staff member takes over in WeCom. Starsign's replies work while the chat is new or with the API; once a person is handling it in WeCom, the API cannot send (95018).

Group bot (群机器人):
1. In the WeCom client, open the internal group → **group settings → 群机器人 → 添加机器人** → create a new bot.
2. Copy its **webhook URL** and paste it into Starsign's "Group bot webhook URL". Anyone with the URL can post into the group: treat it as a secret.

- Redirect URI: none (not OAuth).
- Webhook URL: `${STARSIGN_PUBLIC_URL}/webhooks/wecom?account=<CorpID>` (customer service only). It must answer within 5 seconds from WeCom's servers in China; the URL check must be answered within 1 second.
- Env vars: `STARSIGN_PUBLIC_URL`; optional `WECOM_API_BASE` (default `https://qyapi.weixin.qq.com`).

## Review and access requirements
- A WeCom organisation. WeChat Customer Service needs the organisation to be **verified (企业认证)** for meaningful use (unverified organisations have low limits on accounts and reception); verification takes days to a couple of weeks and costs a fee.
- The customer service API is enabled by the admin in 微信客服 → API; the Secret is visible only to admins. No WeCom app review is involved.
- Group bots need no approval; some organisations disable adding bots to groups (admin setting).
- Before verification or with API access off: customer service connect fails at `kf/account/list` with a clear error; the bot still works.
- Mainland-China realities: the callback must be reachable and fast from mainland China (a mainland or Hong Kong region helps; a mainland server needs an ICP filing). Outbound calls must come from the trusted IPs: serverless or autoscaled hosts need a NAT gateway with static IPs.

## Limits and quotas
- Customer service replies: within **48 hours** of the customer's last message, at most **5 messages** until they write again.
- sync_msg: messages from the last **3 days** only; `limit` up to 1000 per page; without the callback token the call is strictly rate limited. Media over the size limits (image 2 MB, voice 2 MB, video 10 MB, file 20 MB) arrive as a text notice.
- Access tokens: 7200 s; gettoken is rate limited (cache it, as Starsign does).
- Group bot: **20 messages per minute** per bot; markdown up to 4096 bytes; text up to 2048 bytes; images JPG/PNG up to 2 MB before base64; news cards 1–8 articles (Starsign sends one), titles over 128 bytes and descriptions over 512 bytes are cut.
- Starsign's shared limits for `wecom`: 2048 characters, 1 media item.

## Unverified
Sources reachable from the build sandbox were search results only (developer.work.weixin.qq.com and developers.weixin.qq.com could not be fetched). Marked `// TODO(verify)` in code:
- CorpID shape `ww`/`wx` + 16 characters; Customer Service Secret shape (accepted loosely); `open_kfid` starts with `wk`.
- Error codes: 60020 (untrusted IP), 95000/95004 (open_kfid), 95001 (5-message cap), 95007/95008 (sync token), 95013 (session ended), 93000/93004 (bot key). Only 95018 ("send msg session status invalid") was seen in search results.
- `kf/send_msg` accepting a caller-chosen `msgid` (≤ 32 chars) and refusing a repeat.
- The callback answer: an empty 200 body is assumed sufficient for `kf_msg_or_event` deliveries.
- Whether WeCom keeps the `?account=` query on the callback URL when it adds `msg_signature`, `timestamp`, `nonce` (route falls back to the envelope's `ToUserName` either way).
- News card title/description byte limits; bot rate-limit errcode (45009 assumed).
- Confirmed via search results: sync_msg request/response fields (`cursor`, `token` valid 10 minutes, `limit` ≤ 1000, `voice_format`, `open_kfid`, `next_cursor`, `has_more`, `msg_list`, `origin` 3/4/5), 3-day window, media size notices; kf/account/list paging; 48-hour/5-message rule; callback URL check steps (verify msg_signature, decrypt echostr, answer the plaintext within 1 s); bot image base64+md5 ≤ 2 MB JPG/PNG, 20 messages/minute, news 1–8 articles.

## Core change that would allow an immediate pull
Today the callback can only store the sync token; messages land at the next ingest run (up to 5 minutes later). Core would need one of: (a) an async webhook hook, e.g. `webhook.pull?(account, body): Promise<ActivityInput[]>`, awaited by `WebhookService.receiveRouted` after `decodeAccount` (WeCom expects the 200 within 5 seconds, so core could also answer first and pull in the background); or (b) a way for a webhook to enqueue an immediate `ingestAccount(accountId)` for the verified account. A persisted per-account connector cursor (instead of process memory) would also stop a restart from re-reading 3 days. The in-memory sync token is only useful when the API process (which receives callbacks) and the worker (which ingests) share a process; otherwise the worker pulls without a token, which works but is rate limited.

## Questions for the owner
- Is your WeCom organisation verified, and do you already use WeChat Customer Service? Which customer service account(s) should Starsign answer for? (One Starsign account per CorpID, with one customer service account.)
- Is anything else (a CRM, another vendor) already receiving the customer service callback? Only one callback URL can be set; Starsign would replace it.
- Should staff still answer some chats in WeCom? While a person handles a chat there, Starsign's API replies are refused.
- What are the static outbound IPs of the Starsign servers (for the trusted IP list), and where is Starsign hosted for the 5-second callback from mainland China?
- Which internal groups should get group bots, and who may see the bot URLs?
- Do you need customer-group (客户群) monitoring? That needs the paid 会话内容存档 and WeCom's native SDK, which this connector does not cover.
