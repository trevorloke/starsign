import { NETWORK_LIMITS, type Network } from "@starsign/schema";
import type { FakeHandler } from "./gateway.ts";
import type { AdaptForNetworkOutput, AdaptForNetworkVars } from "./prompts/adaptForNetwork.ts";
import type { ClassifyTopicOutput, ClassifyTopicVars } from "./prompts/classifyTopic.ts";
import type { ClusterSignalsOutput, ClusterSignalsVars } from "./prompts/clusterSignals.ts";
import { readProfile } from "./prompts/context.ts";
import type { DraftForTrendOutput, DraftForTrendVars } from "./prompts/draftForTrend.ts";
import type { ScoreRelevanceOutput, ScoreRelevanceVars } from "./prompts/scoreRelevance.ts";
import type { WriteBriefOutput, WriteBriefVars } from "./prompts/writeBrief.ts";
import type { TranslateMessagesOutput, TranslateMessagesVars } from "./prompts/translateMessages.ts";
import type { TranslateKeywordsOutput, TranslateKeywordsVars } from "./prompts/translateKeywords.ts";
import type { SuggestAliasesOutput, SuggestAliasesVars } from "./prompts/suggestAliases.ts";
// ---- AI answer visibility
import { visibilityFakeHandlers } from "./visibility.ts";

