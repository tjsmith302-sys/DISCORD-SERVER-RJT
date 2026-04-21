import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
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
import {
  parseNaturalDate,
  createEvent,
  cancelEvent,
  listUpcomingEvents,
  getEvent,
  setRsvp,
  getRsvps,
  createReminder,
  getTodaysEvents,
  getThisWeeksEvents,
  formatDiscordTime,
  formatForTeam,
} from './lib/calendar.js';
import { startScheduler } from './lib/scheduler.js';

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
  const existing = guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText &&
    c.name.toLowerCase() === LOG_CHANNEL_NAME.toLowerCase()
  );
  if (existing) return existing;

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    log.warn(`Cannot create #${LOG_CHANNEL_NAME}: bot lacks Manage Channels permission.`);
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
  // Fire up the calendar scheduler (15-min reminders, auto-join, daily/weekly, personal reminders)
  startScheduler(c, {
    onVoiceAutoJoin: (event) => autoJoinForEvent(c, event),
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      switch (commandName) {
        case 'join':   return handleJoin(interaction);
        case 'leave':  return handleLeave(interaction);
        case 'summary':    return handleSummary(interaction);
        case 'transcript': return handleTranscript(interaction);
        case 'status': return handleStatus(interaction);
        case 'event':  return handleEvent(interaction);
        case 'remind': return handleRemind(interaction);
      }
    } else if (interaction.isButton()) {
      return handleButton(interaction);
    }
  } catch (err) {
    log.error(`Interaction failed`, err);
    const msg = `Error: ${err.message || 'unknown'}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

// ============================================================
// Meeting recording handlers (unchanged)
// ============================================================

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
  const meeting = await getLatestMeetingForGuild(interaction.guildId);
  if (!meeting) {
    return interaction.reply({ content: 'No past meetings found in this server.', ephemeral: true });
  }
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

// ============================================================
// Calendar handlers
// ============================================================

async function handleEvent(interaction) {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'add':    return handleEventAdd(interaction);
    case 'list':   return handleEventList(interaction);
    case 'cancel': return handleEventCancel(interaction);
    case 'today':  return handleEventToday(interaction);
    case 'week':   return handleEventWeek(interaction);
  }
}

async function handleEventAdd(interaction) {
  const title = interaction.options.getString('title', true);
  const whenInput = interaction.options.getString('when', true);
  const description = interaction.options.getString('description');
  const tierId = interaction.options.getString('tier');
  const categoryId = interaction.options.getString('category');
  const autoJoin = interaction.options.getBoolean('auto_join_voice') ?? false;
  const voiceChannel = interaction.options.getChannel('voice_channel');

  const startsAt = parseNaturalDate(whenInput);
  if (!startsAt) {
    return interaction.reply({
      content: `❌ Couldn't understand "${whenInput}". Try: "tomorrow 3pm", "Friday 10am", or "April 25 2pm".`,
      ephemeral: true,
    });
  }
  if (startsAt.getTime() < Date.now() - 60_000) {
    return interaction.reply({ content: '❌ That time is in the past.', ephemeral: true });
  }
  if (autoJoin && voiceChannel && voiceChannel.type !== ChannelType.GuildVoice) {
    return interaction.reply({ content: '❌ `voice_channel` must be a voice channel.', ephemeral: true });
  }

  await interaction.deferReply();

  const event = await createEvent({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    createdBy: { id: interaction.user.id, username: interaction.user.username },
    title,
    description,
    startsAt,
    tierId,
    categoryId,
    voiceAutoJoin: autoJoin,
    voiceChannelId: voiceChannel?.id || null,
  });

  const embed = buildEventEmbed(event);
  const row = buildRsvpRow(event.id);

  await interaction.editReply({
    content: `✅ Event created by <@${interaction.user.id}>`,
    embeds: [embed],
    components: [row],
  });
}

