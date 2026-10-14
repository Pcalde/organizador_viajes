// ══════════════════════════════════════════════════════════════════════════
//  MOTOR ANALÍTICO, FACTIBILIDAD EN VIVO Y REFORMULARIO (js/reformulario.js)
//  Integra en cliente: datos.py, trayectorias.py, transporte.py,
//  optimizacion.py, resiliencia.py y reporte.py
// ══════════════════════════════════════════════════════════════════════════

let mcUseEmpiricalProb = true; // true = usa 1 - p_efectiva(ausencias); false = p_global fijo (0.12)

// ── 1. PROBABILIDADES Y UTILIDADES MATEMÁTICAS ──────────────────────────────
function getEffectiveProb(nombre) {
  const nLc = String(nombre).toLowerCase();
  const r   = respondentes.find(x => x.nombre.toLowerCase() === nLc);
  const own = (r && r.prob_asistencia != null) ? r.prob_asistencia / 100 : 0.8;

  if (!ausencias || !ausencias.length) return own;
  let menciones = 0;
  ausencias.forEach(a => {
    if ((a.candidatos || []).some(c => String(c).toLowerCase() === nLc)) menciones++;
  });
  const ratioSospecha = menciones / Math.max(1, ausencias.length);
  const probGrupo = Math.max(0.1, 1 - ratioSospecha * 0.75);
  return Math.max(0.05, Math.min(1, 0.7 * own + 0.3 * probGrupo));
}

function userWeight(nombre) {
  return weightByProb ? getEffectiveProb(nombre) : 1.0;
}

function getMySubmittedAnswers() {
  if (!user) return null;
  const mine = respuestas.find(r => r.nombre.toLowerCase() === user.nombre.toLowerCase());
  return mine ? mine.answers : collectAnswers();
}

// Generador pseudoaleatorio con semilla (Mulberry32) para Monte Carlo reproducible (seed=42)
function createSeededRNG(seed = 42) {
  let a = seed >>> 0;
  return function() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const [, m, d] = String(iso).split('-');
  return `${d}/${m}`;
}

function diffDaysISO(isoA, isoB) {
  const tA = Date.UTC(+isoA.slice(0, 4), +isoA.slice(5, 7) - 1, +isoA.slice(8, 10));
  const tB = Date.UTC(+isoB.slice(0, 4), +isoB.slice(5, 7) - 1, +isoB.slice(8, 10));
  return Math.round((tB - tA) / 86400000);
}

function isWeekendISO(iso) {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 5 || d === 6; // Viernes o Sábado (weekday 5, 6 en Python equivalen a Sáb/Dom; aquí Vie/Sáb/Dom)
}

function isSatSunISO(iso) {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 0 || d === 6; // Sábado o Domingo (exacto a d.weekday() in (5,6) de Python)
}

