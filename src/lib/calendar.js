// Calendar module — talks to rjtcal's Postgres database.
// Schema is defined by Prisma in the rjtcal web app. We add three things
// nondestructively: voice_auto_join + voice_channel_id + channel_id columns on
// Event, a separate EventRsvp table (rjtcal uses EventAssignee for ownership),
// and a Reminder table for personal /remind reminders.

import pg from 'pg';
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { createId } from '@paralleldrive/cuid2';

const TEAM_TZ = process.env.TEAM_TIMEZONE || 'America/New_York';
const DEFAULT_TIER_NAME = process.env.DEFAULT_TIER_NAME || 'Normal';

const pool = new pg.Pool({
  connectionString: process.env.RJTCAL_DATABASE_URL,
  ssl: process.env.RJTCAL_DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

pool.on('error', (err) => {
  console.error('[calendar/pg pool error]', err.message);
});

// ---------- Natural date parsing ----------

export function parseNaturalDate(input, refDate = new Date()) {
  if (!input) return null;
  const teamNow = DateTime.fromJSDate(refDate).setZone(TEAM_TZ);
  const results = chrono.parse(input, teamNow.toJSDate(), { forwardDate: true });
  if (!results?.length) return null;
  const r = results[0];
  const comp = r.start;

  // Detect explicit relative inputs ("in 20 minutes", "in 2 hours", etc).
  // For these, chrono produces an absolute instant we should trust directly.
  if (/^\s*in\s+\d/i.test(input) || /^\s*\d+\s*(min|minute|hour|hr|sec|day|week|month)/i.test(input)) {
    return r.start.date();
  }

  // Otherwise re-anchor in team TZ so "3pm" means 3pm ET, not 3pm UTC.
  const year  = comp.get('year')  ?? teamNow.year;
  const month = comp.get('month') ?? teamNow.month;
  const day   = comp.get('day')   ?? teamNow.day;
  const hour   = comp.isCertain('hour')   ? comp.get('hour')   : 9;
  const minute = comp.isCertain('minute') ? comp.get('minute') : 0;

  const teamLocal = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0 },
    { zone: TEAM_TZ },
  );
  return teamLocal.toUTC().toJSDate();
}

