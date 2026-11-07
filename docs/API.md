# Starsign HTTP API v1 (contract)

Base URL in dev: `http://localhost:4000`. All bodies and responses are JSON. Times are ISO-8601 strings.

## Authentication

`Authorization: Bearer star_...` — an API key minted per workspace. The key carries the actor it acts as:
a human user with a role (`owner | approver | editor | viewer`), or an agent (`mcp` / `operator` actor types) governed by
the workspace's autonomy dial. Every write is attributed to that actor in the ledger.

Dev convenience: when the server runs with `STARSIGN_DEV_WORKSPACE=<slug>` and a request has no bearer, it acts as the
human owner `dev` of that workspace. Never set in production.

Errors: `{ "error": { "code": "not_found|forbidden|invalid|conflict|policy_blocked|unavailable|unauthorized|rate_limited", "message": "...", "details": ... } }`
with statuses 404 / 403 / 400 / 409 / 422 / 503 / 401. A malformed JSON body is `400 invalid`. A `422 policy_blocked`
carries `details: { violations: Violation[] }`.

Role gates (`owner`, `approver`, `editor`) apply to humans only; agent keys (`mcp`, `operator`) never pass them.
Agents may create posts within the autonomy dial and may only schedule, edit or cancel posts they created.

## API keys
- `GET /v1/keys` → `{ id, name, actorType, actorId, role, lastUsedAt, revokedAt, createdAt }[]` (owner)
- `DELETE /v1/keys/:id` → 204, revokes the key immediately (owner; recorded in the ledger)

## Health
- `GET /api/health` → `{ ok: true, version: "0.1.0", db: "pglite" | "postgres" }` (no auth)

## Identity & workspace
- `GET /v1/me` → `{ workspace: Workspace, actor: { type, id }, role: string | null }`
- `GET /v1/workspace` → `Workspace` = `{ id, slug, name, profile: object, settings: object, createdAt }`
- `PATCH /v1/workspace/profile` body `{ profile: object }` → `Workspace`
  - `profile` holds brand context: `{ description, audience, topics: string[], voice: { do: string[], dont: string[], examples: string[] }, competitors: string[] }` (free-form, these keys are conventional)

## Social accounts
- `GET /v1/accounts` → `Account[]` = `{ id, network, externalId, handle, displayName, connector, status: "active|reauth_required|disabled", hasCredentials, lastIngestAt, config }[]`
- `POST /v1/accounts` body `{ network, externalId, handle, displayName?, connector, auth?: object, config?: object }` → `Account` (owner/approver)
- `DELETE /v1/accounts/:id` → `204`

## Policy (red lines, autonomy)
- `GET /v1/policy` → `Policy` (see `@starsign/schema` `Policy`)
- `PUT /v1/policy` body `Policy` without `version` → new `Policy` (owner only; version increments)
- `GET /v1/policy/history` → `{ version, document, active, createdBy, createdAt }[]`
- `POST /v1/policy/check` body `{ variants: { network, text }[], scheduledAt?, actionClass?, disclosure? }` → `PolicyDecision` dry run, nothing stored.
  `PolicyDecision = { verdict: "allow|require_approval|block", violations: { redLineId, kind, severity, message, matches }[], autonomy?, policyVersion }`

## Posts
`PostDetail = { post: Post, variants: Variant[], approvals: Approval[] }`
- `Post`: `{ id, workspaceId, status, title, body, media, scheduledAt, publishedAt, actionClass, createdBy: {type,id}, trendTopicId, trendStageAtCreation, trendForecastId, experimentId, experimentArm, disclosure, evidence, policyDecision, createdAt, updatedAt }`
- `status ∈ draft | pending_approval | approved | scheduled | publishing | published | partially_published | failed | cancelled | blocked`
- `Variant`: `{ id, postId, socialAccountId, network, text, media, thread: string[], status, externalId, externalUrl, publishedAt, error, attemptCount }`
- `Approval`: `{ id, postId, state: "requested|approved|rejected|changes_requested", requestedBy, decidedBy, decidedAt, note, createdAt }`

- `GET /v1/posts?status=scheduled,published&limit=50` → `{ post, variants }[]` newest first
- `GET /v1/posts/queue` → `{ post, variants }[]` pending approval, oldest first
- `POST /v1/posts` body `CreatePostInput` → `201 PostDetail`. The gate decides the status. A red-line **block** still returns 201 with `post.status = "blocked"` and `post.policyDecision.violations` populated. A refused action (autonomy says the actor may not create) returns 403.
  `CreatePostInput = { title?, body, media?: Media[], variants: { socialAccountId, text, media?, thread?: string[] }[], scheduledAt?, actionClass?: "new_post|reply|dm|repost|campaign", trendTopicId?, trendStageAtCreation?, trendForecastId?, experimentId?, experimentArm?, disclosure?: { aiAssisted, aiContributions?: string[], humanReviewed, reviewedBy?, model?, promptVersion? }, evidence?: { kind, ref, note? }[], flags?: { paid? } }`
- `GET /v1/posts/:id` → `PostDetail & { history: LedgerEvent[] }`
- `POST /v1/posts/:id/schedule` body `{ at }` (required ISO time; 400 when missing) → `PostDetail`
- `POST /v1/posts/:id/publish-now` → `PostDetail`
- `POST /v1/posts/:id/cancel` → `PostDetail`
- `PATCH /v1/posts/:id/variants` body `{ edits: { [variantId]: text } }` → `PostDetail` (drafts only)
- `POST /v1/posts/:id/decide` body `{ decision: "approve|reject|request_changes", note?, edits?: { [variantId]: text } }` → `PostDetail` (human owner/approver only; edits are recorded as diffs; approving re-runs red lines → 422 `policy_blocked` if the edit crosses one)

