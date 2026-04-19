import { SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
  // --- Meeting recording commands ---
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and start transcribing the meeting'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop transcription, post the summary, and leave the voice channel'),
  new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Post the summary of the most recent meeting in this channel'),
  new SlashCommandBuilder()
    .setName('transcript')
    .setDescription('Upload the full transcript of the most recent meeting as a text file'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check whether the bot is currently recording in this server'),

  // --- Calendar commands ---
  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Team event commands')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Create a new team event')
        .addStringOption(o => o.setName('title').setDescription('Event title (e.g. "CLAIMMAX demo")').setRequired(true))
        .addStringOption(o => o.setName('when').setDescription('When? e.g. "tomorrow 3pm", "Friday 10am", "April 25 2pm"').setRequired(true))
        .addStringOption(o => o.setName('description').setDescription('Optional description or notes').setRequired(false))
        .addBooleanOption(o => o.setName('auto_join_voice').setDescription('Bot auto-joins a voice channel at event time to transcribe').setRequired(false))
        .addChannelOption(o => o.setName('voice_channel').setDescription('Which voice channel to auto-join (if enabled)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List upcoming events in this server')
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel an event you created')
        .addStringOption(o => o.setName('id').setDescription('Event ID (get from /event list)').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('today')
        .setDescription("Show today's agenda")
    )
    .addSubcommand(sub =>
      sub.setName('week')
        .setDescription("Show this week's agenda")
    ),

  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a personal reminder for yourself')
    .addStringOption(o => o.setName('what').setDescription('What to remind you about').setRequired(true))
    .addStringOption(o => o.setName('when').setDescription('When? e.g. "in 2 hours", "tomorrow 9am", "Friday"').setRequired(true)),
].map(c => c.toJSON());
