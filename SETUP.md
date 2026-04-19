# Meeting Bot — Setup & Team Invite Guide

End-to-end setup takes about 15 minutes. You'll need:

- A Discord account with **admin rights on your team server**
- An **OpenAI** API key
- A **Supabase** project (the tables are created for you below)
- A **Railway** account (free tier is fine) — or any Node/Docker host

---

## 1 — Create the Discord application (3 min)

1. Go to the Discord Developer Portal: https://discord.com/developers/applications
2. Click **New Application**, name it e.g. `Meeting Bot`.
3. In the left sidebar, open **Bot**.
   - Click **Reset Token** → copy the token. This is your `DISCORD_TOKEN`. Save it somewhere safe.
   - Under **Privileged Gateway Intents**, enable:
     - ✅ **Server Members Intent**
     - ✅ **Message Content Intent** _(optional — not required today, but recommended for future features)_
   - Under **Bot Permissions**, make sure these are ticked (used by the invite link below):
     - View Channels, Send Messages, Embed Links, Attach Files
     - Connect, Speak, Use Voice Activity
4. In the sidebar, open **OAuth2 → General** and copy the **Application ID** → this is your `DISCORD_CLIENT_ID`.

---

## 2 — Generate the invite link for your team server (30 sec)

Replace `YOUR_CLIENT_ID` with your Application ID, then open the link in a browser:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3214336&scope=bot%20applications.commands
```

Permission integer `3214336` = View Channels + Send Messages + Embed Links + Attach Files + Connect + Speak + Use Voice Activity.

Select your team server → **Authorize**. Have any admin do this once.

---

## 3 — Create OpenAI API key (1 min)

1. https://platform.openai.com/api-keys → **Create new secret key**.
2. Copy the `sk-...` value. This is `OPENAI_API_KEY`.
3. Make sure your OpenAI account has billing enabled (Whisper + GPT-4o require paid tier).

Cost estimate: ~$0.36 / hour of meeting audio (Whisper $0.006/min) + ~$0.03 per summary (GPT-4o on a 1-hour transcript).

---

## 4 — Supabase (already done ✅)

I've already created the `meetings` and `segments` tables in your existing Supabase project.

- **SUPABASE_URL** = `https://yglpobqgsjvrthtnnhrn.supabase.co`
- **SUPABASE_SERVICE_ROLE_KEY** → grab from Supabase dashboard → Project Settings → API → `service_role` secret. This is server-side only, never commit it.

_(If you ever need to recreate the tables, the SQL is in `supabase/schema.sql`.)_

---

## 5 — Deploy to Railway (5 min)

1. Push this folder to a new GitHub repo (or zip + drag-drop into Railway).
2. At https://railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects the `Dockerfile`. In **Variables**, paste all values from `.env.example`:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `OPENAI_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_TRANSCRIBE_MODEL=whisper-1`
   - `OPENAI_SUMMARY_MODEL=gpt-4o`
4. Click **Deploy**. Watch logs — you should see `Logged in as Meeting Bot#xxxx`.
5. **Register slash commands** (one-time): in Railway, open the service → **Settings → Deploy** → run a one-off command:
   ```
   node src/register-commands.js
   ```
   Or do it locally: `npm install && npm run register`.

Alternate hosts: any Docker host works (Fly.io, Render, Cloud Run, a VPS). The `Dockerfile` in this repo is all you need.

---

## 6 — Use it in your team server (30 sec)

1. Join any **voice channel** in your Discord server.
2. Type `/join` in any text channel. The bot joins your voice channel and starts transcribing silently.
3. Have your meeting as normal.
4. When done, type `/leave`. The bot will:
   - Post a formatted **summary** with bullet points, **action items** (with owners + due dates), and **decisions**.
   - Upload the **full transcript** as a `.txt` file with timestamps and speaker labels.
   - Archive everything to Supabase for later retrieval.

Other commands: `/summary`, `/transcript`, `/status`.

---

## 7 — Team onboarding message (copy-paste to your #general)

> **📢 Heads up team — we now have a Meeting Bot 🎙️**
>
> Whenever we jump on voice, anyone can type `/join` and the bot will transcribe the meeting and drop a summary + action items in this channel when we're done. Type `/leave` to end. Past meetings: `/summary` or `/transcript`.
>
> Note: audio is transcribed via OpenAI and archived in our Supabase project. Don't use in channels where confidential 3rd-party info is discussed without consent.

---

## Troubleshooting

- **Bot joins but no summary appears** → check logs. 90% of the time it's a missing `OPENAI_API_KEY` or billing issue.
- **Slash commands don't show up** → you didn't run `npm run register`. Global commands also take up to 1 hour to propagate; set `DISCORD_GUILD_ID` in env for instant registration to one server.
- **"Failed to connect to voice channel"** → bot is missing `Connect` + `Speak` permissions on that voice channel. Re-check channel permissions.
- **Empty transcripts** → mic audio is too quiet or being filtered. Raise your input gain; Discord's "Krisp" noise suppression can be too aggressive.
- **Going over OpenAI budget** → switch `OPENAI_TRANSCRIBE_MODEL` to `gpt-4o-mini-transcribe` and `OPENAI_SUMMARY_MODEL` to `gpt-4o-mini`.

## Privacy & consent

Many jurisdictions require all-party consent for recording. Always announce at the start of a meeting that transcription is on. Consider pinning a notice in the voice channel description.
