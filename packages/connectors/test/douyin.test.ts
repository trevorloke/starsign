import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, STREAM_PIECE_BYTES, type AccountRef, type PublishInput } from "../src/index.ts";
import { DouyinConnector, createDouyinConnectors, douyinEnvelopeError, douyinPartPlan, mapDouyinError, type DouyinConnectorOptions } from "../src/douyin.ts";
import { MiB, bigVideo, network } from "./big-video.ts";

const NOW = new Date("2026-11-07T00:00:00.000Z");
const BASE = "https://open.douyin.com";
// Assembled at runtime so nothing here looks like a real credential.
const TOKEN = ["dy", "test", "access"].join("-");
const REFRESH = ["dy", "test", "refresh"].join("-");
const SECRET = ["client", "secret"].join("-");

const acct = (auth: Record<string, unknown> = {}): AccountRef => ({
  id: "acc-dy",
  workspaceId: "w",
  network: "douyin",
  externalId: "open-1",
  handle: "Acme",
  auth: { accessToken: TOKEN, refreshToken: REFRESH, openId: "open-1", expiresAt: "2026-11-20T00:00:00.000Z", refreshExpiresAt: "2026-12-01T00:00:00.000Z", renewals: 0, ...auth },
  config: { openId: "open-1" },
});

/** Douyin's success envelope. */
const ok = (data: Record<string, unknown> = {}, status = 200) => new Response(JSON.stringify({ data: { ...data, error_code: 0, description: "" }, extra: { error_code: 0, description: "", logid: "L1", now: 1 } }), { status, headers: { "content-type": "application/json" } });
const fail = (code: number, description: string, status = 200) => new Response(JSON.stringify({ data: { error_code: code, description }, extra: { error_code: code, description, logid: "L2" } }), { status, headers: { "content-type": "application/json" } });

type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

function setup(route: Route, opts: DouyinConnectorOptions = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const i = init ?? {};
    calls.push({ url, init: i });
    const r = await route(url, i);
    if (!r) throw new Error(`unexpected ${i.method ?? "GET"} ${url.pathname}`);
    return r;
  });
  const c = new DouyinConnector({ clientKey: "ck", clientSecret: SECRET, fetch: fetchMock as unknown as typeof fetch, now: () => NOW, sleep: async () => {}, ...opts });
  c.media = { fetch: async (m) => (m.kind === "video" ? { bytes: new Uint8Array(m.bytes ?? 1000).fill(7), mime: "video/mp4" } : { bytes: Uint8Array.from([0xff, 0xd8, 0xff]), mime: "image/jpeg" }) };
  const hits = (path: string) => calls.filter((x) => x.url.pathname === path);
  const jsonOf = (path: string, n = 0) => JSON.parse(String(hits(path)[n]!.init.body)) as Record<string, unknown>;
  const formOf = (path: string, n = 0) => new URLSearchParams(String(hits(path)[n]!.init.body));
  return { c, calls, fetchMock, hits, jsonOf, formOf };
}

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected rejection");
}

const video = (bytes = 1000) => ({ kind: "video" as const, url: "https://media.acme.example/v.mp4", mime: "video/mp4", bytes, durationSeconds: 30 });
const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "新品上市 #acme", media: [video()], thread: [], idempotencyKey: "k1", options: { privacy: "public" }, ...over });

afterEach(() => vi.unstubAllGlobals());

