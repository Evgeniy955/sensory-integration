-- =========================================================
-- Roles & admin users schema for Центр сенсорної інтеграції
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.
-- =========================================================

-- 1. Role enum -------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('super_admin', 'admin', 'instructor');
  end if;
end $$;

-- 2. Profiles table ---------------------------------------------
-- One row per auth user, mirrors auth.users(id) and carries the role.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role public.app_role not null default 'instructor',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 3. Helper function to read the caller's role without recursive RLS ----
-- security definer runs as the function owner (bypasses RLS), which is
-- the standard Supabase pattern to avoid "infinite recursion" errors
-- when a policy needs to look at the same table it protects.
create or replace function public.current_user_role()
returns public.app_role
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- 4. RLS policies -------------------------------------------------
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Super admins can insert profiles" on public.profiles;
create policy "Super admins can insert profiles"
  on public.profiles for insert
  with check (public.current_user_role() = 'super_admin');

-- Admins can update instructor/admin profiles; only a super_admin may
-- touch a row that currently is (USING, checked against the old row) or
-- would become (WITH CHECK, checked against the new row) super_admin.
-- That is what stops a plain admin from promoting someone to super_admin
-- or editing/demoting an existing super_admin.
drop policy if exists "Super admins can update any profile" on public.profiles;
drop policy if exists "Admins can update profiles" on public.profiles;
create policy "Admins can update profiles"
  on public.profiles for update
  using (
    public.current_user_role() = 'super_admin'
    or (public.current_user_role() = 'admin' and role <> 'super_admin')
  )
  with check (
    public.current_user_role() = 'super_admin'
    or (public.current_user_role() = 'admin' and role <> 'super_admin')
  );

drop policy if exists "Super admins can delete profiles" on public.profiles;
create policy "Super admins can delete profiles"
  on public.profiles for delete
  using (public.current_user_role() = 'super_admin');

