/* ════════════════════════════════════════════════
   uber.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Mode Uber Médical — Tournée temps réel
   ⚠️  Requiert Leaflet.js et map.js
   v5.0 :
   ✅ Guards stricts (assertDep)
   ✅ GPS throttlé (3s minimum entre updates)
   ✅ maximumAge:10000 + timeout:10000 (économie batterie)
   ✅ getNextPatient() via APP.on('userPos') réactif
   ✅ Lecture via APP.get() / écriture via APP.set()
   ✅ _updateMapLive / _renderNextPatient exposés
     pour les listeners réactifs de utils.js
════════════════════════════════════════════════ */

/* ── Guards stricts ──────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined',    'uber.js : utils.js non chargé.');
  assertDep(typeof APP.map !== 'undefined','uber.js : namespace APP.map manquant (map.js requis).');
  assertDep(typeof L !== 'undefined',      'uber.js : Leaflet non chargé.');
})();

let _watchId     = null;
let _uberInterval= null;

/* ── Distance euclidienne rapide ─────────────── */
function _dist(a, b) {
  return Math.sqrt(Math.pow(a.lat-b.lat,2) + Math.pow(a.lng-b.lng,2));
}

/* ── ETA réel via OSRM ───────────────────────── */
async function getETA(from, to) {
  if (!to.lat || !to.lng) return 999;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const r = await fetch(url);
    const d = await r.json();
    return d.routes?.[0]?.duration / 60 || 999;
  } catch { return _dist(from, to) * 1000; }
}

/* ── Score Uber : plus petit = meilleur ──────── */
async function _computeScore(p) {
  const pos = APP.get('userPos') || APP.get('startPoint');
  if (!pos) return 999;
  const eta = await getETA(pos, p);

  // Distance = critère DOMINANT en mode automatique
  let score = eta * 3;

  // Priorité médicale : hiérarchie clinique stricte (pas proxy financier)
  const acte = (p.actes_recurrents || p.description || p.texte || '').toLowerCase();
  if (/insuline|inject|glycémie|à jeun|glycem/i.test(acte))           score -= 25; // timing critique
  if (/perfusion|perf\b|chimio|intraveineux/i.test(acte))             score -= 22; // technique lourd
  if (/pansement.*(complexe|escarre|ulc[eè]re|nécrose)|escarre/i.test(acte)) score -= 12; // risque infectieux
  if (/pansement/i.test(acte))                                        score -= 6;  // pansement simple
  if (/nursing|toilette|bsc\b|bsb\b/i.test(acte))                    score -= 4;  // confort, moins urgent

  // Contraintes temporelles (restent absolument prioritaires)
  if (p.urgence)                       score -= 50;
  if (p.late)                          score -= 30;
  if (p.time && Date.now() > p.time)   score -= 20;

  return score;
}

/* ── Sélection intelligente du prochain patient ─
   Utilise APP.set() pour déclencher _renderNextPatient
   automatiquement via le listener dans utils.js.
─────────────────────────────────────────────── */
async function selectBestPatient() {
  const patients = APP.get('uberPatients');
  const remaining = patients.filter(p => !p.done && !p.absent);
  if (!remaining.length) { APP.set('nextPatient', null); return; }

  /* ── Contraintes de passage (premier/suivant obligatoire) ──
     Si le patient contraint est encore dans les restants et qu'aucun
     patient avant lui n'est encore à faire, on le force en nextPatient.
     Règle :
       - firstId  → forcé si aucun autre patient "avant lui" n'a été skip (c'est le 1er tour)
       - secondId → forcé si le patient firstId est déjà done/absent
  ─────────────────────────────────────────────────────────── */
  const firstId  = APP._constraintFirst  || null;
  const secondId = APP._constraintSecond || null;
  const allDone  = patients.filter(p => p.done || p.absent);

  if (firstId) {
    const firstPatient = remaining.find(p => String(p.patient_id || p.id || '') === firstId);
    if (firstPatient && allDone.length === 0) {
      // Personne n'a encore été fait → forcer le premier contraint
      APP.set('nextPatient', firstPatient);
      return;
    }
  }

  if (secondId) {
    const secondPatient = remaining.find(p => String(p.patient_id || p.id || '') === secondId);
    // Le 2ème est forcé si le premier contraint est déjà fait (ou absent), et le 2ème n'a encore vu personne devant lui
    const firstDone = firstId
      ? patients.some(p => String(p.patient_id || p.id || '') === firstId && (p.done || p.absent))
      : allDone.length >= 1;
    if (secondPatient && firstDone && allDone.length <= 1) {
      APP.set('nextPatient', secondPatient);
      return;
    }
  }

  /* ── Sélection normale : score IA + distance GPS ── */
  const userPos = APP.get('userPos');
  if (userPos) remaining.sort((a,b) => _dist(userPos,a) - _dist(userPos,b));

  const top5 = remaining.slice(0, 5);
  let best = null, bestScore = Infinity;
  for (const p of top5) {
    const s = await _computeScore(p);
    if (s < bestScore) { bestScore = s; best = p; }
  }
  APP.set('nextPatient', best || remaining[0]);
}

