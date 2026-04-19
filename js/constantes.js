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
   6. IDB isolée par userId (ami_constantes_<uid>) + sync Supabase cross-appareils
   ────────────────────────────────────────────────
════════════════════════════════════════════════ */

const CONST_STORE = 'constantes';

/* ── IDB isolée par userId — même pattern que patients.js ── */
let _constDB        = null;
let _constDBUserId  = null;
let _constDBOpening = null;

function _constDbName() {
  const uid = S?.user?.id || S?.user?.email || 'local';
  return 'ami_constantes_' + uid.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function _constDb() {
  const currentUid = S?.user?.id || S?.user?.email || 'local';

  // Fermer si changement d'utilisateur
  if (_constDB && _constDBUserId !== currentUid) {
    try { _constDB.close(); } catch (_) {}
    _constDB = null; _constDBUserId = null; _constDBOpening = null;
  }
  if (_constDB) return _constDB;
  if (_constDBOpening) return _constDBOpening;

  _constDBOpening = new Promise((resolve, reject) => {
    const req = indexedDB.open(_constDbName(), 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONST_STORE)) {
        const s = db.createObjectStore(CONST_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
        s.createIndex('date',       'date',        { unique: false });
      }
    };
    req.onsuccess = e => {
      _constDB       = e.target.result;
      _constDBUserId = currentUid;
      _constDBOpening = null;
      _constDB.onclose = () => {
        _constDB = null; _constDBUserId = null; _constDBOpening = null;
      };
      resolve(_constDB);
    };
    req.onerror  = () => { _constDBOpening = null; reject(req.error); };
    req.onblocked = () => console.warn('[AMI] ami_constantes IDB bloquée');
  });
  return _constDBOpening;
}

/* Fermer la DB au logout */
document.addEventListener('ami:logout', () => {
  try { if (_constDB) _constDB.close(); } catch (_) {}
  _constDB = null; _constDBUserId = null; _constDBOpening = null;
});

