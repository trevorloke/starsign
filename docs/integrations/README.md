# Integrations: status and owner checklist

Fourteen networks are built into Starsign. What each one can do, how to set it up, and what the platform must
approve are in the per-network files in this folder. This page is the owner's checklist: everything that code
cannot do.

None of these integrations has been exercised against the live platforms yet. The build sandbox cannot reach them,
so each connector is tested against the documented request and response shapes. Uncertain details are marked
`TODO(verify)` in code and listed under "Unverified" in each file. The first real credentials are the live test.

## Status

| Network | Connector | Connect | Works without platform approval? | Blocking approval |
|---|---|---|---|---|
| Bluesky | `bluesky` | Handle + app password | Yes, fully | None |
| Mastodon (any server) | `mastodon` | OAuth, app registered per server automatically | Yes, fully | None |
| Telegram channels | `telegram` | Bot token + channel | Yes, fully | None |
| Discord channels | `discord` | Webhook URL | Yes (publish only) | None |
| X | `x` | OAuth 2.0 + PKCE | Yes, pay-per-use billing | None; metered reads cost money |
| Facebook Pages + Instagram | `meta` | Facebook Login for Business (one login, all Pages and IG accounts) | Only for app testers | App Review (Advanced Access) + Business Verification |
| Threads | `threads` | OAuth | Only for testers | App Review |
| LinkedIn | `linkedin` | OAuth (member + every Page administered) | Member posting only | Community Management API for Pages |
| YouTube | `youtube` | Google OAuth (every channel managed) | Uploads locked private | YouTube API audit; OAuth consent verification |
| Google Business Profile | `google_business` | Google OAuth (every location) | No | GBP API access form |
| TikTok | `tiktok` | OAuth | Private posts only, 5 creators/day | Content Posting Direct Post audit |
| Pinterest | `pinterest` | OAuth | Sandbox or failures | Standard access |
| Reddit | `reddit` | OAuth | Only with an existing registered app | New public access closed 2026-10-31; commercial terms |
| Discord servers (read + reply) | `discord_bot` | Bot token + server ID | Yes, under 100 servers | Message Content intent: toggle in the Developer Portal; Discord verification at 100+ servers |
| WhatsApp (business number + business-created groups) | `whatsapp` | Phone number ID + WABA ID + System User token | Yes, on your own Meta app | Meta Business verification for higher limits; Groups API needs an Official Business Account; per-message pricing |
| WeChat Official Account (messages to the account) | `wechat` | AppID + AppSecret + original ID + server Token (+ AES key) | Verified service account needed for replies | Server IP whitelist; mainland-China hosting realities (see wechat.md) |
| LINE (groups and chats the bot is in) | `line` | Channel access token + channel secret | Yes | Message quotas by plan |
| Nostr | `nostr` | Secret key (nsec) + relays | Yes, fully | None |
| Misskey (and Sharkey, Firefish…) | `misskey` | Server + access token | Yes, fully | None |
| Lemmy | `lemmy` | Server + username + password | Yes, fully | None |
| Tumblr (every blog of a login) | `tumblr` | OAuth 2.0 | Yes | None; register an app |
| Twitch (chat, follows) | `twitch` | OAuth 2.0 + EventSub webhooks | Yes | None; register an app |
| VK (wall and communities) | `vk` | VK ID OAuth with PKCE | Yes | App registration in VK ID |
| Slack (your workspace) | `slack` | Bot token + signing secret | Yes (internal app) | None for your own workspace |
| Matrix | `matrix` | Homeserver + access token | Yes, fully | None (encrypted rooms are not readable) |
| Google Chat | `google_chat` | Space webhook URL | Yes (post only) | Reading spaces needs a Chat app + admin approval |
| Microsoft Teams | `teams` | Workflows webhook URL | Yes (post only) | Reading channels needs Graph + admin consent |
| WordPress | `wordpress` | Site + username + Application Password | Yes, fully | None |
| Ghost | `ghost` | Site + Admin API key | Yes, fully | None |
| Mailchimp | `mailchimp` | API key (+ audience) | Yes | None |
| Kit (ConvertKit) | `kit` | API key (v4) | Yes | None |
| Custom webhook (Zapier, Make, n8n…) | `webhook` | Outbound URL and/or signing secret | Yes, fully | None |
| RSS / Atom (listening) | `rss` | Feed or site URL | Yes, fully | None |

