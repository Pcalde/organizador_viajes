import pandas as pd
import numpy as np
import json
import re
import itertools
import random
import plotly.express as px
import plotly.graph_objects as go
from scipy.optimize import milp, LinearConstraint
from scipy.optimize import Bounds

C_VERDE = '\033[92m'
C_ROJO = '\033[91m'
C_CYAN = '\033[96m'
C_AMARILLO = '\033[93m'
C_MAGENTA = '\033[95m'
C_NEGRITA = '\033[1m'
C_RESET = '\033[0m'

# 1. Extracción
SHEET_ID = '1DVK9auOmMjKFco7cqcHIPYJYARoxPY47s_QS_2XD7XQ'
URL_CSV = f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv'

try:
    df = pd.read_csv(URL_CSV)
except Exception as e:
    raise RuntimeError(f"Fallo de I/O en la extracción tabular: {e}")

# 2. Sanitización General Vectorizada (Schema Mapping)
# Proyección estricta de tipos según el contrato del payload de Google Apps Script
df['diasMax'] = pd.to_numeric(df.get('diasMax'), errors='coerce').fillna(3).astype(int)
df['precioMaxPP'] = pd.to_numeric(df.get('precioMaxPP'), errors='coerce')
df['plazasLibres'] = pd.to_numeric(df.get('plazasLibres'), errors='coerce').fillna(0).astype(int)
df['transporte'] = df.get('transporte', '').astype(str).str.strip().str.lower()

# Mapeo booleano vectorial
for col in ['soloFinde', 'meDaIgual', 'puente']:
    if col in df.columns:
        df[col] = df[col].astype(str).str.strip().str.lower() == 'sí'

_re_precio = re.compile(r'(\d+(?:[.,]\d+)?)\s*€')

def generar_trayectorias_optimas(dias_disponibles, d_max, dias_rango):
    """Genera jerarquía de sub-intervalos acotados mediante partición en clases de equivalencia conexas."""
    # 1. Proyección al espacio de fechas ordenado y único
    dias_ordenados = sorted(set([d if not hasattr(d, 'date') else d.date() for d in dias_disponibles]))
    if not dias_ordenados: return []

    # 2. Partición topológica en bloques conexos
    bloques = []
    bloque_actual = [dias_ordenados[0]]
    for i in range(1, len(dias_ordenados)):
        if (dias_ordenados[i] - dias_ordenados[i-1]).days == 1:
            bloque_actual.append(dias_ordenados[i])
        else:
            bloques.append(bloque_actual)
            bloque_actual = [dias_ordenados[i]]
    bloques.append(bloque_actual)

    # 3. Extracción por segmentación de índices puros
    todas = []
    for b in bloques:
        N_b = len(b)
        for L in range(min(N_b, d_max), 1, -1):
            for i in range(N_b - L + 1):
                # Uso de tuplas para garantizar inyectividad en el hashing posterior
                todas.append(tuple(b[i : i + L])) 

    if not todas:
        return [[dias_ordenados[0]]]

    # 4. Ordenamiento lexicográfico
    dias_rango_set = set(dias_rango)
    todas.sort(key=lambda t: (
        len(dias_rango_set.intersection(t)),
        len(t),
        sum(1 for d in t if d.weekday() in [5, 6])
    ), reverse=True)

    # 5. Reducción O(N) a subespacio único preservando el orden
    return list(dict.fromkeys(todas))

def parsear_casas_estricto(raw_str):
    if pd.isna(raw_str) or not str(raw_str).strip(): return []
    casas_parsed = []
    # El GAS une las opciones con ' | ' garantizando este delimitador
    for parte in str(raw_str).split('|'):
        parte = parte.strip()
        if not parte: continue
        m = _re_precio.search(parte)
        if m:
            nombre = re.sub(r'\s*\(?\d+(?:[.,]\d+)?\s*€\)?$', '', parte).strip()
            casas_parsed.append({'nombre': nombre, 'precio_num': float(m.group(1).replace(',', '.'))})
    return casas_parsed

df['casas_parsed'] = df.get('casas').apply(parsear_casas_estricto)

def parsear_fechas_estricto(json_str):
    if pd.isna(json_str) or not str(json_str).strip(): return set()
    try:
        # El GAS serializa nativamente JSON RFC 8259, no requiere reemplazos de caracteres
        rangos = json.loads(str(json_str))
        dias = set()
        for r in rangos:
            if isinstance(r, dict) and r.get('desde') and r.get('hasta'):
                dias.update(pd.date_range(start=r['desde'], end=r['hasta']).date)
        return dias
    except json.JSONDecodeError:
        return set()

df['conjunto_fechas'] = df.get('rangosFechas').apply(parsear_fechas_estricto)

# Filtrado topológico: purga de usuarios sin proyección temporal válida antes de operar
df = df[df['conjunto_fechas'].apply(len) > 0].reset_index(drop=True)

todas_las_fechas = set().union(*df['conjunto_fechas'])
if not todas_las_fechas: raise ValueError("Espacio temporal nulo.")

# 3. Matriz de disponibilidad UNIFICADA (Sin barreras de findes)
indice_fechas = pd.date_range(start=min(todas_las_fechas), end=max(todas_las_fechas))
A = pd.DataFrame(
    {row['nombre']: [d.date() in row['conjunto_fechas'] for d in indice_fechas] for _, row in df.iterrows()},
    index=indice_fechas
).astype(int)

# Corrección del espacio de búsqueda: El límite es el máximo absoluto, no la media.
L_max_absoluto = df['diasMax'].max()
L_max_eval = max(2, int(L_max_absoluto) if pd.notna(L_max_absoluto) else 3)

