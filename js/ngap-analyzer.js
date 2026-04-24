/* ════════════════════════════════════════════════════════════════
   ngap-analyzer.js — AMI NGAP
   ────────────────────────────────────────────────────────────────
   Module d'enrichissement du moteur NGAP :
     1. Détection d'anomalies dans le référentiel (tarifs aberrants,
        règles CIR-9/2025 manquantes, sous-cotations)
     2. Analyse des cotations RÉELLES (pipeline admin) → pertes €
        pattern récurrents + suggestions de correction auditables
     3. Auto-correction temps réel pendant la saisie (cotation.js)

   Architecture :
     • 100% additif — ne modifie aucune fonction existante
     • expose window.NGAPAnalyzer (namespace global)
     • côté front — s'appuie sur window.NGAP_REFERENTIEL
       (chargé par index.html via /api/ngap/referentiel)
     • côté admin — appelle /webhook/admin-ngap-analyze-real
       (route worker ajoutée séparément)

   Audit-safe :
     • ne sur-cote JAMAIS : propose uniquement, ne remplace pas
     • toutes les suggestions sont ancrées à une règle NGAP documentée
     • aucun envoi de données patient côté client (hash only)

   Dépendances :
     • window.NGAP_REFERENTIEL  (chargé au boot)
     • wpost() / apiCall()      (utils.js)
     • showToast()              (ui.js)
     • S.role === 'admin'       (auth.js)
════════════════════════════════════════════════════════════════ */

