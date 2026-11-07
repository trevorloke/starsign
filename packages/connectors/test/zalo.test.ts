import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { ZaloConnector, createZaloConnectors, mapZaloError, zaloArticleHtml, zaloEventToActivity, zaloSignature, zaloSignatureValid, type ZaloEvent } from "../src/zalo.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const API = "https://openapi.zalo.me";
const TOKEN_URL = "https://oauth.zaloapp.com/v4/oa/access_token";
const APP_ID = "1234567890123456789";
const APP_SECRET = ["app", "secret", "example"].join("-");
const OA_KEY = ["oa", "secret", "key", "example"].join("-");
const ACCESS = ["zalo", "access", "example"].join("_");
const OA = "987654321098765432";
const USER = "5555666677778888999";
const auth = { accessToken: ACCESS, refreshToken: "zalo_refresh_example", expiresAt: "2026-11-07T13:00:00.000Z" };
const acct: AccountRef = { id: "acc-z", workspaceId: "w", network: "zalo", externalId: OA, handle: "Cà phê Acme", auth, config: { oaId: OA, name: "Cà phê Acme", broadcast: false } };
const ok = (data: unknown) => new Response(JSON.stringify({ error: 0, message: "Success", data }), { status: 200, headers: { "content-type": "application/json" } });
const zerr = (error: number, message: string) => new Response(JSON.stringify({ error, message }), { status: 200, headers: { "content-type": "application/json" } });

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: Map<string, Handler>;
const on = (url: string, h: Handler | unknown) => routes.set(url, typeof h === "function" ? (h as Handler) : h instanceof Response ? () => h.clone() : () => ok(h));
const calls = (url: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).split("?")[0] === url).map(([u, init]) => ({ url: String(u), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined }));
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
    const h = routes.get(String(u).split("?")[0]!);
    if (!h) throw new Error(`unexpected ${init?.method ?? "GET"} ${String(u)}`);
    return h(init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = (opts: ConstructorParameters<typeof ZaloConnector>[0] = {}) => new ZaloConnector({ appId: APP_ID, appSecret: APP_SECRET, oaSecretKey: OA_KEY, now: () => NOW, sleep: async () => {}, ...opts });

describe("zalo connect", () => {
  it("builds the OA permission URL with app_id and PKCE; configured only with id and secret", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "st", codeChallenge: "chal", redirectUri: "https://starsign.example/oauth/zalo/callback" }));
    expect(url.origin + url.pathname).toBe("https://oauth.zaloapp.com/v4/oa/permission");
    expect(url.searchParams.get("app_id")).toBe(APP_ID);
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(createZaloConnectors({ ZALO_APP_ID: "1" })[0]!.connectConfigured).toBe(false);
    expect(createZaloConnectors({ ZALO_APP_ID: "1", ZALO_APP_SECRET: "s" })[0]!.connectConfigured).toBe(true);
  });

  it("keeps the broadcast answer from the connect form", async () => {
    const c = connector();
    expect((await c.oauthPrepare({ inputs: { broadcast: "Yes" }, redirectUri: "r", state: "s", codeChallenge: "c" })).config).toEqual({ broadcast: true });
    expect((await c.oauthPrepare({ inputs: { broadcast: "no" }, redirectUri: "r", state: "s", codeChallenge: "c" })).config).toEqual({ broadcast: false });
    expect((await rejection(c.oauthPrepare({ inputs: { broadcast: "maybe" }, redirectUri: "r", state: "s", codeChallenge: "c" }))).kind).toBe("rejected");
  });

  it("exchanges the code with the secret_key header and code_verifier, and returns the OA", async () => {
    on(TOKEN_URL, () => new Response(JSON.stringify({ access_token: ACCESS, refresh_token: "zalo_refresh_example", expires_in: "90000" }), { status: 200 }));
    on(`${API}/v2.0/oa/getoa`, { oa_id: OA, name: "Cà phê Acme", avatar: "https://s.example/a.jpg", is_verified: true, num_follower: 4321 });
    const accounts = await connector().oauthConnect({ code: "code1", codeVerifier: "ver1", redirectUri: "https://starsign.example/oauth/zalo/callback", config: { broadcast: true }, callbackParams: { code: "code1", oa_id: OA, state: "st" } });
    expect(accounts).toEqual([
      { network: "zalo", identity: { externalId: OA, handle: "Cà phê Acme", displayName: "Cà phê Acme" }, auth: { accessToken: ACCESS, refreshToken: "zalo_refresh_example", expiresAt: "2026-11-07T13:00:00.000Z" }, config: { oaId: OA, name: "Cà phê Acme", avatar: "https://s.example/a.jpg", verified: true, broadcast: true } },
    ]);
    const tok = calls(TOKEN_URL)[0]!;
    expect(tok.headers.secret_key).toBe(APP_SECRET);
    const form = Object.fromEntries(new URLSearchParams(tok.body));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "code1", code_verifier: "ver1", app_id: APP_ID });
    expect(form.client_secret).toBeUndefined();
    expect(calls(`${API}/v2.0/oa/getoa`)[0]!.headers.access_token).toBe(ACCESS);
  });

  it("refuses a token for a different OA than the callback named", async () => {
    on(TOKEN_URL, () => new Response(JSON.stringify({ access_token: ACCESS, expires_in: 90000 }), { status: 200 }));
    on(`${API}/v2.0/oa/getoa`, { oa_id: "111" });
    expect((await rejection(connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "r", callbackParams: { oa_id: OA } }))).kind).toBe("auth");
  });

  it("rotates the refresh token once even when asked twice", async () => {
    on(TOKEN_URL, () => new Response(JSON.stringify({ access_token: "new_access", refresh_token: "new_refresh", expires_in: 90000 }), { status: 200 }));
    const c = connector();
    const [a, b] = await Promise.all([c.refreshAuth(acct), c.refreshAuth(acct)]);
    expect(a!.auth).toMatchObject({ accessToken: "new_access", refreshToken: "new_refresh" });
    expect(b!.auth).toEqual(a!.auth);
    expect(calls(TOKEN_URL)).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(calls(TOKEN_URL)[0]!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "zalo_refresh_example", app_id: APP_ID });
  });
});