# 4. Construcción Logística y Optimización de Flota (Consolidación Simultánea)
def construir_flujo_transporte(df_grupo, dict_asignacion):
    idas_coches, vueltas_coches = {}, {}
    idas_pax, vueltas_pax = {}, {}
    conductores_obj = []
    fechas_totales_activas = set()
    
    # 1. Mapeo de subespacios iniciales
    for _, row in df_grupo.iterrows():
        nombre = row['nombre']
        dias = sorted(dict_asignacion.get(nombre, []))
        if not dias: continue
        fechas_totales_activas.update(dias)
        
        t_in, t_out = dias[0], dias[-1]
        estado = str(row.get('transporte', '')).strip().lower()
        plazas = int(float(row.get('plazasLibres', 0))) if pd.notna(row.get('plazasLibres')) and str(row.get('plazasLibres', 0)).strip() != '' else 0
        
        if estado == 'propio': continue
        
        for d_dict, d_val in [(idas_pax, t_in), (vueltas_pax, t_out)]:
            if d_val not in d_dict: d_dict[d_val] = []
        for d_dict, d_val in [(idas_coches, t_in), (vueltas_coches, t_out)]:
            if d_val not in d_dict: d_dict[d_val] = []
            
        if estado == 'llevo-coche':
            c_obj = {'nombre': nombre, 'plazas': plazas, 't_in': t_in, 't_out': t_out, 'aparcado': False}
            conductores_obj.append(c_obj)
            idas_coches[t_in].append(c_obj)
            vueltas_coches[t_out].append(c_obj)
        else:
            idas_pax[t_in].append(nombre)
            vueltas_pax[t_out].append(nombre)

    # 2. Validación de Absorción Biyectiva
    # Un coche solo se aparca si la red lo soporta en t_in y t_out simultáneamente.
    conductores_obj.sort(key=lambda x: x['plazas'])
    for c in conductores_obj:
        t_in, t_out = c['t_in'], c['t_out']
        
        plazas_in = sum(x['plazas'] for x in idas_coches[t_in] if not x['aparcado'])
        pax_in = len(idas_pax.get(t_in, [])) + sum(1 for x in idas_coches[t_in] if x['aparcado'])
        slack_in = plazas_in - pax_in
        
        plazas_out = sum(x['plazas'] for x in vueltas_coches[t_out] if not x['aparcado'])
        pax_out = len(vueltas_pax.get(t_out, [])) + sum(1 for x in vueltas_coches[t_out] if x['aparcado'])
        slack_out = plazas_out - pax_out
        
        coste = c['plazas'] + 1
        if slack_in >= coste and slack_out >= coste:
            c['aparcado'] = True

    # 3. Ensamblaje de flujos
    flujo_estructurado = {'idas': [], 'vueltas': [], 'rango_activo': None}
    
    for is_ida, dict_coches, dict_pax, clave_flujo in [(True, idas_coches, idas_pax, 'idas'), (False, vueltas_coches, vueltas_pax, 'vueltas')]:
        for d in sorted(dict_coches.keys() | dict_pax.keys()):
            activos = [c for c in dict_coches.get(d, []) if not c['aparcado']]
            activos.sort(key=lambda x: x['plazas'], reverse=True)
            paxs = list(dict_pax.get(d, [])) + [c['nombre'] for c in dict_coches.get(d, []) if c['aparcado']]
            
            estado_c = [{'nombre': c['nombre'], 'plazas': c['plazas'], 'asignados': []} for c in activos]
            
            # Asignación por máxima capacidad residual dinámica con Validación Estricta
            while paxs:
                coche_optimo = max(estado_c, key=lambda x: x['plazas'])
                if coche_optimo['plazas'] <= 0:
                    # El MILP falló en predecir la asimetría temporal de la flota. 
                    # Se aborta la topología para evitar abandonar pasajeros en silencio.
                    return False, {"error": f"Inviable: Asimetría logística el {d.strftime('%d/%m')}. Faltan plazas."}
                
                coche_optimo['asignados'].append(paxs.pop(0))
                coche_optimo['plazas'] -= 1
            for c in estado_c:
                flujo_estructurado[clave_flujo].append({'fecha': d, 'conductor': c['nombre'], 'pasajeros': c['asignados']})

    if fechas_totales_activas:
        flujo_estructurado['rango_activo'] = (min(fechas_totales_activas), max(fechas_totales_activas))

    return True, flujo_estructurado

 

def formatear_logistica_ansi(flujo):
    """Proyecta el estado logístico al espacio de representación de la terminal (ANSI)."""
    if "error" in flujo:
        return flujo["error"]
        
    res_ida = [f"{C_CYAN}[Ida {d['fecha'].strftime('%d/%m')}]{C_RESET} {d['conductor']} lleva a: {', '.join(d['pasajeros']) or 'vacío'}" for d in flujo['idas']]
    res_vuelta = [f"{C_AMARILLO}[Vuelta {d['fecha'].strftime('%d/%m')}]{C_RESET} {d['conductor']} vuelve con: {', '.join(d['pasajeros']) or 'vacío'}" for d in flujo['vueltas']]
    
    asignaciones = "\n        ".join(res_ida) + "\n        " + "\n        ".join(res_vuelta)
    
    if flujo.get('rango_activo'):
        f_ini, f_fin = flujo['rango_activo'][0].strftime('%d/%m'), flujo['rango_activo'][1].strftime('%d/%m')
        asignaciones = f"{C_MAGENTA}Macro-Rango Activo [{f_ini} ➝ {f_fin}]{C_RESET}\n        " + asignaciones
        
    return asignaciones

def simular_fragilidad(dict_asignacion, df_viajeros, n_sim=400, p_global=0.12):
    """
    Análisis de resiliencia del plan logístico mediante simulación.
    
    - impacto_individual: elimina una persona y comprueba si el flujo sigue viable (determinista).
    - viabilidad_global: fracción de n_sim escenarios aleatorios (cada persona falta con p=p_global) que siguen siendo viables.
    - impacto_cadena: cuánto cae la viabilidad_global cuando esa persona falta SIEMPRE (100 sims por persona).
    """
    personas = list(dict_asignacion.keys())
    if not personas:
        return None

    # 1. Impacto individual determinista
    impacto_individual = {}
    for persona in personas:
        dict_sin = {k: v for k, v in dict_asignacion.items() if k != persona}
        df_sin   = df_viajeros[df_viajeros['nombre'] != persona].copy()
        if not dict_sin:
            impacto_individual[persona] = 1.0
            continue
        viable, _ = construir_flujo_transporte(df_sin, dict_sin)
        impacto_individual[persona] = 0.0 if viable else 1.0

    # 2. Monte Carlo global (escenarios con ausencias aleatorias)
    n_viable_global = 0
    for _ in range(n_sim):
        ausentes   = {p for p in personas if random.random() < p_global}
        dict_sim   = {k: v for k, v in dict_asignacion.items() if k not in ausentes}
        df_sim     = df_viajeros[~df_viajeros['nombre'].isin(ausentes)].copy()
        if not dict_sim:
            continue
        viable, _ = construir_flujo_transporte(df_sim, dict_sim)
        if viable:
            n_viable_global += 1
    viabilidad_global = n_viable_global / n_sim if n_sim > 0 else 0.0

    # 3. Impacto en cadena: cuánto cae la viabilidad global si esa persona siempre falta
    N_CADENA = 120
    impacto_cadena = {}
    for persona in personas:
        n_via = 0
        for _ in range(N_CADENA):
            ausentes = {persona} | {p for p in personas if p != persona and random.random() < p_global}
            dict_sim = {k: v for k, v in dict_asignacion.items() if k not in ausentes}
            df_sim   = df_viajeros[~df_viajeros['nombre'].isin(ausentes)].copy()
            if not dict_sim:
                continue
            viable, _ = construir_flujo_transporte(df_sim, dict_sim)
            if viable:
                n_via += 1
        impacto_cadena[persona] = max(0.0, viabilidad_global - n_via / N_CADENA)

    return {
        'impacto_individual': impacto_individual,
        'viabilidad_global':  viabilidad_global,
        'impacto_cadena':     impacto_cadena,
        'n_sim':              n_sim,
        'p_global':           p_global,
    }


# 5. Maximización
resultados = []

