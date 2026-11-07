import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { BandConnector, createBandConnectors, mapBandError, parseBandRef } from "../src/band.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const API = "https://openapi.band.us";
const TOKEN_URL = "https://auth.band.us/oauth2/token";
const ACCESS = ["band", "access", "example"].join("_");
const auth = { accessToken: ACCESS, refreshToken: "band_refresh_example", userKey: "ME" };
const acct: AccountRef = { id: "acc-b", workspaceId: "w", network: "band", externalId: "BANDKEY1", handle: "우리 동네 모임", auth, config: { bandKey: "BANDKEY1", bandName: "우리 동네 모임", userKey: "ME" } };
const ok = (result_data: unknown) => new Response(JSON.stringify({ result_code: 1, result_data }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (result_code: number, message = "error", status = 200) => new Response(JSON.stringify({ result_code, result_data: { message } }), { status, headers: { "content-type": "application/json" } });
const t = (iso: string) => Date.parse(iso);

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: Map<string, Handler>;
const on = (path: string, h: Handler | unknown) => routes.set(path, typeof h === "function" ? (h as Handler) : h instanceof Response ? () => h.clone() : () => ok(h));
function calls(path: string) {
  return fetchMock.mock.calls
    .filter(([u]) => new URL(String(u)).pathname === path || String(u).startsWith(path))
    .map(([u, init]) => {
      const url = new URL(String(u));
      const params = init?.method === "POST" ? new URLSearchParams(String(init.body)) : url.searchParams;
      return { url, method: init?.method, params, headers: (init?.headers ?? {}) as Record<string, string> };
    });
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

beforeEach(() => {
  routes = new Map();
  fetchMock = vi.fn<typeof fetch>(async (u, init) => {
    const url = new URL(String(u));
    const key = url.origin === API ? url.pathname : `${url.origin}${url.pathname}`;
    const h = routes.get(key);
    if (!h) throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    return h(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = () => new BandConnector({ clientId: "band-client", clientSecret: "band-secret", now: () => NOW });

describe("band connect", () => {
  it("builds the authorize URL and is configured only with id and secret", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "st", codeChallenge: "c", redirectUri: "https://starsign.example/oauth/band/callback" }));
    expect(url.origin + url.pathname).toBe("https://auth.band.us/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: "code", client_id: "band-client", redirect_uri: "https://starsign.example/oauth/band/callback", state: "st" });
    expect(createBandConnectors({ BAND_CLIENT_ID: "x" })[0]!.connectConfigured).toBe(false);
    expect(createBandConnectors({ BAND_CLIENT_ID: "x", BAND_CLIENT_SECRET: "y" })[0]!.connectConfigured).toBe(true);
  });

  it("exchanges the code with Basic auth and returns one account per band the person may post in", async () => {
    routes.set(TOKEN_URL, () => new Response(JSON.stringify({ access_token: ACCESS, token_type: "bearer", refresh_token: "band_refresh_example", expires_in: 315359999, user_key: "ME" }), { status: 200 }));
    on("/v2/profile", { user_key: "ME", name: "김민수" });
    on("/v2.1/bands", { bands: [{ band_key: "BANDKEY1", name: "우리 동네 모임", cover: "https://c.example/1.jpg", member_count: 87 }, { band_key: "BANDKEY2", name: "읽기 전용", member_count: 10 }, { band_key: "BANDKEY3", name: "Unknown perms" }] });
    on("/v2/band/permissions", (url: URL) => {
      const k = url.searchParams.get("band_key");
      if (k === "BANDKEY1") return ok({ permissions: ["posting", "commenting", "contents_deletion"] });
      if (k === "BANDKEY2") return ok({ permissions: ["commenting"] });
      return fail(60100, "invalid band");
    });
    const accounts = await connector().oauthConnect({ code: "code1", codeVerifier: "unused", redirectUri: "https://starsign.example/oauth/band/callback" });
    expect(accounts.map((a) => [a.identity.externalId, a.identity.handle, a.config?.memberCount, a.config?.permissions])).toEqual([
      ["BANDKEY1", "우리 동네 모임", 87, ["posting", "commenting", "contents_deletion"]],
      ["BANDKEY3", "Unknown perms", null, null],
    ]);
    expect(accounts[0]!.auth).toEqual({ accessToken: ACCESS, refreshToken: "band_refresh_example", expiresAt: "2036-11-03T11:59:59.000Z", userKey: "ME" });
    expect(accounts[0]!.config).toMatchObject({ userKey: "ME", userName: "김민수" });
    const tok = calls(TOKEN_URL)[0]!;
    expect(tok.method).toBe("GET");
    expect(tok.url.searchParams.get("grant_type")).toBe("authorization_code");
    expect(tok.url.searchParams.get("code")).toBe("code1");
    expect(tok.headers.authorization).toBe(`Basic ${Buffer.from("band-client:band-secret").toString("base64")}`);
    expect(calls("/v2.1/bands")[0]!.params.get("access_token")).toBe(ACCESS);
  });

  it("refreshes with the refresh token", async () => {
    routes.set(TOKEN_URL, () => new Response(JSON.stringify({ access_token: "new_access", expires_in: 3600 }), { status: 200 }));
    const r = await connector().refreshAuth(acct);
    expect(r!.auth).toMatchObject({ accessToken: "new_access", refreshToken: "band_refresh_example", userKey: "ME" });
    expect(calls(TOKEN_URL)[0]!.url.searchParams.get("grant_type")).toBe("refresh_token");
  });
});

describe("band publish", () => {
  const input: PublishInput = { variantId: "v1", text: "이번 주 모임 안내", media: [], thread: [], idempotencyKey: "k1" };

  it("creates a post with the text, links and media URLs, without push by default", async () => {
    on("/v2.2/band/post/create", { band_key: "BANDKEY1", post_key: "POST9" });
    const c = connector();
    const r = await c.publish(acct, { ...input, media: [{ kind: "image", url: "https://media.example/p.jpg" }], options: { link: "https://acme.example/meet" } });
    expect(r.externalId).toBe("BANDKEY1:POST9");
    const p = calls("/v2.2/band/post/create")[0]!;
    expect(p.method).toBe("POST");
    expect(Object.fromEntries(p.params)).toEqual({ band_key: "BANDKEY1", content: "이번 주 모임 안내\nhttps://acme.example/meet\nhttps://media.example/p.jpg", do_push: "false", access_token: ACCESS });
    await c.publish(acct, input); // same idempotency key
    expect(calls("/v2.2/band/post/create")).toHaveLength(1);
  });

  it("pushes when the account is set to, and validates", async () => {
    on("/v2.2/band/post/create", { post_key: "P2" });
    await connector().publish({ ...acct, config: { ...acct.config, doPush: true } }, { ...input, idempotencyKey: "k2" });
    expect(calls("/v2.2/band/post/create")[0]!.params.get("do_push")).toBe("true");
    expect(connector().validate(acct, { ...input, text: " ", thread: ["x"] }).map((i) => i.code)).toEqual(["empty", "thread_unsupported"]);
  });
});

describe("band inbox", () => {
  it("maps members' posts to messages and comments to comments, skipping own and old items", async () => {
    on("/v2/band/posts", {
      paging: { next_params: null },
      items: [
        { post_key: "P1", content: "내일 몇 시에 만나요?", author: { name: "이영희", user_key: "U1" }, created_at: t("2026-11-06T10:00:00Z"), comment_count: 2, emotion_count: 1, photos: [{ url: "x" }] },
        { post_key: "P2", content: "공지", author: { name: "김민수", user_key: "ME" }, created_at: t("2026-11-06T09:00:00Z"), comment_count: 1 },
        { post_key: "P0", content: "old", author: { name: "A", user_key: "U9" }, created_at: t("2026-10-01T00:00:00Z"), comment_count: 0 },
      ],
    });
    on("/v2/band/post/comments", (url: URL) =>
      url.searchParams.get("post_key") === "P1"
        ? ok({ items: [{ comment_key: "C1", content: "7시요", author: { name: "박철수", user_key: "U2" }, created_at: t("2026-11-06T10:05:00Z") }, { comment_key: "C2", content: "네", author: { name: "김민수", user_key: "ME" }, created_at: t("2026-11-06T10:06:00Z") }] })
        : ok({ items: [{ comment_key: "C3", content: "좋아요", author: { name: "최", user_key: "U3" }, created_at: t("2026-11-06T09:30:00Z") }] }),
    );
    const items = await connector().fetchActivity(acct, new Date("2026-11-05T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.authorName, i.parentExternalId, i.text])).toEqual([
      ["comment", "BANDKEY1:P2:C3", "최", "BANDKEY1:P2", "좋아요"],
      ["message", "BANDKEY1:P1", "이영희", null, "내일 몇 시에 만나요? [1 photo]"],
      ["comment", "BANDKEY1:P1:C1", "박철수", "BANDKEY1:P1", "7시요"],
    ]);
    expect(items[1]!.conversation).toEqual({ id: "BANDKEY1", name: "우리 동네 모임", type: "group" });
    expect(calls("/v2/band/posts")[0]!.params.get("band_key")).toBe("BANDKEY1");
    expect(calls("/v2/band/post/comments")).toHaveLength(2);
  });

  it("comments on the post when replying to a post or a comment", async () => {
    on("/v2/band/post/comment/create", { comment_key: "C7" });
    const c = connector();
    expect((await c.reply(acct, { parentExternalId: "BANDKEY1:P1:C1", text: "7시에 봬요", idempotencyKey: "r1" })).externalId).toBe("BANDKEY1:P1:C7");
    expect(Object.fromEntries(calls("/v2/band/post/comment/create")[0]!.params)).toMatchObject({ band_key: "BANDKEY1", post_key: "P1", body: "7시에 봬요" });
    expect((await rejection(c.reply(acct, { parentExternalId: "bad", text: "x", idempotencyKey: "r2" }))).kind).toBe("rejected");
  });

  it("removes own posts and comments; other actions are refused", async () => {
    on("/v2/band/post/remove", {});
    on("/v2/band/post/comment/remove", {});
    const c = connector();
    await c.moderate(acct, { externalId: "BANDKEY1:P1", action: "delete" });
    await c.moderate(acct, { externalId: "BANDKEY1:P1:C7", action: "delete" });
    expect(Object.fromEntries(calls("/v2/band/post/remove")[0]!.params)).toMatchObject({ band_key: "BANDKEY1", post_key: "P1" });
    expect(Object.fromEntries(calls("/v2/band/post/comment/remove")[0]!.params)).toMatchObject({ comment_key: "C7" });
    expect((await rejection(c.moderate(acct, { externalId: "BANDKEY1:P1", action: "hide" }))).kind).toBe("rejected");
    expect(parseBandRef("A:B:C")).toEqual({ bandKey: "A", postKey: "B", commentKey: "C" });
  });
});

describe("band metrics", () => {
  it("maps emotion and comment counts per post, and members per band", async () => {
    on("/v2.1/band/post", { post: { post_key: "P9", comment_count: 4, emotion_count: 6 } });
    on("/v2.1/bands", { bands: [{ band_key: "BANDKEY1", member_count: 88 }] });
    const c = connector();
    const rows = await c.fetchMetrics(acct, ["BANDKEY1:P9", "garbage"]);
    expect(rows.map((r) => [r.entityId, r.metric, r.value])).toEqual([["BANDKEY1:P9", "likes", 6], ["BANDKEY1:P9", "replies", 4], ["BANDKEY1:P9", "engagements", 10]]);
    expect(await c.fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc-b", metric: "followers_total", value: 88, observedAt: NOW.toISOString(), source: "band" }]);
  });
});

describe("band errors", () => {
  it("maps result codes, including errors returned with HTTP 200", async () => {
    expect(mapBandError(10401, "unauthorized", "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapBandError(1001, "quota", "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapBandError(1003, "cool down", "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapBandError(2142, "leaders only", "x").kind).toBe("rejected");
    expect(mapBandError(60101, "not member", "x").kind).toBe("rejected");
    expect(mapBandError(undefined, undefined, "x", 503)).toMatchObject({ kind: "network", retryable: true });
    on("/v2.2/band/post/create", fail(10401, "invalid access token"));
    const e = await rejection(connector().publish(acct, { variantId: "v", text: "hi", media: [], thread: [], idempotencyKey: "e1" }));
    expect(e.kind).toBe("auth");
    expect(e.message).toContain("10401");
    on("/v2.1/band/post", () => new Response("oops", { status: 500 }));
    expect((await rejection(connector().fetchMetrics(acct, ["BANDKEY1:P1"]))).kind).toBe("network");
    fetchMock.mockRejectedValueOnce(new TypeError(`connect failed for ${ACCESS}`));
    const net = await rejection(connector().fetchAccountMetrics(acct));
    expect(net.kind).toBe("network");
    expect(net.message).not.toContain(ACCESS);
  });
});
