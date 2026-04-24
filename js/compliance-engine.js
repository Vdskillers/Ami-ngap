/* ════════════════════════════════════════════════
   compliance-engine.js — AMI v1.0
   ────────────────────────────────────────────────
   Moteur unifié de conformité médico-légale :
   ────────────────────────────────────────────────
   1. SCORING 4 PILIERS (Consentements · NGAP · BSI · Traçabilité)
       → Score global pondéré (30/30/20/20)
       → Breakdown actionnable par pilier

   2. AUTO-CORRECTION (détection → proposition → simulation → validation)
       → generateActions() : liste priorisée HIGH/MED/LOW
       → simulateFixes()   : gain estimé avant application
       → applyValidatedFixes() : exécution avec audit trail

   3. SCORING PRÉDICTIF (risque futur 30j)
       → predictFutureRisk() : niveau HIGH/MED/LOW + facteurs

   4. PRIORISATION PATIENTS (revenue × risque × conformité)
       → rankPatients() : classement décroissant pour action ciblée

   5. SIMULATION LONG TERME
       → simulateMonth() : projection 30 jours

   ────────────────────────────────────────────────
   Toutes les fonctions sont pures, testables isolément.
   Le moteur ne persiste rien — il lit l'état, calcule, propose.
   Les corrections s'appliquent via les fonctions existantes
   (consentements.js, patients.js, cotation.js).
   ════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════
   1. SCORING — 4 PILIERS
════════════════════════════════════════════════ */

/** Pilier Consentements (30%) */
async function _scoreConsent() {
  if (typeof consentComputeScore !== 'function') return { score: 100, source: 'no_data' };
  const s = await consentComputeScore();
  return { ...s, weight: 0.30 };
}

/** Pilier NGAP — cotations refusées / anomalies (30%)
 *  Lit les anomalies depuis le journal de monitoring si dispo. */
async function _scoreNGAP() {
  try {
    const allPat = (typeof getAllPatients === 'function') ? await getAllPatients() : [];
    let total = 0, clean = 0, anomalies = 0;
    for (const p of allPat) {
      const cots = p.cotations || [];
      for (const c of cots) {
        total++;
        if (c._ngap_anomaly) anomalies++;
        else clean++;
      }
    }
    const score = total ? Math.round((clean / total) * 100) : 100;
    return { score, total, clean, anomalies, weight: 0.30 };
  } catch (_) {
    return { score: 100, source: 'error', weight: 0.30 };
  }
}

/** Pilier BSI — cohérence bilans (20%) */
async function _scoreBSI() {
  try {
    const allPat = (typeof getAllPatients === 'function') ? await getAllPatients() : [];
    let total = 0, coherent = 0;
    for (const p of allPat) {
      if (p.bsi) {
        total++;
        // Heuristique simple : BSI incohérent si pas de type ou sans date récente
        if (p.bsi.type && p.bsi.updated_at) coherent++;
      }
    }
    const score = total ? Math.round((coherent / total) * 100) : 100;
    return { score, total, coherent, incoherent: total - coherent, weight: 0.20 };
  } catch (_) {
    return { score: 100, source: 'error', weight: 0.20 };
  }
}

/** Pilier Traçabilité — signatures + horodatages (20%) */
async function _scoreTrace() {
  try {
    const allPat = (typeof getAllPatients === 'function') ? await getAllPatients() : [];
    let total = 0, traced = 0;
    for (const p of allPat) {
      const cots = p.cotations || [];
      for (const c of cots) {
        total++;
        // Cotation tracée = a une signature ou preuve_soin + date
        if ((c.signature_hash || c.preuve_soin) && c.date) traced++;
      }
    }
    const score = total ? Math.round((traced / total) * 100) : 100;
    return { score, total, traced, weight: 0.20 };
  } catch (_) {
    return { score: 100, source: 'error', weight: 0.20 };
  }
}

/**
 * Calcule le score global pondéré + breakdown par pilier.
 * Renvoie : { global, breakdown: { consent, ngap, bsi, trace } }
 */
async function computeCompliance() {
  const [consent, ngap, bsi, trace] = await Promise.all([
    _scoreConsent(), _scoreNGAP(), _scoreBSI(), _scoreTrace(),
  ]);

  const global = Math.round(
    consent.score * 0.30 +
    ngap.score    * 0.30 +
    bsi.score     * 0.20 +
    trace.score   * 0.20
  );

  return {
    global,
    breakdown: { consent, ngap, bsi, trace },
    computed_at: new Date().toISOString(),
  };
}

/* ════════════════════════════════════════════════
   2. AUTO-CORRECTION
════════════════════════════════════════════════ */

/**
 * Génère la liste priorisée des actions recommandées.
 * Retourne : [{ id, type, priority, label, patient_id, apply?, meta }]
 */
