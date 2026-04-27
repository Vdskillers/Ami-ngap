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

/* ════════════════════════════════════════════════════════════════════════
   🔥 AMI NETWORK ENGINE v3 — MODE HARDCORE
   ────────────────────────────────────────────────────────────────────────
   Scheduler global anti-DNS-overflow + dédup + cache + retry intelligent.

   Pourquoi ?
     Cloudflare Workers Free plan = 6 connexions sortantes simultanées max.
     L'app AMI faisait jusqu'à 15-20 fetches parallèles au boot
     (boot-sync + ngap-active + admin-logs + admin-stats + sync modules + ...)
     → saturation cache DNS interne du Worker → 503 en cascade.

   Comment ?
     Tous les wpost/apiCall passent automatiquement par NET.request() qui :
      1. Met en queue avec priorité (login > boot > sync > admin)
      2. Limite à 1 fetch sortant simultané (max=1)
      3. Dédupe les appels identiques en cours (1 seul fetch pour N appelants)
      4. Cache mémoire avec TTL (évite de refetch les données stables)
      5. Retry avec backoff exponentiel + jitter sur 503/DNS
      6. Failsafe : ne clear PAS la session sur 401 préemptif

   Compatible : wpost(), apiCall(), bootSyncStart() utilisent NET en interne.
                Aucun changement requis dans les modules métier.
   ═══════════════════════════════════════════════════════════════════════ */
const NET = {
  queue:       [],
  active:      0,
  max:         1,                 // ⚠️ JAMAIS >1 — c'est la clé anti-DNS-overflow
  baseDelay:   100,               // délai entre 2 requêtes successives
  jitter:      80,                // ms aléatoires ajoutés (évite synchronisation)
  cache:       new Map(),         // key → { data, ts }
  inflight:    new Map(),         // key → Promise (déduplication)
  dnsErrors:   0,                 // compteur d'erreurs DNS récentes
  lastDnsErr:  0,                 // timestamp dernière erreur DNS

  /**
   * Lance une requête à travers le scheduler.
   * @param {string} key      Clé unique (path + body) pour dédup/cache
   * @param {Function} fn     Fonction async qui fait le vrai fetch
   * @param {Object} opts     { ttl, priority, retry, dedupe, cacheable }
   */
  async request(key, fn, opts = {}) {
    const {
      ttl       = 0,      // 0 = pas de cache
      priority  = 5,      // 1=critique, 5=normal, 7=admin/logs
      retry     = 2,      // nb retries sur 503/DNS
      dedupe    = true,   // si true, n'exécute qu'1 fois pour N appels concurrents
      cacheable = true,
    } = opts;

    // 🔁 CACHE HIT
    if (cacheable && ttl > 0) {
      const c = this.cache.get(key);
      if (c && Date.now() - c.ts < ttl) return c.data;
    }

    // 🔁 DÉDUP : si déjà en vol, retourner la même promesse
    if (dedupe && this.inflight.has(key)) {
      return this.inflight.get(key);
    }

    const promise = this._enqueue(() => this._exec(fn, retry), priority);
    if (dedupe) this.inflight.set(key, promise);

    try {
      const res = await promise;
      if (cacheable && ttl > 0) {
        this.cache.set(key, { data: res, ts: Date.now() });
      }
      return res;
    } finally {
      if (dedupe) this.inflight.delete(key);
    }
  },

  _enqueue(fn, priority) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, priority });
      this.queue.sort((a, b) => a.priority - b.priority);
      this._run();
    });
  },

  async _run() {
    if (this.active >= this.max) return;
    if (!this.queue.length) return;

    const job = this.queue.shift();
    this.active++;

    try {
      const res = await job.fn();
      job.resolve(res);
    } catch (e) {
      job.reject(e);
    } finally {
      this.active--;
      // Attendre baseDelay + jitter avant le prochain → évite rafale
      const delay = this.baseDelay + Math.random() * this.jitter;
      setTimeout(() => this._run(), delay);
    }
  },

  async _exec(fn, retry) {
    let attempt = 0;
    while (attempt <= retry) {
      try {
        const result = await fn();
        // Reset compteur erreurs DNS sur succès
        this.dnsErrors = 0;
        return result;
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        const isDns      = msg.includes('dns cache overflow') || msg.includes('dns');
        const is503      = msg.includes('503');
        const isFetchErr = msg.includes('fetch') || msg.includes('network');
        if ((isDns || is503 || isFetchErr) && attempt < retry) {
          this.dnsErrors++;
          this.lastDnsErr = Date.now();
          // Backoff exponentiel + jitter : 500ms, 1500ms, 3500ms
          const delay = (500 * Math.pow(2, attempt)) + Math.random() * 300;
          await new Promise(r => setTimeout(r, delay));
          attempt++;
          continue;
        }
        throw e;
      }
    }
    throw new Error('Max retry reached');
  },

  /** Invalide une entrée du cache (à appeler après PUSH pour forcer refresh) */
  invalidate(key) {
    if (key) {
      // Invalidation par préfixe (ex: 'POST:/webhook/patients-' invalide tout patients)
      for (const k of this.cache.keys()) {
        if (k.startsWith(key)) this.cache.delete(k);
      }
    } else {
      this.cache.clear();
    }
  },

  /** Stats pour debug */
  stats() {
    return {
      queueSize: this.queue.length,
      active: this.active,
      cacheSize: this.cache.size,
      inflight: this.inflight.size,
      dnsErrors: this.dnsErrors,
    };
  },
};

