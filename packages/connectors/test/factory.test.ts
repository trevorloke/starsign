import { describe, expect, it, vi } from "vitest";
import { BlueskyConnector, IdempotencyCache, MockConnector, XConnector, ZernioConnector, createDefaultRegistry } from "../src/index.ts";

describe("createDefaultRegistry", () => {
  it("registers the native adapters, the mock outside production, and resolves strictly by connector name", () => {
    const reg = createDefaultRegistry({});
    expect(reg.list().map((c) => c.name)).toEqual(["bluesky", "x", "meta", "threads", "linkedin", "pinterest", "youtube", "google_business", "tiktok", "reddit", "mastodon", "telegram", "discord", "discord_bot", "whatsapp", "wechat", "wecom", "line", "nostr", "misskey", "lemmy", "slack", "matrix", "google_chat", "teams", "wordpress", "ghost", "mailchimp", "kit", "tumblr", "twitch", "vk", "weibo", "douyin", "band", "zalo", "viber", "ok", "webhook", "rss", "mock"]);
    expect(reg.get("bluesky")).toBeInstanceOf(BlueskyConnector);
    expect(reg.get("x")).toBeInstanceOf(XConnector);
    expect(reg.get("mock")).toBeInstanceOf(MockConnector);
    expect(reg.get("zernio")).toBeUndefined();
    // Unknown connector names never silently fall back to another adapter.
    expect(() => reg.resolve("legacy", "x")).toThrow(/not configured/);
    expect(() => reg.resolve("bluesky", "x")).toThrow(/does not serve/);
    expect(reg.resolve("x", "x").name).toBe("x");
    expect(reg.resolve("mock", "x").name).toBe("mock");
    expect(createDefaultRegistry({ NODE_ENV: "production" }).get("mock")).toBeUndefined();
    expect(createDefaultRegistry({ NODE_ENV: "production", STARSIGN_ENABLE_MOCK: "1" }).get("mock")).toBeInstanceOf(MockConnector);
  });

  it("serves every network except news natively and reports unconfigured apps instead of hiding them", () => {
    const reg = createDefaultRegistry({ NODE_ENV: "production" });
    const networks = new Set(reg.list().flatMap((c) => [...c.networks]));
    for (const n of ["x", "bluesky", "threads", "instagram", "facebook", "linkedin", "tiktok", "youtube", "pinterest", "mastodon", "reddit", "google_business", "telegram", "discord", "whatsapp", "wechat", "wecom", "line", "nostr", "misskey", "lemmy", "tumblr", "vk", "twitch", "weibo", "douyin", "wecom", "band", "zalo", "viber", "ok", "slack", "matrix", "google_chat", "teams", "wordpress", "ghost", "mailchimp", "kit", "webhook", "rss"]) {
      expect(networks.has(n as never), n).toBe(true);
    }
    // OAuth apps without credentials say so; open networks are always connectable.
    expect(reg.get("meta")?.connectConfigured).toBe(false);
    expect(reg.get("youtube")?.connectConfigured).toBe(false);
    expect(reg.get("mastodon")?.connectConfigured).not.toBe(false);
    expect(createDefaultRegistry({ META_CLIENT_ID: "a", META_CLIENT_SECRET: "b" }).get("meta")?.connectConfigured).toBe(true);
    // WhatsApp cannot verify a single delivery without the Meta app secret.
    expect(reg.get("whatsapp")?.connectConfigured).toBe(false);
    expect(createDefaultRegistry({ WHATSAPP_APP_SECRET: "s" }).get("whatsapp")?.connectConfigured).toBe(true);
    // Two Discord connectors: posting through a webhook, and the bot that reads servers.
    expect(reg.list().filter((c) => c.networks.includes("discord")).map((c) => c.name)).toEqual(["discord", "discord_bot"]);
  });

  it("adds Zernio only when ZERNIO_API_KEY is set", () => {
    const reg = createDefaultRegistry({ ZERNIO_API_KEY: "zk", X_CLIENT_ID: "cid", X_CLIENT_SECRET: "sec" });
    expect(reg.list().map((c) => c.name)).toEqual(["bluesky", "x", "meta", "threads", "linkedin", "pinterest", "youtube", "google_business", "tiktok", "reddit", "mastodon", "telegram", "discord", "discord_bot", "whatsapp", "wechat", "wecom", "line", "nostr", "misskey", "lemmy", "slack", "matrix", "google_chat", "teams", "wordpress", "ghost", "mailchimp", "kit", "tumblr", "twitch", "vk", "weibo", "douyin", "band", "zalo", "viber", "ok", "webhook", "rss", "zernio", "mock"]);
    expect(reg.get("zernio")).toBeInstanceOf(ZernioConnector);
    expect(reg.resolve("zernio", "tiktok").name).toBe("zernio");
    expect(reg.get("x")?.capabilities("x")).toMatchObject({ meteredReads: true });
    expect(reg.get("zernio")?.capabilities("tiktok")).toMatchObject({ meteredReads: false });
  });
});

describe("IdempotencyCache", () => {
  it("runs work once per key, coalesces concurrent calls and forgets failures", async () => {
    const cache = new IdempotencyCache<string>();
    const work = vi.fn(async () => "r1");
    const [a, b] = await Promise.all([cache.run("k", work), cache.run("k", work)]);
    expect(a).toBe("r1");
    expect(b).toBe("r1");
    expect(await cache.run("k", work)).toBe("r1");
    expect(work).toHaveBeenCalledTimes(1);
    expect(cache.peek("k")).toBe("r1");

    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(cache.run("f", failing)).rejects.toThrow("boom");
    expect(cache.peek("f")).toBeUndefined();
    await expect(cache.run("f", failing)).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past maxEntries", async () => {
    const cache = new IdempotencyCache<number>(2);
    await cache.run("a", async () => 1);
    await cache.run("b", async () => 2);
    await cache.run("c", async () => 3);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBe(2);
    expect(cache.peek("c")).toBe(3);
  });
});
