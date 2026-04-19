import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { log } from './lib/logger.js';
import {
  createMeeting,
  finalizeMeeting,
  getTranscript,
  getLatestMeeting,
  getLatestMeetingForGuild,
} from './lib/supabase.js';
import { summarizeMeeting } from './lib/openai.js';
import { startRecording, stopRecording, getSession } from './lib/recorder.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  log.error('DISCORD_TOKEN is required');
  process.exit(1);
}

const LOG_CHANNEL_NAME = process.env.LOG_CHANNEL_NAME || 'meeting-logs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// Finds an existing #meeting-logs channel in the guild, or creates one.
async function getOrCreateLogChannel(guild) {
  // Try existing first (case-insensitive match on name)
  const existing = guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText &&
    c.name.toLowerCase() === LOG_CHANNEL_NAME.toLowerCase()
  );
  if (existing) return existing;

  // Check if bot has permission to create channels
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    log.warn(`Cannot create #${LOG_CHANNEL_NAME}: bot lacks Manage Channels permission. Falling back to original channel.`);
    return null;
  }

  try {
    const created = await guild.channels.create({
      name: LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Auto-generated meeting summaries and transcripts from Meeting Bot',
      reason: 'Meeting Bot auto-created log channel',
    });
    log.info(`Created log channel #${created.name} in guild=${guild.id}`);
    return created;
  } catch (err) {
    log.error('Failed to create log channel', err.message);
    return null;
  }
}

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag}. Listening for slash commands.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId } = interaction;

  try {
    switch (commandName) {
      case 'join':   return handleJoin(interaction);
      case 'leave':  return handleLeave(interaction);
      case 'summary':    return handleSummary(interaction);
      case 'transcript': return handleTranscript(interaction);
      case 'status': return handleStatus(interaction);
    }
  } catch (err) {
    log.error(`Command ${commandName} failed`, err);
    const msg = `Error: ${err.message || 'unknown'}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

async function handleJoin(interaction) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: 'Join a voice channel first, then run `/join`.', ephemeral: true });
  }
  if (getSession(interaction.guildId)) {
    return interaction.reply({ content: 'Already recording in this server. Use `/leave` to stop.', ephemeral: true });
  }

  await interaction.deferReply();
  log.info(`[/join] user=${interaction.user.id} channel=${voiceChannel.name} (${voiceChannel.id})`);

  // Permission sanity check before we try to connect
  const me = interaction.guild.members.me;
  const perms = voiceChannel.permissionsFor(me);
  if (!perms?.has('Connect') || !perms?.has('Speak')) {
    log.warn(`Missing Connect/Speak perms in channel ${voiceChannel.id}`);
    return interaction.editReply({
      content: `❌ I don't have **Connect** and **Speak** permissions on ${voiceChannel.name}. Fix channel permissions and try again.`,
    });
  }

  let meeting;
  try {
    meeting = await createMeeting({
      guildId: interaction.guildId,
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      startedBy: interaction.user.id,
    });
    log.info(`Meeting row created id=${meeting.id}`);
  } catch (err) {
    log.error('createMeeting failed', err);
    return interaction.editReply({ content: `❌ Supabase error: ${err.message}` });
  }

  try {
    await startRecording({
      voiceChannel,
      meetingId: meeting.id,
      textChannel: interaction.channel,
    });
  } catch (err) {
    log.error('startRecording failed', err);
    return interaction.editReply({ content: `❌ ${err.message}` });
  }

  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('🎙️ Recording started')
    .setDescription(`Transcribing **${voiceChannel.name}**.\nRun \`/leave\` when the meeting ends — I'll post a summary here.`)
    .setFooter({ text: `Meeting ID: ${meeting.id}` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleLeave(interaction) {
  const session = getSession(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'Not currently recording.', ephemeral: true });
  }

  await interaction.deferReply();

  const finished = await stopRecording(interaction.guildId);
  const transcript = await getTranscript(finished.meetingId);
  const { summary, headline, discussion_points, action_items, decisions } = await summarizeMeeting(transcript);

  await finalizeMeeting({
    meetingId: finished.meetingId,
    summary,
    actionItems: action_items,
    decisions,
  });

  const embed = buildSummaryEmbed({
    title: '📝 Meeting summary',
    meetingId: finished.meetingId,
    channelName: finished.voiceChannel.name,
    startedAt: new Date(finished.startedAt),
    headline,
    discussion_points,
    summary,
    action_items,
    decisions,
  });

  const transcriptFile = buildTranscriptAttachment(transcript, finished.meetingId);
  const payload = { embeds: [embed], files: transcriptFile ? [transcriptFile] : [] };

  // Post summary + transcript to #meeting-logs (or fall back to current channel)
  const logChannel = await getOrCreateLogChannel(interaction.guild);
  const target = logChannel || interaction.channel;

  try {
    await target.send(payload);
  } catch (err) {
    log.error('Failed to post to log channel, falling back', err.message);
    await interaction.channel.send(payload);
  }

  const logLink = logChannel && logChannel.id !== interaction.channelId
    ? ` in <#${logChannel.id}>`
    : '';
  await interaction.editReply({
    content: `✅ Meeting ended — summary and transcript posted${logLink}.`,
  });
}

