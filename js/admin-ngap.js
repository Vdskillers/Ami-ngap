/* ════════════════════════════════════════════════
   admin-ngap.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   Module d'administration du référentiel NGAP.
   Permet à un admin de modifier tarifs / règles /
   dérogations sans redéploiement, avec :
   • versionnage complet (rollback possible)
   • validation stricte côté worker (anti-casse)
   • audit log CPAM-ready
   • reload dynamique moteur (cache 60s)
   ────────────────────────────────────────────────
   Dépendances : utils.js ($, wpost, showToast),
                 admin.js (onglet "ngap" déjà câblé)
   Backend : /webhook/admin-ngap-get | -save | -rollback
════════════════════════════════════════════════ */

(function(){
'use strict';

/* ── État local ──────────────────────────────── */
let _NG = {
  active: null,        // {id, version, referentiel, ruleset_hash, created_at, note}
  history: [],         // [{id, version, is_active, created_at, note, ruleset_hash}]
  edit: null,          // copie éditable de active.referentiel
  originalJson: '',    // JSON stringifié pour détection dirty
  loaded: false
};

/* ── Helpers ─────────────────────────────────── */
function _esc(s) { return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function _num(v) { const n = parseFloat(String(v).replace(',','.')); return isFinite(n) ? n : 0; }
function _fmtDate(iso) { try { return new Date(iso).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return iso || '—'; } }
function _isDirty() { return _NG.edit && JSON.stringify(_NG.edit) !== _NG.originalJson; }
function _toast(type, title, msg) { if (typeof showToast === 'function') showToast(type, title, msg); else console.log(`[${type}] ${title} — ${msg}`); }
function _badge(color, text) { return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;background:${color};color:#fff;font-size:10px;font-family:var(--fm);letter-spacing:.5px">${_esc(text)}</span>`; }

/* ── Point d'entrée ──────────────────────────── */
window.admNgapLoad = async function() {
  const root = document.getElementById('adm-ngap-root');
  if (!root) return;
  root.innerHTML = `
    <div class="empty" style="padding:30px 0">
      <div class="ei"><div class="spin spinw" style="width:28px;height:28px"></div></div>
      <p style="margin-top:12px">Chargement du référentiel NGAP…</p>
    </div>`;
  try {
    const d = await wpost('/webhook/admin-ngap-get', {});
    if (!d.ok) throw new Error(d.error || 'Erreur backend');
    _NG.active = d.active;
    _NG.history = Array.isArray(d.history) ? d.history : [];
    _NG.edit = JSON.parse(JSON.stringify(d.active.referentiel));
    _NG.originalJson = JSON.stringify(_NG.edit);
    _NG.loaded = true;
    _render();
  } catch(e) {
    root.innerHTML = `<div class="ai er">⚠️ Impossible de charger le référentiel : ${_esc(e.message)}</div>`;
  }
};

/* ── Rendu principal ─────────────────────────── */
function _render() {
  const root = document.getElementById('adm-ngap-root');
  if (!root || !_NG.loaded) return;

  const a = _NG.active;
  const dirty = _isDirty();
  const nbActes1 = (_NG.edit.actes_chapitre_I||[]).length;
  const nbActes2 = (_NG.edit.actes_chapitre_II||[]).length;
  const nbIncomp = (_NG.edit.incompatibilites||[]).length;
  const nbDerog = (_NG.edit.derogations_taux_plein||[]).length;

  root.innerHTML = `
    <!-- En-tête version active -->
    <div class="adm-notice" style="background:linear-gradient(135deg,rgba(0,212,170,.08),rgba(0,212,170,.02));border-color:rgba(0,212,170,.3)">
      <span style="font-size:22px;flex-shrink:0">⚖️</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;margin-bottom:4px">
          <strong style="color:var(--a);font-family:var(--fm)">Version active : ${_esc(a.version)}</strong>
          ${a._fallback ? _badge('#f59e0b','HARDCODED') : _badge('#10b981','EN BASE')}
          ${dirty ? _badge('#ef4444','MODIFIÉ') : _badge('#6b7280','SAUVÉ')}
        </div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">
          Hash : ${_esc((a.ruleset_hash||'').slice(0,12))}… · MAJ ${_fmtDate(a.created_at)}
        </div>
        ${a.note ? `<div style="font-size:12px;color:var(--t);margin-top:4px;font-style:italic">"${_esc(a.note)}"</div>` : ''}
      </div>
    </div>

    <!-- Barre d'actions -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 20px;align-items:center">
      <button class="btn bs bsm" onclick="admNgapLoad()" title="Recharger depuis le serveur">↻ Actualiser</button>
      <button class="btn bs bsm" onclick="admNgapReset()" ${dirty ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'} title="Annuler les modifications">↺ Annuler</button>
      <button class="btn bs bsm" onclick="admNgapToggleHistory()" title="Historique des versions">📜 Historique (${_NG.history.length})</button>
      <button class="btn bs bsm" onclick="admNgapAnalyze()" title="Détecter les anomalies du référentiel (tarifs aberrants, règles manquantes)">🔍 Analyser</button>
      <div style="flex:1"></div>
      <button class="btn bp bsm" onclick="admNgapSavePrompt()" ${dirty ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'} title="Enregistrer une nouvelle version">
        💾 Enregistrer une nouvelle version
      </button>
    </div>

    <!-- Zone historique (repliable) -->
    <div id="adm-ngap-history" style="display:none;margin-bottom:20px"></div>

    <!-- Zone résultats analyseur (repliable) -->
    <div id="adm-ngap-analyze" style="display:none;margin-bottom:20px"></div>

    <!-- Résumé compteurs -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:20px">
      ${_kpiCard('🔑','Lettres-clés', Object.keys(_NG.edit.lettres_cles||{}).length)}
      ${_kpiCard('💰','Forfaits BSI', Object.keys(_NG.edit.forfaits_bsi||{}).length)}
      ${_kpiCard('🚗','Déplacements', Object.keys(_NG.edit.deplacements||{}).length)}
      ${_kpiCard('⏱️','Majorations', Object.keys(_NG.edit.majorations||{}).length)}
      ${_kpiCard('📋','Actes chap. I', nbActes1)}
      ${_kpiCard('📋','Actes chap. II', nbActes2)}
      ${_kpiCard('🚫','Incompatibilités', nbIncomp)}
      ${_kpiCard('✅','Dérogations', nbDerog)}
    </div>

    <!-- ══ BLOC 1 : TARIFS ══ -->
    ${_blockHeader('💰 Tarifs', 'Lettres-clés, forfaits BSI, déplacements, majorations, actes')}
    <div id="adm-ngap-b1" style="margin-bottom:26px">
      ${_renderLettresCles()}
      ${_renderForfaitsBsi()}
      ${_renderDeplacements()}
      ${_renderMajorations()}
      ${_renderActes()}
    </div>

    <!-- ══ BLOC 2 : INCOMPATIBILITÉS ══ -->
    ${_blockHeader('⚖️ Règles d’incompatibilité', 'Cumuls interdits — un groupe écrase l’autre')}
    <div id="adm-ngap-b2" style="margin-bottom:26px">
      ${_renderIncompatibilites()}
    </div>

    <!-- ══ BLOC 3 : DÉROGATIONS ══ -->
    ${_blockHeader('🔗 Dérogations taux plein', 'Cumuls autorisés à 100 % malgré l’article 11B')}
    <div id="adm-ngap-b3" style="margin-bottom:26px">
      ${_renderDerogations()}
    </div>

    <!-- Footer sécurité -->
    <div class="adm-notice" style="margin-top:30px;font-size:12px">
      <span style="font-size:18px;flex-shrink:0">🛡️</span>
      <p>
        <strong>Garde-fous actifs :</strong> validation stricte côté serveur (tarifs &gt; 0, codes critiques obligatoires, structure vérifiée),
        versionnage complet, audit log CPAM, reset cache moteur automatique.
        <strong>Toute modification est traçable et réversible.</strong>
      </p>
    </div>
  `;
}

function _kpiCard(icon, label, val) {
  return `<div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 12px;text-align:center">
    <div style="font-size:18px;margin-bottom:2px">${icon}</div>
    <div style="font-family:var(--fs);font-size:20px;color:var(--a)">${val}</div>
    <div style="font-size:10px;color:var(--m);font-family:var(--fm)">${_esc(label)}</div>
  </div>`;
}

function _blockHeader(title, subtitle) {
  return `<div style="margin:14px 0 10px">
    <div class="lbl" style="font-size:14px;color:var(--a);margin-bottom:2px">${title}</div>
    <div style="font-size:12px;color:var(--m)">${subtitle}</div>
  </div>`;
}

/* ── Rendu sous-blocs Tarifs ─────────────────── */
function _renderLettresCles() {
  const lc = _NG.edit.lettres_cles || {};
  const rows = Object.entries(lc).map(([code, obj]) => `
    <tr>
      <td style="padding:6px 8px;font-family:var(--fm);color:var(--a);font-weight:600">${_esc(code)}</td>
      <td style="padding:6px 8px;font-size:12px;color:var(--m)">${_esc(obj.label||'')}</td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj.valeur||0}" onchange="admNgapEditLC('${_esc(code)}','valeur',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj.valeur_om||0}" onchange="admNgapEditLC('${_esc(code)}','valeur_om',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
    </tr>`).join('');
  return `<details open style="margin-bottom:12px;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 14px">
    <summary style="cursor:pointer;font-family:var(--fm);font-size:12px;color:var(--a);letter-spacing:.5px">🔑 LETTRES-CLÉS (${Object.keys(lc).length})</summary>
    <div style="overflow-x:auto;margin-top:10px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--b);text-align:left">
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Code</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Libellé</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Valeur €</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Valeur OM €</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

function _renderForfaitsBsi() {
  const fb = _NG.edit.forfaits_bsi || {};
  const rows = Object.entries(fb).map(([code, obj]) => `
    <tr>
      <td style="padding:6px 8px;font-family:var(--fm);color:var(--a);font-weight:600">${_esc(code)}</td>
      <td style="padding:6px 8px;font-size:12px;color:var(--m)">${_esc(obj.label||'')}</td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj.tarif||0}" onchange="admNgapEditBSI('${_esc(code)}','tarif',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj.tarif_om||0}" onchange="admNgapEditBSI('${_esc(code)}','tarif_om',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
    </tr>`).join('');
  return `<details style="margin-bottom:12px;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 14px">
    <summary style="cursor:pointer;font-family:var(--fm);font-size:12px;color:var(--a);letter-spacing:.5px">💰 FORFAITS BSI (${Object.keys(fb).length})</summary>
    <div style="overflow-x:auto;margin-top:10px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--b);text-align:left">
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Code</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Libellé</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif €</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif OM €</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

function _renderDeplacements() {
  const dp = _NG.edit.deplacements || {};
  const rows = Object.entries(dp).map(([code, obj]) => {
    const tField = obj.tarif_par_km !== undefined ? 'tarif_par_km' : 'tarif';
    const tOmField = obj.tarif_om_par_km !== undefined ? 'tarif_om_par_km' : 'tarif_om';
    const tUnit = obj.tarif_par_km !== undefined ? '€/km' : '€';
    return `<tr>
      <td style="padding:6px 8px;font-family:var(--fm);color:var(--a);font-weight:600">${_esc(code)}</td>
      <td style="padding:6px 8px;font-size:12px;color:var(--m)">${_esc(obj.label||'')}</td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj[tField]||0}" onchange="admNgapEditDeplacement('${_esc(code)}','${tField}',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"> <span style="color:var(--m);font-size:10px">${tUnit}</span></td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj[tOmField]||0}" onchange="admNgapEditDeplacement('${_esc(code)}','${tOmField}',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
    </tr>`;
  }).join('');
  return `<details style="margin-bottom:12px;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 14px">
    <summary style="cursor:pointer;font-family:var(--fm);font-size:12px;color:var(--a);letter-spacing:.5px">🚗 DÉPLACEMENTS (${Object.keys(dp).length})</summary>
    <div style="overflow-x:auto;margin-top:10px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--b);text-align:left">
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Code</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Libellé</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif OM</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

function _renderMajorations() {
  const mj = _NG.edit.majorations || {};
  const rows = Object.entries(mj).map(([code, obj]) => `
    <tr>
      <td style="padding:6px 8px;font-family:var(--fm);color:var(--a);font-weight:600">${_esc(code)}</td>
      <td style="padding:6px 8px;font-size:12px;color:var(--m)">${_esc(obj.label||'')}</td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj.tarif||0}" onchange="admNgapEditMaj('${_esc(code)}','tarif',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${obj.tarif_om||0}" onchange="admNgapEditMaj('${_esc(code)}','tarif_om',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
      <td style="padding:6px 8px;font-size:10px;color:var(--m);font-family:var(--fm)">${obj.incompatibles ? _esc(obj.incompatibles.join(', ')) : '—'}</td>
    </tr>`).join('');
  return `<details style="margin-bottom:12px;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 14px">
    <summary style="cursor:pointer;font-family:var(--fm);font-size:12px;color:var(--a);letter-spacing:.5px">⏱️ MAJORATIONS (${Object.keys(mj).length})</summary>
    <div style="overflow-x:auto;margin-top:10px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--b);text-align:left">
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Code</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Libellé</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif €</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif OM €</th>
          <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Incompatibles</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

function _renderActes() {
  const a1 = _NG.edit.actes_chapitre_I || [];
  const a2 = _NG.edit.actes_chapitre_II || [];
  return `<details style="margin-bottom:12px;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 14px">
    <summary style="cursor:pointer;font-family:var(--fm);font-size:12px;color:var(--a);letter-spacing:.5px">📋 ACTES (${a1.length + a2.length})</summary>
    <div style="margin-top:10px">
      <input type="text" id="adm-ngap-actes-filter" placeholder="🔍 Filtrer par code ou libellé…" oninput="admNgapFilterActes()" style="width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:12px;margin-bottom:10px">
      <div id="adm-ngap-actes-table" style="overflow-x:auto;max-height:480px;overflow-y:auto">
        ${_renderActesTable('')}
      </div>
    </div>
  </details>`;
}

function _renderActesTable(filter) {
  const q = (filter||'').toLowerCase().trim();
  const a1 = (_NG.edit.actes_chapitre_I || []).map((a,i) => ({...a, _chap:'I', _idx:i}));
  const a2 = (_NG.edit.actes_chapitre_II || []).map((a,i) => ({...a, _chap:'II', _idx:i}));
  const all = [...a1, ...a2].filter(a => !q || (a.code||'').toLowerCase().includes(q) || (a.label||'').toLowerCase().includes(q) || (a.code_facturation||'').toLowerCase().includes(q));
  if (!all.length) return '<p style="color:var(--m);font-size:12px;padding:10px">Aucun acte correspondant.</p>';
  const rows = all.map(a => `
    <tr>
      <td style="padding:6px 8px;font-size:10px;color:var(--m);font-family:var(--fm)">${a._chap}</td>
      <td style="padding:6px 8px;font-family:var(--fm);color:var(--a);font-size:11px">${_esc(a.code_facturation||a.code)}</td>
      <td style="padding:6px 8px;font-size:11px;color:var(--t);min-width:280px">${_esc((a.label||'').slice(0,90))}</td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${a.tarif||0}" onchange="admNgapEditActe('${a._chap}',${a._idx},'tarif',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
      <td style="padding:4px 8px"><input type="number" step="0.01" min="0" value="${a.tarif_om||0}" onchange="admNgapEditActe('${a._chap}',${a._idx},'tarif_om',this.value)" style="width:80px;padding:4px 6px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:12px"></td>
    </tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead style="position:sticky;top:0;background:var(--bg,#1a1a1a);z-index:1"><tr style="border-bottom:1px solid var(--b);text-align:left">
      <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Chap</th>
      <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Code</th>
      <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Libellé</th>
      <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif €</th>
      <th style="padding:6px 8px;font-family:var(--fm);color:var(--m);font-weight:500">Tarif OM €</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ── Rendu Incompatibilités ─────────────────── */
function _renderIncompatibilites() {
  const list = _NG.edit.incompatibilites || [];
  const items = list.map((inc, i) => {
    const sevColor = inc.severity === 'critical' ? '#ef4444' : '#f59e0b';
    return `<div style="background:var(--s);border:1px solid var(--b);border-left:3px solid ${sevColor};border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-bottom:4px">#${i+1} · ${_badge(sevColor, (inc.severity||'warning').toUpperCase())}</div>
          <div style="font-size:12px;color:var(--t);margin-bottom:8px">${_esc(inc.msg||'')}</div>
        </div>
        <button class="btn bs bsm" onclick="admNgapRemoveIncomp(${i})" title="Supprimer cette règle" style="padding:4px 10px;font-size:11px;background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:#ef4444">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">GROUPE A (supprimé si groupe=a)</label>
          <input type="text" value="${_esc((inc.groupe_a||[]).join(', '))}" onchange="admNgapEditIncomp(${i},'groupe_a',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:11px;margin-top:2px" placeholder="AMI14, AMX14">
        </div>
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">GROUPE B</label>
          <input type="text" value="${_esc((inc.groupe_b||[]).join(', '))}" onchange="admNgapEditIncomp(${i},'groupe_b',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:11px;margin-top:2px" placeholder="AMI15, AMX15">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:100px 120px 1fr;gap:10px;margin-top:8px">
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">SUPPRIMER</label>
          <select onchange="admNgapEditIncomp(${i},'supprimer',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:11px;margin-top:2px">
            <option value="groupe_a" ${inc.supprimer==='groupe_a'?'selected':''}>groupe_a</option>
            <option value="groupe_b" ${inc.supprimer==='groupe_b'?'selected':''}>groupe_b</option>
          </select>
        </div>
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">SÉVÉRITÉ</label>
          <select onchange="admNgapEditIncomp(${i},'severity',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:11px;margin-top:2px">
            <option value="critical" ${inc.severity==='critical'?'selected':''}>critical</option>
            <option value="warning" ${inc.severity==='warning'?'selected':''}>warning</option>
            <option value="info" ${inc.severity==='info'?'selected':''}>info</option>
          </select>
        </div>
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">MESSAGE</label>
          <input type="text" value="${_esc(inc.msg||'')}" onchange="admNgapEditIncomp(${i},'msg',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:11px;margin-top:2px">
        </div>
      </div>
    </div>`;
  }).join('');
  return items + `<button class="btn bs bsm" onclick="admNgapAddIncomp()" style="margin-top:6px">➕ Ajouter une règle</button>`;
}

/* ── Rendu Dérogations ───────────────────────── */
function _renderDerogations() {
  const list = _NG.edit.derogations_taux_plein || [];
  const items = list.map((d, i) => `
    <div style="background:var(--s);border:1px solid var(--b);border-left:3px solid #10b981;border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-bottom:4px">#${i+1} · ${_badge('#10b981','CUMUL AUTORISÉ')}</div>
          <div style="font-size:12px;color:var(--t)">${_esc(d.msg||'')}</div>
        </div>
        <button class="btn bs bsm" onclick="admNgapRemoveDerog(${i})" title="Supprimer" style="padding:4px 10px;font-size:11px;background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:#ef4444">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">GROUPE A</label>
          <input type="text" value="${_esc((d.codes_groupe_a||[]).join(', '))}" onchange="admNgapEditDerog(${i},'codes_groupe_a',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:11px;margin-top:2px">
        </div>
        <div>
          <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">GROUPE B</label>
          <input type="text" value="${_esc((d.codes_groupe_b||[]).join(', '))}" onchange="admNgapEditDerog(${i},'codes_groupe_b',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-family:var(--fm);font-size:11px;margin-top:2px">
        </div>
      </div>
      <div style="margin-top:8px">
        <label style="font-size:10px;color:var(--m);font-family:var(--fm);letter-spacing:.5px">MESSAGE</label>
        <input type="text" value="${_esc(d.msg||'')}" onchange="admNgapEditDerog(${i},'msg',this.value)" style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:11px;margin-top:2px">
      </div>
    </div>`).join('');
  return items + `<button class="btn bs bsm" onclick="admNgapAddDerog()" style="margin-top:6px">➕ Ajouter une dérogation</button>`;
}

/* ── Historique ──────────────────────────────── */
window.admNgapToggleHistory = function() {
  const el = document.getElementById('adm-ngap-history');
  if (!el) return;
  if (el.style.display === 'none') {
    _renderHistory();
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
};

function _renderHistory() {
  const el = document.getElementById('adm-ngap-history');
  if (!el) return;
  if (!_NG.history.length) {
    el.innerHTML = '<div class="ai in">Aucun historique disponible.</div>';
    return;
  }
  const rows = _NG.history.map(h => `
    <tr style="border-bottom:1px solid var(--b)">
      <td style="padding:8px;font-family:var(--fm);font-size:11px;color:${h.is_active?'var(--a)':'var(--t)'};font-weight:${h.is_active?'600':'400'}">
        ${h.is_active ? '● ' : ''}${_esc(h.version)}
      </td>
      <td style="padding:8px;font-size:11px;color:var(--m);font-family:var(--fm)">${_fmtDate(h.created_at)}</td>
      <td style="padding:8px;font-size:10px;color:var(--m);font-family:var(--fm)">${_esc((h.ruleset_hash||'').slice(0,8))}</td>
      <td style="padding:8px;font-size:11px;color:var(--t);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(h.note||'—')}</td>
      <td style="padding:8px;text-align:right">
        ${h.is_active ? _badge('#10b981','ACTIVE') : `<button class="btn bs bsm" onclick="admNgapRollback('${_esc(h.id)}','${_esc(h.version)}')" style="padding:4px 10px;font-size:11px">↩ Restaurer</button>`}
      </td>
    </tr>`).join('');
  el.innerHTML = `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px">
      <div class="lbl" style="margin-bottom:10px">📜 Historique des versions (${_NG.history.length})</div>
      <div style="overflow-x:auto;max-height:380px;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:1px solid var(--b);text-align:left">
            <th style="padding:8px;font-family:var(--fm);color:var(--m);font-weight:500">Version</th>
            <th style="padding:8px;font-family:var(--fm);color:var(--m);font-weight:500">Date</th>
            <th style="padding:8px;font-family:var(--fm);color:var(--m);font-weight:500">Hash</th>
            <th style="padding:8px;font-family:var(--fm);color:var(--m);font-weight:500">Note</th>
            <th style="padding:8px;text-align:right"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

/* ── Handlers édition ────────────────────────── */
window.admNgapEditLC = function(code, field, val) {
  if (!_NG.edit.lettres_cles[code]) return;
  _NG.edit.lettres_cles[code][field] = _num(val);
  _refreshHeader();
};
window.admNgapEditBSI = function(code, field, val) {
  if (!_NG.edit.forfaits_bsi[code]) return;
  _NG.edit.forfaits_bsi[code][field] = _num(val);
  _refreshHeader();
};
window.admNgapEditDeplacement = function(code, field, val) {
  if (!_NG.edit.deplacements[code]) return;
  _NG.edit.deplacements[code][field] = _num(val);
  _refreshHeader();
};
window.admNgapEditMaj = function(code, field, val) {
  if (!_NG.edit.majorations[code]) return;
  _NG.edit.majorations[code][field] = _num(val);
  _refreshHeader();
};
window.admNgapEditActe = function(chap, idx, field, val) {
  const key = chap === 'I' ? 'actes_chapitre_I' : 'actes_chapitre_II';
  if (!_NG.edit[key] || !_NG.edit[key][idx]) return;
  _NG.edit[key][idx][field] = _num(val);
  _refreshHeader();
};
window.admNgapFilterActes = function() {
  const f = document.getElementById('adm-ngap-actes-filter');
  const t = document.getElementById('adm-ngap-actes-table');
  if (!f || !t) return;
  t.innerHTML = _renderActesTable(f.value);
};

/* Incompatibilités */
window.admNgapEditIncomp = function(i, field, val) {
  const list = _NG.edit.incompatibilites;
  if (!list || !list[i]) return;
  if (field === 'groupe_a' || field === 'groupe_b') {
    list[i][field] = String(val).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    list[i][field] = val;
  }
  _refreshHeader();
};
window.admNgapAddIncomp = function() {
  if (!_NG.edit.incompatibilites) _NG.edit.incompatibilites = [];
  _NG.edit.incompatibilites.push({ groupe_a: [], groupe_b: [], supprimer: 'groupe_a', msg: 'Nouvelle règle', severity: 'warning' });
  document.getElementById('adm-ngap-b2').innerHTML = _renderIncompatibilites();
  _refreshHeader();
};
window.admNgapRemoveIncomp = function(i) {
  if (!confirm('Supprimer cette règle d\'incompatibilité ?')) return;
  _NG.edit.incompatibilites.splice(i, 1);
  document.getElementById('adm-ngap-b2').innerHTML = _renderIncompatibilites();
  _refreshHeader();
};

/* Dérogations */
window.admNgapEditDerog = function(i, field, val) {
  const list = _NG.edit.derogations_taux_plein;
  if (!list || !list[i]) return;
  if (field === 'codes_groupe_a' || field === 'codes_groupe_b') {
    list[i][field] = String(val).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    list[i][field] = val;
  }
  _refreshHeader();
};
window.admNgapAddDerog = function() {
  if (!_NG.edit.derogations_taux_plein) _NG.edit.derogations_taux_plein = [];
  _NG.edit.derogations_taux_plein.push({ codes_groupe_a: [], codes_groupe_b: [], msg: 'Nouvelle dérogation' });
  document.getElementById('adm-ngap-b3').innerHTML = _renderDerogations();
  _refreshHeader();
};
window.admNgapRemoveDerog = function(i) {
  if (!confirm('Supprimer cette dérogation ?')) return;
  _NG.edit.derogations_taux_plein.splice(i, 1);
  document.getElementById('adm-ngap-b3').innerHTML = _renderDerogations();
  _refreshHeader();
};

/* ── Rafraîchissement ciblé du header (évite full re-render) ── */
function _refreshHeader() {
  // Re-render complet (simple et robuste). Optim possible plus tard.
  _render();
}

/* ── Reset modifications ─────────────────────── */
window.admNgapReset = function() {
  if (!_isDirty()) return;
  if (!confirm('Annuler toutes les modifications non sauvegardées ?')) return;
  _NG.edit = JSON.parse(_NG.originalJson);
  _render();
  _toast('info', 'Modifications annulées', 'Le référentiel a été restauré.');
};

/* ── Sauvegarde ──────────────────────────────── */
window.admNgapSavePrompt = async function() {
  if (!_isDirty()) { _toast('warn', 'Aucune modification', 'Le référentiel n\'a pas été modifié.'); return; }

  // Générer un numéro de version incrémenté
  const base = (_NG.active.version || 'NGAP_2026').replace(/\.(\d+)$/, (m, n) => `.${parseInt(n)+1}`);
  const suggested = /\.\d+$/.test(base) ? base : base + '.1';

  const version = prompt(
    `Nouvelle version du référentiel NGAP\n\nNuméro de version (doit être unique) :`,
    suggested
  );
  if (!version || !version.trim()) return;

  const note = prompt(
    `Note / changelog (optionnel) :\n\nEx: "Mise à jour tarif BSC suite avenant 7 du 15/03/2026"`,
    ''
  );

  // Compter les changements pour confirmation
  const changes = _countChanges();
  if (!confirm(
    `Confirmer la sauvegarde ?\n\n` +
    `Version       : ${version.trim()}\n` +
    `Modifications : ${changes.total}\n` +
    `  • Tarifs    : ${changes.tarifs}\n` +
    `  • Règles    : ${changes.regles}\n` +
    `  • Dérogations : ${changes.derog}\n\n` +
    `Le moteur sera mis à jour immédiatement.\n` +
    `Cette action est tracée dans les logs d'audit.`
  )) return;

  try {
    const d = await wpost('/webhook/admin-ngap-save', {
      version: version.trim(),
      referentiel: _NG.edit,
      note: (note || '').trim()
    });
    if (!d.ok) throw new Error(d.error || 'Erreur sauvegarde');
    _toast('success', 'Référentiel sauvegardé', `Version "${d.version}" active · hash ${(d.ruleset_hash||'').slice(0,8)}`);
    if (d.warnings && d.warnings.length) {
      _toast('warn', 'Avertissements', d.warnings.slice(0,3).join(' · '));
    }
    // Recharger pour synchroniser l'historique
    await window.admNgapLoad();
  } catch(e) {
    _toast('error', 'Sauvegarde échouée', e.message);
  }
};

function _countChanges() {
  if (!_NG.active || !_NG.active.referentiel) return { total: 0, tarifs: 0, regles: 0, derog: 0 };
  const orig = _NG.active.referentiel;
  const edit = _NG.edit;
  let tarifs = 0, regles = 0, derog = 0;

  // Tarifs : lettres_cles, forfaits_bsi, deplacements, majorations, actes
  ['lettres_cles','forfaits_bsi','deplacements','majorations'].forEach(key => {
    const a = orig[key] || {}, b = edit[key] || {};
    Object.keys(b).forEach(k => { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) tarifs++; });
  });
  ['actes_chapitre_I','actes_chapitre_II'].forEach(key => {
    const a = orig[key] || [], b = edit[key] || [];
    b.forEach((x, i) => { if (JSON.stringify(a[i]) !== JSON.stringify(x)) tarifs++; });
  });

  // Règles
  if (JSON.stringify(orig.incompatibilites||[]) !== JSON.stringify(edit.incompatibilites||[])) {
    regles = Math.max((edit.incompatibilites||[]).length, (orig.incompatibilites||[]).length);
  }
  if (JSON.stringify(orig.derogations_taux_plein||[]) !== JSON.stringify(edit.derogations_taux_plein||[])) {
    derog = Math.max((edit.derogations_taux_plein||[]).length, (orig.derogations_taux_plein||[]).length);
  }

  return { tarifs, regles, derog, total: tarifs + regles + derog };
}

/* ── Rollback ────────────────────────────────── */
window.admNgapRollback = async function(id, version) {
  if (_isDirty()) {
    if (!confirm('Des modifications non sauvegardées seront perdues. Continuer le rollback vers "' + version + '" ?')) return;
  } else {
    if (!confirm('Restaurer la version "' + version + '" ?\n\nLe moteur sera immédiatement basculé sur cette version.\nCette action est tracée dans les logs d\'audit.')) return;
  }
  try {
    const d = await wpost('/webhook/admin-ngap-rollback', { id });
    if (!d.ok) throw new Error(d.error || 'Erreur rollback');
    _toast('success', 'Rollback effectué', 'Version "' + d.version + '" réactivée.');
    await window.admNgapLoad();
  } catch(e) {
    _toast('error', 'Rollback échoué', e.message);
  }
};


/* ── Analyse anomalies via NGAPAnalyzer ──────── */
window.admNgapAnalyze = function() {
  const panel = document.getElementById('adm-ngap-analyze');
  if (!panel) return;

  // Toggle si déjà affiché
  if (panel.style.display === 'block' && panel.dataset.shown === '1') {
    panel.style.display = 'none';
    panel.dataset.shown = '0';
    return;
  }

  if (typeof window.NGAPAnalyzer === 'undefined' || !window.NGAPAnalyzer.analyzeReferentiel) {
    panel.innerHTML = '<div class="ai wa">⚠️ Module NGAPAnalyzer non chargé. Vérifier que <code>js/ngap-analyzer.js</code> est bien inclus dans <code>index.html</code>.</div>';
    panel.style.display = 'block';
    panel.dataset.shown = '1';
    return;
  }

  try {
    const results = window.NGAPAnalyzer.analyzeReferentiel(_NG.edit);
    if (!Array.isArray(results) || results.length === 0) {
      panel.innerHTML = `
        <div class="ai ok" style="border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.08)">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:20px">✅</span>
            <div>
              <strong style="color:#10b981">Aucune anomalie détectée</strong>
              <div style="font-size:11px;color:var(--m);margin-top:2px">Le référentiel est conforme aux règles NGAP 2026 / CIR-9/2025 connues.</div>
            </div>
          </div>
        </div>`;
    } else {
      const errors = results.filter(r => r.level === 'error');
      const warnings = results.filter(r => r.level === 'warning');
      const infos = results.filter(r => r.level === 'info');

      const renderItem = (r, i) => {
        const color = r.level === 'error' ? '#ef4444' : (r.level === 'warning' ? '#f59e0b' : '#4fa8ff');
        const icon = r.level === 'error' ? '🛑' : (r.level === 'warning' ? '⚠️' : 'ℹ️');
        const fixBtn = r.fix ? `
          <button class="btn bs" style="padding:4px 10px;font-size:11px;margin-top:6px"
                  onclick='admNgapApplyFix(${_esc(JSON.stringify(r.fix))})'
                  title="Appliquer la correction suggérée (à vérifier avant sauvegarde)">
            🔧 Appliquer la correction suggérée
          </button>` : '';
        return `
          <div style="padding:10px 12px;background:rgba(${r.level === 'error' ? '239,68,68' : (r.level === 'warning' ? '245,158,11' : '79,168,255')},.06);border-left:3px solid ${color};border-radius:6px;margin-bottom:6px">
            <div style="display:flex;gap:8px;align-items:flex-start">
              <span style="font-size:14px;flex-shrink:0">${icon}</span>
              <div style="flex:1;font-size:12px;line-height:1.5;color:var(--t)">${_esc(r.msg)}${fixBtn}</div>
            </div>
          </div>`;
      };

      panel.innerHTML = `
        <div style="background:var(--s);border:1px solid var(--b);border-radius:12px;padding:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--b)">
            <span style="font-size:22px">🔍</span>
            <div style="flex:1">
              <strong style="font-family:var(--fi);font-size:14px">Analyse du référentiel</strong>
              <div style="font-size:11px;color:var(--m);margin-top:2px">
                ${errors.length > 0 ? `<span style="color:#ef4444">🛑 ${errors.length} erreur${errors.length>1?'s':''}</span> · ` : ''}
                ${warnings.length > 0 ? `<span style="color:#f59e0b">⚠️ ${warnings.length} avertissement${warnings.length>1?'s':''}</span> · ` : ''}
                ${infos.length > 0 ? `<span style="color:#4fa8ff">ℹ️ ${infos.length} info${infos.length>1?'s':''}</span>` : ''}
              </div>
            </div>
            <button class="btn bs" style="padding:4px 10px;font-size:11px" onclick="document.getElementById('adm-ngap-analyze').style.display='none';document.getElementById('adm-ngap-analyze').dataset.shown='0'">✕ Fermer</button>
          </div>
          ${errors.map(renderItem).join('')}
          ${warnings.map(renderItem).join('')}
          ${infos.map(renderItem).join('')}
        </div>`;
    }
    panel.style.display = 'block';
    panel.dataset.shown = '1';
  } catch(e) {
    panel.innerHTML = `<div class="ai er">⚠️ Erreur lors de l'analyse : ${_esc(e.message)}</div>`;
    panel.style.display = 'block';
    panel.dataset.shown = '1';
  }
};

/* ── Applique un fix suggéré par l'analyseur ─── */
window.admNgapApplyFix = function(fix) {
  if (!fix || !fix.type) return;
  try {
    if (fix.type === 'set_tarif' && fix.code && fix.value != null) {
      // Chercher l'acte dans les deux chapitres + forfaits/majorations
      const code = fix.code;
      const edit = _NG.edit;
      let updated = false;

      // Chercher dans les actes des chapitres I et II
      ['actes_chapitre_I', 'actes_chapitre_II'].forEach(key => {
        (edit[key] || []).forEach(a => {
          if ((a.code === code || a.code_facturation === code) && !updated) {
            a.tarif = fix.value;
            updated = true;
          }
        });
      });

      // Chercher dans forfaits BSI
      if (!updated && edit.forfaits_bsi && edit.forfaits_bsi[code]) {
        edit.forfaits_bsi[code].tarif = fix.value;
        updated = true;
      }
      // Chercher dans majorations
      if (!updated && edit.majorations) {
        Object.keys(edit.majorations).forEach(k => {
          if ((k === code || edit.majorations[k].code_alias === code) && !updated) {
            edit.majorations[k].tarif = fix.value;
            updated = true;
          }
        });
      }

      if (updated) {
        _toast('success', 'Correction appliquée', `${code} → ${fix.value.toFixed(2)}€ (à vérifier et sauvegarder).`);
        _render();
        // Réouvrir le panneau d'analyse pour voir l'évolution
        setTimeout(() => { const p = document.getElementById('adm-ngap-analyze'); if (p) p.dataset.shown = '0'; window.admNgapAnalyze(); }, 150);
      } else {
        _toast('warn', 'Code non trouvé', `Impossible de localiser ${code} dans le référentiel.`);
      }
    } else {
      _toast('warn', 'Correction non supportée', `Type de fix : ${fix.type}`);
    }
  } catch(e) {
    _toast('error', 'Erreur application', e.message);
  }
};

})();
