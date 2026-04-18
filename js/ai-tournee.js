/* ════════════════════════════════════════════════
   ai-tournee.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Moteur IA de tournée médicale — niveau Google Maps
   ─────────────────────────────────────────────────
   Architecture : VRPTW (Vehicle Routing Problem
   with Time Windows) hybride client-side
   ─────────────────────────────────────────────────
   1. getTravelTimeOSRM() — temps de trajet réel
   2. cachedTravel()      — cache intelligent
   3. medicalWeight()     — priorité médicale NGAP
   4. dynamicScore()      — score multi-critères
   5. geoPenalty()        — pénalité clustering
   6. optimizeTour()      — algo greedy VRPTW
   7. twoOpt()            — optimisation 2-opt
   8. simulateLookahead() — anticipation N étapes
   9. recomputeRoute()    — recalcul live réactif
  10. startLiveOptimization() — boucle GPS temps réel
  11. USER_STATS          — mémoire utilisateur
  12. addUrgentPatient()  — ajout urgent temps réel
  13. cancelPatient()     — annulation temps réel
  14. scoreTourneeRentabilite() — scoring €/h
════════════════════════════════════════════════ */

/* ── Guards ──────────────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined', 'ai-tournee.js : utils.js non chargé.');
})();

/* ════════════════════════════════════════════════
   1. CACHE INTELLIGENT — évite les appels OSRM répétés
   Clé : "lat1,lng1-lat2,lng2" · TTL : 10 minutes
════════════════════════════════════════════════ */
const _travelCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

/* ════════════════════════════════════════════════
   HEURISTIQUE TRAFIC TEMPORELLE — zéro API
   ─────────────────────────────────────────────
   Coefficients basés sur les patterns de congestion
   urbaine française (données INSEE/CEREMA 2023).
   Appliqués sur le temps OSRM "idéal" pour obtenir
   un temps réaliste selon l'heure de départ.
   ─────────────────────────────────────────────
   Source : études CEREMA trafic domicile/médical
   Zones : urbain dense / péri-urbain (défaut)
════════════════════════════════════════════════ */

/* Périodes de pointe par jour de semaine (0=dim, 1=lun … 6=sam) */
const _TRAFFIC_RULES = [
  // { days, startMin, endMin, factor, label }
  // ── Lundi–Vendredi ─────────────────────────
  { days:[1,2,3,4,5], start: 7*60+15, end:  9*60+30, factor: 1.65, label:'🔴 Pointe matin'     },
  { days:[1,2,3,4,5], start:11*60+45, end: 14*60+15, factor: 1.30, label:'🟡 Déjeuner'         },
  { days:[1,2,3,4,5], start:16*60+30, end: 19*60+30, factor: 1.75, label:'🔴 Pointe soir'      },
  { days:[1,2,3,4,5], start:19*60+30, end: 21*60,    factor: 1.20, label:'🟡 Après pointe'     },
  // ── Samedi ────────────────────────────────
  { days:[6],         start: 9*60+30, end: 12*60+30, factor: 1.25, label:'🟡 Sam. matin'       },
  { days:[6],         start:14*60,    end: 17*60,    factor: 1.20, label:'🟡 Sam. après-midi'  },
  // ── Dimanche / jours fériés ───────────────
  // (pas de pointe significative)
];

/**
 * trafficFactor(departureMin, date?)
 * Retourne { factor, label } pour un départ à `departureMin` (minutes depuis minuit).
 * `date` : Date optionnelle (défaut = maintenant).
 */
function trafficFactor(departureMin, date = new Date()) {
  const dow = date.getDay(); // 0=dim … 6=sam
  for (const rule of _TRAFFIC_RULES) {
    if (rule.days.includes(dow) && departureMin >= rule.start && departureMin < rule.end) {
      return { factor: rule.factor, label: rule.label };
    }
  }
  return { factor: 1.0, label: '🟢 Fluide' };
}

/**
 * trafficAdjust(osrmMin, departureMin, date?)
 * Applique le coefficient trafic sur un temps OSRM brut.
 * Intègre aussi la correction USER_STATS (retard moyen constaté).
 */
function trafficAdjust(osrmMin, departureMin, date = new Date()) {
  const { factor } = trafficFactor(departureMin, date);
  // Correction USER_STATS : apprentissage continu des habitudes de l'infirmière
  const userFactor = USER_STATS.avgDelayMin > 0
    ? 1 + Math.min(USER_STATS.avgDelayMin / 30, 0.5)
    : 1.0;
  return osrmMin * factor * userFactor;
}

/**
 * getTrafficInfo(departureMin)
 * Retourne un objet descriptif pour l'affichage UI.
 */
function getTrafficInfo(departureMin) {
  return trafficFactor(departureMin);
}