if (typeof window !== 'undefined') {
  window.NET = NET;
}

/**
 * Détermine la priorité automatique d'un endpoint en fonction de son path.
 * Plus le nombre est petit, plus c'est prioritaire (1=critique, 9=trivial).
 */
function _netPriorityForPath(path) {
  const p = String(path || '');
  if (p.includes('login') || p.includes('register') || p.includes('logout')) return 1;
  if (p.includes('boot-sync') || p.includes('ngap-active'))                   return 2;
  if (p.includes('-pull'))                                                    return 3;
  if (p.includes('-push') || p.includes('-delete'))                           return 4;
  if (p.includes('admin-syshealth') || p.includes('admin-stats'))             return 6;
  if (p.includes('admin-logs') || p.includes('admin-security'))               return 7;
  if (p.includes('ami-copilot') || p.includes('ami-calcul'))                  return 5;
  return 5;
}

/**
 * Détermine le TTL cache automatique selon le path.
 * 0 = pas de cache (POST modifiants, calculs IA, etc.)
 */
function _netTtlForPath(path, body) {
  const p = String(path || '');
  // Pas de cache sur les actions modifiantes
  if (p.includes('-push') || p.includes('-delete') || p.includes('-update')) return 0;
  if (p.includes('-save') || p.includes('-create'))                          return 0;
  if (p.includes('login') || p.includes('register'))                         return 0;
  if (p.includes('ami-copilot') || p.includes('ami-calcul'))                 return 0;
  // Cache court pour les endpoints lecture admin (charge fréquemment ouverte)
  if (p.includes('admin-syshealth')) return 10000;  // 10s
  if (p.includes('admin-stats'))     return 30000;  // 30s
  if (p.includes('admin-logs'))      return 10000;  // 10s
  if (p.includes('admin-liste'))     return 30000;  // 30s
  if (p.includes('boot-sync'))       return 5000;   // 5s
  // Pas de cache par défaut sur les pulls (sinon les modules ne voient jamais les nouveautés)
  return 0;
}

async function _apiFetch(path, body, retry = true, _attempt = 0) {
  const isIA    = path.includes('ami-calcul') || path.includes('ami-historique') || path.includes('ami-copilot');
  // ✅ v8.8 — Endpoints admin : pas de retry sur 503 (worker degraded → user clique manuellement Rafraîchir)
  //   Évite le triplement d'erreurs console quand le worker hit son CPU budget en cold-start.
  const isAdminRead = /\/webhook\/admin-(syshealth|logs|stats|liste|security-stats)/.test(path);
  const TIMEOUT = isIA ? 55000 : 8000;

  // Clé de cache/dédup : path + hash du body
  const bodyStr = body ? JSON.stringify(body) : '';
  const key = 'POST:' + path + ':' + bodyStr;

  return NET.request(key, async () => {
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

      // 503 → throw pour que NET._exec retente avec backoff (sauf admin : pas de retry)
      if (res.status === 503) {
        const text = await res.clone().text().catch(() => '');
        // ✅ v8.8 — Erreur taggée pour que les caller distinguent un 503 d'une vraie erreur
        const e503 = new Error('503 ' + text.slice(0, 50));
        e503.code = 'WORKER_503';
        e503.transient = true;
        throw e503;
      }

      const data = await _safeParseResponse(res);
      if (!res.ok) throw new Error(data?.error || ('Erreur serveur ' + res.status));
      return data;
    } catch (e) {
      clearTimeout(timeout);
      if (!navigator.onLine) throw new Error('Pas de connexion internet.');
      if (e.name === 'AbortError') throw new Error(isIA ? "L'IA prend plus de temps que prévu 🤖" : 'Serveur trop lent (>8s)');
      throw e;
    }
  }, {
    priority:  _netPriorityForPath(path),
    ttl:       _netTtlForPath(path, body),
    // ✅ v8.8 — Admin reads : 0 retry. Évite le pic 9× quand le worker est degraded.
    //   Les autres endpoints gardent retry: 2 pour résister aux blips DNS transitoires.
    retry:     isAdminRead ? 0 : 2,
    dedupe:    true,
    cacheable: true,
  });
}

async function wpost(path,body)   { return _apiFetch(path,body); }
async function apiCall(path,body) { return _apiFetch(path,body); }