async function generateActions() {
  const actions = [];

  // Consentements manquants / expirés (via consentements.js)
  try {
    if (typeof consentBuildReminders === 'function') {
      const reminders = await consentBuildReminders();
      for (const r of reminders) {
        actions.push({
          id:         r.id,
          type:       r.status === 'expired' ? 'CONSENT_EXPIRED' : 'CONSENT_MISSING',
          priority:   r.priority,
          label:      r.label,
          patient_id: r.patient_id,
          meta:       { consent_type: r.type, status: r.status },
          apply:      () => { // Ouvre le module consentements sur le patient concerné
            if (typeof window.navigate === 'function') window.navigate('consentements');
            setTimeout(() => { if (typeof consentSelectPatient === 'function') consentSelectPatient(r.patient_id); }, 300);
          },
        });
      }
    }
  } catch (_) {}

  // BSI incohérents
  try {
    const allPat = (typeof getAllPatients === 'function') ? await getAllPatients() : [];
    for (const p of allPat) {
      if (p.bsi && !p.bsi.type) {
        actions.push({
          id:         'BSI_' + p.id,
          type:       'BSI_INCOMPLETE',
          priority:   'MEDIUM',
          label:      `BSI à compléter : ${p.nom || ''} ${p.prenom || ''}`.trim(),
          patient_id: p.id,
          meta:       { patient_nom: (p.nom || '') + ' ' + (p.prenom || '') },
          apply:      () => {
            if (typeof window.navigate === 'function') window.navigate('patients');
            setTimeout(() => { if (typeof openPatientDetail === 'function') openPatientDetail(p.id); }, 300);
          },
        });
      }
    }
  } catch (_) {}

  const order = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  actions.sort((a, b) => (order[b.priority] || 0) - (order[a.priority] || 0));
  return actions;
}

/**
 * Simule l'impact de l'application des corrections sur le score.
 * Ne modifie rien — retourne une estimation.
 */
async function simulateFixes(selectedIds, before) {
  const state = before || await computeCompliance();
  const actions = await generateActions();
  const selected = actions.filter(a => selectedIds.includes(a.id));

  if (!selected.length) return { compliance_gain: 0, risk_reduction: 0, revenue_gain: 0, actions_count: 0 };

  // Approximation : chaque HIGH = +2pts conformité, MEDIUM = +1pt, LOW = +0.5pt
  let gain = 0, risk = 0, revenue = 0;
  for (const a of selected) {
    if (a.priority === 'HIGH')   { gain += 2; risk += 5; }
    if (a.priority === 'MEDIUM') { gain += 1; risk += 3; }
    if (a.priority === 'LOW')    { gain += 0.5; risk += 1; }
    // Les corrections NGAP peuvent générer du revenu (moyenne indicative)
    if (a.type.startsWith('NGAP_')) revenue += 15;
  }
  const afterGlobal = Math.min(100, state.global + Math.round(gain));

  return {
    before_global:    state.global,
    after_global:     afterGlobal,
    compliance_gain:  afterGlobal - state.global,
    risk_reduction:   Math.round(risk),
    revenue_gain:     Math.round(revenue),
    actions_count:    selected.length,
  };
}

/**
 * Applique les corrections sélectionnées, avec audit trail.
 * Chaque correction a sa propre fonction apply() — on les exécute séquentiellement.
 * Après application, le reward réel est calculé et loggé côté serveur pour
 * entraîner le moteur RL (/webhook/rl-log-reward).
 */
async function applyValidatedFixes(selectedIds) {
  const actions = await generateActions();
  const selected = actions.filter(a => selectedIds.includes(a.id));
  const results = [];

  // État AVANT (snapshot pour calculer le reward réel)
  let stateBefore = null;
  try { stateBefore = await computeCompliance(); } catch (_) {}

  for (const a of selected) {
    try {
      if (typeof a.apply === 'function') {
        await a.apply();
      }
      if (typeof auditLog === 'function') auditLog('AUTO_FIX_APPLIED', { fix_id: a.id, type: a.type });
      results.push({ id: a.id, ok: true, type: a.type });
    } catch (e) {
      results.push({ id: a.id, ok: false, error: e.message });
    }
  }

  // ── RL : log du reward après application (fire-and-forget) ─────────────
  // Calcule l'état AFTER et envoie au worker pour entraînement futur.
  // Non bloquant — si l'endpoint échoue, l'auto-correction reste valide.
  if (stateBefore && results.some(r => r.ok)) {
    (async () => {
      try {
        // Petit délai pour que les apply() async se propagent dans l'état
        await new Promise(r => setTimeout(r, 200));
        const stateAfter = await computeCompliance();

        const complianceGain = (stateAfter.global || 0) - (stateBefore.global || 0);
        // Reward simple : gain de conformité pondéré
        const reward = complianceGain * 10;

        for (const r of results.filter(x => x.ok)) {
          const action = selected.find(a => a.id === r.id);
          if (!action) continue;
          if (typeof apiCall === 'function') {
            apiCall('/webhook/rl-log-reward', {
              action_type:     action.type,
              action_id:       action.id,
              state_before:    { global: stateBefore.global },
              state_after:     { global: stateAfter.global },
              reward,
              compliance_gain: complianceGain,
              revenue_gain:    0,
              risk_reduction:  Math.max(0, complianceGain),
              context:         { priority: action.priority, label: action.label },
            }).catch(() => {}); // silencieux
          }
        }
      } catch (e) {
        console.warn('[compliance] RL reward log KO:', e.message);
      }
    })();
  }

  return {
    applied: results.filter(r => r.ok).length,
    failed:  results.filter(r => !r.ok).length,
    results,
  };
}

