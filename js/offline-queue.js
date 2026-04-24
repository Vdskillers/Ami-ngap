/* ════════════════════════════════════════════════
   offline-queue.js — AMI NGAP
   ────────────────────────────────────────────────
   ✅ File d'attente cotations hors-ligne
      - queueCotation()       — mise en file si offline
      - syncOfflineQueue()    — sync quand connexion revient
      - loadQueueStatus()     — affiche le nombre en attente
   ✅ Statistiques avancées
      - loadStatsAvancees()   — comparatifs mois/mois, déclin actes
      - renderStatsAvancees() — rendu graphique
   ✅ Onboarding première connexion
      - checkOnboarding()     — détecte première connexion
      - showOnboarding()      — assistant guidé en 4 étapes
      - completeOnboarding()  — marque terminé
   ✅ Notifications toast
      - showToast(msg, type)  — toast système
      - scheduleReminder()    — rappels quotidiens (notification web)
════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   FILE D'ATTENTE HORS-LIGNE
   ═══════════════════════════════════════════════ */

const OFFLINE_QUEUE_KEY = 'ami_offline_queue';

function _getQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)||'[]'); } catch { return []; }
}
function _saveQueue(q) {
  try { localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q)); } catch {}
}

/* Ajouter une cotation à la file si hors-ligne */
function queueCotation(payload) {
  const q = _getQueue();
  q.push({ ...payload, _queued_at: new Date().toISOString(), _id: 'q_'+Date.now() });
  _saveQueue(q);
  _updateQueueBadge();
  showToast(`📡 Hors-ligne — cotation mise en file (${q.length} en attente)`, 'warn');
}

/* Synchronisation quand la connexion revient */
async function syncOfflineQueue() {
  const q = _getQueue();
  if (!q.length) return;

  let synced = 0;
  const failed = [];

  for (const item of q) {
    try {
      const { _queued_at, _id, ...payload } = item;
      const result = await apiCall('/webhook/ami-calcul', payload);
      // Si l'API retourne une cotation valide avec actes, sauvegarder en IDB
      if (result?.actes?.length && result?.total > 0) {
        const _CODES_MAJ_OQ = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
        const _hasTech = (result.actes || []).some(a => !_CODES_MAJ_OQ.has((a.code||'').toUpperCase()));
        if (_hasTech && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
          try {
            const _patNom = (payload.patient_nom || '').trim();
            if (_patNom) {
              const _rows = await _idbGetAll(PATIENTS_STORE);
              const _nomLow = _patNom.toLowerCase();
              const _row = _rows.find(r =>
                ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
                ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
              );
              if (_row && typeof _dec === 'function' && typeof _enc === 'function') {
                const _p = { ...(_dec(_row._data)||{}), id: _row.id, nom: _row.nom, prenom: _row.prenom };
                if (!Array.isArray(_p.cotations)) _p.cotations = [];
                const _todayOQ = (payload.date_soin || new Date().toISOString().slice(0,10));
                // Dédoublonnage strict :
                // 1. Si invoice_number présent → match exact par invoice_number
                // 2. Sinon → match par (source + date + total) pour différencier
                //    plusieurs soins du même jour pour le même patient
                //    (ex: insuline 9h vs insuline 18h, montants identiques mais
                //    cotations distinctes). Sans le filtre `total`, le 2e soin
                //    écraserait le 1er → perte de données.
                const _resTotalOQ = parseFloat(result.total || 0);
                const _existOQ = result.invoice_number
                  ? _p.cotations.findIndex(c => c.invoice_number === result.invoice_number)
                  : _p.cotations.findIndex(c =>
                      c.source === 'offline_queue' &&
                      (c.date || '').slice(0, 10) === _todayOQ &&
                      Math.abs(parseFloat(c.total || 0) - _resTotalOQ) < 0.01
                    );
                const _cotOQ = {
                  date: payload.date_soin || new Date().toISOString(),
                  heure: payload.heure_soin || '',
                  actes: result.actes, total: parseFloat(result.total),
                  soin: (payload.texte||'').slice(0,120),
                  source: 'offline_queue', invoice_number: result.invoice_number || null,
                  _synced: true, updated_at: new Date().toISOString(),
                };
                if (_existOQ >= 0) { _p.cotations[_existOQ] = _cotOQ; }
                else { _p.cotations.push(_cotOQ); }
                _p.updated_at = new Date().toISOString();
                await _idbPut(PATIENTS_STORE, { id: _p.id, nom: _p.nom, prenom: _p.prenom, _data: _enc(_p), updated_at: _p.updated_at });
              }
            }
          } catch (_eOQ) { console.warn('[offline-queue] IDB save KO:', _eOQ.message); }
        }
      }
      synced++;
    } catch {
      failed.push(item);
    }
  }

  _saveQueue(failed);
  _updateQueueBadge();

  if (synced > 0) {
    showToast(`✅ ${synced} cotation(s) synchronisée(s) automatiquement`, 'ok');
  }
  if (failed.length > 0) {
    showToast(`⚠️ ${failed.length} cotation(s) non synchronisée(s)`, 'warn');
  }
}

