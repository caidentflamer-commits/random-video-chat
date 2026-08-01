-- Olumie — Phase 1 database schema (Supabase / Postgres)
-- Run this once: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Supabase Auth already provides auth.users; these are the app tables on top.

-- Profiles: one row per user. Holds premium status for Phase 2 subscriptions.
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  is_premium    boolean not null default false,
  premium_until timestamptz
);

-- Bans: durable now (survive restarts/redeploys). Matched on user_id or IP.
create table if not exists public.bans (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  ip          text,
  reason      text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz            -- null = permanent
);
create index if not exists bans_ip_idx   on public.bans (ip);
create index if not exists bans_user_idx on public.bans (user_id);

-- Reports: durable moderation audit trail (replaces the in-memory buffer).
create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  kind        text,          -- user-report | auto-moderation | report-last
  reporter    text,
  reporter_ip text,
  target      text,
  target_ip   text,
  reason      text,
  note        text,
  action      text
);
create index if not exists reports_created_idx on public.reports (created_at desc);

-- Row-level security: lock everything down. The server uses the service_role
-- key (which BYPASSES rls) to read/write freely. Browsers use the anon key and
-- can only read their own profile — never bans or reports.
alter table public.profiles enable row level security;
alter table public.bans     enable row level security;
alter table public.reports  enable row level security;

drop policy if exists "own profile is readable" on public.profiles;
create policy "own profile is readable"
  on public.profiles for select
  using (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
