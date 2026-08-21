-- Threading escalations into one call.
--
-- A token that escalates 2 -> 3 -> 4 wallets produces three `alerts_fired`
-- rows, which is correct: each step must fire exactly once, and each has its
-- own entry market cap, which is what makes "would you have done better
-- entering on the 2-wallet alert or the 4-wallet one" answerable.
--
-- But it is ONE call. Storing the Telegram message id lets each escalation
-- reply to the first message of its own call instead of arriving as an
-- unrelated post, so the channel reads as "this one is developing" rather than
-- as three separate tips on the same coin.
ALTER TABLE "alerts_fired"
  ADD COLUMN IF NOT EXISTS "telegram_message_id" bigint;