/* ════════════════════════════════════════════════
   3. SCORING PRÉDICTIF — risque futur 30j
════════════════════════════════════════════════ */

/**
 * Prédit le niveau de risque dans les prochains 30 jours
 * à partir des features observées sur le cabinet.
 * Modèle heuristique volontairement simple — remplaçable par ML ensuite.
 */
async function predictFutureRisk() {
  const features = {
    consent_missing_rate: 0,
    bsi_incoherence_rate: 0,
    ngap_anomaly_rate:    0,
    avg_patients_per_day: 0,
    trend:                'STABLE',
  };

  try {
    const comp = await computeCompliance();
    features.consent_missing_rate = (100 - (comp.breakdown.consent?.score ?? 100)) / 100;
    features.bsi_incoherence_rate = (100 - (comp.breakdown.bsi?.score     ?? 100)) / 100;
    features.ngap_anomaly_rate    = (100 - (comp.breakdown.ngap?.score    ?? 100)) / 100;
  } catch (_) {}

  try {
    const allPat = (typeof getAllPatients === 'function') ? await getAllPatients() : [];
    const now = Date.now();
    const recentCots = [];
    for (const p of allPat) {
      for (const c of (p.cotations || [])) {
        if (c.date && (now - new Date(c.date).getTime()) < 7 * 86400000) recentCots.push(c);
      }
    }
    features.avg_patients_per_day = Math.round(recentCots.length / 7);
  } catch (_) {}

  let score = 0;
  score += features.consent_missing_rate * 3;
  score += features.bsi_incoherence_rate * 3;
  score += features.ngap_anomaly_rate    * 2;
  if (features.avg_patients_per_day > 30) score += 1;
  if (features.trend === 'UP') score += 2;

  const level = score >= 5 ? 'HIGH' : score >= 2.5 ? 'MEDIUM' : 'LOW';

  return {
    score:        Math.round(score * 10) / 10,
    level,
    features,
    recommendation: level === 'HIGH'
      ? 'Corriger en priorité les consentements manquants et vérifier la cohérence BSI'
      : level === 'MEDIUM'
        ? 'Surveiller l\'évolution de la traçabilité NGAP'
        : 'Situation saine — maintenir les bonnes pratiques',
  };
}

/* ════════════════════════════════════════════════
   4. PRIORISATION PATIENTS
════════════════════════════════════════════════ */

/**
 * Calcule la priorité d'un patient pour action :
 * priorité = revenue × 0.5 + risque × 20 − conformité × 0.3
 */
function _computePatientPriority(p, monthlyRevenue, riskScore, complianceScore) {
  return (monthlyRevenue || 0) * 0.5 + (riskScore || 0) * 20 - (complianceScore || 0) * 0.3;
}

/**
 * Classe les patients par priorité d'action (plus élevé = plus urgent).
 */
async function rankPatients() {
  try {
    const allPat = (typeof getAllPatients === 'function') ? await getAllPatients() : [];

    // Map consentements par patient pour score individuel
    const consentByPatient = {};
    try {
      const allCons = (typeof _consentGetAllRaw === 'function') ? await _consentGetAllRaw() : [];
      for (const c of allCons) {
        if (c.status === 'archived') continue;
        if (!consentByPatient[c.patient_id]) consentByPatient[c.patient_id] = [];
        consentByPatient[c.patient_id].push(c);
      }
    } catch (_) {}

    const now = Date.now();
    const ranked = allPat.map(p => {
      const cots = p.cotations || [];
      // Revenue 30 derniers jours
      const monthlyRevenue = cots
        .filter(c => c.date && (now - new Date(c.date).getTime()) < 30 * 86400000)
        .reduce((sum, c) => sum + (Number(c.total) || 0), 0);

      // Score conformité patient (0-100)
      const patConsents = consentByPatient[p.id] || [];
      const consentOk = patConsents.filter(c => c.status === 'signed').length;
      const consentTotal = patConsents.length || 1;
      const complianceScore = Math.round((consentOk / consentTotal) * 100);

      // Risque patient (0-1)
      let riskScore = 0;
      if (complianceScore < 70) riskScore += 0.3;
      if (!p.bsi || !p.bsi.type) riskScore += 0.2;
      if (cots.length > 20 && patConsents.length === 0) riskScore += 0.3;
      riskScore = Math.min(1, riskScore);

      const priority = _computePatientPriority(p, monthlyRevenue, riskScore, complianceScore);

      return {
        id:         p.id,
        nom:        p.nom,
        prenom:     p.prenom,
        monthly_revenue: Math.round(monthlyRevenue * 100) / 100,
        compliance_score: complianceScore,
        risk_score: Math.round(riskScore * 100) / 100,
        priority:   Math.round(priority * 100) / 100,
        level:      riskScore > 0.6 ? 'HIGH' : riskScore > 0.3 ? 'MEDIUM' : 'LOW',
      };
    });

    ranked.sort((a, b) => b.priority - a.priority);
    return ranked;
  } catch (e) {
    console.warn('[compliance] rankPatients KO:', e.message);
    return [];
  }
}

