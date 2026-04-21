/* ════════════════════════════════════════════════
   bsi-engine.js — AMI v1.0
   ────────────────────────────────────────────────
   Moteurs d'analyse BSI & conformité
   ────────────────────────────────────────────────
   Modules :
   1. suggestBSI()          — suggestion auto niveau dépendance
   2. checkBSIConsistency() — détection incohérences BSI vs actes
   3. simulateBSIImpact()   — impact financier BSI
   4. computeCPAMRisk()     — score risque contrôle CPAM
   5. computeTrustScore()   — score de confiance global
   ────────────────────────────────────────────────
   ⚠️ 100% local — aucune donnée ne sort du terminal.
   La décision finale reste toujours à l'IDE (aide
   à la décision, jamais automatisation totale).
═══════════════════════════════════════════════ */

/* ── Tarifs NGAP 2026 (source de vérité) ───────── */
const BSI_TARIFS_2026 = {
  BSI1: 3.1 * 3.15,  // 9,77 €  (AIS 3,1c)
  BSI2: 5.1 * 3.15,  // 16,07 € (AIS 5,1c)
  BSI3: 7.1 * 3.15,  // 22,37 € (AIS 7,1c)
  AIS:  3.15,        // valeur du c
};

/* ════════════════════════════════════════════════
   1. MOTEUR SUGGESTION BSI
   ────────────────────────────────────────────────
   Aide l'IDE à choisir BSI 1/2/3 à partir des actes,
   fréquence, durée et de l'évaluation de dépendance.
   NB : ne remplace JAMAIS la grille AGGIR saisie.
═══════════════════════════════════════════════ */
function suggestBSI({ actes = [], freqPerDay = 1, minutesPerDay = 0, dependance = null, scores = null }) {
  let score = 0;
  const motifs = [];

  // ── 1. Si scores AGGIR déjà saisis → usage direct ───────────
  if (scores && typeof scores === 'object') {
    const total = Object.values(scores).reduce((s, v) => s + (Number(v) || 0), 0);
    const filled = Object.keys(scores).length;
    if (filled >= 5) {
      let level = 1, conf = 0.9;
      if (total <= 4)       level = 1;
      else if (total <= 8)  level = 2;
      else                  level = 3;
      motifs.push(`Grille AGGIR : ${total} pts sur ${filled} critères`);
      return { level, confidence: conf, motifs, score: total };
    }
  }

  // ── 2. Fréquence de passage ─────────────────────────────────
  const freq = Math.min(Number(freqPerDay) || 1, 4);
  score += freq * 2;
  if (freq >= 2) motifs.push(`${freq} passages / jour`);

  // ── 3. Charge horaire journalière ────────────────────────────
  const mins = Number(minutesPerDay) || 0;
  if      (mins > 90) { score += 8; motifs.push(`> 90 min/jour de soins`); }
  else if (mins > 60) { score += 6; motifs.push(`> 60 min/jour de soins`); }
  else if (mins > 30) { score += 3; motifs.push(`> 30 min/jour de soins`); }

  // ── 4. Type d'actes techniques ──────────────────────────────
  const codes = actes.map(a => String(a.code || '').toUpperCase());
  const hasNursing  = codes.some(c => c.startsWith('AIS'));
  const hasAMI4     = codes.some(c => /^AMI\s*4/.test(c));
  const hasAMI5     = codes.some(c => /^AMI\s*5/.test(c));
  const hasBSB      = codes.some(c => c === 'BSB');
  const hasPerf     = actes.some(a => /perf|perfusion/i.test(a.description || a.code || ''));

  if (hasNursing) { score += 4; motifs.push('Soins de nursing présents'); }
  if (hasAMI4)    { score += 3; motifs.push('AMI 4 — soins lourds'); }
  if (hasAMI5)    { score += 4; motifs.push('AMI 5 — soins très lourds'); }
  if (hasBSB)     { score += 2; motifs.push('Pansement complexe (BSB)'); }
  if (hasPerf)    { score += 2; motifs.push('Perfusion en cours'); }

  // ── 5. Dépendance (optionnel, si renseignée) ────────────────
  if (dependance) {
    if (dependance.mobility    === 'low')         { score += 3; motifs.push('Mobilité réduite'); }
    if (dependance.hygiene     === 'full_assist') { score += 4; motifs.push('Toilette totalement assistée'); }
    if (dependance.cognition   === 'impaired')    { score += 3; motifs.push('Altération cognitive'); }
    if (dependance.alimentation === 'full_assist'){ score += 3; motifs.push('Alimentation assistée'); }
  }

  // ── 6. Mapping vers niveau BSI ──────────────────────────────
  let level, confidence;
  if      (score >= 15) { level = 3; confidence = 0.85; }
  else if (score >= 9)  { level = 2; confidence = 0.75; }
  else if (score >= 4)  { level = 1; confidence = 0.70; }
  else                  { level = 0; confidence = 0.60; motifs.push('Soins légers — BSI non indiqué'); }

  return { level, confidence, motifs, score };
}

