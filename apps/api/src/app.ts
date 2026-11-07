import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z, ZodError } from "zod";
import { approvalDiffs, postOutcomes, posts, postVariants } from "@starsign/db";
import { CoreError, MAX_UPLOAD_BYTES, type Starsign, type Principal, type ResolvedSession } from "@starsign/core";
import { Policy, Timestamp, type ActivityKind, type Network, type PostStatus } from "@starsign/schema";
import { gatePost } from "@starsign/policy";
import { adaptForNetwork, gatewayKeywordExpander, gatewayTranslator, runPrompt, suggestAliases, type BrandContext, type ModelGateway } from "@starsign/ai";
import { createMentionSearches, type MentionSearch, type SourceAdapter } from "@starsign/sources";
import { Network as NetworkEnum, NETWORK_LIMITS } from "@starsign/schema";
import { allowedWithoutWorkspace, clearSessionCookie, csrfOk, CSRF_HEADER, isPublicAuthRoute, isWrite, registerAuthRoutes, SESSION_COOKIE, setSessionCookie } from "./auth-routes.ts";
import { registerInboxRoutes } from "./routes-inbox.ts"; // ---- inbox workflow
import { registerVisibilityRoutes } from "./routes-visibility.ts"; // ---- AI answer visibility
import { registerAnalyticsRoutes } from "./routes-analytics.ts"; // ---- analytics & client reports

export const VERSION = "0.1.0";

/** `session` is set only for cookie-authenticated requests (a signed-in person); `principal` for every authenticated one. */
export type Env = { Variables: { principal: Principal; session?: ResolvedSession } };

export interface AppOptions {
  /** Slug of a workspace that unauthenticated requests act on, as human owner "dev". Dev only. */
  devWorkspace?: string;
  /** Model gateway for compose assistance. Absent: those routes answer 503. */
  gateway?: ModelGateway | null;
  /** Trend sources this deployment pulls from (for status reporting). */
  sources?: SourceAdapter[];
  /** Public base URL of this deployment (OAuth redirects come back here). */
  publicUrl?: string;
  /** Public mention search for the tracker's "scan now". Default: every configured search. */
  mentionSearches?: MentionSearch[];
  // ---- AI answer visibility
  /** Answer engines to ask (tests). Default: one per key in the environment. */
  answerEngines?: import("@starsign/core").VisibilityEngine[];
}

const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });

function date(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new CoreError("invalid", `bad date: ${v}`);
  return d;
}
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const daysAgo = (n: number, now: Date) => new Date(now.getTime() - n * 86_400_000);

/** Monday 00:00 of the week containing `at`, in `timezone`, as a UTC instant. */
function startOfLocalWeek(at: Date, timezone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(String(parts.weekday));
  const msIntoDay = ((Number(parts.hour) % 24) * 60 + Number(parts.minute)) * 60_000 + at.getUTCSeconds() * 1000 + at.getUTCMilliseconds();
  return new Date(at.getTime() - msIntoDay - Math.max(0, dow) * 86_400_000);
}

