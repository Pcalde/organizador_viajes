-- ═══════════════════════════════════════════════════════════════════════════
--  Cuestionador de viajes · esquema de Supabase (v2 - Generalizado + Debate)
--  Pegar entero en: Supabase → SQL Editor → New query → Run (idempotente)
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ── TABLAS ─────────────────────────────────────────────────────────────────
create table if not exists encuestas (
  eid    text primary key check (eid ~ '^[a-z0-9-]{1,60}$'),
  titulo text not null default 'Cuestionario de viaje',
  creada timestamptz not null default now()
);
alter table encuestas add column if not exists titulo text not null default 'Cuestionario de viaje';

create table if not exists usuarios (
  eid      text not null references encuestas on delete cascade,
  nombre   text not null check (char_length(nombre) between 1 and 40),
  pin_hash text not null,
  creado   timestamptz not null default now(),
  primary key (eid, nombre)
);
create unique index if not exists usuarios_nombre_lc on usuarios (eid, lower(nombre));

create table if not exists intentos (
  eid       text not null,
  nombre_lc text not null,
  ts        timestamptz not null default now()
);
create index if not exists intentos_idx on intentos (eid, nombre_lc, ts);

create table if not exists preguntas (
  seq      bigint generated always as identity,
  eid      text not null references encuestas on delete cascade,
  id       text not null check (id ~ '^[a-z0-9_-]{1,80}$'),
  tipo     text not null check (tipo in
             ('checkbox','voto-ponderado','radio','casas','slider','disponibilidad','horarios','textarea')),
  label    text not null check (char_length(label) between 1 and 200),
  opciones jsonb not null default '[]',
  config   jsonb not null default '{}',
  autor    text,
  creada   timestamptz not null default now(),
  primary key (eid, id)
);
-- Posición estable por encuesta para conservar el orden elegido en la interfaz.
alter table preguntas add column if not exists pos integer;
with orden_inicial as (
  select eid, id, row_number() over (partition by eid order by seq)::integer as n
  from preguntas where pos is null
)
update preguntas p set pos = o.n from orden_inicial o where p.eid = o.eid and p.id = o.id;

-- El CHECK de la tabla solo se evalúa en INSERT/UPDATE, así que las plantillas
-- nuevas (p.ej. 'horarios') funcionan sin migración tras ejecutar este script.
alter table preguntas drop constraint if exists preguntas_tipo_check;
alter table preguntas add constraint preguntas_tipo_check check (tipo in
  ('checkbox','voto-ponderado','radio','casas','slider','disponibilidad','horarios','textarea'));

create table if not exists respuestas (
  eid     text not null references encuestas on delete cascade,
  nombre  text not null,
  answers jsonb not null,
  ts      timestamptz not null default now(),
  primary key (eid, nombre)
);

create table if not exists proscontras (
  id      bigint generated always as identity primary key,
  eid     text not null references encuestas on delete cascade,
  qid     text not null,
  opt_key text not null,
  tipo    text not null check (tipo in ('pro','contra')),
  texto   text not null check (char_length(texto) between 1 and 500),
  autor   text not null,
  ts      timestamptz not null default now()
);
create index if not exists proscontras_eid on proscontras (eid);

create table if not exists ausencias (
  eid             text not null references encuestas on delete cascade,
  votante         text not null,
  candidatos      jsonb not null default '[]',
  mi_probabilidad int,
  ts              timestamptz not null default now(),
  primary key (eid, votante)
);

-- Nuevo: Espacio de debate (diferido por temas/propuestas y directo)
create table if not exists debate (
  id        bigint generated always as identity primary key,
  eid       text not null references encuestas on delete cascade,
  qid       text,               -- NULL = general, o ID de pregunta
  opt_key   text,               -- NULL = sobre pregunta/general, o clave de opción
  parent_id bigint references debate on delete cascade,
  tipo      text not null check (tipo in ('comentario','propuesta','directo')),
  texto     text not null check (char_length(texto) between 1 and 1000),
  autor     text not null,
  votos_up  jsonb not null default '[]',
  resuelto  boolean not null default false,
  ts        timestamptz not null default now()
);
create index if not exists debate_eid_idx on debate (eid, ts);

-- ── FUNCIONES AUXILIARES (no expuestas) ────────────────────────────────────

