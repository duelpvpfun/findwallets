-- Where the hourly leaderboard pin lives.
--
-- The pin is ONE message that gets edited every hour, not a new post every
-- hour: 24 leaderboard posts a day would bury the alerts they are advertising,
-- and only one message can usefully be pinned anyway. So its id has to survive
-- across cron invocations, which means a row.
--
-- `chat_id` is stored alongside it because a message id means nothing outside
-- the chat it was posted in. If TELEGRAM_ALERT_CHAT_ID is ever repointed, the
-- stored id would edit a message in a channel we no longer post to (or, worse,
-- someone else's) — comparing it is what makes the cron re-post instead.
CREATE TABLE IF NOT EXISTS "pinned_messages" (
  -- One row per kind of pin, so a second pinned message later is a new row
  -- rather than a second table.
  "kind" text PRIMARY KEY,
  "chat_id" text NOT NULL,
  "message_id" bigint NOT NULL,
  -- When the message was first posted, vs. when it was last edited. The gap
  -- between them is how long the current pin has been live, which is the only
  -- way to tell "the edit is working" from "it silently re-posts every hour".
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
