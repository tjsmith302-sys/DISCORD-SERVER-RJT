import { SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
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
].map(c => c.toJSON());
