/* ════════════════════════════════════════════════
   tresorerie.js — AMI NGAP
   ────────────────────────────────────────────────
   Suivi de trésorerie & comptabilité
   ✅ Fonctions :
   - loadTresorerie()       — charge et affiche le tableau
   - renderTresorerie(data) — rendu HTML
   - markPaid(id, who)      — marquer remboursé AMO ou AMC
   - exportComptable()      — export CSV comptable/URSSAF
   - statsRemboursements()  — en attente vs reçu
   - checklistCPAM()        — audit conformité avant envoi lot
════════════════════════════════════════════════ */

const TRESOR_PAID_KEY  = 'ami_tresor_paid';

/* ══════════════════════════════════════════════════════
   BARÈME KILOMÉTRIQUE PARTAGÉ — 2025/2026
   Source : Service-Public.fr, brochure fiscale 09/04/2026
   Clé préférences : ami_km_prefs_<userId>  (partagée avec
   infirmiere-tools.js, offline-queue.js, rapport.js)
══════════════════════════════════════════════════════ */
const _KM_BAREME = {
  3: { t1:0.529, t2a:0.316, t2b:1065, t3:0.370, label:'3 CV' },
  4: { t1:0.606, t2a:0.340, t2b:1330, t3:0.407, label:'4 CV' },
  5: { t1:0.636, t2a:0.357, t2b:1395, t3:0.427, label:'5 CV' },
  6: { t1:0.665, t2a:0.374, t2b:1457, t3:0.447, label:'6 CV' },
  7: { t1:0.697, t2a:0.394, t2b:1515, t3:0.470, label:'7 CV et +' },
};
const _KM_ELEC_BONUS = 1.20; // +20% électrique

