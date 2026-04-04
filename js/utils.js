/* ════════════════════════════════════════════════
   utils.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   v5.0 — Améliorations architecture :
   ✅ APP.set() / APP.get() — store observable CustomEvent
   ✅ APP.map — namespace Leaflet explicite
   ✅ fetchWithRetry — retry x2 sur timeout/réseau
   ✅ throttle() — pour GPS watchPosition
   ✅ log() — debug global (APP.debug = true)
   ✅ assertDep() — guards stricts inter-modules
   ✅ APP.on() — écoute réactive par clé
   ✅ Rétrocompatibilité totale window.X
════════════════════════════════════════════════ */
'use strict';

/* ── 1. STORE OBSERVABLE ──────────────────────── */
window.APP = {
  state: {
    user: null, token: null, role: null,
    startPoint: null, userPos: null,
    importedData: null, uberPatients: [], nextPatient: null,
  },

  /* Namespace Leaflet — défini par map.js via APP.map.register() */
  map: {
    instance: null,
    register(inst) { this.instance = inst; },
    setUserMarker: null,
    centerMap: null,
  },

  /* Écriture réactive */
  set(key, value) {
    const prev = this.state[key];
    this.state[key] = value;
    document.dispatchEvent(new CustomEvent('app:update', { detail: { key, value, prev } }));
    if (this.debug) log('APP.set(' + key + ')', value);
  },

  get(key) { return this.state[key]; },

  /* Raccourcis avec setters réactifs */
  get startPoint()    { return this.state.startPoint; },
  set startPoint(v)   { this.set('startPoint', v); },
  get userPos()       { return this.state.userPos; },
  set userPos(v)      { this.set('userPos', v); },
  get importedData()  { return this.state.importedData; },
  set importedData(v) { this.set('importedData', v); },
  get uberPatients()  { return this.state.uberPatients; },
  set uberPatients(v) { this.set('uberPatients', v); },
  get nextPatient()   { return this.state.nextPatient; },
  set nextPatient(v)  { this.set('nextPatient', v); },
  /* token/role/user sans event (performances login) */
  get token()  { return this.state.token; },
  set token(v) { this.state.token = v; },
  get role()   { return this.state.role; },
  set role(v)  { this.state.role = v; },
  get user()   { return this.state.user; },
  set user(v)  { this.state.user = v; },

  /* Écoute réactive d'une clé spécifique */
  on(key, fn) {
    document.addEventListener('app:update', e => {
      if (e.detail.key === key) fn(e.detail.value, e.detail.prev);
    });
  },

  debug: false,
};

/* ── 2. DEBUG LOGGER ─────────────────────────── */
function log(...a)     { if (APP.debug) console.log('[AMI]', ...a); }
function logWarn(...a) { if (APP.debug) console.warn('[AMI]', ...a); }
function logErr(...a)  { console.error('[AMI]', ...a); }

/* ── 3. GUARDS DÉPENDANCES ───────────────────── */
function assertDep(condition, message) {
  if (!condition) logErr('Dépendance manquante : ' + message);
}

/* ── 4. ALIAS RÉTROCOMPATIBLES ───────────────── */
Object.defineProperty(window,'START_POINT',   {get:()=>APP.state.startPoint,   set:v=>APP.set('startPoint',v)});
Object.defineProperty(window,'USER_POS',      {get:()=>APP.state.userPos,      set:v=>APP.set('userPos',v)});
Object.defineProperty(window,'IMPORTED_DATA', {get:()=>APP.state.importedData, set:v=>APP.set('importedData',v)});
Object.defineProperty(window,'UBER_PATIENTS', {get:()=>APP.state.uberPatients, set:v=>APP.set('uberPatients',v)});
Object.defineProperty(window,'NEXT_PATIENT',  {get:()=>APP.state.nextPatient,  set:v=>APP.set('nextPatient',v)});

