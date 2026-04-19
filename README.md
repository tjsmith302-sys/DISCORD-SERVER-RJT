# Meeting Bot — Discord Live Transcription & AI Summaries

A Discord bot that joins voice channels, transcribes every speaker live with **OpenAI Whisper**, then posts a **GPT-4o**-generated summary with action items and decisions to the channel when the meeting ends. Full transcripts are archived to **Supabase**. NotesBot / Memolin style.

## Slash commands

| Command | What it does |
|---|---|
| `/join` | Joins the voice channel you're in and starts live transcription |
| `/leave` | Stops transcription, posts a summary + action items, uploads full transcript |
| `/summary` | Re-posts the summary of the most recent meeting in this channel |
| `/transcript` | Uploads the full transcript of the most recent meeting |
| `/status` | Shows whether the bot is currently recording |

## Local run

```bash
npm install
cp .env.example .env    # fill in keys
npm run register         # registers slash commands
npm start
```

See `SETUP.md` for the full setup and team-invite guide.
