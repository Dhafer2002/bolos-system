-- Live state of all tables, frozen balances and activity, as one JSON document.
-- "version" gives optimistic locking so two screens can't overwrite each other.
create table public.bolos_state (
    id         int primary key,
    data       jsonb not null default '{}'::jsonb,
    version    bigint not null default 0,
    updated_at timestamptz not null default now()
);
insert into public.bolos_state (id) values (1);

-- One row per finished play session (used for reports).
create table public.bolos_sessions (
    id             bigint generated always as identity primary key,
    type           text not null,
    number         int not null,
    mode           text,
    source         text,
    booked_minutes int,
    start_at       timestamptz not null,
    end_at         timestamptz not null,
    played_seconds int not null,
    paused_seconds int not null,
    end_reason     text not null,
    archived_at    timestamptz,
    created_at     timestamptz not null default now()
);
create index bolos_sessions_active_idx on public.bolos_sessions (end_at) where archived_at is null;

-- Wrong-PIN counter per IP (brute-force protection).
create table public.bolos_login_failures (
    ip       text primary key,
    count    int not null default 0,
    until_ms bigint not null default 0
);

-- Server-only access: RLS on with no policies, and no grants for public roles.
alter table public.bolos_state enable row level security;
alter table public.bolos_sessions enable row level security;
alter table public.bolos_login_failures enable row level security;
revoke all on public.bolos_state, public.bolos_sessions, public.bolos_login_failures from anon, authenticated;
