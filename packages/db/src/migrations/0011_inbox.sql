-- The team inbox: shared work state over the live feed. Activities stay exactly as ingested; the state lives here.
-- One row per inbound activity. Messages of one conversation (a reply chain, or a direct-message conversation)
-- point at the conversation's first message (thread_id); the state on that root row is the conversation's state.
CREATE TABLE IF NOT EXISTS inbox_items (
  activity_id text PRIMARY KEY REFERENCES activities(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  thread_id text NOT NULL,                      -- the root activity id (itself for a root)
  status text NOT NULL DEFAULT 'open',          -- open | pending | done | spam
  assignee text,                                -- a member's user id
  priority text NOT NULL DEFAULT 'normal',      -- normal | high | urgent
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,      -- workspace-defined labels
  first_response_at timestamptz,
  done_at timestamptz,
  snoozed_until timestamptz,
  sla_due_at timestamptz,                       -- first-response target for the conversation
  last_activity_at timestamptz NOT NULL,        -- newest inbound message in the conversation
  message_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The open queue: roots only, by status, soonest due first.
CREATE INDEX IF NOT EXISTS inbox_items_queue ON inbox_items(workspace_id, status, sla_due_at) WHERE thread_id = activity_id;
CREATE INDEX IF NOT EXISTS inbox_items_assignee ON inbox_items(workspace_id, assignee, status) WHERE thread_id = activity_id;
CREATE INDEX IF NOT EXISTS inbox_items_thread ON inbox_items(thread_id);
CREATE INDEX IF NOT EXISTS inbox_items_recent ON inbox_items(workspace_id, last_activity_at) WHERE thread_id = activity_id;

-- Internal notes on a conversation. Never sent anywhere.
CREATE TABLE IF NOT EXISTS inbox_notes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  thread_id text NOT NULL,
  author jsonb NOT NULL,
  text text NOT NULL,
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,  -- user ids
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX IF NOT EXISTS inbox_notes_thread ON inbox_notes(thread_id, created_at);

-- Saved replies: shared answers with {{author_name}}, {{author_handle}}, {{brand}}. Inserted, edited, then gated like any reply.
CREATE TABLE IF NOT EXISTS saved_replies (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  text text NOT NULL,
  lang text,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_replies_ws ON saved_replies(workspace_id, name);

-- Routing rules, evaluated in position order when a new conversation arrives.
CREATE TABLE IF NOT EXISTS inbox_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  rr_cursor integer NOT NULL DEFAULT 0,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbox_rules_ws ON inbox_rules(workspace_id, position);

-- What was already in the feed: each message is its own conversation. The last week starts open, older ones done.
INSERT INTO inbox_items (activity_id, workspace_id, thread_id, status, done_at, last_activity_at, created_at, updated_at)
SELECT a.id, a.workspace_id, a.id,
       CASE WHEN a.occurred_at > now() - interval '7 days' THEN 'open' ELSE 'done' END,
       CASE WHEN a.occurred_at > now() - interval '7 days' THEN NULL ELSE now() END,
       a.occurred_at, now(), now()
FROM activities a
WHERE a.kind NOT IN ('own_post', 'like', 'follow', 'repost') AND a.social_account_id IS NOT NULL
ON CONFLICT (activity_id) DO NOTHING;