/* ════════════════════════════════════════════════
   5. SIMULATION LONG TERME (30 jours)
════════════════════════════════════════════════ */

/**
 * Projette l'évolution du cabinet sur 30 jours à partir de l'état courant.
 * Hypothèse : corrections appliquées progressivement + inertie naturelle.
 */
async function simulateMonth(initialState) {
  const state = initialState || await computeCompliance();
  const risk  = await predictFutureRisk();

  // Hypothèse : si rien n'est fait, la conformité dérive légèrement selon le risque
  const driftPerDay = risk.level === 'HIGH' ? -0.5
                    : risk.level === 'MEDIUM' ? -0.15
                    : 0;

  let currentGlobal = state.global;
  const trajectory = [];
  for (let day = 0; day < 30; day++) {
    currentGlobal = Math.max(0, Math.min(100, currentGlobal + driftPerDay));
    if (day % 5 === 0) trajectory.push({ day, global: Math.round(currentGlobal) });
  }

  // Revenu moyen — à raffiner avec historique réel
  const ranked = await rankPatients();
  const monthlyRevenue = ranked.reduce((sum, p) => sum + (p.monthly_revenue || 0), 0);

  return {
    start_global:  state.global,
    end_global:    Math.round(currentGlobal),
    trajectory,
    projected_revenue: Math.round(monthlyRevenue),
    risk_level:    risk.level,
    recommendation: risk.recommendation,
  };
}

/* ════════════════════════════════════════════════
   EXPORT AUDIT — rapport prêt contrôle
════════════════════════════════════════════════ */

/**
 * Construit un rapport d'audit complet, prêt à exporter (JSON / PDF via rapport.js).
 */
async function buildAuditReport() {
  const [comp, actions, risk, ranking] = await Promise.all([
    computeCompliance(),
    generateActions(),
    predictFutureRisk(),
    rankPatients(),
  ]);

  return {
    generated_at: new Date().toISOString(),
    cabinet_id:   APP?.get?.('cabinet')?.id || null,
    user_id:      APP?.user?.id || null,
    compliance:   comp,
    future_risk:  risk,
    pending_actions: {
      total: actions.length,
      high:  actions.filter(a => a.priority === 'HIGH').length,
      medium: actions.filter(a => a.priority === 'MEDIUM').length,
      low:   actions.filter(a => a.priority === 'LOW').length,
      list:  actions.slice(0, 50).map(a => ({
        id: a.id, type: a.type, priority: a.priority, label: a.label,
      })),
    },
    top_priority_patients: ranking.slice(0, 10),
  };
}

/**
 * Export rapport audit en JSON téléchargeable.
 */