-- 5. New sign-ins no longer get an automatic profile ---------------------
-- Previously, any new auth user (e.g. anyone who completed the "Увійти
-- через Google" flow on login.html) got an automatic profiles row
-- defaulting to 'instructor' — which accidentally granted admin-panel
-- access to whoever showed up, and cluttered "Керування користувачами"
-- with self-added accounts nobody invited. Dropped that trigger: now the
-- only way a profiles row gets created is a super_admin explicitly adding
-- someone from "Керування користувачами" (the admin-create-user Edge
-- Function, which writes the row itself with the chosen role). Anyone who
-- authenticates without a matching profiles row is signed back out by
-- getCurrentProfile() (assets/js/admin-auth.js) the moment any admin page
-- checks — they never reach one.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- 6. Anketas (parent questionnaires) ------------------------------------
-- Each submission is stored as one row: the two fields we need to search
-- and sort the list by (child_full_name, parent_name) get their own
-- columns so they're indexable, and every answer — including those two —
-- also lives in `data` so the "view anketa" screen and any future field
-- additions don't need a schema migration.
create table if not exists public.anketas (
  id uuid primary key default gen_random_uuid(),
  child_full_name text not null,
  parent_name text,
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.anketas enable row level security;

create index if not exists anketas_child_full_name_idx on public.anketas (child_full_name);
create index if not exists anketas_parent_name_idx on public.anketas (parent_name);
create index if not exists anketas_created_at_idx on public.anketas (created_at desc);

-- A child can legitimately have more than one anketa over time (they
-- leave, come back months later, something changed — that history is
-- useful, not a mistake). What we actually want to block is re-creating
-- the exact same submission: same child *and* the same submitted_at
-- timestamp (for CSV imports that's the real Google Forms timestamp down
-- to the second; for the manual "Додати анкету" page it's the save
-- moment, which two genuinely different submissions will essentially
-- never collide on). Two rows only look like a duplicate under this
-- index if they're actually the same event.
--
-- If this errors with "could not create unique index ... is duplicated",
-- you already have two rows for the same child with the *same* recorded
-- timestamp (e.g. from importing the same CSV twice before this
-- constraint existed). Find them:
--   select lower(trim(child_full_name)), created_at, count(*) from public.anketas
--   group by 1, 2 having count(*) > 1;
-- Review, then optionally keep only one row per exact duplicate:
--   delete from public.anketas a using (
--     select id, row_number() over (
--       partition by lower(trim(child_full_name)), created_at order by id
--     ) as rn
--     from public.anketas
--   ) dup
--   where a.id = dup.id and dup.rn > 1;
-- ...then re-run this file.
drop index if exists public.anketas_child_full_name_unique_idx;
create unique index if not exists anketas_child_submission_unique_idx
  on public.anketas (lower(trim(child_full_name)), created_at);

-- Instructors get read-only access (the "Анкети" tab shows for them too,
-- but with no add/import/edit/delete controls at the page level — this
-- policy is what backs that up server-side, since the UI gate alone
-- wouldn't stop a direct API call).
drop policy if exists "Admins can view anketas" on public.anketas;
create policy "Admins can view anketas"
  on public.anketas for select
  using (public.current_user_role() in ('admin', 'super_admin', 'instructor'));

drop policy if exists "Admins can insert anketas" on public.anketas;
create policy "Admins can insert anketas"
  on public.anketas for insert
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- Any admin/super_admin may edit any anketa (not just the one they
-- created) — same shared-ownership model already used for the anketas
-- select/insert policies above and for editing user profiles.
drop policy if exists "Admins can update anketas" on public.anketas;
create policy "Admins can update anketas"
  on public.anketas for update
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- Same admin/super_admin gate as edit — deleting an anketa is only
-- offered from the edit screen, which is already restricted to those
-- two roles at the page level.
drop policy if exists "Admins can delete anketas" on public.anketas;
create policy "Admins can delete anketas"
  on public.anketas for delete
  using (public.current_user_role() in ('admin', 'super_admin'));

-- 7. Schedule board (room/specialist timetable) -------------------------
-- The whole board (list of specialists, list of rooms, and the grid of
-- cell contents) is stored as one JSONB blob in a single row, same
-- flexible-schema idea as anketas.data — specialists and rooms are added
-- or removed freely from the admin UI without ever needing a migration.
-- `id` is a fixed text key ('main') instead of a generated uuid because
-- there is currently only ever one board; upsert-by-id from the client
-- is what keeps "load or create if missing" a single round trip.
create table if not exists public.schedule_boards (
  id text primary key default 'main',
  data jsonb not null default '{"rooms": [], "specialists": [], "cells": {}}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.schedule_boards enable row level security;

-- Same admin/super_admin shared-ownership model as anketas: any admin can
-- read and edit the board, not just whoever last saved it. Instructors
-- get the same read-only carve-out as anketas above — they can see the
-- schedule but never write to it.
drop policy if exists "Admins can view schedule" on public.schedule_boards;
create policy "Admins can view schedule"
  on public.schedule_boards for select
  using (public.current_user_role() in ('admin', 'super_admin', 'instructor'));

drop policy if exists "Admins can insert schedule" on public.schedule_boards;
create policy "Admins can insert schedule"
  on public.schedule_boards for insert
  with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can update schedule" on public.schedule_boards;
create policy "Admins can update schedule"
  on public.schedule_boards for update
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- 8. AI assistant saved chats --------------------------------------------
-- Each specialist's AI помічник conversations (admin/anketa.html), so they
-- persist across devices/browsers instead of living only in one tab. This
-- is personal working history, not shared team data like anketas/schedule
-- above — RLS below scopes every row to its own owner via auth.uid(), the
-- same "select own row" shape as the profiles policy in section 4.
-- owner_email is denormalized (kept alongside owner_id) purely so a saved
-- chat's owner is visible without a join; auth.uid() = owner_id is what
-- actually enforces access, not the email column.
create table if not exists public.ai_chats (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_email text not null,
  mode text not null default 'anketas' check (mode in ('anketas', 'general')),
  title text not null default '',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_chats enable row level security;

create index if not exists ai_chats_owner_id_updated_at_idx
  on public.ai_chats (owner_id, updated_at desc);

drop policy if exists "Users can view own ai chats" on public.ai_chats;
create policy "Users can view own ai chats"
  on public.ai_chats for select
  using (auth.uid() = owner_id);

drop policy if exists "Users can insert own ai chats" on public.ai_chats;
create policy "Users can insert own ai chats"
  on public.ai_chats for insert
  with check (
    auth.uid() = owner_id
    and public.current_user_role() in ('admin', 'super_admin', 'instructor')
  );

drop policy if exists "Users can update own ai chats" on public.ai_chats;
create policy "Users can update own ai chats"
  on public.ai_chats for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Users can delete own ai chats" on public.ai_chats;
create policy "Users can delete own ai chats"
  on public.ai_chats for delete
  using (auth.uid() = owner_id);

-- 9. Anketa version activation -------------------------------------------
-- Editing an anketa (admin/anketa-form.html) always inserts a new version
-- rather than overwriting the one being edited (see "Історія" in
-- admin/anketa.html) — is_active marks which version of a child's anketa
-- is the one shown by default in the main list and picked up by
-- "Редагувати" from there. Defaults to true so a fresh insert (a new
-- version, or a brand new child) is active immediately; the app flips the
-- previous active version to false in the same action (see
-- admin/anketa.html and admin/anketa-form.html) — deliberately not a hard
-- DB constraint, consistent with the fuzzy name-based grouping already
-- used for history/duplicate-detection elsewhere in this file.
alter table public.anketas add column if not exists is_active boolean not null default true;

-- One-time backfill for rows that existed before this column: only the
-- most recently created version per child (grouped the same fuzzy way the
-- admin UI does) stays active. Safe to re-run — always converges to the
-- same result, so it's harmless once every row already reflects it.
with ranked as (
  select id, row_number() over (
    partition by lower(trim(child_full_name)) order by created_at desc, id
  ) as rn
  from public.anketas
)
update public.anketas a
set is_active = (ranked.rn = 1)
from ranked
where a.id = ranked.id and a.is_active <> (ranked.rn = 1);

-- 10. Bootstrap: make yourself super_admin -------------------------------
-- 1) Sign up once through admin/login.html (use "Forgot password" style
--    flow isn't needed — just create your own account via Supabase Auth
--    dashboard: Authentication → Users → Add user, or sign up on the page).
-- 2) Then run this, replacing the email:
--
--   update public.profiles set role = 'super_admin' where email = 'you@example.com';
