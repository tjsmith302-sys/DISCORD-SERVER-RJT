import OpenAI from 'openai';
import fs from 'node:fs';
import { log } from './logger.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o';

export async function transcribeFile(filePath) {
  try {
    const resp = await client.audio.transcriptions.create({
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
      action_items: [],
      decisions: [],
    };
  }

  const system = `You are an expert meeting notes assistant. Given a raw transcript with speaker labels, produce:
1. A concise executive summary (4-8 bullet points, plain English).
2. Action items as an array of { owner, task, due } — "owner" is the speaker name if clearly assigned, else "Unassigned"; "due" is a date/phrase if mentioned, else null.
3. Key decisions made during the meeting as an array of short strings.

Respond ONLY with valid JSON of the shape:
{ "summary": "...", "action_items": [...], "decisions": [...] }`;

  try {
    const resp = await client.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Transcript:\n\n${joined}` },
      ],
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    return {
      summary: parsed.summary || '',
      action_items: parsed.action_items || [],
      decisions: parsed.decisions || [],
    };
  } catch (err) {
    log.error('Summary generation failed', err.message);
    return { summary: '_Summary generation failed._', action_items: [], decisions: [] };
  }
}
