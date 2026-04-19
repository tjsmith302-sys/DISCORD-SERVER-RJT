// Calendar feature: events, RSVPs, reminders, daily/weekly agenda.
// All timezone math uses America/New_York as the team's timezone.

import { supabase } from './supabase.js';
function getSupabase() {
  if (!supabase) throw new Error('Supabase not configured');
  return supabase;
}
import { log } from './logger.js';
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

const TEAM_TZ = process.env.TEAM_TIMEZONE || 'America/New_York';
export const CALENDAR_CHANNEL_NAME = process.env.CALENDAR_CHANNEL_NAME || 'calendar';
export const BOT_LOGS_CHANNEL_NAME = process.env.LOG_CHANNEL_NAME || 'bot-logs';

// ---------- Date parsing ----------

/**
 * Parse a natural-language date string using the team's timezone as reference.
 * Returns a Date (UTC) or null.
 *   parseNaturalDate("tomorrow 3pm") -> Date
 *   parseNaturalDate("Friday at 2pm")
 *   parseNaturalDate("April 25 10:30am")
 *   parseNaturalDate("in 2 hours")
 */
export function parseNaturalDate(input, referenceDate = new Date()) {
  if (!input) return null;
  // Interpret relative to team timezone
  const refInTz = DateTime.fromJSDate(referenceDate).setZone(TEAM_TZ).toJSDate();
  const results = chrono.parse(input, refInTz, { forwardDate: true });
  if (!results.length) return null;
  const parsed = results[0].start;
  if (!parsed) return null;

  // If chrono didn't include a time, default to 9am in the team tz
  const hasTime = parsed.isCertain('hour') || parsed.isCertain('minute');
  let dt = DateTime.fromObject(
    {
      year: parsed.get('year'),
      month: parsed.get('month'),
      day: parsed.get('day'),
      hour: hasTime ? parsed.get('hour') : 9,
      minute: hasTime ? parsed.get('minute') || 0 : 0,
    },
    { zone: TEAM_TZ }
  );
  return dt.toJSDate();
}

export function formatDiscordTime(date, style = 'F') {
  // Discord dynamic timestamps render in each user's local tz
  const epochSec = Math.floor(date.getTime() / 1000);
  return `<t:${epochSec}:${style}>`; // F = full, R = relative, f = short
}

export function formatForTeam(date) {
  return DateTime.fromJSDate(date).setZone(TEAM_TZ).toFormat('ccc, LLL d • h:mm a ZZZZ');
}

// ---------- Events CRUD ----------

export async function createEvent({ guildId, channelId, createdBy, title, description, startsAt, endsAt, voiceAutoJoin, voiceChannelId }) {
  const { data, error } = await getSupabase()
    .from('events')
    .insert({
      guild_id: guildId,
      channel_id: channelId,
      created_by_user_id: createdBy.id,
      created_by_username: createdBy.username,
      title,
      description: description || null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt ? endsAt.toISOString() : null,
      voice_auto_join: !!voiceAutoJoin,
      voice_channel_id: voiceChannelId || null,
    })
    .select()
    .single();
  if (error) throw error;
  log.info(`Event created id=${data.id} "${title}" at ${data.starts_at}`);
  return data;
}

export async function cancelEvent(eventId, userId) {
  const { data: event, error: findErr } = await getSupabase().from('events').select('*').eq('id', eventId).single();
  if (findErr || !event) throw new Error('Event not found');
  // Only creator can cancel (can add admin override later)
  if (event.created_by_user_id !== userId) {
    const err = new Error('Only the event creator can cancel this event.');
    err.forbidden = true;
    throw err;
  }
  const { error } = await getSupabase().from('events').update({ cancelled: true }).eq('id', eventId);
  if (error) throw error;
  return event;
}