for L_ventana in range(2, L_max_eval + 1):
    consec = A.rolling(window=L_ventana, min_periods=L_ventana).sum() == L_ventana
    N_vector = consec.sum(axis=1)
    fechas_validas = N_vector[N_vector >= 2] # Al menos 2 personas definen el núcleo del viaje

    for fecha_fin, N_W in fechas_validas.items():
        fecha_inicio = fecha_fin - pd.Timedelta(days=L_ventana - 1)
        dias_rango = pd.date_range(start=fecha_inicio, end=fecha_fin).date
        
        nombres_plenos = consec.loc[fecha_fin][consec.loc[fecha_fin]].index.tolist()
        df_W = df[df['nombre'].isin(nombres_plenos)].copy()

        # Detección dinámica de satélites mediante álgebra matricial
        # 1. Proyección del subespacio temporal W sobre la matriz de diseño A
        A_W = A.loc[fecha_inicio:fecha_fin]
        
        # 2. Suma marginal sobre el eje temporal (norma L1 de disponibilidad por usuario en la ventana)
        disp_ventana = A_W.sum(axis=0)
        
        # 3. Filtrado lógico vectorizado: V >= 2 días y exclusión del núcleo pleno
        cond_satelite = (disp_ventana >= 2) & (~disp_ventana.index.isin(nombres_plenos))
        nombres_satelites = disp_ventana[cond_satelite].index
        
        df_satelites = df[df['nombre'].isin(nombres_satelites)]
        
        # Retrocompatibilidad de la variable list para el formateo inferior
        satelites_rows = [row for _, row in df_satelites.iterrows()] 
        
        df_viajeros = pd.concat([df_W, df_satelites], ignore_index=True) if not df_satelites.empty else df_W.copy()
        
        N_convoy = len(df_satelites)
        N_total  = len(df_viajeros)
        
        df_viajeros['precioMaxPP'] = pd.to_numeric(df_viajeros['precioMaxPP'], errors='coerce')
        p_max_global = df_viajeros['precioMaxPP'].min()

        dict_dias_max = df_viajeros.set_index('nombre')['diasMax'].to_dict()
        espacio_estados = {}
        for _, row in df_viajeros.iterrows():
            nombre = row['nombre']
            d_max_raw = dict_dias_max.get(nombre)
            d_max_personal = int(d_max_raw) if pd.notna(d_max_raw) else L_ventana
            
            # Inyección del núcleo (dias_rango) para forzar cohesión magnética
            trayectorias = generar_trayectorias_optimas(row['conjunto_fechas'], d_max_personal, dias_rango)
            
            # Poda topológica: exige tocar el núcleo al menos 1 día
            trayectorias = [t for t in trayectorias if set(t).intersection(dias_rango)]
            if not trayectorias: 
                trayectorias = [list(set(dias_rango).intersection(row['conjunto_fechas']))]
                
            espacio_estados[nombre] = trayectorias # Acotado a las 4 mejores para evitar explosión de RAM

        nombres_comb = list(espacio_estados.keys())
        
        # 1. Aplanamiento topológico (Variables de decisión x_v)
        # Cada índice de 'variables' representa una dupla única (usuario, trayectoria)
        variables = []
        for n in nombres_comb:
            for t in espacio_estados[n]:
                variables.append({'nombre': n, 'traj': t, 't_in': t[0], 't_out': t[-1]})
        
        N_vars = len(variables)
        flujos_viables_data = []
        
        if N_vars > 0:
            # 2. Vector de costes c (Densidad poblacional y umbral de quórum)
            pesos_dias = {}
            N_mitad = len(df_viajeros) / 2
            nombres_validos = [n for n in df_viajeros['nombre'] if n in A.columns]
            disp_total = A[nombres_validos].sum(axis=1)
            
            dias_rango_set = set(dias_rango)
            for d in indice_fechas:
                d_date = d.date()
                if d_date in dias_rango_set:
                    pesos_dias[d_date] = 100  # Núcleo: máxima prioridad
                else:
                    quorum = disp_total.get(d, 0)
                    if quorum >= N_mitad:
                        pesos_dias[d_date] = 10   # Quórum mayoritario: incentivo de expansión
                    else:
                        pesos_dias[d_date] = -50  # Minoría: fuerte penalización a la fragmentación
                        
            c = np.array([-sum(pesos_dias.get(d, 0) for d in v['traj']) for v in variables])
            
            # 3. Matriz A_eq: Restricciones de unicidad (1 trayectoria por persona)
            A_eq = np.zeros((len(nombres_comb), N_vars))
            b_eq = np.ones(len(nombres_comb))
            for i, nombre in enumerate(nombres_comb):
                for j, v in enumerate(variables):
                    if v['nombre'] == nombre:
                        A_eq[i, j] = 1
                        
            # 4. Extracción de escalares de capacidad (C_i) por usuario
            C_dict = {}
            for _, row in df_viajeros.iterrows():
                estado = row.get('transporte', '')
                plazas = row.get('plazasLibres', 0)
                
                # Consumo: Pasajeros suman 1, Conductores restan sus plazas, Independientes suman 0
                if estado == 'propio':        C_dict[row['nombre']] = 0
                elif estado == 'llevo-coche': C_dict[row['nombre']] = -plazas
                else:                         C_dict[row['nombre']] = 1

            fechas_ida = set(v['t_in'] for v in variables)
            fechas_vuelta = set(v['t_out'] for v in variables)
            
            A_ub = []
            
            # 5. Matriz A_ub: Restricciones de capacidad para Idas
            for d in fechas_ida:
                fila = np.zeros(N_vars)
                activa = False
                for j, v in enumerate(variables):
                    if v['t_in'] == d and C_dict[v['nombre']] != 0:
                        fila[j] = C_dict[v['nombre']]
                        activa = True
                if activa: A_ub.append(fila)
                    
            # 6. Matriz A_ub: Restricciones de capacidad para Vueltas
            for d in fechas_vuelta:
                fila = np.zeros(N_vars)
                activa = False
                for j, v in enumerate(variables):
                    if v['t_out'] == d and C_dict[v['nombre']] != 0:
                        fila[j] = C_dict[v['nombre']]
                        activa = True
                if activa: A_ub.append(fila)
            
            # 7. Ensamblaje del sistema de inecuaciones para SciPy
            A_mat = np.vstack([A_eq] + (A_ub if A_ub else []))
            
            # RELAJACIÓN TOPOLÓGICA: 0 <= sum_traj_persona <= 1 (puede no asignarse)
            # Holgura mínima de transporte: exige al menos 1 plaza libre por fecha (robustez ante bajas)
            # Restricción estándar de capacidad: Suma de (pasajeros - plazas) <= 0
            ub_estandar = np.concatenate([np.ones(len(nombres_comb)), np.zeros(len(A_ub))])
            lb = np.concatenate([np.zeros(len(nombres_comb)), np.full(len(A_ub), -np.inf)])
            
            # Ejecución limpia del solver
            res = milp(c=c, integrality=1, bounds=Bounds(0, 1), 
                       constraints=LinearConstraint(A_mat, lb, ub_estandar))
            
            
            
            
            if res.success:
                # 9. Proyección del vector óptimo al diccionario de asignación original
                x_opt = np.round(res.x).astype(int)
                dict_asignacion = {variables[j]['nombre']: variables[j]['traj'] 
                                   for j, elegido in enumerate(x_opt) if elegido == 1}
                
                if dict_asignacion:
                    # Construcción del flujo y guardado estricto en memoria
                    es_viable, res_flujo = construir_flujo_transporte(df_viajeros, dict_asignacion)
                    score_utilidad = sum(len(t) for t in dict_asignacion.values())
                    flujos_viables_data.append((score_utilidad, res_flujo, dict_asignacion))


        # Modificación en el almacenamiento del resultado óptimo
        fragilidad_data = None
        if not flujos_viables_data:
            # Estado absorbente vacío
            logistica_integral_ansi = f"{C_ROJO}Inviable: Ninguna combinación permite el transporte cruzado.{C_RESET}"
            logistica_raw = None
        else:
            flujos_viables_data.sort(key=lambda x: x[0], reverse=True)
            mejor_score, mejor_logistica_raw, mejor_dict_asig = flujos_viables_data[0]
            
            logistica_integral_ansi = f"\n        {formatear_logistica_ansi(mejor_logistica_raw)}"
            if len(flujos_viables_data) > 1:
                logistica_integral_ansi += f"\n        {C_VERDE}(+ {len(flujos_viables_data)-1} configuraciones evaluadas){C_RESET}"
            logistica_raw = mejor_logistica_raw

            # Monte Carlo de resiliencia sobre la solución óptima
            fragilidad_data = simular_fragilidad(mejor_dict_asig, df_viajeros)

        str_opcion = "Indeterminado"
        # Evaluación atómica de votos sobre toda la coalición logística (Núcleo + Satélites)
        if 'opciones' in df_viajeros.columns:
            opc = df_viajeros['opciones'].dropna().astype(str).str.split(r'\s*\|\s*').explode().str.strip()
            opc = opc[opc != '']
            if not opc.empty:
                freq = opc.value_counts()
                modas = freq[freq == freq.max()].index.tolist()
                str_opcion = f"{' / '.join(modas)} ({freq.max()} votos)"

        casas_votos: dict = {}
        for _, row in df_viajeros.iterrows():
            for casa in row.get('casas_parsed', []):
                key = (casa['nombre'], casa['precio_num'])
                casas_votos[key] = casas_votos.get(key, 0) + 1

        str_votos_casas = "Ninguna casa votada cumple el presupuesto cooperativo límite."
        str_casa_optima = "Vacío factible."
        if casas_votos:
            viables = []
            for (nombre_casa, precio_total), votos in casas_votos.items():
                precio_cooperativo = precio_total / N_total
                precio_coalicion = precio_total / votos if votos > 0 else float('inf')
                
                if pd.notna(p_max_global) and precio_cooperativo <= p_max_global:
                    viables.append({
                        'nombre': nombre_casa, 'p_coop': precio_cooperativo, 
                        'p_coal': precio_coalicion, 'votos': votos
                    })
            
            if viables:
                max_v = max(c['votos'] for c in viables)
                optimas = [c for c in viables if c['votos'] == max_v]
                
                str_votos_casas = " \n ".join(
                    f"  {C_VERDE}•{C_RESET} {c['nombre']} ({c['votos']} votos)\n"
                    f"      ↳ Eq: {c['p_coop']:.1f}€ | Subvencionado: {C_AMARILLO}{c['p_coal']:.1f}€{C_RESET}" 
                    for c in viables
                )
                str_casa_optima = " | ".join(
                    f"{c['nombre']} [Eq: {c['p_coop']:.1f}€ | Subv: {c['p_coal']:.1f}€] ({c['votos']}v)" 
                    for c in optimas
                )

        dias_semana = [d.weekday() for d in dias_rango]
        tag_finde = " (Incluye Fin de Semana)" if any(d in [5, 6] for d in dias_semana) else " (Solo entre semana)"

        resultados.append({
            'L':              L_ventana,
            'Intervalo':      f"{fecha_inicio.strftime('%d/%m/%Y')} - {fecha_fin.strftime('%d/%m/%Y')} {tag_finde}",
            'N':              N_total,
            'N_full':         int(N_W),
            'N_convoy':       N_convoy,
            'Asistentes':     ", ".join(nombres_plenos),
            'Convoy':         ", ".join(r['nombre'] for r in satelites_rows) if satelites_rows else None,
            'opcion_votada':  str_opcion,
            'P_max_grupo':    p_max_global,
            'Casas_factibles': str_votos_casas,
            'Casa_optima':    str_casa_optima,
            'Logistica_ANSI': logistica_integral_ansi, # Para el print() final del script
            'Logistica_Data': logistica_raw,           # Objeto puro para exportar a HTML/JSON
            'Fragilidad':     fragilidad_data,         # Datos de resiliencia Monte Carlo
        })