/* Clé localStorage pour préférences véhicule (isolée par userId) */
function _kmPrefsKey() {
  let uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
  if (!uid) { try { uid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {} }
  return 'ami_km_prefs_' + String(uid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* Lire les préférences véhicule (cv + électrique) */
function _loadKmPrefs() {
  try { return JSON.parse(localStorage.getItem(_kmPrefsKey()) || '{}'); } catch { return {}; }
}

/* Sauvegarder les préférences véhicule */
function _saveKmPrefs(prefs) {
  try { localStorage.setItem(_kmPrefsKey(), JSON.stringify(prefs)); } catch {}
}

/* Calculer le taux km selon puissance + tranche + électrique */
function _calcKmRate(cv, kmAnnuel, electrique) {
  const b = _KM_BAREME[cv] || _KM_BAREME[5];
  let rate;
  if      (kmAnnuel <= 5000)  rate = b.t1;
  else if (kmAnnuel <= 20000) rate = b.t2a + b.t2b / kmAnnuel;
  else                        rate = b.t3;
  return electrique ? rate * _KM_ELEC_BONUS : rate;
}

/* Taux moyen approximatif pour une période (≤5000km : tranche 1) */
function _getKmRateForDisplay(cv, electrique) {
  const b = _KM_BAREME[cv] || _KM_BAREME[5];
  const base = b.t1; // tranche ≤5000 = taux de référence affiché
  return electrique ? +(base * _KM_ELEC_BONUS).toFixed(3) : base;
}

/* Label barème pour affichage */
function _kmBaremeLabel(cv, electrique) {
  const lbl = _KM_BAREME[cv]?.label || '5 CV';
  return electrique ? `${lbl} · ⚡ électrique` : lbl;
}

/* Charge les paiements locaux (localStorage) */
function _loadPaidMap() {
  try { return JSON.parse(localStorage.getItem(TRESOR_PAID_KEY)||'{}'); } catch { return {}; }
}
function _savePaidMap(map) {
  try { localStorage.setItem(TRESOR_PAID_KEY, JSON.stringify(map)); } catch {}
}

/* ════════════════════════════════════════════════
   JOURNAL KILOMÉTRIQUE — données pour la période
════════════════════════════════════════════════ */
function _getKmForPeriod(period) {
  try {
    // Préférences véhicule (cv + électrique)
    const prefs      = _loadKmPrefs();
    const cv         = parseInt(prefs.cv) || 5;
    const electrique = !!prefs.electrique;

    // Clé isolée par userId
    let _kmUid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    if (!_kmUid) { try { _kmUid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {} }
    const _kmStoreKey = 'ami_km_journal_' + String(_kmUid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const entries = JSON.parse(localStorage.getItem(_kmStoreKey) || '[]');
    const now = new Date();

    // km totaux de l'année (pour tranches barème)
    const kmAnnuel = entries
      .filter(e => new Date(e.date).getFullYear() === now.getFullYear())
      .reduce((s, e) => s + parseFloat(e.km || 0), 0);

    // Filtrer par période
    let since = new Date();
    let until = null;
    if      (period === 'today')     { since.setHours(0,0,0,0); }
    else if (period === 'week')      { since.setDate(now.getDate() - 7); }
    else if (period === 'lastmonth') {
      since = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      until = new Date(now.getFullYear(), now.getMonth(), 0);
    }
    else if (period === '3month')    { since.setMonth(now.getMonth() - 3); }
    else if (period === 'year')      { since = new Date(now.getFullYear(), 0, 1); }
    else /* month */                 { since = new Date(now.getFullYear(), now.getMonth(), 1); }

    const filtered = until
      ? entries.filter(e => { const d = new Date(e.date); return d >= since && d <= until; })
      : entries.filter(e => new Date(e.date) >= since);

    const totalKm  = filtered.reduce((s, e) => s + parseFloat(e.km || 0), 0);
    const taux     = _calcKmRate(cv, kmAnnuel, electrique);
    const deduction = totalKm * taux;

    const labels = { month:'Ce mois', lastmonth:'Mois précédent', '3month':'3 derniers mois', year:'Cette année', today:"Aujourd'hui", week:'Cette semaine' };
    return {
      totalKm:    Math.round(totalKm * 10) / 10,
      deduction:  Math.round(deduction * 100) / 100,
      count:      filtered.length,
      label:      labels[period] || 'Ce mois',
      taux,
      cv,
      electrique,
      baremeLabel: _kmBaremeLabel(cv, electrique),
    };
  } catch { return { totalKm: 0, deduction: 0, count: 0, label: '', taux: 0.636, cv: 5, electrique: false, baremeLabel: '5 CV' }; }
}

/* ════════════════════════════════════════════════
   CHARGEMENT PRINCIPAL
════════════════════════════════════════════════ */
async function loadTresorerie() {
  const el = $('tresor-body');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px"><div class="spin spinw" style="width:28px;height:28px;margin:0 auto 10px"></div><p style="color:var(--m)">Chargement...</p></div>';

  const period = gv('tresor-period') || 'month';
  try {
    const d   = await fetchAPI(`/webhook/ami-historique?period=${period}`);
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    const km  = _getKmForPeriod(period);
    renderTresorerie(arr, km);
    statsRemboursements(arr);
  } catch(e) {
    el.innerHTML = `<div class="ai er">⚠️ ${e.message}</div>`;
  }
}

/* ════════════════════════════════════════════════
   RENDU TABLEAU
════════════════════════════════════════════════ */
function renderTresorerie(arr, km) {
  const el = $('tresor-body');
  if (!el) return;
  const paid = _loadPaidMap();

  // ── Bloc kilométrique premium ─────────────────────────────────────────────
  const kmBlock = km && km.totalKm > 0 ? `
    <div class="km-block-premium">
      <div style="font-size:24px;flex-shrink:0">🚗</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--t)">Journal kilométrique — <span style="color:var(--a2)">${km.label}</span></div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">${km.count} trajet(s) · ${km.taux ? km.taux.toFixed(3)+' €/km' : 'barème'} · ${km.baremeLabel || '5 CV'} · 2025/2026</div>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div class="km-stat">
          <div class="km-stat-val" style="color:var(--a2)">${km.totalKm.toFixed(1)} km</div>
          <div class="km-stat-lbl">parcourus</div>
        </div>
        <div class="km-stat">
          <div class="km-stat-val" style="color:var(--ok)">${km.deduction.toFixed(2)} €</div>
          <div class="km-stat-lbl">déduction fiscale</div>
        </div>
      </div>
    </div>` : (km?.count === 0 ? `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:10px">
      <span style="font-size:18px">🚗</span>
      <span style="font-size:12px;color:var(--m)">Aucun trajet sur cette période. <a href="#" onclick="if(typeof navTo==='function')navTo('outils-km',null)" style="color:var(--a);text-decoration:none">→ Ajouter des trajets</a></span>
    </div>` : '');

  if (!arr.length) {
    el.innerHTML = kmBlock + '<div class="empty"><div class="ei">💸</div><p style="margin-top:8px;color:var(--m)">Aucune cotation sur cette période.</p></div>';
    return;
  }

  let totalTTC = 0, totalAMO = 0, totalAMC = 0, totalPat = 0;
  let amoRecu  = 0, amcRecu  = 0, amoAttente = 0, amcAttente = 0;

  const rows = arr.map(r => {
    const id    = r.id;
    const total = parseFloat(r.total||0);
    const amo   = parseFloat(r.part_amo||0);
    const amc   = parseFloat(r.part_amc||0);
    const pat   = parseFloat(r.part_patient||0);
    const amoPaid = !!paid[id+'_amo'];
    const amcPaid = !!paid[id+'_amc'];

    totalTTC += total; totalAMO += amo; totalAMC += amc; totalPat += pat;
    if (amoPaid) amoRecu += amo; else amoAttente += amo;
    if (amcPaid) amcRecu += amc; else amcAttente += amc;

    const date = r.date_soin ? new Date(r.date_soin).toLocaleDateString('fr-FR', {day:'2-digit', month:'short'}) : '—';
    let actesCodes = '—';
    try { actesCodes = JSON.parse(r.actes||'[]').map(a=>a.code||'').filter(Boolean).join(', ') || '—'; } catch {}

    const rowCls = (!amoPaid || !amcPaid) ? 'tresor-tr attente' : 'tresor-tr';

    return `<tr class="${rowCls}">
      <td class="tresor-td" style="white-space:nowrap">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m)">#${id}</div>
        <div style="font-size:12px">${date}</div>
      </td>
      <td class="tresor-td" style="font-family:var(--fm);font-size:11px;color:var(--a2)">${actesCodes}</td>
      <td class="tresor-td" style="font-family:var(--fm);font-size:13px;font-weight:700;color:var(--a)">${total.toFixed(2)} €</td>
      <td class="tresor-td" style="text-align:center">
        <button onclick="markPaid('${id}','amo')" class="pay-pill ${amoPaid?'paid':'pending'}">
          ${amoPaid ? '✅' : '⏳'} ${amo.toFixed(2)} €
        </button>
      </td>
      <td class="tresor-td" style="text-align:center">
        ${amc > 0
          ? `<button onclick="markPaid('${id}','amc')" class="pay-pill ${amcPaid?'paid':'pending'}">${amcPaid?'✅':'⏳'} ${amc.toFixed(2)} €</button>`
          : '<span style="color:var(--m);font-size:12px">—</span>'}
      </td>
      <td class="tresor-td" style="font-family:var(--fm);font-size:11px;color:var(--m)">${pat.toFixed(2)} €</td>
      <td class="tresor-td" style="text-align:center">
        ${r.dre_requise ? '<span style="font-family:var(--fm);font-size:10px;background:rgba(79,168,255,.1);color:var(--a2);padding:2px 7px;border-radius:8px;border:1px solid rgba(79,168,255,.2)">DRE</span>' : ''}
      </td>
    </tr>`;
  }).join('');

  // ── Alert strip attente ───────────────────────────────────────────────────
  const attenteStrip = (amoAttente > 1 || amcAttente > 1) ? `
    <div class="tresor-attente-strip">
      <div class="tresor-attente-dot"></div>
      <div class="tresor-attente-text">
        <strong>${amoAttente.toFixed(2)} €</strong> en attente AMO
        ${amcAttente > 0 ? ` · <strong>${amcAttente.toFixed(2)} €</strong> en attente AMC` : ''}
        — marquez comme reçu au fur et à mesure
      </div>
    </div>` : '';

  el.innerHTML = `
    ${kmBlock}
    <div class="sg" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-bottom:16px">
      <div class="sc g"><div class="si">💶</div><div class="sv">${totalTTC.toFixed(0)} €</div><div class="sn">Total facturé</div></div>
      <div class="sc b"><div class="si">✅</div><div class="sv">${amoRecu.toFixed(0)} €</div><div class="sn">AMO reçu</div></div>
      <div class="sc o"><div class="si">⏳</div><div class="sv">${amoAttente.toFixed(0)} €</div><div class="sn">AMO en attente</div></div>
      <div class="sc b"><div class="si">✅</div><div class="sv">${amcRecu.toFixed(0)} €</div><div class="sn">AMC reçu</div></div>
      <div class="sc o"><div class="si">⏳</div><div class="sv">${amcAttente.toFixed(0)} €</div><div class="sn">AMC en attente</div></div>
      <div class="sc r"><div class="si">💳</div><div class="sv">${totalPat.toFixed(0)} €</div><div class="sn">Part patients</div></div>
      ${km?.deduction > 0 ? `<div class="sc b"><div class="si">🚗</div><div class="sv">${km.deduction.toFixed(0)} €</div><div class="sn">Déd. km</div></div>` : ''}
    </div>
    ${attenteStrip}
    <div class="tresor-table-wrap">
      <table class="tresor-table">
        <thead class="tresor-thead"><tr>
          <th>ID / Date</th>
          <th>Actes</th>
          <th>Total</th>
          <th class="amo" style="text-align:center">AMO SS</th>
          <th class="amc" style="text-align:center">AMC Mutuelle</th>
          <th>Patient</th>
          <th style="text-align:center">DRE</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div id="tresor-checklist-bar" style="margin-top:14px"></div>`;
}

/* Marquer un remboursement comme reçu */
function markPaid(id, who) {
  const map = _loadPaidMap();
  const key = id+'_'+who;
  map[key] = !map[key]; // toggle
  _savePaidMap(map);
  loadTresorerie(); // recharger
}

/* Stats rapides en attente */
function statsRemboursements(arr) {
  if (!arr) return;
  const paid = _loadPaidMap();
  let attente = 0;
  arr.forEach(r => {
    if (!paid[r.id+'_amo']) attente += parseFloat(r.part_amo||0);
  });
  const badge = $('tresor-attente-badge');
  if (badge) {
    badge.textContent = attente > 0 ? attente.toFixed(0)+'€ en attente' : '✅ À jour';
    badge.style.color = attente > 0 ? 'var(--w)' : 'var(--a)';
  }
}

/* ════════════════════════════════════════════════
   EXPORT CSV COMPTABLE
════════════════════════════════════════════════ */
async function exportComptable() {
  const period = gv('tresor-period') || 'month';
  try {
    const d   = await fetchAPI(`/webhook/ami-historique?period=${period}`);
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    const paid = _loadPaidMap();
    const km   = _getKmForPeriod(period);

    const header = ['ID','Date soin','Actes','Total TTC','Part AMO','AMO reçu','Part AMC','AMC reçu','Part Patient','DRE','N° Facture','Version NGAP'];
    const lines  = arr.map(r => {
      let actes = '';
      try { actes = JSON.parse(r.actes||'[]').map(a=>a.code||'').filter(Boolean).join('+'); } catch {}
      return [
        r.id,
        r.date_soin||'',
        actes,
        parseFloat(r.total||0).toFixed(2),
        parseFloat(r.part_amo||0).toFixed(2),
        paid[r.id+'_amo'] ? 'OUI' : 'NON',
        parseFloat(r.part_amc||0).toFixed(2),
        paid[r.id+'_amc'] ? 'OUI' : 'NON',
        parseFloat(r.part_patient||0).toFixed(2),
        r.dre_requise ? 'OUI' : 'NON',
        r.invoice_number||'',
        r.ngap_version||'',
      ].join(';');
    });

    // Ligne séparatrice + récap kilométrique
    if (km.totalKm > 0) {
      lines.push('');
      lines.push(['KILOMÉTRIQUE','','','','','','','','','','',''].join(';'));
      lines.push([
        'KM',
        km.label,
        `${km.count} trajet(s)`,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        `${km.totalKm.toFixed(1)} km parcourus`,
        `Déduction ${km.deduction.toFixed(2)} € (${km.taux ? km.taux.toFixed(3) : '0.636'} €/km · ${km.baremeLabel || '5 CV'})`,
      ].join(';'));
    }

    const csv  = [header.join(';'), ...lines].join('\n');
    const blob = new Blob(['\ufeff'+csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ami-export-${period}-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    showToastSafe('📊 Export CSV téléchargé.');
  } catch(e) { alert('Erreur export : '+e.message); }
}

/* ════════════════════════════════════════════════
   CHECKLIST CONFORMITÉ CPAM
════════════════════════════════════════════════ */
async function checklistCPAM() {
  const el = $('checklist-body');
  if (!el) return;

  try {
    const d   = await fetchAPI('/webhook/ami-historique?period=month');
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];

    const checks = [];
    let ok = 0, warn = 0, err = 0;

    // 1. Chaque acte a un N° facture
    const missingInvoice = arr.filter(r => !r.invoice_number).length;
    if (missingInvoice === 0) { ok++; checks.push({ cls:'ok', msg:'Tous les actes ont un numéro de facture' }); }
    else { err++; checks.push({ cls:'er', msg:`${missingInvoice} acte(s) sans numéro de facture` }); }

    // 2. Pas d'actes à 0 €
    const zeroCot = arr.filter(r => parseFloat(r.total||0) <= 0).length;
    if (zeroCot === 0) { ok++; checks.push({ cls:'ok', msg:'Aucun acte à montant nul' }); }
    else { warn++; checks.push({ cls:'wa', msg:`${zeroCot} acte(s) à 0 € — vérifiez` }); }

    // 3. DRE documentées
    const dreRows = arr.filter(r => r.dre_requise);
    if (dreRows.length > 0) { warn++; checks.push({ cls:'wa', msg:`${dreRows.length} DRE requises à transmettre à la CPAM` }); }
    else { ok++; checks.push({ cls:'ok', msg:'Aucune DRE en attente' }); }

    // 4. Alertes NGAP
    const withAlerts = arr.filter(r => { try { return JSON.parse(r.alerts||'[]').length>0; } catch { return false; } }).length;
    if (withAlerts === 0) { ok++; checks.push({ cls:'ok', msg:'Aucune alerte de conformité NGAP' }); }
    else { err++; checks.push({ cls:'er', msg:`${withAlerts} cotation(s) avec alertes NGAP — à corriger` }); }

    // 5. Version NGAP à jour
    const oldVersion = arr.filter(r => r.ngap_version && r.ngap_version !== '2026.1').length;
    if (oldVersion === 0) { ok++; checks.push({ cls:'ok', msg:'Cotations à la version NGAP 2026.1' }); }
    else { warn++; checks.push({ cls:'wa', msg:`${oldVersion} cotation(s) avec version NGAP ancienne` }); }

    // 6. Profil infirmière complet
    const u = S?.user || {};
    if (u.adeli && u.rpps && u.structure) { ok++; checks.push({ cls:'ok', msg:'Profil complet — ADELI + RPPS + Cabinet' }); }
    else {
      const missing = [!u.adeli&&'ADELI', !u.rpps&&'RPPS', !u.structure&&'Cabinet'].filter(Boolean).join(', ');
      err++; checks.push({ cls:'er', msg:`Profil incomplet — manque : ${missing}` });
    }

    const total = ok + warn + err;
    const score = Math.round(ok / (total||1) * 100);
    const scoreColor = score >= 80 ? 'var(--ok)' : score >= 60 ? 'var(--w)' : 'var(--d)';
    const circumf = 2 * Math.PI * 26;
    const dashOffset = circumf * (1 - score / 100);

    el.innerHTML = `
      <div class="cpam-check-wrap">
        <div class="cpam-check-header">
          <div class="cpam-ring-wrap">
            <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--b)" stroke-width="6"/>
              <circle cx="32" cy="32" r="26" fill="none" stroke="${scoreColor}" stroke-width="6"
                stroke-dasharray="${circumf.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"
                stroke-linecap="round" style="transition:stroke-dashoffset .6s ease"/>
            </svg>
            <div class="cpam-ring-label">
              <div class="cpam-ring-pct" style="color:${scoreColor}">${score}%</div>
              <div class="cpam-ring-sub">CPAM</div>
            </div>
          </div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px">Conformité CPAM — ce mois</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <span class="dash-section-badge" style="font-size:10px">✅ ${ok} OK</span>
              ${warn > 0 ? `<span class="dash-section-badge o" style="font-size:10px">⚠ ${warn} avertissement${warn>1?'s':''}</span>` : ''}
              ${err  > 0 ? `<span class="dash-section-badge r" style="font-size:10px">❌ ${err} erreur${err>1?'s':''}</span>` : ''}
            </div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px">
          ${checks.map(c => `
            <div class="cpam-check-item ${c.cls}">
              <div class="cpam-check-dot"></div>
              <div>${c.msg}</div>
            </div>`).join('')}
        </div>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="ai er">⚠️ ${e.message}</div>`;
  }
}

/* Sauvegarder les préférences véhicule depuis la trésorerie */
function saveKmPrefsTresor() {
  const cv         = parseInt(document.getElementById('tresor-km-cv')?.value) || 5;
  const electrique = !!document.getElementById('tresor-km-elec')?.checked;
  _saveKmPrefs({ cv, electrique });
  // Synchroniser avec le Journal kilométrique s'il est ouvert
  const kmCvEl   = document.getElementById('km-cv');
  const kmElecEl = document.getElementById('km-electrique');
  if (kmCvEl)   kmCvEl.value = cv;
  if (kmElecEl) kmElecEl.checked = electrique;
  // Recharger la trésorerie avec les nouveaux paramètres
  loadTresorerie();
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('app:nav', e => {
    if (e.detail?.view === 'tresor') {
      loadTresorerie();
    }
  });
  // Écouter ui:navigate aussi
  document.addEventListener('ui:navigate', e => {
    if (e.detail?.view === 'tresor') {
      // Synchroniser les sélecteurs CV/électrique depuis les préférences
      const prefs = _loadKmPrefs();
      const cvEl   = document.getElementById('tresor-km-cv');
      const elecEl = document.getElementById('tresor-km-elec');
      if (cvEl   && prefs.cv)         cvEl.value   = prefs.cv;
      if (elecEl && prefs.electrique) elecEl.checked = true;
      loadTresorerie();
    }
  });
});