async function exportAuditJSON() {
  const report = await buildAuditReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `audit-conformite-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return report;
}

/* ════════════════════════════════════════════════
   RENDU UI — vue "Conformité cabinet"
════════════════════════════════════════════════ */
async function renderComplianceDashboard() {
  // Lookup dual container :
  //   • #compliance-root       → ancien onglet dédié (legacy, peut être absent)
  //   • #compliance-block      → nouvel emplacement : bloc inséré dans la page
  //                               "Cabinet & synchronisation" (cabinet.js)
  const wrap = document.getElementById('compliance-root')
             || document.getElementById('compliance-block');
  if (!wrap) return;

  // Si on rend dans la page Cabinet, on n'affiche pas de h1 (il y en a déjà un)
  // et on n'affiche pas la carte "aucun cabinet" car la page Cabinet gère elle-même ce cas.
  const isEmbeddedInCabinet = (wrap.id === 'compliance-block');
  const titleTag = isEmbeddedInCabinet ? 'h2' : 'h1';
  const titleClass = isEmbeddedInCabinet ? 'ct' : 'pt';

  // 🛡️ Guard cabinet — la vue « Conformité cabinet » n'a de sens que si on est dans un cabinet.
  // Hors cabinet : on affiche un état vide explicite avec CTA (pas de score fantôme).
  const cab = (typeof APP !== 'undefined' && APP.get) ? APP.get('cabinet') : null;
  if (!cab?.id) {
    // Dans le mode embedded, on n'affiche RIEN si pas de cabinet — la page parent gère déjà ce cas
    if (isEmbeddedInCabinet) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <h1 class="pt">Conformité <em>cabinet</em></h1>
      <p class="ps">Score global · Auto-correction · Risque futur · Patients prioritaires</p>
      <div class="card" style="text-align:center;padding:40px 20px">
        <div style="font-size:48px;margin-bottom:12px">🏥</div>
        <div style="font-size:15px;font-weight:600;color:var(--t);margin-bottom:6px">
          Aucun cabinet actif
        </div>
        <div style="font-size:13px;color:var(--m);max-width:520px;margin:0 auto 20px;line-height:1.55">
          Le tableau de conformité agrège les scores consentements, NGAP, BSI et traçabilité
          à l'échelle d'un cabinet. Rejoignez ou créez un cabinet pour activer le suivi.
        </div>
        <button class="btn bp bsm" onclick="navTo('cabinet',null)">
          <span>🏥</span> Rejoindre ou créer un cabinet
        </button>
      </div>
    `;
    return;
  }

  wrap.innerHTML = `<div class="card"><div class="sk" style="height:140px"></div></div>`;

  const [comp, actions, risk, ranking, sim, a11opps] = await Promise.all([
    computeCompliance(),
    generateActions(),
    predictFutureRisk(),
    rankPatients(),
    simulateMonth(),
    // Opportunités Avenant 11 (non bloquant)
    (typeof complianceA11OpportunitiesAll === 'function' ? complianceA11OpportunitiesAll() : Promise.resolve(null)).catch(() => null),
  ]);

  const scoreColor = v => v >= 90 ? '#00d4aa' : v >= 70 ? '#f59e0b' : '#ef4444';
  const riskColor  = l => l === 'LOW' ? '#00d4aa' : l === 'MEDIUM' ? '#f59e0b' : '#ef4444';

  // Carte "Opportunités Avenant 11" — uniquement si complianceA11OpportunitiesAll() a renvoyé des résultats
  const a11Card = (a11opps && a11opps.total_opportunities > 0) ? `
    <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(124,58,237,.02));border:1px solid rgba(168,85,247,.3)">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <span style="font-size:20px">🆕</span>
        <strong style="color:#a855f7;font-family:var(--fm);font-size:13px;letter-spacing:.3px">AVENANT 11 — ${a11opps.total_opportunities} opportunités détectées</strong>
        <span style="margin-left:auto;font-family:var(--fm);color:#a855f7;font-weight:700;font-size:14px">+${(a11opps.total_gain_eur||0).toFixed(2)} €</span>
      </div>
      <div style="font-size:12px;color:var(--m);line-height:1.5;margin-bottom:10px">
        Cotations Avenant 11 (CIA/CIB, MSG, AMI 3.48, RKD…) potentiellement applicables chez ${a11opps.patients.length} patient(s).
        <br>
        <em style="color:#f59e0b">⏰ Revalorisations AMI non effectives avant le 01/11/2026.</em>
      </div>
      <details style="margin-top:8px">
        <summary style="cursor:pointer;font-family:var(--fm);font-size:11px;color:#a855f7;letter-spacing:.3px">📋 VOIR LA LISTE PAR PATIENT</summary>
        <div style="margin-top:10px;max-height:320px;overflow-y:auto">
          ${a11opps.patients.slice(0, 30).map(p => `
            <div style="padding:8px 10px;background:var(--s);border-radius:6px;margin-bottom:6px;font-size:12px">
              <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
                <strong style="color:var(--t)">${(p.patient_nom || p.patient_id)}</strong>
                <span style="margin-left:auto;color:#a855f7;font-family:var(--fm);font-weight:700">+${(p.gain_eur||0).toFixed(2)} €</span>
              </div>
              ${p.opportunities.map(o => `
                <div style="padding-left:12px;font-size:11px;color:var(--m);line-height:1.6">
                  • <code style="background:rgba(168,85,247,.15);color:#a855f7;padding:1px 5px;border-radius:3px;font-family:var(--fm);font-size:10px">${o.code}</code>
                  ${o.titre} <span style="color:#f59e0b;font-size:10px">(${o.date_effet})</span>
                </div>`).join('')}
            </div>`).join('')}
          ${a11opps.patients.length > 30 ? `<div style="text-align:center;color:var(--m);font-size:11px;padding:6px">…et ${a11opps.patients.length - 30} autres patients</div>` : ''}
        </div>
      </details>
    </div>` : '';

  wrap.innerHTML = `
    <${titleTag} class="${titleClass}" ${isEmbeddedInCabinet ? 'style="margin-top:24px"' : ''}>🛡️ Conformité <em>cabinet</em></${titleTag}>
    ${!isEmbeddedInCabinet ? '<p class="ps">Score global · Auto-correction · Risque futur · Patients prioritaires</p>' : '<p style="font-size:12px;color:var(--m);margin:-4px 0 14px 0">Score global · Auto-correction · Risque futur · Patients prioritaires · Opportunités Avenant 11</p>'}

    ${a11Card}

    <!-- Score global + 4 piliers -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:140px 1fr;gap:20px;align-items:center">
        <div style="text-align:center">
          <div style="font-size:48px;font-weight:800;color:${scoreColor(comp.global)};font-family:var(--fs)">${comp.global}</div>
          <div style="font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:1px">Score global</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px">
          <div><div style="font-size:11px;color:var(--m)">Consentements</div>
            <div style="font-size:18px;font-weight:700;color:${scoreColor(comp.breakdown.consent.score)}">${comp.breakdown.consent.score}%</div></div>
          <div><div style="font-size:11px;color:var(--m)">NGAP</div>
            <div style="font-size:18px;font-weight:700;color:${scoreColor(comp.breakdown.ngap.score)}">${comp.breakdown.ngap.score}%</div></div>
          <div><div style="font-size:11px;color:var(--m)">BSI</div>
            <div style="font-size:18px;font-weight:700;color:${scoreColor(comp.breakdown.bsi.score)}">${comp.breakdown.bsi.score}%</div></div>
          <div><div style="font-size:11px;color:var(--m)">Traçabilité</div>
            <div style="font-size:18px;font-weight:700;color:${scoreColor(comp.breakdown.trace.score)}">${comp.breakdown.trace.score}%</div></div>
        </div>
      </div>
    </div>

    <!-- Risque futur + projection 30j -->
    <div class="card" style="margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Risque à 30 jours</div>
        <div style="font-size:24px;font-weight:700;color:${riskColor(risk.level)}">${risk.level}</div>
        <div style="font-size:11px;color:var(--m);margin-top:8px;line-height:1.4">${risk.recommendation}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Projection 30 jours</div>
        <div style="font-size:18px;color:var(--t)">Conformité : <strong style="color:${scoreColor(sim.end_global)}">${sim.end_global}%</strong></div>
        <div style="font-size:11px;color:var(--m);margin-top:4px">Revenu projeté : <strong>${sim.projected_revenue} €</strong></div>
      </div>
    </div>

    <!-- Actions recommandées -->
    ${actions.length ? `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div style="font-weight:600">⚡ ${actions.length} action${actions.length>1?'s':''} recommandée${actions.length>1?'s':''}</div>
        <button class="btn bs bsm" onclick="complianceApplyAll()">Corriger tout</button>
      </div>
      <div id="compliance-actions-list">
        ${actions.slice(0, 10).map(a => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--b);gap:10px">
            <div style="flex:1;min-width:0">
              <span style="color:${a.priority==='HIGH'?'#ef4444':a.priority==='MEDIUM'?'#f59e0b':'#6b7280'};margin-right:6px">
                ${a.priority==='HIGH'?'🔴':a.priority==='MEDIUM'?'🟠':'🟡'}
              </span>
              <span style="font-size:12px">${a.label}</span>
            </div>
            <button class="btn bs" style="font-size:11px;padding:4px 10px" onclick="complianceApplyOne('${a.id}')">Corriger</button>
          </div>
        `).join('')}
      </div>
      ${actions.length > 10 ? `<div style="font-size:11px;color:var(--m);margin-top:8px">+${actions.length-10} autres actions…</div>` : ''}
    </div>` : `
    <div class="card" style="margin-bottom:16px;border-left:4px solid #00d4aa">
      <div style="font-size:13px">✅ Aucune action en attente — cabinet conforme.</div>
    </div>`}

    <!-- Top patients prioritaires -->
    ${ranking.length ? `
    <div class="card" style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:10px">💰 Patients prioritaires</div>
      ${ranking.slice(0, 5).map((p, i) => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--b);gap:10px">
          <div><strong>${i+1}. ${p.prenom||''} ${p.nom||''}</strong>
            <span style="color:${riskColor(p.level)};margin-left:6px;font-size:11px">${p.level}</span></div>
          <div style="font-size:11px;color:var(--m)">Rev : ${p.monthly_revenue}€ · Conf : ${p.compliance_score}%</div>
        </div>
      `).join('')}
    </div>` : ''}

    <!-- Actions utilitaires -->
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn bp bsm" onclick="complianceExport()">📥 Export audit JSON</button>
      <button class="btn bs bsm" onclick="renderComplianceDashboard()">🔄 Actualiser</button>
    </div>
  `;
}