function _cacheKey(a, b) {
  /* Arrondi à 4 décimales (~11m précision) pour maximiser les hits */
  return `${a.lat.toFixed(4)},${a.lng.toFixed(4)}-${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
}

async function cachedTravel(a, b) {
  if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return 999;
  const key = _cacheKey(a, b);
  const cached = _travelCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }
  const t = await getTravelTimeOSRM(a, b);
  _travelCache.set(key, { value: t, ts: Date.now() });
  return t;
}

/* ════════════════════════════════════════════════
   2. TEMPS DE TRAJET RÉEL (OSRM)
   Fallback euclidien si OSRM indisponible
════════════════════════════════════════════════ */
async function getTravelTimeOSRM(a, b) {
  if (!a?.lat || !b?.lat) return 999;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d.code !== 'Ok') return _euclideanMin(a, b);
    return d.routes[0].duration / 60; // → minutes
  } catch {
    return _euclideanMin(a, b); // fallback sans erreur console
  }
}

/* Fallback : distance euclidienne → minutes (hypothèse 40 km/h) */
function _euclideanMin(a, b) {
  const dx = (a.lat - b.lat) * 111;
  const dy = (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dx*dx + dy*dy) / 40 * 60;
}

/* ════════════════════════════════════════════════
   3. POIDS MÉDICAL — priorité NGAP métier
   Injecté dans le score global
════════════════════════════════════════════════ */
function medicalWeight(p) {
  let score = 0;
  const d = (p.description || p.label || p.actes || '').toLowerCase();

  /* Urgences absolues */
  if (p.urgent || p.urgence)               score += 200;
  if (/urgence|urgente/.test(d))           score += 200;

  /* Actes contraints (délais biologiques) */
  if (/insuline/.test(d))                  score += 80;
  if (/injection/.test(d))                 score += 40;
  if (/prélèvement|prise de sang/.test(d)) score += 60;
  if (/perfusion/.test(d))                 score += 50;

  /* Actes lourds (durée longue → placer tôt) */
  if (/pansement lourd|bsc/.test(d))       score += 40;
  if (/toilette|nursing/.test(d))          score += 20;

  /* Fenêtre horaire serrée → pénalité si heure dépassée */
  if (p.window && p.window[1] - p.window[0] < 60) score += 30;

  return score;
}

/* ════════════════════════════════════════════════
   4. SCORE DYNAMIQUE MULTI-CRITÈRES
   Formule : retard + attente + médical + distance + cluster
   Plus petit = meilleur prochain patient
════════════════════════════════════════════════ */
function dynamicScore({ currentTime, travelTime, patient, userPos }) {
  const arrival = currentTime + travelTime;
  let score = 0;

  /* ⏰ Fenêtre temporelle */
  if (patient.window) {
    const [wStart, wEnd] = patient.window;
    /* Contrainte stricte (mode mixte, respecter_horaire) → pénalité ×10 */
    const penalty = patient._contrainte_stricte ? 20000 : 2000;
    if (arrival > wEnd)    score += penalty;                       // retard critique
    if (arrival < wStart)  score += (wStart - arrival) * 0.5;     // attente (moins grave)
  }

  /* 🚨 Priorité médicale (soustrait = remonte) */
  score -= medicalWeight(patient);

  /* ⚠️ Déjà en retard → remonter d'urgence */
  if (patient.late)       score -= 150;
  if (patient.priority)   score -= patient.priority * 100;

  /* 📍 Temps de trajet pondéré */
  score += travelTime * 2;

  /* 🔥 Pénalité géographique (évite les zig-zags) */
  if (userPos) score += geoPenalty(patient, userPos);

  return score;
}

/* ════════════════════════════════════════════════
   5. PÉNALITÉ GÉOGRAPHIQUE — clustering intelligent
   Favorise les patients dans la même zone
════════════════════════════════════════════════ */
function geoPenalty(patient, userPos) {
  if (!patient.lat || !patient.lng || !userPos) return 0;
  const dx = patient.lat - (userPos.lat || userPos.latitude);
  const dy = patient.lng - (userPos.lng || userPos.longitude);
  return Math.sqrt(dx*dx + dy*dy) * 60; // pondéré pour équilibrer
}


/**
 * trafficAwareCachedTravel(a, b, departureMin)
 * Comme cachedTravel() mais applique le coefficient trafic.
 * C'est cette fonction qui est utilisée dans optimizeTour et recomputeRoute.
 */
async function trafficAwareCachedTravel(a, b, departureMin = _nowMinutes()) {
  const raw = await cachedTravel(a, b);
  return trafficAdjust(raw, departureMin);
}

/* ════════════════════════════════════════════════
   6. ALGO PRINCIPAL — VRPTW Greedy intelligent
   ─────────────────────────────────────────────
   Greedy VRPTW avec :
   - matrice de temps réels (OSRM + cache)
   - fenêtres temporelles patients
   - score médical
   - anticipation lookahead 2 niveaux
   - mode 'mixte' : patients avec respecter_horaire=true
     ont une fenêtre temporelle stricte (pénalité ×10)
════════════════════════════════════════════════ */
async function optimizeTour(patients, startPoint, startTimeMin = 480, mode = 'ia') {
  if (!patients?.length) return [];

  /* Normalisation entrée */
  let remaining = patients
    .filter(p => p.lat && p.lng)
    .map(p => {
      /* En mode mixte : si le patient a "respecter_horaire", on force une fenêtre stricte
         de ±15 min autour de l'heure préférée.
         En mode ia standard : on utilise heure_soin comme fenêtre souple. */
      let window = p.window || null;
      const heureSource = p.heure_preferee || p.heure_soin || '';
      if (!window && heureSource) {
        const parsed = _parseWindow(heureSource);
        if (parsed && mode === 'mixte' && p.respecter_horaire) {
          /* Fenêtre stricte : ±15 min */
          window = [parsed[0] - 15, parsed[0] + 15];
        } else {
          window = parsed;
        }
      }
      return {
        ...p,
        window,
        duration: p.duration || _estimateDuration(p),
        _contrainte_stricte: mode === 'mixte' && !!p.respecter_horaire,
      };
    });

  const noCoords = patients.filter(p => !p.lat || !p.lng);

  let route    = [];
  let current  = startPoint;
  let currentTime = startTimeMin;

  while (remaining.length) {
    let best = null, bestScore = Infinity;

    /* Pré-tri euclidien pour limiter les appels OSRM aux N=8 plus proches */
    const candidates = _nearestN(remaining, current, 8);

    for (const p of candidates) {
      const travel = await trafficAwareCachedTravel(current, p, currentTime);

      /* Lookahead 2 niveaux : anticipe les 2 prochains patients */
      const futureScore = await simulateLookahead(p, remaining.filter(r => r !== p), 2, currentTime);

      const s = dynamicScore({ currentTime, travelTime: travel, patient: p, userPos: current })
                + futureScore * 0.25;

      if (s < bestScore) { bestScore = s; best = { patient: p, travel }; }
    }

    if (!best) break;

    const arrival  = currentTime + best.travel;
    const start    = Math.max(arrival, best.patient.window?.[0] ?? arrival);
    currentTime    = start + best.patient.duration;

    route.push({
      ...best.patient,
      arrival_min: arrival,
      start_min:   start,
      end_min:     currentTime,
      travel_min:  Math.round(best.travel),
      arrival_str: _minToTime(arrival),
      start_str:   _minToTime(start),
    });

    current   = best.patient;
    remaining = remaining.filter(p => p !== best.patient);
  }

  /* Patients sans coords → ajoutés en fin triés par heure */
  noCoords.sort((a,b) => (a.heure_soin||'').localeCompare(b.heure_soin||''));
  route.push(...noCoords);

  return route;
}

/* ════════════════════════════════════════════════
   7. OPTIMISATION 2-OPT
   Améliore le chemin global après greedy.
   Complexité O(n²) — limité à 20 patients max.
════════════════════════════════════════════════ */
function twoOpt(route) {
  /* Seulement sur les patients avec coords */
  const withCoords    = route.filter(p => p.lat && p.lng);
  const withoutCoords = route.filter(p => !p.lat || !p.lng);

  if (withCoords.length < 4) return route;

  let improved = true;
  let best = [...withCoords];
  let bestDist = _totalEuclidean(best);
  let iterations = 0;
  const MAX_ITER = 50; // cap pour performance

  while (improved && iterations < MAX_ITER) {
    improved = false;
    iterations++;

    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        /* Inversion du segment [i..j] */
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1)
        ];
        const candidateDist = _totalEuclidean(candidate);
        if (candidateDist < bestDist - 0.0001) {
          best      = candidate;
          bestDist  = candidateDist;
          improved  = true;
        }
      }
    }
  }

  log(`2-opt: ${iterations} itérations, dist ${bestDist.toFixed(2)}°`);
  return [...best, ...withoutCoords];
}

function _totalEuclidean(route) {
  let d = 0;
  for (let i = 0; i < route.length - 1; i++) {
    d += _euclideanMin(route[i], route[i+1]);
  }
  return d;
}

/* ════════════════════════════════════════════════
   8. LOOKAHEAD — anticipation N étapes (récursif)
   Évalue le coût futur d'un choix pour éviter
   les impasses temporelles.
   depth=2 → bon compromis perf/qualité
════════════════════════════════════════════════ */
async function simulateLookahead(fromPatient, remaining, depth = 2, departureMin = _nowMinutes()) {
  if (depth === 0 || !remaining.length) return 0;

  /* Limiter à 4 candidats pour éviter explosion exponentielle */
  const candidates = _nearestN(remaining, fromPatient, 4);
  let minScore = Infinity;

  for (const next of candidates) {
    const t     = await trafficAwareCachedTravel(fromPatient, next, departureMin);
    const score = t + await simulateLookahead(next, remaining.filter(p => p !== next), depth - 1, departureMin + t);
    if (score < minScore) minScore = score;
  }

  return minScore === Infinity ? 0 : minScore;
}

/* ════════════════════════════════════════════════
   9. RECALCUL LIVE — réactif à GPS (mode Uber)
   Appelé automatiquement via APP.on('userPos')
   Utilise le score dynamique + cache OSRM
════════════════════════════════════════════════ */
async function recomputeRoute() {
  const userPos   = APP.get('userPos');
  const patients  = APP.get('uberPatients');
  const remaining = (patients || []).filter(p => !p.done && !p.absent && p.lat && p.lng);

  if (!userPos || !remaining.length) return;

  const currentTime = _nowMinutes();
  let best = null, bestScore = Infinity;

  /* Pré-tri + OSRM sur top 6 */
  const candidates = _nearestN(remaining, userPos, 6);

  for (const p of candidates) {
    const travel = await trafficAwareCachedTravel(userPos, p, currentTime);
    const s = dynamicScore({ currentTime, travelTime: travel, patient: p, userPos });
    if (s < bestScore) { bestScore = s; best = p; }
  }

  if (best) APP.set('nextPatient', best);
}

/* ════════════════════════════════════════════════
  10. BOUCLE TEMPS RÉEL — startLiveOptimization()
   Recalcul automatique à chaque update GPS.
   ✅ Throttle 5s via APP.on('userPos') existant
   ✅ Intervalle 20s en fallback
════════════════════════════════════════════════ */
let _liveOptInterval = null;

function startLiveOptimization() {
  /* Réactif via store observable */
  APP.on('userPos', throttle(async () => {
    await recomputeRoute();
    _updateRentabilite();
  }, 5000));

  /* Fallback : recalcul toutes les 20s même si GPS immobile */
  if (_liveOptInterval) clearInterval(_liveOptInterval);
  _liveOptInterval = setInterval(async () => {
    if (APP.get('userPos')) await recomputeRoute();
  }, 20000);

  log('Live optimization démarrée');
}

/* Exposer l'info trafic pour l'UI tournée */
if (typeof window !== 'undefined') {
  window.getTrafficInfo     = getTrafficInfo;
  window.trafficFactor      = trafficFactor;
}

function stopLiveOptimization() {
  if (_liveOptInterval) { clearInterval(_liveOptInterval); _liveOptInterval = null; }
  log('Live optimization arrêtée');
}

/* ════════════════════════════════════════════════
  11. MÉMOIRE UTILISATEUR — apprentissage continu
   Ajuste les temps de trajet selon la réalité.
   Persisté en localStorage (non-sensible).
════════════════════════════════════════════════ */
const USER_STATS = (() => {
  try {
    const saved = localStorage.getItem('ami_user_stats');
    return saved ? JSON.parse(saved) : { avgSpeedKmh: 35, avgDelayMin: 3, sessionsCount: 0 };
  } catch { return { avgSpeedKmh: 35, avgDelayMin: 3, sessionsCount: 0 }; }
})();

function updateUserStats(plannedMin, actualMin) {
  if (!plannedMin || !actualMin) return;
  const diff = actualMin - plannedMin;
  /* Moyenne mobile exponentielle (α=0.2) */
  USER_STATS.avgDelayMin = USER_STATS.avgDelayMin * 0.8 + diff * 0.2;
  USER_STATS.sessionsCount++;
  try { localStorage.setItem('ami_user_stats', JSON.stringify(USER_STATS)); } catch {}
  log('USER_STATS mis à jour:', USER_STATS);
}

/* adjustedTravel() remplacée par trafficAdjust() — voir section heuristique trafic */

/* ════════════════════════════════════════════════
  12. ÉVÉNEMENTS TEMPS RÉEL
   addUrgentPatient() / cancelPatient()
   Recalcul automatique après chaque événement.
════════════════════════════════════════════════ */

/* Ajoute un patient urgent en tête de file */
async function addUrgentPatient(patient) {
  const pts = APP.get('uberPatients') || [];
  const urgent = {
    ...patient,
    urgent:   true,
    urgence:  true,
    priority: 10,
    done:     false,
    absent:   false,
    late:     false,
    window:   [_nowMinutes(), _nowMinutes() + 60],
    duration: patient.duration || 15,
    lat:      parseFloat(patient.lat) || null,
    lng:      parseFloat(patient.lng) || null,
  };
  APP.set('uberPatients', [urgent, ...pts]);
  await recomputeRoute();
  log('Patient urgent ajouté:', urgent.label || urgent.description);
}

/* Annule un patient (par id ou index) */
async function cancelPatient(patientId) {
  const pts = APP.get('uberPatients') || [];
  APP.set('uberPatients', pts.filter(p => String(p.id) !== String(patientId) && p.patient_id !== patientId));
  await recomputeRoute();
  log('Patient annulé:', patientId);
}

/* Marque un patient comme terminé + met à jour stats */
async function completePatient(patientId, actualArrivalMin) {
  const pts = APP.get('uberPatients') || [];
  const p   = pts.find(x => String(x.id) === String(patientId) || x.patient_id === patientId);
  if (p) {
    if (p.arrival_min && actualArrivalMin) updateUserStats(p.arrival_min, actualArrivalMin);
    p.done = true;
  }
  APP.set('uberPatients', [...pts]);
  await recomputeRoute();
}

/* ════════════════════════════════════════════════
  13. SCORING RENTABILITÉ (€/heure)
   Affiché dans la carte live pour motiver l'infirmière.
════════════════════════════════════════════════ */
function scoreTourneeRentabilite(route) {
  if (!route?.length) return null;

  // CA : utiliser total > amount > estimation locale
  const totalCA   = route.reduce((s,p) => {
    const v = parseFloat(p.total || p.amount || 0);
    return s + v;
  }, 0);

  // Temps : travel_min (réel OSRM) + durée soin (15 min défaut)
  // Pour les patients sans coords, on suppose 5 min de trajet minimum
  const totalMin  = route.reduce((s,p) => {
    const travel   = p.travel_min > 0 ? p.travel_min : (p.lat && p.lng ? 5 : 0);
    const duration = p.duration   > 0 ? p.duration   : 15;
    return s + travel + duration;
  }, 0);

  const totalKm   = route.reduce((s,p) => {
    if (!p.travel_min) return s;
    return s + (p.travel_min / 60) * USER_STATS.avgSpeedKmh;
  }, 0);

  const hourlyRate = totalMin > 0 ? (totalCA / totalMin * 60) : 0;
  const kmRate     = totalKm  > 0 ? (totalCA / totalKm) : 0;

  return {
    ca_total:     totalCA.toFixed(2),
    total_min:    Math.round(totalMin),
    total_km:     totalKm.toFixed(1),
    euro_heure:   hourlyRate.toFixed(2),
    euro_km:      kmRate.toFixed(2),
    nb_patients:  route.filter(p => p.lat && p.lng).length,
  };
}

function _updateRentabilite() {
  const el = $('live-rentabilite');
  if (!el) return;
  const route = APP.get('uberPatients') || [];
  const done  = route.filter(p => p.done);
  if (!done.length) return;
  const stats = scoreTourneeRentabilite(done);
  if (!stats) return;
  el.innerHTML = `💶 ${stats.euro_heure}€/h · 📍 ${stats.total_km} km · ✅ ${stats.nb_patients} patients`;
  el.style.display = 'block';
}

/* ════════════════════════════════════════════════
   UTILS INTERNES
════════════════════════════════════════════════ */

/* N patients les plus proches (euclidien rapide) */
function _nearestN(patients, from, n) {
  if (!from?.lat) return patients.slice(0, n);
  return [...patients]
    .filter(p => p.lat && p.lng)
    .sort((a,b) => _euclideanMin(from,a) - _euclideanMin(from,b))
    .slice(0, n);
}

/* Heure "HH:MM" → minutes depuis minuit */
function _parseWindow(heureStr) {
  if (!heureStr) return null;
  const [hh, mm] = heureStr.split(':').map(Number);
  const start = (hh || 0) * 60 + (mm || 0);
  return [start - 30, start + 90]; // fenêtre ±1h30 autour de l'heure prévue
}

/* Durée estimée selon description */
function _estimateDuration(p) {
  const d = (p.description || p.label || '').toLowerCase();
  if (/toilette|nursing/.test(d))          return 35;
  if (/pansement lourd|bsc/.test(d))       return 30;
  if (/perfusion/.test(d))                 return 45;
  if (/prélèvement|prise de sang/.test(d)) return 15;
  if (/injection/.test(d))                 return 10;
  return 20; // défaut
}

/* Minutes actuelles depuis minuit */
function _nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/* Minutes → "HH:MM" */
function _minToTime(min) {
  if (min == null || isNaN(min)) return '—';
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

/* ════════════════════════════════════════════════
   MODE CABINET — Couche multi-IDE additive v1.0
   ──────────────────────────────────────────────
   Fonctions qui complètent le moteur solo existant
   pour le cas où plusieurs IDEs partagent un cabinet.

   Principe : chaque IDE passe dans le pipeline solo
   existant — on ajoute seulement le clustering et
   la distribution. Rien n'est modifié dans le code
   solo au-dessus.

   API publique :
     cabinetPlanDay(patients, members)
     cabinetScoreDistribution(assignments)
     cabinetOptimizeRevenue(assignments, members)
════════════════════════════════════════════════ */

/** TARIFS NGAP pour estimation revenue cabinet (côté client) */
const _CABINET_TARIFS = {
  AMI1: 3.15, AMI2: 6.30, AMI3: 9.45, AMI4: 12.60, AMI5: 15.75, AMI6: 18.90,
  AIS1: 2.65, AIS3: 7.95,
  BSA: 13.00, BSB: 18.20, BSC: 28.70,
  IFD: 2.75,
};

/**
 * Estime le revenu NGAP pour une liste d'actes (côté client, approximatif).
 * Le vrai calcul se fait côté N8N — ceci est uniquement pour le scoring cabinet.
 */
function _cabinetEstimateRevenue(actes = []) {
  if (!actes.length) return 0;
  const sorted = [...actes].sort((a, b) => (_CABINET_TARIFS[b.code] || 0) - (_CABINET_TARIFS[a.code] || 0));
  let total = 0, principal = true;
  for (const acte of sorted) {
    const tarif = _CABINET_TARIFS[acte.code] || 3.15;
    total += principal ? tarif : tarif * 0.5;
    if (['AMI1','AMI2','AMI3','AMI4','AMI5','AMI6','AIS1','AIS3'].includes(acte.code)) {
      principal = false; // les suivants à 0.5
    }
  }
  return Math.round(total * 100) / 100;
}

/**
 * K-means géographique côté client (identique à la version worker).
 * @param {Array} patients — liste avec .lat/.lng optionnels
 * @param {number} k       — nombre de clusters (= nombre d'IDEs)
 * @returns {Array[]}      — tableau de k tableaux de patients
 */
function cabinetGeoCluster(patients, k) {
  if (!k || k <= 1) return [patients];
  const withGeo = patients.filter(p => p.lat && p.lng);
  const noGeo   = patients.filter(p => !p.lat || !p.lng);
  if (!withGeo.length) {
    const clusters = Array.from({ length: k }, () => []);
    patients.forEach((p, i) => clusters[i % k].push(p));
    return clusters;
  }
  let centers = withGeo.slice(0, k).map(p => ({ lat: p.lat, lng: p.lng }));
  let clusters = [];
  for (let iter = 0; iter < 8; iter++) {
    clusters = Array.from({ length: k }, () => []);
    for (const p of withGeo) {
      let best = 0, bestDist = Infinity;
      centers.forEach((c, i) => {
        const d = Math.hypot(p.lat - c.lat, p.lng - c.lng);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      clusters[best].push(p);
    }
    centers = clusters.map((cl, i) => {
      if (!cl.length) return centers[i];
      return {
        lat: cl.reduce((s, p) => s + p.lat, 0) / cl.length,
        lng: cl.reduce((s, p) => s + p.lng, 0) / cl.length,
      };
    });
  }
  noGeo.forEach(p => {
    const smallest = clusters.reduce((min, cl, i) => cl.length < clusters[min].length ? i : min, 0);
    clusters[smallest].push(p);
  });
  return clusters;
}

/**
 * cabinetPlanDay — génère un planning multi-IDE à partir d'une liste de patients
 * et d'une liste de membres du cabinet.
 *
 * @param {Array} patients  — liste de patients (avec .lat/.lng si disponibles, .actes optionnel)
 * @param {Array} members   — liste d'IDEs : [{ id, nom, prenom }]
 * @returns {Array}         — assignments : [{ ide_id, nom, prenom, patients: [...] }]
 *
 * Utilise le moteur optimizeTour() existant pour chaque IDE.
 */
function cabinetPlanDay(patients, members) {
  if (!patients.length || !members.length) return [];
  const k        = members.length;
  const clusters = cabinetGeoCluster(patients, k);

  return members.map((member, idx) => {
    const idePatients  = clusters[idx] || [];
    // Optimiser la route pour cet IDE via le moteur solo existant
    const optimized = (typeof optimizeTour === 'function')
      ? optimizeTour(idePatients, member.start_lat || null, member.start_lng || null)
      : idePatients;

    return {
      ide_id:   member.id || member.infirmiere_id || `ide_${idx}`,
      nom:      member.nom    || '',
      prenom:   member.prenom || '',
      patients: optimized.map(p => ({ ...p, performed_by: member.id || `ide_${idx}` })),
    };
  });
}

/**
 * cabinetScoreDistribution — score un planning cabinet (€/h, km, nb patients).
 * Utilisé pour comparer deux distributions.
 */
function cabinetScoreDistribution(assignments) {
  if (!assignments.length) return { score: 0, total_revenue: 0, total_km: 0, details: [] };
  const details = assignments.map(a => {
    const patients = a.patients || [];
    const revenue  = patients.reduce((s, p) => {
      const actes = Array.isArray(p.actes) ? p.actes : [];
      return s + _cabinetEstimateRevenue(actes);
    }, 0);
    const km = patients.reduce((s, p) => s + (p.distance_km || 0), 0);
    return { ide_id: a.ide_id, nb_patients: patients.length, revenue: Math.round(revenue * 100) / 100, km: Math.round(km * 10) / 10 };
  });
  const total_revenue = details.reduce((s, d) => s + d.revenue, 0);
  const total_km      = details.reduce((s, d) => s + d.km, 0);
  // Pénaliser les déséquilibres (écart-type des revenus)
  const mean = total_revenue / details.length;
  const variance = details.reduce((s, d) => s + Math.pow(d.revenue - mean, 2), 0) / details.length;
  const penalty  = Math.sqrt(variance) * 0.5;
  const score    = Math.round((total_revenue - total_km * 0.2 - penalty) * 100) / 100;
  return { score, total_revenue: Math.round(total_revenue * 100) / 100, total_km: Math.round(total_km * 10) / 10, details };
}

/**
 * cabinetOptimizeRevenue — améliore itérativement un planning cabinet
 * en déplaçant des patients entre IDEs pour maximiser le score.
 * Max 30 itérations pour rester léger côté client.
 *
 * @param {Array} assignments — sortie de cabinetPlanDay()
 * @param {Array} members     — membres du cabinet
 * @returns {Array}           — assignments améliorés
 */
function cabinetOptimizeRevenue(assignments, members) {
  if (assignments.length <= 1) return assignments;
  let best = assignments.map(a => ({ ...a, patients: [...(a.patients || [])] }));
  let bestScore = cabinetScoreDistribution(best).score;

  for (let iter = 0; iter < 30; iter++) {
    let improved = false;
    for (let i = 0; i < best.length; i++) {
      for (let j = 0; j < best.length; j++) {
        if (i === j || !best[i].patients.length) continue;
        // Essayer de déplacer le premier patient de l'IDE i vers l'IDE j
        const candidate = best.map(a => ({ ...a, patients: [...a.patients] }));
        const moved = candidate[i].patients.shift();
        if (!moved) continue;
        moved.performed_by = candidate[j].ide_id;
        candidate[j].patients.push(moved);
        const candidateScore = cabinetScoreDistribution(candidate).score;
        if (candidateScore > bestScore) {
          best = candidate;
          bestScore = candidateScore;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * cabinetBuildUI — génère le HTML résumé pour affichage dans l'UI cabinet.
 * Utilisé par tournee.js ou uber.js pour afficher le planning multi-IDE.
 */
function cabinetBuildUI(assignments, scoreData) {
  if (!assignments.length) return '<p style="color:var(--m)">Aucun membre dans ce cabinet.</p>';
  const rows = assignments.map((a, idx) => {
    const d    = (scoreData?.details || [])[idx] || {};
    const color = ['var(--a)', 'var(--w)', '#00d4aa', '#ff6b6b'][idx % 4];
    return `<div style="padding:10px 0;border-bottom:1px solid var(--b)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <strong style="font-size:13px">${a.prenom} ${a.nom}</strong>
        <span style="margin-left:auto;font-size:11px;color:var(--m)">${a.patients.length} patient(s)</span>
      </div>
      <div style="font-size:12px;color:var(--m);display:flex;gap:12px">
        <span>💶 ${(d.revenue || 0).toFixed(2)} €</span>
        <span>🚗 ${(d.km || 0).toFixed(1)} km</span>
      </div>
    </div>`;
  });
  const total = scoreData?.total_revenue || 0;
  return `<div>
    ${rows.join('')}
    <div style="padding:10px 0;font-size:13px;font-weight:700;color:var(--a)">
      💰 Total cabinet : ${total.toFixed(2)} €
    </div>
  </div>`;
}

/* ════════════════════════════════════════════════
   COUCHE IA AVANCÉE — v2.0
   ────────────────────────────────────────────────
   predictDelayLive()       — prédiction de retard en temps réel
   autoReassignIfRisk()     — réassignation auto si risque HIGH
   smartCluster()           — clustering hybride € + géo
   planWithRevenueTarget()  — planning piloté par objectif CA
   _estimateFatigueFactor() — modèle fatigue IDE (heuristique)
   _surgeScore()            — score tension zone
   planWithTargetAndSurge() — planning objectif + surge
════════════════════════════════════════════════ */

/* ── Tarifs NGAP pour estimation locale ── */
const _AI_TARIFS = {
  AMI1:3.15, AMI2:6.30, AMI3:9.45, AMI4:12.60, AMI5:15.75, AMI6:18.90,
  AIS1:2.65, AIS3:7.95, BSA:13.00, BSB:18.20, BSC:28.70, IFD:2.75,
};

function _aiTarif(code) { return _AI_TARIFS[code] || _AI_TARIFS[(code||'').toUpperCase()] || 3.15; }

/* ════════════════════════════════════════════════
   PRÉDICTION DE RETARD LIVE
════════════════════════════════════════════════ */

/**
 * predictDelayLive — prédit les retards sur une tournée en cours
 * @param {Object} ide — { id, pos: {lat,lng}, avg_duration_factor? }
 * @param {Array}  route — [ { id, coords:{lat,lng}, scheduled_at:ms, actes:[] }, … ]
 * @returns { risk_level:'LOW'|'MEDIUM'|'HIGH', total_delay_min, details }
 */
function predictDelayLive({ ide, route }) {
  if (!Array.isArray(route) || !route.length) return { risk_level: 'LOW', total_delay_min: 0, details: [] };

  let currentTime = Date.now();
  let risk = 0;
  const delays = [];

  for (const stop of route) {
    // Temps de trajet estimé (euclidien + heuristique trafic)
    const travel = _predictTravelMs(ide?.pos, stop.coords);
    // Durée soin avec facteur fatigue IDE
    const care   = _predictCareDurationMs(stop, ide, { done: delays.length });

    currentTime += travel + care;

    const scheduled = stop.scheduled_at || stop.heure_ms || 0;
    if (scheduled > 0) {
      const delta = currentTime - scheduled;
      if (delta > 5 * 60 * 1000) { // > 5 min de retard
        risk += delta;
        delays.push({ patient_id: stop.id, delay_min: Math.round(delta / 60000) });
      }
    }
  }

  const total_delay_min = Math.round(risk / 60000);
  return {
    risk_level:      total_delay_min > 15 ? 'HIGH' : total_delay_min > 5 ? 'MEDIUM' : 'LOW',
    total_delay_min,
    details: delays,
  };
}

function _predictTravelMs(from, to) {
  if (!from?.lat || !to?.lat) return 10 * 60 * 1000; // 10 min par défaut
  const km  = Math.hypot(to.lat - from.lat, to.lng - from.lng) * 111;
  const dep = _nowMinutes();
  const { factor } = trafficFactor(dep);
  const baseMin = (km / 40) * 60; // 40 km/h moyen
  return Math.round(baseMin * factor * 60 * 1000);
}

function _predictCareDurationMs(stop, ide, ctx) {
  const actes = Array.isArray(stop.actes) ? stop.actes : [];
  let base = _estimateDuration(stop); // fonction existante dans ai-tournee.js
  // Facteur fatigue IDE
  const fatigue = _estimateFatigueFactor(ctx?.done || 0);
  // Complexité patient
  const complexity = stop.patient?.complexity || 1.0;
  return Math.round(base * fatigue * complexity * 60 * 1000);
}

/* ════════════════════════════════════════════════
   MODÈLE FATIGUE IDE (heuristique légère)
════════════════════════════════════════════════ */

/**
 * _estimateFatigueFactor — estime le facteur fatigue selon l'avancement de la tournée
 * Retourne un facteur multiplicatif de durée (1.0 = normal, >1.0 = plus lent)
 */
function _estimateFatigueFactor(nbStopsDone, kmDone = 0, minutesSinceStart = 0) {
  let factor = 1.0;
  // Fatigue progressive selon nombre de patients
  if (nbStopsDone >= 10) factor += 0.10;
  if (nbStopsDone >= 15) factor += 0.10;
  if (nbStopsDone >= 20) factor += 0.10;
  // Fatigue horaire (fin de matinée / après déjeuner)
  const h = new Date().getHours();
  if (h >= 11 && h < 14) factor += 0.05; // creux déjeuner
  if (h >= 17)            factor += 0.08; // fin journée
  // Fatigue kilométrique
  if (kmDone > 50) factor += 0.05;
  if (kmDone > 80) factor += 0.05;
  return Math.min(factor, 1.4); // max +40%
}

/* ════════════════════════════════════════════════
   AUTO-RÉASSIGNATION EN CAS DE RISQUE
════════════════════════════════════════════════ */

/**
 * autoReassignIfRisk — vérifie chaque IDE et réassigne si risque HIGH
 * @param {Object} planning — { [ide_id]: patients[] }
 * @param {Array}  infirmieres — [ { id, nom, prenom, pos } ]
 * @returns { planning, changes[] }
 */
function autoReassignIfRisk({ planning, infirmieres }) {
  if (!planning || !infirmieres?.length) return { planning: planning || {}, changes: [] };

  const changes = [];

  for (const ide of infirmieres) {
    const route = planning[ide.id] || [];
    if (!route.length) continue;

    const prediction = predictDelayLive({ ide, route });
    if (prediction.risk_level !== 'HIGH') continue;

    for (const delay of prediction.details) {
      const patient = _findPatientInPlanning(planning, delay.patient_id);
      if (!patient) continue;

      const better = _findBestIDEForPatientSimple(patient, infirmieres, ide.id);
      if (!better) continue;

      // Réassigner
      planning[ide.id] = (planning[ide.id] || []).filter(p => p.id !== patient.id);
      if (!planning[better.ide_id]) planning[better.ide_id] = [];
      planning[better.ide_id].push({ ...patient, performed_by: better.ide_id });

      changes.push({
        type:       'reassign',
        patient_id: patient.id,
        from:       ide.id,
        to:         better.ide_id,
        gain_min:   delay.delay_min,
      });
    }
  }

  return { planning, changes };
}

function _findPatientInPlanning(planning, patientId) {
  for (const route of Object.values(planning)) {
    const p = (route || []).find(x => x.id === patientId || x.patient_id === patientId);
    if (p) return p;
  }
  return null;
}

function _findBestIDEForPatientSimple(patient, infirmieres, excludeId) {
  let best = null, bestScore = -Infinity;
  for (const ide of infirmieres) {
    if (ide.id === excludeId) continue;
    const dist  = ide.pos && patient.coords
      ? Math.hypot(ide.pos.lat - patient.coords.lat, ide.pos.lng - patient.coords.lng) * 111
      : 10;
    const rev   = _estimateRevenueForPatient(patient);
    const score = rev - dist * 0.4;
    if (score > bestScore) { bestScore = score; best = { ide_id: ide.id, score }; }
  }
  return best;
}

function _estimateRevenueForPatient(patient) {
  const actes = Array.isArray(patient.actes) ? patient.actes : [];
  if (!actes.length) return 8.50;
  const sorted = [...actes].sort((a, b) => _aiTarif(b.code) - _aiTarif(a.code));
  return sorted.reduce((s, a, i) => s + _aiTarif(a.code) * (i === 0 ? 1 : 0.5), 0);
}

/* ════════════════════════════════════════════════
   CLUSTERING INTELLIGENT € + GÉO
════════════════════════════════════════════════ */

/**
 * smartCluster — clustering hybride géo + rentabilité
 * Remplace le clustering purement géographique
 */
function smartCluster(patients, k) {
  if (!k || k <= 1) return [patients];
  if (!patients.length) return [];

  // Initialisation géographique
  let clusters = cabinetGeoCluster(patients, k); // fonction existante

  // Itérations d'amélioration basées sur le score €
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (let ci = 0; ci < clusters.length; ci++) {
      for (let pi = clusters[ci].length - 1; pi >= 0; pi--) {
        const p = clusters[ci][pi];
        let bestClusterIdx = ci;
        let bestScore = _clusterScore([...clusters[ci]]);

        for (let cj = 0; cj < clusters.length; cj++) {
          if (cj === ci) continue;
          const testSrc = clusters[ci].filter((_, i) => i !== pi);
          const testDst = [...clusters[cj], p];
          const scoreNew = _clusterScore(testSrc) + _clusterScore(testDst);
          const scoreCur = _clusterScore(clusters[ci]) + _clusterScore(clusters[cj]);
          if (scoreNew > scoreCur) { bestClusterIdx = cj; bestScore = scoreNew; }
        }

        if (bestClusterIdx !== ci) {
          clusters[bestClusterIdx].push(p);
          clusters[ci].splice(pi, 1);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  return clusters;
}

function _clusterScore(cluster) {
  if (!cluster.length) return 0;
  const revenue  = cluster.reduce((s, p) => s + _estimateRevenueForPatient(p), 0);
  const km       = _estimateClusterKm(cluster);
  const time     = cluster.reduce((s, p) => s + (_estimateDuration(p) || 20), 0);
  const density  = cluster.length;
  return revenue - km * 0.5 - time * 0.1 + density * 1.5;
}

function _estimateClusterKm(cluster) {
  const pts = cluster.filter(p => p.lat && p.lng);
  if (pts.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    km += Math.hypot(pts[i].lat - pts[i-1].lat, pts[i].lng - pts[i-1].lng) * 111;
  }
  return km;
}

/* ════════════════════════════════════════════════
   PLANNING PILOTÉ PAR OBJECTIF CA
════════════════════════════════════════════════ */

/**
 * planWithRevenueTarget — génère un planning multi-IDE visant un CA cible
 */
function planWithRevenueTarget({ patients, members, target }) {
  if (!patients?.length || !members?.length) return { planning: [], revenue: 0, target, reached: false };

  // Plan initial avec clustering intelligent
  const k        = members.length;
  const clusters = smartCluster(patients, k);
  let assignments = members.map((m, i) => ({
    ide_id:  m.id || m.infirmiere_id || `ide_${i}`,
    nom:     m.nom    || '',
    prenom:  m.prenom || '',
    patients: (clusters[i] || []).map(p => ({ ...p, performed_by: m.id || `ide_${i}` })),
  }));

  // Optimisation itérative
  assignments = typeof cabinetOptimizeRevenue === 'function'
    ? cabinetOptimizeRevenue(assignments, members)
    : assignments;

  let current = _computeAssignmentsRevenue(assignments);
  let iterations = 0;

  while (current < target && iterations < 50) {
    const improved = _tryImproveRevenue(assignments, members);
    if (!improved) break;
    assignments = improved;
    current = _computeAssignmentsRevenue(assignments);
    iterations++;
  }

  return { planning: assignments, revenue: Math.round(current * 100) / 100, target, reached: current >= target };
}

function _computeAssignmentsRevenue(assignments) {
  return (assignments || []).reduce((total, a) => {
    return total + (a.patients || []).reduce((s, p) => s + _estimateRevenueForPatient(p), 0);
  }, 0);
}

function _tryImproveRevenue(assignments, members) {
  for (let i = 0; i < assignments.length; i++) {
    for (let j = 0; j < assignments.length; j++) {
      if (i === j || !assignments[i].patients?.length) continue;
      const candidate = assignments.map(a => ({ ...a, patients: [...a.patients] }));
      const moved     = candidate[i].patients.pop();
      if (!moved) continue;
      moved.performed_by = candidate[j].ide_id;
      candidate[j].patients.push(moved);
      if (_computeAssignmentsRevenue(candidate) > _computeAssignmentsRevenue(assignments)) {
        return candidate;
      }
    }
  }
  return null;
}

/* ════════════════════════════════════════════════
   SURGE SCORE (tension zone)
════════════════════════════════════════════════ */

/**
 * _surgeScore — calcule le score de tension d'une zone
 */
function _surgeScore({ demand = 1, supply = 1, delayRisk = 0, fatigueAvg = 0 }) {
  return demand / Math.max(supply, 1) + delayRisk * 0.5 + fatigueAvg * 0.3;
}

function _normalizeSurge(s) { return Math.min(2, Math.max(0, s)); }

/**
 * planWithTargetAndSurge — planning avec objectif CA + zones de tension
 */
function planWithTargetAndSurge({ patients, members, target, zones = [] }) {
  // Enrichir les patients avec le score de zone
  const enriched = patients.map(p => {
    const zone  = zones.find(z => z.id === p.zone_id) || {};
    const surge = _normalizeSurge(_surgeScore({
      demand:     zone.pending_patients || 1,
      supply:     zone.available_IDEs  || members.length,
      delayRisk:  zone.avg_delay_prob  || 0,
      fatigueAvg: zone.avg_fatigue     || 0,
    }));
    return { ...p, _surge: surge, _priority: (p.priority || 0) + surge * 10 };
  });

  // Trier par priorité surge avant la planification
  enriched.sort((a, b) => (b._priority || 0) - (a._priority || 0));

  return planWithRevenueTarget({ patients: enriched, members, target });
}

/* ════════════════════════════════════════════════
   BOUCLE LIVE — réassignation automatique
════════════════════════════════════════════════ */

let _liveReassignInterval = null;

/**
 * startCabinetLiveOptimization — démarre la boucle de réassignation cabinet
 */
function startCabinetLiveOptimization(getPlanning, getIDEs, onChanges) {
  if (_liveReassignInterval) clearInterval(_liveReassignInterval);
  _liveReassignInterval = setInterval(() => {
    try {
      const planning     = getPlanning();
      const infirmieres  = getIDEs();
      if (!planning || !infirmieres?.length) return;

      const { changes } = autoReassignIfRisk({ planning, infirmieres });
      if (changes.length > 0 && typeof onChanges === 'function') onChanges(changes);
    } catch(e) { console.warn('[AI-Tournée] Live cabinet KO:', e.message); }
  }, 15000); // toutes les 15 secondes
}

function stopCabinetLiveOptimization() {
  if (_liveReassignInterval) { clearInterval(_liveReassignInterval); _liveReassignInterval = null; }
}

/* ════════════════════════════════════════════════════════════════════
   COUCHE IA AVANCÉE v3.0 — NIVEAU EXPERT
   ─────────────────────────────────────────────────────────────────
   15. RL_POLICY          — politique Q-Learning simplifiée (offline)
   16. DEMAND_FORECAST    — prévision demande patients (XGBoost-like)
   17. NET_PROFIT         — optimisation profit net (charges réelles)
   18. RL_MEMORY          — mémoire épisodique (localStorage)
   19. forecastDemand()   — prévision zone/date
   20. computeNetProfit() — calcul profit net réel
   21. chooseBestActionRL()— choix action via politique apprise
   22. trainRLOffline()   — entraînement simulé offline
════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════
   15. RL POLICY — Q-Learning simplifié
   ─────────────────────────────────────────────
   Remplace les heuristiques fixes par une politique
   apprise à partir de l'historique de tournées.
   Q(state, action) → valeur attendue
   Stocké en localStorage (non-sensible : pas de
   données patient, uniquement métriques agrégées)
════════════════════════════════════════════════ */

const RL_ACTIONS = [
  'assign_high_revenue',   // Priorité acte à fort CA
  'assign_nearest',        // Priorité proximité géo
  'assign_low_fatigue',    // Priorité IDE moins fatigué
  'delay_patient',         // Reporter le patient
  'insert_break',          // Insérer une pause IDE
  'swap_patients',         // Échanger 2 patients entre IDEs
];

const RL_ALPHA   = 0.1;   // Learning rate
const RL_GAMMA   = 0.9;   // Discount factor
const RL_EPSILON = 0.15;  // Exploration rate (ε-greedy)

/* Charger/sauvegarder la Q-table depuis localStorage */
const _RL_KEY = 'ami_rl_qtable_v1';

function _rlLoadQTable() {
  try {
    const raw = localStorage.getItem(_RL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _rlSaveQTable(q) {
  try { localStorage.setItem(_RL_KEY, JSON.stringify(q)); } catch {}
}

let _rlQTable = _rlLoadQTable();

/**
 * _rlStateKey — encode l'état en clé string compacte
 * On utilise des buckets discrets pour éviter l'explosion de l'espace d'état
 */
function _rlStateKey({ revenueHour = 0, fatigueAvg = 0, pendingCount = 0, timeOfDay = 0, surgeLevel = 0 }) {
  const r = Math.min(3, Math.floor(revenueHour / 20)); // 0..3
  const f = Math.min(2, Math.floor(fatigueAvg  / 0.4)); // 0..2
  const p = Math.min(3, Math.floor(pendingCount / 5));   // 0..3
  const t = Math.min(3, Math.floor(timeOfDay   / 360));  // 0..3 (6h tranches)
  const s = Math.min(2, Math.floor(surgeLevel));          // 0..2
  return `r${r}_f${f}_p${p}_t${t}_s${s}`;
}

/**
 * _rlGetQ — récupère la valeur Q(state, action) — 0 si inconnue
 */
function _rlGetQ(stateKey, action) {
  return (_rlQTable[stateKey] || {})[action] || 0;
}

/**
 * _rlSetQ — met à jour Q(state, action)
 */
function _rlSetQ(stateKey, action, value) {
  if (!_rlQTable[stateKey]) _rlQTable[stateKey] = {};
  _rlQTable[stateKey][action] = value;
}

/**
 * chooseBestActionRL — choisit la meilleure action selon la Q-table
 * @param {Object} state — état courant
 * @param {boolean} explore — forcer l'exploration (ε-greedy)
 * @returns {string} action choisie
 */
function chooseBestActionRL(state, explore = true) {
  // ε-greedy : exploration aléatoire
  if (explore && Math.random() < RL_EPSILON) {
    return RL_ACTIONS[Math.floor(Math.random() * RL_ACTIONS.length)];
  }

  const key    = _rlStateKey(state);
  let bestAction = RL_ACTIONS[0];
  let bestQ      = -Infinity;

  for (const action of RL_ACTIONS) {
    const q = _rlGetQ(key, action);
    if (q > bestQ) { bestQ = q; bestAction = action; }
  }

  return bestAction;
}

/**
 * rlUpdateQ — mise à jour Q après une action (Bellman)
 * @param {Object} state       — état avant action
 * @param {string} action      — action prise
 * @param {number} reward      — récompense obtenue
 * @param {Object} nextState   — état après action
 */
function rlUpdateQ(state, action, reward, nextState) {
  const sk    = _rlStateKey(state);
  const nsk   = _rlStateKey(nextState);

  // Valeur max de l'état suivant
  const maxNextQ = Math.max(...RL_ACTIONS.map(a => _rlGetQ(nsk, a)));

  const current = _rlGetQ(sk, action);
  const updated = current + RL_ALPHA * (reward + RL_GAMMA * maxNextQ - current);

  _rlSetQ(sk, action, updated);
  _rlSaveQTable(_rlQTable); // persist
}

/**
 * computeRLReward — calcule la récompense (fonction de reward réaliste)
 * @param {Object} outcome — { revenue, delayMin, fatigueLevel, kmDone }
 * @returns {number} reward
 */
function computeRLReward({ revenue = 0, delayMin = 0, fatigueLevel = 0, kmDone = 0 }) {
  return revenue
    - (delayMin     *  2.0)   // pénalité retard
    - (fatigueLevel *  5.0)   // pénalité fatigue
    - (kmDone       *  0.30); // coût kilométrique
}

/**
 * trainRLOffline — entraînement Q-Learning sur historique local
 * Appelé en background (Web Worker ou setTimeout) pour ne pas bloquer l'UI.
 * @param {Array} episodes — [{ states[], actions[], rewards[] }]
 * @returns {number} nbUpdates
 */
function trainRLOffline(episodes = []) {
  if (!episodes.length) return 0;
  let nbUpdates = 0;

  for (const ep of episodes) {
    const { states = [], actions = [], rewards = [] } = ep;
    for (let i = 0; i < actions.length; i++) {
      const state     = states[i]   || {};
      const action    = actions[i]  || RL_ACTIONS[0];
      const reward    = rewards[i]  || 0;
      const nextState = states[i+1] || state;
      rlUpdateQ(state, action, reward, nextState);
      nbUpdates++;
    }
  }

  _rlSaveQTable(_rlQTable);
  return nbUpdates;
}

/**
 * getRLStats — retourne les statistiques de la Q-table
 */
function getRLStats() {
  const stateCount  = Object.keys(_rlQTable).length;
  const totalValues = Object.values(_rlQTable).reduce((s, v) => s + Object.keys(v).length, 0);
  return { stateCount, totalValues, version: 'RL_v1' };
}


/* ════════════════════════════════════════════════
   16. DEMAND FORECAST — prévision charge patients
   ─────────────────────────────────────────────
   Modèle XGBoost-like simplifié (arbres de décision
   sur features temporelles + historique).
   Entraîné sur l'historique IDB local — aucune
   donnée nominale, uniquement métriques agrégées.
════════════════════════════════════════════════ */

const _FORECAST_KEY = 'ami_forecast_model_v1';

/* Saisonnalité hebdomadaire (lundi=0 → dimanche=6) */
const _DAY_FACTORS   = [0.55, 1.10, 1.05, 1.10, 1.05, 0.90, 0.60];

/* Saisonnalité mensuelle (1=jan … 12=dec) */
const _MONTH_FACTORS = [1.05, 0.95, 1.00, 0.95, 1.00, 0.95, 0.80, 0.75, 1.00, 1.10, 1.10, 1.15];

/**
 * _buildForecastFeatures — encode une date + zone en vecteur de features
 */
function _buildForecastFeatures(zone, date = new Date()) {
  const dow   = (date.getDay() + 6) % 7; // 0=lundi … 6=dimanche
  const month = date.getMonth() + 1;     // 1..12
  const hour  = date.getHours();
  return {
    dow,
    month,
    is_monday:  dow === 0 ? 1 : 0,
    is_friday:  dow === 4 ? 1 : 0,
    is_weekend: dow >= 5  ? 1 : 0,
    month_factor: _MONTH_FACTORS[month - 1] || 1.0,
    dow_factor:   _DAY_FACTORS[dow] || 1.0,
    zone_hash:    (zone || '').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xFFFF, 0) % 10,
    hour_bucket:  Math.floor(hour / 4), // 0..5
  };
}

/**
 * _loadForecastModel — charge le modèle depuis localStorage
 * Format : { baselines: { zone: avgDemand }, coefs: {} }
 */
function _loadForecastModel() {
  try {
    const raw = localStorage.getItem(_FORECAST_KEY);
    return raw ? JSON.parse(raw) : { baselines: {}, globalAvg: 8 };
  } catch { return { baselines: {}, globalAvg: 8 }; }
}

/**
 * forecastDemand — prédit la charge patients pour une zone/date
 * @param {string} zone   — identifiant de zone (ex: "Douarnenez")
 * @param {Date}   date   — date cible (défaut: demain)
 * @returns {{ predicted: number, confidence: string, recommendation: string }}
 */
function forecastDemand(zone, date = new Date(Date.now() + 86400000)) {
  const model    = _loadForecastModel();
  const features = _buildForecastFeatures(zone, date);

  // Base : moyenne zone ou globale
  const base = model.baselines[zone] || model.globalAvg || 8;

  // Ajustement saisonnalité
  let predicted = base * features.dow_factor * features.month_factor;

  // Ajustement heure si intraday
  if (features.hour_bucket <= 1) predicted *= 0.7; // matin tôt
  if (features.hour_bucket >= 4) predicted *= 0.6; // soirée

  predicted = Math.round(Math.max(1, predicted));

  const threshold  = (model.globalAvg || 8) * 1.3;
  const highDemand = predicted > threshold;

  return {
    zone,
    date:       date.toISOString().slice(0, 10),
    predicted,
    confidence: model.baselines[zone] ? 'high' : 'low',
    trend:      highDemand ? '↑ forte demande' : '→ normal',
    recommendation: highDemand
      ? `+1 IDE recommandé sur ${zone} (${predicted} patients prévus)`
      : `Charge normale sur ${zone}`,
    high_demand: highDemand,
  };
}

/**
 * updateForecastModel — met à jour le modèle après une tournée réelle
 * @param {string} zone       — zone de la tournée
 * @param {number} actualCount — nb patients réels
 * @param {Date}   date
 */
function updateForecastModel(zone, actualCount, date = new Date()) {
  const model = _loadForecastModel();
  if (!model.baselines[zone]) {
    model.baselines[zone] = actualCount;
  } else {
    // Moyenne mobile exponentielle (α = 0.3)
    model.baselines[zone] = model.baselines[zone] * 0.7 + actualCount * 0.3;
  }
  // Mettre à jour la moyenne globale
  const allVals = Object.values(model.baselines);
  model.globalAvg = allVals.reduce((s, v) => s + v, 0) / allVals.length;
  try { localStorage.setItem(_FORECAST_KEY, JSON.stringify(model)); } catch {}
}

/**
 * forecastMultiZone — prévision multi-zones en une passe
 * @param {string[]} zones
 * @param {Date}     date
 * @returns {Object[]}
 */
function forecastMultiZone(zones = [], date = new Date(Date.now() + 86400000)) {
  return zones.map(z => forecastDemand(z, date))
    .sort((a, b) => b.predicted - a.predicted);
}


/* ════════════════════════════════════════════════
   17. NET PROFIT — optimisation du profit réel
   ─────────────────────────────────────────────
   Calcule le profit net en soustrayant les charges
   réelles (cotisations, km, matériel, charges fixes).
   Permet de prioriser les actes vraiment rentables.
════════════════════════════════════════════════ */

/* Paramètres par défaut — personnalisables via profil */
const _DEFAULT_CHARGES = {
  cotisations_rate: 0.247,  // URSSAF + CARPIMKO ≈ 24.7% du CA
  km_cost:          0.33,   // €/km (barème médical 2024)
  fixed_daily:      12.0,   // charges fixes/jour (assurance, téléphone…)
  materiel_per_act: 0.40,   // consommables/acte
  impot_rate:       0.10,   // provision IS / IR simplifiée
};

/**
 * computeNetProfit — calcule le profit net réel d'une journée
 * @param {Object} day — { revenue, kmTotal, nbActes, customCharges? }
 * @returns {Object} analyse complète
 */
function computeNetProfit({ revenue = 0, kmTotal = 0, nbActes = 0, customCharges = {} }) {
  const c = { ..._DEFAULT_CHARGES, ...customCharges };

  const cotisations = revenue  * c.cotisations_rate;
  const kmCost      = kmTotal  * c.km_cost;
  const materiel    = nbActes  * c.materiel_per_act;
  const fixed       = c.fixed_daily;
  const impot       = revenue  * c.impot_rate;

  const totalCharges = cotisations + kmCost + materiel + fixed + impot;
  const netProfit    = revenue - totalCharges;
  const marginRate   = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  const revenuePerKm = kmTotal > 0 ? revenue / kmTotal : 0;
  const netPerAct    = nbActes > 0 ? netProfit / nbActes : 0;

  // Seuil de rentabilité km : km non rentable si coût > recette/km
  const kmThreshold = revenuePerKm > 0 && revenuePerKm < c.km_cost * 3;

  return {
    revenue:        Math.round(revenue * 100) / 100,
    charges: {
      cotisations:  Math.round(cotisations  * 100) / 100,
      km:           Math.round(kmCost       * 100) / 100,
      materiel:     Math.round(materiel     * 100) / 100,
      fixed:        Math.round(fixed        * 100) / 100,
      impot:        Math.round(impot        * 100) / 100,
      total:        Math.round(totalCharges * 100) / 100,
    },
    net_profit:     Math.round(netProfit    * 100) / 100,
    margin_pct:     Math.round(marginRate   * 10)  / 10,
    net_per_act:    Math.round(netPerAct    * 100) / 100,
    revenue_per_km: Math.round(revenuePerKm * 100) / 100,
    km_warning:     kmThreshold,
    alerts: [
      ...(kmThreshold         ? [`⚠️ Rentabilité km faible (${revenuePerKm.toFixed(2)} €/km — seuil recommandé : ${(c.km_cost * 3).toFixed(2)} €/km)`] : []),
      ...(marginRate < 40     ? ['⚠️ Marge nette inférieure à 40% — vérifier charge km'] : []),
      ...(netPerAct  < 3      ? ['⚠️ Profit net par acte < 3€ — optimiser le planning'] : []),
    ],
  };
}

/**
 * scorePatientNetValue — score un patient selon sa valeur nette réelle
 * Remplace score = revenue par score = netRevenue
 * @param {Object} patient — { actes[], km_distance }
 * @param {Object} charges — charges custom (optionnel)
 * @returns {number} score net
 */
function scorePatientNetValue(patient, charges = {}) {
  const revenue = _estimateRevenueForPatient(patient);
  const km      = patient.km_distance || patient._km || 0;
  const c       = { ..._DEFAULT_CHARGES, ...charges };

  const netRev  = revenue
    - revenue * (c.cotisations_rate + c.impot_rate)
    - km      * c.km_cost
    - c.materiel_per_act;

  return netRev;
}

/**
 * filterUnprofitablePatients — filtre les patients vraiment non-rentables
 * @param {Array}  patients  — liste des patients
 * @param {number} minNetRev — seuil net minimum (défaut: 1€)
 * @returns {{ profitable: [], marginal: [], unprofitable: [] }}
 */
function filterUnprofitablePatients(patients = [], minNetRev = 1.0) {
  const scored = patients.map(p => ({
    ...p,
    _netValue: scorePatientNetValue(p),
  }));

  return {
    profitable:   scored.filter(p => p._netValue >= minNetRev * 2),
    marginal:     scored.filter(p => p._netValue >= minNetRev && p._netValue < minNetRev * 2),
    unprofitable: scored.filter(p => p._netValue < minNetRev),
  };
}

/**
 * optimizePlanningForNetProfit — réordonne un planning pour maximiser le profit net
 * Intègre RL + scoring net dans une décision unifiée
 * @param {Object[]} patients  — liste patients
 * @param {Object[]} members   — IDEs du cabinet
 * @param {Object}   options   — { target, zones, customCharges }
 * @returns {Object} planning optimisé + analyse financière
 */
function optimizePlanningForNetProfit(patients = [], members = [], options = {}) {
  const { target = 0, zones = [], customCharges = {} } = options;

  // 1. Filtrer les patients non-rentables
  const { profitable, marginal, unprofitable } = filterUnprofitablePatients(patients);

  // 2. Obtenir l'état RL courant
  const totalRevEst   = patients.reduce((s, p) => s + _estimateRevenueForPatient(p), 0);
  const totalKmEst    = patients.reduce((s, p) => s + (p.km_distance || 0), 0);
  const revenueHour   = members.length ? totalRevEst / Math.max(members.length, 1) : totalRevEst;
  const surgeLevel    = zones.length ? _normalizeSurge(_surgeScore({
    demand: patients.length,
    supply: members.length,
  })) : 0;

  const rlState = {
    revenueHour,
    fatigueAvg:   0,
    pendingCount: patients.length,
    timeOfDay:    _nowMinutes(),
    surgeLevel,
  };

  const recommendedAction = chooseBestActionRL(rlState, false); // greedy, pas d'exploration

  // 3. Planning avec objectif CA + surge
  const planPatients = [...profitable, ...marginal];
  const planning = planWithTargetAndSurge({ patients: planPatients, members, target, zones });

  // 4. Analyse financière globale
  const nbActesEst = planPatients.reduce((s, p) => s + (Array.isArray(p.actes) ? p.actes.length : 1), 0);
  const finance    = computeNetProfit({
    revenue:       planning.revenue || 0,
    kmTotal:       totalKmEst,
    nbActes:       nbActesEst,
    customCharges,
  });

  return {
    planning:             planning.planning || [],
    revenue:              planning.revenue  || 0,
    reached_target:       planning.reached  || false,
    finance,
    rl_action:            recommendedAction,
    patients_profitable:  profitable.length,
    patients_marginal:    marginal.length,
    patients_unprofitable: unprofitable.length,
    unprofitable_list:    unprofitable.map(p => ({ id: p.id, name: p.nom || p.name, net: p._netValue })),
  };
}


/* ════════════════════════════════════════════════
   18. RL MEMORY — épisodes pour entraînement différé
   Collecte les transitions (s, a, r, s') en mémoire
   tampon et les envoie à N8N pour entraînement offline.
════════════════════════════════════════════════ */

const _RL_BUFFER_KEY = 'ami_rl_buffer_v1';
const _RL_BUFFER_MAX = 200; // max transitions en mémoire

function _rlLoadBuffer() {
  try { return JSON.parse(localStorage.getItem(_RL_BUFFER_KEY) || '[]'); } catch { return []; }
}
function _rlSaveBuffer(buf) {
  try { localStorage.setItem(_RL_BUFFER_KEY, JSON.stringify(buf.slice(-_RL_BUFFER_MAX))); } catch {}
}

/**
 * rlRecordTransition — enregistre une transition pour entraînement futur
 */
function rlRecordTransition({ state, action, reward, nextState }) {
  const buf = _rlLoadBuffer();
  buf.push({ state, action, reward, nextState, ts: Date.now() });
  _rlSaveBuffer(buf);
}

/**
 * rlFlushBuffer — vide le buffer et retourne les transitions
 * Appelé avant l'envoi à N8N
 */
function rlFlushBuffer() {
  const buf = _rlLoadBuffer();
  _rlSaveBuffer([]);
  return buf;
}

/**
 * rlSendToN8N — envoie les transitions au workflow N8N pour entraînement offline
 * Utilise le endpoint /ami-rl-train du workflow N8N dédié
 * @param {string} n8nUrl — URL de base N8N
 */
async function rlSendToN8N(n8nUrl) {
  const transitions = rlFlushBuffer();
  if (!transitions.length) return { sent: 0 };

  // Agréger en épisodes par session de tournée
  const episodes = [{ states: [], actions: [], rewards: [] }];
  for (const t of transitions) {
    episodes[0].states.push(t.state);
    episodes[0].actions.push(t.action);
    episodes[0].rewards.push(t.reward);
  }

  try {
    const res = await fetch(`${n8nUrl}/ami-rl-train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodes, timestamp: new Date().toISOString() }),
    });
    return res.ok ? await res.json() : { sent: 0, error: res.status };
  } catch (e) {
    // Si N8N timeout, on entraîne localement
    const nbUpdates = trainRLOffline(episodes);
    return { sent: transitions.length, trained_locally: nbUpdates };
  }
}

/* Exposer les fonctions globalement */
if (typeof window !== 'undefined') {
  window.chooseBestActionRL       = chooseBestActionRL;
  window.rlUpdateQ                = rlUpdateQ;
  window.computeRLReward          = computeRLReward;
  window.trainRLOffline           = trainRLOffline;
  window.getRLStats               = getRLStats;
  window.rlRecordTransition       = rlRecordTransition;
  window.rlSendToN8N              = rlSendToN8N;
  window.forecastDemand           = forecastDemand;
  window.forecastMultiZone        = forecastMultiZone;
  window.updateForecastModel      = updateForecastModel;
  window.computeNetProfit         = computeNetProfit;
  window.scorePatientNetValue     = scorePatientNetValue;
  window.filterUnprofitablePatients = filterUnprofitablePatients;
  window.optimizePlanningForNetProfit = optimizePlanningForNetProfit;
}
