import type { ActivityInput, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, openForUpload, sendBody, setMediaFile, uploadForm, type MediaReader, type StreamingForm } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Discord through channel webhooks. A server admin creates a webhook (Channel settings → Integrations → Webhooks)
 * and pastes its URL. Webhooks can post, edit and delete their own messages; they cannot read the channel, so
 * there is no inbox, no reply and no metrics through this connector.
 */

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{30,120})\/?(?:\?(.*))?$/;

export const DiscordAuth = z.object({ webhookUrl: z.string().regex(WEBHOOK_URL, "not a Discord webhook URL") });
export type DiscordAuth = z.infer<typeof DiscordAuth>;

/** Discord message limits: 2000 characters, 10 files, 10 embeds; 10 MiB per upload on servers without boosts. */
const LIMITS = { files: 10, uploadBytes: 10 * 1024 * 1024, pollQuestion: 300, pollAnswer: 55, pollMaxHours: 768 } as const;

export interface ParsedWebhook {
  id: string;
  token: string;
  threadId: string | null;
  /** Canonical execute URL (discord.com, API v10), without query. */
  base: string;
}

export function parseDiscordWebhookUrl(url: string): ParsedWebhook | null {
  const m = url.trim().match(WEBHOOK_URL);
  if (!m?.[1] || !m[2]) return null;
  const threadId = new URLSearchParams(m[3] ?? "").get("thread_id");
  return { id: m[1], token: m[2], threadId: threadId && /^\d+$/.test(threadId) ? threadId : null, base: `https://discord.com/api/v10/webhooks/${m[1]}/${m[2]}` };
}

interface DiscordFailure {
  status: number;
  code?: number;
  retryAfter?: number;
}