describe("zalo webhook", () => {
  const event = (over: Partial<ZaloEvent> = {}): ZaloEvent => ({ app_id: APP_ID, user_id_by_app: "4444", event_name: "user_send_text", timestamp: "1793966400000", sender: { id: USER }, recipient: { id: OA }, message: { msg_id: "msg1", text: "Quán mở cửa mấy giờ?" }, ...over });
  const sign = (raw: string, ts: string, key = OA_KEY) => `mac=${createHash("sha256").update(APP_ID + raw + ts + key).digest("hex")}`;

  it("verifies X-ZEvent-Signature = sha256(app_id + body + timestamp + OA secret key)", () => {
    const raw = JSON.stringify(event());
    const c = connector();
    expect(zaloSignature(APP_ID, raw, "1793966400000", OA_KEY)).toBe(sign(raw, "1793966400000").slice(4));
    expect(c.webhook.verify({ "X-ZEvent-Signature": sign(raw, "1793966400000") }, raw)).toBe(true);
    expect(c.webhook.verify({ "x-zevent-signature": sign(raw, "1793966400000").slice(4) }, raw)).toBe(true);
    expect(c.webhook.verify({ "x-zevent-signature": sign(raw, "1793966400000", "other-key") }, raw)).toBe(false);
    expect(c.webhook.verify({ "x-zevent-signature": sign(raw, "1793966400000") }, raw.replace("giờ", "gio"))).toBe(false);
    expect(c.webhook.verify({}, raw)).toBe(false);
    // Another app's delivery never verifies, even with a matching hash.
    const foreign = JSON.stringify(event({ app_id: "999" }));
    expect(zaloSignatureValid(APP_ID, OA_KEY, foreign, sign(foreign, "1793966400000"))).toBe(false);
    expect(connector({ oaSecretKey: undefined }).webhook.verify({ "x-zevent-signature": sign(raw, "1793966400000") }, raw)).toBe(false);
  });

  it("maps messages to dm and follows to follow, per OA", () => {
    const c = connector();
    const batches = c.webhook.parse(event());
    expect(batches).toEqual([
      { network: "zalo", accountExternalId: OA, items: [{ network: "zalo", kind: "dm", externalId: `${USER}:msg1`, authorHandle: USER, authorName: null, text: "Quán mở cửa mấy giờ?", url: null, parentExternalId: null, occurredAt: "2026-11-06T12:00:00.000Z", raw: event(), conversation: { id: USER, name: null, type: "direct" } }] },
    ]);
    const img = zaloEventToActivity(event({ event_name: "user_send_image", message: { msg_id: "m2", attachments: [{ type: "image", payload: { url: "https://z.example/i.jpg" } }] } }));
    expect(img!.item.text).toBe("[Image]");
    expect(zaloEventToActivity(event({ event_name: "user_send_location", message: { msg_id: "m3", attachments: [{ type: "location", payload: { coordinates: { latitude: "10.77", longitude: "106.70" } } }] } }))!.item.text).toBe("[Location: 10.77, 106.70]");
    expect(zaloEventToActivity(event({ event_name: "user_send_link", message: { msg_id: "m4", attachments: [{ type: "link", payload: { url: "https://acme.example" } }] } }))!.item.text).toBe("[Link: https://acme.example]");
    expect(zaloEventToActivity(event({ event_name: "user_send_sticker", message: { msg_id: "m5", attachments: [{ type: "sticker", payload: { id: "s" } }] } }))!.item.text).toBe("[Sticker]");
    expect(zaloEventToActivity(event({ event_name: "user_send_file", message: { msg_id: "m6", attachments: [{ type: "file", payload: { name: "menu.pdf" } }] } }))!.item.text).toBe("[File: menu.pdf]");
    const follow = c.webhook.parse({ app_id: APP_ID, oa_id: OA, event_name: "follow", follower: { id: USER }, user_id_by_app: "4444", source: "oa_profile", timestamp: "1793966400000" });
    expect(follow[0]!.items[0]).toMatchObject({ kind: "follow", externalId: `${USER}:follow:1793966400000`, authorHandle: USER });
    expect(c.webhook.parse(event({ event_name: "oa_send_text" }))).toEqual([]);
    expect(c.webhook.parse(event({ event_name: "user_seen_message" }))).toEqual([]);
  });
});