function parsePrecioNumerico(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// ── 2. NORMALIZACIÓN Y MATRIZ DE DISPONIBILIDAD (Port de datos.py) ──────────
function buildModelData() {
  const qDisp  = schema.find(q => q.tipo === 'disponibilidad');
  const qTrans = schema.find(q => getRadioStepperConfig(q)) || schema.find(q => q.id === 'transporte');
  const qPrec  = schema.find(q => q.id === 'precio' || q.tipo === 'slider');
  const qCasas = schema.find(q => q.tipo === 'casas');
  const qOpts  = schema.find(q => q.id === 'opciones-destino' || q.tipo === 'checkbox' || q.tipo === 'voto-ponderado');
  
  const viajeros = [];
  const allDatesSet = new Set();

  respuestas.forEach(r => {
    const ans = r.answers || {};
    const disp = qDisp ? extractAnswer(ans, qDisp) : null;
    const trans = qTrans ? extractAnswer(ans, qTrans) : null;
    const prec = qPrec ? extractAnswer(ans, qPrec) : null;
    const casasRaw = qCasas ? extractAnswer(ans, qCasas) : [];
    const optsRaw  = qOpts ? extractAnswer(ans, qOpts) : [];

    const diasMax = Math.max(1, parseInt((disp && disp.diasMax) ?? ans.diasMax ?? 5, 10) || 5);
    const soloFinde = !!(disp && disp.soloFinde);
    const rangos = (disp && Array.isArray(disp.rangos)) ? disp.rangos : (ans.rangosFechas || []);

    const conjuntoFechas = new Set();
    rangos.forEach(rg => {
      if (!rg || !rg.desde || !rg.hasta || rg.hasta < rg.desde) return;
      const cur = new Date(rg.desde + 'T00:00:00Z');
      const end = new Date(rg.hasta + 'T00:00:00Z');
      let guard = 0;
      while (cur <= end && guard < 180) {
        const iso = cur.toISOString().slice(0, 10);
        if (!soloFinde || isSatSunISO(iso) || new Date(iso + 'T00:00:00Z').getUTCDay() === 5) {
          conjuntoFechas.add(iso);
          allDatesSet.add(iso);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
        guard++;
      }
    });

    if (conjuntoFechas.size === 0) return; // Descarta participantes sin fechas válidas (como datos.py)

    const estadoTrans = trans ? (typeof trans === 'object' ? trans.estado : String(trans)) : '';
    const cs = qTrans ? getRadioStepperConfig(qTrans) : null;
    const keyPlazas = (cs && cs.key) ? cs.key : 'plazasLibres';
    const plazasLibres = (trans && typeof trans === 'object' && trans[keyPlazas] != null)
      ? Math.max(0, parseInt(trans[keyPlazas], 10) || 0)
      : 0;

    // Parseo de casas votadas con precio numérico (como parsear_casas_estricto en datos.py)
    const casasParsed = [];
    (Array.isArray(casasRaw) ? casasRaw : []).forEach(c => {
      const nombre = typeof c === 'string' ? c : c.nombre;
      let precioStr = (typeof c === 'object' && c.precio) ? c.precio : null;
      if (!precioStr && qCasas) {
        const schemaCasa = (qCasas.opciones || []).find(o => o.nombre === nombre);
        if (schemaCasa) precioStr = schemaCasa.precio;
      }
      const pNum = parsePrecioNumerico(precioStr);
      if (nombre && pNum != null && pNum > 0) {
        casasParsed.push({ nombre, precio_num: pNum });
      }
    });

    // Opciones de plan votadas
    let opcionesList = [];
    if (Array.isArray(optsRaw)) opcionesList = optsRaw;
    else if (optsRaw && typeof optsRaw === 'object') {
      opcionesList = Object.entries(optsRaw).filter(([, pts]) => Number(pts) > 0).map(([k]) => k);
    }

    viajeros.push({
      nombre: r.nombre,
      diasMax,
      precioMaxPP: (prec != null && !isNaN(prec) && Number(prec) >= 0) ? Number(prec) : null,
      transporte: String(estadoTrans || '').trim().toLowerCase(),
      plazasLibres,
      soloFinde,
      conjuntoFechas,
      casasParsed,
      opcionesList,
      probEfectiva: getEffectiveProb(r.nombre),
    });
  });

  if (!viajeros.length || !allDatesSet.size) {
    return { viajeros: [], indiceFechas: [], matriz: {}, lMaxEval: 0 };
  }

  const sortedBounds = [...allDatesSet].sort();
  const indiceFechas = [];
  const c = new Date(sortedBounds[0] + 'T00:00:00Z');
  const e = new Date(sortedBounds[sortedBounds.length - 1] + 'T00:00:00Z');
  let guard = 0;
  while (c <= e && guard < 180) {
    indiceFechas.push(c.toISOString().slice(0, 10));
    c.setUTCDate(c.getUTCDate() + 1);
    guard++;
  }

  // Matriz binaria A[fecha][nombre] ∈ {0, 1}
  const matriz = {};
  indiceFechas.forEach(f => {
    matriz[f] = {};
    viajeros.forEach(v => {
      matriz[f][v.nombre] = v.conjuntoFechas.has(f) ? 1 : 0;
    });
  });

  // Dentro de buildModelData() en js/reformulario.js, reemplaza el final por:
  const hayPlanDia = viajeros.some(v => v.diasMax === 1 || v.irYVenir || v.conjuntoFechas.size === 1);
  const lMinEval = hayPlanDia ? 1 : 2;
  const lMaxEval = Math.min(12, Math.max(lMinEval, ...viajeros.map(v => v.diasMax)));
  return { viajeros, indiceFechas, matriz, lMinEval, lMaxEval };
}

// ── 3. GENERACIÓN DE TRAYECTORIAS ÓPTIMAS (Port de trayectorias.py) ─────────
function generarTrayectoriasOptimas(conjuntoFechas, dMax, diasRango) {
  const limite = parseInt(dMax, 10);
  if (!limite || limite < 1) return [];
  const diasOrdenados = [...conjuntoFechas].sort();
  if (!diasOrdenados.length) return [];

  // Particionar en bloques consecutivos sin huecos
  const bloques = [];
  let actual = [diasOrdenados[0]];
  for (let i = 1; i < diasOrdenados.length; i++) {
    if (diffDaysISO(actual[actual.length - 1], diasOrdenados[i]) === 1) {
      actual.push(diasOrdenados[i]);
    } else {
      bloques.push(actual);
      actual = [diasOrdenados[i]];
    }
  }
  bloques.push(actual);

  const rangoSet = new Set(diasRango);
  const candidatas = [];

  for (const bloque of bloques) {
    const n = bloque.length;
    const maxLen = Math.min(n, limite);
    for (let len = 1; len <= maxLen; len++) {
      for (let ini = 0; ini <= n - len; ini++) {
        const traj = bloque.slice(ini, ini + len);
        let inter = 0, finde = 0;
        for (const d of traj) {
          if (rangoSet.has(d)) inter++;
          if (isSatSunISO(d)) finde++;
        }
        if (inter > 0) {
          candidatas.push({ traj, inter, len: traj.length, finde });
        }
      }
    }
  }

  candidatas.sort((a, b) => (b.inter - a.inter) || (b.len - a.len) || (b.finde - a.finde));
  return candidatas.map(c => c.traj);
}

// ── 4. FLUJO DE TRANSPORTE Y APARCAMIENTO (Port de transporte.py) ───────────
function construirFlujoTransporte(viajerosGrupo, dictAsignacion) {
  const idasCoches = {}, vueltasCoches = {};
  const idasPax = {}, vueltasPax = {};
  const conductoresObj = [];
  const fechasActivas = new Set();

  const mapViajeros = new Map(viajerosGrupo.map(v => [v.nombre, v]));

  for (const [nombre, traj] of Object.entries(dictAsignacion)) {
    const row = mapViajeros.get(nombre);
    if (!row || !traj || !traj.length) continue;
    const dias = [...traj].sort();
    dias.forEach(d => fechasActivas.add(d));
    const tIn = dias[0], tOut = dias[dias.length - 1];
    const estado = row.transporte;
    const plazas = row.plazasLibres;

    if (estado === 'propio') continue;

    if (!idasPax[tIn]) idasPax[tIn] = [];
    if (!vueltasPax[tOut]) vueltasPax[tOut] = [];
    if (!idasCoches[tIn]) idasCoches[tIn] = [];
    if (!vueltasCoches[tOut]) vueltasCoches[tOut] = [];

    if (estado === 'llevo-coche') {
      const coche = { nombre, plazas, t_in: tIn, t_out: tOut, aparcado: false };
      conductoresObj.push(coche);
      idasCoches[tIn].push(coche);
      vueltasCoches[tOut].push(coche);
    } else {
      idasPax[tIn].push(nombre);
      vueltasPax[tOut].push(nombre);
    }
  }

  // Heurística de aparcamiento: aparcar coche si la holgura en t_in y t_out >= plazas + 1
  conductoresObj.sort((a, b) => a.plazas - b.plazas);
  for (const coche of conductoresObj) {
    const tIn = coche.t_in, tOut = coche.t_out;
    const plazasIn = (idasCoches[tIn] || []).filter(x => !x.aparcado).reduce((s, x) => s + x.plazas, 0);
    const paxIn    = (idasPax[tIn] || []).length + (idasCoches[tIn] || []).filter(x => x.aparcado).length;
    const slackIn  = plazasIn - paxIn;

    const plazasOut = (vueltasCoches[tOut] || []).filter(x => !x.aparcado).reduce((s, x) => s + x.plazas, 0);
    const paxOut    = (vueltasPax[tOut] || []).length + (vueltasCoches[tOut] || []).filter(x => x.aparcado).length;
    const slackOut  = plazasOut - paxOut;

    const coste = coche.plazas + 1;
    if (slackIn >= coste && slackOut >= coste) {
      coche.aparcado = true;
    }
  }

  const flujo = { idas: [], vueltas: [], rango_activo: null };
  const pares = [
    [idasCoches, idasPax, 'idas'],
    [vueltasCoches, vueltasPax, 'vueltas'],
  ];

  for (const [dictCoches, dictPax, clave] of pares) {
    const dias = [...new Set([...Object.keys(dictCoches), ...Object.keys(dictPax)])].sort();
    for (const dia of dias) {
      const activos = (dictCoches[dia] || []).filter(c => !c.aparcado).sort((a, b) => b.plazas - a.plazas);
      const pasajeros = [
        ...(dictPax[dia] || []),
        ...(dictCoches[dia] || []).filter(c => c.aparcado).map(c => c.nombre),
      ];
      const estadoCoches = activos.map(c => ({ nombre: c.nombre, plazas: c.plazas, asignados: [] }));

      while (pasajeros.length > 0) {
        if (estadoCoches.length === 0) {
          return { viable: false, flujo: { error: `Sin coches el ${fmtShortDate(dia)} (${pasajeros.length} pax sin plaza)` } };
        }
        estadoCoches.sort((a, b) => b.plazas - a.plazas);
        const opt = estadoCoches[0];
        if (opt.plazas <= 0) {
          return { viable: false, flujo: { error: `Faltan plazas el ${fmtShortDate(dia)} (${pasajeros.length} pax sin asignar)` } };
        }
        opt.asignados.push(pasajeros.shift());
        opt.plazas -= 1;
      }

      for (const c of estadoCoches) {
        flujo[clave].push({ fecha: dia, conductor: c.nombre, pasajeros: c.asignados });
      }
    }
  }

  if (fechasActivas.size > 0) {
    const s = [...fechasActivas].sort();
    flujo.rango_activo = [s[0], s[s.length - 1]];
  }
  return { viable: true, flujo };
}

// ── 5. SOLVER COMBINATORIO DE VENTANAS (Port de optimizacion.py) ────────────
function resolverVentana(viajerosCandidatos, matriz, indiceFechas, nombresNucleo, diasRango, longitud) {
  const nucleoSet = new Set(nombresNucleo);
  const rangoSet  = new Set(diasRango);

  // Pesos por día (100 en ventana núcleo, 10 si >= mitad disponible, -50 resto)
  const mitad = viajerosCandidatos.length / 2;
  const pesosDias = {};
  indiceFechas.forEach(f => {
    if (rangoSet.has(f)) {
      pesosDias[f] = 100;
    } else {
      const disp = viajerosCandidatos.reduce((acc, v) => acc + (matriz[f]?.[v.nombre] || 0), 0);
      pesosDias[f] = disp >= mitad ? 10 : -50;
    }
  });

  const scoreTraj = traj => traj.reduce((s, d) => s + (pesosDias[d] ?? -50), 0);

  const baseAsignacion = {};
  let baseScore = 0;
  nombresNucleo.forEach(n => {
    baseAsignacion[n] = diasRango;
    baseScore += scoreTraj(diasRango);
  });

  // Espacio de estados para satélites (limitado a las 6 mejores trayectorias + opción de no asistir)
  const satelites = viajerosCandidatos.filter(v => !nucleoSet.has(v.nombre));
  const opcionesSat = satelites.map(sat => {
    const trajs = generarTrayectoriasOptimas(sat.conjuntoFechas, sat.diasMax, diasRango)
      .slice(0, 6)
      .map(t => ({ traj: t, score: scoreTraj(t) }))
      .filter(x => x.score > 0);
    return { nombre: sat.nombre, opciones: [...trajs, null] }; // null = no asignado
  });

  let bestSol = null;
  let bestScore = -Infinity;
  let nodesVisited = 0;
  const MAX_NODES = 1200;

  // Sufijo máximo posible para poda por cota superior (Branch & Bound)
  const maxRem = new Array(opcionesSat.length + 1).fill(0);
  for (let i = opcionesSat.length - 1; i >= 0; i--) {
    const bestOpt = opcionesSat[i].opciones.reduce((m, o) => Math.max(m, o ? o.score : 0), 0);
    maxRem[i] = maxRem[i + 1] + bestOpt;
  }

  function dfs(idx, curScore, curAsignacion) {
    if (nodesVisited > MAX_NODES) return;
    if (curScore + maxRem[idx] <= bestScore) return; // Poda por cota superior

    if (idx === opcionesSat.length) {
      nodesVisited++;
      const res = construirFlujoTransporte(viajerosCandidatos, curAsignacion);
      if (res.viable) {
        bestScore = curScore;
        bestSol = {
          asignacion: Object.assign({}, curAsignacion),
          flujo: res.flujo,
          objetivo: -curScore,
        };
      }
      return;
    }

    const sat = opcionesSat[idx];
    for (const opt of sat.opciones) {
      if (opt) {
        curAsignacion[sat.nombre] = opt.traj;
        dfs(idx + 1, curScore + opt.score, curAsignacion);
        delete curAsignacion[sat.nombre];
      } else {
        dfs(idx + 1, curScore, curAsignacion);
      }
    }
  }

  dfs(0, baseScore, baseAsignacion);
  if (!bestSol) return null;

  const asignadosSet = new Set(Object.keys(bestSol.asignacion));
  bestSol.viajerosAsignados = viajerosCandidatos.filter(v => asignadosSet.has(v.nombre));
  return bestSol;
}

// ── 6. SIMULACIÓN MONTE CARLO DE RESILIENCIA (Port de resiliencia.py) ───────
function simularFragilidad(dictAsignacion, viajerosAsignados, nSim = 250, pGlobal = 0.12, nCadena = 80, seed = 42) {
  const personas = Object.keys(dictAsignacion);
  if (!personas.length) return null;

  const rng = createSeededRNG(seed);
  const probFalta = {};
  viajerosAsignados.forEach(v => {
    probFalta[v.nombre] = mcUseEmpiricalProb
      ? Math.max(0.02, Math.min(0.95, 1 - v.probEfectiva))
      : pGlobal;
  });

  // 1. Impacto individual determinista (colapso inmediato si falta esa persona)
  const impactoIndividual = {};
  for (const p of personas) {
    const sinP = {};
    personas.forEach(k => { if (k !== p) sinP[k] = dictAsignacion[k]; });
    if (!Object.keys(sinP).length) {
      impactoIndividual[p] = 1.0;
      continue;
    }
    const grupoSinP = viajerosAsignados.filter(v => v.nombre !== p);
    const { viable } = construirFlujoTransporte(grupoSinP, sinP);
    impactoIndividual[p] = viable ? 0.0 : 1.0;
  }

  function simularEscenario(ausentesSet) {
    const asig = {};
    personas.forEach(k => { if (!ausentesSet.has(k)) asig[k] = dictAsignacion[k]; });
    if (!Object.keys(asig).length) return false;
    const subGrupo = viajerosAsignados.filter(v => !ausentesSet.has(v.nombre));
    return construirFlujoTransporte(subGrupo, asig).viable;
  }

  // 2. Viabilidad global Monte Carlo
  let nViables = 0;
  for (let s = 0; s < nSim; s++) {
    const ausentes = new Set(personas.filter(p => rng() < (probFalta[p] ?? pGlobal)));
    if (simularEscenario(ausentes)) nViables++;
  }
  const viabilidadGlobal = nViables / nSim;

  // 3. Impacto en cadena condicional por persona
  const impactoCadena = {};
  for (const p of personas) {
    let nViablesCond = 0;
    for (let s = 0; s < nCadena; s++) {
      const ausentes = new Set([p]);
      personas.forEach(otro => {
        if (otro !== p && rng() < (probFalta[otro] ?? pGlobal)) ausentes.add(otro);
      });
      if (simularEscenario(ausentes)) nViablesCond++;
    }
    const viaCond = nViablesCond / nCadena;
    impactoCadena[p] = Math.max(0.0, viabilidadGlobal - viaCond);
  }

  return {
    impactoIndividual,
    viabilidadGlobal,
    impactoCadena,
    nSim,
    pGlobal,
  };
}

// ── 7. BÚSQUEDA GLOBAL DE SOLUCIONES FACTIBLES (Port de buscar_resultados) ──
function ejecutarMotorFactibilidad(model) {
  const { viajeros, indiceFechas, matriz, lMaxEval } = model;
  if (!viajeros.length || indiceFechas.length < 2) return { soluciones: [], diagnosticos: [] };

  const candidatosBrutos = [];
  const diagnosticos = [];

  const lMin = model.lMinEval || 1; // Permite evaluar excursiones de 1 día (L = 1)
  for (let L = lMin; L <= lMaxEval; L++) {
    for (let i = 0; i <= indiceFechas.length - L; i++) {
      const diasRango = indiceFechas.slice(i, i + L);
      const fIni = diasRango[0], fFin = diasRango[diasRango.length - 1];

      const nombresNucleo = viajeros
        .filter(v => v.diasMax >= L && diasRango.every(d => matriz[d][v.nombre] === 1))
        .map(v => v.nombre);

      if (nombresNucleo.length < 2) continue;

      const nucleoSet = new Set(nombresNucleo);
      const minSatDays = L === 1 ? 1 : 2;
      const satelites = viajeros.filter(v => {
        if (nucleoSet.has(v.nombre)) return false;
        const diasEnVentana = diasRango.reduce((s, d) => s + matriz[d][v.nombre], 0);
        return diasEnVentana >= minSatDays;
      });

      const dfCandidatos = [
        ...viajeros.filter(v => nucleoSet.has(v.nombre)),
        ...satelites,
      ];

      const sol = resolverVentana(dfCandidatos, matriz, indiceFechas, nombresNucleo, diasRango, L);
      if (!sol) {
        diagnosticos.push(`Ventana ${fmtShortDate(fIni)}–${fmtShortDate(fFin)} (${L}d): sin flujo logístico factible.`);
        continue;
      }

      const asig = sol.asignacion;
      const dfAsig = sol.viajerosAsignados;
      const asistentesNucleo = nombresNucleo.filter(n => n in asig);
      const satelitesAsignados = dfAsig.map(v => v.nombre).filter(n => !(n in nucleoSet) && !nucleoSet.has(n));
      const nTotal = dfAsig.length;

      const presupuestos = dfAsig.map(v => v.precioMaxPP).filter(p => p != null);
      const pMaxGrupo = presupuestos.length ? Math.min(...presupuestos) : null;

      // Moda de opción de destino en el subgrupo asignado
      const freqOpts = {};
      dfAsig.forEach(v => {
        (v.opcionesList || []).forEach(op => { freqOpts[op] = (freqOpts[op] || 0) + 1; });
      });
      let strOpcion = 'Indeterminado';
      const optEntries = Object.entries(freqOpts);
      if (optEntries.length) {
        const maxV = Math.max(...optEntries.map(([, c]) => c));
        const modas = optEntries.filter(([, c]) => c === maxV).map(([k]) => k);
        strOpcion = `${modas.join(' / ')} (${maxV} votos)`;
      }

      // Evaluación de casas (Precio Cooperativo vs Precio Coalición)
      const mapCasas = new Map();
      dfAsig.forEach(v => {
        (v.casasParsed || []).forEach(c => {
          const k = `${c.nombre}||${c.precio_num}`;
          const prev = mapCasas.get(k) || { nombre: c.nombre, precio_total: c.precio_num, votos: 0 };
          prev.votos += 1;
          mapCasas.set(k, prev);
        });
      });

      const casasEvaluadas = [...mapCasas.values()].map(c => {
        const pCoop = c.precio_total / Math.max(1, nTotal);
        const pCoal = c.precio_total / Math.max(1, c.votos);
        const viable = pMaxGrupo == null ? true : (pCoop <= pMaxGrupo);
        return { ...c, p_coop: pCoop, p_coal: pCoal, viable };
      }).sort((a, b) => (Number(b.viable) - Number(a.viable)) || (b.votos - a.votos) || (a.p_coop - b.p_coop));

      const incluyeFinde = diasRango.some(isSatSunISO);

      candidatosBrutos.push({
        L,
        fIni,
        fFin,
        diasRango,
        incluyeFinde,
        N: nTotal,
        N_full: asistentesNucleo.length,
        N_convoy: satelitesAsignados.length,
        asistentesNucleo,
        satelitesAsignados,
        excluidos: viajeros.map(v => v.nombre).filter(n => !(n in asig)),
        opcionVotada: strOpcion,
        pMaxGrupo,
        casasEvaluadas,
        flujo: sol.flujo,
        objetivo: sol.objetivo,
        asignacion: asig,
        viajerosAsignados: dfAsig,
      });
    }
  }

  // Ordenar priorizando mayor asistencia total N, mayor núcleo N_full, mayor duración L y mejor objetivo
  candidatosBrutos.sort((a, b) =>
    (b.N - a.N) || (b.N_full - a.N_full) || (b.L - a.L) || (a.objetivo - b.objetivo)
  );

  // Filtrar soluciones redundantes (subventanas dominadas en el mismo rango con igual o menor gente)
  const soluciones = [];
  for (const cand of candidatosBrutos) {
    const dominada = soluciones.some(s =>
      s.N >= cand.N &&
      ((cand.fIni >= s.fIni && cand.fFin <= s.fFin) ||
       (Math.abs(diffDaysISO(cand.fIni, s.fIni)) <= 1 && Math.abs(diffDaysISO(cand.fFin, s.fFin)) <= 1))
    );
    if (!dominada) {
      cand.fragilidad = simularFragilidad(cand.asignacion, cand.viajerosAsignados);
      soluciones.push(cand);
      if (soluciones.length >= 4) break;
    }
  }

  return { soluciones, diagnosticos };
}

// ── 8. TOPOLOGÍA (A^T * A) Y SENSIBILIDAD (Port de reporte.py) ──────────────
function computeTopologyAndSensitivity(model, soluciones) {
  const { viajeros, indiceFechas, matriz } = model;
  const nombres = viajeros.map(v => v.nombre);
  const n = nombres.length;

  // Matriz C = A^T * A (días compartidos entre pares de participantes)
  const compat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let shared = 0;
      for (const f of indiceFechas) {
        if (matriz[f][nombres[i]] && matriz[f][nombres[j]]) shared++;
      }
      compat[i][j] = shared;
      compat[j][i] = shared;
    }
  }

  // Aislamiento topológico: norma L1 de la fila excluyendo la diagonal
  let nomAislado = 'Ninguno', valAislado = Infinity;
  for (let i = 0; i < n; i++) {
    let l1 = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) l1 += compat[i][j];
    }
    if (l1 < valAislado) { valAislado = l1; nomAislado = nombres[i]; }
  }
  if (valAislado === Infinity) valAislado = 0;

  // Cuello de botella logístico diario
  let diaCritico = 'N/A', minHolgura = Infinity;
  const serieLogistica = indiceFechas.map(f => {
    let oferta = 0, demanda = 0;
    viajeros.forEach(v => {
      if (!matriz[f][v.nombre]) return;
      if (v.transporte === 'llevo-coche') oferta += v.plazasLibres;
      else if (v.transporte !== 'propio') demanda += 1;
    });
    const holgura = oferta - demanda;
    if (demanda > 0 && holgura < minHolgura) {
      minHolgura = holgura;
      diaCritico = fmtShortDate(f);
    }
    return { fecha: f, oferta, demanda, holgura };
  });
  if (minHolgura === Infinity) minHolgura = 0;

  // Restricción económica activa
  const conPrecio = viajeros.filter(v => v.precioMaxPP != null).sort((a, b) => a.precioMaxPP - b.precioMaxPP);
  const nomEco = conPrecio.length ? conPrecio[0].nombre : 'Ninguno';
  const valEco = conPrecio.length ? conPrecio[0].precioMaxPP : 0;

  // Menor disponibilidad temporal
  const porDisp = [...viajeros].sort((a, b) => a.conjuntoFechas.size - b.conjuntoFechas.size);
  const nomT = porDisp.length ? porDisp[0].nombre : 'Ninguno';
  const valT = porDisp.length ? porDisp[0].conjuntoFechas.size : 0;

  // Índice de Imprescindibilidad agregado entre soluciones óptimas (como render_indispensables en reporte.py)
  const acumIndis = {};
  let nSolsConFrag = 0;
  soluciones.forEach(s => {
    if (!s.fragilidad) return;
    nSolsConFrag++;
    Object.entries(s.fragilidad.impactoCadena).forEach(([p, v]) => {
      acumIndis[p] = (acumIndis[p] || 0) + v;
    });
    Object.entries(s.fragilidad.impactoIndividual).forEach(([p, v]) => {
      if (v === 1.0) acumIndis[p] = (acumIndis[p] || 0) + 0.3;
    });
  });

  const rankingIndispensables = Object.entries(acumIndis)
    .map(([nombre, sc]) => ({ nombre, score: Math.round((sc / Math.max(1, nSolsConFrag)) * 1000) / 10 }))
    .sort((a, b) => b.score - a.score);

  return {
    nombres,
    compat,
    serieLogistica,
    sensibilidad: { diaCritico, minHolgura, nomAislado, valAislado, nomEco, valEco, nomT, valT },
    rankingIndispensables,
  };
}

