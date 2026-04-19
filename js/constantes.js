/* ════════════════════════════════════════════════
   constantes.js — AMI v1.0
   ────────────────────────────────────════════════
   Module Suivi des Constantes Patients
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Saisie : TA, glycémie, SpO2, poids, T°, EVA
   2. Graphiques d'évolution 30/90 jours (Canvas)
   3. Alertes seuils personnalisables par patient
   4. Historique avec export CSV
   5. Intégration dans fiche patient
   6. 100% local IDB
   ────────────────────────────────────────────────
════════════════════════════════════════════════ */

const CONST_STORE = 'constantes';

async function _constDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_constantes', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONST_STORE)) {
        const s = db.createObjectStore(CONST_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
        s.createIndex('date',       'date',        { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _constSave(obj) {
  const db = await _constDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONST_STORE, 'readwrite');
    const req = tx.objectStore(CONST_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _constGetAll(patientId, days = 90) {
  const db  = await _constDb();
  const uid = APP?.user?.id || '';
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CONST_STORE, 'readonly');
    const idx = tx.objectStore(CONST_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => resolve(
      (e.target.result||[])
        .filter(c => c.user_id === uid && c.date >= since)
        .sort((a,b) => new Date(a.date) - new Date(b.date))
    );
    req.onerror = e => reject(e.target.error);
  });
}

async function _constDelete(id) {
  const db = await _constDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONST_STORE, 'readwrite');
    tx.objectStore(CONST_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = e  => reject(e.target.error);
  });
}

/* ── Seuils normaux de référence ─────────────── */
const SEUILS = {
  ta_sys:    { min: 90,  max: 140, unit: 'mmHg', label: 'TA Systolique' },
  ta_dia:    { min: 60,  max: 90,  unit: 'mmHg', label: 'TA Diastolique' },
  glycemie:  { min: 0.7, max: 1.8, unit: 'g/L',  label: 'Glycémie' },
  spo2:      { min: 94,  max: 100, unit: '%',     label: 'SpO2' },
  poids:     { min: null,max: null,unit: 'kg',    label: 'Poids' },
  temperature:{ min: 36, max: 37.5,unit: '°C',   label: 'Température' },
  eva:       { min: null,max: 3,   unit: '/10',   label: 'Douleur EVA' },
  fc:        { min: 50,  max: 100, unit: 'bpm',   label: 'Fréquence cardiaque' },
};

