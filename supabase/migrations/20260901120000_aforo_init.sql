-- Aforo — migración inicial: tablas, RLS y funciones de acceso.
-- Aplicar con `supabase db push`, o pegándola en el SQL Editor del proyecto.
--
-- MODELO DE ACCESO
-- Las dos tablas quedan con RLS activo y SIN políticas, y sin permisos para los
-- roles anon/authenticated: la clave publishable no puede leer ni escribir nada
-- directamente. Todo el acceso pasa por las funciones SECURITY DEFINER del final,
-- que exigen el código del local. Ese código es el secreto compartido entre los
-- dispositivos de un mismo local: genérese largo y aleatorio y no se publique.

-- ---------------------------------------------------------------------- tablas

create table if not exists public.pc_venues (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null default 'Mi local',
  -- Objetivo o límite de personas del día. NULL = sin objetivo.
  capacity   int,
  -- Inicio de la jornada en curso: sólo cuentan los registros posteriores.
  reset_at   timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.pc_events (
  id          bigint generated always as identity primary key,
  venue_id    uuid not null references public.pc_venues(id) on delete cascade,
  device_id   text not null default 'desconocido',
  -- Idempotencia: el dispositivo genera el id, así reenviar su cola no duplica.
  client_id   uuid not null unique,
  occurred_at timestamptz not null default now()
);

create index if not exists pc_events_venue_time_idx
  on public.pc_events (venue_id, occurred_at desc, id desc);

-- ------------------------------------------------------------------------- RLS

alter table public.pc_venues enable row level security;
alter table public.pc_events enable row level security;

-- Sin políticas a propósito: nadie llega a las filas salvo el propietario de las
-- funciones SECURITY DEFINER, que las evita. Se revocan además los permisos que
-- Supabase concede por defecto a los roles de la API.
revoke all on public.pc_venues from anon, authenticated;
revoke all on public.pc_events from anon, authenticated;

-- -------------------------------------------------------------------- funciones

-- Localiza el local por código y lo da de alta la primera vez.
-- p_since: registro más antiguo del mismo envío. Al crear el local la jornada
-- arranca ahí y no en now(), para no descartar una cola acumulada sin conexión.
-- Si el local ya existe, reset_at no se toca.
create or replace function public.pc_venue(p_code text, p_name text default null,
                                           p_capacity int default null,
                                           p_since timestamptz default null)
returns public.pc_venues
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v      public.pc_venues;
  v_name text := nullif(btrim(p_name), '');
begin
  if coalesce(btrim(p_code), '') = '' then
    raise exception 'Falta el código del local';
  end if;

  insert into public.pc_venues (code, name, capacity, reset_at)
  values (upper(btrim(p_code)), coalesce(v_name, 'Mi local'), p_capacity,
          least(now(), coalesce(p_since, now())))
  on conflict (code) do update
    set name     = coalesce(v_name, public.pc_venues.name),
        capacity = coalesce(p_capacity, public.pc_venues.capacity)
  returning * into v;

  return v;
end $$;

-- Estado del local desde la última puesta a cero.
create or replace function public.pc_state(p_code text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.pc_venues; result jsonb;
begin
  select * into v from public.pc_venues where code = upper(btrim(p_code));
  if not found then
    raise exception 'No existe ningún local con el código %', upper(btrim(p_code));
  end if;

  select jsonb_build_object(
    'venue_id',    v.id,
    'code',        v.code,
    'name',        v.name,
    'capacity',    v.capacity,
    'since',       v.reset_at,
    'count',       (select count(*) from public.pc_events
                     where venue_id = v.id and occurred_at >= v.reset_at),
    'server_time', now()
  ) into result;

  return result;
end $$;

-- Recibe la cola de registros del dispositivo y devuelve el estado actualizado.
-- p_events: [{"id": uuid, "ts": epoch_ms}, …]
create or replace function public.pc_push(p_code text, p_device text,
                                          p_events jsonb default '[]'::jsonb,
                                          p_name text default null,
                                          p_capacity int default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v       public.pc_venues;
  v_since timestamptz;
begin
  select min(to_timestamp((e ->> 'ts')::bigint / 1000.0))
    into v_since
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e;

  v := public.pc_venue(p_code, p_name, p_capacity, v_since);

  insert into public.pc_events (venue_id, device_id, client_id, occurred_at)
  select v.id,
         coalesce(nullif(p_device, ''), 'desconocido'),
         (e ->> 'id')::uuid,
         to_timestamp((e ->> 'ts')::bigint / 1000.0)
  from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e
  on conflict (client_id) do nothing;

  return public.pc_state(v.code);
end $$;

-- Borra el último registro de la jornada (deshacer).
create or replace function public.pc_undo(p_code text, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.pc_venues;
begin
  select * into v from public.pc_venues where code = upper(btrim(p_code));
  if not found then
    raise exception 'No existe ningún local con el código %', upper(btrim(p_code));
  end if;

  delete from public.pc_events
  where id = (
    select id from public.pc_events
    where venue_id = v.id and occurred_at >= v.reset_at
    order by occurred_at desc, id desc
    limit 1
  );

  return public.pc_state(v.code);
end $$;

-- Empieza una jornada nueva: el histórico se conserva, el contador vuelve a cero.
create or replace function public.pc_reset(p_code text, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.pc_venues;
begin
  update public.pc_venues set reset_at = now()
  where code = upper(btrim(p_code))
  returning * into v;

  if not found then
    raise exception 'No existe ningún local con el código %', upper(btrim(p_code));
  end if;

  return public.pc_state(v.code);
end $$;

-- Personas por hora en los últimos p_days días, para el CSV.
create or replace function public.pc_history(p_code text, p_days int default 7)
returns table (hour timestamptz, people bigint)
language sql security definer set search_path = public, pg_temp as $$
  select date_trunc('hour', occurred_at) as hour, count(*)::bigint as people
  from public.pc_events
  where venue_id = (select id from public.pc_venues where code = upper(btrim(p_code)))
    and occurred_at >= now() - make_interval(days => greatest(1, coalesce(p_days, 7)))
  group by 1
  order by 1;
$$;

-- ---------------------------------------------------------------------- permisos

-- pc_venue es un ayudante interno: sólo lo invocan las funciones de arriba.
revoke all on function public.pc_venue(text, text, int, timestamptz) from public, anon, authenticated;

grant execute on function public.pc_state(text)                        to anon, authenticated;
grant execute on function public.pc_push(text, text, jsonb, text, int) to anon, authenticated;
grant execute on function public.pc_undo(text, text)                   to anon, authenticated;
grant execute on function public.pc_reset(text, text)                  to anon, authenticated;
grant execute on function public.pc_history(text, int)                 to anon, authenticated;
