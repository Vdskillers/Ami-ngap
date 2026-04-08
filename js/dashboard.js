/* dashboard.js — AMI NGAP v5.2 — DASH_CACHE_KEY déclarée une seule fois */
'use strict';

(function checkDeps(){
  if(typeof requireAuth==='undefined') console.error('dashboard.js : utils.js non chargé.');
  if(typeof fetchAPI==='undefined')    console.error('dashboard.js : fetchAPI manquant dans utils.js');
})();

/* ── Constante cache — UNE SEULE DÉCLARATION ── */
const DASH_CACHE_KEY = 'ami_dash_v1';

function saveDashCache(arr) {
  try { localStorage.setItem(DASH_CACHE_KEY, JSON.stringify({ t: Date.now(), data: arr })); } catch {}
}

function loadDashCache(maxAge) {
  maxAge = maxAge || 300000; // 5 min
  try {
    var raw = localStorage.getItem(DASH_CACHE_KEY);
    if (!raw) return null;
    var p = JSON.parse(raw);
    if (!p || !p.data) return null;
    return { data: p.data, expired: (Date.now() - p.t) > maxAge, age: Math.floor((Date.now() - p.t) / 1000) };
  } catch(e) { return null; }
}

/* ── loadDash v5 — fallback cache + messages état ── */
async function loadDash() {
  if (!requireAuth()) return;
  $('dash-loading').style.display = 'block';
  $('dash-body').style.display    = 'none';
  $('dash-empty').style.display   = 'none';

  var cache = loadDashCache();
  if (cache && cache.data && cache.data.length) {
    renderDashboard(cache.data);
    $('dash-loading').style.display = 'none';
    $('dash-body').style.display    = 'block';
    _showDashCacheInfo(cache.expired ? 'expired' : 'fresh', cache.age);
  }

  try {
    var res = await fetchAPI('/webhook/ami-historique?period=month');
    var arr = Array.isArray(res && res.data) ? res.data : Array.isArray(res) ? res : [];
    if (!arr.length) {
      if (!cache || !cache.data || !cache.data.length) {
        $('dash-loading').style.display = 'none';
        $('dash-empty').style.display   = 'block';
      }
      return;
    }
    saveDashCache(arr);
    renderDashboard(arr);
    _hideDashCacheInfo();
    $('dash-loading').style.display = 'none';
    $('dash-body').style.display    = 'block';
  } catch(e) {
    logErr('loadDash:', e.message);
    if (cache && cache.data && cache.data.length) {
      renderDashboard(cache.data);
      _showDashCacheInfo('offline', cache.age, e.message);
      $('dash-loading').style.display = 'none';
      $('dash-body').style.display    = 'block';
    } else {
      $('dash-loading').style.display = 'none';
      $('dash-empty').style.display   = 'block';
      $('dash-empty').innerHTML = '<div style="font-size:40px;margin-bottom:12px">⚠️</div><p>Impossible de charger les statistiques.<br><small style="color:var(--m)">'+e.message+'</small></p>';
    }
  }
}

function _showDashCacheInfo(type, ageSec, errorMsg) {
  var el = $('dash-cache-info');
  if (!el) return;
  var min = Math.floor((ageSec || 0) / 60);
  if (type === 'offline') {
    el.innerHTML = '🔴 Mode hors ligne — données en cache (' + min + ' min)' + (errorMsg ? ' · <small>' + errorMsg + '</small>' : '');
    el.style.cssText = 'display:block;font-size:11px;color:var(--d);margin-bottom:10px;padding:6px 12px;background:rgba(255,95,109,.08);border-radius:8px;border:1px solid rgba(255,95,109,.2)';
  } else if (type === 'expired') {
    el.innerHTML = '🟡 Données en cache (' + min + ' min) — actualisation en cours…';
    el.style.cssText = 'display:block;font-size:11px;color:var(--m);margin-bottom:8px;padding:4px 0';
  } else {
    el.style.display = 'none';
  }
}

function _hideDashCacheInfo() {
  var el = $('dash-cache-info');
  if (el) el.style.display = 'none';
}

