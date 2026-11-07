# Naver Band (네이버 밴드)

Connector `band` · networks `["band"]` · `packages/connectors/src/band.ts` · factory `createBandConnectors(env)`

BAND is where many Korean communities live: school parents, clubs, churches, fan groups, neighbourhoods, small shops
and their regulars. A band is a closed group, so Starsign treats each band as a group conversation.

## What works
- **Connect** (`connectMethod: "oauth"`, OAuth 2.0 authorization code, no PKCE, no scopes in the request).
  Authorize `https://auth.band.us/oauth2/authorize`; token `https://auth.band.us/oauth2/token` with the client id and secret in
  a Basic header (sent as a GET with the parameters in the query, as BAND documents it). `oauthConnect` returns **one account
  per band the person belongs to and may post in**: `GET /v2.1/bands`, then `GET /v2/band/permissions`
  (`posting,commenting,contents_deletion`) per band; bands without `posting` are left out, bands whose permissions cannot be
  read are kept. externalId = `band_key`, handle = band name, config `{ bandKey, bandName, userKey, userName, coverUrl,
  memberCount, permissions }`. The person's own `user_key` (from the token or `GET /v2/profile`) is kept so their own posts
  and comments are not fed back as inbox items. `connectConfigured` needs `BAND_CLIENT_ID` and `BAND_CLIENT_SECRET`.
- **Refresh**: BAND access tokens last years (`expires_in` ≈ 10 years); `refreshAuth` uses the refresh token when one exists.
- **API calls**: `https://openapi.band.us`, `access_token` as a parameter. Responses are `{ result_code, result_data }`;
  `result_code` 1 is success.
- **Publish** `POST /v2.2/band/post/create` (`band_key`, `content`, `do_push`): text. `options.link` and every media URL are
  added to the text on their own lines (BAND turns them into previews); the Open API has no photo upload for posts.
  `do_push` is off unless the account config sets `doPush: true`. externalId `<band_key>:<post_key>`, url null (the API does
  not return a web link). Idempotent in-process.
- **Inbox**: `GET /v2/band/posts` (newest page) → members' posts become `message` items in the band's conversation
  (`{ id: band_key, name: band name, type: "group" }`); for the 10 most recent posts with comments,
  `GET /v2/band/post/comments` (`sort=-created_at`) → `comment` items with the post as parent. The connected person's own
  posts and comments are skipped. externalIds `<band_key>:<post_key>` and `<band_key>:<post_key>:<comment_key>`.
- **Reply** `POST /v2/band/post/comment/create` (`band_key`, `post_key`, `body`): replying to a post or to a comment comments on
  the post (the API has no nested replies).
- **Moderate**: `delete` → `POST /v2/band/post/remove` or `/v2/band/post/comment/remove` (the person's own content; band
  leaders may remove others'). Hide, like and unlike are refused.
- **Metrics** `GET /v2.1/band/post`: `emotion_count` → likes, `comment_count` → replies, engagements = both. **Account**:
  `member_count` from `/v2.1/bands` → followers_total.
- **Errors**: `result_code` ≠ 1 is an error even with HTTP 200. 10401 → auth; 1001/1002/1003 (app quota, user quota,
  cool-down) → rate_limit retryable; 10403, 2142 (leaders only), 60000–60999 (not a member, band or post gone) and the rest →
  rejected. HTTP failures use the shared mapping (5xx retryable).

## What Starsign can and cannot see
Starsign sees the newest posts in each connected band and the comments on the 10 most recent of them, with members' BAND
names. It sees only bands the connecting person belongs to. It does not see band chats (밴드 채팅), private messages, older
posts beyond the newest page, or bands the person is not in. It never posts as anyone but the person who connected.

## Setup
1. Sign in at https://developers.band.us with a BAND account and register a service ("내 서비스" → 등록).
2. Redirect URI: `${STARSIGN_PUBLIC_URL}/oauth/band/callback`.
3. Copy the Client ID and Client Secret.
- Scopes: none in the request; the person approves access on BAND's consent screen.
- Webhook URL: none (BAND has no webhooks; the inbox polls).
- Env vars: `BAND_CLIENT_ID`, `BAND_CLIENT_SECRET`.

## Review and access requirements
- Registering a service is self-serve; there is no app review we know of. TODO(verify) whether BAND reviews services that
  write posts for others.
- Each person can only reach bands they are a member of, and only post where the band's settings let members post.

## Limits and quotas
- BAND applies per-app and per-user daily quotas and a cool-down between writes (result codes 1001–1003). TODO(verify) the
  numbers; they are not published in what we could reach.
- Post length: 10,000 characters assumed (platform table). No images, video or files through the API: they go in as links.

## Unverified
- `TODO(verify)`: the token endpoint also accepts a POST form (the connector sends a GET with query parameters, as documented).
- `TODO(verify)`: POST endpoints read form-encoded bodies (the reference shows query parameters).
- `TODO(verify)`: `/v2.2/band/post/create` has no image parameter (checked against third-party clients only).
- `TODO(verify)`: `/v2/band/permissions` request and response shape.
- `TODO(verify)`: `locale` is required by `/v2/band/posts` (sent as `ko_KR`).
- `TODO(verify)`: the comment create parameter is `body`, and whether the response returns `comment_key` (without it, the reply's
  id is `sent-<key>` and cannot be removed through the API).
- `TODO(verify)`: the result code table (1001–1003, 2142, 10401, 10403, 60000+).
- `TODO(verify)`: quotas and whether services are reviewed.

## Questions for the owner
- Should new posts notify band members (`do_push`)? Off by default; it can be turned on per band.
- Which bands should a person connect when they belong to many? Today every band they may post in is connected.
- Is BAND's developer agreement acceptable for an agency posting on behalf of several clients?