/* ════════════════════════════════════════════════════════════════════════
   BOOT-SYNC v8.7 — Orchestrateur global pour réduire le DNS overflow
   ────────────────────────────────────────────────────────────────────────
   Au lieu que chaque module fasse son propre fetch au boot (6 appels
   parallèles = 18 fetches Supabase = saturation cache DNS Cloudflare),
   on appelle UN SEUL endpoint /boot-sync qui retourne tout en 1 fois.

   Les modules existants peuvent appeler bootSyncGet('patients') au
   lieu de wpost('/webhook/patients-pull'). Si le cache est vide ou
   l'endpoint indisponible, fallback automatique sur l'ancien comportement.

   Usage :
     - bootSyncStart()          → lance le pull (à appeler 1x au login)
     - bootSyncGet('patients')  → renvoie les données patients (await la promesse en cours si pas encore fini)
     - bootSyncGet('km')        → idem pour km
     - etc.
   ═══════════════════════════════════════════════════════════════════════ */
let _BOOT_SYNC_PROMISE = null;
let _BOOT_SYNC_DATA = null;
let _BOOT_SYNC_TS = 0;
const _BOOT_SYNC_TTL = 30000; // 30s — suffisant pour couvrir le boot complet

async function bootSyncStart(force = false) {
  // Si déjà en cours → renvoie la promesse existante (déduplication)
  if (_BOOT_SYNC_PROMISE && !force) return _BOOT_SYNC_PROMISE;
  // Si données en cache et pas expirées → retour immédiat
  if (!force && _BOOT_SYNC_DATA && (Date.now() - _BOOT_SYNC_TS) < _BOOT_SYNC_TTL) {
    return _BOOT_SYNC_DATA;
  }
  // ✅ Garde-fou : ne tenter le fetch QUE si un token est présent.
  //   Sans cette garde, un appel pré-login ferait un POST sans Authorization,
  //   le worker répondrait 401, et la session existante serait potentiellement clear.
  if (typeof ss === 'undefined' || !ss.tok || !ss.tok()) {
    return null;
  }
  _BOOT_SYNC_PROMISE = (async () => {
    try {
      // ✅ v3.10 — Passe par NET.request pour bénéficier du scheduler global :
      //   priorité 2 (très haute, juste après login), dédup, cache 5s.
      //   En cas de 401/404/503, retourne null (fallback silencieux),
      //   les modules retomberont sur leurs endpoints individuels.
      const data = await NET.request('boot-sync:' + ss.tok().slice(-8), async () => {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(W + '/webhook/boot-sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + ss.tok(),
            },
            body: '{}',
            signal: ctrl.signal,
          });
          clearTimeout(tid);
          if (!res.ok) {
            // 503 → throw pour que NET retente avec backoff
            if (res.status === 503) throw new Error('503 Service Unavailable');
            // 401 / 404 → fallback silencieux (pas de clear session)
            return null;
          }
          return await res.json().catch(() => null);
        } catch (e) {
          clearTimeout(tid);
          throw e;
        }
      }, {
        priority:  2,
        ttl:       5000,
        retry:     2,
        dedupe:    true,
        cacheable: true,
      });

      if (data && data.ok) {
        _BOOT_SYNC_DATA = data;
        _BOOT_SYNC_TS = Date.now();
        return data;
      }
      return null;
    } catch (e) {
      // Fallback silencieux : les modules retomberont sur leurs endpoints individuels
      console.debug('[boot-sync] indisponible, fallback sur endpoints individuels:', e.message);
      return null;
    } finally {
      _BOOT_SYNC_PROMISE = null;
    }
  })();
  return _BOOT_SYNC_PROMISE;
}

/**
 * Récupère les données d'un module depuis le boot-sync.
 * Si le boot-sync n'est pas encore fait, le déclenche.
 * Si l'endpoint /boot-sync n'est pas disponible (ancien worker), retourne null
 * → le module appelant doit alors utiliser son endpoint individuel.
 *
 * Modules disponibles : patients, km, signatures, piluliers, constantes,
 *                       consentements, bsi, cr_passage, ngap_active
 */
async function bootSyncGet(module) {
  const data = await bootSyncStart();
  if (!data) return null;
  return data[module] || null;
}

/**
 * Invalide le cache boot-sync, forcera un nouveau pull au prochain bootSyncGet.
 * À appeler après une action utilisateur qui change l'état serveur (ex: push).
 */
function bootSyncInvalidate() {
  _BOOT_SYNC_DATA = null;
  _BOOT_SYNC_TS = 0;
  _BOOT_SYNC_PROMISE = null;
  // Invalider aussi le cache NET pour les requêtes liées au boot
  if (typeof NET !== 'undefined') {
    NET.invalidate('boot-sync:');
  }
}

if (typeof window !== 'undefined') {
  window.bootSyncStart = bootSyncStart;
  window.bootSyncGet = bootSyncGet;
  window.bootSyncInvalidate = bootSyncInvalidate;
}

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