// ── 9. RENDERIZADO PRINCIPAL EN EL DOM ──────────────────────────────────────
function renderReformulario() {
  const container = $('consensus-container');
  if (!container) return;
  if (container.querySelector('input[type=range]:active')) return;

  container.innerHTML = '';

  if (!serverHasV2) {
    const warn = div('card');
    warn.style.borderColor = 'var(--accent)';
    warn.innerHTML = `
      <div class="card-title"><span class="num" style="background:var(--accent)">!</span> Falta actualizar <code>schema.sql</code> en Supabase</div>
      <p style="color:var(--ink);font-size:0.9rem;line-height:1.5">
        Hay <b>${respondentes.length}</b> participante(s) en la encuesta, pero el servidor de Supabase sigue ejecutando la función <code>_snapshot</code> antigua (que no enviaba el campo <code>respuestas</code> ni tenía la tabla <code>debate</code>).<br><br>
        👉 Abre <b>Supabase → SQL Editor</b>, pega el nuevo <code>schema.sql</code> completo y pulsa <b>Run</b>. Al recargar la página verás inmediatamente las respuestas y funcionará el debate.
      </p>
    `;
    container.appendChild(warn);
    return;
  }

  if (!respuestas.length) {
    const empty = div('card');
    empty.innerHTML = `
      <div class="card-title"><span class="num">📊</span> Sin respuestas enviadas aún</div>
      <p style="color:var(--muted);font-size:0.9rem">
        Hay ${respondentes.length} persona(s) registrada(s) en el viaje, pero nadie ha pulsado <b>«Enviar mi respuesta →»</b> todavía.
      </p>
    `;
    container.appendChild(empty);
    return;
  }

  const model = buildModelData();
  const { soluciones, diagnosticos } = ejecutarMotorFactibilidad(model);
  const topo = computeTopologyAndSensitivity(model, soluciones);

  container.appendChild(buildExecutiveSummaryCard(model, soluciones, topo));
  container.appendChild(buildFeasibleSolutionsSection(soluciones, diagnosticos, topo));

  if (model.viajeros.length >= 2) {
    container.appendChild(buildTopologyAndSensitivityCard(model, topo));
  }

  const myAns = getMySubmittedAnswers();
  const secHeader = div('ref-section-divider');
  secHeader.innerHTML = `<span>Reformulario Interactivo por Pregunta (haz clic para cambiar tu voto en vivo)</span>`;
  container.appendChild(secHeader);

  schema.forEach((q, idx) => {
    const card = buildAnalyticalCard(q, idx, myAns);
    if (card) container.appendChild(card);
  });
}