describe("zalo publish", () => {
  const input: PublishInput = { variantId: "v1", text: "Menu mới tuần này.\n\nGhé quán nhé <3", media: [{ kind: "image", url: "https://media.example/cover.jpg" }, { kind: "image", url: "https://media.example/2.jpg", alt: "Bánh mì" }], thread: [], idempotencyKey: "k1", options: { title: "Menu mới", link: "https://acme.example/menu" } };

  it("creates an article, waits for its id, and does not broadcast unless set", async () => {
    let verifies = 0;
    on(`${API}/v2.0/article/create`, { token: "art-token" });
    on(`${API}/v2.0/article/verify`, () => (++verifies < 3 ? zerr(-201, "Article is processing") : ok({ id: "a1b2" })));
    const c = connector();
    const r = await c.publish(acct, input);
    expect(r).toMatchObject({ externalId: "article:a1b2", url: null });
    const body = JSON.parse(calls(`${API}/v2.0/article/create`)[0]!.body!);
    expect(body).toMatchObject({ type: "normal", title: "Menu mới", author: "Cà phê Acme", cover: { cover_type: "photo", photo_url: "https://media.example/cover.jpg", status: "show" }, status: "show", comment: "show" });
    expect(body.body).toEqual([
      { type: "text", content: '<p>Menu mới tuần này.</p><p>Ghé quán nhé &lt;3</p><p><a href="https://acme.example/menu">https://acme.example/menu</a></p>' },
      { type: "image", url: "https://media.example/2.jpg", caption: "Bánh mì" },
    ]);
    expect(JSON.parse(calls(`${API}/v2.0/article/verify`)[0]!.body!)).toEqual({ token: "art-token" });
    expect(calls(`${API}/v2.0/oa/message`)).toHaveLength(0);
  });

  it("resumes verifying the same token on retry instead of creating a second article", async () => {
    on(`${API}/v2.0/article/create`, { token: "tok-2" });
    on(`${API}/v2.0/article/verify`, zerr(-201, "processing"));
    const c = connector({ verifyAttempts: 2 });
    const e = await rejection(c.publish(acct, { ...input, idempotencyKey: "k2" }));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    on(`${API}/v2.0/article/verify`, { id: "done" });
    expect((await c.publish(acct, { ...input, idempotencyKey: "k2" })).externalId).toBe("article:done");
    expect(calls(`${API}/v2.0/article/create`)).toHaveLength(1);
  });

  it("broadcasts the article when the account is set to, and keeps a failed broadcast out of the result", async () => {
    on(`${API}/v2.0/article/create`, { token: "t3" });
    on(`${API}/v2.0/article/verify`, { id: "a3" });
    on(`${API}/v2.0/oa/message`, { message_id: "bm1" });
    const bc = { ...acct, config: { ...acct.config, broadcast: true } };
    const r = await connector().publish(bc, { ...input, idempotencyKey: "k3" });
    expect((r.raw as { broadcast: unknown }).broadcast).toEqual({ message_id: "bm1" });
    expect(JSON.parse(calls(`${API}/v2.0/oa/message`)[0]!.body!).message.attachment.payload.elements).toEqual([{ media_type: "article", attachment_id: "a3" }]);
    on(`${API}/v2.0/oa/message`, zerr(-32, "Exceed broadcast quota"));
    const r2 = await connector().publish(bc, { ...input, idempotencyKey: "k4" });
    expect(r2.externalId).toBe("article:a3");
    expect((r2.raw as { broadcast: { error: string } }).broadcast.error).toContain("quota");
  });

  it("requires a title, a cover and body text", () => {
    const issues = connector().validate(acct, { ...input, text: "", media: [{ kind: "video", url: "https://m.example/v.mp4" }], options: {} });
    expect(issues.map((i) => i.code)).toEqual(["empty", "empty", "media_required", "unsupported_media"]);
    expect(zaloArticleHtml("a\nb")).toBe("<p>a<br>b</p>");
  });
});

