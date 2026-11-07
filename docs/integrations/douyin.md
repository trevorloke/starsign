# Douyin (抖音)

Connector `douyin` · networks `["douyin"]` · `packages/connectors/src/douyin.ts` · factory `createDouyinConnectors(env)`

**Douyin is not TikTok.** Douyin is ByteDance's mainland-China app, with its own developer platform
(open.douyin.com), its own apps, accounts and review. TikTok is a separate platform and has its own connector
(`tiktok`, see tiktok.md). A Douyin integration needs a **mainland-China registered developer account (enterprise)**
and Douyin's **capability review** for each scope; nothing below works until that is done.

## What works
- **Connect** (`connectMethod: "oauth"`): `https://open.douyin.com/platform/oauth/connect/` with `client_key`,
  comma-separated scopes (default `user_info,video.create.bind,video.data.bind,item.comment`) → `POST
  /oauth/access_token/` through `OAuth2Client` (Douyin wraps the token in `data`) → `POST /oauth/userinfo/` for the
  nickname. One login = one Douyin account. Auth blob: `{ accessToken, refreshToken, expiresAt, refreshExpiresAt,
  openId, scope, renewals }`; externalId = `open_id`; handle = nickname (Douyin exposes no @handle through the API).
- **Refresh**: access tokens last 15 days, refresh tokens 30 days. `refreshAuth` calls `/oauth/refresh_token/`. When the
  refresh token has less than 3 days left, it first calls `/oauth/renew_refresh_token/` for a new 30-day refresh token
  (Douyin allows 5 renewals; the count is kept in the auth blob). After that, or once the refresh token has expired,
  the person must log in again (core marks the account).