/* ════════════════════════════════════════════════
   2. DÉTECTION INCOHÉRENCES BSI vs ACTES
   ────────────────────────────────────────────────
   Détecte les situations où le niveau BSI ne colle
   pas avec la réalité des soins facturés.
═══════════════════════════════════════════════ */
function checkBSIConsistency({ bsiLevel, actes = [], freqPerDay = 1, nbJours = 30 }) {
  const issues = [];
  if (!bsiLevel) return issues;

  const codes      = actes.map(a => String(a.code || '').toUpperCase());
  const hasAIS     = codes.some(c => c.startsWith('AIS'));
  const hasAMI4    = codes.some(c => /^AMI\s*4/.test(c));
  const hasAMI5    = codes.some(c => /^AMI\s*5/.test(c));
  const hasLourd   = hasAMI4 || hasAMI5;
  const freq       = Number(freqPerDay) || 1;

  // ❌ BSI 1 avec nursing fréquent → probablement sous-évalué
  if (bsiLevel === 1 && hasAIS && freq >= 2) {
    issues.push({
      type: 'UNDER_EVALUATION',
      severity: 'moyen',
      message: 'Nursing fréquent (≥2 passages/j) avec BSI 1 — niveau possiblement trop bas',
      suggestion: 2,
    });
  }

  // ❌ BSI 1 avec actes lourds → incohérent
  if (bsiLevel === 1 && hasLourd) {
    issues.push({
      type: 'UNDER_EVALUATION',
      severity: 'eleve',
      message: 'AMI 4/5 coté avec BSI 1 — incohérence de dépendance',
      suggestion: 3,
    });
  }

  // ❌ BSI 3 sans aucun acte lourd ni nursing → surévalué
  if (bsiLevel === 3 && !hasAIS && !hasLourd && freq <= 1) {
    issues.push({
      type: 'OVER_EVALUATION',
      severity: 'eleve',
      message: 'BSI 3 sans soins lourds ni nursing — risque de rejet CPAM',
      suggestion: 1,
    });
  }

  // ⚠️ BSI 3 avec une fréquence faible → à justifier
  if (bsiLevel === 3 && freq <= 1 && hasAIS) {
    issues.push({
      type: 'TO_JUSTIFY',
      severity: 'moyen',
      message: 'BSI 3 avec 1 seul passage/j — dépendance à documenter précisément',
      suggestion: null,
    });
  }

  // ⚠️ Forte charge sans BSI → opportunité manquée
  if (!bsiLevel && hasAIS && freq >= 2) {
    issues.push({
      type: 'MISSING_BSI',
      severity: 'eleve',
      message: 'Nursing fréquent sans BSI — évaluation recommandée',
      suggestion: 2,
    });
  }

  return issues;
}

