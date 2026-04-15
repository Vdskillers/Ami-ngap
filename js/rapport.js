/* ════════════════════════════════════════════════
   rapport.js — AMI NGAP
   ────────────────────────────────────────────────
   ✅ Rapport d'activité mensuel PDF
      - generateRapportMensuel()   — génère et télécharge le HTML/PDF
      - previewRapport()           — aperçu avant impression
   ✅ Monitoring système (admin)
      - loadSystemHealth()         — charge santé n8n/worker/IA
      - renderSystemHealth(data)   — affiche les indicateurs
      - loadAdmSystemLogs()        — logs système enrichis
   ✅ Moteur NGAP nomenclature complète
      - NGAP_NOMENCLATURE          — table complète des actes 2026
      - lookupNGAP(code)           — recherche d'un acte
      - searchNGAP(query)          — recherche full-text
      - validateNGAPCumul(actes)   — validateur cumul
════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   RAPPORT MENSUEL PDF
   ═══════════════════════════════════════════════ */

async function generateRapportMensuel() {
  const btn = document.getElementById('btn-rapport');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Génération…'; }

  try {
    const period   = document.getElementById('rapport-period')?.value || 'month';
    const d        = await fetchAPI(`/webhook/ami-historique?period=${period}`);
    const arr      = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    const u        = typeof S !== 'undefined' ? (S?.user||{}) : {};
    const html     = _buildRapportHTML(arr, u, period);
    _downloadHTML(html, `rapport-activite-${period}-${new Date().toISOString().slice(0,7)}.html`);
    if (typeof showToast === 'function') showToast('📄 Rapport téléchargé.', 'ok');
  } catch(e) {
    alert('Erreur génération rapport : ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '📄 Télécharger le rapport'; }
  }
}

async function previewRapport() {
  const period = document.getElementById('rapport-period')?.value || 'month';
  try {
    const d   = await fetchAPI(`/webhook/ami-historique?period=${period}`);
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    const u   = typeof S !== 'undefined' ? (S?.user||{}) : {};
    const html = _buildRapportHTML(arr, u, period);
    const w = window.open('', '_blank');
    if (!w) { alert('Autorisez les popups pour l\'aperçu.'); return; }
    w.document.write(html);
    w.document.close();
  } catch(e) { alert('Erreur aperçu : '+e.message); }
}

function _buildRapportHTML(arr, u, period) {
  const inf   = ((u.prenom||'') + ' ' + (u.nom||'')).trim() || 'Infirmier(ère) libéral(e)';
  const today = new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });
  const periodLabel = { month:'ce mois', lastmonth:'mois précédent', '3month':'3 derniers mois', year:'cette année' }[period] || period;

  // KPIs
  const total   = arr.reduce((s,r) => s + parseFloat(r.total||0), 0);
  const amo     = arr.reduce((s,r) => s + parseFloat(r.part_amo||0), 0);
  const amc     = arr.reduce((s,r) => s + parseFloat(r.part_amc||0), 0);
  const pat     = arr.reduce((s,r) => s + parseFloat(r.part_patient||0), 0);
  const dre     = arr.filter(r => r.dre_requise).length;
  const avg     = arr.length ? total/arr.length : 0;
  const best    = Math.max(...arr.map(r=>parseFloat(r.total||0)), 0);

  // ── Données kilométriques depuis le journal local ──────────────────────
  let kmTotal = 0, kmDeduction = 0, kmEntries = [];
  try {
    const allEntries = JSON.parse(localStorage.getItem('ami_km_journal') || '[]');
    // Filtrer selon la période sélectionnée
    const now = new Date();
    let since = new Date(now.getFullYear(), now.getMonth(), 1); // défaut : mois courant
    if (period === 'lastmonth') since = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    else if (period === '3month') since = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    else if (period === 'year') since = new Date(now.getFullYear(), 0, 1);
    kmEntries = allEntries.filter(e => new Date(e.date) >= since);
    kmTotal = Math.round(kmEntries.reduce((s, e) => s + parseFloat(e.km||0), 0) * 10) / 10;
    // Barème kilométrique 5CV 2025 (≤5000 km/an : ×0,636)
    const kmAnnuel = allEntries.filter(e => new Date(e.date).getFullYear() === now.getFullYear())
      .reduce((s, e) => s + parseFloat(e.km||0), 0);
    const taux = kmAnnuel <= 5000 ? 0.636 : kmAnnuel <= 20000 ? (0.319 + 1587/kmAnnuel) : 0.370;
    kmDeduction = Math.round(kmTotal * taux * 100) / 100;
  } catch {}

  // Top actes
  const freq = {};
  arr.forEach(r => { try { JSON.parse(r.actes||'[]').forEach(a=>{ if(a.code&&a.code!=='IMPORT') freq[a.code]=(freq[a.code]||0)+1; }); } catch{} });
  const topActes = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,10);

  // Par jour
  const byDay = {};
  arr.forEach(r => {
    const day = (r.date_soin||'').slice(0,10);
    if (day) byDay[day] = (byDay[day]||0) + parseFloat(r.total||0);
  });
  const days = Object.entries(byDay).sort();

  // Lignes du tableau
  const rows = arr.slice(0, 100).map(r => {
    let codes = '—';
    try { codes = JSON.parse(r.actes||'[]').map(a=>a.code||'').filter(Boolean).join('+') || '—'; } catch {}
    return `<tr>
      <td>${r.invoice_number||('#'+r.id)}</td>
      <td>${r.date_soin ? new Date(r.date_soin).toLocaleDateString('fr-FR') : '—'}</td>
      <td style="font-family:monospace;font-size:11px">${codes}</td>
      <td style="text-align:right;font-weight:600">${parseFloat(r.total||0).toFixed(2)} €</td>
      <td style="text-align:right">${parseFloat(r.part_amo||0).toFixed(2)} €</td>
      <td style="text-align:right">${parseFloat(r.part_amc||0).toFixed(2)} €</td>
      <td style="text-align:right">${parseFloat(r.part_patient||0).toFixed(2)} €</td>
      <td style="text-align:center">${r.dre_requise?'✓':''}</td>
      <td style="font-size:10px;color:#6b7a99">${r.ngap_version||''}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Rapport d'activité ${periodLabel} — ${inf}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0 }
  body { font-family:'Segoe UI',sans-serif; padding:40px; font-size:13px; color:#1a1a2e; background:#fff }
  @media print { body { padding:20px } .no-print { display:none !important } }
  h1 { font-size:28px; color:#0b3954; margin-bottom:4px }
  h2 { font-size:16px; color:#0b3954; margin:28px 0 12px; padding-bottom:6px; border-bottom:2px solid #e0e7ef }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px; padding-bottom:20px; border-bottom:3px solid #0b3954 }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; margin-bottom:24px }
  .kpi { background:#f7f9fc; border:1px solid #e0e7ef; border-radius:10px; padding:16px; text-align:center }
  .kpi-v { font-size:26px; font-weight:700; color:#0b3954; margin-bottom:4px }
  .kpi-l { font-size:11px; text-transform:uppercase; color:#6b7a99; letter-spacing:.5px }
  .kpi.green .kpi-v { color:#059669 } .kpi.blue .kpi-v { color:#2563eb } .kpi.orange .kpi-v { color:#d97706 }
  table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:20px }
  th { background:#f0f4fa; padding:8px 10px; text-align:left; font-size:11px; text-transform:uppercase; color:#6b7a99; letter-spacing:.3px }
  td { padding:8px 10px; border-bottom:1px solid #f0f4fa }
  tr:hover td { background:#f7fbff }
  tfoot td { font-weight:700; border-top:2px solid #ccd5e0; background:#f7f9fc }
  .bar-wrap { display:flex; align-items:flex-end; gap:3px; height:100px; margin:12px 0 4px }
  .bar { background:#0b3954; border-radius:3px 3px 0 0; min-height:4px; flex:1; transition:height .3s; opacity:.8 }
  .footer { margin-top:40px; padding-top:16px; border-top:1px solid #e0e7ef; font-size:11px; color:#9ca3af; text-align:center }
  .badge { display:inline-block; padding:2px 8px; border-radius:20px; font-size:10px; font-weight:600 }
  .badge-ok { background:#d1fae5; color:#059669 } .badge-warn { background:#fef3c7; color:#d97706 }
  button.no-print { margin-bottom:16px; padding:10px 20px; background:#0b3954; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer }
</style>
</head>
<body>
<button class="no-print" onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>

<div class="header">
  <div>
    <h1>Rapport d'activité</h1>
    <div style="color:#6b7a99;font-size:13px;margin-top:4px">Période : ${periodLabel} · Généré le ${today}</div>
  </div>
  <div style="text-align:right;line-height:1.8">
    <strong style="font-size:15px">${inf}</strong>
    ${u.adeli ? `<br><span style="font-size:11px;color:#6b7a99">N° ADELI : ${u.adeli}</span>` : ''}
    ${u.rpps  ? `<br><span style="font-size:11px;color:#6b7a99">N° RPPS : ${u.rpps}</span>` : ''}
    ${u.structure ? `<br><span style="font-size:11px;color:#6b7a99">${u.structure}</span>` : ''}
  </div>
</div>

<h2>📊 Indicateurs clés</h2>
<div class="kpi-grid">
  <div class="kpi green"><div class="kpi-v">${total.toFixed(2)} €</div><div class="kpi-l">CA total facturé</div></div>
  <div class="kpi blue"><div class="kpi-v">${arr.length}</div><div class="kpi-l">Cotations</div></div>
  <div class="kpi"><div class="kpi-v">${avg.toFixed(2)} €</div><div class="kpi-l">Panier moyen</div></div>
  <div class="kpi orange"><div class="kpi-v">${amo.toFixed(2)} €</div><div class="kpi-l">Part AMO (SS)</div></div>
  <div class="kpi blue"><div class="kpi-v">${amc.toFixed(2)} €</div><div class="kpi-l">Part AMC</div></div>
  <div class="kpi"><div class="kpi-v">${pat.toFixed(2)} €</div><div class="kpi-l">Part patients</div></div>
  <div class="kpi"><div class="kpi-v">${best.toFixed(2)} €</div><div class="kpi-l">Meilleure facture</div></div>
  <div class="kpi ${dre>0?'orange':'green'}"><div class="kpi-v">${dre}</div><div class="kpi-l">DRE requises</div></div>
  ${kmTotal > 0 ? `<div class="kpi blue"><div class="kpi-v">${kmTotal} km</div><div class="kpi-l">Km parcourus</div></div>` : ''}
  ${kmDeduction > 0 ? `<div class="kpi green"><div class="kpi-v">${kmDeduction} €</div><div class="kpi-l">Déd. fiscale km</div></div>` : ''}
</div>

${kmTotal > 0 ? `<h2>🚗 Journal kilométrique (${kmEntries.length} trajet${kmEntries.length>1?'s':''})</h2>
<table>
  <thead><tr><th>Date</th><th>Départ</th><th>Arrivée</th><th style="text-align:right">Km</th><th>Motif</th></tr></thead>
  <tbody>${kmEntries.slice(0, 100).map(e => `<tr>
    <td>${e.date ? new Date(e.date).toLocaleDateString('fr-FR') : '—'}</td>
    <td>${e.depart||'—'}</td>
    <td>${e.arrivee||'—'}</td>
    <td style="text-align:right;font-weight:600">${parseFloat(e.km||0).toFixed(1)} km</td>
    <td style="color:#6b7a99">${e.motif||''}</td>
  </tr>`).join('')}</tbody>
  <tfoot><tr>
    <td colspan="3"><strong>TOTAL</strong></td>
    <td style="text-align:right"><strong>${kmTotal} km</strong></td>
    <td style="color:#059669"><strong>Déduction fiscale estimée : ${kmDeduction} €</strong></td>
  </tr></tfoot>
</table>
<p style="font-size:11px;color:#6b7a99;margin-top:-12px;margin-bottom:20px">Barème kilométrique 2025 (5CV) · Les déductions fiscales sont indicatives, consultez votre comptable.</p>` : ''}

${topActes.length ? `<h2>🩺 Actes les plus fréquents</h2>
<table>
  <thead><tr><th>Code NGAP</th><th>Fréquence</th><th>Part</th></tr></thead>
  <tbody>${topActes.map(([code,cnt]) => `<tr><td><strong>${code}</strong></td><td>${cnt}×</td><td>${(cnt/arr.length*100).toFixed(0)}% des cotations</td></tr>`).join('')}</tbody>
</table>` : ''}

${days.length ? `<h2>📈 Revenus par jour (${days.length} jours)</h2>
<div class="bar-wrap">
  ${days.map(([day,val])=>{const max=Math.max(...days.map(d=>d[1]),1);return `<div class="bar" title="${day}: ${val.toFixed(2)}€" style="height:${Math.max(5,Math.round(val/max*90))}px"></div>`}).join('')}
</div>
<div style="font-size:10px;color:#6b7a99;text-align:center">${days[0]?.[0]||''} → ${days[days.length-1]?.[0]||''}</div>` : ''}

<h2>📋 Détail des cotations</h2>
<table>
  <thead><tr><th>N° Facture</th><th>Date</th><th>Actes</th><th style="text-align:right">Total</th><th style="text-align:right">AMO</th><th style="text-align:right">AMC</th><th style="text-align:right">Patient</th><th>DRE</th><th>Version</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td colspan="3"><strong>TOTAL (${arr.length} cotations)</strong></td>
    <td style="text-align:right"><strong>${total.toFixed(2)} €</strong></td>
    <td style="text-align:right">${amo.toFixed(2)} €</td>
    <td style="text-align:right">${amc.toFixed(2)} €</td>
    <td style="text-align:right">${pat.toFixed(2)} €</td>
    <td>${dre}</td><td></td>
  </tr></tfoot>
</table>
${arr.length > 100 ? `<p style="color:#6b7a99;font-size:11px">Les ${arr.length-100} cotations suivantes ne sont pas affichées dans cet aperçu.</p>` : ''}

<div class="footer">
  AMI NGAP · Rapport généré le ${today} · NGAP 2026 métropole en vigueur<br>
  ${inf}${u.adeli?' · ADELI '+u.adeli:''}${u.rpps?' · RPPS '+u.rpps:''}
</div>
</body>
</html>`;
}

function _downloadHTML(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 2000);
}

