import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  DiscordBotConnector,
  DiscordConnector,
  LinkedInConnector,
  MastodonConnector,
  MatrixConnector,
  MetaConnector,
  MisskeyConnector,
  PinterestConnector,
  RedditConnector,
  SlackConnector,
  TelegramConnector,
  TikTokConnector,
  TumblrConnector,
  VkConnector,
  WordPressConnector,
  XConnector,
  YouTubeConnector,
  STREAM_PIECE_BYTES,
  type AccountRef,
  type PublishInput,
} from "../src/index.ts";
import { MiB, bigVideo, byteAt, json, network } from "./big-video.ts";

/**
 * A 50 MB video through every connector that uploads bytes: the fetcher's `fetch` is never called for it, no single
 * read is larger than the connector's chunk (or the stream piece for streamed bodies), and every byte arrives.
 */

const NOW = new Date("2026-11-03T18:00:00.000Z");
const SIZE = 50 * MiB;
const base: Omit<PublishInput, "media"> = { variantId: "v1", text: "Launch video", thread: [], idempotencyKey: "big1" };
const acct = (network: string, auth: Record<string, unknown>, config: Record<string, unknown> = {}, handle = "acme"): AccountRef =>
  ({ id: `acc-${network}`, workspaceId: "w", network, externalId: "ext", handle, auth, config }) as AccountRef;

afterEach(() => vi.unstubAllGlobals());