def generar_reporte_html(df_optimos, matriz_disponibilidad, df_original):
    """Genera informe HTML completo: soluciones, logística, alojamiento, disponibilidad y sensibilidad."""
    import re as _re

    def strip_ansi(s):
        return _re.sub(r'\033\[[0-9;]*m', '', str(s))

    def render_logistica(logistica_data):
        if not logistica_data:
            return '<p class="inviable">⚠ Logística inviable o no calculada.</p>'

        def tabla_viajes(viajes, tipo):
            color = '#4fc3f7' if tipo == 'ida' else '#81c784'
            icon  = '↗' if tipo == 'ida' else '↙'
            rows  = ''
            for v in viajes:
                fecha = v['fecha'].strftime('%d/%m') if hasattr(v['fecha'], 'strftime') else str(v['fecha'])
                paxs  = ', '.join(v['pasajeros']) if v['pasajeros'] else '<em style="opacity:.5">solo</em>'
                rows += f'<tr><td class="t-fecha">{fecha}</td><td class="t-cond">{v["conductor"]}</td><td>{paxs}</td></tr>'
            return f'''
            <div class="log-bloque">
                <div class="log-titulo" style="color:{color}">{icon} {"Idas" if tipo=="ida" else "Vueltas"}</div>
                <table class="log-table">
                    <thead><tr><th>Fecha</th><th>Conductor</th><th>Pasajeros</th></tr></thead>
                    <tbody>{rows}</tbody>
                </table>
            </div>'''

        html  = '<div class="log-grid">'
        if logistica_data.get('idas'):   html += tabla_viajes(logistica_data['idas'],   'ida')
        if logistica_data.get('vueltas'): html += tabla_viajes(logistica_data['vueltas'], 'vuelta')
        html += '</div>'

        if logistica_data.get('rango_activo'):
            f0, f1 = logistica_data['rango_activo']
            fs = lambda d: d.strftime('%d/%m') if hasattr(d,'strftime') else str(d)
            html = f'<div class="rango-activo">Rango activo: {fs(f0)} → {fs(f1)}</div>' + html
        return html

    def render_casas(sol, df_orig):
        nombres = set(sol['Asistentes'].split(', '))
        if pd.notna(sol['Convoy']):
            nombres |= set(sol['Convoy'].split(', '))
        df_v = df_orig[df_orig['nombre'].isin(nombres)]
        N_total  = len(nombres)
        p_max    = sol.get('P_max_grupo')

        votos = {}
        for _, row in df_v.iterrows():
            for casa in row.get('casas_parsed', []):
                key = (casa['nombre'], casa['precio_num'])
                votos[key] = votos.get(key, 0) + 1

        if not votos:
            return '<p class="muted-text">Sin opciones de alojamiento votadas.</p>'

        items = []
        for (nombre_casa, precio_total), n_votos in sorted(votos.items(), key=lambda x: -x[1]):
            p_coop = precio_total / N_total if N_total > 0 else float('inf')
            p_coal = precio_total / n_votos if n_votos > 0 else float('inf')
            viable = pd.notna(p_max) and p_coop <= p_max
            items.append({'nombre': nombre_casa, 'precio_total': precio_total,
                          'p_coop': p_coop, 'p_coal': p_coal, 'votos': n_votos, 'viable': viable})

        max_votos = max(c['votos'] for c in items) or 1
        html = ''
        for c in items:
            pct    = int(c['votos'] / max_votos * 100)
            bcls   = 'badge-ok' if c['viable'] else 'badge-no'
            btxt   = '✓ Viable' if c['viable'] else '✗ Fuera de presupuesto'
            barcls = 'bar-ok'   if c['viable'] else 'bar-no'
            html  += f'''
            <div class="casa-row">
                <div class="casa-head">
                    <span class="casa-nombre">{c["nombre"]}</span>
                    <span class="badge {bcls}">{btxt}</span>
                </div>
                <div class="casa-meta">
                    <span>Total <strong>{c["precio_total"]:.0f}€</strong></span>
                    <span>Por persona <strong>{c["p_coop"]:.1f}€</strong></span>
                    <span>Solo votantes <strong>{c["p_coal"]:.1f}€</strong></span>
                    <span>🗳 {c["votos"]} voto{"s" if c["votos"]!=1 else ""}</span>
                </div>
                <div class="bar-bg"><div class="{barcls}" style="width:{pct}%"></div></div>
            </div>'''
        return html

    # ── Plotly charts ──────────────────────────────────────────────────────────
    _layout = dict(paper_bgcolor='rgba(0,0,0,0)', plot_bgcolor='rgba(0,0,0,0)',
                   font=dict(color='#c8c8d8', family='DM Sans, sans-serif'),
                   margin=dict(l=10, r=10, t=40, b=10))

    fig_heat = px.imshow(
        matriz_disponibilidad.T,
        labels=dict(x='Fecha', y='Asistente', color='Disponibilidad'),
        color_continuous_scale=[[0, '#0d1117'], [1, '#4fc3f7']],
        title='Disponibilidad por persona y fecha',
    )
    fig_heat.update_coloraxes(showscale=False)
    fig_heat.update_xaxes(tickformat='%d/%m', tickangle=45, gridcolor='#1e2330')
    fig_heat.update_yaxes(gridcolor='#1e2330')
    fig_heat.update_layout(**_layout)
    html_heat = fig_heat.to_html(full_html=False, include_plotlyjs='cdn')

    df_pp = df_original.dropna(subset=['precioMaxPP']).sort_values('precioMaxPP').copy()
    df_pp['precioMaxPP'] = pd.to_numeric(df_pp['precioMaxPP'], errors='coerce')
    fig_pp = px.bar(df_pp, x='nombre', y='precioMaxPP',
                    title='Presupuesto máximo por asistente',
                    labels={'precioMaxPP': '€/persona', 'nombre': ''},
                    color='precioMaxPP', color_continuous_scale='Blues')
    min_pp = df_pp['precioMaxPP'].min()
    fig_pp.add_hline(y=min_pp, line_dash='dot', line_color='#ff6b6b',
                     annotation_text=f'Restricción activa: {min_pp}€',
                     annotation_font_color='#ff6b6b')
    fig_pp.update_layout(**_layout, coloraxis_showscale=False)
    fig_pp.update_xaxes(gridcolor='#1e2330')
    fig_pp.update_yaxes(gridcolor='#1e2330')
    html_pp = fig_pp.to_html(full_html=False, include_plotlyjs='cdn')

    # 3. Matriz de Compatibilidad Cruzada (Álgebra matricial A^T * A)
    matriz_compat = matriz_disponibilidad.T.dot(matriz_disponibilidad)
    fig_comp = px.imshow(
        matriz_compat,
        labels=dict(color='Días compartidos'),
        color_continuous_scale=[[0, '#0d1117'], [1, '#9575cd']],
        title='Compatibilidad Temporal Cruzada (Intersección de días)'
    )
    fig_comp.update_xaxes(tickangle=45, gridcolor='#1e2330')
    fig_comp.update_yaxes(gridcolor='#1e2330')
    fig_comp.update_layout(**_layout)
    html_comp = fig_comp.to_html(full_html=False, include_plotlyjs='cdn')

    # 4. Serie Temporal de Presión Logística
    oferta_t, demanda_t = [], []
    for d in matriz_disponibilidad.index:
        disp_d = matriz_disponibilidad.loc[d]
        df_d = df_original[df_original['nombre'].isin(disp_d[disp_d == 1].index)]
        
        oferta, demanda = 0, 0
        for _, row in df_d.iterrows():
            est = str(row.get('transporte', '')).strip().lower()
            plazas = int(float(row.get('plazasLibres', 0))) if pd.notna(row.get('plazasLibres')) and str(row.get('plazasLibres', 0)).strip() != '' else 0
            if est == 'llevo-coche': oferta += plazas
            elif est != 'propio':    demanda += 1
                
        oferta_t.append(oferta)
        demanda_t.append(demanda)

    df_log_t = pd.DataFrame({'Fecha': matriz_disponibilidad.index, 'Oferta': oferta_t, 'Demanda': demanda_t})
    df_log_t['Holgura'] = df_log_t['Oferta'] - df_log_t['Demanda']

    fig_log = go.Figure()
    fig_log.add_trace(go.Bar(x=df_log_t['Fecha'], y=df_log_t['Oferta'], name='Plazas Ofertadas', marker_color='#81c784'))
    fig_log.add_trace(go.Bar(x=df_log_t['Fecha'], y=df_log_t['Demanda'], name='Pasajeros', marker_color='#ef5350'))
    fig_log.update_layout(barmode='group', title='Capacidad Logística Potencial por Fecha', **_layout)
    fig_log.update_xaxes(tickformat='%d/%m', gridcolor='#1e2330')
    fig_log.update_yaxes(gridcolor='#1e2330')
    html_log = fig_log.to_html(full_html=False, include_plotlyjs='cdn')

    # ── Sensibilidad Expandida ─────────────────────────────────────────────────
    df_original['precioMaxPP'] = pd.to_numeric(df_original['precioMaxPP'], errors='coerce')
    idx_eco  = df_original['precioMaxPP'].idxmin()
    nom_eco  = df_original.loc[idx_eco, 'nombre'] if pd.notna(idx_eco) else "Ninguno"
    val_eco  = df_original.loc[idx_eco, 'precioMaxPP'] if pd.notna(idx_eco) else 0

    card_fechas = df_original.set_index('nombre')['conjunto_fechas'].apply(len)
    nom_t    = card_fechas.idxmin() if not card_fechas.empty else "Ninguno"
    val_t    = card_fechas.min() if not card_fechas.empty else 0

    # Aislamiento topológico (Norma L1 de la matriz de compatibilidad excluyendo la traza)
    matriz_np = matriz_compat.to_numpy(copy=True)
    np.fill_diagonal(matriz_np, 0)
    
    # Suma marginal sobre el eje 1 proyectando el resultado al espacio de índices original
    aislamiento_series = pd.Series(matriz_np.sum(axis=1), index=matriz_compat.index)
    nom_aislado = aislamiento_series.idxmin() if not aislamiento_series.empty else "Ninguno"
    val_aislado = aislamiento_series.min() if not aislamiento_series.empty else 0

    # Cuello de botella logístico
    df_log_activo = df_log_t[df_log_t['Demanda'] > 0]
    if not df_log_activo.empty:
        idx_critico = df_log_activo['Holgura'].idxmin()
        dia_critico = df_log_activo.loc[idx_critico, 'Fecha'].strftime('%d/%m')
        val_holgura = df_log_activo.loc[idx_critico, 'Holgura']
    else:
        dia_critico, val_holgura = "N/A", 0

    # ── Fragility charts per solution ──────────────────────────────────────────
    def render_fragilidad(frag, sol_idx):
        if not frag:
            return '<p class="muted-text">Sin datos de simulación.</p>'

        via_pct = int(frag['viabilidad_global'] * 100)
        via_color = '#81c784' if via_pct >= 80 else ('#ffb74d' if via_pct >= 50 else '#ef5350')

        # Gráfico de impacto en cadena (cuánto cae la viabilidad si esa persona siempre falta)
        personas  = list(frag['impacto_cadena'].keys())
        impactos  = [round(frag['impacto_cadena'][p] * 100, 1) for p in personas]
        colores   = ['#ef5350' if frag['impacto_individual'].get(p, 0) == 1.0
                     else '#ffb74d' if i > 15 else '#81c784'
                     for p, i in zip(personas, impactos)]

        fig = go.Figure(go.Bar(
            x=impactos, y=personas, orientation='h',
            marker_color=colores,
            text=[f'{v:.1f}%' for v in impactos],
            textposition='outside',
            hovertemplate='<b>%{y}</b><br>Caída de viabilidad: %{x:.1f}%<extra></extra>'
        ))
        fig.update_layout(
            **_layout,
            title=f'Impacto en cadena por ausencia (base: {frag["n_sim"]} sims, p_falta={int(frag["p_global"]*100)}%)',
            xaxis=dict(title='Caída de viabilidad global (%)', range=[0, max(impactos or [10]) * 1.3],
                       gridcolor='#1e2330'),
            yaxis=dict(autorange='reversed', gridcolor='#1e2330'),
            height=max(200, len(personas) * 38 + 80),
            margin=dict(l=10, r=60, t=40, b=30),
        )
        html_fig = fig.to_html(full_html=False, include_plotlyjs='cdn')

        # Personas cuya ausencia rompe el plan inmediatamente
        criticos = [p for p, v in frag['impacto_individual'].items() if v == 1.0]
        criticos_html = (''.join(f'<span class="chip chip-x">{p}</span>' for p in sorted(criticos))
                         if criticos else '<span style="color:var(--green)">Ninguno crítico</span>')

        return f'''
        <div class="frag-header">
            <div>
                <div class="frag-via-label">Viabilidad global del plan</div>
                <div class="frag-via-val" style="color:{via_color}">{via_pct}%</div>
                <div class="frag-via-sub">{frag["n_sim"]} escenarios · p(falta)={int(frag["p_global"]*100)}%</div>
            </div>
            <div>
                <div class="frag-via-label">Imprescindibles (plan colapsa sin ellos)</div>
                <div class="chip-row" style="margin-top:6px">{criticos_html}</div>
            </div>
        </div>
        <div class="chart-wrap" style="margin-top:10px">{html_fig}</div>'''

    # ── Personas imprescindibles globales (agregado entre soluciones) ───────────
    def render_indispensables(df_opts):
        acum = {}
        n_sols = 0
        for _, sol in df_opts.iterrows():
            frag = sol.get('Fragilidad')
            if not frag:
                continue
            n_sols += 1
            for p, v in frag['impacto_cadena'].items():
                acum[p] = acum.get(p, 0.0) + v
            # Bonus si su ausencia rompe el plan individualmente
            for p, v in frag['impacto_individual'].items():
                if v == 1.0:
                    acum[p] = acum.get(p, 0.0) + 0.3  # penalización adicional

        if not acum or n_sols == 0:
            return '<p class="muted-text">No hay datos suficientes de simulación.</p>'

        ranking = sorted(acum.items(), key=lambda x: -x[1])
        personas_r = [r[0] for r in ranking]
        scores_r   = [round(r[1] / n_sols * 100, 1) for r in ranking]  # normalizado a %
        colores_r  = ['#ef5350' if s > 30 else '#ffb74d' if s > 10 else '#81c784' for s in scores_r]

        fig = go.Figure(go.Bar(
            x=scores_r, y=personas_r, orientation='h',
            marker_color=colores_r,
            text=[f'{v:.1f}' for v in scores_r],
            textposition='outside',
            hovertemplate='<b>%{y}</b><br>Índice de imprescindibilidad: %{x:.1f}<extra></extra>'
        ))
        fig.update_layout(
            **_layout,
            title='Índice de imprescindibilidad (agregado entre soluciones óptimas)',
            xaxis=dict(title='Índice (mayor = más imprescindible)', gridcolor='#1e2330'),
            yaxis=dict(autorange='reversed', gridcolor='#1e2330'),
            height=max(220, len(personas_r) * 38 + 80),
            margin=dict(l=10, r=60, t=40, b=30),
        )
        html_fig = fig.to_html(full_html=False, include_plotlyjs='cdn')

        # Tabla de texto de los top 3
        top3 = ranking[:3]
        top3_html = ''
        medallas = ['🥇', '🥈', '🥉']
        for i, (nombre, _) in enumerate(top3):
            sc = scores_r[i]
            top3_html += f'<div class="indis-row"><span class="indis-medal">{medallas[i]}</span><span class="indis-nom">{nombre}</span><span class="indis-sc" style="color:{colores_r[i]}">{sc:.1f}</span></div>'

        return f'''
        <div class="indis-top3">{top3_html}</div>
        <div class="chart-wrap" style="margin-top:14px">{html_fig}</div>'''

    # ── Solution cards ─────────────────────────────────────────────────────────
    nombres_totales = set(df_original['nombre'].dropna().unique())
    cards = ''
    for idx, sol in df_optimos.iterrows():
        asist  = set(sol['Asistentes'].split(', '))
        convoy = set(sol['Convoy'].split(', ')) if pd.notna(sol['Convoy']) else set()
        excl   = nombres_totales - asist - convoy

        def chips(names, cls):
            return ''.join(f'<span class="chip {cls}">{n}</span>' for n in sorted(names))

        excl_html = chips(excl, 'chip-x') if excl else '<span class="perf">✓ Asistencia perfecta</span>'
        p_str     = f'{sol["P_max_grupo"]:.0f}€' if pd.notna(sol.get('P_max_grupo')) else 'N/A'

        cards += f'''
        <div class="card" id="sol-{idx}">
            <div class="card-head">
                <div>
                    <div class="card-tag">Solución {idx+1}</div>
                    <div class="card-intervalo">{sol["Intervalo"]}</div>
                </div>
                <div class="pills">
                    <div class="pill"><span class="pill-k">Duración</span><span class="pill-v">{sol["L"]}d</span></div>
                    <div class="pill"><span class="pill-k">Núcleo</span><span class="pill-v">{sol["N_full"]}</span></div>
                    <div class="pill"><span class="pill-k">Satélites</span><span class="pill-v">{sol["N_convoy"]}</span></div>
                    <div class="pill"><span class="pill-k">Total</span><span class="pill-v">{sol["N"]}</span></div>
                    <div class="pill"><span class="pill-k">Presup.</span><span class="pill-v">{p_str}</span></div>
                </div>
            </div>
            <div class="card-body">

                <div class="sec">
                    <div class="sec-title">Asistentes</div>
                    <div class="group-label">Núcleo ({sol["N_full"]})</div>
                    <div class="chip-row">{chips(asist, "chip-n")}</div>
                    {f'<div class="group-label">Satélites ({sol["N_convoy"]})</div><div class="chip-row">{chips(convoy, "chip-s")}</div>' if convoy else ''}
                    <div class="group-label">Excluidos ({len(excl)})</div>
                    <div class="chip-row">{excl_html}</div>
                </div>

                <div class="divider"></div>

                <div class="sec">
                    <div class="sec-title">Logística de Transporte</div>
                    {render_logistica(sol.get('Logistica_Data'))}
                </div>

                <div class="divider"></div>

                <div class="sec">
                    <div class="sec-title">Alojamiento</div>
                    <div class="plan-row">Plan más votado: <strong>{strip_ansi(sol["opcion_votada"])}</strong></div>
                    {render_casas(sol, df_original)}
                </div>

                <div class="divider"></div>

                <div class="sec">
                    <div class="sec-title">Resiliencia del Plan · Monte Carlo</div>
                    {render_fragilidad(sol.get('Fragilidad'), idx)}
                </div>

            </div>
        </div>'''

    # ── CSS ────────────────────────────────────────────────────────────────────
    CSS = '''
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');

:root {
    --bg:      #0a0c12;
    --panel:   #0f1118;
    --card:    #141720;
    --card2:   #191d28;
    --border:  #1e2330;
    --border2: #252a3a;
    --accent:  #4fc3f7;
    --green:   #81c784;
    --warn:    #ffb74d;
    --danger:  #ef5350;
    --purple:  #9575cd;
    --text:    #dde1f0;
    --sub:     #7a7f9a;
    --mono:    'DM Mono', monospace;
    --r:       10px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif;
       font-size: 13.5px; line-height: 1.65; }
::selection { background: rgba(79,195,247,.25); }

.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }

/* Header */
.page-header { margin-bottom: 48px; }
.page-title { font-size: 2rem; font-weight: 700; letter-spacing: -.02em;
              background: linear-gradient(120deg, #4fc3f7, #9575cd);
              -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.page-sub { color: var(--sub); font-size: .9rem; margin-top: 4px; }

/* Section headers */
.sec-h { font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .12em;
         color: var(--sub); margin: 44px 0 14px; padding-bottom: 8px;
         border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.sec-h::before { content: ''; display: block; width: 3px; height: 14px;
                 background: var(--accent); border-radius: 2px; }

/* Cards */
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--r);
        margin-bottom: 20px; overflow: hidden;
        transition: border-color .2s; }
.card:hover { border-color: var(--border2); }
.card-head { background: var(--card2); padding: 18px 20px;
             border-bottom: 1px solid var(--border);
             display: flex; justify-content: space-between; align-items: flex-start;
             flex-wrap: wrap; gap: 12px; }
.card-tag { font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .1em;
            color: var(--accent); margin-bottom: 3px; }
.card-intervalo { font-size: 1.05rem; font-weight: 600; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { background: var(--bg); border: 1px solid var(--border2); border-radius: 20px;
        padding: 4px 12px; display: flex; gap: 6px; align-items: center; }
.pill-k { color: var(--sub); font-size: .72rem; }
.pill-v { font-weight: 600; font-size: .8rem; }
.card-body { padding: 20px; display: flex; flex-direction: column; gap: 0; }

/* Sections inside card */
.sec { padding: 12px 0; }
.sec-title { font-size: .8rem; font-weight: 700; text-transform: uppercase;
             letter-spacing: .08em; color: var(--purple); margin-bottom: 12px; }
.group-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em;
               color: var(--sub); margin: 8px 0 5px; }
.divider { height: 1px; background: var(--border); margin: 4px 0; }

/* Chips */
.chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { padding: 3px 10px; border-radius: 20px; font-size: .78rem; font-weight: 500; }
.chip-n { background: rgba(79,195,247,.12); color: var(--accent);   border: 1px solid rgba(79,195,247,.25); }
.chip-s { background: rgba(255,183,77,.12);  color: var(--warn);    border: 1px solid rgba(255,183,77,.25); }
.chip-x { background: rgba(239,83,80,.12);   color: var(--danger);  border: 1px solid rgba(239,83,80,.25); }
.perf   { color: var(--green); font-size: .82rem; }

/* Logistics */
.rango-activo { font-size: .78rem; color: var(--warn); font-family: var(--mono);
                margin-bottom: 10px; opacity: .85; }
.log-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width:640px) { .log-grid { grid-template-columns: 1fr; } }
.log-bloque { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.log-titulo { font-size: .78rem; font-weight: 700; text-transform: uppercase;
              letter-spacing: .08em; margin-bottom: 8px; }
.log-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
.log-table th { color: var(--sub); font-size: .7rem; text-transform: uppercase;
                letter-spacing: .08em; padding: 5px 8px;
                border-bottom: 1px solid var(--border); text-align: left; }
.log-table td { padding: 5px 8px; border-bottom: 1px solid rgba(30,35,48,.6); }
.log-table tr:last-child td { border-bottom: none; }
.t-fecha { font-family: var(--mono); font-weight: 500; color: var(--warn); white-space: nowrap; }
.t-cond  { color: var(--accent); font-weight: 500; }
.inviable { color: var(--danger); font-size: .82rem; padding: 8px 12px;
            background: rgba(239,83,80,.1); border-radius: 6px;
            border: 1px solid rgba(239,83,80,.2); }

/* Housing */
.plan-row { font-size: .82rem; color: var(--sub); margin-bottom: 10px;
            padding: 7px 12px; background: var(--bg);
            border-radius: 6px; border: 1px solid var(--border); }
.plan-row strong { color: var(--text); }
.casa-row { background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
            padding: 10px 12px; margin-bottom: 7px; }
.casa-head { display: flex; justify-content: space-between; align-items: center;
             flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.casa-nombre { font-weight: 600; font-size: .88rem; }
.badge { font-size: .68rem; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
.badge-ok { background: rgba(129,199,132,.12); color: var(--green); border: 1px solid rgba(129,199,132,.3); }
.badge-no { background: rgba(239,83,80,.1);    color: var(--danger); border: 1px solid rgba(239,83,80,.2); }
.casa-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: .78rem;
             color: var(--sub); margin-bottom: 7px; }
.casa-meta strong { color: var(--text); }
.bar-bg { height: 3px; background: var(--border); border-radius: 2px; }
.bar-ok { height: 3px; background: var(--green);  border-radius: 2px; }
.bar-no { height: 3px; background: var(--danger); border-radius: 2px; opacity: .5; }
.muted-text { color: var(--sub); font-size: .82rem; }

/* Sensitivity */
.sens-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 8px; }
.sens-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; }
.sens-k { font-size: .7rem; text-transform: uppercase; letter-spacing: .09em;
          color: var(--sub); margin-bottom: 5px; }
.sens-v { font-size: 1rem; font-weight: 700; color: var(--danger); }
.sens-d { font-size: .78rem; color: var(--sub); margin-top: 3px; }

/* Chart containers */
.chart-wrap { background: var(--panel); border: 1px solid var(--border);
              border-radius: var(--r); padding: 14px; margin-top: 8px; overflow: hidden; }

/* Fragility */
.frag-header { display: flex; gap: 32px; flex-wrap: wrap; align-items: flex-start;
               padding: 12px 0 4px; }
.frag-via-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em;
                  color: var(--sub); margin-bottom: 3px; }
.frag-via-val { font-size: 1.6rem; font-weight: 700; line-height: 1; }
.frag-via-sub { font-size: .72rem; color: var(--sub); margin-top: 4px; font-family: var(--mono); }

/* Indispensables */
.indis-top3 { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 2px; }
.indis-row  { background: var(--card2); border: 1px solid var(--border2); border-radius: 8px;
              padding: 10px 16px; display: flex; align-items: center; gap: 10px; min-width: 160px; }
.indis-medal { font-size: 1.2rem; }
.indis-nom  { font-weight: 600; flex: 1; }
.indis-sc   { font-family: var(--mono); font-size: .85rem; font-weight: 700; }
'''

    n_sol = len(df_optimos)
    n_max = int(df_optimos['N'].max()) if not df_optimos.empty else 0
    l_max = int(df_optimos['L'].max()) if not df_optimos.empty else 0

    html = f'''<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reporte del Viaje</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

  <div class="page-header">
    <div class="page-title">Reporte Viaje</div>
    <div class="page-sub">{n_sol} solución{"es" if n_sol!=1 else ""} óptima{"s" if n_sol!=1 else ""} &nbsp;·&nbsp; N={n_max} asistentes &nbsp;·&nbsp; L={l_max} días</div>
  </div>

  <div class="sec-h">Soluciones óptimas</div>
  {cards}

  <div class="sec-h">Personas Imprescindibles</div>
  {render_indispensables(df_optimos)}

  <div class="sec-h">Disponibilidad temporal</div>
  <div class="chart-wrap">{html_heat}</div>

  <div class="sec-h">Restricciones económicas</div>
  <div class="chart-wrap">{html_pp}</div>

  <div class="sec-h">Topología del Grupo</div>
  <div class="chart-wrap">{html_comp}</div>

  <div class="sec-h">Balance Logístico</div>
  <div class="chart-wrap">{html_log}</div>

  <div class="sec-h">Análisis de sensibilidad</div>
  <div class="sens-grid">
    <div class="sens-card">
      <div class="sens-k">Cuello de Botella Logístico</div>
      <div class="sens-v">{dia_critico}</div>
      <div class="sens-d">Holgura de plazas: {val_holgura} (Día más restrictivo)</div>
    </div>
    <div class="sens-card">
      <div class="sens-k">Aislamiento Topológico</div>
      <div class="sens-v">{nom_aislado}</div>
      <div class="sens-d">Menor compatibilidad cruzada ({val_aislado} inters. totales)</div>
    </div>
    <div class="sens-card">
      <div class="sens-k">Restricción Económica</div>
      <div class="sens-v">{nom_eco}</div>
      <div class="sens-d">Fija el límite grupal en {val_eco}€/persona</div>
    </div>
    <div class="sens-card">
      <div class="sens-k">Menor Disponibilidad Temporal</div>
      <div class="sens-v">{nom_t}</div>
      <div class="sens-d">{val_t} días absolutos disponibles</div>
    </div>
  </div>

</div>
</body>
</html>'''

    with open("reporte_optimizacion.html", "w", encoding="utf-8") as f:
        f.write(html)