describe("zalo reply and metrics", () => {
  it("sends a customer-service message to the person", async () => {
    on(`${API}/v3.0/oa/message/cs`, { message_id: "out1", user_id: USER });
    const r = await connector().reply(acct, { parentExternalId: `${USER}:msg1`, text: "Dạ, 7 giờ sáng ạ", idempotencyKey: "r1" });
    expect(r.externalId).toBe(`${USER}:out1`);
    const call = calls(`${API}/v3.0/oa/message/cs`)[0]!;
    expect(call.headers.access_token).toBe(ACCESS);
    expect(JSON.parse(call.body!)).toEqual({ recipient: { user_id: USER }, message: { text: "Dạ, 7 giờ sáng ạ" } });
  });

  it("explains the closed reply window", async () => {
    on(`${API}/v3.0/oa/message/cs`, zerr(-230, "User has not interacted with the OA in the past 7 days"));
    const e = await rejection(connector().reply(acct, { parentExternalId: USER, text: "hi", idempotencyKey: "r2" }));
    expect(e.kind).toBe("rejected");
    expect(e.message).toContain("window has closed");
  });

  it("reads followers from getoa", async () => {
    on(`${API}/v2.0/oa/getoa`, { oa_id: OA, num_follower: 4321 });
    expect(await connector().fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc-z", metric: "followers_total", value: 4321, observedAt: NOW.toISOString(), source: "zalo" }]);
  });

  it("maps errors", async () => {
    expect(mapZaloError(-216, "Access token is invalid", "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapZaloError(-124, "Access token has expired", "x").kind).toBe("auth");
    expect(mapZaloError(-213, "User has not followed OA", "x").kind).toBe("rejected");
    expect(mapZaloError(-32, "Rate limit", "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapZaloError(-201, "Parameters are invalid", "x").kind).toBe("rejected");
    expect(mapZaloError(undefined, undefined, "x", 502)).toMatchObject({ kind: "network", retryable: true });
    on(`${API}/v2.0/oa/getoa`, zerr(-216, "Access token is invalid"));
    const e = await rejection(connector().fetchAccountMetrics(acct));
    expect(e.kind).toBe("auth");
    expect(e.message).not.toContain(ACCESS);
    await expect(connector().moderate(acct, { externalId: "x", action: "delete" })).rejects.toThrow(/not available/);
    expect(connector().capabilities()).toMatchObject({ webhooks: true, fetchActivity: false, reply: true, moderate: false });
  });
});
