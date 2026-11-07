import type { ActivityInput, Media, MetricInput, Network, VariantOptions } from "@starsign/schema";

/** What a connector receives about the account it acts for. Auth is already decrypted by core. */
export interface AccountRef {
  id: string;
  workspaceId: string;
  network: Network;
  externalId: string;
  handle: string;
  /** Decrypted credential blob; shape is connector-specific. */
  auth: Record<string, unknown> | null;
  /** Non-secret connector config. */
  config: Record<string, unknown>;
}

export interface PublishInput {
  variantId: string;
  text: string;
  media: Media[];
  /** Additional thread segments after the first post. */
  thread: string[];
  /** Reply target, when this is a reply. */
  replyToExternalId?: string | null;
  /** Network-specific options (kind, title, privacy, board, subreddit, first comment...). Defaults to {}. */
  options?: VariantOptions;
  /** Idempotency key: connectors that support it must not double-post on retry. */
  idempotencyKey: string;
}

/** Reads media bytes for upload-style APIs (X, Bluesky, LinkedIn, YouTube, TikTok FILE_UPLOAD, Reddit). */
export interface MediaFetcher {
  /**
   * Bytes and type of a media item, from Starsign storage when it has an assetId, else by URL. The whole file is in
   * memory: use it for images and small files only. Video paths read through `openMedia` / `readChunks` (media-io.ts),
   * which use the methods below when present and fall back to this one.
   */
  fetch(media: Media): Promise<{ bytes: Uint8Array; mime: string }>;
  /** Size in bytes, or null when it cannot be known without downloading (the reader then streams instead). */
  size?(media: Media): Promise<number | null>;
  /** Bytes [start, start + length); exactly `length` bytes unless the file is shorter. */
  range?(media: Media, start: number, length: number): Promise<Uint8Array>;
  /** The whole file as a web stream, read as it is consumed. `size` is null when the source does not say. */
  stream?(media: Media): Promise<{ body: ReadableStream<Uint8Array>; size: number | null; mime: string }>;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  /** Thread segment ids when a thread was posted. */
  threadExternalIds?: string[];
  raw?: unknown;
}

export interface ValidationIssue {
  code: "too_long" | "too_many_media" | "media_required" | "thread_unsupported" | "unsupported_media" | "empty";
  message: string;
  /** Which segment (0 = root) when applicable. */
  segment?: number;
}

export interface ConnectorCapabilities {
  publish: boolean;
  fetchActivity: boolean;
  fetchMetrics: boolean;
  /** Reading costs money (metered API). Core enforces spend caps when true. */
  meteredReads: boolean;
  /** Optional richer declarations; absent means false. */
  reply?: boolean;
  moderate?: boolean;
  accountMetrics?: boolean;
  webhooks?: boolean;
  video?: boolean;
  /** Post kinds this network accepts through this connector (default ["post"]). */
  kinds?: string[];
}

/** One account a connection produced. A single OAuth login can yield several (Facebook Pages, Instagram, LinkedIn orgs). */
export interface ConnectedAccount {
  network: Network;
  identity: AccountIdentity;
  auth: Record<string, unknown>;
  /** Non-secret per-account config (e.g. Mastodon instance, LinkedIn author URN, page id). */
  config?: Record<string, unknown>;
}

/** A comment-level action on the network. */
export interface ModerationInput {
  externalId: string;
  action: "hide" | "unhide" | "delete" | "like" | "unlike";
}

/** Parsed webhook delivery: items routed to the account whose network id matches. */
export interface WebhookBatch {
  network: Network;
  accountExternalId: string;
  items: ActivityInput[];
}

export interface WebhookHandler {
  /** Subscription handshake (e.g. Meta's hub.challenge, WeChat's echostr). Return the body to echo, or null when not a handshake. */
  challenge?(query: Record<string, string>): string | null;
  /** Verify the signature over the raw body (and, for platforms that sign the URL, its query). Must be constant-time. */
  verify(headers: Record<string, string>, rawBody: string, query?: Record<string, string>): boolean;
  /** Turn the raw body into what `parse` reads. Default: JSON.parse. WeChat: XML, possibly encrypted. */
  decode?(rawBody: string, query: Record<string, string>): unknown;
  parse(body: unknown): WebhookBatch[];
  /** What the platform expects back on success. Default: JSON `{ accepted, items }`. WeChat: the text "success". */
  ack?: { body: string; contentType: string };
  /**
   * A reply computed from this delivery, after it verified: e.g. Slack's url_verification and Twitch's callback
   * verification echo a `challenge` from the signed body. Null: use `ack` or the default.
   */
  respond?(body: unknown, headers: Record<string, string>): { body: string; contentType: string } | null;
  /**
   * True when this delivery only announces that new items are waiting (WeCom's kf_msg_or_event carries a sync token,
   * not the messages). Core then pulls the verified account(s) right away, after answering, instead of waiting for
   * the next scheduled poll.
   */
  pullNow?(body: unknown): boolean;

