# Chinese platforms: what Starsign can and cannot connect

Starsign connects to Chinese platforms only through their official open APIs. Several large platforms do not offer
one to outside tools, or offer it only to approved partners. This page says plainly which ones, what Starsign does
instead, and what it would take to add them. It reflects what we could find as of November 2026; the platforms'
developer sites were not reachable from the build sandbox, so treat the details as a starting point to confirm.

Starsign does not use unofficial methods (logging in as a person, browser automation, scraping the app's private
API, "third-party data API" resellers). They break the platforms' terms, get accounts restricted or banned, and in
China can also raise legal problems under the Personal Information Protection Law (PIPL) and anti-unfair-competition
rules.

## Connected

| Platform | Connector | What it does | Doc |
|---|---|---|---|
| Weibo (微博) | `weibo` | Posts with a link to your security domain (+1 picture), comments and @mentions inbox, reply, delete comments, metrics, followers | weibo.md |
| Douyin (抖音) | `douyin` | Video and picture posts, comments on your recent videos, reply, video metrics, fans | douyin.md |
| WeChat Official Account (公众号) | `wechat` | Messages people send to the account, customer-service replies, followers | wechat.md |

Douyin is not TikTok; TikTok is the `tiktok` connector.

## Not connectable today

| Platform | Why | What Starsign does instead | What it would take |
|---|---|---|---|
| **Xiaohongshu (小红书 / RED)** | No open API for posting notes, reading comments or monitoring mentions for third-party tools. Its open platforms cover e-commerce sellers (orders, products) and advertising/brand-partner tools (蒲公英 creator collaborations, 聚光 ads), not organic posting or inbox. | Public mentions that reach news coverage come in through the tracker (GDELT, Chinese-language news) and RSS. The owner publishes natively in the Xiaohongshu app and can paste the note link into Starsign to track it as an external post. | Xiaohongshu would have to open a posting/comments API to tools like Starsign, or grant partner access. If your brand has a Xiaohongshu account manager, ask whether any API (e.g. for brand accounts or agencies) is available and on what terms. |
| **WeChat Channels (视频号)** | No open API for outside apps to publish videos or read comments. Publishing happens in the WeChat app or the Channels assistant (视频号助手) web console. Channels APIs that exist cover shops and live-commerce, not posting. | The WeChat Official Account connector covers messages to your Official Account. Channels videos are posted natively. | An official publishing/comment API from WeChat. Nothing to apply for today. |
| **Bilibili (哔哩哔哩)** | Has an open platform (openhome.bilibili.com) with server-side video submission (upload, chunked upload, cover, submit) and data APIs, but it is for approved partner/enterprise apps. | Nothing automatic; mentions in news reach the tracker. | A mainland enterprise developer account, an app approved for video submission and data capabilities, then a connector like Douyin's (OAuth, chunked upload, submit, poll review, comments if granted). Tell us if you get approval. |
| **Kuaishou (快手)** | Has an open platform (open.kuaishou.com) with video publishing and data capabilities, granted to reviewed partner apps only. | Same as above. | A mainland enterprise developer account and approved publishing/data capabilities; then a connector similar to Douyin's. |
| **Zhihu (知乎)** | No public API for posting answers/articles or monitoring mentions; its paid promotion (知+) is a separate ad product. | Mentions that reach news coverage come through the tracker. | An official API or partner arrangement with Zhihu. |
| **Baidu Tieba (百度贴吧)** | No open API for posting or reading threads for third-party tools. | Same. | An official API from Baidu. |

## How Chinese-language mentions are still caught

- **News in Chinese (GDELT)**: the tracker's public scan uses GDELT, which indexes news in 65+ languages including
  Chinese and also matches machine translations, so an English brand name can find Chinese articles. Add the Chinese
  brand name (e.g. 艾克米) as a tracked name or keyword as well. Items arrive with `lang: "zh"`.
- **RSS feeds of Chinese news sites**: add the feed URLs with the `rss` connector (the site's RSS or Atom feed, or a
  site URL that advertises one). Many Chinese outlets no longer publish feeds; self-hosted feed generators exist
  (RSSHub, for example) but they read public web pages, can break without notice and may conflict with a site's
  terms, so Starsign does not run them for you. Point Starsign at one only if you have checked that.
- **WeChat Official Account messages**: everything people send to your Official Account (wechat.md).
- **Weibo**: comments on your posts and @mentions in posts and comments (weibo.md). Keyword search across Weibo is
  not available (partner-only).
- **Douyin**: comments on your own recent videos, if Douyin grants the comment capability (douyin.md).

## Mainland-China realities

- **Developer accounts**: Weibo, Douyin, Bilibili and Kuaishou developer accounts effectively require a
  mainland-China entity (business licence) and a mainland phone number; capability reviews look for a real business
  use and often an ICP-filed website.
- **ICP filing (ICP 备案)**: any website or server hosted in mainland China needs one for its domain. Platforms often
  ask for an ICP-filed website when reviewing an app, even if Starsign itself runs elsewhere.
- **Network reachability**: `api.weibo.com`, `open.douyin.com` and `api.weixin.qq.com` are served from mainland
  China. From outside China they are usually reachable but latency varies and some requests from overseas IPs are
  slow or refused; WeChat also requires fixed outbound IPs on a whitelist. Running Starsign's China traffic from a Hong
  Kong or mainland region (or through a fixed egress there) is the reliable setup. The build sandbox could not reach
  these platforms' doc sites at all, which is why the connectors are tested against documented shapes only.
- **Data residency and PIPL**: comments, nicknames and ids read from these platforms are personal information of
  people in China. PIPL limits cross-border transfer (security assessment, standard contract or certification,
  depending on volume), and the platforms' developer terms restrict storing and reusing their data. Keep only what
  the inbox and metrics need, set a retention period, and get legal advice before storing large volumes outside China.
- **Content review**: every post on Weibo and Douyin goes through the platform's content review; a post can be
  accepted by the API and then hidden or limited. Starsign reports review refusals as `rejected`.

## Questions for the owner

- Which Chinese platforms matter most for you, and on which do you have business accounts (企业号 / 蓝V)?
- Do you have, or will you create, a mainland-China entity for developer accounts and app reviews?
- Do you have contacts at Xiaohongshu, Bilibili or Kuaishou who could grant API or partner access?
- Which Chinese news sites should the tracker follow by RSS, and what are your brand's Chinese names and keywords?
- Where should Starsign run for China traffic, and what is your position on storing Chinese users' data outside China?