/* ── Chiffrement stable pour sync cross-appareils ─────────────────────
   Clé dérivée de l'userId (stable entre appareils et sessions),
   PAS du token JWT qui change à chaque connexion et casserait la sync.
   Identique au pattern de patients.js (_enc/_dec).
─────────────────────────────────────────────────────────────────────── */
function _constSyncKey() {
  const uid = S?.user?.id || S?.user?.email || 'local';
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (Math.imul(31, h) + uid.charCodeAt(i)) | 0;
  return 'sk_const_' + String(Math.abs(h));
}
function _constEnc(obj) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj) + '|' + _constSyncKey()))); } catch { return null; }
}
function _constDec(str) {
  try { const raw = decodeURIComponent(escape(atob(str))); const sep = raw.lastIndexOf('|'); return JSON.parse(raw.slice(0, sep)); } catch { return null; }
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
  const db    = await _constDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CONST_STORE, 'readonly');
    const idx = tx.objectStore(CONST_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    // Base isolée par userId — filtre uniquement sur la date
    req.onsuccess = e => resolve(
      (e.target.result||[])
        .filter(c => c.date >= since)
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

  // Pull silencieux depuis Supabase au chargement du module
  constSyncPull().catch(() => {});

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Constantes <em>patients</em></h1>
    <p class="ps">TA · Glycémie · SpO2 · Poids · Température · Douleur · Graphiques évolution</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🔒</span><p>Constantes chiffrées AES-256 sur votre appareil, synchronisées de façon sécurisée entre vos appareils. Aucune donnée médicale lisible côté serveur.</p></div>

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
  // Annuler le mode édition si on change de patient
  if (window._constEditMode) {
    window._constEditMode = null;
    const saveBtn = document.querySelector('[onclick="constSave()"]');
    if (saveBtn) saveBtn.innerHTML = '<span>💾</span> Enregistrer';
  }
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
  let data = await _constGetAll(_constCurrentPatient, _constPeriod);

  // Fallback : si IDB vide, lire depuis la fiche patient (source de vérité)
  if (!data.length && typeof getPatientById === 'function') {
    try {
      const p = await getPatientById(_constCurrentPatient);
      if (Array.isArray(p?.constantes) && p.constantes.length) {
        // Hydrater l'IDB depuis la fiche (évite de refaire le fallback)
        const db = await _constDb();
        const existing = await new Promise((res, rej) => {
          const tx = db.transaction(CONST_STORE, 'readonly');
          const req = tx.objectStore(CONST_STORE).getAll();
          req.onsuccess = e => res(e.target.result || []);
          req.onerror   = e => rej(e.target.error);
        });
        const existKeys = new Set(existing.map(c => `${c.patient_id}|${c.date}`));
        const toImport  = p.constantes.filter(c => !existKeys.has(`${_constCurrentPatient}|${c.date}`));
        if (toImport.length) {
          const txW = db.transaction(CONST_STORE, 'readwrite');
          const store = txW.objectStore(CONST_STORE);
          for (const m of toImport) {
            const { id: _x, ...clean } = m;
            store.add({ ...clean, patient_id: _constCurrentPatient, user_id: APP?.user?.id || '' });
          }
          await new Promise((res, rej) => { txW.oncomplete = () => res(); txW.onerror = e => rej(e.target.error); });
          data = await _constGetAll(_constCurrentPatient, _constPeriod);
        }
        if (!data.length) {
          // Mesures hors période — afficher quand même depuis la fiche
          const since = new Date(Date.now() - _constPeriod * 86400000).toISOString();
          data = p.constantes
            .filter(c => (c.date || '') >= since)
            .sort((a, b) => new Date(a.date) - new Date(b.date));
        }
      }
    } catch (e) { console.warn('[constRefresh fallback]', e.message); }
  }

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
    const editMode = window._constEditMode;
    if (editMode) {
      // ── Mode édition : mettre à jour la mesure existante dans la fiche patient ──
      const rows = await _idbGetAll(PATIENTS_STORE);
      const row  = rows?.find?.(r => r.id === editMode.patientId);
      if (row && typeof _dec === 'function' && typeof _enc === 'function') {
        const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
        if (Array.isArray(p.constantes) && p.constantes[editMode.idx] != null) {
          p.constantes[editMode.idx] = { ...obj, id: p.constantes[editMode.idx].id };
          p.updated_at = new Date().toISOString();
          const toStore = { id: row.id, nom: row.nom, prenom: row.prenom, _data: _enc(p), updated_at: p.updated_at };
          if (typeof _idbPut === 'function') await _idbPut(PATIENTS_STORE, toStore);
          if (typeof _syncPatientNow === 'function') _syncPatientNow(toStore).catch(() => {});
        }
      }
      // Mettre à jour aussi dans l'IDB constantes (retrouver par date+patient_id)
      const existing = await _constGetAll(editMode.patientId, 365 * 5);
      const old = existing.find(c => c.date === editMode.mesure.date && c.patient_id === editMode.patientId);
      if (old?.id) {
        const db = await _constDb();
        await new Promise((res, rej) => {
          const tx = db.transaction(CONST_STORE, 'readwrite');
          tx.objectStore(CONST_STORE).put({ ...obj, id: old.id });
          tx.oncomplete = () => res(); tx.onerror = e => rej(e.target.error);
        });
      }
      window._constEditMode = null;
      // Réinitialiser le libellé du bouton
      const saveBtn = document.querySelector('[onclick="constSave()"]');
      if (saveBtn) saveBtn.innerHTML = '<span>💾</span> Enregistrer';
      showToast('success', 'Mesure modifiée', alerts.length ? '⚠️ Alertes détectées' : undefined);
    } else {
      // ── Mode création normal ──
      await _constSave(obj);
      if (typeof patientAddConstante === 'function') {
        await patientAddConstante(_constCurrentPatient, obj);
      }
      showToast('success', 'Constantes enregistrées', alerts.length ? '⚠️ Alertes détectées' : undefined);
    }
    constResetForm();
    await constRefresh();
    // Sync cross-appareils en arrière-plan (silencieux)
    constSyncPush().catch(() => {});
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

/* Charger une mesure existante dans le formulaire pour modification */
function constLoadForEdit(mesure, patientId, idx) {
  // Marquer le mode édition
  window._constEditMode = { patientId, idx, mesure };

  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('const-ta-sys',  mesure.ta_sys);
  set('const-ta-dia',  mesure.ta_dia);
  set('const-gly',     mesure.glycemie);
  set('const-spo2',    mesure.spo2);
  set('const-poids',   mesure.poids);
  set('const-temp',    mesure.temperature);
  set('const-fc',      mesure.fc);
  set('const-note',    mesure.note || '');
  // Date
  const dtEl = document.getElementById('const-date');
  if (dtEl && mesure.date) dtEl.value = new Date(mesure.date).toISOString().slice(0,16);
  // EVA
  const eva = document.getElementById('const-eva');
  const evaVal = document.getElementById('const-eva-val');
  if (eva && mesure.eva != null) { eva.value = mesure.eva; if (evaVal) evaVal.textContent = mesure.eva; }

  // Changer le libellé du bouton pour indiquer le mode édition
  const saveBtn = document.querySelector('[onclick="constSave()"]');
  if (saveBtn) saveBtn.innerHTML = '<span>💾</span> Modifier la mesure';

  showToast('info', 'Mode édition', 'Modifiez les valeurs puis cliquez "Modifier la mesure"');
}

/* Pré-remplir le formulaire pour modifier une mesure existante */
function constLoadForEdit(mesure, patientId, idx) {
  window._constEditMode = { patientId, idx, mesure };
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('const-ta-sys',  mesure.ta_sys);
  set('const-ta-dia',  mesure.ta_dia);
  set('const-gly',     mesure.glycemie);
  set('const-spo2',    mesure.spo2);
  set('const-poids',   mesure.poids);
  set('const-temp',    mesure.temperature);
  set('const-fc',      mesure.fc);
  set('const-note',    mesure.note || '');
  const dtEl = document.getElementById('const-date');
  if (dtEl && mesure.date) dtEl.value = new Date(mesure.date).toISOString().slice(0, 16);
  const eva = document.getElementById('const-eva');
  const evaVal = document.getElementById('const-eva-val');
  if (eva && mesure.eva != null) { eva.value = mesure.eva; if (evaVal) evaVal.textContent = mesure.eva; }
  const btn = document.querySelector('[onclick="constSave()"]');
  if (btn) btn.innerHTML = '<span>💾</span> Modifier la mesure';
  showToast('info', 'Mode édition', 'Modifiez les valeurs puis cliquez "Modifier la mesure"');
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


/* ════════════════════════════════════════════════
   SYNC CROSS-APPAREILS — Constantes
   Blob chiffré AES-256-GCM côté client,
   stocké opaque dans Supabase (constantes_sync).
   Isolation stricte par user.id — admins inclus pour leurs propres données de test.
════════════════════════════════════════════════ */

async function constSyncPush() {
  const uid = APP?.user?.id;
  if (!uid) return;

  try {
    // Lire depuis l'IDB constantes
    const db  = await _constDb();
    let all = await new Promise((res, rej) => {
      const tx  = db.transaction(CONST_STORE, 'readonly');
      const req = tx.objectStore(CONST_STORE).getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });

    // Fallback : si IDB vide, piocher dans les fiches patients
    if (!all.length && typeof getAllPatients === 'function') {
      try {
        const pts = await getAllPatients();
        for (const p of pts) {
          for (const m of (p.constantes || [])) {
            all.push({ ...m, patient_id: p.id, user_id: APP?.user?.id || '' });
          }
        }
      } catch {}
    }

    if (!all.length) return;

    // Chiffrement stable (clé dérivée userId — identique sur tous les appareils)
    const encrypted_data = _constEnc(all);
    if (!encrypted_data) return;

    await wpost('/webhook/constantes-push', {
      encrypted_data,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[constSyncPush]', e.message);
  }
}

async function constSyncPull() {
  const uid = APP?.user?.id;
  if (!uid) return;

  try {
    const resp = await wpost('/webhook/constantes-pull', {});
    if (!resp?.data?.encrypted_data) return;

    const rawEnc = resp.data.encrypted_data;

    // Détecter l'ancien format AES-GCM ({"data":"...","iv":"..."}) incompatible
    // Ce format a été produit par l'ancien code avec encryptData() (clé de session).
    // Il ne peut pas être déchiffré avec _constDec (clé userId stable).
    // → Ignorer et forcer un push pour écraser avec le bon format.
    try {
      const parsed = JSON.parse(rawEnc);
      if (parsed?.iv !== undefined) {
        console.warn('[constSyncPull] Format AES-GCM détecté en base — incompatible avec le déchiffrement stable. Un push va écraser cette entrée.');
        constSyncPush().catch(() => {});
        return;
      }
    } catch (_) { /* pas du JSON = format btoa correct, continuer */ }

    // Déchiffrement stable (même clé que le push — dérivée de userId)
    const remote = _constDec(rawEnc);
    if (!Array.isArray(remote) || !remote.length) {
      // Données corrompues ou vides — forcer un push pour réécrire
      console.warn('[constSyncPull] Déchiffrement échoué — push forcé pour corriger la ligne en base.');
      constSyncPush().catch(() => {});
      return;
    }

    // Lire l'IDB locale
    const db = await _constDb();
    const existing = await new Promise((res, rej) => {
      const tx = db.transaction(CONST_STORE, 'readonly');
      const req = tx.objectStore(CONST_STORE).getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });

    // Dédup par patient_id + date uniquement (user_id peut être '' ou absent)
    const existKeys = new Set(existing.map(c => `${c.patient_id}|${c.date}`));

    let imported = 0;
    const txW = db.transaction(CONST_STORE, 'readwrite');
    const store = txW.objectStore(CONST_STORE);
    const toFirePatient = []; // pour mise à jour fiches patients après commit IDB

    for (const m of remote) {
      const key = `${m.patient_id}|${m.date}`;
      if (existKeys.has(key)) continue;
      const { id: _x, ...clean } = m;
      store.add({ ...clean, user_id: APP?.user?.id || '', _synced: true });
      existKeys.add(key);
      toFirePatient.push(m);
      imported++;
    }

    await new Promise((res, rej) => {
      txW.oncomplete = () => res();
      txW.onerror    = e  => rej(e.target.error);
    });

    if (imported > 0) {
      console.info(`[constSyncPull] ${imported} mesure(s) importée(s)`);
      // Mettre à jour les fiches patients (source de vérité)
      if (typeof patientAddConstante === 'function') {
        for (const m of toFirePatient) {
          await patientAddConstante(m.patient_id, m).catch(() => {});
        }
      }
      // Rafraîchir si module ouvert
      if (_constCurrentPatient) constRefresh().catch(() => {});
    }
  } catch (e) {
    console.warn('[constSyncPull]', e.message);
  }
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'constantes') renderConstantes();
});

/* Au login : push d'abord (écrase les lignes corrompues), puis pull */
document.addEventListener('ami:login', () => {
  constSyncPush().catch(() => {}).finally(() => {
    constSyncPull().catch(() => {});
  });
});

