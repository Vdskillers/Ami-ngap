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
  $('dash-prevision').innerHTML = `<span style="color:var(--m)">— Projection disponible avec des données réelles</span>`;

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
    try { JSON.parse(r.actes||'[]').forEach(a=>{ if(a.code&&a.code!=='IMPORT') actesFreq[a.code]=(actesFreq[a.code]||0)+1; }); } catch{}
    const d=(r.date_soin||'').slice(0,10);
    if(d) daily[d]=(daily[d]||0)+t;
  });

  const avg = arr.length ? total/arr.length : 0;
  const dayOfMonth=new Date().getDate();
  const daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate();

  // ── Km du mois depuis le journal kilométrique ──────────────────────────
  let kmMois = 0, kmDeduction = 0;
  try {
    const kmEntries = JSON.parse(localStorage.getItem('ami_km_journal') || '[]');
    const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    kmEntries.filter(e => new Date(e.date) >= since).forEach(e => { kmMois += parseFloat(e.km||0); });
    kmDeduction = Math.round(kmMois * 0.636 * 100) / 100;
    kmMois = Math.round(kmMois * 10) / 10;
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

  // KPIs enrichis + km
  $('dash-kpis').innerHTML=[
    {icon:'💶',val:total.toFixed(2)+'€',label:'CA total (mois)',cls:'g'},
    {icon:'🏦',val:amo.toFixed(2)+'€',label:'Part AMO',cls:'b'},
    {icon:'🏥',val:amc.toFixed(2)+'€',label:'Part AMC',cls:'b'},
    {icon:'👤',val:partPat.toFixed(2)+'€',label:'Part Patient',cls:'o'},
    {icon:'☀️',val:todayRev.toFixed(2)+'€',label:'Revenus du jour',cls:'o'},
    {icon:'🏆',val:best.toFixed(2)+'€',label:'Meilleure facture',cls:'g'},
    {icon:'📋',val:dre,label:'DRE requises',cls:'r'},
    {icon:'📊',val:avg.toFixed(2)+'€',label:'Moy. par passage',cls:'b'},
    ...(kmMois>0 ? [{icon:'🚗',val:kmMois+'km',label:'Km ce mois',cls:'b'}] : []),
    ...(kmDeduction>0 ? [{icon:'💸',val:kmDeduction+'€',label:'Déd. fiscale km',cls:'g'}] : []),
  ].map(k=>`<div class="sc ${k.cls}"><div class="si">${k.icon}</div><div class="sv">${k.val}</div><div class="sn">${k.label}</div></div>`).join('');

  // Graphique 30 jours
  const days30=[];
  for(let i=29;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);days30.push(d.toISOString().split('T')[0]);}
  const vals=days30.map(d=>daily[d]||0);
  const maxVal=Math.max(...vals,1);
  $('dash-chart').innerHTML=vals.map((v,i)=>`<div style="flex:1;background:${v>0?'var(--a)':'var(--b)'};border-radius:3px 3px 0 0;height:${Math.max(4,Math.round(v/maxVal*140))}px;opacity:${v>0?1:0.3};transition:height .3s;cursor:help" title="${days30[i]}: ${v.toFixed(2)}€"></div>`).join('');
  $('dash-chart-labels').innerHTML=days30.map((d,i)=>`<div style="flex:1;font-family:var(--fm);font-size:9px;color:var(--m);text-align:center;overflow:hidden">${i%7===0?d.slice(5):''}</div>`).join('');

  // Top actes
  const topActes=Object.entries(actesFreq).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxCount=topActes[0]?.[1]||1;
  $('dash-top-actes').innerHTML=topActes.length
    ? topActes.map(([code,count])=>`<div class="ar"><div class="ac">${code}</div><div class="an"><div style="height:6px;background:var(--a);border-radius:3px;width:${Math.round(count/maxCount*100)}%;transition:width .4s"></div></div><div class="at" style="color:var(--a)">${count}×</div></div>`).join('')
    : '<div class="ai wa">Aucune cotation enregistrée</div>';

  // Bandeau km si données disponibles
  const kmBandeau = $('dash-km-bandeau');
  if (kmBandeau) {
    kmBandeau.style.display = kmMois > 0 ? 'flex' : 'none';
    if (kmMois > 0) kmBandeau.innerHTML = `🚗 <strong>${kmMois} km</strong> parcourus ce mois · déduction fiscale estimée : <strong style="color:#22c55e">${kmDeduction} €</strong> (barème 5CV 2025) · <span id="dash-km-patients" style="color:var(--m)"></span>`;
  }

  // Prévision intelligente
  const forecast = forecastRevenue(daily);
  if (forecast) {
    const trendIcon = forecast.trend>0 ? '📈 hausse' : forecast.trend<0 ? '📉 baisse' : '➡️ stable';
    $('dash-prevision').innerHTML=`📈 Projection fin de mois : <strong>${forecast.projection.toFixed(2)} €</strong> · Tendance : ${trendIcon} · Moy/jour : <strong>${forecast.avg.toFixed(2)} €</strong> (${daysInMonth-dayOfMonth} jours restants)`;
  } else {
    const prevision = dayOfMonth>0 ? (monthRev/dayOfMonth)*daysInMonth : 0;
    $('dash-prevision').innerHTML=`📈 Sur la base de vos <strong>${arr.length} cotation(s)</strong> ce mois, prévision : <strong>${prevision.toFixed(2)} €</strong> (${daysInMonth-dayOfMonth} jours restants)`;
  }

  // Modules IA
  const anomalyResult = detectAnomalies(arr, daily);
  renderAnomalies(anomalyResult);
  const explanations = explainAnomalies(arr, anomalyResult);
  const suggestions = suggestOptimizations(arr);
  renderAI(explanations, suggestions);
  const loss = computeLoss(arr);
  showLossAlert(loss);

  // Notice admin si applicable
  const isAdmin = typeof S !== 'undefined' && S?.role === 'admin';
  const notice = $('dash-admin-notice');
  if (notice) notice.style.display = isAdmin ? 'flex' : 'none';
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
  el.innerHTML=`<div style="font-size:12px;color:var(--m);margin-bottom:10px;font-family:var(--fm)">Moy/jour : ${avg}€ · Écart-type : ${std}€</div>`
    +result.anomalies.slice(0,8).map(a=>{
      if(a.type==='critical_low') return`<div class="ai er">🔴 Chute anormale le <strong>${a.date}</strong> : ${a.value.toFixed(2)}€ <span style="font-size:10px;opacity:.7">(score: ${a.score}σ)</span></div>`;
      if(a.type==='critical_high') return`<div class="ai wa">🟠 Pic inhabituel le <strong>${a.date}</strong> : ${a.value.toFixed(2)}€ <span style="font-size:10px;opacity:.7">(score: ${a.score}σ)</span></div>`;
      return`<div class="ai in">🟡 Activité faible le <strong>${a.date}</strong> : ${a.value.toFixed(2)}€</div>`;
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
        const acts=JSON.parse(r.actes||'[]');
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
    if(h&&(h<'08:00'||h>'20:00')&&!actes.includes('majoration_nuit')&&!actes.includes('MN')) {
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
  let html='';

  if (explanations.length) {
    html+='<div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin-bottom:8px">Explications anomalies</div>';
    explanations.forEach(e=>{
      const icon=e.type==='critical_low'?'🔴':e.type==='critical_high'?'🟠':'🟡';
      html+=`<div class="ai wa" style="margin-bottom:6px">${icon} <strong>${e.date}</strong> — ${e.reason}${e.actesCount?' ('+e.actesCount+' acte(s))':''}</div>`;
      e.insights.forEach(ins=>{ html+=`<div class="ai in" style="margin-bottom:4px;margin-left:20px">💡 ${ins}</div>`; });
    });
  }

  if (suggestions.length) {
    html+='<div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin:14px 0 8px">Optimisations NGAP détectées</div>';
    suggestions.slice(0,8).forEach(s=>{
      const icon=s.type==='error'?'❌':s.type==='lost_revenue'?'💸':s.type==='check'?'🔍':'💡';
      html+=`<div class="ai ${s.type==='error'?'er':s.type==='lost_revenue'?'wa':'in'}" style="margin-bottom:6px">${icon} ${s.msg}</div>`;
    });
  }

  if (!html) html='<div class="ai su">✅ Aucun problème ou optimisation détecté</div>';
  el.innerHTML=html;
}

/* ============================================================
   9. CALCUL PERTE ESTIMÉE + ALERTE
   ============================================================ */
function computeLoss(rows) {
  let loss=0;
  rows.forEach(r=>{
    const txt=(r.texte_soin||r.description||'').toLowerCase();
    const actes=r.actes||'';
    const h=r.heure_soin||'';
    if((txt.includes('domicile')||txt.includes('chez'))&&!actes.includes('IFD')) loss+=2.75;
    if(/\d+\s*km/.test(txt)&&!actes.includes('IK')) loss+=3.5;
    if(h&&(h<'08:00'||h>'20:00')&&!actes.includes('majoration_nuit')&&!actes.includes('MN')) loss+=9.15;
  });
  return loss;
}

function showLossAlert(loss) {
  const el=$('dash-loss');
  if (!el) return;
  if (loss<5) {
    el.innerHTML='<div class="ai su">✅ Aucune perte de revenu manifeste détectée</div>';
    return;
  }
  el.innerHTML=`<div class="ai er">🔔 Perte estimée : <strong>${loss.toFixed(2)} €</strong> sur la période analysée</div>
    <div class="ai in" style="margin-top:6px;font-size:12px">💡 Sources possibles : IFD oubliés · IK non cotés · Majorations nuit manquantes. Utilisez "Vérifier soin" pour corriger.</div>`;
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
