/* ════════════════════════════════════════════════════════════════
   ngap-ref-explorer.js — AMI NGAP v1.0
   ────────────────────────────────────────────────────────────────
   Expose l'intégralité du référentiel NGAP côté infirmière :
   - 112 actes (chap I + II)
   - 6 majorations, 5 déplacements, 3 plafonnements IK
   - 12 règles d'incompatibilité, 9 dérogations taux plein
   - Règles article 11B, règles CIR-9/2025
   
   Fonctions globales exposées :
     • renderNGAPSearch()    — appelé par #ngap-search-input (oninput)
     • validateNGAPCumul()   — appelé par _checkCumul()
     • renderNGAPExplorer()  — construit l'accordéon du référentiel complet
   
   Dépendances : window.NGAP_REFERENTIEL (chargé par index.html)
════════════════════════════════════════════════════════════════ */

(function(){
'use strict';

function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function _num(n){const v=parseFloat(n);return isFinite(v)?v:0;}
function _fmt(n){return (+n).toFixed(2).replace('.',',');}

/* ── Normalisation codes : AMI4.1, AMI4_1, ami4.1 → AMI4.1 ── */
function _norm(c){return String(c||'').toUpperCase().replace(/_/g,'.').trim();}

/* ── Inventaire complet plat du référentiel pour la recherche ──
   Retourne un tableau uniforme { category, code, label, tarif, raw } */
function _flattenReferentiel(ref) {
  if (!ref) return [];
  const items = [];

  // Lettres-clés
  for (const [k, v] of Object.entries(ref.lettres_cles || {})) {
    items.push({ category: 'lettre', code: k, label: v.label, tarif: v.valeur, raw: v });
  }
  // Forfaits BSI
  for (const [k, v] of Object.entries(ref.forfaits_bsi || {})) {
    items.push({ category: 'bsi', code: k, label: v.label, tarif: v.tarif, raw: v });
  }
  // Forfaits DI
  for (const [k, v] of Object.entries(ref.forfaits_di || {})) {
    items.push({ category: 'di', code: k, label: v.label, tarif: v.tarif, raw: v });
  }
  // Déplacements
  for (const [k, v] of Object.entries(ref.deplacements || {})) {
    const tarif = v.tarif != null ? v.tarif : v.tarif_par_km;
    const suffix = v.tarif_par_km ? ' €/km' : '';
    items.push({ category: 'deplacement', code: v.code_facturation || k, label: v.label, tarif, tarif_suffix: suffix, raw: v });
  }
  // Majorations
  for (const [k, v] of Object.entries(ref.majorations || {})) {
    const alias = v.code_alias || k;
    items.push({ category: 'majoration', code: alias, label: v.label, tarif: v.tarif, raw: { ...v, _key: k } });
  }
  // Télésoin
  for (const [k, v] of Object.entries(ref.telesoin || {})) {
    items.push({ category: 'telesoin', code: k, label: v.label, tarif: v.tarif, raw: v });
  }
  // Actes chap I et II
  for (const a of ref.actes_chapitre_I || []) {
    items.push({ category: 'acte_I', code: a.code_facturation || a.code, label: a.label, tarif: a.tarif, raw: a });
  }
  for (const a of ref.actes_chapitre_II || []) {
    items.push({ category: 'acte_II', code: a.code_facturation || a.code, label: a.label, tarif: a.tarif, raw: a });
  }
  return items;
}

/* ── Couleurs catégorie (harmonisées avec la table existante) ── */
const CAT_META = {
  lettre:      { icon: '🔑', label: 'Lettre-clé',   color: 'var(--m)',     bg: 'rgba(107,114,128,.1)' },
  bsi:         { icon: '💰', label: 'Forfait BSI',   color: '#4fa8ff',      bg: 'rgba(79,168,255,.1)' },
  di:          { icon: '📊', label: 'Forfait DI',    color: '#a78bfa',      bg: 'rgba(167,139,250,.1)' },
  deplacement: { icon: '🚗', label: 'Déplacement',   color: '#0891b2',      bg: 'rgba(8,145,178,.1)' },
  majoration:  { icon: '⏱️', label: 'Majoration',    color: '#f59e0b',      bg: 'rgba(245,158,11,.1)' },
  telesoin:    { icon: '📞', label: 'Télésoin',      color: '#10b981',      bg: 'rgba(16,185,129,.1)' },
  acte_I:      { icon: '📋', label: 'Acte chap. I',  color: '#00d4aa',      bg: 'rgba(0,212,170,.1)' },
  acte_II:     { icon: '💉', label: 'Acte chap. II', color: '#ef4444',      bg: 'rgba(239,68,68,.1)' }
};

/* ══════════════════════════════════════════════════════════════
   RECHERCHE — dans toutes les catégories
   Pattern : code partiel, mot du label, ou catégorie
══════════════════════════════════════════════════════════════ */
window.renderNGAPSearch = function() {
  const input = document.getElementById('ngap-search-input');
  const out = document.getElementById('ngap-search-results');
  if (!input || !out) return;

  const q = (input.value || '').trim().toLowerCase();
  const ref = window.NGAP_REFERENTIEL;
  if (!ref) {
    out.innerHTML = '<div class="ai wa" style="margin-top:8px">⏳ Référentiel en cours de chargement…</div>';
    return;
  }

  if (q.length < 2) {
    out.innerHTML = '';
    return;
  }

  const all = _flattenReferentiel(ref);
  const results = all.filter(it => {
    const code = _norm(it.code).toLowerCase();
    const label = (it.label || '').toLowerCase();
    return code.includes(q) || label.includes(q);
  });

  if (results.length === 0) {
    out.innerHTML = `<div class="ai wa" style="margin-top:8px">Aucun résultat pour "<strong>${_esc(q)}</strong>".</div>`;
    return;
  }

  // Limiter à 30 résultats pour éviter de surcharger
  const max = 30;
  const shown = results.slice(0, max);

  out.innerHTML = `
    <div style="font-size:11px;color:var(--m);font-family:var(--fm);letter-spacing:.5px;margin-bottom:8px;padding:6px 0">
      ${results.length} résultat${results.length > 1 ? 's' : ''}${results.length > max ? ` (${max} affichés)` : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${shown.map(_renderItemRow).join('')}
    </div>
    ${results.length > max ? '<div style="font-size:11px;color:var(--m);text-align:center;padding:8px">… affinez votre recherche pour plus de résultats</div>' : ''}`;
};

/* Rendu d'une ligne d'acte dans les résultats + l'explorateur
   Affiche aussi : max/jour, max/an, prescription, incompatibles, subordonné à, dérogations, etc. */
function _renderItemRow(it) {
  const meta = CAT_META[it.category] || { icon: '•', label: '?', color: 'var(--t)', bg: 'var(--ad,#0f172a)' };
  const tarif = (it.tarif != null && it.tarif !== '') 
    ? `${_fmt(it.tarif)} €${it.tarif_suffix || ''}` 
    : '—';
  const r = it.raw || {};
  const lettre = r.lettre_cle ? ` · ${r.lettre_cle}` : '';
  const coef = r.coefficient ? ` × ${r.coefficient}` : '';
  const article = r.chapitre && r.article ? ` · Chap ${r.chapitre} art ${r.article}` : '';
  const note = (r.note || r.regle_cir9_2025) ? 
    `<div style="font-size:10px;color:var(--m);margin-top:4px;font-style:italic;line-height:1.4">💡 ${_esc(r.note || r.regle_cir9_2025)}</div>` : '';

  // ── Tags contraintes ──
  const tags = [];
  
  // Max par période
  if (r.max_par_jour) tags.push({ icon: '📅', text: `max ${r.max_par_jour}/jour`, color: '#f59e0b' });
  if (r.max_par_semaine) tags.push({ icon: '📅', text: `max ${r.max_par_semaine}/semaine`, color: '#f59e0b' });
  if (r.max_par_mois) tags.push({ icon: '📅', text: `max ${r.max_par_mois}/mois`, color: '#f59e0b' });
  if (r.max_par_an) tags.push({ icon: '📅', text: `max ${r.max_par_an}/an`, color: '#f59e0b' });
  if (r.max_par_episode) tags.push({ icon: '📅', text: `max ${r.max_par_episode}/épisode`, color: '#f59e0b' });
  if (r.max_total) tags.push({ icon: '🔒', text: `max ${r.max_total} total`, color: '#f59e0b' });
  if (r.max_par_intervention) tags.push({ icon: '🔒', text: `max ${r.max_par_intervention}/intervention`, color: '#f59e0b' });
  if (r.max_par_passage) tags.push({ icon: '🔒', text: `max ${r.max_par_passage}/passage`, color: '#f59e0b' });
  if (r.max_par_patient === true) tags.push({ icon: '🔒', text: 'max 1/patient', color: '#f59e0b' });
  if (r.max_periodes_consecutives) tags.push({ icon: '🔒', text: `max ${r.max_periodes_consecutives} périodes consécutives`, color: '#f59e0b' });

  // Prescription
  if (r.prescription_required === true) tags.push({ icon: '📋', text: 'prescription requise', color: '#a78bfa' });
  if (r.prescription_required === 'AP') tags.push({ icon: '📋', text: 'entente préalable (AP)', color: '#a78bfa' });

  // Subordination (BSI préalable)
  if (r.subordonne_a) tags.push({ icon: '⚠️', text: `nécessite ${r.subordonne_a}`, color: '#ef4444' });

  // Renouvelable
  if (r.renouvelable) tags.push({ icon: '🔄', text: `renouvelable : ${r.renouvelable}`, color: '#10b981' });

  // Formation requise
  if (r.formation_requise) tags.push({ icon: '🎓', text: 'formation requise', color: '#a78bfa' });

  // Cumul taux plein (dérogations explicites)
  if (r.cumul_taux_plein === true) tags.push({ icon: '✅', text: 'cumul taux plein', color: '#10b981' });
  if (Array.isArray(r.cumul_taux_plein) && r.cumul_taux_plein.length) {
    tags.push({ icon: '✅', text: `cumul taux plein : ${r.cumul_taux_plein.slice(0,2).join(', ')}${r.cumul_taux_plein.length>2?'…':''}`, color: '#10b981' });
  }
  if (Array.isArray(r.cumul_taux_plein_avec) && r.cumul_taux_plein_avec.length) {
    tags.push({ icon: '✅', text: `+ ${r.cumul_taux_plein_avec.slice(0,2).join(', ')}${r.cumul_taux_plein_avec.length>2?'…':''} à taux plein`, color: '#10b981' });
  }
  if (Array.isArray(r.cumul_50pct) && r.cumul_50pct.length) {
    tags.push({ icon: '½', text: `cumul 50% : ${r.cumul_50pct.slice(0,2).join(', ')}`, color: '#f59e0b' });
  }

  // Incompatibles
  if (Array.isArray(r.incompatibles) && r.incompatibles.length) {
    tags.push({ icon: '🚫', text: `incompatible : ${r.incompatibles.slice(0,4).join(', ')}${r.incompatibles.length>4?'…':''}`, color: '#ef4444' });
  }
  if (Array.isArray(r.incompatibles_avec) && r.incompatibles_avec.length) {
    tags.push({ icon: '🚫', text: `incompatible : ${r.incompatibles_avec.slice(0,4).join(', ')}${r.incompatibles_avec.length>4?'…':''}`, color: '#ef4444' });
  }

  // Non cumulable
  if (Array.isArray(r.non_cumulable_avec) && r.non_cumulable_avec.length) {
    tags.push({ icon: '🚫', text: `non cumulable : ${r.non_cumulable_avec.slice(0,3).join(', ')}${r.non_cumulable_avec.length>3?'…':''}`, color: '#ef4444' });
  }

  // Dérogation texte
  if (r.derogation && typeof r.derogation === 'string') {
    tags.push({ icon: 'ℹ️', text: `dérog. ${r.derogation.slice(0, 50)}${r.derogation.length>50?'…':''}`, color: '#4fa8ff' });
  }

  const tagsHtml = tags.length ? `
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
      ${tags.map(t => `<span style="font-size:10px;padding:2px 6px;background:${t.color}15;color:${t.color};border-radius:10px;font-family:var(--fm);border:1px solid ${t.color}40">${t.icon} ${_esc(t.text)}</span>`).join('')}
    </div>` : '';

  return `
    <div style="display:flex;gap:10px;padding:8px 10px;background:var(--ad,#0f172a);border:1px solid var(--b);border-radius:6px;align-items:flex-start">
      <span style="font-size:14px;flex-shrink:0;width:24px;text-align:center" title="${_esc(meta.label)}">${meta.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
          <div>
            <span style="font-family:var(--fm);font-weight:700;color:${meta.color};font-size:12px;background:${meta.bg};padding:2px 7px;border-radius:4px">${_esc(it.code)}</span>
            <span style="font-size:11px;color:var(--m);margin-left:6px">${_esc(meta.label)}${lettre}${coef}${article}</span>
          </div>
          <div style="font-family:var(--fm);font-weight:700;color:#00d4aa;font-size:12px;flex-shrink:0">${tarif}</div>
        </div>
        <div style="font-size:12px;color:var(--t);margin-top:3px;line-height:1.4">${_esc(it.label || '')}</div>
        ${tagsHtml}
        ${note}
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   VALIDATION DE CUMUL — utilise les règles du référentiel
══════════════════════════════════════════════════════════════ */
window.validateNGAPCumul = function(actes) {
  const ref = window.NGAP_REFERENTIEL;
  if (!ref) return ['Référentiel NGAP non chargé'];
  const errors = [];
  const codes = (actes || []).map(a => _norm(a.code || a));

  // 1. Incompatibilités
  for (const rule of ref.incompatibilites || []) {
    const inA = codes.some(c => (rule.groupe_a || []).map(_norm).includes(c));
    const inB = codes.some(c => (rule.groupe_b || []).map(_norm).includes(c));
    if (inA && inB) {
      const sev = rule.severity === 'critical' ? '🛑' : '⚠️';
      errors.push(`${sev} ${rule.msg || 'Incompatibilité détectée'}`);
    }
  }

  // 2. Doubles NUIT/NUIT_PROF/DIM (majorations temporelles exclusives)
  const tempMajs = codes.filter(c => ['NUIT','NUIT_PROF','DIM'].includes(c));
  if (tempMajs.length > 1) {
    errors.push(`⚠️ Une seule majoration temporelle applicable : ${tempMajs.join(', ')} (NUIT_PROF > NUIT > DIM)`);
  }

  // 3. MAU seul sur AMI ≤ 1.5 (vérif tarif max)
  if (codes.includes('MAU')) {
    const hasHighAMI = (actes || []).some(a => {
      const c = _norm(a.code);
      return /^AMI([2-9]|1[0-5])/.test(c);  // AMI2 à AMI15
    });
    if (hasHighAMI) {
      errors.push('⚠️ MAU réservé aux AMI ≤ 1.5 (cabinet ou domicile simple)');
    }
  }

  return errors;
};

/* ══════════════════════════════════════════════════════════════
   EXPLORATEUR COMPLET — rendu accordéon de TOUT le référentiel
══════════════════════════════════════════════════════════════ */
window.renderNGAPExplorer = function() {
  const container = document.getElementById('ngap-explorer');
  if (!container) return;
  const ref = window.NGAP_REFERENTIEL;
  if (!ref) {
    container.innerHTML = '<div class="ai wa">⏳ Référentiel en cours de chargement…</div>';
    return;
  }

  // Compteurs pour les headers
  const nLettres = Object.keys(ref.lettres_cles || {}).length;
  const nBsi = Object.keys(ref.forfaits_bsi || {}).length;
  const nDi = Object.keys(ref.forfaits_di || {}).length;
  const nDep = Object.keys(ref.deplacements || {}).length;
  const nMaj = Object.keys(ref.majorations || {}).length;
  const nTel = Object.keys(ref.telesoin || {}).length;
  const nActes1 = (ref.actes_chapitre_I || []).length;
  const nActes2 = (ref.actes_chapitre_II || []).length;
  const nInc = (ref.incompatibilites || []).length;
  const nDer = (ref.derogations_taux_plein || []).length;

  const section = (icon, title, count, contentHtml, opened=false) => `
    <details ${opened ? 'open' : ''} style="background:var(--ad,#0f172a);border:1px solid var(--b);border-radius:8px;margin-bottom:8px;overflow:hidden">
      <summary style="cursor:pointer;padding:12px 14px;display:flex;align-items:center;gap:10px;user-select:none;list-style:none;background:var(--s)">
        <span style="font-size:18px">${icon}</span>
        <strong style="flex:1;font-family:var(--fi);font-size:14px;color:var(--t)">${_esc(title)}</strong>
        <span style="font-family:var(--fm);font-size:11px;color:var(--m);background:var(--ad,#0f172a);padding:2px 8px;border-radius:10px">${count}</span>
      </summary>
      <div style="padding:12px 14px">${contentHtml}</div>
    </details>`;

  // Helpers pour rendre chaque bloc
  const renderKV = (obj, keyFmt) => Object.entries(obj || {}).map(([k, v]) => {
    const label = v.label || '';
    const tarif = v.tarif != null ? v.tarif : (v.tarif_par_km != null ? v.tarif_par_km : v.valeur);
    const suffix = v.tarif_par_km ? ' €/km' : (tarif != null ? ' €' : '');
    const displayCode = keyFmt ? keyFmt(k, v) : k;
    return _renderItemRow({
      category: 'lettre', 
      code: displayCode, 
      label, 
      tarif, 
      tarif_suffix: suffix,
      raw: v
    });
  }).join('');

  const lettres = renderKV(ref.lettres_cles).replace(/🔑 Lettre-clé/g, '🔑 Lettre-clé'); // kept
  
  const bsiHtml = Object.entries(ref.forfaits_bsi || {}).map(([k, v]) => _renderItemRow({
    category: 'bsi', code: k, label: v.label, tarif: v.tarif, raw: v
  })).join('');

  const diHtml = Object.entries(ref.forfaits_di || {}).map(([k, v]) => _renderItemRow({
    category: 'di', code: v.lettre_cle ? `${v.lettre_cle}${v.coefficient}` : k, 
    label: v.label, tarif: v.tarif, raw: v
  })).join('');

  const depHtml = Object.entries(ref.deplacements || {}).map(([k, v]) => _renderItemRow({
    category: 'deplacement', 
    code: v.code_facturation || k,
    label: v.label, 
    tarif: v.tarif != null ? v.tarif : v.tarif_par_km, 
    tarif_suffix: v.tarif_par_km ? ' €/km' : '',
    raw: v
  })).join('');

  // Plafonnements IK en tableau
  const plafsHtml = ref.ik_plafonnement ? `
    <div style="margin-top:10px;padding:10px;background:rgba(245,158,11,.06);border-left:3px solid #f59e0b;border-radius:6px">
      <div style="font-size:11px;color:#f59e0b;font-family:var(--fm);letter-spacing:.5px;margin-bottom:6px">⚠️ PLAFONNEMENTS IK (grands trajets)</div>
      ${Object.entries(ref.ik_plafonnement).map(([seuil, v]) => 
        `<div style="font-size:12px;color:var(--t);line-height:1.6">• <strong>${_esc(seuil)}</strong> : ${_esc(v.label)} (abattement ${Math.round((v.abattement||0)*100)}%)</div>`
      ).join('')}
    </div>` : '';

  const majHtml = Object.entries(ref.majorations || {}).map(([k, v]) => {
    const code = v.code_alias || k;
    const incomp = Array.isArray(v.incompatibles) && v.incompatibles.length 
      ? `<div style="font-size:10px;color:#ef4444;margin-top:4px">🚫 Incompatible avec : ${v.incompatibles.join(', ')}</div>` 
      : '';
    const base = _renderItemRow({ category: 'majoration', code, label: v.label, tarif: v.tarif, raw: v });
    return base.replace('</div></div></div>', incomp + '</div></div></div>');
  }).join('');

  const telHtml = Object.entries(ref.telesoin || {}).map(([k, v]) => _renderItemRow({
    category: 'telesoin', code: k, label: v.label, tarif: v.tarif, raw: v
  })).join('');

  // Actes — gros volumes, on limite par défaut à 20 avec bouton "voir tous"
  const renderActesList = (arr, kind) => {
    if (arr.length <= 20) {
      return arr.map(a => _renderItemRow({ 
        category: kind === 'I' ? 'acte_I' : 'acte_II', 
        code: a.code_facturation || a.code, label: a.label, tarif: a.tarif, raw: a 
      })).join('');
    }
    const first20 = arr.slice(0, 20).map(a => _renderItemRow({ 
      category: kind === 'I' ? 'acte_I' : 'acte_II', 
      code: a.code_facturation || a.code, label: a.label, tarif: a.tarif, raw: a 
    })).join('');
    const remaining = arr.length - 20;
    const allItems = arr.map(a => _renderItemRow({ 
      category: kind === 'I' ? 'acte_I' : 'acte_II', 
      code: a.code_facturation || a.code, label: a.label, tarif: a.tarif, raw: a 
    })).join('');
    const toggleId = `actes-${kind}-all`;
    return `
      <div id="${toggleId}-first">${first20}</div>
      <div id="${toggleId}-full" style="display:none">${allItems}</div>
      <button class="btn bs bsm" onclick="document.getElementById('${toggleId}-first').style.display=this.dataset.open==='1'?'block':'none';document.getElementById('${toggleId}-full').style.display=this.dataset.open==='1'?'none':'block';this.dataset.open=this.dataset.open==='1'?'0':'1';this.textContent=this.dataset.open==='1'?'↑ Replier':'↓ Voir les ${remaining} autres';" data-open="0" style="width:100%;margin-top:8px;font-size:12px">↓ Voir les ${remaining} autres</button>`;
  };

  const actes1Html = renderActesList(ref.actes_chapitre_I || [], 'I');
  const actes2Html = renderActesList(ref.actes_chapitre_II || [], 'II');

  // Article 11B (principe)
  const art11bHtml = ref.regles_article_11B ? `
    <div style="padding:10px;background:rgba(79,168,255,.05);border-left:3px solid #4fa8ff;border-radius:6px;margin-bottom:10px">
      <div style="font-family:var(--fm);font-size:11px;color:#4fa8ff;letter-spacing:.5px;margin-bottom:6px">📜 PRINCIPE GÉNÉRAL</div>
      <div style="font-size:12px;color:var(--t);line-height:1.6">${_esc(ref.regles_article_11B.principe || '')}</div>
    </div>
    ${Array.isArray(ref.regles_article_11B.applicable_a) ? `
      <div style="padding:10px;background:rgba(167,139,250,.05);border-left:3px solid #a78bfa;border-radius:6px;margin-bottom:10px">
        <div style="font-family:var(--fm);font-size:11px;color:#a78bfa;letter-spacing:.5px;margin-bottom:6px">🎯 S'APPLIQUE À</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${ref.regles_article_11B.applicable_a.map(l => `<code style="padding:2px 7px;background:rgba(167,139,250,.15);color:#a78bfa;border-radius:4px;font-family:var(--fm);font-size:11px">${_esc(l)}</code>`).join('')}
        </div>
      </div>` : ''}
    ${Array.isArray(ref.regles_article_11B.exceptions_taux_plein) ? `
      <div style="padding:10px;background:rgba(16,185,129,.05);border-left:3px solid #10b981;border-radius:6px;margin-bottom:10px">
        <div style="font-family:var(--fm);font-size:11px;color:#10b981;letter-spacing:.5px;margin-bottom:6px">✅ EXCEPTIONS À TAUX PLEIN</div>
        <div style="font-size:12px;color:var(--t);line-height:1.6">
          ${ref.regles_article_11B.exceptions_taux_plein.map(e => `• ${_esc(e)}`).join('<br>')}
        </div>
      </div>` : ''}
    ${Array.isArray(ref.regles_article_11B.actes_non_decotables_jamais) ? `
      <div style="padding:10px;background:rgba(167,139,250,.05);border-left:3px solid #a78bfa;border-radius:6px;margin-bottom:10px">
        <div style="font-family:var(--fm);font-size:11px;color:#a78bfa;letter-spacing:.5px;margin-bottom:6px">🛡️ JAMAIS DÉCOTÉS</div>
        <div style="font-size:12px;color:var(--t);line-height:1.6">
          ${ref.regles_article_11B.actes_non_decotables_jamais.map(e => `<code style="padding:2px 6px;background:var(--ad,#0f172a);border-radius:4px;font-family:var(--fm)">${_esc(e)}</code>`).join(' ')}
        </div>
      </div>` : ''}
    ${ref.note_5bis ? `
      <div style="padding:10px;background:rgba(245,158,11,.05);border-left:3px solid #f59e0b;border-radius:6px">
        <div style="font-family:var(--fm);font-size:11px;color:#f59e0b;letter-spacing:.5px;margin-bottom:6px">📌 NOTE ARTICLE 5BIS (diabète insulino-traité)</div>
        <div style="font-size:12px;color:var(--t);line-height:1.6">${_esc(ref.note_5bis)}</div>
      </div>` : ''}` : '<p style="color:var(--m);font-size:12px">Règles article 11B non définies dans le référentiel.</p>';

  // CIR-9/2025
  const cir9 = ref.regles_cir9_2025;
  const cir9Html = cir9 ? `
    <div style="padding:10px;background:rgba(239,68,68,.05);border-left:3px solid #ef4444;border-radius:6px;margin-bottom:10px">
      <div style="font-family:var(--fm);font-size:11px;color:#ef4444;letter-spacing:.5px;margin-bottom:6px">📅 APPLICABLE DEPUIS LE ${_esc(cir9.date_application || '?')}</div>
      <div style="font-size:11px;color:var(--m);margin-bottom:8px">${_esc(cir9.reference || '')}</div>
    </div>
    ${Array.isArray(cir9.regles) ? `
      <div style="padding:10px;background:rgba(0,212,170,.04);border-left:3px solid #00d4aa;border-radius:6px;margin-bottom:10px">
        <div style="font-family:var(--fm);font-size:11px;color:#00d4aa;letter-spacing:.5px;margin-bottom:6px">✅ RÈGLES</div>
        <div style="font-size:12px;color:var(--t);line-height:1.8">
          ${cir9.regles.map(r => `• ${_esc(r)}`).join('<br>')}
        </div>
      </div>` : ''}
    ${Array.isArray(cir9.interdits) ? `
      <div style="padding:10px;background:rgba(239,68,68,.05);border-left:3px solid #ef4444;border-radius:6px;margin-bottom:10px">
        <div style="font-family:var(--fm);font-size:11px;color:#ef4444;letter-spacing:.5px;margin-bottom:6px">🚫 INTERDITS</div>
        <div style="font-size:12px;color:var(--t);line-height:1.8">
          ${cir9.interdits.map(r => `• ${_esc(r)}`).join('<br>')}
        </div>
      </div>` : ''}
    ${Array.isArray(cir9.exemples) ? `
      <div style="padding:10px;background:rgba(79,168,255,.04);border-left:3px solid #4fa8ff;border-radius:6px">
        <div style="font-family:var(--fm);font-size:11px;color:#4fa8ff;letter-spacing:.5px;margin-bottom:6px">💡 EXEMPLES CLINIQUES</div>
        ${cir9.exemples.map(ex => `
          <div style="margin-top:8px;font-size:12px;line-height:1.5">
            <div style="color:var(--t);font-weight:600">📋 ${_esc(ex.cas || '')}</div>
            <div style="color:var(--m);margin-top:2px;padding-left:12px">→ ${_esc(ex.cotation || '')}</div>
          </div>`).join('')}
      </div>` : ''}` : '<p style="color:var(--m);font-size:12px">Règles CIR-9/2025 non définies.</p>';

  // Incompatibilités
  const incHtml = (ref.incompatibilites || []).map((r, i) => {
    const sev = r.severity === 'critical' ? '🛑' : '⚠️';
    const sevColor = r.severity === 'critical' ? '#ef4444' : '#f59e0b';
    return `
      <div style="padding:10px;background:var(--ad,#0f172a);border-left:3px solid ${sevColor};border-radius:6px;margin-bottom:6px">
        <div style="display:flex;gap:8px;align-items:flex-start">
          <span style="font-size:14px;flex-shrink:0">${sev}</span>
          <div style="flex:1">
            <div style="font-size:12px;color:var(--t);line-height:1.5">${_esc(r.msg || '')}</div>
            <div style="font-family:var(--fm);font-size:10px;color:var(--m);margin-top:4px">
              <strong>Groupe A:</strong> ${(r.groupe_a || []).map(c => `<code style="background:rgba(239,68,68,.1);padding:1px 5px;border-radius:3px">${_esc(c)}</code>`).join(' ')}
              &nbsp;&nbsp;<strong>Groupe B:</strong> ${(r.groupe_b || []).map(c => `<code style="background:rgba(239,68,68,.1);padding:1px 5px;border-radius:3px">${_esc(c)}</code>`).join(' ')}
            </div>
          </div>
        </div>
      </div>`;
  }).join('') || '<p style="color:var(--m);font-size:12px">Aucune incompatibilité définie.</p>';

  // Dérogations
  const derHtml = (ref.derogations_taux_plein || []).map((d, i) => `
    <div style="padding:10px;background:var(--ad,#0f172a);border-left:3px solid #10b981;border-radius:6px;margin-bottom:6px">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <span style="font-size:14px;flex-shrink:0">✅</span>
        <div style="flex:1">
          <div style="font-size:12px;color:var(--t);line-height:1.5">${_esc(d.msg || '')}</div>
          <div style="font-family:var(--fm);font-size:10px;color:var(--m);margin-top:4px">
            <strong>Cumul:</strong> ${(d.codes_groupe_a || []).map(c => `<code style="background:rgba(16,185,129,.1);padding:1px 5px;border-radius:3px">${_esc(c)}</code>`).join(' ')}
            &nbsp;+&nbsp; ${(d.codes_groupe_b || []).map(c => `<code style="background:rgba(16,185,129,.1);padding:1px 5px;border-radius:3px">${_esc(c)}</code>`).join(' ')}
          </div>
        </div>
      </div>
    </div>`).join('') || '<p style="color:var(--m);font-size:12px">Aucune dérogation définie.</p>';

  // ═══════════════════════════════════════════════════════════════
  // AVENANT 11 — sections dédiées (consultations, IDER, IPA, etc.)
  // ═══════════════════════════════════════════════════════════════
  const isAvenant11 = (ref.version || '').includes('AVENANT11')
    || ref.consultations_infirmieres
    || ref.infirmier_referent_IDER
    || ref.notes_version?.avenant_11;

  // Bannière Avenant 11
  const avenant11Banner = isAvenant11 ? `
    <div style="padding:12px 14px;background:linear-gradient(135deg,rgba(168,85,247,.12),rgba(124,58,237,.04));border:1px solid rgba(168,85,247,.35);border-radius:10px;margin-bottom:14px">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:22px;flex-shrink:0">🆕</span>
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--fi);font-weight:700;color:#a855f7;font-size:13px;margin-bottom:4px">
            Avenant 11 — Signé le 31/03/2026
          </div>
          <div style="font-size:12px;color:var(--t);line-height:1.5">
            Ce référentiel intègre les nouveautés de l'avenant 11 (CNAM/FNI/SNIIL/CI/UNOCAM) :
            consultations infirmières <strong>CIA/CIB (20€)</strong>, majorations <strong>MSG/MSD/MIR</strong>,
            infirmier référent <strong>IDER</strong>, nouveaux actes de surveillance, accès direct plaies.
          </div>
          <div style="margin-top:6px;padding:6px 10px;background:rgba(245,158,11,.08);border-left:3px solid #f59e0b;border-radius:4px;font-size:11px;color:#f59e0b">
            ⏰ <strong>Revalorisation AMI</strong> : 3,15 € → 3,35 € au 01/11/2026 → 3,45 € au 01/11/2027 — <em>applicable automatiquement selon la date du soin</em>.
          </div>
        </div>
      </div>
    </div>` : '';

  // Consultations infirmières (CIA / CIB)
  const renderConsultations = () => {
    const c = ref.consultations_infirmieres || {};
    const items = Object.entries(c).filter(([k, v]) => v && typeof v === 'object' && v.code_facturation);
    if (items.length === 0) return '';
    const rows = items.map(([key, v]) => `
      <div style="padding:10px;background:var(--ad,#0f172a);border-left:3px solid #a855f7;border-radius:6px;margin-bottom:8px">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <span style="font-size:14px;flex-shrink:0">🩺</span>
          <div style="flex:1">
            <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
              <code style="background:rgba(168,85,247,.15);color:#a855f7;padding:2px 8px;border-radius:4px;font-family:var(--fm);font-size:12px">${_esc(v.code_facturation)}</code>
              <strong style="color:var(--t);font-size:12px">${_esc(v.label || key)}</strong>
              <span style="margin-left:auto;font-family:var(--fm);color:#a855f7;font-size:12px">${v.tarif} €</span>
            </div>
            ${v.applicable_a_compter_de ? `<div style="font-size:10px;color:var(--m);margin-top:4px">📅 ${_esc(v.applicable_a_compter_de)}</div>` : ''}
            ${v.conditions ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:var(--m)">⚙️ Conditions</summary>
              <div style="margin-top:4px;padding-left:8px;font-size:11px;color:var(--t);line-height:1.6">
                ${Object.entries(v.conditions).map(([ck, cv]) =>
                  `<div>• <strong>${_esc(ck)}</strong>: ${_esc(Array.isArray(cv) ? cv.join(', ') : (typeof cv === 'object' ? JSON.stringify(cv) : String(cv)))}</div>`
                ).join('')}
              </div>
            </details>` : ''}
            ${Array.isArray(v.objectifs) ? `<div style="font-size:11px;color:var(--m);margin-top:4px">🎯 ${v.objectifs.map(_esc).join(' · ')}</div>` : ''}
          </div>
        </div>
      </div>`).join('');
    return rows;
  };

  // Infirmier Référent (IDER)
  const renderIDER = () => {
    const d = ref.infirmier_referent_IDER;
    if (!d) return '';
    return `
      <div style="padding:12px;background:var(--ad,#0f172a);border-left:3px solid #4fa8ff;border-radius:6px">
        <div style="font-size:12px;color:var(--t);line-height:1.6">
          <div><strong style="color:#4fa8ff">👥 Désignation :</strong> ${_esc(d.designation || '—')}</div>
          <div style="margin-top:4px"><strong style="color:#4fa8ff">📅 Applicable :</strong> ${_esc(d.applicable_a_compter_de || '—')}</div>
          <div style="margin-top:4px"><strong style="color:#4fa8ff">🎯 Cible :</strong> ${_esc(d.cible || '—')}</div>
          ${Array.isArray(d.missions) ? `<div style="margin-top:6px"><strong style="color:#4fa8ff">🏥 Missions :</strong><ul style="margin:4px 0 0 16px;color:var(--m)">${d.missions.map(m => `<li>${_esc(m)}</li>`).join('')}</ul></div>` : ''}
          ${d.parcours_renforce_patients_vulnerables ? `<div style="margin-top:6px;padding:6px 8px;background:rgba(79,168,255,.08);border-radius:4px;font-size:11px">
            <strong>🔄 Parcours renforcé (${_esc(d.parcours_renforce_patients_vulnerables.applicable_a_compter_de || '?')})</strong> :
            ${Array.isArray(d.parcours_renforce_patients_vulnerables.modalites) ? d.parcours_renforce_patients_vulnerables.modalites.map(_esc).join(' · ') : ''}
          </div>` : ''}
        </div>
      </div>`;
  };

  // IPA (Infirmiers en Pratique Avancée)
  const renderIPA = () => {
    const d = ref.ipa_pratique_avancee;
    if (!d) return '';
    return `
      <div style="padding:12px;background:var(--ad,#0f172a);border-left:3px solid #10b981;border-radius:6px">
        <div style="font-size:12px;color:var(--t);line-height:1.6">
          <div><strong style="color:#10b981">💰 Tarif avant A11 :</strong> ${d.tarif_seance_avant_A11} € (séance) → <strong>${d.tarif_consultation_apres_A11} €</strong> (consultation)</div>
          <div style="margin-top:4px"><strong style="color:#10b981">📅 Applicable :</strong> ${_esc(d.applicable_a_compter_de || '—')}</div>
          ${Array.isArray(d.evolutions_A11) ? `<div style="margin-top:6px"><strong style="color:#10b981">📈 Évolutions :</strong><ul style="margin:4px 0 0 16px;color:var(--m)">${d.evolutions_A11.map(e => `<li>${_esc(e)}</li>`).join('')}</ul></div>` : ''}
        </div>
      </div>`;
  };

  // Astreintes PDSA
  const renderAstreintes = () => {
    const a = ref.indemnites_astreinte;
    if (!a) return '';
    return Object.entries(a).map(([k, v]) => `
      <div style="padding:10px;background:var(--ad,#0f172a);border-left:3px solid #ef4444;border-radius:6px;margin-bottom:6px">
        <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
          <code style="background:rgba(239,68,68,.15);color:#ef4444;padding:2px 8px;border-radius:4px;font-family:var(--fm);font-size:12px">${_esc(k)}</code>
          <strong style="color:var(--t);font-size:12px">${_esc(v.label || '')}</strong>
          <span style="margin-left:auto;font-family:var(--fm);color:#ef4444;font-size:12px">${v.tarif} € / ${_esc(v.unite || '')}</span>
        </div>
        ${v.conditions ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:var(--m)">⚙️ Conditions</summary>
          <div style="margin-top:4px;padding-left:8px;font-size:11px;color:var(--t);line-height:1.6">
            ${Object.entries(v.conditions).map(([ck, cv]) => `<div>• ${_esc(ck)}: ${_esc(String(cv))}</div>`).join('')}
          </div>
        </details>` : ''}
      </div>`).join('');
  };

  // Kit dépistage colorectal
  const renderDepistage = () => {
    const d = ref.depistage_cancer_colorectal;
    if (!d) return '';
    return `
      <div style="padding:12px;background:var(--ad,#0f172a);border-left:3px solid #f59e0b;border-radius:6px;font-size:12px;color:var(--t);line-height:1.6">
        <div><strong style="color:#f59e0b">🎯 Code traceur :</strong> <code style="background:rgba(245,158,11,.15);padding:1px 6px;border-radius:3px">${_esc(d.code_traceur || 'RKD')}</code></div>
        <div style="margin-top:4px"><strong style="color:#f59e0b">💰 Remise kit :</strong> ${d.tarif_remise_kit} € · <strong>Test réalisé :</strong> +${d.tarif_test_realise} € (total ${d.tarif_total_si_test_realise} €)</div>
        <div style="margin-top:4px"><strong style="color:#f59e0b">✅ Prise en charge :</strong> ${_esc(d.prise_en_charge || '100% AM')}</div>
        <div style="margin-top:4px"><strong style="color:#f59e0b">📅 Applicable :</strong> ${_esc(d.applicable_a_compter_de || '—')}</div>
      </div>`;
  };

  // Diabète pédiatrique scolarisé
  const renderDiabetePedia = () => {
    const d = ref.diabete_pediatrique_scolarise;
    if (!d) return '';
    const actes = d.actes_specifiques || {};
    const maj = d.majoration_specifique || {};
    return `
      <div style="padding:12px;background:var(--ad,#0f172a);border-left:3px solid #ec4899;border-radius:6px;font-size:12px;color:var(--t);line-height:1.6">
        <div><strong style="color:#ec4899">🎯 Cible :</strong> ${_esc(d.cible || '—')}</div>
        <div style="margin-top:4px"><strong style="color:#ec4899">📅 Applicable :</strong> ${_esc(d.applicable_a_compter_de || '—')}</div>
        <div style="margin-top:6px"><strong style="color:#ec4899">💉 Actes spécifiques :</strong></div>
        <ul style="margin:2px 0 0 16px;color:var(--m);font-size:11px">
          ${Object.entries(actes).map(([k, v]) => `<li><code style="background:rgba(236,72,153,.15);padding:1px 5px;border-radius:3px">${_esc(v.code || '')}</code> ${_esc(v.description || k)} — <strong style="color:var(--t)">${v.tarif} €</strong></li>`).join('')}
        </ul>
        ${maj.code ? `<div style="margin-top:6px;padding:6px 8px;background:rgba(236,72,153,.08);border-radius:4px">
          <strong style="color:#ec4899">➕ Majoration ${_esc(maj.code)} :</strong> ${maj.tarif} € — ${_esc(maj.description || '')}
        </div>` : ''}
      </div>`;
  };

  // Accès direct (loi infirmière + Avenant 11)
  const renderAccesDirect = () => {
    const d = ref.acces_direct_sans_prescription;
    if (!d) return '';
    return `
      <div style="padding:12px;background:var(--ad,#0f172a);border-left:3px solid #0891b2;border-radius:6px;font-size:12px;color:var(--t);line-height:1.6">
        <div><strong style="color:#0891b2">📜 Base légale :</strong> ${_esc(d.base_legale || '—')}</div>
        <div style="margin-top:4px"><strong style="color:#0891b2">📅 Applicable :</strong> ${_esc(d.applicable_a_compter_de || '—')}</div>
        ${Array.isArray(d.actes_concernes) ? `<div style="margin-top:6px"><strong style="color:#0891b2">✅ Actes concernés :</strong></div>
          <ul style="margin:2px 0 0 16px;font-size:11px;color:var(--m)">
            ${d.actes_concernes.map(a => `<li><strong style="color:var(--t)">${_esc(a.acte || '')}</strong> ${a.cotation ? `— <code style="background:rgba(8,145,178,.15);padding:1px 5px;border-radius:3px">${_esc(a.cotation)}</code>` : ''} ${a.date_effet ? `<span style="color:#0891b2">(${_esc(a.date_effet)})</span>` : ''}</li>`).join('')}
          </ul>` : ''}
        ${Array.isArray(d.regles_specifiques) ? `<div style="margin-top:6px"><strong style="color:#0891b2">🔒 Règles :</strong><ul style="margin:2px 0 0 16px;font-size:11px;color:var(--m)">${d.regles_specifiques.map(r => `<li>${_esc(r)}</li>`).join('')}</ul></div>` : ''}
      </div>`;
  };

  // Checklist anti-audit CPAM
  const renderChecklist = () => {
    const d = ref.checklist_anti_audit_cpam;
    if (!d) return '';
    const blocs = [
      { key: 'prescription',                   title: '📜 Prescription', color: '#f59e0b' },
      { key: 'tracabilite',                    title: '📝 Traçabilité',  color: '#4fa8ff' },
      { key: 'facturation',                    title: '💰 Facturation',  color: '#00d4aa' },
      { key: 'nouveautes_A11_points_attention',title: '🆕 Points A11',   color: '#a855f7' },
    ];
    return blocs.filter(b => Array.isArray(d[b.key])).map(b => `
      <details style="margin-bottom:6px;background:var(--ad,#0f172a);border-radius:6px;padding:8px 12px;border-left:3px solid ${b.color}">
        <summary style="cursor:pointer;font-family:var(--fm);font-size:12px;color:${b.color};letter-spacing:.3px">${_esc(b.title)} (${d[b.key].length})</summary>
        <ul style="margin:6px 0 0 16px;font-size:11px;color:var(--t);line-height:1.6">
          ${d[b.key].map(r => `<li>${_esc(r)}</li>`).join('')}
        </ul>
      </details>`).join('');
  };

  const nbConsult = Object.keys(ref.consultations_infirmieres || {}).filter(k => (ref.consultations_infirmieres[k] || {}).code_facturation).length;
  const nbAstreintes = Object.keys(ref.indemnites_astreinte || {}).length;

  // ── Assemblage final ──
  container.innerHTML = `
    <div style="padding:10px 12px;background:linear-gradient(135deg,rgba(0,212,170,.08),rgba(79,168,255,.04));border:1px solid rgba(0,212,170,.2);border-radius:8px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">VERSION ACTIVE</div>
      <div style="font-family:var(--fm);font-weight:700;color:#00d4aa;font-size:14px;margin-top:2px">${_esc(ref.version || 'inconnue')}</div>
      <div style="font-size:11px;color:var(--m);margin-top:4px">Compilé le ${_esc(ref.date_compilation || '?')} · ${_esc(ref.source || '')}</div>
    </div>

    ${avenant11Banner}

    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn bs bsm" onclick="document.querySelectorAll('#ngap-explorer details').forEach(d=>d.open=true)" style="font-size:11px">↓ Tout déplier</button>
      <button class="btn bs bsm" onclick="document.querySelectorAll('#ngap-explorer details').forEach(d=>d.open=false)" style="font-size:11px">↑ Tout replier</button>
    </div>

    ${section('🔑', 'Lettres-clés', nLettres, renderKV(ref.lettres_cles), false)}
    ${section('💰', 'Forfaits BSI', nBsi, bsiHtml, false)}
    ${section('📊', 'Forfaits DI (bilan soins)', nDi, diHtml, false)}
    ${section('🚗', 'Déplacements & IK', nDep, depHtml + plafsHtml, false)}
    ${section('⏱️', 'Majorations', nMaj, majHtml, false)}
    ${section('📞', 'Télésoin', nTel, telHtml, false)}
    ${section('📋', 'Actes — Chapitre I', nActes1, actes1Html, false)}
    ${section('💉', 'Actes — Chapitre II (perfusions, spécialisés)', nActes2, actes2Html, false)}
    ${section('⚖️', 'Règles article 11B', '', art11bHtml, false)}
    ${section('🩺', 'Règles CIR-9/2025 (perfusions)', '', cir9Html, false)}
    ${section('🚫', 'Incompatibilités (cumuls interdits)', nInc, incHtml, false)}
    ${section('✅', 'Dérogations (cumuls à taux plein)', nDer, derHtml, false)}
    ${nbConsult ? section('🩺', 'Consultations infirmières (Avenant 11)', nbConsult, renderConsultations(), false) : ''}
    ${ref.infirmier_referent_IDER ? section('👥', 'Infirmier Référent IDER (Avenant 11)', '', renderIDER(), false) : ''}
    ${ref.ipa_pratique_avancee ? section('🎓', 'IPA — Pratique Avancée (Avenant 11)', '', renderIPA(), false) : ''}
    ${nbAstreintes ? section('🚨', 'Astreintes PDSA (Avenant 11)', nbAstreintes, renderAstreintes(), false) : ''}
    ${ref.depistage_cancer_colorectal ? section('🎯', 'Dépistage cancer colorectal (Avenant 11)', '', renderDepistage(), false) : ''}
    ${ref.diabete_pediatrique_scolarise ? section('🍭', 'Diabète pédiatrique scolarisé (Avenant 11)', '', renderDiabetePedia(), false) : ''}
    ${ref.acces_direct_sans_prescription ? section('🔓', 'Accès direct sans prescription (Loi 2025 + A11)', '', renderAccesDirect(), false) : ''}
    ${ref.checklist_anti_audit_cpam ? section('🛡️', 'Checklist anti-audit CPAM', '', renderChecklist(), false) : ''}
  `;
};

/* ══════════════════════════════════════════════════════════════
   AUTO-INIT — au chargement du référentiel
══════════════════════════════════════════════════════════════ */
function _init() {
  if (typeof window.renderNGAPExplorer === 'function') {
    try { window.renderNGAPExplorer(); } catch (e) { console.warn('[NGAP-Explorer] init KO:', e.message); }
  }
}

// Si le référentiel est déjà chargé, on init tout de suite
if (window.NGAP_REFERENTIEL) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    setTimeout(_init, 50);
  }
} else {
  // Sinon on attend l'événement dispatché par le chargeur
  document.addEventListener('ngap:ref_loaded', _init);
}

// Re-render si l'utilisateur navigue vers l'onglet
document.addEventListener('ui:navigate', (e) => {
  if (e.detail && e.detail.view === 'ngap-ref') {
    setTimeout(_init, 100);
  }
});

// Avenant 11 : re-render automatique quand le référentiel est mis à jour à chaud
// (push via NGAPUpdateManager → dispatch 'ngap:ref_updated')
document.addEventListener('ngap:ref_updated', (e) => {
  if (window.console && console.info) {
    console.info('[NGAP-Explorer] Référentiel mis à jour —',
      (e.detail && e.detail.version) || '?', '— re-rendering…');
  }
  setTimeout(_init, 50);
});

console.info('[NGAP-Explorer] v1.1-avenant11 prêt — renderNGAPSearch, validateNGAPCumul, renderNGAPExplorer exposés.');

})();