(function(){
  'use strict';

  /* ══ Garde-fou : éviter double-chargement ══ */
  if (window.NGAPAnalyzer) return;

  /* ─── Constantes internes ─────────────────────── */
  // Majorations + indemnités + consultations dédiées (Avenant 11 inclus)
  const _MAJ_CODES = new Set([
    // Historiques
    'DIM','NUIT','NUIT_PROF','IFD','IFI','MIE','MCI','MAU','IK','ISD','ISN_NUIT','ISN_NUIT_PROFONDE',
    // Avenant 11 du 31/03/2026
    'MSG','MSD','MIR',       // Majoration Soins Gériatriques, Scolaire Diabète, Intervention Régulée
    'CIA','CIB',             // Consultations infirmières dédiées (20€, séance isolée)
    'RKD',                   // Remise Kit Dépistage colorectal
    'IAS_PDSA'               // Indemnité d'Astreinte PDSA (52€/4h)
  ]);
  const _LOSS_THRESHOLD = 0.5;  // seuil € pour considérer une perte significative

  /* ════════════════════════════════════════════════
     A. HELPERS — recherche dans le référentiel
  ════════════════════════════════════════════════ */

  function _getTarif(ref, code) {
    if (!ref || !code) return null;
    const norm = String(code).toUpperCase().replace(/\s+/g,'').replace(/,/g,'.');
    const all  = [...(ref.actes_chapitre_I||[]), ...(ref.actes_chapitre_II||[])];
    const acte = all.find(a =>
      a.code === norm.replace(/\./g,'_') ||
      a.code_facturation === norm ||
      a.code === norm
    );
    if (acte) return acte.tarif;
    // Forfaits BSI
    if (ref.forfaits_bsi && ref.forfaits_bsi[norm] && typeof ref.forfaits_bsi[norm] === 'object') {
      return ref.forfaits_bsi[norm].tarif;
    }
    // Majorations
    if (ref.majorations) {
      const key = Object.keys(ref.majorations).find(k =>
        k === norm || ref.majorations[k].code_alias === norm
      );
      if (key) return ref.majorations[key].tarif;
    }
    // Déplacements
    if (ref.deplacements && ref.deplacements[norm]) return ref.deplacements[norm].tarif || null;
    // Avenant 11 : lettres-clés nouvelles (CIA=20€, CIB=20€, RKD=3€)
    if (ref.lettres_cles && ref.lettres_cles[norm] && ref.lettres_cles[norm].valeur != null) {
      return ref.lettres_cles[norm].valeur;
    }
    // Avenant 11 : indemnités d'astreinte (IAS_PDSA=52€)
    if (ref.indemnites_astreinte && ref.indemnites_astreinte[norm] && ref.indemnites_astreinte[norm].tarif != null) {
      return ref.indemnites_astreinte[norm].tarif;
    }
    return null;
  }

  function _hasRuleInRef(ref, keywords) {
    const txt = JSON.stringify(ref || {});
    return keywords.every(k => txt.toUpperCase().includes(String(k).toUpperCase()));
  }

  /* ════════════════════════════════════════════════
     B. ANALYZE RÉFÉRENTIEL — détection d'anomalies
     Retourne un tableau de suggestions { level, msg, fix? }
  ════════════════════════════════════════════════ */

  function analyzeReferentiel(ref) {
    ref = ref || window.NGAP_REFERENTIEL;
    if (!ref) return [{ level:'error', msg:'Référentiel NGAP non chargé.' }];
    const out = [];

    /* ── 1. Perfusions : AMI14 doit être > AMI9 ── */
    const ami9   = _getTarif(ref, 'AMI9');
    const ami14  = _getTarif(ref, 'AMI14');
    const ami15  = _getTarif(ref, 'AMI15');
    if (ami9 != null && ami14 != null && ami14 <= ami9) {
      out.push({
        level:'warning',
        msg:`⚠️ Tarif anormal : AMI14 (${ami14}€) ≤ AMI9 (${ami9}€) — perfusion longue devrait rapporter plus qu'une courte.`,
        fix:{ type:'set_tarif', code:'AMI14', value:44.10 }
      });
    }
    if (ami9 != null && ami15 != null && ami15 <= ami9) {
      out.push({
        level:'warning',
        msg:`⚠️ Tarif anormal : AMI15 (${ami15}€) ≤ AMI9 (${ami9}€).`,
        fix:{ type:'set_tarif', code:'AMI15', value:47.25 }
      });
    }

    /* ── 2. AMI4.1 — erreur classique (ne doit pas être <10€) ── */
    const ami41 = _getTarif(ref, 'AMI4.1');
    if (ami41 != null && ami41 < 10) {
      out.push({
        level:'warning',
        msg:`⚠️ AMI4.1 suspect (${ami41}€) — tarif officiel 2026 : 12.92€.`,
        fix:{ type:'set_tarif', code:'AMI4.1', value:12.92 }
      });
    }

    /* ── 3. Forfaits BSI 2026 — vérification BSB=18.20, BSC=28.70 ── */
    const bsb = _getTarif(ref, 'BSB');
    const bsc = _getTarif(ref, 'BSC');
    if (bsb != null && Math.abs(bsb - 18.20) > 0.01) {
      out.push({
        level:'warning',
        msg:`⚠️ BSB (${bsb}€) ≠ tarif officiel 2026 (18.20€).`,
        fix:{ type:'set_tarif', code:'BSB', value:18.20 }
      });
    }
    if (bsc != null && Math.abs(bsc - 28.70) > 0.01) {
      out.push({
        level:'warning',
        msg:`⚠️ BSC (${bsc}€) ≠ tarif officiel 2026 (28.70€).`,
        fix:{ type:'set_tarif', code:'BSC', value:28.70 }
      });
    }

    /* ── 4. Règle CIR-9/2025 AMI14 + AMI15 présente ? ── */
    const hasCir9 = (ref.incompatibilites||[]).some(i =>
      (i.groupe_a||[]).some(c => /AMI1[45]/.test(c)) &&
      (i.groupe_b||[]).some(c => /AMI1[45]/.test(c))
    );
    if (!hasCir9) {
      out.push({
        level:'critical',
        msg:'🚨 Règle CIR-9/2025 absente : AMI14 + AMI15 même jour interdits (risque redressement CPAM).',
        fix:{ type:'add_incompatibilite', rule:{
          groupe_a:['AMI14','AMX14'],
          groupe_b:['AMI15','AMX15'],
          supprimer:'groupe_a',
          msg:'CIR-9/2025 : AMI14 + AMI15 interdits',
          severity:'critical'
        }}
      });
    }

    /* ── 5. Heuristiques sous-cotation (informatif) ── */
    out.push({
      level:'info',
      msg:'💡 Rappel : perfusion >1h → AMI14/15 (pas AMI5/6). Perfusion ≤1h → AMI9/10 (pas AMI4).'
    });

    /* ── 6. MIE 2026 — doit être à 3.15€ ── */
    const mie = _getTarif(ref, 'MIE');
    if (mie != null && Math.abs(mie - 3.15) > 0.01) {
      out.push({
        level:'warning',
        msg:`⚠️ MIE (${mie}€) ≠ tarif 2026 (3.15€).`,
        fix:{ type:'set_tarif', code:'MIE', value:3.15 }
      });
    }

    return out;
  }

  /* ════════════════════════════════════════════════
     C. APPLY FIX — mutation non destructive
     Retourne un NOUVEAU référentiel patché (immutable)
  ════════════════════════════════════════════════ */

  function applyNGAPFix(refOrText, fix) {
    if (!fix || !fix.type) return refOrText;
    let ref;
    const isText = typeof refOrText === 'string';
    try { ref = isText ? JSON.parse(refOrText) : JSON.parse(JSON.stringify(refOrText)); }
    catch (e) { console.error('[NGAPAnalyzer] applyFix parse KO:', e.message); return refOrText; }

    if (fix.type === 'set_tarif') {
      const code = String(fix.code || '').toUpperCase();
      const norm = code.replace(/\./g,'_');
      const all  = [...(ref.actes_chapitre_I||[]), ...(ref.actes_chapitre_II||[])];
      const acte = all.find(a => a.code === norm || a.code_facturation === code);
      if (acte) acte.tarif = fix.value;
      else if (ref.forfaits_bsi && ref.forfaits_bsi[code]) ref.forfaits_bsi[code].tarif = fix.value;
      else if (ref.majorations) {
        const key = Object.keys(ref.majorations).find(k =>
          k === code || ref.majorations[k].code_alias === code
        );
        if (key) ref.majorations[key].tarif = fix.value;
      }
    } else if (fix.type === 'add_incompatibilite' && fix.rule) {
      ref.incompatibilites = ref.incompatibilites || [];
      ref.incompatibilites.push(fix.rule);
    }
    return isText ? JSON.stringify(ref, null, 2) : ref;
  }

  /* ════════════════════════════════════════════════
     D. LIVE ANALYZE — auto-correction temps réel
     Appelée par cotation.js pendant la saisie (debounced)
     NE MODIFIE JAMAIS le DOM, retourne juste des données
  ════════════════════════════════════════════════ */

  function _detectActsFromText(text) {
    if (!text) return [];
    const t = String(text).toLowerCase();
    const codes = [];

    /* ── Perfusion ── */
    if (/perfusion|baxter|picc|midline/.test(t)) {
      const cancer = /cancer|chimio|immunod|onco/.test(t);
      const longue = /12\s*h|24\s*h|longue|>1h|nuit|continue|baxter|journée/.test(t);
      const courte = /30\s*min|45\s*min|1h|courte|≤1h|bref/.test(t);
      const retrait = /retrait|enlev|ablation.*picc|fin.*perf/.test(t);

      if (retrait) codes.push({ code: 'AMI5', _hint:'retrait perfusion' });
      else if (longue) codes.push({ code: cancer ? 'AMI15' : 'AMI14', _hint:'perfusion longue' });
      else if (courte) codes.push({ code: cancer ? 'AMI10' : 'AMI9', _hint:'perfusion courte' });
    }

    /* ── Pansements complexes ── */
    if (/ulcère|escarre.*prof|brûlure|fistule|plaie.*complexe|amputation/.test(t)) {
      codes.push({ code: 'AMI4', _hint:'pansement complexe' });
    } else if (/pansement/.test(t) && !codes.length) {
      codes.push({ code: 'AMI2', _hint:'pansement simple' });
    }

    /* ── Injections ── */
    if (/insuline/.test(t)) codes.push({ code:'AMI1', _hint:'injection insuline' });
    else if (/im\b|intra.?musculaire/.test(t) && !codes.length) codes.push({ code:'AMI1', _hint:'injection IM' });
    else if (/iv\b|intraveineuse/.test(t) && !codes.length) codes.push({ code:'AMI2', _hint:'injection IV' });

    /* ── BSI / AIS ── */
    if (/bsi.*lourd|dépendance.*lourde/.test(t)) codes.push({ code:'BSC', _hint:'BSI lourd' });
    else if (/bsi.*intermédiaire|dépendance.*modérée/.test(t)) codes.push({ code:'BSB', _hint:'BSI intermédiaire' });
    else if (/bsi.*léger|bsi\b/.test(t) && !codes.some(c=>/BS/.test(c.code))) codes.push({ code:'BSA', _hint:'BSI léger' });

    return codes;
  }

  function _optimizeActs(codes, text) {
    if (!codes || !codes.length) return codes;
    const t = String(text || '').toLowerCase();
    const out = codes.map(c => ({...c}));
    const has = code => out.some(c => String(c.code||'').toUpperCase() === code);

    /* ── AMI6 détecté sur perfusion longue → AMI14 ── */
    if (has('AMI6') && /perfusion.*(12|24|longue|>1h)/.test(t)) {
      const i = out.findIndex(c => String(c.code||'').toUpperCase()==='AMI6');
      out.splice(i,1,{ code:'AMI14', _hint:'optimisation : perfusion longue AMI14 au lieu de AMI6' });
    }
    /* ── AMI4 détecté sur perfusion courte → AMI9 ── */
    if (has('AMI4') && /perfusion.*(court|30|45|≤1h)/.test(t)) {
      const i = out.findIndex(c => String(c.code||'').toUpperCase()==='AMI4');
      out.splice(i,1,{ code:'AMI9', _hint:'optimisation : perfusion courte AMI9 au lieu de AMI4' });
    }
    return out;
  }

  function _computeTotalSimple(codes, ref) {
    /* Calcul simplifié côté front (fallback si moteur non dispo) */
    if (!codes || !ref) return 0;
    let total = 0;
    codes.forEach(c => {
      const t = _getTarif(ref, c.code);
      if (t != null) total += t;
    });
    return total;
  }

  function liveAnalyzeCotation(text) {
    const ref = window.NGAP_REFERENTIEL;
    if (!ref || !text || text.length < 5) {
      return { ok:false, reason:'not_ready' };
    }
    const codes   = _detectActsFromText(text);
    const optCodes= _optimizeActs(codes, text);
    const totActu = _computeTotalSimple(codes, ref);
    const totOpt  = _computeTotalSimple(optCodes, ref);
    const gain    = totOpt - totActu;
    const changed = JSON.stringify(codes.map(c=>c.code)) !== JSON.stringify(optCodes.map(c=>c.code));
    return {
      ok:true,
      codes, optCodes,
      total_actuel: totActu,
      total_optimal: totOpt,
      gain,
      has_suggestion: changed && gain > _LOSS_THRESHOLD,
      confidence: codes.length ? 0.85 : 0,
    };
  }

  /* ════════════════════════════════════════════════
     E. RENDER — UI admin pour analyse pertes
     Appelle /webhook/admin-ngap-analyze-real (route worker)
  ════════════════════════════════════════════════ */

  async function runRealLossAnalysis(containerId) {
    const el = (typeof containerId === 'string')
      ? document.getElementById(containerId)
      : containerId;
    if (!el) { console.warn('[NGAPAnalyzer] container introuvable:', containerId); return; }

    /* Vérif rôle — la route worker vérifie aussi côté serveur */
    const isAdm = (typeof S !== 'undefined' && S?.role === 'admin') ||
                  (typeof APP !== 'undefined' && APP?.user?.role === 'admin');
    if (!isAdm) {
      el.innerHTML = '<div class="ai wa">⚠️ Accès réservé aux administrateurs.</div>';
      return;
    }

    el.innerHTML = '<div class="ai in" style="display:flex;align-items:center;gap:10px">' +
      '<div class="spin spinw" style="width:20px;height:20px"></div>' +
      '<span>Analyse des cotations réelles en cours…</span></div>';

    try {
      const d = (typeof wpost === 'function')
        ? await wpost('/webhook/admin-ngap-analyze-real', {})
        : null;
      if (!d || !d.ok) throw new Error(d?.error || 'Analyse indisponible.');

      const details = Array.isArray(d.details) ? d.details : [];
      const gain    = parseFloat(d.gain_total || 0);
      const count   = parseInt(d.count || details.length || 0, 10);

      if (!details.length) {
        el.innerHTML = '<div class="ai su">✅ Aucune perte détectée — vos cotations sont optimisées.</div>';
        return;
      }

      /* Agrégation par pattern */
      const byPattern = {};
      details.forEach(x => {
        const k = x.pattern || 'autre';
        if (!byPattern[k]) byPattern[k] = { count:0, gain:0 };
        byPattern[k].count++;
        byPattern[k].gain += parseFloat(x.perte || 0);
      });
      const topPatterns = Object.entries(byPattern)
        .sort((a,b) => b[1].gain - a[1].gain)
        .slice(0,5);

      el.innerHTML = `
        <div class="card" style="background:linear-gradient(135deg,rgba(0,212,170,.08),transparent);border:1px solid rgba(0,212,170,.3);padding:16px;margin-bottom:12px">
          <div style="font-size:13px;color:var(--m);margin-bottom:4px">💸 Gain potentiel récupérable</div>
          <div style="font-size:32px;font-weight:700;color:#00b894;font-family:var(--fs)">${gain.toFixed(2)} €</div>
          <div style="font-size:11px;color:var(--m);margin-top:4px">sur ${count} cotation${count>1?'s':''} à optimiser · période analysée : 30j glissants · données anonymisées</div>
        </div>
        ${topPatterns.length ? `
        <div class="card" style="padding:14px;margin-bottom:12px">
          <h4 style="margin:0 0 10px;font-size:13px">🔍 Top patterns de sous-cotation</h4>
          ${topPatterns.map(([k,v]) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--b);font-size:12px">
              <span>${k}</span>
              <span style="color:#ef4444;font-weight:600">${v.gain.toFixed(2)}€ <small style="color:var(--m);font-weight:400">(×${v.count})</small></span>
            </div>
          `).join('')}
        </div>` : ''}
        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:12px;color:var(--m);padding:6px 0">Voir le détail (${details.length} lignes · anonymisées)</summary>
          <div style="max-height:420px;overflow:auto;margin-top:8px">
            ${details.slice(0,100).map(x => `
              <div style="padding:10px;border-bottom:1px solid var(--b);font-size:12px">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
                  <strong style="font-size:13px">${(x.patient_ref || '—')}</strong>
                  <span style="color:#ef4444;font-weight:600">−${parseFloat(x.perte||0).toFixed(2)}€</span>
                </div>
                <div style="color:var(--m);margin-top:4px">
                  ${parseFloat(x.actuel||0).toFixed(2)}€ → <strong style="color:#00b894">${parseFloat(x.optimal||0).toFixed(2)}€</strong>
                </div>
                ${x.suggestion ? `<div style="margin-top:6px;font-size:11px;color:var(--a)">💡 ${x.suggestion}</div>` : ''}
                ${x.regle ? `<div style="margin-top:2px;font-size:10px;color:var(--m);font-family:var(--fm)">${x.regle}</div>` : ''}
              </div>
            `).join('')}
            ${details.length > 100 ? `<div style="padding:10px;text-align:center;color:var(--m);font-size:11px">+${details.length - 100} lignes — tronqué à 100 pour affichage</div>` : ''}
          </div>
        </details>
        <div style="font-size:10px;color:var(--m);margin-top:10px;padding:8px;background:var(--s);border-radius:6px">
          🛡️ RGPD : analyses basées sur les cotations anonymisées (hash patient) — aucune donnée identifiable n'est traitée côté client.
        </div>`;
    } catch (e) {
      el.innerHTML = `<div class="ai er">⚠️ ${e.message || 'Erreur analyse'}</div>`;
    }
  }

  /* ════════════════════════════════════════════════
     F. RENDER ANOMALIES — UI référentiel
     Affiche les suggestions détectées dans le référentiel
  ════════════════════════════════════════════════ */

  function renderAnomaliesUI(containerId, refOverride) {
    const el = (typeof containerId === 'string')
      ? document.getElementById(containerId)
      : containerId;
    if (!el) return;
    const ref = refOverride || window.NGAP_REFERENTIEL;
    const sugg = analyzeReferentiel(ref);
    if (!sugg.length) {
      el.innerHTML = '<div class="ai su">✅ Aucune anomalie détectée dans le référentiel NGAP.</div>';
      return;
    }
    const byLevel = { critical:[], warning:[], info:[] };
    sugg.forEach(s => (byLevel[s.level] || byLevel.info).push(s));
    const render = (arr, bg, col, icon) => arr.map((s,i) => `
      <div style="background:${bg};border:1px solid ${col}33;border-left:3px solid ${col};padding:10px 12px;border-radius:6px;margin-bottom:8px;font-size:12px">
        <div>${s.msg}</div>
        ${s.fix ? `<button class="btn bsm" style="margin-top:6px;font-size:11px" data-ngap-fix='${JSON.stringify(s.fix).replace(/'/g,"&#39;")}'>✔︎ Appliquer le fix</button>` : ''}
      </div>
    `).join('');
    el.innerHTML = `
      ${byLevel.critical.length ? `<h4 style="font-size:12px;margin:0 0 6px;color:#ef4444">🚨 Critique (${byLevel.critical.length})</h4>${render(byLevel.critical,'rgba(239,68,68,.08)','#ef4444','🚨')}` : ''}
      ${byLevel.warning.length  ? `<h4 style="font-size:12px;margin:10px 0 6px;color:#f59e0b">⚠️ Avertissement (${byLevel.warning.length})</h4>${render(byLevel.warning,'rgba(251,191,36,.08)','#f59e0b','⚠️')}` : ''}
      ${byLevel.info.length     ? `<h4 style="font-size:12px;margin:10px 0 6px;color:var(--a)">💡 Info (${byLevel.info.length})</h4>${render(byLevel.info,'rgba(79,168,255,.08)','#4fa8ff','💡')}` : ''}
    `;
  }

  /* ════════════════════════════════════════════════
     G. EXPOSITION PUBLIQUE
  ════════════════════════════════════════════════ */

  window.NGAPAnalyzer = {
    version: '1.1.0-avenant11',
    analyzeReferentiel,
    applyNGAPFix,
    liveAnalyzeCotation,
    runRealLossAnalysis,
    renderAnomaliesUI,
    // accès utilitaires
    _getTarif,
    _detectActsFromText,
    _optimizeActs,
  };

  /* ── Avenant 11 : rafraîchissement à chaud du référentiel ──
     Quand NGAPUpdateManager pousse une nouvelle version, on relogge
     pour traçabilité (les fonctions lisent window.NGAP_REFERENTIEL
     dynamiquement, donc rien à invalider en cache). */
  document.addEventListener('ngap:ref_updated', (e) => {
    if (window.console && console.info) {
      console.info('[NGAPAnalyzer] Référentiel mis à jour à chaud :',
        (e.detail && e.detail.version) || '?', '— analyses suivantes utiliseront la nouvelle version.');
    }
  });

  /* ════════════════════════════════════════════════
     H. AUTO-INIT — enrichissement temps réel sur #f-txt
     ────────────────────────────────────────────────
     Ajoute un 2e encart (#live-reco-optim) qui COMPLÈTE
     (ne remplace pas) #live-reco géré par renderLiveReco().
     Se limite aux optimisations stratégiques : AMI6→AMI14
     pour perfusion longue, AMI4→AMI9 pour perfusion courte.
     • debounced 250ms
     • jamais destructif — affiche toujours juste une suggestion
     • n'auto-remplace JAMAIS le texte
  ════════════════════════════════════════════════ */

  let _liveTimer = null;
  let _liveAttached = false;

  function _renderLiveOptim(result) {
    // Conteneur créé à côté de #live-reco (géré par renderLiveReco de tournee.js)
    let el = document.getElementById('live-reco-optim');
    const host = document.getElementById('live-reco');
    if (!host) return;
    if (!el) {
      el = document.createElement('div');
      el.id = 'live-reco-optim';
      el.style.cssText = 'margin-top:6px';
      host.parentNode.insertBefore(el, host.nextSibling);
    }

    if (!result || !result.ok || !result.has_suggestion) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    const actuel = (result.total_actuel || 0).toFixed(2);
    const optimal = (result.total_optimal || 0).toFixed(2);
    const gain = (result.gain || 0).toFixed(2);
    const oldCodes = (result.codes || []).map(c => c.code).join(' + ') || '—';
    const newCodes = (result.optCodes || []).map(c => c.code).join(' + ') || '—';
    const hints = (result.optCodes || []).map(c => c._hint).filter(Boolean).join(' · ');

    el.style.display = 'block';
    el.innerHTML = `
      <div style="padding:10px 12px;border-radius:8px;background:linear-gradient(135deg,rgba(0,212,170,.08),rgba(79,168,255,.05));border:1px solid rgba(0,212,170,.3);font-size:12px">
        <div style="font-family:var(--fm);font-size:10px;color:var(--a);letter-spacing:1.2px;text-transform:uppercase;margin-bottom:5px">⚡ Optimisation NGAP détectée</div>
        <div style="font-size:12px;line-height:1.5">
          <span style="text-decoration:line-through;color:var(--m);opacity:.7">${oldCodes}</span>
          &nbsp;→&nbsp;
          <strong style="color:#00b894;font-family:var(--fm)">${newCodes}</strong>
        </div>
        <div style="margin-top:5px;font-size:11px;color:var(--m)">
          ${actuel}€ → <strong style="color:#00b894">${optimal}€</strong>
          &nbsp;<span style="color:#00b894;font-weight:600">(+${gain}€)</span>
        </div>
        ${hints ? `<div style="margin-top:4px;font-size:10px;color:var(--m);font-style:italic">💡 ${hints}</div>` : ''}
        <div style="margin-top:5px;font-size:10px;color:var(--m)">
          ℹ️ Suggestion — la cotation finale reste décidée par votre saisie
        </div>
      </div>
    `;
  }

  function _onLiveInput(e) {
    clearTimeout(_liveTimer);
    _liveTimer = setTimeout(() => {
      try {
        const val = (e.target && 'value' in e.target) ? e.target.value : '';
        const result = liveAnalyzeCotation(val);
        _renderLiveOptim(result);
      } catch (err) {
        console.warn('[NGAPAnalyzer] live analyze KO:', err.message);
      }
    }, 250); // debounce 250ms
  }

  function _attachLiveListener() {
    if (_liveAttached) return;
    const txt = document.getElementById('f-txt');
    if (!txt) return false;
    // Ajout d'un listener SUPPLÉMENTAIRE (addEventListener, pas oninput)
    // — n'écrase pas le oninput="renderLiveReco(this.value)" existant
    txt.addEventListener('input', _onLiveInput, { passive: true });
    _liveAttached = true;
    return true;
  }

  /* Tentative d'attache — idempotente */
  function _tryAttach() {
    if (_attachLiveListener()) return;
    // #f-txt pas encore présent → réessayer via DOMContentLoaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        _attachLiveListener();
      }, { once: true });
    }
  }
  _tryAttach();

  /* Re-attache après navigation (si le DOM est recréé — défensif) */
  document.addEventListener('ami:login', () => { _liveAttached = false; _tryAttach(); });
  document.addEventListener('ui:navigate', () => { if (!_liveAttached) _tryAttach(); });

  /* Log de chargement — utile pour admin */
  if (window.console && console.info) {
    console.info('[NGAPAnalyzer] v1.1.0-avenant11 prêt — window.NGAPAnalyzer disponible.');
  }
})();
