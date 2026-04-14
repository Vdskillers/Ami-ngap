// ─────────────────────────────────────────────────────────────
//  ai-layer.js
//  Couche IA silencieuse — enrichit les 3 modes de tournée
//  Sans modifier l'UX ni la logique existante
//  Ajouter : geoScore + habitScore + clustering + warnings
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  SCORE ENRICHI (remplace baseScore dans ai-tournee.js)
// ─────────────────────────────────────────────────────────────

/**
 * Score global patient pour tri de tournée.
 * Respecte les 3 modes existants + enrichissement silencieux.
 */
function enhancedScore(patient, mode, context) {
  let score = 0;

  // ── logique métier existante (NE PAS MODIFIER) ──────────────
  if (mode === 'auto') {
    if (patient.urgent)                                     score += 50;
    if (/insuline|perf/i.test(patient.soin || ''))          score += 30;
    if (context && context.distanceTo)
      score -= (context.distanceTo(patient) || 0) * 0.5;
  }

  if (mode === 'horaire') {
    const [h, m] = (patient.preferredTime || '12:00').split(':').map(Number);
    return 10000 - (h * 60 + m) * 10; // tri pur par heure
  }

  if (mode === 'mixte') {
    if (patient.locked) return 9999; // patient verrouillé → toujours prioritaire
    if (patient.urgent)              score += 50;
    if (context && context.distanceTo)
      score -= (context.distanceTo(patient) || 0) * 0.4;
  }

  // ── enrichissement IA silencieux ────────────────────────────
  score += (patient.geoScore   || 50) * 0.3;  // fiabilité adresse
  score += (patient.habitScore || 0);          // habitudes apprises
  if (patient.isRegular)                       score += 15;  // patient régulier
  score -= (patient.riskDelay  || 0);          // risque retard connu

  return score;
}

// ─────────────────────────────────────────────────────────────
//  APPRENTISSAGE DES HABITUDES
// ─────────────────────────────────────────────────────────────

/**
 * Met à jour le score d'habitude d'un patient après visite.
 * Appelé à chaque fin de visite dans ton flow existant.
 */
async function updateHabitScore(patientId, visitedAt) {
  const patterns = await loadSecure('habits', patientId) || { visits: [] };

  patterns.visits.push(visitedAt);

  // garder 30 dernières visites
  if (patterns.visits.length > 30) patterns.visits.shift();

  // calculer heure habituelle
  const hours = patterns.visits.map(v => new Date(v).getHours());
  const avg   = hours.reduce((a, b) => a + b, 0) / hours.length;
  patterns.avgHour    = Math.round(avg);
  patterns.habitScore = Math.min(30, patterns.visits.length);

  await saveSecure('habits', patientId, patterns);
}

/**
 * Vérifie si le patient est d'habitude visité le matin.
 */
async function isUsuallyMorning(patientId) {
  const patterns = await loadSecure('habits', patientId);
  return patterns && patterns.avgHour < 12;
}

/**
 * Charge et injecte les scores d'habitude dans la liste patients.
 */
async function enrichPatientsWithHabits(patients) {
  const enriched = await Promise.all(patients.map(async p => {
    try {
      const patterns = await loadSecure('habits', p.id);
      return {
        ...p,
        habitScore: patterns?.habitScore || 0,
        avgVisitHour: patterns?.avgHour || null,
      };
    } catch (_) {
      return p;
    }
  }));
  return enriched;
}

// ─────────────────────────────────────────────────────────────
//  CLUSTERING — regroupement par quartiers
// ─────────────────────────────────────────────────────────────

/**
 * K-means léger côté client.
 * Regroupe les patients par zones géographiques naturelles.
 * Retourne un tableau de clusters [{center, patients}].
 */
