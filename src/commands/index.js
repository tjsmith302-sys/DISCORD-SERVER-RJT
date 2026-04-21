import { SlashCommandBuilder } from 'discord.js';

// Note: tier/category choices are populated dynamically at registration time
// from rjtcal's DB. See register-commands.js.
export function buildCommandDefinitions({ tiers = [], categories = [] } = {}) {
  return [
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
      .setDescription('Team calendar — schedule events synced with the rjtcal web app')
      .addSubcommand(sub => {
        const s = sub
          .setName('add')
          .setDescription('Create a new team event')
          .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true))
          .addStringOption(o => o.setName('when').setDescription('When? e.g. "tomorrow 3pm", "Friday 10am", "April 25 2pm"').setRequired(true))
          .addStringOption(o => o.setName('description').setDescription('Optional notes'))
          .addStringOption(o => {
            o.setName('tier').setDescription('Reminder priority tier');
            for (const t of tiers.slice(0, 25)) o.addChoices({ name: t.name, value: t.id });
            return o;
          })
          .addStringOption(o => {
            o.setName('category').setDescription('Category (icon + color)');
            for (const c of categories.slice(0, 25)) o.addChoices({ name: `${c.icon} ${c.name}`, value: c.id });
            return o;
          })
          .addBooleanOption(o => o.setName('auto_join_voice').setDescription('Bot auto-joins voice at event time to transcribe'))
          .addChannelOption(o => o.setName('voice_channel').setDescription('Which voice channel to auto-join'));
        return s;
      })
      .addSubcommand(sub => sub.setName('list').setDescription('List upcoming events'))
      .addSubcommand(sub =>
        sub.setName('cancel').setDescription('Cancel an event you created')
          .addStringOption(o => o.setName('id').setDescription('Event ID (from /event list)').setRequired(true))
      )
      .addSubcommand(sub => sub.setName('today').setDescription("Show today's agenda"))
      .addSubcommand(sub => sub.setName('week').setDescription("Show this week's agenda")),

    new SlashCommandBuilder()
      .setName('remind')
      .setDescription('Set a personal reminder for yourself')
      .addStringOption(o => o.setName('what').setDescription('What to remind you about').setRequired(true))
      .addStringOption(o => o.setName('when').setDescription('When? e.g. "in 2 hours", "tomorrow 9am"').setRequired(true)),
  ].map(c => c.toJSON());
}

// Backward-compat export for code that imports commandDefinitions directly.
// Uses an empty tier/category list — register-commands.js builds the full version.
export const commandDefinitions = buildCommandDefinitions();
