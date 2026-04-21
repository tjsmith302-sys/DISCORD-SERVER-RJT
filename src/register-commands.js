import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { buildCommandDefinitions } from './commands/index.js';
import { listTiers, listCategories } from './lib/calendar.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required');
  process.exit(1);
}

let tiers = [];
let categories = [];
try {
  tiers = await listTiers();
  categories = await listCategories();
  console.log(`Loaded ${tiers.length} tiers and ${categories.length} categories from rjtcal DB`);
} catch (err) {
  console.warn(`Could not load tiers/categories from DB: ${err.message} — registering with empty choices`);
}

const commandDefinitions = buildCommandDefinitions({ tiers, categories });
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
  process.exit(0);
} catch (err) {
  console.error('Command registration failed', err);
  process.exit(1);
}