/** Trim to the network's text limit by code points (graphemes never exceed code points, so Bluesky stays legal). */
export function fitToNetwork(text: string, network: Network): string {
  const max = NETWORK_LIMITS[network].maxText;
  const cps = [...text];
  return cps.length <= max ? text : `${cps.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/**
 * Deterministic, schema-valid outputs for every prompt. Used by tests and by `STARSIGN_FAKE_AI=1` development so the
 * operators run end to end without a model. Everything here is derived from the inputs; nothing is invented.
 */
export function defaultFakeHandlers(): Record<string, FakeHandler> {
  return {
    // ---- AI answer visibility (judgeAnswer, suggestQuestions)
    ...visibilityFakeHandlers(),
    // Marks text as translated without inventing a translation.
    translateMessages: (vars) => {
      const v = vars as TranslateMessagesVars;
      const out: TranslateMessagesOutput = { translations: v.items.map((i) => ({ id: i.id, text: i.lang === v.to ? i.text : `[${v.to}] ${i.text}` })) };
      return out;
    },
    // A hashtag form only: derived from the name, nothing invented.
    suggestAliases: (vars) => {
      const v = vars as SuggestAliasesVars;
      const tag = `#${v.name.replace(/[^\p{L}\p{N}]+/gu, "")}`;
      const out: SuggestAliasesOutput = { aliases: v.existing.includes(tag) ? [] : [{ text: tag, lang: "und", why: "hashtag" }], ambiguous: [] };
      return out;
    },
    translateKeywords: (vars) => {
      const v = vars as TranslateKeywordsVars;
      const out: TranslateKeywordsOutput = { byLanguage: v.languages.map((lang) => ({ lang, keywords: v.keywords.map((k) => `${k} (${lang})`) })) };
      return out;
    },
    adaptForNetwork: (vars) => {
      const v = vars as AdaptForNetworkVars;
      const out: AdaptForNetworkOutput = {
        variants: v.networks.map((n) => ({ network: n, text: fitToNetwork(v.idea, n), thread: [] })),
        notes: "fake gateway: the idea was copied per network and trimmed to each hard limit",
      };
      return out;
    },
    draftForTrend: (vars) => {
      const v = vars as DraftForTrendVars;
      const angle = `Our take on ${v.topic.name}`;
      const peak = v.forecast.hoursToPeak === null ? "no peak estimate" : `peak in ~${Math.round(v.forecast.hoursToPeak)}h`;
      const out: DraftForTrendOutput = {
        angle,
        rationale: `Fake draft. ${v.topic.name} is ${v.forecast.stage} at ${Math.round(v.forecast.confidence * 100)}% confidence, ${peak}; sources: ${v.forecast.sources.join(", ") || "none"}. Treat the timing as an estimate.`,
        variants: v.networks.map((n) => ({ network: n, text: fitToNetwork(`${angle}: ${v.topic.keywords.slice(0, 3).join(", ") || "what it means for you"}.`, n), thread: [] })),
        disclosure: { aiAssisted: true, aiContributions: ["text_drafted"] },
      };
      return out;
    },
    clusterSignals: (vars) => {
      const v = vars as ClusterSignalsVars;
      const groups = new Map<string, string[]>();
      for (const s of v.signals) {
        const key = words(s)[0] ?? s.toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), s]);
      }
      const out: ClusterSignalsOutput = {
        topics: [...groups.entries()].slice(0, v.maxTopics ?? 8).map(([key, signals]) => ({
          name: key,
          keywords: [...new Set(signals.flatMap(words))].slice(0, 6).concat(key).filter((k, i, a) => a.indexOf(k) === i),
          relevance: 0.5,
          why: `fake gateway: ${signals.length} signal(s) share the term "${key}"`,
        })),
      };
      return out;
    },
    writeBrief: (vars) => {
      const v = vars as WriteBriefVars;
      const s = v.summary;
      const totals = (typeof s.totals === "object" && s.totals !== null ? s.totals : {}) as Record<string, unknown>;
      const measured = num(s.measuredAt24h);
      const impressions = num(totals.impressions);
      const engagements = num(totals.engagements);
      const lift = (v.liftByStage as { stage?: string; posts?: number; lift?: number | null }[]).map((l) => `- ${l.stage ?? "?"}: ${l.posts ?? 0} posts, lift ${l.lift === null || l.lift === undefined ? "n/a" : l.lift.toFixed(2)}`);
      const headline = measured ? `${measured} posts measured at 24h: ${engagements} engagements on ${impressions} impressions` : "Nothing measured at 24h this period";
      const out: WriteBriefOutput = {
        headline,
        markdown: [
          `# Weekly brief: ${v.period.from.slice(0, 10)} to ${v.period.to.slice(0, 10)}`,
          "",
          `**${headline}.**`,
          "",
          "## What moved",
          `- Posts measured at 24h: ${measured}`,
          `- Impressions: ${impressions}; engagements: ${engagements}`,
          "",
          "## Lift by trend stage",
          ...(lift.length ? lift : ["- not measured"]),
          "",
          "## Confidence notes",
          measured < 10 ? `- Only ${measured} posts measured: indicative, not conclusive.` : "- Sample size is adequate for directional comparisons.",
          `- Radar entries considered: ${v.radar.length}; alerts considered: ${v.alerts.length}.`,
        ].join("\n"),
        evidence: [{ kind: "metrics_summary", ref: `${v.period.from}..${v.period.to}`, note: `${measured} posts measured at 24h; ${impressions} impressions; ${engagements} engagements` }],
      };
      return out;
    },
    classifyTopic: (vars) => {
      const v = vars as ClassifyTopicVars;
      const text = v.text.toLowerCase();
      const hits = v.keywords.filter((k) => text.includes(k.toLowerCase()));
      const out: ClassifyTopicOutput = {
        likelihood: v.keywords.length ? hits.length / v.keywords.length : 0,
        reason: hits.length ? `fake gateway: matched ${hits.length}/${v.keywords.length} signals (${hits.join(", ")})` : "fake gateway: no signal matched",
      };
      return out;
    },
    scoreRelevance: (vars) => {
      const v = vars as ScoreRelevanceVars;
      const p = readProfile(v.brand.workspace.profile);
      const hay = [p.description ?? "", p.audience ?? "", ...p.topics].join(" ").toLowerCase();
      const terms = [v.topic.name, ...v.topic.keywords];
      const hits = terms.filter((t) => hay.includes(t.toLowerCase()));
      const out: ScoreRelevanceOutput = {
        relevance: terms.length ? hits.length / terms.length : 0,
        why: hits.length ? `fake gateway: ${hits.join(", ")} appear in the brand profile` : "fake gateway: no overlap with the brand profile",
      };
      return out;
    },
  };
}