/* ── Rendu carte prochain patient ────────────── */
function _renderNextPatient() {
  const el = $('uber-next-patient');
  if (!el) return;
  const p = APP.get('nextPatient');
  if (!p) { el.innerHTML = '<div class="ai su">✅ Tous les patients ont été vus !</div>'; return; }
  const userPos = APP.get('userPos');
  const rawDist = userPos && p.lat ? _dist(userPos, p) * 111 : null;
  /* Afficher la distance seulement si GPS actif et distance plausible (<150km) */
  const dist = (rawDist !== null && rawDist < 150) ? rawDist.toFixed(1) + ' km' : (userPos ? rawDist.toFixed(1) + ' km' : '—');
  const nomAff = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.label || 'Patient';
  el.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">${nomAff}</div>
    <div style="font-size:12px;color:var(--m);margin-bottom:10px">
      ${p.heure_soin ? '⏰ '+p.heure_soin : ''} ${p.urgence ? '🚨 URGENT' : ''}${dist !== '—' ? ' · 📍 ~'+dist : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn bp bsm" onclick="markUberDone()"><span>✅</span> Terminé</button>
      <button class="btn bs bsm" onclick="markUberAbsent()"><span>❌</span> Absent</button>
      ${p.lat ? `<button class="btn bv bsm" onclick="openNavigation(APP.get('nextPatient'))"><span>🗺️</span> Naviguer</button>` : ''}
    </div>`;
}

/* ── Marker live position infirmière ─────────── */
function _updateMapLive(lat, lng) {
  const map = APP.map.instance;
  if (!map) return;
  if (window._liveMarker) {
    window._liveMarker.setLatLng([lat, lng]);
  } else {
    window._liveMarker = L.circleMarker([lat, lng], {
      radius: 10, fillColor: '#00d4aa', color: '#00b891', weight: 2, fillOpacity: 0.9
    }).addTo(map).bindPopup('📍 Vous êtes ici');
  }
}

/* ── Détection retards ───────────────────────── */
function detectDelaysUber() {
  const now = Date.now();
  APP.get('uberPatients').forEach(p => {
    if (p.time && !p.done && now > p.time + 15 * 60 * 1000) p.late = true;
  });
}

/* ── GPS CONTINU — throttlé 3s ───────────────────
   ✅ maximumAge:10000 → évite requêtes GPS inutiles
   ✅ timeout:10000    → plus tolérant en intérieur
   ✅ throttle 3s      → économise la batterie
─────────────────────────────────────────────── */
const _onGPSUpdate = throttle((lat, lng) => {
  APP.set('userPos', { lat, lng });
  /* startPoint seulement si pas encore défini */
  if (!APP.get('startPoint')) APP.set('startPoint', { lat, lng });
  log('GPS live →', lat.toFixed(4), lng.toFixed(4));
}, 3000);

function startLiveTracking() {
  if (!navigator.geolocation) { alert('GPS non supporté'); return; }
  if (_watchId !== null) { log('GPS déjà actif'); return; }
  const el = $('uber-tracking-status');
  if (el) el.textContent = '📡 GPS actif — suivi continu';
  _watchId = navigator.geolocation.watchPosition(
    pos => _onGPSUpdate(pos.coords.latitude, pos.coords.longitude),
    err => { logErr('GPS LIVE ERROR', err); if (el) el.textContent = '❌ GPS perdu — ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
  );
  /* Recalcul auto toutes les 15s */
  _uberInterval = setInterval(() => { detectDelaysUber(); selectBestPatient(); }, 15000);
}

function stopLiveTracking() {
  if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
  if (_uberInterval) { clearInterval(_uberInterval); _uberInterval = null; }
  const el = $('uber-tracking-status');
  if (el) el.textContent = '⏹️ Suivi GPS arrêté';
}

/* ── Actions patient ─────────────────────────── */

/* ════════════════════════════════════════════════════════════
   _autoCoterEtImporterPatient(p)
   ─────────────────────────────────────────────────────────────
   Déclenché par markUberDone() à chaque patient validé ✅
   1. Auto-cotation (API NGAP + fallback local)
   2. Import cotation dans le carnet patient (IDB)
   3. Enregistrement km incrémental dans le journal kilométrique
   Toutes les dépendances IDB/enc/dec sont appelées de façon
   défensive (typeof guard) pour ne jamais bloquer le rendu.
   ============================================================ */
async function _autoCoterEtImporterPatient(p) {
  const _now     = new Date();
  // ⚡ Date locale (pas UTC) : cotation faite à 1h du matin France doit
  // s'afficher au jour calendaire courant, pas la veille UTC.
  const todayStr = (typeof _localDateStr === 'function')
    ? _localDateStr(_now)
    : (() => { // fallback inline si utils.js pas encore chargé
        const y=_now.getFullYear(),m=String(_now.getMonth()+1).padStart(2,'0'),d=String(_now.getDate()).padStart(2,'0');
        return `${y}-${m}-${d}`;
      })();
  // ISO local (sans Z) — slice(0,10) renvoie alors la date locale
  const today = (typeof _localDateTimeISO === 'function')
    ? _localDateTimeISO(_now)
    : todayStr + 'T' + _now.toTimeString().slice(0, 8);
  // ⚡ Heure RÉELLE de fin de soin. Priorité :
  //   1. p._done_at : posé par markUberDone() au clic "Terminer" — c'est l'ancre
  //      fiable, même si cette fonction est ré-appelée plus tard en batch par
  //      terminerTourneeAvecBilan ("Clôturer la journée") ou _autoCoterEtImporterPatient
  //      après un retry async.
  //   2. new Date() : fallback pour les patients clôturés sans clic "Terminer"
  //      préalable (cas rare : l'infirmière clique directement "Clôturer" après
  //      avoir coché done manuellement).
  // NE JAMAIS utiliser p.heure_soin / p.heure_preferee : ce sont les contraintes
  // horaires PLANIFIÉES de la tournée, pas l'horodatage effectif à inscrire
  // dans la cotation CPAM / Historique des soins.
  const heureReelle = p._done_at || _now.toTimeString().slice(0, 5); // "HH:MM" locale
  const u        = (typeof S !== 'undefined' && S?.user) ? S.user : {};

  /* ── 1. AUTO-COTATION ── */
  try {
    if (!p._cotation?.validated) {
      let actesRecurrents = '';
      try {
        if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
          const rows = await _idbGetAll(PATIENTS_STORE);
          const row  = rows.find(r => r.id === p.patient_id || r.id === p.id);
          if (row && typeof _dec === 'function') {
            const pat = _dec(row._data) || {};
            if (pat.actes_recurrents) actesRecurrents = pat.actes_recurrents;
          }
        }
      } catch (_e) {}

      const texteImport  = (p.description || p.texte || p.texte_soin || p.acte || '').trim();
      // Convertir pathologies OU description brute via pathologiesToActes()
      // (couvre le cas description="Diabète" sans champ pathologies rempli)
      const _pathoSrc  = p.pathologies || texteImport;
      const _hasActe   = /injection|pansement|prélèvement|perfusion|nursing|toilette|bilan|sonde|insuline|glycémie/i;
      const _pathoConv = _pathoSrc && typeof pathologiesToActes === 'function'
        ? pathologiesToActes(_pathoSrc) : '';
      // Base : texteImport enrichi si c'est une pathologie brute
      const _texteBase = _hasActe.test(texteImport)
        ? texteImport
        : (_pathoConv && _pathoConv !== texteImport
            ? (texteImport ? texteImport + ' — ' + _pathoConv : _pathoConv)
            : (texteImport || 'soin infirmier à domicile'));
      // actes_recurrents prime
      const texte = actesRecurrents || _texteBase;

      if (texte) {
        let cot = (typeof autoCotationLocale === 'function')
          ? autoCotationLocale(texte) : { actes: [], total: 0 };
        try {
          // ── Résoudre nom/prenom depuis l'IDB avant l'appel ──────────────
          // Indispensable pour que le worker sauvegarde patient_nom dans Supabase
          let _nomPatient = ((p.prenom||'') + ' ' + (p.nom||'')).trim();
          if (!_nomPatient) {
            // Chercher dans l'IDB si pas encore enrichi
            const _enrichRows = (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined')
              ? await _idbGetAll(PATIENTS_STORE).catch(() => []) : [];
            const _eRow = _enrichRows.find(r => r.id === p.patient_id || r.id === p.id);
            if (_eRow) {
              p.nom    = p.nom    || _eRow.nom    || '';
              p.prenom = p.prenom || _eRow.prenom || '';
              _nomPatient = ((p.prenom||'') + ' ' + (p.nom||'')).trim();
            }
          }
          const _patientId = p.patient_id || p.id || null;

          const d = await (typeof apiCall === 'function' ? apiCall('/webhook/ami-calcul', {
            mode: 'ngap', texte,
            infirmiere: ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
            adeli: u.adeli||'', rpps: u.rpps||'', structure: u.structure||'',
            date_soin: todayStr,
            heure_soin: heureReelle, // ⚡ heure RÉELLE de fin de soin (pas la contrainte horaire)
            _live_auto: true,
            // ── Nom patient → stocké dans planning_patients.patient_nom ──────
            ...(_nomPatient ? { patient_nom: _nomPatient } : {}),
            ...(_patientId  ? { patient_id:  _patientId  } : {}),
          }) : Promise.reject('no apiCall'));
          if ((d?.actes?.length || d?.total > 0) && !d?.error) cot = d;
        } catch (_e) { /* silencieux — fallback local déjà prêt */ }
        // Conserver invoice_number retourné par le worker — indispensable pour
        // que toute re-cotation manuelle ultérieure fasse un PATCH Supabase
        // et non un INSERT (évite le doublon dans l'historique des soins).
        p._cotation = {
          actes:          cot.actes || [],
          total:          parseFloat(cot.total || 0),
          auto:           true,
          validated:      true,
          invoice_number: cot.invoice_number || null,
          _heure_reelle:  heureReelle, // ⚡ propagé à _syncCotationsToSupabase
        };
      }
    }
  } catch (_e) { console.warn('[AMI] Cotation auto KO:', _e?.message); }

  /* ── 2. IMPORT COTATION → CARNET PATIENT (IDB) ── */
  try {
    if (p._cotation?.validated
        && typeof _idbGetAll === 'function'
        && typeof _idbPut    === 'function'
        && typeof _enc       === 'function'
        && typeof PATIENTS_STORE !== 'undefined') {

      const rows = await _idbGetAll(PATIENTS_STORE);
      let row    = rows.find(r => r.id === p.patient_id || r.id === p.id);
      let pat;

      if (row) {
        pat = { id: row.id, nom: row.nom, prenom: row.prenom,
                ...((typeof _dec === 'function' ? _dec(row._data) : null) || {}) };
      } else {
        const newId = p.patient_id || p.id
          || ('pat_' + Date.now() + '_' + Math.random().toString(36).slice(2,6));
        const parts = (p.nom
          ? [p.prenom||'', p.nom]
          : (p.description || p.texte || 'Patient').split(' '));
        pat = {
          id: newId,
          nom:    p.nom    || parts.slice(-1)[0]          || 'Patient',
          prenom: p.prenom || parts.slice(0,-1).join(' ') || '',
          adresse: p.adresse || p.addressFull || '',
          lat: p.lat || null, lng: p.lng || null,
          created_at: today, updated_at: today, cotations: [],
        };
      }

      // ── Enrichir p avec le nom trouvé en IDB pour que _syncCotationsToSupabase
      //    puisse inclure patient_nom dans le payload Supabase → Historique des soins ──
      p.nom    = p.nom    || pat.nom    || '';
      p.prenom = p.prenom || pat.prenom || '';


      if (!pat.cotations) pat.cotations = [];

      // Guard : ne sauvegarder que si au moins un acte technique (pas juste DIM/IFD...)
      const _CODES_MAJ_U = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
      const _actesTechU = (p._cotation.actes || []).filter(a => !_CODES_MAJ_U.has((a.code||'').toUpperCase()));
      if (!_actesTechU.length) {
        console.warn('[uber] Cotation ignorée — pas d\'acte technique:', (p._cotation.actes||[]).map(a=>a.code));
        return;
      }

      // Upsert : chercher une cotation existante pour ce patient
      // ⚠️ Dédup par FENÊTRE TEMPORELLE (6h), PAS par date UTC.
      // Pourquoi : une cotation faite à 1h du matin France stocke "2026-04-20"
      // (UTC) au lieu de "2026-04-21" (local). Comparer par UTC date confond
      // les tournées de fin de soirée et début de matinée. Une fenêtre 6h
      // capture les double-clics accidentels sur "Terminé" (cas légitime
      // d'upsert) mais autorise une vraie nouvelle tournée le même jour
      // (matin + soir, ou jours différents proches).
      const _DEDUP_WINDOW_MS = 6 * 3600 * 1000;
      const _nowMs = _now.getTime();
      const _existUberIdx = pat.cotations.findIndex(c => {
        if (c.source !== 'tournee_live' && c.source !== 'tournee' && c.source !== 'tournee_auto') return false;
        const _cMs = new Date(c.date || 0).getTime();
        if (isNaN(_cMs) || _cMs <= 0) return false;
        return Math.abs(_nowMs - _cMs) < _DEDUP_WINDOW_MS;
      });
      // ⚡ Préserver l'heure de la cotation existante si on upsert, sinon heure réelle.
      // Évite qu'un double-clic accidentel sur "Terminer" décale l'horodatage.
      const _heureUber = (_existUberIdx >= 0 && pat.cotations[_existUberIdx].heure)
        ? pat.cotations[_existUberIdx].heure
        : heureReelle;
      // Re-taguer _cotation avec l'heure finale retenue (utile si upsert d'une cotation préexistante)
      if (p._cotation) p._cotation._heure_reelle = _heureUber;
      const _cotEntryUber = {
        date:   today,
        heure:  _heureUber, // ⚡ heure RÉELLE de fin de soin (pas la contrainte horaire planifiée)
        actes:  p._cotation.actes || [],
        total:  parseFloat(p._cotation.total || 0),
        soin:   (p.description || p.texte || '').slice(0, 120),
        source: 'tournee_live',
        invoice_number: p._cotation.invoice_number || null,
        // ⚡ _synced: true SI invoice_number présent (= /ami-calcul a déjà sauvé en Supabase
        // côté worker via _saveCotationNurse). Évite que _syncCotationsToSupabase ne re-pousse
        // la même cotation et crée un doublon (2 INSERTs visibles dans Historique).
        // _synced: false sinon → rattrapage par _stopDayInternal à la clôture.
        _synced: !!p._cotation.invoice_number,
        updated_at: today,
      };
      if (_existUberIdx >= 0) {
        pat.cotations[_existUberIdx] = _cotEntryUber; // mise à jour
      } else {
        pat.cotations.push(_cotEntryUber); // nouvelle cotation
      }
      pat.updated_at = today;

      await _idbPut(PATIENTS_STORE, {
        id: pat.id, nom: pat.nom, prenom: pat.prenom,
        _data: _enc(pat), updated_at: today,
      });
    }
  } catch (_e) { console.warn('[AMI] Import IDB KO:', _e?.message); }

  /* ── 3. KM INCRÉMENTAL ── */
  try {
    if (p.lat && p.lng) {
      // Si startPoint est null (APP réinitialisé), tenter de le récupérer depuis localStorage.
      // Il est posé lors de l'optimisation Tournée IA et persisté par startJourneeUnifiee.
      if (!APP.get('startPoint') && !APP.get('_lastVisitedPos')) {
        try {
          const _sp = JSON.parse(localStorage.getItem('ami_start_point') || 'null');
          if (_sp?.lat && _sp?.lng) APP.set('startPoint', _sp);
        } catch (_) {}
      }
      const prev = APP.get('_lastVisitedPos') || APP.get('startPoint');
      if (prev?.lat && prev?.lng) {
        const R = 6371;
        const dLat = (parseFloat(p.lat) - parseFloat(prev.lat)) * Math.PI / 180;
        const dLon = (parseFloat(p.lng) - parseFloat(prev.lng)) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2
          + Math.cos(parseFloat(prev.lat)*Math.PI/180)
          * Math.cos(parseFloat(p.lat)*Math.PI/180)
          * Math.sin(dLon/2)**2;
        const km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const curKm = parseFloat(APP.get('tourneeKmJour') || 0);
        APP.set('tourneeKmJour', curKm + km);
        try { localStorage.setItem('ami_tournee_km', String(curKm + km)); } catch (_e) {}
      }
      APP.set('_lastVisitedPos', { lat: p.lat, lng: p.lng });
    }
  } catch (_e) {}

  /* ── Sync Supabase silencieux (SEULEMENT si /ami-calcul n'a pas déjà sauvé) ──
     Depuis le fix worker (_saveCotationNurse génère + retourne un invoice_number),
     /ami-calcul sauvegarde TOUJOURS la cotation en Supabase et nous renvoie son
     invoice_number. Dans ce cas, _syncCotationsToSupabase ferait un 2e appel
     redondant qui peut créer un doublon (le critère 2 patient_id+date_soin du
     worker ne match pas toujours sur l'INSERT précédent dans la même ms).
     On skip donc proprement quand invoice_number est connu.
     Si invoice_number est null (échec /ami-calcul ou worker non déployé),
     on tombe sur l'ancien comportement : push via _syncCotationsToSupabase. */
  try {
    if (typeof _syncCotationsToSupabase === 'function' && !p?._cotation?.invoice_number) {
      _syncCotationsToSupabase([p], { skipIDB: true }).catch(() => {});
    }
  } catch (_e) {}
}

async function markUberDone() {
  const p = APP.get('nextPatient'); if (!p) return;
  p.done = true;

  // ⚡ Mémoriser l'heure RÉELLE du clic "Terminer" — point d'ancrage unique.
  // Ainsi, même si _autoCoterEtImporterPatient est ré-appelée plus tard par
  // terminerTourneeAvecBilan ("Clôturer la journée"), c'est cette heure-ci
  // qui sera utilisée, pas celle du clic Clôturer.
  p._done_at = new Date().toTimeString().slice(0, 5); // "HH:MM" locale
  p._done_at_iso = new Date().toISOString();

  /* Déclencher cotation + import + km pour ce patient (non bloquant) */
  _autoCoterEtImporterPatient(p).catch(e => console.warn('[AMI] markUberDone async KO:', e));

  selectBestPatient();
  _updateUberProgress();
  if (typeof _updateLiveCADisplay === 'function') _updateLiveCADisplay();

  /* Toast si tous les patients sont terminés */
  const remaining = (APP.get('uberPatients') || []).filter(q => !q.done && !q.absent);
  if (!remaining.length && typeof showToast === 'function') {
    showToast('✅ Tous les patients visités — cliquez sur 🏁 Clôturer la journée');
  }
}

function markUberAbsent() {
  const p = APP.get('nextPatient'); if (!p) return;
  p.absent = true;
  selectBestPatient();
  _updateUberProgress();
  if (typeof _updateLiveCADisplay === 'function') _updateLiveCADisplay();
}

function _updateUberProgress() {
  // Déléguer à renderLivePatientList pour un affichage unifié (évite le doublon uber-progress)
  if (typeof renderLivePatientList === 'function') {
    renderLivePatientList();
  } else {
    // Fallback si tournee.js pas encore chargé
    const pts = APP.get('uberPatients');
    const total = pts.length;
    const done  = pts.filter(p => p.done || p.absent).length;
    const el = $('uber-progress');
    if (el) el.textContent = `${done} / ${total} patients · ${total - done} restant(s)`;
  }
}

/* ── Navigation Google Maps ──────────────────────────────────
   Point de départ = startPoint choisi dans la tournée (ou position
   GPS live si disponible). Si aucun point de départ n'est défini,
   Google Maps utilise la position de l'appareil.
─────────────────────────────────────────────────────────────── */
function openNavigation(p) {
  if (!p?.lat && !p?.adresse && !p?.addressFull) { alert('Adresse du patient non disponible.'); return; }

  /* Destination : préférer l'adresse TEXTE exacte si disponible
     → Google Maps utilise sa propre base pour trouver le bon numéro
     → évite le reverse geocoding approximatif sur les coordonnées IGN
     Fallback sur coordonnées GPS si pas d'adresse texte */
  const addrText = p.addressFull || p.adresse || p.address || '';
  const dest = addrText
    ? encodeURIComponent(addrText)
    : `${p.lat},${p.lng}`;

  /* Origin = startPoint défini dans Tournée IA */
  const origin = APP.get('startPoint');

  let url;
  const destParam = addrText ? `destination=${dest}` : `destination=${dest}`;
  if (origin && origin.lat && origin.lng) {
    url = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&${destParam}&travelmode=driving`;
  } else {
    url = `https://www.google.com/maps/dir/?api=1&${destParam}&travelmode=driving`;
  }

  window.open(url, '_blank');
}