export async function listUpcomingEvents(guildId, { limit = 20, fromDate = new Date() } = {}) {
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .eq('guild_id', guildId)
    .eq('cancelled', false)
    .gte('starts_at', fromDate.toISOString())
    .order('starts_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getEvent(eventId) {
  const { data, error } = await getSupabase().from('events').select('*').eq('id', eventId).single();
  if (error) return null;
  return data;
}

// ---------- RSVPs ----------

export async function setRsvp({ eventId, userId, username, status }) {
  const { error } = await getSupabase()
    .from('event_rsvps')
    .upsert({ event_id: eventId, user_id: userId, username, status, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function getRsvps(eventId) {
  const { data, error } = await getSupabase().from('event_rsvps').select('*').eq('event_id', eventId);
  if (error) return [];
  return data || [];
}

// ---------- Reminders ----------

export async function createReminder({ guildId, channelId, user, content, remindAt }) {
  const { data, error } = await getSupabase()
    .from('reminders')
    .insert({
      guild_id: guildId,
      channel_id: channelId,
      user_id: user.id,
      username: user.username,
      content,
      remind_at: remindAt.toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- Scheduler queries ----------

/** Events needing a 15-min reminder right now */
export async function getEventsNeedingReminder() {
  const now = new Date();
  const in20min = new Date(now.getTime() + 20 * 60 * 1000);
  const in10min = new Date(now.getTime() + 10 * 60 * 1000);
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .eq('cancelled', false)
    .eq('reminder_sent_15m', false)
    .gte('starts_at', in10min.toISOString())
    .lte('starts_at', in20min.toISOString());
  if (error) { log.error('getEventsNeedingReminder', error.message); return []; }
  return data || [];
}

export async function markReminderSent(eventId) {
  await getSupabase().from('events').update({ reminder_sent_15m: true }).eq('id', eventId);
}

/** Events whose voice auto-join should fire now */
export async function getEventsNeedingAutoJoin() {
  const now = new Date();
  const in1min = new Date(now.getTime() + 60 * 1000);
  const oneMinAgo = new Date(now.getTime() - 60 * 1000);
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .eq('cancelled', false)
    .eq('voice_auto_join', true)
    .eq('auto_join_fired', false)
    .gte('starts_at', oneMinAgo.toISOString())
    .lte('starts_at', in1min.toISOString());
  if (error) { log.error('getEventsNeedingAutoJoin', error.message); return []; }
  return data || [];
}

export async function markAutoJoinFired(eventId) {
  await getSupabase().from('events').update({ auto_join_fired: true }).eq('id', eventId);
}

/** Personal reminders due now */
export async function getDueReminders() {
  const { data, error } = await getSupabase()
    .from('reminders')
    .select('*')
    .eq('sent', false)
    .lte('remind_at', new Date().toISOString())
    .limit(50);
  if (error) { log.error('getDueReminders', error.message); return []; }
  return data || [];
}

export async function markReminderSentPersonal(id) {
  await getSupabase().from('reminders').update({ sent: true }).eq('id', id);
}

// ---------- Agenda queries ----------

export async function getTodaysEvents(guildId, now = new Date()) {
  const startOfDay = DateTime.fromJSDate(now).setZone(TEAM_TZ).startOf('day').toJSDate();
  const endOfDay = DateTime.fromJSDate(now).setZone(TEAM_TZ).endOf('day').toJSDate();
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .eq('guild_id', guildId)
    .eq('cancelled', false)
    .gte('starts_at', startOfDay.toISOString())
    .lte('starts_at', endOfDay.toISOString())
    .order('starts_at', { ascending: true });
  if (error) { log.error('getTodaysEvents', error.message); return []; }
  return data || [];
}

export async function getThisWeeksEvents(guildId, now = new Date()) {
  const dt = DateTime.fromJSDate(now).setZone(TEAM_TZ);
  const start = dt.startOf('week').toJSDate();
  const end = dt.endOf('week').toJSDate();
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .eq('guild_id', guildId)
    .eq('cancelled', false)
    .gte('starts_at', start.toISOString())
    .lte('starts_at', end.toISOString())
    .order('starts_at', { ascending: true });
  if (error) { log.error('getThisWeeksEvents', error.message); return []; }
  return data || [];
}