function buildExecutiveSummaryCard(model, soluciones, topo) {
  const card = div('card ref-summary-card');
  const nombres = respondentes.map(r => r.nombre);
  let expected = 0, variance = 0;
  const probs = nombres.map(nombre => {
    const p = getEffectiveProb(nombre);
    expected += p;
    variance += p * (1 - p);
    return { nombre, p };
  }).sort((a, b) => b.p - a.p);

  const nMax = soluciones.length ? Math.max(...soluciones.map(s => s.N)) : 0;
  const lMax = soluciones.length ? Math.max(...soluciones.map(s => s.L)) : 0;

  card.innerHTML = `
    <div class="ref-summary-header">
      <div>
        <div class="card-title" style="margin-bottom:4px"><span class="num">Σ</span> Síntesis de Factibilidad y Reformulario</div>
        <p style="font-size:0.82rem;color:var(--muted)">
          ${soluciones.length} solución(es) factible(s) encontrada(s) · Máx. N=${nMax} asistentes · L=${lMax} días
        </p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="toggle-label" style="font-size:0.78rem;background:var(--bg);padding:5px 10px;border-radius:8px;border:1px solid var(--border)">
          <input type="checkbox" id="toggle-weight-prob" ${weightByProb ? 'checked' : ''}>
          <span class="toggle-pill"></span>
          <span>Ponderar rankings por $p_i$</span>
        </label>
        <label class="toggle-label" style="font-size:0.78rem;background:var(--bg);padding:5px 10px;border-radius:8px;border:1px solid var(--border)">
          <input type="checkbox" id="toggle-mc-empirical" ${mcUseEmpiricalProb ? 'checked' : ''}>
          <span class="toggle-pill"></span>
          <span>Monte Carlo con ausencias votadas</span>
        </label>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-box">
        <span class="kpi-label">Participantes (con fechas)</span>
        <span class="kpi-val">${model.viajeros.length} <small>/ ${respondentes.length} resp.</small></span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Esperanza asistencia E[N]</span>
        <span class="kpi-val">${expected.toFixed(1)} <small>± ${Math.sqrt(variance).toFixed(1)}</small></span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Probabilidad efectiva por miembro</span>
        <div class="kpi-pills">
          ${probs.map(u => `<span class="user-prob-pill">${esc(u.nombre)} <b>${Math.round(u.p * 100)}%</b></span>`).join('')}
        </div>
      </div>
    </div>
  `;

  card.querySelector('#toggle-weight-prob').addEventListener('change', e => {
    weightByProb = e.target.checked;
    renderReformulario();
  });
  card.querySelector('#toggle-mc-empirical').addEventListener('change', e => {
    mcUseEmpiricalProb = e.target.checked;
    renderReformulario();
  });

  return card;
}

