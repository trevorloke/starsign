import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { WeComConnector, botExternalId, createWeComConnectors, kfMessageToActivity, kfTarget, mapWeComError, type KfMessage } from "../src/wecom.ts";
import { toWeChatXml, wechatEncrypt, wechatSignature } from "../src/wechat-crypto.ts";

// Every credential here is fake and assembled at runtime so nothing looks like a real key.
const CORP = ["ww", "fakecorp", "0".repeat(8)].join("");
const OTHER_CORP = ["ww", "othercorp", "1".repeat(7)].join("");
const SECRET = ["fake", "kf", "secret", "x".repeat(20)].join("_");
const TOKEN = ["fake", "Callback", "Token"].join("");
const AES = randomBytes(32).toString("base64").replace(/=$/, "").replace(/[+/]/g, "A");
const BOT_KEY = ["fake", "bot", "key", "0000"].join("-");
const BOT_URL = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${BOT_KEY}`;
const KF = ["wk", "fakeKfAccount01"].join("");
const USER = ["wm", "fakeCustomer0001"].join("");
const NOW = new Date("2026-11-06T10:00:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

const kfAuth = { corpId: CORP, kfSecret: SECRET, token: TOKEN, encodingAesKey: AES, openKfId: KF };
const acct = (auth: Record<string, unknown> = kfAuth, over: Partial<AccountRef> = {}): AccountRef => ({
  id: "acc1",
  workspaceId: "w",
  network: "wecom",
  externalId: CORP,
  handle: "Store help",
  auth,
  config: { corpId: CORP, openKfId: KF },
  ...over,
});
const botAcct = () => acct({ botKey: BOT_KEY }, { externalId: botExternalId(BOT_KEY), config: {} });

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let clock: Date;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  clock = NOW;
});
afterEach(() => vi.unstubAllGlobals());
const connector = () => new WeComConnector({ now: () => clock, publicUrl: "https://app.example/" });
const calls = (part: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(part));
const bodyOf = (part: string, i = 0) => JSON.parse(String(calls(part)[i]?.[1]?.body)) as Record<string, unknown>;

type Route = Response[] | ((url: string, body: Record<string, unknown>) => Response);
function wire(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes("/cgi-bin/gettoken")) return json({ errcode: 0, errmsg: "ok", access_token: "AT-1", expires_in: 7200 });
    for (const [k, r] of Object.entries(routes)) {
      if (!u.includes(k)) continue;
      if (Array.isArray(r)) return (r.length > 1 ? r.shift()! : r[0]!).clone();
      return r(u, init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    }
    throw new Error(`unexpected ${u}`);
  });
}

describe("wecom connect", () => {
  const inputs = { corpId: CORP, kfSecret: SECRET, token: TOKEN, encodingAesKey: AES, openKfId: "", botWebhookUrl: "" };

  it("customer service: gettoken + kf/account/list, first account by default, keyed by CorpID", async () => {
    wire({ "kf/account/list": [json({ errcode: 0, account_list: [{ open_kfid: KF, name: "Store help", avatar: "https://x" }, { open_kfid: "wkSecond000", name: "Second" }] })] });
    const c = connector();
    const [a] = await c.connectWithInputs({ network: "wecom", inputs: { ...inputs, corpId: ` ${CORP} ` } });
    const tokenUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(tokenUrl.pathname).toBe("/cgi-bin/gettoken");
    expect(tokenUrl.searchParams.get("corpid")).toBe(CORP);
    expect(String(calls("kf/account/list")[0]?.[0])).toBe("https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token=AT-1");
    expect(bodyOf("kf/account/list")).toEqual({ offset: 0, limit: 100 });
    expect(a).toEqual({
      network: "wecom",
      identity: { externalId: CORP, handle: "Store help", displayName: "Store help" },
      auth: { corpId: CORP, kfSecret: SECRET, token: TOKEN, encodingAesKey: AES, openKfId: KF },
      config: { parts: ["customer_service"], corpId: CORP, openKfId: KF, webhookUrl: `https://app.example/webhooks/wecom?account=${CORP}` },
    });
    expect(c.credentialInputs.every((i) => i.optional)).toBe(true);
  });

  it("customer service + bot: picks the named account and keeps the bot key", async () => {
    wire({ "kf/account/list": [json({ account_list: [{ open_kfid: "wkFirst0000", name: "First" }, { open_kfid: KF, name: "Store help" }] })] });
    const [a] = await connector().connectWithInputs({ network: "wecom", inputs: { ...inputs, openKfId: KF, botWebhookUrl: BOT_URL } });
    expect(a?.auth).toMatchObject({ openKfId: KF, botKey: BOT_KEY });
    expect(a?.config).toMatchObject({ parts: ["customer_service", "group_bot"], openKfId: KF });
  });

  it("bot only: validates the URL shape without calling WeCom, keyed by a hash of the key", async () => {
    const [a] = await connector().connectWithInputs({ network: "wecom", inputs: { botWebhookUrl: BOT_URL } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a?.identity).toEqual({ externalId: botExternalId(BOT_KEY), handle: "WeCom group bot", displayName: null });
    expect(a?.identity.externalId).not.toContain(BOT_KEY);
    expect(a?.auth).toEqual({ botKey: BOT_KEY });
    expect(a?.config).toEqual({ parts: ["group_bot"] });
  });

  it("rejects bad shapes and partial customer service inputs without echoing values", async () => {
    const tries: Record<string, string>[] = [
      {},
      { botWebhookUrl: "https://example.com/hook?key=abc" },
      { corpId: CORP },
      { ...inputs, corpId: "acme" },
      { ...inputs, encodingAesKey: "short-key" },
      { ...inputs, token: "bad token!" },
      { ...inputs, openKfId: "nope" },
    ];
    for (const t of tries) {
      const err = (await connector().connectWithInputs({ network: "wecom", inputs: t }).catch((e: unknown) => e)) as ConnectorError;
      expect(err.kind).toBe("rejected");
      expect(err.message).not.toContain("short-key");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains an unknown open_kfid, no accounts, a bad secret and an untrusted IP", async () => {
    wire({ "kf/account/list": [json({ account_list: [{ open_kfid: "wkOther0000", name: "x" }] })] });
    await expect(connector().connectWithInputs({ network: "wecom", inputs: { ...inputs, openKfId: KF } })).rejects.toMatchObject({ message: expect.stringMatching(/not in this company/) });
    wire({ "kf/account/list": [json({ account_list: [] })] });
    await expect(connector().connectWithInputs({ network: "wecom", inputs })).rejects.toMatchObject({ message: expect.stringMatching(/no customer service account/) });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ errcode: 40001, errmsg: `invalid secret ${SECRET}` }));
    const bad = (await connector().connectWithInputs({ network: "wecom", inputs }).catch((e: unknown) => e)) as ConnectorError;
    expect(bad.kind).toBe("auth");
    expect(bad.message).not.toContain(SECRET);
    fetchMock.mockResolvedValueOnce(json({ errcode: 60020, errmsg: "not allow to access from your ip, from ip: 203.0.113.9" }));
    const ip = (await connector().connectWithInputs({ network: "wecom", inputs }).catch((e: unknown) => e)) as ConnectorError;
    expect(ip).toMatchObject({ kind: "rejected" });
    expect(ip.message).toMatch(/trusted IP/);
    expect(ip.message).toContain("203.0.113.9");
  });

  it("describeAccount works from either part", async () => {
    wire({ "kf/account/list": [json({ account_list: [{ open_kfid: KF, name: "Store help" }] })] });
    expect(await connector().describeAccount(kfAuth)).toEqual({ externalId: CORP, handle: "Store help", displayName: "Store help" });
    expect(await connector().describeAccount({ botKey: BOT_KEY })).toMatchObject({ externalId: botExternalId(BOT_KEY) });
    await expect(connector().describeAccount({})).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("wecom access token", () => {
  it("caches the token and refreshes once on 42001", async () => {
    const tokens = ["AT-old", "AT-new", "AT-newer"];
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("gettoken")) return json({ errcode: 0, access_token: tokens.shift(), expires_in: 7200 });
      if (u.includes("AT-old")) return json({ errcode: 42001, errmsg: "access_token expired" });
      return json({ errcode: 0, msgid: "m1" });
    });
    const c = connector();
    await c.reply(acct(), { parentExternalId: `${KF}:${USER}:msg1`, text: "hi", idempotencyKey: "r1" });
    await c.reply(acct(), { parentExternalId: `${KF}:${USER}:msg1`, text: "hi", idempotencyKey: "r2" });
    expect(calls("gettoken")).toHaveLength(2);
    expect(calls("access_token=AT-new")).toHaveLength(2);
  });
});

