import { createHash } from "node:crypto";
import type { ActivityInput, Media, MetricInput, Network } from "@starsign/schema";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";
import { decodeAesKey, field, parseWeChatXml, signatureMatches, wechatDecrypt, wechatSignature, type WeChatXml } from "./wechat-crypto.ts";

/**
 * WeCom (企业微信) through its official server API at qyapi.weixin.qq.com. One Starsign account can hold two parts,
 * each optional:
 *
 * - **WeChat Customer Service (微信客服)**: customers tap a link or QR code inside WeChat and chat with the business.
 *   Credentials: CorpID, the Customer Service Secret, the callback Token and EncodingAESKey, and the customer service
 *   account (open_kfid). The callback (`/webhooks/wecom?account=<CorpID>`) only says "there are new messages" and
 *   carries a short-lived sync token; the messages themselves are pulled with `kf/sync_msg`. Webhook `parse` is
 *   synchronous, so the callback stores the sync token and `fetchActivity` (the workers' ingest job) pulls with it.
 *   Replies go out with `kf/send_msg` (48 hours after the customer's last message, at most 5 messages).
 * - **Group bot (群机器人)**: a webhook URL that posts into one internal WeCom group. Publish-only: bots cannot read.
 *
 * Message external ids are "<open_kfid>:<external_userid>:<msgid>" so a reply can find the customer and the account.
 * Personal WeChat groups and WeCom customer groups' contents are NOT reachable here; see docs/integrations/wecom.md.
 */

const API_BASE = "https://qyapi.weixin.qq.com";
const BOT_URL = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=([A-Za-z0-9-]{8,64})$/;
/** Replay window for signed callbacks (seconds, either direction). */
const MAX_SKEW_SECONDS = 300;
/** Renew a cached access token this long before it expires (tokens live 7200 s). */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** The callback's sync token is valid for 10 minutes; use it a little less. */
const SYNC_TOKEN_TTL_MS = 9 * 60_000;
/** sync_msg pages per fetch (1000 messages each). */
const MAX_SYNC_PAGES = 10;
/** Group bot image: JPG/PNG up to 2 MB before base64. */
const BOT_IMAGE_MAX = 2 * 1024 * 1024;
const BOT_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
/** Group bot markdown content: up to 4096 bytes UTF-8; text: 2048 bytes. */
const BOT_MARKDOWN_MAX_BYTES = 4096;
// TODO(verify): news card title ≤ 128 bytes and description ≤ 512 bytes (WeCom truncates longer ones).
const NEWS_TITLE_MAX_BYTES = 128;
const NEWS_DESC_MAX_BYTES = 512;

// TODO(verify): CorpIDs are "ww" + 16 characters (older corps "wx" + 16).
const CORP_ID = /^w[wx][0-9A-Za-z]{16}$/;
// TODO(verify): Customer Service Secret is 43 characters; accepted loosely.
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
const CALLBACK_TOKEN = /^[A-Za-z0-9]{1,32}$/;
const AES_KEY = /^[A-Za-z0-9]{43}$/;
// TODO(verify): open_kfid starts with "wk"; external_userid with "wm" or "wo".
const OPEN_KFID = /^wk[0-9A-Za-z_-]{4,64}$/;
const USER_ID = /^[0-9A-Za-z_-]{4,128}$/;

export interface WeComAuth {
  corpId?: string;
  kfSecret?: string;
  token?: string;
  encodingAesKey?: string;
  openKfId?: string;
  botKey?: string;
}

interface KfAuth {
  corpId: string;
  kfSecret: string;
  token: string;
  encodingAesKey: string;
  openKfId: string | undefined;
}

export interface WeComConnectorOptions {
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** STARSIGN_PUBLIC_URL, used to tell the owner which callback URL to configure. */
  publicUrl?: string;
}