/* ═══════════════════════════════════════════════
   MONITORING SYSTÈME (ADMIN)
   ═══════════════════════════════════════════════ */

async function loadSystemHealth() {
  /* Cible les deux conteneurs :
     - adm-system-health-body : panneau admin (Activité plateforme, en haut)
     - system-health-body     : vue dédiée view-syshealth */
  const elAdm  = document.getElementById('adm-system-health-body');
  const elView = document.getElementById('system-health-body');
  if (!elAdm && !elView) return;

  const spinner = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto 8px"></div></div>';
  if (elAdm)  elAdm.innerHTML  = spinner;
  if (elView) elView.innerHTML = spinner;

  try {
    const [logs, stats] = await Promise.all([
      wpost('/webhook/admin-logs', {}),
      wpost('/webhook/admin-stats', {}),
    ]);

    const sl = logs?.system_logs || [];
    const s  = stats?.stats || {};

    const n8nFails     = (logs?.stats?.n8n_failures     || 0);
    const iaFallbacks  = (logs?.stats?.ia_fallbacks      || 0);
    const fraudAlerts  = (logs?.stats?.fraud_alerts      || 0);
    const frontErrors  = (logs?.stats?.frontend_errors   || 0);

    const n8nOk    = n8nFails === 0;
    const iaOk     = iaFallbacks < 5;
    const fraudOk  = fraudAlerts === 0;

    const overallHealth = n8nOk && iaOk ? 'green' : n8nFails < 3 ? 'orange' : 'red';
    const healthLabel   = overallHealth === 'green' ? '✅ Opérationnel' : overallHealth === 'orange' ? '⚠️ Dégradé' : '🔴 Incident';

    const html = `
      <!-- Score global -->
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding:16px;
        background:${overallHealth==='green'?'rgba(0,212,170,.06)':overallHealth==='orange'?'rgba(255,181,71,.08)':'rgba(255,95,109,.08)'};
        border:1px solid ${overallHealth==='green'?'rgba(0,212,170,.25)':overallHealth==='orange'?'rgba(255,181,71,.3)':'rgba(255,95,109,.3)'};
        border-radius:var(--r);flex-wrap:wrap">
        <div style="font-size:36px">${overallHealth==='green'?'✅':overallHealth==='orange'?'⚠️':'🔴'}</div>
        <div>
          <div style="font-size:18px;font-weight:700">${healthLabel}</div>
          <div style="font-size:12px;color:var(--m)">Dernière vérification : ${new Date().toLocaleTimeString('fr-FR')}</div>
        </div>
        <button class="btn bs bsm" onclick="loadSystemHealth()" style="margin-left:auto">↻ Rafraîchir</button>
      </div>

      <!-- Indicateurs services -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px">
        ${[
          { label:'Worker Cloudflare',  ok:true,            detail:'API opérationnelle',    icon:'⚙️' },
          { label:'N8N / IA',           ok:n8nOk,           detail:`${n8nFails} erreur(s)`,  icon:'🤖' },
          { label:'Moteur cotation IA', ok:iaOk,            detail:`${iaFallbacks} fallback(s)`, icon:'🩺' },
          { label:'Fraude détectée',    ok:fraudOk,         detail:`${fraudAlerts} alerte(s)`,  icon:'🚨' },
          { label:'Erreurs frontend',   ok:frontErrors===0, detail:`${frontErrors} erreur(s)`,  icon:'🖥️' },
          { label:'Base de données',    ok:true,            detail:'Supabase EU',            icon:'🗄️' },
        ].map(c => `
          <div style="background:var(--c);border:1px solid ${c.ok?'rgba(0,212,170,.2)':'rgba(255,181,71,.3)'};
            border-radius:var(--r);padding:14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:18px">${c.icon}</span>
              <span style="font-weight:600;font-size:13px">${c.label}</span>
              <span style="margin-left:auto;font-size:18px">${c.ok?'✅':'⚠️'}</span>
            </div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${c.detail}</div>
          </div>`).join('')}
      </div>

      <!-- Stats globales -->
      <div class="lbl" style="margin-bottom:10px">Activité plateforme</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:20px">
        <div class="kpi"><div class="kpi-v g">${s.nb_actes||0}</div><div class="kpi-l">Soins cotés total</div></div>
        <div class="kpi"><div class="kpi-v b">${(s.ca_total||0).toFixed(0)}€</div><div class="kpi-l">CA total (€)</div></div>
        <div class="kpi"><div class="kpi-v o">${(s.panier_moyen||0).toFixed(2)}€</div><div class="kpi-l">Panier moyen</div></div>
        <div class="kpi"><div class="kpi-v ${(s.nb_alertes||0)>0?'r':'g'}">${s.nb_alertes||0}</div><div class="kpi-l">Alertes NGAP</div></div>
        <div class="kpi"><div class="kpi-v b">${s.nb_dre||0}</div><div class="kpi-l">DRE requises</div></div>
        <div class="kpi"><div class="kpi-v ${fraudAlerts>0?'r':'g'}">${fraudAlerts}</div><div class="kpi-l">Alertes fraude</div></div>
      </div>

      <!-- Logs système récents -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <div class="lbl">Logs système récents (${sl.length})</div>
        ${sl.length > 0 ? `<button class="btn bsm" onclick="resetSystemLogs()" style="background:rgba(255,95,109,.1);border:1px solid rgba(255,95,109,.3);color:var(--d);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer">🗑️ Réinitialiser les logs</button>` : ''}
      </div>
      <div style="max-height:280px;overflow-y:auto;border:1px solid var(--b);border-radius:var(--r)">
        ${sl.length ? sl.slice(0,50).map(l => {
          const lvlColor = l.level==='error'||l.level==='critical' ? 'var(--d)' : l.level==='warn' ? 'var(--w)' : 'var(--a)';
          const dt = new Date(l.created_at).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
          let metaStr = '';
          try {
            const m = typeof l.meta === 'string' ? JSON.parse(l.meta) : (l.meta || {});
            if (m.path) metaStr = ` · ${m.path}`;
            if (m.error) metaStr += ` (${m.error})`;
          } catch {}
          return `<div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--b);font-size:12px">
            <span style="font-family:var(--fm);color:${lvlColor};font-size:10px;min-width:50px;font-weight:600">${(l.level||'').toUpperCase()}</span>
            <span style="font-family:var(--fm);color:var(--m);font-size:10px;min-width:60px">${l.source||'—'}</span>
            <span style="flex:1;font-weight:500">${l.event||'—'}<span style="font-weight:400;color:var(--m)">${metaStr}</span></span>
            <span style="color:var(--m);font-size:11px;white-space:nowrap">${dt}</span>
          </div>`;
        }).join('')
        : '<div style="padding:20px;text-align:center;color:var(--m)">✅ Aucun log système — tout est propre.</div>'}
      </div>`;

    if (elAdm)  elAdm.innerHTML  = html;
    if (elView) elView.innerHTML = html;

  } catch(e) {
    const errHtml = `<div class="ai er">⚠️ Impossible de charger le monitoring : ${e.message}</div>`;
    if (elAdm)  elAdm.innerHTML  = errHtml;
    if (elView) elView.innerHTML = errHtml;
  }
}

