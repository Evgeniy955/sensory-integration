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

-- 5. Auto-create a profile row whenever a new auth user signs up --------
-- New users default to 'instructor'; a super_admin can change the role
-- afterwards (or the admin-create-user Edge Function sets it directly).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'instructor')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

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

-- One anketa per child: case-insensitive, ignores leading/trailing spaces
-- (so "Іваненко Олег" and " іваненко олег " collide). This is what makes
-- duplicate submissions and repeat CSV imports actually fail in the
-- database, not just get skipped by the client that happens to check first.
--
-- If this errors with "could not create unique index ... is duplicated",
-- you already have duplicate anketas for the same child (e.g. from
-- testing the CSV import twice before this constraint existed). Find them:
--   select lower(trim(child_full_name)), count(*) from public.anketas
--   group by 1 having count(*) > 1;
-- Review, then optionally keep only the oldest row per child:
--   delete from public.anketas a using (
--     select id, row_number() over (
--       partition by lower(trim(child_full_name)) order by created_at asc
--     ) as rn
--     from public.anketas
--   ) dup
--   where a.id = dup.id and dup.rn > 1;
-- ...then re-run this file.
create unique index if not exists anketas_child_full_name_unique_idx
  on public.anketas (lower(trim(child_full_name)));

drop policy if exists "Admins can view anketas" on public.anketas;
create policy "Admins can view anketas"
  on public.anketas for select
  using (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can insert anketas" on public.anketas;
create policy "Admins can insert anketas"
  on public.anketas for insert
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- 7. Bootstrap: make yourself super_admin -------------------------------
-- 1) Sign up once through admin/login.html (use "Forgot password" style
--    flow isn't needed — just create your own account via Supabase Auth
--    dashboard: Authentication → Users → Add user, or sign up on the page).
-- 2) Then run this, replacing the email:
--
--   update public.profiles set role = 'super_admin' where email = 'you@example.com';
