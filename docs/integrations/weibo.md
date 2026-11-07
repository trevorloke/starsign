# Weibo (微博)

Connector `weibo` · networks `["weibo"]` · `packages/connectors/src/weibo.ts` · factory `createWeiboConnectors(env)`

Uses the official Weibo Open Platform (open.weibo.com) API on `api.weibo.com` only: OAuth 2.0 and the v2 REST API.
No web-client scraping, no cookie logins.

## What works
- **Connect** (`connectMethod: "oauth"`): `https://api.weibo.com/oauth2/authorize` (client_id, redirect_uri, state;
  no scope by default) → `POST https://api.weibo.com/oauth2/access_token` through `OAuth2Client` → `POST
  oauth2/get_token_info` for the uid and the seconds left on the token (`expire_in`) → `users/show` for the name.
  One login = one Weibo user (enterprise 蓝V accounts are ordinary users; there is no multi-account login).
  Auth blob: `{ accessToken, uid, expiresAt, scope? }`. Config: `{ uid, securityDomain? }`. `describeAccount` reads
  `users/show`: externalId = uid, handle and displayName = `screen_name` / `name`.
- **Tokens**: Weibo gives web apps a long-lived access token and **no refresh token**. Starsign stores the expiry.
  `refreshAuth` returns null (nothing to renew). After the expiry every call fails with `auth` before reaching Weibo,
  and Weibo's own expired/revoked codes also map to `auth`, so core marks the account "reconnect required" and the
  person logs in again.
- **Publish** (`statuses/share`, the posting endpoint Weibo opens to third-party apps): text, plus one picture sent as
  multipart `pic`. `options.link` is appended to the text when it is not already in it. In-process idempotency.
  Result: externalId = `idstr`, url = `https://weibo.com/<uid>/<mid>`. A `replyToExternalId` publish becomes a comment
  (same as `reply`).
- **The security-domain rule.** `statuses/share` only accepts text that contains at least one link to the app's
  registered **security domain** (安全域名, in the app's settings on open.weibo.com). Without it Weibo refuses the post
  (error 10017 "text not find domain"). Starsign checks this before calling Weibo:
  - no link at all in the text (or `options.link`) → validation issue and `rejected` error, with the rule explained;
  - when `WEIBO_SECURITY_DOMAIN` (or the account config `securityDomain`) is set, at least one link must be on that
    domain or a subdomain (e.g. `acme.com` accepts `https://www.acme.com/x`);
  - if Weibo still refuses with 10017 "domain", the error repeats the rule.
  In practice: every Weibo post from Starsign carries a link to your site (a tracked short link on your domain works
  if the short-link domain is the security domain, or a subdomain of it).
- **Inbox** (`fetchActivity`): `comments/to_me` (comments on your posts) → `comment`; `statuses/mentions` (posts that
  @mention you) → `mention`; `comments/mentions` (comments that @mention you) → `mention`. Each timeline is read with
  `since_id` (the highest id seen, kept in memory) or, after a restart, back to `since`, at most 3 pages of 50.
  externalId = `idstr`; parentExternalId = the comment it replies to, else the post it is on; url =
  `https://weibo.com/<uid>/<mid>` of the post; authorHandle = `screen_name`. Your own comments are skipped. Ids are
  64-bit and kept exact (big integers are quoted before JSON parsing).
- **Reply**: to a comment → `comments/reply` (cid + the post id, learned from the inbox or looked up with
  `comments/show_batch`); to a post → `comments/create`. `"<postId>:<commentId>"` is also accepted.
- **Moderate**: `delete` → `comments/destroy` (your own comments, and comments on your posts). Hide/like are not
  available through the API and return `rejected`.
- **Metrics**: `statuses/count` (up to 100 ids per call): `reposts` → reposts, `comments` → replies, `attitudes`
  (likes) → likes, and their sum → engagements. Account: `users/show` `followers_count` → `followers_total`.
- **Errors** (`{ error_code, error }`, code wins over HTTP status): 21301/21314–21317/21319/21327/21332/21501 → `auth`
  (token expired or revoked); 10022/10023/10024/20016 → `rate_limit` (retryable); 10001/10002/10003/10009/10011 and
  HTTP 5xx → `network` (retryable); 20019/20017/20111 (duplicate or similar content), 20012, 20018, 20020, 20021,
  20101, 20206, 10014 (API not granted to the app), 21321 (unaudited app) → `rejected` with an explanation. The access
  token is never put in error messages.
- **Not supported**: video (not open to third-party apps), multiple pictures, threads, webhooks (Weibo's push
  subscription is for partners), DMs.

## What Starsign can and cannot see
Starsign sees comments on the connected account's posts and posts and comments that @mention it. It does not see
keyword searches across Weibo (the search APIs are commercial/partner-only), other people's timelines, likes by
name, or private messages.

## Setup
1. Register as a developer on **open.weibo.com** (a Weibo account with a verified mainland phone number; enterprise
   developer verification is recommended) and create a **website app (网站应用)**.
2. In the app's settings:
   - **授权回调页 (redirect URI)**: `${STARSIGN_PUBLIC_URL}/oauth/weibo/callback`. Also set the cancel-authorization page.
   - **安全域名 (security domain)**: the domain your posts will link to (e.g. `acme.com`). Set the same value as
     `WEIBO_SECURITY_DOMAIN` so Starsign checks it before posting.
   - Add test users (测试账号) while the app is unaudited.
3. Copy the App Key and App Secret into the environment.
- Redirect URI: `${STARSIGN_PUBLIC_URL}/oauth/weibo/callback`.
- Webhook URL: none (Weibo does not push to ordinary apps; Starsign polls).
- Scopes: none requested by default (the basic grant covers the endpoints used). Set `WEIBO_SCOPES` only if Weibo asks
  for a specific scope for an advanced interface.
- Env vars: `WEIBO_APP_KEY`, `WEIBO_APP_SECRET` (also read as `WEIBO_CLIENT_ID` / `WEIBO_CLIENT_SECRET`),
  `WEIBO_SECURITY_DOMAIN` (recommended), optional `WEIBO_SCOPES`, `WEIBO_API_BASE`.

## Review and access requirements
- **App review (应用审核)**: until the app passes review, only the app's developer and its listed test users can
  authorize it (21321 otherwise), and tokens are short (about a day). Review asks for a working website on an
  ICP-filed domain in most cases, a description and screenshots. Typical time: days to a few weeks.
- **Advanced interfaces (高级接口)**: `comments/to_me`, `statuses/mentions` and `comments/mentions` are classed as
  advanced on many apps and must be requested separately; until granted they return 10014 and the inbox stays
  empty (publishing and metrics still work).
- **Token lifetime depends on the app's level**: test apps about 1 day; reviewed apps longer (weeks to years
  depending on level). Weibo has no refresh token for web apps, so people reconnect when it runs out.
