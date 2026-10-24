-- History of events the reports need that aren't play sessions:
-- waitlist tickets (added / their turn / removed) and manual light switches.
-- No customer names are stored here.
create table if not exists public.bolos_history (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  kind text not null,          -- TICKET_ADD, TICKET_TURN, TICKET_REMOVE, LIGHT_ON, LIGHT_OFF
  game text,
  number int,
  data jsonb not null default '{}'::jsonb
);
create index if not exists bolos_history_ts_idx on public.bolos_history (ts);

-- Server-only access, same as the other bolos tables.
alter table public.bolos_history enable row level security;
revoke all on public.bolos_history from anon, authenticated;

-- Minutes added with "extend", so reports can tell the initial booking from extensions.
alter table public.bolos_sessions add column if not exists extended_minutes int not null default 0;