/* ════════════════════════════════════════════════
   3. IMPACT FINANCIER BSI
   ────────────────────────────────────────────────
   Compare la cotation actuelle avec un niveau
   suggéré et projette l'écart mensuel / annuel.
═══════════════════════════════════════════════ */
function simulateBSIImpact({ current, suggested, freqPerDay = 1, days = 30 }) {
  const key = l => {
    if (l === 1 || l === '1' || l === 'BSI1') return 'BSI1';
    if (l === 2 || l === '2' || l === 'BSI2') return 'BSI2';
    if (l === 3 || l === '3' || l === 'BSI3') return 'BSI3';
    return null;
  };
  const kCurrent   = key(current);
  const kSuggested = key(suggested);

  const freq = Math.max(1, Number(freqPerDay) || 1);
  const tCurrent   = kCurrent   ? BSI_TARIFS_2026[kCurrent]   : 0;
  const tSuggested = kSuggested ? BSI_TARIFS_2026[kSuggested] : 0;

  // Revenu mensuel = tarif × freq/jour × days
  const revCurrent   = +(tCurrent   * freq * days).toFixed(2);
  const revSuggested = +(tSuggested * freq * days).toFixed(2);
  const delta        = +(revSuggested - revCurrent).toFixed(2);
  const deltaAnnuel  = +(delta * 12).toFixed(2);

  return {
    tarifCurrent:   tCurrent,
    tarifSuggested: tSuggested,
    revenuMensuel_current:   revCurrent,
    revenuMensuel_suggested: revSuggested,
    delta,
    deltaAnnuel,
    direction: delta > 0 ? 'gain' : delta < 0 ? 'perte' : 'neutre',
  };
}

/* ════════════════════════════════════════════════
   4. DÉTECTION RISQUE CONTRÔLE CPAM
   ────────────────────────────────────────────────
   ⚠️ ne prédit PAS un contrôle — calcule le niveau
   de non-conformité susceptible d'en déclencher un.
═══════════════════════════════════════════════ */
function computeCPAMRisk({
  cotations = [],
  bsiIncoherences = 0,
  patientsPerDay  = 0,
  sameActRepeated = 0,
  noDecotePattern = false,
  kmPerDay        = 0,
  dre_missing     = 0,
} = {}) {
  let score = 0;
  const alerts = [];

  // ── 1. Incohérences BSI ─────────────────────────
  if (bsiIncoherences >= 3)      { score += 4; alerts.push({ level: 'eleve',  msg: `${bsiIncoherences} incohérences BSI détectées` }); }
  else if (bsiIncoherences >= 1) { score += 2; alerts.push({ level: 'moyen',  msg: `${bsiIncoherences} incohérence(s) BSI` }); }

  // ── 2. Volume patients / jour ────────────────────
  if (patientsPerDay > 40)      { score += 3; alerts.push({ level: 'eleve', msg: `Volume patients élevé (${patientsPerDay}/j)` }); }
  else if (patientsPerDay > 30) { score += 2; alerts.push({ level: 'moyen', msg: `Volume patients soutenu (${patientsPerDay}/j)` }); }

  // ── 3. Répétition d'actes identiques ─────────────
  if (sameActRepeated > 30)      { score += 3; alerts.push({ level: 'eleve', msg: `Acte répété > 30 fois sur la période` }); }
  else if (sameActRepeated > 15) { score += 2; alerts.push({ level: 'moyen', msg: `Répétition d'actes fréquente` }); }

  // ── 4. Absence de décote sur séries ─────────────
  if (noDecotePattern) { score += 2; alerts.push({ level: 'moyen', msg: 'Pattern d\'optimisation NGAP atypique' }); }

  // ── 5. IK élevées ────────────────────────────────
  if (kmPerDay > 150)      { score += 2; alerts.push({ level: 'moyen', msg: `IK > 150 km/jour` }); }
  else if (kmPerDay > 100) { score += 1; alerts.push({ level: 'faible',msg: `IK soutenues (${Math.round(kmPerDay)} km/j)` }); }

  // ── 6. DRE manquantes ────────────────────────────
  if (dre_missing > 3) { score += 2; alerts.push({ level: 'moyen', msg: `${dre_missing} cotations sans prescripteur` }); }

  // ── 7. Cotations quotidiennes sans pause ─────────
  // Détection pattern "suractivité" (> 6 mois sans jour off)
  if (cotations.length > 500) {
    const dates = new Set(cotations.map(c => (c.date_soin || c.date || '').slice(0, 10)).filter(Boolean));
    if (dates.size > 180) { score += 1; alerts.push({ level: 'faible', msg: 'Activité quasi-quotidienne sur 6 mois' }); }
  }

  // ── Mapping score → niveau ───────────────────────
  let level, label, color;
  if      (score >= 8) { level = 'HIGH';   label = 'ÉLEVÉ';   color = '#ef4444'; }
  else if (score >= 4) { level = 'MEDIUM'; label = 'MODÉRÉ';  color = '#f59e0b'; }
  else                 { level = 'LOW';    label = 'FAIBLE';  color = '#22c55e'; }

  return { level, label, color, score, max: 20, alerts };
}