function renderDashboard(arr) {
  var total=0, amo=0, amc=0, partPat=0, dre=0;
  var actesFreq={}, daily={};
  var today=new Date().toISOString().split('T')[0];
  var monthStr=today.slice(0,7);
  var todayRev=0, monthRev=0, best=0;
  arr.forEach(function(r) {
    var t=parseFloat(r.total||0);
    total+=t; amo+=parseFloat(r.part_amo||r.amo_amount||0); amc+=parseFloat(r.part_amc||r.amc_amount||0);
    partPat+=parseFloat(r.part_patient||0);
    if(r.dre_requise) dre++;
    if(best<t) best=t;
    if((r.date_soin||'').startsWith(today)) todayRev+=t;
    if((r.date_soin||'').startsWith(monthStr)) monthRev+=t;
    try { JSON.parse(r.actes||'[]').forEach(function(a){ if(a.code&&a.code!=='IMPORT') actesFreq[a.code]=(actesFreq[a.code]||0)+1; }); } catch(e){}
    var d=(r.date_soin||'').slice(0,10);
    if(d) daily[d]=(daily[d]||0)+t;
  });
  var avg = arr.length ? total/arr.length : 0;
  var dayOfMonth=new Date().getDate();
  var daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate();
  $('dash-kpis').innerHTML=[
    {icon:'💶',val:total.toFixed(2)+'€',label:'CA total (mois)',cls:'g'},
    {icon:'🏦',val:amo.toFixed(2)+'€',label:'Part AMO',cls:'b'},
    {icon:'🏥',val:amc.toFixed(2)+'€',label:'Part AMC',cls:'b'},
    {icon:'👤',val:partPat.toFixed(2)+'€',label:'Part Patient',cls:'o'},
    {icon:'☀️',val:todayRev.toFixed(2)+'€',label:'Revenus du jour',cls:'o'},
    {icon:'🏆',val:best.toFixed(2)+'€',label:'Meilleure facture',cls:'g'},
    {icon:'📋',val:dre,label:'DRE requises',cls:'r'},
    {icon:'📊',val:avg.toFixed(2)+'€',label:'Moy. par passage',cls:'b'},
  ].map(function(k){ return '<div class="sc '+k.cls+'"><div class="si">'+k.icon+'</div><div class="sv">'+k.val+'</div><div class="sn">'+k.label+'</div></div>'; }).join('');
  var days30=[];
  for(var i=29;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);days30.push(d.toISOString().split('T')[0]);}
  var vals=days30.map(function(d){ return daily[d]||0; });
  var maxVal=Math.max.apply(null,vals.concat([1]));
  $('dash-chart').innerHTML=vals.map(function(v,i){ return '<div style="flex:1;background:'+(v>0?'var(--a)':'var(--b)')+';border-radius:3px 3px 0 0;height:'+Math.max(4,Math.round(v/maxVal*140))+'px;opacity:'+(v>0?1:0.3)+';transition:height .3s;cursor:help" title="'+days30[i]+': '+v.toFixed(2)+'€"></div>'; }).join('');
  $('dash-chart-labels').innerHTML=days30.map(function(d,i){ return '<div style="flex:1;font-family:var(--fm);font-size:9px;color:var(--m);text-align:center;overflow:hidden">'+(i%7===0?d.slice(5):'')+'</div>'; }).join('');
  var topActes=Object.entries(actesFreq).sort(function(a,b){ return b[1]-a[1]; }).slice(0,6);
  var maxCount=topActes[0]?topActes[0][1]:1;
  $('dash-top-actes').innerHTML=topActes.length
    ? topActes.map(function(x){ return '<div class="ar"><div class="ac">'+x[0]+'</div><div class="an"><div style="height:6px;background:var(--a);border-radius:3px;width:'+Math.round(x[1]/maxCount*100)+'%;transition:width .4s"></div></div><div class="at" style="color:var(--a)">'+x[1]+'×</div></div>'; }).join('')
    : '<div class="ai wa">Aucune cotation enregistrée</div>';
  var forecast = forecastRevenue(daily);
  if (forecast) {
    var trendIcon = forecast.trend>0 ? '📈 hausse' : forecast.trend<0 ? '📉 baisse' : '➡️ stable';
    $('dash-prevision').innerHTML='📈 Projection fin de mois : <strong>'+forecast.projection.toFixed(2)+' €</strong> · Tendance : '+trendIcon+' · Moy/jour : <strong>'+forecast.avg.toFixed(2)+' €</strong> ('+( daysInMonth-dayOfMonth)+' jours restants)';
  } else {
    var prevision = dayOfMonth>0 ? (monthRev/dayOfMonth)*daysInMonth : 0;
    $('dash-prevision').innerHTML='📈 Sur la base de vos <strong>'+arr.length+' cotation(s)</strong> ce mois, prévision : <strong>'+prevision.toFixed(2)+' €</strong> ('+( daysInMonth-dayOfMonth)+' jours restants)';
  }
  var anomalyResult = detectAnomalies(arr, daily);
  renderAnomalies(anomalyResult);
  var explanations = explainAnomalies(arr, anomalyResult);
  var suggestions = suggestOptimizations(arr);
  renderAI(explanations, suggestions);
  var loss = computeLoss(arr);
  showLossAlert(loss);
}

