# KakaoTalk (카카오톡)

There is **no KakaoTalk connector**, and this page explains why and what Starsign does for Korean audiences instead.

## What cannot be done through any official API
- **KakaoTalk chats and open chats (오픈채팅)** cannot be read or posted to by a third-party service. Kakao offers no API for
  group chats or open chats, and the tools that try (automating the PC client, reading its database, unofficial bots) break
  Kakao's terms and get accounts suspended. Starsign does not use them.
- **Kakao Talk Channel (카카오톡 채널) posts** (the channel's feed, "소식") have no publishing API. They are written in the Kakao
  Talk Channel admin center by hand.
- **Kakao Talk Channel 1:1 chat** has no open API to read or answer messages from outside Kakao's own admin tools and its
  chatbot builder (카카오 i 오픈빌더), which is a separate product with its own approval.
- Kakao Login and the "send to me / send to friends" messaging APIs are for apps acting for one user (and sending to friends is
  limited to approved partner apps); they are not a way to run a brand's presence.

## What is possible later, as a separate feature
Kakao's business messages, **알림톡 (AlimTalk)** for transactional notices and **친구톡 / 브랜드 메시지** for marketing messages
to people who added the channel, are sent through registered official dealers (공식 딜러사, e.g. NHN Cloud, Kakao i Connect
Message, and others). They need a business-verified Kakao Talk Channel, message templates approved by Kakao in advance (for
AlimTalk), and they cost money per message. They are one-way notifications, not conversations. If you want them, they belong in
a separate "business messaging" feature with a dealer contract, not in the social inbox.

## What Starsign does for Korean audiences instead
- **Naver Band** (`band`): publish to the bands you belong to, and read members' posts and comments. See `band.md`.
- **Instagram**, **YouTube**, **Threads** and **X**: publishing, comments and metrics, all widely used in Korea.
- **News and RSS in Korean**: the tracker and the radar read Korean-language news sites and blogs through RSS (Naver blogs and
  Tistory publish feeds).
- **The tracker** follows mentions of your names across the networks above, with Korean keywords and translations
  ("expand to languages").
- **AI answer visibility in Korean**: sample Korean prompts to see whether AI assistants mention and cite you.

## Questions for the owner
- Do clients need AlimTalk or brand messages? If so, which dealer do they already use, and is it worth a separate feature?
- Is a Kakao Talk Channel chatbot (Open Builder) in scope? It would be a separate integration with Kakao's own review.
