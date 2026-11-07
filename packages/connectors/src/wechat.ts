import { createHash } from "node:crypto";
import type { ActivityInput, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { firstLine, firstParagraph, textToHtml, uploadFileName } from "./html.ts";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";
import { decodeAesKey, field, parseWeChatXml, signatureMatches, wechatDecrypt, wechatSignature, type WeChatXml } from "./wechat-crypto.ts";

/**
 * WeChat Official Account (公众号 / 服务号) through the official platform API at api.weixin.qq.com.
 *
 * One Starsign account = one Official Account. The owner pastes AppID, AppSecret, the original ID (gh_…), the server
 * Token and, for safe mode, the EncodingAESKey, and points the account's server URL at
 * `${STARSIGN_PUBLIC_URL}/webhooks/wechat?account=<gh_id>`. Messages people send to the account arrive by webhook
 * (XML, plaintext or AES-encrypted), signed with that account's own Token, so the webhook handler uses the per-account
 * hooks (route / verifyAccount / decodeAccount / challengeAccount).
 *
 * External ids are "<openid>:<MsgId>" so a reply can find the person (customer service messages go to an openid).
 *
 * Publishing makes an article (图文): cover → permanent material, body images → uploadimg, draft/add, then
 * freepublish/submit + bounded polling of freepublish/get (no push to followers), or, when the account is set to
 * broadcast, message/mass/sendall to all followers (push; limited quota).
 *
 * Personal chats and WeChat groups are NOT reachable through any official API; see docs/integrations/wechat.md.
 */

const API_BASE = "https://api.weixin.qq.com";
/** Replay window for signed deliveries (seconds, either direction). */
const MAX_SKEW_SECONDS = 300;
/** Renew a cached access token this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Inputs that mean "no EncodingAESKey": empty (the field is optional), or a placeholder people type anyway. */
const NO_AES_KEY = /^(-|none|no|plain|plaintext|明文)?$/i;

// ---- article publishing limits -------------------------------------------------------------
// TODO(verify): title limit is 64 (characters per this build's brief; some third-party tools say 64 bytes).
export const WECHAT_TITLE_MAX = 64;
// TODO(verify): author limit (16 characters) and digest limit (120 characters) for draft/add.
export const WECHAT_AUTHOR_MAX = 16;
const DIGEST_MAX = 120;
/** draft/add: content must be under 20,000 characters (and under 1 MB). */
const CONTENT_MAX = 20_000;
/** media/uploadimg (images inside the article body): JPG/PNG up to 1 MB. */
const INLINE_IMAGE_MAX = 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
/** material/add_material?type=image (the cover): up to 10 MB, bmp/png/jpeg/jpg/gif. */
const COVER_IMAGE_MAX = 10 * 1024 * 1024;
/** Answers to "Send to followers" that mean yes. */
const YES = /^(y|yes|true|1|on|是|发送)$/i;
const NO = /^(-|n|no|false|0|off|否)?$/i;
/** freepublish/get polling, bounded. */
const PUBLISH_POLL_ATTEMPTS = 10;
const PUBLISH_POLL_INTERVAL_MS = 3000;

export const WeChatAuth = z.object({
  appId: z.string().regex(/^wx[0-9a-zA-Z]{16}$/, "AppID looks like wx followed by 16 letters or digits"),
  appSecret: z.string().regex(/^[0-9a-zA-Z]{16,64}$/, "AppSecret is 32 letters or digits"),
  originalId: z.string().regex(/^gh_[0-9a-zA-Z]{6,32}$/, "the original ID looks like gh_ followed by letters and digits"),
  // Server configuration rule: 3-32 English letters or digits.
  token: z.string().regex(/^[A-Za-z0-9]{3,32}$/, "the server Token is 3-32 English letters or digits"),
  encodingAesKey: z.string().regex(/^[A-Za-z0-9]{43}$/, "the EncodingAESKey is 43 letters and digits").optional(),
});
export type WeChatAuth = z.infer<typeof WeChatAuth>;

export interface WeChatConnectorOptions {
  /** Override for api.weixin.qq.com (e.g. api2.weixin.qq.com, or a regional sh./sz./hk. host). */
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** STARSIGN_PUBLIC_URL, used to tell the owner which server URL to configure. */
  publicUrl?: string;
  /** freepublish/get checks before giving up with a retryable error (default 10, every 3 s). */
  publishPollAttempts?: number;
  publishPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface WeChatFailure {
  errcode: number;
  errmsg: string;
}

/** Strip anything secret from text before it lands in an error. */
function scrub(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.replaceAll(s, "<redacted>");
  return out.replace(/access_token=[^&\s"]+/g, "access_token=<redacted>");
}

/**
 * errcode → ConnectorError. WeChat answers HTTP 200 with { errcode, errmsg } for almost everything.
 * Source for the codes: the global return code page and each API's page on developers.weixin.qq.com.
 */
export function mapWeChatError(errcode: number, errmsg: string, context: string): ConnectorError {
  const cause: WeChatFailure = { errcode, errmsg };
  const msg = `wechat ${context}: ${errmsg || "error"} (errcode ${errcode})`;
  switch (errcode) {
    case -1:
      return new ConnectorError(`${msg}: WeChat is busy, try again shortly`, "network", true, cause);
    case 40164:
      return new ConnectorError(
        `${msg}: this server's outbound IP is not on the Official Account's API IP whitelist. Add the IP shown above in the WeChat Developer Platform (API IP 白名单 / IP whitelist) for this AppID, wait a few minutes, then try again`,
        "rejected",
        false,
        cause,
      );
    // TODO(verify): 89501/89503 are returned for calls from a new IP when no whitelist is set and an admin must confirm.
    case 89501:
    case 89503:
      return new ConnectorError(`${msg}: an administrator must approve calls from this server's IP in WeChat, or add the IP to the API IP whitelist`, "rejected", false, cause);
    case 40001:
    case 40014:
    case 42001:
      return new ConnectorError(`${msg}: the access token was not accepted`, "auth", false, cause);
    case 40013:
    case 40125:
    case 41002:
    case 41004:
    case 40243:
      return new ConnectorError(`${msg}: the AppID or AppSecret was not accepted (reset or unfreeze the AppSecret in the WeChat Developer Platform if needed)`, "auth", false, cause);
    case 45009:
    case 45011:
      return new ConnectorError(`${msg}: WeChat API quota reached, try again later`, "rate_limit", true, cause);
    case 45015:
      return new ConnectorError(
        `${msg}: WeChat only allows replies within 48 hours of the person's last message (or they unfollowed the account). Wait for them to write again`,
        "rejected",
        false,
        cause,
      );
    // TODO(verify): 45047 is the customer-service per-user downlink cap.
    case 45047:
      return new ConnectorError(`${msg}: too many messages sent to this person without a reply from them`, "rejected", false, cause);
    case 43004:
      return new ConnectorError(`${msg}: the person no longer follows the Official Account`, "rejected", false, cause);
    case 48001:
      return new ConnectorError(`${msg}: this Official Account is not authorized for this API (customer service messages need a verified service account)`, "rejected", false, cause);
    case 40003:
      return new ConnectorError(`${msg}: unknown openid for this Official Account`, "rejected", false, cause);
    // ---- article publishing and mass send
    // TODO(verify): 45028 "has no masssend quota" (seen on the developer forum, not on the code page).
    case 45028:
      return new ConnectorError(
        `${msg}: the account has used up its mass-send quota (service accounts get a few broadcasts a month, subscription accounts one a day). Turn off "Send to followers" to publish without a push, or wait for the quota to reset`,
        "rejected",
        false,
        cause,
      );
    // TODO(verify): 45065/45066/45067 are the clientmsgid codes of mass/sendall.
    case 45065:
      return new ConnectorError(`${msg}: this post was already sent to followers (same clientmsgid); it was not sent again`, "rejected", false, cause);
    case 45066:
      return new ConnectorError(`${msg}: mass send retried too quickly, try again in a minute`, "rate_limit", true, cause);
    case 40007:
      return new ConnectorError(`${msg}: WeChat did not accept the media id (the cover or draft was not uploaded for this account)`, "rejected", false, cause);
    // TODO(verify): 40005/40009/40113 are "unsupported file type" / "image too large" / "unsupported file type" for uploads.
    case 40005:
    case 40113:
      return new ConnectorError(`${msg}: WeChat does not accept this image type (use JPG or PNG)`, "rejected", false, cause);
    case 40009:
      return new ConnectorError(`${msg}: the image is too large for WeChat (article images up to 1 MB, the cover up to 10 MB)`, "rejected", false, cause);
    // TODO(verify): freepublish/submit codes as remembered from the API page: 53503 draft failed the publish check,
    // 53504 the draft must be opened in the web console first, 53505 the draft must be saved manually first.
    case 53503:
      return new ConnectorError(`${msg}: the article did not pass WeChat's publish check (content, links or images)`, "rejected", false, cause);
    case 53504:
    case 53505:
      return new ConnectorError(`${msg}: WeChat wants this draft opened and saved in the Official Account console before it can be published`, "rejected", false, cause);
    default:
      return new ConnectorError(msg, "rejected", false, cause);
  }
}

const isTokenError = (e: unknown) => e instanceof ConnectorError && [40001, 40014, 42001].includes((e.cause as WeChatFailure | undefined)?.errcode ?? 0);
const isPermissionError = (e: unknown) => e instanceof ConnectorError && [48001, 50001, 50002].includes((e.cause as WeChatFailure | undefined)?.errcode ?? 0);

// ---- message mapping ----------------------------------------------------------------------

/** One inbound message → the account (ToUserName) and the activity, or null for messages Starsign ignores. */
export function wechatMessageToActivity(m: WeChatXml): { accountExternalId: string; item: ActivityInput } | null {
  const to = field(m, "ToUserName");
  const openid = field(m, "FromUserName");
  const type = field(m, "MsgType");
  const created = Number(field(m, "CreateTime"));
  if (!to || !openid || !type) return null;
  const occurredAt = new Date((Number.isFinite(created) && created > 0 ? created : 0) * 1000).toISOString();
  const msgId = field(m, "MsgId");
  const base = {
    network: "wechat" as const,
    authorHandle: openid,
    authorName: null,
    parentExternalId: null,
    occurredAt,
    raw: m,
    conversation: { id: openid, type: "direct" as const },
  };
  if (type === "event") {
    const event = (field(m, "Event") ?? "").toLowerCase();
    if (event !== "subscribe") return null; // unsubscribe, menu clicks, scans, template receipts: ignored
    const scene = field(m, "EventKey")?.replace(/^qrscene_/, "");
    return {
      accountExternalId: to,
      item: { ...base, kind: "follow", externalId: `${openid}:subscribe:${field(m, "CreateTime") ?? "0"}`, text: scene ? `followed (QR scene ${scene})` : null, url: null },
    };
  }
  let text: string | null;
  let url: string | null = null;
  switch (type) {
    case "text":
      text = field(m, "Content") ?? "";
      break;
    case "image":
      url = field(m, "PicUrl") ?? null;
      text = url ? `[image] ${url}` : "[image]";
      break;
    case "voice": {
      // TODO(verify): Recognition is only present when speech recognition is enabled and is being phased out.
      const said = field(m, "Recognition")?.trim();
      text = said ? `[voice] ${said}` : "[voice message]";
      break;
    }
    case "video":
    case "shortvideo":
      text = "[video]";
      break;
    case "location": {
      const label = field(m, "Label");
      const x = field(m, "Location_X");
      const y = field(m, "Location_Y");
      text = `[location]${label ? ` ${label}` : ""}${x && y ? ` (${x}, ${y})` : ""}`;
      break;
    }
    case "link": {
      url = field(m, "Url") ?? null;
      text = ["[link]", field(m, "Title"), field(m, "Description"), url].filter(Boolean).join(" ");
      break;
    }
    default:
      text = `[${type}]`;
  }
  return {
    accountExternalId: to,
    item: { ...base, kind: "dm", externalId: `${openid}:${msgId ?? field(m, "CreateTime") ?? "0"}`, text, url },
  };
}

/** The openid inside an external id "<openid>:<msgid>" (or a bare openid). */
export function openidOf(externalId: string): string {
  const i = externalId.indexOf(":");
  const openid = i >= 0 ? externalId.slice(0, i) : externalId;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(openid)) throw new ConnectorError(`wechat: "${externalId}" does not name a WeChat user`, "rejected", false);
  return openid;
}

// ---- article publishing ---------------------------------------------------------------------

/** Title and body of the article: options.title, or the first line of the text (which then leaves the body). */
export function articleParts(text: string, title: string | undefined): { title: string; body: string } {
  const given = title?.trim();
  if (given) return { title: given, body: text.trim() };
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const first = firstLine(normalized);
  if (!first) return { title: "", body: "" };
  const lines = normalized.split("\n");
  const at = lines.findIndex((l) => l.trim() !== "");
  const body = lines
    .slice(at + 1)
    .join("\n")
    .trim();
  // A one-line post keeps its line as the body too, so the article is not empty.
  return { title: first, body: body || normalized };
}

/**
 * freepublish/get publish_status → a ConnectorError, or null for success (0). 1 = still publishing.
 * Codes from the API page: 0 success, 1 publishing, 2 original-content check failed, 3 general failure, 4 platform review
 * failed, 5 deleted by the user after success, 6 banned by the system after success.
 */
export function freepublishFailure(status: number, publishId: string, failIdx: unknown): ConnectorError | null {
  const cause = { publish_status: status, publish_id: publishId, fail_idx: failIdx };
  const p = `wechat freepublish ${publishId}`;
  switch (status) {
    case 0:
      return null;
    case 1:
      return new ConnectorError(`${p}: WeChat is still publishing the article; retry later (it will not be submitted twice)`, "unknown", true, cause);
    case 2:
      return new ConnectorError(`${p}: the original-content (原创) check failed; the article looks like a copy of an existing one. Remove the original claim or change the content`, "rejected", false, cause);
    case 3:
      return new ConnectorError(`${p}: WeChat failed to publish the article (常规失败, no reason given); check the draft in the Official Account console`, "rejected", false, cause);
    case 4:
      return new ConnectorError(`${p}: the article did not pass WeChat's platform review (平台审核不通过)`, "rejected", false, cause);
    case 5:
      return new ConnectorError(`${p}: the article was published and then deleted by the account`, "rejected", false, cause);
    case 6:
      return new ConnectorError(`${p}: the article was published and then banned by WeChat (系统封禁)`, "rejected", false, cause);
    default:
      return new ConnectorError(`${p}: publish failed with status ${status}`, "rejected", false, cause);
  }
}

/** Mass-send results are kept as "mass:<msg_data_id>:<YYYY-MM-DD China date>" so metrics can ask datacube for that day. */
const MASS_ID = /^mass:(\d+):(\d{4}-\d{2}-\d{2})$/;

/** The calendar day in China (UTC+8), as datacube dates are. */
function chinaDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** clientmsgid for mass/sendall (≤ 32 bytes): stable per idempotency key, so WeChat itself refuses a second send. */
function clientMsgId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}

interface PendingPublish {
  publishId: string;
  draftMediaId: string;
  note: Record<string, unknown>;
}

// ---- connector ----------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class WeChatConnector implements Connector {
  readonly name = "wechat";
  readonly networks: readonly Network[] = ["wechat"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "appId", label: "AppID", placeholder: "wx1234567890abcdef" },
    { key: "appSecret", label: "AppSecret", placeholder: "32 letters and digits", secret: true },
    { key: "originalId", label: "Original ID (原始ID)", placeholder: "gh_0123456789ab" },
    { key: "token", label: "Server Token (服务器配置 Token)", placeholder: "the Token you entered in the server configuration", secret: true },
    { key: "encodingAesKey", label: "EncodingAESKey (only for safe mode)", placeholder: "43 characters; leave empty for plaintext mode", secret: true, optional: true },
    { key: "author", label: "Article author (作者)", placeholder: "shown under article titles; optional", optional: true },
    { key: "broadcast", label: "Send to followers (uses your mass-send quota)", placeholder: "yes, or leave empty to publish without a push", optional: true },
  ] as const;
  readonly webhook: WebhookHandler;
  /** Set by core: reads image bytes for the cover and article images. */
  media?: MediaFetcher;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly publicUrl: string | undefined;
  private readonly pollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Access tokens per AppID, process-local. Tokens live ~2 hours. */
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflightTokens = new Map<string, Promise<string>>();
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** Submitted freepublish jobs per idempotency key, so a retry after "still publishing" polls instead of resubmitting. */
  private readonly pendingPublishes = new Map<string, PendingPublish>();

  constructor(opts: WeChatConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.pollAttempts = Math.max(1, opts.publishPollAttempts ?? PUBLISH_POLL_ATTEMPTS);
    this.pollIntervalMs = opts.publishPollIntervalMs ?? PUBLISH_POLL_INTERVAL_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.webhook = {
      verify: () => false, // never used: each account has its own Token, so route + verifyAccount take over
      route: (raw, query) => this.route(raw, query),
      challengeAccount: (account, query) => this.challengeAccount(account, query),
      verifyAccount: (account, _headers, raw, query) => this.verifyAccount(account, raw, query),
      decodeAccount: (account, raw, query) => this.decodeAccount(account, raw, query),
      parse: (body) => this.parse(body),
      // WeChat shows "该公众号暂时无法提供服务" for any reply that is neither XML nor "success"/"".
      ack: { body: "success", contentType: "text/plain" },
    };
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: false, fetchMetrics: true, meteredReads: false, reply: true, moderate: false, accountMetrics: true, webhooks: true, video: false, kinds: ["post"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const aes = (p.inputs.encodingAesKey ?? "").trim();
    const parsed = WeChatAuth.safeParse({
      appId: (p.inputs.appId ?? "").trim(),
      appSecret: (p.inputs.appSecret ?? "").trim(),
      originalId: (p.inputs.originalId ?? "").trim(),
      token: (p.inputs.token ?? "").trim(),
      ...(NO_AES_KEY.test(aes) ? {} : { encodingAesKey: aes }),
    });
    if (!parsed.success) {
      // Name the field, never echo the value.
      const issue = parsed.error.issues[0];
      throw new ConnectorError(`wechat: ${issue?.message ?? "the credentials are not in the expected format"}`, "rejected", false);
    }
    const auth = parsed.data;
    const author = (p.inputs.author ?? "").trim();
    if ([...author].length > WECHAT_AUTHOR_MAX) throw new ConnectorError(`wechat: the article author is at most ${WECHAT_AUTHOR_MAX} characters`, "rejected", false);
    const broadcastInput = (p.inputs.broadcast ?? "").trim();
    if (!YES.test(broadcastInput) && !NO.test(broadcastInput)) throw new ConnectorError('wechat: answer "yes" to "Send to followers", or leave it empty', "rejected", false);
    const broadcast = YES.test(broadcastInput);
    if (auth.encodingAesKey) {
      try {
        decodeAesKey(auth.encodingAesKey);
      } catch {
        throw new ConnectorError("wechat: the EncodingAESKey is not valid (43 letters and digits from the server configuration)", "rejected", false);
      }
    }
    // Proves AppID + AppSecret and that this server's IP may call the API.
    await this.accessToken(auth);
    // TODO(verify): self-developed Official Accounts have no API that returns their own nickname; only third-party
    // platforms (api_get_authorizer_info) do. The handle is therefore the original ID.
    const identity: AccountIdentity = { externalId: auth.originalId, handle: auth.originalId, displayName: null };
    const config: Record<string, unknown> = {
      appId: auth.appId,
      mode: auth.encodingAesKey ? "safe" : "plaintext",
      ...(this.publicUrl ? { webhookUrl: `${this.publicUrl}/webhooks/wechat?account=${encodeURIComponent(auth.originalId)}` } : {}),
      ...(author ? { author } : {}),
      ...(broadcast ? { broadcast: true } : {}),
    };
    return [{ network: "wechat", identity, auth: { ...auth }, config }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = WeChatAuth.safeParse(auth);
    if (!parsed.success) throw new ConnectorError("wechat: auth needs appId, appSecret, originalId and token", "auth", false);
    await this.accessToken(parsed.data);
    return { externalId: parsed.data.originalId, handle: parsed.data.originalId, displayName: null };
  }

  // ---- publish: articles (图文) ------------------------------------------------------------

  /** Article pre-flight: a title (≤ 64), a cover image, images only, no threads, content under 20,000 characters. */
  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const opts = input.options ?? {};
    if (opts.kind && opts.kind !== "post") issues.push({ code: "unsupported_media", message: `WeChat Official Accounts publish articles only (kind "post"), not "${opts.kind}"` });
    const { title, body } = articleParts(input.text, opts.title);
    if (!title) issues.push({ code: "empty", message: "a WeChat article needs a title: set a title or start the text with one line" });
    else if ([...title].length > WECHAT_TITLE_MAX) issues.push({ code: "too_long", message: `the WeChat article title is ${[...title].length} characters; the limit is ${WECHAT_TITLE_MAX}` });
    const images = input.media.filter((m) => m.kind === "image");
    if (images.length === 0) issues.push({ code: "media_required", message: "a WeChat article needs a cover image: attach at least one image (the first one becomes the cover)" });
    for (const m of input.media) {
      if (m.kind !== "image") issues.push({ code: "unsupported_media", message: `WeChat articles take images only, not ${m.kind}` });
      else if (m.bytes !== undefined && m.bytes > COVER_IMAGE_MAX) issues.push({ code: "unsupported_media", message: "the cover image is larger than WeChat's 10 MB limit" });
    }
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "WeChat articles have no threads" });
    // Each inline image adds a <figure><img> of about 150 characters with its mmbiz URL.
    const estimate = textToHtml(body, opts.link ? { link: opts.link } : {}).length + images.length * 150;
    if (estimate > CONTENT_MAX) issues.push({ code: "too_long", message: `the article is about ${estimate} characters of HTML; WeChat accepts under ${CONTENT_MAX}` });
    return issues;
  }

  /**
   * Publish an article: upload the cover (permanent material) and the article images (uploadimg), create a draft, then
   * either freepublish it (default: appears on the account's profile, no push) or, when the account is set to
   * broadcast, mass-send it to all followers (push; counts against the mass-send quota).
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const issues = this.validate(account, input);
      if (issues[0]) throw new ConnectorError(`wechat: ${issues[0].message}`, "rejected", false, issues);
      const broadcast = account.config.broadcast === true;

      // A retry of a freepublish job that was still running polls the same job.
      const pending = this.pendingPublishes.get(input.idempotencyKey);
      if (pending && !broadcast) return this.awaitPublish(auth, input.idempotencyKey, pending);

      const draft = await this.createDraft(auth, account, input);
      const draftMediaId = draft.mediaId;
      // Images over 1 MB or not JPG/PNG are the cover only (uploadimg refuses them); the result says which.
      const note = draft.skippedImages.length > 0 ? { images_not_in_body: draft.skippedImages } : {};
      if (broadcast) {
        const sent = await this.massSend(auth, draftMediaId, input.idempotencyKey);
        return { ...sent, raw: { ...(sent.raw as object), ...note } };
      }
      const submitted = (await this.call(auth, "freepublish/submit", "POST", { media_id: draftMediaId })) as { publish_id?: string | number };
      if (submitted.publish_id === undefined) throw new ConnectorError("wechat freepublish/submit: no publish_id in the response", "unknown", false);
      const job: PendingPublish = { publishId: String(submitted.publish_id), draftMediaId, note };
      this.pendingPublishes.set(input.idempotencyKey, job);
      return this.awaitPublish(auth, input.idempotencyKey, job);
    });
  }

  /** Upload images and add the draft; returns the draft's media_id and the images left out of the body. */
  private async createDraft(auth: WeChatAuth, account: AccountRef, input: PublishInput): Promise<{ mediaId: string; skippedImages: string[] }> {
    const opts = input.options ?? {};
    const { title, body } = articleParts(input.text, opts.title);
    const images = input.media.filter((m) => m.kind === "image");
    const source = mediaSource(this.media, this.fetchImpl);
    let thumbMediaId: string | null = null;
    const inline: { src: string; alt?: string | null }[] = [];
    const skipped: string[] = [];
    for (const [i, m] of images.entries()) {
      const { bytes, mime } = await source.fetch(m);
      if (i === 0) {
        if (bytes.byteLength > COVER_IMAGE_MAX) throw new ConnectorError("wechat: the cover image is larger than WeChat's 10 MB limit", "rejected", false);
        thumbMediaId = await this.uploadCover(auth, m, bytes, mime);
      }
      // Images inside the body must be WeChat-hosted (mmbiz.qpic.cn) URLs from uploadimg: JPG/PNG up to 1 MB.
      if (bytes.byteLength <= INLINE_IMAGE_MAX && INLINE_IMAGE_TYPES.has(mime.toLowerCase())) {
        inline.push({ src: await this.uploadInlineImage(auth, m, bytes, mime), alt: m.alt ?? null });
      } else {
        skipped.push(m.url);
      }
    }
    if (!thumbMediaId) throw new ConnectorError("wechat: a WeChat article needs a cover image", "rejected", false);
    // textToHtml escapes everything that is not its small markdown subset, so no script/iframe/style can get through.
    const content = textToHtml(body, { images: inline, link: opts.link });
    const author = typeof account.config.author === "string" ? account.config.author.trim() : "";
    const article: Record<string, unknown> = {
      article_type: "news",
      title,
      ...(author ? { author } : {}),
      digest: firstParagraph(body, DIGEST_MAX) || title,
      content,
      ...(opts.link ? { content_source_url: opts.link } : {}),
      thumb_media_id: thumbMediaId,
      need_open_comment: 0,
      only_fans_can_comment: 0,
    };
    const draft = (await this.call(auth, "draft/add", "POST", { articles: [article] })) as { media_id?: string };
    if (!draft.media_id) throw new ConnectorError("wechat draft/add: no media_id in the response", "unknown", false);
    // Not an error: the cover still shows; the body just lacks images WeChat would not host inline.
    return { mediaId: draft.media_id, skippedImages: skipped };
  }

  /** Permanent image material → media_id (the article's thumb_media_id). */
  private async uploadCover(auth: WeChatAuth, m: Media, bytes: Uint8Array, mime: string): Promise<string> {
    const form = new FormData();
    form.set("media", new Blob([bytes], { type: mime }), uploadFileName(m.url, mime, "cover"));
    const r = (await this.call(auth, "material/add_material?type=image", "POST", form)) as { media_id?: string };
    if (!r.media_id) throw new ConnectorError("wechat material/add_material: no media_id in the response", "unknown", false);
    return r.media_id;
  }

  /** An image for the article body → its WeChat URL. */
  private async uploadInlineImage(auth: WeChatAuth, m: Media, bytes: Uint8Array, mime: string): Promise<string> {
    const form = new FormData();
    form.set("media", new Blob([bytes], { type: mime }), uploadFileName(m.url, mime, "image"));
    const r = (await this.call(auth, "media/uploadimg", "POST", form)) as { url?: string };
    if (!r.url) throw new ConnectorError("wechat media/uploadimg: no url in the response", "unknown", false);
    return r.url;
  }

  /** Poll freepublish/get (bounded). Success → article_id and the article URL. */
  private async awaitPublish(auth: WeChatAuth, key: string, job: PendingPublish): Promise<PublishResult> {
    for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.pollIntervalMs);
      const r = (await this.call(auth, "freepublish/get", "POST", { publish_id: job.publishId })) as {
        publish_status?: number;
        article_id?: string;
        article_detail?: { item?: { idx?: number; article_url?: string }[] };
        fail_idx?: unknown;
      };
      const status = typeof r.publish_status === "number" ? r.publish_status : 1;
      if (status === 1) continue;
      this.pendingPublishes.delete(key);
      const failure = freepublishFailure(status, job.publishId, r.fail_idx);
      if (failure) throw failure;
      if (!r.article_id) throw new ConnectorError(`wechat freepublish ${job.publishId}: published but no article_id in the response`, "unknown", false);
      return { externalId: r.article_id, url: r.article_detail?.item?.[0]?.article_url ?? null, raw: { ...r, publish_id: job.publishId, draft_media_id: job.draftMediaId, ...job.note } };
    }
    throw freepublishFailure(1, job.publishId, undefined)!;
  }

  /** mass/sendall to every follower with the draft as mpnews. */
  private async massSend(auth: WeChatAuth, draftMediaId: string, idempotencyKey: string): Promise<PublishResult> {
    const r = (await this.call(auth, "message/mass/sendall", "POST", {
      filter: { is_to_all: true },
      mpnews: { media_id: draftMediaId },
      msgtype: "mpnews",
      // 0: stop when WeChat judges the article a reprint (the safe default).
      send_ignore_reprint: 0,
      clientmsgid: clientMsgId(idempotencyKey),
    })) as { msg_id?: number | string; msg_data_id?: number | string };
    // TODO(verify): msg_data_id is returned for mpnews and is the prefix of datacube's msgid ("<msg_data_id>_<index>").
    const dataId = r.msg_data_id ?? r.msg_id;
    if (dataId === undefined) throw new ConnectorError("wechat message/mass/sendall: no msg_id in the response", "unknown", false);
    // The send is asynchronous (MASSSENDJOBFINISH event); there is no article URL in the response.
    return { externalId: `mass:${dataId}:${chinaDate(this.now())}`, url: null, raw: { ...r, draft_media_id: draftMediaId } };
  }

  // ---- engage ---------------------------------------------------------------------------

  /** Customer service text message to the person (only within 48 hours of their last message). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const openid = openidOf(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("wechat reply: the message is empty", "rejected", false);
      const raw = await this.call(auth, "message/custom/send", "POST", { touser: openid, msgtype: "text", text: { content: input.text } });
      // The API returns no message id; this id is Starsign's own, unique per reply.
      return { externalId: `${openid}:reply:${input.idempotencyKey}`, url: null, raw };
    });
  }

  // ---- listen ---------------------------------------------------------------------------

  /** Webhook-only: WeChat has no API to read messages back. */
  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  /**
   * Best-effort per-article metrics for mass-sent articles ("mass:<msg_data_id>:<date>") from
   * POST /datacube/getarticletotal (one send date per call; totals up to 7 days after sending; a day's data appears the
   * next day). Freepublish articles (article_id) are not covered: getarticletotal counts mass sends only, and the newer
   * per-article publish statistics API was not confirmed for this build. TODO(verify): a freepublish per-article API.
   */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const byDate = new Map<string, Set<string>>();
    for (const id of externalIds) {
      const m = MASS_ID.exec(id);
      if (!m) continue;
      const date = m[2]!;
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date)!.add(m[1]!);
    }
    if (byDate.size === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const [date, dataIds] of byDate) {
      let body: { list?: { msgid?: string; details?: Record<string, unknown>[] }[] };
      try {
        body = (await this.call(auth, "/datacube/getarticletotal", "POST", { begin_date: date, end_date: date })) as typeof body;
      } catch (e) {
        // Not permitted, or the date is not available yet (data lags a day): no numbers for these ids this time.
        if (e instanceof ConnectorError && e.kind === "rejected") continue;
        throw e;
      }
      for (const row of body.list ?? []) {
        const [dataId] = String(row.msgid ?? "").split("_");
        if (!dataId || !dataIds.has(dataId)) continue;
        // Each details entry is the running total up to its stat_date; the last one is the latest.
        const latest = row.details?.[row.details.length - 1];
        if (!latest) continue;
        const entityId = `mass:${dataId}:${date}`;
        // TODO(verify): field names int_page_read_count/int_page_read_user/share_count/add_to_fav_count.
        const pairs: [MetricName, unknown][] = [
          ["impressions", latest.int_page_read_count],
          ["reach", latest.int_page_read_user],
          ["shares", latest.share_count],
          ["saves", latest.add_to_fav_count],
        ];
        // An article can be one of several in a send (msgid "<id>_<n>"): sum them under the send's id.
        for (const [metric, value] of pairs) {
          if (typeof value !== "number" || !Number.isFinite(value)) continue;
          const existing = out.find((r) => r.entityId === entityId && r.metric === metric);
          if (existing) existing.value += value;
          else out.push({ entityType: "post_variant", entityId, metric, value, observedAt, source: "wechat" });
        }
      }
    }
    return out;
  }

  /** followers_total from user/get (field `total`), when the account is allowed to call it. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    try {
      const body = (await this.call(auth, "user/get", "GET")) as { total?: number };
      if (typeof body.total !== "number") return [];
      return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: body.total, observedAt: this.now().toISOString(), source: "wechat" }];
    } catch (e) {
      if (isPermissionError(e)) return [];
      throw e;
    }
  }

  // ---- webhooks -------------------------------------------------------------------------

  private route(raw: string, query: Record<string, string>): { network: Network; accountExternalId: string } | null {
    const fromQuery = query.account?.trim();
    if (fromQuery && /^gh_[0-9a-zA-Z]{1,64}$/.test(fromQuery)) return { network: "wechat", accountExternalId: fromQuery };
    if (!raw) return null;
    try {
      const to = field(parseWeChatXml(raw), "ToUserName");
      return to ? { network: "wechat", accountExternalId: to } : null;
    } catch {
      return null;
    }
  }

  private fresh(query: Record<string, string>): boolean {
    const ts = Number(query.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return Math.abs(this.now().getTime() / 1000 - ts) <= MAX_SKEW_SECONDS;
  }

  /** Server URL check: signature = sha1(sorted [token, timestamp, nonce]) → echo echostr. */
  private challengeAccount(account: AccountRef, query: Record<string, string>): string | null {
    const auth = WeChatAuth.safeParse(account.auth ?? {});
    if (!auth.success) return null;
    const { signature, timestamp, nonce, echostr } = query;
    if (!timestamp || nonce === undefined || echostr === undefined || !this.fresh(query)) return null;
    // TODO(verify): in safe mode the URL check also sends msg_signature + an encrypted echostr only for third-party
    // platforms / WeCom; Official Accounts send the plain echostr with `signature` in every mode.
    return signatureMatches(wechatSignature([auth.data.token, timestamp, nonce]), signature) ? echostr : null;
  }

  private verifyAccount(account: AccountRef, raw: string, query: Record<string, string>): boolean {
    const parsed = WeChatAuth.safeParse(account.auth ?? {});
    if (!parsed.success) return false;
    const { token } = parsed.data;
    const { timestamp, nonce } = query;
    if (!timestamp || nonce === undefined || !this.fresh(query)) return false;
    let encrypt: string | undefined;
    try {
      encrypt = field(parseWeChatXml(raw), "Encrypt");
    } catch {
      return false;
    }
    if (encrypt !== undefined || query.encrypt_type === "aes") {
      // Safe/compatible mode: msg_signature over the Encrypt field (the docs say not to use `signature` here).
      if (encrypt === undefined) return false;
      return signatureMatches(wechatSignature([token, timestamp, nonce, encrypt]), query.msg_signature);
    }
    return signatureMatches(wechatSignature([token, timestamp, nonce]), query.signature);
  }

  private decodeAccount(account: AccountRef, raw: string, _query: Record<string, string>): WeChatXml {
    const outer = parseWeChatXml(raw);
    const encrypt = field(outer, "Encrypt");
    if (encrypt === undefined) return outer;
    const auth = parseAuth(account);
    if (!auth.encodingAesKey) throw new ConnectorError("wechat: this delivery is encrypted but the account has no EncodingAESKey; reconnect it with the key", "auth", false);
    // Throws when the AppID at the end does not match: the message was not encrypted for this account.
    return parseWeChatXml(wechatDecrypt(encrypt, auth.encodingAesKey, auth.appId));
  }

  private parse(body: unknown): WebhookBatch[] {
    if (!body || typeof body !== "object") return [];
    const r = wechatMessageToActivity(body as WeChatXml);
    return r ? [{ network: "wechat", accountExternalId: r.accountExternalId, items: [r.item] }] : [];
  }

  // ---- transport ------------------------------------------------------------------------

  /** A valid access token for this AppID, from the cache or stable_token. */
  async accessToken(auth: WeChatAuth, opts: { forceRefresh?: boolean; reject?: string } = {}): Promise<string> {
    const cached = this.tokens.get(auth.appId);
    if (!opts.forceRefresh && cached && cached.token !== opts.reject && cached.expiresAt - TOKEN_MARGIN_MS > this.now().getTime()) return cached.token;
    const key = `${auth.appId}:${opts.forceRefresh ? "force" : "normal"}`;
    const inflight = this.inflightTokens.get(key);
    if (inflight) return inflight;
    const p = this.fetchToken(auth, opts.forceRefresh === true).finally(() => this.inflightTokens.delete(key));
    this.inflightTokens.set(key, p);
    return p;
  }

  private async fetchToken(auth: WeChatAuth, forceRefresh: boolean): Promise<string> {
    const body = await this.request(`${this.apiBase}/cgi-bin/stable_token`, "POST", { grant_type: "client_credential", appid: auth.appId, secret: auth.appSecret, ...(forceRefresh ? { force_refresh: true } : {}) }, "stable_token", auth);
    const b = body as { access_token?: string; expires_in?: number };
    if (!b.access_token) throw new ConnectorError("wechat stable_token: no access token in the response", "unknown", false);
    this.tokens.set(auth.appId, { token: b.access_token, expiresAt: this.now().getTime() + (b.expires_in ?? 7200) * 1000 });
    return b.access_token;
  }

  /**
   * Call /cgi-bin/<path> (or an absolute API path starting with "/", e.g. /datacube/...) with the account's access
   * token, refreshing it once on 40001/42001/40014. A FormData payload is sent as multipart (media uploads).
   */
  private async call(auth: WeChatAuth, path: string, method: "GET" | "POST", payload?: unknown): Promise<unknown> {
    const base = path.startsWith("/") ? `${this.apiBase}${path}` : `${this.apiBase}/cgi-bin/${path}`;
    const url = (t: string) => `${base}${base.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(t)}`;
    const context = path.replace(/^\//, "").replace(/\?.*$/, "");
    const token = await this.accessToken(auth);
    try {
      return await this.request(url(token), method, payload, context, auth, token);
    } catch (e) {
      if (!isTokenError(e)) throw e;
      this.tokens.delete(auth.appId);
      // stable_token in normal mode returns the token WeChat considers current; if that is the one just rejected,
      // force a new one (force_refresh is limited to ~20 a day, so only then).
      let next = await this.accessToken(auth, { reject: token });
      if (next === token) next = await this.accessToken(auth, { forceRefresh: true });
      return this.request(url(next), method, payload, context, auth, next);
    }
  }

  private async request(url: string, method: "GET" | "POST", payload: unknown, context: string, auth: WeChatAuth, token?: string): Promise<unknown> {
    const secrets = [auth.appSecret, auth.token, auth.encodingAesKey, token];
    let res: Response;
    try {
      const init: RequestInit =
        method === "GET"
          ? { method }
          : payload instanceof FormData
            ? { method, body: payload }
            : { method, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload ?? {}) };
      res = await resolveFetch(this.fetchImpl)(url, init);
    } catch (err) {
      // The URL carries the access token and the body the secret; report only the API name.
      throw asNetworkError(new Error(scrub(err instanceof Error ? err.message : String(err), secrets)), `wechat ${context}`);
    }
    const body = await readJson(res);
    const b = (body && typeof body === "object" ? body : {}) as { errcode?: number; errmsg?: string };
    if (typeof b.errcode === "number" && b.errcode !== 0) throw mapWeChatError(b.errcode, scrub(String(b.errmsg ?? ""), secrets), context);
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`wechat ${context}: HTTP ${res.status}`, kind, retryable);
    }
    return body ?? {};
  }
}

function parseAuth(account: AccountRef): WeChatAuth {
  const parsed = WeChatAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`wechat account ${account.handle}: auth needs appId, appSecret, originalId and token`, "auth", false);
  return parsed.data;
}

export function createWeChatConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new WeChatConnector({ ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}), ...(env.WECHAT_API_BASE ? { apiBase: env.WECHAT_API_BASE } : {}) })];
}
