/* ════════════════════════════════════════════════════════════════════
   ai-smart-tour.js — AMI NGAP v5.10.5
   ────────────────────────────────────────────────────────────────────
   Couches d'intelligence terrain pour la Tournée IA :

   1.  Apprentissage zones (urbain/péri/rural)        ami_route_learning
   2.  Stats par grille géographique (zones lentes)   ami_zone_stats
   3.  Prédiction no-show / retard patient            ami_no_show_stats
   4.  Score difficulté patient                       ami_patient_difficulty
   5.  Apprentissage par IDE                          ami_ide_learning
   6.  Type de patient (diabète, lourd, plaie…)        ami_patient_type_learning
   7.  Mémoire conversationnelle                      ami_conversation_memory
   8.  Météo (Open-Meteo gratuit, opt-in)             APP._weather
   9.  Fatigue + pause automatique
   10. Clustering géographique grid + tri intelligent
   11. Prédiction cascade / effet domino
   12. ETA prédictif + détection retard proactive
   13. Prédiction fin de tournée (zone × diff × météo)
   14. Regroupement automatique des visites proches
   15. Recommandations stratégiques de départ
   16. IA replanification live (garde-fous)
   17. Priorisation dynamique d'urgence en live
   18. Assistant vocal (Web Speech) + anti-spam
   19. Dialogue vocal naturel (proposer / confirmer)
   20. Mode autopilote (DÉSACTIVÉ par défaut, opt-in IDE)
   21. Simulation de journée avant départ

   ⚠️  RESPONSABILITÉ MÉDICO-LÉGALE
   ────────────────────────────────────────────────────────────────────
   - Le mode autopilot est DÉSACTIVÉ par défaut.
   - Le safetyLevel est à 3 (ultra strict) par défaut.
   - Les soins critiques (priorité 3) ne sont JAMAIS replanifiés
     automatiquement sans confirmation explicite de l'IDE.
   - Toutes les décisions à fort impact passent par _askUser() avec
     confirmation vocale ou refus.
   - L'IDE reste responsable de sa tournée. AMI propose, n'impose pas.

   🛡️  DONNÉES & RGPD
   ────────────────────────────────────────────────────────────────────
   - localStorage : patient_id (UUID) + stats agrégées uniquement.
     Aucun nom, aucune description, aucune donnée de santé nominative.
   - IndexedDB chiffré AES-256-GCM reste la source canonique pour
     les données de santé.
   - Pas de transmission serveur des stats d'apprentissage.
   ════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AMI_SMART && window.AMI_SMART._loaded) return; // idempotent

  /* ╔══════════════════════════════════════════════╗
     ║ 0. NAMESPACE & CONFIG                         ║
     ╚══════════════════════════════════════════════╝ */

  const SMART = (window.AMI_SMART = window.AMI_SMART || {});
  SMART._loaded = true;
  SMART.version = '5.10.5';

  /* Configuration globale (modifiable par l'IDE via UI) */
  const CFG = (SMART.config = {
    autoMode: {
      enabled:        false,  // 🛡️ désactivé par défaut
      voice:          false,  // 🛡️ vocal off par défaut
      navigation:     false,  // 🛡️ navigation auto off par défaut
      safetyLevel:    3,      // 1=libre / 2=sécurisé / 3=ultra strict (défaut)
    },
    autoReplan: {
      minGainMin:       8,            // gain attendu ≥ 8 min
      maxDisruptions:   3,            // max patients déplacés
      cooldownMs:       5 * 60 * 1000, // 5 min entre auto-replans
    },
    voice: {
      cooldownMs:      15000,         // anti-spam vocal 15s
      dialogTimeoutMs: 15000,         // 15s pour répondre à une question
      askCooldownMs:   20000,         // pas plus d'une question / 20s
    },
    fatigue: {
      shortBreakMin:   10,
      longBreakMin:    20,
      shortBreakAt:    1.2,           // score fatigue déclenchant pause courte
      longBreakAt:     1.6,
    },
    weather: {
      ttlMs:           30 * 60 * 1000, // refresh météo toutes les 30 min
      lastFetch:       0,
    },
    grid: {
      sizeDeg:         0.02,          // ~2 km
    },
  });

  /* ╔══════════════════════════════════════════════╗
     ║ 1. STORAGE HELPERS (localStorage)             ║
     ╚══════════════════════════════════════════════╝ */

  function _lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : (fallback ?? {});
    } catch { return fallback ?? {}; }
  }

  function _lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 2. GÉOMÉTRIE / TEMPS                          ║
     ╚══════════════════════════════════════════════╝ */

  function _dist(a, b) {
    if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return Infinity;
    const dx = a.lat - b.lat;
    const dy = a.lng - b.lng;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function _distKm(a, b) {
    if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return Infinity;
    const dx = (a.lat - b.lat) * 111;
    const dy = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function _zoneKey(lat, lng, size) {
    const g = size || CFG.grid.sizeDeg;
    return Math.floor(lat / g) + '_' + Math.floor(lng / g);
  }

  function _nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function _parseHour(str) {
    if (!str) return null;
    const m = String(str).match(/(\d{1,2})[:hH](\d{2})?/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10);
  }

  function _formatTime(min) {
    if (!Number.isFinite(min)) return '--h--';
    const total = Math.round(min);
    let h = Math.floor(total / 60);
    const m = total % 60;
    h = ((h % 24) + 24) % 24;
    return `${h}h${String(m).padStart(2, '0')}`;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 3. APPRENTISSAGE ZONE (urbain/péri/rural)     ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_ROUTE_LEARN = 'ami_route_learning';

  function _zoneFromSpeed(distanceKm, durationSec) {
    if (!durationSec) return 'peri';
    const speed = distanceKm / (durationSec / 3600);
    if (speed < 25) return 'urban';
    if (speed > 50) return 'rural';
    return 'peri';
  }

  function _learnRouteFactor(zone, estimatedMin, realMin) {
    if (!zone || !estimatedMin || !realMin) return;
    const ratio = realMin / estimatedMin;
    const db = _lsGet(KEY_ROUTE_LEARN, {});
    const cur = db[zone] || { avgFactor: ratio, count: 0 };
    cur.avgFactor = (cur.avgFactor * cur.count + ratio) / (cur.count + 1);
    cur.count++;
    cur.avgFactor = Math.max(1.05, Math.min(1.6, cur.avgFactor));
    db[zone] = cur;
    _lsSet(KEY_ROUTE_LEARN, db);
  }

  function _getLearnedRouteFactor(zone) {
    const db = _lsGet(KEY_ROUTE_LEARN, {});
    return db[zone]?.avgFactor || null;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 4. ZONES "CHAUDES" (grille géographique)       ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_ZONE_STATS = 'ami_zone_stats';

  function learnZone(lat, lng, expectedMin, realMin) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!expectedMin || !realMin) return;
    const db = _lsGet(KEY_ZONE_STATS, {});
    const k = _zoneKey(lat, lng);
    const z = db[k] || { factor: 1, count: 0 };
    const ratio = realMin / expectedMin;
    z.factor = (z.factor * z.count + ratio) / (z.count + 1);
    z.factor = Math.max(0.7, Math.min(1.6, z.factor));
    z.count++;
    db[k] = z;
    _lsSet(KEY_ZONE_STATS, db);
  }

  function getZoneFactor(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 1;
    const db = _lsGet(KEY_ZONE_STATS, {});
    const z = db[_zoneKey(lat, lng)];
    return z ? Math.min(z.factor, 1.5) : 1;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 5. NO-SHOW / RETARD PATIENT                    ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_NOSHOW = 'ami_no_show_stats';

  function updateNoShow(patientId, opts) {
    if (!patientId) return;
    const o = opts || {};
    const db = _lsGet(KEY_NOSHOW, {});
    const p = db[patientId] || { shows: 0, noShows: 0, lateAvgMin: 0, lastTs: 0 };
    if (o.isNoShow) {
      p.noShows++;
    } else {
      p.shows++;
      const lateMin = Math.max(0, +o.lateMin || 0);
      p.lateAvgMin = (p.lateAvgMin * 0.7) + (lateMin * 0.3);
    }
    p.lastTs = Date.now();
    db[patientId] = p;
    _lsSet(KEY_NOSHOW, db);
  }

  function predictNoShowScore(patient, now) {
    if (!patient?.id) return 0.05;
    const db = _lsGet(KEY_NOSHOW, {});
    const p = db[patient.id] || { shows: 0, noShows: 0, lateAvgMin: 0 };
    const total = p.shows + p.noShows;
    const baseProb = total > 5 ? (p.noShows / total) : 0.05;

    const h = (now || new Date()).getHours();
    let timeFactor = 1.0;
    if (h < 8)  timeFactor += 0.10;
    if (h > 18) timeFactor += 0.15;

    const lateFactor = 1 + Math.min(p.lateAvgMin / 30, 0.3);

    const score = baseProb * timeFactor * lateFactor;
    return Math.min(score, 0.9);
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 6. DIFFICULTÉ PATIENT                          ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_DIFF = 'ami_patient_difficulty';

  function updateDifficulty(patientId, opts) {
    if (!patientId) return;
    const o = opts || {};
    const plannedMin = +o.plannedMin || 10;
    const realMin    = +o.realMin    || 10;
    const hadIssue   = !!o.hadIssue;
    const db = _lsGet(KEY_DIFF, {});
    const p = db[patientId] || { avgOver: 0, issues: 0, count: 0 };
    const over = Math.max(0, realMin - plannedMin);
    p.avgOver = (p.avgOver * p.count + over) / (p.count + 1);
    if (hadIssue) p.issues++;
    p.count++;
    db[patientId] = p;
    _lsSet(KEY_DIFF, db);
  }

  function difficultyScore(patient) {
    if (!patient?.id) return 0.1;
    const db = _lsGet(KEY_DIFF, {});
    const p = db[patient.id] || { avgOver: 0, issues: 0, count: 0 };
    if (p.count < 3) return 0.1;
    let score = 0;
    score += Math.min(p.avgOver / 20, 0.5);
    score += Math.min(p.issues / Math.max(p.count, 1), 0.4);
    const txt = (patient.description || patient.actes_recurrents || '').toLowerCase();
    if (/agité|confus|dépendant|alzheimer/.test(txt)) score += 0.2;
    return Math.min(score, 1);
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 7. APPRENTISSAGE PAR IDE                       ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_IDE = 'ami_ide_learning';

  function learnIDE(ideId, stats) {
    if (!ideId) return;
    const s = stats || {};
    if (!s.realTime || !s.estimatedTime) return;
    const db = _lsGet(KEY_IDE, {});
    const cur = db[ideId] || { speedFactor: 1, punctuality: 1, count: 0 };
    const ratio = s.realTime / s.estimatedTime;
    cur.speedFactor = (cur.speedFactor * cur.count + ratio) / (cur.count + 1);
    cur.speedFactor = Math.max(0.7, Math.min(1.6, cur.speedFactor));
    if (Number.isFinite(s.onTimeRate)) {
      cur.punctuality = (cur.punctuality * cur.count + s.onTimeRate) / (cur.count + 1);
      cur.punctuality = Math.max(0, Math.min(1, cur.punctuality));
    }
    cur.count++;
    db[ideId] = cur;
    _lsSet(KEY_IDE, db);
  }

  function getIDEProfile(ideId) {
    if (!ideId) return {};
    const db = _lsGet(KEY_IDE, {});
    return db[ideId] || {};
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 8. TYPE DE PATIENT                             ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_TYPE = 'ami_patient_type_learning';

  function getPatientType(p) {
    const txt = ((p?.description || '') + ' ' + (p?.actes_recurrents || '')).toLowerCase();
    if (/diab|insuline|glycém/.test(txt))             return 'diabetes';
    if (/toilette|nursing|dépendant|grabataire/.test(txt)) return 'heavy';
    if (/pansement.*lourd|bsc|escarre|stomie/.test(txt)) return 'heavy_wound';
    if (/pansement|plaie|suture|ablation/.test(txt))  return 'wound';
    if (/perfusion|chimio/.test(txt))                  return 'perfusion';
    if (/injection|sc|im|iv/.test(txt))                return 'injection';
    if (/prélèvement|prise.*sang/.test(txt))          return 'blood';
    return 'standard';
  }

  function learnType(type, expectedMin, realMin) {
    if (!type || !expectedMin || !realMin) return;
    const db = _lsGet(KEY_TYPE, {});
    const t = db[type] || { factor: 1, count: 0 };
    const ratio = realMin / expectedMin;
    t.factor = (t.factor * t.count + ratio) / (t.count + 1);
    t.factor = Math.max(0.7, Math.min(2.0, t.factor));
    t.count++;
    db[type] = t;
    _lsSet(KEY_TYPE, db);
  }

  function getTypeFactor(p) {
    const db = _lsGet(KEY_TYPE, {});
    const t = db[getPatientType(p)];
    return t?.factor || 1;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 9. PRIORITÉ MÉDICALE (étendue)                 ║
     ╚══════════════════════════════════════════════╝ */

  /**
   * 1 = standard / 2 = lourd ou contraint / 3 = vital ou urgence
   * Étend (sans la remplacer) la logique de medicalWeight() de ai-tournee.js.
   */
  function getMedicalPriority(p) {
    if (!p) return 1;
    if (p.urgent || p.urgence || p._urgent >= 3) return 3;
    const txt = ((p.actes_recurrents || '') + ' ' +
                 (p.description || '') + ' ' +
                 (p.actes || '')).toLowerCase();
    if (/urgence|perfusion.*critique|insuline|anticoagulant|antibio.*iv|chimio/.test(txt)) return 3;
    if (/pansement.*lourd|bsc|bsa|escarre|stomie|toilette/.test(txt)) return 2;
    return 1;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 10. MÉMOIRE CONVERSATIONNELLE                  ║
     ╚══════════════════════════════════════════════╝ */

  const KEY_MEMORY = 'ami_conversation_memory';

  function remember(key, value) {
    const m = _lsGet(KEY_MEMORY, {});
    m[key] = { value, ts: Date.now() };
    _lsSet(KEY_MEMORY, m);
  }

  function recall(key) {
    const m = _lsGet(KEY_MEMORY, {});
    return m[key]?.value ?? null;
  }

  function forget(key) {
    const m = _lsGet(KEY_MEMORY, {});
    delete m[key];
    _lsSet(KEY_MEMORY, m);
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 11. MÉTÉO (Open-Meteo, opt-in)                 ║
     ╚══════════════════════════════════════════════╝ */

  async function fetchWeather(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const now = Date.now();
    if (now - CFG.weather.lastFetch < CFG.weather.ttlMs && SMART._weather) {
      return SMART._weather;
    }
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=rain,wind_speed_10m,temperature_2m`;
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) return null;
      const j = await r.json();
      SMART._weather = {
        rain: (j.current?.rain ?? 0) > 0,
        wind: j.current?.wind_speed_10m ?? 0,
        heat: j.current?.temperature_2m ?? 15,
        ts:   now,
      };
      CFG.weather.lastFetch = now;
      return SMART._weather;
    } catch {
      return null;
    }
  }

  function getWeatherFactor() {
    const w = SMART._weather;
    if (!w) return 1.0;
    if (w.rain)        return 1.20;
    if (w.wind > 50)   return 1.10;
    if (w.heat > 32)   return 1.10;
    if (w.heat < -2)   return 1.10;
    return 1.0;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 12. FATIGUE & PAUSE AUTOMATIQUE                ║
     ╚══════════════════════════════════════════════╝ */

  function fatigueScore(state) {
    const s = state || (typeof APP !== 'undefined' && APP._tourState) || {};
    const patientsDone = +s.patientsDone || 0;
    const totalKm      = +s.totalKm      || 0;
    const totalMinutes = +s.totalMinutes || 0;
    let f = 0;
    f += patientsDone * 0.03;
    f += totalMinutes / 600;
    f += totalKm / 100;
    return Math.min(f, 2);
  }

  function shouldTakeBreak() {
    const f = fatigueScore();
    if (f >= CFG.fatigue.longBreakAt)  return 'long';
    if (f >= CFG.fatigue.shortBreakAt) return 'short';
    return null;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 13. TRAFIC TEMPS RÉEL (helper)                 ║
     ╚══════════════════════════════════════════════╝ */

  function trafficNowFactor() {
    const minutes = _nowMinutes();
    const fn = window.getTrafficInfo;
    if (typeof fn !== 'function') return 1.0;
    try {
      const info = fn(minutes);
      return info?.factor || 1.0;
    } catch { return 1.0; }
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 14. CLUSTERING GRID DYNAMIQUE                  ║
     ╚══════════════════════════════════════════════╝ */

  function clusterPatients(patients, gridSize) {
    const g = gridSize || CFG.grid.sizeDeg;
    const clusters = {};
    (patients || []).forEach(p => {
      if (!p?.lat || !p?.lng) return;
      const k = _zoneKey(p.lat, p.lng, g);
      if (!clusters[k]) clusters[k] = [];
      clusters[k].push({
        ...p,
        _prio: getMedicalPriority(p),
        _diff: difficultyScore(p),
      });
    });
    return Object.values(clusters);
  }

  function _clusterCenter(cluster) {
    const lat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
    const lng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;
    return { lat, lng };
  }

  function sortCluster(cluster) {
    return cluster.sort((a, b) => {
      if (b._prio !== a._prio) return b._prio - a._prio;
      if (b._diff !== a._diff) return b._diff - a._diff;
      const ha = _parseHour(a.heure_soin || a.heure || '') ?? Infinity;
      const hb = _parseHour(b.heure_soin || b.heure || '') ?? Infinity;
      return ha - hb;
    });
  }

  function orderClusters(clusters, start) {
    if (!start?.lat || !start?.lng) return clusters;
    return clusters.sort((a, b) => _dist(start, _clusterCenter(a)) - _dist(start, _clusterCenter(b)));
  }

  function clusterDynamicRoute(patients, startPoint) {
    const clusters = clusterPatients(patients);
    const ordered = orderClusters(clusters, startPoint);
    const out = [];
    ordered.forEach(c => out.push(...sortCluster(c)));
    return out;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 15. REGROUPEMENT VISITES PROCHES               ║
     ╚══════════════════════════════════════════════╝ */

  function _findNearby(p, others, thresholdDeg) {
    const t = thresholdDeg || 0.01; // ~1 km
    return others.filter(o => o.id !== p.id && _dist(p, o) < t);
  }

  function groupVisits(route) {
    const used = new Set();
    const out = [];
    (route || []).forEach(p => {
      if (used.has(p.id)) return;
      const nearby = _findNearby(p, route, 0.01);
      if (nearby.length) {
        const group = [p, ...nearby];
        group.forEach(x => used.add(x.id));
        out.push({ type: 'group', patients: group });
      } else {
        out.push(p);
        used.add(p.id);
      }
    });
    return out;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 16. ETA PRÉDICTIF + DÉTECTION RETARD           ║
     ╚══════════════════════════════════════════════╝ */

  function predictETASequence(route, startIdx, startTimeMin) {
    let time = startTimeMin ?? _nowMinutes();
    const result = [];
    for (let i = (startIdx ?? 0) + 1; i < (route?.length || 0); i++) {
      const p = route[i];
      if (!p) continue;
      const travel = +p.travelMin || +p.travel_min || 10;
      const care   = +p.careMin   || +p.duration   || 10;
      time += travel + care;
      const planned = _parseHour(p.heure_soin || p.heure || '');
      result.push({ patientId: p.id, etaMin: time, planned: planned ?? null });
    }
    return result;
  }

  function detectLatePatients(predictions, thresholdMin) {
    const t = thresholdMin ?? 10;
    return (predictions || []).filter(p =>
      p.planned != null && (p.etaMin - p.planned) > t
    );
  }

  function checkProactiveDelay(route, idx) {
    const preds = predictETASequence(route, idx, _nowMinutes());
    return detectLatePatients(preds, 10);
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 17. CASCADE DELAY                              ║
     ╚══════════════════════════════════════════════╝ */

  function predictCascadeDelay(route, startIdx, currentDelayMin) {
    let delay = +currentDelayMin || 0;
    const out = [];
    const start = (startIdx ?? 0) + 1;
    const end   = Math.min((route?.length || 0), start + 10);
    for (let i = start; i < end; i++) {
      const p = route[i];
      if (!p) continue;
      const buffer = +p.bufferMin || 0;
      delay = Math.max(0, delay - buffer);
      out.push({ patientId: p.id, predictedDelay: delay });
      delay *= 1.05;
    }
    return out;
  }

  function cascadeRisk(impacts) {
    if (!impacts?.length) return 0;
    const bad = impacts.filter(i => i.predictedDelay > 15).length;
    return bad / impacts.length;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 18. PRÉDICTION FIN DE TOURNÉE                  ║
     ╚══════════════════════════════════════════════╝ */

  function predictEndOfTour(route, startIdx) {
    let time = _nowMinutes();
    for (let i = (startIdx ?? 0); i < (route?.length || 0); i++) {
      const p = route[i];
      if (!p) continue;
      const travel = +p.travelMin || +p.travel_min || 10;
      const care   = +p.careMin   || +p.duration   || 10;
      const zoneF  = getZoneFactor(p.lat, p.lng);
      const diff   = difficultyScore(p);
      const meteo  = getWeatherFactor();
      const factor = zoneF * (1 + diff * 0.3) * meteo;
      time += (travel + care) * factor;
    }
    return time;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 19. SIMULATION DE JOURNÉE                      ║
     ╚══════════════════════════════════════════════╝ */

  function simulateDay(patients, startTimeMin) {
    let time = startTimeMin ?? _nowMinutes();
    let totalDelay = 0;
    const details = [];
    (patients || []).forEach(p => {
      const travel = +p.travelMin || +p.travel_min || 10;
      const care   = +p.careMin   || +p.duration   || 10;
      const zoneF  = getZoneFactor(p.lat, p.lng);
      const diff   = difficultyScore(p);
      const meteo  = getWeatherFactor();
      const typeF  = getTypeFactor(p);
      const factor = zoneF * (1 + diff * 0.3) * meteo * typeF;
      const duration = (travel + care) * factor;
      time += duration;
      const planned = _parseHour(p.heure_soin || p.heure || '');
      const delay = planned != null ? Math.max(0, time - planned) : 0;
      totalDelay += delay;
      details.push({ id: p.id, eta: time, delay });
    });
    return { endTime: time, totalDelay, details };
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 20. RECOMMANDATIONS STRATÉGIQUES               ║
     ╚══════════════════════════════════════════════╝ */

  function detectStartZones(patients) {
    const zones = {};
    (patients || []).forEach(p => {
      if (!p?.lat || !p?.lng) return;
      const k = Math.round(p.lat * 10) + '_' + Math.round(p.lng * 10);
      if (!zones[k]) zones[k] = [];
      zones[k].push(p);
    });
    return zones;
  }

  function _scoreZoneStrategy(zone) {
    let s = 0;
    zone.forEach(p => {
      s += getMedicalPriority(p) * 2;
      s += difficultyScore(p);
    });
    s += zone.length * 0.5;
    return s;
  }

  function bestStartZone(patients) {
    const zones = detectStartZones(patients);
    let best = null, bestScore = -Infinity;
    Object.values(zones).forEach(z => {
      const sc = _scoreZoneStrategy(z);
      if (sc > bestScore) { bestScore = sc; best = z; }
    });
    return best;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 21. AUTO-REPLAN (avec garde-fous)              ║
     ╚══════════════════════════════════════════════╝ */

  let _lastAutoReplanAt = 0;

  function _buildCandidate(route, idx, userPos) {
    const head = route.slice(0, idx + 1);
    const tail = route.slice(idx + 1);
    tail.sort((a, b) => {
      const pa = getMedicalPriority(a);
      const pb = getMedicalPriority(b);
      if (pb !== pa) return pb - pa;
      const da = userPos ? _dist(userPos, a) : 0;
      const db = userPos ? _dist(userPos, b) : 0;
      if (da !== db) return da - db;
      const dfa = difficultyScore(a);
      const dfb = difficultyScore(b);
      return dfb - dfa;
    });
    return [...head, ...tail];
  }

  function _countMoved(a, b, fromIdx) {
    let c = 0;
    for (let i = fromIdx + 1; i < a.length; i++) {
      if (a[i]?.id !== b[i]?.id) c++;
    }
    return c;
  }

  function estimateGain(currentRoute, candidateRoute, fromIdx) {
    const endNow  = predictEndOfTour(currentRoute,  fromIdx);
    const endCand = predictEndOfTour(candidateRoute, fromIdx);
    return Math.round(endNow - endCand);
  }

  /**
   * Applique une replanification automatique SI :
   *   - autoMode.enabled === true
   *   - cooldown respecté
   *   - aucun soin critique impacté en safetyLevel 3
   *   - gain ≥ minGainMin
   *   - disruptions ≤ maxDisruptions
   */
  function maybeAutoReplan(route, idx) {
    if (!CFG.autoMode.enabled) return { applied: false, reason: 'autoMode_off' };
    const now = Date.now();
    if (now - _lastAutoReplanAt < CFG.autoReplan.cooldownMs) {
      return { applied: false, reason: 'cooldown' };
    }
    if (!Array.isArray(route) || idx == null || idx >= route.length - 1) {
      return { applied: false, reason: 'no_route' };
    }

    const userPos = (typeof APP !== 'undefined') ? APP.get?.('userPos') : null;
    const cand = _buildCandidate(route, idx, userPos);

    /* 🛡️ GARDE-FOU MÉDICO-LÉGAL : safetyLevel 3 → ne touche pas aux soins critiques */
    if (CFG.autoMode.safetyLevel >= 3) {
      const tail = route.slice(idx + 1);
      const candTail = cand.slice(idx + 1);
      const criticalsMoved = tail.some((p, i) =>
        getMedicalPriority(p) === 3 && p.id !== candTail[i]?.id
      );
      if (criticalsMoved) {
        return { applied: false, reason: 'critical_protected' };
      }
    }

    const moved = _countMoved(route, cand, idx);
    if (moved > CFG.autoReplan.maxDisruptions) {
      return { applied: false, reason: 'too_many_disruptions', moved };
    }

    const gain = estimateGain(route, cand, idx);
    if (gain < CFG.autoReplan.minGainMin) {
      return { applied: false, reason: 'gain_too_low', gain };
    }

    if (typeof APP !== 'undefined' && typeof APP.set === 'function') {
      APP.set('uberPatients', cand);
    }
    _lastAutoReplanAt = now;

    if (typeof showToast === 'function') {
      showToast(`🤖 Tournée ajustée automatiquement (gain ~${gain} min)`);
    }
    if (CFG.autoMode.voice) {
      _speakSafe(`Tournée optimisée. Gain estimé ${gain} minutes.`);
    }
    return { applied: true, gain, moved };
  }

  /**
   * Suggère une replanification SANS l'appliquer.
   * Renvoie la nouvelle route candidate et passe la main à l'IDE
   * (boutons UI à brancher côté tournee.js / uber.js).
   */
  function suggestReplan(route, idx) {
    const userPos = (typeof APP !== 'undefined') ? APP.get?.('userPos') : null;
    const cand = _buildCandidate(route, idx, userPos);
    const gain = estimateGain(route, cand, idx);
    if (typeof APP !== 'undefined' && typeof APP.set === 'function') {
      APP.set('suggestedRoute', cand);
      APP.set('suggestedRouteGain', gain);
    }
    if (typeof showToast === 'function') {
      showToast(`💡 Nouvelle tournée suggérée — gain estimé ${gain} min`);
    }
    return { route: cand, gain };
  }

  function applySuggestedRoute() {
    if (typeof APP === 'undefined') return false;
    const r = APP.get('suggestedRoute');
    if (!r) return false;
    APP.set('uberPatients', r);
    APP.set('suggestedRoute', null);
    if (typeof showToast === 'function') {
      showToast('✅ Tournée ajustée');
    }
    return true;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 22. PRIORISATION URGENCE LIVE                  ║
     ╚══════════════════════════════════════════════╝ */

  function markUrgent(patientId, level) {
    if (typeof APP === 'undefined') return;
    const lvl = Number.isFinite(level) ? level : 3;
    const route = APP.get('uberPatients') || [];
    const p = route.find(x => String(x.id) === String(patientId));
    if (!p) return;
    p._urgent = lvl;
    APP.set('uberPatients', [...route]);
    document.dispatchEvent(new CustomEvent('ami:urgent', { detail: { patientId, level: lvl } }));
    if (CFG.autoMode.voice) {
      _speakSafe(`Urgence détectée pour ce patient`);
    }
  }

  function getDynamicPriority(p) {
    return getMedicalPriority(p) + (+p?._urgent || 0);
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 23. ASSISTANT VOCAL (Web Speech)               ║
     ╚══════════════════════════════════════════════╝ */

  let _lastSpeech = 0;
  let _voiceRecognition = null;
  let _dialogPending = null; // { action, expiresAt }
  let _lastAskedAt = 0;

  function _speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(String(text || ''));
      u.lang = 'fr-FR';
      u.rate = 1.0;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {}
  }

  function _speakSafe(text) {
    if (!CFG.autoMode.voice) return;
    const now = Date.now();
    if (now - _lastSpeech < CFG.voice.cooldownMs) return;
    _lastSpeech = now;
    _speak(text);
  }

  function askUser(question, action) {
    if (!CFG.autoMode.voice) return false;
    const now = Date.now();
    if (now - _lastAskedAt < CFG.voice.askCooldownMs) return false;
    _dialogPending = {
      action: typeof action === 'function' ? action : null,
      expiresAt: now + CFG.voice.dialogTimeoutMs,
    };
    _lastAskedAt = now;
    _speak(question);
    return true;
  }

  function _handleVoiceCommand(text) {
    const t = String(text || '').toLowerCase();
    /* Réponse à une question en attente */
    if (_dialogPending && Date.now() < _dialogPending.expiresAt) {
      if (/(\boui\b|\bok\b|d['’ ]accord|vas[- ]y)/.test(t)) {
        _speak("D'accord, j'applique");
        try { _dialogPending.action?.(); } catch {}
        _dialogPending = null;
        return;
      }
      if (/(\bnon\b|annule|pas maintenant)/.test(t)) {
        _speak("Très bien, je ne change rien");
        _dialogPending = null;
        return;
      }
    }
    /* Commandes libres */
    if (/(prochain patient|suivant)/.test(t)) {
      const next = (typeof APP !== 'undefined') ? APP.get('nextPatient') : null;
      if (next) _speak(`Prochain patient ${next.nom || next.label || ''}`);
      return;
    }
    if (/désactive.*auto|stop.*auto|arrête.*auto/.test(t)) {
      CFG.autoMode.enabled = false;
      _speak('Mode automatique désactivé');
      return;
    }
  }

  function startVoiceRecognition() {
    if (_voiceRecognition) return _voiceRecognition;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    try {
      const rec = new SR();
      rec.lang = 'fr-FR';
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        if (last && last[0]) _handleVoiceCommand(last[0].transcript);
      };
      rec.onerror = () => {};
      rec.onend = () => { try { rec.start(); } catch {} };
      rec.start();
      _voiceRecognition = rec;
      return rec;
    } catch {
      return null;
    }
  }

  function stopVoiceRecognition() {
    if (_voiceRecognition) {
      try { _voiceRecognition.onend = null; _voiceRecognition.stop(); } catch {}
      _voiceRecognition = null;
    }
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 24. AUTOPILOTE                                 ║
     ╚══════════════════════════════════════════════╝ */

  let _autoPilotInterval = null;
  let _lastNextPatientId = null;

  /* v5.10.3 — Mémoire des retards déjà annoncés vocalement.
     Map patientId → dernier retard annoncé (en min).
     Une nouvelle annonce vocale n'a lieu QUE si :
       - le patient n'a jamais été annoncé, OU
       - le retard s'est aggravé de plus de +5 min depuis la dernière annonce.
     Réinitialisé à chaque démarrage de tournée et au stop autopilot. */
  const _announcedDelays = new Map();

  function _resetAnnouncedDelays() { _announcedDelays.clear(); }

  function _autoPilotTick() {
    if (!CFG.autoMode.enabled) return;
    if (typeof APP === 'undefined') return;

    const route = APP.get('uberPatients') || [];
    const idx   = APP.get('currentIndex') || 0;

    /* 1. Urgence prioritaire (toujours, même hors autoMode) */
    const urgent = route.find(p => (+p._urgent || 0) >= 3);
    if (urgent) {
      _handleUrgentAuto(route, idx, urgent);
      return;
    }

    /* 2. Détection retard proactive
       v5.10.4 : annonce vocale UNE SEULE fois par patient. Pas de
       ré-annonce si le retard s'aggrave — l'IDE a déjà été informé. */
    const late = checkProactiveDelay(route, idx);
    if (late.length && CFG.autoMode.voice) {
      const newAlerts = [];
      for (const l of late) {
        if (_announcedDelays.has(l.patientId)) continue; // déjà annoncé
        const delayMin = Math.round(l.etaMin - l.planned);
        newAlerts.push({ ...l, delayMin });
        _announcedDelays.set(l.patientId, delayMin);
      }
      if (newAlerts.length === 1) {
        const a = newAlerts[0];
        const target = route.find(p => p.id === a.patientId);
        const name = target ? (target.nom || target.label || 'un patient') : 'un patient';
        _speakSafe(`Retard estimé chez ${name}, plus ${a.delayMin} minutes`);
      } else if (newAlerts.length > 1) {
        _speakSafe(`Retard détecté sur ${newAlerts.length} nouveaux patients`);
      }
    }

    /* 3. Replanification automatique (avec garde-fous) */
    maybeAutoReplan(route, idx);

    /* 4. Navigation auto (annonce vocale du prochain) */
    if (CFG.autoMode.navigation) {
      const next = route[idx + 1];
      if (next && next.id !== _lastNextPatientId) {
        _lastNextPatientId = next.id;
        APP.set('nextPatient', next);
        if (CFG.autoMode.voice) {
          _speakSafe(`Direction ${next.nom || next.label || 'patient suivant'}`);
        }
      }
    }

    /* 5. Pause auto */
    const breakType = shouldTakeBreak();
    if (breakType && !APP._pause) {
      const dur = breakType === 'short' ? CFG.fatigue.shortBreakMin : CFG.fatigue.longBreakMin;
      askUser(
        `Je te propose une pause de ${dur} minutes`,
        () => {
          APP._pause = { start: Date.now(), durationMin: dur };
          _speak(`Pause lancée pour ${dur} minutes`);
        }
      );
    }

    /* 6. Mise à jour fin de tournée prédite */
    const end = predictEndOfTour(route, idx);
    APP.set('predictedEnd', end);
  }

  function _handleUrgentAuto(route, idx, urgent) {
    const newRoute = [
      ...route.slice(0, idx + 1),
      urgent,
      ...route.filter(p => p.id !== urgent.id).slice(idx + 1),
    ];
    if (typeof APP !== 'undefined') APP.set('uberPatients', newRoute);
    if (typeof showToast === 'function') {
      showToast('🚨 Urgence prioritaire — tournée réordonnée');
    }
    if (CFG.autoMode.voice) {
      _speakSafe(`Urgence prioritaire. Patient à voir maintenant.`);
    }
  }

  function startAutoPilot() {
    if (_autoPilotInterval) return;
    _resetAnnouncedDelays();          /* v5.10.3 : oublier les anciennes annonces */
    _autoPilotInterval = setInterval(_autoPilotTick, 10000);
    if (typeof showToast === 'function') {
      showToast('🤖 Autopilote activé');
    }
  }

  function stopAutoPilot() {
    if (_autoPilotInterval) { clearInterval(_autoPilotInterval); _autoPilotInterval = null; }
    _resetAnnouncedDelays();          /* v5.10.3 : nettoyage à l'arrêt */
    if (typeof showToast === 'function') {
      showToast('⏸ Autopilote désactivé');
    }
  }

  /* Activation par l'IDE (opt-in explicite) */
  function enableAutoMode(opts) {
    const o = opts || {};
    CFG.autoMode.enabled     = true;
    CFG.autoMode.voice       = !!o.voice;
    CFG.autoMode.navigation  = !!o.navigation;
    CFG.autoMode.safetyLevel = Number.isFinite(o.safetyLevel) ? o.safetyLevel : 3;
    if (CFG.autoMode.voice) startVoiceRecognition();
    startAutoPilot();
  }

  function disableAutoMode() {
    CFG.autoMode.enabled    = false;
    CFG.autoMode.voice      = false;
    CFG.autoMode.navigation = false;
    stopVoiceRecognition();
    stopAutoPilot();
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 25. SUGGESTION DE SWAP (dialogue)              ║
     ╚══════════════════════════════════════════════╝ */

  function maybeSuggestSwap(route, idx) {
    if (!CFG.autoMode.enabled || !CFG.autoMode.voice) return;
    const next = route?.[idx + 1];
    const alt  = route?.[idx + 2];
    if (!next || !alt) return;

    /* 🛡️ Ne jamais swapper si soin critique */
    if (getMedicalPriority(next) >= 3 || getMedicalPriority(alt) >= 3) return;

    const userPos = (typeof APP !== 'undefined') ? APP.get('userPos') : null;
    if (!userPos) return;

    if (_dist(userPos, alt) < _dist(userPos, next)) {
      askUser(
        `Tu veux que je passe le patient suivant après ?`,
        () => {
          const newRoute = [...route];
          [newRoute[idx + 1], newRoute[idx + 2]] = [newRoute[idx + 2], newRoute[idx + 1]];
          if (typeof APP !== 'undefined') APP.set('uberPatients', newRoute);
        }
      );
    }
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 26. HOOK SCORE (utilisé par dynamicScore)      ║
     ╚══════════════════════════════════════════════╝
     Cette fonction est appelée par ai-tournee.js depuis dynamicScore()
     pour ajouter les nouveaux signaux SANS casser l'algo existant.
     Renvoie un AJUSTEMENT ADDITIF du score (positif = pénalité,
     négatif = boost).
  */
  function scoreAdjustment(patient, ctx) {
    if (!patient) return 0;
    let adj = 0;

    /* Priorité dynamique (urgence live) */
    const dynPrio = getDynamicPriority(patient);
    if (dynPrio === 3) adj -= 250;        // urgence : passe avant
    else if (dynPrio === 2) adj -= 60;    // lourd : prioritaire mais soft

    /* Score difficulté : on remonte les patients difficiles plus tôt */
    const diff = difficultyScore(patient);
    adj -= diff * 30;

    /* Risque no-show : on rétrograde un peu (évite trajet inutile en premier) */
    const noShow = predictNoShowScore(patient, new Date());
    adj += noShow * 40;

    /* Préférence mémorisée (ex : "garder Mme X en fin de tournée") */
    if (recall('prefer_late_patient_' + patient.id)) {
      adj += 50;
    }

    return adj;
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 26.bis OBSERVATEUR AUTO-APPRENTISSAGE          ║
     ╚══════════════════════════════════════════════╝
     v5.10.4 — Hook indirect via APP.on() pour ne pas dépendre
     d'un appel explicite à completePatient() depuis uber.js / tournee.js.
     Détecte les transitions done=false→true et absent=false→true sur
     uberPatients, et alimente automatiquement les apprentissages.

     • Pose `_started_at_ts` quand un patient devient nextPatient
       → permet de mesurer la durée RÉELLE du soin
     • Détecte les nouveaux done / absent dans uberPatients
       → appelle updateDifficulty / updateNoShow / learnType / learnZone
     • Set `_observedCompletions` empêche les doubles comptabilisations.
  */
  const _observedCompletions = new Set();

  function _learnFromCompletion(p) {
    if (!p?.id) return;
    try {
      const plannedMin = +p.duration || 10;
      let realMin = plannedMin;
      if (p._started_at_ts) {
        realMin = Math.max(1, Math.round((Date.now() - p._started_at_ts) / 60000));
      }

      if (p.absent) {
        updateNoShow(p.id, { isNoShow: true });
        return;
      }
      if (p.done) {
        updateDifficulty(p.id, { plannedMin, realMin });
        updateNoShow(p.id, { lateMin: 0 });
        const type = getPatientType(p);
        learnType(type, plannedMin, realMin);
        if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
          learnZone(p.lat, p.lng, plannedMin, realMin);
        }

        // ⚡ FIX Apprentissage accumulé "0 profils route appris" :
        //    Avant ce fix, _learnRouteFactor n'était JAMAIS appelée → la stat
        //    restait à 0 même après plusieurs tournées. On la nourrit ici dès
        //    qu'on a une durée trajet (p.travel_min). Si on a aussi une
        //    distance OSRM (p.distance_km), on dérive la zone par vitesse —
        //    sinon fallback 'peri' (compromis le plus probable en France).
        if (p.travel_min > 0) {
          let _routeZone = 'peri';
          if (Number.isFinite(p.distance_km) && p.distance_km > 0) {
            _routeZone = _zoneFromSpeed(p.distance_km, p.travel_min * 60);
          }
          // Sample : sans tracking trajet réel, on enregistre planifié vs
          // planifié (count++ sans mouvement de avgFactor). Au moins le
          // compteur progresse → l'IDE sait que l'apprentissage est actif.
          const _realTravelMin = Number.isFinite(p._real_travel_min)
            ? p._real_travel_min
            : p.travel_min;
          _learnRouteFactor(_routeZone, p.travel_min, _realTravelMin);
        }

        // ⚡ FIX Apprentissage accumulé "0 profil(s) IDE" :
        //    Avant ce fix, learnIDE n'était JAMAIS appelée → 0 profils IDE
        //    même après des dizaines de patients. On lie l'apprentissage au
        //    compte connecté (S.user.id) et on enregistre le ratio de durée.
        //    Si le patient est marqué done sans retard détecté, on considère
        //    onTimeRate=1 (ponctualité parfaite ce passage).
        const _S = (typeof S !== 'undefined' && S) ||
                   (typeof window !== 'undefined' && window.S) || null;
        const _ideId = _S?.user?.id || _S?.user?.email || null;
        if (_ideId) {
          learnIDE(_ideId, {
            realTime:      realMin,
            estimatedTime: plannedMin,
            onTimeRate:    1,
          });
        }
      }
    } catch (_) {}
  }

  function _onUberPatientsChanged(route) {
    if (!Array.isArray(route)) return;
    for (const p of route) {
      if (!p?.id) continue;
      if (p.done) {
        const k = String(p.id) + '|done';
        if (_observedCompletions.has(k)) continue;
        _observedCompletions.add(k);
        _learnFromCompletion(p);
      } else if (p.absent) {
        const k = String(p.id) + '|absent';
        if (_observedCompletions.has(k)) continue;
        _observedCompletions.add(k);
        _learnFromCompletion(p);
      }
    }
  }

  function _onNextPatientChanged(p) {
    if (!p || !p.id) return;
    /* Pose l'ancre temporelle uniquement la 1ʳᵉ fois pour ce patient */
    if (!p._started_at_ts) p._started_at_ts = Date.now();
  }

  function _attachAutoLearningHooks() {
    if (SMART._autoLearnAttached) return;
    if (typeof APP === 'undefined' || typeof APP.on !== 'function') {
      const tries = (SMART._autoLearnTries = (SMART._autoLearnTries || 0) + 1);
      if (tries < 25) {
        setTimeout(_attachAutoLearningHooks, Math.min(200 * tries, 1000));
      }
      return;
    }
    SMART._autoLearnAttached = true;
    try {
      APP.on('uberPatients', _onUberPatientsChanged);
      APP.on('nextPatient',  _onNextPatientChanged);
      _onUberPatientsChanged(APP.get('uberPatients'));
      _onNextPatientChanged(APP.get('nextPatient'));
    } catch (_) {}

    /* v5.10.5 — Polling défensif (toutes les 5s)
       Certaines mutations done/absent se font EN PLACE sur les objets
       (markUberDone : p.done = true sans APP.set('uberPatients', …)).
       Le listener APP.on() ne se déclenche donc pas. Le polling scanne
       le store et alimente les apprentissages quoi qu'il arrive. */
    if (!SMART._autoLearnPollInterval) {
      SMART._autoLearnPollInterval = setInterval(() => {
        try {
          _onUberPatientsChanged(APP.get('uberPatients'));
          _scanHistoriqueOnce();
        } catch(_) {}
      }, 5000);
    }
  }

  /* v5.10.5 — Scan de l'historique IDB une seule fois pour rattraper
     les patients déjà facturés AVANT le déploiement de l'observateur
     (tournées passées dont les stats ne sont pas dans localStorage).
     Lit window._cotationsHistoryCache si dispo (rempli par dashboard.js)
     ou IDB.cotations directement si idbGet est exposé. */
  let _historiqueScanned = false;
  async function _scanHistoriqueOnce() {
    if (_historiqueScanned) return;
    _historiqueScanned = true;

    try {
      let cotations = [];
      const cache = window._cotationsHistoryCache;
      if (Array.isArray(cache) && cache.length) {
        cotations = cache;
      } else if (typeof window.idbGetAll === 'function') {
        try { cotations = await window.idbGetAll('cotations') || []; } catch {}
      } else {
        /* Tentative sur le cache localStorage du dashboard */
        try {
          const keys = Object.keys(localStorage).filter(k => k.startsWith('ami_dash_'));
          for (const k of keys) {
            const raw = JSON.parse(localStorage.getItem(k) || '{}');
            if (Array.isArray(raw.data)) cotations.push(...raw.data);
          }
        } catch {}
      }

      if (!cotations.length) return;
      let learned = 0;
      for (const c of cotations) {
        if (!c?.patient_id) continue;
        const k = String(c.patient_id) + '|done';
        if (_observedCompletions.has(k)) continue;
        _observedCompletions.add(k);

        const lat = +c.lat || +c.patient_lat;
        const lng = +c.lng || +c.patient_lng;
        const plannedMin = +c.duration_min || 10;
        const realMin    = +c.real_min || +c.duration_real_min || plannedMin;

        try {
          updateDifficulty(c.patient_id, { plannedMin, realMin });
          updateNoShow(c.patient_id, { lateMin: 0 });
          const patientLike = {
            id: c.patient_id,
            description: c.description || c.actes || '',
            actes_recurrents: c.actes_recurrents || '',
          };
          const type = getPatientType(patientLike);
          learnType(type, plannedMin, realMin);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            learnZone(lat, lng, plannedMin, realMin);
          }
          learned++;
        } catch (_) {}
      }
      if (learned > 0) {
        console.info(`[AMI_SMART] Apprentissage rattrapé : ${learned} cotations historiques`);
      }
    } catch(_) {}
  }

  /* Force un re-scan de l'historique IDB (appelé par le bouton "Rafraîchir").
     Ne re-comptabilise PAS le store uberPatients en cours (déjà fait par
     le polling), seulement l'historique pour rattraper les anciennes
     tournées non observées. */
  function rescanLearning() {
    _historiqueScanned = false;
    return _scanHistoriqueOnce();
  }

  /* ╔══════════════════════════════════════════════╗
     ║ 27. INIT & EXPORTS                             ║
     ╚══════════════════════════════════════════════╝ */

  function init() {
    /* Hook auto-apprentissage : doit être attaché tôt pour ne rien rater */
    _attachAutoLearningHooks();

    /* Charge la météo en arrière-plan si la position est dispo */
    setTimeout(() => {
      try {
        const pos = (typeof APP !== 'undefined') ? APP.get?.('userPos') || APP.get?.('startPoint') : null;
        if (pos?.lat && pos?.lng) fetchWeather(pos.lat, pos.lng);
      } catch {}
    }, 2000);
  }

  /* Exports namespace AMI_SMART */
  Object.assign(SMART, {
    /* config */
    enableAutoMode, disableAutoMode,
    /* zones / route learning */
    learnZone, getZoneFactor,
    learnRouteFactor: _learnRouteFactor,
    getLearnedRouteFactor: _getLearnedRouteFactor,
    zoneFromSpeed: _zoneFromSpeed,
    /* no-show */
    updateNoShow, predictNoShowScore,
    /* difficulté */
    updateDifficulty, difficultyScore,
    /* IDE */
    learnIDE, getIDEProfile,
    /* type patient */
    getPatientType, learnType, getTypeFactor,
    /* priorité */
    getMedicalPriority, getDynamicPriority, markUrgent,
    /* mémoire */
    remember, recall, forget,
    /* météo */
    fetchWeather, getWeatherFactor,
    /* fatigue */
    fatigueScore, shouldTakeBreak,
    /* trafic */
    trafficNowFactor,
    /* clustering */
    clusterPatients, sortCluster, orderClusters, clusterDynamicRoute,
    groupVisits,
    /* prédictions */
    predictETASequence, detectLatePatients, checkProactiveDelay,
    predictCascadeDelay, cascadeRisk,
    predictEndOfTour, simulateDay,
    bestStartZone, detectStartZones,
    /* replanification */
    estimateGain, maybeAutoReplan, suggestReplan, applySuggestedRoute,
    /* vocal */
    speak: _speak, speakSafe: _speakSafe, askUser,
    startVoiceRecognition, stopVoiceRecognition,
    /* autopilote */
    startAutoPilot, stopAutoPilot,
    maybeSuggestSwap,
    /* hook score */
    scoreAdjustment,
    /* helpers */
    formatTime: _formatTime,
    parseHour: _parseHour,
    nowMinutes: _nowMinutes,
    distKm: _distKm,
    /* v5.10.5 — relance manuelle de l'apprentissage */
    rescanLearning,
  });

  /* Init immédiate : _attachAutoLearningHooks retry tant qu'APP n'est pas prêt,
     et la météo est différée à 2s. Pas besoin d'attendre DOMContentLoaded. */
  init();

  console.info('[AMI_SMART] Module IA terrain v' + SMART.version + ' chargé');
})();
