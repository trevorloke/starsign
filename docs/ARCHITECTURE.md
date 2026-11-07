# Architecture

Starsign is one TypeScript monorepo with two spines running through every package.

## The data spine

Two append-only logs. Postgres triggers refuse `UPDATE` and `DELETE` on both.

| Log | What goes in | Why it exists |
|---|---|---|
| `raw_events` | Every payload received from any source, verbatim, hash-deduplicated | Nothing observed is ever lost; derivations can be rebuilt with better models later |
| `ledger_events` | Every fact Starsign asserts (`post.created`, `policy.blocked`, `variant.published`, `outcome.captured`, `operator.alert`, …) with the actor who caused it | The ledger is the product's memory and its audit trail; the brief, the lift analysis and the voice model all read from it |

Everything else is a derivation. `posts`, `activities`, `metrics`, `trend_forecasts` and friends are indexed, queryable
projections that could be recomputed from the logs. Derived tables carry `model_version` / `prompt_version` where a model
produced them, so a recompute can be selective.

The **outcome ledger** sits on top: every published variant gets six snapshot rows (`post_outcomes` at 1h, 6h, 24h, 72h,
7d, 30d). Workers capture them when due. Because every snapshot is at a fixed offset, posts are comparable across
networks, authors (human / operator / mcp), trend stages (`trend_actions`) and experiment arms. `MetricsService.summary`
and `liftByStage` are the first consumers; the forecaster's relevance and the drafting prompts are next.

## The policy spine

One `Policy` document per workspace (versioned in `policies`, every change in the ledger):

- **Red lines** — declared constraints the brand never crosses: forbidden phrases/topics/claims, competitor mentions,
  quiet hours, required disclosure, cadence caps, network restrictions, custom regex. Each has a severity
  (`block`, `require_approval`, `warn`). Evaluated by `@starsign/policy` on every output from every actor.
- **Autonomy dial** — per action class (`new_post`, `reply`, `dm`, `repost`, `campaign`): `suggest`, `draft`,
  `schedule_with_approval`, `autopost`. Operators and MCP agents follow it; humans follow role rules.
- **Spend caps** and **disclosure** defaults.

`gatePost()` combines both and is the only way a post comes into existence. It returns where the post lands
(`draft`, `pending_approval`, `scheduled`, `blocked`) or refuses creation. The API, the operators, the MCP server
and the seed all go through `PostService.create`, which goes through the gate. Approvals re-run red lines on the
edited text, so an edit cannot sneak past them, and every edit is recorded in `approval_diffs` as voice training signal.

## How attention gets in

Every hour the workers' `sources` job samples every topic from every configured source (`packages/sources`):
keyword interest over time from Google Trends (official alpha API when a key exists), Wikipedia daily pageviews,
Hacker News mentions per hour, Bluesky posts per hour, and the brand's own feed (mentions, replies and comments
matching the topic, recomputed over the trailing day so late ingestion lands in the right hour). Sources that list
"trending now" terms (Google Trends RSS, Wikipedia top articles, the Hacker News front page, YouTube most-popular)
are stored raw. Every two hours the Scout clusters those terms with the brand's context and starts tracking the
relevant, new ones (relevance >= 0.6, at most three a run, each with a recorded reason). The forecasts job then
recomputes every topic. `GET /v1/sources` reports each source's health.

## Packages

```
schema      zod schemas = the open event schema v0 (types for everything, no runtime deps)
policy      pure: red-line evaluation, autonomy resolution, gatePost
forecast    pure: resample → EWMA kinematics → stage → damped Holt → band; always deterministic
db          drizzle schema + SQL migration + client (PGlite in dev/tests, Postgres in prod)
ledger      EventStore (raw + ledger), OutcomeScheduler, ApprovalDiffs, prefixed ids
connectors  Connector interface, per-network validation, registry, mock, bluesky, x, zernio
core        Starsign: auth/workspaces/accounts/policy/posts/approvals/publishing/listening/metrics/trends/ops/export
ai          ModelGateway (Anthropic SDK) with versioned prompts, pricing, FakeGateway
```

Dependency direction is strictly downward: `schema` ← `policy`/`forecast`/`db` ← `ledger`/`connectors` ← `core` ← apps.

## Apps

- **api** (Hono): the HTTP contract in `docs/API.md`, SSE fan-out from `Starsign.emitter`, serves `apps/web/dist`.
  Boot: migrate → connectors → scheduler (BullMQ when `REDIS_URL`, else in-process timers re-armed from the database).
- **workers** (BullMQ): durable publish queue (one delayed job per post, idempotent per variant), repeatable jobs for
  ingest (with metered-read caps), outcome capture, forecast refresh.
- **operators**: Watch (forecast → alert → draft into the queue), Analyst (weekly brief), Steward (semantic red lines).
  Direct core access, same trust level as workers.
- **mcp**: agents' front door, over the HTTP API with an agent key; proposals land in the approval queue.
- **web**: the room.

## People and sessions

Two kinds of credentials reach `/v1`. **API keys** (`Authorization: Bearer star_...`) are for agents and automation:
an MCP client, an operator, a script. **Sessions** are for people: email + password sign-in (`AuthService`,
`packages/core/src/services/auth.ts`; routes in `apps/api/src/auth-routes.ts`) sets an HttpOnly, SameSite=Lax
`starsign_session` cookie. Both resolve to the same `Principal`; a session's is
`{ workspaceId: currentWorkspaceId, actor: { type: "human", id: userId }, role: <member role> }`, with the role read
from `members` on every request, so a role change or removal applies immediately.

- Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key, per-user salt), stored as `scrypt$N$r$p$salt$key` so the cost can
  rise later (hashes are upgraded on the next sign-in). Compared in constant time; unknown emails burn the same scrypt
  time and get the same 401 as a wrong password.
- Tokens: sessions, invites and password resets are 32 random bytes handed out once; only their sha256 is stored
  (`sessions.id`, `invites.token_hash`, `password_resets.token_hash`). Sessions slide to 30 days on use, invites last
  7 days, resets 1 hour; invites and resets are single use; a reset revokes every session of that user.
- CSRF: cookie-authenticated writes must carry `x-starsign-csrf: 1` (a header a cross-site page cannot add without CORS
  approval); session-creating public routes accept only `application/json`. Bearer requests need neither.
- Teams: every workspace has at least one owner (the last owner cannot be demoted or removed). Owners invite by email;
  accepting requires the invite's email (signed in as it, its password, or a new password for a new person). Any
  signed-in person can create a workspace and owns it, which is how an agency adds a client; `POST /v1/auth/switch` moves
  the session between workspaces the person belongs to. Membership changes, invites and sign-ups go to the ledger.
- Sign-up: the first person on a deployment always; afterwards only with `STARSIGN_ALLOW_SIGNUP=1` (otherwise invites).
- Mail: Resend over HTTPS when `RESEND_API_KEY` + `MAIL_FROM` are set; otherwise invite links are returned to the owner
  and reset links go to the API log outside production.
- Limits: 5 failed sign-ins per email per 15 minutes, then 429. The counter is **in memory, per process**: several API
  replicas each keep their own and a restart clears it. Put a shared limiter in front if that matters.

## Owned measurement

Network metrics are rented: each platform decides what it reports, renames it, rate-limits it or prices it. So every
link Starsign publishes can go through a short link it controls (`LinkService`, `packages/core/src/services/links.ts`).
`PublishingService` asks it to wrap a variant's links just before sending; the stored variant keeps the approved text.
The redirect (`GET /l/:slug`) appends UTM tags and a click id (`ssclid`); the customer's site reports conversions with
that id, server to server (`POST /v1/conversions`, idempotent by `externalId`) or from the browser (`/s.js` → `POST /c`,
once per click and name, 30-day window). `link_clicks` and `conversions` are append-only like the event logs.

Privacy by construction: no raw IP is stored. A click carries `visitor_hash = sha256(HMAC(master key, day), ip, ua)`,
which counts unique visitors within a day and cannot be joined across days or reversed. Link-preview crawlers are
redirected (so cards still render) but flagged and never counted.

Outcome snapshots merge these first-party numbers (`tracked_clicks`, `conversions`, `conversion_value`, counted up to
each offset's due time) over the network's, which makes outcomes comparable across networks that report nothing alike,
and lets experiments use `conversions` as their primary metric.

## Analytics and client reports

`AnalyticsService` (`packages/core/src/services/analytics.ts`) answers one payload for a window and the equal window
before it, from what is already recorded: outcome snapshots (72h, else 24h, else latest metrics), owned clicks and
conversions, follower series and received mentions. Best times and "what worked" look back at least 90 days, bucket
by the workspace's local weekday and hour, and never claim anything from thin data (fewer than 3 posts a cell, 5 a
side). The payload types, that math and the report renderer live in one import-free module
(`analytics-shared.ts`) that the web app imports too, so its fixtures render a sample report with the real renderer.
`ReportService` turns a saved definition into a self-contained HTML document (no scripts, no external loads but the
logo), emails it (once per period on a schedule, claimed in `last_sent_period`) and serves read-only share links whose
tokens are stored only as sha256.

## Adding a connector

Implement `Connector` from `@starsign/connectors` (publish / fetchActivity / fetchMetrics / capabilities), map errors to
`ConnectorError` kinds so publishing knows what to retry, declare `meteredReads` if reads cost money, register it in
`createDefaultRegistry`. Credentials arrive decrypted in `AccountRef.auth`; never log them.

## Adding an operator

An operator is a function `(m: Starsign, gateway: ModelGateway, workspaceId) => summary` wrapped in
`m.ops.startRun/finishRun`. It reads through core, writes through core (so the gate applies), and attaches evidence to
everything it proposes. If it needs a new prompt, add one to `packages/ai/src/prompts` with a version string.

## Invariants worth defending

1. No write to a social network happens outside `PublishingService.publishPost`.
2. No post exists that did not pass `gatePost`.
3. No raw payload is ever modified or deleted.
4. Every ledger event names an actor.
5. Every forecast carries a band and a confidence; thin data is visibly thin.
6. Everything a workspace owns comes out of `GET /v1/export`.
7. Role gates are for humans; agent keys never pass them. Agents act only through the autonomy dial, on their own posts.
8. Connector resolution is strict and the mock connector never runs in production: a "published" post always touched a network.
9. API keys never appear in URLs; the live stream uses single-use, sixty-second tokens.
10. No password, session, invite or reset token is stored in a recoverable form; cookie writes need the CSRF header.
11. No raw visitor IP is stored; clicks and conversions are append-only, and tracking never changes the text people approved.
