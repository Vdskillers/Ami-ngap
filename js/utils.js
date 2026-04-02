/* ════════════════════════════════════════════════
   utils.js — AMI NGAP
   ────────────────────────────────────────────────
   Utilitaires globaux partagés par tous les modules
   - APP store centralisé (évite la pollution du scope global)
   - Session store (ss)
   - Communication API avec gestion d'erreur complète + timeout
   - UI helpers (showM, hideM, ld, sanitize, debounce)
   - requireAuth() — guard de session
════════════════════════════════════════════════ */
'use strict';

/* ── Store global centralisé ──────────────────────
   Remplace les window.X dispersés — tout dans APP
   pour éviter les collisions et faciliter le debug.
─────────────────────────────────────────────────── */
window.APP = {
  user:         null,   // objet utilisateur connecté
  token:        null,   // JWT session
  role:         null,   // 'nurse' | 'admin'
  startPoint:   null,   // {lat, lng} point de départ tournée
  userPos:      null,   // {lat, lng} position GPS live
  importedData: null,   // données importées depuis calendrier
  uberPatients: [],     // liste patients pour mode Uber Médical
  nextPatient:  null,   // prochain patient recommandé
};

/* Alias rétrocompatibles (anciens appels window.X toujours fonctionnels) */
Object.defineProperty(window,'START_POINT',   {get:()=>APP.startPoint,   set:v=>{APP.startPoint=v;}});
Object.defineProperty(window,'USER_POS',      {get:()=>APP.userPos,      set:v=>{APP.userPos=v;}});
Object.defineProperty(window,'IMPORTED_DATA', {get:()=>APP.importedData, set:v=>{APP.importedData=v;}});
Object.defineProperty(window,'UBER_PATIENTS', {get:()=>APP.uberPatients, set:v=>{APP.uberPatients=v;}});
Object.defineProperty(window,'NEXT_PATIENT',  {get:()=>APP.nextPatient,  set:v=>{APP.nextPatient=v;}});

/* ── Sécurité ─────────────────────────────────── */
function sanitize(str){return(str||'').replace(/[<>'"]/g,'');}
function debounce(fn,ms){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),ms);};}

/* ── Backend URL ─────────────────────────────── */
const W='https://raspy-tooth-1a2f.vdskillers.workers.dev';
let S=null,LIVE_PATIENT_ID=null;

/* ── Session store ────────────────────────────── */
const ss={
  save(t,r,u){S={token:t,role:r,user:u};APP.token=t;APP.role=r;APP.user=u;sessionStorage.setItem('ami',JSON.stringify(S));},
  clear(){S=null;APP.token=null;APP.role=null;APP.user=null;sessionStorage.removeItem('ami');},
  load(){try{const x=sessionStorage.getItem('ami');if(x){S=JSON.parse(x);APP.token=S.token;APP.role=S.role;APP.user=S.user;return true;}}catch{}return false;},
  tok(){return S?.token||'';}
};

/* ── Helpers DOM ─────────────────────────────── */
const $=id=>document.getElementById(id);
const gv=id=>($(id)?.value||'').trim();
const fmt=n=>(parseFloat(n)||0).toFixed(2)+' €';
function cc(c){c=(c||'').toUpperCase();if(['IFD','IK','MCI','MIE'].includes(c))return 'dp';if(c.includes('MAJ'))return 'mj';return '';}

/* ── UI helpers ──────────────────────────────── */
function showM(id,txt,type='e'){const el=$(id);if(!el)return;el.className='msg '+type;el.textContent=txt;el.style.display='block';}
function hideM(...ids){ids.forEach(id=>{const el=$(id);if(el)el.style.display='none';});}
function ld(id,on){const b=$(id);if(!b)return;b.disabled=on;if(on){b._o=b.innerHTML;b.innerHTML='<span class="spin"></span> En cours...';}else b.innerHTML=b._o||b.innerHTML;}

/* ── Communication API ────────────────────────────
   Toutes les requêtes passent par _apiFetch :
   ✅ Timeout 35s (Grok-3 peut être lent)
   ✅ Détection offline
   ✅ Statut HTTP vérifié (throw si !res.ok)
   ✅ AbortController propre
─────────────────────────────────────────────────── */
const API_TIMEOUT_MS=35000;

async function _apiFetch(path,body){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),API_TIMEOUT_MS);
  try{
    const res=await fetch(W+path,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+ss.tok()},
      body:JSON.stringify(body),
      signal:ctrl.signal
    });
    clearTimeout(timer);
    if(!res.ok){
      const txt=await res.text().catch(()=>'');
      throw new Error(`Erreur serveur ${res.status}${txt?' : '+txt.slice(0,120):''}`);
    }
    return await res.json();
  }catch(e){
    clearTimeout(timer);
    if(e.name==='AbortError') throw new Error('Délai dépassé — serveur trop lent (>35s). Réessayez.');
    if(!navigator.onLine)     throw new Error('Pas de connexion internet.');
    throw e;
  }
}

async function wpost(path,body){return _apiFetch(path,body);}
async function apiCall(path,body){return _apiFetch(path,body);}

/* fetchAPI — GET avec auth (historique, dashboard) */
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
    console.error('API ERROR:',err);
    throw err;
  }
}

/* ── Guard de session ─────────────────────────────
   Appeler en début de toute fonction qui nécessite
   une session valide. Redirige vers login si expiré.
─────────────────────────────────────────────────── */
function requireAuth(){
  if(!ss.tok()){ss.clear();if(typeof showAuthOv==='function')showAuthOv();return false;}
  return true;
}
