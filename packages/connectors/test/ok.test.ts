import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, STREAM_PIECE_BYTES, type AccountRef, type PublishInput } from "../src/index.ts";
import { OkConnector, createOkConnectors, mapOkError, okCommentTime, okSessionSecret, okSignature, okSignatureBase, parseOkRef } from "../src/ok.ts";
import { MiB, bigVideo, json as bigJson, network } from "./big-video.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const API = "https://api.ok.ru/fb.do";
const TOKEN_URL = "https://api.ok.ru/oauth/token.do";
// Token-shaped values are assembled at runtime so they never look like real credentials.
const ACCESS = ["tkn", "example", "session"].join("-");
const SECRET = ["EXAMPLE", "SECRET", "0000"].join("");
const APP_KEY = "CBA" + "EXAMPLEKEY";
const auth = { accessToken: ACCESS, refreshToken: "refresh-example", expiresAt: "2026-11-06T12:30:00.000Z", userId: "111" };
const userAcct: AccountRef = { id: "acc-u", workspaceId: "w", network: "ok", externalId: "111", handle: "profile/111", auth, config: { kind: "user", uid: "111" } };
const groupAcct: AccountRef = { id: "acc-g", workspaceId: "w", network: "ok", externalId: "group:555", handle: "acme", auth, config: { kind: "group", uid: "111", gid: "555" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okErr = (error_code: number, error_msg = "ERR") => json({ error_code, error_msg, error_data: null });

type Handler = (params: URLSearchParams, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let methods: Map<string, Handler>;
let others: [string, (url: string, init: RequestInit | undefined) => Response | Promise<Response>][];
const method = (name: string, h: Handler | unknown) => methods.set(name, typeof h === "function" ? (h as Handler) : h instanceof Response ? () => h.clone() : () => json(h));
const on = (url: string, h: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) => others.push([url, h]);
function apiCalls(name?: string) {
  return fetchMock.mock.calls.filter(([u]) => String(u) === API).map(([, init]) => new URLSearchParams(String(init?.body))).filter((p) => !name || p.get("method") === name);
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
  methods = new Map();
  others = [];
  fetchMock = vi.fn<typeof fetch>(async (u, init) => {
    const url = String(u);
    if (url === API) {
      const p = new URLSearchParams(String(init?.body));
      // Every API call is signed: check it the way OK would.
      const signed = Object.fromEntries([...p].filter(([k]) => k !== "access_token"));
      expect(p.get("sig")).toBe(okSignature(signed, p.get("access_token")!, SECRET));
      expect(p.get("application_key")).toBe(APP_KEY);
      const h = methods.get(p.get("method")!);
      if (!h) throw new Error(`unexpected method ${p.get("method")}`);
      return h(p, init);
    }
    const hit = others.find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    return hit[1](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = () => {
  const c = new OkConnector({ clientId: "512000000001", clientSecret: SECRET, applicationKey: APP_KEY, now: () => NOW });
  c.media = { fetch: async (m) => ({ bytes: new Uint8Array([1, 2, 3]), mime: m.kind === "video" ? "video/mp4" : "image/jpeg" }) };
  return c;
};

describe("ok signature", () => {
  it("matches a worked example: md5(sorted params + md5(access_token + secret))", () => {
    // Derived by hand (Python hashlib) from OK's description of session signatures.
    expect(okSessionSecret(ACCESS, SECRET)).toBe("0c9d060f947639c0c0ccbfe260f5a242");
    const params = { method: "users.getCurrentUser", format: "json", application_key: APP_KEY, access_token: ACCESS };
    expect(okSignatureBase(params)).toBe(`application_key=${APP_KEY}format=jsonmethod=users.getCurrentUser`);
    expect(okSignature(params, ACCESS, SECRET)).toBe("19e7500c0ab106b5ff3e422d3768f55c");
    // Unicode text is signed as UTF-8, and sig/session_key never enter the base string.
    const post = { type: "GROUP_THEME", gid: "555", method: "mediatopic.post", format: "json", application_key: APP_KEY, attachment: JSON.stringify({ media: [{ type: "text", text: "Привет" }] }), sig: "x", session_key: "y" };
    expect(okSignature(post, ACCESS, SECRET)).toBe("c55f7c7ed1984e29a19aae45c6138e12");
  });

  it("sends the signature and the token with every call, never the secret", async () => {
    method("users.getCurrentUser", { uid: "111", name: "Ivan Petrov" });
    await connector().describeAccount(auth);
    const p = apiCalls("users.getCurrentUser")[0]!;
    expect(p.get("sig")).toMatch(/^[0-9a-f]{32}$/);
    expect(p.get("access_token")).toBe(ACCESS);
    expect([...p.values()].join(" ")).not.toContain(SECRET);
  });
});

describe("ok connect", () => {
  it("builds the authorize URL with ;-separated scopes and is configured only with all three env vars", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "st", codeChallenge: "chal", redirectUri: "https://starsign.example/oauth/ok/callback" }));
    expect(url.origin + url.pathname).toBe("https://connect.ok.ru/oauth/authorize");
    expect(url.searchParams.get("scope")).toContain("GROUP_CONTENT;");
    expect(url.searchParams.get("client_id")).toBe("512000000001");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(createOkConnectors({ OK_CLIENT_ID: "1", OK_CLIENT_SECRET: "s" })[0]!.connectConfigured).toBe(false);
    expect(createOkConnectors({ OK_CLIENT_ID: "1", OK_CLIENT_SECRET: "s", OK_APPLICATION_KEY: "k" })[0]!.connectConfigured).toBe(true);
  });

  it("returns the user plus one account per group the user administers or moderates", async () => {
    on(TOKEN_URL, () => json({ access_token: ACCESS, token_type: "session", refresh_token: "refresh-example", expires_in: "1800" }));
    method("users.getCurrentUser", { uid: "111", name: "Ivan Petrov", first_name: "Ivan", last_name: "Petrov" });
    method("group.getUserGroupsV2", { groups: [{ groupId: "555", userId: "111", status: "ADMIN" }, { groupId: "666", userId: "111", status: "MODERATOR" }, { groupId: "777", userId: "111", status: "ACTIVE" }] });
    method("group.getInfo", [{ uid: "555", name: "Acme", shortname: "acme", members_count: 1200 }, { uid: "666", name: "Acme Shop" }]);
    const accounts = await connector().oauthConnect({ code: "code1", codeVerifier: "unused", redirectUri: "https://starsign.example/oauth/ok/callback" });
    expect(accounts.map((a) => [a.identity.externalId, a.identity.handle, a.identity.displayName, a.config])).toEqual([
      ["111", "profile/111", "Ivan Petrov", { kind: "user", uid: "111", name: "Ivan Petrov" }],
      ["group:555", "acme", "Acme", { kind: "group", uid: "111", gid: "555", role: "ADMIN", name: "Acme" }],
      ["group:666", "group/666", "Acme Shop", { kind: "group", uid: "111", gid: "666", role: "MODERATOR", name: "Acme Shop" }],
    ]);
    expect(accounts[0]!.auth).toEqual({ accessToken: ACCESS, refreshToken: "refresh-example", expiresAt: "2026-11-06T12:30:00.000Z", userId: "111" });
    const form = new URLSearchParams(String(fetchMock.mock.calls.find(([u]) => String(u) === TOKEN_URL)![1]!.body));
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "code1", client_id: "512000000001", client_secret: SECRET });
    expect(apiCalls("group.getInfo")[0]!.get("uids")).toBe("555,666");
  });

  it("still connects the user when group access is not granted (error 10)", async () => {
    on(TOKEN_URL, () => json({ access_token: ACCESS, expires_in: 1800 }));
    method("users.getCurrentUser", { uid: 111, name: "Ivan" });
    method("group.getUserGroupsV2", okErr(10, "PERMISSION_DENIED"));
    const accounts = await connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "r" });
    expect(accounts.map((a) => a.identity.externalId)).toEqual(["111"]);
  });

  it("refreshes with the refresh token and keeps it (OK does not rotate it)", async () => {
    on(TOKEN_URL, () => json({ access_token: "new-session", expires_in: 1800 }));
    const r = await connector().refreshAuth(groupAcct);
    expect(r!.auth).toEqual({ accessToken: "new-session", refreshToken: "refresh-example", expiresAt: "2026-11-06T12:30:00.000Z", userId: "111" });
    const form = new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));
    expect(form.get("grant_type")).toBe("refresh_token");
  });
});

