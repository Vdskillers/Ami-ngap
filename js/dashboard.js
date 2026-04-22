/* ════════════════════════════════════════════════
   dashboard.js — AMI NGAP
   ────────────────────────────────────────────────
   Dashboard & Statistiques
   - loadDash() / renderDashboard()
   - detectAnomalies() / renderAnomalies()
   - explainAnomalies() / suggestOptimizations()
   - renderAI() — analyse IA NGAP
   - computeLoss() / showLossAlert()
   - forecastRevenue() — prévision linéaire
   - saveDashCache() / loadDashCache()
════════════════════════════════════════════════ */

/* ── Vérification de dépendances ─────────────── */
(function checkDeps(){
  if(typeof requireAuth==='undefined') console.error('dashboard.js : utils.js non chargé.');
  // DASH_CACHE_KEY est déclaré dans voice.js — vérification défensive
  if(typeof DASH_CACHE_KEY==='undefined') console.error('dashboard.js : DASH_CACHE_KEY manquant (voice.js non chargé).');
})();

/* Cache 30 minutes (au lieu de 5) avec fallback hors-ligne */
function loadDashCache(maxAge = 30 * 60 * 1000) {
  try {
    const key = (typeof _dashCacheKey === 'function') ? _dashCacheKey() : DASH_CACHE_KEY;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const expired = Date.now() - p.t > maxAge;
    return { data: p.data, expired, age: Date.now() - p.t };
  } catch { return null; }
}

/* ── Badge cache UI ──────────────────────────── */
function _showCacheInfo(cache) {
  const el = $('dash-cache-info');
  if (!el) return;
  const min = Math.floor((cache.age || 0) / 60000);
  el.innerHTML = cache.expired
    ? `🔴 Mode hors ligne — données en cache (${min} min)`
    : `🟡 Données en cache (${min} min)`;
  el.style.display = 'block';
  // Toast informatif
  if (typeof showToast === 'function') {
    if (cache.expired) showToast('warning', 'Mode hors ligne', `Données en cache (${min} min)`, 4000);
  }
}
function _hideCacheInfo() {
  const el = $('dash-cache-info');
  if (el) el.style.display = 'none';
}

/* ── 3. loadDash robuste + fallback cache ─────── */
async function loadDash() {
  if(!requireAuth()) return;

  $('dash-loading').style.display='block';
  $('dash-body').style.display='none';
  $('dash-empty').style.display='none';

  const period = document.getElementById('dash-period')?.value || 'month';
  const cache = loadDashCache();

  if (cache?.data?.length) {
    renderDashboard(cache.data);
    _showCacheInfo(cache);
    $('dash-loading').style.display='none';
    $('dash-body').style.display='block';
  }

  try {
    const data = await fetchAPI(`/webhook/ami-historique?period=${period}`);
    const arr  = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    if (!arr.length) {
      if (!cache?.data?.length) {
        $('dash-loading').style.display='none';
        $('dash-empty').style.display='block';
      }
      return;
    }
    saveDashCache(arr);
    renderDashboard(arr);
    _hideCacheInfo();
    $('dash-loading').style.display='none';
    $('dash-body').style.display='block';
  } catch(e) {
    console.warn('[Dashboard] API error:', e.message);
    if (cache?.data?.length) {
      renderDashboard(cache.data);
      _showCacheInfo({ ...cache, expired: true });
      $('dash-loading').style.display='none';
      $('dash-body').style.display='block';
    } else {
      $('dash-loading').style.display='none';
      $('dash-empty').style.display='block';
      $('dash-empty').innerHTML='<div style="font-size:40px;margin-bottom:12px">⚠️</div><p>Impossible de charger les statistiques.<br><small style="color:var(--m)">'+e.message+'</small></p>';
    }
  }
}

/* ── Mode admin : structure vide pour vérification UI ─────── */
function _renderAdminDashDemo() {
  $('dash-loading').style.display = 'none';
  $('dash-empty').style.display   = 'none';
  $('dash-body').style.display    = 'block';

  // Activer la notice admin
  const notice = $('dash-admin-notice');
  if (notice) notice.style.display = 'flex';

  // KPIs — libellés visibles, valeurs vides
  $('dash-kpis').innerHTML = [
    { icon:'💶', val:'— €',  label:'CA total (mois)',      cls:'g' },
    { icon:'🏦', val:'— €',  label:'Part AMO',              cls:'b' },
    { icon:'🏥', val:'— €',  label:'Part AMC',              cls:'b' },
    { icon:'👤', val:'— €',  label:'Part Patient',          cls:'o' },
    { icon:'☀️', val:'— €',  label:'Revenus du jour',       cls:'o' },
    { icon:'🏆', val:'— €',  label:'Meilleure facture',     cls:'g' },
    { icon:'📋', val:'—',    label:'DRE requises',          cls:'r' },
    { icon:'📊', val:'— €',  label:'Moy. par passage',      cls:'b' },
  ].map(k => `<div class="sc ${k.cls}"><div class="si">${k.icon}</div><div class="sv" style="color:var(--m)">${k.val}</div><div class="sn">${k.label}</div></div>`).join('');

  // Graphique 30j — barres vides
  const emptyBars = Array(30).fill(0).map((_, i) =>
    `<div style="flex:1;background:var(--b);border-radius:3px 3px 0 0;height:4px;opacity:0.4" title="Aucune donnée"></div>`
  ).join('');
  $('dash-chart').innerHTML = emptyBars;
  const emptyLabels = Array(30).fill(0).map((_, i) =>
    `<div style="flex:1;font-family:var(--fm);font-size:9px;color:var(--m);text-align:center">${i%7===0 ? '—' : ''}</div>`
  ).join('');
  $('dash-chart-labels').innerHTML = emptyLabels;

  // Top actes — placeholder
  $('dash-top-actes').innerHTML = `<div class="ai in" style="font-size:12px;color:var(--m)">
    🛡️ Aucune cotation — les actes s'afficheront ici avec les barres de fréquence</div>`;

  // Prévision
  $('dash-prevision').innerHTML = `
    <div class="dash-ring-wrap" style="margin:0 auto 12px">
      <svg viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg">
        <circle cx="44" cy="44" r="34" fill="none" stroke="var(--b)" stroke-width="7"/>
      </svg>
      <div class="dash-ring-label"><div class="dash-ring-pct" style="font-size:12px;color:var(--m)">—</div><div class="dash-ring-sub">objectif</div></div>
    </div>
    <div class="dash-prev-row"><span>Projection</span><strong style="color:var(--m)">—</strong></div>
    <div class="dash-prev-row"><span>Moy/jour</span><strong style="color:var(--m)">—</strong></div>`;

  // Heatmap vide
  const heatEl = $('dash-heatmap');
  if (heatEl) heatEl.innerHTML = Array(13).fill(0).map(()=>`<div class="hm-cell h0"></div>`).join('');

  // Alerte perte
  $('dash-loss').innerHTML = `<div class="ai in" style="font-size:12px">🔔 Alertes revenus manqués : aucune donnée à analyser</div>`;

  // Anomalies
  $('dash-anomalies').innerHTML = `<div class="ai in" style="font-size:12px">💸 Détection d'anomalies : aucune donnée à analyser</div>`;

  // IA analyse
  $('dash-ai').innerHTML = `<div class="ai in" style="font-size:12px">🧠 Analyse IA & Optimisations NGAP : aucune cotation à analyser</div>`;
}

