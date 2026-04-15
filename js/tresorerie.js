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

const TRESOR_PAID_KEY = 'ami_tresor_paid';
const KM_FISCAL_RATE_TRESOR = 0.636; // barème 5 CV 2025/2026

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
    // Clé isolée par userId — même logique que _kmKey() dans infirmiere-tools.js
    let _kmUid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    if (!_kmUid) { try { _kmUid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {} }
    const _kmStoreKey = 'ami_km_journal_' + String(_kmUid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const entries = JSON.parse(localStorage.getItem(_kmStoreKey) || '[]');
    const now = new Date();

    // Calculer la date de début selon la période
    let since = new Date();
    if      (period === 'today')    { since.setHours(0,0,0,0); }
    else if (period === 'week')     { since.setDate(now.getDate() - 7); }
    else if (period === 'lastmonth'){
      since = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const until = new Date(now.getFullYear(), now.getMonth(), 0);
      const filtered = entries.filter(e => {
        const d = new Date(e.date); return d >= since && d <= until;
      });
      const totalKm   = filtered.reduce((s, e) => s + parseFloat(e.km || 0), 0);
      const deduction = totalKm * KM_FISCAL_RATE_TRESOR;
      return { totalKm: Math.round(totalKm * 10) / 10, deduction: Math.round(deduction * 100) / 100, count: filtered.length, label: 'Mois précédent' };
    }
    else if (period === '3month')   { since.setMonth(now.getMonth() - 3); }
    else if (period === 'year')     { since = new Date(now.getFullYear(), 0, 1); }
    else /* month */                { since = new Date(now.getFullYear(), now.getMonth(), 1); }

    const filtered  = entries.filter(e => new Date(e.date) >= since);
    const totalKm   = filtered.reduce((s, e) => s + parseFloat(e.km || 0), 0);
    const deduction = totalKm * KM_FISCAL_RATE_TRESOR;

    const labels = { month:'Ce mois', lastmonth:'Mois précédent', '3month':'3 derniers mois', year:'Cette année', today:'Aujourd\'hui', week:'Cette semaine' };
    return {
      totalKm:   Math.round(totalKm * 10) / 10,
      deduction: Math.round(deduction * 100) / 100,
      count:     filtered.length,
      label:     labels[period] || 'Ce mois',
    };
  } catch { return { totalKm: 0, deduction: 0, count: 0, label: '' }; }
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

  // Bloc kilométrique — affiché même si aucune cotation
  const kmBlock = km && km.totalKm > 0 ? `
    <div style="background:rgba(79,168,255,.05);border:1px solid rgba(79,168,255,.2);border-radius:12px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-size:22px">🚗</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--t)">Journal kilométrique — <span style="color:var(--a2)">${km.label}</span></div>
        <div style="font-size:12px;color:var(--m);margin-top:2px">${km.count} trajet(s) · barème ${KM_FISCAL_RATE_TRESOR} €/km (5 CV 2025/2026)</div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div style="text-align:center">
          <div style="font-size:18px;font-weight:700;color:var(--a2);font-family:var(--fm)">${km.totalKm.toFixed(1)} km</div>
          <div style="font-size:10px;color:var(--m)">parcourus</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:18px;font-weight:700;color:#22c55e;font-family:var(--fm)">${km.deduction.toFixed(2)} €</div>
          <div style="font-size:10px;color:var(--m)">déduction fiscale</div>
        </div>
      </div>
    </div>` : (km?.count === 0 ? `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:10px">
      <span style="font-size:18px">🚗</span>
      <span style="font-size:12px;color:var(--m)">Aucun trajet dans le Journal kilométrique sur cette période. <a href="#" onclick="if(typeof navTo==='function')navTo('outils-km',null)" style="color:var(--a);text-decoration:none">→ Ajouter des trajets</a></span>
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

    const date = r.date_soin ? new Date(r.date_soin).toLocaleDateString('fr-FR') : '—';
    let actesCodes = '—';
    try { actesCodes = JSON.parse(r.actes||'[]').map(a=>a.code||'').filter(Boolean).join(', ') || '—'; } catch {}

    return `<tr style="${!amoPaid||!amcPaid ? 'background:rgba(255,181,71,.03)' : ''}">
      <td style="font-family:var(--fm);font-size:11px;color:var(--m)">#${id}</td>
      <td style="font-size:13px">${date}</td>
      <td style="font-family:var(--fm);font-size:11px">${actesCodes}</td>
      <td style="font-weight:600;font-family:var(--fm);color:var(--a)">${total.toFixed(2)} €</td>
      <td style="text-align:center">
        <button onclick="markPaid('${id}','amo')" class="btn bsm ${amoPaid?'bp':'bd'}" style="font-size:10px;padding:3px 8px">
          ${amoPaid ? '✅ '+amo.toFixed(2)+'€' : '⏳ '+amo.toFixed(2)+'€'}
        </button>
      </td>
      <td style="text-align:center">
        ${amc > 0
          ? `<button onclick="markPaid('${id}','amc')" class="btn bsm ${amcPaid?'bp':'bd'}" style="font-size:10px;padding:3px 8px">
              ${amcPaid ? '✅ '+amc.toFixed(2)+'€' : '⏳ '+amc.toFixed(2)+'€'}
             </button>`
          : '<span style="color:var(--m);font-size:11px">—</span>'}
      </td>
      <td style="font-family:var(--fm);font-size:11px;color:var(--m)">${pat.toFixed(2)} €</td>
      <td style="font-size:11px;text-align:center">${r.dre_requise ? '<span style="color:var(--a2)">DRE</span>' : ''}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    ${kmBlock}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">
      <div class="sc g"><div class="si">💶</div><div class="sv">${totalTTC.toFixed(0)}€</div><div class="sn">Total facturé</div></div>
      <div class="sc b"><div class="si">✅</div><div class="sv">${amoRecu.toFixed(0)}€</div><div class="sn">AMO reçu</div></div>
      <div class="sc o"><div class="si">⏳</div><div class="sv">${amoAttente.toFixed(0)}€</div><div class="sn">AMO en attente</div></div>
      <div class="sc b"><div class="si">✅</div><div class="sv">${amcRecu.toFixed(0)}€</div><div class="sn">AMC reçu</div></div>
      <div class="sc o"><div class="si">⏳</div><div class="sv">${amcAttente.toFixed(0)}€</div><div class="sn">AMC en attente</div></div>
      <div class="sc r"><div class="si">💳</div><div class="sv">${totalPat.toFixed(0)}€</div><div class="sn">Part patients</div></div>
      ${km?.deduction > 0 ? `<div class="sc b"><div class="si">🚗</div><div class="sv">${km.deduction.toFixed(0)}€</div><div class="sn">Déd. km</div></div>` : ''}
    </div>
    <div id="tresor-checklist-bar" style="margin-bottom:16px"></div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--s)">
          <th style="padding:8px;text-align:left;font-family:var(--fm);font-size:10px;color:var(--m)">ID</th>
          <th style="padding:8px;text-align:left;font-family:var(--fm);font-size:10px;color:var(--m)">Date</th>
          <th style="padding:8px;text-align:left;font-family:var(--fm);font-size:10px;color:var(--m)">Actes</th>
          <th style="padding:8px;text-align:left;font-family:var(--fm);font-size:10px;color:var(--m)">Total</th>
          <th style="padding:8px;text-align:center;font-family:var(--fm);font-size:10px;color:var(--a)">AMO SS</th>
          <th style="padding:8px;text-align:center;font-family:var(--fm);font-size:10px;color:var(--a2)">AMC Mutuelle</th>
          <th style="padding:8px;text-align:left;font-family:var(--fm);font-size:10px;color:var(--m)">Patient</th>
          <th style="padding:8px;text-align:center;font-family:var(--fm);font-size:10px;color:var(--m)">DRE</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Afficher checklist si paiements en attente
  if (amoAttente > 1 || amcAttente > 1) {
    const bar = $('tresor-checklist-bar');
    if (bar) bar.innerHTML = `<div class="ai wa">💡 <strong>${amoAttente.toFixed(2)} €</strong> en attente AMO · <strong>${amcAttente.toFixed(2)} €</strong> en attente AMC — marquez comme reçu au fur et à mesure.</div>`;
  }
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
        `Déduction ${km.deduction.toFixed(2)} € (${KM_FISCAL_RATE_TRESOR} €/km)`,
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
    if (missingInvoice === 0) { ok++; checks.push({ ok:true,  msg:'✅ Tous les actes ont un numéro de facture' }); }
    else { err++; checks.push({ ok:false, msg:`❌ ${missingInvoice} acte(s) sans numéro de facture` }); }

    // 2. Pas d'actes à 0 €
    const zeroCot = arr.filter(r => parseFloat(r.total||0) <= 0).length;
    if (zeroCot === 0) { ok++; checks.push({ ok:true, msg:'✅ Aucun acte à montant nul' }); }
    else { warn++; checks.push({ ok:'warn', msg:`⚠️ ${zeroCot} acte(s) à 0 € — vérifiez` }); }

    // 3. DRE documentées
    const dreRows = arr.filter(r => r.dre_requise);
    if (dreRows.length > 0) { warn++; checks.push({ ok:'warn', msg:`⚠️ ${dreRows.length} DRE requises à transmettre à la CPAM` }); }
    else { ok++; checks.push({ ok:true, msg:'✅ Aucune DRE en attente' }); }

    // 4. Alertes NGAP
    const withAlerts = arr.filter(r => { try { return JSON.parse(r.alerts||'[]').length>0; } catch { return false; } }).length;
    if (withAlerts === 0) { ok++; checks.push({ ok:true, msg:'✅ Aucune alerte de conformité NGAP' }); }
    else { err++; checks.push({ ok:false, msg:`❌ ${withAlerts} cotation(s) avec alertes NGAP — à corriger avant envoi` }); }

    // 5. Version NGAP à jour
    const oldVersion = arr.filter(r => r.ngap_version && r.ngap_version !== '2026.1').length;
    if (oldVersion === 0) { ok++; checks.push({ ok:true, msg:'✅ Toutes les cotations sont à la version NGAP 2026.1' }); }
    else { warn++; checks.push({ ok:'warn', msg:`⚠️ ${oldVersion} cotation(s) avec une version NGAP ancienne` }); }

    // 6. Profil infirmière complet
    const u = S?.user || {};
    if (u.adeli && u.rpps && u.structure) { ok++; checks.push({ ok:true, msg:'✅ Profil professionnel complet (ADELI + RPPS + Cabinet)' }); }
    else {
      const missing = [!u.adeli&&'ADELI', !u.rpps&&'RPPS', !u.structure&&'Cabinet'].filter(Boolean).join(', ');
      err++; checks.push({ ok:false, msg:`❌ Profil incomplet — manque : ${missing}` });
    }

    const score = Math.round(ok / (ok+warn+err) * 100);
    const scoreColor = score >= 80 ? 'var(--a)' : score >= 60 ? 'var(--w)' : 'var(--d)';

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap">
        <div style="text-align:center">
          <div style="font-family:var(--fs);font-size:44px;color:${scoreColor}">${score}%</div>
          <div style="font-size:12px;color:var(--m);font-family:var(--fm)">Conformité CPAM</div>
        </div>
        <div style="flex:1">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <span class="ai su" style="font-size:11px">✅ ${ok} OK</span>
            <span class="ai wa" style="font-size:11px">⚠️ ${warn} avertissements</span>
            <span class="ai er" style="font-size:11px">❌ ${err} erreurs</span>
          </div>
          <div style="height:6px;background:var(--b);border-radius:3px;margin-top:10px;overflow:hidden">
            <div style="height:100%;width:${score}%;background:${scoreColor};border-radius:3px;transition:width .4s"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${checks.map(c => `<div class="ai ${c.ok===true?'su':c.ok==='warn'?'wa':'er'}" style="font-size:13px">${c.msg}</div>`).join('')}
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="ai er">⚠️ ${e.message}</div>`;
  }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('app:nav', e => {
    if (e.detail?.view === 'tresor') {
      loadTresorerie();
    }
  });
});