export function formatDiscordTime(date, style = 'F') {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

export function formatForTeam(date, fmt = 'ccc, LLL d · h:mm a ZZZZ') {
  return DateTime.fromJSDate(new Date(date)).setZone(TEAM_TZ).toFormat(fmt);
}

// ---------- User bootstrap (creates rjtcal User row if needed) ----------

/**
 * rjtcal.User has a NOT NULL discordId + username. We auto-create a row the
 * first time a Discord user interacts so Event.createdById FK is satisfied.
 */
export async function ensureUser({ discordId, username, avatarUrl = null }) {
  const existing = await pool.query(
    'SELECT id FROM "User" WHERE "discordId" = $1',
    [discordId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = createId();
  await pool.query(
    `INSERT INTO "User" (id, "discordId", username, "avatarUrl", "createdAt")
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("discordId") DO NOTHING`,
    [id, discordId, username, avatarUrl],
  );
  // Re-fetch in case of race
  const after = await pool.query(
    'SELECT id FROM "User" WHERE "discordId" = $1',
    [discordId],
  );
  return after.rows[0].id;
}

// ---------- Tier + Category helpers ----------

export async function getTier(nameOrId) {
  const r = await pool.query(
    `SELECT id, name, "offsetsMinutes", "sortOrder" FROM "ReminderTier"
     WHERE id = $1 OR name ILIKE $1 LIMIT 1`,
    [nameOrId],
  );
  return r.rows[0] || null;
}

export async function getDefaultTier() {
  const r = await pool.query(
    `SELECT id, name, "offsetsMinutes", "sortOrder" FROM "ReminderTier"
     WHERE name ILIKE $1 LIMIT 1`,
    [DEFAULT_TIER_NAME],
  );
  if (r.rows[0]) return r.rows[0];
  // Fallback: lowest sortOrder
  const any = await pool.query(
    `SELECT id, name, "offsetsMinutes" FROM "ReminderTier" ORDER BY "sortOrder" ASC LIMIT 1`,
  );
  return any.rows[0] || null;
}

export async function listTiers() {
  const r = await pool.query(
    `SELECT id, name, "offsetsMinutes" FROM "ReminderTier" ORDER BY "sortOrder" ASC`,
  );
  return r.rows;
}

export async function listCategories() {
  const r = await pool.query(
    `SELECT id, name, icon, "colorKey" FROM "Category" ORDER BY "sortOrder" ASC`,
  );
  return r.rows;
}

// ---------- Event CRUD ----------

export async function createEvent({
  guildId,
  channelId,
  createdBy, // { id: discordId, username }
  title,
  description,
  startsAt,
  endsAt = null,
  tierId = null,
  categoryId = null,
  voiceAutoJoin = false,
  voiceChannelId = null,
}) {
  const userRowId = await ensureUser({ discordId: createdBy.id, username: createdBy.username });
  let resolvedTierId = tierId;
  if (!resolvedTierId) {
    const t = await getDefaultTier();
    resolvedTierId = t?.id;
    if (!resolvedTierId) throw new Error('No ReminderTier rows exist in rjtcal DB — run its seed script.');
  }
  const id = createId();
  const r = await pool.query(
    `INSERT INTO "Event"
       (id, title, description, "startTime", "endTime", "tierId", "categoryId",
        "createdById", "createdAt", "updatedAt",
        "voiceAutoJoin", "voiceChannelId", "channelId")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),$9,$10,$11)
     RETURNING *`,
    [id, title, description, startsAt, endsAt, resolvedTierId, categoryId,
     userRowId, voiceAutoJoin, voiceChannelId, channelId],
  );
  return enrichEvent(r.rows[0], { guildId });
}

export async function getEvent(eventId) {
  const r = await pool.query(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c."colorKey" AS category_color,
            t.name AS tier_name, t."offsetsMinutes" AS tier_offsets,
            u."discordId" AS creator_discord_id, u.username AS creator_username
     FROM "Event" e
     LEFT JOIN "Category" c ON c.id = e."categoryId"
     LEFT JOIN "ReminderTier" t ON t.id = e."tierId"
     LEFT JOIN "User" u ON u.id = e."createdById"
     WHERE e.id = $1`,
    [eventId],
  );
  return r.rows[0] ? enrichEvent(r.rows[0]) : null;
}

export async function cancelEvent(eventId, discordUserId) {
  // rjtcal has no "cancelled" column — we hard-delete. Check ownership first.
  const r = await pool.query(
    `SELECT e.id, e.title, u."discordId"
     FROM "Event" e JOIN "User" u ON u.id = e."createdById"
     WHERE e.id = $1`,
    [eventId],
  );
  if (!r.rows[0]) throw new Error('Event not found');
  if (r.rows[0].discordId !== discordUserId) {
    const err = new Error('Forbidden');
    err.forbidden = true;
    throw err;
  }
  const title = r.rows[0].title;
  await pool.query(`DELETE FROM "Event" WHERE id = $1`, [eventId]);
  return { id: eventId, title };
}

export async function listUpcomingEvents(_guildId, { limit = 10 } = {}) {
  const r = await pool.query(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c."colorKey" AS category_color,
            t.name AS tier_name
     FROM "Event" e
     LEFT JOIN "Category" c ON c.id = e."categoryId"
     LEFT JOIN "ReminderTier" t ON t.id = e."tierId"
     WHERE e."startTime" >= now()
     ORDER BY e."startTime" ASC
     LIMIT $1`,
    [limit],
  );
  return r.rows.map(enrichEvent);
}

export async function getTodaysEvents(_guildId) {
  const now = DateTime.now().setZone(TEAM_TZ);
  const start = now.startOf('day').toUTC().toJSDate();
  const end   = now.endOf('day').toUTC().toJSDate();
  const r = await pool.query(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c."colorKey" AS category_color,
            t.name AS tier_name
     FROM "Event" e
     LEFT JOIN "Category" c ON c.id = e."categoryId"
     LEFT JOIN "ReminderTier" t ON t.id = e."tierId"
     WHERE e."startTime" >= $1 AND e."startTime" <= $2
     ORDER BY e."startTime" ASC`,
    [start, end],
  );
  return r.rows.map(enrichEvent);
}

export async function getThisWeeksEvents(_guildId) {
  const now = DateTime.now().setZone(TEAM_TZ);
  const start = now.startOf('week').toUTC().toJSDate();
  const end   = now.endOf('week').toUTC().toJSDate();
  const r = await pool.query(
    `SELECT e.*, c.name AS category_name, c.icon AS category_icon, c."colorKey" AS category_color,
            t.name AS tier_name
     FROM "Event" e
     LEFT JOIN "Category" c ON c.id = e."categoryId"
     LEFT JOIN "ReminderTier" t ON t.id = e."tierId"
     WHERE e."startTime" >= $1 AND e."startTime" <= $2
     ORDER BY e."startTime" ASC`,
    [start, end],
  );
  return r.rows.map(enrichEvent);
}

// Normalizes snake/camel columns into a uniform shape our Discord code expects.
function enrichEvent(row, extras = {}) {
  if (!row) return row;
  return {
    ...row,
    id: row.id,
    title: row.title,
    description: row.description,
    starts_at: row.startTime || row.starts_at,
    ends_at: row.endTime || row.ends_at,
    guild_id: extras.guildId || process.env.DISCORD_GUILD_ID,
    channel_id: row.channelId || row.channel_id,
    created_by_user_id: row.creator_discord_id || row.createdById,
    created_by_username: row.creator_username,
    voice_auto_join: row.voiceAutoJoin ?? row.voice_auto_join ?? false,
    voice_channel_id: row.voiceChannelId || row.voice_channel_id,
    cancelled: false, // rjtcal has no cancelled flag (deletes), always false
    tier_id: row.tierId,
    tier_name: row.tier_name,
    tier_offsets: row.tier_offsets,
    category_id: row.categoryId,
    category_name: row.category_name,
    category_icon: row.category_icon,
    category_color: row.category_color,
  };
}

// ---------- Reminder firing (tier-based) ----------

/**
 * Returns events that need a reminder for SOME offset in their tier's offsetsMinutes,
 * where that specific offset hasn't been logged in ReminderLog yet.
 * Window: events starting between (now + offset - 1min) and (now + offset + 2min).
 */
export async function getEventsNeedingReminder() {
  const r = await pool.query(
    `SELECT e.id AS event_id, e.title, e.description, e."startTime",
            e."voiceAutoJoin", e."voiceChannelId", e."channelId",
            t.id AS tier_id, t.name AS tier_name, t."offsetsMinutes",
            c.name AS category_name, c.icon AS category_icon, c."colorKey" AS category_color,
            u."discordId" AS creator_discord_id
     FROM "Event" e
     JOIN "ReminderTier" t ON t.id = e."tierId"
     LEFT JOIN "Category" c ON c.id = e."categoryId"
     LEFT JOIN "User" u ON u.id = e."createdById"
     WHERE e."startTime" > now()`
  );
  const due = [];
  const nowMs = Date.now();
  for (const row of r.rows) {
    const startMs = new Date(row.startTime).getTime();
    const minsUntil = Math.round((startMs - nowMs) / 60000);
    for (const offset of (row.offsetsMinutes || [])) {
      // Fire when we're within +/- a tight window of the offset
      if (minsUntil <= offset && minsUntil > offset - 2) {
        // Check ReminderLog for idempotency
        const { rows: existing } = await pool.query(
          `SELECT 1 FROM "ReminderLog" WHERE "eventId" = $1 AND "offsetMinutes" = $2`,
          [row.event_id, offset],
        );
        if (!existing.length) {
          due.push({ ...row, offset_minutes: offset });
        }
      }
    }
  }
  return due;
}

export async function markReminderSent(eventId, offsetMinutes) {
  await pool.query(
    `INSERT INTO "ReminderLog" (id, "eventId", "offsetMinutes", "sentAt")
     VALUES ($1, $2, $3, now())
     ON CONFLICT ("eventId", "offsetMinutes") DO NOTHING`,
    [createId(), eventId, offsetMinutes],
  );
}

// ---------- Voice auto-join ----------

export async function getEventsNeedingAutoJoin() {
  // Events with voiceAutoJoin=true starting in 0..2 min that haven't fired
  // We piggyback on ReminderLog with offsetMinutes=-1 as a sentinel for "auto-join fired"
  const r = await pool.query(
    `SELECT e.id AS event_id, e.title, e."startTime",
            e."voiceChannelId", e."voiceAutoJoin", e."channelId",
            u."discordId" AS creator_discord_id
     FROM "Event" e
     LEFT JOIN "User" u ON u.id = e."createdById"
     WHERE e."voiceAutoJoin" = true
       AND e."startTime" >= now() - interval '1 minute'
       AND e."startTime" <= now() + interval '2 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM "ReminderLog" rl
         WHERE rl."eventId" = e.id AND rl."offsetMinutes" = -1
       )`
  );
  return r.rows.map(row => ({
    ...row,
    id: row.event_id,
    guild_id: process.env.DISCORD_GUILD_ID,
    voice_channel_id: row.voiceChannelId,
    channel_id: row.channelId,
    created_by_user_id: row.creator_discord_id,
  }));
}

export async function markAutoJoinFired(eventId) {
  await pool.query(
    `INSERT INTO "ReminderLog" (id, "eventId", "offsetMinutes", "sentAt")
     VALUES ($1, $2, -1, now())
     ON CONFLICT ("eventId", "offsetMinutes") DO NOTHING`,
    [createId(), eventId],
  );
}

// ---------- RSVPs ----------

export async function setRsvp({ eventId, userId, username, status }) {
  await pool.query(
    `INSERT INTO "EventRsvp" ("eventId", "userId", username, status, "updatedAt")
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT ("eventId","userId") DO UPDATE
       SET status = $4, username = $3, "updatedAt" = now()`,
    [eventId, userId, username, status],
  );
}

export async function getRsvps(eventId) {
  const r = await pool.query(
    `SELECT "eventId" as event_id, "userId" as user_id, username, status, "updatedAt"
     FROM "EventRsvp" WHERE "eventId" = $1`,
    [eventId],
  );
  return r.rows;
}

// ---------- Personal reminders ----------

export async function createReminder({ guildId, channelId, user, content, remindAt }) {
  const id = createId();
  const r = await pool.query(
    `INSERT INTO "Reminder" (id, "guildId", "channelId", "userId", username, content, "remindAt", sent, "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,now())
     RETURNING *`,
    [id, guildId, channelId, user.id, user.username, content, remindAt],
  );
  return r.rows[0];
}

export async function getDueReminders() {
  const r = await pool.query(
    `SELECT id, "guildId" as guild_id, "channelId" as channel_id,
            "userId" as user_id, username, content, "remindAt" as remind_at
     FROM "Reminder"
     WHERE sent = false AND "remindAt" <= now()
     ORDER BY "remindAt" ASC
     LIMIT 25`,
  );
  return r.rows;
}

export async function markReminderSentPersonal(id) {
  await pool.query(`UPDATE "Reminder" SET sent = true WHERE id = $1`, [id]);
}

// ---------- Health check ----------

export async function pingDb() {
  const r = await pool.query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}