/* 4. renderDashboard — version optimisée complète */
function renderDashboard(arr) {
  let total=0, amo=0, amc=0, partPat=0, dre=0;
  const actesFreq={}, daily={};
  const today=new Date().toISOString().split('T')[0];
  const monthStr=today.slice(0,7);
  let todayRev=0, monthRev=0, best=0;

  arr.forEach(r => {
    const t=parseFloat(r.total||0);
    total+=t;
    amo+=parseFloat(r.part_amo||0);
    amc+=parseFloat(r.part_amc||0);
    partPat+=parseFloat(r.part_patient||0);
    if(r.dre_requise) dre++;
    if(best<t) best=t;
    if((r.date_soin||'').startsWith(today)) todayRev+=t;
    if((r.date_soin||'').startsWith(monthStr)) monthRev+=t;
    try {
      // r.actes peut être une chaîne JSON (TEXT Supabase) ou un tableau déjà parsé (JSONB)
      const actesArr = Array.isArray(r.actes) ? r.actes : JSON.parse(r.actes || '[]');
      actesArr.forEach(a => { if (a.code && a.code !== 'IMPORT') actesFreq[a.code] = (actesFreq[a.code] || 0) + 1; });
    } catch {}
    const d=(r.date_soin||'').slice(0,10);
    if(d) daily[d]=(daily[d]||0)+t;
  });

  const avg = arr.length ? total/arr.length : 0;
  const dayOfMonth=new Date().getDate();
  const daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate();

  // ── Km du mois — barème dynamique depuis préférences véhicule ─────────────
  let kmMois = 0, kmDeduction = 0, _kmBaremeLabel = '5 CV';
  try {
    let _kmUid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    if (!_kmUid) { try { _kmUid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {} }
    const _kmKey3    = 'ami_km_journal_' + String(_kmUid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const _prefsKey3 = 'ami_km_prefs_'   + String(_kmUid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const kmEntries  = JSON.parse(localStorage.getItem(_kmKey3) || '[]');
    const kmPrefs    = (() => { try { return JSON.parse(localStorage.getItem(_prefsKey3)||'{}'); } catch { return {}; } })();

    const cv         = parseInt(kmPrefs.cv) || 5;
    const electrique = !!kmPrefs.electrique;

    const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const kmAnnuel = kmEntries.filter(e => new Date(e.date).getFullYear() === new Date().getFullYear())
      .reduce((s,e) => s + parseFloat(e.km||0), 0);

    kmEntries.filter(e => new Date(e.date) >= since).forEach(e => { kmMois += parseFloat(e.km||0); });

    // Barème 2025/2026
    const _KMB = {3:{t1:.529,t2a:.316,t2b:1065,t3:.370,lbl:'3 CV'},4:{t1:.606,t2a:.340,t2b:1330,t3:.407,lbl:'4 CV'},
      5:{t1:.636,t2a:.357,t2b:1395,t3:.427,lbl:'5 CV'},6:{t1:.665,t2a:.374,t2b:1457,t3:.447,lbl:'6 CV'},
      7:{t1:.697,t2a:.394,t2b:1515,t3:.470,lbl:'7 CV et +'}};
    const b   = _KMB[cv] || _KMB[5];
    let taux  = kmAnnuel <= 5000 ? b.t1 : kmAnnuel <= 20000 ? b.t2a + b.t2b/kmAnnuel : b.t3;
    if (electrique) taux *= 1.20;

    kmDeduction       = Math.round(kmMois * taux * 100) / 100;
    kmMois            = Math.round(kmMois * 10) / 10;
    _kmBaremeLabel    = b.lbl + (electrique ? ' ⚡' : '');
  } catch {}

  // ── Patients du carnet ce mois (IDB local) ─────────────────────────────
  let nbPatientsCarnet = 0;
  try {
    const uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : 'local';
    const dbName = 'ami_patients_db_' + String(uid).replace(/[^a-zA-Z0-9_-]/g,'_');
    // Lecture asynchrone non-bloquante — met à jour le badge si disponible
    (async () => {
      try {
        const req = indexedDB.open(dbName);
        req.onsuccess = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('ami_patients')) return;
          const tx = db.transaction('ami_patients','readonly');
          const store = tx.objectStore('ami_patients');
          const countReq = store.count();
          countReq.onsuccess = () => {
            const el = $('dash-km-patients');
            if (el) el.textContent = countReq.result + ' patient(s) dans le carnet';
          };
        };
      } catch {}
    })();
  } catch {}

  // ── KPIs Premium — avec accent top-border + delta tendance ──────────────
  // Calcul delta mois précédent (estimation sur 15 jours glissants vs 15 précédents)
  const midPoint = Math.floor(arr.length / 2);
  const recentHalf = arr.slice(midPoint).reduce((s, r) => s + parseFloat(r.total || 0), 0);
  const olderHalf  = arr.slice(0, midPoint).reduce((s, r) => s + parseFloat(r.total || 0), 0);
  const deltaPct   = olderHalf > 0 ? ((recentHalf - olderHalf) / olderHalf * 100) : 0;
  const deltaHtml  = (pct, suffix='') => {
    if (Math.abs(pct) < 0.5) return `<span class="sc-delta nt">→ stable${suffix}</span>`;
    return pct > 0
      ? `<span class="sc-delta up">↑ +${Math.abs(pct).toFixed(1)}%${suffix}</span>`
      : `<span class="sc-delta dn">↓ −${Math.abs(pct).toFixed(1)}%${suffix}</span>`;
  };

  $('dash-kpis').innerHTML=[
    {icon:'💶', val:total.toFixed(2)+'€',    label:'CA total (mois)',   cls:'g', delta:deltaHtml(deltaPct)},
    {icon:'🏦', val:amo.toFixed(2)+'€',      label:'Part AMO',          cls:'b', delta:''},
    {icon:'🏥', val:amc.toFixed(2)+'€',      label:'Part AMC',          cls:'b', delta:''},
    {icon:'👤', val:partPat.toFixed(2)+'€',  label:'Part Patient',      cls:'o', delta:''},
    {icon:'☀️', val:todayRev.toFixed(2)+'€', label:'Revenus du jour',   cls:'o', delta:''},
    {icon:'🏆', val:best.toFixed(2)+'€',     label:'Meilleure facture', cls:'g', delta:''},
    {icon:'📋', val:dre,                      label:'DRE requises',      cls:'r', delta: dre>0?'<span class="sc-delta dn">à vérifier</span>':'<span class="sc-delta up">OK</span>'},
    {icon:'📊', val:avg.toFixed(2)+'€',      label:'Moy. par passage',  cls:'b', delta:''},
    ...(kmMois>0 ? [{icon:'🚗', val:kmMois+'km', label:'Km ce mois', cls:'b', delta:`<span class="sc-delta nt" style="font-size:9px">${_kmBaremeLabel}</span>`}] : []),
    ...(kmDeduction>0 ? [{icon:'💸', val:kmDeduction+'€', label:'Déd. fiscale km', cls:'g', delta:''}] : []),
  ].map(k=>`<div class="sc ${k.cls}">
    <div class="si">${k.icon}</div>
    <div class="sv">${k.val}</div>
    <div class="sn">${k.label}</div>
    ${k.delta ? k.delta : ''}
  </div>`).join('');

  // Graphique 30 jours — barres premium (today = vert, high = bleu fort, normal = bleu doux, low = foncé)
  const days30=[];
  for(let i=29;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);days30.push(d.toISOString().split('T')[0]);}
  const vals=days30.map(d=>daily[d]||0);
  const maxVal=Math.max(...vals,1);
  const avgVal=vals.filter(v=>v>0).reduce((a,b)=>a+b,0)/Math.max(vals.filter(v=>v>0).length,1);
  $('dash-chart').innerHTML=vals.map((v,i)=>{
    const isToday = i===29;
    const cls = isToday ? 'today' : v > avgVal*1.3 ? 'high' : v > 0 ? 'normal' : 'low';
    return `<div class="dash-bar ${cls}" style="height:${Math.max(4,Math.round(v/maxVal*140))}px" title="${days30[i]}: ${v.toFixed(2)}€"></div>`;
  }).join('');
  $('dash-chart-labels').innerHTML=days30.map((d,i)=>`<div style="flex:1;font-family:var(--fm);font-size:9px;color:var(--m);text-align:center;overflow:hidden">${i%7===0?d.slice(5):''}</div>`).join('');

  // Top actes — version premium avec rang + barre gradient
  const topActes=Object.entries(actesFreq).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxCount=topActes[0]?.[1]||1;
  $('dash-top-actes').innerHTML=topActes.length
    ? topActes.map(([code,count],i)=>`<div class="acte-row-prem">
        <div class="acte-rank">${i+1}</div>
        <div class="acte-code-pill">${code}</div>
        <div class="acte-bar-track"><div class="acte-bar-fill-prem" style="width:${Math.round(count/maxCount*100)}%"></div></div>
        <div class="acte-count-lbl">${count}×</div>
      </div>`).join('')
    : '<div class="ai wa">Aucune cotation enregistrée</div>';

  // Bandeau km si données disponibles
  const kmBandeau = $('dash-km-bandeau');
  if (kmBandeau) {
    kmBandeau.style.display = kmMois > 0 ? 'flex' : 'none';
    if (kmMois > 0) {
      kmBandeau.innerHTML = `🚗 <strong>${kmMois} km</strong> parcourus ce mois · déduction fiscale estimée : <strong style="color:#22c55e">${kmDeduction} €</strong> · ${_kmBaremeLabel} · barème 2025/2026 · <span id="dash-km-patients" style="color:var(--m)"></span>`;
      // Afficher le sélecteur barème
      const prefsBar = document.getElementById('dash-km-prefs');
      if (prefsBar) prefsBar.style.display = 'flex';
    } else {
      const prefsBar = document.getElementById('dash-km-prefs');
      if (prefsBar) prefsBar.style.display = 'none';
    }
  }

  // Prévision — anneau SVG + sidebar layout
  const forecast = forecastRevenue(daily);
  const daysRemaining = daysInMonth - dayOfMonth;
  if (forecast) {
    const trendIcon = forecast.trend>0 ? '↑ hausse' : forecast.trend<0 ? '↓ baisse' : '→ stable';
    const trendCls  = forecast.trend>0 ? 'style="color:var(--ok)"' : forecast.trend<0 ? 'style="color:var(--d)"' : '';
    // Anneau : % de l'objectif (projection / objectif estimé = projection * 1.15)
    const objectif = forecast.projection * 1.1;
    const pctObj   = Math.min(100, Math.round((Object.values(daily).reduce((a,b)=>a+b,0) / objectif) * 100));
    const circumf  = 2 * Math.PI * 34;
    const dashOffset = circumf * (1 - pctObj/100);
    $('dash-prevision').innerHTML=`
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div class="dash-ring-wrap">
          <svg viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg">
            <circle cx="44" cy="44" r="34" fill="none" stroke="var(--b)" stroke-width="7"/>
            <circle cx="44" cy="44" r="34" fill="none" stroke="var(--a)" stroke-width="7"
              stroke-dasharray="${circumf.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"
              stroke-linecap="round" style="transition:stroke-dashoffset .6s ease"/>
          </svg>
          <div class="dash-ring-label">
            <div class="dash-ring-pct">${pctObj}%</div>
            <div class="dash-ring-sub">objectif</div>
          </div>
        </div>
        <div style="flex:1;min-width:140px">
          <div class="dash-prev-row"><span>Réalisé ce mois</span><strong>${Object.values(daily).reduce((a,b)=>a+b,0).toFixed(2)} €</strong></div>
          <div class="dash-prev-row"><span>Projection fin mois</span><strong>${forecast.projection.toFixed(2)} €</strong></div>
          <div class="dash-prev-row"><span>Moy/jour</span><strong>${forecast.avg.toFixed(2)} €</strong></div>
          <div class="dash-prev-row"><span>Tendance</span><strong ${trendCls}>${trendIcon}</strong></div>
          <div class="dash-prev-row"><span>Jours restants</span><strong>${daysRemaining}</strong></div>
        </div>
      </div>`;
  } else {
    const prevision = dayOfMonth>0 ? (monthRev/dayOfMonth)*daysInMonth : 0;
    $('dash-prevision').innerHTML=`
      <div class="dash-ring-wrap" style="margin:0 auto 12px">
        <svg viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg">
          <circle cx="44" cy="44" r="34" fill="none" stroke="var(--b)" stroke-width="7"/>
          <circle cx="44" cy="44" r="34" fill="none" stroke="var(--a)" stroke-width="7"
            stroke-dasharray="213" stroke-dashoffset="180" stroke-linecap="round"/>
        </svg>
        <div class="dash-ring-label"><div class="dash-ring-pct" style="font-size:12px">—</div></div>
      </div>
      <div class="dash-prev-row"><span>Prévision</span><strong>${prevision.toFixed(2)} €</strong></div>
      <div class="dash-prev-row"><span>Cotations</span><strong>${arr.length}</strong></div>`;
  }

  // Heatmap horaire — analyse répartition par tranche horaire
  const heatHours = new Array(13).fill(0); // tranches 6h→18h (1h chacune)
  arr.forEach(r => {
    const h = parseInt((r.heure_soin||'').slice(0,2),10);
    if (h>=6 && h<=18) heatHours[h-6]++;
  });
  const maxHeat = Math.max(...heatHours, 1);
  const heatEl = $('dash-heatmap');
  if (heatEl) {
    heatEl.innerHTML = heatHours.map((v,i) => {
      const intensity = v===0 ? 0 : v < maxHeat*0.25 ? 1 : v < maxHeat*0.5 ? 2 : v < maxHeat*0.75 ? 3 : 4;
      return `<div class="hm-cell h${intensity}" title="${6+i}h : ${v} soins"></div>`;
    }).join('');
  }

  // Chart footer stats
  const peakVal = Math.max(...vals.filter(v=>v>0), 0);
  const el_avg = document.getElementById('cs-avg');
  const el_peak = document.getElementById('cs-peak');
  const el_mpp = document.getElementById('cs-mpp');
  const el_count = document.getElementById('cs-count');
  if (el_avg) el_avg.textContent = avgVal > 0 ? avgVal.toFixed(2)+'€/j' : '—';
  if (el_peak) el_peak.textContent = peakVal > 0 ? peakVal.toFixed(2)+'€' : '—';
  if (el_mpp) el_mpp.textContent = arr.length ? avg.toFixed(2)+'€' : '—';
  if (el_count) el_count.textContent = arr.length;

  // Badge tendance graphique
  const trendBadge = document.getElementById('dash-chart-trend-badge');
  if (trendBadge) {
    if (deltaPct > 1) { trendBadge.textContent='↑ hausse'; trendBadge.className='dash-section-badge'; }
    else if (deltaPct < -1) { trendBadge.textContent='↓ baisse'; trendBadge.className='dash-section-badge r'; }
    else { trendBadge.textContent='→ stable'; trendBadge.className='dash-section-badge b'; }
  }

  // Modules IA
  const anomalyResult = detectAnomalies(arr, daily);
  renderAnomalies(anomalyResult);
  const explanations = explainAnomalies(arr, anomalyResult);
  const suggestions = suggestOptimizations(arr);
  renderAI(explanations, suggestions);
  const lossResult = computeLoss(arr);
  showLossAlert(lossResult);

  // Alert strip — afficher si des pertes détectées
  const alertStrip = document.getElementById('dash-alert-strip-loss');
  const alertText  = document.getElementById('dash-alert-strip-text');
  const lossBadge  = document.getElementById('dash-loss-badge');
  if (alertStrip && lossResult.total >= 1) {
    alertStrip.style.display = 'flex';
    if (alertText) alertText.innerHTML = `<strong>${lossResult.total.toFixed(2)} €</strong> de revenus manqués détectés ce mois`;
    if (lossBadge) lossBadge.style.display = 'inline-block';
    // Badge sidebar nav Dashboard
    const navDashBadge = document.getElementById('nav-dash-badge');
    if (navDashBadge) { navDashBadge.style.display = 'inline-block'; navDashBadge.textContent = '−' + lossResult.total.toFixed(0) + '€'; }
    // Toast alerte revenus
    if (typeof showToast === 'function') {
      showToast('warning', 'Revenus manqués détectés', `${lossResult.total.toFixed(2)} € non facturés ce mois`, 5000);
    }
  } else if (alertStrip) {
    alertStrip.style.display = 'none';
    const navDashBadge = document.getElementById('nav-dash-badge');
    if (navDashBadge) navDashBadge.style.display = 'none';
  }

  // Notice admin si applicable
  const isAdmin = typeof S !== 'undefined' && S?.role === 'admin';
  const notice = $('dash-admin-notice');
  if (notice) notice.style.display = isAdmin ? 'flex' : 'none';

  // 🆕 Widget score de confiance global
  try { renderTrustWidget(arr); } catch (e) { console.warn('[trust widget]', e.message); }

  // 🛡️ Widget Conformité cabinet & 📊 Dashboard cabinet : DÉPLACÉS vers la vue
  //    « Cabinet & synchronisation ». Appelés désormais par renderCabinetSection().
}