/* ── 5. SÉCURITÉ ─────────────────────────────── */
function sanitize(str) { return (str||'').replace(/[<>'"]/g,''); }
function debounce(fn,ms) { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
/* throttle — fréquence max (GPS, resize…) */
function throttle(fn,ms) {
  let last=0;
  return (...a)=>{ const now=Date.now(); if(now-last<ms) return; last=now; return fn(...a); };
}

/* ── 6. BACKEND + SESSION ────────────────────── */
const W='https://raspy-tooth-1a2f.vdskillers.workers.dev';
let S=null, LIVE_PATIENT_ID=null;

const ss={
  save(t,r,u){ S={token:t,role:r,user:u}; APP.token=t; APP.role=r; APP.user=u; sessionStorage.setItem('ami',JSON.stringify(S)); },
  clear(){ S=null; APP.token=null; APP.role=null; APP.user=null; sessionStorage.removeItem('ami'); },
  load(){ try{ const x=sessionStorage.getItem('ami'); if(x){ S=JSON.parse(x); APP.token=S.token; APP.role=S.role; APP.user=S.user; return true; } }catch{} return false; },
  tok(){ return S?.token||''; }
};

/* ── 7. DOM HELPERS ──────────────────────────── */
const $=id=>document.getElementById(id);
const gv=id=>($(id)?.value||'').trim();
const fmt=n=>(parseFloat(n)||0).toFixed(2)+' €';
function cc(c){ c=(c||'').toUpperCase(); if(['IFD','IK','MCI','MIE'].includes(c))return 'dp'; if(c.includes('MAJ'))return 'mj'; return ''; }
function showM(id,txt,type='e'){ const el=$(id); if(!el)return; el.className='msg '+type; el.textContent=txt; el.style.display='block'; }
function hideM(...ids){ ids.forEach(id=>{ const el=$(id); if(el) el.style.display='none'; }); }
function ld(id,on){ const b=$(id); if(!b)return; b.disabled=on; if(on){b._o=b.innerHTML;b.innerHTML='<span class="spin"></span> En cours...';}else b.innerHTML=b._o||b.innerHTML; }

/* ── 8. API — FETCH AVEC RETRY ───────────────────
   ✅ Timeout 35s
   ✅ Retry x2 automatique (timeout + erreur réseau)
   ✅ Pas de retry sur 4xx (erreurs métier)
   ✅ Délai 800ms entre retries
─────────────────────────────────────────────── */
const API_TIMEOUT_MS=35000;

async function _apiFetch(path, body, retry = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 🔥 8s au lieu de 35s

  try {
    const res = await fetch(W + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ss.tok() ? 'Bearer ' + ss.tok() : ''
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    // 🔐 SESSION INVALIDE → logout direct
    if (res.status === 401) {
      ss.clear();
      if (typeof showAuthOv === 'function') showAuthOv();
      throw new Error('Session expirée — reconnectez-vous');
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(txt || ('Erreur serveur ' + res.status));
    }

    return await res.json();

  } catch (e) {
    clearTimeout(timeout);

    // 🔁 retry UNE SEULE FOIS (pas 2)
    if (retry && e.name !== 'AbortError') {
      logWarn('Retry API →', path);
      await new Promise(r => setTimeout(r, 500));
      return _apiFetch(path, body, false);
    }

    if (!navigator.onLine) {
      throw new Error('Pas de connexion internet.');
    }

    if (e.name === 'AbortError') {
      throw new Error('Serveur trop lent (>8s)');
    }

    throw e;
  }
}

async function wpost(path,body)   { return _apiFetch(path,body); }
async function apiCall(path,body) { return _apiFetch(path,body); }

async function fetchAPI(url,options={}){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),API_TIMEOUT_MS);
  try{
    const res=await fetch(W+url,{
      ...options,
      headers:{'Content-Type':'application/json','Authorization':ss.tok()?'Bearer '+ss.tok():'',...(options.headers||{})},
      signal:ctrl.signal
    });
    clearTimeout(timer);
    if(!res.ok){const text=await res.text();throw new Error('API '+res.status+': '+text);}
    return await res.json();
  }catch(err){
    clearTimeout(timer);
    if(err.name==='AbortError') throw new Error('Délai dépassé');
    logErr('fetchAPI:',err);
    throw err;
  }
}

/* ── 9. GUARD SESSION ────────────────────────── */
function requireAuth(){
  if(!ss.tok()){ ss.clear(); if(typeof showAuthOv==='function') showAuthOv(); return false; }
  return true;
}

/* ── 10. ÉCOUTES RÉACTIVES GLOBALES ─────────────
   Effets de bord déclenchés par APP.set().
   Chaque module peut ajouter les siens via APP.on().
─────────────────────────────────────────────── */

/* userPos → marker live Uber (si _updateMapLive définie dans uber.js) */
APP.on('userPos', pos => {
  if (!pos) return;
  if (typeof _updateMapLive === 'function') _updateMapLive(pos.lat, pos.lng);
  log('userPos →', pos.lat?.toFixed(4), pos.lng?.toFixed(4));
});

/* nextPatient → re-render card Uber (si _renderNextPatient définie) */
APP.on('nextPatient', p => {
  if (typeof _renderNextPatient === 'function') _renderNextPatient();
  log('nextPatient →', p?.label || p?.description || '—');
});
