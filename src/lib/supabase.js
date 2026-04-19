import { createClient } from '@supabase/supabase-js';
import { log } from './logger.js';

const url = process.env.SUPABASE_URL;
const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Strip whitespace, quotes, and trailing newlines that Railway / copy-paste often add
const key = rawKey?.trim().replace(/^["']|["']$/g, '');

if (!url || !key) {
  log.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — persistence disabled');
} else {
  const keyType = key.startsWith('sb_secret_') ? 'new-format secret'
    : key.startsWith('sb_publishable_') ? 'new-format publishable'
    : key.startsWith('eyJ') ? 'legacy JWT'
    : 'unknown';
  log.info(`Supabase key type: ${keyType} (length ${key.length})`);
}

export const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    // Ensure headers are clean strings — new sb_secret_ keys fail if any
    // whitespace/control chars sneak in from env var
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  },
}) : null;

export async function createMeeting({ guildId, channelId, channelName, startedBy }) {
  if (!supabase) return { id: `local-${Date.now()}` };
  const { data, error } = await supabase
    .from('meetings')
    .insert({
      guild_id: guildId,
      channel_id: channelId,
      channel_name: channelName,
      started_by: startedBy,
      status: 'recording',
    })
    .select()
    .single();
  if (error) { log.error('createMeeting failed', error); throw error; }
  return data;
}

export async function insertSegment({ meetingId, speakerId, speakerName, durationMs, text }) {
  if (!supabase) return;
  const { error } = await supabase.from('segments').insert({
    meeting_id: meetingId,
    speaker_id: speakerId,
    speaker_name: speakerName,
    duration_ms: durationMs,
    text,
  });
  if (error) log.error('insertSegment failed', error);
}

export async function finalizeMeeting({ meetingId, summary, actionItems, decisions }) {
  if (!supabase) return;
  const { error } = await supabase
    .from('meetings')
    .update({
      ended_at: new Date().toISOString(),
      status: 'ended',
      summary,
      action_items: actionItems,
      decisions,
    })
    .eq('id', meetingId);
  if (error) log.error('finalizeMeeting failed', error);
}

export async function getTranscript(meetingId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('segments')
    .select('speaker_name, started_at, text')
    .eq('meeting_id', meetingId)
    .order('started_at', { ascending: true });
  if (error) { log.error('getTranscript failed', error); return []; }
  return data || [];
}

export async function getLatestMeeting(guildId, channelId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('meetings')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { log.error('getLatestMeeting failed', error); return null; }
  return data;
}