// ── RENDER DE SOLUCIONES ÓPTIMAS (Port visual de reporte.py) ────────────────
function buildFeasibleSolutionsSection(soluciones, diagnosticos, topo) {
  const wrap = div('ref-solutions-wrap');

  if (!soluciones.length) {
    const diagHtml = diagnosticos.slice(0, 6).map(d => `<li>${esc(d)}</li>`).join('');
    wrap.innerHTML = `
      <div class="card" style="border-color:var(--accent)">
        <div class="card-title"><span class="num" style="background:var(--accent)">!</span> Sin soluciones simultáneamente factibles en fechas y transporte</div>
        <p style="font-size:0.86rem;color:var(--muted);margin-bottom:10px">
          El optimizador evaluó todas las ventanas de $\\ge 2$ días con al menos 2 miembros de núcleo, pero ninguna superó las restricciones de capacidad de vehículos o solapamiento:
        </p>
        ${diagHtml ? `<ul style="font-size:0.8rem;color:var(--muted);padding-left:18px;margin-bottom:10px">${diagHtml}</ul>` : ''}
        <p style="font-size:0.84rem;color:var(--ink)">
          💡 <b>Usa el Reformulario más abajo</b> para ampliar tus fechas o cambiar tu opción de transporte a <em>"Llevo coche"</em> y desbloquear soluciones.
        </p>
      </div>
    `;
    return wrap;
  }

  soluciones.forEach((sol, idx) => {
    const card = div('card sol-card');
    const tagFinde = sol.incluyeFinde ? 'Incluye Fin de Semana' : 'Solo entre semana';
    const pStr = sol.pMaxGrupo != null ? `${sol.pMaxGrupo} €` : 'N/A';

    // Tablas de logística (Idas y Vueltas)
    const renderTablaViajes = (viajes, titulo, badgeCls) => {
      if (!viajes || !viajes.length) return `<div class="muted-note">Sin desplazamientos en coche requeridos.</div>`;
      return `
        <div class="sol-log-box">
          <div class="sol-log-title ${badgeCls}">${titulo}</div>
          <table class="sol-log-table">
            <thead><tr><th>Fecha</th><th>Conductor</th><th>Pasajeros asignados</th></tr></thead>
            <tbody>
              ${viajes.map(v => `
                <tr>
                  <td class="mono-cell">${fmtShortDate(v.fecha)}</td>
                  <td><b>${esc(v.conductor)}</b></td>
                  <td>${v.pasajeros.length ? v.pasajeros.map(esc).join(', ') : '<em style="color:var(--muted)">solo</em>'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    };

    // Evaluación de casas (Precio Cooperativo vs Coalición)
    const casasHtml = sol.casasEvaluadas.length
      ? sol.casasEvaluadas.map(c => `
          <div class="sol-casa-item ${c.viable ? 'viable' : 'inviable'}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
              <strong>${esc(c.nombre)}</strong>
              <span class="sol-badge ${c.viable ? 'ok' : 'err'}">${c.viable ? '✓ Viable en presupuesto' : '✗ Excede presupuesto mín.'}</span>
            </div>
            <div class="sol-casa-meta">
              <span>Total: <b>${c.precio_total.toFixed(0)}€</b></span>
              <span>Cooperativo (entre ${sol.N}): <b>${c.p_coop.toFixed(1)}€/pers</b></span>
              <span>Coalición (${c.votos} votantes): <b>${c.p_coal.toFixed(1)}€/pers</b></span>
            </div>
          </div>
        `).join('')
      : `<div class="muted-note">No hay casas con precio numérico votadas por este subgrupo.</div>`;

    // Resiliencia Monte Carlo
    const frag = sol.fragilidad;
    let fragHtml = '';
    if (frag) {
      const viaPct = Math.round(frag.viabilidadGlobal * 100);
      const criticos = Object.entries(frag.impactoIndividual).filter(([, v]) => v === 1.0).map(([k]) => k);
      const cadenaArr = Object.entries(frag.impactoCadena)
        .map(([k, v]) => ({ nombre: k, drop: Math.round(v * 1000) / 10, crit: frag.impactoIndividual[k] === 1.0 }))
        .sort((a, b) => b.drop - a.drop);

      fragHtml = `
        <div class="sol-frag-box">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:10px">
            <div>
              <span class="kpi-label">Resiliencia Logística (Monte Carlo, ${frag.nSim} sims)</span>
              <div style="font-size:1.35rem;font-weight:700;color:${viaPct >= 80 ? 'var(--accent2)' : viaPct >= 50 ? '#b7791f' : 'var(--accent)'}">
                ${viaPct}% viabilidad ante bajas
              </div>
            </div>
            <div>
              <span class="kpi-label">Imprescindibles (colapso inmediato si faltan)</span>
              <div style="margin-top:4px">
                ${criticos.length ? criticos.map(c => `<span class="voter-chip veto">${esc(c)}</span>`).join(' ') : `<span style="color:var(--accent2);font-size:0.8rem">✓ Ninguno crítico (hay holgura de coches)</span>`}
              </div>
            </div>
          </div>
          <div class="ref-dist-list">
            ${cadenaArr.slice(0, 5).map(item => `
              <div class="ref-dist-row">
                <span class="ref-dist-name">${esc(item.nombre)}${item.crit ? '⚠️' : ''}</span>
                <div class="ref-bar-track" style="flex:1">
                  <div class="ref-bar-fill ${item.crit ? 'negative' : ''}" style="width:${Math.min(100, Math.max(3, item.drop))}%"></div>
                </div>
                <span class="ref-dist-val" style="width:70px;text-align:right">-${item.drop}% viab.</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="sol-card-head">
        <div>
          <span class="sol-tag">Solución Óptima #${idx + 1} · ${tagFinde}</span>
          <h3 class="sol-interval">📅 ${fmtShortDate(sol.fIni)} → ${fmtShortDate(sol.fFin)} (${sol.L} días)</h3>
        </div>
        <div class="sol-pills">
          <span class="sol-pill">Total <b>${sol.N}</b></span>
          <span class="sol-pill">Núcleo <b>${sol.N_full}</b></span>
          <span class="sol-pill">Satélites <b>${sol.N_convoy}</b></span>
          <span class="sol-pill">Tope Coop. <b>${pStr}</b></span>
        </div>
      </div>

      <div class="sol-group-chips">
        <div><small>Núcleo (${sol.N_full}):</small> ${sol.asistentesNucleo.map(n => `<span class="voter-chip star">${esc(n)}</span>`).join(' ')}</div>
        ${sol.satelitesAsignados.length ? `<div><small>Satélites (${sol.N_convoy}):</small>${sol.satelitesAsignados.map(n => `<span class="voter-chip">${esc(n)} (${fmtShortDate(sol.asignacion[n][0])}→${fmtShortDate(sol.asignacion[n][sol.asignacion[n].length - 1])})</span>`).join(' ')}</div>` : ''}
        ${sol.excluidos.length ? `<div><small>Excluidos (${sol.excluidos.length}):</small>${sol.excluidos.map(n => `<span class="voter-chip veto">${esc(n)}</span>`).join(' ')}</div>` : `<div><span style="color:var(--accent2);font-size:0.8rem">✓ ¡Asistencia perfecta del grupo!</span></div>`}
      </div>

      <div class="sol-log-grid">
        ${renderTablaViajes(sol.flujo.idas, '↗ Viajes de Ida', 'ida')}
        ${renderTablaViajes(sol.flujo.vueltas, '↙ Viajes de Vuelta', 'vuelta')}
      </div>

      <div style="margin-top:14px">
        <div style="font-size:0.82rem;color:var(--muted);margin-bottom:6px">
          Plan preferido por los asistentes: <strong style="color:var(--ink)">${esc(sol.opcionVotada)}</strong>
        </div>
        ${casasHtml}
      </div>

      ${fragHtml}

      <div style="margin-top:12px;display:flex;justify-content:flex-end">
        <button type="button" class="btn-propose btn-propose-sol" style="padding:6px 12px;font-size:0.8rem">
          📌 Llevar esta solución como Propuesta a la Sala de Debate →
        </button>
      </div>
    `;

    card.querySelector('.btn-propose-sol').addEventListener('click', () => {
      const textoPropuesta = `Propongo cerrar la Solución #${idx + 1}: del ${fmtShortDate(sol.fIni)} al ${fmtShortDate(sol.fFin)} (${sol.L} días, ${sol.N} asistentes: ${[...sol.asistentesNucleo, ...sol.satelitesAsignados].join(', ')}). Plan: ${sol.opcionVotada}.`;
      if (typeof createProposalFromConsensus === 'function') {
        createProposalFromConsensus(textoPropuesta);
      }
    });

    wrap.appendChild(card);
  });

  return wrap;
}

