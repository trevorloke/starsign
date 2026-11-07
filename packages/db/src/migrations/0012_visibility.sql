-- AI answer visibility: the questions a workspace asks AI assistants, every answer they gave, and what each answer
-- said about each tracked name. Answers and mentions are append-only in practice (never edited after a run).

-- Per workspace: which engines to use and the cadence caps (owners), and each tracked name's own web domains.
CREATE TABLE IF NOT EXISTS visibility_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  engines jsonb,                                   -- engine ids to ask; null = every configured engine
  cadences jsonb NOT NULL DEFAULT '["daily","weekly"]'::jsonb,  -- cadences editors may choose
  max_prompts integer NOT NULL DEFAULT 20,
  domains jsonb NOT NULL DEFAULT '{}'::jsonb,       -- tracked entity id -> its own domains (citations to them count as own)
  updated_by jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visibility_prompts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  question text NOT NULL,
  translations jsonb NOT NULL DEFAULT '{}'::jsonb,  -- lang -> the question as a native speaker would ask it
  languages jsonb NOT NULL DEFAULT '["en"]'::jsonb,
  regions jsonb NOT NULL DEFAULT '[]'::jsonb,       -- ISO country codes; empty = no location
  entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,    -- tracked names to look for; empty = all tracked
  cadence text NOT NULL DEFAULT 'weekly',           -- daily | weekly
  notes text,
  last_slot text,                                   -- the period last completed (2026-11-07 or 2026-W45)
  last_run_at timestamptz,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS visibility_prompts_ws ON visibility_prompts(workspace_id, archived_at);

CREATE TABLE IF NOT EXISTS visibility_answers (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  prompt_id text NOT NULL REFERENCES visibility_prompts(id),
  run_id text,                                      -- the "visibility" operator run that asked it
  slot text NOT NULL,                               -- scheduling period (or manual:<time>): one answer per slot and combination
  engine text NOT NULL,
  model text,
  lang text NOT NULL,
  region text NOT NULL DEFAULT '',
  question text NOT NULL,                           -- exactly what was sent
  status text NOT NULL,                             -- ok | error | capped
  text text,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,     -- { url, title, domain, ownerEntityId }[]
  error text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  judged boolean NOT NULL DEFAULT false,
  asked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS visibility_answers_once ON visibility_answers(prompt_id, slot, engine, lang, region);
CREATE INDEX IF NOT EXISTS visibility_answers_ws_time ON visibility_answers(workspace_id, asked_at);

CREATE TABLE IF NOT EXISTS visibility_mentions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  answer_id text NOT NULL REFERENCES visibility_answers(id),
  prompt_id text NOT NULL,
  entity_id text NOT NULL REFERENCES tracked_entities(id),
  engine text NOT NULL,
  lang text NOT NULL,
  mentioned boolean NOT NULL,
  position integer,                                 -- 1 = named first among tracked names in this answer
  term text,                                        -- what matched
  sentiment double precision,                       -- -1..1, null when not judged
  summary text,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,         -- possible inaccuracies the judge noticed
  own_citations integer NOT NULL DEFAULT 0,
  asked_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS visibility_mentions_once ON visibility_mentions(answer_id, entity_id);
CREATE INDEX IF NOT EXISTS visibility_mentions_entity_time ON visibility_mentions(entity_id, asked_at);
CREATE INDEX IF NOT EXISTS visibility_mentions_ws_time ON visibility_mentions(workspace_id, asked_at);
