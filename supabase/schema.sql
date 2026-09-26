-- Meal Planner: family sharing on Supabase.
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again (it replaces the functions and keeps your data).
--
-- How it works
--   * Each family has one planner document (week, favorites, shopping list, settings) in family_data.
--     The apps merge edits item by item on the device, then save with a version check so two phones
--     saving at the same moment can't overwrite each other.
--   * People join a family with an invite code. Nobody can read or change a family they aren't in:
--     row level security blocks direct access, and every change goes through the functions below,
--     which check membership first.

-- ------------------------------------------------------------------ tables

create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  created_by  uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id     uuid not null references public.families (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 40),
  role          text not null default 'member' check (role in ('owner', 'member')),
  joined_at     timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index if not exists family_members_user on public.family_members (user_id);

create table if not exists public.family_invites (
  code        text primary key,
  family_id   uuid not null references public.families (id) on delete cascade,
  created_by  uuid not null references auth.users (id) on delete cascade,
  expires_at  timestamptz not null default now() + interval '7 days'
);

create table if not exists public.family_data (
  family_id   uuid primary key references public.families (id) on delete cascade,
  doc         jsonb not null default '{}'::jsonb,
  version     bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

alter table public.families       enable row level security;
alter table public.family_members enable row level security;
alter table public.family_invites enable row level security;
alter table public.family_data    enable row level security;

-- ------------------------------------------------------------------ read access (members only)

create or replace function public.is_family_member(p_family uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from family_members where family_id = p_family and user_id = auth.uid());
$$;

drop policy if exists "members read family" on public.families;
create policy "members read family" on public.families
  for select to authenticated using (public.is_family_member(id));

drop policy if exists "members read members" on public.family_members;
create policy "members read members" on public.family_members
  for select to authenticated using (public.is_family_member(family_id));

drop policy if exists "members read data" on public.family_data;
create policy "members read data" on public.family_data
  for select to authenticated using (public.is_family_member(family_id));
-- family_invites has no policies: codes are only created and redeemed through the functions below.
-- There are no insert/update/delete policies anywhere: all changes go through the functions below.

-- ------------------------------------------------------------------ functions the apps call

create or replace function public.require_member(p_family uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;
  if not public.is_family_member(p_family) then
    raise exception 'You are not in this family.' using errcode = '42501';
  end if;
end $$;

create or replace function public.family_summary(p_family uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'family_id', f.id,
    'name', f.name,
    'role', (select role from family_members where family_id = f.id and user_id = auth.uid()),
    'members', coalesce((
      select json_agg(json_build_object('user_id', m.user_id, 'display_name', m.display_name,
                                        'role', m.role, 'me', m.user_id = auth.uid())
                      order by m.joined_at)
      from family_members m where m.family_id = f.id), '[]'::json))
  from families f where f.id = p_family;
$$;

-- Start a new family; you become its owner.
create or replace function public.create_family(p_name text, p_display_name text default '')
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;
  insert into families (name, created_by) values (left(coalesce(nullif(trim(p_name), ''), 'Our family'), 60), auth.uid())
    returning id into v_id;
  insert into family_members (family_id, user_id, display_name, role)
    values (v_id, auth.uid(), left(coalesce(trim(p_display_name), ''), 40), 'owner');
  insert into family_data (family_id, updated_by) values (v_id, auth.uid());
  return public.family_summary(v_id);
end $$;

-- Make an invite code (8 letters/digits, valid 7 days, can be used by several people).
create or replace function public.create_invite(p_family uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O or 1/I, easy to read aloud
  v_code text;
  v_bytes bytea;
  v_expires timestamptz;
begin
  perform public.require_member(p_family);
  delete from family_invites where expires_at < now();
  loop
    v_bytes := uuid_send(gen_random_uuid());  -- strong random bytes
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, 1 + (get_byte(v_bytes, i) % 32), 1);
    end loop;
    begin
      insert into family_invites (code, family_id, created_by) values (v_code, p_family, auth.uid())
        returning expires_at into v_expires;
      exit;
    exception when unique_violation then
      -- astronomically unlikely; try another code
    end;
  end loop;
  return json_build_object('code', v_code, 'expires_at', v_expires);
end $$;

-- Join a family with an invite code.
create or replace function public.join_family(p_code text, p_display_name text default '')
returns json language plpgsql security definer set search_path = public as $$
declare v_family uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;
  select family_id into v_family from family_invites
    where code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) and expires_at > now();
  if v_family is null then
    raise exception 'That invite code isn''t valid or has expired. Ask for a new one.' using errcode = 'P0002';
  end if;
  insert into family_members (family_id, user_id, display_name, role)
    values (v_family, auth.uid(), left(coalesce(trim(p_display_name), ''), 40), 'member')
    on conflict (family_id, user_id) do nothing;
  return public.family_summary(v_family);
end $$;

-- The families you belong to, with their members.
create or replace function public.my_families()
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(public.family_summary(m.family_id) order by m.joined_at), '[]'::json)
  from family_members m where m.user_id = auth.uid();
