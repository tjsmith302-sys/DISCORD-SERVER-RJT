import OpenAI from 'openai';
import fs from 'node:fs';
import { log } from './logger.js';

const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o';

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey: key });
  return _client;
}

export async function transcribeFile(filePath) {
  try {
    const resp = await getClient().audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: TRANSCRIBE_MODEL,
      response_format: 'json',
    });
    return (resp.text || '').trim();
  } catch (err) {
    log.error('Whisper transcription failed', err.message);
    return '';
  }
}

export async function summarizeMeeting(transcriptLines) {
  const joined = transcriptLines
    .map(s => `[${s.speaker_name || 'Unknown'}] ${s.text}`)
    .join('\n');

  if (!joined.trim()) {
    return {
      summary: '_No speech was captured during this meeting._',
      discussion_points: [],
      action_items: [],
      decisions: [],
    };
  }

  const system = `You are an expert meeting notes assistant. Given a raw transcript with speaker labels, produce:

1. "headline": a single-sentence TL;DR of the meeting (max 25 words).

2. "discussion_points": an array of 5-12 bullet-point strings describing WHAT WAS ACTUALLY TALKED ABOUT (topics, context, opinions, debates, questions raised). These are NOT action items — they are a faithful recap of the conversation. Each bullet should be a self-contained, plain-English sentence. Group related thoughts together. Include who raised the topic when relevant (e.g. "Alice raised concerns about the deployment timeline"). Do not invent content that was not said.

3. "decisions": an array of short strings — concrete choices the group agreed on during the meeting. Empty array if none were made.

4. "action_items": an array of { owner, task, due } — "owner" is the speaker name if a task was clearly assigned, else "Unassigned"; "due" is a date/phrase if mentioned, else null. Empty array if no tasks were assigned.

Respond ONLY with valid JSON of the shape:
{ "headline": "...", "discussion_points": [...], "decisions": [...], "action_items": [...] }`;

  try {
    const resp = await getClient().chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Transcript:\n\n${joined}` },
      ],
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    const discussion_points = parsed.discussion_points || [];
    // Build combined summary text: headline + discussion bullets (for DB storage + back-compat)
    const headline = parsed.headline || '';
    const summary = [
      headline,
      ...discussion_points.map(p => `• ${p}`),
    ].filter(Boolean).join('\n');
    return {
      summary,
      headline,
      discussion_points,
      action_items: parsed.action_items || [],
      decisions: parsed.decisions || [],
    };
  } catch (err) {
    log.error('Summary generation failed', err.message);
    return {
      summary: '_Summary generation failed._',
      headline: '',
      discussion_points: [],
      action_items: [],
      decisions: [],
    };
  }
}