async function handleSummary(interaction) {
  // Look up the most recent meeting anywhere in the guild (not just current channel)
  const meeting = await getLatestMeetingForGuild(interaction.guildId);
  if (!meeting) {
    return interaction.reply({ content: 'No past meetings found in this server.', ephemeral: true });
  }
  // Older meetings only have `summary` text; parse bullets out of it for display.
  const storedSummary = meeting.summary || '_(no summary yet)_';
  const { headline, discussion_points } = splitStoredSummary(storedSummary);
  const embed = buildSummaryEmbed({
    title: '📝 Last meeting summary',
    meetingId: meeting.id,
    channelName: meeting.channel_name,
    startedAt: new Date(meeting.started_at),
    headline,
    discussion_points,
    summary: storedSummary,
    action_items: meeting.action_items || [],
    decisions: meeting.decisions || [],
  });
  await interaction.reply({ embeds: [embed] });
}

async function handleTranscript(interaction) {
  const meeting = await getLatestMeetingForGuild(interaction.guildId);
  if (!meeting) {
    return interaction.reply({ content: 'No past meetings found in this server.', ephemeral: true });
  }
  const transcript = await getTranscript(meeting.id);
  const file = buildTranscriptAttachment(transcript, meeting.id);
  if (!file) {
    return interaction.reply({ content: 'Transcript is empty.', ephemeral: true });
  }
  await interaction.reply({ content: `Full transcript for meeting \`${meeting.id}\`:`, files: [file] });
}

async function handleStatus(interaction) {
  const session = getSession(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'Not recording. Use `/join` in a voice channel to start.', ephemeral: true });
  }
  const mins = Math.floor((Date.now() - session.startedAt) / 60000);
  await interaction.reply({
    content: `🟢 Recording in **${session.voiceChannel.name}** for ${mins} min. Meeting ID: \`${session.meetingId}\`.`,
    ephemeral: true,
  });
}

function buildSummaryEmbed({ title, meetingId, channelName, startedAt, headline, discussion_points, summary, action_items, decisions }) {
  // Description: headline TL;DR (falls back to summary text if no headline present)
  const description = headline && headline.trim()
    ? headline
    : truncate(summary || '_(no summary)_', 4000);

  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(title)
    .setDescription(truncate(description, 4000))
    .addFields(
      { name: 'Channel', value: channelName || 'Unknown', inline: true },
      { name: 'Started', value: `<t:${Math.floor(startedAt.getTime()/1000)}:f>`, inline: true },
    );

  // 💬 Discussion points — what was actually talked about
  if (discussion_points?.length) {
    const lines = discussion_points.slice(0, 15).map(p => `• ${p}`);
    embed.addFields({ name: '💬 What we discussed', value: truncate(lines.join('\n'), 1024) });
  }

  if (decisions?.length) {
    const lines = decisions.slice(0, 10).map(d => `• ${d}`);
    embed.addFields({ name: '📌 Decisions', value: truncate(lines.join('\n'), 1024) });
  }

  if (action_items?.length) {
    const lines = action_items.slice(0, 15).map((a) => {
      const owner = a.owner || 'Unassigned';
      const due = a.due ? ` _(due: ${a.due})_` : '';
      return `• **${owner}** — ${a.task}${due}`;
    });
    embed.addFields({ name: '✅ Action items', value: truncate(lines.join('\n'), 1024) });
  }

  embed.setFooter({ text: `Meeting ID: ${meetingId}` });
  return embed;
}

// Parse legacy stored summary text (first non-bullet line = headline, bullet lines = points)
function splitStoredSummary(text) {
  if (!text) return { headline: '', discussion_points: [] };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let headline = '';
  const discussion_points = [];
  for (const line of lines) {
    if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
      discussion_points.push(line.replace(/^[•\-*]\s*/, ''));
    } else if (!headline) {
      headline = line;
    } else {
      // Additional non-bullet line: treat as a bullet too
      discussion_points.push(line);
    }
  }
  return { headline, discussion_points };
}

function buildTranscriptAttachment(segments, meetingId) {
  if (!segments?.length) return null;
  const body = segments
    .map(s => `[${new Date(s.started_at).toISOString()}] ${s.speaker_name || 'Unknown'}: ${s.text}`)
    .join('\n');
  return new AttachmentBuilder(Buffer.from(body, 'utf8'), {
    name: `transcript-${meetingId}.txt`,
  });
}

function truncate(s, n) {
  if (!s) return '—';
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

// Graceful shutdown
process.on('SIGINT', async () => { await client.destroy(); process.exit(0); });
process.on('SIGTERM', async () => { await client.destroy(); process.exit(0); });

client.login(token);