// ── TARJETA DE SENSIBILIDAD, TOPOLOGÍA (A^T A) E IMPRESCINDIBLES ────────────
function buildTopologyAndSensitivityCard(model, topo) {
  const card = div('card');
  const s = topo.sensibilidad;
  const n = topo.nombres.length;
  let maxShared = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) if (topo.compat[i][j] > maxShared) maxShared = topo.compat[i][j];
  }

  card.innerHTML = `
    <div class="card-title"><span class="num">🕸️</span> Sensibilidad, Cuellos de Botella y Topología ($A^T A$)</div>

    <div class="sens-grid-4">
      <div class="kpi-box">
        <span class="kpi-label">Cuello de Botella Logístico</span>
        <span class="kpi-val" style="color:var(--accent)">${esc(s.diaCritico)}</span>
        <small>Holgura mínima: ${s.minHolgura} plaza(s)</small>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Aislamiento Topológico ($L_1$)</span>
        <span class="kpi-val">${esc(s.nomAislado)}</span>
        <small>${s.valAislado} intersecciones con el grupo</small>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Restricción Económica</span>
        <span class="kpi-val" style="color:var(--accent)">${esc(s.nomEco)}</span>
        <small>Fija el techo coop. en ${s.valEco} €/pers</small>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Menor Disponibilidad</span>
        <span class="kpi-val">${esc(s.nomT)}</span>
        <small>${s.valT} días totales marcados</small>
      </div>
    </div>

    ${topo.rankingIndispensables.length ? `
      <div style="margin-top:16px">
        <div style="font-size:0.82rem;font-weight:600;color:var(--muted);margin-bottom:8px">ÍNDICE DE IMPRESCINDIBILIDAD (Agregado Monte Carlo)</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${topo.rankingIndispensables.slice(0, 4).map((r, i) => `
            <span class="user-prob-pill" style="padding:5px 10px">
              ${['🥇','🥈','🥉','•'][i]} <b>${esc(r.nombre)}</b>: índice ${r.score}
            </span>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <details style="margin-top:16px">
      <summary style="cursor:pointer;font-size:0.84rem;font-weight:500;color:var(--accent3)">
        Ver Matriz de Compatibilidad Temporal Cruzada ($A^T A$ — días en común)
      </summary>
      <div style="overflow-x:auto;margin-top:10px">
        <table class="compat-matrix-table">
          <thead>
            <tr>
              <th></th>
              ${topo.nombres.map(nom => `<th>${esc(nom.slice(0, 8))}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${topo.nombres.map((nomI, i) => `
              <tr>
                <th style="text-align:left">${esc(nomI)}</th>${topo.nombres.map((_, j) => {
                  const v = topo.compat[i][j];
                  const alpha = (v / maxShared) * 0.45;
                  return `<td style="background:rgba(58,107,74,${alpha.toFixed(2)})">${v}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </details>
  `;
  return card;
}

// ── 10. TARJETAS INTERACTIVAS DE REFORMULARIO POR PREGUNTA ──────────────────
function buildAnalyticalCard(q, idx, myAns) {
  const card = div('card ref-card');
  const title = div('card-title');
  title.innerHTML = `<span class="num">${idx + 1}</span> ${esc(q.label)}`;
  card.appendChild(title);

  const myVal = extractAnswer(myAns, q);

  switch (q.tipo) {
    case 'checkbox':
    case 'voto-ponderado':
    case 'casas':
      buildOptionsConsensus(card, q, myVal);
      break;
    case 'slider':
      buildSliderConsensus(card, q, myVal);
      break;
    case 'disponibilidad':
      buildDisponibilidadConsensus(card, q);
      break;
    case 'radio':
      buildRadioConsensus(card, q, myVal);
      break;
    case 'textarea':
      buildTextareaConsensus(card, q);
      break;
    case 'horarios':
      buildHorariosConsensus(card, q, myVal);
      break;
  }
  return card;
}

function buildOptionsConsensus(card, q, myVal) {
  const pcIdx = pcIndex();
  const opts  = (q.opciones || []).map(op => {
    const key    = optVal(q, op);
    const precio = (op && typeof op === 'object' && op.precio) ? op.precio : null;
    const url    = (op && typeof op === 'object' && op.url) ? safeUrl(op.url) : '';
    return { key, precio, url, score: 0, rawScore: 0, voters: [], vetoes: [] };
  });

  const map = new Map(opts.map(o => [o.key, o]));

  respuestas.forEach(r => {
    const v = extractAnswer(r.answers, q);
    if (!v) return;
    const w = userWeight(r.nombre);

    if (q.tipo === 'checkbox') {
      (Array.isArray(v) ? v : []).forEach(k => {
        const item = map.get(k);
        if (item) { item.score += w; item.rawScore += 1; item.voters.push({ nombre: r.nombre, pts: 1 }); }
      });
    } else if (q.tipo === 'casas') {
      (Array.isArray(v) ? v : []).forEach(c => {
        const k = typeof c === 'string' ? c : c.nombre;
        const item = map.get(k);
        if (item) { item.score += w; item.rawScore += 1; item.voters.push({ nombre: r.nombre, pts: 1 }); }
      });
    } else if (q.tipo === 'voto-ponderado') {
      Object.entries(v || {}).forEach(([k, pts]) => {
        const item = map.get(k);
        const pNum = Number(pts);
        if (!item || !pNum) return;
        item.score += pNum * w;
        item.rawScore += pNum;
        if (pNum < 0) item.vetoes.push(r.nombre);
        else item.voters.push({ nombre: r.nombre, pts: pNum });
      });
    }
  });

  opts.sort((a, b) => b.score - a.score || b.voters.length - a.voters.length);
  const maxScore = Math.max(1, ...opts.map(o => Math.abs(o.score)));

  const list = div('ref-opt-list');

  opts.forEach((o, rank) => {
    const row = div('ref-opt-row' + (rank === 0 && o.score > 0 ? ' is-leader' : ''));
    const pct = Math.max(0, Math.min(100, (o.score / maxScore) * 100));
    const entriesPC = pcIdx.get(q.id + '\u0000' + o.key) || [];
    const pros = entriesPC.filter(e => e.tipo === 'pro').length;
    const cons = entriesPC.filter(e => e.tipo === 'contra').length;
    const controversial = (o.vetoes.length > 0 && o.voters.length >= 2) || (pros > 0 && cons >= 2);

    let controlsHtml = '';
    if (q.tipo === 'voto-ponderado') {
      const myScore = (myVal && myVal[o.key]) ? Number(myVal[o.key]) : 0;
      controlsHtml = `
        <div class="btn-group-pond ref-inline-pond">
          <button type="button" class="btn-pond ${myScore === -1 ? 'active' : ''}" data-score="-1">-1</button>
          <button type="button" class="btn-pond ${myScore === 1 ? 'active' : ''}" data-score="1">+1</button>
          <button type="button" class="btn-pond ${myScore === 3 ? 'active' : ''}" data-score="3">+3</button>
        </div>
      `;
    } else {
      const isChecked = q.tipo === 'casas'
        ? (Array.isArray(myVal) && myVal.some(c => (typeof c === 'string' ? c : c.nombre) === o.key))
        : (Array.isArray(myVal) && myVal.includes(o.key));
      controlsHtml = `
        <button type="button" class="btn-ref-toggle ${isChecked ? 'active' : ''}">
          ${isChecked ? '✓ Votado' : '+ Votar'}
        </button>
      `;
    }

    row.innerHTML = `
      <div class="ref-opt-main">
        <div class="ref-opt-info">
          <span class="ref-rank">#${rank + 1}</span>
          ${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener" class="ref-link">${esc(o.key)} ↗</a>` : `<span class="ref-opt-title">${esc(o.key)}</span>`}
          ${o.precio ? `<span class="casa-precio">${esc(o.precio)}</span>` : ''}
          ${controversial ? `<span class="badge-controversy">⚡ Polarizada</span>` : ''}
        </div>
        <div class="ref-opt-actions">
          <span class="ref-score-badge">${weightByProb ? o.score.toFixed(1) : o.rawScore} pts</span>
          ${controlsHtml}
        </div>
      </div>
      <div class="ref-bar-track">
        <div class="ref-bar-fill ${o.score < 0 ? 'negative' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="ref-opt-meta">
        <div class="ref-voters">
          ${o.voters.map(v => `<span class="voter-chip ${v.pts === 3 ? 'star' : ''}">${esc(v.nombre)}${v.pts === 3 ? ' ★' : ''}</span>`).join('')}
          ${o.vetoes.map(nombre => `<span class="voter-chip veto">${esc(nombre)} ✕</span>`).join('')}
          ${!o.voters.length && !o.vetoes.length ? `<span style="color:var(--muted);font-size:0.75rem">Sin votos aún</span>` : ''}
        </div>
        <button type="button" class="btn-JumpDebate">
          💬 ${pros + cons > 0 ? `▲${pros} ▼${cons} · Debatir` : 'Debatir opción'}
        </button>
      </div>
    `;

    if (q.tipo === 'voto-ponderado') {
      row.querySelectorAll('.btn-pond').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = parseInt(btn.dataset.score, 10);
          const next = Object.assign({}, myVal || {});
          if (next[o.key] === s) delete next[o.key];
          else {
            if (s === 3 || s === -1) Object.keys(next).forEach(k => { if (next[k] === s) delete next[k]; });
            next[o.key] = s;
          }
          patchSingleAnswer(q.id, next);
        });
      });
    } else {
      row.querySelector('.btn-ref-toggle').addEventListener('click', () => {
        if (q.tipo === 'casas') {
          const cur = Array.isArray(myVal) ? [...myVal] : [];
          const exists = cur.some(c => (typeof c === 'string' ? c : c.nombre) === o.key);
          const next = exists
            ? cur.filter(c => (typeof c === 'string' ? c : c.nombre) !== o.key)
            : [...cur, { nombre: o.key, precio: o.precio }];
          patchSingleAnswer(q.id, next);
        } else {
          const cur = new Set(Array.isArray(myVal) ? myVal : []);
          if (cur.has(o.key)) cur.delete(o.key); else cur.add(o.key);
          patchSingleAnswer(q.id, [...cur]);
        }
      });
    }

    row.querySelector('.btn-JumpDebate').addEventListener('click', () => {
      if (typeof openDebateFor === 'function') openDebateFor(q.id, o.key);
    });

    list.appendChild(row);
  });

  card.appendChild(list);
}

function buildSliderConsensus(card, q, myVal) {
  const cfg  = q.config || {};
  const min  = cfg.min ?? 10, max = cfg.max ?? 500, step = cfg.step ?? 10;
  const unit = cfg.unit ?? (q.id === 'precio' ? ' €' : '');

  const entries = [];
  respuestas.forEach(r => {
    const v = extractAnswer(r.answers, q);
    if (v != null && !isNaN(v)) entries.push({ nombre: r.nombre, val: Number(v) });
  });

  if (!entries.length) {
    card.innerHTML += `<p style="color:var(--muted);font-size:0.85rem">Sin datos numéricos aún.</p>`;
    return;
  }

  entries.sort((a, b) => a.val - b.val);
  const vals = entries.map(e => e.val);
  const vMin = vals[0];
  const q1   = vals[Math.floor((vals.length - 1) * 0.25)];
  const med  = vals[Math.floor((vals.length - 1) * 0.50)];
  const mean = vals.reduce((acc, x) => acc + x, 0) / vals.length;
  const curMyVal = (myVal != null && !isNaN(myVal)) ? Number(myVal) : (cfg.default ?? med);

  const wrap = div('ref-slider-analysis');
  wrap.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:14px">
      <div class="kpi-box">
        <span class="kpi-label">Restricción Activa (Mín)</span>
        <span class="kpi-val" style="color:var(--accent)">${vMin}${esc(unit)}</span>
        <small>Por ${esc(entries[0].nombre)}</small>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Percentil 25 ($Q_1$)</span>
        <span class="kpi-val">${q1}${esc(unit)}</span>
        <small>75% del grupo lo acepta</small>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Mediana / Media</span>
        <span class="kpi-val">${med}${esc(unit)} <small>/ ${Math.round(mean)}${esc(unit)}</small></span>
      </div>
    </div>

    <div class="ref-dist-list">
      ${entries.map(e => {
        const pct = max > min ? ((e.val - min) / (max - min)) * 100 : 50;
        return `
          <div class="ref-dist-row">
            <span class="ref-dist-name">${esc(e.nombre)}</span>
            <div class="ref-bar-track" style="flex:1">
              <div class="ref-bar-fill" style="width:${Math.max(4, Math.min(100, pct))}%"></div>
            </div>
            <span class="ref-dist-val">${e.val}${esc(unit)}</span>
          </div>
        `;
      }).join('')}
    </div>

    <div class="ref-reformulario-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:0.85rem;font-weight:500">Ajustar mi límite en caliente:</span>
        <strong class="ref-live-val" style="color:var(--accent2);font-size:1.1rem">${curMyVal}${esc(unit)}</strong>
      </div>
      <input type="range" class="ref-live-slider" min="${min}" max="${max}" step="${step}" value="${curMyVal}">
    </div>
  `;

  const sl  = wrap.querySelector('.ref-live-slider');
  const lbl = wrap.querySelector('.ref-live-val');
  const updatePct = () => {
    const pct = max > min ? ((+sl.value - min) / (max - min)) * 100 : 0;
    sl.style.setProperty('--pct', pct + '%');
    lbl.textContent = sl.value + unit;
  };
  updatePct();
  sl.addEventListener('input', updatePct);
  sl.addEventListener('change', () => patchSingleAnswer(q.id, +sl.value));

  card.appendChild(wrap);
}

function buildDisponibilidadConsensus(card) {
  const model = buildModelData();
  if (!model.indiceFechas.length) {
    card.innerHTML += `<p style="color:var(--muted);font-size:0.85rem">Sin fechas registradas.</p>`;
    return;
  }

  // Heatmap compacto de disponibilidad por persona y fecha
  const wrap = div();
  const datesSlice = model.indiceFechas.slice(0, 45); // Primeros 45 días activos para legibilidad
  wrap.innerHTML = `
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:8px">
      Mapa de calor diario (${model.indiceFechas.length} días en el horizonte; las ventanas óptimas combinadas se muestran arriba):
    </div>
    <div style="overflow-x:auto">
      <table class="compat-matrix-table">
        <thead>
          <tr>
            <th style="text-align:left">Viajero (${model.viajeros.length})</th>
            <th>díasMax</th>
            ${datesSlice.map(f => `<th class="${isSatSunISO(f) ? 'wknd-col' : ''}">${fmtShortDate(f)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${model.viajeros.map(v => `
            <tr>
              <th style="text-align:left">${esc(v.nombre)}</th>
              <td><b>${v.diasMax}d</b></td>${datesSlice.map(f => {
                const avail = model.matriz[f][v.nombre];
                return `<td style="background:${avail ? 'rgba(58,107,74,0.65);color:#fff' : 'transparent'}">${avail ? '✓' : '·'}</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  card.appendChild(wrap);
}

function buildRadioConsensus(card, q, myVal) {
  const cs = getRadioStepperConfig(q);
  const counts = new Map();
  (q.opciones || []).forEach(op => {
    const s = String(op);
    const [val, label] = s.includes('|') ? s.split('|') : [s, s];
    counts.set(val, { val, label, users: [], extraSum: 0 });
  });

  respuestas.forEach(r => {
    const v = extractAnswer(r.answers, q);
    if (!v) return;
    const est = typeof v === 'object' ? v.estado : v;
    const entry = counts.get(est);
    if (entry) {
      const extra = (cs && typeof v === 'object' && v[cs.key || 'plazasLibres']) ? Number(v[cs.key || 'plazasLibres']) : 0;
      entry.users.push({ nombre: r.nombre, extra });
      entry.extraSum += extra;
    }
  });

  const myEstado = myVal ? (typeof myVal === 'object' ? myVal.estado : myVal) : null;
  const myExtra  = (cs && myVal && typeof myVal === 'object' && myVal[cs.key || 'plazasLibres']) ? Number(myVal[cs.key || 'plazasLibres']) : (cs ? cs.default : 3);

  const list = div('ref-opt-list');
  counts.forEach(item => {
    const isMine = myEstado === item.val;
    const row = div('ref-opt-row');
    row.innerHTML = `
      <div class="ref-opt-main">
        <div class="ref-opt-info">
          <span class="ref-opt-title">${esc(item.label)}</span>
          ${cs && item.val === cs.when ? `<span class="casa-precio">Oferta total: ${item.extraSum} plazas libres</span>` : ''}
        </div>
        <div class="ref-opt-actions">
          <button type="button" class="btn-ref-toggle ${isMine ? 'active' : ''}">${isMine ? '✓ Mi elección' : 'Cambiar aquí'}</button>
        </div>
      </div>
      <div class="ref-voters" style="margin-top:6px">
        ${item.users.map(u => `<span class="voter-chip">${esc(u.nombre)}${u.extra ? ` (+${u.extra} pl.)` : ''}</span>`).join('') || `<span style="color:var(--muted);font-size:0.75rem">Nadie aún</span>`}
      </div>
    `;

    row.querySelector('.btn-ref-toggle').addEventListener('click', () => {
      if (cs) {
        const payload = { estado: item.val };
        if (item.val === cs.when) payload[cs.key || 'plazasLibres'] = myExtra;
        patchSingleAnswer(q.id, payload);
      } else {
        patchSingleAnswer(q.id, item.val);
      }
    });

    list.appendChild(row);
  });

  card.appendChild(list);
}

function buildTextareaConsensus(card, q) {
  const notes = [];
  respuestas.forEach(r => {
    const v = extractAnswer(r.answers, q);
    if (v && String(v).trim()) notes.push({ nombre: r.nombre, texto: String(v).trim() });
  });

  if (!notes.length) {
    card.innerHTML += `<p style="color:var(--muted);font-size:0.85rem">Sin comentarios adicionales.</p>`;
    return;
  }

  const wrap = div('ref-notes-list');
  notes.forEach(n => {
    const item = div('ref-note-item');
    item.innerHTML = `<strong>${esc(n.nombre)}:</strong> <span>${esc(n.texto)}</span>`;
    wrap.appendChild(item);
  });
  card.appendChild(wrap);
}
// ── OPTIMIZADOR DE VENTANAS HORARIAS Y RESTRICCIONES (Comidas, Cine, Clases…) ──

function parseHHMM(str) {
  if (!str) return null;
  const [h, m] = String(str).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h + m / 60;
}

function fmtHourFloat(h) {
  const norm = h >= 24 ? h - 24 : h;
  const hh = String(Math.floor(norm)).padStart(2, '0');
  const mm = Math.round((norm - Math.floor(norm)) * 60) === 30 ? '30' : '00';
  return `${hh}:${mm}`;
}

const ICONO_MOTIVO = {
  clase:   '📚 Clase',
  trabajo: '💼 Trabajo',
  examen:  '📝 Examen',
  otro:    '⏳ Compromiso',
};

function buildHorariosConsensus(card, q, myVal) {
  const participantes = [];
  const fechasSet = new Set();
  const duraciones = [];

  respuestas.forEach(r => {
    const v = extractAnswer(r.answers, q);
    if (!v || !Array.isArray(v.disponibilidades)) return;
    if (v.duracionHoras) duraciones.push(Number(v.duracionHoras));

    const dispPorFecha = new Map();
    v.disponibilidades.forEach(d => {
      if (!d.fecha || !Array.isArray(d.franjas) || !d.franjas.length) return;
      fechasSet.add(d.fecha);
      const prev = dispPorFecha.get(d.fecha) || new Set();
      d.franjas.forEach(f => prev.add(f));
      dispPorFecha.set(d.fecha, prev);
    });

    if (dispPorFecha.size > 0) {
      participantes.push({
        nombre: r.nombre,
        p: getEffectiveProb(r.nombre),
        dispPorFecha,
        restricciones: Array.isArray(v.restricciones) ? v.restricciones : [],
      });
    }
  });

  if (!participantes.length || !fechasSet.size) {
    card.innerHTML += `<p style="color:var(--muted);font-size:0.85rem">Aún no hay disponibilidades horarias registradas.</p>`;
    return;
  }

  duraciones.sort((a, b) => a - b);
  const durIdeal = duraciones.length ? duraciones[Math.floor(duraciones.length / 2)] : (q.config?.duracionIdeal || 3);
  const fechasOrdenadas = [...fechasSet].sort();

  // Malla temporal: de 10:00 a 26:00 (02:00 AM) en pasos de 0.5h (32 slots)
  const SLOTS = [];
  for (let t = 10.0; t < 26.5; t += 0.5) SLOTS.push(t);
  const reqSlots = Math.max(2, Math.round(durIdeal * 2)); // nº de medias horas consecutivas

  const mejoresVentanas = [];

  fechasOrdenadas.forEach(fecha => {
    // Para cada participante, calcular qué slots de media hora tiene libres y qué restricciones le afectan hoy
    const estadoUsuarioDia = participantes.map(u => {
      const franjasHoy = u.dispPorFecha.get(fecha);
      if (!franjasHoy) return { ...u, freeSlots: new Set(), motivosHoy: [] };

      const restHoy = u.restricciones.filter(r => !r.fecha || r.fecha === fecha);
      const freeSlots = new Set();

      SLOTS.forEach(t => {
        // ¿Pertenece a alguna franja marcada por el usuario?
        const inFranja = FRANJAS_HORARIAS.some(f => franjasHoy.has(f.id) && t >= f.start && t < f.end);
        if (!inFranja) return;

        // ¿Choca con alguna restricción horaria?
        const choca = restHoy.some(r => {
          const rIni = parseHHMM(r.desde);
          let rFin   = parseHHMM(r.hasta);
          if (rIni == null || rFin == null) return false;
          if (rFin <= rIni) rFin += 24;
          return t >= rIni && t < rFin;
        });

        if (!choca) freeSlots.add(t);
      });

      return { ...u, freeSlots, restHoy };
    });

    // Evaluar cada ventana contigua de longitud `reqSlots` (durIdeal horas)
    for (let i = 0; i <= SLOTS.length - reqSlots; i++) {
      const winSlots = SLOTS.slice(i, i + reqSlots);
      const tStart = winSlots[0];
      const tEnd   = winSlots[winSlots.length - 1] + 0.5;

      const nucleo = [];
      const satelites = [];
      const bloqueados = [];

      estadoUsuarioDia.forEach(u => {
        const libresEnWin = winSlots.filter(t => u.freeSlots.has(t));
        if (libresEnWin.length === winSlots.length) {
          nucleo.push(u.nombre);
        } else if (libresEnWin.length >= Math.max(2, Math.floor(reqSlots / 2))) {
          // Satélite horario: puede al menos la mitad del plan (ej. se incorpora al salir de clase/trabajo)
          const tJoin  = libresEnWin[0];
          const tLeave = libresEnWin[libresEnWin.length - 1] + 0.5;
          const causa  = (u.restHoy && u.restHoy.length) ? (ICONO_MOTIVO[u.restHoy[0].motivo] || 'Restricción') : 'Franja parcial';
          const nota   = tJoin > tStart
            ? `se une a las ${fmtHourFloat(tJoin)} tras ${causa}`
            : `sale a las ${fmtHourFloat(tLeave)} por ${causa}`;
          satelites.push({ nombre: u.nombre, nota });
        } else {
          const causa = (u.restHoy && u.restHoy.length)
            ? `${ICONO_MOTIVO[u.restHoy[0].motivo]} (${u.restHoy[0].desde}–${u.restHoy[0].hasta})`
            : 'Sin disponibilidad';
          bloqueados.push({ nombre: u.nombre, causa });
        }
      });

      if (nucleo.length >= 1 && (nucleo.length + satelites.length) >= 2) {
        const score = nucleo.length * 10 + satelites.length * 4;
        mejoresVentanas.push({
          fecha,
          tStart,
          tEnd,
          nucleo,
          satelites,
          bloqueados,
          total: nucleo.length + satelites.length,
          score,
        });
      }
    }
  });

  mejoresVentanas.sort((a, b) => (b.score - a.score) || (b.nucleo.length - a.nucleo.length));

  // Filtrar ventanas solapadas en el mismo día y tramo para mostrar las 4 mejores alternativas
  const topWin = [];
  for (const w of mejoresVentanas) {
    const solapaMismoDia = topWin.some(tw => tw.fecha === w.fecha && Math.abs(tw.tStart - w.tStart) < 2.5);
    if (!solapaMismoDia) {
      topWin.push(w);
      if (topWin.length >= 4) break;
    }
  }

  // Recopilar todas las restricciones activas del grupo para hacerlas visibles
  const todasRestricciones = [];
  participantes.forEach(u => {
    u.restricciones.forEach(r => {
      todasRestricciones.push({ nombre: u.nombre, ...r });
    });
  });

  const wrap = div('ref-horarios-wrap');
  wrap.innerHTML = `
    <div style="font-size:0.83rem;color:var(--muted);margin-bottom:12px">
      Duración objetivo mediana: <b>${durIdeal} horas</b> · Evaluando compatibilidad horaria y bloqueos de clase/trabajo/exámenes:
    </div>

    <!-- 1. TOP VENTANAS HORARIAS FACTIBLES -->
    <div class="ref-windows-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-bottom:16px">
      ${topWin.length ? topWin.map((w, idx) => `
        <div class="sol-log-box" style="border-left:3px solid ${idx === 0 ? 'var(--accent2)' : 'var(--accent3)'}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <strong style="font-size:0.92rem">📅 ${fmtShortDate(w.fecha)} · ${fmtHourFloat(w.tStart)} →${fmtHourFloat(w.tEnd)}</strong>
            <span class="sol-badge ok">${w.total}/${participantes.length} asisten</span>
          </div>
          <div style="font-size:0.8rem;margin-bottom:4px">
            <b>Puntuales (${w.nucleo.length}):</b>${w.nucleo.map(esc).join(', ')}
          </div>
          ${w.satelites.length ? `
            <div style="font-size:0.78rem;color:var(--accent3);margin-bottom:4px">
              <b>Incorporación parcial (${w.satelites.length}):</b>
              ${w.satelites.map(s => `${esc(s.nombre)} <em>(${esc(s.nota)})</em>`).join(' · ')}
            </div>
          ` : ''}
          ${w.bloqueados.length ? `
            <div style="font-size:0.76rem;color:var(--accent)">
              <b>No pueden:</b> ${w.bloqueados.map(b => `${esc(b.nombre)} [${esc(b.causa)}]`).join(', ')}
            </div>
          ` : `<div style="font-size:0.76rem;color:var(--accent2)">✓ ¡Sin bajas horarias!</div>`}
        </div>
      `).join('') : `<div class="muted-note">No se encontraron tramos continuos de ${durIdeal}h para al menos 2 personas.</div>`}
    </div>

    <!-- 2. MATRIZ DE CALOR POR FRANJAS Y DÍAS -->
    <div style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase">
      Mapa de coincidencia por franja horaria
    </div>
    <div style="overflow-x:auto;margin-bottom:14px">
      <table class="compat-matrix-table">
        <thead>
          <tr>
            <th style="text-align:left">Fecha</th>
            ${FRANJAS_HORARIAS.map(f => `<th>${f.label}<br><small style="font-weight:400;color:var(--muted)">${f.sub}</small></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${fechasOrdenadas.map(fecha => `
            <tr>
              <th style="text-align:left">${fmtShortDate(fecha)}</th>${FRANJAS_HORARIAS.map(f => {
                const libres = participantes.filter(u => u.dispPorFecha.get(fecha)?.has(f.id));
                const alpha = (libres.length / Math.max(1, participantes.length)) * 0.55;
                return `
                  <td style="background:rgba(58,107,74,${alpha.toFixed(2)})" title="${libres.map(u => u.nombre).join(', ') || 'Nadie'}">
                    <b>${libres.length}/${participantes.length}</b>
                    <div style="font-size:0.68rem;color:var(--ink)">${libres.map(u => esc(u.nombre.slice(0, 6))).join(', ')}</div>
                  </td>
                `;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- 3. LISTADO DE RESTRICCIONES HORARIAS ACTIVAS DEL GRUPO -->
    ${todasRestricciones.length ? `
      <div style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase">
        Restricciones declaradas (Clases, Trabajo, Exámenes)
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${todasRestricciones.map(r => `
          <span class="voter-chip ${r.meUnoAlSalir ? '' : 'veto'}">
            ${ICONO_MOTIVO[r.motivo] || '⏳'} <b>${esc(r.nombre)}</b>:
            ${r.fecha ? fmtShortDate(r.fecha) + ' ' : 'Todos los días '}
            ${esc(r.desde)}–${esc(r.hasta)}
            ${r.meUnoAlSalir ? ' (⚡ se une al salir)' : ' (bloqueo total)'}
          </span>
        `).join('')}
      </div>
    ` : ''}
  `;

  card.appendChild(wrap);
}