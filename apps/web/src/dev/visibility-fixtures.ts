/**
 * The fixture "server" for AI answer visibility (VITE_USE_FIXTURES=1): three engines configured, five questions in
 * English, Japanese, Spanish and Korean, and four months of answers in which Northwind Coffee slowly gains ground.
 * Everything is generated from a seed, so the screens look the same on every load.
 */
import type { Entity, Role } from "../types";
import { ApiError } from "../lib/errors";
import type {
  VisAgg,
  VisAnswer,
  VisAnswersQuery,
  VisCitation,
  VisEngine,
  VisEntityRow,
  VisMention,
  VisPrompt,
  VisPromptInput,
  VisReport,
  VisRunResult,
  VisSettings,
  VisSettingsPatch,
  VisSettingsResponse,
  VisSuggestion,
} from "../lib/visibility";

export interface VisibilityFixtureContext {
  role: () => Role | null;
  entities: () => Entity[];
}

const DAY = 86_400_000;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const wait = <T,>(v: T, ms = 160) => new Promise<T>((r) => setTimeout(() => r(clone(v)), ms));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: string) {
  let a = hash(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ENGINES: VisEngine[] = [
  { id: "anthropic", label: "Claude", configured: true, enabled: true, envVar: "ANTHROPIC_API_KEY", modelEnvVar: "STARSIGN_MODEL", model: "claude-opus-5-5", priced: true },
  { id: "openai", label: "ChatGPT", configured: true, enabled: true, envVar: "OPENAI_API_KEY", modelEnvVar: "OPENAI_ANSWER_MODEL", model: "gpt-5", priced: false },
  { id: "perplexity", label: "Perplexity", configured: true, enabled: true, envVar: "PERPLEXITY_API_KEY", modelEnvVar: "PERPLEXITY_ANSWER_MODEL", model: "sonar", priced: false },
  { id: "gemini", label: "Gemini", configured: false, enabled: false, envVar: "GEMINI_API_KEY", modelEnvVar: "GEMINI_ANSWER_MODEL", model: "gemini-2.5-flash", priced: false },
];

type Lang = "en" | "ja" | "es" | "ko";
interface Blurb {
  text: Record<Lang, string>;
  tone: number;
  summary: string;
  flag?: string;
}

const NAMES: Record<string, Partial<Record<Lang, string>> & { en: string }> = {
  ent_northwind: { en: "Northwind Coffee", ja: "ノースウィンド", ko: "Northwind Coffee" },
  ent_bluebottle: { en: "Blue Bottle", ja: "ブルーボトル", ko: "블루보틀" },
  ent_stumptown: { en: "Stumptown" },
  ent_fern: { en: "Little Fern Tea" },
  ent_ana: { en: "Ana Ruiz", ja: "アナ・ルイス" },
};

const BLURBS: Record<string, Blurb[]> = {
  ent_northwind: [
    { tone: 0.72, summary: "Recommended for ethically sourced, small-batch beans", text: { en: "known for ethically sourced, small-batch beans and for publishing what it pays farmers", ja: "倫理的に調達した少量焙煎の豆で知られる人気店", es: "conocida por su café de origen ético y tostado en pequeños lotes", ko: "윤리적으로 조달한 소량 로스팅 원두로 유명합니다" } },
    { tone: 0.55, summary: "A local favourite with a strong cold brew", text: { en: "a local favourite with a strong cold brew", ja: "コールドブリューが評判の地元の人気店", es: "una favorita local con un cold brew excelente", ko: "콜드브루가 인기 있는 동네 맛집입니다" } },
    { tone: 0.05, summary: "Listed as a smaller roaster with one café", text: { en: "a smaller roaster with a café in Mount Pleasant", ja: "マウントプレザントにカフェがある小さな焙煎所", es: "un tostador pequeño con un café en Mount Pleasant", ko: "마운트 플레전트에 카페가 있는 작은 로스터리입니다" } },
    { tone: -0.35, summary: "Good beans, but called pricier than most", text: { en: "good beans, though several reviewers find it pricier than most", ja: "豆は良いが、価格が高めという声もある", es: "buen café, aunque varias reseñas lo consideran caro", ko: "원두는 좋지만 가격이 비싸다는 평도 있습니다" } },
    { tone: -0.15, summary: "Says the Tokyo shop has closed", flag: "Says the Tokyo shop closed; the brand profile says it is open in Shibuya.", text: { en: "a Vancouver roaster that closed its Tokyo shop last year", ja: "東京店は昨年閉店したバンクーバーの焙煎所", es: "un tostador de Vancouver que cerró su tienda de Tokio", ko: "작년에 도쿄 매장을 닫은 밴쿠버 로스터리입니다" } },
  ],
  ent_bluebottle: [
    { tone: 0.48, summary: "Praised for polished cafés and consistent espresso", text: { en: "polished cafés and consistent espresso", ja: "洗練されたカフェと安定したエスプレッソ", es: "cafés cuidados y un espresso constante", ko: "세련된 카페와 안정적인 에스프레소" } },
    { tone: -0.3, summary: "Called a chain that lost its small-batch feel", text: { en: "widely known, though some say it lost its small-batch feel", ja: "有名だが、小規模ならではの良さは薄れたという声も", es: "muy conocida, aunque algunos dicen que perdió su esencia artesanal", ko: "유명하지만 소규모 특유의 매력은 줄었다는 의견도 있습니다" } },
  ],
  ent_stumptown: [
    { tone: 0.2, summary: "Listed for cold brew in cans, sold widely", text: { en: "cold brew in cans that is easy to find in grocery stores", ja: "スーパーで買える缶のコールドブリュー", es: "cold brew en lata fácil de encontrar en supermercados", ko: "마트에서 쉽게 살 수 있는 캔 콜드브루" } },
    { tone: 0.0, summary: "Mentioned as a Portland roaster", text: { en: "a Portland roaster with cafés in several cities", ja: "複数の都市にカフェがあるポートランドの焙煎所", es: "un tostador de Portland con cafés en varias ciudades", ko: "여러 도시에 카페가 있는 포틀랜드 로스터리" } },
  ],
  ent_fern: [{ tone: 0.4, summary: "Suggested for hojicha instead of coffee", text: { en: "a tea shop with excellent hojicha, if you want something other than coffee", ja: "コーヒー以外ならほうじ茶がおいしいお茶の店", es: "una tienda de té con un hojicha excelente", ko: "커피 대신이라면 호지차가 훌륭한 찻집" } }],
};

const FILLERS: Record<Lang, string[]> = {
  en: ["Harbour Street Roasters — bright, light roasts", "Kettle & Kiln — good pour-over bar", "Seawall Coffee Co. — easy stop on a walk"],
  ja: ["ハーバーストリート・ロースターズ：浅煎りが得意", "ケトル＆キルン：ハンドドリップが人気"],
  es: ["Harbour Street Roasters — tuestes claros", "Kettle & Kiln — buen café de filtro"],
  ko: ["Harbour Street Roasters — 라이트 로스팅", "Kettle & Kiln — 핸드드립 바"],
};

const INTRO: Record<string, Record<Lang, string>> = {
  list: { en: "Here are a few places people often recommend:", ja: "よく名前が挙がるのは次のお店です。", es: "Estas son algunas opciones que suelen recomendarse:", ko: "자주 추천되는 곳은 다음과 같습니다:" },
  ethics: { en: "On sourcing, here is what reviews and the companies themselves say:", ja: "調達については、レビューと各社の説明によると：", es: "Sobre el abastecimiento, esto dicen las reseñas y las propias empresas:", ko: "원두 조달에 대해 리뷰와 회사의 설명은 다음과 같습니다:" },
  versus: { en: "Both are good; it depends on what you value:", ja: "どちらも良い店ですが、何を重視するかによります。", es: "Ambas son buenas; depende de lo que valores:", ko: "둘 다 좋지만 무엇을 중시하느냐에 따라 다릅니다:" },
};
const OUTRO: Record<Lang, string> = {
  en: "Hours and prices change, so check before you go.",
  ja: "営業時間や価格は変わることがあるので、行く前に確認してください。",
  es: "Los horarios y precios cambian; confirma antes de ir.",
  ko: "영업시간과 가격은 바뀔 수 있으니 방문 전에 확인하세요.",
};

const SOURCES: { url: string; title: string; lang: Lang | "any"; owner: string | null }[] = [
  { url: "https://northwind.coffee/sourcing", title: "How we buy coffee — Northwind", lang: "any", owner: "ent_northwind" },
  { url: "https://northwind.coffee/about", title: "About Northwind Coffee", lang: "any", owner: "ent_northwind" },
  { url: "https://bluebottlecoffee.com/cafes", title: "Blue Bottle cafés", lang: "en", owner: "ent_bluebottle" },
  { url: "https://bluebottlecoffee.jp/cafes", title: "ブルーボトルコーヒー", lang: "ja", owner: "ent_bluebottle" },
  { url: "https://www.eater.com/maps/best-coffee-vancouver", title: "The best coffee in Vancouver — Eater", lang: "en", owner: null },
  { url: "https://dailyhive.com/vancouver/best-coffee-shops", title: "Daily Hive: coffee shops", lang: "en", owner: null },
  { url: "https://www.reddit.com/r/vancouver/comments/coffee", title: "r/vancouver: where to get beans?", lang: "en", owner: null },
  { url: "https://sprudge.com/roasters", title: "Sprudge", lang: "any", owner: null },
  { url: "https://www.yelp.ca/search?find_desc=coffee+roasters", title: "Yelp", lang: "en", owner: null },
  { url: "https://tabelog.com/coffee/vancouver", title: "食べログ", lang: "ja", owner: null },
  { url: "https://www.timeout.com/vancouver/coffee", title: "Time Out Vancouver", lang: "en", owner: null },
  { url: "https://www.eltiempo.com/viajes/cafe-vancouver", title: "El Tiempo", lang: "es", owner: null },
  { url: "https://www.mangoplate.com/vancouver", title: "망고플레이트", lang: "ko", owner: null },
];

const PROMPTS_SEED: Omit<VisPrompt, "due" | "lastRunAt" | "lastSlot">[] = [
  { id: "vqp_roasters", question: "Best independent coffee roasters in Vancouver", translations: { ja: "バンクーバーでおすすめの独立系コーヒーロースターは？" }, languages: ["en", "ja"], regions: ["CA"], entityIds: [], cadence: "weekly", notes: null, createdAt: "", updatedAt: "", archivedAt: null },
  { id: "vqp_ethical", question: "Is Northwind Coffee ethical?", translations: {}, languages: ["en"], regions: [], entityIds: [], cadence: "daily", notes: "The sourcing page launched in October.", createdAt: "", updatedAt: "", archivedAt: null },
  { id: "vqp_coldbrew", question: "Where can I buy good cold brew online in Canada?", translations: { es: "¿Dónde comprar buen cold brew en línea en Canadá?" }, languages: ["en", "es"], regions: ["CA"], entityIds: [], cadence: "weekly", notes: null, createdAt: "", updatedAt: "", archivedAt: null },
  { id: "vqp_versus", question: "Northwind Coffee or Blue Bottle: which is better?", translations: { ko: "Northwind Coffee와 블루보틀 중 어디가 더 나아요?" }, languages: ["en", "ko"], regions: [], entityIds: ["ent_northwind", "ent_bluebottle", "ent_ana"], cadence: "weekly", notes: null, createdAt: "", updatedAt: "", archivedAt: null },
  { id: "vqp_tokyo", question: "東京で買えるカナダのコーヒー豆は？", translations: {}, languages: ["ja"], regions: ["JP"], entityIds: [], cadence: "weekly", notes: "Shibuya opening.", createdAt: "", updatedAt: "", archivedAt: null },
];

/** How likely each engine is to name each brand, how that changes over the 120 days, and where it tends to rank. */
function mentionChance(entityId: string, promptId: string, engine: string, lang: Lang, progress: number): number {
  if (promptId === "vqp_ethical" && entityId === "ent_northwind") return 1;
  if (promptId === "vqp_versus" && (entityId === "ent_northwind" || entityId === "ent_bluebottle")) return 1;
  if (entityId === "ent_northwind") {
    const base = { anthropic: 0.5, openai: 0.34, perplexity: 0.58 }[engine] ?? 0.4;
    const gain = { anthropic: 0.24, openai: 0.12, perplexity: 0.14 }[engine] ?? 0.1;
    return Math.min(0.95, (base + gain * progress) * (lang === "ja" ? 0.8 : lang === "ko" ? 0.7 : 1));
  }
  if (entityId === "ent_bluebottle") return lang === "ja" || lang === "ko" ? 0.82 : 0.68 - 0.06 * progress;
  if (entityId === "ent_stumptown") return promptId === "vqp_coldbrew" ? 0.75 : 0.42;
  if (entityId === "ent_fern") return promptId === "vqp_roasters" ? 0.06 : 0.02;
  return 0;
}

function slotsFor(cadence: "daily" | "weekly", start: number, end: number): number[] {
  const out: number[] = [];
  const step = cadence === "daily" ? DAY : 7 * DAY;
  for (let t = end - 2 * 3_600_000; t >= start; t -= step) out.push(t);
  return out.reverse();
}

export function createVisibilityFixtures(ctx: VisibilityFixtureContext) {
  const now = Date.now();
  const SPAN = 120 * DAY;
  let seq = 0;
  const settings: VisSettings = { engines: null, cadences: ["daily", "weekly"], maxPrompts: 20, domains: { ent_northwind: ["northwind.coffee"], ent_bluebottle: ["bluebottlecoffee.com", "bluebottlecoffee.jp"] } };
  const prompts: VisPrompt[] = PROMPTS_SEED.map((p, i) => ({ ...p, createdAt: new Date(now - SPAN - i * DAY).toISOString(), updatedAt: new Date(now - SPAN).toISOString(), due: false, lastRunAt: null, lastSlot: null }));
  let answers: VisAnswer[] | null = null;

  const liveEntities = () => ctx.entities().filter((e) => !e.archivedAt);
  const nameIn = (id: string, lang: Lang, fallback: string) => NAMES[id]?.[lang] ?? NAMES[id]?.en ?? fallback;

  function compose(prompt: VisPrompt, engine: string, lang: Lang, at: number, seed: string): VisAnswer {
    const r = rng(seed);
    const progress = Math.max(0, Math.min(1, 1 - (now - at) / SPAN));
    const all = liveEntities();
    const scope = prompt.entityIds.length ? all.filter((e) => prompt.entityIds.includes(e.id)) : all;
    const orgs = ["ent_northwind", "ent_bluebottle", "ent_stumptown", "ent_fern"].filter((id) => scope.some((e) => e.id === id));
    const picked = orgs.filter((id) => r() < mentionChance(id, prompt.id, engine, lang, progress));
    // Order: a noisy rank where Northwind drifts up over time.
    const weight = (id: string) => (id === "ent_northwind" ? 0.35 + 0.45 * progress : id === "ent_bluebottle" ? 0.62 : id === "ent_stumptown" ? 0.4 : 0.1) + r() * 0.5;
    const order = picked.map((id) => ({ id, w: weight(id) })).sort((a, b) => b.w - a.w).map((x) => x.id);
    const fillers = FILLERS[lang].filter(() => r() < 0.55);
    const intro = INTRO[prompt.id === "vqp_ethical" ? "ethics" : prompt.id === "vqp_versus" ? "versus" : "list"]![lang];
    const lines: string[] = [];
    const chosen = new Map<string, Blurb>();
    let n = 0;
    let anaNamed = false;
    for (const id of order) {
      const blurbs = BLURBS[id]!;
      // Northwind's blurbs get kinder over time; the flagged one shows up now and then.
      let b = blurbs[Math.floor(r() * blurbs.length)]!;
      if (id === "ent_northwind" && b.tone < 0 && r() < 0.35 + 0.4 * progress) b = blurbs[0]!;
      chosen.set(id, b);
      const name = nameIn(id, lang, id);
      let line = lang === "ja" ? `${++n}. ${name}：${b.text[lang]}。` : `${++n}. ${name} — ${b.text[lang]}.`;
      if (id === "ent_northwind" && scope.some((e) => e.id === "ent_ana") && r() < 0.28) {
        anaNamed = true;
        line += lang === "ja" ? ` 創業者は${nameIn("ent_ana", lang, "Ana Ruiz")}。` : lang === "en" ? ` Founded by ${NAMES.ent_ana!.en}.` : ` (${NAMES.ent_ana!.en})`;
      }
      lines.push(line);
      if (fillers.length && r() < 0.5) lines.push(`${++n}. ${fillers.shift()!}${lang === "ja" ? "。" : "."}`);
    }
    for (const f of fillers) lines.push(`${++n}. ${f}${lang === "ja" ? "。" : "."}`);
    if (!lines.length) lines.push(lang === "ja" ? "1. 地元の小さな焙煎所を探すのがおすすめです。" : "1. Look for small local roasters near you.");
    const text = [intro, "", ...lines, "", OUTRO[lang]].join("\n");

    // Sources: Perplexity cites the most; Northwind's own pages show up more as the months go by.
    const pool = SOURCES.filter((s) => s.lang === "any" || s.lang === lang);
    const want = engine === "perplexity" ? 4 + Math.floor(r() * 3) : engine === "anthropic" ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 3);
    const citations: VisCitation[] = [];
    for (const s of [...pool].sort(() => r() - 0.5)) {
      if (citations.length >= want) break;
      if (s.owner === "ent_northwind" && (!chosen.has("ent_northwind") || r() > 0.25 + 0.5 * progress)) continue;
      if (s.owner === "ent_bluebottle" && !chosen.has("ent_bluebottle")) continue;
      citations.push({ url: s.url, title: s.title, domain: new URL(s.url).hostname.replace(/^www\./, ""), ownerEntityId: s.owner });
    }

    // Mentions in text order, and highlight spans for every name that appears.
    const highlights: VisAnswer["highlights"] = [];
    const firstAt = new Map<string, number>();
    for (const e of scope) {
      const name = e.id in NAMES ? nameIn(e.id, lang, e.name) : e.name;
      if (e.id === "ent_ana" && !anaNamed) continue;
      let i = text.indexOf(name);
      while (i >= 0) {
        if (!firstAt.has(e.id)) firstAt.set(e.id, i);
        highlights.push({ start: i, end: i + name.length, entityId: e.id });
        i = text.indexOf(name, i + name.length);
      }
    }
    highlights.sort((a, b) => a.start - b.start);
    const ranked = [...firstAt.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const mentions: VisMention[] = scope.map((e) => {
      const pos = ranked.indexOf(e.id);
      const b = chosen.get(e.id);
      const said = pos >= 0;
      const tone = b ? Math.max(-1, Math.min(1, b.tone + (r() - 0.5) * 0.2)) : e.id === "ent_ana" && said ? 0.35 : null;
      return {
        entityId: e.id,
        name: e.name,
        mentioned: said,
        position: said ? pos + 1 : null,
        term: said ? nameIn(e.id, lang, e.name) : null,
        sentiment: said ? (tone === null ? null : Math.round(tone * 100) / 100) : null,
        summary: said ? (b?.summary ?? "Named as the founder") : null,
        flags: said && b?.flag ? [b.flag] : [],
        ownCitations: citations.filter((c) => c.ownerEntityId === e.id).length,
      };
    });
    mentions.sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || a.name.localeCompare(b.name));
    const failed = engine === "perplexity" && r() < 0.025;
    return {
      id: `vqa_${hash(seed).toString(16)}_${++seq}`,
      promptId: prompt.id,
      prompt: prompt.question,
      question: prompt.translations[lang] ?? prompt.question,
      engine,
      model: ENGINES.find((x) => x.id === engine)?.model ?? null,
      lang,
      region: prompt.regions[0] ?? null,
      status: failed ? "error" : "ok",
      text: failed ? null : text,
      error: failed ? "HTTP 429: rate limited" : null,
      citations: failed ? [] : citations,
      costUsd: failed ? 0 : engine === "anthropic" ? 0.031 + r() * 0.02 : engine === "perplexity" ? 0.006 : 0,
      askedAt: new Date(at).toISOString(),
      mentions: failed ? [] : mentions,
      highlights: failed ? [] : highlights,
    };
  }

  const enabledEngines = () => ENGINES.filter((e) => e.configured && (settings.engines === null || settings.engines.includes(e.id)));

  function all(): VisAnswer[] {
    if (answers) return answers;
    const out: VisAnswer[] = [];
    for (const p of prompts) {
      for (const at of slotsFor(p.cadence, now - SPAN, now)) {
        for (const e of enabledEngines()) {
          for (const lang of p.languages as Lang[]) out.push(compose(p, e.id, lang, at + (hash(e.id) % 40) * 60_000, `${p.id}|${e.id}|${lang}|${Math.floor(at / DAY)}`));
        }
      }
      const last = out.filter((a) => a.promptId === p.id).at(-1);
      p.lastRunAt = last?.askedAt ?? null;
      p.lastSlot = "seeded";
    }
    answers = out.sort((a, b) => b.askedAt.localeCompare(a.askedAt));
    return answers;
  }

  const editor = () => {
    const role = ctx.role();
    if (role !== "owner" && role !== "approver" && role !== "editor") throw new ApiError(403, "forbidden", "Only editors and above manage these questions.");
  };
  const owner = () => {
    if (ctx.role() !== "owner") throw new ApiError(403, "forbidden", "Only an owner chooses engines and cadence limits.");
  };
  const engineList = (): VisEngine[] => ENGINES.map((e) => ({ ...e, enabled: e.configured && (settings.engines === null || settings.engines.includes(e.id)) }));
  const findPrompt = (id: string) => {
    const p = prompts.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "not_found", "That question is gone.");
    return p;
  };

  function aggregate(rows: VisMention[]): VisAgg {
    const hit = rows.filter((r) => r.mentioned);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const r2 = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
    return {
      answers: rows.length,
      mentioned: hit.length,
      share: rows.length ? r2(hit.length / rows.length, 3) : null,
      avgPosition: r2(avg(hit.flatMap((r) => (r.position === null ? [] : [r.position])))),
      sentiment: r2(avg(hit.flatMap((r) => (r.sentiment === null ? [] : [r.sentiment])))),
    };
  }

  function cleanInput(input: VisPromptInput, base?: VisPrompt): Omit<VisPrompt, "id" | "createdAt" | "updatedAt" | "archivedAt" | "due" | "lastRunAt" | "lastSlot"> {
    const question = (input.question ?? base?.question ?? "").trim();
    if (question.length < 3) throw new ApiError(400, "invalid", "Write the question as someone would ask it.");
    if (question.length > 500) throw new ApiError(400, "invalid", "Keep the question under 500 characters.");
    const languages = [...new Set((input.languages ?? base?.languages ?? ["en"]).map((l) => l.trim()).filter(Boolean))];
    if (!languages.length) throw new ApiError(400, "invalid", "Ask in at least one language.");
    if (languages.length > 6) throw new ApiError(400, "invalid", "Six languages at most.");
    const regions = [...new Set((input.regions ?? base?.regions ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean))];
    if (regions.some((r) => !/^[A-Z]{2}$/.test(r))) throw new ApiError(400, "invalid", "Regions are two-letter country codes, such as CA or JP.");
    const cadence = input.cadence ?? base?.cadence ?? "weekly";
    if (!settings.cadences.includes(cadence)) throw new ApiError(400, "invalid", `An owner limited questions to ${settings.cadences.join(" or ")} runs.`);
    const entityIds = input.entityIds ?? base?.entityIds ?? [];
    const known = new Set(liveEntities().map((e) => e.id));
    if (entityIds.some((id) => !known.has(id))) throw new ApiError(400, "invalid", "One of those names isn't tracked anymore.");
    return { question, translations: input.translations ?? base?.translations ?? {}, languages, regions, entityIds, cadence, notes: (input.notes ?? base?.notes ?? "").trim() || null };
  }

  return {
    engines: () => wait(engineList()),
    settings: (): Promise<VisSettingsResponse> => wait({ settings, engines: engineList(), judge: true }),
    updateSettings: async (patch: VisSettingsPatch): Promise<VisSettingsResponse> => {
      await wait(null, 300);
      if (patch.engines !== undefined || patch.cadences !== undefined || patch.maxPrompts !== undefined) owner();
      else editor();
      if (patch.engines !== undefined) settings.engines = patch.engines;
      if (patch.cadences) {
        if (!patch.cadences.length) throw new ApiError(400, "invalid", "Allow at least one cadence.");
        settings.cadences = patch.cadences;
      }
      if (patch.maxPrompts !== undefined) settings.maxPrompts = patch.maxPrompts;
      if (patch.domains) {
        for (const [id, ds] of Object.entries(patch.domains)) {
          const clean = [...new Set(ds.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean))];
          if (clean.some((d) => !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d))) throw new ApiError(400, "invalid", "Domains look like example.com.");
          if (clean.length) settings.domains[id] = clean;
          else delete settings.domains[id];
        }
      }
      return { settings: clone(settings), engines: engineList(), judge: true };
    },

    prompts: (archived = false): Promise<VisPrompt[]> => {
      all();
      return wait(prompts.filter((p) => archived || !p.archivedAt));
    },
    createPrompt: async (input: VisPromptInput): Promise<VisPrompt> => {
      await wait(null, 300);
      editor();
      if (prompts.filter((p) => !p.archivedAt).length >= settings.maxPrompts) throw new ApiError(409, "conflict", `This workspace asks at most ${settings.maxPrompts} questions. Archive one first.`);
      const at = new Date().toISOString();
      const p: VisPrompt = { id: `vqp_new_${++seq}`, ...cleanInput(input), createdAt: at, updatedAt: at, archivedAt: null, due: true, lastRunAt: null, lastSlot: null };
      prompts.push(p);
      return clone(p);
    },
    updatePrompt: async (id: string, input: Partial<VisPromptInput>): Promise<VisPrompt> => {
      await wait(null, 300);
      editor();
      const p = findPrompt(id);
      Object.assign(p, cleanInput({ question: p.question, ...input }, p), { updatedAt: new Date().toISOString() });
      return clone(p);
    },
    archivePrompt: async (id: string): Promise<void> => {
      await wait(null, 250);
      editor();
      findPrompt(id).archivedAt = new Date().toISOString();
    },
    runPrompt: async (id: string): Promise<VisRunResult> => {
      editor();
      const p = findPrompt(id);
      await wait(null, 1400);
      const at = Date.now();
      const fresh = enabledEngines().flatMap((e) => (p.languages as Lang[]).map((lang) => compose(p, e.id, lang, at, `${p.id}|${e.id}|${lang}|run${at}`)));
      answers = [...fresh, ...all()];
      p.lastRunAt = new Date(at).toISOString();
      p.due = false;
      const ok = fresh.filter((a) => a.status === "ok");
      return { runId: `run_fx_${++seq}`, prompts: 1, answers: ok.length, errors: fresh.length - ok.length, capped: 0, mentions: ok.reduce((n, a) => n + a.mentions.filter((m) => m.mentioned).length, 0), costUsd: fresh.reduce((n, a) => n + a.costUsd, 0) };
    },
    suggest: async (languages: string[] = [], count = 8): Promise<{ languages: string[]; questions: VisSuggestion[] }> => {
      await wait(null, 1100);
      editor();
      const langs = languages.length ? languages : ["en"];
      const pool: VisSuggestion[] = [
        { question: "Which Vancouver coffee roasters pay farmers fairly?", lang: "en", why: "An open question where sourcing should bring you up unprompted", names: ["Northwind Coffee"] },
        { question: "Best coffee beans to give as a gift in Canada", lang: "en", why: "A buying moment; shows who assistants send shoppers to", names: ["Northwind Coffee", "Stumptown"] },
        { question: "Is Blue Bottle worth the price?", lang: "en", why: "How the main competitor is described", names: ["Blue Bottle"] },
        { question: "What do people say about Northwind Coffee?", lang: "en", why: "Reputation check", names: ["Northwind Coffee"] },
        { question: "Good cafés to work from in Mount Pleasant, Vancouver", lang: "en", why: "Local intent near your café", names: ["Northwind Coffee"] },
        { question: "渋谷でおいしいコーヒー豆が買える店は？", lang: "ja", why: "The Tokyo shop's neighbourhood", names: ["Northwind Coffee", "Blue Bottle"] },
        { question: "¿Qué tostadores de café en Vancouver son éticos?", lang: "es", why: "Sourcing, asked in Spanish", names: ["Northwind Coffee"] },
        { question: "밴쿠버에서 원두 사기 좋은 곳은?", lang: "ko", why: "Where Korean-speaking visitors are sent", names: ["Blue Bottle"] },
      ];
      const have = new Set(prompts.filter((p) => !p.archivedAt).map((p) => p.question.toLowerCase()));
      const questions = pool.filter((q) => langs.some((l) => q.lang === l.split("-")[0]) && !have.has(q.question.toLowerCase())).slice(0, count);
      return { languages: langs, questions };
    },

    report: async (from?: string, to?: string): Promise<VisReport> => {
      const toMs = to ? Date.parse(to) : Date.now();
      const fromMs = from ? Date.parse(from) : toMs - 28 * DAY;
      const prevFrom = fromMs - (toMs - fromMs);
      const rows = all().filter((a) => {
        const t = Date.parse(a.askedAt);
        return t >= prevFrom && t <= toMs;
      });
      const cur = rows.filter((a) => Date.parse(a.askedAt) >= fromMs);
      const prev = rows.filter((a) => Date.parse(a.askedAt) < fromMs);
      const ok = cur.filter((a) => a.status === "ok");
      const mentionsOf = (xs: VisAnswer[], id: string) => xs.filter((a) => a.status === "ok").flatMap((a) => a.mentions.filter((m) => m.entityId === id).map((m) => ({ m, a })));
      const groupBy = <T,>(xs: T[], key: (x: T) => string) => {
        const g = new Map<string, T[]>();
        for (const x of xs) g.set(key(x), [...(g.get(key(x)) ?? []), x]);
        return g;
      };
      const entities: VisEntityRow[] = liveEntities().map((e) => {
        const c = mentionsOf(cur, e.id);
        const p = mentionsOf(prev, e.id);
        const now = aggregate(c.map((x) => x.m));
        const before = aggregate(p.map((x) => x.m));
        const d = (a: number | null, b: number | null, digits = 3) => (a === null || b === null ? null : Math.round((a - b) * 10 ** digits) / 10 ** digits);
        return {
          id: e.id,
          name: e.name,
          kind: e.kind,
          role: e.role,
          relation: e.relation,
          parentId: e.parentId,
          ...now,
          ownCitations: c.reduce((n, x) => n + x.m.ownCitations, 0),
          flagged: c.filter((x) => x.m.flags.length).length,
          previous: before,
          change: { share: d(now.share, before.share), avgPosition: d(now.avgPosition, before.avgPosition, 2), sentiment: d(now.sentiment, before.sentiment, 2) },
          byEngine: [...groupBy(c, (x) => x.a.engine).entries()].map(([engine, xs]) => ({ engine, ...aggregate(xs.map((x) => x.m)) })).sort((a, b) => a.engine.localeCompare(b.engine)),
          byLanguage: [...groupBy(c, (x) => x.a.lang).entries()].map(([lang, xs]) => ({ lang, ...aggregate(xs.map((x) => x.m)) })).sort((a, b) => b.answers - a.answers),
          trend: [...groupBy(c, (x) => x.a.askedAt.slice(0, 10)).entries()].map(([day, xs]) => ({ day, ...aggregate(xs.map((x) => x.m)) })).sort((a, b) => a.day.localeCompare(b.day)),
        };
      });
      const domains = new Map<string, { domain: string; citations: number; answers: Set<string>; ownerEntityId: string | null }>();
      for (const a of ok) for (const c of a.citations) {
        const owner = Object.entries(settings.domains).find(([, ds]) => ds.some((d) => c.domain === d || c.domain.endsWith(`.${d}`)))?.[0] ?? null;
        const row = domains.get(c.domain) ?? { domain: c.domain, citations: 0, answers: new Set<string>(), ownerEntityId: owner };
        row.citations++;
        row.answers.add(a.id);
        domains.set(c.domain, row);
      }
      const dRows = [...domains.values()].map((d) => ({ domain: d.domain, citations: d.citations, answers: d.answers.size, ownerEntityId: d.ownerEntityId })).sort((a, b) => b.citations - a.citations);
      const total = dRows.reduce((n, d) => n + d.citations, 0);
      const own = dRows.filter((d) => d.ownerEntityId).reduce((n, d) => n + d.citations, 0);
      return wait(
        {
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          previous: { from: new Date(prevFrom).toISOString(), to: new Date(fromMs).toISOString() },
          totals: {
            answers: ok.length,
            prompts: new Set(ok.map((a) => a.promptId)).size,
            errors: cur.filter((a) => a.status === "error").length,
            capped: 0,
            costUsd: Math.round(cur.reduce((n, a) => n + a.costUsd, 0) * 100) / 100,
            byEngine: [...groupBy(ok, (a) => a.engine).entries()].map(([engine, xs]) => ({ engine, answers: xs.length })),
            byLanguage: [...groupBy(ok, (a) => a.lang).entries()].map(([lang, xs]) => ({ lang, answers: xs.length })).sort((a, b) => b.answers - a.answers),
          },
          entities,
          citations: { total, own, ownShare: total ? Math.round((own / total) * 1000) / 1000 : null, ownDomains: dRows.filter((d) => d.ownerEntityId).slice(0, 15), otherDomains: dRows.filter((d) => !d.ownerEntityId).slice(0, 15) },
          latest: ok.slice(0, 6),
          engines: engineList(),
        },
        260,
      );
    },
    answers: async (q: VisAnswersQuery = {}): Promise<VisAnswer[]> => {
      const rows = all().filter(
        (a) =>
          (!q.promptId || a.promptId === q.promptId) &&
          (!q.engine || a.engine === q.engine) &&
          (!q.lang || a.lang === q.lang) &&
          (!q.entity || (a.status === "ok" && a.mentions.some((m) => m.entityId === q.entity && m.mentioned === (q.mentioned ?? true)))),
      );
      return wait(rows.slice(0, Math.min(q.limit ?? 50, 200)), 200);
    },
  };
}