  /**
   * Per-account secrets (LINE channel secret, a WeChat Official Account's token and AES key). When `route` is set,
   * core reads which account a delivery claims to be for (unverified), loads that account's credentials and checks
   * the delivery with `verifyAccount` instead of `verify`; only the accounts that verify receive the items. The
   * handshake works the same way through `challengeAccount`. Platforms with one app-wide secret ignore these.
   */
  route?(rawBody: string, query: Record<string, string>, headers: Record<string, string>): { network: Network; accountExternalId: string } | null;
  verifyAccount?(account: AccountRef, headers: Record<string, string>, rawBody: string, query: Record<string, string>): boolean;
  decodeAccount?(account: AccountRef, rawBody: string, query: Record<string, string>): unknown;
  challengeAccount?(account: AccountRef, query: Record<string, string>): string | null;
}

/** Updated credentials to persist after a refresh. */
export interface AuthRefresh {
  auth: Record<string, unknown>;
}

/** How a person connects an account through this connector. */
export type ConnectMethod = "app_password" | "oauth" | "api_key" | "webhook_url" | "bot_token" | "none";

/** Who the credentials belong to, as the network reports it. */
export interface AccountIdentity {
  externalId: string;
  handle: string;
  displayName: string | null;
}

export interface Connector {
  readonly name: string;
  readonly networks: readonly Network[];
  /** How accounts are connected. Defaults to "none" (only programmatic). */
  readonly connectMethod?: ConnectMethod;
  /** False when the deployment lacks what connecting needs (e.g. OAuth client id). Defaults to true. */
  readonly connectConfigured?: boolean;
  /** OAuth 2.0 + PKCE: the URL to send the person to. */
  oauthAuthorizeUrl?(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** OAuth 2.0 + PKCE: exchange the code for a credential blob this connector can use (single-account connectors). */
  oauthExchange?(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<Record<string, unknown>>;
  /**
   * OAuth: exchange the code and return every account the login can act for. Preferred over oauthExchange
   * when one login yields several accounts (Meta pages + Instagram, LinkedIn member + organizations).
   */
  oauthConnect?(p: { code: string; codeVerifier: string; redirectUri: string; config?: Record<string, unknown>; /** Every query parameter the callback received (VK ID adds device_id). */ callbackParams?: Record<string, string> }): Promise<ConnectedAccount[]>;
  /** Extra inputs a person supplies before OAuth starts (e.g. Mastodon instance URL). */
  readonly oauthInputs?: readonly { key: string; label: string; placeholder?: string }[];
  /**
   * Per-start preparation that needs those inputs (e.g. registering an app on a Mastodon instance).
   * Returns config to keep with the pending state and an authorize URL override.
   */
  oauthPrepare?(p: { inputs: Record<string, string>; redirectUri: string; state: string; codeChallenge: string }): Promise<{ authorizeUrl: string; config: Record<string, unknown> }>;
  /** Non-OAuth connect: verify typed inputs (bot token + channel, webhook URL, app password) and return the accounts. */
  connectWithInputs?(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]>;
  /** Inputs for connectWithInputs, shown as a form in the room. */
  readonly credentialInputs?: readonly { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean }[];
  /** Verify credentials and say whose they are. Used when a person connects an account. */
  describeAccount?(auth: Record<string, unknown>): Promise<AccountIdentity>;
  capabilities(network: Network): ConnectorCapabilities;
  /** Pre-flight checks beyond generic limits (e.g. link cards). Return [] when fine. */
  validate?(account: AccountRef, input: PublishInput): ValidationIssue[];
  publish(account: AccountRef, input: PublishInput): Promise<PublishResult>;
  fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]>;
  /** Metrics for the given external post ids, as of now. */
  fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]>;
  refreshAuth?(account: AccountRef): Promise<AuthRefresh | null>;
  /** Reply to a post or comment on the network. Core routes replies through the policy gate first. */
  reply?(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult>;
  /** Hide, delete, like a comment or post. */
  moderate?(account: AccountRef, input: ModerationInput): Promise<void>;
  /** Account-level metrics now (followers_total, profile reach...). entityType "social_account", entityId = account id. */
  fetchAccountMetrics?(account: AccountRef): Promise<MetricInput[]>;
  /** Inbound webhooks, when the network pushes events. */
  readonly webhook?: WebhookHandler;
  /** Set by core at boot so upload-style connectors can read media bytes. */
  media?: MediaFetcher;
}

export class ConnectorError extends Error {
  /** Set when part of a thread reached the network before the failure: the root's ids, so core can keep them. */
  partial?: { externalId: string; url: string | null; threadExternalIds: string[] };
  constructor(
    message: string,
    public readonly kind: "auth" | "rate_limit" | "rejected" | "network" | "unknown",
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
