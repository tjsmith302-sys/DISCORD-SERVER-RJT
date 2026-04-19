-- Meeting Bot schema
-- Run this in Supabase SQL Editor once per project.

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  channel_name text,
  started_by text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'recording', -- recording | ended | failed
  summary text,
  action_items jsonb,
  decisions jsonb
);

create index if not exists meetings_guild_idx on meetings(guild_id, started_at desc);

create table if not exists segments (
  id bigserial primary key,
  meeting_id uuid not null references meetings(id) on delete cascade,
  speaker_id text not null,          -- Discord user id
  speaker_name text,                 -- Discord display name at time of speech
  started_at timestamptz not null default now(),
  duration_ms int,
  text text not null
);

create index if not exists segments_meeting_idx on segments(meeting_id, started_at);

-- Optional: RLS off for service-role inserts (bot uses service role key)
alter table meetings disable row level security;
alter table segments disable row level security;