describe("douyin connect", () => {
  it("builds the authorize URL with client_key and comma scopes; unconfigured without credentials", () => {
    const { c } = setup(() => undefined);
    const u = new URL(c.oauthAuthorizeUrl({ state: "st", codeChallenge: "ch", redirectUri: "https://app.example/oauth/douyin/callback" }));
    expect(u.origin + u.pathname).toBe("https://open.douyin.com/platform/oauth/connect/");
    expect(u.searchParams.get("client_key")).toBe("ck");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("user_info,video.create.bind,video.data.bind,item.comment");
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(c.connectConfigured).toBe(true);
    expect(createDouyinConnectors({})[0]!.connectConfigured).toBe(false);
    const fromEnv = createDouyinConnectors({ DOUYIN_CLIENT_KEY: "a", DOUYIN_CLIENT_SECRET: "b", DOUYIN_SCOPES: "user_info,video.create" });
    expect(fromEnv.map((x) => [x.name, x.networks, x.connectConfigured])).toEqual([["douyin", ["douyin"], true]]);
    expect(new URL(fromEnv[0]!.oauthAuthorizeUrl!({ state: "s", codeChallenge: "c", redirectUri: "https://r" })).searchParams.get("scope")).toBe("user_info,video.create");
  });

  it("exchanges the code (data-wrapped token) and names the account from userinfo", async () => {
    const { c, formOf } = setup((url) => {
      if (url.pathname === "/oauth/access_token/") return ok({ access_token: TOKEN, expires_in: 1296000, open_id: "open-1", refresh_token: REFRESH, refresh_expires_in: 2592000, scope: "user_info,video.create.bind" });
      if (url.pathname === "/oauth/userinfo/") return ok({ open_id: "open-1", nickname: "Acme 官方", avatar: "https://p.example/a.jpg", e_account_role: "EAccountS" });
      return undefined;
    });
    const accounts = await c.oauthConnect({ code: "the-code", codeVerifier: "v", redirectUri: "https://app.example/oauth/douyin/callback" });
    expect(Object.fromEntries(formOf("/oauth/access_token/"))).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_key: "ck", client_secret: SECRET });
    expect(Object.fromEntries(formOf("/oauth/userinfo/"))).toEqual({ access_token: TOKEN, open_id: "open-1" });
    expect(accounts).toEqual([
      {
        network: "douyin",
        identity: { externalId: "open-1", handle: "Acme 官方", displayName: "Acme 官方" },
        auth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: "2026-11-22T00:00:00.000Z", refreshExpiresAt: "2026-12-07T00:00:00.000Z", openId: "open-1", scope: "user_info,video.create.bind", renewals: 0 },
        config: { openId: "open-1" },
      },
    ]);
  });

  it("reports a failed exchange as auth with Douyin's code and description", async () => {
    const { c } = setup(() => fail(10007, "授权码过期"));
    const err = await rejection(c.oauthConnect({ code: "old", codeVerifier: "v", redirectUri: "https://r" }));
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("10007");
    expect(err.message).toContain("授权码过期");
  });

  it("refreshes the access token at /oauth/refresh_token/ and keeps the refresh token's expiry", async () => {
    const { c, formOf, hits } = setup((url) => (url.pathname === "/oauth/refresh_token/" ? ok({ access_token: "new-access", expires_in: 1296000, open_id: "open-1", scope: "user_info" }) : undefined));
    const r = await c.refreshAuth(acct());
    expect(Object.fromEntries(formOf("/oauth/refresh_token/"))).toMatchObject({ grant_type: "refresh_token", refresh_token: REFRESH, client_key: "ck" });
    expect(hits("/oauth/renew_refresh_token/")).toHaveLength(0);
    expect(r!.auth).toEqual({ accessToken: "new-access", refreshToken: REFRESH, expiresAt: "2026-11-22T00:00:00.000Z", refreshExpiresAt: "2026-12-01T00:00:00.000Z", openId: "open-1", scope: "user_info", renewals: 0 });
  });

  it("renews a refresh token that is about to expire (counting renewals), and gives up when it is dead", async () => {
    const { c, formOf, hits } = setup((url) => {
      if (url.pathname === "/oauth/renew_refresh_token/") return ok({ refresh_token: "renewed-refresh", expires_in: 2592000 });
      if (url.pathname === "/oauth/refresh_token/") return ok({ access_token: "new-access", expires_in: 1296000, open_id: "open-1" });
      return undefined;
    });
    const r = await c.refreshAuth(acct({ refreshExpiresAt: "2026-11-08T00:00:00.000Z", renewals: 2 }));
    expect(Object.fromEntries(formOf("/oauth/renew_refresh_token/"))).toEqual({ client_key: "ck", refresh_token: REFRESH });
    expect(formOf("/oauth/refresh_token/").get("refresh_token")).toBe("renewed-refresh");
    expect(r!.auth).toMatchObject({ refreshToken: "renewed-refresh", refreshExpiresAt: "2026-12-07T00:00:00.000Z", renewals: 3 });
    // Five renewals used: refresh with the current token, no renew.
    await c.refreshAuth(acct({ refreshExpiresAt: "2026-11-08T00:00:00.000Z", renewals: 5 }));
    expect(hits("/oauth/renew_refresh_token/")).toHaveLength(1);
    expect(await c.refreshAuth(acct({ refreshExpiresAt: "2026-11-06T00:00:00.000Z" }))).toBeNull();
  });
});