**What chat monitoring can and cannot see.** Starsign reads only what each platform's official API allows: Discord
channels its bot can read; Telegram groups its bot is in; LINE groups and chats its bot is in; messages people send
to a WhatsApp business number and groups the business created; messages people send to a WeChat Official Account.
Personal WhatsApp groups and WeChat group chats (群聊) cannot be monitored through any official API, and the
unofficial tools that try get numbers and accounts banned, so Starsign does not use them.

## Do these first (they take weeks)

1. **Pick the production domain** for `STARSIGN_PUBLIC_URL`. Every OAuth redirect (`/oauth/<connector>/callback`) and
   webhook (`/webhooks/<connector>`) is registered against it.
2. **Set up media hosting**: an S3-compatible bucket with a public URL (`STARSIGN_S3_*`). Cloudflare R2 with a custom domain
   is the recommendation. Verify that domain in TikTok's developer portal.
3. **Have a legal entity, website, privacy policy and terms URL ready.** Meta, LinkedIn, Google and TikTok reviews all ask.
4. **Meta**: create the app in a Business portfolio, start Business Verification, configure Facebook Login for Business,
   record one screencast per permission, submit App Review. For Threads, add the Threads use case and its callbacks
   (uninstall and delete-data endpoints are required before going live).
5. **Google Cloud**: one project; enable YouTube Data API v3, YouTube Analytics API and the Business Profile APIs;
   configure and verify the OAuth consent screen (sensitive scopes need a demo video); apply for the YouTube API Services
   audit; submit the Business Profile API access form.
6. **TikTok**: developer app with Login Kit and Content Posting API; submit the Direct Post audit. The room already
   implements TikTok's required posting screen (creator nickname, privacy with no default, interaction toggles, commercial
   content disclosure, music usage confirmation).
7. **LinkedIn**: developer app tied to a Company Page; request the Community Management API; ask whether programmatic
   refresh tokens can be enabled (otherwise people reconnect every 60 days).
8. **Pinterest**: developer app; apply for Standard access with a demo video.
9. **Reddit**: confirm whether a registered OAuth app is still obtainable and what commercial use requires now.
10. **X**: OAuth 2.0 app with the callback URL; set up pay-per-use billing; set `spendCaps.xReadsUsdMonthly` per workspace.

## Decisions only you can make

- **One Starsign-owned app per platform** (recommended: one review, clients sign in through it) or each client brings its own.
- **Meta**: which Business portfolio owns the app; whether to request DM permissions later (separate review); whether
  Page stories and reels are in the first review.
- **Threads**: keep `threads_delete` (shorter review without it); mention webhooks (extra permission and review).
- **LinkedIn**: auto-subscribe Page webhooks on connect; request member analytics permissions once granted.
- **YouTube**: expected uploads per day (over ~6/day needs a quota extension); default notify-subscribers and category.
- **Google Business**: Pub/Sub for near-real-time review alerts, or polling.
- **TikTok**: agents may draft but a person must confirm every TikTok post in the room (TikTok requires explicit consent);
  whether to set TikTok's AI-generated label from Starsign's disclosure record.