describe("ok publish", () => {
  const input: PublishInput = { variantId: "v1", text: "Новая коллекция", media: [], thread: [], idempotencyKey: "k1" };

  it("posts text and a link as a group topic", async () => {
    method("mediatopic.post", json("123456789"));
    const c = connector();
    const r = await c.publish(groupAcct, { ...input, options: { link: "https://acme.example/new" } });
    expect(r).toMatchObject({ externalId: "123456789", url: "https://ok.ru/group/555/topic/123456789" });
    const p = apiCalls("mediatopic.post")[0]!;
    expect(p.get("type")).toBe("GROUP_THEME");
    expect(p.get("gid")).toBe("555");
    expect(JSON.parse(p.get("attachment")!)).toEqual({ media: [{ type: "text", text: "Новая коллекция" }, { type: "link", url: "https://acme.example/new" }] });
    // Idempotent on retry.
    await c.publish(groupAcct, { ...input, options: { link: "https://acme.example/new" } });
    expect(apiCalls("mediatopic.post")).toHaveLength(1);
  });

  it("uploads photos through photosV2 and attaches their tokens", async () => {
    let n = 0;
    method("photosV2.getUploadUrl", () => {
      n++;
      return json({ upload_url: `https://up.ok.example/photo${n}`, photo_ids: [`pid${n}`], expires_ms: 1 });
    });
    on("https://up.ok.example/photo", (url, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init!.body as FormData).get("pic1")).toBeInstanceOf(Blob);
      const id = url.endsWith("1") ? "pid1" : "pid2";
      return json({ photos: { [id]: { token: `token-${id}` } } });
    });
    method("mediatopic.post", json(42));
    const r = await connector().publish(userAcct, { ...input, media: [{ kind: "image", url: "https://media.example/a.jpg" }, { kind: "image", url: "https://media.example/b.jpg" }] });
    expect(r).toMatchObject({ externalId: "42", url: "https://ok.ru/profile/111/statuses/42" });
    expect(apiCalls("photosV2.getUploadUrl")[0]!.get("gid")).toBeNull();
    const p = apiCalls("mediatopic.post")[0]!;
    expect(p.get("type")).toBe("USER");
    expect(JSON.parse(p.get("attachment")!).media[1]).toEqual({ type: "photo", list: [{ id: "token-pid1" }, { id: "token-pid2" }] });
  });

  it("validates documents, threads and empty posts", () => {
    const c = connector();
    expect(c.validate(groupAcct, { ...input, text: "", media: [] }).map((i) => i.code)).toEqual(["empty"]);
    expect(c.validate(groupAcct, { ...input, thread: ["x"], media: [{ kind: "document", url: "https://m.example/a.pdf" }] }).map((i) => i.code)).toEqual(["unsupported_media", "thread_unsupported"]);
  });

  it("streams a 50 MB video in one multipart body, then video.update and a movie attachment", async () => {
    const SIZE = 50 * MiB;
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => {
      if (r.url.href === API) {
        const p = new URLSearchParams(r.text!);
        const m = p.get("method");
        if (m === "video.getUploadUrl") {
          expect(p.get("file_size")).toBe(String(SIZE));
          expect(p.get("gid")).toBe("555");
          return bigJson({ upload_url: "https://vu.ok.example/upload?id=9", video_id: 9001 });
        }
        if (m === "video.update") return bigJson(true);
        if (m === "mediatopic.post") return bigJson("777");
      }
      if (r.url.host === "vu.ok.example") return bigJson({});
      return undefined;
    });
    const c = new OkConnector({ clientId: "1", clientSecret: SECRET, applicationKey: APP_KEY, now: () => NOW });
    c.media = fetcher;
    const res = await c.publish(groupAcct, { ...input, idempotencyKey: "big", media: [media], options: { title: "Launch" } });
    expect(res.externalId).toBe("777");
    const up = sent.filter((r) => r.url.host === "vu.ok.example");
    expect(up).toHaveLength(1);
    expect(up[0]!.streamed).toBe(true);
    expect(up[0]!.fileParts).toEqual([{ name: "data", filename: "big.mp4", bytes: SIZE }]);
    expect(up[0]!.maxPiece).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
    const post = new URLSearchParams(sent.find((r) => r.text?.includes("method=mediatopic.post"))!.text!);
    expect(JSON.parse(post.get("attachment")!).media).toContainEqual({ type: "movie", list: [{ id: "9001" }] });
    const upd = new URLSearchParams(sent.find((r) => r.text?.includes("method=video.update"))!.text!);
    expect(upd.get("title")).toBe("Launch");
  });
});