async function complianceApplyOne(id) {
  if (typeof showToast === 'function') showToast('info', 'Correction en cours…');
  const r = await applyValidatedFixes([id]);
  if (typeof showToast === 'function')
    showToast(r.applied ? 'success' : 'error',
      r.applied ? 'Correction appliquée' : 'Erreur',
      r.applied ? 'L\'action a été exécutée' : 'Aucune correction appliquée');
  setTimeout(() => renderComplianceDashboard(), 500);
}

async function complianceApplyAll() {
  const actions = await generateActions();
  const ids = actions.map(a => a.id);
  if (!ids.length) return;

  const impact = await simulateFixes(ids);
  const ok = confirm(
    `Appliquer ${ids.length} correction${ids.length>1?'s':''} ?\n\n` +
    `Conformité estimée : ${impact.before_global}% → ${impact.after_global}%\n` +
    `Gain : +${impact.compliance_gain} pts\n` +
    `Risque réduit : -${impact.risk_reduction} pts`
  );
  if (!ok) return;

  if (typeof showToast === 'function') showToast('info', 'Corrections en cours…');
  const r = await applyValidatedFixes(ids);
  if (typeof showToast === 'function')
    showToast('success', `${r.applied} correction${r.applied>1?'s':''} appliquée${r.applied>1?'s':''}`);
  setTimeout(() => renderComplianceDashboard(), 500);
}