interface WeComFailure {
  errcode: number;
  errmsg: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Strip anything secret from text before it lands in an error. */
function scrub(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.replaceAll(s, "<redacted>");
  return out.replace(/(access_token|corpsecret|key)=[^&\s"]+/g, "$1=<redacted>");
}

/** Cut a string to at most `max` UTF-8 bytes on a character boundary. */
function cutBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (utf8Bytes(out + ch) > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * errcode → ConnectorError. WeCom answers HTTP 200 with { errcode, errmsg } like WeChat.
 * Codes from the global error code page (open.work.weixin.qq.com/devtool/query?e=<code>) as far as search results showed.
 */
export function mapWeComError(errcode: number, errmsg: string, context: string): ConnectorError {
  const cause: WeComFailure = { errcode, errmsg };
  const msg = `wecom ${context}: ${errmsg || "error"} (errcode ${errcode})`;
  switch (errcode) {
    case -1:
      return new ConnectorError(`${msg}: WeCom is busy, try again shortly`, "network", true, cause);
    case 40001:
      return new ConnectorError(`${msg}: the Customer Service Secret was not accepted (copy it again from 微信客服 → API)`, "auth", false, cause);
    case 40013:
      return new ConnectorError(`${msg}: the CorpID was not accepted (My Company → Company Information → CorpID)`, "auth", false, cause);
    case 40014:
    case 41001:
    case 42001:
      return new ConnectorError(`${msg}: the access token was not accepted`, "auth", false, cause);
    // TODO(verify): 60020 "not allow to access from your ip" — the server IP must be a trusted IP of the app.
    case 60020:
      return new ConnectorError(
        `${msg}: this server's outbound IP is not a trusted IP (企业可信IP) for WeChat Customer Service. Add it in the WeCom admin console (微信客服 → API → 可信IP), then try again`,
        "rejected",
        false,
        cause,
      );
    case 48002:
      return new ConnectorError(`${msg}: this API is not allowed for the secret used (the Customer Service API must be enabled under 微信客服 → API)`, "rejected", false, cause);
    case 45009:
    case 45033:
      return new ConnectorError(`${msg}: WeCom API rate limit reached, try again later`, "rate_limit", true, cause);
    // TODO(verify): 95xxx customer-service codes; only 95018 ("send msg session status invalid") was seen in search results.
    case 95000:
    case 95004:
      return new ConnectorError(`${msg}: the customer service account (open_kfid) was not found in this company`, "rejected", false, cause);
    case 95001:
      return new ConnectorError(
        `${msg}: WeCom allows at most 5 messages within 48 hours after the customer's last message. Wait for them to write again`,
        "rejected",
        false,
        cause,
      );
    case 95007:
    case 95008:
      return new ConnectorError(`${msg}: the message sync token from the callback is invalid or expired`, "rejected", false, cause);
    case 95013:
      return new ConnectorError(`${msg}: this chat session has ended; the customer has to write again`, "rejected", false, cause);
    case 95018:
      return new ConnectorError(
        `${msg}: WeCom refused to send in this chat's current state. Replies through the API work only within 48 hours of the customer's last message (at most 5 messages), and only while the chat is new or handled by the API/bot, not while a staff member handles it in WeCom or after it ended`,
        "rejected",
        false,
        cause,
      );
    // TODO(verify): 93000 invalid group bot webhook key; 93004 the bot was removed from the group.
    case 93000:
      return new ConnectorError(`${msg}: the group bot webhook URL is not valid any more (the bot may have been removed); copy a new one from the group's bot settings`, "auth", false, cause);
    case 93004:
      return new ConnectorError(`${msg}: the group bot has been removed or disabled`, "auth", false, cause);
    default:
      return new ConnectorError(msg, "rejected", false, cause);
  }
}

/** A customer-service callback saying "new messages are waiting" (it carries a sync token, not the messages). */
const isKfAnnouncement = (body: unknown): boolean => !!body && typeof body === "object" && field(body as WeChatXml, "MsgType") === "event" && field(body as WeChatXml, "Event") === "kf_msg_or_event";

const isTokenError = (e: unknown) => e instanceof ConnectorError && [40014, 41001, 42001].includes((e.cause as WeComFailure | undefined)?.errcode ?? 0);

// ---- message mapping ----------------------------------------------------------------------

/** One sync_msg message as WeCom returns it (fields as documented; unknown types keep their own object). */
export interface KfMessage {
  msgid?: string;
  open_kfid?: string;
  external_userid?: string;
  send_time?: number;
  /** 3 = sent by the customer, 4 = system event, 5 = sent by a staff member (servicer) in WeCom. */
  origin?: number;
  servicer_userid?: string;
  msgtype?: string;
  text?: { content?: string; menu_id?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  link?: { title?: string; desc?: string; url?: string; pic_url?: string };
  miniprogram?: { title?: string; appid?: string; pagepath?: string };
  event?: { event_type?: string; open_kfid?: string; external_userid?: string; scene?: string; scene_param?: string };
  [key: string]: unknown;
}

/** A customer message (origin 3) or a customer entering the chat → a "dm"; staff messages and other events → null. */
export function kfMessageToActivity(m: KfMessage, names: ReadonlyMap<string, string> = new Map()): ActivityInput | null {
  const type = m.msgtype ?? "";
  let userId = m.external_userid;
  let openKfId = m.open_kfid;
  let text: string | null;
  let url: string | null = null;
  if (type === "event") {
    const ev = m.event ?? {};
    userId = ev.external_userid ?? userId;
    openKfId = ev.open_kfid ?? openKfId;
    // Only a customer opening the chat is a signal; session state changes, failed sends and recalls are internal.
    if (ev.event_type !== "enter_session") return null;
    text = `[opened the chat${ev.scene ? ` from scene ${ev.scene}${ev.scene_param ? ` (${ev.scene_param})` : ""}` : ""}]`;
  } else {
    if (m.origin !== 3) return null; // 4 system, 5 staff replies: not inbound
    switch (type) {
      case "text":
        text = m.text?.content ?? "";
        break;
      case "image":
      case "voice":
      case "video":
      case "file":
        // Media arrive as media_id only (download via /cgi-bin/media/get with an access token); kept in raw.
        text = `[${type}]`;
        break;
      case "location": {
        const l = m.location ?? {};
        const label = [l.name, l.address].filter(Boolean).join(", ");
        text = `[location]${label ? ` ${label}` : ""}${l.latitude !== undefined && l.longitude !== undefined ? ` (${l.latitude}, ${l.longitude})` : ""}`;
        break;
      }
      case "link":
        url = m.link?.url ?? null;
        text = ["[link]", m.link?.title, m.link?.desc, url].filter(Boolean).join(" ");
        break;
      case "miniprogram":
        text = ["[mini program]", m.miniprogram?.title].filter(Boolean).join(" ");
        break;
      default:
        text = `[${type || "message"}]`;
    }
  }
  if (!userId || !openKfId || !m.msgid) return null;
  const sent = typeof m.send_time === "number" && m.send_time > 0 ? m.send_time : 0;
  return {
    network: "wecom",
    kind: "dm",
    externalId: `${openKfId}:${userId}:${m.msgid}`,
    authorHandle: userId,
    authorName: names.get(userId) ?? null,
    text,
    url,
    parentExternalId: null,
    occurredAt: new Date(sent * 1000).toISOString(),
    raw: m,
    conversation: { id: userId, type: "direct" },
  };
}

/** "<open_kfid>:<external_userid>[:<msgid>]" → its parts. */
export function kfTarget(externalId: string): { openKfId: string; userId: string } {
  const [openKfId, userId] = externalId.split(":");
  if (!openKfId || !userId || !OPEN_KFID.test(openKfId) || !USER_ID.test(userId)) {
    throw new ConnectorError(`wecom: "${externalId}" does not name a WeChat Customer Service chat`, "rejected", false);
  }
  return { openKfId, userId };
}

// ---- connector ----------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class WeComConnector implements Connector {
  readonly name = "wecom";
  readonly networks: readonly Network[] = ["wecom"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "corpId", label: "CorpID (企业ID)", placeholder: "ww followed by 16 letters or digits; for customer service", optional: true },
    { key: "kfSecret", label: "Customer Service Secret (微信客服 Secret)", placeholder: "from 微信客服 → API", secret: true, optional: true },
    { key: "token", label: "Callback Token", placeholder: "the Token in the callback settings", secret: true, optional: true },
    { key: "encodingAesKey", label: "Callback EncodingAESKey", placeholder: "43 characters", secret: true, optional: true },
    { key: "openKfId", label: "Customer service account ID (open_kfid)", placeholder: "wk…; leave empty for the first account", optional: true },
    { key: "botWebhookUrl", label: "Group bot webhook URL (群机器人)", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…", secret: true, optional: true },
  ] as const;
  readonly webhook: WebhookHandler;
  /** Set by core: reads image bytes for bot image messages. */
  media?: MediaFetcher;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly publicUrl: string | undefined;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflightTokens = new Map<string, Promise<string>>();
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** sync_msg cursors per "<account id>:<open_kfid>", process-local. A restart re-reads up to 3 days, filtered by `since`. */
  private readonly cursors = new Map<string, string>();
  /** Sync tokens from callbacks per "<corpId>:<open_kfid>", valid ~10 minutes. */
  private readonly syncTokens = new Map<string, { token: string; expiresAt: number }>();
  /** Customer nicknames per "<corpId>:<external_userid>" from kf/customer/batchget. */
  private readonly nicknames = new Map<string, string>();

  constructor(opts: WeComConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.webhook = {
      verify: () => false, // never used: each corp has its own Token, so route + verifyAccount take over
      route: (raw, query) => this.route(raw, query),
      challengeAccount: (account, query) => this.challengeAccount(account, query),
      verifyAccount: (account, _headers, raw, query) => this.verifyAccount(account, raw, query),
      decodeAccount: (account, raw) => this.decodeAccount(account, raw),
      parse: (body) => this.parse(body),
      // The announcement carries no messages: core pulls the account straight after answering, using the sync token parse stored.
      pullNow: (body) => isKfAnnouncement(body),
      // TODO(verify): WeCom only needs HTTP 200 within 5 seconds for kf callbacks; an empty body is the documented safe answer.
      ack: { body: "", contentType: "text/plain" },
    };
  }

  capabilities(): ConnectorCapabilities {
    // One network, two optional parts: publish needs the bot, listening and replies need customer service.
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: false, accountMetrics: false, webhooks: true, video: false, kinds: ["post", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const v = (k: string) => (p.inputs[k] ?? "").trim();
    const kfFields = ["corpId", "kfSecret", "token", "encodingAesKey", "openKfId"];
    const wantsKf = kfFields.some((k) => v(k) !== "");
    const botUrl = v("botWebhookUrl");
    if (!wantsKf && !botUrl) throw new ConnectorError("wecom: fill in the customer service fields, a group bot webhook URL, or both", "rejected", false);

    const auth: WeComAuth = {};
    let kf: KfAuth | null = null;
    if (wantsKf) {
      const missing = ["corpId", "kfSecret", "token", "encodingAesKey"].filter((k) => v(k) === "");
      if (missing.length > 0) throw new ConnectorError(`wecom: customer service needs CorpID, Customer Service Secret, callback Token and EncodingAESKey (missing: ${missing.join(", ")})`, "rejected", false);
      // Name the field, never echo the value.
      if (!CORP_ID.test(v("corpId"))) throw new ConnectorError("wecom: the CorpID looks like ww followed by 16 letters or digits", "rejected", false);
      if (!SECRET.test(v("kfSecret"))) throw new ConnectorError("wecom: the Customer Service Secret is not in the expected format (letters, digits, - and _)", "rejected", false);
      if (!CALLBACK_TOKEN.test(v("token"))) throw new ConnectorError("wecom: the callback Token is up to 32 English letters or digits", "rejected", false);
      if (!AES_KEY.test(v("encodingAesKey"))) throw new ConnectorError("wecom: the EncodingAESKey is 43 letters and digits", "rejected", false);
      try {
        decodeAesKey(v("encodingAesKey"));
      } catch {
        throw new ConnectorError("wecom: the EncodingAESKey is not valid (43 letters and digits from the callback settings)", "rejected", false);
      }
      if (v("openKfId") && !OPEN_KFID.test(v("openKfId"))) throw new ConnectorError("wecom: the customer service account ID looks like wk followed by letters and digits", "rejected", false);
      kf = { corpId: v("corpId"), kfSecret: v("kfSecret"), token: v("token"), encodingAesKey: v("encodingAesKey"), openKfId: v("openKfId") || undefined };
    }
    let botKey: string | undefined;
    if (botUrl) {
      const m = BOT_URL.exec(botUrl);
      if (!m) throw new ConnectorError("wecom: the group bot webhook URL looks like https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…", "rejected", false);
      // A bot URL cannot be checked without posting into the group, so only its shape is validated.
      botKey = m[1]!;
    }

    let identity: AccountIdentity;
    const config: Record<string, unknown> = { parts: [...(kf ? ["customer_service"] : []), ...(botKey ? ["group_bot"] : [])] };
    if (kf) {
      // Proves CorpID + Secret, the trusted IP, and API access to customer service; picks the account.
      const accounts = await this.listKfAccounts(kf);
      const chosen = kf.openKfId ? accounts.find((a) => a.open_kfid === kf.openKfId) : accounts[0];
      if (!chosen?.open_kfid) {
        throw new ConnectorError(
          kf.openKfId ? "wecom: that customer service account ID is not in this company (or not managed by the API)" : "wecom: this company has no customer service account yet; create one under 微信客服 first",
          "rejected",
          false,
        );
      }
      kf.openKfId = chosen.open_kfid;
      Object.assign(auth, kf);
      identity = { externalId: kf.corpId, handle: chosen.name || chosen.open_kfid, displayName: chosen.name ?? null };
      Object.assign(config, {
        corpId: kf.corpId,
        openKfId: chosen.open_kfid,
        ...(this.publicUrl ? { webhookUrl: `${this.publicUrl}/webhooks/wecom?account=${encodeURIComponent(kf.corpId)}` } : {}),
      });
    } else {
      identity = { externalId: botExternalId(botKey!), handle: "WeCom group bot", displayName: null };
    }
    if (botKey) auth.botKey = botKey;
    return [{ network: "wecom", identity, auth: { ...auth }, config }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const kf = kfAuthOf(auth);
    if (kf) {
      const accounts = await this.listKfAccounts(kf);
      const chosen = accounts.find((a) => a.open_kfid === kf.openKfId) ?? accounts[0];
      return { externalId: kf.corpId, handle: chosen?.name || kf.openKfId || kf.corpId, displayName: chosen?.name ?? null };
    }
    const key = typeof auth.botKey === "string" ? auth.botKey : null;
    if (!key) throw new ConnectorError("wecom: auth has neither customer service credentials nor a group bot", "auth", false);
    return { externalId: botExternalId(key), handle: "WeCom group bot", displayName: null };
  }

  private async listKfAccounts(kf: KfAuth): Promise<{ open_kfid?: string; name?: string }[]> {
    const body = (await this.call(kf, "kf/account/list", { offset: 0, limit: 100 })) as { account_list?: { open_kfid?: string; name?: string }[] };
    return body.account_list ?? [];
  }

  // ---- publish: group bot ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const opts = input.options ?? {};
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "WeCom group bots post single messages, not threads" });
    for (const m of input.media) {
      if (m.kind !== "image") issues.push({ code: "unsupported_media", message: `WeCom group bots post images only, not ${m.kind}` });
      else if (m.bytes !== undefined && m.bytes > BOT_IMAGE_MAX) issues.push({ code: "unsupported_media", message: "WeCom group bot images are at most 2 MB" });
      else if (m.mime && !BOT_IMAGE_TYPES.has(m.mime.toLowerCase())) issues.push({ code: "unsupported_media", message: "WeCom group bot images must be JPG or PNG" });
    }
    if (!isNewsCard(input)) {
      const content = markdownContent(input.text, opts.link);
      if (utf8Bytes(content) > BOT_MARKDOWN_MAX_BYTES) issues.push({ code: "too_long", message: `the message is ${utf8Bytes(content)} bytes; WeCom group bot markdown takes up to ${BOT_MARKDOWN_MAX_BYTES}` });
      if (!content.trim() && input.media.length === 0) issues.push({ code: "empty", message: "the post has no text and no image" });
    }
    return issues;
  }

  /**
   * Post into the bot's internal WeCom group: a news card when the post has a link and a title (or kind "link"),
   * else a markdown message, then each image as an image message (base64 + md5).
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const key = typeof account.auth?.botKey === "string" ? account.auth.botKey : null;
      if (!key) throw new ConnectorError("wecom: this account has no group bot, so it cannot post; reconnect it with a group bot webhook URL", "rejected", false);
      const issues = this.validate(account, input);
      if (issues[0]) throw new ConnectorError(`wecom: ${issues[0].message}`, "rejected", false, issues);
      const opts = input.options ?? {};
      const externalId = `${botExternalId(key)}:${sha256(input.idempotencyKey).slice(0, 16)}`;
      const sent: string[] = [];
      const images = input.media.filter((m) => m.kind === "image");
      if (isNewsCard(input)) {
        const lines = input.text.trim().split("\n");
        const title = opts.title?.trim() || lines[0]?.trim() || opts.link!;
        const description = (opts.title?.trim() ? input.text : lines.slice(1).join("\n")).trim();
        const pic = images[0]?.url && /^https?:\/\//.test(images[0].url) ? images[0].url : undefined;
        await this.bot(key, { msgtype: "news", news: { articles: [{ title: cutBytes(title, NEWS_TITLE_MAX_BYTES), ...(description ? { description: cutBytes(description, NEWS_DESC_MAX_BYTES) } : {}), url: opts.link!, ...(pic ? { picurl: pic } : {}) }] } });
        return { externalId, url: null, raw: { sent: ["news"] } };
      }
      const content = markdownContent(input.text, opts.link);
      if (content.trim()) {
        await this.bot(key, { msgtype: "markdown", markdown: { content } });
        sent.push("markdown");
      }
      const source = mediaSource(this.media, this.fetchImpl);
      for (const m of images) {
        try {
          await this.botImage(key, source, m);
          sent.push("image");
        } catch (e) {
          if (e instanceof ConnectorError && sent.length > 0) e.partial = { externalId, url: null, threadExternalIds: [] };
          throw e;
        }
      }
      return { externalId, url: null, raw: { sent } };
    });
  }

  private async botImage(key: string, source: MediaFetcher, m: Media): Promise<void> {
    const { bytes, mime } = await source.fetch(m);
    if (bytes.byteLength > BOT_IMAGE_MAX) throw new ConnectorError("wecom: group bot images are at most 2 MB", "rejected", false);
    if (!BOT_IMAGE_TYPES.has(mime.toLowerCase())) throw new ConnectorError("wecom: group bot images must be JPG or PNG", "rejected", false);
    const buf = Buffer.from(bytes);
    await this.bot(key, { msgtype: "image", image: { base64: buf.toString("base64"), md5: createHash("md5").update(buf).digest("hex") } });
  }

  private async bot(key: string, payload: unknown): Promise<void> {
    // TODO(verify): 20 messages per minute per bot; 45009 when exceeded.
    await this.request(`${this.apiBase}/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`, "POST", payload, "group bot", [key]);
  }

  // ---- reply: customer service ----------------------------------------------------------

  /** kf/send_msg text to the customer of the parent message. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const kf = requireKf(account);
      const { openKfId, userId } = kfTarget(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("wecom reply: the message is empty", "rejected", false);
      // TODO(verify): send_msg accepts our own msgid (≤ 32 chars of [0-9a-zA-Z_-]) and refuses a repeated one.
      const msgid = sha256(input.idempotencyKey).slice(0, 32);
      const body = (await this.call(kf, "kf/send_msg", { touser: userId, open_kfid: openKfId, msgid, msgtype: "text", text: { content: input.text } })) as { msgid?: string };
      return { externalId: `${openKfId}:${userId}:${body.msgid ?? msgid}`, url: null, raw: body };
    });
  }

  // ---- listen ---------------------------------------------------------------------------

  /**
   * Pull new customer service messages with kf/sync_msg from the stored cursor. Uses the callback's sync token when one
   * arrived in the last ~10 minutes (sync_msg without it is strictly rate limited).
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const kf = kfAuthOf(account.auth ?? {});
    if (!kf) return []; // bot-only accounts cannot read
    const openKfId = kf.openKfId ?? (typeof account.config.openKfId === "string" ? account.config.openKfId : undefined);
    if (!openKfId) throw new ConnectorError("wecom: no customer service account (open_kfid) is set; reconnect the account", "auth", false);
    const cursorKey = `${account.id}:${openKfId}`;
    const tokenKey = `${kf.corpId}:${openKfId}`;
    const hadCursor = this.cursors.has(cursorKey);
    const messages: KfMessage[] = [];
    for (let page = 0; page < MAX_SYNC_PAGES; page++) {
      const cursor = this.cursors.get(cursorKey);
      const stash = this.syncTokens.get(tokenKey);
      const token = stash && stash.expiresAt > this.now().getTime() ? stash.token : undefined;
      const payload = { ...(cursor ? { cursor } : {}), ...(token ? { token } : {}), limit: 1000, voice_format: 0, open_kfid: openKfId };
      let body: { next_cursor?: string; has_more?: number | boolean; msg_list?: KfMessage[] };
      try {
        body = (await this.call(kf, "kf/sync_msg", payload)) as typeof body;
      } catch (e) {
        // An expired or used-up callback token: drop it and pull without one.
        if (token && e instanceof ConnectorError && e.kind === "rejected") {
          this.syncTokens.delete(tokenKey);
          page--;
          continue;
        }
        throw e;
      }
      messages.push(...(body.msg_list ?? []));
      if (body.next_cursor) this.cursors.set(cursorKey, body.next_cursor);
      if (!body.has_more || !body.next_cursor) break;
    }
    const names = await this.customerNames(kf, messages);
    const out: ActivityInput[] = [];
    for (const m of messages) {
      const item = kfMessageToActivity(m, names);
      if (!item) continue;
      // Without a cursor (first run, or after a restart) sync_msg starts 3 days back: keep only what is new.
      if (!hadCursor && since && Date.parse(item.occurredAt) <= since.getTime()) continue;
      out.push(item);
    }
    return out;
  }

  /** Best-effort WeChat nicknames for the customers in these messages (kf/customer/batchget, 100 per call). */
  private async customerNames(kf: KfAuth, messages: KfMessage[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const m of messages) {
      const id = m.msgtype === "event" ? (m.event?.external_userid ?? m.external_userid) : m.external_userid;
      if (id) ids.add(id);
    }
    const names = new Map<string, string>();
    const unknown: string[] = [];
    for (const id of ids) {
      const known = this.nicknames.get(`${kf.corpId}:${id}`);
      if (known) names.set(id, known);
      else unknown.push(id);
    }
    for (let i = 0; i < unknown.length; i += 100) {
      try {
        const body = (await this.call(kf, "kf/customer/batchget", { external_userid_list: unknown.slice(i, i + 100), need_enter_session_context: 0 })) as { customer_list?: { external_userid?: string; nickname?: string }[] };
        for (const c of body.customer_list ?? []) {
          if (!c.external_userid || !c.nickname) continue;
          names.set(c.external_userid, c.nickname);
          this.nicknames.set(`${kf.corpId}:${c.external_userid}`, c.nickname);
        }
      } catch (e) {
        if (!(e instanceof ConnectorError) || e.kind === "network") throw e;
        // Names are a nicety: a permission or quota error leaves authors unnamed.
      }
    }
    return names;
  }

  /** Group bots and customer service expose no per-message metrics. */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  // ---- webhooks -------------------------------------------------------------------------

  private route(raw: string, query: Record<string, string>): { network: Network; accountExternalId: string } | null {
    const fromQuery = query.account?.trim();
    if (fromQuery && CORP_ID.test(fromQuery)) return { network: "wecom", accountExternalId: fromQuery };
    if (!raw) return null;
    try {
      const to = field(parseWeChatXml(raw), "ToUserName");
      return to && CORP_ID.test(to) ? { network: "wecom", accountExternalId: to } : null;
    } catch {
      return null;
    }
  }

  private fresh(query: Record<string, string>): boolean {
    const ts = Number(query.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return Math.abs(this.now().getTime() / 1000 - ts) <= MAX_SKEW_SECONDS;
  }

  /** URL check: msg_signature = sha1(sort([token, timestamp, nonce, echostr])); answer the decrypted echostr. */
  private challengeAccount(account: AccountRef, query: Record<string, string>): string | null {
    const kf = kfAuthOf(account.auth ?? {});
    if (!kf) return null;
    const { msg_signature, timestamp, nonce } = query;
    // Some frameworks turn "+" in an unescaped query into a space; base64 has no spaces.
    const echostr = query.echostr?.replace(/ /g, "+");
    if (!timestamp || nonce === undefined || !echostr || !this.fresh(query)) return null;
    if (!signatureMatches(wechatSignature([kf.token, timestamp, nonce, echostr]), msg_signature)) return null;
    try {
      // receiveid = CorpID: an echostr encrypted for another corp does not decrypt to an answer.
      return wechatDecrypt(echostr, kf.encodingAesKey, kf.corpId);
    } catch {
      return null;
    }
  }

  private verifyAccount(account: AccountRef, raw: string, query: Record<string, string>): boolean {
    const kf = kfAuthOf(account.auth ?? {});
    if (!kf) return false;
    const { timestamp, nonce } = query;
    if (!timestamp || nonce === undefined || !this.fresh(query)) return false;
    let encrypt: string | undefined;
    try {
      encrypt = field(parseWeChatXml(raw), "Encrypt");
    } catch {
      return false;
    }
    if (!encrypt) return false; // WeCom callbacks are always encrypted
    return signatureMatches(wechatSignature([kf.token, timestamp, nonce, encrypt]), query.msg_signature);
  }

  private decodeAccount(account: AccountRef, raw: string): WeChatXml {
    const kf = kfAuthOf(account.auth ?? {});
    if (!kf) throw new ConnectorError("wecom: this account has no customer service credentials", "auth", false);
    const encrypt = field(parseWeChatXml(raw), "Encrypt");
    if (!encrypt) throw new ConnectorError("wecom: the callback is not encrypted", "rejected", false);
    return parseWeChatXml(wechatDecrypt(encrypt, kf.encodingAesKey, kf.corpId));
  }

  /**
   * The callback carries no message content: `kf_msg_or_event` says an account has new messages and gives a sync token
   * (valid 10 minutes). Parse is synchronous, so the token is kept for the next fetchActivity; no items are returned.
   */
  private parse(body: unknown): WebhookBatch[] {
    if (!isKfAnnouncement(body)) return [];
    const x = body as WeChatXml;
    {
      const corpId = field(x, "ToUserName");
      const openKfId = field(x, "OpenKfId");
      const token = field(x, "Token");
      if (corpId && openKfId && token) this.syncTokens.set(`${corpId}:${openKfId}`, { token, expiresAt: this.now().getTime() + SYNC_TOKEN_TTL_MS });
    }
    return [];
  }

  /** The sync token stored from the last callback for this corp and account, if still fresh (for tests and diagnostics). */
  pendingSyncToken(corpId: string, openKfId: string): string | null {
    const s = this.syncTokens.get(`${corpId}:${openKfId}`);
    return s && s.expiresAt > this.now().getTime() ? s.token : null;
  }

  // ---- transport ------------------------------------------------------------------------

  private tokenKey(kf: KfAuth): string {
    return `${kf.corpId}:${sha256(kf.kfSecret).slice(0, 12)}`;
  }

  /** A valid access token for this CorpID + secret, from the cache or /cgi-bin/gettoken. */
  async accessToken(kf: KfAuth, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const key = this.tokenKey(kf);
    const cached = this.tokens.get(key);
    if (!opts.forceRefresh && cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now().getTime()) return cached.token;
    const inflight = this.inflightTokens.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const url = `${this.apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(kf.corpId)}&corpsecret=${encodeURIComponent(kf.kfSecret)}`;
      const body = (await this.request(url, "GET", undefined, "gettoken", [kf.kfSecret, kf.token, kf.encodingAesKey])) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new ConnectorError("wecom gettoken: no access token in the response", "unknown", false);
      this.tokens.set(key, { token: body.access_token, expiresAt: this.now().getTime() + (body.expires_in ?? 7200) * 1000 });
      return body.access_token;
    })().finally(() => this.inflightTokens.delete(key));
    this.inflightTokens.set(key, p);
    return p;
  }

  /** POST /cgi-bin/<path> with the access token, refreshing it once on 40014/41001/42001. */
  private async call(kf: KfAuth, path: string, payload: unknown): Promise<unknown> {
    const secrets = (t: string) => [kf.kfSecret, kf.token, kf.encodingAesKey, t];
    const token = await this.accessToken(kf);
    try {
      return await this.request(`${this.apiBase}/cgi-bin/${path}?access_token=${encodeURIComponent(token)}`, "POST", payload, path, secrets(token));
    } catch (e) {
      if (!isTokenError(e)) throw e;
      this.tokens.delete(this.tokenKey(kf));
      const next = await this.accessToken(kf, { forceRefresh: true });
      return this.request(`${this.apiBase}/cgi-bin/${path}?access_token=${encodeURIComponent(next)}`, "POST", payload, path, secrets(next));
    }
  }

  private async request(url: string, method: "GET" | "POST", payload: unknown, context: string, secrets: readonly (string | undefined)[]): Promise<unknown> {
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url, method === "POST" ? { method, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload ?? {}) } : { method });
    } catch (err) {
      // The URL carries the secret, the access token or the bot key: report only the API name.
      throw asNetworkError(new Error(scrub(err instanceof Error ? err.message : String(err), secrets)), `wecom ${context}`);
    }
    const body = await readJson(res);
    const b = (body && typeof body === "object" ? body : {}) as { errcode?: number; errmsg?: string };
    if (typeof b.errcode === "number" && b.errcode !== 0) throw mapWeComError(b.errcode, scrub(String(b.errmsg ?? ""), secrets), context);
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`wecom ${context}: HTTP ${res.status}`, kind, retryable);
    }
    return body ?? {};
  }
}