describe("ok inbox", () => {
  it("reads comments on recent group topics, skipping the account's own and old ones", async () => {
    method("mediatopic.getTopics", { media_topics: [{ id: "100", discussion_summary: { comments_count: 3 } }, { id: "200", discussion_summary: { comments_count: 0 } }] });
    method("discussions.getComments", {
      comments: [
        { id: "c1", author_id: "900", text: "Когда доставка?", date: "2026-11-06 14:30:00" },
        { id: "c2", author_id: "555", text: "Завтра", date: "2026-11-06 14:40:00", reply_to_comment_id: "c1" },
        { id: "c3", author_id: "901", author_name: "Olga", text: "Спасибо", date_ms: Date.parse("2026-11-06T11:50:00Z"), reply_to_comment_id: "c2" },
        { id: "c0", author_id: "902", text: "old", date: "2026-11-01 10:00:00" },
      ],
      entities: { users: [{ uid: "900", name: "Petr" }] },
    });
    const items = await connector().fetchActivity(groupAcct, new Date("2026-11-05T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.authorHandle, i.authorName, i.parentExternalId, i.occurredAt])).toEqual([
      ["comment", "100:c1", "900", "Petr", "100", "2026-11-06T11:30:00.000Z"],
      ["comment", "100:c3", "901", "Olga", "100:c2", "2026-11-06T11:50:00.000Z"],
    ]);
    expect(items[0]!.url).toBe("https://ok.ru/group/555/topic/100");
    expect(apiCalls("discussions.getComments")).toHaveLength(1);
    expect(apiCalls("discussions.getComments")[0]!.get("discussionType")).toBe("GROUP_TOPIC");
  });

  it("replies to a comment as the group and deletes comments", async () => {
    method("discussions.comment", json("c9"));
    method("discussions.deleteComment", json(true));
    const c = connector();
    const r = await c.reply(groupAcct, { parentExternalId: "100:c1", text: "Завтра утром", idempotencyKey: "r1" });
    expect(r.externalId).toBe("100:c9");
    const p = apiCalls("discussions.comment")[0]!;
    expect(Object.fromEntries(p)).toMatchObject({ discussionId: "100", discussionType: "GROUP_TOPIC", comment: "Завтра утром", reply_to_comment_id: "c1", as_admin: "true" });
    await c.moderate(groupAcct, { externalId: "100:c1", action: "delete" });
    expect(Object.fromEntries(apiCalls("discussions.deleteComment")[0]!)).toMatchObject({ discussionId: "100", commentId: "c1" });
    expect((await rejection(c.moderate(groupAcct, { externalId: "100:c1", action: "hide" }))).kind).toBe("rejected");
    expect(() => parseOkRef("nope")).toThrow(ConnectorError);
  });
});

