-- Aforo — migración inicial: tablas, RLS y funciones de acceso.
-- Aplicar con `supabase db push`, o pegándola en el SQL Editor del proyecto.
--
-- MODELO DE ACCESO
-- La extensión usa únicamente la clave anon / publishable, que es pública por
-- diseño: va dentro de la extensión y cualquiera puede extraerla. La service key
-- no interviene en ningún momento.
--
-- Por eso la clave anon, por sí sola, no sirve para nada:
--   · Las dos tablas tienen RLS activo y SIN políticas, y se les revocan los
--     permisos de anon/authenticated: no se pueden leer ni escribir directamente.
--   · El acceso pasa por funciones SECURITY DEFINER que exigen el código del
--     local. Ese código es el secreto compartido entre los dispositivos de un
--     mismo local: genérese largo y aleatorio y no se publique.
--   · Dar de alta un local NO está al alcance de la API. pc_create_venue queda
--     revocada para anon, así que sólo se ejecuta desde el SQL Editor del
--     proyecto. Sin eso, cualquiera con la clave podría crear locales y llenar
--     la base de datos de filas.
--
-- ALTA DE UN LOCAL (una vez por local, en el SQL Editor, tras esta migración):
--   select public.pc_create_venue('TIENDA-7F3A2B', 'Tienda Centro', 500);

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

-- Da de alta un local. NO se concede a anon: se ejecuta una sola vez desde el
-- SQL Editor del proyecto. Si el código ya existe, sólo actualiza nombre y objetivo.
create or replace function public.pc_create_venue(p_code text, p_name text default null,
                                                  p_capacity int default null)
returns public.pc_venues
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v      public.pc_venues;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := nullif(btrim(p_name), '');
begin
  if length(v_code) < 8 then
    raise exception 'El código del local debe tener al menos 8 caracteres y ser aleatorio: es el secreto que protege el local';
  end if;

  insert into public.pc_venues (code, name, capacity)
  values (v_code, coalesce(v_name, 'Mi local'), p_capacity)
  on conflict (code) do update
    set name     = coalesce(v_name, public.pc_venues.name),
        capacity = coalesce(p_capacity, public.pc_venues.capacity)
  returning * into v;

  return v;
end $$;

-- Busca un local por código. Nunca lo crea.
create or replace function public.pc_venue(p_code text)
returns public.pc_venues
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v      public.pc_venues;
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  select * into v from public.pc_venues where code = v_code;
  if not found then
    raise exception 'No existe ningún local con el código %. Créalo una vez desde el SQL Editor del proyecto: select public.pc_create_venue(''%'', ''Mi local'', null);',
      v_code, v_code;
  end if;
  return v;
end $$;

-- Estado del local desde la última puesta a cero.
create or replace function public.pc_state(p_code text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.pc_venues; result jsonb;
begin
  v := public.pc_venue(p_code);

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
  v_name  text := nullif(btrim(p_name), '');
  v_since timestamptz;
begin
  if jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 1000 then
    raise exception 'Demasiados registros en un solo envío (máximo 1000)';
  end if;

  v := public.pc_venue(p_code);   -- exige que el local ya exista

  -- El nombre y el objetivo sí se pueden ajustar desde la extensión: quien llega
  -- hasta aquí ya conoce el código del local.
  if v_name is not null or p_capacity is not null then
    update public.pc_venues
       set name = coalesce(v_name, name), capacity = coalesce(p_capacity, capacity)
     where id = v.id
    returning * into v;
  end if;

  insert into public.pc_events (venue_id, device_id, client_id, occurred_at)
  select v.id,
         coalesce(nullif(p_device, ''), 'desconocido'),
         (e ->> 'id')::uuid,
         to_timestamp((e ->> 'ts')::bigint / 1000.0)
  from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e
  -- Se descarta lo absurdo: nada del futuro ni de hace meses.
  where to_timestamp((e ->> 'ts')::bigint / 1000.0)
        between now() - interval '90 days' and now() + interval '1 day'
  on conflict (client_id) do nothing;

  -- Primer envío al local: la jornada arranca en el registro más antiguo de la
  -- cola y no en el momento del alta, para no descartar lo contado sin conexión.
  select min(occurred_at) into v_since from public.pc_events where venue_id = v.id;
  if v_since is not null and v_since < v.reset_at
     and not exists (select 1 from public.pc_events
                     where venue_id = v.id and occurred_at >= v.reset_at) then
    update public.pc_venues set reset_at = v_since where id = v.id returning * into v;
  end if;

  return public.pc_state(v.code);
end $$;

-- Borra el último registro de la jornada (deshacer).
create or replace function public.pc_undo(p_code text, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.pc_venues;
begin
  v := public.pc_venue(p_code);

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
  v := public.pc_venue(p_code);
  update public.pc_venues set reset_at = now() where id = v.id returning * into v;

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

-- Ayudantes internos, fuera del alcance de la API. pc_create_venue es la pieza
-- clave: sin ella, la clave anon permitiría crear locales y llenar la base de datos.
revoke all on function public.pc_venue(text)                    from public, anon, authenticated;
revoke all on function public.pc_create_venue(text, text, int)  from public, anon, authenticated;

grant execute on function public.pc_state(text)                        to anon, authenticated;
grant execute on function public.pc_push(text, text, jsonb, text, int) to anon, authenticated;
grant execute on function public.pc_undo(text, text)                   to anon, authenticated;
grant execute on function public.pc_reset(text, text)                  to anon, authenticated;
grant execute on function public.pc_history(text, int)                 to anon, authenticated;