/* ── Recalcul OSRM complet ───────────────────── */
async function recalcRouteUber() {
  const pos = APP.get('userPos') || APP.get('startPoint');
  if (!pos) { alert("Active le GPS d'abord."); return; }
  const remaining = APP.get('uberPatients').filter(p => !p.done && !p.absent && p.lat && p.lng);
  if (!remaining.length) { alert('Aucun patient restant avec coordonnées GPS.'); return; }
  const coords = [[pos.lng, pos.lat], ...remaining.map(p => [p.lng, p.lat])];
  try {
    const url = `https://router.project-osrm.org/trip/v1/driving/${coords.map(c=>c.join(',')).join(';')}?source=first&roundtrip=false`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code === 'Ok') {
      const totalMin = Math.round(d.trips[0].duration / 60);
      const totalKm  = (d.trips[0].distance / 1000).toFixed(1);
      const el = $('uber-route-info');
      if (el) el.innerHTML = `🗺️ Route optimisée : <strong>${totalKm} km</strong> · <strong>${totalMin} min</strong>`;
    }
  } catch (e) { logWarn('OSRM recalc:', e.message); }
}

/* ── Chargement patients Uber ────────────────── */
function loadUberPatients() {
  if (!requireAuth()) return;
  const data = APP.get('importedData');
  if (!data || data._planningOnly) {
    const el = $('uber-next-patient');
    if (el) el.innerHTML = '<div class="ai wa" style="margin-bottom:10px">⚠️ Aucune donnée importée.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn bp bsm" onclick="navTo(\'patients\',null)"><span>👤</span> Carnet patients</button>' +
        '<button class="btn bs bsm" onclick="navTo(\'imp\',null)"><span>📂</span> Import calendrier</button>' +
        '</div>';
    return;
  }
  const raw = data?.patients || data?.entries || [];
  APP.set('uberPatients', raw.map((p, i) => {
    const amountBase = parseFloat(p.total || p.montant || p.amount || 0);
    // estimateRevenue si pas de montant réel
    const amount = amountBase > 0 ? amountBase
      : (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 6.30);
    return {
      ...p,
      id:      p.patient_id || p.id || i,
      label:   p.description || p.texte || p.summary || 'Patient ' + (i+1),
      done:    false, absent: false, late: false,
      urgence: !!(p.urgence || p.priorite === 'urgent'),
      time:    p.heure_soin ? _parseTime(p.heure_soin) : null,
      amount,
      lat:     parseFloat(p.lat || p.latitude) || null,
      lng:     parseFloat(p.lng || p.longitude || p.lon) || null,
    };
  }));

  // ── Filtre IDE : ne charger que les patients assignés à l'IDE connectée ──
  // Si aucune assignation (mode solo ou tournée non cabinet), charger tout.
  const _allLoaded  = APP.get('uberPatients') || [];
  const _ideAssign  = (typeof APP !== 'undefined') ? (APP._ideAssignments || {}) : {};
  const _hasAssign  = Object.values(_ideAssign).some(arr => arr?.length > 0);
  if (_hasAssign) {
    const _myId    = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    const _isAdmin = (typeof S !== 'undefined') && S?.role === 'admin';
    if (_myId && !_isAdmin) {
      const _myPats = _allLoaded.filter(p => {
        const pk = String(p.patient_id || p.id || '');
        return (_ideAssign[pk] || []).some(a => a.id === _myId);
      });
      if (_myPats.length > 0) {
        APP.set('uberPatients', _myPats);
        if (typeof showToast === 'function')
          showToast(`🎯 ${_myPats.length} patient(s) assigné(s) chargés`, 'ok');
      }
    }
  }

  _updateUberProgress();
  // Peupler les selects contraintes si disponibles
  if (typeof populateConstraintSelects === 'function') populateConstraintSelects();
  selectBestPatient();
}

function _parseTime(h) {
  if (!h) return null;
  const [hh, mm] = (h||'').split(':').map(Number);
  const t = new Date(); t.setHours(hh||0, mm||0, 0, 0);
  return t.getTime();
}