# 6. Resolución
if not resultados:
    print("El sistema no converge a ninguna intersección continua viable (N≥2).")
else:
    df_global = pd.DataFrame(resultados)
    
    # 1º Prioridad absoluta: Maximizar la cohesión del núcleo (N_full)
    N_full_max = df_global['N_full'].max()
    subespacio_N_full = df_global[df_global['N_full'] == N_full_max]
    
    # 2º Prioridad: Atraer al máximo de satélites posibles al núcleo (N total)
    N_max = subespacio_N_full['N'].max()
    subespacio_N = subespacio_N_full[subespacio_N_full['N'] == N_max]
    
    # 3º Prioridad: Maximizar la duración del viaje (L)
    L_max = subespacio_N['L'].max()
    optimos = subespacio_N[subespacio_N['L'] == L_max].reset_index(drop=True)

    nombres_totales = set(df['nombre'].dropna().unique())

    print(f"{C_MAGENTA}{C_NEGRITA}{'*'*20}{C_RESET}")
    print(f"{C_MAGENTA}{C_NEGRITA}=== ÓPTIMO GLOBAL ==={C_RESET}")
    print(f"Maximización N (asistencia): {N_max}")
    print(f"Maximización L (duración)  : {L_max}")
    print(f"Soluciones degeneradas     : {len(optimos)}")
    print(f"{C_MAGENTA}{C_NEGRITA}{'*'*20}{C_RESET}\n")

    for idx, sol in optimos.iterrows():
        asistentes_set = set(sol['Asistentes'].split(', '))
        convoy_set     = set(sol['Convoy'].split(', ')) if pd.notna(sol['Convoy']) else set()
        excluidos      = nombres_totales - asistentes_set - convoy_set

        print(f"{C_AMARILLO}{C_NEGRITA}{'='*10} Solución degenerada {idx + 1} {'='*10}{C_RESET}")
        print(f"{C_CYAN}INTERVALO PROPUESTO{C_RESET}: {sol['Intervalo']}")
        print(f"{C_AMARILLO}{'-'*60}{C_RESET}")
        print(f"\n {C_CYAN}Asistentes núcleo{C_RESET} ({sol['N_full']}): {sol['Asistentes']}")
        
        if pd.notna(sol['Convoy']):
            print(f" {C_CYAN}Asistentes parciales{C_RESET} ({sol['N_convoy']}): {sol['Convoy']}")
            
        str_exc = ", ".join(excluidos) if excluidos else f"{C_VERDE}Ninguno (Asistencia perfecta){C_RESET}"
        if excluidos: str_exc = f"{C_ROJO}{str_exc}{C_RESET}"
        print(f" {C_ROJO}Excluidos{C_RESET} ({len(excluidos)}): {str_exc}")
        
        print(f"  {C_CYAN}Presupuesto máximo grupal{C_RESET}: {sol['P_max_grupo']}€")
        print(f"  {C_CYAN}Asignación Logística{C_RESET}: {sol['Logistica_ANSI']}\n")
        print(f"{C_AMARILLO}{'-'*60}{C_RESET}")
        print(f"  {C_CYAN}Casas factibles{C_RESET}: \n {sol['Casas_factibles']}\n")
        print(f"{C_AMARILLO}{'-'*20}{C_RESET} {C_CYAN}{C_NEGRITA}Planes más votados{C_RESET} {C_AMARILLO}{'-'*20}{C_RESET}")
        print(f"{C_CYAN}  Alojamiento factible más votado{C_RESET}: {sol['Casa_optima']}")
        print(f" {C_CYAN} Plan más votado{C_RESET}: {sol['opcion_votada']}")
        print(f"{C_AMARILLO}{'-'*60}{C_RESET}\n")

    # Análisis de sensibilidad
    print(f"{C_MAGENTA}{C_NEGRITA}=== ANÁLISIS DE SENSIBILIDAD ==={C_RESET}")
    df['precioMaxPP'] = pd.to_numeric(df['precioMaxPP'], errors='coerce')
    idx_min = df['precioMaxPP'].idxmin()
    print(f"► {C_CYAN}Restricción económica activa{C_RESET}: "
          f"{C_ROJO}{df.loc[idx_min, 'nombre']}{C_RESET} fija el límite en {df.loc[idx_min, 'precioMaxPP']}€.")

    cardinalidad_fechas = df.set_index('nombre')['conjunto_fechas'].apply(len)
    persona_lim_t = cardinalidad_fechas.idxmin()
    dias_min = cardinalidad_fechas.min()
    print(f"► {C_CYAN}Menor disponibilidad absoluta{C_RESET}: "
          f"{C_ROJO}'{persona_lim_t}'{C_RESET} posee el espacio temporal más reducido de la muestra ({dias_min} días totales).")
    generar_reporte_html(optimos, A, df)
    """print(f"\n{C_MAGENTA}{C_NEGRITA}=== MAPA DE CALOR DE DISPONIBILIDAD ==={C_RESET}")
    print(f"{C_MAGENTA}{'-'*50}{C_RESET}")
    A_visual = A.T.replace({1: '█', 0: '·'})
    A_visual.columns = [d.strftime('%d/%m') for d in A_visual.columns]
    print(A_visual.to_string())
    print(f"{C_MAGENTA}{'-'*50}{C_RESET}\n")"""