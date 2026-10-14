// ── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://tnkviacmerwtevabqctm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ruqVLDiQfHcc5tj9kvllkA_2wAJtdg6';

const POLL_INTERVAL      = 15000; // ms entre sondeos en vista de cuestionario
const POLL_FAST_INTERVAL = 4000;  // ms entre sondeos en Consenso / Debate en vivo
const POLL_MAX_BACKOFF   = 4;     // ante errores: intervalo × 2^n, con n ≤ 4
const SAVE_DEBOUNCE      = 800;   // ms para guardar el borrador local

const LS_USER  = 'viaje_v2_user';
const LS_DRAFT = eid => `viaje_v3_draft_${eid}`;