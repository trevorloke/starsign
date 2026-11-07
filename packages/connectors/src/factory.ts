import { BlueskyConnector } from "./bluesky.ts";
import { MockConnector } from "./mock.ts";
import { ConnectorRegistry } from "./registry.ts";
import { XConnector } from "./x.ts";
import { ZernioConnector } from "./zernio.ts";
import { createMetaConnectors } from "./meta.ts";
import { createThreadsConnectors } from "./threads.ts";
import { createLinkedInConnectors } from "./linkedin.ts";
import { createPinterestConnectors } from "./pinterest.ts";
import { createYouTubeConnectors } from "./youtube.ts";
import { createGoogleBusinessConnectors } from "./google-business.ts";
import { createTikTokConnectors } from "./tiktok.ts";
import { createRedditConnectors } from "./reddit.ts";
import { createMastodonConnectors } from "./mastodon.ts";
import { createTelegramConnectors } from "./telegram.ts";
import { createDiscordConnectors } from "./discord.ts";
import { createDiscordBotConnectors } from "./discord-bot.ts";
import { createWhatsAppConnectors } from "./whatsapp.ts";
import { createWeChatConnectors } from "./wechat.ts";
import { createWeComConnectors } from "./wecom.ts";
import { createWeiboConnectors } from "./weibo.ts";
import { createDouyinConnectors } from "./douyin.ts";
import { createBandConnectors } from "./band.ts";
import { createZaloConnectors } from "./zalo.ts";
import { createViberConnectors } from "./viber.ts";
import { createOkConnectors } from "./ok.ts";
import { createLineConnectors } from "./line.ts";
import { createNostrConnectors } from "./nostr.ts";
import { createMisskeyConnectors } from "./misskey.ts";
import { createLemmyConnectors } from "./lemmy.ts";
import { createSlackConnectors } from "./slack.ts";
import { createMatrixConnectors } from "./matrix.ts";
import { createGoogleChatConnectors } from "./google-chat.ts";
import { createTeamsConnectors } from "./teams.ts";
import { createWordPressConnectors } from "./wordpress.ts";
import { createGhostConnectors } from "./ghost.ts";
import { createMailchimpConnectors } from "./mailchimp.ts";
import { createKitConnectors } from "./kit.ts";
import { createTumblrConnectors } from "./tumblr.ts";
import { createTwitchConnectors } from "./twitch.ts";
import { createVkConnectors } from "./vk.ts";
import { createWebhookConnectors } from "./webhook.ts";
import { createRssConnectors } from "./rss.ts";

/**
 * The registry a Starsign process boots with. Native adapters are always present (their credentials
 * live on each account, not in the environment); Zernio needs a workspace-wide API key, so it joins
 * only when ZERNIO_API_KEY is set; the mock joins outside production (or with STARSIGN_ENABLE_MOCK=1).
 * Env is injectable so tests and tools can build registries without touching process.env.
 */
export function createDefaultRegistry(env: NodeJS.ProcessEnv = process.env): ConnectorRegistry {
  const registry = new ConnectorRegistry()
    .register(new BlueskyConnector())
    .register(new XConnector({ clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET, ...(env.X_API_BASE_URL ? { baseUrl: env.X_API_BASE_URL } : {}) }));
  // Every native connector is registered; each reports connectConfigured=false until its app credentials exist,
  // so the room can show "Not set up on this server" instead of hiding the network.
  for (const make of [
    createMetaConnectors,
    createThreadsConnectors,
    createLinkedInConnectors,
    createPinterestConnectors,
    createYouTubeConnectors,
    createGoogleBusinessConnectors,
    createTikTokConnectors,
    createRedditConnectors,
    createMastodonConnectors,
    createTelegramConnectors,
    createDiscordConnectors,
    // Chat apps: monitoring group chats and messages to the business, through each platform's official API.
    createDiscordBotConnectors,
    createWhatsAppConnectors,
    createWeChatConnectors,
    createWeComConnectors,
    createLineConnectors,
    // Open networks, team chat, blogs and newsletters, more social and streaming, and the universal connectors.
    createNostrConnectors,
    createMisskeyConnectors,
    createLemmyConnectors,
    createSlackConnectors,
    createMatrixConnectors,
    createGoogleChatConnectors,
    createTeamsConnectors,
    createWordPressConnectors,
    createGhostConnectors,
    createMailchimpConnectors,
    createKitConnectors,
    createTumblrConnectors,
    createTwitchConnectors,
    createVkConnectors,
    // Chinese platforms with open APIs (Weibo, Douyin); WeChat and WeCom sit with the chat apps above.
    createWeiboConnectors,
    createDouyinConnectors,
    // Community networks in Korea (Naver Band), Vietnam (Zalo), Eastern Europe and the Middle East (Viber), Russia (OK.ru).
    createBandConnectors,
    createZaloConnectors,
    createViberConnectors,
    createOkConnectors,
    createWebhookConnectors,
    createRssConnectors,
  ]) {
    for (const c of make(env)) registry.register(c);
  }
  if (env.ZERNIO_API_KEY) registry.register(new ZernioConnector({ apiKey: env.ZERNIO_API_KEY, ...(env.ZERNIO_BASE_URL ? { baseUrl: env.ZERNIO_BASE_URL } : {}) }));
  // The mock never reaches production: a "published" post that touched no network would be a lie in the ledger.
  // Resolution is strict (by the account's connector name), so the mock only serves accounts that chose it.
  if (env.NODE_ENV !== "production" || env.STARSIGN_ENABLE_MOCK === "1") registry.register(new MockConnector());
  return registry;
}