create or replace function opt_key(p_tipo text, o jsonb) returns text
language sql immutable as $$
  select case
    when jsonb_typeof(o) = 'object' then o->>'nombre'
    when p_tipo = 'radio'           then split_part(o #>> '{}', '|', 1)
    else o #>> '{}'
  end
$$;

-- Sanitizador único de opciones: preserva foto/geo y valida coordenadas.
-- Las opciones admiten dos formas: string simple u objeto enriquecido
-- {nombre, precio, url, foto, geo:{texto,lat,lng}}. Antes add_opcion y
-- add_pregunta reconstruían el objeto con una lista fija de campos y
-- descartaban `foto` y `geo`, por lo que el punto del mapa se perdía al
-- sondear el servidor. Esta función es la única autoridad sobre qué campos
-- sobreviven al guardar.
create or replace function _san_opcion(p_tipo text, o jsonb) returns jsonb
language plpgsql immutable as $$
declare g jsonb; out jsonb; t text;
begin
  -- Forma string: se conserva tal cual si no está vacía.
  if jsonb_typeof(o) = 'string' then
    return case when btrim(o #>> '{}') <> '' then o else null end;
  end if;
  if jsonb_typeof(o) <> 'object' then return null; end if;
  t := btrim(coalesce(o->>'nombre', ''));
  if t = '' then return null; end if;

  out := jsonb_build_object('nombre', t, 'precio', coalesce(o->>'precio', ''));

  -- URL y FOTO: solo https/http válidas; si no, cadena vacía (el cliente
  -- usa safeUrl igualmente; así no se pierde el campo en el JSON).
  if coalesce(o->>'url', '')  ~* '^https?://' then
    out := jsonb_build_object('nombre', t, 'precio', coalesce(o->>'precio',''),
                              'url',  left(o->>'url', 400));
  end if;
  if coalesce(o->>'foto', '') ~* '^https?://' then
    out := out || jsonb_build_object('foto', left(o->>'foto', 400));
  end if;

  -- GEO: objeto {texto, lat, lng}. Se aceptan coordenadas numéricas válidas
  -- (lat -90..90, lng -180..180) y/o un texto de búsqueda. Si no hay nada
  -- útil, se descarta geo (pero NO se descarta la opción).
  g := o->'geo';
  if jsonb_typeof(g) = 'object' then
    if (g->>'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (g->>'lng') ~ '^-?[0-9]+(\.[0-9]+)?$'
       and abs((g->>'lat')::numeric) <= 90 and abs((g->>'lng')::numeric) <= 180 then
      out := out || jsonb_build_object('geo', jsonb_build_object(
        'texto', left(coalesce(g->>'texto', ''), 200),
        'lat',   round((g->>'lat')::numeric, 6),
        'lng',   round((g->>'lng')::numeric, 6)));
    elsif btrim(coalesce(g->>'texto', '')) <> '' then
      out := out || jsonb_build_object('geo',
        jsonb_build_object('texto', left(btrim(g->>'texto'), 200)));
    end if;
  elsif jsonb_typeof(g) = 'string' and btrim(g #>> '{}') <> '' then
    -- Compatibilidad con geo como string "lat,lng" o dirección de texto.
    out := out || jsonb_build_object('geo',
      jsonb_build_object('texto', left(btrim(g #>> '{}'), 200)));
  end if;

  return out;
end $$;

-- ¿Tiene sentido que las opciones sean objetos para este tipo de pregunta?
create or replace function _tipo_admite_objetos(p_tipo text) returns boolean
language sql immutable as $$
  select p_tipo in ('casas', 'checkbox', 'voto-ponderado', 'radio')
$$;

create or replace function _auth(p_eid text, p_nombre text, p_pin text, p_crear boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  nm text := btrim(coalesce(p_nombre, ''));
  u  usuarios%rowtype;
  n  int;
begin
  if p_eid is null or p_eid !~ '^[a-z0-9-]{1,60}$' then
    return jsonb_build_object('error', 'ID de encuesta inválido');
  end if;
  if char_length(nm) not between 1 and 40 then
    return jsonb_build_object('error', 'Nombre inválido');
  end if;
  if p_pin is null or p_pin !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'PIN inválido');
  end if;
  if not exists (select 1 from encuestas where eid = p_eid) then
    return jsonb_build_object('error', 'Encuesta no encontrada');
  end if;

  select count(*) into n from intentos
   where eid = p_eid and nombre_lc = lower(nm) and ts > now() - interval '15 minutes';
  if n >= 10 then
    return jsonb_build_object('error', 'Demasiados intentos fallidos. Espera unos minutos.');
  end if;

  select * into u from usuarios where eid = p_eid and lower(nombre) = lower(nm);
  if not found then
    if not p_crear then
      return jsonb_build_object('error', 'Usuario no registrado en esta encuesta');
    end if;
    insert into usuarios (eid, nombre, pin_hash) values (p_eid, nm, crypt(p_pin, gen_salt('bf', 8)));
    return jsonb_build_object('nombre', nm);
  end if;

  if u.pin_hash = crypt(p_pin, u.pin_hash) then
    return jsonb_build_object('nombre', u.nombre);
  end if;

  delete from intentos where ts < now() - interval '1 day';
  insert into intentos (eid, nombre_lc) values (p_eid, lower(nm));
  return jsonb_build_object('error', 'PIN incorrecto');
end $$;

-- Foto completa de la encuesta incluyendo respuestas grupales y sala de debate
create or replace function _snapshot(p_eid text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'titulo', coalesce((select titulo from encuestas where eid = p_eid),
                       'Cuestionario de viaje'),
    'schema', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'tipo', p.tipo, 'label', p.label,
                                          'opciones', p.opciones, 'config', p.config) order by coalesce(p.pos, p.seq + 1000000))
        from preguntas p where p.eid = p_eid), '[]'::jsonb),
    'proscontras', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'qid', c.qid, 'optKey', c.opt_key, 'tipo', c.tipo,
                   'texto', c.texto, 'autor', c.autor, 'votos', c.votos, 'ts', c.ts) order by c.id)
        from proscontras c where c.eid = p_eid), '[]'::jsonb),
    'respondentes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'nombre', r.nombre,
               'prob_asistencia', coalesce(a.mi_probabilidad,
                                           nullif(r.answers->>'prob_asistencia_propia', '')::numeric::int,
                                           80)
             ) order by r.ts)
        from respuestas r
        left join ausencias a on a.eid = r.eid and lower(a.votante) = lower(r.nombre)
       where r.eid = p_eid), '[]'::jsonb),
    'respuestas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'nombre', r.nombre,
               'answers', r.answers,
               'ts', r.ts
             ) order by r.ts)
        from respuestas r where r.eid = p_eid), '[]'::jsonb),
    'ausencias', coalesce((
      select jsonb_agg(jsonb_build_object('votante', v.votante, 'candidatos', v.candidatos,
                                          'mi_probabilidad', v.mi_probabilidad) order by v.votante)
        from ausencias v where v.eid = p_eid), '[]'::jsonb),
    'debate', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'qid', d.qid, 'optKey', d.opt_key,
                                          'parentId', d.parent_id, 'tipo', d.tipo, 'texto', d.texto,
                                          'autor', d.autor, 'votosUp', d.votos_up,
                                          'resuelto', d.resuelto, 'ts', d.ts) order by d.id)
        from debate d where d.eid = p_eid), '[]'::jsonb)
  )