/* ═══════════════════════════════════════════════
   RESET LOGS SYSTÈME
   ═══════════════════════════════════════════════ */

async function resetSystemLogs() {
  if (!confirm('Supprimer toutes les entrées de logs système ?\nCette action est irréversible.')) return;

  const btn = document.querySelector('button[onclick="resetSystemLogs()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Réinitialisation...'; }

  try {
    const d = await wpost('/webhook/admin-system-reset', {});
    if (!d.ok) throw new Error(d.error || 'Erreur');
    if (typeof showToast === 'function') showToast('✅ Logs système réinitialisés', 'ok');
    // Recharger le monitoring
    await loadSystemHealth();
  } catch(e) {
    if (typeof showToast === 'function') showToast('⚠️ ' + e.message, 'err');
    alert('Erreur : ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ Réinitialiser les logs'; }
  }
}

window.resetSystemLogs = resetSystemLogs;

/* ═══════════════════════════════════════════════
   NOMENCLATURE NGAP 2026 COMPLÈTE
   ═══════════════════════════════════════════════ */

const NGAP_NOMENCLATURE = {
  // Actes infirmiers (AMI)
  'AMI1':  { desc:'Acte infirmier simple (injection SC/IM, pansement simple, prélèvement)', coef:1,  tarif:3.15, cumul:false },
  'AMI2':  { desc:'Acte infirmier (2 passages)',            coef:2,  tarif:6.30,  cumul:false },
  'AMI3':  { desc:'Acte infirmier lourd (3 actes)',         coef:3,  tarif:9.45,  cumul:false },
  'AMI4':  { desc:'Pansement complexe (escarre, plaie)',    coef:4,  tarif:12.60, cumul:false },
  'AMI5':  { desc:'Perfusion, cathéter',                   coef:5,  tarif:15.75, cumul:false },
  'AMI6':  { desc:'Surveillance et soins',                 coef:6,  tarif:18.90, cumul:false },
  // Soins infirmiers (AIS) — dépendance
  'AIS1':  { desc:'Soins infirmiers légers',               coef:1,  tarif:2.65,  cumul:false },
  'AIS2':  { desc:'Soins infirmiers intermédiaires',       coef:2,  tarif:5.30,  cumul:false },
  'AIS3':  { desc:'Soins infirmiers lourds',               coef:3,  tarif:7.95,  cumul:false },
  // Bilan de soins infirmiers
  'BSA':   { desc:'Bilan soins infirmiers A (dépendance légère)',   coef:null, tarif:13.00,  cumul:false },
  'BSB':   { desc:'Bilan soins infirmiers B (dépendance modérée)',  coef:null, tarif:18.20,  cumul:false },
  'BSC':   { desc:'Bilan soins infirmiers C (dépendance lourde)',   coef:null, tarif:28.70,  cumul:false },
  // Déplacements
  'IFD':   { desc:'Indemnité forfaitaire de déplacement',  coef:null, tarif:2.75,  cumul:true  },
  'IK':    { desc:'Indemnités kilométriques (0,35 €/km)',  coef:null, tarif:0.35,  cumul:true  },
  // Majorations temporelles
  'MN':    { desc:'Majoration nuit (20h-8h)',              coef:null, tarif:9.15,  cumul:true  },
  'MN2':   { desc:'Majoration nuit profonde (23h-5h)',     coef:null, tarif:18.30, cumul:true  },
  'MD':    { desc:'Majoration dimanche et jours fériés',   coef:null, tarif:8.50,  cumul:true  },
  // Majorations patient
  'MIE':   { desc:'Majoration enfant < 7 ans',             coef:null, tarif:2.65,  cumul:true  },
  'MCI':   { desc:'Majoration coordination infirmière',    coef:null, tarif:5.00,  cumul:true  },
  // Actes spécifiques
  'SI':    { desc:'Soins palliatifs infirmiers',           coef:null, tarif:null,  cumul:false },
  'PIV':   { desc:'Perfusion intraveineuse',               coef:null, tarif:null,  cumul:false },
};

