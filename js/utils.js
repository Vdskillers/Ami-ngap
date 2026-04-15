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
  load(){ try{ const x=sessionStorage.getItem('ami'); if(x){ S=JSON.parse(x); APP.token=S.token; APP.role=S.role; APP.user=S.user; return S; } }catch{} return null; },
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

/* ── 8. API — FETCH AVEC RETRY v5 ───────────────
   ✅ Parsing JSON sécurisé (anti "Unexpected end of JSON")
   ✅ Timeout IA 30s, standard 8s
   ✅ Retry 1× propre, détection vide/HTML/JSON cassé
─────────────────────────────────────────────── */

async function _safeParseResponse(res) {
  const text = await res.text().catch(() => '');
  if (!text || text.trim() === '') throw new Error('Réponse vide du serveur');
  if (text.trim().startsWith('<')) throw new Error('Erreur serveur — réessayez dans quelques secondes');
  try { return JSON.parse(text); } catch { throw new Error('Réponse invalide du serveur'); }
}

async function _apiFetch(path, body, retry = true) {
  const isIA    = path.includes('ami-calcul') || path.includes('ami-historique') || path.includes('ami-copilot');
  const TIMEOUT = isIA ? 55000 : 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(W + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ss.tok() ? 'Bearer ' + ss.tok() : '' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 401) { ss.clear(); if (typeof showAuthOv === 'function') showAuthOv(); throw new Error('Session expirée — reconnectez-vous'); }

    const data = await _safeParseResponse(res);
    if (!res.ok) throw new Error(data?.error || ('Erreur serveur ' + res.status));
    return data;

  } catch (e) {
    clearTimeout(timeout);
    if (retry && e.name !== 'AbortError' && !e.message.includes('Session expirée')) {
      await new Promise(r => setTimeout(r, 500));
      return _apiFetch(path, body, false);
    }
    if (!navigator.onLine) throw new Error('Pas de connexion internet.');
    if (e.name === 'AbortError') throw new Error(isIA ? "L'IA prend plus de temps que prévu 🤖" : 'Serveur trop lent (>8s)');
    throw e;
  }
}

async function wpost(path,body)   { return _apiFetch(path,body); }
async function apiCall(path,body) { return _apiFetch(path,body); }

/* Copilote IA — question NGAP */
async function copilotAsk(question) {
  return _apiFetch('/webhook/ami-copilot', { question });
}

/* Analytiques semaine */
async function weekAnalytics() {
  return _apiFetch('/webhook/ami-week-analytics', {});
}

async function fetchAPI(url, options = {}) {
  const isIA    = url.includes('ami-calcul') || url.includes('ami-historique');
  const TIMEOUT = isIA ? 55000 : 8000;
  const ctrl    = new AbortController();
  const timer   = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(W + url, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'Authorization': ss.tok() ? 'Bearer ' + ss.tok() : '', ...(options.headers || {}) },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 401) { ss.clear(); if (typeof showAuthOv === 'function') showAuthOv(); throw new Error('Session expirée — reconnectez-vous'); }
    const data = await _safeParseResponse(res);
    if (!res.ok) throw new Error(data?.error || ('API ' + res.status));
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Délai dépassé');
    logErr('fetchAPI:', err);
    throw err;
  }
}

/* ── 9. GUARD SESSION ────────────────────────── */
function requireAuth(){
  // Si S n'est pas hydraté en mémoire, tenter de le recharger depuis sessionStorage
  if(!S) ss.load();
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