- **Mainland-China realities**: open.weibo.com developer registration effectively needs a mainland phone number and,
  for review, usually a mainland-filed (ICP 备案) website. `api.weibo.com` is reachable from outside China but with
  variable latency and occasional blocking of non-mainland IPs; a Hong Kong or mainland egress is more reliable.
  Data obtained through the API is subject to Weibo's developer agreement and China's personal-information rules
  (PIPL); keep stored commenter data to what the inbox needs.

## Limits and quotas
- Rate limits are per user token and per app per hour (10022 IP, 10023 user, 10024 user per API); posting has its own
  tighter cap (20016). Starsign treats them as retryable.
- `statuses/share`: one picture (JPEG/PNG/GIF, under 5 MB); text limit per `NETWORK_LIMITS.weibo.maxText` (2000).
- `statuses/count`: 100 ids per call. Timelines: 50 per page here, 3 pages per poll.

## Unverified
- `// TODO(verify)` Weibo's token endpoint is documented with parameters on the POST URL; `OAuth2Client` sends them
  as a form body (as Weibo SDKs do).
- `// TODO(verify)` statuses/share picture limit (5 MB; JPEG, GIF, PNG) and whether `rip` (end-user IP) is required.
- `// TODO(verify)` statuses/share text limit: older docs say 140 Chinese characters and "no #topic# tags"; current
  posts allow 2000. Starsign does not block topics; if Weibo refuses them the error says so.
- `// TODO(verify)` 21321 meaning (unaudited app over its user limit).
- `// TODO(verify)` comments/to_me, statuses/mentions and comments/mentions are advanced interfaces for this app.
- Whether the security domain must match exactly or subdomains count (Starsign accepts subdomains).
- Token lifetimes by app level (test ≈ 1 day; others not confirmed).
- open.weibo.com could not be reached from the build sandbox. Endpoint names and fields come from Weibo SDKs and
  developer discussions found by search, not from the official wiki pages directly.

## Questions for the owner
- Which Weibo account(s), and do you have (or can you get) an app on open.weibo.com under a mainland entity?
- What security domain will posts link to? Every post must carry a link to it. Is a Starsign short-link domain on it?
- Do you need the inbox? If so, request the advanced comment/mention interfaces when submitting the app for review.
- Where will Starsign run, and is the egress reliable to `api.weibo.com` (Hong Kong or mainland region)?
