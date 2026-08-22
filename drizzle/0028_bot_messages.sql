-- Two corrections to 0027, before anything depends on it.
--
-- 1. The table now holds two kinds of message and only one of them is pinned:
--    the hourly leaderboard (posted once, pinned, then edited in place forever)
--    and the daily 2pm recap (a new post every day, never pinned). What they
--    have in common is that the bot addresses them by key rather than posting
--    and forgetting, so `bot_messages` is the honest name and `pinned_messages`
--    would be wrong about half its rows.
--
-- 2. `message_id` becomes nullable, which is what makes the recap's
--    once-a-day guarantee an index rather than a read-then-write. The row is
--    claimed BEFORE the message is sent — at which point there is no id yet —
--    so a retried cron delivery collides on the primary key and does nothing
--    instead of posting a second recap.
ALTER TABLE IF EXISTS "pinned_messages" RENAME TO "bot_messages";
--> statement-breakpoint

ALTER TABLE "bot_messages" ALTER COLUMN "message_id" DROP NOT NULL;
