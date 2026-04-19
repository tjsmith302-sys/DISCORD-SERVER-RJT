import 'dotenv/config';
import { Client, GatewayIntentBits, Events, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { log } from './lib/logger.js';
import {
  createMeeting,
  finalizeMeeting,
  getTranscript,
  getLatestMeeting,
} from './lib/supabase.js';
import { summarizeMeeting } from './lib/openai.js';
import { startRecording, stopRecording, getSession } from './lib/recorder.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  log.error('DISCORD_TOKEN is required');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

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

  const meeting = await createMeeting({
    guildId: interaction.guildId,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name,
    startedBy: interaction.user.id,
  });

  await startRecording({
    voiceChannel,
    meetingId: meeting.id,
    textChannel: interaction.channel,
  });

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
  const { summary, action_items, decisions } = await summarizeMeeting(transcript);

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
    summary,
    action_items,
    decisions,
  });

  const transcriptFile = buildTranscriptAttachment(transcript, finished.meetingId);

  await interaction.editReply({
    embeds: [embed],
    files: transcriptFile ? [transcriptFile] : [],
  });
}

async function handleSummary(interaction) {
  const meeting = await getLatestMeeting(interaction.guildId, interaction.channel.id);
  if (!meeting) {
    return interaction.reply({ content: 'No past meetings found for this channel.', ephemeral: true });
  }
  const embed = buildSummaryEmbed({
    title: '📝 Last meeting summary',
    meetingId: meeting.id,
    channelName: meeting.channel_name,
    startedAt: new Date(meeting.started_at),
    summary: meeting.summary || '_(no summary yet)_',
    action_items: meeting.action_items || [],
    decisions: meeting.decisions || [],
  });
  await interaction.reply({ embeds: [embed] });
}

async function handleTranscript(interaction) {
  const meeting = await getLatestMeeting(interaction.guildId, interaction.channel.id);
  if (!meeting) {
    return interaction.reply({ content: 'No past meetings found for this channel.', ephemeral: true });
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

function buildSummaryEmbed({ title, meetingId, channelName, startedAt, summary, action_items, decisions }) {
  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(title)
    .setDescription(truncate(summary, 4000))
    .addFields(
      { name: 'Channel', value: channelName || 'Unknown', inline: true },
      { name: 'Started', value: `<t:${Math.floor(startedAt.getTime()/1000)}:f>`, inline: true },
    );

  if (action_items?.length) {
    const lines = action_items.slice(0, 15).map((a) => {
      const owner = a.owner || 'Unassigned';
      const due = a.due ? ` _(due: ${a.due})_` : '';
      return `• **${owner}** — ${a.task}${due}`;
    });
    embed.addFields({ name: '✅ Action items', value: truncate(lines.join('\n'), 1024) });
  }
  if (decisions?.length) {
    const lines = decisions.slice(0, 10).map(d => `• ${d}`);
    embed.addFields({ name: '📌 Decisions', value: truncate(lines.join('\n'), 1024) });
  }

  embed.setFooter({ text: `Meeting ID: ${meetingId}` });
  return embed;
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