export function createApp(m: Starsign, opts: AppOptions = {}) {
  const app = new Hono<Env>();

  app.onError((e, c) => {
    if (e instanceof CoreError) return c.json(err(e.code, e.message, e.details), e.httpStatus as 400);
    if (e instanceof ZodError) return c.json(err("invalid", "validation failed", e.issues), 400);
    if (e instanceof SyntaxError) return c.json(err("invalid", "malformed JSON body"), 400);
    console.error("[api]", e);
    return c.json(err("internal", "internal error"), 500);
  });

  // OAuth callback for every connector: authenticated by the single-use state, not by an API key. Lands back in the room.
  app.get("/oauth/:connector/callback", async (c) => {
    const name = c.req.param("connector");
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) return c.redirect(`/?connect_error=${encodeURIComponent(c.req.query("error") ?? "missing_code")}&connector=${encodeURIComponent(name)}`);
    try {
      const accts = await m.accounts.completeOAuth({ state, code, params: c.req.query() as Record<string, string> });
      const handles = accts.map((a) => a.handle).join(",");
      return c.redirect(`/?connected=${encodeURIComponent(name)}&handle=${encodeURIComponent(handles)}&count=${accts.length}`);
    } catch (e) {
      const reason = e instanceof CoreError ? ((e.details as { reason?: string } | undefined)?.reason ?? "failed") : "failed";
      return c.redirect(`/?connect_error=${encodeURIComponent(reason)}&connector=${encodeURIComponent(name)}`);
    }
  });

  // Inbound webhooks: no API key; the connector verifies the signature over the raw body.
  app.get("/webhooks/:connector", async (c) => {
    const answer = await m.webhooks.challenge(c.req.param("connector"), c.req.query() as Record<string, string>);
    return answer === null ? c.text("not a subscription request", 400) : c.text(answer);
  });
  app.post("/webhooks/:connector", async (c) => {
    const raw = await c.req.text();
    const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const r = await m.webhooks.receive(c.req.param("connector"), headers, raw, c.req.query() as Record<string, string>);
    if (r.ack) return c.body(r.ack.body, 200, { "content-type": r.ack.contentType });
    return c.json({ accepted: r.accepted, items: r.items });
  });

  // Uploaded media on local storage. Keys are unguessable and public by design: networks fetch from here.
  app.get("/media/*", async (c) => {
    if (m.media.storage.name !== "local") return c.text("not found", 404);
    const key = c.req.path.slice("/media/".length);
    try {
      const bytes = await m.media.storage.get(key);
      const ext = key.split(".").pop() ?? "";
      const type = ({ jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", pdf: "application/pdf" } as Record<string, string>)[ext] ?? "application/octet-stream";
      return new Response(bytes, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    } catch {
      return c.text("not found", 404);
    }
  });

  // ---------------------------------------------------------------- owned measurement: short links, conversions
  const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || c.req.header("cf-connecting-ip") || null;

  app.get("/l/:slug", async (c) => {
    const location = await m.links.click(c.req.param("slug"), {
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      referrer: c.req.header("referer") ?? null,
      country: c.req.header("cf-ipcountry") ?? c.req.header("x-vercel-ip-country") ?? c.req.header("x-country-code") ?? null,
    });
    if (!location) return c.text("This link does not exist or has been turned off.", 404, { "cache-control": "no-store" });
    // 302, never cached: every visit must reach us to be counted, and a disabled link must stop working at once.
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store, max-age=0", "referrer-policy": "no-referrer-when-downgrade", "x-robots-tag": "noindex" } });
  });

  const beaconCors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
  app.options("/c", () => new Response(null, { status: 204, headers: beaconCors }));
  app.post("/c", async (c) => {
    // navigator.sendBeacon posts text/plain to skip the CORS preflight; accept JSON in either content type.
    let body: unknown = null;
    try {
      body = JSON.parse((await c.req.text()).slice(0, 4096));
    } catch {
      body = null;
    }
    try {
      await m.links.recordBrowserConversion(body);
    } catch {
      // A beacon never gets an error it could learn from.
    }
    return new Response(null, { status: 204, headers: beaconCors });
  });
  app.get("/s.js", (c) => {
    const base = (opts.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    return c.body(conversionSnippet(base), 200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" });
  });

  // Short-lived, single-use tokens for the SSE stream (EventSource cannot send headers; API keys never go in URLs).
  const streamTokens = new Map<string, { principal: Principal; expires: number }>();
  const STREAM_TOKEN_TTL_MS = 60_000;

  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, db: m.ctx.db.constructor.name.toLowerCase().includes("pglite") ? "pglite" : "postgres" }));

  // Who is asking: a bearer API key (agents, automation), else the starsign_session cookie (people), else the dev workspace.
  const cookieOpts = { publicUrl: opts.publicUrl };
  const auth = createMiddleware<Env>(async (c, next) => {
    if (isPublicAuthRoute(c.req.method, c.req.path)) return next();
    const header = c.req.header("authorization");
    const key = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    if (!key && c.req.path.endsWith("/feed/stream")) {
      const token = c.req.query("token");
      const entry = token ? streamTokens.get(token) : undefined;
      if (token) streamTokens.delete(token); // single use
      if (entry && entry.expires > m.ctx.now().getTime()) {
        c.set("principal", entry.principal);
        return next();
      }
      if (token) return c.json(err("unauthorized", "stream token expired or already used"), 401);
    }
    if (key) {
      const p = await m.workspaces.authenticate(key);
      if (!p) return c.json(err("unauthorized", "invalid api key"), 401);
      c.set("principal", p);
      return next();
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const s = await m.auth.resolveSession(cookie);
      if (!s) {
        clearSessionCookie(c, cookieOpts);
        return c.json(err("unauthorized", "session expired or signed out"), 401);
      }
      // Cookies ride along on cross-site requests; a custom header cannot be sent cross-site without CORS approval.
      if (isWrite(c.req.method) && !csrfOk(c)) return c.json(err("forbidden", `cookie-authenticated writes must send ${CSRF_HEADER}: 1`), 403);
      if (s.refreshed) setSessionCookie(c, cookie, cookieOpts);
      c.set("session", s);
      if (s.principal) c.set("principal", s.principal);
      else if (!allowedWithoutWorkspace(c.req.method, c.req.path)) {
        return c.json(err("forbidden", "you are not a member of any workspace; create one or accept an invite"), 403);
      }
      return next();
    }
    if (opts.devWorkspace) {
      const ws = await m.workspaces.bySlug(opts.devWorkspace);
      if (ws) {
        c.set("principal", { workspaceId: ws.id, actor: { type: "human", id: "dev" }, role: "owner" });
        return next();
      }
    }
    // The sign-in screen asks this first: tell it whether to offer sign-up, and whether nobody can sign in yet.
    if (c.req.path === "/v1/auth/session") return c.json(err("unauthorized", "sign in or send an API key", await m.auth.signupStatus()), 401);
    return c.json(err("unauthorized", "sign in or send an API key"), 401);
  });
  app.use("/v1/*", auth);

  // ---------------------------------------------------------------- people: sign-in, sessions, teams
  registerAuthRoutes(app, m, { publicUrl: opts.publicUrl });
  registerInboxRoutes(app, m); // ---- inbox workflow
  registerVisibilityRoutes(app, m, { gateway: opts.gateway, ...(opts.answerEngines ? { answerEngines: opts.answerEngines } : {}) }); // ---- AI answer visibility
  registerAnalyticsRoutes(app, m, opts); // ---- analytics & client reports

  // ---------------------------------------------------------------- identity & workspace
  app.get("/v1/me", async (c) => {
    const p = c.get("principal");
    return c.json({ workspace: await m.workspaces.get(p.workspaceId), actor: p.actor, role: p.role ?? null });
  });
  app.get("/v1/workspace", async (c) => c.json(await m.workspaces.get(c.get("principal").workspaceId)));
  app.patch("/v1/workspace/profile", async (c) => {
    const body = (await c.req.json()) as { profile: Record<string, unknown> };
    return c.json(await m.workspaces.updateProfile(c.get("principal"), body.profile ?? {}));
  });

  // ---------------------------------------------------------------- api keys
  app.get("/v1/keys", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner"]);
    return c.json(await m.workspaces.listApiKeys(p.workspaceId));
  });
  app.delete("/v1/keys/:id", async (c) => {
    await m.workspaces.revokeApiKey(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- connectors & connecting
  app.get("/v1/connectors", (c) =>
    c.json(
      m.ctx.connectors
        .list()
        .map((k) => ({
          name: k.name,
          networks: [...k.networks],
          configured: k.connectConfigured !== false,
          // The mock (dev and demos only) is listed so the room knows what its accounts can do, never as a way to connect.
          connect: k.name === "mock" ? "none" : (k.connectMethod ?? "none"),
          inputs: k.connectMethod === "oauth" ? (k.oauthInputs ?? []) : (k.credentialInputs ?? []),
          capabilities: Object.fromEntries(k.networks.map((n) => [n, k.capabilities(n)])),
        })),
    ),
  );
  app.post("/v1/accounts/connect/bluesky", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    const body = z.object({ identifier: z.string().min(1), appPassword: z.string().min(1), service: z.string().url().optional() }).parse(await c.req.json());
    const auth = { identifier: body.identifier.replace(/^@/, ""), appPassword: body.appPassword, ...(body.service ? { service: body.service } : {}) };
    return c.json(await m.accounts.connectWithCredentials(p, { connector: "bluesky", network: "bluesky", auth }), 201);
  });

  app.post("/v1/accounts/connect/:connector/credentials", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    const body = z.object({ network: NetworkEnum, inputs: z.record(z.string(), z.string().max(2000)) }).parse(await c.req.json());
    return c.json(await m.accounts.connectFromInputs(p, { connector: c.req.param("connector"), network: body.network, inputs: body.inputs }), 201);
  });
  app.post("/v1/accounts/connect/:connector/start", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    const name = c.req.param("connector");
    if (!opts.publicUrl) throw new CoreError("unavailable", "STARSIGN_PUBLIC_URL is not set, so the network cannot send people back here");
    const body = (await c.req.json().catch(() => ({}))) as { network?: string; inputs?: Record<string, string> };
    const network = body.network ? NetworkEnum.parse(body.network) : undefined;
    return c.json(
      await m.accounts.startOAuth(p, { connector: name, network, inputs: body.inputs, redirectUri: `${opts.publicUrl.replace(/\/+$/, "")}/oauth/${encodeURIComponent(name)}/callback` }),
    );
  });

  // ---------------------------------------------------------------- media library
  // Direct-to-bucket uploads (S3 storage): presign, the browser PUTs the file, then complete.
  app.get("/v1/media/limits", (c) => c.json(m.media.limits()));
  app.post("/v1/media/uploads", async (c) => {
    const body = z.object({ mime: z.string().max(100), bytes: z.number().int().positive(), filename: z.string().max(255).optional() }).parse(await c.req.json());
    return c.json(await m.media.createDirectUpload(c.get("principal"), body), 201);
  });
  app.post("/v1/media/uploads/complete", async (c) => {
    const body = z.object({ uploadId: z.string().min(1).max(4096), alt: z.string().max(1000).optional() }).parse(await c.req.json());
    const row = await m.media.completeDirectUpload(c.get("principal"), body);
    return c.json({ ...row, media: m.media.toMedia(row) }, 201);
  });
  app.post("/v1/media", async (c) => {
    const p = c.get("principal");
    // Refuse oversized uploads before buffering them: the body is read into memory.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
      return c.json(err("too_large", `uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB on this server`), 413);
    }
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new CoreError("invalid", "send the file as multipart field 'file'");
    const row = await m.media.upload(p, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, alt: typeof form.alt === "string" ? form.alt : undefined });
    return c.json({ ...row, media: m.media.toMedia(row) }, 201);
  });
  app.get("/v1/media", async (c) => {
    const rows = await m.media.list(c.get("principal").workspaceId, Number(c.req.query("limit") ?? 100));
    return c.json(rows.map((r) => ({ ...r, media: m.media.toMedia(r) })));
  });
  app.delete("/v1/media/:id", async (c) => {
    await m.media.remove(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- engagement (inbox actions)
  app.post("/v1/feed/:id/reply", async (c) => {
    const body = z.object({ text: z.string().min(1).max(10_000), aiAssisted: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await m.engagement.reply(c.get("principal"), c.req.param("id"), body.text, { aiAssisted: body.aiAssisted }), 201);
  });
  app.post("/v1/feed/:id/moderate", async (c) => {
    const body = z.object({ action: z.enum(["hide", "unhide", "delete", "like", "unlike"]) }).parse(await c.req.json());
    return c.json(await m.engagement.moderate(c.get("principal"), c.req.param("id"), body.action));
  });
  app.get("/v1/accounts/:id/metrics", async (c) => {
    const p = c.get("principal");
    const acc = await m.accounts.get(p.workspaceId, c.req.param("id"));
    const now = m.ctx.now();
    const from = date(c.req.query("from"), daysAgo(90, now));
    const metric = c.req.query("metric") ?? "followers_total";
    return c.json({ latest: await m.metrics.latest("social_account", acc.id), series: await m.metrics.series("social_account", acc.id, metric, from, now) });
  });

  // ---------------------------------------------------------------- compose & calendar
  app.post("/v1/compose/adapt", async (c) => {
    const p = c.get("principal");
    if (!opts.gateway) throw new CoreError("unavailable", "no model is configured for this deployment");
    const body = z.object({ body: z.string().min(1).max(10_000), networks: z.array(NetworkEnum).min(1), topicId: z.string().optional(), notes: z.string().max(2000).optional() }).parse(await c.req.json());
    const brand = (await m.brand.context(p.workspaceId)) as BrandContext;
    let notes = body.notes;
    if (body.topicId) {
      const t = await m.trends.getTopic(body.topicId, p.workspaceId);
      notes = [notes, `This post rides the trend "${t.name}" (keywords: ${t.keywords.join(", ")}).`].filter(Boolean).join("\n");
    }
    const networks = [...new Set(body.networks)];
    const res = await runPrompt(opts.gateway, adaptForNetwork, { brand, idea: body.body, networks, ...(notes ? { notes } : {}) });
    // Never hand back a variant for a network that was not asked for, and say plainly when one is over its limit.
    const variants = res.output.variants.filter((v) => networks.includes(v.network as never));
    const over = variants.filter((v) => [v.text, ...(v.thread ?? [])].some((seg) => seg.length > NETWORK_LIMITS[v.network as keyof typeof NETWORK_LIMITS].maxText));
    return c.json({
      variants: variants.map((v) => ({ network: v.network, text: v.text, thread: v.thread ?? [] })),
      notes: [res.output.notes, over.length ? `Over the limit, trim before posting: ${over.map((v) => v.network).join(", ")}.` : null].filter(Boolean).join(" "),
      usage: { costUsd: res.usage.costUsd, model: res.usage.model },
    });
  });
  app.get("/v1/calendar", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const policy = await m.policy.getActive(p.workspaceId);
    const defaultFrom = startOfLocalWeek(now, policy.timezone);
    const from = date(c.req.query("from"), defaultFrom);
    const to = date(c.req.query("to"), new Date(from.getTime() + 14 * 86_400_000));
    if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new CoreError("invalid", "calendar window is at most 92 days");
    return c.json(await m.posts.calendar(p.workspaceId, from, to));
  });

  // ---------------------------------------------------------------- experiments
  app.get("/v1/experiments", async (c) => c.json(await m.experiments.list(c.get("principal").workspaceId)));
  app.post("/v1/experiments", async (c) => c.json(await m.experiments.create(c.get("principal"), await c.req.json()), 201));
  app.get("/v1/experiments/:id", async (c) => {
    const p = c.get("principal");
    const exp = await m.experiments.get(p.workspaceId, c.req.param("id"));
    return c.json({ experiment: exp, readout: exp.status === "concluded" && exp.result ? exp.result : await m.experiments.readout(p.workspaceId, exp.id) });
  });
  app.post("/v1/experiments/:id/conclude", async (c) => c.json(await m.experiments.conclude(c.get("principal"), c.req.param("id"))));

  // ---------------------------------------------------------------- sources
  app.get("/v1/sources", async (c) => c.json(await m.sources.status(opts.sources ?? [])));
  app.get("/v1/trends/discoveries", async (c) => c.json(await m.sources.discoveries({ limit: Number(c.req.query("limit") ?? 50) })));

  // ---------------------------------------------------------------- accounts
  app.get("/v1/accounts", async (c) => c.json(await m.accounts.list(c.get("principal").workspaceId)));
  app.post("/v1/accounts", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    const body = await c.req.json();
    // An account whose connector this server does not run could never post or pull (the mock in production).
    const name = (body as { connector?: unknown } | null)?.connector;
    if (typeof name === "string" && !m.ctx.connectors.get(name)) throw new CoreError("invalid", `connector "${name}" is not available on this server`);
    return c.json(await m.accounts.connect(p, body), 201);
  });
  app.delete("/v1/accounts/:id", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    await m.accounts.disconnect(p, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- policy
  app.get("/v1/policy", async (c) => c.json(await m.policy.getActive(c.get("principal").workspaceId)));
  app.put("/v1/policy", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner"]);
    if (p.actor.type !== "human") throw new CoreError("forbidden", "only humans change policy");
    return c.json(await m.policy.update(p, await c.req.json()));
  });
  app.get("/v1/policy/history", async (c) => c.json(await m.policy.history(c.get("principal").workspaceId)));
  app.post("/v1/policy/check", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { variants: { network: string; text: string }[]; scheduledAt?: string; actionClass?: string; disclosure?: unknown };
    const policy = await m.policy.getActive(p.workspaceId);
    const at = body.scheduledAt ? date(body.scheduledAt, m.ctx.now()) : null;
    const gate = gatePost({
      policy,
      actionClass: (body.actionClass as never) ?? "new_post",
      actorType: p.actor.type,
      role: p.role,
      subjects: (body.variants ?? []).map((v) => ({ text: v.text, network: v.network, scheduledAt: at, disclosure: (body.disclosure as never) ?? null })),
      wantsSchedule: !!at,
      ctx: { postsToday: await m.policy.postsToday(p.workspaceId, policy.timezone, at ?? m.ctx.now()), classifyTopic: m.ctx.classifyTopic, now: m.ctx.now() },
    });
    return c.json({ ...gate.decision, wouldLand: gate.initialStatus, refused: gate.refusedReason ?? null });
  });

  // ---------------------------------------------------------------- posts
  app.get("/v1/posts", async (c) => {
    const p = c.get("principal");
    const status = list(c.req.query("status")) as PostStatus[];
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(await m.posts.list(p.workspaceId, { status: status.length ? status : undefined, limit }));
  });
  app.get("/v1/posts/queue", async (c) => c.json(await m.posts.queue(c.get("principal").workspaceId)));
  app.post("/v1/posts", async (c) => c.json(await m.posts.create(c.get("principal"), await c.req.json()), 201));
  app.get("/v1/posts/:id", async (c) => {
    const p = c.get("principal");
    const detail = await m.posts.get(p.workspaceId, c.req.param("id"));
    return c.json({ ...detail, history: await m.events.history("post", detail.post.id) });
  });
  app.post("/v1/posts/:id/schedule", async (c) => {
    const body = z.object({ at: Timestamp }).parse(await c.req.json()); // never default a missing time to "now"
    return c.json(await m.posts.schedule(c.get("principal"), c.req.param("id"), new Date(body.at)));
  });
  app.post("/v1/posts/:id/publish-now", async (c) => c.json(await m.posts.publishNow(c.get("principal"), c.req.param("id"))));
  app.post("/v1/posts/:id/cancel", async (c) => c.json(await m.posts.cancel(c.get("principal"), c.req.param("id"))));
  app.post("/v1/posts/:id/retry", async (c) => c.json(await m.posts.retry(c.get("principal"), c.req.param("id"))));
  app.patch("/v1/posts/:id/variants", async (c) => {
    const body = (await c.req.json()) as { edits: Record<string, string> };
    return c.json(await m.posts.updateVariants(c.get("principal"), c.req.param("id"), body.edits ?? {}));
  });
  app.post("/v1/posts/:id/decide", async (c) => c.json(await m.approvals.decide(c.get("principal"), c.req.param("id"), await c.req.json())));

  // ---------------------------------------------------------------- feed
  app.get("/v1/feed", async (c) => {
    const p = c.get("principal");
    const q = c.req.query();
    return c.json(
      await m.listening.feed(p.workspaceId, {
        streamId: q.stream,
        networks: list(q.networks) as Network[],
        kinds: list(q.kinds) as ActivityKind[],
        accountId: q.account,
        since: q.since ? date(q.since, m.ctx.now()) : undefined,
        before: q.before ? date(q.before, m.ctx.now()) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        q: q.q,
        languages: list(q.languages),
        conversationId: q.conversation,
        ...(q.entity ? { ids: await m.entities.activityIdsFor(p.workspaceId, q.entity, { includeChildren: q.children === "1" || q.children === "true", limit: 2000 }) } : {}),
      }),
    );
  });

  // ---------------------------------------------------------------- the tracker: parties, brands, people
  app.get("/v1/entities", async (c) => c.json(await m.entities.list(c.get("principal").workspaceId, { includeArchived: c.req.query("archived") === "1" })));
  app.post("/v1/entities", async (c) => c.json(await m.entities.create(c.get("principal"), await c.req.json()), 201));
  app.get("/v1/entities/report", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const policy = await m.policy.getActive(p.workspaceId);
    return c.json(await m.entities.report(p.workspaceId, date(c.req.query("from"), daysAgo(7, now)), date(c.req.query("to"), now), policy.timezone));
  });
  app.get("/v1/entities/:id", async (c) => c.json(await m.entities.get(c.get("principal").workspaceId, c.req.param("id"))));
  app.patch("/v1/entities/:id", async (c) => c.json(await m.entities.update(c.get("principal"), c.req.param("id"), await c.req.json())));
  app.delete("/v1/entities/:id", async (c) => {
    await m.entities.archive(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/entities/:id/mentions", async (c) => {
    const p = c.get("principal");
    const children = c.req.query("children") === "1" || c.req.query("children") === "true";
    return c.json(await m.entities.mentions(p.workspaceId, c.req.param("id"), { includeChildren: children, limit: Number(c.req.query("limit") ?? 50) }));
  });
  /** Search public posts and news for one tracked name now (the background job does this every 30 minutes). */
  app.post("/v1/entities/:id/scan", async (c) => {
    const p = c.get("principal");
    if (p.actor.type === "human" && (!p.role || p.role === "viewer")) throw new CoreError("forbidden", "viewers cannot start a scan");
    const e = await m.entities.get(p.workspaceId, c.req.param("id"));
    const r = await m.entities.scanPublic(opts.mentionSearches ?? createMentionSearches(), { workspaceId: p.workspaceId, entityId: e.id });
    return c.json(r);
  });
  /** Suggestions only: nothing changes until the person adds them with PATCH. */
  app.post("/v1/entities/:id/suggest-aliases", async (c) => {
    const p = c.get("principal");
    const e = await m.entities.get(p.workspaceId, c.req.param("id"));
    const body = z.object({ languages: z.array(z.string().min(2).max(12)).max(12).default([]) }).parse(await c.req.json().catch(() => ({})));
    const gw = await modelFor(p.workspaceId);
    const parent = e.parentId ? await m.entities.get(p.workspaceId, e.parentId) : null;
    const seen = body.languages.length ? body.languages : (await m.translations.languagesSeen(p.workspaceId, daysAgo(30, m.ctx.now()))).flatMap((l) => (l.lang ? [l.lang] : [])).slice(0, 8);
    const languages = seen.length ? seen : [(await m.translations.settings(p.workspaceId)).home];
    const runId = await m.ops.startRun(p.workspaceId, "tracker");
    try {
      const res = await runPrompt(gw, suggestAliases, { name: e.name, kind: e.kind, ...(e.role ? { role: e.role } : {}), ...(parent ? { parent: parent.name } : {}), languages, existing: [e.name, ...e.aliases] });
      await m.ops.finishRun(runId, { status: "succeeded", summary: `suggested ${res.output.aliases.length} alias(es) for ${e.name}`, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd });
      const have = new Set([e.name, ...e.aliases].map((x) => x.normalize("NFKC").toLowerCase()));
      return c.json({ languages, aliases: res.output.aliases.filter((a) => !have.has(a.text.normalize("NFKC").toLowerCase())), ambiguous: res.output.ambiguous });
    } catch (err) {
      await m.ops.finishRun(runId, { status: "failed", error: (err as Error).message });
      throw err;
    }
  });

  // ---------------------------------------------------------------- languages
  /** Model calls made for a person go through the same monthly spend cap the operators respect. */
  const modelFor = async (workspaceId: string): Promise<ModelGateway> => {
    if (!opts.gateway) throw new CoreError("unavailable", "no model is configured for this deployment, so translation is off");
    const policy = await m.policy.getActive(workspaceId);
    if ((await m.ops.modelSpendThisMonth(workspaceId, m.ctx.now())) >= policy.spendCaps.modelUsdMonthly) {
      throw new CoreError("unavailable", "this workspace has reached its monthly model spend cap; raise it in the policy to translate more");
    }
    return opts.gateway;
  };
  app.get("/v1/languages", async (c) => {
    const p = c.get("principal");
    const since = daysAgo(30, m.ctx.now());
    return c.json({ settings: await m.translations.settings(p.workspaceId), seen: await m.translations.languagesSeen(p.workspaceId, since), translationAvailable: Boolean(opts.gateway) });
  });
  app.patch("/v1/languages/settings", async (c) => c.json(await m.translations.updateSettings(c.get("principal"), await c.req.json())));
  app.post("/v1/feed/:id/translate", async (c) => {
    const p = c.get("principal");
    const gw = await modelFor(p.workspaceId);
    return c.json(await m.translations.translateOne(p, c.req.param("id"), gatewayTranslator(gw)));
  });
  app.post("/v1/streams/:id/expand", async (c) => {
    const p = c.get("principal");
    const body = z.object({ languages: z.array(z.string().min(2).max(12)).min(1).max(12) }).parse(await c.req.json());
    const gw = await modelFor(p.workspaceId);
    const brand = (await m.brand.context(p.workspaceId)) as BrandContext;
    return c.json(await m.translations.expandStream(p, c.req.param("id"), body.languages, gatewayKeywordExpander(gw, [brand.workspace.name])));
  });
  app.get("/v1/feed/counts", async (c) => {
    const p = c.get("principal");
    return c.json(await m.listening.counts(p.workspaceId, date(c.req.query("since"), daysAgo(7, m.ctx.now()))));
  });
  app.post("/v1/feed/stream-token", (c) => {
    const p = c.get("principal");
    const now = m.ctx.now().getTime();
    for (const [t, e] of streamTokens) if (e.expires <= now) streamTokens.delete(t);
    const token = randomBytes(24).toString("base64url");
    streamTokens.set(token, { principal: p, expires: now + STREAM_TOKEN_TTL_MS });
    return c.json({ token, expiresInSeconds: STREAM_TOKEN_TTL_MS / 1000 });
  });
  app.get("/v1/feed/stream", (c) => {
    const p = c.get("principal");
    return streamSSE(c, async (stream) => {
      const names = ["activity", "post", "alert", "forecast", "inbox"] as const; // "inbox": inbox workflow
      const handlers = names.map((name) => {
        const h = (payload: { workspaceId?: string | null }) => {
          const ws = payload.workspaceId;
          if (ws === p.workspaceId || (name === "forecast" && (ws === null || ws === undefined))) {
            void stream.writeSSE({ event: name, data: JSON.stringify(payload) });
          }
        };
        m.emitter.on(name, h);
        return [name, h] as const;
      });
      stream.onAbort(() => {
        for (const [name, h] of handlers) m.emitter.off(name, h);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ workspaceId: p.workspaceId }) });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.write(": ping\n\n");
      }
    });
  });
  app.get("/v1/streams", async (c) => c.json(await m.listening.listStreams(c.get("principal").workspaceId)));
  app.post("/v1/streams", async (c) => c.json(await m.listening.createStream(c.get("principal"), await c.req.json()), 201));
  app.delete("/v1/streams/:id", async (c) => {
    await m.listening.deleteStream(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/v1/ingest/items", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver", "editor"]);
    const body = (await c.req.json()) as { accountId?: string | null; items: unknown[] };
    if (body.accountId) await m.accounts.get(p.workspaceId, body.accountId); // must be ours
    return c.json(await m.listening.ingestItems(p.workspaceId, body.accountId ?? null, body.items ?? []));
  });
  app.post("/v1/ingest/:accountId", async (c) => {
    const p = c.get("principal");
    await m.accounts.get(p.workspaceId, c.req.param("accountId"));
    return c.json(await m.listening.ingestAccount(c.req.param("accountId")));
  });

  // ---------------------------------------------------------------- metrics
  app.get("/v1/metrics/summary", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const policy = await m.policy.getActive(p.workspaceId);
    return c.json(await m.metrics.summary(p.workspaceId, date(c.req.query("from"), daysAgo(7, now)), date(c.req.query("to"), now), policy.timezone));
  });
  app.get("/v1/metrics/lift-by-stage", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    return c.json(await m.metrics.liftByStage(p.workspaceId, date(c.req.query("from"), daysAgo(30, now)), date(c.req.query("to"), now)));
  });
  app.get("/v1/metrics/series", async (c) => {
    const p = c.get("principal");
    const q = c.req.query();
    const now = m.ctx.now();
    if (!q.entityType || !q.entityId || !q.metric) throw new CoreError("invalid", "entityType, entityId and metric are required");
    // Metrics rows carry no workspace column, so the entity is resolved inside the caller's workspace first.
    switch (q.entityType) {
      case "post_variant": {
        const [v] = await m.ctx.db
          .select({ id: postVariants.id })
          .from(postVariants)
          .innerJoin(posts, eq(posts.id, postVariants.postId))
          .where(and(eq(postVariants.externalId, q.entityId), eq(posts.workspaceId, p.workspaceId)))
          .limit(1);
        if (!v) throw new CoreError("not_found", "variant");
        break;
      }
      case "social_account":
        await m.accounts.get(p.workspaceId, q.entityId);
        break;
      case "trend_topic":
        await m.trends.getTopic(q.entityId, p.workspaceId);
        break;
      case "workspace":
        if (q.entityId !== p.workspaceId) throw new CoreError("not_found", "workspace");
        break;
      default:
        throw new CoreError("not_found", `entity type ${q.entityType}`);
    }
    return c.json(await m.metrics.series(q.entityType, q.entityId, q.metric, date(q.from, daysAgo(30, now)), date(q.to, now)));
  });
  app.get("/v1/metrics/variant/:variantId", async (c) => {
    const p = c.get("principal");
    const [v] = await m.ctx.db.select().from(postVariants).where(eq(postVariants.id, c.req.param("variantId"))).limit(1);
    if (!v) throw new CoreError("not_found", "variant");
    await m.posts.get(p.workspaceId, v.postId); // tenancy check
    const outcomes = await m.ctx.db.select().from(postOutcomes).where(eq(postOutcomes.variantId, v.id)).orderBy(postOutcomes.dueAt);
    return c.json({ latest: v.externalId ? await m.metrics.latest("post_variant", v.externalId) : {}, outcomes });
  });

  // ---------------------------------------------------------------- links & conversions
  app.get("/v1/links", async (c) => {
    const p = c.get("principal");
    return c.json({ baseUrl: m.links.baseUrl, settings: await m.links.settings(p.workspaceId), links: await m.links.list(p.workspaceId, Number(c.req.query("limit") ?? 100)) });
  });
  app.post("/v1/links", async (c) => {
    const body = z.object({ url: z.string().min(1).max(2048), network: NetworkEnum.optional(), campaign: z.string().max(100).optional() }).parse(await c.req.json());
    return c.json(await m.links.create(c.get("principal"), body), 201);
  });
  app.delete("/v1/links/:id", async (c) => {
    await m.links.disable(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/links/report", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const policy = await m.policy.getActive(p.workspaceId);
    return c.json(await m.links.report(p.workspaceId, date(c.req.query("from"), daysAgo(30, now)), date(c.req.query("to"), now), policy.timezone));
  });
  app.get("/v1/links/settings", async (c) => c.json({ ...(await m.links.settings(c.get("principal").workspaceId)), baseUrl: m.links.baseUrl }));
  app.patch("/v1/links/settings", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner"]);
    return c.json(await m.links.updateSettings(p, await c.req.json()));
  });
  app.get("/v1/conversions", async (c) => c.json(await m.links.listConversions(c.get("principal").workspaceId, Number(c.req.query("limit") ?? 100))));
  app.post("/v1/conversions", async (c) => {
    const result = await m.links.recordConversion(c.get("principal"), await c.req.json());
    return c.json(result, result.duplicate ? 200 : 201);
  });

  // ---------------------------------------------------------------- trends
  app.get("/v1/trends/radar", async (c) => c.json(await m.trends.radar(c.get("principal").workspaceId)));
  app.get("/v1/trends/topics", async (c) => c.json(await m.trends.listTopics(c.get("principal").workspaceId)));
  app.post("/v1/trends/topics", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { name: string; keywords: string[]; relevance?: number; global?: boolean };
    if (body.global) m.workspaces.requireRole(p, ["owner"]);
    return c.json(await m.trends.createTopic({ workspaceId: body.global ? null : p.workspaceId, name: body.name, keywords: body.keywords ?? [], relevance: body.relevance }), 201);
  });
  app.patch("/v1/trends/topics/:id", async (c) => {
    const body = (await c.req.json()) as { relevance: number };
    await m.trends.setRelevance(c.get("principal"), c.req.param("id"), Number(body.relevance));
    return c.body(null, 204);
  });
  app.get("/v1/trends/topics/:id", async (c) => c.json(await m.trends.detail(c.get("principal").workspaceId, c.req.param("id"))));
  app.post("/v1/trends/topics/:id/forecast", async (c) => {
    const { combined, ...rest } = await m.trends.computeForecast(c.req.param("id"), {}, c.get("principal"));
    return c.json(rest);
  });
  app.post("/v1/trends/points", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { points: unknown[] };
    return c.json({ recorded: await m.trends.recordPoints(body.points ?? [], p) });
  });

  // ---------------------------------------------------------------- operators' output
  app.get("/v1/alerts", async (c) => {
    const p = c.get("principal");
    return c.json(await m.ops.alerts(p.workspaceId, { unacknowledgedOnly: c.req.query("unacknowledged") === "1", limit: Number(c.req.query("limit") ?? 50) }));
  });
  app.post("/v1/alerts/:id/ack", async (c) => {
    await m.ops.acknowledge(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/briefs", async (c) => c.json(await m.ops.briefs(c.get("principal").workspaceId, Number(c.req.query("limit") ?? 12))));
  app.get("/v1/briefs/latest", async (c) => c.json((await m.ops.briefs(c.get("principal").workspaceId, 1))[0] ?? null));
  app.get("/v1/runs", async (c) => c.json(await m.ops.runs(c.get("principal").workspaceId, Number(c.req.query("limit") ?? 50))));

  // ---------------------------------------------------------------- ledger & export
  app.get("/v1/ledger", async (c) => {
    const p = c.get("principal");
    const q = c.req.query();
    return c.json(
      await m.events.list({
        workspaceId: p.workspaceId,
        types: list(q.types),
        subjectType: q.subjectType,
        subjectId: q.subjectId,
        afterSeq: q.afterSeq ? Number(q.afterSeq) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });
  app.get("/v1/export", async (c) => {
    const p = c.get("principal");
    const data = await m.exports.workspace(p);
    c.header("Content-Disposition", `attachment; filename="starsign-${data.workspace?.slug ?? p.workspaceId}.json"`);
    return c.json(data);
  });

  // ---------------------------------------------------------------- brand context for agents
  app.get("/v1/context", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const [ws, policy, accounts, summary, radar] = await Promise.all([
      m.workspaces.get(p.workspaceId),
      m.policy.getActive(p.workspaceId),
      m.accounts.list(p.workspaceId),
      m.metrics.summary(p.workspaceId, daysAgo(30, now), now),
      m.trends.radar(p.workspaceId),
    ]);
    const diffs = await m.ctx.db
      .select({ before: approvalDiffs.beforeText, after: approvalDiffs.afterText })
      .from(approvalDiffs)
      .where(and(eq(approvalDiffs.workspaceId, p.workspaceId)))
      .orderBy(desc(approvalDiffs.createdAt))
      .limit(20);
    const parsed = Policy.parse(policy);
    return c.json({
      workspace: { name: ws.name, profile: ws.profile },
      policy: { autonomy: parsed.autonomy, redLines: parsed.redLines.map((r) => ({ id: r.id, kind: r.kind, description: r.description, severity: r.severity })), timezone: parsed.timezone, competitors: parsed.competitors },
      accounts,
      recentTop: summary.top,
      voiceExamples: diffs,
      activeTopics: radar.slice(0, 10),
    });
  });

  return app;
}

/**
 * The browser half of conversion tracking. Drop it on the destination site:
 *   <script src="https://YOUR-STARSIGN/s.js" async></script>
 * It keeps the ssclid from the landing URL in first-party storage for 30 days, and
 *   starsign.convert("purchase", 49.0, "USD")
 * reports a conversion against that click. No cookies are set on any other domain; nothing runs without a click id.
 */
export function conversionSnippet(base: string): string {
  return `(function(){var K="starsign_clid",T=2592e6,B=${JSON.stringify(base)};
function get(){try{var v=JSON.parse(localStorage.getItem(K)||"null");if(v&&Date.now()-v.t<T)return v.id}catch(e){}return null}
try{var p=new URLSearchParams(location.search).get("ssclid");if(p&&/^clk_[0-9a-f]{32}$/.test(p))localStorage.setItem(K,JSON.stringify({id:p,t:Date.now()}))}catch(e){}
function convert(name,value,currency){var id=get();if(!id)return false;var b=JSON.stringify({clickId:id,name:name||"conversion",value:typeof value==="number"?value:undefined,currency:currency});
if(navigator.sendBeacon)return navigator.sendBeacon(B+"/c",b);fetch(B+"/c",{method:"POST",body:b,keepalive:true,mode:"cors"});return true}
var q=(window.starsign&&window.starsign.q)||[];window.starsign={convert:convert,clickId:get};for(var i=0;i<q.length;i++)convert.apply(null,q[i]);})();`;
}
