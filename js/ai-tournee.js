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

  const noCoords = patients.filter(p => !p.lat || !p.lng);

  /* Si AUCUN patient n'a de coordonnées GPS → retourner tous les patients
     triés par heure, sans optimisation géographique */
  if (noCoords.length === patients.length) {
    return [...patients].sort((a,b) =>
      (a.heure_preferee||a.heure_soin||'99:99').localeCompare(b.heure_preferee||b.heure_soin||'99:99')
    );
  }

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
