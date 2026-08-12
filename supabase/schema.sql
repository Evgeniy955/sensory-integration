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

drop policy if exists "Super admins can update any profile" on public.profiles;
create policy "Super admins can update any profile"
  on public.profiles for update
  using (public.current_user_role() = 'super_admin');

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

-- 6. Bootstrap: make yourself super_admin -------------------------------
-- 1) Sign up once through admin/login.html (use "Forgot password" style
--    flow isn't needed — just create your own account via Supabase Auth
--    dashboard: Authentication → Users → Add user, or sign up on the page).
-- 2) Then run this, replacing the email:
--
--   update public.profiles set role = 'super_admin' where email = 'you@example.com';