describe("chunked protocols read one chunk at a time", () => {
  it("x: APPEND segments come from ranged reads of chunkBytes each", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const appended: number[] = [];
    network((r) => {
      const p = r.url.pathname;
      if (p === "/2/media/upload/initialize") return json({ data: { id: "M1" } });
      if (p === "/2/media/upload/M1/append") {
        appended.push(r.fileParts[0]!.bytes);
        return json({});
      }
      if (p === "/2/media/upload/M1/finalize") return json({ data: { id: "M1" } });
      if (p === "/2/media/upload" && r.method === "GET") return json({ data: { processing_info: { state: "succeeded" } } });
      if (p === "/2/tweets") return json({ data: { id: "900" } }, 201);
      return undefined;
    });
    const c = new XConnector({ now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    const res = await c.publish(acct("x", { accessToken: "tok", refreshToken: "ref", userId: "123" }), { ...base, media: [media] });
    expect(res.externalId).toBe("900");
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(4 * MiB);
    expect(appended).toHaveLength(Math.ceil(SIZE / (4 * MiB)));
    expect(appended.reduce((a, b) => a + b, 0)).toBe(SIZE);
  });

  it("youtube: each resumable PUT reads one 8 MiB chunk and resumes from the 308 Range", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const puts: { range: string; sent: number }[] = [];
    network((r) => {
      if (r.url.pathname.endsWith("/videos") && r.url.searchParams.get("uploadType") === "resumable") return new Response(null, { status: 200, headers: { location: "https://upload.example/session1" } });
      if (r.url.href === "https://upload.example/session1" && r.method === "PUT") {
        const range = r.headers.get("content-range")!;
        puts.push({ range, sent: r.sent });
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)!;
        // Ask for part of the last chunk again once, as YouTube may.
        if (Number(m[2]) + 1 < Number(m[3])) return new Response(null, { status: 308, headers: { range: `bytes=0-${m[2]}` } });
        return json({ id: "vid1" });
      }
      if (r.url.pathname.endsWith("/youtube/v3/videos")) return json({ items: [{ id: "vid1", status: { uploadStatus: "processed", privacyStatus: "public" }, processingDetails: { processingStatus: "succeeded" } }] });
      return undefined;
    });
    const c = new YouTubeConnector({ clientId: "cid", clientSecret: "s", now: () => NOW, sleep: async () => {}, processingIntervalMs: 1 });
    c.media = fetcher;
    const yt = acct("youtube", { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-03T19:00:00.000Z", channelId: "UC" }, { channelId: "UC" });
    const res = await c.publish(yt, { ...base, media: [media], options: { title: "Big" } });
    expect(res.externalId).toBe("vid1");
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(8 * MiB);
    expect(puts).toHaveLength(Math.ceil(SIZE / (8 * MiB)));
    expect(puts[0]).toEqual({ range: `bytes 0-${8 * MiB - 1}/${SIZE}`, sent: 8 * MiB });
    expect(puts.reduce((a, p) => a + p.sent, 0)).toBe(SIZE);
  });

  it("linkedin: each part PUT reads exactly its byte range", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const PART = 4 * 1024 * 1024;
    const parts: number[] = [];
    network((r) => {
      const href = r.url.href;
      if (href.endsWith("/rest/videos?action=initializeUpload")) {
        const total = (JSON.parse(r.text!) as { initializeUploadRequest: { fileSizeBytes: number } }).initializeUploadRequest.fileSizeBytes;
        const uploadInstructions = Array.from({ length: Math.ceil(total / PART) }, (_, i) => ({ uploadUrl: `https://up.example/p${i}`, firstByte: i * PART, lastByte: Math.min(total, (i + 1) * PART) - 1 }));
        return json({ value: { video: "urn:li:video:V1", uploadToken: "", uploadInstructions } });
      }
      if (href.startsWith("https://up.example/")) {
        parts.push(r.sent);
        return new Response(null, { status: 200, headers: { etag: `e${parts.length}` } });
      }
      if (href.endsWith("/rest/videos?action=finalizeUpload")) return new Response(null, { status: 200 });
      if (r.url.pathname.startsWith("/rest/videos/")) return json({ status: "AVAILABLE" });
      if (r.url.pathname === "/rest/posts") return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
      return undefined;
    });
    const c = new LinkedInConnector({ clientId: "cid", clientSecret: "s", now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    const org = acct("linkedin", { accessToken: "tok", personUrn: "urn:li:person:abc" }, { authorUrn: "urn:li:organization:42", kind: "organization" });
    const res = await c.publish(org, { ...base, media: [media], options: { title: "Big" } });
    expect(res.externalId).toBe("urn:li:share:1");
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(PART);
    expect(parts).toHaveLength(Math.ceil(SIZE / PART));
    expect(parts.reduce((a, b) => a + b, 0)).toBe(SIZE);
  });

  it("tiktok: FILE_UPLOAD sends the one ≤64 MB chunk as a streamed body with Content-Range", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE, { stream: false });
    const ok = (data: unknown) => json({ data, error: { code: "ok", message: "", log_id: "l" } });
    const { sent } = network((r) => {
      const p = r.url.pathname;
      if (p.endsWith("creator_info/query/")) return ok({ creator_username: "acme", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], max_video_post_duration_sec: 600 });
      if (p.endsWith("video/init/")) return ok({ publish_id: "pub1", upload_url: "https://open-upload.tiktokapis.com/u" });
      if (r.url.host === "open-upload.tiktokapis.com") return new Response(null, { status: 201 });
      if (p.endsWith("status/fetch/")) return ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["73"] });
      return undefined;
    });
    const c = new TikTokConnector({ clientKey: "ck", clientSecret: "cs", now: () => NOW, sleep: async () => {}, videoSource: "FILE_UPLOAD" });
    c.media = fetcher;
    const tk = acct("tiktok", { accessToken: "tok", refreshToken: "rt", openId: "o1", expiresAt: "2026-11-04T00:00:00.000Z" });
    await c.publish(tk, { ...base, media: [media], options: { privacy: "public", allowComments: true } });
    const up = sent.filter((r) => r.url.host === "open-upload.tiktokapis.com");
    expect(up).toHaveLength(1);
    expect(up[0]!.headers.get("content-range")).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(up[0]!).toMatchObject({ streamed: true, sent: SIZE });
    expect(up[0]!.maxPiece).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
  });
});

/** The file parts of every streamed multipart request: one 50 MB part, sent with an exact Content-Length. */
function expectStreamedFile(sent: { streamed: boolean; fileParts: { bytes: number }[]; maxPiece: number }[]) {
  const streamed = sent.filter((r) => r.streamed);
  expect(streamed.length).toBeGreaterThan(0);
  const files = streamed.flatMap((r) => r.fileParts);
  expect(files.map((f) => f.bytes)).toContain(SIZE);
  for (const r of streamed) expect(r.maxPiece).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
}