describe("douyin publish", () => {
  const publishRoutes = (review: Record<string, unknown> = { is_reviewed: true, video_status: 5 }): Route => (url) => {
    if (url.pathname === "/api/douyin/v1/video/upload_video/") return ok({ video: { video_id: "vid-enc-1", width: 1080, height: 1920 } });
    if (url.pathname === "/api/douyin/v1/video/upload_image/") return ok({ image: { image_id: "img-1", width: 1, height: 1 } });
    if (url.pathname === "/api/douyin/v1/video/create_video/") return ok({ item_id: "@item1" });
    if (url.pathname === "/api/douyin/v1/video/create_image_text/") return ok({ item_id: "@item2" });
    if (url.pathname === "/api/douyin/v1/video/video_data/") return ok({ list: [{ item_id: "@item1", share_url: "https://www.iesdouyin.com/share/video/1/", ...review }] });
    return undefined;
  };

  it("uploads a small video in one request, creates it with text and privacy, and reads the share URL", async () => {
    const { c, hits, jsonOf, fetchMock } = setup(publishRoutes());
    const res = await c.publish(acct(), input({ options: { privacy: "friends" } }));
    expect(res).toMatchObject({ externalId: "@item1", url: "https://www.iesdouyin.com/share/video/1/" });
    const up = hits("/api/douyin/v1/video/upload_video/")[0]!;
    expect(up.url.searchParams.get("open_id")).toBe("open-1");
    expect((up.init.headers as Record<string, string>)["access-token"]).toBe(TOKEN);
    expect(up.url.searchParams.has("access_token")).toBe(false);
    const file = (up.init.body as FormData).get("video") as File;
    expect(file.size).toBe(1000);
    expect(jsonOf("/api/douyin/v1/video/create_video/")).toEqual({ video_id: "vid-enc-1", text: "新品上市 #acme", private_status: 2 });
    expect(jsonOf("/api/douyin/v1/video/video_data/")).toEqual({ item_ids: ["@item1"] });
    const n = fetchMock.mock.calls.length;
    await c.publish(acct(), input({ options: { privacy: "friends" } }));
    expect(fetchMock.mock.calls.length).toBe(n); // idempotent
  });

  it("uploads a cover from thumbnailUrl and does not upload again when create is retried", async () => {
    let creates = 0;
    const base = publishRoutes();
    const { c, hits, jsonOf } = setup((url, init) => {
      if (url.pathname === "/api/douyin/v1/video/create_video/" && creates++ === 0) return fail(2100004, "系统繁忙");
      return base(url, init);
    });
    const opts = { privacy: "self" as const, thumbnailUrl: "https://media.acme.example/cover.jpg" };
    const err = await rejection(c.publish(acct(), input({ idempotencyKey: "retry", options: opts })));
    expect([err.kind, err.retryable]).toEqual(["network", true]);
    await c.publish(acct(), input({ idempotencyKey: "retry", options: opts }));
    expect(hits("/api/douyin/v1/video/upload_video/")).toHaveLength(1);
    expect(hits("/api/douyin/v1/video/upload_image/")).toHaveLength(1);
    expect(jsonOf("/api/douyin/v1/video/create_video/", 1)).toEqual({ video_id: "vid-enc-1", text: "新品上市 #acme", private_status: 1, custom_cover_image_url: "img-1" });
  });

  it("posts pictures (图文) with upload_image + create_image_text", async () => {
    const { c, jsonOf, hits } = setup(publishRoutes());
    const res = await c.publish(acct(), input({ media: [{ kind: "image", url: "https://media.acme.example/a.jpg", mime: "image/jpeg" }], options: {} }));
    expect(res.externalId).toBe("@item2");
    expect((hits("/api/douyin/v1/video/upload_image/")[0]!.init.body as FormData).get("image")).toBeInstanceOf(Blob);
    expect(jsonOf("/api/douyin/v1/video/create_image_text/")).toEqual({ image_list: ["img-1"], text: "新品上市 #acme" });
  });

  it("keeps the item id when review marks the post not suitable for public display", async () => {
    const { c } = setup(publishRoutes({ is_reviewed: true, video_status: 2 }));
    const err = await rejection(c.publish(acct(), input()));
    expect(err.kind).toBe("rejected");
    expect(err.partial).toEqual({ externalId: "@item1", url: "https://www.iesdouyin.com/share/video/1/", threadExternalIds: [] });
  });

  it("maps a content-review refusal at create to rejected", async () => {
    const base = publishRoutes();
    const { c } = setup((url, init) => (url.pathname === "/api/douyin/v1/video/create_video/" ? fail(2190015, "视频内容审核不通过") : base(url, init)));
    const err = await rejection(c.publish(acct(), input()));
    expect([err.kind, err.retryable]).toEqual(["rejected", false]);
    expect(err.message).toContain("content review");
  });

  it("validates media, length and privacy", () => {
    const { c } = setup(() => undefined);
    expect(c.validate(acct(), input({ media: [] })).map((i) => i.code)).toContain("media_required");
    expect(c.validate(acct(), input({ text: "字".repeat(1001) })).map((i) => i.code)).toContain("too_long");
    expect(c.validate(acct(), input({ text: "字".repeat(1000) }))).toEqual([]);
    expect(c.validate(acct(), input({ options: { privacy: "followers" } })).map((i) => i.code)).toContain("empty");
    expect(c.validate(acct(), input({ media: [video(), { kind: "image", url: "https://m/a.jpg" }] })).map((i) => i.code)).toContain("unsupported_media");
    expect(c.validate(acct(), input({ media: [{ kind: "gif", url: "https://m/a.gif" }] })).map((i) => i.code)).toContain("unsupported_media");
  });
});