async function complianceExport() {
  try {
    await exportAuditJSON();
    if (typeof showToast === 'function') showToast('success', 'Audit exporté', 'Fichier téléchargé');
  } catch (e) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', e.message);
  }
}

/* ════════════════════════════════════════════════
   EXPORT — API publique
════════════════════════════════════════════════ */
window.computeCompliance       = computeCompliance;
window.generateActions         = generateActions;
window.simulateFixes           = simulateFixes;
window.applyValidatedFixes     = applyValidatedFixes;
window.predictFutureRisk       = predictFutureRisk;
window.rankPatients            = rankPatients;
window.simulateMonth           = simulateMonth;
window.buildAuditReport        = buildAuditReport;
window.exportAuditJSON         = exportAuditJSON;
window.renderComplianceDashboard = renderComplianceDashboard;
window.complianceApplyOne      = complianceApplyOne;
window.complianceApplyAll      = complianceApplyAll;
window.complianceExport        = complianceExport;

document.addEventListener('ui:navigate', e => {
  const view = e.detail?.view;
  if (view === 'compliance') renderComplianceDashboard();
  // Depuis l'Avenant 11 : le dashboard de conformité est aussi rendu dans
  // la page Cabinet & synchronisation (container #compliance-block).
  // On laisse cabinet.js déclencher le render après son propre rendu,
  // mais on garde un fallback ici : si l'utilisateur re-navigue sur le cabinet
  // et que le block existe déjà, on re-render.
  if (view === 'cabinet') {
    setTimeout(() => {
      if (document.getElementById('compliance-block')) renderComplianceDashboard();
    }, 300);
  }
});

/* ════════════════════════════════════════════════════════════════
   AVENANT 11 — Détection d'opportunités de cotation
   ────────────────────────────────────────────────────────────────
   Analyse un patient (ou tous) et retourne les opportunités non
   exploitées depuis l'Avenant 11 :
     • CIA : diabète T2 sous insuline <6 mois (jamais coté)
     • CIB : bilan prévention âge-clé (jamais coté en suivi)
     • MSG : patient avec BSC + SEGA ≥ 35 (non coté)
     • AMI3.48 : plaie chronique ALD 15/23 (bilan annuel manquant)
     • RKD : kit dépistage colorectal non délivré (50-74 ans)
     • AMI2.02 accès direct : pansements sous prescription inutile (≥01/01/2027)

   Non-intrusif : détecte seulement, ne modifie rien.
   Non-effectif avant novembre 2026 pour les tarifs AMI.
═══════════════════════════════════════════════════════════════ */