function detectAnomalies(rows, daily) {
  var values = Object.values(daily);
  if (values.length < 5) return {avg:0, std:0, anomalies:[]};
  var avg = values.reduce(function(a,b){return a+b;},0)/values.length;
  var variance = values.reduce(function(a,v){return a+Math.pow(v-avg,2);},0)/values.length;
  var std = Math.sqrt(variance);
  var anomalies = [];
  Object.entries(daily).forEach(function(entry){
    var date=entry[0], val=entry[1];
    var score = std>0 ? Math.abs(val-avg)/std : 0;
    if (val < avg-2*std) anomalies.push({type:'critical_low',date:date,value:val,score:score.toFixed(1)});
    else if (val > avg+2*std) anomalies.push({type:'critical_high',date:date,value:val,score:score.toFixed(1)});
    else if (val < avg-std) anomalies.push({type:'warning_low',date:date,value:val,score:score.toFixed(1)});
  });
  return {avg:avg, std:std, anomalies:anomalies};
}

function renderAnomalies(result) {
  var el=$('dash-anomalies'); if (!el) return;
  if (!result||!result.anomalies.length) { el.innerHTML='<div class="ai su">✅ Aucun comportement anormal détecté sur la période</div>'; return; }
  el.innerHTML='<div style="font-size:12px;color:var(--m);margin-bottom:10px;font-family:var(--fm)">Moy/jour : '+result.avg.toFixed(2)+'€ · Écart-type : '+result.std.toFixed(2)+'€</div>'
    +result.anomalies.slice(0,8).map(function(a){
      if(a.type==='critical_low') return '<div class="ai er">🔴 Chute anormale le <strong>'+a.date+'</strong> : '+a.value.toFixed(2)+'€ <span style="font-size:10px;opacity:.7">(score: '+a.score+'σ)</span></div>';
      if(a.type==='critical_high') return '<div class="ai wa">🟠 Pic inhabituel le <strong>'+a.date+'</strong> : '+a.value.toFixed(2)+'€ <span style="font-size:10px;opacity:.7">(score: '+a.score+'σ)</span></div>';
      return '<div class="ai in">🟡 Activité faible le <strong>'+a.date+'</strong> : '+a.value.toFixed(2)+'€</div>';
    }).join('');
}

function explainAnomalies(rows, anomalyResult) {
  return (anomalyResult.anomalies||[]).map(function(a){
    var dayRows = rows.filter(function(r){ return (r.date_soin||'').startsWith(a.date); });
    var actesCount=0, dre=0, nuit=0, domicile=0;
    dayRows.forEach(function(r){
      if(r.dre_requise) dre++;
      var h=r.heure_soin||''; if(h&&(h<'08:00'||h>'20:00')) nuit++;
      try { var acts=JSON.parse(r.actes||'[]'); actesCount+=acts.length; acts.forEach(function(act){ if(act.code==='IFD') domicile++; }); } catch(e){}
    });
    var reason='', insights=[];
    if(a.type==='critical_low') {
      if(actesCount<3) reason="Très peu d'actes ce jour";
      else if(domicile===0){ reason="Absence d'IFD (indemnité déplacement)"; insights.push('Aucun IFD → perte possible sur déplacements'); }
      else reason='Volume ou valorisation anormalement faibles';
    } else if(a.type==='critical_high') {
      if(dre>0) reason='Soins complexes avec DRE (normal si ALD/maternité)';
      else if(nuit>0) reason='Actes de nuit majorés détectés';
      else reason='Montant inhabituel → vérifier conformité NGAP';
    } else { reason='Journée sous la moyenne habituelle'; }
    return Object.assign({},a,{reason:reason, insights:insights, actesCount:actesCount});
  });
}