$$;

-- ── API PÚBLICA (RPC) ──────────────────────────────────────────────────────

create or replace function entrar(p_eid text, p_nombre text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, true);
  if a ? 'error' then return a; end if;
  return jsonb_build_object('nombre', a->>'nombre', 'datos', _snapshot(p_eid));
end $$;

create or replace function get_all(p_eid text, p_nombre text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  return _snapshot(p_eid);
end $$;

-- Cambiar el propio nombre y/o la contraseña (PIN). Requiere autenticación con
-- el PIN actual; propaga el rename a todas las tablas donde aparece el usuario.
create or replace function update_profile(p_eid text, p_nombre text, p_pin text,
                                          p_nuevo_nombre text default null,
                                          p_nuevo_pin    text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb; nm text; nn text;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  nm := a->>'nombre';

  if p_nuevo_pin is not null and char_length(btrim(p_nuevo_pin)) < 32 then
    return jsonb_build_object('error', 'PIN nuevo inválido');
  end if;

  if p_nuevo_nombre is not null then
    nn := btrim(coalesce(p_nuevo_nombre, ''));
    if char_length(nn) < 1 or char_length(nn) > 40 then
      return jsonb_build_object('error', 'El nombre debe tener entre 1 y 40 caracteres');
    end if;
    if lower(nn) <> lower(nm) and exists (
      select 1 from usuarios where eid = p_eid and lower(nombre) = lower(nn)
    ) then
      return jsonb_build_object('error', 'Ese nombre ya está en uso en el grupo');
    end if;
    if lower(nn) <> lower(nm) then
      update usuarios   set nombre = nn where eid = p_eid and lower(nombre) = lower(nm);
      update respuestas set nombre = nn where eid = p_eid and lower(nombre) = lower(nm);
      update ausencias  set votante = nn where eid = p_eid and lower(votante) = lower(nm);
      update ausencias  set candidatos = (
        select jsonb_agg(case when lower(c #>> '{}') = lower(nm)
                              then to_jsonb(nn) else c end)
        from jsonb_array_elements(ausencias.candidatos) c
      ) where eid = p_eid and jsonb_typeof(candidatos) = 'array'
        and exists (select 1 from jsonb_array_elements(ausencias.candidatos) c
                    where lower(c #>> '{}') = lower(nm));
      update proscontras set autor = nn where eid = p_eid and lower(autor) = lower(nm);
      update debate      set autor = nn where eid = p_eid and lower(autor) = lower(nm);
      nm := nn;
    end if;
  end if;

  if p_nuevo_pin is not null then
    update usuarios set pin_hash = crypt(p_nuevo_pin, gen_salt('bf', 8))
     where eid = p_eid and lower(nombre) = lower(nm);
  end if;

  return jsonb_build_object('ok', true, 'nombre', nm);
end $$;

-- Permite a cada participante borrar su propia cuenta y todos sus datos asociados.
create or replace function delete_participant(p_eid text, p_nombre text, p_pin text, p_participante text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb; nm text;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  nm := a->>'nombre';
  if lower(btrim(coalesce(p_participante, ''))) <> lower(nm) then
    return jsonb_build_object('error', 'Solo puedes eliminar tu propia participación');
  end if;

  delete from respuestas where eid = p_eid and lower(nombre) = lower(nm);
  delete from ausencias where eid = p_eid and lower(votante) = lower(nm);
  delete from proscontras where eid = p_eid and lower(autor) = lower(nm);
  delete from debate where eid = p_eid and lower(autor) = lower(nm);
  delete from usuarios where eid = p_eid and lower(nombre) = lower(nm);
  return jsonb_build_object('ok', true);
end $$;

create or replace function submit_response(p_eid text, p_nombre text, p_pin text, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if jsonb_typeof(p_answers) is distinct from 'object' or pg_column_size(p_answers) > 60000 then
    return jsonb_build_object('error', 'Respuesta inválida');
  end if;
  insert into respuestas (eid, nombre, answers) values (p_eid, a->>'nombre', p_answers)
  on conflict (eid, nombre) do update set answers = excluded.answers, ts = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function vote_ausencia(p_eid text, p_nombre text, p_pin text, p_candidatos jsonb, p_prob int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if jsonb_typeof(p_candidatos) is distinct from 'array' or pg_column_size(p_candidatos) > 10000 then
    return jsonb_build_object('error', 'Votos inválidos');
  end if;
  insert into ausencias (eid, votante, candidatos, mi_probabilidad)
  values (p_eid, a->>'nombre', p_candidatos, least(100, greatest(0, p_prob)))
  on conflict (eid, votante) do update
    set candidatos = excluded.candidatos, mi_probabilidad = excluded.mi_probabilidad, ts = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function add_opcion(p_eid text, p_nombre text, p_pin text, p_qid text, p_opcion jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a jsonb; q preguntas%rowtype; o jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;

  select * into q from preguntas where eid = p_eid and id = p_qid for update;
  if not found then return jsonb_build_object('error', 'Pregunta no encontrada'); end if;
  if q.tipo not in ('checkbox', 'voto-ponderado', 'radio', 'casas') then
    return jsonb_build_object('error', 'Esta pregunta no admite opciones');
  end if;
  if p_opcion is null or pg_column_size(p_opcion) > 2000 then
    return jsonb_build_object('error', 'Opción inválida');
  end if;

  -- Sanitizado único: conserva nombre/precio/url/foto/geo y rechaza lo demás.
  -- (Antes se reconstrucía con lista fija y geo/foto se perdían al sondear.)
  o := _san_opcion(q.tipo, p_opcion);
  if o is null or (q.tipo = 'casas' and jsonb_typeof(o) <> 'object') then
    return jsonb_build_object('error', 'Opción inválida');
  end if;

  if exists (select 1 from jsonb_array_elements(q.opciones) e where opt_key(q.tipo, e) = opt_key(q.tipo, o)) then
    return jsonb_build_object('ok', true, 'duplicada', true);
  end if;

  update preguntas set opciones = opciones || jsonb_build_array(o) where eid = p_eid and id = p_qid;
  return jsonb_build_object('ok', true);
end $$;

-- Editar una opción existente (renombrado incluido). `p_old_optkey` es la clave
-- actual (opt_key de la opción); `p_nueva_opcion` la nueva forma, sanitizada
-- con _san_opcion para que sobrevivan precio/url/foto/geo. Si cambia la clave,
-- se migran también las selecciones ya guardadas en las respuestas del grupo
-- (para que nadie pierda su voto al renombrar una opción).
create or replace function edit_opcion(p_eid text, p_nombre text, p_pin text,
                                       p_qid text, p_old_optkey text, p_nueva_opcion jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a jsonb; q preguntas%rowtype; nueva jsonb; oldk text := btrim(coalesce(p_old_optkey, ''));
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if oldk = '' or length(oldk) > 200 or p_nueva_opcion is null
     or pg_column_size(p_nueva_opcion) > 2000 then
    return jsonb_build_object('error', 'Opción inválida');
  end if;

  select * into q from preguntas where eid = p_eid and id = p_qid for update;
  if not found then return jsonb_build_object('error', 'Pregunta no encontrada'); end if;
  if q.tipo not in ('checkbox', 'voto-ponderado', 'radio', 'casas') then
    return jsonb_build_object('error', 'Esta pregunta no admite opciones');
  end if;

  nueva := _san_opcion(q.tipo, p_nueva_opcion);
  if nueva is null or (q.tipo = 'casas' and jsonb_typeof(nueva) <> 'object') then
    return jsonb_build_object('error', 'Opción inválida');
  end if;
  if not exists (select 1 from jsonb_array_elements(q.opciones) e where opt_key(q.tipo, e) = oldk) then
    return jsonb_build_object('error', 'La opción ya no existe');
  end if;
  if opt_key(q.tipo, nueva) <> oldk and exists (
       select 1 from jsonb_array_elements(q.opciones) e
        where opt_key(q.tipo, e) = opt_key(q.tipo, nueva)) then
    return jsonb_build_object('error', 'Ya existe una opción con ese nombre');
  end if;

  update preguntas
     set opciones = (
       select coalesce(jsonb_agg(case when opt_key(q.tipo, e) = oldk then nueva else e end), '[]'::jsonb)
         from jsonb_array_elements(q.opciones) e)
   where eid = p_eid and id = p_qid;

  -- Migrar selecciones previas si la clave cambió (respuestas enviadas y borradores).
  if opt_key(q.tipo, nueva) <> oldk then
    update respuestas r
       set answers = case
           when q.tipo = 'voto-ponderado' then
             jsonb_set(
               coalesce(r.answers - 'values', '{}'::jsonb) ||
                 jsonb_build_object('values',
                   coalesce(r.answers->'values', '{}'::jsonb)),
               '{values,' || p_qid || '}',
               (select coalesce(jsonb_object_agg(
                          case when k = oldk then opt_key(q.tipo, nueva) else k end, v), '{}'::jsonb)
                  from jsonb_each(coalesce(r.answers #> ('{values,' || p_qid || '}'), '{}'::jsonb)) x(k, v)),
               true)
           else
             jsonb_set(
               coalesce(r.answers - 'values', '{}'::jsonb) ||
                 jsonb_build_object('values',
                   coalesce(r.answers->'values', '{}'::jsonb)),
               '{values,' || p_qid || '}',
               (select coalesce(jsonb_agg(
                          case when x.v #>> '{}' = oldk
                               then (opt_key(q.tipo, nueva))::jsonb else x.v end), '[]'::jsonb)
                  from jsonb_array_elements(
                         coalesce(r.answers #> ('{values,' || p_qid || '}'), '[]'::jsonb)) x(v)),
               true)
         end
     where r.eid = p_eid
       and jsonb_typeof(r.answers #> ('{values,' || p_qid || '}')) is not null;
  end if;

  return jsonb_build_object('ok', true);
end $$;

-- Eliminar una opción del esquema (y de las respuestas guardadas del grupo).
create or replace function delete_opcion(p_eid text, p_nombre text, p_pin text, p_qid text, p_optkey text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a jsonb; q preguntas%rowtype; k text := btrim(coalesce(p_optkey, ''));
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if k = '' or length(k) > 200 then return jsonb_build_object('error', 'Opción inválida'); end if;

  select * into q from preguntas where eid = p_eid and id = p_qid for update;
  if not found then return jsonb_build_object('error', 'Pregunta no encontrada'); end if;
  if q.tipo not in ('checkbox', 'voto-ponderado', 'radio', 'casas') then
    return jsonb_build_object('error', 'Esta pregunta no admite opciones');
  end if;

  update preguntas
     set opciones = (
       select coalesce(jsonb_agg(e), '[]'::jsonb)
         from jsonb_array_elements(q.opciones) e
        where opt_key(q.tipo, e) <> k)
   where eid = p_eid and id = p_qid;

  update respuestas r
     set answers = jsonb_set(
           coalesce(r.answers - 'values', '{}'::jsonb) ||
             jsonb_build_object('values', coalesce(r.answers->'values', '{}'::jsonb)),
           '{values,' || p_qid || '}',
           case
             when q.tipo = 'voto-ponderado' then
               (select coalesce(jsonb_object_agg(x.k, x.v) - k, '{}'::jsonb)
                  from jsonb_each(coalesce(r.answers #> ('{values,' || p_qid || '}'), '{}'::jsonb)) x(k, v))
             else
               (select coalesce(jsonb_agg(x.v), '[]'::jsonb)
                  from jsonb_array_elements(
                         coalesce(r.answers #> ('{values,' || p_qid || '}'), '[]'::jsonb)) x(v)
                 where x.v #>> '{}' <> k)
           end,
           true)
   where r.eid = p_eid
     and jsonb_typeof(r.answers #> ('{values,' || p_qid || '}')) is not null;

  return jsonb_build_object('ok', true);
end $$;

create or replace function add_proscontra(p_eid text, p_nombre text, p_pin text,
                                          p_qid text, p_optkey text, p_tipo text, p_texto text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if p_tipo not in ('pro', 'contra') or char_length(btrim(coalesce(p_texto, ''))) not between 1 and 500
     or coalesce(p_optkey, '') = '' then
    return jsonb_build_object('error', 'Argumento inválido');
  end if;
  if not exists (select 1 from preguntas where eid = p_eid and id = p_qid) then
    return jsonb_build_object('error', 'Pregunta no encontrada');
  end if;
  insert into proscontras (eid, qid, opt_key, tipo, texto, autor)
  values (p_eid, p_qid, p_optkey, p_tipo, btrim(p_texto), a->>'nombre');
  return jsonb_build_object('ok', true);
end $$;

create or replace function add_pregunta(p_eid text, p_nombre text, p_pin text, p_pregunta jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a jsonb; v_id text; v_tipo text; v_label text; v_op jsonb; v_cfg jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if jsonb_typeof(p_pregunta) is distinct from 'object' or pg_column_size(p_pregunta) > 20000 then
    return jsonb_build_object('error', 'Pregunta inválida');
  end if;

  v_id    := p_pregunta->>'id';
  v_tipo  := p_pregunta->>'tipo';
  v_label := btrim(coalesce(p_pregunta->>'label', ''));
  v_op    := coalesce(p_pregunta->'opciones', '[]'::jsonb);
  v_cfg   := coalesce(p_pregunta->'config', '{}'::jsonb);

  if v_id is null or v_id !~ '^[a-z0-9_-]{1,80}$'
     or v_tipo not in ('checkbox','voto-ponderado','radio','casas','slider',
                       'disponibilidad','horarios','textarea')
     or char_length(v_label) not between 1 and 200
     or jsonb_typeof(v_op) <> 'array' or jsonb_typeof(v_cfg) <> 'object' then
    return jsonb_build_object('error', 'Pregunta inválida');
  end if;

  -- Sanitizado de opciones con el mismo criterio que add/edit_opcion: los
  -- objetos conservan nombre/precio/url/foto/geo y las cadenas se validan.
  select coalesce(jsonb_agg(_san_opcion(v_tipo, e)), '[]'::jsonb)
    into v_op
    from jsonb_array_elements(v_op) e
   where _san_opcion(v_tipo, e) is not null;

  insert into preguntas (eid, id, tipo, label, opciones, config, autor, pos)
  values (p_eid, v_id, v_tipo, v_label, v_op, v_cfg, a->>'nombre',
          coalesce((select max(pos) + 1 from preguntas where eid = p_eid), 1))
  on conflict (eid, id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Editar el texto y/o la configuración de una pregunta existente. `p_config`
-- es el objeto completo que reemplaza al anterior (incluye seccion, mostrarSi,
-- franjas, etc.); se limita su tamaño para evitar payloads abusivos.
create or replace function edit_pregunta(p_eid text, p_nombre text, p_pin text,
                                         p_qid text, p_label text default null,
                                         p_config jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb; v_lbl text;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if p_qid is null or p_qid !~ '^[a-z0-9_-]{1,80}$' then
    return jsonb_build_object('error', 'Pregunta no encontrada');
  end if;
  if p_label is null and p_config is null then
    return jsonb_build_object('error', 'Nada que guardar');
  end if;
  if p_config is not null and (jsonb_typeof(p_config) <> 'object'
                               or pg_column_size(p_config) > 20000) then
    return jsonb_build_object('error', 'Configuración inválida');
  end if;

  update preguntas q
     set label  = case when p_label is not null
                       then left(btrim(p_label), 200) else q.label end,
         config = coalesce(p_config, q.config)
   where q.eid = p_eid and q.id = p_qid
     and (p_label is null or length(btrim(p_label)) between 1 and 200);
  if not found then return jsonb_build_object('error', 'Pregunta no encontrada o etiqueta inválida'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Borrado lógico de pregunta: se elimina del esquema y de las respuestas del
-- grupo (los votos/historial asociados a esa pregunta desaparecen también).
create or replace function delete_pregunta(p_eid text, p_nombre text, p_pin text, p_qid text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if p_qid is null or p_qid !~ '^[a-z0-9_-]{1,80}$' then
    return jsonb_build_object('error', 'Pregunta no encontrada');
  end if;

  delete from preguntas where eid = p_eid and id = p_qid;
  if not found then return jsonb_build_object('error', 'Pregunta no encontrada'); end if;
  delete from proscontras where eid = p_eid and qid = p_qid;
  delete from debate      where eid = p_eid and qid = p_qid;
  update respuestas r
     set answers = jsonb_set(
           coalesce(r.answers - 'values', '{}'::jsonb) ||
             jsonb_build_object('values', coalesce(r.answers->'values', '{}'::jsonb)),
           '{values}',
           coalesce(r.answers->'values', '{}'::jsonb) - p_qid,
           true)
   where r.eid = p_eid and jsonb_typeof(r.answers->'values') = 'object';
  return jsonb_build_object('ok', true);
end $$;

create or replace function reordenar_preguntas(p_eid text, p_nombre text, p_pin text, p_ids jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb; total_db integer; total_ids integer;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if jsonb_typeof(p_ids) is distinct from 'array' then
    return jsonb_build_object('error', 'Orden de preguntas inválido');
  end if;
  select count(*) into total_db from preguntas where eid = p_eid;
  select count(distinct value) into total_ids from jsonb_array_elements_text(p_ids);
  if total_ids <> total_db or jsonb_array_length(p_ids) <> total_db
     or exists (select 1 from jsonb_array_elements_text(p_ids) x
                 where not exists (select 1 from preguntas q where q.eid = p_eid and q.id = x.value)) then
    return jsonb_build_object('error', 'La lista de preguntas no coincide con la encuesta');
  end if;
  update preguntas q set pos = x.ord::integer
    from jsonb_array_elements_text(p_ids) with ordinality as x(value, ord)
   where q.eid = p_eid and q.id = x.value;
  return jsonb_build_object('ok', true);
end $$;

-- Nuevas RPCs de Debate (Diferido + Directo + Votación de argumentos)
create or replace function add_debate(
  p_eid text, p_nombre text, p_pin text,
  p_qid text, p_optkey text, p_parent bigint, p_tipo text, p_texto text
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb; new_id bigint;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  if p_tipo not in ('comentario', 'propuesta', 'directo')
     or char_length(btrim(coalesce(p_texto, ''))) not between 1 and 1000 then
    return jsonb_build_object('error', 'Mensaje de debate inválido');
  end if;

  insert into debate (eid, qid, opt_key, parent_id, tipo, texto, autor)
  values (p_eid, nullif(btrim(p_qid), ''), nullif(btrim(p_optkey), ''), p_parent, p_tipo, btrim(p_texto), a->>'nombre')
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
end $$;

create or replace function vote_debate(p_eid text, p_nombre text, p_pin text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a jsonb; nm text; cur jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  nm := a->>'nombre';

  select votos_up into cur from debate where id = p_id and eid = p_eid for update;
  if not found then return jsonb_build_object('error', 'Mensaje no encontrado'); end if;

  if cur @> to_jsonb(nm) then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into cur
      from jsonb_array_elements_text(cur) x where x <> nm;
  else
    cur := cur || to_jsonb(nm);
  end if;

  update debate set votos_up = cur where id = p_id and eid = p_eid;
  return jsonb_build_object('ok', true, 'votosUp', cur);
end $$;

create or replace function resolve_debate(p_eid text, p_nombre text, p_pin text, p_id bigint, p_resuelto boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;
  update debate set resuelto = coalesce(p_resuelto, false) where id = p_id and eid = p_eid;
  return jsonb_build_object('ok', true);
end $$;

-- ── CREAR ENCUESTA (RPC pública, sin preguntas fijas por defecto) ──────────
-- Plantillas disponibles:
--   'vacia'    → encuesta en blanco (el grupo crea secciones y preguntas).
--   'quedada'  → set de ejemplo con secciones legibles (config.seccion);
--                los IDs son generados, no anclados: la app no depende de ellos.
create or replace function crear_encuesta_publica(p_eid text, p_nombre text, p_pin text,
                                                  p_plantilla text default 'vacia',
                                                  p_titulo text default 'Cuestionario de viaje')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare a jsonb; v_tit text; sfx text;
begin
  a := _auth(p_eid, p_nombre, p_pin, true);
  if a ? 'error' then return a; end if;

  v_tit := left(btrim(coalesce(nullif(p_titulo, ''), 'Cuestionario de viaje')), 80);
  insert into encuestas (eid, titulo) values (p_eid, v_tit)
    on conflict (eid) do update set titulo = excluded.titulo;

  if coalesce(p_plantilla, 'vacia') = 'vacia' then
    return jsonb_build_object('ok', true, 'plantilla', 'vacia');
  end if;

  -- Plantilla de ejemplo: cada pregunta lleva config.seccion para que el raíl
  -- las agrupe. Se usan sufijos únicos para permitir varias encuestas.
  sfx := substr(translate(p_eid, '-', '_'), 1, 20);

  insert into preguntas (eid, id, tipo, label, opciones, config, pos) values
    (p_eid, 'plan_' || sfx, 'checkbox', '¿Qué plan dirías en realidad?',
     '["Casa rural","Camping / aire libre / hamaqueo","Plan más elaborado","Turisteo","Playa"]',
     '{"seccion":"Preferencias"}', 1),
    (p_eid, 'aloj_' || sfx, 'casas', '¿Qué alojamientos en particular te gustan?', '[]',
     '{"seccion":"Preferencias"}', 2),
    (p_eid, 'presu_' || sfx, 'slider', 'Presupuesto máximo por persona', '[]',
     '{"min":20,"max":500,"step":20,"default":100,"unit":" €","seccion":"Presupuesto"}', 3),
    (p_eid, 'trans_' || sfx, 'radio', 'Transporte',
     '["llevo-coche|Llevo coche","necesito|Necesito que me lleven","propio|Me busco la vida"]',
     '{"conditionalStepper":{"when":"llevo-coche","key":"plazasLibres","label":"Plazas libres en mi coche:","min":1,"max":8,"default":3},"seccion":"Logística"}', 4),
    (p_eid, 'cuand_' || sfx, 'disponibilidad', '¿Cuándo podrías?', '[]',
     '{"seccion":"Fechas"}', 5),
    (p_eid, 'notas_' || sfx, 'textarea', 'Algo más que añadir', '[]',
     '{"placeholder":"Restricciones, alergias, preferencias, lo que sea…","seccion":"Notas"}', 6)
  on conflict (eid, id) do nothing;

  return jsonb_build_object('ok', true, 'plantilla', p_plantilla);
end $$;

-- (Legacy) crear_encuesta(text): conservada por compatibilidad, pero ya NO
-- inserta preguntas con IDs anclados; equivale a la plantilla vacía.
create or replace function crear_encuesta(p_eid text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_eid is null or p_eid !~ '^[a-z0-9-]{1,60}$' then
    raise exception 'ID inválido: solo a-z, 0-9 y guiones (máx. 60)';
  end if;
  insert into encuestas (eid) values (p_eid) on conflict (eid) do nothing;
  return 'Encuesta creada: ' || p_eid;
end $$;

-- ── VISTA PARA EL CSV (compatible con formato nuevo values.* y legacy) ─────
create or replace view respuestas_planas with (security_invoker = true) as
select
  r.eid,
  r.ts                                                             as "timestamp",
  r.nombre,
  (select string_agg(x, ' | ')
     from jsonb_array_elements_text(coalesce(r.answers#>'{values,opciones-destino}', r.answers->'opciones', '[]'::jsonb)) x) as opciones,
  (select string_agg((c->>'nombre') || coalesce(' (' || nullif(c->>'precio', '') || ')', ''), ' | ')
     from jsonb_array_elements(coalesce(r.answers#>'{values,casas}', r.answers->'casas', '[]'::jsonb)) c)                    as casas,
  coalesce((r.answers#>>'{values,precio}')::numeric, (r.answers->>'precioMaxPP')::numeric)                                   as "precioMaxPP",
  coalesce((r.answers#>>'{values,disponibilidad,diasMax}')::int, (r.answers->>'diasMax')::int)                               as "diasMax",
  coalesce(r.answers#>>'{values,transporte,estado}', r.answers#>>'{transporte,estado}')                                      as transporte,
  coalesce((r.answers#>>'{values,transporte,plazasLibres}')::int, (r.answers#>>'{transporte,plazasLibres}')::int)            as "plazasLibres",
  case when coalesce((r.answers#>>'{values,disponibilidad,soloFinde}')::boolean, (r.answers#>>'{disponibilidad,soloFinde}')::boolean) then 'sí' else 'no' end as "soloFinde",
  case when coalesce((r.answers#>>'{values,disponibilidad,meDaIgual}')::boolean, (r.answers#>>'{disponibilidad,meDaIgual}')::boolean) then 'sí' else 'no' end as "meDaIgual",
  case when coalesce((r.answers#>>'{values,disponibilidad,preferirPuente}')::boolean, (r.answers#>>'{disponibilidad,preferirPuente}')::boolean) then 'sí' else 'no' end as puente,
  coalesce(r.answers#>'{values,disponibilidad,rangos}', r.answers->'rangosFechas', '[]'::jsonb)::text                        as "rangosFechas",
  coalesce(r.answers#>>'{values,notas}', r.answers#>>'{extras,notas}')                                                       as notas,
  coalesce(r.answers->'values', r.answers->'extras')::text                                                                   as extras,
  (select string_agg(x, ' | ')
     from jsonb_array_elements_text(coalesce(r.answers->'ausencias_predichas', '[]'::jsonb)) x)                              as ausencias_predichas,
  (r.answers->>'prob_asistencia_propia')::numeric                                                                            as prob_asistencia_propia
from respuestas r;

-- ── PERMISOS ───────────────────────────────────────────────────────────────
alter table encuestas   enable row level security;
alter table usuarios    enable row level security;
alter table intentos    enable row level security;
alter table preguntas   enable row level security;
alter table respuestas  enable row level security;
alter table proscontras enable row level security;
alter table ausencias   enable row level security;
alter table debate      enable row level security;

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

revoke all on function opt_key(text, jsonb)                   from public, anon, authenticated;
revoke all on function _auth(text, text, text, boolean)       from public, anon, authenticated;
revoke all on function _snapshot(text)                        from public, anon, authenticated;
revoke all on function crear_encuesta(text)                   from public, anon, authenticated;
revoke all on function _san_opcion(text, jsonb)               from public, anon, authenticated;
revoke all on function _tipo_admite_objetos(text)             from public, anon, authenticated;

grant execute on function
  entrar(text, text, text),
  get_all(text, text, text),
  delete_participant(text, text, text, text),
  reordenar_preguntas(text, text, text, jsonb),
  submit_response(text, text, text, jsonb),
  vote_ausencia(text, text, text, jsonb, int),
  add_opcion(text, text, text, text, jsonb),
  edit_opcion(text, text, text, text, text, jsonb),
  delete_opcion(text, text, text, text, text),
  add_proscontra(text, text, text, text, text, text, text),
  add_pregunta(text, text, text, jsonb),
  edit_pregunta(text, text, text, text, text, jsonb),
  delete_pregunta(text, text, text, text),
  add_debate(text, text, text, text, text, bigint, text, text),
  vote_debate(text, text, text, bigint),
  resolve_debate(text, text, text, bigint, boolean),
  update_profile(text, text, text, text, text),
  crear_encuesta_publica(text, text, text, text, text)
to anon, authenticated;

-- Recargar el catálogo de PostgREST para que vea las funciones nuevas.
notify pgrst, 'reload schema';