// ---- helpers ------------------------------------------------------------------------------

/** Account key for a bot-only account: a hash of the bot key (the key itself is a secret). */
export function botExternalId(key: string): string {
  return `bot-${sha256(key).slice(0, 16)}`;
}

function isNewsCard(input: PublishInput): boolean {
  const o = input.options ?? {};
  return Boolean(o.link) && (Boolean(o.title?.trim()) || o.kind === "link");
}

/** Markdown for the bot: the post text (WeCom markdown: headings, bold, links, quotes) plus the link when missing. */
function markdownContent(text: string, link: string | undefined): string {
  const t = text.trim();
  if (!link || t.includes(link)) return t;
  return t ? `${t}\n\n[${link}](${link})` : `[${link}](${link})`;
}

function kfAuthOf(auth: Record<string, unknown>): KfAuth | null {
  const s = (k: string) => (typeof auth[k] === "string" && (auth[k] as string) !== "" ? (auth[k] as string) : undefined);
  const corpId = s("corpId");
  const kfSecret = s("kfSecret");
  const token = s("token");
  const encodingAesKey = s("encodingAesKey");
  if (!corpId || !kfSecret || !token || !encodingAesKey) return null;
  return { corpId, kfSecret, token, encodingAesKey, openKfId: s("openKfId") };
}

function requireKf(account: AccountRef): KfAuth {
  const kf = kfAuthOf(account.auth ?? {});
  if (!kf) throw new ConnectorError("wecom: this account has only a group bot, which cannot reply; connect WeChat Customer Service to answer customers", "rejected", false);
  return kf;
}

export function createWeComConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new WeComConnector({ ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}), ...(env.WECOM_API_BASE ? { apiBase: env.WECOM_API_BASE } : {}) })];
}
