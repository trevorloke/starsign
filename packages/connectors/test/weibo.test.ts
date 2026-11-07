import { describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { SECURITY_DOMAIN_RULE, WeiboConnector, checkSecurityDomain, createWeiboConnectors, mapWeiboError, parseWeiboJson, type WeiboConnectorOptions } from "../src/weibo.ts";

const NOW = new Date("2026-11-07T00:00:00.000Z");
// Assembled at runtime so nothing here looks like a real credential.
const TOKEN = ["weibo", "test", "token"].join("-");
const SECRET = ["app", "secret"].join("-");

const acct = (auth: Record<string, unknown> = {}, config: Record<string, unknown> = {}): AccountRef => ({
  id: "acc-wb",
  workspaceId: "w",
  network: "weibo",
  externalId: "1000001",
  handle: "acme",
  auth: { accessToken: TOKEN, uid: "1000001", expiresAt: "2031-11-07T00:00:00.000Z", ...auth },
  config,
});

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

function setup(route: Route, opts: WeiboConnectorOptions = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const i = init ?? {};
    calls.push({ url, init: i });
    const r = await route(url, i);
    if (!r) throw new Error(`unexpected ${i.method ?? "GET"} ${url.pathname}`);
    return r;
  });
  const c = new WeiboConnector({ appKey: "12345", appSecret: SECRET, securityDomain: "acme.com", fetch: fetchMock as unknown as typeof fetch, now: () => NOW, ...opts });
  c.media = { fetch: async () => ({ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" }) };
  const form = (path: string, n = 0) => {
    const hit = calls.filter((x) => x.url.pathname === path)[n];
    if (!hit) throw new Error(`no call to ${path}`);
    return hit.init.body instanceof FormData ? hit.init.body : new URLSearchParams(String(hit.init.body));
  };
  return { c, calls, fetchMock, form };
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

const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "New season https://acme.com/s1", media: [], thread: [], idempotencyKey: "k1", ...over });

// Weibo ids exceed 2^53: send them as bare numbers to check they survive parsing.
const BIG_STATUS = "5100000000000000001";
const BIG_COMMENT = "5100000000000000123";

describe("weibo connect", () => {
  it("builds the authorize URL and reads env names; unconfigured without an app key and secret", () => {
    const { c } = setup(() => undefined);
    const u = new URL(c.oauthAuthorizeUrl({ state: "st", codeChallenge: "ch", redirectUri: "https://app.example/oauth/weibo/callback" }));
    expect(u.origin + u.pathname).toBe("https://api.weibo.com/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("12345");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example/oauth/weibo/callback");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.has("scope")).toBe(false);
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(c.connectConfigured).toBe(true);
    expect(createWeiboConnectors({})[0]!.connectConfigured).toBe(false);
    const fromEnv = createWeiboConnectors({ WEIBO_APP_KEY: "a", WEIBO_APP_SECRET: "b" });
    expect(fromEnv.map((x) => [x.name, x.networks, x.connectConfigured])).toEqual([["weibo", ["weibo"], true]]);
    expect(c.capabilities()).toMatchObject({ publish: true, reply: true, moderate: true, accountMetrics: true, video: false });
  });

  it("exchanges the code, reads expiry from get_token_info and returns the user", async () => {
    const { c, form } = setup((url) => {
      if (url.pathname === "/oauth2/access_token") return json({ access_token: TOKEN, remind_in: "157679999", expires_in: 157679999, uid: "1000001", isRealName: "true" });
      if (url.pathname === "/oauth2/get_token_info") return json({ uid: 1000001, appkey: "12345", scope: null, create_at: 1762473600, expire_in: 86400 });
      if (url.pathname === "/2/users/show.json") return json({ id: 1000001, idstr: "1000001", screen_name: "Acme官方", name: "Acme官方", followers_count: 42 });
      return undefined;
    });
    const accounts = await c.oauthConnect({ code: "the-code", codeVerifier: "v", redirectUri: "https://app.example/oauth/weibo/callback" });
    const ex = form("/oauth2/access_token") as URLSearchParams;
    expect(Object.fromEntries(ex)).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "12345", client_secret: SECRET, redirect_uri: "https://app.example/oauth/weibo/callback" });
    expect((form("/oauth2/get_token_info") as URLSearchParams).get("access_token")).toBe(TOKEN);
    expect(accounts).toEqual([
      {
        network: "weibo",
        identity: { externalId: "1000001", handle: "Acme官方", displayName: "Acme官方" },
        // get_token_info's expire_in (1 day here, e.g. a test app) wins over expires_in.
        auth: { accessToken: TOKEN, uid: "1000001", expiresAt: "2026-11-08T00:00:00.000Z" },
        config: { uid: "1000001", securityDomain: "acme.com" },
      },
    ]);
  });

  it("has no refresh: refreshAuth is null and an expired token fails as auth without calling Weibo", async () => {
    const { c, fetchMock } = setup(() => undefined);
    expect(await c.refreshAuth(acct())).toBeNull();
    const err = await rejection(c.fetchAccountMetrics(acct({ expiresAt: "2026-11-06T00:00:00.000Z" })));
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("weibo publish (statuses/share)", () => {
  const shareOk = (url: URL) => (url.pathname === "/2/statuses/share.json" ? json(`{"id":${BIG_STATUS},"idstr":"${BIG_STATUS}","mid":"${BIG_STATUS}","text":"ok","user":{"id":1000001,"idstr":"1000001"}}`) : undefined);

  it("posts text containing a security-domain link and returns the status URL", async () => {
    const { c, form, fetchMock } = setup(shareOk);
    const res = await c.publish(acct(), input());
    expect(res).toMatchObject({ externalId: BIG_STATUS, url: `https://weibo.com/1000001/${BIG_STATUS}` });
    const body = form("/2/statuses/share.json") as URLSearchParams;
    expect(body.get("status")).toBe("New season https://acme.com/s1");
    expect(body.get("access_token")).toBe(TOKEN);
    // Idempotent in-process.
    await c.publish(acct(), input());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("appends options.link to the text when it is not there yet (subdomains count)", async () => {
    const { c, form } = setup(shareOk);
    await c.publish(acct(), input({ text: "New season", options: { link: "https://www.acme.com/s1" } }));
    expect((form("/2/statuses/share.json") as URLSearchParams).get("status")).toBe("New season https://www.acme.com/s1");
  });

  it("refuses text without a link, or without a link to the security domain, before calling Weibo", async () => {
    const { c, fetchMock } = setup(shareOk);
    const none = await rejection(c.publish(acct(), input({ text: "No link here", idempotencyKey: "a" })));
    expect(none.kind).toBe("rejected");
    expect(none.message).toContain("has no link");
    expect(none.message).toContain("security domain");
    const other = await rejection(c.publish(acct(), input({ text: "See https://other.example/x", idempotencyKey: "b" })));
    expect(other.message).toContain("acme.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(c.validate(acct(), input({ text: "No link" })).map((i) => i.code)).toEqual(["empty"]);
    expect(c.validate(acct(), input())).toEqual([]);
    // The account's own security domain overrides the app default.
    expect(c.validate(acct({}, { securityDomain: "other.example" }), input({ text: "See https://other.example/x" }))).toEqual([]);
    // Without a configured domain, any link passes the local check (Weibo still enforces its rule).
    const loose = setup(shareOk, { securityDomain: "" }).c;
    expect(loose.validate(acct(), input({ text: "See https://other.example/x" }))).toEqual([]);
    expect(checkSecurityDomain("文字 https://acme.com/a，好", "acme.com")).toBeNull();
  });

  it("sends one picture as multipart `pic`", async () => {
    const { c, form } = setup(shareOk);
    await c.publish(acct(), input({ media: [{ kind: "image", url: "https://media.acme.com/a.png", mime: "image/png" }] }));
    const body = form("/2/statuses/share.json") as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("status")).toBe("New season https://acme.com/s1");
    expect(body.get("access_token")).toBe(TOKEN);
    const pic = body.get("pic") as File;
    expect(pic).toBeInstanceOf(Blob);
    expect(pic.type).toBe("image/png");
    expect(pic.size).toBe(4);
  });

  it("validates media and threads", () => {
    const { c } = setup(() => undefined);
    const two = c.validate(acct(), input({ media: [{ kind: "image", url: "https://m/a.jpg" }, { kind: "image", url: "https://m/b.jpg" }] }));
    expect(two.map((i) => i.code)).toContain("too_many_media");
    expect(c.validate(acct(), input({ media: [{ kind: "video", url: "https://m/a.mp4" }] })).map((i) => i.code)).toContain("unsupported_media");
    expect(c.validate(acct(), input({ thread: ["more"] })).map((i) => i.code)).toContain("thread_unsupported");
  });

  it("explains Weibo's own domain refusal (10017 text not find domain)", async () => {
    const { c } = setup((url) => (url.pathname === "/2/statuses/share.json" ? json({ request: "/2/statuses/share.json", error_code: 10017, error: "text not find domain!" }, 400) : undefined));
    const err = await rejection(c.publish(acct(), input()));
    expect(err.kind).toBe("rejected");
    expect(err.message).toContain(SECURITY_DOMAIN_RULE);
  });
});

describe("weibo inbox", () => {
  const user = (id: number, name: string) => `{"id":${id},"idstr":"${id}","screen_name":"${name}","name":"${name}"}`;
  const myStatus = `{"id":${BIG_STATUS},"idstr":"${BIG_STATUS}","mid":"${BIG_STATUS}","user":${user(1000001, "acme")}}`;

  function inboxRoutes(seen: string[]) {
    return (url: URL) => {
      seen.push(`${url.pathname}?${url.searchParams.get("since_id") ?? ""}`);
      if (url.pathname === "/2/comments/to_me.json")
        return json(
          `{"comments":[` +
            `{"created_at":"Fri Nov 07 10:00:00 +0800 2026","id":${BIG_COMMENT},"idstr":"${BIG_COMMENT}","text":"好看","user":${user(2000002, "fan")},"status":${myStatus}},` +
            `{"created_at":"Thu Nov 06 07:00:00 +0800 2026","id":5099999999999999999,"idstr":"5099999999999999999","text":"old","user":${user(2000002, "fan")},"status":${myStatus}},` +
            `{"created_at":"Fri Nov 07 10:05:00 +0800 2026","id":5100000000000000200,"idstr":"5100000000000000200","text":"mine","user":${user(1000001, "acme")},"status":${myStatus}}` +
            `],"total_number":3}`,
        );
      if (url.pathname === "/2/statuses/mentions.json")
        return json(`{"statuses":[{"created_at":"Fri Nov 07 09:00:00 +0800 2026","id":5100000000000000300,"idstr":"5100000000000000300","mid":"5100000000000000300","text":"@acme 你好","user":${user(3000003, "someone")}}]}`);
      if (url.pathname === "/2/comments/mentions.json")
        return json(
          `{"comments":[{"created_at":"Fri Nov 07 11:00:00 +0800 2026","id":5100000000000000400,"idstr":"5100000000000000400","text":"@acme look","user":${user(4000004, "other")},"status":{"id":5100000000000000500,"idstr":"5100000000000000500","mid":"5100000000000000500","user":${user(4000004, "other")}},"reply_comment":{"id":5100000000000000450,"idstr":"5100000000000000450"}}]}`,
        );
      return undefined;
    };
  }

  it("maps comments on my posts, @mentions in posts and in comments; skips my own and older items", async () => {
    const seen: string[] = [];
    const { c } = setup(inboxRoutes(seen));
    const items = await c.fetchActivity(acct(), new Date("2026-11-06T12:00:00.000Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId, i.url, i.authorHandle])).toEqual([
      ["mention", "5100000000000000300", null, "https://weibo.com/3000003/5100000000000000300", "someone"],
      ["comment", BIG_COMMENT, BIG_STATUS, `https://weibo.com/1000001/${BIG_STATUS}`, "fan"],
      ["mention", "5100000000000000400", "5100000000000000450", "https://weibo.com/4000004/5100000000000000500", "other"],
    ]);
    expect(items[1]).toMatchObject({ network: "weibo", text: "好看", authorName: "fan", occurredAt: "2026-11-07T02:00:00.000Z" });
    expect(items[1]!.raw).toBeTruthy();
    // The next poll asks only for newer items.
    await c.fetchActivity(acct(), null);
    expect(seen.slice(3)).toEqual(["/2/comments/to_me.json?5100000000000000200", "/2/statuses/mentions.json?5100000000000000300", "/2/comments/mentions.json?5100000000000000400"]);
  });

  it("replies to a comment with comments/reply (cid + status id) and to a post with comments/create", async () => {
    const seen: string[] = [];
    const route = inboxRoutes(seen);
    const { c, form } = setup((url) => {
      if (url.pathname === "/2/comments/reply.json") return json(`{"id":5100000000000000900,"idstr":"5100000000000000900","status":${myStatus}}`);
      if (url.pathname === "/2/comments/create.json") return json(`{"id":5100000000000000901,"idstr":"5100000000000000901","status":${myStatus}}`);
      if (url.pathname === "/2/comments/show_batch.json") return json([]);
      return route(url);
    });
    await c.fetchActivity(acct(), null);
    const r1 = await c.reply(acct(), { parentExternalId: BIG_COMMENT, text: "谢谢", idempotencyKey: "r1" });
    expect(r1).toMatchObject({ externalId: "5100000000000000900", url: `https://weibo.com/1000001/${BIG_STATUS}` });
    expect(Object.fromEntries(form("/2/comments/reply.json") as URLSearchParams)).toEqual({ access_token: TOKEN, comment: "谢谢", id: BIG_STATUS, cid: BIG_COMMENT });
    const r2 = await c.reply(acct(), { parentExternalId: "5100000000000000777", text: "hi", idempotencyKey: "r2" });
    expect(r2.externalId).toBe("5100000000000000901");
    expect(Object.fromEntries(form("/2/comments/create.json") as URLSearchParams)).toEqual({ access_token: TOKEN, comment: "hi", id: "5100000000000000777" });
    // Explicit "<status>:<comment>" needs no lookup.
    await c.reply(acct(), { parentExternalId: `${BIG_STATUS}:5100000000000000555`, text: "ok", idempotencyKey: "r3" });
    expect((form("/2/comments/reply.json", 1) as URLSearchParams).get("cid")).toBe("5100000000000000555");
  });

  it("deletes a comment with comments/destroy; other moderation is refused", async () => {
    const { c, form } = setup((url) => (url.pathname === "/2/comments/destroy.json" ? json(`{"id":${BIG_COMMENT}}`) : undefined));
    await c.moderate(acct(), { externalId: BIG_COMMENT, action: "delete" });
    expect((form("/2/comments/destroy.json") as URLSearchParams).get("cid")).toBe(BIG_COMMENT);
    const err = await rejection(c.moderate(acct(), { externalId: BIG_COMMENT, action: "hide" }));
    expect(err.kind).toBe("rejected");
  });
});

describe("weibo metrics", () => {
  it("maps statuses/count (reposts, comments, attitudes) with exact ids, and followers from users/show", async () => {
    const { c, calls } = setup((url) => {
      if (url.pathname === "/2/statuses/count.json") return json(`[{"id":${BIG_STATUS},"comments":16,"reposts":38,"attitudes":5},{"id":5100000000000000002,"comments":0,"reposts":0,"attitudes":1}]`);
      if (url.pathname === "/2/users/show.json") return json({ idstr: "1000001", followers_count: 1234 });
      return undefined;
    });
    const m = await c.fetchMetrics(acct(), [BIG_STATUS, "5100000000000000002"]);
    expect(calls[0]!.url.searchParams.get("ids")).toBe(`${BIG_STATUS},5100000000000000002`);
    expect(m.filter((x) => x.entityId === BIG_STATUS).map((x) => [x.metric, x.value])).toEqual([
      ["reposts", 38],
      ["replies", 16],
      ["likes", 5],
      ["engagements", 59],
    ]);
    expect(m.every((x) => x.entityType === "post_variant" && x.source === "weibo" && x.observedAt === NOW.toISOString())).toBe(true);
    expect(await c.fetchAccountMetrics(acct())).toEqual([{ entityType: "social_account", entityId: "acc-wb", metric: "followers_total", value: 1234, observedAt: NOW.toISOString(), source: "weibo" }]);
  });
});

describe("weibo errors", () => {
  it("maps error codes over HTTP status", () => {
    const e = (code: number, status = 400, error = "x") => mapWeiboError(status, { error_code: code, error, request: "/2/x.json" }, "op");
    expect([e(21327, 403).kind, e(21327).retryable]).toEqual(["auth", false]);
    expect(e(21332).kind).toBe("auth");
    expect(e(21315).kind).toBe("auth");
    expect([e(10023, 403).kind, e(10023).retryable]).toEqual(["rate_limit", true]);
    expect(e(10024).kind).toBe("rate_limit");
    expect(e(10022).kind).toBe("rate_limit");
    expect([e(20019).kind, e(20019).retryable]).toEqual(["rejected", false]);
    expect(e(20019).message).toContain("duplicate");
    expect(e(10014, 403).kind).toBe("rejected");
    expect([e(10001, 500).kind, e(10001).retryable]).toEqual(["network", true]);
    expect(mapWeiboError(502, "<html>bad gateway</html>", "op").kind).toBe("network");
    expect(mapWeiboError(429, undefined, "op").kind).toBe("rate_limit");
  });

  it("raises error bodies, keeps big ids exact and never puts the token in messages", async () => {
    const { c } = setup(() => json({ error_code: 21332, error: "invalid_access_token", request: "/2/users/show.json" }, 401));
    const err = await rejection(c.fetchAccountMetrics(acct()));
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain(TOKEN);
    expect(parseWeiboJson(`{"id":${BIG_STATUS},"ids":[${BIG_STATUS},12],"n":3}`)).toEqual({ id: BIG_STATUS, ids: [BIG_STATUS, 12], n: 3 });
    const thrown = setup(() => {
      throw new TypeError(`fetch failed for https://api.weibo.com/2/users/show.json?access_token=${TOKEN}`);
    }).c;
    const net = await rejection(thrown.fetchAccountMetrics(acct()));
    expect(net.kind).toBe("network");
    expect(net.message).not.toContain(TOKEN);
  });
});
