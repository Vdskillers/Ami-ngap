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
    cabinet: null,  // { id, nom, my_role, members[], sync_prefs }
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
  get cabinet()  { return this.state.cabinet; },
  set cabinet(v) { this.set('cabinet', v); },

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

/* ⚡ Date locale du jour au format YYYY-MM-DD (pas UTC).
   Critique pour date_soin : à 1h du matin France (CEST = UTC+2),
   `new Date().toISOString().slice(0,10)` renvoie la veille ("2026-04-21"
   alors que le calendrier local affiche mercredi 22/04). Stocker la date
   en UTC fait apparaître toutes les cotations nocturnes au mauvais jour
   dans le carnet, l'historique et le simulateur audit CPAM. */
function _localDateStr(d) {
  const dd = d || new Date();
  const y = dd.getFullYear();
  const m = String(dd.getMonth() + 1).padStart(2, '0');
  const day = String(dd.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
window._localDateStr = _localDateStr;

/* ⚡ Date+Heure locale ISO (sans suffixe Z) — utilisé pour cotation.date
   afin que slice(0,10) renvoie bien la date locale partout. */
function _localDateTimeISO(d) {
  const dd = d || new Date();
  const y = dd.getFullYear();
  const m = String(dd.getMonth() + 1).padStart(2, '0');
  const day = String(dd.getDate()).padStart(2, '0');
  const h = String(dd.getHours()).padStart(2, '0');
  const mi = String(dd.getMinutes()).padStart(2, '0');
  const s = String(dd.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${mi}:${s}`;
}
window._localDateTimeISO = _localDateTimeISO;

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

/* ── 10. CONVERSION PATHOLOGIES → ACTES NGAP ────────────────────────────────
   _PATHO_MAP v2.0 — Enrichi avec toutes les abréviations médicales courantes
   Utilisée quand actes_recurrents est vide.
   Traduit un champ Pathologies (ex : "Diabète type 2, HTA, plaie pied")
   en description d'actes médicaux réels applicables,
   directement exploitable par l'IA NGAP pour la cotation.

   Abréviations couvertes : DT1/DT2, IRC/IRT, IC, BPCO/MPOC, EP, TVP, AVC,
   SEP, SLA, HBPM, AVK, AOD, INR, HbA1c, NFS, CRP, SAD, PEG, HAD, SSIAD,
   ALD, MRC, SCA, FA/ACFA, HTAP, AAA, AOMI, IEC, SAS/SAOS, HBP, LUTS...
──────────────────────────────────────────────────────────────────────────── */
const _PATHO_MAP = [

  /* ════════════════════════════════════════════
     DIABÈTE — Toutes formes et abréviations
  ════════════════════════════════════════════ */
  {
    re: /diab[eè]te?(?:\s*(?:type\s*[12]|insulino[- ]d[eé]pendant|non\s*insulino|instable|d[eé]s[eé]quilibr))?|\bDT[12]\b|\bDNID\b|\bDID\b|\bT[12]D\b/i,
    actes: 'Injection insuline SC, surveillance glycémie capillaire, éducation thérapeutique'
  },

  /* ════════════════════════════════════════════
     PLAIES, PANSEMENTS, CICATRISATION
  ════════════════════════════════════════════ */
  {
    re: /plaie|ulc[eè]re|escarre|pansement|cicatric|d[eé]bridement|n[eé]crose|fistule|br[uû]lure|dermite/i,
    actes: 'Pansement complexe, détersion, surveillance plaie, IFD domicile'
  },

  /* ════════════════════════════════════════════
     ANTICOAGULANTS — HBPM, AVK, AOD
  ════════════════════════════════════════════ */
  {
    re: /anticoagul|h[eé]parin|lovenox|fragmine|innohep|HBPM|\bAVK\b|warfarin|acenocoumarol|sintrom|rivaroxaban|apixaban|dabigatran|\bAOD\b|\bNACO\b/i,
    actes: 'Injection sous-cutanée HBPM, surveillance INR, éducation anticoagulant, IFD'
  },

  /* ════════════════════════════════════════════
     PERFUSIONS — Antibiotiques, chimio, hydratation
  ════════════════════════════════════════════ */
  {
    re: /perfus|antibio\w*|chimio|voie\s*vein(?:euse)?|\bKT\b|\bVVP\b|\bVVC\b|cathéter\s*(?:veineux|central|périph)|nutri(?:tion)?\s*parent/i,
    actes: 'Perfusion intraveineuse à domicile, IFD, surveillance tolérance et abord veineux'
  },

  /* ════════════════════════════════════════════
     NURSING / DÉPENDANCE / DÉMENCE
  ════════════════════════════════════════════ */
  {
    re: /nursing|grabataire|d[eé]pendance|ALD\s*\d*\s*perte|d[eé]mence|Alzheimer|Parkinson|\bGIR\s*[1-4]\b|perte\s*d.autonomie|t[eé]traplég|h[eé]miplég|\.\bSLA\b/i,
    actes: 'Soins de nursing complets, AMI 4, aide à la toilette BSC, prévention escarres, IFD'
  },

  /* ════════════════════════════════════════════
     INSUFFISANCE CARDIAQUE / HTA / CARDIO
  ════════════════════════════════════════════ */
  {
    re: /\bHTA\b|hypertension|insuffisance\s*cardiaque|\bIC\b(?!\s*[a-z])|cardio(?:myopathie|pathie|logie)?|\bFA\b|\bACFA\b|fibrillation\s*atriale|\bSCA\b|angor|angine\s*de\s*poitrine|infarctus|\bIDM\b|post.\s*(?:IDM|infarctus)/i,
    actes: 'Prise de tension artérielle, surveillance cardiaque, surveillance poids et œdèmes, éducation traitement, IFD'
  },

  /* ════════════════════════════════════════════
     SOINS PALLIATIFS / FIN DE VIE
  ════════════════════════════════════════════ */
  {
    re: /palliatif|fin\s*de\s*vie|soins\s*confort|phase\s*terminale|cancer\s*(?:stade|terminal)|soins\s*support/i,
    actes: 'Soins palliatifs à domicile, AMI 4, gestion douleur, nursing complet, IFD, surveillance EVA'
  },

  /* ════════════════════════════════════════════
     PRÉLÈVEMENTS / BILANS SANGUINS
  ════════════════════════════════════════════ */
  {
    re: /bilan\s*sanguin|prise\s*de\s*sang|pr[eé]l[eè]ve|\bNFS\b|\bCRP\b|\bHbA1c\b|\bINR\b|\bTP\b|\bTCA\b|\bCK\b|\bBNP\b|\bNT.proBNP\b|ionogramme|cr[eé]atinin|bilan\s*r[eé]nal|bilan\s*h[eé]patique|glyc[eé]mie\s*(?:veineuse|capillaire|à\s*jeun)/i,
    actes: 'Prélèvement veineux à domicile, BSA, IFD'
  },

  /* ════════════════════════════════════════════
     SONDE URINAIRE / STOMIE / APPAREILLAGE
  ════════════════════════════════════════════ */
  {
    re: /sonde\s*urinaire|\bSAD\b|\bSAV\b|stomie|colostomie|iléostomie|trachéo(?:tomie|stomie)?|gastrostomie|\bPEG\b|\bJEJ\b|sonde\s*naso(?:gastrique|duodénale)|\bSNG\b/i,
    actes: 'Soin sur appareillage, surveillance et entretien sonde, AMI 2, IFD'
  },

  /* ════════════════════════════════════════════
     DOULEUR / MORPHINE / ANTALGIQUES
  ════════════════════════════════════════════ */
  {
    re: /douleur\s*(?:chronique|intense|nociceptive|neuropathique)?|morphine|oxycodone|fentanyl|antalgique|\bPCA\b|patch\s*(?:morphin|fentanyl)|pompe\s*(?:à\s*morphine|antalg)/i,
    actes: 'Injection antalgique SC ou IV, surveillance douleur EVA, gestion pompe PCA si besoin, IFD'
  },

  /* ════════════════════════════════════════════
     ASTHME / BPCO / INSUFFISANCE RESPIRATOIRE
  ════════════════════════════════════════════ */
  {
    re: /asthme|\bBPCO\b|\bMPOC\b|insuffisance\s*resp(?:iratoire)?|aérosol|nébulisation|\bVNI\b|\bOHD\b|oxygéno(?:thérapie)?|oxygen|sat(?:uration)?\s*<|dyspn[eé]e/i,
    actes: 'Aérosol médicamenteux, surveillance saturation SpO2, éducation inhalateurs, IFD'
  },

  /* ════════════════════════════════════════════
     POST-OPÉRATOIRE / CHIRURGIE / PHLÉBITE
  ════════════════════════════════════════════ */
  {
    re: /post[- .]op(?:ératoire)?|chirurgi|\bTVP\b|\bEP\b(?!\s*[a-z])|phlébite|thrombose\s*veineuse|embolie\s*pulmonaire|suture|agrafes?|drain(?:age)?|\bJ[0-9]+\s*post/i,
    actes: 'Soins post-opératoires, pansement, surveillance cicatrice, injection HBPM si prescrite, IFD'
  },

  /* ════════════════════════════════════════════
     PSYCHIATRIE / TROUBLES COGNITIFS
  ════════════════════════════════════════════ */
  {
    re: /psychiatr|d[eé]pression|schizophr[eè]nie|trouble\s*(?:bipolaire|de\s*la\s*personnalit[eé])|psychose|\bTSA\b|trouble\s*anxieux|\bTOC\b|anorexie|boulimie|addiction/i,
    actes: 'Suivi infirmier psychiatrique, surveillance observance traitement, éducation thérapeutique, IFD'
  },

  /* ════════════════════════════════════════════
     INSUFFISANCE RÉNALE — IRC, IRT, dialyse
  ════════════════════════════════════════════ */
  {
    re: /insuffisance\s*r[eé]nale|\bIRC\b|\bIRT\b|\bMRC\b|dialyse|hémodialyse|dialyse\s*p[eé]riton[eé]ale|\bDFG\b|\bDFGe\b|cr[eé]atinin(?:ine)?\s*(?:élevée|augment)/i,
    actes: 'Surveillance paramètres rénaux, prise de tension, surveillance poids et œdèmes, gestion fistule si dialyse, IFD'
  },

  /* ════════════════════════════════════════════
     CANCER / ONCOLOGIE / HAD
  ════════════════════════════════════════════ */
  {
    re: /cancer|carcinome|sarcome|lymphome|leucémie|tumeur|n[eé]oplasie|\bHAD\b|hospitalisation\s*à\s*domicile|oncologi/i,
    actes: 'Soins oncologiques à domicile, perfusion chimio si prescrite, surveillance tolérance, gestion cathéter, IFD'
  },

  /* ════════════════════════════════════════════
     AVC / NEUROLOGIE
  ════════════════════════════════════════════ */
  {
    re: /\bAVC\b|accident\s*(?:vasculaire\s*cérébral|ischémique|hémorragique)|\bAIT\b|séquelles?\s*(?:AVC|neuro)|\bSEP\b|sclérose\s*(?:en\s*plaques|latérale)|\bSLA\b|neuropathie/i,
    actes: 'Soins de rééducation infirmière, nursing, surveillance neurologique, prévention escarres, IFD'
  },

  /* ════════════════════════════════════════════
     INSUFFISANCE VEINEUSE / LYMPHŒDÈME
  ════════════════════════════════════════════ */
  {
    re: /insuffisance\s*veineuse|varic(?:e|osité)|lymph[oœ]d[eè]me|bandage\s*(?:compressif|contentif)|contention|bas\s*de\s*contention/i,
    actes: 'Pose bandage compressif, soins de contention, surveillance circulation, IFD'
  },

  /* ════════════════════════════════════════════
     NUTRITION ENTÉRALE / PARENTÉRALE
  ════════════════════════════════════════════ */
  {
    re: /nutrition\s*(?:ent[eé]rale|parent[eé]rale|artificielle)|sonde\s*(?:naso)?gastrique|\bNE\b(?:\s+)|\bNP\b(?:\s+)|d[eé]nutrition|malnutrition|poids\s*(?:<|bas|insuffisant)/i,
    actes: 'Gestion nutrition entérale ou parentérale, entretien sonde, surveillance tolérance digestive, IFD'
  },

  /* ════════════════════════════════════════════
     RÉTENTION / TROUBLES URINAIRES / HBP
  ════════════════════════════════════════════ */
  {
    re: /r[eé]tention\s*urinaire|\bHBP\b|hyperplasie\s*(?:b[eé]nigne\s*)?prostate|troubles?\s*(?:mictionnels?|urinaires?)|\bLUTS\b|incontinence/i,
    actes: 'Sondage urinaire évacuateur, soins sonde à demeure, éducation patient, IFD'
  },

  /* ════════════════════════════════════════════
     APNÉE DU SOMMEIL / SAS / PPC
  ════════════════════════════════════════════ */
  {
    re: /apn[eé]e\s*(?:du\s*sommeil|obstructive)?|\bSAS\b|\bSAOS\b|\bPPC\b|\bCPAP\b|\bBPAP\b|ventilation\s*non\s*invasive/i,
    actes: 'Surveillance appareillage PPC/VNI, éducation utilisation masque, IFD'
  },

  /* ════════════════════════════════════════════
     CONSTIPATION / OCCLUSION / SOINS DIGESTIFS
  ════════════════════════════════════════════ */
  {
    re: /constipation|\bFCO\b|fécalome|occlusion\s*intestinale|lavement|irrigation\s*colique|soins\s*digestifs/i,
    actes: 'Soins digestifs, lavement évacuateur si prescrit, surveillance transit, IFD'
  },

  /* ════════════════════════════════════════════
     ESCARRES / PRÉVENTION — doublon ciblé si
     pas de plaie déclarée mais risque élevé
  ════════════════════════════════════════════ */
  {
    re: /pr[eé]vention\s*escarre|\bBraden\b|risque\s*(?:cutané|escarres?)|matelas\s*(?:anti[- ]escarre|dynamique)/i,
    actes: 'Soins préventifs escarres, nursing, changements de position, éducation aidants, IFD'
  },

  /* ════════════════════════════════════════════
     SSIAD / HAD / SOINS À DOMICILE — contexte
  ════════════════════════════════════════════ */
  {
    re: /\bSSIAD\b|\bHAD\b|maintien\s*à\s*domicile|soins\s*à\s*domicile|retour\s*(?:à|au)\s*domicile|sortie\s*(?:d.?hospit|HAD)/i,
    actes: 'Soins infirmiers à domicile, évaluation globale, coordination HAD/SSIAD, IFD'
  },

];

/**
 * Convertit un champ Pathologies en description d'actes médicaux
 * exploitable pour la cotation NGAP.
 * @param {string} pathologies — ex : "Diabète type 2, HTA, plaie pied"
 * @returns {string} — texte prêt pour l'IA NGAP (vide si pas de correspondance)
 */
function pathologiesToActes(pathologies) {
  if (!pathologies || !pathologies.trim()) return '';
  const matches = [];
  const seen = new Set();
  for (const entry of _PATHO_MAP) {
    if (entry.re.test(pathologies) && !seen.has(entry.actes)) {
      matches.push(entry.actes);
      seen.add(entry.actes);
    }
  }
  if (matches.length) return matches.join(', ');
  // Aucune correspondance → retourner les pathologies brutes
  // pour que l'IA NGAP tente quand même une cotation par contexte
  return 'Soins infirmiers pour : ' + pathologies.trim();
}

/* Exposer globalement pour cotation.js, extras.js, tournee.js, index.html */
window.pathologiesToActes = pathologiesToActes;

/**
 * ⚡ Convertit un patient en description de soin enrichie pour stockage.
 *
 * Pourquoi : l'affichage des cotations (carnet patient, historique, planning)
 * montrait juste "Diabète" ou "HTA" au lieu du détail du soin ("Injection
 * insuline SC, surveillance glycémie capillaire…"). La raison : le champ
 * `soin` de la cotation IDB recevait p.description brute, alors que le champ
 * `texte` envoyé à l'IA NGAP était bien enrichi via pathologiesToActes.
 *
 * Ce helper centralise la logique d'enrichissement. Ordre de priorité :
 *   1. actes_recurrents (description manuelle détaillée par l'infirmière)
 *   2. Description brute SI elle contient déjà un acte technique reconnu
 *   3. pathologiesToActes(pathologies) si champ pathologies rempli
 *   4. pathologiesToActes(description) si description est une pathologie brute
 *   5. description brute en dernier recours
 *
 * @param {Object} patient - Patient avec actes_recurrents/pathologies/description
 * @param {number} [max=200] - Longueur max (default 200 pour stockage IDB)
 * @returns {string} Description enrichie prête pour affichage/stockage
 */
function _enrichSoinLabel(patient, max = 200) {
  if (!patient) return '';
  const p = patient;
  const actesRec = (p.actes_recurrents || '').trim();
  const pathoBrut = (p.pathologies || '').trim();
  const desc = (p.description || p.texte || p.texte_soin || p.acte || '').trim();

  // ⚡ Règle #1 révisée — actes_recurrents prime UNIQUEMENT s'il est vraiment
  // détaillé (phrase ≥ 20 caractères avec au moins un espace). Sinon ("Diabète",
  // "AMI1", "HTA" en saisie brève), on doit enrichir via pathologiesToActes pour
  // ne pas afficher "Diabète" brut dans l'Historique des soins ou la Tournée.
  const _isDetaille = actesRec.length >= 20 && /\s/.test(actesRec);
  if (_isDetaille) {
    return actesRec.slice(0, max);
  }

  // Règle #2 — description contenant déjà un acte technique reconnu → garder
  // (mais on exclut "AMI\d" seul sans autre mot, trop court pour être informatif)
  const _hasActe = /injection|pansement|pr[eé]l[eè]vement|perfusion|nursing|toilette|bilan|sonde|insuline|glyc[eé]mie|BSA|BSC|BSB/i;
  if (desc && _hasActe.test(desc)) {
    return desc.slice(0, max);
  }

  // Règle #3 — enrichir via pathologiesToActes. Sources testées dans l'ordre :
  // pathologies > actes_recurrents court > description brute.
  if (typeof pathologiesToActes === 'function') {
    const _candidats = [pathoBrut, actesRec, desc].filter(Boolean);
    for (const src of _candidats) {
      const enriched = pathologiesToActes(src);
      // On garde uniquement si ça matche réellement un pattern de _PATHO_MAP
      // (pas le fallback "Soins infirmiers pour : X" qui renvoie juste la pathologie).
      if (enriched && !enriched.startsWith('Soins infirmiers pour :')) {
        return enriched.slice(0, max);
      }
    }
  }

  // Règle #4 — fallback brut dans l'ordre : actes_recurrents > description > pathologies
  return (actesRec || desc || pathoBrut).slice(0, max);
}
window._enrichSoinLabel = _enrichSoinLabel;

/* ── 11. ÉCOUTES RÉACTIVES GLOBALES ─────────────
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
