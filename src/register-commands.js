import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands/index.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    console.log(`Registering ${commandDefinitions.length} guild commands to ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandDefinitions });
    console.log('Guild commands registered (instant).');
  } else {
    console.log(`Registering ${commandDefinitions.length} global commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commandDefinitions });
    console.log('Global commands registered (may take up to 1 hour to appear).');
  }
} catch (err) {
  console.error('Command registration failed', err);
  process.exit(1);
}
