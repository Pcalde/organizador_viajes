# organizador_viajes

Encuestas para planificar y debatir viajes.

## Descripción

Este repositorio contiene dos piezas complementarias:

1. **Aplicación web** (`index.html` + `src/js/`): cuestionario colaborativo de viajes con
   sincronización en tiempo real (Supabase), optimizador de consenso embebido en el navegador,
   mapa de destinos (Leaflet) y sala de debate.
2. **Analizador por lotes** (`analizador_viaje.py`): script en Python que lee la hoja de cálculo
   generada por el formulario y produce un informe analítico en consola/HTML con el mismo motor
   de optimización.

## Modelo matemático del optimizador (LaTeX)

El núcleo de `reformulario.js` (y su port `analizador_viaje.py`) resuelve el problema de
planificación como un **programa lineal entero mixto (PLE)**. A continuación se detalla la
formalización.

### 1. Conjuntos e índices

Sea $V = \{v_1, \dots, v_n\}$ el conjunto de viajeros y $T = \{t_1, \dots, t_m\}$ el universo
de días evaluados (unión de todos los rangos de disponibilidad declarados). Para una ventana
candidata de duración $L$, denotamos $W = \{t_i, t_{i+1}, \dots, t_{i+L-1}\} \subseteq T$.

Cada viajero $v$ declara:

- un conjunto de fechas disponibles $D_v \subseteq T$ (unión de intervalos $[\,\text{desde}, \text{hasta}\,]$);
- una cota máxima de días consecutivos $\delta_v \in \mathbb{N}$ (`diasMax`);
- una preferencia booleana de fin de semana $s_v \in \{0,1\}$ (`soloFinde`);
- una opción de transporte con capacidad $c_v \in \mathbb{N}$ (plazas libres, $c_v = 0$ si no conduce);
- un presupuesto máximo por persona $p_v \in \mathbb{R}_{\ge 0}$.

### 2. Matriz de disponibilidad

Se define la matriz binaria de disponibilidad

$$
A \in \{0,1\}^{m \times n}, \qquad
A_{tv} =
\begin{cases}
1 & \text{si } t \in D_v, \\
0 & \text{en caso contrario.}
\end{cases}
$$

### 3. Variables de decisión

Para cada ventana $W$ y cada viajero $v$:

$$
x_{tv} \in \{0,1\}, \quad t \in W,
$$

donde $x_{tv} = 1$ indica que el viajero $v$ participa en el viaje durante el día $t$.

### 4. Restricciones

**(R1) Coherencia con la disponibilidad declarada:**

$$
x_{tv} \le A_{tv} \qquad \forall\, t \in W,\ \forall\, v \in V .
$$

**(R2) Cota de días máximos:**

$$
\sum_{t \in W} x_{tv} \le \min(\delta_v, L) \qquad \forall\, v \in V .
$$

**(R3) Conectividad temporal (trayectorias):** los días asignados a cada viajero deben formar
sub-intervalos contiguos extraídos de sus bloques conexos de disponibilidad. Formalmente, sea
$\mathcal{T}_v$ la familia de subconjuntos connexos válidos de $D_v$ acotados por $\delta_v$;
entonces se exige

$$
\{t \in W : x_{tv} = 1\} \in \mathcal{T}_v \quad \text{o es vacío}.
$$

En la implementación esto se linealiza enumerando las trayectorias óptimas
$\text{traj}(v) \in \mathcal{T}_v$ y eligiendo una por viajero mediante variables
$y_{vk} \in \{0,1\}$ con $\sum_k y_{vk} \le 1$ y $x_{tv} = \sum_k y_{vk}\,\mathbb{1}[t \in \text{traj}_k(v)]$.

**(R4) Núcleo de pernocta:** un viajero pertenece al núcleo si está disponible *todos* los días
de la ventana y su $\delta_v \ge L$ (para $L \ge 2$); quien vota «ir y venir» solo participa en
excursiones de un día ($L = 1$):

$$
\mathcal{N}(W) = \{\, v \in V : \delta_v \ge L \ \wedge\ A_{tv} = 1\ \forall t \in W \,\},
\qquad |\mathcal{N}(W)| \ge 2 .
$$