async function complianceA11Opportunities(patient) {
  const opportunities = [];
  if (!patient) return opportunities;

  const cots = patient.cotations || [];
  const age = _computeAge(patient.date_naissance);
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 10);
  const oneYearAgo = new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10);

  // Helper : présence d'un code dans les cotations
  const hasCode = (codeRx, sinceDate) => cots.some(c => {
    const actes = Array.isArray(c.actes) ? c.actes : [c];
    const date = c.date || c.date_soin || '';
    if (sinceDate && date < sinceDate) return false;
    return actes.some(a => codeRx.test(String(a.code || '').toUpperCase()));
  });

  // Diagnostic infos (tolérant aux schémas différents)
  const diag = {
    ald:       String(patient.ald || '').toUpperCase(),
    ald_codes: Array.isArray(patient.ald_codes) ? patient.ald_codes.map(c => String(c).toUpperCase()) : [],
    diabete:   /diabet|insulin|glycemi|dt2|type\s*2/i.test(JSON.stringify(patient).slice(0, 5000)),
    insuline:  /insulin/i.test(JSON.stringify(patient.traitements || patient.medicaments || patient.notes || '').slice(0, 5000)),
    sega:      Number(patient.sega_score || patient.sega || 0),
    bsi_type:  String((patient.bsi || {}).type || '').toUpperCase(),
    plaies:    Array.isArray(patient.plaies) ? patient.plaies : [],
  };

  /* ── CIA : instauration insuline DT2 ── */
  if (diag.diabete && diag.insuline && !hasCode(/^CIA$/, oneYearAgo)) {
    opportunities.push({
      level: 'info',
      code: 'CIA',
      titre: 'Consultation instauration insuline (CIA) éligible',
      detail: 'Patient diabétique T2 sous insuline — jusqu\'à 4 consultations CIA (20€) dans les 6 premiers mois de traitement.',
      gain_estime_eur: 80,   // 4 × 20€
      date_effet: 'À partir parution JO Avenant 11',
      reference: 'Avenant 11 — art. consultation infirmière CIA',
    });
  }

  /* ── MSG : Majoration Soins Gériatriques ── */
  if (diag.bsi_type === 'BSC' && diag.sega >= 35 && !hasCode(/^MSG$/, oneYearAgo)) {
    opportunities.push({
      level: 'warn',
      code: 'MSG',
      titre: 'Majoration Soins Gériatriques (MSG) non appliquée',
      detail: `Patient BSC avec score SEGA ${diag.sega} (≥35) — MSG +3.10€/jour non facturée.`,
      gain_estime_eur: 3.10 * 30, // ~mensuel
      date_effet: 'À partir parution JO Avenant 11',
      reference: 'Avenant 11 — MSG réservée BSC + SEGA ≥35',
    });
  }

  /* ── AMI3.48 : bilan plaie annuel pour plaie chronique en ALD ── */
  const hasPlaieChronique = diag.plaies.some(p => /chronique|ulcere|escarre|pied\s*diabet/i.test(String(p.type || p.label || '')));
  const aldMatchPlaie = /15|23/.test(diag.ald) || diag.ald_codes.some(c => /ALD\s*(15|23)/.test(c));
  if (hasPlaieChronique && aldMatchPlaie && !hasCode(/^AMI\s*3\.48$/, oneYearAgo)) {
    opportunities.push({
      level: 'info',
      code: 'AMI3.48',
      titre: 'Bilan annuel plaie (AMI 3.48) éligible',
      detail: 'Plaie chronique + ALD 15/23 — bilan annuel (10.96€) non facturé sur 12 derniers mois. Max 1×/an, hors BSI.',
      gain_estime_eur: 10.96,
      date_effet: '01/01/2027',
      reference: 'Avenant 11 — art. bilan plaie à risque de complication',
    });
  }

  /* ── RKD : kit dépistage colorectal (50-74 ans) ── */
  if (age >= 50 && age <= 74 && !hasCode(/^RKD$/, oneYearAgo)) {
    opportunities.push({
      level: 'info',
      code: 'RKD',
      titre: 'Kit dépistage cancer colorectal (RKD) non délivré',
      detail: `Patient ${age} ans (50-74) — remise kit RKD (3€) + 2€ si test réalisé. PEC 100% AM.`,
      gain_estime_eur: 5,
      date_effet: '01/01/2027',
      reference: 'Avenant 11 — dépistage organisé cancer colorectal',
    });
  }

  /* ── CIB : suivi post-bilan prévention (25, 45, 65, 70 ans) ── */
  const agesBilan = [25, 45, 65, 70];
  if (agesBilan.some(a => Math.abs(age - a) <= 2) && !hasCode(/^CIB$/, oneYearAgo)) {
    opportunities.push({
      level: 'info',
      code: 'CIB',
      titre: 'Consultation suivi bilan prévention (CIB) éligible',
      detail: `Patient ${age} ans (proche âge-clé) — consultation CIB 20€ si bilan prévention réalisé. Max 4/bilan.`,
      gain_estime_eur: 80,
      date_effet: '01/07/2027 (sous réserve HAS)',
      reference: 'Avenant 11 — consultation post-bilan prévention',
    });
  }

  return opportunities;
}

/** Helper local : calcul d'âge tolérant */
function _computeAge(dateNaissance) {
  if (!dateNaissance) return 0;
  try {
    const d = new Date(dateNaissance);
    if (isNaN(d.getTime())) return 0;
    const diff = Date.now() - d.getTime();
    return Math.floor(diff / (365.25 * 864e5));
  } catch { return 0; }
}

/** Agrège les opportunités sur tout le panier patients */
async function complianceA11OpportunitiesAll() {
  if (typeof getAllPatients !== 'function') return { patients: [], total_opportunities: 0, total_gain_eur: 0 };
  const allPat = await getAllPatients();
  const out = [];
  let total_gain = 0;
  for (const p of allPat) {
    const opps = await complianceA11Opportunities(p);
    if (opps.length) {
      const gain = opps.reduce((s, o) => s + (Number(o.gain_estime_eur) || 0), 0);
      total_gain += gain;
      out.push({
        patient_id: p.id || p.code || '?',
        patient_nom: p.nom || p.name || '',
        opportunities: opps,
        gain_eur: Math.round(gain * 100) / 100,
      });
    }
  }
  return {
    patients: out,
    total_opportunities: out.reduce((s, x) => s + x.opportunities.length, 0),
    total_gain_eur: Math.round(total_gain * 100) / 100,
    generated_at: new Date().toISOString(),
    warning_dates_effet: {
      note: 'Les revalorisations tarifaires Avenant 11 ne sont pas effectives avant novembre 2026.',
      ami_step_1: '2026-11-01',
      ami_step_2: '2027-11-01',
    }
  };
}

window.complianceA11Opportunities    = complianceA11Opportunities;
window.complianceA11OpportunitiesAll = complianceA11OpportunitiesAll;

// Log Avenant 11 lors du hot-swap du référentiel (par NGAPUpdateManager)
document.addEventListener('ngap:ref_updated', (e) => {
  if (window.console && console.info) {
    console.info('[compliance-engine] Référentiel NGAP v2 chargé —',
      (e.detail && e.detail.version) || '?',
      '— opportunités Avenant 11 disponibles via complianceA11OpportunitiesAll()');
  }
});
