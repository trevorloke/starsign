-- Client reports: a saved definition (period, sections, branding, recipients, schedule) rendered on demand from the
-- same numbers as Analytics. Sending is idempotent per period through last_sent_period.
CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  period text NOT NULL DEFAULT 'last_7_days',          -- last_7_days | last_30_days | calendar_month
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,          -- ordered section ids
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,          -- { title, clientName, logoMediaId, accent }
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,        -- email addresses
  schedule jsonb NOT NULL DEFAULT '{"kind":"none"}'::jsonb, -- none | weekly { weekday, hour } | monthly { day, hour }
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,           -- { networks?, accounts? }
  intro text,
  last_sent_at timestamptz,
  last_sent_period text,                                -- the period key last emailed by the schedule
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS reports_ws ON reports(workspace_id, deleted_at);

-- Read-only public links to a report. Only the token's sha256 is stored, like invites.
CREATE TABLE IF NOT EXISTS report_shares (
  id text PRIMARY KEY,
  report_id text NOT NULL REFERENCES reports(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'link',                 -- link | email
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_viewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS report_shares_report ON report_shares(report_id, revoked_at);