- **Reddit**: hide it in the room until an approved app exists.
- **Telegram**: use a dedicated bot per brand (Starsign takes over the bot's webhook).
- **Discord**: whether posts may ping roles or @everyone (suppressed today); a bot for inbox and metrics is a separate build.
- **Bluesky**: move from app passwords to Bluesky OAuth.

## Environment variables

| Variable | For |
|---|---|
| `STARSIGN_PUBLIC_URL` | OAuth redirects, webhooks, local media URLs |
| `STARSIGN_S3_ENDPOINT`, `STARSIGN_S3_REGION`, `STARSIGN_S3_BUCKET`, `STARSIGN_S3_ACCESS_KEY_ID`, `STARSIGN_S3_SECRET_ACCESS_KEY`, `STARSIGN_S3_PUBLIC_URL` | Media storage (else local disk at `STARSIGN_MEDIA_DIR`) |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X |
| `META_CLIENT_ID`, `META_CLIENT_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `META_LOGIN_CONFIG_ID` | Facebook + Instagram |
| `THREADS_CLIENT_ID`, `THREADS_CLIENT_SECRET`, `THREADS_WEBHOOK_VERIFY_TOKEN`, `THREADS_API_BASE_URL` | Threads |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION`, `LINKEDIN_SCOPES` | LinkedIn (`LINKEDIN_SCOPES="openid profile email w_member_social"` until Pages are approved) |
| `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`, `PINTEREST_API_BASE_URL` | Pinterest (sandbox URL while on Trial) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | YouTube + Google Business Profile |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_WEBHOOK_SECRET`, `TIKTOK_VIDEO_SOURCE` | TikTok |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | Reddit |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram push updates (else polling) |
| `RESEND_API_KEY`, `MAIL_FROM` | Invites and password resets by email |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | WhatsApp webhooks (the Meta app's secret, and a verify token you choose); webhook URL `/webhooks/whatsapp` |
| `TUMBLR_CLIENT_ID`, `TUMBLR_CLIENT_SECRET` | Tumblr OAuth app; redirect `/oauth/tumblr/callback` |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET` | Twitch app and EventSub signing secret (HTTPS public URL on port 443 required) |
| `VK_CLIENT_ID` (+ optional `VK_CLIENT_SECRET`, `VK_API_VERSION`) | VK ID app; redirect `/oauth/vk/callback` |
| `NOSTR_DEFAULT_RELAYS`, `MISSKEY_LIKE_REACTION`, `LEMMY_API_BASE`, `SLACK_API_BASE`, `GHOST_ACCEPT_VERSION` | Optional overrides |
| `STARSIGN_ALLOW_PRIVATE_URLS` | Let the custom webhook and RSS reach private network addresses (self-hosted n8n); off by default |
| `STARSIGN_INPROCESS_JOBS` | `0` stops the API from running background jobs when there is no `REDIS_URL` |
| `STARSIGN_BLUESKY_SEARCH_TOKEN` | Bluesky post search, if the public AppView requires sign-in (tracker public scan and the radar) |
| `STARSIGN_MASTODON_SEARCH_INSTANCES` | Servers whose public hashtag timelines the tracker reads (default `mastodon.social`) |
| `STARSIGN_MENTION_SOURCES` | Limit the tracker's public scan to some of `bluesky,mastodon,youtube,news` |
| `WECHAT_API_BASE`, `LINE_API_BASE` | Optional API host overrides (e.g. a regional WeChat host) |
| `STARSIGN_LINK_BASE_URL` | Short-link base for tracked links (default `<STARSIGN_PUBLIC_URL>/l` when public). A short domain pointed at the API reads better in posts |
| `STARSIGN_MAX_UPLOAD_MB` | Largest upload (default 100). Uploads are held in memory, so keep it well under the instance memory; with S3 storage the web app uploads straight to the bucket instead (up to 4 GB video; set bucket CORS to allow `PUT` + `content-type` from the app origin) |
| `STARSIGN_ALLOW_SIGNUP` | Open sign-up after the first owner |

## Known limits

- **Big videos stream; nothing loads a whole video into memory.** Direct uploads keep a 4 GB video out of the API's
  memory, and publishing does too: the media fetcher serves sizes, byte ranges and streams (positional reads on local
  disk, ranged GETs and one streamed GET on S3, HEAD + Range for external URLs or one streamed GET when the server has
  no Range support), and each upload-style connector reads what it sends a piece at a time:
  - **Chunked protocols, one chunk resident at a time:** X (APPEND segments of `chunkBytes`, 4 MiB), YouTube (resumable
    PUTs of `chunkSize`, 8 MiB, re-read on resume), LinkedIn (each upload instruction's byte range, about 4 MB).
  - **One request per chunk, streamed:** TikTok file mode (each chunk, up to 64 MB, is a streamed PUT with
    `Content-Range`).
  - **One request with the whole file, streamed with an exact `Content-Length`:** these APIs take the file in a single
    request body, so it is sent as a stream read in pieces of at most 4 MB (`duplex: "half"`) and memory stays flat:
    Bluesky (video service), Facebook resumable upload (bytes from `file_offset`), Slack (upload URL), Matrix (media upload),
    WordPress (`/wp/v2/media`), and as streamed multipart bodies Mastodon, Reddit (S3 form), Pinterest (S3 form),
    Telegram, Discord (webhook and bot), Misskey, Tumblr and VK. LinkedIn documents are streamed the same way.
  - **Still read whole:** images, and GIFs outside X (capped at 30 MB), YouTube custom thumbnails and LinkedIn video
    thumbnails (small images), and Ghost and Lemmy (image uploads only). A source that cannot say how big it is (an
    external URL with neither `Content-Length` nor Range support) is also read whole, because every upload protocol
    needs the size first. Networks that pull media by URL (Instagram, Threads, Facebook below its resumable threshold,
    Pinterest images, TikTok's pull mode) never need the bytes.
  - API uploads through `POST /v1/media` (local disk, no S3) are still held in memory while they are checked, so keep
    `STARSIGN_MAX_UPLOAD_MB` well under the instance memory; with S3 the web app uploads straight to the bucket.