## Live feed (listening)
`Activity = { id, workspaceId, socialAccountId, network, kind, externalId, authorHandle, authorName, text, url, parentExternalId, occurredAt, ingestedAt, sentiment, matchedStreams: string[], rawEventId }`
`kind ∈ own_post | reply | mention | comment | dm | repost | quote | like | follow`
- `GET /v1/feed?stream=<id>&networks=x,bluesky&kinds=mention,reply&account=<id>&since=<iso>&before=<iso>&limit=100&q=<text>` → `Activity[]` newest first
- `GET /v1/feed/counts?since=<iso>` → `{ network, kind, n }[]`
- `POST /v1/feed/stream-token` → `{ token, expiresInSeconds: 60 }`. Single use. The API key itself is never accepted in a URL.
- `GET /v1/feed/stream?token=<stream token>` → **SSE**. Events: `activity` `{ workspaceId, id, network, kind, matchedStreams }`, `post` `{ workspaceId, postId, status }`, `alert` `{ workspaceId, id, title, severity }`, `forecast` `{ topicId, stage, confidence }`. A `: ping` comment every 25s.
- `GET /v1/streams` → `Stream[]` = `{ id, name, query: { keywords, authors, networks, kinds }, createdAt }`
- `POST /v1/streams` body `{ name, query }` → `Stream`
- `DELETE /v1/streams/:id` → 204
- `POST /v1/ingest/:accountId` → `{ ingested, duplicates }` (pull now)
- `POST /v1/ingest/items` body `{ accountId: string | null, items: ActivityInput[] }` → `{ ingested, duplicates }` (import; editor+, account must be the caller's). `ActivityInput = Activity fields minus ids + { raw }`

## Measurement
- `GET /v1/metrics/summary?from=<iso>&to=<iso>` → `Summary`:
  `{ window, publishedByNetwork: {network, posts}[], measuredAt24h, totals: {impressions, engagements}, baselineEngagements24h, byNetwork: Group[], byHour: Group[], byTrendStage: Group[], byAuthor: Group[], byExperiment: Group[], top: { postId, variantId, network, text, impressions, engagements, lift }[] }`
  `Group = { key, posts, impressions, engagements, avgEngagements }`
- `GET /v1/metrics/lift-by-stage?from&to` → `{ stage, posts, avgEngagements, lift }[]`
- `GET /v1/metrics/series?entityType=post_variant&entityId=<externalId>&metric=impressions&from&to` → `{ value, observedAt, source }[]`. The entity must belong to the caller's workspace (404 otherwise).
- `GET /v1/metrics/variant/:variantId` → `{ latest: { [metric]: number }, outcomes: { offsetLabel, dueAt, capturedAt, status, metrics }[] }`

## Trends (the radar)
- `GET /v1/trends/radar` → `RadarEntry[]` sorted by score desc:
  `{ topic: { id, workspaceId, name, keywords, relevance }, forecast: { id, stage, confidence, velocity, hoursToPeak, computedAt, sources, sourceAgreement, curve: { at, value, lo, hi }[] } | null, actedOn: number, score, window: string | null }`
- `GET /v1/trends/topics` → `Topic[]`
- `POST /v1/trends/topics` body `{ name, keywords: string[], relevance?, global?: boolean }` → `Topic`
- `PATCH /v1/trends/topics/:id` body `{ relevance }` → 204 (workspace-owned topics only; global topics are maintained by the system)
- `GET /v1/trends/topics/:id` → `{ topic, forecast, series: { source, points: { t, v }[] }[], actions: { postId, stageAtAction, forecastId, createdAt, outcome24h: object | null }[] }`
- `POST /v1/trends/topics/:id/forecast` → recomputed forecast
- `POST /v1/trends/points` body `{ points: { topicId, source, value, observedAt, region? }[] }` → `{ recorded }` (topics must belong to the caller's workspace)

## Operators' output
- `GET /v1/alerts?unacknowledged=1&limit=50` → `Alert[]` = `{ id, kind, severity: "info|attention|urgent", title, body, evidence, topicId, acknowledgedAt, createdAt }`
- `POST /v1/alerts/:id/ack` → 204
- `GET /v1/briefs?limit=12` → `Brief[]` = `{ id, periodStart, periodEnd, contentMd, evidence, runId, createdAt }`
- `GET /v1/briefs/latest` → `Brief | null`
- `GET /v1/runs?limit=50` → `OperatorRun[]` = `{ id, operator, startedAt, finishedAt, status, summary, inputTokens, outputTokens, costUsd, error }`

## Ledger & export
- `GET /v1/ledger?types=post.created,post.published&subjectType=post&subjectId=<id>&afterSeq=<n>&limit=100` → `LedgerEvent[]` newest first
  `LedgerEvent = { id, seq, workspaceId, type, subjectType, subjectId, actor: {type,id}, data, occurredAt }`
- `GET /v1/export` → the whole workspace as one JSON document (`Content-Disposition: attachment`)

## Brand context (for agents)
- `GET /v1/context` → `{ workspace: { name, profile }, policy: { autonomy, redLines: { id, kind, description, severity }[], timezone }, accounts: Account[], recentTop: Summary.top, voiceExamples: { before, after }[] (last 20 approval diffs), activeTopics: RadarEntry[] (top 10) }`

## Compose, calendar, connect (v1.1)

- `POST /v1/accounts/connect/bluesky` body `{ identifier, appPassword, service? }` → `201 Account` (owner/approver).
  The server logs in with the app password, reads the account's DID and handle, stores the credentials encrypted.
  `400 invalid` with `details: { reason }` when the login fails.
- `GET /v1/connectors` → `{ name, networks: string[], configured: boolean, connect: "app_password" | "oauth" | "api_key" | "none" }[]`
  (which networks this deployment can connect, and how).
- `POST /v1/compose/adapt` body `{ body, networks: string[], topicId? }` → `{ variants: { network, text, thread: string[] }[], notes, usage: { costUsd, model } }`.
  Uses the model gateway with the brand context and red lines. `503 unavailable` when no model is configured.
- `GET /v1/calendar?from=<iso>&to=<iso>` → `{ post, variants }[]` ordered by time, where time = `publishedAt ?? scheduledAt`,
  statuses `pending_approval | approved | scheduled | publishing | published | partially_published | failed`.
  Default window: start of this week (Monday 00:00 workspace time) to +14 days.
- `GET /v1/sources` → `{ name, kind: "sample" | "trending" | "both", configured: boolean, lastRunAt: string | null, lastError: string | null, pointsLast24h: number }[]`
  (the trend sources this deployment pulls from).
- `GET /v1/trends/discoveries?limit=50` → `{ term, source, value: number | null, url: string | null, observedAt, region }[]`
  newest first: raw "trending now" terms the scout saw, before they become topics.
- `POST /v1/accounts/connect/x/start` → `{ authorizeUrl, expiresAt }` (owner/approver). Send the person's browser to
  `authorizeUrl`. X returns them to `GET /oauth/x/callback`, which connects the account and redirects to
  `/?connected=x&handle=<handle>` or `/?connect_error=<reason>` (`expired`, `exchange_failed`, `access_denied`, …).
  Needs `X_CLIENT_ID` (and `X_CLIENT_SECRET` for confidential clients) and `STARSIGN_PUBLIC_URL`; otherwise `503`.
  `GET /v1/connectors` reports `configured: false` for X until those exist.

## Experiments (v1.1)
Any post can be an arm: create the experiment, then create posts with `experimentId` + `experimentArm`.
- `POST /v1/experiments` body `{ name, hypothesis, arms: { key, description }[] (2-6, keys a-z0-9_-), primaryMetric?: "engagements" | "impressions" | "likes" | "replies" | "reposts" | "link_clicks" | "conversions", offset?: "24h" | "72h" | "7d" }` → `201 Experiment`
- `GET /v1/experiments` → `Experiment[]` = `{ id, name, hypothesis, status: "running" | "concluded", arms, primaryMetric: "<metric>@<offset>", result, createdAt }`
- `GET /v1/experiments/:id` → `{ experiment, readout }`, `readout = { metric, offset, arms: { key, description, posts, measured, mean }[], comparisons: { arm, versus, lift, lo, hi, probabilityBetter }[], verdict: "not_enough_data" | "no_clear_winner" | "winner", winner, summary, minPerArm }`.
  Lift is the ratio of means at the offset with an 80% bootstrap interval; a winner is named only when every interval clears 1.
  A post's value is the sum over its variants. Concluded experiments return the frozen readout.
- `POST /v1/experiments/:id/conclude` → `Experiment` (a person, editor or above; freezes the readout, records it in the ledger)
- Creating a post with an `experimentId` from another workspace, a stopped experiment, or an unknown arm is refused.

## People, sign-in, teams (v1.2)
Two ways to authenticate every `/v1` route: `Authorization: Bearer star_...` (API keys, unchanged) or the `starsign_session`
cookie (HttpOnly, SameSite=Lax, Secure when STARSIGN_PUBLIC_URL is https). Cookie-authenticated requests that change state
(POST/PUT/PATCH/DELETE) must send `x-starsign-csrf: 1` or get `403 forbidden`. A session acts as the signed-in user in their
current workspace with their member role.
- `POST /v1/auth/signup` `{ email, password (>= 10 chars), name, workspaceName }` → `201 { user, workspaces, currentWorkspaceId }` + cookie.
  Allowed when no user exists yet (first owner) or `STARSIGN_ALLOW_SIGNUP=1`; otherwise `403`.
- `POST /v1/auth/login` `{ email, password }` → `{ user, workspaces, currentWorkspaceId }` + cookie. `401 unauthorized` on bad credentials
  (same message for unknown email and wrong password). Repeated failures → `429` for 15 minutes per email.
- `POST /v1/auth/logout` → 204, clears the cookie and revokes the session.
- `GET /v1/auth/session` → `{ user: { id, email, name }, workspaces: { id, slug, name, role }[], currentWorkspaceId }` or 401.
- `POST /v1/auth/switch` `{ workspaceId }` → same shape; must be a member.
- `POST /v1/auth/forgot` `{ email }` → 204 always (sends a reset link when email is configured: RESEND_API_KEY + MAIL_FROM).
- `POST /v1/auth/reset` `{ token, password }` → 204. Reset links: `${STARSIGN_PUBLIC_URL}/?reset=<token>` (one hour, single use; signs the user out everywhere).
- `POST /v1/workspaces` `{ name, slug?, timezone? }` → `201 Workspace` (any signed-in user; creator is owner). For agencies adding a client.
- `GET /v1/members` → `{ id, userId, email, name, role, createdAt }[]`
- `POST /v1/invites` `{ email, role }` (owner) → `201 { inviteUrl, expiresAt }` (also emailed when configured). Invite links: `${STARSIGN_PUBLIC_URL}/?invite=<token>`.
- `GET /v1/invites/:token` → `{ workspaceName, email, role, expiresAt }` (no auth) or 404.
- `POST /v1/auth/accept-invite` `{ token, name?, password? }` → `{ user, workspaces, currentWorkspaceId }` + cookie (creates the user when new).
- `PATCH /v1/members/:id` `{ role }` (owner; cannot demote the last owner) → member. `DELETE /v1/members/:id` (owner; not the last owner) → 204.

## Integrations (v1.2)
- `GET /v1/connectors` → `{ name, networks, configured, connect: "oauth"|"app_password"|"api_key"|"webhook_url"|"bot_token"|"none", inputs: { key, label, placeholder? }[], capabilities: { [network]: { publish, reply, moderate, accountMetrics, webhooks, video, kinds: string[] } } }[]`
- `POST /v1/accounts/connect/:connector/start` `{ network?, inputs? }` → `{ authorizeUrl, expiresAt }`. Callback: `/oauth/:connector/callback`
  → redirects to `/?connected=<connector>&handle=<h1,h2>&count=<n>` or `/?connect_error=<reason>&connector=<connector>`. One login may connect several accounts.
- `POST /v1/accounts/connect/:connector/credentials` `{ network, inputs: { ... } }` → `201 Account[]` for non-OAuth connectors
  (Bluesky app password, Telegram bot token + channel, Discord webhook URL). `400` with `details.reason` on rejection.
- `POST /v1/media` multipart `file` (+ `alt`) → `201 { id, url, kind, mime, bytes, width, height, durationSeconds, media: Media }`; `GET /v1/media`; `DELETE /v1/media/:id`.
  `413 too_large` above `STARSIGN_MAX_UPLOAD_MB` (default 100): this path holds the file in memory.
- Direct-to-bucket uploads (v1.3, S3-compatible storage only): `GET /v1/media/limits` → `{ maxUploadBytes, direct, directLimits, types }`.
  `POST /v1/media/uploads` `{ mime, bytes, filename? }` → `201 { uploadId, method: "PUT", url, headers, expiresAt, maxBytes }`;
  the browser PUTs the file to `url` with exactly `headers` (valid 1 hour); then `POST /v1/media/uploads/complete`
  `{ uploadId, alt? }` → `201` asset as above. The server checks the object (HEAD for size, first 64 KB for type and
  dimensions, ranged reads for MP4/MOV duration) and deletes anything that is not what it claimed. Caps: images 30 MB,
  documents 100 MB, video 4 GB. `503 unavailable` on local-disk storage. The bucket needs CORS allowing `PUT` with a
  `content-type` header from the app's origin.
- `POST /v1/feed/:activityId/reply` `{ text, aiAssisted? }` → `201 PostDetail` (through the gate; may be pending approval).
- `POST /v1/feed/:activityId/moderate` `{ action: hide|unhide|delete|like|unlike }` → `{ ok, action }` (people only; delete needs owner/approver).
- `GET /v1/accounts/:id/metrics?metric=followers_total&from=` → `{ latest: {metric: value}, series: { value, observedAt }[] }`.
- Variants accept `options` (see VariantOptions in packages/schema/src/networks.ts) and `replyToExternalId`.

## Links & conversions (v1.3)
Owned measurement. When a short-link base is configured (`STARSIGN_LINK_BASE_URL`, else `<STARSIGN_PUBLIC_URL>/l` when
that is not localhost), every link in a published post (text, thread segments, `options.link`, `options.firstComment`)
goes out as `<base>/<slug>`. The stored variant keeps the approved text; `variant.published` events list the slugs used.
The redirect adds `utm_source=<network>`, `utm_medium=social`, `utm_campaign=<options.campaign | workspace default |
post-<id>>`, `utm_content=<slug>` (tags the author already set are kept) and `ssclid=<click id>`. Instagram and TikTok
captions are left alone (links there are not clickable), as is any segment the short link would push over the limit.
Pinterest, Reddit and Google Business distrust redirecting links, so there the real destination is kept and only the
UTM tags are added (web analytics still attribute the visit; Starsign does not count those clicks itself).
A variant opts out with `options.trackLinks: false`.

Public:
- `GET /l/:slug` → `302` to the tagged destination, `Cache-Control: no-store`; `404` for unknown or disabled links. Link-preview
  crawlers are redirected but recorded as previews and never counted. No raw IP is stored (a daily-salted hash counts unique visitors).
- `POST /c` `{ clickId, name?, value?, currency? }` (JSON, `text/plain` accepted for `sendBeacon`, CORS `*`) → always `204`.
  Counts only for a real, non-bot click from the last 30 days, once per click and name.
- `GET /s.js` → the browser snippet: keeps `ssclid` from the landing URL for 30 days in first-party storage and exposes
  `starsign.convert(name, value?, currency?)`.

Authenticated:
- `GET /v1/links?limit=` → `{ baseUrl, settings, links: (link & { shortUrl, stats: { links, clicks, uniqueVisitors, previews, conversions, conversionValue } })[] }`
- `POST /v1/links` `{ url, network?, campaign? }` → `201` link + `shortUrl` (not viewers; `503` when no base is configured).
- `DELETE /v1/links/:id` → `204`; the link stops redirecting at once (owner/approver).
- `GET /v1/links/report?from&to` (default 30 days) → `{ configured, totals: { clicks, uniqueVisitors, previews, conversions,
  attributedConversions, conversionValue, valueByCurrency[] }, byNetwork[], byDay[], topLinks[] }`.
- `GET|PATCH /v1/links/settings` `{ enabled, utm, clickIds, defaultCampaign?, medium }` (PATCH: owner).
- `POST /v1/conversions` `{ clickId? | slug?, name="conversion", value?, currency?, externalId?, occurredAt? }` → `201
  { conversion, duplicate: false }`, or `200 { duplicate: true }` when `externalId` was already recorded. Any API key
  (e.g. the shop's backend) or a non-viewer person. A `clickId` from another workspace is `404`.
- `GET /v1/conversions?limit=`.

Outcome snapshots (`post_outcomes.metrics`) gain `tracked_clicks` (unique visitors), `conversions` and
`conversion_value` up to each offset's due time, merged over the network's numbers; networks that report no post
metrics get these alone. A worker job writes the same three as cumulative series every 15 minutes.

## Languages and chat apps (v1.4)
Every inbound item is labelled with its language at ingest (`lang`, ISO 639-1; null when the text is too short to
tell) and, for chat apps, the room it was said in (`conversationId`, `conversationName`, `conversationType`:
group | channel | direct). New activity kind `message` (a message in a group, channel or server channel).
Networks `whatsapp`, `wechat`, `line`; connectors `discord_bot`, `whatsapp`, `wechat`, `line` (see docs/integrations).
Credential inputs may be `optional`.

- `GET /v1/feed` also takes `languages=ja,es`, `conversation=<id>`, `entity=<id>` (+ `children=1`); `q` searches translations too.
  Rows carry `translation`, `translationLang`, `translatedAt`.
- `GET /v1/languages` → `{ settings: { home, autoTranslate, dailyLimit }, seen: { lang, n }[], translationAvailable }`;
  `PATCH /v1/languages/settings` (owner).
- `POST /v1/feed/:id/translate` → the activity with its translation. `503` without a model or past the monthly model spend cap.
- Streams: `query.languages` (only these) and `query.translations` (lang → keywords); `POST /v1/streams/:id/expand`
  `{ languages }` fills translations with the words people use in those languages. Keywords match inside Chinese,
  Japanese and Thai text, full-width characters fold, and translations are matched too.
- The operators process translates waiting items every five minutes (batches of 25, `dailyLimit` per workspace), as
  "translator" operator runs that count toward the model spend cap.
- Webhooks: `GET|POST /webhooks/:connector` pass the query string to the connector (WeChat signs the URL), accept
  non-JSON bodies (WeChat XML) and reply with what the platform expects (WeChat: `success`). Platforms that sign each
  account's deliveries with that account's own secret (LINE, WeChat) are verified against the named account.

## The tracker: parties, brands and people (v1.4)
Track named organisations (`kind: "organization"`: a party, brand, company) and people (`kind: "person"`: a
candidate, spokesperson, creator, an individual's own brand). A person or sub-brand can belong to an organisation
(`parentId`), and organisations roll up their people.

- `GET /v1/entities` (`?archived=1`), `POST /v1/entities`, `GET|PATCH|DELETE /v1/entities/:id` (DELETE archives; history stays).
  Body: `{ kind, name, role?, parentId?, relation: own|client|prospect|competitor|opponent|watch, aliases[], handles: { network: [handle] },
  context[], exclude[], wikipedia[], trackTrend = true, notes? }`. Viewers cannot change it; agent keys can.
- Matching, on every stored message and every new translation: written by one of its handles (`how: "author"`); an
  @mention of a handle (`handle`); its name or an alias in the text or translation (`name`) — only when a `context`
  word is also present if any are set, and never when an `exclude` word appears. Creating or renaming an entity
  rescans the last 90 days.
- `trackTrend` creates a trend topic (name, aliases, `wiki:` articles) so the radar forecasts its momentum.
- `GET /v1/entities/report?from&to` (default 7 days) → per entity: `mentions`, `authored`, `people`, `sentiment`,
  `familyMentions` (with its people), `byNetwork`, `byLanguage`, `byDay`, `shareOfVoice` (among top-level entities),
  `shareWithinParent` (among an organisation's people).
- `GET /v1/entities/:id/mentions?children=1&limit=` → `{ mention: { how, term, network, lang }, activity }[]`.
- `POST /v1/entities/:id/suggest-aliases` `{ languages? }` → `{ languages, aliases: { text, lang, why }[], ambiguous[] }`.
  Suggestions only; add them with PATCH. Defaults to the languages seen in the feed.
- Public scan (`scanPublic`, default on): every 30 minutes the workers search public Bluesky posts
  (`app.bsky.feed.searchPosts`), Mastodon hashtag timelines, YouTube (with `YOUTUBE_API_KEY`) and news in 65+
  languages (GDELT, network `news`, listening only) for each tracked name, from where the last run left off. Only
  results that pass the entity's rules are stored, as feed items without a connected account.
  `POST /v1/entities/:id/scan` runs it now for one entity → `{ entities, found, stored, errors[] }`.
- MCP tools: `list_tracked`, `get_tracker_report`, `track_entity`.

## Changes in v1.5
- `POST /v1/posts/:id/retry` → post detail: a failed or partly published post's failed variants go out again now
  (published ones are never re-sent). `409` when nothing failed. Owner/approver/editor, or the agent that created it.
- Quiet hours no longer hold a draft that has no publish time; scheduling it (or "Post now") checks the rules then.
- `401` from `/v1/auth/session` also carries `mail: boolean` (whether reset and invite emails can be sent).
- Sign-up and `POST /v1/workspaces` accept `timezone` (IANA); unknown zones are ignored.
- `POST /v1/accounts` refuses connectors this server does not run (`400`).
- `GET /v1/connectors` lists the demo connector as `connect: "none"` when it is enabled, so its real capabilities show.
- Connect errors (`400`, `details.reason`) say whether the network was unreachable, the credentials were refused, or
  the network refused, with the connector's own hint.
- Without `REDIS_URL` the API process runs the background jobs itself (ingest, outcomes, account metrics, link
  rollups, tracker scan, trend sources, forecasts) on timers; `STARSIGN_INPROCESS_JOBS=0` turns that off.
- `STARSIGN_PUBLIC_URL` falls back to `RENDER_EXTERNAL_URL` on Render's web service.
- Webhook handlers may answer a delivery from its own signed body (`respond`), and OAuth callbacks pass every query
  parameter to the connector (`callbackParams`).
- `GET /v1/invites` (owner) → pending invites `{ id, email, role, invitedBy: { id, name, email }, expiresAt, createdAt }[]`;
  `DELETE /v1/invites/:id` (owner) → `204`, the link stops working at once and the ledger records `invite.revoked`.
- The web app has a Settings drawer for the brand profile (PATCH /v1/workspace/profile), red lines, autonomy,
  timezone and spend caps (PUT /v1/policy), and policy history.


## Analytics and client reports (v1.6)
<!-- ---- analytics & client reports -->
- `GET /v1/analytics?from&to&networks=x,bluesky&accounts=<id,id>` (default: the last 30 days; at most 366 days; anyone
  in the workspace) → one payload for the Analytics view:
  `{ window: { from, to, previousFrom, previousTo, days, timezone }, filters, totals, previous, change, currency,
  byNetwork[], byAccount[], topPosts[], bestTimes, whatWorked, series[], previousSeries[], mentions, measured }`.
  - `totals` / `previous` (the equal period just before) / each `byNetwork` and `byAccount` row:
    `{ posts, impressions, engagements, engagementRate, linkClicks, conversions, conversionValue, followersGained, mentions }`.
    A post's numbers are its 72h outcome snapshot, else its 24h one, else its latest metrics; engagements are the
    network's `engagements`, else likes + replies + reposts + quotes + shares + saves; engagement rate is over posts
    that reported impressions. Link clicks are non-bot clicks on Starsign short links; followers gained comes from the
    accounts' `followers_total` series; mentions are mention/reply/comment/quote items the accounts received.
    `change[k]` is fractional (0.12 = +12%), null when the previous value was 0.
  - `topPosts` (10, by engagements): `{ postId, variantIds, text, networks, url, publishedAt, impressions, engagements,
    engagementRate, linkClicks, conversions, basis: "72h" | "24h" | "latest" }`.
  - `bestTimes` (posts from the last 90 days, at least): 168 `cells` `{ weekday (0 = Monday), hour, posts, medianRate, thin }`
    of median engagement rate at 24h by local weekday × hour of publish in the workspace's time zone; `thin` = fewer
    than 3 posts (never recommended); `recommendation` is a sentence ("Tuesdays and Thursdays 9–11am have done best;
    based on 42 posts.").
  - `whatWorked`: `comparisons` (rode a trend vs not, images or video vs none, short (< 120 characters) vs longer, and
    each post kind vs the rest) as `{ id, label, a, b, ratio, verdict: better|worse|similar|not_enough, sentence }`
    using median engagements at 24h; fewer than 5 posts on either side is always `not_enough`. `stages` is
    `GET /v1/metrics/lift-by-stage` for the same window.
  - `series` / `previousSeries`: per local day `{ day, impressions, engagements (by the day posts went out), clicks,
    followers (end of day) }`.
- Reports: `{ id, name, period: last_7_days|last_30_days|calendar_month, sections[], branding: { title, clientName,
  logoMediaId, logoUrl, accent }, recipients[], schedule: { kind: "none" } | { kind: "weekly", weekday 0-6 (Monday = 0),
  hour } | { kind: "monthly", day 1-28, hour }, scheduleSummary, nextSendAt, filters: { networks, accounts }, intro,
  lastSentAt, lastSentPeriod, shares: { active, lastCreatedAt }, createdBy, createdAt, updatedAt }`.
  Sections: `summary, by_network, top_posts, best_times, links, tracker, mentions, what_worked, upcoming`. Periods are
  whole local days that have ended (a calendar month is the last complete one). The logo must be an image in this
  workspace's media library.
  - `GET /v1/reports`, `GET /v1/reports/:id` (anyone in the workspace).
  - `POST /v1/reports` → `201`, `PATCH /v1/reports/:id`, `DELETE /v1/reports/:id` → `204` (also turns off its links).
    People with owner/approver/editor manage reports; agent keys may PATCH anything but `recipients` (`403`); viewers
    read and render only.
  - `GET /v1/reports/:id/render?format=html` → a self-contained, printable HTML document (inline CSS and SVG, no
    scripts, nothing loaded but the logo; a print stylesheet keeps sections on one page where they fit: "Save as PDF"
    from the browser). Served with `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src …`.
  - `POST /v1/reports/preview` body = a report definition → the same HTML without saving (the editor's live preview).
  - `POST /v1/reports/:id/send` → `{ sent, period, periodLabel, viewUrl }`: emails every recipient now (HTML body,
    plain-text alternative, and a fresh read-only link). People editor+ and agents; `503` without mail
    (RESEND_API_KEY + MAIL_FROM), `400` without recipients. Ledger: `report.sent`.
  - `POST /v1/reports/:id/share` → `201 { id, url, createdAt }`: a new read-only link `<public url>/r/<token>`; the
    token is 32 random bytes shown once, stored only as its sha256. `DELETE /v1/reports/:id/share` → `204` turns off
    every link to the report (emailed ones too). Editor+ people only. Ledger: `report.shared`, `report.share_revoked`.
  - Public `GET /r/:token` (no session, no key): the latest version of the report for its current period, read-only,
    `no-store`, never framed or indexed; `404` once revoked or deleted.
- Scheduling: the workers' `reports` job (every 15 minutes) emails each scheduled report whose latest moment (in the
  workspace's time zone) has passed and came after the report was created, once per period: the period key is
  claimed in `reports.last_sent_period` before mailing and released if mailing fails. Without mail it does nothing.
- `MailMessage` gained an optional `html`; Resend receives it alongside `text`.

<!-- ---- AI answer visibility -->
## AI answer visibility
What AI assistants say when people ask the questions a workspace cares about. See `docs/visibility.md` for what is
measured, its limits, keys and costs. Viewers and agent keys read everything; people with editor or above manage
questions, run them and set each tracked name's own sites; owners choose the engines and which cadences are allowed.
- `GET /v1/visibility/engines` → `{ id: "anthropic"|"openai"|"perplexity"|"gemini"|"fake", label, configured, enabled, envVar, modelEnvVar, model, priced }[]`
  (`configured`: this server has the key; `enabled`: configured and not turned off for the workspace; `priced`: the call's cost is known and counted).
- `GET /v1/visibility/settings` → `{ settings: { engines: string[] | null, cadences: ("daily"|"weekly")[], maxPrompts, domains: { [entityId]: string[] } }, engines, judge: boolean }`.
  `PATCH` with any of those fields: `engines` (null = every configured engine), `cadences`, `maxPrompts` are owner only;
  `domains` (a tracked name's own web domains; an empty list clears them) is editor and up. Ledger: `visibility.settings_updated`.
- `GET /v1/visibility/prompts` (`?archived=1`) → `Prompt[]` = `{ id, question, translations: { [lang]: string }, languages, regions, entityIds, cadence, notes, lastSlot, lastRunAt, createdAt, updatedAt, archivedAt, due }`.
- `POST /v1/visibility/prompts` body `{ question (3-500), languages = ["en"] (1-6), translations?, regions? (ISO country codes, ≤ 6), entityIds? (empty = every tracked name), cadence = "weekly", notes? }` → `201 Prompt`.
  `400` for a cadence an owner turned off or an untracked name; `409` past `maxPrompts`. `GET|PATCH|DELETE /v1/visibility/prompts/:id` (DELETE archives; answers stay).
  Ledger: `visibility.prompt_created|prompt_updated|prompt_archived`.
- `POST /v1/visibility/prompts/:id/run` → `{ runId, prompts, answers, errors, capped, mentions, costUsd }`: asks every enabled engine, in every
  language and region, now. Counts for the current day or week, so the hourly job does not ask again. `503` without an engine.
- `POST /v1/visibility/suggest` body `{ languages?, count = 8 }` → `{ languages, questions: { question, lang, why, names }[] }`. Suggestions only;
  `503` without a model or past the monthly model spend cap.
- `GET /v1/visibility/report?from&to` (default 28 days) → `{ from, to, previous: { from, to }, totals: { answers, prompts, errors, capped, costUsd, byEngine[], byLanguage[] },
  entities: Row[], citations: { total, own, ownShare, ownDomains[], otherDomains[] }, latest: Answer[], engines }`.
  `Row = { id, name, kind, role, relation, parentId, answers, mentioned, share (0..1), avgPosition, sentiment (-1..1), ownCitations, flagged, previous: Agg, change: { share, avgPosition, sentiment }, byEngine: Agg[], byLanguage: Agg[], trend: (Agg & { day })[] }`
  where `answers` counts the successful answers in which the name was looked for; `previous` is the same length of time just before `from`.
  Domains: `{ domain, citations, answers, ownerEntityId }`.
- `GET /v1/visibility/answers?promptId&engine&entity&mentioned=0&lang&from&to&limit` → `Answer[]` newest first:
  `{ id, promptId, prompt, question (as sent), engine, model, lang, region, status: ok|error|capped, text, error, citations: { url, title, domain, ownerEntityId }[], costUsd, askedAt,
  mentions: { entityId, name, mentioned, position, term, sentiment, summary, flags[], ownCitations }[], highlights: { start, end, entityId }[] }`.
  With `entity`, answers that name it (or, with `mentioned=0`, that leave it out).
- Background: the workers' `ai-visibility` job (hourly) asks every due question (once per UTC day or ISO week), at most 60 engine
  calls per workspace per hour, as a "visibility" operator run within the model spend cap; past the cap the remaining answers are
  recorded `capped`. Each run writes `ai_answer_mentions` and `ai_answer_citations` metrics per tracked name (`entityType: "tracked_entity"`).
- MCP: `get_ai_visibility` (read only).
<!-- ---- end AI answer visibility -->

<!-- ---- inbox workflow -->
## Team inbox
The live feed worked as a shared inbox. Every inbound message that came in through a connected account is part of a
conversation (own posts, likes, follows and reposts are not; nor is what the tracker's public search found). A reply
with a parent id, or a direct message with a conversation id, joins the conversation it belongs to; the conversation's
state lives on its first message, whose activity id is the item's id. A new message in a done or pending conversation
reopens it. Activities stay exactly as ingested; the state is in `inbox_items` (migration `0011_inbox.sql`, which also
backfills: messages from the last 7 days start open, older ones done).

Roles: viewers and agent keys read everything. People with editor or above work items (status, assignee, priority,
labels, snooze), write notes and manage saved replies. Owners and approvers manage labels, rules and response targets.
Agent keys may change status and labels and add notes, but never assign, set priority, snooze or touch rules (`403`).
Every change is a ledger event.

- `GET /v1/inbox?status=open,pending&assignee=me|none|<userId>&tag=&priority=urgent,high&network=x,line&q=&sort=newest|oldest|due|priority&snoozed=1&limit=50&offset=0`
  → `{ items: Entry[], counts: { open, pending, done, spam, mine, unassigned, snoozed }, viewer: { userId, canWork, canAssign, canManage } }`.
  `Entry = { activity: Activity (the first message), latest: Activity | null, state: { status, assignee, priority, tags, firstResponseAt, doneAt, snoozedUntil, slaDueAt, lastActivityAt, messageCount, createdAt, updatedAt }, sla: { dueAt, state: none|ok|soon|overdue|met|missed, msLeft, targetMinutes }, notes }`.
  Snoozed conversations are left out unless `snoozed=1`. Counts follow every filter except status and assignee: `mine` is open or pending and
  assigned to the caller, `unassigned` is open with nobody on it, open/pending exclude snoozed ones. `due` sorts by the first-response deadline
  of conversations still waiting on one.
- `GET /v1/inbox/:activityId` (any message of the conversation) → `{ item: Entry, messages: Activity[] (oldest first), parent: Activity | null (the post it answers), replies: { postId, status, text, replyTo, network, createdAt, createdBy, publishedAt }[], notes: Note[] }`.
- `PATCH /v1/inbox/:activityId` body any of `{ status: open|pending|done|spam, assignee: userId|"me"|null, priority: normal|high|urgent, tags: string[], addTags, removeTags, snoozedUntil: ISO|null }` → `Entry`.
  Labels must be the workspace's; an assignee must be a member with editor or above. Done sets `doneAt`; done and spam wake a snooze. Ledger: `inbox.item_updated` with the changes.
- `PATCH /v1/inbox` body `{ ids: string[] (1-200), patch }` → `{ updated, items: Entry[] }` (ledger events carry `bulk: true`).
- Notes: `GET /v1/inbox/:activityId/notes` → `Note[]` = `{ id, threadId, author, text, mentions: userId[], createdAt, editedAt }`; `POST` body `{ text, mentions? }` → `201 Note`;
  `PATCH /v1/inbox/notes/:noteId` `{ text }` (the author only); `DELETE` (the author or an owner). `@sam`, `@ana.ruiz`, `@AnaRuiz` mention a member by email name,
  first name or full name. Each person mentioned gets an `inbox` live event and an `inbox.mentioned` ledger event (subject: the user). Ledger: `inbox.note_added|note_updated|note_deleted`.
- Saved replies: `GET /v1/saved-replies` → `{ id, name, text, lang, createdBy, createdAt, updatedAt }[]`; `POST` `{ name, text, lang? }`; `PATCH|DELETE /v1/saved-replies/:id`.
  `POST /v1/saved-replies/:id/fill` `{ activityId }` → `{ text, lang }` with `{{author_name}}`, `{{author_handle}}`, `{{brand}}` filled in one pass (a value is never
  re-expanded; `\{{x}}` stays literal; unknown variables stay for the person to edit). Nothing is sent: the text goes into the reply box and the reply goes through
  `POST /v1/feed/:id/reply` and the gate (red lines and the reply autonomy dial) as before. Ledger: `inbox.saved_reply_created|updated|deleted`.
- Rules: `GET /v1/inbox/rules`; `POST` `{ name, enabled?, conditions: { streams, entities, networks, kinds, languages, keywords }, actions: { assignee? | roundRobin?: userId[], tags?, priority?, spam? } }`;
  `PATCH|DELETE /v1/inbox/rules/:id`; `POST /v1/inbox/rules/reorder` `{ ids }`. Evaluated in order when a new conversation arrives (after the tracker scan,
  so `entities` matches tracked names): empty condition groups match anything, values within a group are alternatives. For assignee, priority and spam
  the first matching rule decides; labels from every matching rule add up. Round robin rotates among the listed members who can still work the inbox.
  Ledger: `inbox.rule_created|rule_updated|rule_deleted`, and `inbox.rule_applied` per rule that changed a conversation.
- Settings: `GET /v1/inbox/settings` → `{ sla: { urgent, high, normal } (minutes; default 15, 60, 480), businessHours: { enabled, days (0 = Sunday), start, end }, tags: { name, color: gray|blue|green|amber|red|violet }[], timezone }`;
  `PATCH` with any of `sla`, `businessHours`, `tags`. With business hours on, the clock counts only those hours on those days, in the workspace's
  timezone (the policy's). New targets apply to conversations still waiting on a first reply; a label taken off the list comes off every conversation.
  Ledger: `inbox.settings_updated`.
- First response: a reply post on its way out (scheduled, approved, publishing or published) that answers a message in a conversation sets
  `firstResponseAt` and moves an open conversation to pending. Ledger: `inbox.responded` (actor: who wrote the reply). A reply waiting on approval is not a response yet.
- Live: the SSE stream gains `event: inbox`, `data: { workspaceId, kind: new|updated|assigned|mention|note|settings, ids?, userIds?, noteId? }`.
- MCP: `list_inbox` (read) and `update_inbox_item` (status, labels, note; write).
<!-- ---- end inbox workflow -->