describe("douyin part upload streams one part at a time", () => {
  it("plans 20 MB parts numbered from 1 and folds a tail under 5 MB into the last part", () => {
    expect(douyinPartPlan(50 * MiB)).toEqual([
      { partNumber: 1, start: 0, length: 20 * MiB },
      { partNumber: 2, start: 20 * MiB, length: 20 * MiB },
      { partNumber: 3, start: 40 * MiB, length: 10 * MiB },
    ]);
    expect(douyinPartPlan(42 * MiB).map((p) => p.length)).toEqual([20 * MiB, 22 * MiB]);
    expect(douyinPartPlan(3 * MiB)).toEqual([{ partNumber: 1, start: 0, length: 3 * MiB }]);
    expect(() => douyinPartPlan(0)).toThrow(ConnectorError);
  });

  it("init → upload_video_part ×3 (streamed multipart, never the whole file) → complete → create_video", async () => {
    const SIZE = 50 * MiB;
    const { fetcher, stats, media } = bigVideo(SIZE);
    const okBody = (data: Record<string, unknown>) => new Response(JSON.stringify({ data: { ...data, error_code: 0, description: "" }, extra: { error_code: 0, logid: "L" } }), { status: 200 });
    const { sent } = network((r) => {
      const p = r.url.pathname;
      if (p === "/api/douyin/v1/video/init_video_part_upload/") return okBody({ upload_id: "up/1+=" });
      if (p === "/api/douyin/v1/video/upload_video_part/") return okBody({});
      if (p === "/api/douyin/v1/video/complete_video_part_upload/") return okBody({ video: { video_id: "vid-big" } });
      if (p === "/api/douyin/v1/video/create_video/") return okBody({ item_id: "@big" });
      if (p === "/api/douyin/v1/video/video_data/") return okBody({ list: [] });
      return undefined;
    });
    // Lower the single-request limit so a 50 MB file takes the part path (the default limit is 128 MB).
    const c = new DouyinConnector({ clientKey: "ck", clientSecret: SECRET, now: () => NOW, sleep: async () => {}, singleUploadMaxBytes: 16 * MiB });
    c.media = fetcher;
    const res = await c.publish(acct(), input({ media: [media], idempotencyKey: "big" }));
    expect(res.externalId).toBe("@big");
    expect(sent.some((r) => r.url.pathname === "/api/douyin/v1/video/upload_video/")).toBe(false);
    const parts = sent.filter((r) => r.url.pathname === "/api/douyin/v1/video/upload_video_part/");
    expect(parts.map((r) => [r.url.searchParams.get("upload_id"), r.url.searchParams.get("part_number"), r.url.searchParams.get("open_id")])).toEqual([
      ["up/1+=", "1", "open-1"],
      ["up/1+=", "2", "open-1"],
      ["up/1+=", "3", "open-1"],
    ]);
    for (const r of parts) {
      expect(r.streamed).toBe(true);
      expect(r.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      expect(r.headers.get("access-token")).toBe(TOKEN);
      expect(r.maxPiece).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
    }
    expect(parts.flatMap((r) => r.fileParts)).toEqual([
      { name: "video", filename: "video.mp4", bytes: 20 * MiB },
      { name: "video", filename: "video.mp4", bytes: 20 * MiB },
      { name: "video", filename: "video.mp4", bytes: 10 * MiB },
    ]);
    const complete = sent.find((r) => r.url.pathname === "/api/douyin/v1/video/complete_video_part_upload/")!;
    expect(complete.url.searchParams.get("upload_id")).toBe("up/1+=");
    expect(JSON.parse(sent.find((r) => r.url.pathname === "/api/douyin/v1/video/create_video/")!.text!)).toMatchObject({ video_id: "vid-big" });
    // At most one part is ever read at a time, and the file is never fetched whole.
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(20 * MiB);
    expect(stats.bytesRead).toBe(SIZE);
  });
});

describe("douyin inbox", () => {
  const routes = (calls: string[]): Route => (url) => {
    calls.push(`${url.pathname}${url.searchParams.get("item_id") ? `?${url.searchParams.get("item_id")}` : ""}`);
    if (url.pathname === "/api/douyin/v1/video/video_list/")
      return ok({
        list: [
          { item_id: "@a", share_url: "https://www.iesdouyin.com/share/video/a/", create_time: 1762400000, statistics: { comment_count: 2 } },
          { item_id: "@b", share_url: "https://www.iesdouyin.com/share/video/b/", create_time: 1762300000, statistics: { comment_count: 0 } },
        ],
        cursor: 0,
        has_more: false,
      });
    if (url.pathname === "/item/comment/list/")
      return ok({
        list: [
          { comment_id: "c2", comment_user_id: "u-x", content: "第二条", create_time: 1794000000, digg_count: 1, nick_name: "小明" },
          { comment_id: "c1", comment_user_id: "u-y", content: "old", create_time: 1793000000 },
        ],
        cursor: 2,
        has_more: true,
      });
    if (url.pathname === "/item/comment/reply/") return ok({ comment_id: "c9" });
    return undefined;
  };

  it("maps comments on recent videos, skips videos without new comments, and stops at `since`", async () => {
    const calls: string[] = [];
    const { c } = setup(routes(calls));
    const items = await c.fetchActivity(acct(), new Date("2026-11-06T12:00:00.000Z"));
    expect(items).toEqual([
      {
        network: "douyin",
        kind: "comment",
        externalId: "@a:c2",
        authorHandle: "u-x",
        authorName: "小明",
        text: "第二条",
        url: "https://www.iesdouyin.com/share/video/a/",
        parentExternalId: "@a",
        occurredAt: new Date(1794000000 * 1000).toISOString(),
        raw: expect.objectContaining({ comment_id: "c2", item_id: "@a" }),
      },
    ]);
    expect(calls).toEqual(["/api/douyin/v1/video/video_list/", "/item/comment/list/?@a"]);
    // Same comment count on the next poll: no comment calls.
    await c.fetchActivity(acct(), null);
    expect(calls.slice(2)).toEqual(["/api/douyin/v1/video/video_list/"]);
  });

  it("replies to a comment, or comments on a video", async () => {
    const { c, jsonOf } = setup(routes([]));
    const r = await c.reply(acct(), { parentExternalId: "@a:c2", text: "谢谢支持", idempotencyKey: "r1" });
    expect(r.externalId).toBe("@a:c9");
    expect(jsonOf("/item/comment/reply/")).toEqual({ item_id: "@a", content: "谢谢支持", comment_id: "c2" });
    await c.reply(acct(), { parentExternalId: "@a", text: "置顶说明", idempotencyKey: "r2" });
    expect(jsonOf("/item/comment/reply/", 1)).toEqual({ item_id: "@a", content: "置顶说明" });
    expect(c.capabilities()).toMatchObject({ reply: true, moderate: false, video: true });
  });
});

describe("douyin metrics", () => {
  it("maps video_data statistics and fans_data", async () => {
    const { c, jsonOf } = setup((url) => {
      if (url.pathname === "/api/douyin/v1/video/video_data/") return ok({ list: [{ item_id: "@a", statistics: { play_count: 1000, digg_count: 50, comment_count: 7, share_count: 3, forward_count: 2, download_count: 1 } }] });
      if (url.pathname === "/api/douyin/v1/user/fans_data/") return ok({ fans_data: { all_fans_num: 8800 } });
      return undefined;
    });
    const m = await c.fetchMetrics(acct(), ["@a"]);
    expect(jsonOf("/api/douyin/v1/video/video_data/")).toEqual({ item_ids: ["@a"] });
    expect(m.map((x) => [x.metric, x.value])).toEqual([
      ["video_views", 1000],
      ["likes", 50],
      ["replies", 7],
      ["shares", 3],
      ["reposts", 2],
      ["engagements", 62],
    ]);
    expect(m.every((x) => x.entityType === "post_variant" && x.entityId === "@a" && x.source === "douyin")).toBe(true);
    expect(await c.fetchAccountMetrics(acct())).toEqual([{ entityType: "social_account", entityId: "acc-dy", metric: "followers_total", value: 8800, observedAt: NOW.toISOString(), source: "douyin" }]);
  });

  it("returns no follower count when fans_data is not granted", async () => {
    const { c } = setup(() => fail(2190004, "应用未获得该能力"));
    expect(await c.fetchAccountMetrics(acct())).toEqual([]);
  });
});

describe("douyin errors", () => {
  it("maps envelope codes", () => {
    const body = (code: number, description = "x") => ({ data: { error_code: code, description }, extra: { error_code: code, logid: "LOG" } });
    const e = (code: number, status = 200, description = "x") => mapDouyinError(status, body(code, description), "op");
    expect([e(2190008).kind, e(2190008).retryable]).toEqual(["auth", false]);
    expect(e(2190008).message).toContain("logid LOG");
    expect(e(28001008).kind).toBe("auth");
    expect(e(2190002).kind).toBe("auth");
    expect(e(10020).message).toContain("log in to Douyin again");
    expect(e(2190004).kind).toBe("rejected");
    expect(e(2190004).message).toContain("scope");
    expect([e(2100004).kind, e(2100004).retryable]).toEqual(["network", true]);
    expect([mapDouyinError(429, undefined, "op").kind, mapDouyinError(429, undefined, "op").retryable]).toEqual(["rate_limit", true]);
    expect(e(2199999, 200, "请求过于频繁").kind).toBe("rate_limit");
    expect(e(2199998, 200, "内容违规").kind).toBe("rejected");
    expect(mapDouyinError(503, "<html/>", "op").kind).toBe("network");
    expect(douyinEnvelopeError({ data: { error_code: 0 }, extra: { error_code: 0 } })).toBeNull();
    expect(douyinEnvelopeError({ err_no: 28001008, err_msg: "access_token过期", log_id: "x" })).toEqual({ code: 28001008, description: "access_token过期" });
  });

  it("throws on an error envelope with HTTP 200, so core refreshes on token expiry", async () => {
    const { c } = setup(() => fail(2190008, "access_token过期,请刷新或重新授权"));
    const err = await rejection(c.fetchMetrics(acct(), ["@a"]));
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain(TOKEN);
  });
});