- **Publish video**: the video is uploaded, then the post is created.
  - Up to 128 MB: one `POST /api/douyin/v1/video/upload_video/` (multipart `video`), sent as a stream with an exact
    `Content-Length`.
  - Over 128 MB: `init_video_part_upload` → `upload_video_part` per part (`upload_id`, `part_number` from 1, multipart
    `video`) → `complete_video_part_upload`. Parts are 20 MB (Douyin's recommendation; a tail under the 5 MB minimum is
    folded into the last part). Parts are sent one after another, each streamed from storage in 4 MB pieces: at most
    one part is ever being read, and the whole file never sits in memory.
  - `create_video` with `video_id`, `text` (title with #hashtags and @mentions, up to 1000 characters),
    `private_status` from `options.privacy` (public → 0, self/private → 1, friends → 2; "followers" and "unlisted"
    have no Douyin equivalent and fail validation), and a cover from `options.thumbnailUrl` (uploaded with
    `upload_image`, passed as `custom_cover_image_url`).
  - Afterwards Starsign reads the item back with `video_data` (2 checks, 5 s apart) for the review state and the share
    URL. If review already marked it "not suitable for public display" (`video_status` 2) the publish fails `rejected`
    but keeps the item id (`partial`). Otherwise the result is `{ externalId: item_id, url: share_url or null }`;
    Douyin reviews every post, so a fresh post may be visible only to its author for a while.
  - Retries after a failed create reuse the uploaded video (no second upload); in-process idempotency on top.
- **Publish pictures (图文)**: `upload_image` per picture → `create_image_text` with `image_list` and `text`.
  Starsign's generic limit for Douyin is one media item, so this is a single-picture post today.
- **Inbox**: the account's 10 most recent videos (`video_list`), then for each video whose `comment_count` changed
  since the last poll, `GET /item/comment/list/` (newest first, 50 per page, 2 pages) → `comment`. externalId =
  `<item_id>:<comment_id>`, parentExternalId = item_id, url = the video's share URL, authorHandle = the opaque
  `comment_user_id`, authorName = nickname. Replies inside comment threads are not read yet.
- **Reply**: `POST /item/comment/reply/` with `item_id`, `content` and `comment_id` (to answer a comment) or without it
  (to comment on the video). Result externalId = `<item_id>:<new comment_id>`.
- **Moderate**: not available (the open API has no delete/hide for comments; pinning exists but is not a Starsign
  action). Capability false.
- **Metrics**: `POST /api/douyin/v1/video/video_data/` with `item_ids` (20 per call): `play_count` → video_views,
  `digg_count` → likes, `comment_count` → replies, `share_count` → shares, `forward_count` → reposts, sum →
  engagements. `play_count` is visible to the author only and reads 0 if a public video is made private. Account:
  `GET /api/douyin/v1/user/fans_data/` `all_fans_num` → `followers_total` (nothing is returned if the app lacks it).
- **Transport**: OpenAPI calls send the token in the `access-token` header and `open_id` in the query, never the token
  in a URL.
- **Errors** (Douyin answers HTTP 200 with `{ data: { error_code, description }, extra: { error_code, logid } }`;
  the logid is kept in the message for Douyin support): 2190008, 10008, 28001008 (expired), 2190002, 10009 (invalid),
  28001015 (token/open_id mismatch), 10010, 10020 (refresh token dead or renewals used up) → `auth`, so core refreshes
  or asks for a reconnect; 2190004 and 10004 (capability/scope not approved) → `rejected` with a hint (reconnecting does
  not help); HTTP 429, 2190001 or a "频率/频繁/限流" description → `rate_limit` (retryable); 2100004, 28001005 and
  HTTP 5xx → `network` (retryable); descriptions about review or violations (审核/违规/敏感) → `rejected` ("content
  review refused this post"); any other non-zero code → `rejected`.
- **Not supported**: webhooks (Douyin has them, signed with `X-Douyin-Signature`; not wired yet), DMs, keyword search,
  stories, live.

## What Starsign can and cannot see
Comments on the connected account's own recent videos, if Douyin grants the comment capability. Not: comments on
other accounts' videos, mentions elsewhere on Douyin, DMs, or search. Commenters appear by nickname and an opaque id.

## Setup
1. **Developer account**: register on open.douyin.com as an enterprise (企业) developer with a mainland business
   licence (营业执照) and a mainland contact; personal developers cannot request the posting and data capabilities.
2. Create a **website app (网站应用)** (or mobile/web app as the console names it), fill in the website, privacy policy
   and description, and pass app review.
3. Under **能力管理 (capabilities)** request: user info (`user_info`), video publishing (`video.create.bind`, the
   console may show `video.create`), video data (`video.data.bind`), comment management (`item.comment`, often limited
   to enterprise accounts 企业号), and fan data if offered. Each capability is reviewed separately.
4. Set the **授权回调域 / redirect URI** to `${STARSIGN_PUBLIC_URL}/oauth/douyin/callback`.
- Redirect URI: `${STARSIGN_PUBLIC_URL}/oauth/douyin/callback`.
- Webhook URL: none yet (`${STARSIGN_PUBLIC_URL}/webhooks/douyin` would be the address if webhooks are added).
- Env vars: `DOUYIN_CLIENT_KEY`, `DOUYIN_CLIENT_SECRET` (also read as `DOUYIN_CLIENT_ID` / `DOUYIN_CLIENT_SECRET`),
  optional `DOUYIN_SCOPES` (comma list, to match exactly what the console granted; asking for an ungranted scope fails
  the login), optional `DOUYIN_API_BASE`.

## Review and access requirements
- Douyin reviews the app, then each capability. Publishing (server-side posting on the user's behalf) has been
  restricted to enterprise developers with a real business use; comment management has at times been closed to new
  applications ("内测名额已满"). Expect weeks, and possible refusal.
- Before approval nothing works: the login itself fails for scopes the app does not have.
- **Mainland-China realities**: the developer entity must be mainland-registered; the website named in the app
  usually needs an ICP filing (备案). `open.douyin.com` is served from mainland China; reachability and latency from
  outside China vary (the build sandbox could not resolve its doc host at all), so run Starsign's Douyin traffic from
  a Hong Kong or mainland region. Data you read is personal information under PIPL and Douyin's developer terms;
  cross-border transfer of it out of China has its own legal requirements.

## Limits and quotas
- Video: up to 4 GB; one-request upload up to 128 MB (Douyin recommends parts above 50 MB); parts 5 MB minimum,
  20 MB recommended; `upload_id` valid for 2 hours.
- Title text: 1000 characters including hashtags.
- `video_data`: 20 item ids per call here. Comment list: 50 per page.
- Per-API QPS and daily quotas are set per app in the console; Starsign treats Douyin's rate-limit answers as
  retryable.

## Unverified
- `// TODO(verify)` `/oauth/access_token/` accepts a form body (current docs show JSON; older docs/SDKs use form or
  query parameters), and `/oauth/refresh_token/` tolerates the extra `client_secret`.
- `// TODO(verify)` `/oauth/userinfo/` as POST with a form body (older docs: GET with query).
- `// TODO(verify)` the `/api/douyin/v1/` endpoints take the token in the `access-token` header rather than
  `access_token` in the query (the community SDK uses the query).
- `// TODO(verify)` `private_status` values (0 everyone, 1 only me, 2 friends) on `create_video` and
  `create_image_text`.
- `// TODO(verify)` `custom_cover_image_url` takes the `image_id` returned by `upload_image`.
- `// TODO(verify)` `upload_image` + `create_image_text` (图文) are available under `video.create.bind`.
- `// TODO(verify)` the last part may be smaller than 5 MB (Starsign folds small tails into the previous part anyway);
  parts must be sent in order.
- `// TODO(verify)` which account types may use `/item/comment/list/` and `/item/comment/reply/` today (enterprise
  only?), and the exact scope name.
- `// TODO(verify)` `fans_data` scope and whether small accounts get `all_fans_num`.
- `// TODO(verify)` error codes: 2190001 as a quota/rate code, 2190015 and other content-review codes (Starsign matches
  review failures by their description).
- `// TODO(verify)` `video_data` batch size (20 assumed).
- Paths, fields and part-upload query parameters come from Douyin doc pages as quoted in search results and from the
  community SDK `zhangshuai/douyin-go`; developer.open-douyin.com and open.douyin.com could not be fetched from the
  build sandbox.

## Questions for the owner
- Do you have (or can you register) a mainland-China enterprise developer account on open.douyin.com?
- Which Douyin account(s)? Are they enterprise accounts (企业号/蓝V)? Comment management may require it.
- Which capabilities did Douyin grant? Set `DOUYIN_SCOPES` to exactly those.
- Should Starsign post publicly by default, or as "only me" until a person checks it in the Douyin app?
- Where will Starsign run for Douyin traffic (Hong Kong or mainland region)? Is there an ICP-filed website for the app?
