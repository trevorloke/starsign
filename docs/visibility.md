# AI answer visibility

More and more people ask ChatGPT, Claude, Perplexity or Gemini instead of searching. This feature asks those
assistants the questions a brand's or a campaign's audience asks, on a schedule, and records what they say: whether
the tracked names come up, in what order, in what tone, what is said about each, whether it may be wrong, and which
sources the answers rest on.

Open it from the account menu (**AI visibility**) or from any tracked name (**How AI answers talk about …**).

## What it measures

For every question, every enabled engine, every language and every region it is asked in, one answer per period
(day or ISO week). For each answer:

- **Mentioned or not**, for every tracked name the question looks for (all tracked names by default). Detection is the
  tracker's own matcher (`matchEntity`): the name, every alias in every script, @handles, context words for ambiguous
  names and exclusion words for namesakes. No model call.
- **Position**: the order in which tracked names first appear in the answer (#1 = named first). Untracked names do not
  count.
- **Tone** (-1 to 1), **a one-line summary** of what the answer says about the name, and **flags** for statements
  that contradict what Starsign knows (for your own organisation, the brand profile's description). One model call per
  answer that names anything (`judgeAnswer` prompt), at low effort.
- **Citations**: the sources the engine cites, and whether each is one of the name's own domains (set per name in the
  drawer).

The report turns these into, per name: the share of answers that mention it, the average position, the average tone,
own-site citations and flagged answers, by engine, by language and by day, with the same numbers for the period
before, so the change is visible. It also lists the domains answers cite (yours and others) and the latest answers
with the names highlighted.

Each run also writes two canonical metrics per tracked name, `ai_answer_mentions` (answers that named it) and
`ai_answer_citations` (citations of its own domains), with `entityType: "tracked_entity"`.

## Its limits

- **Answers vary.** The same question asked twice gets different wording, order and sources. One answer proves little;
  the share over a period and its trend are the signal. The screens say so.
- **It is a sample, not what every person sees.** Consumer apps add memory, personalisation, location and their own
  system prompts. Starsign asks through each provider's API with web search on, without a system prompt, as a new
  person would.
- **Position is among tracked names only**, and only by first appearance in the text.
- **Tone and flags are a model's reading** of the answer. Flags check against what Starsign knows (the brand profile),
  not the web; without facts they only catch internal contradictions. Without a model configured, tone and summaries
  are left empty and everything else still works.
- **Languages.** Give a question in each language as a native speaker would ask it (`translations`); without one the
  question is asked as written and the answer requested in that language.
- **Regions.** Claude, ChatGPT and Perplexity are asked to search as if from the country given; Gemini's grounding has
  no such setting, so its region is not sent.
- Gemini cites Google redirect links; the source's domain is read from the citation's title.

## Turning engines on

Each engine is used only when its key is set on the server (the API process for "Ask now", and the workers process,
or the API process without Redis, for the hourly job).

| Engine | Key | Model | API |
|---|---|---|---|
| Claude | `ANTHROPIC_API_KEY` | `STARSIGN_MODEL` (default `claude-opus-5-5`) | Messages API with the `web_search_20260209` tool, via the Anthropic SDK |
| ChatGPT | `OPENAI_API_KEY` | `OPENAI_ANSWER_MODEL` (default `gpt-5`) | Responses API with the `web_search` tool |
| Perplexity | `PERPLEXITY_API_KEY` | `PERPLEXITY_ANSWER_MODEL` (default `sonar`) | Sonar chat completions |
| Gemini | `GEMINI_API_KEY` | `GEMINI_ANSWER_MODEL` (default `gemini-2.5-flash`) | `generateContent` with Google Search grounding |

`STARSIGN_FAKE_AI=1` with no keys adds a demo engine that answers offline, for development. Owners can turn any
configured engine off for their workspace, and limit editors to weekly questions.

The judge and the question helper use the same model gateway as the rest of Starsign (`ANTHROPIC_API_KEY`).

## Costs

Every engine call and every judge call is recorded as a **"visibility" operator run** and counts toward the
workspace's monthly model spend cap (Settings). Once the month's model spend reaches the cap, the remaining questions
in that period are recorded as **capped** (not asked) and the run's summary starts with `capped:`; they are asked again
in the next period.

What is counted:

- **Claude**: tokens at the model's price (`packages/ai/src/pricing.ts`) plus web searches at $10 per 1,000.
- **Perplexity**: the request cost Perplexity reports in `usage.cost.total_cost`, when present.
- **ChatGPT and Gemini** (and Perplexity when it reports no cost): their prices are not in Starsign's price table,
  so each call is charged a conservative estimate, **$0.05 per answer** by default (`STARSIGN_ANSWER_CALL_COST_USD`
  changes it), marked as an estimate. That keeps every engine under the spend cap. Tokens are recorded on each
  answer; check the real bills at the provider and adjust the estimate to match.
- **The judge**: one low-effort call per answer that names a tracked name, at the gateway model's price.

Rough volume: questions × engines × languages × regions per day (daily) or per week (weekly). The hourly job makes at
most 60 engine calls per workspace per hour; the rest wait for the next hour.

## Scheduling

The workers' `ai-visibility` job runs every hour. A question is due when its current period (UTC day for daily, ISO
week for weekly) has no completed run. Every engine × language × region combination gets one answer per period
(unique in `visibility_answers`), so a second run in the same period or a retry does not ask again. Two processes
running the job at the same moment could both ask; only the first answer is stored.
Errors are recorded and not retried in the same period. "Ask now" records a separate sample and also completes the
current period.

## Where things are

- Engines: `packages/ai/src/engines/` (`answerEnginesFromEnv`, `answerEngineStatus`).
- Prompts: `packages/ai/src/prompts/judgeAnswer.ts`, `suggestQuestions.ts`; adapters and fakes in `packages/ai/src/visibility.ts`.
- Service: `packages/core/src/services/visibility.ts` (`VisibilityService`). Tables: migration `0012_visibility.sql`,
  drizzle in `packages/db/src/schema-visibility.ts`.
- Routes: `apps/api/src/routes-visibility.ts`. Job: `apps/workers/src/visibility.ts`. MCP: `get_ai_visibility`.
- Web: `apps/web/src/drawers/VisibilityDrawer.tsx`, `drawers/visibility/*`, fixtures in `dev/visibility-fixtures.ts`.
