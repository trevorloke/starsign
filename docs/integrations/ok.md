# OK.ru (Odnoklassniki)

Connector `ok` · networks `["ok"]` · `packages/connectors/src/ok.ts` · factory `createOkConnectors(env)`

OK (Одноклассники) is a Russian-language social network, strong with older audiences across Russia, Kazakhstan, Belarus,
Uzbekistan and the Russian-speaking diaspora. Most brand activity happens in groups.

## What works
- **Connect** (`connectMethod: "oauth"`, OAuth 2.0 authorization code, no PKCE). Authorize
  `https://connect.ok.ru/oauth/authorize` (`client_id`, `scope` separated by `;`, `response_type=code`, `redirect_uri`,
  `layout=w`, `state`); token `https://api.ok.ru/oauth/token.do` (`grant_type`, `code`, `client_id`, `client_secret`,
  `redirect_uri`). `oauthConnect` returns **the user's own feed plus one account per group the user administers or
  moderates**: `users.getCurrentUser`, `group.getUserGroupsV2` (paged; kept: ADMIN, MODERATOR, SUPER_MODERATOR, EDITOR), then
  `group.getInfo` for names. externalId `<uid>` for the user and `group:<gid>` for groups; config `{ kind, uid, gid, role, name }`.
  Without group access (error 10) the user's feed still connects. `connectConfigured` needs `OK_CLIENT_ID`, `OK_CLIENT_SECRET`
  and `OK_APPLICATION_KEY`.
- **Refresh**: access tokens last 30 minutes; refresh tokens (with `LONG_ACCESS_TOKEN`) 30 days and are not rotated.
- **API calls and signature**: `POST https://api.ok.ru/fb.do`, form-encoded, with `application_key`, `format=json`, `method`, the
  method's parameters, `access_token` and `sig`:
  - `secret = md5(access_token + application secret key)` (lowercase hex);
  - `sig = md5(params sorted by key as "key=value", concatenated, without sig, access_token and session_key, + secret)`.
  The tests pin a worked example derived independently (Python `hashlib`), including Cyrillic text (signed as UTF-8).
- **Publish** `mediatopic.post` (kinds `post`, `link`, `carousel`, `video`) with `type=GROUP_THEME` + `gid` for groups or
  `type=USER` for the user's feed, and an `attachment` JSON `{ media: [...] }`:
  - text → `{ type: "text", text }`; `options.link` → `{ type: "link", url }`;
  - photos: `photosV2.getUploadUrl` (`gid`, `count=1`, no album) → multipart upload (`pic1`) → the upload token →
    `{ type: "photo", list: [{ id: token }, ...] }` (up to 10);
  - video: `video.getUploadUrl` (`file_name`, `file_size`, `gid`) → the file as one **streamed multipart body** (field `data`,
    read in pieces of at most 4 MB, exact Content-Length; the file is never held whole) → `video.update` (`vid`, `title` from
    `options.title`) → `{ type: "movie", list: [{ id: video_id }] }`.
  externalId = topic id, url `https://ok.ru/group/<gid>/topic/<id>` (or `https://ok.ru/profile/<uid>/statuses/<id>`). Idempotent
  in-process.
- **Inbox**: `mediatopic.getTopics` (10 most recent topics) → `discussions.getComments` (`discussionType` GROUP_TOPIC or
  USER_STATUS) for topics with comments → `comment` items. The account's own comments (as the user or as the group) are skipped.
  externalId `<topic>:<comment>`, parent = the topic or the comment answered. Comment times: `date_ms` when present, else `date`
  read as Moscow time.
- **Reply** `discussions.comment` on a topic or a comment (`reply_to_comment_id`); in groups as the group (`as_admin=true`).
- **Moderate**: `delete` a comment → `discussions.deleteComment`. Hide, like and deleting topics are refused.
- **Metrics** `mediatopic.getByIds` (50 per call): `like_summary.count` → likes, `reshare_summary.count` → reposts,
  `discussion_summary.comments_count` → replies, engagements = the sum. **Account**: groups → `members_count` from `group.getInfo`
  → followers_total; the user's feed has none.
- **Errors** `{ error_code, error_msg }` (usually HTTP 200): 102 (session expired), 101/103/104/105 (bad key, session or
  signature) → auth; 8/11/26/5000 (flood, limits) → rate_limit retryable; 10 (permission denied) → rejected with an explanation;
  1/2/50/51 → network retryable; the rest → rejected. HTTP failures use the shared mapping.

## What Starsign can and cannot see
Starsign sees comments on the 10 most recent topics of each connected group (and of the user's own feed), with commenters' ids
and, where OK returns them, names. It does not see private messages, group chats, comments on older topics, or groups the person
does not administer or moderate.

## Setup
1. Register as an OK developer (https://ok.ru/devaccess) and create an application ("Внешнее приложение" / external app).
2. Redirect URI: `${STARSIGN_PUBLIC_URL}/oauth/ok/callback`.
3. Note the Application ID (client id), the public key (application key) and the secret key (client secret) from the email OK
   sends.
4. Ask OK API support (api-support@ok.ru) for the permissions below; some are granted only on request.
- Scopes requested: `VALUABLE_ACCESS;LONG_ACCESS_TOKEN;PHOTO_CONTENT;VIDEO_CONTENT;GROUP_CONTENT;PUBLISH_TO_STREAM`.
- Webhook URL: none (the inbox polls).
- Env vars: `OK_CLIENT_ID`, `OK_CLIENT_SECRET`, `OK_APPLICATION_KEY`.

## Review and access requirements
- `GROUP_CONTENT`, `VIDEO_CONTENT`, `PUBLISH_TO_STREAM` and `LONG_ACCESS_TOKEN` must be requested from OK API support for the app.
  Typical answer time is days to weeks (TODO(verify)). Before that, group calls fail with error 10 and only the user connects.
- Posting to a group needs the person to be its administrator or moderator.

## Limits and quotas
- Per-method and per-user rate limits; flood control (error 8) on repeated actions; daily limits (11, 26). All mapped to
  rate_limit retryable.
- Up to 10 photos per topic (as built); video upload up to 2 GB in one multipart request (OK's documented limit).
- Topic text limit assumed 10,000 characters (TODO(verify)).

## Unverified
- `TODO(verify)`: scope names and which need OK's approval.
- `TODO(verify)`: `token.do` accepts the form body (OK's docs show the parameters in the query string of a POST).
- `TODO(verify)`: `group.getUserGroupsV2` status values (ADMIN, MODERATOR, SUPER_MODERATOR, EDITOR).
- `TODO(verify)`: `video.getUploadUrl` parameters, the multipart field name `data`, and whether a topic may attach a video before
  OK has finished processing it.
- `TODO(verify)`: `mediatopic.getTopics` with `uid` for the user's own feed, and the `discussions.getComments` response shape
  (`comments`, `entities.users`).
- `TODO(verify)`: the time zone of comment `date` (Moscow assumed).
- `TODO(verify)`: `reply_to_comment_id` and `as_admin` on `discussions.comment`.
- `TODO(verify)`: error 5000 as a rate condition.
- `TODO(verify)`: the topic text limit.

## Questions for the owner
- Connect editors' groups too, or administrators and moderators only?
- Should group replies always be signed as the group (today: yes)?
- Who at your company will request the extra permissions from OK API support, and under which legal entity?
