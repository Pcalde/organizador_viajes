-- ═══════════════════════════════════════════════════════════════════════════
--  Cuestionador de viajes · esquema de Supabase (v2 - Generalizado + Debate)
--  Pegar entero en: Supabase → SQL Editor → New query → Run (idempotente)
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ── TABLAS ─────────────────────────────────────────────────────────────────
create table if not exists encuestas (
  eid    text primary key check (eid ~ '^[a-z0-9-]{1,60}$'),
  creada timestamptz not null default now()
);

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
             ('checkbox','voto-ponderado','radio','casas','slider','disponibilidad','textarea')),
  label    text not null check (char_length(label) between 1 and 200),
  opciones jsonb not null default '[]',
  config   jsonb not null default '{}',
  autor    text,
  creada   timestamptz not null default now(),
  primary key (eid, id)
);

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
  a jsonb; q preguntas%rowtype; o jsonb := p_opcion;
begin
  a := _auth(p_eid, p_nombre, p_pin, false);
  if a ? 'error' then return a; end if;

  select * into q from preguntas where eid = p_eid and id = p_qid for update;
  if not found then return jsonb_build_object('error', 'Pregunta no encontrada'); end if;
  if q.tipo not in ('checkbox', 'voto-ponderado', 'radio', 'casas') then
    return jsonb_build_object('error', 'Esta pregunta no admite opciones');
  end if;
  if o is null or pg_column_size(o) > 2000 then return jsonb_build_object('error', 'Opción inválida'); end if;

  if q.tipo = 'casas' then
    if jsonb_typeof(o) <> 'object' or btrim(coalesce(o->>'nombre', '')) = '' then
      return jsonb_build_object('error', 'Opción inválida');
    end if;
    o := jsonb_build_object(
      'nombre', btrim(o->>'nombre'),
      'precio', coalesce(o->>'precio', ''),
      'url',    case when coalesce(o->>'url', '') ~* '^https?://' then o->>'url' else '' end);
  elsif jsonb_typeof(o) <> 'string' or btrim(o #>> '{}') = '' then
    return jsonb_build_object('error', 'Opción inválida');
  end if;

  if exists (select 1 from jsonb_array_elements(q.opciones) e where opt_key(q.tipo, e) = opt_key(q.tipo, o)) then
    return jsonb_build_object('ok', true, 'duplicada', true);
  end if;

  update preguntas set opciones = opciones || jsonb_build_array(o) where eid = p_eid and id = p_qid;
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
     or v_tipo not in ('checkbox','voto-ponderado','radio','casas','slider','disponibilidad','textarea')
     or char_length(v_label) not between 1 and 200
     or jsonb_typeof(v_op) <> 'array' or jsonb_typeof(v_cfg) <> 'object' then
    return jsonb_build_object('error', 'Pregunta inválida');
  end if;

  if v_tipo = 'casas' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'nombre', btrim(e->>'nombre'),
             'precio', coalesce(e->>'precio', ''),
             'url',    case when coalesce(e->>'url', '') ~* '^https?://' then e->>'url' else '' end)), '[]'::jsonb)
      into v_op
      from jsonb_array_elements(v_op) e
     where jsonb_typeof(e) = 'object' and btrim(coalesce(e->>'nombre', '')) <> '';
  else
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_op
      from jsonb_array_elements(v_op) e
     where jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> '';
  end if;

  insert into preguntas (eid, id, tipo, label, opciones, config, autor)
  values (p_eid, v_id, v_tipo, v_label, v_op, v_cfg, a->>'nombre')
  on conflict (eid, id) do nothing;
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

-- ── ADMIN: crear una encuesta (configuración declarativa generalizada) ─────
create or replace function crear_encuesta(p_eid text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_eid is null or p_eid !~ '^[a-z0-9-]{1,60}$' then
    raise exception 'ID inválido: solo a-z, 0-9 y guiones (máx. 60)';
  end if;
  insert into encuestas (eid) values (p_eid);
  insert into preguntas (eid, id, tipo, label, opciones, config) values
    (p_eid, 'opciones-destino', 'checkbox',       '¿Qué plan dirías en realidad?',
       '["Casa rural","Camping / aire libre / hamaqueo","Plan más elaborado","Turisteo","Playa"]', '{}'),
    (p_eid, 'casas',            'casas',          '¿Qué casas en particular te gustan?', '[]', '{}'),
    (p_eid, 'precio',           'slider',         'Precio máximo por persona', '[]',
       '{"min":20,"max":500,"step":20,"default":100,"unit":" €"}'),
    (p_eid, 'transporte',       'radio',          'Transporte',
       '["llevo-coche|Llevo coche","necesito|Necesito que me lleven","propio|Me busco la vida"]',
       '{"conditionalStepper":{"when":"llevo-coche","key":"plazasLibres","label":"Plazas libres en mi coche:","min":1,"max":8,"default":3}}'),
    (p_eid, 'disponibilidad',   'disponibilidad', '¿Cuándo podrías?', '[]', '{}'),
    (p_eid, 'notas',            'textarea',       'Algo más que añadir', '[]',
       '{"placeholder":"Restricciones, alergias, preferencias, lo que sea…"}');
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

grant execute on function
  entrar(text, text, text),
  get_all(text, text, text),
  submit_response(text, text, text, jsonb),
  vote_ausencia(text, text, text, jsonb, int),
  add_opcion(text, text, text, text, jsonb),
  add_proscontra(text, text, text, text, text, text, text),
  add_pregunta(text, text, text, jsonb),
  add_debate(text, text, text, text, text, bigint, text, text),
  vote_debate(text, text, text, bigint),
  resolve_debate(text, text, text, bigint, boolean)
to anon, authenticated;