async function handleEventList(interaction) {
  const events = await listUpcomingEvents(interaction.guildId, { limit: 10 });
  if (!events.length) {
    return interaction.reply({ content: '📭 No upcoming events. Use `/event add` to create one.', ephemeral: true });
  }
  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle('📅 Upcoming events')
    .setDescription(events.map(ev =>
      `• **${ev.title}** — ${formatDiscordTime(new Date(ev.starts_at), 'F')}${ev.voice_auto_join ? ' 🎙️' : ''}\n   ID: \`${ev.id}\``
    ).join('\n\n'))
    .setFooter({ text: `Showing ${events.length} event${events.length === 1 ? '' : 's'}` });
  await interaction.reply({ embeds: [embed] });
}

async function handleEventCancel(interaction) {
  const id = interaction.options.getString('id', true);
  try {
    const event = await cancelEvent(id, interaction.user.id);
    await interaction.reply({ content: `🗑️ Cancelled **${event.title}**.` });
  } catch (err) {
    const isForbidden = err.forbidden;
    await interaction.reply({
      content: isForbidden ? '❌ Only the event creator can cancel it.' : `❌ ${err.message}`,
      ephemeral: true,
    });
  }
}

async function handleEventToday(interaction) {
  const events = await getTodaysEvents(interaction.guildId);
  if (!events.length) {
    return interaction.reply({ content: '☀️ Nothing on the calendar today.', ephemeral: true });
  }
  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle("☀️ Today's agenda")
    .setDescription(events.map(ev =>
      `• ${formatDiscordTime(new Date(ev.starts_at), 't')} — **${ev.title}**${ev.voice_auto_join ? ' 🎙️' : ''}`
    ).join('\n'));
  await interaction.reply({ embeds: [embed] });
}

async function handleEventWeek(interaction) {
  const events = await getThisWeeksEvents(interaction.guildId);
  if (!events.length) {
    return interaction.reply({ content: '📅 No events this week.', ephemeral: true });
  }
  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle("📅 This week")
    .setDescription(events.map(ev =>
      `• ${formatDiscordTime(new Date(ev.starts_at), 'F')} — **${ev.title}**${ev.voice_auto_join ? ' 🎙️' : ''}`
    ).join('\n'));
  await interaction.reply({ embeds: [embed] });
}

async function handleRemind(interaction) {
  const what = interaction.options.getString('what', true);
  const whenInput = interaction.options.getString('when', true);
  const remindAt = parseNaturalDate(whenInput);
  if (!remindAt) {
    return interaction.reply({
      content: `❌ Couldn't understand "${whenInput}". Try: "in 2 hours", "tomorrow 9am", or "Friday 3pm".`,
      ephemeral: true,
    });
  }
  if (remindAt.getTime() < Date.now() - 60_000) {
    return interaction.reply({ content: '❌ That time is in the past.', ephemeral: true });
  }
  await createReminder({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    user: { id: interaction.user.id, username: interaction.user.username },
    content: what,
    remindAt,
  });
  await interaction.reply({
    content: `⏰ Reminder set: **${what}** — ${formatDiscordTime(remindAt, 'F')} (${formatDiscordTime(remindAt, 'R')})`,
    ephemeral: true,
  });
}

// ============================================================
// Button interactions (RSVP)
// ============================================================

async function handleButton(interaction) {
  const [prefix, action, eventId] = interaction.customId.split(':');
  if (prefix !== 'rsvp') return;

  const statusMap = { going: 'going', maybe: 'maybe', notgoing: 'not_going' };
  const status = statusMap[action];
  if (!status) return;

  const event = await getEvent(eventId);
  if (!event) {
    return interaction.reply({ content: '❌ Event not found.', ephemeral: true });
  }

  await setRsvp({
    eventId,
    userId: interaction.user.id,
    username: interaction.user.username,
    status,
  });

  // Update original embed with new RSVP counts
  const rsvps = await getRsvps(eventId);
  const updated = buildEventEmbed(event, rsvps);
  const row = buildRsvpRow(eventId);

  await interaction.update({ embeds: [updated], components: [row] });
  const label = status === 'going' ? '✅ Going' : status === 'maybe' ? '🤔 Maybe' : '❌ Not going';
  await interaction.followUp({ content: `<@${interaction.user.id}> — ${label}`, ephemeral: true });
}