describe("wecom callback crypto", () => {
  const sign = (parts: string[]) => wechatSignature(parts);

  it("routes by ?account= and by the envelope's ToUserName", () => {
    const h = connector().webhook;
    expect(h.route!("", { account: CORP }, {})).toEqual({ network: "wecom", accountExternalId: CORP });
    expect(h.route!(toWeChatXml({ ToUserName: CORP, AgentID: "", Encrypt: "abc" }), {}, {})).toEqual({ network: "wecom", accountExternalId: CORP });
    expect(h.route!("", { account: "gh_123" }, {})).toBeNull();
    expect(h.route!("garbage", {}, {})).toBeNull();
  });

  it("URL check: verifies msg_signature over the encrypted echostr and answers the plaintext", () => {
    const h = connector().webhook;
    const echostr = wechatEncrypt("8231904518339218", AES, CORP);
    const q = { account: CORP, timestamp: TS, nonce: "n1", echostr, msg_signature: sign([TOKEN, TS, "n1", echostr]) };
    expect(h.challengeAccount!(acct(), q)).toBe("8231904518339218");
    // a "+" that arrived as a space is restored
    expect(h.challengeAccount!(acct(), { ...q, echostr: echostr.replace(/\+/g, " ") })).toBe("8231904518339218");
    expect(h.challengeAccount!(acct(), { ...q, msg_signature: sign(["otherToken", TS, "n1", echostr]) })).toBeNull();
    expect(h.challengeAccount!(acct(), { ...q, timestamp: String(Number(TS) - 3600), msg_signature: sign([TOKEN, String(Number(TS) - 3600), "n1", echostr]) })).toBeNull();
    // encrypted for another corp (receiveid mismatch)
    const foreign = wechatEncrypt("1", AES, OTHER_CORP);
    expect(h.challengeAccount!(acct(), { ...q, echostr: foreign, msg_signature: sign([TOKEN, TS, "n1", foreign]) })).toBeNull();
    expect(h.challengeAccount!(botAcct(), q)).toBeNull();
  });

  it("callback: verify → decrypt → parse stores the sync token, returns no items, acks with an empty body", async () => {
    const c = connector();
    const h = c.webhook;
    const inner = toWeChatXml({ ToUserName: CORP, CreateTime: Number(TS), MsgType: "event", Event: "kf_msg_or_event", Token: "SYNC-TOKEN-1", OpenKfId: KF });
    const encrypt = wechatEncrypt(inner, AES, CORP);
    const raw = toWeChatXml({ ToUserName: CORP, AgentID: "", Encrypt: encrypt });
    const q = { account: CORP, timestamp: TS, nonce: "n2", msg_signature: sign([TOKEN, TS, "n2", encrypt]) };
    expect(h.verifyAccount!(acct(), {}, raw, q)).toBe(true);
    expect(h.verifyAccount!(acct(), {}, raw, { ...q, msg_signature: sign([TOKEN, TS, "n2"]) })).toBe(false);
    expect(h.verifyAccount!(acct(), {}, toWeChatXml({ ToUserName: CORP, Content: "x" }), q)).toBe(false);
    expect(h.verifyAccount!(acct(), {}, raw, { ...q, timestamp: String(Number(TS) + 400) })).toBe(false);
    expect(h.verify({}, raw, q)).toBe(false);
    const body = h.decodeAccount!(acct(), raw, q);
    expect(h.parse(body)).toEqual([]);
    expect(c.pendingSyncToken(CORP, KF)).toBe("SYNC-TOKEN-1");
    expect(h.ack).toEqual({ body: "", contentType: "text/plain" });
    clock = new Date(NOW.getTime() + 10 * 60_000);
    expect(c.pendingSyncToken(CORP, KF)).toBeNull();
  });

  it("refuses a callback encrypted for another corp", () => {
    const encrypt = wechatEncrypt(toWeChatXml({ ToUserName: CORP, MsgType: "event" }), AES, OTHER_CORP);
    expect(() => connector().webhook.decodeAccount!(acct(), toWeChatXml({ ToUserName: CORP, Encrypt: encrypt }), {})).toThrow(/another AppID/);
  });
});