function clusterPatients(patients, k = 3) {
  const withCoords = patients.filter(p => p.lat && p.lng);
  if (withCoords.length < k) return [{ center: null, patients }];

  // init centres : premiers patients distincts
  let centers = withCoords.slice(0, k).map(p => ({ lat: p.lat, lng: p.lng }));

  let clusters = [];

  for (let iter = 0; iter < 15; iter++) {
    clusters = Array.from({ length: k }, () => []);

    withCoords.forEach(p => {
      let best    = 0;
      let minDist = Infinity;

      centers.forEach((c, i) => {
        const d = _haversine(p.lat, p.lng, c.lat, c.lng);
        if (d < minDist) { minDist = d; best = i; }
      });

      clusters[best].push(p);
    });

    // recalcul centres
    centers = clusters.map(cluster => {
      if (!cluster.length) return centers[0];
      return {
        lat: cluster.reduce((s, p) => s + p.lat, 0) / cluster.length,
        lng: cluster.reduce((s, p) => s + p.lng, 0) / cluster.length,
      };
    });
  }

  return clusters.map((pts, i) => ({ center: centers[i], patients: pts }));
}

// ─────────────────────────────────────────────────────────────
//  WARNINGS discrets sur la tournée
// ─────────────────────────────────────────────────────────────

/**
 * Détecte les incohérences dans la tournée planifiée.
 * Retourne un tableau de warnings { patientId, type, message }.
 */
function detectTourneeWarnings(patients, mode) {
  const warnings = [];

  // adresses imprécises
  patients.forEach(p => {
    if ((p.geoScore || 0) < 50) {
      warnings.push({
        patientId: p.id,
        type:      'geo',
        message:   `Adresse imprécise pour ${p.name} — vérifier la localisation`,
      });
    }
  });

  // risque retard en mode horaire
  if (mode === 'horaire') {
    for (let i = 0; i < patients.length - 1; i++) {
      const a = patients[i];
      const b = patients[i + 1];

      const gap  = _timeGapMinutes(a.preferredTime, b.preferredTime);
      const dist = (a.lat && b.lat)
        ? _haversine(a.lat, a.lng, b.lat, b.lng)
        : 0;

      // moins de 10 min entre 2 patients séparés de plus de 5 km
      if (gap < 10 && dist > 5) {
        warnings.push({
          patientId: b.id,
          type:      'delay',
          message:   `Risque de retard : ${b.name} (${gap} min d'écart, ${dist.toFixed(1)} km)`,
        });
        b.riskDelay = 20;
      }
    }
  }

  // patients sans coordonnées GPS
  patients.forEach(p => {
    if (!p.lat || !p.lng) {
      warnings.push({
        patientId: p.id,
        type:      'no-coords',
        message:   `${p.name} : coordonnées GPS manquantes`,
      });
    }
  });

  return warnings;
}

// ─────────────────────────────────────────────────────────────
//  PIPELINE COMPLET de préparation tournée
// ─────────────────────────────────────────────────────────────

/**
 * Point d'entrée principal.
 * Appeler avant de lancer l'optimisation de tournée.
 */
async function prepareSmartTournee(patients, mode, context) {
  // 1. enrichir avec habitudes
  const enriched = await enrichPatientsWithHabits(patients);

  // 2. calculer score enrichi
  const scored = enriched.map(p => ({
    ...p,
    aiScore: enhancedScore(p, mode, context),
  }));

  // 3. tri
  if (mode !== 'horaire') {
    scored.sort((a, b) => b.aiScore - a.aiScore);
  } else {
    scored.sort((a, b) => {
      const [ha, ma] = (a.preferredTime || '12:00').split(':').map(Number);
      const [hb, mb] = (b.preferredTime || '12:00').split(':').map(Number);
      return (ha * 60 + ma) - (hb * 60 + mb);
    });
  }

  // 4. warnings
  const warnings = detectTourneeWarnings(scored, mode);

  // 5. clusters
  const clusters = clusterPatients(scored);

  return { patients: scored, warnings, clusters };
}

// ─────────────────────────────────────────────────────────────
//  Utilitaires internes
// ─────────────────────────────────────────────────────────────

function _haversine(la1, lo1, la2, lo2) {
  const R    = 6371;
  const dLat = (la2 - la1) * Math.PI / 180;
  const dLon = (lo2 - lo1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(la1 * Math.PI / 180)
             * Math.cos(la2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _timeGapMinutes(t1, t2) {
  if (!t1 || !t2) return 60;
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}