**(R5) Satélites:** un viajero $u \notin \mathcal{N}(W)$ puede unirse si comparte al menos
$L \ge 2$ días (o $1$ si $L=1$) con la ventana:

$$
\sum_{t \in W} A_{tu} \ge \min(2, L).
$$

**(R6) Logística de transporte (flujo de coches):** para cada día $t \in W$, sean
$P_t = \{v : x_{tv} = 1\}$ los pasajeros del día. Debe existir una asignación conductor →
pasajeros tal que

$$
|P_t| \le \sum_{v \in P_t} (c_v + 1)\,\mathbb{1}[\text{$v$ conduce}] \qquad \forall\, t \in W,
$$

resuelta internamente como un problema de flujo/factibilidad por día (los excursionistas de
«ir y venir» entran y salen en su propio día).

**(R7) Cruce horario (capa B):** si el cuestionario incluye horarios por franjas con duración
ideal $\tau$ (horas), para todo par del núcleo debe existir una franja común de solape

$$
\mu(v, v', t) = \max \big| I^{\tau}_f(v,t) \cap I^{\tau}_f(v',t) \big| \ge \theta
\qquad \forall\, \{v,v'\} \subseteq \mathcal{N}(W),\ \exists t \in W,
$$

con umbral $\theta$ (`UMBRAL_HORA_SOLAPE`). La franja resultante $[h_{\text{ini}}, h_{\text{fin}}]$
se reporta como *cruce horario*.

**(R8) Presupuesto cooperativo:** dada una casa $h$ con precio total $C_h$, se considera viable
si el reparto cooperativo no excede el presupuesto mínimo del grupo:

$$
\frac{C_h}{\sum_{v} x_{tv}} \le p_{\max} := \min_{v \in \text{asignados}} p_v .
$$

Se compara además con el reparto en coalición $C_h / (\text{votos de } h)$.

### 5. Función objetivo

Los pesos por día se definen como

$$
w_t =
\begin{cases}
100 & t \in \text{núcleo mayoritario (quórum)}, \\
10 & \text{días adyacentes de expansión permitida}, \\
-50 & \text{días en minoría (penalización de fragmentación)},
\end{cases}
$$

y el problema se formula como un maximizar convertido en minimizar (vector $c$ del solver
`scipy.optimize.milp` / versión JS):

$$
\min_{y} \; - \sum_{v} \sum_{k} y_{vk} \sum_{t \in \text{traj}_k(v)} w_t
\qquad \text{s.a. (R1)--(R8)} .
$$

### 6. Selección global de soluciones

Se enumeran todas las ventanas $W$ factibles ($1 \le L \le L_{\max} = \max_v \delta_v$) y los
candidatos se ordenan lexicográficamente por

$$
\big(\, |N|,\ |\mathcal{N}|,\ L,\ -z^\star \,\big)
$$

(asistencia total, tamaño del núcleo, duración, valor óptimo negativo), filtrando
subventanas dominadas.

### 7. Resiliencia Monte Carlo

Con probabilidad global de baja $p$ por viajero, se simulan $S$ escenarios eliminando miembros
aleatoriamente según las predicciones de ausencia votadas, estimando

$$
\hat{\rho} = \frac{1}{S} \sum_{s=1}^{S} \mathbb{1}[\text{la solución sobrevive al escenario } s],
$$

y el impacto en cadena de cada viajero indispensable
$\Delta_v = \hat{\rho} - \hat{\rho}_{\bar{v}}$.

## Estructura del repositorio

```
├── index.html            # SPA: login, encuesta, consenso/reformulario, debate
├── src/
│   ├── css/styles.css    # Estilos (incl. menú lateral y modal del mapa)
│   ├── js/               # config, api, state, types, questions, answers,
│   │                     # reformulario (motor PLE), mapa (Leaflet), debate…
│   └── sql/schema.sql    # Esquema Supabase/Postgres
├── analizador_viaje.py   # Port por lotes del motor (pandas + scipy.milp + plotly)
├── run_analizador_viaje.py
└── legacy/               # Versión monolítica anterior
```

## Uso

1. Copia tus credenciales de Supabase en `src/js/config.js`.
2. Sirve el repositorio estático (p. ej. `python3 -m http.server`) y abre `index.html`.
3. Para el análisis por lotes: `pip install pandas numpy scipy plotly && python analizador_viaje.py`.
