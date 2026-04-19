// Calendar scheduler: runs every 60s to fire reminders, auto-join voice,
// and post daily/weekly agendas.

import { ChannelType, EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { log } from './logger.js';
import {
  getEventsNeedingReminder,
  markReminderSent,
  getEventsNeedingAutoJoin,
  markAutoJoinFired,
  getDueReminders,
  markReminderSentPersonal,
  getTodaysEvents,
  getThisWeeksEvents,
  getRsvps,
  formatDiscordTime,
} from './calendar.js';

const TEAM_TZ = process.env.TEAM_TIMEZONE || 'America/New_York';
const CALENDAR_CHANNEL_NAME = process.env.CALENDAR_CHANNEL_NAME || 'calendar';

// Track what we've already posted today to avoid double-posts
const postedState = {
  dailyAgendaKey: null,   // "YYYY-MM-DD" string
  weeklyOverviewKey: null, // "YYYY-Www" string
};

export function startScheduler(client, { onVoiceAutoJoin }) {
  log.info('Calendar scheduler started (polls every 60s)');
  // Run immediately once, then every 60s
  tick(client, { onVoiceAutoJoin }).catch(err => log.error('scheduler tick error', err));
  setInterval(() => {
    tick(client, { onVoiceAutoJoin }).catch(err => log.error('scheduler tick error', err));
  }, 60 * 1000);
}

async function tick(client, { onVoiceAutoJoin }) {
  await Promise.all([
    fireEventReminders(client),
    fireVoiceAutoJoins(client, onVoiceAutoJoin),
    firePersonalReminders(client),
    maybePostDailyAgenda(client),
    maybePostWeeklyOverview(client),
  ]);
}

// ---------- 15-min event reminders ----------

async function fireEventReminders(client) {
  const events = await getEventsNeedingReminder();
  for (const ev of events) {
    try {
      const guild = await client.guilds.fetch(ev.guild_id).catch(() => null);
      if (!guild) continue;
      const channel = findCalendarChannel(guild) || (ev.channel_id && await guild.channels.fetch(ev.channel_id).catch(() => null));
      if (!channel) continue;
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle(`⏰ Starting in 15 min — ${ev.title}`)
        .setDescription(ev.description || '_(no description)_')
        .addFields(
          { name: 'When', value: formatDiscordTime(new Date(ev.starts_at), 'F'), inline: true },
          { name: 'Starts', value: formatDiscordTime(new Date(ev.starts_at), 'R'), inline: true },
        )
        .setFooter({ text: `Event ID: ${ev.id}` });
      await channel.send({ content: '@here', embeds: [embed] });
      await markReminderSent(ev.id);
      log.info(`15-min reminder sent for event ${ev.id}`);
    } catch (err) {
      log.error(`Failed to fire reminder for event ${ev.id}`, err.message);
    }
  }
}

// ---------- Voice auto-join ----------

async function fireVoiceAutoJoins(client, onVoiceAutoJoin) {
  const events = await getEventsNeedingAutoJoin();
  for (const ev of events) {
    try {
      if (!onVoiceAutoJoin) continue;
      await markAutoJoinFired(ev.id); // mark first to avoid retry loops
      await onVoiceAutoJoin(ev);
      log.info(`Voice auto-join fired for event ${ev.id}`);
    } catch (err) {
      log.error(`Voice auto-join failed for event ${ev.id}`, err.message);
    }
  }
}

// ---------- Personal reminders ----------

async function firePersonalReminders(client) {
  const reminders = await getDueReminders();
  for (const r of reminders) {
    try {
      const guild = await client.guilds.fetch(r.guild_id).catch(() => null);
      if (!guild) continue;
      const channel = await guild.channels.fetch(r.channel_id).catch(() => null)
        || findCalendarChannel(guild);
      if (!channel) continue;
      await channel.send({
        content: `⏰ <@${r.user_id}> reminder: **${r.content}**`,
      });
      await markReminderSentPersonal(r.id);
      log.info(`Personal reminder sent id=${r.id}`);
    } catch (err) {
      log.error(`Failed to fire personal reminder ${r.id}`, err.message);
    }
  }
}

// ---------- Daily 8am agenda ----------

async function maybePostDailyAgenda(client) {
  const nowTeam = DateTime.now().setZone(TEAM_TZ);
  if (nowTeam.hour !== 8) return; // only fires during the 8am hour
  const key = nowTeam.toFormat('yyyy-LL-dd');
  if (postedState.dailyAgendaKey === key) return;

  for (const guild of client.guilds.cache.values()) {
    try {
      const channel = findCalendarChannel(guild);
      if (!channel) continue;
      const events = await getTodaysEvents(guild.id);
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle(`☀️ Good morning — today's agenda (${nowTeam.toFormat('ccc, LLL d')})`);

      if (!events.length) {
        embed.setDescription('Nothing on the calendar today. Have a productive one.');
      } else {
        const lines = events.map(ev =>
          `• ${formatDiscordTime(new Date(ev.starts_at), 't')} — **${ev.title}**${ev.voice_auto_join ? ' 🎙️' : ''}`
        );
        embed.setDescription(lines.join('\n'));
        embed.setFooter({ text: `${events.length} event${events.length === 1 ? '' : 's'} today` });
      }

      await channel.send({ embeds: [embed] });
    } catch (err) {
      log.error(`Daily agenda failed for guild ${guild.id}`, err.message);
    }
  }
  postedState.dailyAgendaKey = key;
}

// ---------- Monday 8am weekly overview ----------

async function maybePostWeeklyOverview(client) {
  const nowTeam = DateTime.now().setZone(TEAM_TZ);
  if (nowTeam.weekday !== 1) return; // Monday only
  if (nowTeam.hour !== 8) return;
  const key = `${nowTeam.weekYear}-W${String(nowTeam.weekNumber).padStart(2, '0')}`;
  if (postedState.weeklyOverviewKey === key) return;

  for (const guild of client.guilds.cache.values()) {
    try {
      const channel = findCalendarChannel(guild);
      if (!channel) continue;
      const events = await getThisWeeksEvents(guild.id);
      const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle(`📅 Week of ${nowTeam.startOf('week').toFormat('LLL d')}`);

      if (!events.length) {
        embed.setDescription('No events scheduled this week yet. Use `/event add` to plan something.');
      } else {
        // Group by day
        const byDay = new Map();
        for (const ev of events) {
          const dayKey = DateTime.fromJSDate(new Date(ev.starts_at)).setZone(TEAM_TZ).toFormat('cccc');
          if (!byDay.has(dayKey)) byDay.set(dayKey, []);
          byDay.get(dayKey).push(ev);
        }
        const sections = [];
        for (const [day, evs] of byDay.entries()) {
          const lines = evs.map(ev =>
            `  • ${formatDiscordTime(new Date(ev.starts_at), 't')} — ${ev.title}${ev.voice_auto_join ? ' 🎙️' : ''}`
          );
          sections.push(`**${day}**\n${lines.join('\n')}`);
        }
        embed.setDescription(sections.join('\n\n'));
        embed.setFooter({ text: `${events.length} event${events.length === 1 ? '' : 's'} this week` });
      }

      await channel.send({ embeds: [embed] });
    } catch (err) {
      log.error(`Weekly overview failed for guild ${guild.id}`, err.message);
    }
  }
  postedState.weeklyOverviewKey = key;
}

// ---------- Helpers ----------

function findCalendarChannel(guild) {
  return guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText &&
    c.name.toLowerCase() === CALENDAR_CHANNEL_NAME.toLowerCase()
  );
}