/* ════════════════════════════════════════════════
   🛡️ WIDGET CONFORMITÉ CABINET (v3.9)
   ────────────────────────────────────────────────
   Affiche sur l'accueil un résumé du score de conformité
   (4 piliers : consentements · NGAP · BSI · traçabilité)
   + le nombre d'actions requises + bouton d'accès rapide.
   Non bloquant si compliance-engine.js n'est pas chargé.
════════════════════════════════════════════════ */
async function renderComplianceBadge() {
  const el = document.getElementById('dash-compliance-widget');
  if (!el || typeof computeCompliance !== 'function') return;

  // 🛡️ Guard cabinet — le widget de conformité n'a de sens que si on est dans un cabinet.
  // Hors cabinet : on masque le widget et on vide son contenu (évite l'affichage fantôme
  // « Cabinet à surveiller · Consent 100% · NGAP 100% · BSI 100% · Trace 0% »).
  const cab = (typeof APP !== 'undefined' && APP.get) ? APP.get('cabinet') : null;
  if (!cab?.id) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  try {
    const [comp, reminders] = await Promise.all([
      computeCompliance(),
      typeof consentBuildReminders === 'function' ? consentBuildReminders() : Promise.resolve([]),
    ]);
    const color = comp.global >= 90 ? '#00d4aa' : comp.global >= 70 ? '#f59e0b' : '#ef4444';
    const statusLbl = comp.global >= 90 ? 'conforme' : comp.global >= 70 ? 'à surveiller' : 'à régulariser';
    const hiCount   = reminders.filter(r => r.priority === 'HIGH').length;
    const medCount  = reminders.filter(r => r.priority === 'MEDIUM').length;

    el.innerHTML = `
      <div class="card" style="display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:center;padding:14px 18px">
        <div style="text-align:center;min-width:72px">
          <div style="font-family:var(--fs);font-size:30px;font-weight:800;color:${color};line-height:1">${comp.global}</div>
          <div style="font-size:10px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-top:2px">Conformité</div>
        </div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600">🛡️ Cabinet <span style="color:${color}">${statusLbl}</span></div>
          <div style="display:flex;gap:10px;margin-top:4px;flex-wrap:wrap;font-size:10px;color:var(--m);font-family:var(--fm)">
            <span>Consent <strong style="color:var(--t)">${comp.breakdown.consent.score}%</strong></span>
            <span>NGAP <strong style="color:var(--t)">${comp.breakdown.ngap.score}%</strong></span>
            <span>BSI <strong style="color:var(--t)">${comp.breakdown.bsi.score}%</strong></span>
            <span>Trace <strong style="color:var(--t)">${comp.breakdown.trace.score}%</strong></span>
          </div>
          ${reminders.length ? `
            <div style="font-size:11px;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap">
              ${hiCount ? `<span style="color:#ef4444">🔴 ${hiCount} urgent${hiCount>1?'s':''}</span>` : ''}
              ${medCount ? `<span style="color:#f59e0b">🟠 ${medCount} moyen${medCount>1?'s':''}</span>` : ''}
            </div>` : '<div style="font-size:11px;color:#00d4aa;margin-top:6px">✅ Aucune action en attente</div>'}
        </div>
        <button class="btn bs bsm" style="flex-shrink:0" onclick="navTo('compliance',null)">
          <span>🧠</span> Voir
        </button>
      </div>
    `;
    el.style.display = 'block';
  } catch (e) {
    console.warn('[compliance widget] render KO:', e.message);
  }
}