describe("ok metrics", () => {
  it("maps likes, reshares and comments per topic", async () => {
    method("mediatopic.getByIds", { media_topics: [{ id: "100", like_summary: { count: 10 }, reshare_summary: { count: 2 }, discussion_summary: { comments_count: 3 } }] });
    const rows = await connector().fetchMetrics(groupAcct, ["100", "not-a-topic"]);
    expect(rows.map((r) => [r.metric, r.value])).toEqual([["likes", 10], ["reposts", 2], ["replies", 3], ["engagements", 15]]);
    expect(apiCalls("mediatopic.getByIds")[0]!.get("topic_ids")).toBe("100");
  });

  it("reads group members as followers_total", async () => {
    method("group.getInfo", [{ uid: "555", members_count: 1234 }]);
    const c = connector();
    expect(await c.fetchAccountMetrics(groupAcct)).toEqual([{ entityType: "social_account", entityId: "acc-g", metric: "followers_total", value: 1234, observedAt: NOW.toISOString(), source: "ok" }]);
    expect(await c.fetchAccountMetrics(userAcct)).toEqual([]);
  });
});

describe("ok errors", () => {
  it("maps error codes to kinds", () => {
    expect(mapOkError({ error_code: 102, error_msg: "PARAM_SESSION_EXPIRED" }, "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapOkError({ error_code: 103 }, "x").kind).toBe("auth");
    expect(mapOkError({ error_code: 104, error_msg: "PARAM_SIGNATURE" }, "x").kind).toBe("auth");
    expect(mapOkError({ error_code: 10, error_msg: "PERMISSION_DENIED" }, "x")).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapOkError({ error_code: 8 }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapOkError({ error_code: 5000 }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapOkError({ error_code: 2 }, "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapOkError({ error_code: 100 }, "x").kind).toBe("rejected");
  });

  it("raises errors returned with HTTP 200 and HTTP failures", async () => {
    method("mediatopic.post", okErr(102, "PARAM_SESSION_EXPIRED"));
    const e = await rejection(connector().publish(groupAcct, { variantId: "v", text: "hi", media: [], thread: [], idempotencyKey: "e1" }));
    expect(e.kind).toBe("auth");
    expect(e.message).not.toContain(ACCESS);
    method("mediatopic.getByIds", () => new Response("bad gateway", { status: 502 }));
    expect((await rejection(connector().fetchMetrics(groupAcct, ["1"]))).kind).toBe("network");
  });

  it("refuses to call without the application key", async () => {
    const c = new OkConnector({ clientId: "1", clientSecret: SECRET });
    expect((await rejection(c.describeAccount(auth))).kind).toBe("auth");
  });

  it("reads OK comment times", () => {
    expect(okCommentTime({ date: "2026-01-01 03:00:00" })).toBe("2026-01-01T00:00:00.000Z");
    expect(okCommentTime({})).toBeNull();
  });
});