describe("wecom sync_msg", () => {
  const msg = (i: number, over: Partial<KfMessage> = {}): KfMessage => ({
    msgid: `msg${i}`,
    open_kfid: KF,
    external_userid: USER,
    send_time: Number(TS) - 100 + i,
    origin: 3,
    msgtype: "text",
    text: { content: `hello ${i}` },
    ...over,
  });

  it("pulls with the callback token, follows next_cursor while has_more, then resumes from the cursor", async () => {
    const pages = [
      json({ errcode: 0, next_cursor: "C1", has_more: 1, msg_list: [msg(1), msg(2, { origin: 5, servicer_userid: "staff" })] }),
      json({ errcode: 0, next_cursor: "C2", has_more: 0, msg_list: [msg(3)] }),
      json({ errcode: 0, next_cursor: "C3", has_more: 0, msg_list: [msg(4)] }),
    ];
    wire({ "kf/sync_msg": pages, "kf/customer/batchget": [json({ errcode: 0, customer_list: [{ external_userid: USER, nickname: "小王" }] })] });
    const c = connector();
    const inner = toWeChatXml({ ToUserName: CORP, MsgType: "event", Event: "kf_msg_or_event", Token: "SYNC-1", OpenKfId: KF });
    c.webhook.parse(c.webhook.decodeAccount!(acct(), toWeChatXml({ ToUserName: CORP, Encrypt: wechatEncrypt(inner, AES, CORP) }), {}));

    const first = await c.fetchActivity(acct(), null);
    expect(first.map((a) => a.externalId)).toEqual([`${KF}:${USER}:msg1`, `${KF}:${USER}:msg3`]);
    expect(first[0]).toMatchObject({ network: "wecom", kind: "dm", text: "hello 1", authorHandle: USER, authorName: "小王", conversation: { id: USER, type: "direct" } });
    expect(bodyOf("kf/sync_msg", 0)).toEqual({ token: "SYNC-1", limit: 1000, voice_format: 0, open_kfid: KF });
    expect(bodyOf("kf/sync_msg", 1)).toEqual({ cursor: "C1", token: "SYNC-1", limit: 1000, voice_format: 0, open_kfid: KF });
    expect(bodyOf("kf/customer/batchget")).toEqual({ external_userid_list: [USER], need_enter_session_context: 0 });

    const second = await c.fetchActivity(acct(), new Date(NOW.getTime() + 3600_000));
    expect(second.map((a) => a.externalId)).toEqual([`${KF}:${USER}:msg4`]); // the cursor, not `since`, decides
    expect(bodyOf("kf/sync_msg", 2)).toMatchObject({ cursor: "C2" });
    expect(calls("kf/customer/batchget")).toHaveLength(1); // nickname cached
  });

  it("without a cursor filters by since; drops a rejected sync token and pulls without it", async () => {
    let n = 0;
    wire({
      "kf/sync_msg": (_u, body) => {
        n++;
        if (body.token) return json({ errcode: 95007, errmsg: "invalid msg token" });
        return json({ next_cursor: "C9", has_more: 0, msg_list: [msg(1, { send_time: Number(TS) - 7200 }), msg(2)] });
      },
      "kf/customer/batchget": [json({ errcode: 48002, errmsg: "api forbidden" })],
    });
    const c = connector();
    c.webhook.parse({ ToUserName: CORP, MsgType: "event", Event: "kf_msg_or_event", Token: "OLD", OpenKfId: KF });
    // The announcement asks core to pull at once; other events do not.
    expect(c.webhook.pullNow?.({ ToUserName: CORP, MsgType: "event", Event: "kf_msg_or_event", Token: "OLD", OpenKfId: KF })).toBe(true);
    expect(c.webhook.pullNow?.({ ToUserName: CORP, MsgType: "event", Event: "enter_agent" })).toBe(false);
    const items = await c.fetchActivity(acct(), new Date(NOW.getTime() - 3600_000));
    expect(items.map((i) => i.externalId)).toEqual([`${KF}:${USER}:msg2`]);
    expect(items[0]?.authorName).toBeNull();
    expect(n).toBe(2);
    expect(c.pendingSyncToken(CORP, KF)).toBeNull();
  });

  it("bot-only accounts have nothing to read", async () => {
    expect(await connector().fetchActivity(botAcct(), null)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps every message type", () => {
    const map = (over: Partial<KfMessage>) => kfMessageToActivity(msg(9, over));
    expect(map({ msgtype: "image", image: { media_id: "M" } })?.text).toBe("[image]");
    expect(map({ msgtype: "voice", voice: { media_id: "M" } })?.text).toBe("[voice]");
    expect(map({ msgtype: "video", video: { media_id: "M" } })?.text).toBe("[video]");
    expect(map({ msgtype: "file", file: { media_id: "M" } })?.text).toBe("[file]");
    expect(map({ msgtype: "location", location: { latitude: 23.1, longitude: 113.2, name: "店", address: "广州" } })?.text).toBe("[location] 店, 广州 (23.1, 113.2)");
    expect(map({ msgtype: "link", link: { title: "T", desc: "D", url: "https://e.cn/x" } })).toMatchObject({ text: "[link] T D https://e.cn/x", url: "https://e.cn/x" });
    expect(map({ msgtype: "miniprogram", miniprogram: { title: "Shop", appid: "wx1" } })?.text).toBe("[mini program] Shop");
    expect(map({ msgtype: "business_card" })?.text).toBe("[business_card]");
    const enter = kfMessageToActivity({ msgid: "e1", send_time: Number(TS), origin: 4, msgtype: "event", event: { event_type: "enter_session", open_kfid: KF, external_userid: USER, scene: "qr", scene_param: "store42" } });
    expect(enter).toMatchObject({ kind: "dm", externalId: `${KF}:${USER}:e1`, text: "[opened the chat from scene qr (store42)]", occurredAt: NOW.toISOString() });
    expect(kfMessageToActivity({ msgid: "e2", origin: 4, msgtype: "event", event: { event_type: "session_status_change", open_kfid: KF, external_userid: USER } })).toBeNull();
    expect(map({ origin: 5 })).toBeNull();
  });
});

describe("wecom reply (kf/send_msg)", () => {
  it("sends text to the customer of the parent message with a stable msgid", async () => {
    wire({ "kf/send_msg": [json({ errcode: 0, errmsg: "ok", msgid: "SENT1" })] });
    const c = connector();
    const r = await c.reply(acct(), { parentExternalId: `${KF}:${USER}:msg1`, text: "我们 9 点开门", idempotencyKey: "rk1" });
    const sent = bodyOf("kf/send_msg");
    expect(sent).toMatchObject({ touser: USER, open_kfid: KF, msgtype: "text", text: { content: "我们 9 点开门" } });
    expect(sent.msgid).toBe(createHash("sha256").update("rk1").digest("hex").slice(0, 32));
    expect(r).toMatchObject({ externalId: `${KF}:${USER}:SENT1`, url: null });
    await c.reply(acct(), { parentExternalId: `${KF}:${USER}:msg1`, text: "again", idempotencyKey: "rk1" });
    expect(calls("kf/send_msg")).toHaveLength(1);
  });

  it.each([
    [95018, "send msg session status invalid", /48 hours/],
    [95001, "send msg count limit", /5 messages/],
    [95013, "conversation end", /ended/],
    [95000, "invalid open_kfid", /not found/],
  ])("maps errcode %i clearly", async (errcode, errmsg, re) => {
    wire({ "kf/send_msg": [json({ errcode, errmsg })] });
    const err = (await connector().reply(acct(), { parentExternalId: `${KF}:${USER}:m`, text: "hi", idempotencyKey: `e${errcode}` }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toMatch(re);
    expect(err.message).not.toContain("AT-1");
  });

  it("refuses bot-only accounts, bad parent ids and empty text", async () => {
    await expect(connector().reply(botAcct(), { parentExternalId: `${KF}:${USER}:m`, text: "hi", idempotencyKey: "a" })).rejects.toMatchObject({ kind: "rejected" });
    expect(() => kfTarget("nope")).toThrow();
    expect(kfTarget(`${KF}:${USER}`)).toEqual({ openKfId: KF, userId: USER });
    await expect(connector().reply(acct(), { parentExternalId: `${KF}:${USER}:m`, text: "  ", idempotencyKey: "b" })).rejects.toMatchObject({ kind: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("wecom group bot publishing", () => {
  const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v", text: "## 新品上架\n**今天** 到店有礼", media: [], thread: [], options: {}, idempotencyKey: "p1", ...over });
  const png = (bytes = 64) => new Uint8Array(bytes).fill(9);
  const withMedia = (c: WeComConnector, bytes = 64, mime = "image/png") => {
    c.media = { fetch: async () => ({ bytes: png(bytes), mime }) };
    return c;
  };

  it("posts markdown with the link appended, then images as base64 + md5", async () => {
    wire({ "webhook/send": [json({ errcode: 0, errmsg: "ok" })] });
    const c = withMedia(connector());
    const r = await c.publish(botAcct(), input({ media: [{ kind: "image", url: "https://cdn.example/a.png", mime: "image/png" }], options: { link: "https://example.cn/new" } }));
    expect(String(calls("webhook/send")[0]?.[0])).toBe(BOT_URL);
    expect(bodyOf("webhook/send", 0)).toEqual({ msgtype: "markdown", markdown: { content: "## 新品上架\n**今天** 到店有礼\n\n[https://example.cn/new](https://example.cn/new)" } });
    const img = bodyOf("webhook/send", 1) as { msgtype: string; image: { base64: string; md5: string } };
    expect(img.msgtype).toBe("image");
    expect(img.image.base64).toBe(Buffer.from(png()).toString("base64"));
    expect(img.image.md5).toBe(createHash("md5").update(png()).digest("hex"));
    expect(r.externalId.startsWith(`${botExternalId(BOT_KEY)}:`)).toBe(true);
    expect(r.externalId).not.toContain(BOT_KEY);
    await c.publish(botAcct(), input({ options: { link: "https://example.cn/new" } }));
    expect(calls("webhook/send")).toHaveLength(2); // idempotent
  });

  it("sends a news card when there is a link and a title", async () => {
    wire({ "webhook/send": [json({ errcode: 0, errmsg: "ok" })] });
    await connector().publish(botAcct(), input({ text: "Autumn menu is here", media: [{ kind: "image", url: "https://cdn.example/a.png" }], options: { link: "https://example.cn/m", title: "Autumn menu" } }));
    expect(bodyOf("webhook/send")).toEqual({ msgtype: "news", news: { articles: [{ title: "Autumn menu", description: "Autumn menu is here", url: "https://example.cn/m", picurl: "https://cdn.example/a.png" }] } });
    expect(calls("webhook/send")).toHaveLength(1);
  });

  it("validates size, type and length; refuses accounts without a bot", async () => {
    const c = connector();
    const codes = (i: PublishInput) => c.validate(botAcct(), i).map((x) => x.code);
    expect(codes(input())).toEqual([]);
    expect(codes(input({ text: "长".repeat(1400) }))).toContain("too_long"); // 4200 bytes
    expect(codes(input({ media: [{ kind: "image", url: "https://x/a.png", bytes: 3 * 1024 * 1024 }] }))).toContain("unsupported_media");
    expect(codes(input({ media: [{ kind: "image", url: "https://x/a.gif", mime: "image/gif" }] }))).toContain("unsupported_media");
    expect(codes(input({ media: [{ kind: "video", url: "https://x/a.mp4" }] }))).toContain("unsupported_media");
    expect(codes(input({ thread: ["x"] }))).toContain("thread_unsupported");
    expect(codes(input({ text: "" }))).toContain("empty");
    await expect(c.publish(acct(), input())).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/no group bot/) });
    // fetched bytes over 2 MB are refused even when the size was unknown up front
    wire({ "webhook/send": [json({ errcode: 0 })] });
    await expect(withMedia(connector(), 3 * 1024 * 1024).publish(botAcct(), input({ idempotencyKey: "big", media: [{ kind: "image", url: "https://x/a.png" }] }))).rejects.toMatchObject({ kind: "rejected", partial: expect.any(Object) });
  });

  it("maps bot errors: invalid key → auth, rate limit → retryable, never leaking the key", async () => {
    wire({ "webhook/send": [json({ errcode: 93000, errmsg: `invalid webhook url, key=${BOT_KEY}` })] });
    const err = (await connector().publish(botAcct(), input({ idempotencyKey: "e1" })).catch((e: unknown) => e)) as ConnectorError;
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain(BOT_KEY);
    wire({ "webhook/send": [json({ errcode: 45009, errmsg: "api freq out of limit" })] });
    await expect(connector().publish(botAcct(), input({ idempotencyKey: "e2" }))).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${BOT_URL}`));
    const net = (await connector().publish(botAcct(), input({ idempotencyKey: "e3" })).catch((e: unknown) => e)) as ConnectorError;
    expect(net).toMatchObject({ kind: "network", retryable: true });
    expect(net.message).not.toContain(BOT_KEY);
  });
});

describe("wecom misc", () => {
  it("capabilities, metrics and factory", async () => {
    const c = connector();
    expect(c.capabilities()).toMatchObject({ publish: true, fetchActivity: true, reply: true, moderate: false, webhooks: true, fetchMetrics: false, kinds: ["post", "link"] });
    expect(await c.fetchMetrics()).toEqual([]);
    const [f] = createWeComConnectors({ STARSIGN_PUBLIC_URL: "https://s.example", WECOM_API_BASE: "https://qyapi.weixin.qq.com/" });
    expect(f?.name).toBe("wecom");
    expect(f?.networks).toEqual(["wecom"]);
    expect(mapWeComError(-1, "busy", "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapWeComError(40014, "invalid access_token", "x").kind).toBe("auth");
  });
});