/* ════════════════════════════════════════════════
   🆕 WIDGET SCORE DE CONFIANCE (Trust Score)
   ────────────────────────────────────────────────
   Affiche en haut du dashboard un score global
   agrégant NGAP + BSI + Risque CPAM. Donne à
   l'IDE une vision instantanée de sa sérénité.
═══════════════════════════════════════════════ */
function renderTrustWidget(arr) {
  const el = document.getElementById('dash-trust-widget');
  if (!el || !window.BSI_ENGINE) return;

  // ── Estimation rapide des inputs à partir des cotations disponibles ──
  const cots = Array.isArray(arr) ? arr : [];
  if (!cots.length) { el.style.display = 'none'; return; }

  // ngapCompliance = part de cotations sans DRE manquant ni alerte majeure
  const nb = cots.length;
  const nbDre = cots.filter(c => c.dre_requise).length;
  const nbAlertes = cots.filter(c => {
    try {
      const a = typeof c.alerts === 'string' ? JSON.parse(c.alerts || '[]') : (c.alerts || []);
      return Array.isArray(a) && a.some(x => /erreur|invalide|critique/i.test(JSON.stringify(x)));
    } catch { return false; }
  }).length;
  const ngapCompliance = nb ? Math.max(0, 1 - (nbDre * 0.3 + nbAlertes * 0.5) / nb) : 1;

  // bsiCoherence : approximation — 1 par défaut (sans calcul patient-par-patient coûteux)
  // Le vrai calcul se fait dans auditModeControleCPAM. Ici on reste en estimation.
  const bsiCoherence = 0.9;

  // riskScore : approximation basée sur DRE et alertes
  const riskScore = Math.min(20, Math.round((nbDre * 0.4 + nbAlertes * 0.6) / Math.max(1, nb) * 20));

  const trust = window.BSI_ENGINE.computeTrustScore({
    ngapCompliance, bsiCoherence, riskScore, riskMax: 20,
  });

  const emoji = trust.score >= 85 ? '🛡️' : trust.score >= 70 ? '✅' : trust.score >= 50 ? '⚠️' : '🔴';

  el.style.display = 'block';
  el.innerHTML = `
    <div style="background:linear-gradient(135deg,${trust.color}14,${trust.color}06);border:1px solid ${trust.color}40;border-radius:14px;padding:16px 18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:260px">
        <div style="font-size:36px;line-height:1">${emoji}</div>
        <div style="flex:1">
          <div style="font-size:11px;color:var(--m);font-family:var(--fm);letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Score de confiance</div>
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <span style="font-family:var(--fs);font-size:32px;color:${trust.color};line-height:1">${trust.score}<span style="font-size:14px;color:var(--m)">/100</span></span>
            <span style="font-size:13px;font-weight:600;color:${trust.color}">${trust.label}</span>
          </div>
          <div style="display:flex;gap:12px;margin-top:6px;flex-wrap:wrap;font-size:10px;color:var(--m);font-family:var(--fm)">
            <span>NGAP <strong style="color:var(--t)">${trust.parts.ngap}</strong></span>
            <span>BSI <strong style="color:var(--t)">${trust.parts.bsi}</strong></span>
            <span>Risque <strong style="color:var(--t)">${trust.parts.risk}</strong></span>
          </div>
        </div>
      </div>
      <button class="btn bp bsm" onclick="navTo('audit-cpam',null);setTimeout(()=>typeof auditModeControleCPAM==='function'&&auditModeControleCPAM(),400)" style="flex-shrink:0">
        <span>🛡️</span> Lancer le contrôle
      </button>
    </div>
  `;
}

/* ============================================================
   5. DÉTECTION D'ANOMALIES (stats σ)
   ============================================================ */
function detectAnomalies(rows, daily) {
  const values = Object.values(daily);
  if (values.length < 5) return {avg:0, std:0, anomalies:[]};

  const avg = values.reduce((a,b)=>a+b,0)/values.length;
  const variance = values.reduce((a,v)=>a+Math.pow(v-avg,2),0)/values.length;
  const std = Math.sqrt(variance);
  const anomalies = [];

  Object.entries(daily).forEach(([date,val])=>{
    const score = std>0 ? Math.abs(val-avg)/std : 0;
    if (val < avg-2*std) anomalies.push({type:'critical_low',date,value:val,score:score.toFixed(1)});
    else if (val > avg+2*std) anomalies.push({type:'critical_high',date,value:val,score:score.toFixed(1)});
    else if (val < avg-std) anomalies.push({type:'warning_low',date,value:val,score:score.toFixed(1)});
  });

  return {avg, std, anomalies};
}

function renderAnomalies(result) {
  const el=$('dash-anomalies');
  if (!el) return;
  if (!result||!result.anomalies.length) {
    el.innerHTML='<div class="ai su">✅ Aucun comportement anormal détecté sur la période</div>';
    return;
  }
  const avg=result.avg.toFixed(2), std=result.std.toFixed(2);
  el.innerHTML=`<div style="font-size:11px;color:var(--m);margin-bottom:10px;font-family:var(--fm)">Moy/jour : ${avg}€ · Écart-type : ${std}€</div>`
    +result.anomalies.slice(0,6).map(a=>{
      if(a.type==='critical_low') return`<div class="anomaly-prem"><div class="anomaly-prem-indicator cr"></div><div><div class="anomaly-prem-title">Chute anormale — ${a.date}</div><div class="anomaly-prem-desc">${a.value.toFixed(2)}€ · score ${a.score}σ en dessous de la moyenne</div></div></div>`;
      if(a.type==='critical_high') return`<div class="anomaly-prem" style="background:rgba(255,181,71,.04);border-color:rgba(255,181,71,.18)"><div class="anomaly-prem-indicator hi"></div><div><div class="anomaly-prem-title" style="color:var(--w)">Pic inhabituel — ${a.date}</div><div class="anomaly-prem-desc">${a.value.toFixed(2)}€ · vérifier conformité NGAP</div></div></div>`;
      return`<div class="anomaly-prem" style="background:rgba(79,168,255,.04);border-color:rgba(79,168,255,.18)"><div class="anomaly-prem-indicator lo"></div><div><div class="anomaly-prem-title" style="color:var(--a2)">Activité faible — ${a.date}</div><div class="anomaly-prem-desc">${a.value.toFixed(2)}€ · journée sous la moyenne habituelle</div></div></div>`;
    }).join('');
}

/* ============================================================
   6. EXPLICATION IA DES ANOMALIES
   ============================================================ */
function explainAnomalies(rows, anomalyResult) {
  return (anomalyResult.anomalies||[]).map(a=>{
    const dayRows = rows.filter(r=>(r.date_soin||'').startsWith(a.date));
    let actesCount=0, dre=0, nuit=0, domicile=0;
    dayRows.forEach(r=>{
      if(r.dre_requise) dre++;
      const h=r.heure_soin||'';
      if(h&&(h<'08:00'||h>'20:00')) nuit++;
      try {
        const acts = Array.isArray(r.actes) ? r.actes : JSON.parse(r.actes || '[]');
        actesCount+=acts.length;
        acts.forEach(act=>{ if(act.code==='IFD') domicile++; });
      } catch{}
    });
    let reason='', insights=[];
    if(a.type==='critical_low') {
      if(actesCount<3) reason='Très peu d\'actes ce jour';
      else if(domicile===0){ reason='Absence d\'IFD (indemnité déplacement)'; insights.push('Aucun IFD → perte possible sur déplacements'); }
      else reason='Volume ou valorisation anormalement faibles';
    } else if(a.type==='critical_high') {
      if(dre>0) reason='Soins complexes avec DRE (normal si ALD/maternité)';
      else if(nuit>0) reason='Actes de nuit majorés détectés';
      else reason='Montant inhabituel → vérifier conformité NGAP';
    } else {
      reason='Journée sous la moyenne habituelle';
    }
    return {...a, reason, insights, actesCount};
  });
}