$$;

create or replace function public.get_family_data(p_family uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare r family_data;
begin
  perform public.require_member(p_family);
  select * into r from family_data where family_id = p_family;
  return json_build_object('doc', r.doc, 'version', r.version, 'updated_at', r.updated_at);
end $$;

-- Save the planner, but only if nobody else saved since you last read it (version check).
-- Returns {ok: true, version} or {ok: false, version} - on false, read again, merge, and retry.
create or replace function public.put_family_data(p_family uuid, p_doc jsonb, p_expected_version bigint)
returns json language plpgsql security definer set search_path = public as $$
declare v_version bigint;
begin
  perform public.require_member(p_family);
  if pg_column_size(p_doc) > 2000000 then
    raise exception 'The planner is too large to save.' using errcode = '54000';
  end if;
  update family_data set doc = p_doc, version = version + 1, updated_at = now(), updated_by = auth.uid()
    where family_id = p_family and version = p_expected_version
    returning version into v_version;
  if v_version is null then
    select version into v_version from family_data where family_id = p_family;
    return json_build_object('ok', false, 'version', v_version);
  end if;
  return json_build_object('ok', true, 'version', v_version);
end $$;

create or replace function public.set_display_name(p_family uuid, p_display_name text)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.require_member(p_family);
  update family_members set display_name = left(coalesce(trim(p_display_name), ''), 40)
    where family_id = p_family and user_id = auth.uid();
  return public.family_summary(p_family);
end $$;

-- Leave a family. If the owner leaves, the longest-standing member becomes owner;
-- if nobody is left, the family and its data are deleted.
create or replace function public.leave_family(p_family uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_was_owner boolean;
begin
  perform public.require_member(p_family);
  delete from family_members where family_id = p_family and user_id = auth.uid()
    returning role = 'owner' into v_was_owner;
  if not exists (select 1 from family_members where family_id = p_family) then
    delete from families where id = p_family;
  elsif v_was_owner then
    update family_members set role = 'owner'
      where family_id = p_family
        and user_id = (select user_id from family_members where family_id = p_family order by joined_at limit 1);
  end if;
end $$;

-- The owner can remove someone from the family.
create or replace function public.remove_member(p_family uuid, p_user uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.require_member(p_family);
  if not exists (select 1 from family_members where family_id = p_family and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the family owner can remove people.' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Use Leave family to remove yourself.' using errcode = '22023';
  end if;
  delete from family_members where family_id = p_family and user_id = p_user;
  return public.family_summary(p_family);
end $$;

-- Only signed-in users may call the app functions.
revoke all on function public.is_family_member(uuid), public.require_member(uuid), public.family_summary(uuid),
  public.create_family(text, text), public.create_invite(uuid), public.join_family(text, text),
  public.my_families(), public.get_family_data(uuid), public.put_family_data(uuid, jsonb, bigint),
  public.set_display_name(uuid, text), public.leave_family(uuid), public.remove_member(uuid, uuid)
  from public, anon;
grant execute on function public.create_family(text, text), public.create_invite(uuid), public.join_family(text, text),
  public.my_families(), public.get_family_data(uuid), public.put_family_data(uuid, jsonb, bigint),
  public.set_display_name(uuid, text), public.leave_family(uuid), public.remove_member(uuid, uuid),
  public.is_family_member(uuid)
  to authenticated;

-- ------------------------------------------------------------------ live updates

-- Let the phone app hear when someone in the family saves (Supabase Realtime).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'family_data') then
    alter publication supabase_realtime add table public.family_data;
  end if;
end $$;