let _constCurrentPatient = null;
let _constPeriod = 30;

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderConstantes() {
  const wrap = document.getElementById('constantes-root');
  if (!wrap) return;

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Constantes <em>patients</em></h1>
    <p class="ps">TA · Glycémie · SpO2 · Poids · Température · Douleur · Graphiques évolution</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🔒</span><p>Constantes stockées localement sur votre appareil. Aucune donnée médicale ne quitte votre terminal.</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient</div>
      <select id="const-patient-sel" onchange="constSelectPatient(this.value)" style="width:100%;margin-bottom:20px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <!-- Formulaire saisie -->
      <div id="const-form-section" style="display:none">
        <div class="lbl" style="margin-bottom:12px">📊 Nouvelle mesure</div>
        <div class="fg" style="margin-bottom:16px">
          <div class="f"><label>TA Systolique (mmHg)</label><input type="number" id="const-ta-sys" placeholder="120" min="50" max="250" step="1" style="font-size:14px"></div>
          <div class="f"><label>TA Diastolique (mmHg)</label><input type="number" id="const-ta-dia" placeholder="80" min="30" max="150" step="1" style="font-size:14px"></div>
          <div class="f"><label>Glycémie (g/L)</label><input type="number" id="const-gly" placeholder="1.10" min="0.2" max="6" step="0.01" style="font-size:14px"></div>
          <div class="f"><label>SpO2 (%)</label><input type="number" id="const-spo2" placeholder="98" min="70" max="100" step="1" style="font-size:14px"></div>
          <div class="f"><label>Poids (kg)</label><input type="number" id="const-poids" placeholder="70" min="10" max="300" step="0.1" style="font-size:14px"></div>
          <div class="f"><label>Température (°C)</label><input type="number" id="const-temp" placeholder="36.8" min="34" max="42" step="0.1" style="font-size:14px"></div>
          <div class="f"><label>FC (bpm)</label><input type="number" id="const-fc" placeholder="72" min="20" max="200" step="1" style="font-size:14px"></div>
          <div class="f"><label>Douleur EVA (0-10)</label><input type="range" id="const-eva" min="0" max="10" step="1" value="0" oninput="document.getElementById('const-eva-val').textContent=this.value" style="accent-color:var(--a)"><span style="font-size:12px;color:var(--m);margin-left:8px">→ <span id="const-eva-val">0</span>/10</span></div>
          <div class="f"><label>Date / Heure</label><input type="datetime-local" id="const-date" value="${new Date().toISOString().slice(0,16)}"></div>
          <div class="f"><label>Remarques</label><input type="text" id="const-note" placeholder="Observation, contexte..."></div>
        </div>
        <div id="const-alert-banner" style="display:none"></div>
        <div class="ar-row">
          <button class="btn bp" onclick="constSave()"><span>💾</span> Enregistrer</button>
          <button class="btn bs" onclick="constResetForm()">↺ Effacer</button>
        </div>
      </div>
    </div>

    <!-- Graphiques et historique -->
    <div id="const-graphs-wrap" class="card" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
        <div class="lbl">📈 Évolution</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="const-period-sel" onchange="_constChangePeriod(this.value)" style="padding:6px 10px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fm)">
            <option value="14">14 jours</option>
            <option value="30" selected>30 jours</option>
            <option value="90">90 jours</option>
          </select>
          <button class="btn bs bsm" onclick="constExportCSV()">⬇ CSV</button>
        </div>
      </div>
      <div id="const-graphs" style="display:flex;flex-direction:column;gap:20px"></div>

      <!-- Tableau historique -->
      <div class="lbl" style="margin-bottom:10px;margin-top:20px">📋 Historique des mesures</div>
      <div id="const-history-table" style="overflow-x:auto"></div>
    </div>
  `;
}

async function constSelectPatient(pid) {
  _constCurrentPatient = pid || null;
  const formSec  = document.getElementById('const-form-section');
  const graphWrap = document.getElementById('const-graphs-wrap');
  if (!pid) {
    if (formSec) formSec.style.display = 'none';
    if (graphWrap) graphWrap.style.display = 'none';
    return;
  }
  if (formSec) formSec.style.display = 'block';
  if (graphWrap) graphWrap.style.display = 'block';
  await constRefresh();
}

async function _constChangePeriod(val) {
  _constPeriod = parseInt(val) || 30;
  await constRefresh();
}

async function constRefresh() {
  if (!_constCurrentPatient) return;
  const data = await _constGetAll(_constCurrentPatient, _constPeriod);
  constRenderGraphs(data);
  constRenderTable(data);
}

/* ── Graphique Canvas minimaliste ────────────── */
function _drawLineChart(canvasId, data, label, color, unit, minRef, maxRef) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PAD = { t:20, r:20, b:30, l:50 };
  const vals = data.map(d => parseFloat(d));
  const minV = Math.min(...vals, minRef||vals[0]) * 0.95;
  const maxV = Math.max(...vals, maxRef||vals[0]) * 1.05;
  const toX = i => PAD.l + (i / Math.max(data.length-1,1)) * (W - PAD.l - PAD.r);
  const toY = v => PAD.t + (1 - (v-minV)/(maxV-minV||1)) * (H - PAD.t - PAD.b);
  ctx.clearRect(0,0,W,H);

  // Zones normales
  if (minRef != null && maxRef != null) {
    ctx.fillStyle = 'rgba(0,212,170,0.07)';
    ctx.fillRect(PAD.l, toY(maxRef), W-PAD.l-PAD.r, toY(minRef)-toY(maxRef));
  }

  // Grille
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i=0;i<4;i++) {
    const y = PAD.t + (i/3)*(H-PAD.t-PAD.b);
    ctx.beginPath(); ctx.moveTo(PAD.l,y); ctx.lineTo(W-PAD.r,y); ctx.stroke();
    const v = maxV - (i/3)*(maxV-minV);
    ctx.fillStyle='rgba(255,255,255,0.35)';ctx.font='10px var(--fm,monospace)';
    ctx.fillText(v.toFixed(unit==='g/L'?2:0),2,y+4);
  }

  // Ligne
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  data.forEach((d,i) => {
    const x=toX(i), y=toY(parseFloat(d));
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.stroke();

  // Points + alertes
  data.forEach((d,i) => {
    const v=parseFloat(d), x=toX(i), y=toY(v);
    const isAlert = (minRef!=null && v<minRef) || (maxRef!=null && v>maxRef);
    ctx.beginPath();
    ctx.arc(x,y,isAlert?5:3,0,Math.PI*2);
    ctx.fillStyle = isAlert ? '#ef4444' : color;
    ctx.fill();
  });
}

function constRenderGraphs(data) {
  const el = document.getElementById('const-graphs');
  if (!el) return;
  if (!data.length) { el.innerHTML = '<div class="empty"><p>Aucune mesure enregistrée sur cette période.</p></div>'; return; }

  const metrics = [
    { key: 'ta_sys',      label:'TA Systolique',    unit:'mmHg', color:'#4f8eff', min: 90, max:140 },
    { key: 'ta_dia',      label:'TA Diastolique',   unit:'mmHg', color:'#60a5fa', min: 60, max: 90 },
    { key: 'glycemie',    label:'Glycémie',          unit:'g/L',  color:'#f59e0b', min:0.7, max:1.8 },
    { key: 'spo2',        label:'SpO2',              unit:'%',    color:'#00d4aa', min: 94, max:100 },
    { key: 'temperature', label:'Température',       unit:'°C',   color:'#f97316', min: 36, max:37.5 },
    { key: 'fc',          label:'Fréquence cardiaque',unit:'bpm', color:'#a78bfa', min: 50, max:100 },
    { key: 'eva',         label:'Douleur EVA',       unit:'/10',  color:'#ef4444', min:null,max: 3 },
    { key: 'poids',       label:'Poids',             unit:'kg',   color:'#94a3b8', min:null,max:null },
  ];

  el.innerHTML = metrics.filter(m => data.some(d => d[m.key] != null && d[m.key] !== '')).map(m => {
    const pts = data.filter(d => d[m.key] != null && d[m.key] !== '');
    const last = pts[pts.length-1]?.[m.key];
    const isAlert = last != null && ((m.min != null && last < m.min) || (m.max != null && last > m.max));
    return `
      <div style="background:var(--s);border:1px solid ${isAlert?'rgba(239,68,68,.4)':'var(--b)'};border-radius:10px;padding:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:13px;font-weight:600;color:var(--t)">${m.label}</div>
          <div style="font-family:var(--fs);font-size:20px;color:${isAlert?'#ef4444':m.color}">${last != null ? last+' '+m.unit : '—'} ${isAlert?'⚠️':''}</div>
        </div>
        <canvas id="chart-${m.key}" width="400" height="100" style="width:100%;height:100px;display:block"></canvas>
        <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-top:6px">${pts.length} mesure(s) · ${m.min!=null?`Norme : ${m.min}–${m.max} ${m.unit}`:'Valeur de référence variable'}</div>
      </div>`;
  }).join('') || '<div class="empty"><p>Aucune donnée à afficher.</p></div>';

  // Dessiner les graphiques après rendu DOM
  setTimeout(() => {
    metrics.forEach(m => {
      const pts = data.filter(d => d[m.key] != null && d[m.key] !== '');
      if (pts.length < 2) return;
      _drawLineChart(`chart-${m.key}`, pts.map(d=>d[m.key]), m.label, m.color, m.unit, m.min, m.max);
    });
  }, 80);
}

function constRenderTable(data) {
  const el = document.getElementById('const-history-table');
  if (!el) return;
  if (!data.length) { el.innerHTML = '<div class="empty"><p>Aucune mesure.</p></div>'; return; }
  const reversed = [...data].reverse().slice(0, 30);
  el.innerHTML = `<table style="border-collapse:collapse;width:100%;font-size:12px;font-family:var(--fm)">
    <thead><tr style="background:var(--s)">
      <th style="padding:8px;border:1px solid var(--b);text-align:left;color:var(--m)">Date</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">TA</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">Gly.</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">SpO2</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">T°</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">FC</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">EVA</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">Poids</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)">Note</th>
      <th style="padding:8px;border:1px solid var(--b);color:var(--m)"></th>
    </tr></thead>
    <tbody>
    ${reversed.map(r => {
      const d = new Date(r.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      const ta = r.ta_sys && r.ta_dia ? `${r.ta_sys}/${r.ta_dia}` : '—';
      const alertCell = (v, min, max) => v != null && v !== '' && ((min!=null&&v<min)||(max!=null&&v>max)) ? 'color:#ef4444;font-weight:700' : 'color:var(--t)';
      return `<tr>
        <td style="padding:6px 8px;border:1px solid var(--b)">${d}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center;${alertCell(r.ta_sys,90,140)}">${ta}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center;${alertCell(r.glycemie,0.7,1.8)}">${r.glycemie||'—'}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center;${alertCell(r.spo2,94,100)}">${r.spo2!=null?r.spo2+'%':'—'}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center;${alertCell(r.temperature,36,37.5)}">${r.temperature||'—'}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center;${alertCell(r.fc,50,100)}">${r.fc||'—'}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center;${alertCell(r.eva,null,3)}">${r.eva!=null?r.eva+'/10':'—'}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center">${r.poids!=null?r.poids+'kg':'—'}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);font-size:11px;color:var(--m)">${r.note||''}</td>
        <td style="padding:6px 8px;border:1px solid var(--b);text-align:center"><button onclick="constDeleteMeasure(${r.id})" style="background:none;border:none;color:var(--d);cursor:pointer;font-size:13px">🗑</button></td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

async function constSave() {
  if (!_constCurrentPatient) { showToast('warning','Patient requis'); return; }
  const get = id => { const v = document.getElementById(id)?.value; return v !== '' ? v : null; };
  const obj = {
    patient_id:  _constCurrentPatient,
    user_id:     APP?.user?.id || '',
    date:        get('const-date') || new Date().toISOString(),
    ta_sys:      get('const-ta-sys') != null ? parseFloat(get('const-ta-sys')) : null,
    ta_dia:      get('const-ta-dia') != null ? parseFloat(get('const-ta-dia')) : null,
    glycemie:    get('const-gly')    != null ? parseFloat(get('const-gly'))    : null,
    spo2:        get('const-spo2')   != null ? parseFloat(get('const-spo2'))   : null,
    poids:       get('const-poids')  != null ? parseFloat(get('const-poids'))  : null,
    temperature: get('const-temp')   != null ? parseFloat(get('const-temp'))   : null,
    fc:          get('const-fc')     != null ? parseFloat(get('const-fc'))     : null,
    eva:         parseInt(document.getElementById('const-eva')?.value || '0'),
    note:        document.getElementById('const-note')?.value?.trim() || '',
  };

  // Vérifier alertes avant save
  const alerts = [];
  if (obj.ta_sys  && obj.ta_sys  > 180) alerts.push('TA systolique très élevée (>180 mmHg)');
  if (obj.ta_sys  && obj.ta_sys  < 80)  alerts.push('TA systolique basse (<80 mmHg)');
  if (obj.spo2    && obj.spo2    < 90)  alerts.push('SpO2 critique (<90%) — contacter le médecin');
  if (obj.glycemie&& obj.glycemie< 0.6) alerts.push('Hypoglycémie sévère (<0.6 g/L) — intervention urgente');
  if (obj.glycemie&& obj.glycemie> 3.0) alerts.push('Hyperglycémie sévère (>3.0 g/L)');

  if (alerts.length) {
    const banner = document.getElementById('const-alert-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = `<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px;margin-bottom:12px">${alerts.map(a=>`<div style="font-size:12px;color:#ef4444;margin-bottom:4px">⚠️ ${a}</div>`).join('')}</div>`;
    }
  } else {
    const banner = document.getElementById('const-alert-banner');
    if (banner) banner.style.display = 'none';
  }

  try {
    await _constSave(obj);
    // ── Écriture dans la fiche patient du carnet ──────────────────────
    if (typeof patientAddConstante === 'function') {
      await patientAddConstante(_constCurrentPatient, obj);
    }
    showToast('success', 'Constantes enregistrées', alerts.length ? '⚠️ Alertes détectées' : undefined);
    constResetForm();
    await constRefresh();
  } catch (err) {
    showToast('error', 'Erreur', err.message);
  }
}

function constResetForm() {
  ['const-ta-sys','const-ta-dia','const-gly','const-spo2','const-poids','const-temp','const-fc','const-note'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const eva = document.getElementById('const-eva');
  if (eva) { eva.value = '0'; document.getElementById('const-eva-val').textContent = '0'; }
  const dt = document.getElementById('const-date');
  if (dt) dt.value = new Date().toISOString().slice(0,16);
  const banner = document.getElementById('const-alert-banner');
  if (banner) banner.style.display = 'none';
}

async function constDeleteMeasure(id) {
  if (!confirm('Supprimer cette mesure ?')) return;
  await _constDelete(id);
  showToast('info', 'Mesure supprimée');
  await constRefresh();
}

async function constExportCSV() {
  if (!_constCurrentPatient) return;
  const data = await _constGetAll(_constCurrentPatient, 365);
  if (!data.length) { showToast('warning','Aucune donnée à exporter'); return; }
  const headers = 'Date,TA Sys,TA Dia,Glycémie,SpO2,Poids,Temp,FC,EVA,Note';
  const rows = data.map(d => [
    new Date(d.date).toLocaleString('fr-FR'),
    d.ta_sys||'',d.ta_dia||'',d.glycemie||'',d.spo2||'',d.poids||'',d.temperature||'',d.fc||'',d.eva!=null?d.eva:'',d.note||''
  ].join(','));
  const csv = [headers, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `constantes_${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
  showToast('success','Export CSV réussi');
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'constantes') renderConstantes();
});