/* ============================================================
   7. SUGGESTIONS OPTIMISATION NGAP
   ============================================================ */
function suggestOptimizations(rows) {
  const suggestions=[];
  const seen=new Set();
  rows.forEach(r=>{
    const actes=r.actes||'';
    const txt=(r.texte_soin||r.description||'').toLowerCase();
    const h=r.heure_soin||'';
    // IFD manquant
    if((txt.includes('domicile')||txt.includes('chez'))&&!actes.includes('IFD')) {
      const k='ifd'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'lost_revenue',msg:'IFD (indemnité déplacement domicile) potentiellement oublié — +2,75 € par passage'});}
    }
    // IK manquant
    if(/\d+\s*km/.test(txt)&&!actes.includes('IK')) {
      const k='ik'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'lost_revenue',msg:'Kilométrage mentionné sans IK coté — +0,35 €/km'});}
    }
    // Nuit non majorée
    if(h&&(h<'08:00'||h>'20:00')&&!actes.includes('majoration_nuit')&&!actes.includes('MN')&&!actes.includes('NUIT')&&!actes.includes('nuit')) {
      const k='nuit'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'optimization',msg:'Acte de nuit sans majoration nuit (9,15 € ou 18,30 €) — vérifier'});}
    }
    // ALD + reste patient > 0
    if((r.exo==='ALD')&&parseFloat(r.part_patient||0)>0) {
      const k='ald'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'error',msg:'ALD détecté avec reste patient > 0 — incohérence facturation CPAM'});}
    }
    // Montant très élevé
    if(parseFloat(r.total||0)>150) {
      suggestions.push({type:'check',msg:`Montant élevé (${parseFloat(r.total).toFixed(2)}€ le ${(r.date_soin||'').slice(0,10)}) — vérifier conformité NGAP`});
    }
    // AIS sans BS
    if(actes.includes('AIS')&&!actes.includes('BSA')&&!actes.includes('BSB')&&!actes.includes('BSC')) {
      const k='ais'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'optimization',msg:'AIS coté sans forfait BS — BSA (+13€) possible si dépendance légère'});}
    }
  });
  return suggestions;
}

/* ============================================================
   8. RENDU IA + SUGGESTIONS
   ============================================================ */
function renderAI(explanations, suggestions) {
  const el=$('dash-ai');
  if (!el) return;

  // Classifier les suggestions par colonne thématique
  const cotations = suggestions.filter(s => ['lost_revenue','optimization'].includes(s.type));
  const errors    = suggestions.filter(s => s.type === 'error');
  const checks    = suggestions.filter(s => s.type === 'check');

  // Construire les lignes des colonnes
  const colCot = cotations.length
    ? cotations.slice(0,3).map(s=>`<p>💸 ${s.msg}</p>`).join('')
    : '<p style="color:var(--ok)">✅ Aucune optimisation manquante détectée</p>';

  const anomBullets = explanations.length
    ? explanations.slice(0,3).map(e=>`<p>${e.type==='critical_low'?'🔴':e.type==='critical_high'?'🟠':'🟡'} <strong>${e.date}</strong> — ${e.reason}</p>`).join('')
    : '<p style="color:var(--ok)">✅ Aucune anomalie détectée</p>';

  const conformBullets = errors.length || checks.length
    ? [...errors.slice(0,2), ...checks.slice(0,2)].map(s=>`<p>${s.type==='error'?'❌':'🔍'} ${s.msg}</p>`).join('')
    : '<p style="color:var(--ok)">✅ 100 % des cotations conformes</p>';

  el.innerHTML = `<div class="dash-ia-grid">
    <div class="dash-ia-col g">
      <div class="dash-ia-col-lbl">Cotations</div>
      ${colCot}
    </div>
    <div class="dash-ia-col b">
      <div class="dash-ia-col-lbl">Anomalies</div>
      ${anomBullets}
    </div>
    <div class="dash-ia-col o">
      <div class="dash-ia-col-lbl">Conformité</div>
      ${conformBullets}
    </div>
  </div>`;
}

/* ============================================================
   9. CALCUL PERTE ESTIMÉE + ALERTE — v2.0
   Analyse ligne par ligne avec détail par source de perte.
   Retourne { total, details[], byType{} }
   ============================================================ */
function computeLoss(rows) {
  let total = 0;
  const details = [];
  const byType  = { ifd: 0, ik: 0, nuit: 0, dimanche: 0, ald: 0 };

  rows.forEach(r => {
    const txt   = (r.texte_soin || r.description || '').toLowerCase();
    const actes = r.actes || '';
    const h     = r.heure_soin || '';
    const date  = r.date_soin  || '';
    const nom   = r.patient_nom || r.nom || '';

    // ── IFD manquant ────────────────────────────────────────
    // Seulement si le texte mentionne explicitement le domicile
    // ET que ni IFD ni IK (déplacement) ne sont cotés
    const mentionDomicile = txt.includes('domicile') || txt.includes(' chez ');
    let aIFD = false;
    try {
      const actesArr = typeof actes === 'string' ? JSON.parse(actes) : (Array.isArray(actes) ? actes : []);
      aIFD = actesArr.some(a => {
        const c = (a.code || a.Code || '').toUpperCase();
        return c === 'IFD' || c === 'IK';
      });
    } catch {
      aIFD = actes.includes('IFD') || actes.includes('"IFD"') || actes.includes('IK') || actes.includes('"IK"');
    }
    if (mentionDomicile && !aIFD) {
      details.push({ type: 'ifd', montant: 2.75, label: 'IFD manquant', date, nom });
      byType.ifd += 2.75;
      total += 2.75;
    }

    // ── IK manquant ─────────────────────────────────────────
    // Uniquement si un nombre de km est explicitement mentionné
    const kmMatch = txt.match(/(\d+(?:[.,]\d+)?)\s*km/);
    let aIK = false;
    try {
      const actesArr = typeof actes === 'string' ? JSON.parse(actes) : (Array.isArray(actes) ? actes : []);
      aIK = actesArr.some(a => (a.code || a.Code || '').toUpperCase() === 'IK');
    } catch {
      aIK = actes.includes('IK') || actes.includes('"IK"') || actes.includes(' ik');
    }
    if (kmMatch && !aIK) {
      const km       = parseFloat(kmMatch[1].replace(',', '.'));
      const montantIK = Math.round(km * 0.35 * 100) / 100;
      details.push({ type: 'ik', montant: montantIK, label: `IK non coté (${km} km × 0,35 €)`, date, nom });
      byType.ik += montantIK;
      total     += montantIK;
    }

    // ── Majoration nuit manquante ────────────────────────────
    // Seulement si l'heure est hors plage 08:00–20:00
    // ET qu'aucun code majoration nuit n'est présent
    let aNuit = false;
    try {
      const actesArr = typeof actes === 'string' ? JSON.parse(actes) : (Array.isArray(actes) ? actes : []);
      aNuit = actesArr.some(a => {
        const c = (a.code || a.Code || '').toUpperCase();
        return c === 'NUIT' || c === 'NUIT_PROF' || c === 'MN' || c === 'MN2';
      });
    } catch {
      aNuit = actes.includes('NUIT') || actes.includes('MN') ||
              actes.toLowerCase().includes('nuit') ||
              actes.includes('majoration_nuit');
    }
    if (h && !aNuit) {
      const hh = parseInt(h.slice(0, 2), 10);
      const mm = parseInt(h.slice(3, 5) || '0', 10);
      const tMin = hh * 60 + mm;
      // Nuit profonde 00:00–06:00 → +18,30€ · Nuit 20:00–00:00 et 06:00–08:00 → +9,15€
      if (tMin >= 0 && tMin < 360) {
        details.push({ type: 'nuit', montant: 18.30, label: `Majoration nuit profonde (${h})`, date, nom });
        byType.nuit += 18.30;
        total       += 18.30;
      } else if (tMin >= 1200 || (tMin >= 360 && tMin < 480)) {
        details.push({ type: 'nuit', montant: 9.15, label: `Majoration nuit (${h})`, date, nom });
        byType.nuit += 9.15;
        total       += 9.15;
      }
    }

    // ── Dimanche/férié sans majoration ──────────────────────
    if (date) {
      const dow = new Date(date).getDay();
      // Détecte le code DIM dans le JSON des actes (format tableau ou texte brut)
      let aDim = false;
      try {
        const actesArr = typeof actes === 'string' ? JSON.parse(actes) : (Array.isArray(actes) ? actes : []);
        aDim = actesArr.some(a => {
          const c = (a.code || a.Code || '').toUpperCase();
          return c === 'DIM' || c === 'MD';
        });
      } catch {
        // fallback texte brut si actes n'est pas du JSON
        aDim = actes.includes('DIM') || actes.includes('"DIM"') ||
               actes.includes('MD') ||
               actes.toLowerCase().includes('dimanche') ||
               actes.toLowerCase().includes('ferie') ||
               actes.toLowerCase().includes('férié');
      }
      if ((dow === 0) && !aDim) {
        details.push({ type: 'dimanche', montant: 8.50, label: 'Majoration dimanche/férié manquante', date, nom });
        byType.dimanche += 8.50;
        total           += 8.50;
      }
    }

    // ── ALD avec reste patient > 0 (incohérence, pas perte mais alerte) ──
    if ((r.exo || '').toUpperCase() === 'ALD' && parseFloat(r.part_patient || 0) > 0) {
      details.push({ type: 'ald', montant: 0, label: 'ALD avec reste patient > 0 — incohérence CPAM', date, nom });
    }
  });

  return { total: Math.round(total * 100) / 100, details, byType };
}