function buildEventEmbed(event, rsvps = null) {
  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(`📅 ${event.title}`)
    .setDescription(event.description || '_(no description)_')
    .addFields(
      { name: 'When', value: formatDiscordTime(new Date(event.starts_at), 'F'), inline: true },
      { name: 'Starts', value: formatDiscordTime(new Date(event.starts_at), 'R'), inline: true },
    );
  if (event.voice_auto_join) {
    embed.addFields({
      name: '🎙️ Auto-join voice',
      value: event.voice_channel_id ? `<#${event.voice_channel_id}>` : 'Yes',
      inline: true,
    });
  }
  if (rsvps?.length) {
    const going = rsvps.filter(r => r.status === 'going').map(r => `<@${r.user_id}>`);
    const maybe = rsvps.filter(r => r.status === 'maybe').map(r => `<@${r.user_id}>`);
    const no = rsvps.filter(r => r.status === 'not_going').map(r => `<@${r.user_id}>`);
    const parts = [];
    if (going.length) parts.push(`✅ **Going (${going.length}):** ${going.join(', ')}`);
    if (maybe.length) parts.push(`🤔 **Maybe (${maybe.length}):** ${maybe.join(', ')}`);
    if (no.length)    parts.push(`❌ **Not going (${no.length}):** ${no.join(', ')}`);
    embed.addFields({ name: 'RSVPs', value: parts.join('\n') });
  }
  embed.setFooter({ text: `Event ID: ${event.id}` });
  return embed;
}

function buildRsvpRow(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rsvp:going:${eventId}`).setLabel('Going').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rsvp:maybe:${eventId}`).setLabel('Maybe').setEmoji('🤔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rsvp:notgoing:${eventId}`).setLabel('Not going').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

// ============================================================
// Voice auto-join hook (called by scheduler at event time)
// ============================================================

async function autoJoinForEvent(client, event) {
  const guild = await client.guilds.fetch(event.guild_id).catch(() => null);
  if (!guild) return;

  // Figure out which voice channel to join
  let voiceChannel = null;
  if (event.voice_channel_id) {
    voiceChannel = await guild.channels.fetch(event.voice_channel_id).catch(() => null);
  }
  if (!voiceChannel) {
    // Fallback: first voice channel with any members (likely the meeting)
    voiceChannel = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildVoice && c.members.size > 0)
      .first();
  }
  if (!voiceChannel) {
    log.warn(`Auto-join skipped for event ${event.id}: no voice channel found`);
    return;
  }

  if (getSession(guild.id)) {
    log.info(`Auto-join skipped for event ${event.id}: already recording`);
    return;
  }

  try {
    const meeting = await createMeeting({
      guildId: guild.id,
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      startedBy: event.created_by_user_id,
    });
    await startRecording({
      voiceChannel,
      meetingId: meeting.id,
      textChannel: null,
    });
    log.info(`Auto-join: recording started for event ${event.id} in ${voiceChannel.name}`);

    // Notify calendar channel
    const calChannel = guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText &&
      c.name.toLowerCase() === (process.env.CALENDAR_CHANNEL_NAME || 'calendar').toLowerCase()
    );
    if (calChannel) {
      await calChannel.send({
        content: `🎙️ Auto-joined **${voiceChannel.name}** for **${event.title}** — recording started. Run \`/leave\` when done.`,
      });
    }
  } catch (err) {
    log.error(`Auto-join failed for event ${event.id}`, err.message);
  }
}

// ============================================================
// Shared helpers
// ============================================================

function buildSummaryEmbed({ title, meetingId, channelName, startedAt, headline, discussion_points, summary, action_items, decisions }) {
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