/** HTTP → ConnectorError without the URL (it carries the webhook token). */
export function mapDiscordError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body ?? {}) as { message?: string; code?: number; retry_after?: number; global?: boolean; errors?: unknown };
  const detail = [b.message, b.code !== undefined ? `(code ${b.code})` : null, b.errors ? JSON.stringify(b.errors).slice(0, 300) : null].filter(Boolean).join(" ");
  const msg = `discord ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: DiscordFailure = { status, ...(b.code !== undefined ? { code: b.code } : {}) };
  if (status === 429) {
    const after = b.retry_after ?? Number(headers.get("x-ratelimit-reset-after") ?? headers.get("retry-after") ?? NaN);
    return new ConnectorError(`${msg}; retry after ${Number.isFinite(after) ? after : "?"}s${b.global ? " (global)" : ""}`, "rate_limit", true, { ...cause, ...(Number.isFinite(after) ? { retryAfter: after } : {}) });
  }
  // 401 = bad token; 404 Unknown Webhook (10015) = the webhook was deleted. Either way the person must reconnect.
  if (status === 401 || (status === 404 && (b.code === 10015 || b.code === undefined))) return new ConnectorError(`${msg} (the webhook was deleted or its URL changed; reconnect it)`, "auth", false, cause);
  if (status === 403) return new ConnectorError(msg, "auth", false, cause);
  if (status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

interface DiscordMessage {
  id: string;
  channel_id: string;
}

export interface DiscordConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
}

export class DiscordConnector implements Connector {
  readonly name = "discord";
  readonly networks: readonly Network[] = ["discord"];
  readonly connectMethod = "webhook_url" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [{ key: "webhookUrl", label: "Discord webhook URL", placeholder: "https://discord.com/api/webhooks/123.../abc...", secret: true }] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: DiscordConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
  }

  capabilities(): ConnectorCapabilities {
    // Webhooks only write: no inbox, no replies, no metrics, no follower counts.
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: false, moderate: true, accountMetrics: false, webhooks: false, video: true, kinds: ["post", "poll", "video", "carousel", "link"] };
  }

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const hook = parseDiscordWebhookUrl(p.inputs.webhookUrl ?? "");
    if (!hook) throw new ConnectorError("discord: paste a webhook URL like https://discord.com/api/webhooks/<id>/<token>", "auth", false);
    const info = await this.describeHook(hook);
    const webhookUrl = `${hook.base}${hook.threadId ? `?thread_id=${hook.threadId}` : ""}`;
    return [
      {
        network: "discord",
        identity: { externalId: hook.id, handle: info.name ?? `webhook ${hook.id}`, displayName: info.name ?? null },
        auth: { webhookUrl },
        config: { webhookId: hook.id, guildId: info.guild_id ?? null, channelId: info.channel_id ?? null, threadId: hook.threadId, name: info.name ?? null },
      },
    ];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const hook = parseDiscordWebhookUrl(typeof auth.webhookUrl === "string" ? auth.webhookUrl : "");
    if (!hook) throw new ConnectorError("discord: webhookUrl is required", "auth", false);
    const info = await this.describeHook(hook);
    return { externalId: hook.id, handle: info.name ?? `webhook ${hook.id}`, displayName: info.name ?? null };
  }

  /** GET the webhook with its token: proves it exists and tells us the guild and channel. */
  private async describeHook(hook: ParsedWebhook): Promise<{ name?: string; guild_id?: string; channel_id?: string; type?: number }> {
    const info = (await this.request(hook.base, { method: "GET" }, "get webhook")) as { id?: string; name?: string; guild_id?: string; channel_id?: string; type?: number };
    if (info?.id !== hook.id) throw new ConnectorError("discord: the webhook answered with a different id", "auth", false, info);
    return info;
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (input.media.length > LIMITS.files) issues.push({ code: "too_many_media", message: `discord messages carry at most ${LIMITS.files} files` });
    for (const m of input.media) {
      // TODO(verify): 10 MiB is the default upload cap for servers without boosts; boosted servers allow more.
      if (m.bytes !== undefined && m.bytes > LIMITS.uploadBytes) issues.push({ code: "unsupported_media", message: `${m.url.split("/").pop()} is ${(m.bytes / 1048576).toFixed(1)} MiB; Discord webhooks accept ${LIMITS.uploadBytes / 1048576} MiB per file on unboosted servers` });
    }
    const poll = input.options?.poll;
    if (poll) {
      if (input.media.length > 0) issues.push({ code: "unsupported_media", message: "discord polls cannot carry attachments" });
      if ([...(input.options?.title ?? input.text)].length > LIMITS.pollQuestion) issues.push({ code: "too_long", message: `discord poll questions are at most ${LIMITS.pollQuestion} characters` });
      for (const o of poll.options) if ([...o].length > LIMITS.pollAnswer) issues.push({ code: "too_long", message: `discord poll answer "${o.slice(0, 30)}" is longer than ${LIMITS.pollAnswer} characters` });
    }
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const hook = parseAuth(account);
      const opts = input.options ?? {};
      const payload: Record<string, unknown> = {
        content: input.text,
        // Never ping @everyone/@here/roles/users from a scheduled post by accident.
        allowed_mentions: { parse: [] },
      };
      if (opts.link && !input.text.includes(opts.link)) {
        payload.embeds = [{ url: opts.link, title: (opts.title ?? opts.link).slice(0, 256), ...(opts.thumbnailUrl ? { thumbnail: { url: opts.thumbnailUrl } } : {}) }];
      }
      if (opts.poll) {
        // TODO(verify): execute-webhook accepts the same poll object as create-message.
        payload.poll = {
          question: { text: (opts.title ?? input.text).slice(0, LIMITS.pollQuestion) },
          answers: opts.poll.options.map((text) => ({ poll_media: { text } })),
          duration: Math.min(LIMITS.pollMaxHours, Math.max(1, Math.ceil(opts.poll.durationMinutes / 60))),
          allow_multiselect: false,
        };
        if (!opts.title) payload.content = "";
      }
      let body: string | FormData | StreamingForm;
      const headers: Record<string, string> = {};
      // Videos and documents are opened for streaming; when any is, the multipart body is streamed with an exact
      // Content-Length instead of being assembled in memory.
      const files: MediaReader[] = [];
      let msg: DiscordMessage;
      try {
        if (input.media.length > 0) {
          for (const m of input.media.slice(0, LIMITS.files)) files.push(await openForUpload(mediaSource(this.media, this.fetchImpl), m));
          const form = uploadForm(files);
          payload.attachments = input.media.slice(0, LIMITS.files).map((m, i) => ({ id: i, filename: fileName(m, files[i]!.mime, i), ...(m.alt ? { description: m.alt.slice(0, 1024) } : {}) }));
          form.set("payload_json", JSON.stringify(payload));
          input.media.slice(0, LIMITS.files).forEach((m, i) => setMediaFile(form, `files[${i}]`, files[i]!, fileName(m, files[i]!.mime, i)));
          body = form;
        } else {
          headers["content-type"] = "application/json";
          body = JSON.stringify(payload);
        }
        const url = new URL(hook.base);
        url.searchParams.set("wait", "true");
        if (hook.threadId) url.searchParams.set("thread_id", hook.threadId);
        msg = (await this.request(url.toString(), { method: "POST", headers }, "execute webhook", body)) as DiscordMessage;
      } finally {
        for (const f of files) await f.close();
      }
      if (!msg?.id) throw new ConnectorError("discord publish: response carried no message id", "unknown", false, msg);
      const guild = typeof account.config.guildId === "string" ? account.config.guildId : null;
      return { externalId: msg.id, url: guild ? `https://discord.com/channels/${guild}/${msg.channel_id}/${msg.id}` : null, raw: msg };
    });
  }

  /** Only delete is possible: a webhook can remove the messages it posted. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "delete") throw new ConnectorError(`discord moderate: ${input.action} is not possible through a webhook`, "rejected", false);
    const hook = parseAuth(account);
    if (!/^\d+$/.test(input.externalId)) throw new ConnectorError(`discord: "${input.externalId}" is not a message id`, "rejected", false);
    const url = new URL(`${hook.base}/messages/${input.externalId}`);
    if (hook.threadId) url.searchParams.set("thread_id", hook.threadId);
    await this.request(url.toString(), { method: "DELETE" }, "delete message");
  }

  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  private async request(url: string, init: Omit<RequestInit, "body" | "headers"> & { headers?: Record<string, string> }, what: string, payload?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), url, init, payload);
    } catch (err) {
      const scrub = (s: string) => s.replace(/webhooks\/\d+\/[A-Za-z0-9_-]+/g, "webhooks/<id>/<token>");
      throw asNetworkError(err instanceof Error ? new Error(scrub(err.message)) : err, `discord ${what}`);
    }
    const body = await readJson(res);
    if (!res.ok) throw mapDiscordError(res.status, res.headers, body, what);
    return body;
  }
}

function fileName(m: Media, mime: string, i: number): string {
  const fromUrl = m.url.split("?")[0]?.split("/").pop();
  return fromUrl && /^[\w.-]+\.[a-z0-9]{2,5}$/i.test(fromUrl) ? fromUrl : `file${i}.${mime.split("/")[1] ?? "bin"}`;
}

function parseAuth(account: AccountRef): ParsedWebhook {
  const hook = parseDiscordWebhookUrl(typeof account.auth?.webhookUrl === "string" ? account.auth.webhookUrl : "");
  if (!hook) throw new ConnectorError(`discord account ${account.handle}: auth blob needs a webhookUrl`, "auth", false);
  return hook;
}

export function createDiscordConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new DiscordConnector()];
}
