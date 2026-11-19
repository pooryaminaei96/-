create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '',
  role text not null default 'student' check (role in ('student', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text not null default '';

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'display_name', ''))
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(nullif(excluded.display_name, ''), profiles.display_name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute procedure public.create_profile_for_new_user();

update public.profiles p
set email = coalesce(u.email, '')
from auth.users u
where p.id = u.id and p.email = '';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

create table if not exists public.learner_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.courses (
  id text primary key,
  title text not null,
  description text not null default '',
  published boolean not null default true,
  enrollment_open boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.courses add column if not exists enrollment_open boolean not null default true;

create table if not exists public.lessons (
  id text primary key,
  course_id text not null references public.courses(id) on delete cascade,
  order_index integer not null default 1 check (order_index > 0),
  title text not null,
  content jsonb not null default '{}'::jsonb,
  audio_url text,
  published boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.certificates (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  recipient_name text not null default '',
  issued_at timestamptz not null default now(),
  unique (user_id, course_id)
);

create table if not exists public.course_enrollments (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null references public.courses(id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

alter table public.profiles enable row level security;
alter table public.learner_state enable row level security;
alter table public.courses enable row level security;
alter table public.lessons enable row level security;
alter table public.certificates enable row level security;
alter table public.course_enrollments enable row level security;

drop policy if exists "profiles_read_own" on public.profiles;
create policy "profiles_read_own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profiles_admin_read" on public.profiles;
create policy "profiles_admin_read" on public.profiles
  for select to authenticated using (public.is_admin());

drop policy if exists "learner_state_own" on public.learner_state;
create policy "learner_state_own" on public.learner_state
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists "learner_state_admin_read" on public.learner_state;
create policy "learner_state_admin_read" on public.learner_state
  for select to authenticated using (public.is_admin());

drop policy if exists "course_enrollments_read_own_or_admin" on public.course_enrollments;
create policy "course_enrollments_read_own_or_admin" on public.course_enrollments
  for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());
drop policy if exists "course_enrollments_insert_open_course" on public.course_enrollments;
create policy "course_enrollments_insert_open_course" on public.course_enrollments
  for insert to authenticated with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.courses c
      where c.id = course_enrollments.course_id and c.published and c.enrollment_open
    )
  );

drop policy if exists "courses_read_published" on public.courses;
create policy "courses_read_published" on public.courses
  for select to anon, authenticated using (published or public.is_admin());
drop policy if exists "courses_admin_insert" on public.courses;
create policy "courses_admin_insert" on public.courses
  for insert to authenticated with check (public.is_admin());
drop policy if exists "courses_admin_update" on public.courses;
create policy "courses_admin_update" on public.courses
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "courses_admin_delete" on public.courses;
create policy "courses_admin_delete" on public.courses
  for delete to authenticated using (public.is_admin());

drop policy if exists "lessons_read_published" on public.lessons;
create policy "lessons_read_published" on public.lessons
  for select to anon, authenticated using (
    published or public.is_admin()
  );
drop policy if exists "lessons_admin_insert" on public.lessons;
create policy "lessons_admin_insert" on public.lessons
  for insert to authenticated with check (public.is_admin());
drop policy if exists "lessons_admin_update" on public.lessons;
create policy "lessons_admin_update" on public.lessons
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "lessons_admin_delete" on public.lessons;
create policy "lessons_admin_delete" on public.lessons
  for delete to authenticated using (public.is_admin());

drop policy if exists "certificates_read_own" on public.certificates;
create policy "certificates_read_own" on public.certificates
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.courses, public.lessons to anon, authenticated;
revoke insert, update, delete on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.learner_state to authenticated;
grant insert, update, delete on public.courses, public.lessons to authenticated;
grant select on public.certificates to authenticated;
grant select, insert on public.course_enrollments to authenticated;

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_display_name text,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  perform pg_advisory_xact_lock(hashtext('admin-role-change'));
  if p_role is null or p_role not in ('student', 'admin') then
    raise exception 'Invalid profile role';
  end if;
  if exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'admin'
  ) and p_role = 'student' and (
    select count(*) from public.profiles where role = 'admin'
  ) <= 1 then
    raise exception 'At least one administrator must remain';
  end if;
  update public.profiles
  set display_name = left(trim(coalesce(p_display_name, '')), 120),
      role = p_role
  where id = p_user_id;
  if not found then
    raise exception 'Profile not found';
  end if;
end;
$$;

revoke all on function public.admin_update_profile(uuid, text, text) from public;
grant execute on function public.admin_update_profile(uuid, text, text) to authenticated;

create or replace function public.verify_certificate(p_code text)
returns table (code text, course_id text, issued_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.code, c.course_id, c.issued_at
  from public.certificates c
  where c.code = upper(trim(p_code))
  limit 1;
$$;

revoke all on function public.verify_certificate(text) from public;
grant execute on function public.verify_certificate(text) to anon, authenticated;

create or replace function public.issue_certificate(p_course_id text, p_recipient_name text)
returns table (code text, course_id text, issued_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  certificate_code text;
begin
  if current_user_id is null then
    raise exception 'Sign in is required';
  end if;
  if p_course_id <> 'sarf-unit-1' then
    raise exception 'This course is not eligible for a certificate';
  end if;
  if not exists (
    select 1 from public.learner_state s
    where s.user_id = current_user_id
      and coalesce((s.state->>'examDone')::boolean, false)
  ) then
    raise exception 'The final exam must be completed first';
  end if;

  insert into public.certificates (code, user_id, course_id, recipient_name)
  values (
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    current_user_id,
    p_course_id,
    left(trim(coalesce(p_recipient_name, '')), 120)
  )
  on conflict (user_id, course_id) do update
    set recipient_name = excluded.recipient_name
  returning certificates.code into certificate_code;

  return query
    select c.code, c.course_id, c.issued_at
    from public.certificates c
    where c.code = certificate_code;
end;
$$;

revoke all on function public.issue_certificate(text, text) from public;
grant execute on function public.issue_certificate(text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lesson-audio', 'lesson-audio', true, 10485760, array['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'])
on conflict (id) do update set public = true, file_size_limit = 10485760;

drop policy if exists "lesson_audio_public_read" on storage.objects;
create policy "lesson_audio_public_read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'lesson-audio');
drop policy if exists "lesson_audio_admin_insert" on storage.objects;
create policy "lesson_audio_admin_insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'lesson-audio' and public.is_admin()
  );
drop policy if exists "lesson_audio_admin_update" on storage.objects;
create policy "lesson_audio_admin_update" on storage.objects
  for update to authenticated using (
    bucket_id = 'lesson-audio' and public.is_admin()
  ) with check (bucket_id = 'lesson-audio' and public.is_admin());
drop policy if exists "lesson_audio_admin_delete" on storage.objects;
create policy "lesson_audio_admin_delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'lesson-audio' and public.is_admin()
  );
