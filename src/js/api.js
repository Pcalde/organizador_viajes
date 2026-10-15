// ── API (Supabase RPC) ──────────────────────────────────────────────────────

const ident = b => ({ p_eid: b.eid, p_nombre: b.nombre, p_pin: b.pinHash });

const RPC = {
  crear_encuesta:  { fn: 'crear_encuesta_publica', args: b => ({ ...ident(b), p_plantilla: b.plantilla || 'vacia', p_titulo: b.titulo || 'Cuestionario de viaje' }) },
  entrar:          { fn: 'entrar',          args: b => ident(b) },
  all:             { fn: 'get_all',         args: b => ident(b) },
  delete_participant: { fn: 'delete_participant', args: b => ({ ...ident(b), p_participante: b.participant }) },
  submit_response: { fn: 'submit_response', args: b => ({ ...ident(b), p_answers: b.answers }) },
  vote_ausencia:   { fn: 'vote_ausencia',   args: b => ({ ...ident(b), p_candidatos: b.candidatos, p_prob: b.prob_propia }) },
  add_pregunta:    { fn: 'add_pregunta',    args: b => ({ ...ident(b), p_pregunta: b.pregunta }) },
  edit_pregunta:   { fn: 'edit_pregunta',   args: b => ({ ...ident(b), p_qid: b.questionId, p_label: b.label, p_config: b.config || null }) },
  delete_pregunta: { fn: 'delete_pregunta', args: b => ({ ...ident(b), p_qid: b.questionId }) },
  add_opcion:      { fn: 'add_opcion',      args: b => ({ ...ident(b), p_qid: b.questionId, p_opcion: b.opcion }) },
  edit_opcion:     { fn: 'edit_opcion',     args: b => ({ ...ident(b), p_qid: b.questionId, p_old_optkey: b.oldOptKey, p_nueva_opcion: b.nuevaOpcion }) },
  delete_opcion:   { fn: 'delete_opcion',   args: b => ({ ...ident(b), p_qid: b.questionId, p_optkey: b.optKey }) },
  add_proscontra:  { fn: 'add_proscontra',  args: b => ({ ...ident(b), p_qid: b.questionId, p_optkey: b.optKey, p_tipo: b.tipo, p_texto: b.texto }) },
  add_debate:      { fn: 'add_debate',      args: b => ({ ...ident(b), p_tipo: b.tipo, p_texto: b.texto, p_qid: b.qid || null, p_optkey: b.optKey || null, p_parent: b.parentId || null }) },
  vote_debate:     { fn: 'vote_debate',     args: b => ({ ...ident(b), p_id: b.id }) },
  resolve_debate:  { fn: 'resolve_debate',  args: b => ({ ...ident(b), p_id: b.id, p_resuelto: b.resuelto }) },
  edit_proscontra:   { fn: 'edit_proscontra',   args: b => ({ ...ident(b), p_id: b.id, p_texto: b.texto }) },
  delete_proscontra: { fn: 'delete_proscontra', args: b => ({ ...ident(b), p_id: b.id }) },
  vote_proscontra:   { fn: 'vote_proscontra',   args: b => ({ ...ident(b), p_id: b.id, p_voto: b.voto }) },
  reordenar_preguntas: { fn: 'reordenar_preguntas', args: b => ({ ...ident(b), p_ids: b.ids }) },
};

function unwrap(data) {
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function api(body) {
  // El pinHash puede venir en el cuerpo (flujo normal) o inyectarse en un
  // reintento con credencial rotada por apiAuthenticated().
  const def = RPC[body.action];
  if (!def) throw new Error('Acción desconocida: ' + body.action);

  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY;

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${def.fn}`, {
      method: 'POST', headers, body: JSON.stringify(def.args(body)),
    });
  } catch (e) {
    throw new Error('Sin conexión con el servidor (comprueba SUPABASE_URL y tu red)');
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return unwrap(await res.json());
}

// Envoltura de todas las llamadas autenticadas: reintenta una vez con la
// credencial de sesión si el servidor rechaza el pinHash en memoria.
async function apiAuth(body) {
  return apiAuthenticated(pin => {
    const b = { ...body, pinHash: body.pinHash || pin };
    return api(b);
  });
}

const apiPost = apiAuth;