describe("single-request uploads stream the body", () => {
  it("mastodon: POST /api/v2/media as a streamed multipart body", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => {
      if (r.url.pathname === "/api/v2/media") return json({ id: "m1", url: "https://files.example/m1.mp4" });
      if (r.url.pathname === "/api/v1/statuses") return json({ id: "s1", url: "https://mastodon.social/@acme/s1" });
      return undefined;
    });
    const c = new MastodonConnector({ now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    await c.publish(acct("mastodon", { accessToken: "tok", instance: "mastodon.social", accountId: "1" }, { instance: "mastodon.social" }), { ...base, media: [{ ...media, alt: "a clip" }] });
    const up = sent.filter((r) => r.url.pathname === "/api/v2/media");
    expect(up[0]!.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(up[0]!.fileParts).toEqual([{ name: "file", filename: "upload.mp4", bytes: SIZE }]);
    expectStreamedFile(sent);
    expect(stats.fetchCalls).toBe(0);
  });

  it("reddit: the S3 form POST streams the video; the poster image is read whole as before", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    let leases = 0;
    const lease = (id: string) =>
      json({ args: { action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com", fields: [{ name: "key", value: `rte_images/${id}.jpg` }, { name: "policy", value: "p" }] }, asset: { asset_id: id } });
    const { sent } = network((r) => {
      const p = r.url.pathname;
      if (p === "/api/media/asset.json") return lease(`a${++leases}`);
      if (r.url.host.startsWith("reddit-uploaded-media")) return new Response(`<PostResponse><Location>https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images%2Fa${leases}.jpg</Location></PostResponse>`, { status: 201 });
      if (p === "/api/submit") return json({ json: { errors: [], data: { websocket_url: "wss://ws.example/x" } } });
      if (p === "/user/acme/submitted") return json({ kind: "Listing", data: { after: null, children: [{ kind: "t3", data: { id: "p4", name: "t3_p4", title: "Big", subreddit: "starsign", created_utc: NOW.getTime() / 1000 } }] } });
      if (p === "/api/comment") return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c4", name: "t1_c4" } }] } } });
      return undefined;
    });
    const c = new RedditConnector({ clientId: "cid", clientSecret: "sec", userAgent: "web:starsign:0.1", now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    const rd = acct("reddit", { accessToken: "tok", refreshToken: "rt", userId: "t2_abc", username: "acme", expiresAt: "2026-11-04T01:00:00.000Z" });
    const res = await c.publish(rd, { ...base, media: [media], options: { subreddit: "starsign", title: "Big", thumbnailUrl: "https://media.example/poster.jpg" } });
    expect(res.externalId).toBe("t3_p4");
    const s3 = sent.filter((r) => r.url.host.startsWith("reddit-uploaded-media"));
    expect(s3).toHaveLength(2);
    expect(s3.filter((r) => r.streamed)).toHaveLength(1); // the video; the poster stays a FormData
    expectStreamedFile(sent);
    expect(stats.fetchCalls).toBe(0);
  });

  it("telegram: sendVideo uploads a streamed multipart body when the file is too big for a URL fetch", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => (r.url.pathname.endsWith("/sendVideo") ? json({ ok: true, result: { message_id: 5, chat: { id: -1001, type: "channel" }, date: 1 } }) : undefined));
    const c = new TelegramConnector({ now: () => NOW });
    c.media = fetcher;
    await c.publish(acct("telegram", { botToken: "123456789:AAEhBP0av28_test_token_abcdefghij" }, { chatId: "-1001", chatType: "channel", username: "acmenews", webhook: false }), { ...base, media: [media] });
    expect(sent[0]!.fileParts).toEqual([{ name: "video", filename: "big.mp4", bytes: SIZE }]);
    expectStreamedFile(sent);
    expect(stats.fetchCalls).toBe(0);
  });

  it("discord webhook and bot: files[0] streams inside the multipart body", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => (r.method === "POST" ? json({ id: "77", channel_id: "222" }) : undefined));
    const hook = new DiscordConnector();
    hook.media = fetcher;
    await hook.publish(acct("discord", { webhookUrl: "https://discord.com/api/v10/webhooks/1234567890123456789/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwxyzABCD" }, { webhookId: "1234567890123456789", guildId: "111", channelId: "222", threadId: null }), { ...base, media: [media] });
    const bot = new DiscordBotConnector({ now: () => NOW, sleep: async () => {} });
    bot.media = fetcher;
    await bot.publish(acct("discord", { botToken: [Buffer.from("123456789012345678").toString("base64url"), "GhAbCd", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("."), guildId: "111111111111111111" }, { guildId: "111111111111111111", botId: "999", defaultChannelId: "222222222222222222", channels: [{ id: "222222222222222222", name: "general", type: 0 }] }), { ...base, media: [media] });
    expect(sent.filter((r) => r.streamed)).toHaveLength(2);
    for (const r of sent) expect(r.fileParts).toEqual([{ name: "files[0]", filename: "big.mp4", bytes: SIZE }]);
    expectStreamedFile(sent);
    expect(stats.fetchCalls).toBe(0);
  });

  it("slack: the upload URL gets the raw file as a streamed body", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => {
      const p = r.url.pathname;
      if (p === "/api/files.getUploadURLExternal") return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F1" });
      if (r.url.host === "files.slack.com") return new Response("OK - 1", { status: 200 });
      if (p === "/api/files.completeUploadExternal") return json({ ok: true, files: [{ id: "F1", shares: { public: { C0GENERAL: [{ ts: "1.000100" }] } } }] });
      return undefined;
    });
    const c = new SlackConnector({ now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    await c.publish(acct("slack", { botToken: ["xoxb", "1111111111", "2222222222", "abcdefghijklmnopqrstuvwx"].join("-") }, { teamId: "T1", teamUrl: "https://acme.slack.com/", botUserId: "U0", channels: [], watchChannelIds: [], defaultChannelId: "C0GENERAL" }), { ...base, media: [media] });
    const get = sent.find((r) => r.url.pathname === "/api/files.getUploadURLExternal")!;
    expect(new URLSearchParams(get.text!).get("length")).toBe(String(SIZE));
    const up = sent.find((r) => r.url.host === "files.slack.com")!;
    expect(up).toMatchObject({ streamed: true, sent: SIZE });
    expect(up.maxPiece).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
    expect(stats.fetchCalls).toBe(0);
  });

  it("matrix: /_matrix/media/v3/upload gets a streamed body and the event carries the size", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => {
      if (r.url.pathname === "/_matrix/media/v3/upload") return json({ content_uri: "mxc://example.org/abc" });
      if (r.url.pathname.includes("/send/m.room.message/")) return json({ event_id: `$e${sent.length}` });
      return undefined;
    });
    const c = new MatrixConnector({ now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    const mx = acct("matrix", { homeserver: "https://matrix.example.org", accessToken: "syt_token_abcdefgh", userId: "@bot:example.org" }, { homeserver: "https://matrix.example.org", userId: "@bot:example.org", rooms: [{ id: "!room:example.org", alias: null, name: null, encrypted: false }], defaultRoomId: "!room:example.org" });
    await c.publish(mx, { ...base, media: [media] });
    const up = sent.find((r) => r.url.pathname === "/_matrix/media/v3/upload")!;
    expect(up).toMatchObject({ streamed: true, sent: SIZE });
    const event = sent.filter((r) => r.url.pathname.includes("/send/m.room.message/")).map((r) => JSON.parse(r.text!) as { msgtype: string; info?: { size: number } });
    expect(event.find((e) => e.msgtype === "m.video")?.info?.size).toBe(SIZE);
    expect(stats.fetchCalls).toBe(0);
  });

  it("misskey, tumblr, vk, wordpress and pinterest stream their video uploads", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => {
      const p = r.url.pathname;
      // misskey
      if (p === "/api/drive/files/create") return json({ id: "f1" });
      if (p === "/api/notes/create") return json({ createdNote: { id: "n1" } });
      // tumblr
      if (p === "/v2/blog/acme/posts") return json({ meta: { status: 201 }, response: { id_string: "t1" } }, 201);
      // vk
      if (p === "/method/video.save") return json({ response: { upload_url: "https://vu.vk.example/upload", video_id: 5, owner_id: -777 } });
      if (r.url.host === "vu.vk.example") return json({ video_id: 5, owner_id: -777 });
      if (p === "/method/wall.post") return json({ response: { post_id: 9 } });
      // wordpress
      if (p === "/wp-json/wp/v2/media") return json({ id: 31, source_url: "https://blog.example.com/wp-content/uploads/big.mp4" }, 201);
      if (p === "/wp-json/wp/v2/posts") return json({ id: 40, link: "https://blog.example.com/?p=40", status: "publish" }, 201);
      // pinterest
      if (p === "/v5/media" && r.method === "POST") return json({ media_id: "pm1", upload_url: "https://pinterest-media-upload.s3.amazonaws.com/", upload_parameters: { key: "uploads/pm1", policy: "p" } });
      if (r.url.host === "pinterest-media-upload.s3.amazonaws.com") return new Response(null, { status: 204 });
      if (p === "/v5/media/pm1") return json({ media_id: "pm1", status: "succeeded" });
      if (p === "/v5/pins") return json({ id: "pin1" }, 201);
      return undefined;
    });
    const mk = new MisskeyConnector({ now: () => NOW });
    const tb = new TumblrConnector({ clientId: "cid", clientSecret: "cs", now: () => NOW });
    const vk = new VkConnector({ clientId: "1", clientSecret: "s", now: () => NOW });
    const wp = new WordPressConnector({ now: () => NOW });
    const pin = new PinterestConnector({ clientId: "p", clientSecret: "s", now: () => NOW, sleep: async () => {} });
    for (const c of [mk, tb, vk, wp, pin]) c.media = fetcher;
    await mk.publish(acct("misskey", { token: "tok", host: "misskey.io", userId: "9" }, { host: "misskey.io" }), { ...base, media: [media] });
    await tb.publish(acct("tumblr", { accessToken: "tok", blogName: "acme", blogUuid: "t:u" }), { ...base, media: [media] });
    await vk.publish(acct("vk", { accessToken: "tok", userId: "42" }, { ownerId: -777, groupId: 777, kind: "group" }), { ...base, media: [media] });
    await wp.publish(acct("wordpress", { siteUrl: "https://blog.example.com", username: "ed", applicationPassword: "abcd efgh ijkl mnop qrst uvwx", restMode: "pretty" }, { siteUrl: "https://blog.example.com", userId: 7 }), { ...base, media: [media], options: { title: "Big" } });
    await pin.publish(acct("pinterest", { accessToken: "tok", username: "acme" }), { ...base, media: [media], options: { boardId: "b1", title: "Big", thumbnailUrl: "https://media.example/cover.jpg" } });

    const byHost = (pred: (u: URL) => boolean) => sent.filter((r) => pred(r.url));
    expect(byHost((u) => u.pathname === "/api/drive/files/create")[0]!.fileParts).toEqual([{ name: "file", filename: "upload.mp4", bytes: SIZE }]);
    expect(byHost((u) => u.pathname === "/v2/blog/acme/posts")[0]!.fileParts).toEqual([{ name: "json", filename: "blob", bytes: expect.any(Number) }, { name: "video0", filename: "video0.mp4", bytes: SIZE }]);
    expect(byHost((u) => u.host === "vu.vk.example")[0]!.fileParts).toEqual([{ name: "video_file", filename: "video.mp4", bytes: SIZE }]);
    expect(byHost((u) => u.pathname === "/wp-json/wp/v2/media")[0]!).toMatchObject({ streamed: true, sent: SIZE });
    expect(byHost((u) => u.host === "pinterest-media-upload.s3.amazonaws.com")[0]!.fileParts).toEqual([{ name: "file", filename: "video.mp4", bytes: SIZE }]);
    expectStreamedFile(sent);
    expect(stats.fetchCalls).toBe(0);
  });

  it("facebook: the resumable upload streams the bytes from file_offset", async () => {
    const { fetcher, stats, media } = bigVideo(SIZE);
    const { sent } = network((r) => {
      const p = r.url.pathname;
      if (p.endsWith("/app1/uploads")) return json({ id: "upload:sess1" });
      if (p.endsWith("/upload:sess1") && r.method === "POST") return json({ h: "handle-1" });
      if (p.endsWith("/P1/videos")) return json({ id: "vid9", post_id: "P1_9" });
      return undefined;
    });
    const c = new MetaConnector({ clientId: "app1", clientSecret: "secret", now: () => NOW, sleep: async () => {}, resumableThresholdBytes: 10 * MiB });
    c.media = fetcher;
    const fb = acct("facebook", { pageAccessToken: "PT", pageId: "P1", userAccessToken: "UT" }, { pageId: "P1" });
    await c.publish(fb, { ...base, media: [media], options: { kind: "video" } });
    const up = sent.find((r) => r.url.pathname.endsWith("/upload:sess1"))!;
    expect(up.headers.get("file_offset")).toBe("0");
    expect(up).toMatchObject({ streamed: true, sent: SIZE });
    expect(new URLSearchParams(sent.find((r) => r.url.pathname.endsWith("/app1/uploads"))!.url.search).get("file_length")).toBe(String(SIZE));
    expect(stats.fetchCalls).toBe(0);
    expect(stats.maxRead).toBeLessThanOrEqual(STREAM_PIECE_BYTES);
  });
});

describe("the bytes that arrive are the file's", () => {
  it("a streamed raw body carries every byte in order", async () => {
    const { fetcher, media } = bigVideo(3 * MiB + 123);
    let checked = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/_matrix/media/v3/upload") {
          const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            for (const b of r.value) if (b !== byteAt(checked++)) throw new Error(`byte ${checked - 1} differs`);
          }
          return json({ content_uri: "mxc://example.org/abc" });
        }
        return json({ event_id: "$e" });
      }),
    );
    const c = new MatrixConnector({ now: () => NOW, sleep: async () => {} });
    c.media = fetcher;
    await c.publish(acct("matrix", { homeserver: "https://m.example", accessToken: "syt_token_abcdefgh", userId: "@b:m.example" }, { homeserver: "https://m.example", userId: "@b:m.example", rooms: [], defaultRoomId: "!r:m.example" }), { ...base, media: [media] });
    expect(checked).toBe(3 * MiB + 123);
  });
});
