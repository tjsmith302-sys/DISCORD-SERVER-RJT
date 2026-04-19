-- Calendar feature tables. Run this in Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text,                         -- channel where event was created (for context)
  created_by_user_id text not null,        -- Discord user id who made the event
  created_by_username text,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,                     -- optional
  voice_auto_join boolean default false,   -- if true, bot joins voice at event time
  voice_channel_id text,                   -- specific voice channel to join (optional)
  reminder_sent_15m boolean default false, -- track reminder state
  auto_join_fired boolean default false,   -- prevent double-join
  cancelled boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_events_guild_starts on events(guild_id, starts_at);
create index if not exists idx_events_active on events(guild_id, cancelled, starts_at);

create table if not exists event_rsvps (
  event_id uuid references events(id) on delete cascade,
  user_id text not null,
  username text,
  status text not null check (status in ('going', 'maybe', 'not_going')),
  updated_at timestamptz default now(),
  primary key (event_id, user_id)
);

create index if not exists idx_rsvps_event on event_rsvps(event_id);

-- Simple reminders (personal, no RSVP, no voice)
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  user_id text not null,
  username text,
  content text not null,
  remind_at timestamptz not null,
  sent boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_reminders_due on reminders(sent, remind_at);