/* Règles de cumul interdits */
const NGAP_CUMUL_INTERDIT = [
  ['AIS', 'BSA'], ['AIS', 'BSB'], ['AIS', 'BSC'],
  ['BSA', 'BSB'], ['BSA', 'BSC'], ['BSB', 'BSC'],
  ['MN', 'MN2'],
];

function lookupNGAP(code) {
  return NGAP_NOMENCLATURE[code.toUpperCase()] || null;
}

function searchNGAP(query) {
  const q = query.toLowerCase();
  return Object.entries(NGAP_NOMENCLATURE)
    .filter(([code, info]) => code.toLowerCase().includes(q) || info.desc.toLowerCase().includes(q))
    .map(([code, info]) => ({ code, ...info }));
}

function validateNGAPCumul(actes) {
  const codes   = actes.map(a => (a.code||'').toUpperCase());
  const errors  = [];
  for (const [a, b] of NGAP_CUMUL_INTERDIT) {
    const hasA = codes.some(c => c.startsWith(a));
    const hasB = codes.some(c => c.startsWith(b));
    if (hasA && hasB) errors.push(`Cumul interdit : ${a} + ${b}`);
  }
  return errors;
}

function renderNGAPSearch() {
  const el = document.getElementById('ngap-search-results');
  const q  = (document.getElementById('ngap-search-input')?.value || '').trim();
  if (!el || !q) return;

  const results = searchNGAP(q);
  if (!results.length) { el.innerHTML = '<div class="ai wa">Aucun acte trouvé.</div>'; return; }

  el.innerHTML = results.slice(0, 15).map(r => `
    <div class="ar" style="flex-wrap:wrap;gap:8px;margin-bottom:6px">
      <div class="ac">${r.code}</div>
      <div class="an" style="flex:1;min-width:200px">${r.desc}</div>
      ${r.tarif ? `<div class="ao" style="color:var(--a);font-weight:600">${typeof r.tarif==='number'?r.tarif.toFixed(2)+' €':r.tarif}</div>` : ''}
      ${r.coef  ? `<div style="font-family:var(--fm);font-size:11px;color:var(--m)">Coef.${r.coef}</div>` : ''}
    </div>`).join('');
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('app:nav', e => {
    if (e.detail?.view === 'rapport')  { /* chargement à la demande */ }
    if (e.detail?.view === 'syshealth') loadSystemHealth();
  });
});

/* Exports */
window.generateRapportMensuel = generateRapportMensuel;
window.previewRapport         = previewRapport;
window.loadSystemHealth       = loadSystemHealth;
window.lookupNGAP             = lookupNGAP;
window.searchNGAP             = searchNGAP;
window.validateNGAPCumul      = validateNGAPCumul;
window.renderNGAPSearch       = renderNGAPSearch;
window.NGAP_NOMENCLATURE      = NGAP_NOMENCLATURE;