function suggestOptimizations(rows) {
  var suggestions=[], seen=new Set();
  rows.forEach(function(r){
    var actes=r.actes||'', txt=(r.texte_soin||r.description||'').toLowerCase(), h=r.heure_soin||'';
    if((txt.includes('domicile')||txt.includes('chez'))&&!actes.includes('IFD')){ var k='ifd'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'lost_revenue',msg:'IFD (indemnité déplacement domicile) potentiellement oublié — +2,75 € par passage'});} }
    if(/\d+\s*km/.test(txt)&&!actes.includes('IK')){ var k='ik'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'lost_revenue',msg:'Kilométrage mentionné sans IK coté — +0,35 €/km'});} }
    if(h&&(h<'08:00'||h>'20:00')&&!actes.includes('majoration_nuit')&&!actes.includes('MN')){ var k='nuit'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'optimization',msg:'Acte de nuit sans majoration nuit (9,15 € ou 18,30 €) — vérifier'});} }
    if((r.exo==='ALD')&&parseFloat(r.part_patient||0)>0){ var k='ald'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'error',msg:'ALD détecté avec reste patient > 0 — incohérence facturation CPAM'});} }
    if(parseFloat(r.total||0)>150){ suggestions.push({type:'check',msg:'Montant élevé ('+parseFloat(r.total).toFixed(2)+'€ le '+(r.date_soin||'').slice(0,10)+') — vérifier conformité NGAP'}); }
    if(actes.includes('AIS')&&!actes.includes('BSA')&&!actes.includes('BSB')&&!actes.includes('BSC')){ var k='ais'; if(!seen.has(k)){seen.add(k);suggestions.push({type:'optimization',msg:'AIS coté sans forfait BS — BSA (+13€) possible si dépendance légère'});} }
  });
  return suggestions;
}

function renderAI(explanations, suggestions) {
  var el=$('dash-ai'); if (!el) return;
  var html='';
  if (explanations.length) {
    html+='<div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin-bottom:8px">Explications anomalies</div>';
    explanations.forEach(function(e){
      var icon=e.type==='critical_low'?'🔴':e.type==='critical_high'?'🟠':'🟡';
      html+='<div class="ai wa" style="margin-bottom:6px">'+icon+' <strong>'+e.date+'</strong> — '+e.reason+(e.actesCount?' ('+e.actesCount+' acte(s))':'')+'</div>';
      e.insights.forEach(function(ins){ html+='<div class="ai in" style="margin-bottom:4px;margin-left:20px">💡 '+ins+'</div>'; });
    });
  }
  if (suggestions.length) {
    html+='<div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin:14px 0 8px">Optimisations NGAP détectées</div>';
    suggestions.slice(0,8).forEach(function(s){
      var icon=s.type==='error'?'❌':s.type==='lost_revenue'?'💸':s.type==='check'?'🔍':'💡';
      html+='<div class="ai '+(s.type==='error'?'er':s.type==='lost_revenue'?'wa':'in')+'" style="margin-bottom:6px">'+icon+' '+s.msg+'</div>';
    });
  }
  if (!html) html='<div class="ai su">✅ Aucun problème ou optimisation détecté</div>';
  el.innerHTML=html;
}

function computeLoss(rows) {
  var loss=0;
  rows.forEach(function(r){
    var txt=(r.texte_soin||r.description||'').toLowerCase(), actes=r.actes||'', h=r.heure_soin||'';
    if((txt.includes('domicile')||txt.includes('chez'))&&!actes.includes('IFD')) loss+=2.75;
    if(/\d+\s*km/.test(txt)&&!actes.includes('IK')) loss+=3.5;
    if(h&&(h<'08:00'||h>'20:00')&&!actes.includes('majoration_nuit')&&!actes.includes('MN')) loss+=9.15;
  });
  return loss;
}

function showLossAlert(loss) {
  var el=$('dash-loss'); if (!el) return;
  if (loss<5) { el.innerHTML='<div class="ai su">✅ Aucune perte de revenu manifeste détectée</div>'; return; }
  el.innerHTML='<div class="ai er">🔔 Perte estimée : <strong>'+loss.toFixed(2)+' €</strong> sur la période analysée</div><div class="ai in" style="margin-top:6px;font-size:12px">💡 Sources possibles : IFD oubliés · IK non cotés · Majorations nuit manquantes.</div>';
}

function forecastRevenue(daily) {
  var values=Object.values(daily);
  if (values.length<5) return null;
  var avg=values.reduce(function(a,b){return a+b;},0)/values.length;
  var mid=Math.floor(values.length/2);
  var firstHalf=values.slice(0,mid).reduce(function(a,b){return a+b;},0)/(mid||1);
  var secondHalf=values.slice(mid).reduce(function(a,b){return a+b;},0)/((values.length-mid)||1);
  var trend=secondHalf-firstHalf;
  var dayOfMonth=new Date().getDate();
  var daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate();
  var remaining=daysInMonth-dayOfMonth;
  var adjustedAvg=avg+(trend>0?avg*0.1:trend<0?-avg*0.1:0);
  var projection=Object.values(daily).reduce(function(a,b){return a+b;},0)+(adjustedAvg*remaining);
  return {avg:avg, trend:trend, projection:projection};
}
