// Checks the Telegram side of the alert stream is wired up.
//
//   node --env-file=.env.local scripts/telegram-setup.mjs
//
// Run it after adding the bot to the channel. It verifies the token, resolves
// the chat, confirms the bot can actually post there, and sends one plain test
// message.
//
// It deliberately does NOT build a sample alert: `buildAlertMessage` lives
// behind the `server-only` boundary and duplicating it here is how the real
// message and the test message drift apart. For a genuine end-to-end alert,
// with the real formatting and the real referral buttons, use:
//
//   npm run alerts:replay -- --simulate
//
// against a running dev server with these variables set.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const PUBLIC_CHANNEL = process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;

const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
};

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather.");
  process.exit(1);
}

const me = await api("getMe");
if (!me.ok) {
  console.error(`Token rejected: ${me.description}`);
  process.exit(1);
}
console.log(`bot            @${me.result.username}  (${me.result.first_name})`);

if (!CHAT_ID) {
  console.log(`\nTELEGRAM_ALERT_CHAT_ID is not set.`);
  console.log(`For a PUBLIC channel it is just the @username, e.g. @findwallets_alerts.`);
  console.log(`For a PRIVATE channel it is a numeric -100… id; post any message in the`);
  console.log(`channel and this script will find it below.\n`);

  // getUpdates only returns anything for a private channel the bot is in, and
  // only for messages posted after it joined. An empty result here is normal
  // for a public channel and is not an error.
  const updates = await api("getUpdates", { limit: 20 });
  const seen = new Map();
  for (const u of updates.result ?? []) {
    const chat = u.channel_post?.chat ?? u.message?.chat ?? u.my_chat_member?.chat;
    if (chat) seen.set(chat.id, chat);
  }
  if (seen.size === 0) {
    console.log(`No chats seen yet. Add the bot to the channel as an admin with`);
    console.log(`"Post Messages", post something there, and re-run.`);
  } else {
    console.log(`Chats this bot has seen:`);
    for (const chat of seen.values()) {
      const handle = chat.username ? `@${chat.username}` : "(private)";
      console.log(`  ${String(chat.id).padEnd(16)} ${chat.type.padEnd(9)} ${handle}  ${chat.title ?? ""}`);
    }
  }
  process.exit(0);
}

const chat = await api("getChat", { chat_id: CHAT_ID });
if (!chat.ok) {
  console.error(`\nCannot read ${CHAT_ID}: ${chat.description}`);
  console.error(`Usually this means the bot is not in the channel yet, or the`);
  console.error(`username is wrong. Add @${me.result.username} as an admin.`);
  process.exit(1);
}
console.log(`chat           ${chat.result.id}  ${chat.result.type}  ${chat.result.title ?? ""}`);

// Being in the channel is not the same as being able to post in it — a bot
// added as a plain member reads fine and fails silently on every alert.
const admins = await api("getChatAdministrators", { chat_id: CHAT_ID });
if (admins.ok) {
  const self = (admins.result ?? []).find((a) => a.user?.id === me.result.id);
  if (!self) {
    console.error(`\nThe bot is NOT an admin of this channel. Alerts will fail.`);
    console.error(`Channel settings -> Administrators -> Add @${me.result.username}.`);
    process.exit(1);
  }
  if (self.can_post_messages === false) {
    console.error(`\nThe bot is an admin but lacks "Post Messages". Alerts will fail.`);
    process.exit(1);
  }
  // The hourly leaderboard is pinned, and without the right to pin it posts
  // fine and silently never reaches the top of the channel, which is the whole
  // point of it. Not fatal: the alerts themselves work regardless.
  //
  // Which right that is depends on the chat. A CHANNEL has no separate "Pin
  // Messages" toggle — pinning there is covered by "Edit Messages", and the API
  // omits `can_pin_messages` entirely rather than returning false. Reading the
  // absent field as "denied" would report a working bot as broken.
  const isChannel = chat.result.type === "channel";
  const canPin = isChannel ? self.can_edit_messages !== false : self.can_pin_messages === true;
  const right = isChannel ? "Edit Messages" : "Pin Messages";
  console.log(`permissions    admin, can post${canPin ? ", can pin" : ""}`);
  if (!canPin) {
    console.log(`\nThe bot cannot PIN. The hourly leaderboard will be posted but never`);
    console.log(`pinned. Settings -> Administrators -> @${me.result.username} -> ${right}.`);
  }
}

const sent = await api("sendMessage", {
  chat_id: CHAT_ID,
  text:
    "✅ <b>Alert stream connected</b>\n" +
    "This channel is wired up. Real alerts will look nothing like this one.",
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
});
if (!sent.ok) {
  console.error(`\nSend failed: ${sent.description}`);
  process.exit(1);
}
console.log(`test message   sent`);

if (!PUBLIC_CHANNEL) {
  console.log(
    `\nNEXT_PUBLIC_TELEGRAM_CHANNEL is not set, so /alerts will not show a join` +
      `\nbutton. Set it to the channel username without the @.`
  );
} else {
  console.log(`join link      https://t.me/${PUBLIC_CHANNEL.replace(/^@/, "")}`);
}

console.log(`\nFor a real alert end to end: npm run alerts:replay -- --simulate`);