function showLossAlert(lossResult) {
  const el = $('dash-loss');
  if (!el) return;

  // Compatibilité ancienne signature (nombre seul)
  const loss    = typeof lossResult === 'number' ? lossResult : (lossResult?.total || 0);
  const details = lossResult?.details || [];
  const byType  = lossResult?.byType  || {};

  if (loss < 1) {
    el.innerHTML = '<div class="ai su">✅ Aucune perte de revenu manifeste détectée sur la période</div>';
    return;
  }

  // Résumé par type
  const byTypeLines = [
    byType.ifd      > 0 ? `IFD oubliés : <strong>−${byType.ifd.toFixed(2)} €</strong>`           : '',
    byType.ik       > 0 ? `IK non cotés : <strong>−${byType.ik.toFixed(2)} €</strong>`            : '',
    byType.nuit     > 0 ? `Majorations nuit manquantes : <strong>−${byType.nuit.toFixed(2)} €</strong>` : '',
    byType.dimanche > 0 ? `Majorations dimanche : <strong>−${byType.dimanche.toFixed(2)} €</strong>`    : '',
  ].filter(Boolean);

  // Lignes détail (max 5 premières, hors ALD qui sont des alertes)
  const lossLines = details
    .filter(d => d.montant > 0)
    .slice(0, 5)
    .map(d => {
      const dateStr = d.date ? ` <span style="opacity:.6;font-size:11px">(${d.date.slice(0,10)})</span>` : '';
      const nomStr  = d.nom  ? ` — ${d.nom}` : '';
      return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,95,109,.1)">
        <span>• ${d.label}${nomStr}${dateStr}</span>
        <span style="flex-shrink:0;margin-left:12px;font-weight:600">−${d.montant.toFixed(2)} €</span>
      </div>`;
    }).join('');

  const moreCount = details.filter(d => d.montant > 0).length - 5;
  const moreStr   = moreCount > 0 ? `<div style="font-size:11px;color:var(--m);margin-top:4px">… et ${moreCount} autre(s) non affiché(s)</div>` : '';

  const aldAlert = details.some(d => d.type === 'ald')
    ? `<div class="ai wa" style="margin-top:8px;font-size:12px">⚠️ Incohérence ALD détectée — reste patient > 0 alors qu'exonération active</div>`
    : '';

  el.innerHTML = `
    <div class="ai er" style="flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span>🔔 <strong>Alertes revenus manqués</strong></span>
        <span style="font-size:16px;font-weight:700;color:#ff9aa2">−${loss.toFixed(2)} €</span>
      </div>
      ${byTypeLines.length ? `<div style="font-size:12px;display:flex;flex-wrap:wrap;gap:8px;opacity:.85">${byTypeLines.join(' · ')}</div>` : ''}
    </div>
    ${lossLines ? `<div style="margin-top:8px;font-size:12px;padding:8px 0">${lossLines}${moreStr}</div>` : ''}
    <div class="ai in" style="margin-top:8px;font-size:12px">
      💡 Ouvrez chaque soin concerné et utilisez <strong>"Vérifier soin"</strong> pour ajouter les éléments manquants.
    </div>
    ${aldAlert}`;
}

/* ============================================================
   10. PRÉVISION INTELLIGENTE (tendance linéaire)
   ============================================================ */
function forecastRevenue(daily) {
  const values=Object.values(daily);
  if (values.length<5) return null;
  const avg=values.reduce((a,b)=>a+b,0)/values.length;
  // Tendance = diff entre seconde moitié et première moitié
  const mid=Math.floor(values.length/2);
  const firstHalf=values.slice(0,mid).reduce((a,b)=>a+b,0)/(mid||1);
  const secondHalf=values.slice(mid).reduce((a,b)=>a+b,0)/(values.length-mid||1);
  const trend=secondHalf-firstHalf;
  const dayOfMonth=new Date().getDate();
  const daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate();
  const remaining=daysInMonth-dayOfMonth;
  const adjustedAvg=avg+(trend>0?avg*0.1:trend<0?-avg*0.1:0);
  const projection=Object.values(daily).reduce((a,b)=>a+b,0)+(adjustedAvg*remaining);
  return {avg, trend, projection};
}

/* ════════════════════════════════════════════════
   DASHBOARD CABINET — Statistiques multi-IDE
════════════════════════════════════════════════ */

async function loadDashCabinet() {
  const section = document.getElementById('dash-cabinet-section');
  if (!section) return;

  const cab = APP.get ? APP.get('cabinet') : null;
  if (!cab?.id) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  const kpisEl = document.getElementById('dash-cabinet-kpis');
  const revsEl = document.getElementById('dash-cabinet-ide-revenues');
  if (!kpisEl) return;

  let members = cab.members || [];
  const nbIDE     = members.length;
  const caEstime  = nbIDE * 280;

  // KPIs cabinet — même style .sc avec delta
  const kpis = [
    { icon: '🏥', val: nbIDE > 1 ? `${nbIDE} IDEs` : '1 IDE', label: 'Cabinet actif',       cls: 'g' },
    { icon: '👥', val: `${nbIDE} membre(s)`,                   label: 'IDEs',                cls: 'b' },
    { icon: '💶', val: `~${caEstime.toFixed(0)} €/j`,          label: 'CA estimé / jour',    cls: 'g' },
    { icon: '📅', val: `~${(caEstime*22).toFixed(0)} €`,       label: 'Projection mensuelle',cls: 'o' },
  ];
  kpisEl.innerHTML = kpis.map(k =>
    `<div class="sc ${k.cls}"><div class="si">${k.icon}</div><div class="sv">${k.val}</div><div class="sn">${k.label}</div></div>`
  ).join('');

  // Revenus par IDE — avatars colorés + barres
  if (revsEl) {
    const avatarColors = ['col-a', 'col-b', 'col-c', 'col-d', 'col-e'];
    const colorVars    = ['var(--a)', 'var(--a2)', 'var(--w)', 'var(--d)', 'var(--ok)'];
    revsEl.innerHTML = members.map((m, i) => {
      const colorVar = colorVars[i % 5];
      const pct      = Math.round(100 / members.length);
      const initials = ((m.prenom||'').charAt(0) + (m.nom||'').charAt(0)).toUpperCase();
      return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <div class="pt-avatar ${avatarColors[i%5]}" style="width:36px;height:36px;font-size:13px">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
            <span style="font-size:13px;font-weight:600">${m.prenom} ${m.nom}</span>
            <span style="font-size:13px;color:${colorVar};font-family:var(--fm);font-weight:600">~${caEstime.toFixed(0)} €/j</span>
          </div>
          <div style="height:6px;background:var(--b);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${colorVar};border-radius:3px;transition:width .5s"></div>
          </div>
          <div style="font-size:10px;color:var(--m);margin-top:3px;font-family:var(--fm)">${m.role==='titulaire'?'👑 Titulaire':'👤 Membre'}</div>
        </div>
      </div>`;
    }).join('') || '<div class="ai in" style="font-size:12px">Aucun membre.</div>';
  }

  runCabinetSimulator();
}

/**
 * runCabinetSimulator — simulateur revenus cabinet
 */
function runCabinetSimulator() {
  const el = document.getElementById('dash-cabinet-simulator-result');
  if (!el) return;

  const patientsJour = parseFloat(document.getElementById('sim-patients-jour')?.value) || 12;
  const nbIDE        = parseFloat(document.getElementById('sim-nb-ide')?.value)        || 2;
  const montantMoyen = parseFloat(document.getElementById('sim-montant-moyen')?.value) || 8.50;
  const jours        = parseFloat(document.getElementById('sim-jours')?.value)         || 22;

  const caJourIDE    = patientsJour * montantMoyen;
  const caJourCab    = caJourIDE * nbIDE;
  const caMoisCab    = caJourCab * jours;
  const caMoisIDE    = caJourIDE * jours;
  const gainOptim    = caMoisCab * 0.15;
  const caMoisOptim  = caMoisCab + gainOptim;
  const decotesEvitees = Math.round(patientsJour * nbIDE * jours * 0.15 * 3.15);

  // Barre de progression objectif
  const objectif = caMoisOptim;
  const pct = Math.min(100, Math.round(caMoisCab / objectif * 100));

  el.innerHTML = `
    <div class="sg" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));margin-bottom:14px">
      <div class="sc g"><div class="si">💶</div><div class="sv">${caMoisCab.toFixed(0)} €</div><div class="sn">CA mensuel cabinet</div></div>
      <div class="sc b"><div class="si">👤</div><div class="sv">${caMoisIDE.toFixed(0)} €</div><div class="sn">CA moyen / IDE</div></div>
      <div class="sc g"><div class="si">⚡</div><div class="sv">+${gainOptim.toFixed(0)} €</div><div class="sn">Gain optimisation IA</div><span class="sc-delta up">+15%</span></div>
      <div class="sc o"><div class="si">📉</div><div class="sv">+${decotesEvitees.toFixed(0)} €</div><div class="sn">Décotes évitées</div></div>
    </div>
    <!-- Barre objectif avec optimisation -->
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--m);margin-bottom:5px;font-family:var(--fm)">
        <span>CA actuel</span>
        <span style="color:var(--a)">Avec optimisation IA : <strong>${caMoisOptim.toFixed(0)} €/mois</strong></span>
      </div>
      <div style="height:8px;background:var(--b);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--a2),var(--a));border-radius:4px;transition:width .6s"></div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--m)">
      Basé sur ${patientsJour} patients/IDE/jour · ${montantMoyen.toFixed(2)} €/acte · ${jours} jours travaillés
    </div>`;
}

/**
 * runCabinetCATarget — simule comment atteindre un objectif CA mensuel
 */
function runCabinetCATarget() {
  const el = document.getElementById('dash-cabinet-ca-target-result');
  if (!el) return;

  const target  = parseFloat(document.getElementById('cab-ca-target')?.value) || 0;
  if (target <= 0) { el.innerHTML = ''; return; }

  const cab     = APP.get ? APP.get('cabinet') : null;
  const nbIDE   = cab?.members?.length || 1;
  const jours   = 22;
  const montant = 8.50;

  const currentEstim = nbIDE * 12 * montant * jours;
  const diff         = target - currentEstim;
  const reached      = currentEstim >= target;
  const pctAtteint   = Math.min(100, Math.round(currentEstim / target * 100));

  // Barre de progression toujours affichée
  const progressBar = `
    <div style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--m);margin-bottom:5px;font-family:var(--fm)">
        <span>Estimé : <strong style="color:var(--t)">${currentEstim.toFixed(0)} €</strong></span>
        <span>Objectif : <strong style="color:var(--t)">${target.toFixed(0)} €</strong></span>
      </div>
      <div style="height:8px;background:var(--b);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pctAtteint}%;background:${reached?'linear-gradient(90deg,var(--a),var(--ok))':'linear-gradient(90deg,var(--a2),var(--a))'};border-radius:4px;transition:width .6s"></div>
      </div>
      <div style="text-align:right;font-size:10px;color:var(--m);font-family:var(--fm);margin-top:3px">${pctAtteint}% de l'objectif</div>
    </div>`;

  if (reached) {
    el.innerHTML = `
      <div class="dash-alert-strip g" style="border-radius:10px;margin-bottom:0">
        <div class="dash-alert-dot"></div>
        <div class="dash-alert-text">✅ Objectif atteignable ! CA estimé <strong>${currentEstim.toFixed(0)} €</strong> ≥ ${target.toFixed(0)} €</div>
      </div>
      ${progressBar}`;
    return;
  }

  const patientsSupp   = Math.ceil(diff / (montant * jours * nbIDE));
  const actesMoyenSupp = diff / (nbIDE * 12 * jours);
  const joursSupp      = Math.ceil(diff / (nbIDE * 12 * montant));

  el.innerHTML = `
    <div class="dash-alert-strip" style="border-radius:10px;margin-bottom:12px">
      <div class="dash-alert-dot"></div>
      <div class="dash-alert-text">Il manque <strong>${diff.toFixed(0)} €</strong> pour atteindre l'objectif</div>
    </div>
    <div class="dash-section-title" style="margin-bottom:10px">Pour y arriver</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div class="acte-row-prem" style="gap:12px;align-items:center">
        <div style="font-size:14px;flex-shrink:0">📋</div>
        <div style="flex:1;font-size:12px"><strong>+${patientsSupp} patient(s)/IDE/jour</strong> <span style="color:var(--m)">→ soit ${12+patientsSupp} patients/j</span></div>
      </div>
      <div class="acte-row-prem" style="gap:12px;align-items:center">
        <div style="font-size:14px;flex-shrink:0">💶</div>
        <div style="flex:1;font-size:12px"><strong>+${actesMoyenSupp.toFixed(2)} €/acte moyen</strong> <span style="color:var(--m)">→ optimiser la cotation NGAP</span></div>
      </div>
      <div class="acte-row-prem" style="gap:12px;align-items:center">
        <div style="font-size:14px;flex-shrink:0">📅</div>
        <div style="flex:1;font-size:12px"><strong>+${joursSupp} jour(s)/mois</strong> <span style="color:var(--m)">→ soit ${jours+joursSupp} jours travaillés</span></div>
      </div>
      ${nbIDE < 3 ? `<div class="acte-row-prem" style="gap:12px;align-items:center;background:rgba(0,212,170,.04);border:1px solid rgba(0,212,170,.15);border-radius:8px;padding:8px 10px">
        <div style="font-size:14px;flex-shrink:0">🏥</div>
        <div style="flex:1;font-size:12px"><strong>Ajouter 1 IDE</strong> <span style="color:var(--a)">→ CA estimé : ${(currentEstim+currentEstim/nbIDE).toFixed(0)} €</span></div>
      </div>` : ''}
    </div>
    ${progressBar}`;
}

/* Déclencher le dashboard cabinet quand APP.cabinet change */
if (typeof APP !== 'undefined' && APP.on) {
  APP.on('cabinet', () => {
    const dashBody = document.getElementById('dash-body');
    if (dashBody && dashBody.style.display !== 'none') {
      loadDashCabinet();
    }
  });
}

/* ── Préférences km partagées — helpers dashboard ── */

/** Clé préférences km (même que tresorerie.js) */
function _kmPrefsKeyDash() {
  let uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
  if (!uid) { try { uid = JSON.parse(sessionStorage.getItem('ami')||'null')?.user?.id||null; } catch {} }
  return 'ami_km_prefs_' + String(uid||'local').replace(/[^a-zA-Z0-9_-]/g,'_');
}

/** Lire les préférences */
function _loadKmPrefsDash() {
  try { return JSON.parse(localStorage.getItem(_kmPrefsKeyDash())||'{}'); } catch { return {}; }
}

/** Sauvegarder depuis le dashboard */
function saveKmPrefsDash() {
  const cv         = parseInt(document.getElementById('dash-km-cv')?.value) || 5;
  const electrique = !!document.getElementById('dash-km-elec')?.checked;
  try { localStorage.setItem(_kmPrefsKeyDash(), JSON.stringify({ cv, electrique })); } catch {}
  _syncAllKmSelectors(cv, electrique);
  loadDash(); // recalculer
}

/** Sauvegarder depuis le rapport */
function saveKmPrefsRapport() {
  const cv         = parseInt(document.getElementById('rapport-km-cv')?.value) || 5;
  const electrique = !!document.getElementById('rapport-km-elec')?.checked;
  try { localStorage.setItem(_kmPrefsKeyDash(), JSON.stringify({ cv, electrique })); } catch {}
  _syncAllKmSelectors(cv, electrique);
  const period = document.getElementById('rapport-period')?.value || 'month';
  if (typeof _loadRapportKpis === 'function') _loadRapportKpis(period);
}

/** Synchroniser tous les sélecteurs CV/électrique sur la page */
function _syncAllKmSelectors(cv, electrique) {
  const selIds = ['km-cv','tresor-km-cv','rapport-km-cv','dash-km-cv'];
  const chkIds = ['km-electrique','tresor-km-elec','rapport-km-elec','dash-km-elec'];
  selIds.forEach(id => { const el = document.getElementById(id); if (el) el.value = cv; });
  chkIds.forEach(id => { const el = document.getElementById(id); if (el) el.checked = electrique; });
  // Mettre à jour les infos taux
  const bareme = {3:'3 CV · 0.529',4:'4 CV · 0.606',5:'5 CV · 0.636',6:'6 CV · 0.665',7:'7 CV et + · 0.697'};
  const lbl = (bareme[cv]||'5 CV · 0.636') + (electrique ? ' ⚡' : '') + ' €/km';
  ['tresor-km-rate-info','rapport-km-rate-info','dash-km-rate-info'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = 'Taux : ' + lbl;
  });
}

/** Initialiser les sélecteurs depuis les préférences au chargement */
function _initKmPrefsSelectors() {
  const prefs = _loadKmPrefsDash();
  if (prefs.cv || prefs.electrique) {
    _syncAllKmSelectors(parseInt(prefs.cv)||5, !!prefs.electrique);
  }
  // Afficher la barre km dashboard uniquement si des km existent
  // (géré dans renderDashboard — ici on initialise juste les selects)
}

/* ── setDashPeriod — gère la période pill ── */
function setDashPeriod(btn, period) {
  const sel = document.getElementById('dash-period');
  if (sel) sel.value = period;
  document.querySelectorAll('.dpp-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadDash();
}

/* ── setHistPeriod — période pill historique ── */
function setHistPeriod(btn, period) {
  const sel = document.getElementById('hp');
  if (sel) sel.value = period;
  // Mettre à jour uniquement les boutons dans le même conteneur parent
  if (btn) {
    btn.closest('.dash-period-pill')?.querySelectorAll('.dpp-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  if (typeof hist === 'function') hist();
}

/* ── histSetFilter — filtre rapide pills historique ── */
let _histFilter = 'all';
let _histSort   = 'date-desc';

function histSetFilter(btn, filter) {
  _histFilter = filter;
  document.querySelectorAll('.hist-filter-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _applyHistFilter();
}

function histToggleSort() {
  const orders = ['date-desc','date-asc','total-desc','total-asc'];
  const labels = ['Date ↓','Date ↑','Total ↓','Total ↑'];
  const idx = orders.indexOf(_histSort);
  _histSort = orders[(idx + 1) % orders.length];
  const lbl = document.getElementById('hist-sort-label');
  if (lbl) lbl.textContent = labels[(idx + 1) % orders.length];
  _applyHistFilter();
}

/* ⚡ Extrait la date+heure triables d'une row historique.
   Source : data-hist-date + data-hist-heure sur le bouton edit (.hist-edit-btn)
   posés au moment de la construction de la row dans index.html.
   Fallback : parsing de la cellule date si les dataset manquent. */
function _histRowDate(row) {
  try {
    const btn = row.querySelector('.hist-edit-btn');
    if (btn?.dataset.histDate) {
      const d = btn.dataset.histDate; // YYYY-MM-DD
      const h = btn.dataset.histHeure || '00:00';
      return new Date(`${d}T${h}:00`).getTime() || 0;
    }
    // Fallback texte (fragile mais robuste aux vieux rows)
    const txt = row.cells?.[1]?.textContent || '';
    const t = Date.parse(txt);
    return isFinite(t) ? t : 0;
  } catch { return 0; }
}

/* ⚡ Extrait le total € triable d'une row. Cellule .pt-ca contient "21.45 €". */
function _histRowTotal(row) {
  try {
    const cell = row.querySelector('.pt-ca');
    const txt = (cell?.textContent || '').replace(/[^\d,.-]/g, '').replace(',', '.');
    const v = parseFloat(txt);
    return isFinite(v) ? v : 0;
  } catch { return 0; }
}

function _applyHistFilter() {
  const tbody = document.getElementById('htb');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr[id^="hist-row-"]'));

  // ── 1. TRI — selon _histSort ────────────────────────────────────────────
  // On ne modifie PAS le tableau `rows` en place : on fait une copie triée
  // puis on réinsère les <tr> dans le tbody dans le nouvel ordre via
  // appendChild (qui déplace les nœuds sans les cloner, donc sans perdre
  // les listeners attachés aux boutons ✏️ / 🗑️).
  const sorted = [...rows].sort((a, b) => {
    switch (_histSort) {
      case 'date-asc':   return _histRowDate(a)  - _histRowDate(b);
      case 'date-desc':  return _histRowDate(b)  - _histRowDate(a);
      case 'total-asc':  return _histRowTotal(a) - _histRowTotal(b);
      case 'total-desc': return _histRowTotal(b) - _histRowTotal(a);
      default:           return _histRowDate(b)  - _histRowDate(a);
    }
  });
  // Réinsérer dans l'ordre trié (appendChild = move, pas copy)
  sorted.forEach(r => tbody.appendChild(r));

  // ── 2. FILTRE — selon _histFilter ───────────────────────────────────────
  sorted.forEach(row => {
    let show = true;
    if (_histFilter === 'ok') {
      // Statut conforme = dot vert présent
      show = row.querySelector('.pt-status.active') !== null;
    } else if (_histFilter === 'dre') {
      show = row.innerHTML.includes('DRE req');
    } else if (_histFilter === 'alerts') {
      // Badge rouge présent
      show = row.querySelector('[style*="255,95,109"]') !== null || row.innerHTML.includes('⚠');
    }
    row.style.display = show ? '' : 'none';
  });
}

/* ── setRapportPeriod — période pill rapport ── */
function setRapportPeriod(btn, period) {
  const sel = document.getElementById('rapport-period');
  if (sel) sel.value = period;
  if (btn) {
    btn.closest('.dash-period-pill')?.querySelectorAll('.dpp-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  // Mettre à jour le label et charger les KPIs
  const labels = {
    month: 'Ce mois',
    lastmonth: 'Mois précédent',
    '3month': '3 derniers mois',
    year: 'Cette année'
  };
  const note = document.getElementById('rapport-period-label');
  if (note) note.textContent = `${labels[period]||period} · NGAP 2026.1 · Prêt à exporter`;
  _loadRapportKpis(period);
}

/* ── _loadRapportKpis — charge et affiche les KPIs résumé ── */
async function _loadRapportKpis(period) {
  const el = document.getElementById('rapport-kpis');
  const note = document.getElementById('rapport-kpis-note');
  if (!el) return;
  el.innerHTML = `<div style="color:var(--m);font-size:12px;padding:8px 0">Chargement des KPIs...</div>`;
  try {
    const data = await fetchAPI(`/webhook/ami-historique?period=${period||'month'}`);
    const arr  = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    if (!arr.length) {
      el.innerHTML = '';
      if (note) note.textContent = 'Aucune donnée sur cette période.';
      return;
    }
    const total   = arr.reduce((s,r) => s + parseFloat(r.total||0), 0);
    const amo     = arr.reduce((s,r) => s + parseFloat(r.part_amo||0), 0);
    const count   = arr.length;
    const joursSet= new Set(arr.map(r=>(r.date_soin||'').slice(0,10)).filter(Boolean));
    const jours   = joursSet.size;
    const avg     = jours > 0 ? total / jours : 0;
    const dreCount= arr.filter(r=>r.dre_requise).length;

    el.innerHTML = [
      { icon:'💶', val:total.toFixed(0)+' €',  label:'CA période',      cls:'g' },
      { icon:'🏥', val:amo.toFixed(0)+' €',    label:'Part AMO',        cls:'b' },
      { icon:'📋', val:count,                   label:'Actes cotés',     cls:'b' },
      { icon:'📆', val:jours+'j',               label:'Jours travaillés',cls:'o' },
      { icon:'💹', val:avg.toFixed(0)+' €',     label:'CA/jour',         cls:'g' },
      ...(dreCount > 0 ? [{ icon:'📋', val:dreCount, label:'DRE à traiter', cls:'r' }] : []),
    ].map(k =>
      `<div class="sc ${k.cls}"><div class="si">${k.icon}</div><div class="sv">${k.val}</div><div class="sn">${k.label}</div></div>`
    ).join('');
    if (note) note.textContent = `${count} cotation${count>1?'s':''} · généré le ${new Date().toLocaleDateString('fr-FR')}`;
  } catch(e) {
    el.innerHTML = '';
    if (note) note.textContent = '';
  }
}

/* ⚡ Auto-tri après rechargement de l'historique.
   Sans ça, `hist()` reconstruit tbody.innerHTML avec l'ordre renvoyé par le
   backend et le bouton ↕ Date avait beau changer _histSort, il fallait re-cliquer
   pour que le tri s'applique. MutationObserver → à chaque nouveau contenu du
   tbody, on applique _histSort + _histFilter automatiquement. */
(function _setupHistAutoSort() {
  const tbody = document.getElementById('htb');
  if (!tbody) {
    // DOM pas encore prêt → retry
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _setupHistAutoSort);
    } else {
      setTimeout(_setupHistAutoSort, 500);
    }
    return;
  }
  let debounce;
  const obs = new MutationObserver(() => {
    // Debounce pour éviter de trier à chaque append individuel si hist()
    // fait du DOM batch. Aussi : ignorer si _applyHistFilter vient juste
    // de réordonner (sinon boucle infinie : tri → mutation → tri).
    if (tbody._sortingInProgress) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      tbody._sortingInProgress = true;
      try { _applyHistFilter(); } catch {}
      tbody._sortingInProgress = false;
    }, 60);
  });
  obs.observe(tbody, { childList: true });
})();

