import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  generateDependencyReport,
} from '@discordjs/voice';
import prism from 'prism-media';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { log } from './logger.js';
import { transcribeFile } from './openai.js';
import { insertSegment } from './supabase.js';

// Log voice dependencies once at startup so we can spot missing libs in deploy logs
log.info('Voice dependency report:\n' + generateDependencyReport());

const SILENCE_GAP_MS = parseInt(process.env.SILENCE_GAP_MS || '1500', 10);

// Active sessions keyed by guildId
const sessions = new Map();

export function getSession(guildId) {
  return sessions.get(guildId);
}

export async function startRecording({ voiceChannel, meetingId, textChannel }) {
  const guildId = voiceChannel.guild.id;

  if (sessions.has(guildId)) {
    throw new Error('Already recording in this server.');
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  // Robust reconnection handler: on Disconnected, try to resume before giving up.
  // Critical for Railway / hosts where Discord voice UDP is flaky.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      log.info('Voice disconnect was a reconnect attempt — resuming.');
    } catch {
      log.warn('Voice disconnected with no reconnect — destroying.');
      try { connection.destroy(); } catch {}
    }
  });

  // Log every state transition so we can see exactly where it fails
  connection.on('stateChange', (oldState, newState) => {
    log.info(`Voice state: ${oldState.status} -> ${newState.status}`);
  });

  try {
    // 30s timeout (up from 20s) — Railway cold-starts can take longer
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    const finalState = connection.state?.status;
    log.error(`Voice connection never became Ready. state=${finalState} err=${err?.message}`);
    try { connection.destroy(); } catch {}
    const hint = finalState === 'signalling' || finalState === 'connecting'
      ? ' This is usually a hosting-region UDP issue. Try redeploying to us-east1 on Railway, or switch to Fly.io.'
      : ' Check bot permissions on the voice channel.';
    throw new Error(`Failed to connect to voice channel (stuck at: ${finalState}).${hint}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-'));
  const session = {
    guildId,
    meetingId,
    connection,
    voiceChannel,
    textChannel,
    tmpDir,
    activeUsers: new Map(), // userId -> { cleanup }
    startedAt: Date.now(),
  };
  sessions.set(guildId, session);

  const receiver = connection.receiver;

  receiver.speaking.on('start', (userId) => {
    if (session.activeUsers.has(userId)) return;
    captureUtterance(session, userId).catch(err =>
      log.error('captureUtterance error', err)
    );
  });

  log.info(`Recording started in guild=${guildId} channel=${voiceChannel.name}`);
  return session;
}

async function captureUtterance(session, userId) {
  const { connection, tmpDir, meetingId, voiceChannel } = session;
  const receiver = connection.receiver;

  const member = voiceChannel.guild.members.cache.get(userId);
  const speakerName = member?.displayName || member?.user?.username || 'Unknown';

  const startedAt = Date.now();
  const pcmPath = path.join(tmpDir, `${userId}-${startedAt}.pcm`);
  const wavPath = path.join(tmpDir, `${userId}-${startedAt}.wav`);

  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_GAP_MS,
    },
  });

  // Opus -> 48kHz stereo PCM16
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

  const pcmWrite = fs.createWriteStream(pcmPath);
  session.activeUsers.set(userId, { opusStream });

  try {
    await pipeline(opusStream, decoder, pcmWrite);
  } catch (err) {
    log.debug('pipeline ended', err?.message);
  } finally {
    session.activeUsers.delete(userId);
  }

  const durationMs = Date.now() - startedAt;
  // Discard very short blips
  if (durationMs < 600) {
    safeUnlink(pcmPath);
    return;
  }

  // Wrap raw PCM in a WAV header so Whisper accepts it
  try {
    writeWavFromPcm(pcmPath, wavPath, { sampleRate: 48000, channels: 2 });
  } catch (err) {
    log.error('WAV wrap failed', err);
    safeUnlink(pcmPath);
    return;
  }
  safeUnlink(pcmPath);

  const text = await transcribeFile(wavPath);
  safeUnlink(wavPath);

  if (!text || text.length < 2) return;

  log.info(`[${speakerName}] ${text}`);
  await insertSegment({
    meetingId,
    speakerId: userId,
    speakerName,
    durationMs,
    text,
  });
}

export async function stopRecording(guildId) {
  const session = sessions.get(guildId);
  if (!session) return null;

  // End any in-flight streams
  for (const { opusStream } of session.activeUsers.values()) {
    try { opusStream.destroy(); } catch {}
  }
  session.activeUsers.clear();

  try {
    const conn = getVoiceConnection(guildId);
    conn?.destroy();
  } catch (err) {
    log.warn('Error destroying voice connection', err.message);
  }

  // Give pending transcriptions a moment to flush
  await new Promise(r => setTimeout(r, 2500));

  try { fs.rmSync(session.tmpDir, { recursive: true, force: true }); } catch {}
  sessions.delete(guildId);

  return session;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

function writeWavFromPcm(pcmPath, wavPath, { sampleRate, channels }) {
  const pcm = fs.readFileSync(pcmPath);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM chunk size
  header.writeUInt16LE(1, 20);         // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
}
