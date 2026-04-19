// Posts a "How to use meeting bot" guide to #bot-logs and pins it.
// Idempotent: if a pinned message from the bot starts with the same title,
// it edits that message instead of posting a duplicate.
//
// Usage: DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/post-how-to-use.mjs

import 'dotenv/config';
import { Client, GatewayIntentBits, ChannelType, EmbedBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TARGET_CHANNEL_NAME = process.env.GUIDE_CHANNEL || 'bot-logs';

const TITLE = '🤖 How to use the team bot';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

function buildGuideEmbeds() {
  // Discord embeds cap at 4096 chars description + 1024/field. Split into 3 embeds for readability.

  const overview = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(TITLE)
    .setDescription(
      "Hey team 👋 — here's everything the bot can do right now. Keep this pinned for reference.\n\n" +
      "**What it is:** a Discord bot that (1) records and summarizes voice meetings, and (2) runs a team calendar with events, RSVPs, reminders, and daily agendas.\n\n" +
      "**Where results go:** meeting summaries + transcripts post to `#bot-logs`. Calendar events, reminders, and agendas post in `#calendar`."
    )
    .addFields(
      { name: '🎤 Meeting recording', value: 'Join a voice channel, run `/join` from any text channel, talk your meeting, then `/leave`. Bot posts a summary + full transcript to `#bot-logs`.', inline: false },
      { name: '📅 Team calendar', value: 'Use `/event add` to schedule anything — team meetings, demos, deadlines. Set personal reminders with `/remind`. Bot posts today\'s agenda every morning at 8am ET and a full week overview every Monday.', inline: false },
    );

  const meetingCommands = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle('🎤 Meeting commands')
    .setDescription(
      "**`/join`** — Bot joins the voice channel you're currently in and starts recording + live transcription.\n" +
      "_Requires:_ you must already be in a voice channel.\n\n" +

      "**`/leave`** — Bot stops recording, posts a summary to `#bot-logs` with:\n" +
      "• 🧠 TL;DR headline\n" +
      "• 💬 What we discussed (bullet points)\n" +
      "• 📌 Decisions made\n" +
      "• ✅ Action items (with owners + due dates)\n" +
      "• 📄 Full transcript as a `.txt` attachment\n\n" +

      "**`/status`** — Shows if the bot is currently recording and which channel.\n\n" +

      "**`/summary`** — Re-posts the most recent meeting summary (anywhere in the server).\n\n" +

      "**`/transcript`** — Uploads the full transcript of the most recent meeting as a `.txt`."
    );

  const calendarCommands = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('📅 Calendar commands')
    .setDescription(
      "**`/event add`** — Create a team event.\n" +
      "Options: `title`, `when` (natural language — \"tomorrow 3pm\", \"Friday 10am\", \"April 25 2pm\"), `description` (optional), `auto_join_voice` (bot records the meeting automatically), `voice_channel` (which one to join).\n" +
      "Posts a card in `#calendar` with ✅ Going / 🤔 Maybe / ❌ Not going buttons.\n\n" +

      "**`/event list`** — Shows the next 10 upcoming events with IDs.\n\n" +

      "**`/event today`** — Today's agenda.\n\n" +

      "**`/event week`** — This week's agenda.\n\n" +

      "**`/event cancel id:<event-id>`** — Cancel an event (creator only). Get the ID from `/event list`.\n\n" +

      "**`/remind what:<thing> when:<time>`** — Set a personal reminder. Only you get pinged. Example: `/remind what:\"call supplier\" when:\"tomorrow 9am\"`."
    )
    .addFields(
      { name: '🔔 Automatic calendar posts', value:
        '• **8am ET every day** → today\'s agenda in `#calendar`\n' +
        '• **8am ET every Monday** → full week overview\n' +
        '• **15 min before each event** → reminder with `@here` ping\n' +
        '• **At event time (if auto_join_voice)** → bot joins voice and starts recording automatically',
        inline: false },
      { name: '📝 Example', value:
        '`/event add title:\"CLAIMMAX demo\" when:\"Friday 2pm\" auto_join_voice:true`\n' +
        '→ Event card posts in `#calendar`, everyone RSVPs with buttons, 15-min reminder fires Friday at 1:45pm, bot auto-joins the voice meeting at 2pm and records it.',
        inline: false },
    );

  const howto = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle('🎯 How a typical meeting flow works')
    .setDescription(
      "**1. Hop in voice.** Join any voice channel on the server.\n\n" +
      "**2. Type `/join`** in any text channel. Bot will confirm: _'Recording started in [channel]'._\n\n" +
      "**3. Have your meeting normally.** Bot captures everyone who's speaking — each person is tagged separately in the transcript.\n\n" +
      "**4. Type `/leave`** when done. Bot posts:\n" +
      "• A summary card in `#bot-logs` with discussion points, decisions, action items\n" +
      "• A `.txt` transcript attached\n\n" +
      "**5. Want it again later?** Use `/summary` or `/transcript` from anywhere in the server."
    )
    .addFields(
      { name: '💡 Tips', value:
        '• **Speak clearly.** Whisper is accurate but mumbling hurts it.\n' +
        '• **One person at a time** gives the cleanest transcript — overlapping voices merge into one segment.\n' +
        '• **Recordings are not saved** — only the transcript text + summary are stored (Supabase).\n' +
        '• **Private meetings?** Don\'t `/join` and everyone stays off the record.\n' +
        '• **Bot is silent in voice** — it only listens and transcribes, never plays audio.',
        inline: false },
      { name: '❓ Troubleshooting', value:
        '• **"Failed to connect to voice"** → usually fixed by the bot restarting itself. Try again in 30s.\n' +
        '• **"No speech captured"** → meeting was too short or mic was muted. Check that you weren\'t muted in Discord.\n' +
        '• **Summary looks off?** → GPT-4o works better with longer meetings (2+ min). Very short ones yield thin summaries.',
        inline: false },
      { name: '🔐 Privacy', value:
        'Audio is streamed to OpenAI Whisper for transcription, then **discarded**. Only the text transcript and summary are stored in your private Supabase. No audio files persist anywhere.',
        inline: false },
    )
    .setFooter({ text: 'Questions? Ask TJ. Bot running on Fly.io • Updated April 19, 2026' });

  return [overview, meetingCommands, calendarCommands, howto];
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.channels.fetch();

  const channel = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === TARGET_CHANNEL_NAME.toLowerCase()
  );
  if (!channel) {
    console.error(`Channel #${TARGET_CHANNEL_NAME} not found`);
    process.exit(1);
  }

  const embeds = buildGuideEmbeds();

  // Look for an existing pinned guide from the bot and edit it instead of duplicating.
  const pinned = await channel.messages.fetchPinned();
  const existing = pinned.find(
    m => m.author.id === client.user.id &&
         m.embeds.length > 0 &&
         m.embeds[0].title === TITLE
  );

  let message;
  if (existing) {
    message = await existing.edit({ embeds });
    console.log(`✓ Updated existing pinned guide (id=${message.id})`);
  } else {
    message = await channel.send({ embeds });
    try {
      await message.pin();
      console.log(`✓ Posted and pinned guide in #${channel.name} (id=${message.id})`);
    } catch (err) {
      console.log(`✓ Posted guide (id=${message.id}) — pin failed: ${err.message}`);
    }
  }

  await client.destroy();
  process.exit(0);
});

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