/* ════════════════════════════════════════════════
   5. SCORE DE CONFIANCE GLOBAL
   ────────────────────────────────────────────────
   Agrégation NGAP + BSI + Risque → note /100
   Objectif : donner à l'IDE une vision instantanée
   de sa sérénité professionnelle.
═══════════════════════════════════════════════ */
function computeTrustScore({
  ngapCompliance = 1,   // 0..1  (part des cotations conformes)
  bsiCoherence   = 1,   // 0..1  (1 - ratio d'incohérences)
  riskScore      = 0,   // 0..20 (sortie de computeCPAMRisk)
  riskMax        = 20,
} = {}) {
  const n = Math.max(0, Math.min(1, Number(ngapCompliance) || 0));
  const b = Math.max(0, Math.min(1, Number(bsiCoherence)   || 0));
  const r = Math.max(0, Math.min(1, 1 - (Number(riskScore) / (riskMax || 20))));

  // Pondération : NGAP 40% / BSI 30% / Risque 30%
  const raw = n * 0.4 + b * 0.3 + r * 0.3;
  const score = Math.round(raw * 100);

  let level, label, color;
  if      (score >= 85) { level = 'EXCELLENT'; label = 'Excellent';  color = '#22c55e'; }
  else if (score >= 70) { level = 'GOOD';      label = 'Bon';        color = '#84cc16'; }
  else if (score >= 50) { level = 'FAIR';      label = 'Correct';    color = '#f59e0b'; }
  else                  { level = 'LOW';       label = 'À surveiller'; color = '#ef4444'; }

  return {
    score,
    level,
    label,
    color,
    parts: {
      ngap: Math.round(n * 100),
      bsi:  Math.round(b * 100),
      risk: Math.round(r * 100),
    },
  };
}

/* ════════════════════════════════════════════════
   6. HISTORIQUE DE CONFORMITÉ (par mois)
   ────────────────────────────────────────────────
   Stocke un snapshot mensuel du score de confiance
   pour prouver juridiquement la constance de la
   vigilance de l'IDE.
═══════════════════════════════════════════════ */
const TRUST_HISTORY_KEY = () => `ami_trust_history_${APP?.user?.id || 'anon'}`;

function saveTrustSnapshot(snapshot) {
  try {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const raw = localStorage.getItem(TRUST_HISTORY_KEY());
    const history = raw ? JSON.parse(raw) : {};
    history[monthKey] = {
      ...snapshot,
      saved_at: now.toISOString(),
    };
    // Garder 24 mois max
    const keys = Object.keys(history).sort();
    if (keys.length > 24) {
      const toRemove = keys.slice(0, keys.length - 24);
      toRemove.forEach(k => delete history[k]);
    }
    localStorage.setItem(TRUST_HISTORY_KEY(), JSON.stringify(history));
    return true;
  } catch (e) {
    console.warn('[saveTrustSnapshot]', e.message);
    return false;
  }
}

function getTrustHistory() {
  try {
    const raw = localStorage.getItem(TRUST_HISTORY_KEY());
    if (!raw) return [];
    const history = JSON.parse(raw);
    return Object.entries(history)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));
  } catch { return []; }
}

/* ════════════════════════════════════════════════
   EXPORT GLOBAL
═══════════════════════════════════════════════ */
// Attacher au window pour accès depuis bsi.js, audit-cpam.js, dashboard.js…
if (typeof window !== 'undefined') {
  window.BSI_ENGINE = {
    suggestBSI,
    checkBSIConsistency,
    simulateBSIImpact,
    computeCPAMRisk,
    computeTrustScore,
    saveTrustSnapshot,
    getTrustHistory,
    TARIFS: BSI_TARIFS_2026,
  };
}
