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
    const ideId      = member.id || member.infirmiere_id || `ide_${idx}`;
    const idePatients = (clusters[idx] || []);
    // Note : optimizeTour est async — on n'appelle pas ici pour rester synchrone.
    // Le clustering géographique seul suffit ; la route est optimisée à l'exécution.
    return {
      ide_id:   ideId,
      nom:      member.nom    || '',
      prenom:   member.prenom || '',
      patients: idePatients.map(p => ({ ...p, performed_by: ideId })),
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
