import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { ViberConnector, createViberConnectors, mapViberError, viberCallbackToActivity, viberMessageText, viberParse, viberSignatureValid } from "../src/viber.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const API = "https://chatapi.viber.com/pa";
// Token-shaped values are assembled at runtime.
const TOKEN_A = ["4f0a1b2c3d4e5f60", "7a8b9c0d1e2f3a4b", "example0000000a"].join("-");
const TOKEN_B = ["5e1b2c3d4e5f6071", "8b9c0d1e2f3a4b5c", "example0000000b"].join("-");
const CHANNEL_ID = "pa:5000000000000000001";
const BOT_ID = "pa:5000000000000000002";
const ADMIN = "01234567890A=";
const USER = "UserAbCdEfGh123=";

const channel: AccountRef = { id: "acc-ch", workspaceId: "w", network: "viber", externalId: CHANNEL_ID, handle: "acmenews", auth: { authToken: TOKEN_A }, config: { kind: "channel", accountId: CHANNEL_ID, name: "Acme News", from: ADMIN } };
const bot: AccountRef = { id: "acc-bot", workspaceId: "w", network: "viber", externalId: BOT_ID, handle: "acmebot", auth: { authToken: TOKEN_B }, config: { kind: "bot", accountId: BOT_ID, name: "Acme Support Bot With A Long Name" } };
const okBody = (extra: Record<string, unknown> = {}) => ({ status: 0, status_message: "ok", ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (body: Record<string, unknown>, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: Map<string, Handler>;
const on = (path: string, h: Handler | Record<string, unknown>) => routes.set(path, typeof h === "function" ? h : () => json(okBody(h)));
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u) === `${API}${path}`).map(([, init]) => ({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
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
    const path = String(u).slice(API.length);
    const h = routes.get(path);
    if (!h) throw new Error(`unexpected ${String(u)}`);
    return h(JSON.parse(String(init?.body ?? "{}")), init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = (opts: ConstructorParameters<typeof ViberConnector>[0] = {}) => new ViberConnector({ now: () => NOW, publicUrl: "https://app.example/", ...opts });
const channelInfo = { id: CHANNEL_ID, name: "Acme News", uri: "acmenews", subscribers_count: 15000, members: [{ id: "adm2", name: "Helper", role: "admin" }, { id: ADMIN, name: "Owner", role: "superadmin" }] };

describe("viber connect", () => {
  it("connects a channel as its superadmin; the first webhook check may fail and is retried later", async () => {
    on("/get_account_info", channelInfo);
    on("/set_webhook", () => json({ status: 1, status_message: "Result[HttpRequest failed]" }));
    const c = connector();
    const accounts = await c.connectWithInputs({ network: "viber", inputs: { authToken: ` ${TOKEN_A} `, kind: "" } });
    expect(accounts).toEqual([
      {
        network: "viber",
        identity: { externalId: CHANNEL_ID, handle: "acmenews", displayName: "Acme News" },
        auth: { authToken: TOKEN_A },
        config: { kind: "channel", accountId: CHANNEL_ID, name: "Acme News", uri: "acmenews", from: ADMIN, subscribersCount: 15000, webhookUrl: `https://app.example/webhooks/viber?account=${encodeURIComponent(CHANNEL_ID)}`, webhookSet: false },
      },
    ]);
    expect(calls("/get_account_info")[0]!.headers["x-viber-auth-token"]).toBe(TOKEN_A);
    expect(calls("/set_webhook")[0]!.body).toEqual({ url: `https://app.example/webhooks/viber?account=${encodeURIComponent(CHANNEL_ID)}`, send_name: true, send_photo: false });
    expect(c.credentialInputs.map((i) => [i.key, "secret" in i ? i.secret : false, "optional" in i ? i.optional : false])).toEqual([["authToken", true, false], ["kind", false, true]]);
  });

  it("connects a bot and sets its webhook with the bot events", async () => {
    on("/get_account_info", { id: BOT_ID, name: "Acme Bot", uri: "acmebot", subscribers_count: 321, members: [{ id: "m", role: "admin" }] });
    on("/set_webhook", { event_types: ["subscribed"] });
    const accounts = await connector().connectWithInputs({ network: "viber", inputs: { authToken: TOKEN_B, kind: "Bot" } });
    expect(accounts[0]!.config).toMatchObject({ kind: "bot", from: null, webhookSet: true, subscribersCount: 321 });
    expect(calls("/set_webhook")[0]!.body.event_types).toContain("subscribed");
  });

  it("refuses a channel token without a superadmin, a bad type, and a bad token", async () => {
    on("/get_account_info", { id: CHANNEL_ID, members: [{ id: "x", role: "admin" }] });
    expect((await rejection(connector().connectWithInputs({ network: "viber", inputs: { authToken: TOKEN_A } }))).message).toContain("superadmin");
    expect((await rejection(connector().connectWithInputs({ network: "viber", inputs: { authToken: TOKEN_A, kind: "group" } }))).kind).toBe("rejected");
    on("/get_account_info", () => json({ status: 2, status_message: "invalidAuthToken" }));
    expect((await rejection(connector().connectWithInputs({ network: "viber", inputs: { authToken: TOKEN_A } }))).kind).toBe("auth");
    expect((await rejection(connector().connectWithInputs({ network: "viber", inputs: { authToken: "short" } }))).kind).toBe("auth");
  });

  it("sets the webhook on the first poll, once per process", async () => {
    on("/set_webhook", {});
    const c = connector();
    expect(await c.fetchActivity(bot)).toEqual([]);
    expect(await c.fetchActivity(bot)).toEqual([]);
    expect(calls("/set_webhook")).toHaveLength(1);
    expect(createViberConnectors({})[0]!.connectConfigured).toBe(true);
  });
});

describe("viber webhook", () => {
  const sign = (raw: string, token: string) => createHmac("sha256", token).update(raw).digest("hex");
  const message = `{"event":"message","timestamp":1793966400000,"chat_hostname":"SN-1","message_token":4912661846655238145,"sender":{"id":"${USER}","name":"Olena","language":"uk","country":"UA","api_version":10},"message":{"type":"text","text":"Коли відкриваєтесь?"},"silent":false}`;

  it("routes by the account query, verifies with that account's token, and keeps 64-bit message tokens", () => {
    const c = connector();
    const h = c.webhook;
    const q = { account: BOT_ID };
    expect(h.route!(message, q, {})).toEqual({ network: "viber", accountExternalId: BOT_ID });
    expect(h.route!(message, {}, {})).toBeNull();
    expect(h.verifyAccount!(bot, { "X-Viber-Content-Signature": sign(message, TOKEN_B) }, message, q)).toBe(true);
    expect(h.verifyAccount!(bot, { "x-viber-content-signature": sign(message, TOKEN_A) }, message, q)).toBe(false); // another account's token
    expect(h.verifyAccount!(bot, { "x-viber-content-signature": sign(message, TOKEN_B) }, message.replace("Olena", "Oleh"), q)).toBe(false);
    expect(h.verifyAccount!(bot, {}, message, q)).toBe(false);
    expect(h.verify({}, message)).toBe(false);
    const batches = h.parse(h.decodeAccount!(bot, message, q));
    expect(batches).toEqual([
      {
        network: "viber",
        accountExternalId: BOT_ID,
        items: [{ network: "viber", kind: "dm", externalId: `${USER}:4912661846655238145`, authorHandle: USER, authorName: "Olena", text: "Коли відкриваєтесь?", url: null, parentExternalId: null, occurredAt: "2026-11-06T12:00:00.000Z", raw: expect.anything(), conversation: { id: USER, name: "Olena", type: "direct" } }],
      },
    ]);
    expect(viberSignatureValid(TOKEN_B, message, sign(message, TOKEN_B).toUpperCase())).toBe(true);
  });

  it("maps subscriptions to follow and ignores the rest", () => {
    const sub = viberCallbackToActivity({ event: "subscribed", timestamp: 1793966400000, user: { id: USER, name: "Olena" }, message_token: "77" });
    expect(sub).toMatchObject({ kind: "follow", externalId: `${USER}:subscribed:77`, authorHandle: USER });
    for (const event of ["conversation_started", "delivered", "seen", "failed", "unsubscribed", "webhook"]) expect(viberCallbackToActivity({ event, timestamp: 1, user: { id: USER } })).toBeNull();
    expect(connector().webhook.parse({ account: BOT_ID, payload: viberParse('{"event":"webhook","timestamp":1,"message_token":1}') })).toEqual([]);
  });

  it("summarises non-text messages without phone numbers", () => {
    expect(viberMessageText({ type: "picture", media: "https://x", text: "look" })).toBe("[Picture] look");
    expect(viberMessageText({ type: "video", duration: 12 })).toBe("[Video 12s]");
    expect(viberMessageText({ type: "file", file_name: "price.pdf" })).toBe("[File: price.pdf]");
    expect(viberMessageText({ type: "location", location: { lat: 50.45, lon: 30.52 } })).toBe("[Location: 50.45, 30.52]");
    expect(viberMessageText({ type: "contact", contact: { name: "Ivan", phone_number: "+380000000000" } })).toBe("[Contact: Ivan]");
    expect(viberMessageText({ type: "sticker", sticker_id: 46105 })).toBe("[Sticker]");
    expect(viberMessageText({ type: "url", media: "https://acme.example" })).toBe("[Link: https://acme.example]");
  });
});

describe("viber channel publish", () => {
  const input: PublishInput = { variantId: "v1", text: "Нова колекція вже тут", media: [], thread: [], idempotencyKey: "k1" };

  it("posts text with the link as the superadmin", async () => {
    on("/post", () => new Response('{"status":0,"status_message":"ok","message_token":5741311803571721087,"chat_hostname":"SN-CHAT"}', { status: 200 }));
    const c = connector();
    const r = await c.publish(channel, { ...input, options: { link: "https://acme.example/new" } });
    expect(r.externalId).toBe(`${CHANNEL_ID}:5741311803571721087`);
    expect(calls("/post")[0]!.body).toEqual({ from: ADMIN, type: "text", text: "Нова колекція вже тут\n\nhttps://acme.example/new" });
    await c.publish(channel, { ...input, options: { link: "https://acme.example/new" } });
    expect(calls("/post")).toHaveLength(1);
  });

  it("sends a bare link as a URL message and a picture with its caption", async () => {
    let n = 0;
    on("/post", () => json(okBody({ message_token: ++n })));
    await connector().publish(channel, { ...input, text: "", idempotencyKey: "k2", options: { link: "https://acme.example/" } });
    await connector().publish(channel, { ...input, idempotencyKey: "k3", media: [{ kind: "image", url: "https://media.example/p.jpg" }], options: { thumbnailUrl: "https://media.example/t.jpg" } });
    expect(calls("/post").map((c) => c.body)).toEqual([
      { from: ADMIN, type: "url", media: "https://acme.example/" },
      { from: ADMIN, type: "picture", media: "https://media.example/p.jpg", text: "Нова колекція вже тут", thumbnail: "https://media.example/t.jpg" },
    ]);
  });

  it("sends a long text before the picture, and a text before a video with its size", async () => {
    let n = 0;
    on("/post", () => json(okBody({ message_token: ++n })));
    const long = "a".repeat(800);
    const r = await connector().publish(channel, { ...input, text: long, idempotencyKey: "k4", media: [{ kind: "image", url: "https://media.example/p.jpg" }] });
    expect(r).toMatchObject({ externalId: `${CHANNEL_ID}:1`, threadExternalIds: [`${CHANNEL_ID}:2`] });
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array(), mime: "video/mp4" }), size: async () => 12_345_678 };
    await c.publish(channel, { ...input, idempotencyKey: "k5", media: [{ kind: "video", url: "https://media.example/v.mp4", mime: "video/mp4", durationSeconds: 42.4 }] });
    await c.publish(channel, { ...input, text: "", idempotencyKey: "k6", media: [{ kind: "document", url: "https://media.example/price%20list.pdf", bytes: 2048 }] });
    expect(calls("/post").slice(2).map((x) => x.body)).toEqual([
      { from: ADMIN, type: "text", text: "Нова колекція вже тут" },
      { from: ADMIN, type: "video", media: "https://media.example/v.mp4", size: 12_345_678, duration: 42 },
      { from: ADMIN, type: "file", media: "https://media.example/price%20list.pdf", size: 2048, file_name: "price list.pdf" },
    ]);
  });

  it("sets the webhook and retries once when Viber says none is set", async () => {
    let posts = 0;
    on("/post", () => json(++posts === 1 ? { status: 10, status_message: "webhookNotSet" } : okBody({ message_token: 9 })));
    on("/set_webhook", {});
    const r = await connector().publish(channel, { ...input, idempotencyKey: "k7" });
    expect(r.externalId).toBe(`${CHANNEL_ID}:9`);
    expect(calls("/set_webhook")).toHaveLength(1);
    expect(calls("/post")).toHaveLength(2);
  });

  it("validates: bots do not publish, one media item, video limits, HTTPS media", () => {
    const c = connector();
    expect(c.validate(bot, input).map((i) => i.message)).toEqual(["Viber bots only answer people; connect a Viber Channel to publish"]);
    expect(c.validate(channel, { ...input, thread: ["x"], media: [{ kind: "video", url: "http://m.example/v.mov", mime: "video/quicktime", bytes: 60_000_000, durationSeconds: 300 }, { kind: "image", url: "https://m.example/i.jpg" }] }).map((i) => i.code)).toEqual([
      "thread_unsupported",
      "too_many_media",
      "unsupported_media",
      "unsupported_media",
      "unsupported_media",
      "unsupported_media",
    ]);
  });
});

describe("viber bot reply and metrics", () => {
  it("replies to a person with send_message and a sender name of at most 28 characters", async () => {
    on("/send_message", () => new Response('{"status":0,"status_message":"ok","message_token":5098034272017991234}', { status: 200 }));
    const r = await connector().reply(bot, { parentExternalId: `${USER}:4912661846655238145`, text: "З 9:00", idempotencyKey: "r1" });
    expect(r.externalId).toBe(`${USER}:5098034272017991234`);
    expect(calls("/send_message")[0]!.body).toEqual({ receiver: USER, min_api_version: 1, sender: { name: "Acme Support Bot With A Long" }, type: "text", text: "З 9:00" });
  });

  it("refuses replies from a channel and maps a not-subscribed receiver", async () => {
    expect((await rejection(connector().reply(channel, { parentExternalId: USER, text: "hi", idempotencyKey: "r2" }))).message).toContain("no inbox");
    on("/send_message", () => json({ status: 6, status_message: "notSubscribed" }));
    const e = await rejection(connector().reply(bot, { parentExternalId: USER, text: "hi", idempotencyKey: "r3" }));
    expect(e.kind).toBe("rejected");
    expect(e.message).toContain("not subscribed");
  });

  it("reads subscribers as followers_total", async () => {
    on("/get_account_info", channelInfo);
    expect(await connector().fetchAccountMetrics(channel)).toEqual([{ entityType: "social_account", entityId: "acc-ch", metric: "followers_total", value: 15000, observedAt: NOW.toISOString(), source: "viber" }]);
  });

  it("maps status codes and HTTP failures", async () => {
    expect(mapViberError(2, "invalidAuthToken", "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapViberError(12, "tooManyRequests", "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapViberError(6, undefined, "x")).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapViberError(9, undefined, "x").kind).toBe("auth");
    expect(mapViberError(23, undefined, "x").message).toContain("allowance");
    expect(mapViberError(undefined, undefined, "x", 503)).toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError(`socket closed ${TOKEN_A}`));
    const e = await rejection(connector().fetchAccountMetrics(channel));
    expect(e.kind).toBe("network");
    expect(e.message).not.toContain(TOKEN_A);
    await expect(connector().moderate(channel, { externalId: "x", action: "delete" })).rejects.toThrow(/not available/);
  });
});