/* Badge file en attente */
function _updateQueueBadge() {
  const q = _getQueue();
  const badge = document.getElementById('offline-queue-badge');
  if (badge) {
    badge.textContent = q.length > 0 ? q.length : '';
    badge.style.display = q.length > 0 ? 'inline' : 'none';
  }
  // ⚠️ Bannière #offline-banner volontairement NON manipulée ici :
  // la bannière orange haute (#oa-offline-badge, offline-auth.js:418)
  // est la source unique de vérité pour le statut hors-ligne.
  // L'ancien doublon gris créait 2 barres empilées sur mobile.
}

/* Écouter la reconnexion */
window.addEventListener('online',  () => { _updateQueueBadge(); syncOfflineQueue(); showToast('🌐 Connexion rétablie — synchronisation en cours…', 'ok'); });
window.addEventListener('offline', () => { _updateQueueBadge(); showToast('📡 Hors-ligne — les cotations seront mises en file', 'warn'); });

/* ═══════════════════════════════════════════════
   STATISTIQUES AVANCÉES
   ═══════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   _buildHeureIndex() — construit un index { "YYYY-MM-DD": "HH:MM" }
   depuis les données locales de l'utilisateur connecté (planning + tournée).
   ⚠️  Isolation garantie : la clé localStorage est ami_planning_<userId>
       → chaque utilisateur (infirmière OU admin) ne lit que ses propres heures.
       Pour les admins, heure_soin est retiré de la réponse API (RGPD/HDS),
       mais ils voient leurs propres heures de test via ce mécanisme local.
───────────────────────────────────────────────────────────────────────── */
/* ── Clé localStorage cache des heures — isolée par userId ──────────────────
   Persiste les heure_soin entre sessions pour l'analyse horaire.
   Structure : { "id_cotation": "HH:MM", "YYYY-MM-DD": "HH:MM", ... }
   Alimenté à chaque réponse API avec heure_soin non null.
   
   Stratégie de clé robuste :
   - Clé principale  : ami_heure_cache_<userId-UUID>  (isolée par compte)
   - Clé de secours  : ami_heure_cache_local          (quand userId inconnu)
   - Migration auto  : au login, les données "local" sont fusionnées dans la clé UUID
   → garantit qu'aucune heure n'est perdue même si S n'est pas encore hydraté
────────────────────────────────────────────────────────────────────────── */
function _heureCacheKey() {
  // 1. S hydraté en mémoire (cas normal — session active)
  let uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
  // 2. sessionStorage (page rechargée, S pas encore réhydraté par checkAuth)
  if (!uid) {
    try { uid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {}
  }
  // 3. localStorage longue durée (survit aux fermetures de navigateur)
  if (!uid) {
    try { uid = JSON.parse(localStorage.getItem('ami_last_uid') || 'null'); } catch {}
  }
  return 'ami_heure_cache_' + String(uid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _loadHeureCache() {
  try { return JSON.parse(localStorage.getItem(_heureCacheKey()) || '{}'); } catch { return {}; }
}

function _saveHeureCache(cache) {
  // Persister aussi le userId courant pour les lectures futures avant réhydratation S
  try {
    const uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    if (uid) localStorage.setItem('ami_last_uid', JSON.stringify(uid));
    localStorage.setItem(_heureCacheKey(), JSON.stringify(cache));
  } catch {}
}

/* ── Migration : fusionne ami_heure_cache_local → clé userId au login ──────
   Appelé après login quand S est hydraté. Évite de perdre les heures
   mémorisées pendant une session où userId n'était pas encore disponible.
──────────────────────────────────────────────────────────────────────────── */
function _migrateHeureCacheLocal() {
  try {
    const uid = S?.user?.id;
    if (!uid) return;
    // Mettre à jour ami_last_uid maintenant qu'on a l'UUID
    localStorage.setItem('ami_last_uid', JSON.stringify(uid));
    const localKey  = 'ami_heure_cache_local';
    const localData = localStorage.getItem(localKey);
    if (!localData) return;
    const local   = JSON.parse(localData);
    if (!Object.keys(local).length) return;
    // Merge : clé UUID existante + données local (UUID prioritaire)
    const realKey = 'ami_heure_cache_' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
    const existing = JSON.parse(localStorage.getItem(realKey) || '{}');
    const merged   = { ...local, ...existing }; // existing (UUID) prioritaire
    localStorage.setItem(realKey, JSON.stringify(merged));
    localStorage.removeItem(localKey); // nettoyer le fallback
  } catch {}
}

/* Mémorise les heures depuis un tableau de cotations retourné par l'API */
function _updateHeureCache(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const cache = _loadHeureCache();
  let changed = false;
  rows.forEach(r => {
    const heure = (r.heure_soin || '').trim().slice(0, 5);
    if (!heure || !/^\d{1,2}:\d{2}/.test(heure)) return;
    // Indexer par id (clé stable) ET par date (fallback)
    if (r.id)       { cache[String(r.id)]                         = heure; changed = true; }
    if (r.date_soin){ cache[(r.date_soin||'').slice(0,10)]        = heure; changed = true; }
  });
  if (changed) {
    _saveHeureCache(cache);
    _scheduleSyncHeureCache(); // push cross-appareils (debounced 5s)
  }
}

/* ── Sync serveur du cache heures (push) — cross-appareils PC ↔ mobile ──
   Données NON sensibles : { id: "HH:MM", "YYYY-MM-DD": "HH:MM" }
   Aucun nom patient, aucune donnée médicale. Uniquement pour l'analyse horaire.
   Debounced 5 secondes pour éviter les appels répétés en rafale.
   Admins ignorés : leurs heures de test restent locales.
──────────────────────────────────────────────────────────────────────── */
let _syncHeureCacheTimer = null;
function _scheduleSyncHeureCache() {
  if (_syncHeureCacheTimer) clearTimeout(_syncHeureCacheTimer);
  _syncHeureCacheTimer = setTimeout(syncHeureCache, 5000);
}

async function syncHeureCache() {
  _syncHeureCacheTimer = null;
  // Accessible admins ET infirmières : chacun synchronise ses propres heures
  if (!navigator.onLine) return;
  try {
    const cache = _loadHeureCache();
    if (!Object.keys(cache).length) return;
    const data = JSON.stringify(cache);
    await wpost('/webhook/heure-push', { data, updated_at: new Date().toISOString() });
  } catch(e) { /* silencieux — non critique */ }
}

/* ── Pull du cache heures depuis le serveur (cross-appareils) ──────────
   Appelé au chargement du dashboard et après login.
   Merge : les entrées serveur complètent le cache local (union des deux).
   La clé locale gagne en cas de conflit (données saisies sur cet appareil).
──────────────────────────────────────────────────────────────────────── */
async function pullHeureCache() {
  // Accessible admins ET infirmières : chacun récupère ses propres heures
  if (!navigator.onLine) return;
  try {
    const d = await wpost('/webhook/heure-pull', {});
    if (!d?.data?.data) return;
    let remote;
    try { remote = JSON.parse(d.data.data); } catch { return; }
    if (typeof remote !== 'object' || Array.isArray(remote)) return;
    // Merge : local + remote (local prioritaire)
    const local  = _loadHeureCache();
    const merged = { ...remote, ...local }; // local écrase remote
    _saveHeureCache(merged);
  } catch(e) { /* silencieux — non critique */ }
}

function _buildHeureIndex() {
  const idx = {};

  // ── Source 1 : planning sauvegardé en localStorage (ami_planning_<userId>) ──
  // Clé isolée par utilisateur — aucun risque de croiser les données entre comptes.
  // ⚠️ La clé sessionStorage correcte est 'ami' (définie dans utils.js → ss.save/load).
  try {
    let uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    if (!uid) {
      try { uid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {}
    }
    uid = uid || 'local';
    const planKey = 'ami_planning_' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
    const raw = localStorage.getItem(planKey);
    if (raw) {
      const data = JSON.parse(raw);
      const patients = Array.isArray(data.patients) ? data.patients
                     : Array.isArray(data)           ? data
                     : [];
      patients.forEach(p => {
        const heure = (p.heure_soin || p.heure_preferee || p.heure || '').trim().slice(0, 5);
        const date  = (p.date_soin  || p.date || '').slice(0, 10);
        if (date && heure && /^\d{1,2}:\d{2}/.test(heure)) idx[date] = heure;
      });
    }
  } catch {}

  // ── Source 2 : APP.importedData en mémoire (tournée du jour) ──────────────
  try {
    const pts = (typeof APP !== 'undefined')
      ? (APP.importedData?.patients || APP.importedData?.entries || [])
      : [];
    pts.forEach(p => {
      const heure = (p.heure_soin || p.heure_preferee || p.heure || '').trim().slice(0, 5);
      const date  = (p.date_soin  || p.date || '').slice(0, 10);
      if (date && heure && /^\d{1,2}:\d{2}/.test(heure)) idx[date] = heure;
    });
  } catch {}

  // ── Source 3 : cache persistant localStorage (ami_heure_cache_<userId>) ───
  // Mémorise les heure_soin vus lors des sessions précédentes.
  // Permet l'analyse horaire même pour des cotations anciennes sans planning actif.
  try {
    const cache = _loadHeureCache();
    Object.entries(cache).forEach(([k, v]) => {
      // Ne garder que les clés au format date YYYY-MM-DD (pas les ids numériques)
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v && !idx[k]) idx[k] = v;
    });
  } catch {}

  return idx;
}

async function loadStatsAvancees() {
  const el = $('stats-avancees-body');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:30px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto 8px"></div></div>';

  try {
    // Charger 3 mois pour comparatif
    const [m3, m2, m1] = await Promise.all([
      fetchAPI('/webhook/ami-historique?period=3month').catch(()=>({data:[]})),
      fetchAPI('/webhook/ami-historique?period=lastmonth').catch(()=>({data:[]})),
      fetchAPI('/webhook/ami-historique?period=month').catch(()=>({data:[]})),
    ]);

    const arr3 = Array.isArray(m3?.data) ? m3.data : [];
    const arr2 = Array.isArray(m2?.data) ? m2.data : [];
    let   arr1 = Array.isArray(m1?.data) ? m1.data : [];

    // ── Mémoriser les heures reçues de l'API dans le cache persistant ─────────
    // Chaque fois qu'une cotation arrive avec heure_soin non null, on la mémorise
    // pour qu'elle soit disponible lors des prochaines sessions (analyse horaire).
    _updateHeureCache([...arr1, ...arr2, ...arr3]);

    // ── Pull cross-appareils : récupérer les heures saisies sur mobile/PC ─────
    // Merge silencieux — complète le cache local avec les heures de l'autre appareil.
    await pullHeureCache();

    // ── Enrichissement horaire depuis le planning local de l'utilisateur ──────
    // heure_soin est retourné par l'API pour admins ET infirmières (worker.js).
    // Ce bloc complète les cotations où heure_soin est null (ex: import ICS, anciennes cotations).
    // L'isolation est garantie — chacun ne lit que sa propre clé localStorage.
    try {
      // Source A : cache persistant par id (plus précis — évite les collisions de date)
      const heureCache = _loadHeureCache();
      arr1 = arr1.map(r => {
        if (r.heure_soin) return r;
        const cached = r.id ? heureCache[String(r.id)] : null;
        if (cached) return { ...r, heure_soin: cached };
        return r;
      });

      // Source B : index planning local par date (fallback)
      const heureIdx = _buildHeureIndex();
      if (Object.keys(heureIdx).length) {
        arr1 = arr1.map(r => {
          if (r.heure_soin) return r;
          const date = (r.date_soin || '').slice(0, 10);
          if (date && heureIdx[date]) return { ...r, heure_soin: heureIdx[date] };
          return r;
        });
      }
    } catch {}

    renderStatsAvancees(arr1, arr2, arr3);
  } catch(e) {
    el.innerHTML = `<div class="ai er">⚠️ ${e.message}</div>`;
  }
}

function renderStatsAvancees(moisActuel, moisPrecedent, trois_mois) {
  const el = $('stats-avancees-body');
  if (!el) return;

  const sum = arr => arr.reduce((s,r) => s + parseFloat(r.total||0), 0);
  const ca1  = sum(moisActuel);
  const ca2  = sum(moisPrecedent);
  const ca3  = sum(trois_mois);
  const evo  = ca2 > 0 ? ((ca1 - ca2) / ca2 * 100) : 0;
  const evoColor = evo >= 0 ? 'var(--ok)' : 'var(--d)';

  // ── Km du mois — barème dynamique depuis préférences véhicule ────────────
  let kmMois = 0, kmDeduction = 0, kmBaremeLabel = '5 CV';
  try {
    let kmUid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    if (!kmUid) {
      try { kmUid = JSON.parse(sessionStorage.getItem('ami') || 'null')?.user?.id || null; } catch {}
    }
    const kmKey = 'ami_km_journal_' + String(kmUid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const kmEntries = JSON.parse(localStorage.getItem(kmKey) || '[]');
    const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const filtered = kmEntries.filter(e => new Date(e.date) >= since);
    kmMois = Math.round(filtered.reduce((s, e) => s + parseFloat(e.km||0), 0) * 10) / 10;

    const kmAnnuel = kmEntries.filter(e => new Date(e.date).getFullYear() === new Date().getFullYear())
      .reduce((s, e) => s + parseFloat(e.km||0), 0);

    // Lire les préférences véhicule partagées (clé commune à tresorerie.js + infirmiere-tools.js)
    const prefsKey  = 'ami_km_prefs_' + String(kmUid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefs     = (() => { try { return JSON.parse(localStorage.getItem(prefsKey)||'{}'); } catch { return {}; } })();
    const cv        = parseInt(prefs.cv) || 5;
    const electrique = !!prefs.electrique;

    // Barème 2025/2026 — même table que infirmiere-tools.js + tresorerie.js
    const KM_B = {
      3:{t1:0.529,t2a:0.316,t2b:1065,t3:0.370,label:'3 CV'},
      4:{t1:0.606,t2a:0.340,t2b:1330,t3:0.407,label:'4 CV'},
      5:{t1:0.636,t2a:0.357,t2b:1395,t3:0.427,label:'5 CV'},
      6:{t1:0.665,t2a:0.374,t2b:1457,t3:0.447,label:'6 CV'},
      7:{t1:0.697,t2a:0.394,t2b:1515,t3:0.470,label:'7 CV et +'},
    };
    const b = KM_B[cv] || KM_B[5];
    let taux = kmAnnuel <= 5000 ? b.t1 : kmAnnuel <= 20000 ? b.t2a + b.t2b/kmAnnuel : b.t3;
    if (electrique) taux *= 1.20;

    kmDeduction   = Math.round(kmMois * taux * 100) / 100;
    kmBaremeLabel = b.label + (electrique ? ' · ⚡ électrique' : '');
  } catch {}

  // Actes par fréquence — mois actuel vs précédent
  const freqActes = (arr) => {
    const f = {};
    arr.forEach(r => {
      try { JSON.parse(r.actes||'[]').forEach(a => { if(a.code && a.code!=='IMPORT') f[a.code]=(f[a.code]||0)+1; }); } catch {}
    });
    return f;
  };
  const freq1 = freqActes(moisActuel);
  const freq2 = freqActes(moisPrecedent);
  const allCodes = [...new Set([...Object.keys(freq1), ...Object.keys(freq2)])].sort();

  // Calcul jours travaillés
  const joursSet = new Set(moisActuel.map(r => (r.date_soin||'').slice(0,10)).filter(Boolean));
  const joursTravailles = joursSet.size;
  const caParJour = joursTravailles > 0 ? ca1 / joursTravailles : 0;

  // Top patient (par fréquence de passage — anonymisé)
  const patFreq = {};
  moisActuel.forEach(r => { const pid = r.patient_id||'?'; patFreq[pid]=(patFreq[pid]||0)+1; });
  const topPatient = Object.entries(patFreq).sort((a,b)=>b[1]-a[1])[0];

  // Delta badge helper
  const deltaBadge = (pct) => {
    if (Math.abs(pct) < 0.5) return `<span class="sc-delta nt">→ stable</span>`;
    return pct > 0
      ? `<span class="sc-delta up">↑ +${Math.abs(pct).toFixed(1)}%</span>`
      : `<span class="sc-delta dn">↓ −${Math.abs(pct).toFixed(1)}%</span>`;
  };

  el.innerHTML = `
    <!-- ── Séparateur titre ── -->
    <div style="border-top:1px solid var(--b);margin:28px 0 20px"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
      <div class="dash-section-title" style="margin-bottom:0">Comparatif mensuel</div>
    </div>

    <!-- KPIs comparatif — même style .sc avec delta -->
    <div class="sg" style="grid-template-columns:repeat(auto-fill,minmax(175px,1fr));margin-bottom:20px">
      <div class="sc g">
        <div class="si">📅</div>
        <div class="sv">${ca1.toFixed(0)} €</div>
        <div class="sn">Mois actuel</div>
        ${deltaBadge(evo)}
      </div>
      <div class="sc b">
        <div class="si">🗓️</div>
        <div class="sv">${ca2.toFixed(0)} €</div>
        <div class="sn">Mois précédent</div>
      </div>
      <div class="sc ${evo>=0?'g':'r'}">
        <div class="si">${evo>=0?'↑':'↓'}</div>
        <div class="sv">${evo>=0?'+':''}${evo.toFixed(1)}%</div>
        <div class="sn">Évolution M/M-1</div>
      </div>
      <div class="sc o">
        <div class="si">📆</div>
        <div class="sv">${joursTravailles}j</div>
        <div class="sn">Jours travaillés</div>
      </div>
      <div class="sc b">
        <div class="si">💹</div>
        <div class="sv">${caParJour.toFixed(0)} €</div>
        <div class="sn">CA / jour moyen</div>
      </div>
      <div class="sc g">
        <div class="si">📈</div>
        <div class="sv">${ca3.toFixed(0)} €</div>
        <div class="sn">3 mois cumulés</div>
      </div>
      ${kmMois > 0 ? `<div class="sc b"><div class="si">🚗</div><div class="sv">${kmMois} km</div><div class="sn">Km ce mois</div><span class="sc-delta nt" style="font-size:9px">${kmBaremeLabel}</span></div>` : ''}
      ${kmDeduction > 0 ? `<div class="sc g"><div class="si">💸</div><div class="sv">${kmDeduction} €</div><div class="sn">Déd. fiscale km</div></div>` : ''}
    </div>

    ${evo < -10 ? `<div class="dash-alert-strip r" style="margin-bottom:20px;border-radius:10px"><div class="dash-alert-dot"></div><div class="dash-alert-text">Baisse de CA de ${Math.abs(evo).toFixed(0)}% vs mois précédent — vérifiez vos cotations manquées</div></div>` : ''}
    ${evo > 15  ? `<div class="dash-alert-strip g" style="margin-bottom:20px;border-radius:10px"><div class="dash-alert-dot"></div><div class="dash-alert-text">Excellente progression <strong>+${evo.toFixed(0)}%</strong> ce mois !</div></div>` : ''}

    <!-- ── Évolution des actes ── -->
    <div style="border-top:1px solid var(--b);margin-bottom:20px"></div>
    <div class="dash-section-title" style="margin-bottom:14px">
      Évolution des actes (M vs M-1)
      <span class="dash-section-badge b">${allCodes.length} actes</span>
    </div>
    ${allCodes.length ? `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px">
      ${allCodes.map(code => {
        const n1 = freq1[code]||0, n2 = freq2[code]||0;
        const diff = n1 - n2;
        const pct  = n2 > 0 ? Math.round((n1-n2)/n2*100) : (n1>0?100:0);
        const color= diff > 0 ? 'var(--ok)' : diff < 0 ? 'var(--d)' : 'var(--m)';
        const icon = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
        const maxN = Math.max(...Object.values(freq1), 1);
        return `<div class="acte-row-prem">
          <div class="acte-rank">${icon}</div>
          <div class="acte-code-pill">${code}</div>
          <div class="acte-bar-track"><div class="acte-bar-fill-prem" style="width:${Math.min(n1/maxN*100,100)}%"></div></div>
          <div style="font-size:11px;font-family:var(--fm);color:var(--t);width:28px;text-align:right;flex-shrink:0">${n1}×</div>
          <div style="font-size:10px;font-family:var(--fm);color:${color};width:42px;text-align:right;flex-shrink:0">${diff>0?'+':''}${diff}× M-1</div>
        </div>`;
      }).join('')}
    </div>` : '<div class="ai in" style="margin-bottom:20px">Pas encore assez de données pour comparer.</div>'}

    <!-- ── Analyse horaire ── -->
    <div style="border-top:1px solid var(--b);margin-bottom:20px"></div>
    <div class="dash-section-title" style="margin-bottom:14px">Analyse horaire</div>
    ${_renderHeureStats(moisActuel)}
  `;
}

function _renderHeureStats(arr) {
  const byHour = {};

  const heureCache = _loadHeureCache();
  const heureIdx = _buildHeureIndex();

  arr.forEach(r => {
    let h = '';
    const hSoin = (r.heure_soin || '').trim().slice(0, 2);
    if (hSoin && !isNaN(parseInt(hSoin))) h = hSoin;
    if (!h && r.id) {
      const cached = heureCache[String(r.id)];
      if (cached) h = (cached || '').trim().slice(0, 2);
    }
    if (!h) {
      const date = (r.date_soin || '').slice(0, 10);
      if (date && heureIdx[date]) {
        const hLocal = heureIdx[date].trim().slice(0, 2);
        if (!isNaN(parseInt(hLocal))) h = hLocal;
      }
    }
    if (!h) {
      const date = (r.date_soin || '').slice(0, 10);
      if (date && heureCache[date]) h = (heureCache[date] || '').trim().slice(0, 2);
    }
    if (!h && r.date_soin && r.date_soin.includes('T')) {
      const timePart = r.date_soin.split('T')[1] || '';
      const hIso = timePart.slice(0, 2);
      if (hIso && !isNaN(parseInt(hIso)) && parseInt(hIso) < 24) h = hIso;
    }
    if (!h) {
      const txt = (r.notes || r.description || r.texte || '').toLowerCase();
      const matchH = txt.match(/\b(\d{1,2})[h:]\d{0,2}\b/);
      if (matchH) {
        h = String(parseInt(matchH[1])).padStart(2, '0');
      } else if (/matin\b|morning/.test(txt))          h = '09';
      else if (/apr[eè]s.?midi\b|afternoon/.test(txt)) h = '14';
      else if (/\bsoir\b|evening/.test(txt))           h = '19';
    }
    if (h && !isNaN(parseInt(h))) {
      const k = parseInt(h);
      if (k >= 0 && k <= 23) byHour[k] = (byHour[k] || 0) + 1;
    }
  });

  if (!Object.keys(byHour).length) {
    return `<div class="ai in" style="display:flex;flex-direction:column;gap:6px;padding:12px 0">
      <span>Aucune heure de soin détectée sur cette période.</span>
      <span style="font-size:11px;color:var(--m);font-family:var(--fm);line-height:1.5">
        💡 Renseignez le champ <strong>Heure du soin</strong> lors de la cotation,
        ou importez un planning avec des créneaux horaires.
      </span>
    </div>`;
  }

  const max = Math.max(...Object.values(byHour), 1);
  const hours = Array.from({length:24},(_,i)=>i);

  // Tranches horaires colorées identiques au dashboard
  const barColor = h => h < 8 ? 'rgba(255,95,109,.7)' : h < 12 ? 'var(--a)' : h < 18 ? 'var(--a2)' : 'rgba(255,181,71,.8)';

  // Heure pic
  const peakHour = Object.entries(byHour).sort((a,b)=>b[1]-a[1])[0];

  return `
    <!-- Graphe barres 24h -->
    <div style="display:flex;align-items:flex-end;gap:2px;height:80px;margin-bottom:4px">
      ${hours.map(h => {
        const count = byHour[h]||0;
        const height = count > 0 ? Math.max(6, Math.round(count/max*72)) : 3;
        return `<div title="${h}h : ${count} soin(s)" style="flex:1;height:${height}px;background:${count>0?barColor(h):'var(--b)'};border-radius:2px 2px 0 0;opacity:${count>0?1:0.25};transition:height .3s;cursor:help"></div>`;
      }).join('')}
    </div>
    <div style="display:flex;gap:0;margin-bottom:14px;font-family:var(--fm);font-size:8px;color:var(--m)">
      ${hours.map(h => `<div style="flex:1;text-align:center">${h%6===0?h+'h':''}</div>`).join('')}
    </div>

    <!-- Légende couleurs + stat pic -->
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--m)"><div style="width:10px;height:10px;border-radius:2px;background:rgba(255,95,109,.7)"></div>Nuit (0–7h)</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--m)"><div style="width:10px;height:10px;border-radius:2px;background:var(--a)"></div>Matin (8–11h)</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--m)"><div style="width:10px;height:10px;border-radius:2px;background:var(--a2)"></div>Après-midi (12–17h)</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--m)"><div style="width:10px;height:10px;border-radius:2px;background:rgba(255,181,71,.8)"></div>Soir (18–23h)</div>
      ${peakHour ? `<div style="margin-left:auto;font-size:11px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);border:1px solid rgba(0,212,170,.2);padding:2px 10px;border-radius:10px">⏰ Pic : ${peakHour[0]}h (${peakHour[1]} soins)</div>` : ''}
    </div>

    <!-- Heatmap compacte 24 cases (0h→23h) -->
    <div style="display:grid;grid-template-columns:repeat(24,1fr);gap:3px;margin-bottom:4px">
      ${hours.map(h => {
        const count = byHour[h]||0;
        const intensity = count===0 ? 0 : count < max*0.25 ? 1 : count < max*0.5 ? 2 : count < max*0.75 ? 3 : 4;
        return `<div class="hm-cell h${intensity}" title="${h}h : ${count} soin(s)"></div>`;
      }).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:8px;color:var(--m);font-family:var(--fm)">
      <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
    </div>`;
}

/* ═══════════════════════════════════════════════
   TOAST SYSTÈME GLOBAL
   ═══════════════════════════════════════════════ */

let _toastTimer = null;

function showToast(msg, type='ok') {
  // ── Adaptateur : traduit l'ancienne signature (msg, type) vers la nouvelle
  //    window.showToast(type, title, msg, duration) définie dans index.html
  //    Évite l'affichage "I undefined" quand les deux coexistent.
  if (typeof window.showToast === 'function' && window.showToast !== showToast) {
    // Conversion ancienne → nouvelle signature
    const typeMap = { ok:'success', warn:'warning', err:'error', info:'info' };
    const newType = typeMap[type] || 'info';
    // Extraire un titre court depuis le message (avant le premier '—' ou '.')
    const titleMatch = String(msg || '').match(/^([^—\n]{1,60})/);
    const title = titleMatch ? titleMatch[1].trim() : (msg || '');
    window.showToast(newType, title, '', 3500);
    return;
  }
  // ── Fallback : ancienne implémentation si window.showToast n'est pas encore chargée
  let toast = document.getElementById('ami-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ami-toast';
    toast.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);
      background:rgba(17,23,32,.97);border:1px solid var(--b);border-radius:10px;
      padding:12px 20px;font-size:13px;z-index:9999;color:var(--t);
      pointer-events:none;transition:opacity .25s,transform .25s;opacity:0;
      max-width:340px;text-align:center;backdrop-filter:blur(12px);
      box-shadow:0 4px 24px rgba(0,0,0,.5)`;
    document.body.appendChild(toast);
  }
  const colors = { ok:'var(--a)', warn:'var(--w)', err:'var(--d)', info:'var(--a2)' };
  toast.style.borderColor = colors[type]||'var(--b)';
  toast.textContent = msg || '';
  toast.style.opacity  = '1';
  toast.style.transform= 'translateX(-50%) translateY(0)';

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.style.opacity  = '0';
    toast.style.transform= 'translateX(-50%) translateY(10px)';
  }, 3500);
}

/* ═══════════════════════════════════════════════
   ONBOARDING PREMIÈRE CONNEXION
   ═══════════════════════════════════════════════ */

// Clé d'onboarding par utilisateur (email) pour que chaque compte ait sa propre première connexion
function _getOnboardingKey() {
  const email = (typeof S !== 'undefined' && S?.user?.email) ? S.user.email : 'default';
  return 'ami_onboarding_done_' + btoa(email).replace(/=/g,'');
}
// Compatibilité : ONBOARDING_KEY statique pour les appels externes (resetOnboarding)
const ONBOARDING_KEY = 'ami_onboarding_done';

const ONBOARDING_STEPS = [
  {
    icon: '🩺',
    title: 'Bienvenue dans AMI !',
    text: 'AMI est votre assistant de cotation NGAP intelligent. Il analyse vos descriptions de soins et génère automatiquement la cotation correcte avec les majorations applicables.',
    action: 'Découvrir la cotation',
    nav: 'cot'
  },
  {
    icon: '👤',
    title: 'Complétez votre profil',
    text: 'Pour générer des factures conformes CPAM, renseignez votre N° ADELI, RPPS et cabinet. Ces informations apparaîtront sur vos feuilles de soins.',
    action: 'Ouvrir mon profil',
    nav: 'profil'
  },
  {
    icon: '🗺️',
    title: 'Planifiez votre tournée',
    text: 'Importez votre planning (ICS, CSV, texte libre) et laissez l\'IA optimiser votre tournée. Le moteur VRPTW calcule le meilleur ordre en fonction du trafic réel.',
    action: 'Importer un planning',
    nav: 'imp'
  },
  {
    icon: '💸',
    title: 'Suivez vos remboursements',
    text: 'Le tableau de trésorerie vous permet de suivre ce que la CPAM et votre complémentaire vous doivent. Marquez les remboursements reçus pour garder vos comptes à jour.',
    action: 'Voir la trésorerie',
    nav: 'tresor'
  }
];

let _onboardingStep = 0;

function checkOnboarding() {
  const key = _getOnboardingKey();
  const done = localStorage.getItem(key);
  if (!done && S?.token && S?.role === 'nurse') {
    setTimeout(showOnboarding, 800);
  }
}

function showOnboarding() {
  // Créer la modale si elle n'existe pas
  let modal = document.getElementById('onboarding-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'onboarding-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;
      background:rgba(11,15,20,.92);backdrop-filter:blur(12px);padding:20px`;
    document.body.appendChild(modal);
  }
  _onboardingStep = 0;
  _renderOnboardingStep(modal);
}

function _renderOnboardingStep(modal) {
  const step = ONBOARDING_STEPS[_onboardingStep];
  const total = ONBOARDING_STEPS.length;
  modal.innerHTML = `
    <div style="background:var(--c);border:1px solid var(--b);border-radius:24px;padding:40px 36px;max-width:460px;width:100%;box-shadow:0 0 80px rgba(0,212,170,.08),0 24px 64px rgba(0,0,0,.6);animation:pop .2s ease">
      <div style="text-align:center;margin-bottom:28px">
        <div style="font-size:52px;margin-bottom:12px">${step.icon}</div>
        <div style="font-family:var(--fs);font-size:24px;margin-bottom:10px">${step.title}</div>
        <div style="font-size:14px;color:var(--m);line-height:1.7">${step.text}</div>
      </div>
      <!-- Dots -->
      <div style="display:flex;justify-content:center;gap:6px;margin-bottom:24px">
        ${ONBOARDING_STEPS.map((_,i) => `<div style="width:${i===_onboardingStep?20:8}px;height:8px;border-radius:4px;background:${i===_onboardingStep?'var(--a)':'var(--b)'};transition:all .2s"></div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;flex-direction:column">
        <button class="abtn" onclick="_onboardingAction('${step.nav}')">${step.action} →</button>
        <div style="display:flex;gap:10px">
          ${_onboardingStep > 0 ? `<button class="btn bs bsm" style="flex:1" onclick="_onboardingPrev()">← Précédent</button>` : ''}
          ${_onboardingStep < total-1
            ? `<button class="btn bs bsm" style="flex:1" onclick="_onboardingNext()">Passer →</button>`
            : `<button class="btn bs bsm" style="flex:1" onclick="completeOnboarding()">Commencer ✓</button>`}
        </div>
        <button style="background:none;border:none;color:var(--m);font-size:12px;cursor:pointer;padding:4px" onclick="completeOnboarding()">Passer l'introduction</button>
      </div>
    </div>`;
}

function _onboardingNext()    { _onboardingStep = Math.min(_onboardingStep+1, ONBOARDING_STEPS.length-1); _renderOnboardingStep(document.getElementById('onboarding-modal')); }
function _onboardingPrev()    { _onboardingStep = Math.max(_onboardingStep-1, 0); _renderOnboardingStep(document.getElementById('onboarding-modal')); }
function _onboardingAction(nav) {
  completeOnboarding();
  if (nav === 'profil') { if(typeof openPM === 'function') openPM(); }
  else if (nav) { if(typeof navTo === 'function') navTo(nav, null); }
}
function completeOnboarding() {
  const key = _getOnboardingKey();
  localStorage.setItem(key, '1');
  const modal = document.getElementById('onboarding-modal');
  if (modal) modal.remove();
  showToast('🎉 Bienvenue dans AMI — bonne utilisation !', 'ok');
}

/* Réinitialiser l'onboarding pour l'utilisateur courant */
function resetOnboarding() {
  const key = _getOnboardingKey();
  localStorage.removeItem(key);
  showOnboarding();
}

/* ═══════════════════════════════════════════════
   RAPPELS & NOTIFICATIONS PUSH
   ═══════════════════════════════════════════════ */

async function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted') showToast('🔔 Notifications activées', 'ok');
}

function scheduleReminder(msg, delayMs) {
  if (Notification.permission !== 'granted') return;
  setTimeout(() => {
    new Notification('AMI — Rappel', {
      body: msg,
      icon: './favicon.ico',
      badge: './favicon.ico',
      tag: 'ami-reminder',
    });
  }, delayMs);
}

/* Rappel quotidien de cotation (si pas de cotation aujourd'hui) */
async function scheduleDailyCotationReminder() {
  if (Notification.permission !== 'granted') return;
  try {
    const d = await fetchAPI('/webhook/ami-historique?period=today').catch(()=>({data:[]}));
    const arr = Array.isArray(d?.data) ? d.data : [];
    if (arr.length === 0) {
      // Pas de cotation aujourd'hui → rappel dans 2h
      scheduleReminder('Vous n\'avez pas encore coté de soins aujourd\'hui. Pensez à votre facturation !', 2 * 3600 * 1000);
    }
  } catch {}
}

/* ═══════════════════════════════════════════════
   INIT GLOBAL
   ═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Badge file d'attente offline
  _updateQueueBadge();

  // Stats avancées quand on navigue vers le dashboard (vue fusionnée)
  document.addEventListener('app:nav', e => {
    if (e.detail?.view === 'dash' || e.detail?.view === 'stats') loadStatsAvancees();
  });

  // Patch cotation() pour gérer l'offline
  const _origCotation = window.cotation;
  if (typeof _origCotation === 'function') {
    window.cotation = async function() {
      if (!navigator.onLine) {
        const txt = document.getElementById('f-txt')?.value?.trim();
        if (txt) {
          const u = typeof S !== 'undefined' ? (S?.user||{}) : {};
          queueCotation({
            mode:'ngap', texte:txt,
            infirmiere:((u.prenom||'')+' '+(u.nom||'')).trim(),
            date_soin: document.getElementById('f-ds')?.value||'',
            heure_soin:document.getElementById('f-hs')?.value||'',
            exo: document.getElementById('f-exo')?.value||'',
          });
          return;
        }
      }
      return _origCotation();
    };
  }

  // Onboarding après login
  document.addEventListener('ami:login', checkOnboarding);

  // Migration + pull du cache heures au login
  document.addEventListener('ami:login', () => {
    _migrateHeureCacheLocal();        // fusionner ami_heure_cache_local → clé UUID
    setTimeout(pullHeureCache, 2000); // puis sync cross-appareils
  });

  // Init queue status
  const q = _getQueue();
  if (q.length > 0 && navigator.onLine) {
    setTimeout(syncOfflineQueue, 3000);
  }
});

/* Exposer globalement */
window.showToast              = showToast;
window.queueCotation          = queueCotation;
window.syncOfflineQueue       = syncOfflineQueue;
window.loadStatsAvancees      = loadStatsAvancees;
window.checkOnboarding        = checkOnboarding;
window.showOnboarding         = showOnboarding;
window.completeOnboarding     = completeOnboarding;
window.resetOnboarding        = resetOnboarding;
window.requestNotifPermission = requestNotifPermission;
window.scheduleDailyCotationReminder = scheduleDailyCotationReminder;
window.syncHeureCache          = syncHeureCache;
window.pullHeureCache          = pullHeureCache;
window._migrateHeureCacheLocal = _migrateHeureCacheLocal;
window.loadTresorerie         = window.loadTresorerie || function(){};
window.checklistCPAM          = window.checklistCPAM  || function(){};
window.exportComptable        = window.exportComptable || function(){};
