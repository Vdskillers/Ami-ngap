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
  if (/insuline|inject|glyc[eé]mie|à jeun|glycem|diab[eè]te/i.test(acte)) score -= 25; // timing critique (ajout diab[eè]te)
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

   ⚡ FIX : Le mode Uber respecte maintenant STRICTEMENT l'ordre VRPTW
   déjà optimisé par `optimizeTour` (distance + horaires + priorité médicale
   déjà pris en compte). Le re-tri par distance GPS + score médical créait
   des incohérences : un pansement complexe à 15h00 loin pouvait passer
   devant un diabète à 13h00 proche à cause du bonus -18 du matching
   "pansement.*complexe".

   Priorités (dans cet ordre) :
     1. Urgence explicite (`urgence: true`) — passe toujours devant
     2. Contrainte `firstId` (patient forcé en 1er)
     3. Contrainte `secondId` (patient forcé en 2e si 1er fait)
     4. Premier patient non-done/non-absent dans l'ordre uberPatients
        = respect strict de la tournée optimisée par l'IA VRPTW
   Le scoring IA reste disponible comme fallback si aucun ordre n'existe
   (ex: patients ajoutés à la volée sans optimisation préalable).
─────────────────────────────────────────────── */
async function selectBestPatient() {
  const patients = APP.get('uberPatients') || [];
  const remaining = patients.filter(p => !p.done && !p.absent);
  if (!remaining.length) { APP.set('nextPatient', null); return; }

  // ── 1. Urgence explicite → passe devant tout ─────────────────────
  const urgent = remaining.find(p => p.urgence || p.urgent);
  if (urgent) { APP.set('nextPatient', urgent); return; }

  // ── 2. Contraintes de passage (premier/suivant obligatoire) ──────
  const firstId  = APP._constraintFirst  || null;
  const secondId = APP._constraintSecond || null;
  const allDone  = patients.filter(p => p.done || p.absent);

  if (firstId) {
    const firstPatient = remaining.find(p => String(p.patient_id || p.id || '') === firstId);
    if (firstPatient && allDone.length === 0) {
      APP.set('nextPatient', firstPatient);
      return;
    }
  }

  if (secondId) {
    const secondPatient = remaining.find(p => String(p.patient_id || p.id || '') === secondId);
    const firstDone = firstId
      ? patients.some(p => String(p.patient_id || p.id || '') === firstId && (p.done || p.absent))
      : allDone.length >= 1;
    if (secondPatient && firstDone && allDone.length <= 1) {
      APP.set('nextPatient', secondPatient);
      return;
    }
  }

  // ── 3. Respect strict de l'ordre VRPTW ───────────────────────────
  // `uberPatients` est déjà trié par optimizeTour (distance + heures + priorité).
  // Le premier restant dans cet ordre = le prochain patient selon l'IA.
  // On suppose que si un ordre existe (patients.length > 1 et position 0 stable),
  // il faut le respecter.
  const optimizedOrder = patients.length > 1;
  if (optimizedOrder) {
    // Trouver le premier patient restant dans l'ORDRE ORIGINAL (pas remaining qui
    // a le même ordre mais évite les fake indices). Remaining préserve l'ordre
    // de filter() donc remaining[0] = premier non-done dans uberPatients.
    APP.set('nextPatient', remaining[0]);
    return;
  }

  // ── 4. Fallback : score IA + GPS (si pas d'ordre pré-optimisé) ───
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
  const p = APP.get('nextPatient');

  // ⚡ Synchroniser le header "Mode Uber Médical" (#live-patient-name / #live-info)
  // qui était auparavant figé sur window._liveIndex et ne suivait pas nextPatient.
  // Ça garantit que le soin affiché en haut correspond au VRAI prochain patient,
  // pas au patient d'index 0 de IMPORTED_DATA.
  const liveName = $('live-patient-name');
  const liveInfo = $('live-info');
  if (p) {
    // ⚡ Soin enrichi : "Diabète" brut → "Injection insuline SC, surveillance
    // glycémie capillaire, éducation thérapeutique". Sans ça, le header du
    // Pilotage affichait "Diabète" alors que la cotation stockait le détail.
    const _soinEnrichi = (typeof _enrichSoinLabel === 'function')
      ? _enrichSoinLabel({
          actes_recurrents: p.actes_recurrents || '',
          pathologies:      p.pathologies || '',
          description:      p.description || p.texte || p.acte || '',
        }, 160)
      : (p.description || p.texte || p.acte || '');
    if (liveName) liveName.textContent = _soinEnrichi || ((p.nom||'') + ' ' + (p.prenom||'')).trim() || 'Patient suivant';
    if (liveInfo) liveInfo.textContent = `Heure prévue : ${p.heure_soin || p.heure_preferee || p.heure || '—'}`;
    // Aligner aussi window._liveIndex pour cohérence avec les autres flux (extras.js)
    try {
      const imported = APP.importedData?.patients || window.IMPORTED_DATA || [];
      const nKey = String(p.patient_id || p.id || '');
      const nIdx = imported.findIndex(x => String(x.patient_id || x.id || '') === nKey);
      if (nIdx >= 0) window._liveIndex = nIdx;
    } catch {}
  } else {
    if (liveName) liveName.textContent = 'Tournée terminée ✅';
    if (liveInfo) liveInfo.textContent = 'Tous les patients ont été pris en charge';
  }

  /* ⚡ #uber-next-patient est désormais géré EXCLUSIVEMENT par renderLivePatientList
     (dans tournee.js) qui affiche la liste complète AVEC les boutons Terminé/Absent/
     Naviguer directement sur le patient marqué "Prochain patient".
     Avant, _renderNextPatient écrivait la card seule dans #uber-next-patient et
     renderLivePatientList écrivait la liste dans le même élément : les deux se
     battaient, l'ordre d'exécution déterminait ce que l'utilisateur voyait
     (avec un délai de ~5s avant que la card réapparaisse via recomputeRoute).
     La liste unique résout ce conflit + donne une UX cohérente (on voit les
     boutons d'action sur le prochain patient ET tous les autres patients). */
  if (typeof renderLivePatientList === 'function') {
    renderLivePatientList();
  }
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

/* ── Détection retards ───────────────────────────────────────────────
   Marque `p.late = true` les patients dont l'heure planifiée + 15 min
   est dépassée. Pour CHAQUE NOUVEAU patient en retard détecté :
     • Toast unique (anti-spam via _lateNotified)
     • Mise à jour de l'alerte #live-delay-alert avec bouton 🔄 Recalculer
     • Mise à jour du HUD GPS plein écran si overlay ouvert
   Re-render systématique de la liste patients (badge ⏰ rouge).
   Réinitialisation de _lateNotified au chargement et à l'arrêt GPS. */

let _lateNotified = new Set(); // patient_id déjà notifiés par toast
let _delayAlertDismissed = false; // l'utilisateur a cliqué ✕ Masquer

function detectDelaysUber() {
  const now = Date.now();
  const patients = APP.get('uberPatients') || [];
  const newlyLate = [];

  patients.forEach(p => {
    if (p.time && !p.done && !p.absent && now > p.time + 15 * 60 * 1000) {
      const wasLate = p.late === true;
      p.late = true;
      const k = String(p.patient_id || p.id || '');
      if (!wasLate && k && !_lateNotified.has(k)) {
        _lateNotified.add(k);
        newlyLate.push(p);
      }
    }
  });

  // Toast unique au moment où un nouveau patient passe en retard
  if (newlyLate.length > 0 && typeof showToast === 'function') {
    const nom = ((newlyLate[0].prenom || '') + ' ' + (newlyLate[0].nom || '')).trim()
             || newlyLate[0].description || 'patient';
    if (newlyLate.length === 1) {
      showToast(`⏰ Retard détecté sur ${nom}`, 'wa');
    } else {
      showToast(`⏰ Retard sur ${newlyLate.length} patients (${nom}…)`, 'wa');
    }
    // Si l'utilisateur avait masqué l'alerte, un nouveau retard la rouvre
    _delayAlertDismissed = false;
  }

  // Toujours rafraîchir l'UI (alerte + liste + overlay GPS)
  _renderDelayAlert();
  if (typeof renderLivePatientList === 'function') {
    try { renderLivePatientList(); } catch (_) {}
  }
  if (_uberFSMap) {
    _uberFSRender();
    _uberFSUpdateHUD();
  }
}

/**
 * Met à jour le contenu et la visibilité de #live-delay-alert.
 * Inclut un bouton "🔄 Recalculer" qui appelle recalcOnDelay()
 * et un bouton "✕" qui masque l'alerte jusqu'au prochain nouveau retard.
 */
function _renderDelayAlert() {
  const alertEl = $('live-delay-alert');
  if (!alertEl) return;

  const patients = APP.get('uberPatients') || [];
  const lates = patients.filter(p => p.late && !p.done && !p.absent);

  if (lates.length === 0 || _delayAlertDismissed) {
    alertEl.style.display = 'none';
    return;
  }

  // Construire le message principal selon le ou les patients en retard
  const now = Date.now();
  const worst = lates.reduce((acc, p) => {
    const delta = p.time ? Math.round((now - p.time) / 60000) : 0;
    return delta > acc.delta ? { p, delta } : acc;
  }, { p: lates[0], delta: 0 });

  const nom = ((worst.p.prenom || '') + ' ' + (worst.p.nom || '')).trim()
           || worst.p.description || 'patient suivant';
  const heure = worst.p.heure_soin || worst.p.heure_preferee || worst.p.heure || '';
  const msg = lates.length === 1
    ? `Retard de ${worst.delta} min sur ${nom}${heure ? ' (prévu ' + heure + ')' : ''}.`
    : `${lates.length} patients en retard · le pire : ${nom} (${worst.delta} min).`;

  alertEl.style.display = 'block';
  alertEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:18px;flex-shrink:0">⏰</span>
      <span id="live-delay-msg" style="flex:1;min-width:200px;font-size:13px;color:var(--w)">${msg}</span>
      <button class="btn bv bsm" onclick="recalcOnDelay()" style="white-space:nowrap;font-size:11px;padding:5px 10px"><span>🔄</span> Recalculer</button>
      <button class="btn bs bsm" onclick="dismissDelayAlert()" style="white-space:nowrap;font-size:11px;padding:5px 8px" title="Masquer l'alerte">✕</button>
    </div>
  `;
}

/**
 * Masque l'alerte jusqu'au prochain nouveau retard (toast déclencheur).
 */
function dismissDelayAlert() {
  _delayAlertDismissed = true;
  const alertEl = $('live-delay-alert');
  if (alertEl) alertEl.style.display = 'none';
}

/**
 * Recalcul demandé par l'utilisateur suite à une alerte retard.
 *  1. Réoptimise la route OSRM (recalcRouteUber : distance/durée actualisées)
 *  2. Si un patient en retard a une fenêtre médicale critique (insuline / glycémie
 *     / chimio à jeun), le promeut en `nextPatient` pour respecter la priorité
 *     clinique au lieu de l'ordre VRPTW figé.
 *  3. Toast confirmation.
 */
async function recalcOnDelay() {
  const patients = APP.get('uberPatients') || [];
  const lates = patients.filter(p => p.late && !p.done && !p.absent);

  // 1. Réoptimisation route OSRM (durée + distance affichées)
  if (typeof recalcRouteUber === 'function') {
    try { await recalcRouteUber(); } catch (_) {}
  }

  // 2. Réordonnancement clinique : si un patient en retard a une fenêtre critique,
  //    on le passe en `nextPatient` (passerelle vers le scoring _computeScore).
  const _CRITIQUE_RX = /insuline|inject|glyc[eé]mie|à jeun|chimio|perfusion.*critique/i;
  const lateCritique = lates.find(p => {
    const acte = (p.actes_recurrents || p.description || p.texte || '').toLowerCase();
    return _CRITIQUE_RX.test(acte);
  });

  if (lateCritique) {
    const currentNext = APP.get('nextPatient');
    const currentKey = currentNext ? String(currentNext.patient_id || currentNext.id || '') : '';
    const lateKey    = String(lateCritique.patient_id || lateCritique.id || '');

    // Promouvoir uniquement si pas déjà le suivant et pas de contrainte explicite
    const hasConstraint = !!(APP._constraintFirst || APP._constraintSecond);
    if (currentKey !== lateKey && !hasConstraint) {
      APP.set('nextPatient', lateCritique);
      const nom = ((lateCritique.prenom || '') + ' ' + (lateCritique.nom || '')).trim()
               || lateCritique.description || 'patient critique';
      if (typeof showToast === 'function')
        showToast(`🚨 Priorité clinique → ${nom} promu en suivant`, 'wa');
      // Re-render
      if (typeof renderLivePatientList === 'function') renderLivePatientList();
      if (_uberFSMap) { _uberFSRender(); _uberFSUpdateHUD(); _uberFSFitView(); }
      return;
    }
  }

  // 3. Toast confirmation simple si aucun changement d'ordre
  if (typeof showToast === 'function') showToast('🔄 Route recalculée');
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
  // Reset détection retards : nouvelle journée = nouveaux retards potentiels
  _lateNotified = new Set();
  _delayAlertDismissed = false;
  const el = $('uber-tracking-status');
  if (el) el.textContent = '📡 GPS actif — suivi continu';
  _watchId = navigator.geolocation.watchPosition(
    pos => _onGPSUpdate(pos.coords.latitude, pos.coords.longitude),
    err => { logErr('GPS LIVE ERROR', err); if (el) el.textContent = '❌ GPS perdu — ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
  );
  /* Recalcul auto + détection retards toutes les 15s */
  _uberInterval = setInterval(() => { detectDelaysUber(); selectBestPatient(); }, 15000);
  // Première passe immédiate (sinon on attend 15s avant 1ère détection)
  setTimeout(() => detectDelaysUber(), 1000);
}

function stopLiveTracking() {
  if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
  if (_uberInterval) { clearInterval(_uberInterval); _uberInterval = null; }
  // Reset alerte retard à l'arrêt GPS
  _lateNotified = new Set();
  _delayAlertDismissed = false;
  const alertEl = $('live-delay-alert');
  if (alertEl) alertEl.style.display = 'none';
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

  /* ⚡ Variables liftées au scope de la fonction :
     Utilisées à la fois par la section 1 (AUTO-COTATION) pour construire le
     texte à coter, et par la section 2 (IMPORT IDB) pour enrichir le `soin`
     écrit dans la cotation du carnet patient. Sans ce lift, quand un patient
     arrivait ici avec `_cotation.validated = true` (section 1 sautée), la
     section 2 levait `ReferenceError: actesRecurrents is not defined`. */
  let actesRecurrents = '';
  let texte           = '';

  /* ══════════════════════════════════════════════════════════════════════
     ⚡ PRÉ-PHASE : COTATION LOCALE INSTANTANÉE (100% SYNCHRONE, pas d'await)
     ══════════════════════════════════════════════════════════════════════
     Calcule un montant estimé depuis `p` directement, sans attendre l'IDB.
     Affiché immédiatement dans la liste → l'utilisateur voit "X € validés"
     dès le clic "Terminer", sans délai perceptible.
     La cotation est ensuite raffinée par l'IDB (actes_recurrents) puis par
     l'API /ami-calcul (invoice_number CPAM + montants NGAP exacts).
     ═══════════════════════════════════════════════════════════════════════ */
  if (!p._cotation?.validated) {
    // Texte le plus rapide disponible depuis p (sans IDB)
    const _texteRapide = (p.actes_recurrents || p.description || p.texte
                          || p.texte_soin || p.acte || p.pathologies || '').trim();
    if (_texteRapide && typeof autoCotationLocale === 'function') {
      const _cotRapide = autoCotationLocale(_texteRapide);
      if (_cotRapide.total > 0 || (_cotRapide.actes && _cotRapide.actes.length)) {
        p._cotation = {
          actes:          _cotRapide.actes || [],
          total:          parseFloat(_cotRapide.total || 0),
          auto:           true,
          validated:      true,
          invoice_number: null,
          _heure_reelle:  heureReelle,
          _pending_api:   true, // marqueur : raffinement en cours
        };
        // Re-render INSTANTANÉ — l'utilisateur voit le montant tout de suite
        if (typeof renderLivePatientList === 'function') {
          try { renderLivePatientList(); } catch (_e) {}
        }
      }
    }
  }

  /* ── 1. AUTO-COTATION (raffinement IDB + API en arrière-plan) ── */
  try {
    if (p._cotation?._pending_api || !p._cotation?.validated) {
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
      texte = actesRecurrents || _texteBase;

      if (texte) {
        /* Cotation locale enrichie (avec actes_recurrents de l'IDB) */
        let cot = (typeof autoCotationLocale === 'function')
          ? autoCotationLocale(texte) : { actes: [], total: 0 };

        // Si la pré-phase n'a pas déjà set p._cotation (ex: pas de _texteRapide),
        // on le fait maintenant avec la valeur enrichie + re-render
        if (!p._cotation?.validated) {
          p._cotation = {
            actes:          cot.actes || [],
            total:          parseFloat(cot.total || 0),
            auto:           true,
            validated:      true,
            invoice_number: null,
            _heure_reelle:  heureReelle,
            _pending_api:   true,
          };
          if (typeof renderLivePatientList === 'function') {
            try { renderLivePatientList(); } catch (_e) {}
          }
        }

        /* Appel API /ami-calcul pour raffiner la cotation
           et obtenir invoice_number officiel. Si l'API répond, on met à
           jour p._cotation + re-render. Si elle échoue, la cotation locale
           reste en place (fallback déjà prêt). */
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

        // Mettre à jour p._cotation avec la valeur API (si elle a répondu)
        // Conserver invoice_number retourné par le worker — indispensable pour
        // que toute re-cotation manuelle ultérieure fasse un PATCH Supabase
        // et non un INSERT (évite le doublon dans l'historique des soins).
        p._cotation = {
          actes:          cot.actes || p._cotation.actes || [],
          total:          parseFloat(cot.total || p._cotation.total || 0),
          auto:           true,
          validated:      true,
          invoice_number: cot.invoice_number || null,
          _heure_reelle:  heureReelle,
          _pending_api:   false,
        };

        // Re-render après réponse API (montants raffinés + invoice_number)
        if (typeof renderLivePatientList === 'function') {
          try { renderLivePatientList(); } catch (_e) {}
        }
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
      // ⚡ Description enrichie pour `soin` : on utilise le texte qui a
      // réellement été coté (avec conversion pathologie → actes) plutôt
      // que p.description brute qui pouvait être juste "Diabète".
      // Résultat affiché partout (carnet patient, historique, planning) :
      // "Injection insuline SC, surveillance glycémie capillaire…"
      // au lieu du label court opaque. Cohérence avec le flux "Coter depuis
      // fiche patient" qui enrichissait déjà la description via pathologiesToActes.
      const _soinEnriched = (typeof _enrichSoinLabel === 'function')
        ? _enrichSoinLabel({ ...p, actes_recurrents: actesRecurrents }, 200)
        : (texte || (p.description || p.texte || '')).slice(0, 200);
      const _cotEntryUber = {
        date:   today,
        heure:  _heureUber, // ⚡ heure RÉELLE de fin de soin (pas la contrainte horaire planifiée)
        actes:  p._cotation.actes || [],
        total:  parseFloat(p._cotation.total || 0),
        soin:   _soinEnriched,
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

/* ════════════════════════════════════════════════════════════
   _uberAfterDoneFlow(p)
   ─────────────────────────────────────────────────────────────
   v5.4 — Flow unifié déclenché AVANT toute progression au patient
   suivant lors d'un clic "✅ Terminer" (Mode Uber Médical OU
   Mode GPS plein écran) :

     1. Cotation + import IDB + km (await pour avoir invoice_number)
     2. Ouverture de la modale signature avec contexte complet
     3. Création auto des consentements (faite par saveSignature
        via _pendingConsentsByInvoice / _lastCotData → fallback)
     4. Création auto du CR de passage initial (rempli avec acte
        coté + horodatage + invoice_number + signature_invoice_id)
     5. Tous ces enregistrements vont dans IDB → carnet patient
        affiche automatiquement les onglets Cotation, Consentements
        et CR Passage.

   Promise résolue uniquement quand la signature est validée OU
   fermée. Permet aux callers d'enchaîner sur le patient suivant
   après que toute la trace médico-légale soit posée.
   ============================================================ */
async function _uberAfterDoneFlow(p) {
  if (!p) return;

  // ⚡ v5.4 — Récap des actions réalisées pendant le flow.
  // Permet d'afficher un toast final synthétique :
  // "✍️ Signature OK · 📋 CR créé · ✅ 2 consentements à jour"
  const _outcome = {
    cotationOk:   false,
    cotationTotal: 0,
    signatureOk:  false,    // true si saveSignature a posé une signature
    crOk:         false,    // true si _crSave a réussi
    consentsCreated:    0,  // nb de consentements nouvellement créés
    consentsAlreadyOk:  0,  // nb de consentements déjà actifs (non recréés)
    consentsRequired:   0,  // nb total d'actes nécessitant un consentement
  };

  // ── 1. Cotation + import IDB (await pour récupérer invoice_number) ──
  // _autoCoterEtImporterPatient est idempotent grâce à la fenêtre 6h
  // (cf. _DEDUP_WINDOW_MS). Si appelée 2 fois pour le même patient, elle
  // upsert au lieu de doubler. Pas de risque de conflit avec la doctrine
  // cotation upsert.
  try {
    await _autoCoterEtImporterPatient(p);
    _outcome.cotationOk = !!p?._cotation?.validated;
    _outcome.cotationTotal = parseFloat(p?._cotation?.total || 0);
  } catch (e) {
    console.warn('[AMI] _uberAfterDoneFlow cotation KO:', e?.message);
  }

  // ── 2. Préparer le contexte pour signature.js ──
  const invoiceId = p?._cotation?.invoice_number
                 || ('uber_' + (p.patient_id || p.id || Date.now()) + '_' + Date.now());
  const actesArr = (p?._cotation?.actes || []).map(a => a.code || a.nom || '').filter(Boolean);
  const patientId = p.patient_id || p.id || '';

  // Mémoriser la cotation dans _lastCotData pour le fallback consentements
  // (saveSignature.js lit cette variable pour détecter les actes nécessitant
  // un consentement quand _pendingConsentsByInvoice n'est pas pré-rempli).
  try {
    window._lastCotData = {
      patient_id:  patientId,
      patient_nom: ((p.prenom||'') + ' ' + (p.nom||'')).trim(),
      actes:       p?._cotation?.actes || [],
      total:       p?._cotation?.total || 0,
      date_soin:   new Date().toISOString().slice(0, 10),
      heure_soin:  p._done_at || new Date().toTimeString().slice(0,5),
      notes:       p.actes_recurrents || p.description || p.texte || '',
      invoice_number: invoiceId,
    };
  } catch(_) {}

  // ── 3. Ouvrir la modale signature (asynchrone) ──
  // Attend la fermeture (validation ou ✕) avant de continuer.
  // saveSignature() crée automatiquement les consentements requis
  // (mécanique existante dans signature.js v2 — détection d'actes).
  //
  // ⚡ v5.6 — Fix bug majeur : l'overlay GPS plein écran (z-index:9999)
  // masquait la modale signature (z-index:1500). Symptôme : "rien ne se
  // passe" au clic Terminer en mode plein écran, modale visible seulement
  // après fermeture de l'overlay (= dernier patient). Solution : on cache
  // visuellement l'overlay le temps de la signature, puis on le restaure.
  // L'instance Leaflet et tous les listeners restent intacts — pas de
  // re-création de la carte ni de cleanup GPS.
  if (typeof openSignatureModal === 'function') {
    // Snapshot de l'état d'affichage de l'overlay GPS plein écran
    const _fsOverlayEl = document.getElementById('uber-fs-overlay');
    const _fsWasVisible = !!(_fsOverlayEl && _fsOverlayEl.style.display !== 'none');
    if (_fsWasVisible) {
      _fsOverlayEl.style.display = 'none';
    }

    await new Promise((resolve) => {
      // Stocker un callback que closeSignatureModal pourra appeler.
      // Si la modale est fermée par n'importe quel chemin (✕ ou Valider),
      // on résout pour ne pas bloquer le flow tournée.
      window._uberAfterSignClose = () => {
        try { delete window._uberAfterSignClose; } catch(_) {}
        // Restaurer l'overlay GPS plein écran s'il était visible avant
        if (_fsWasVisible && _fsOverlayEl && _fsOverlayEl.parentNode) {
          _fsOverlayEl.style.display = '';
          // Forcer Leaflet à recalculer ses dimensions après le reflow
          // (sinon des tuiles peuvent rester grises).
          setTimeout(() => {
            try { if (_uberFSMap) _uberFSMap.invalidateSize(); } catch(_) {}
          }, 50);
        }
        resolve();
      };
      try {
        openSignatureModal(invoiceId, {
          patient_id: patientId,
          actes:      actesArr,
          ide_id:     (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : '',
        });
      } catch (e) {
        console.warn('[AMI] openSignatureModal KO:', e?.message);
        // Restaurer l'overlay si l'ouverture a planté
        if (_fsWasVisible && _fsOverlayEl) _fsOverlayEl.style.display = '';
        resolve(); // ne bloque pas la tournée si la modale plante
      }
      // Fail-safe : si la modale ne se ferme jamais (bug), on libère après 5 min
      setTimeout(() => {
        if (typeof window._uberAfterSignClose === 'function') {
          try { delete window._uberAfterSignClose; } catch(_) {}
          // Restaurer l'overlay
          if (_fsWasVisible && _fsOverlayEl) _fsOverlayEl.style.display = '';
          resolve();
        }
      }, 5 * 60 * 1000);
    });
  }

  // Vérifier si la signature a effectivement été posée dans IDB
  // (saveSignature persiste dans ami_signatures via _sigPut)
  try {
    if (typeof _sigGet === 'function') {
      const sig = await _sigGet(invoiceId);
      _outcome.signatureOk = !!(sig && sig.png && sig.signed_at);
    }
  } catch(_) {}

  // ── 4. Créer le CR de passage automatique ──
  // Doctrine : un CR initial pré-rempli est créé pour CHAQUE patient terminé
  // afin de garantir la traçabilité médico-légale ; l'IDE peut ensuite
  // l'éditer dans l'onglet "CR Passage" du carnet patient.
  try {
    const crRes = await _uberAutoCreateCRPassage(p, invoiceId);
    _outcome.crOk = !!(crRes && crRes.ok);
  } catch (e) {
    console.warn('[AMI] CR auto KO:', e?.message);
  }

  // ── 5. Force-vérifier la création des consentements ──
  // Si saveSignature n'a rien créé (modale fermée sans signer, ou actes
  // sans match consentement), on tente quand même la détection ici pour
  // la trace médico-légale. Best-effort, silencieux.
  try {
    const cRes = await _uberAutoEnsureConsentements(p, invoiceId);
    if (cRes) {
      _outcome.consentsRequired   = cRes.required   || 0;
      _outcome.consentsCreated    = cRes.created    || 0;
      _outcome.consentsAlreadyOk  = cRes.alreadyOk  || 0;
    }
  } catch (e) {
    console.warn('[AMI] Consent auto KO:', e?.message);
  }

  // ── 6. Toast récap ──
  // Construit dynamiquement selon ce qui s'est réellement passé.
  // Type 'ok' (vert) si tout OK, 'wa' (jaune) si signature manquante.
  if (typeof showToast === 'function') {
    const parts = [];

    // Cotation : toujours affichée si validée
    if (_outcome.cotationOk && _outcome.cotationTotal > 0) {
      parts.push(`💶 ${_outcome.cotationTotal.toFixed(2)} €`);
    }

    // Signature : OK ou non posée
    if (_outcome.signatureOk) {
      parts.push('✍️ Signature OK');
    } else if (typeof openSignatureModal === 'function') {
      // La modale a été ouverte mais aucune signature persistée
      // (l'IDE a fermé sans signer, ou la signature a échoué)
      parts.push('⚠️ Signature manquante');
    }

    // CR de passage : créé ou non
    if (_outcome.crOk) {
      parts.push('📋 CR créé');
    }

    // Consentements : récap selon ce qui était requis
    if (_outcome.consentsRequired > 0) {
      const totalOk = _outcome.consentsCreated + _outcome.consentsAlreadyOk;
      if (totalOk === _outcome.consentsRequired) {
        if (_outcome.consentsCreated > 0) {
          parts.push(`✅ ${_outcome.consentsCreated} consentement${_outcome.consentsCreated > 1 ? 's' : ''} créé${_outcome.consentsCreated > 1 ? 's' : ''}`);
        } else {
          parts.push('✅ Consentements à jour');
        }
      } else {
        parts.push(`⚠️ ${_outcome.consentsRequired - totalOk}/${_outcome.consentsRequired} consentement${_outcome.consentsRequired > 1 ? 's' : ''} manquant${_outcome.consentsRequired > 1 ? 's' : ''}`);
      }
    }

    if (parts.length > 0) {
      // Type : warning si signature manquante OU consentement manquant
      const hasWarning = !_outcome.signatureOk
                      || (_outcome.consentsRequired > 0
                          && (_outcome.consentsCreated + _outcome.consentsAlreadyOk) < _outcome.consentsRequired);
      const toastType = hasWarning ? 'wa' : 'ok';
      showToast(parts.join(' · '), toastType);
    }
  }
}

/**
 * Crée un CR de passage IDB initial pour ce patient terminé.
 * Si _crSave existe (cr-passage.js chargé), enregistre directement.
 * Sinon, fallback : on stocke dans une queue en localStorage qui sera
 * drainée au prochain chargement de cr-passage.js.
 *
 * @returns {Promise<{ok:boolean, queued?:boolean}>}
 *   ok=true si le CR est dans IDB ; queued=true si fallback localStorage.
 */
async function _uberAutoCreateCRPassage(p, invoiceId) {
  const patientId = p.patient_id || p.id;
  if (!patientId) return { ok: false };

  const now = new Date();
  const todayISO = now.toISOString();
  const heure = p._done_at || now.toTimeString().slice(0, 5);

  // Construire le texte des actes effectués (pour le champ "actes" du CR)
  const actesText = (p._cotation?.actes || [])
    .map(a => a.nom || a.code)
    .filter(Boolean)
    .join(', ')
    || (p.actes_recurrents || p.description || p.texte || 'Soin infirmier à domicile');

  const crObj = {
    patient_id:    patientId,
    patient_nom:   ((p.prenom||'') + ' ' + (p.nom||'')).trim(),
    user_id:       (typeof APP !== 'undefined' && APP?.user?.id) ? APP.user.id : '',
    date:          todayISO,
    medecin:       '',
    actes:         actesText,
    ta:            '',
    glycemie:      '',
    spo2:          '',
    temperature:   '',
    fc:            '',
    eva:           '',
    observations:  '', // l'IDE complétera depuis le carnet patient si besoin
    transmissions: '',
    urgence:       'normal',
    inf_nom:       (typeof APP !== 'undefined')
                     ? `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim()
                     : '',
    type:          'private',
    alert:         false,
    saved_at:      todayISO,
    updated_at:    todayISO,
    _cr_version:   2,
    // ⚡ Lien médico-légal : permet de retrouver la signature et la cotation
    invoice_id:    invoiceId,
    _source:       'uber_auto', // distingue les CR créés auto des CR manuels
    _heure_soin:   heure,
  };

  // Tentative 1 : appeler _crSave si cr-passage.js est chargé
  if (typeof _crSave === 'function') {
    try {
      await _crSave(crObj);
      // Sync inter-appareils silencieux
      if (typeof crSyncPush === 'function') {
        crSyncPush().catch(() => {});
      }
      return { ok: true };
    } catch (e) {
      console.warn('[AMI] _crSave KO:', e?.message);
    }
  }

  // Tentative 2 : queue localStorage (drainée au prochain crLoadHistory)
  try {
    const k = 'ami_cr_pending_queue';
    const queue = JSON.parse(localStorage.getItem(k) || '[]');
    queue.push(crObj);
    localStorage.setItem(k, JSON.stringify(queue));
    return { ok: true, queued: true };
  } catch(_) {
    return { ok: false };
  }
}

/**
 * Force-crée des consentements si la cotation matche des actes nécessitant
 * un consentement, et qu'aucun n'existe encore actif. Best-effort silencieux —
 * ne lève jamais. Utilise la signature stockée par saveSignature s'il y en
 * a une (via le hash invoice → ami_signatures).
 *
 * @returns {Promise<{required:number, created:number, alreadyOk:number}>}
 *   required  = nb d'actes ayant déclenché un type de consentement
 *   created   = nb de consentements nouvellement créés cette fois
 *   alreadyOk = nb de consentements déjà actifs valides (skip)
 */
async function _uberAutoEnsureConsentements(p, invoiceId) {
  const result = { required: 0, created: 0, alreadyOk: 0 };

  if (typeof _consentCreateOrUpdate !== 'function'
      || typeof CONSENT_TEMPLATES === 'undefined'
      || typeof _consentGetActive !== 'function') return result;

  const patientId = p.patient_id || p.id;
  if (!patientId) return result;

  // Détecter les types de consentement requis depuis les actes coté
  const allText = ((p._cotation?.actes || [])
                    .map(a => (a.nom || '') + ' ' + (a.code || ''))
                    .join(' ')
                  + ' ' + (p.actes_recurrents || '')
                  + ' ' + (p.description || '')
                  + ' ' + (p.texte || '')).toLowerCase();

  const requiredTypes = [];
  for (const [key, tpl] of Object.entries(CONSENT_TEMPLATES)) {
    if (tpl.actes_lies?.some(mot => allText.includes(mot))) {
      requiredTypes.push(key);
    }
  }
  result.required = requiredTypes.length;
  if (!requiredTypes.length) return result; // aucun acte ne nécessite consentement

  const patientNom = ((p.prenom||'') + ' ' + (p.nom||'')).trim();
  const dateSoin = new Date().toISOString().slice(0, 10);

  for (const type of requiredTypes) {
    try {
      // Si déjà un consentement actif valide, ne rien faire
      const existing = await _consentGetActive(patientId, type);
      if (existing && existing.status === 'signed') {
        // Vérifier expiration
        const expired = existing.expires_at && new Date(existing.expires_at) < new Date();
        if (!expired) { result.alreadyOk++; continue; } // déjà OK
      }
      // Créer pré-rempli sans signatureDataUrl (status='pending')
      // Le invoice_id permet de retrouver la signature canonique dans
      // ami_signatures si l'IDE a signé pendant le flow.
      await _consentCreateOrUpdate({
        patient_id:       patientId,
        type,
        signatureDataUrl: null,        // signature résolue via invoice_id
        patient_nom:      patientNom,
        qualite:          'Patient',
        date:             dateSoin,
        invoice_id:       invoiceId,   // ⚡ lien canonique vers ami_signatures
      });
      result.created++;
    } catch (e) {
      console.warn('[AMI] _consentCreateOrUpdate KO pour', type, ':', e?.message);
    }
  }

  return result;
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

  // ⚡ v5.4 — Flow unifié : cotation → signature → CR → consentements
  // _uberAfterDoneFlow await la cotation puis ouvre la modale signature.
  // L'enchaînement vers le patient suivant attend la fermeture de la modale.
  // markUberDone est désormais async — les callers (markUberDone() depuis
  // le bouton classique OU _uberFSEndPatient depuis le GPS plein écran)
  // peuvent await pour synchroniser leur logique aval.
  try {
    await _uberAfterDoneFlow(p);
  } catch (e) {
    console.warn('[AMI] markUberDone flow KO:', e?.message);
  }

  /* ⚡ Depuis le refactor liste unique : renderLivePatientList est la seule fonction
     qui écrit dans #uber-next-patient. selectBestPatient() publie le nouveau
     nextPatient dans le store, ce qui déclenche synchroniquement
     _renderNextPatient (listener APP.on('nextPatient')) qui appelle à son tour
     renderLivePatientList. Résultat : UN seul rafraîchissement de la liste,
     avec les boutons Terminé/Absent/Naviguer désormais sur le NOUVEAU prochain
     patient — instantanément, sans délai. */
  selectBestPatient();
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
  // ⚡ Même flow que markUberDone : selectBestPatient → nextPatient → _renderNextPatient
  //    → renderLivePatientList (seule source de vérité visuelle)
  selectBestPatient();
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

/* ════════════════════════════════════════════════════════════════════════════
   🗺️ MODE GPS PLEIN ÉCRAN — Uber Médical v1.0
   ────────────────────────────────────────────────────────────────────────────
   Overlay fixed inset:0 avec carte Leaflet dédiée (instance séparée de
   APP.map pour ne pas casser la carte du Pilotage). Affiche :
     • Tous les patients de la tournée (markers numérotés)
     • Position GPS infirmière temps réel (refresh 10s — choix utilisateur)
     • Polyline OSRM vers le prochain patient
     • HUD bas : nom prochain patient + 4 boutons d'action
     • HUD haut : compteur progression + bouton fermer
   Utilise les fonctions existantes (markUberDone, selectBestPatient,
   recalcRouteUber, openUrgentPatientModal) pour ne pas dupliquer la logique
   métier — l'overlay est un pur "wrapper visuel mobile-first" autour du
   Mode Uber Médical existant.
   ──────────────────────────────────────────────────────────────────────────── */

let _uberFSMap          = null;   // Instance Leaflet dédiée
let _uberFSGpsInterval  = null;   // setInterval (10s) de polling GPS
let _uberFSMarkers      = [];     // Markers patients
let _uberFSLiveMarker   = null;   // Marker infirmière (bleu pulsant)
let _uberFSRoutePoly    = null;   // Polyline route OSRM
let _uberFSWakeLock     = null;   // Wake Lock (empêche extinction écran)
let _uberFSNextListener = null;   // Unsubscribe APP.on('nextPatient')
let _uberFSPosListener  = null;   // Unsubscribe APP.on('userPos')

/**
 * Ouvre l'overlay GPS plein écran. Appelée par le bouton "🗺️ GPS plein écran"
 * du Mode Uber Médical. Idempotent : si déjà ouvert, ne fait rien.
 */
function openUberFullscreenGPS() {
  if (typeof requireAuth === 'function' && !requireAuth()) return;

  // Garde : déjà ouvert
  if (document.getElementById('uber-fs-overlay')) {
    log('[Uber FS] déjà ouvert');
    return;
  }

  // Garde : Leaflet dispo
  if (typeof L === 'undefined') {
    if (typeof showToast === 'function') showToast('❌ Carte indisponible — Leaflet non chargé');
    return;
  }

  // Garde : patients chargés
  const patients = APP.get('uberPatients') || [];
  if (!patients.length) {
    if (typeof showToast === 'function')
      showToast('⚠️ Aucun patient — démarrez la journée d\'abord', 'wa');
    return;
  }

  // ── Construction du DOM overlay ────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'uber-fs-overlay';
  overlay.innerHTML = `
    <!-- Carte plein écran -->
    <div id="uber-fs-map"></div>

    <!-- HUD HAUT : titre + progression + fermer -->
    <div id="uber-fs-top">
      <div class="uber-fs-badge">
        <span class="uber-fs-dot"></span>
        <span id="uber-fs-gps-status">GPS…</span>
      </div>
      <div class="uber-fs-progress" id="uber-fs-progress">— / —</div>
      <button class="uber-fs-close" onclick="closeUberFullscreenGPS()" aria-label="Fermer">✕</button>
    </div>

    <!-- HUD BAS : prochain patient + actions -->
    <div id="uber-fs-bottom">
      <div class="uber-fs-next-card" id="uber-fs-next-card">
        <div class="uber-fs-next-label">🎯 PROCHAIN PATIENT</div>
        <div class="uber-fs-next-name" id="uber-fs-next-name">—</div>
        <div class="uber-fs-next-meta" id="uber-fs-next-meta">—</div>
      </div>
      <div class="uber-fs-actions">
        <div class="uber-fs-actions-row uber-fs-actions-secondary">
          <button class="uber-fs-btn uber-fs-btn-secondary" onclick="_uberFSRecalcRoute()" title="Recalculer la route">
            <span>🔄</span><span class="uber-fs-btn-lbl">Recalculer</span>
          </button>
          <button class="uber-fs-btn uber-fs-btn-secondary" onclick="_uberFSBestNext()" title="Meilleur suivant">
            <span>🧠</span><span class="uber-fs-btn-lbl">Meilleur</span>
          </button>
          <button class="uber-fs-btn uber-fs-btn-urgent" onclick="openUrgentPatientModal()" title="Ajouter un patient urgent">
            <span>🚨</span><span class="uber-fs-btn-lbl">+ Urgent</span>
          </button>
        </div>
        <div class="uber-fs-actions-row uber-fs-actions-primary">
          <button class="uber-fs-btn uber-fs-btn-absent" onclick="_uberFSAbsentPatient()" title="Patient absent">
            <span>❌</span><span class="uber-fs-btn-lbl">Absent</span>
          </button>
          <button class="uber-fs-btn uber-fs-btn-primary" onclick="_uberFSEndPatient()" title="Terminer ce patient">
            <span>✅</span><span class="uber-fs-btn-lbl">Terminer</span>
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Bloquer le scroll body en arrière-plan
  document.body.style.overflow = 'hidden';

  // ── Initialiser la carte Leaflet (instance dédiée) ─────────────────
  // Centre par défaut : startPoint > position GPS connue > centre France
  const startPoint = APP.get('startPoint') || APP.get('userPos');
  const centerLat  = startPoint?.lat || 46.5;
  const centerLng  = startPoint?.lng || 2.3;

  // Délai requis pour que le container ait sa taille définitive
  setTimeout(() => {
    try {
      _uberFSMap = L.map('uber-fs-map', {
        zoomControl: true,
        attributionControl: false,
      }).setView([centerLat, centerLng], 14);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(_uberFSMap);

      // Premier rendu complet
      _uberFSRender();
      _uberFSUpdateHUD();

      // Recadrer sur tous les markers + position
      _uberFSFitView();

      // Listeners réactifs : si nextPatient ou userPos changent ailleurs,
      // on re-rend l'overlay sans dépendre de notre propre cycle 10s.
      _uberFSNextListener = APP.on('nextPatient', () => {
        if (!_uberFSMap) return;
        _uberFSRender();
        _uberFSUpdateHUD();
      });
      _uberFSPosListener = APP.on('userPos', () => {
        if (!_uberFSMap) return;
        _uberFSDrawLiveMarker();
      });
    } catch (e) {
      logErr('[Uber FS] init carte KO', e);
      if (typeof showToast === 'function') showToast('❌ Erreur carte : ' + e.message);
      closeUberFullscreenGPS();
      return;
    }
  }, 50);

  // ── Démarrer le cycle GPS 10s ──────────────────────────────────────
  _uberFSStartGPSPolling();

  // ── Wake Lock (empêcher l'écran de s'éteindre) ─────────────────────
  _uberFSAcquireWakeLock();

  if (typeof showToast === 'function') showToast('🗺️ Mode GPS plein écran activé');
}

/**
 * Ferme l'overlay et nettoie toutes les ressources (interval, listeners,
 * wake lock, instance Leaflet, marker GPS).
 */
function closeUberFullscreenGPS() {
  // Stop GPS polling
  if (_uberFSGpsInterval) {
    clearInterval(_uberFSGpsInterval);
    _uberFSGpsInterval = null;
  }

  // Release wake lock
  if (_uberFSWakeLock) {
    try { _uberFSWakeLock.release(); } catch (_) {}
    _uberFSWakeLock = null;
  }

  // Detach listeners
  if (_uberFSNextListener) { try { _uberFSNextListener(); } catch (_) {} _uberFSNextListener = null; }
  if (_uberFSPosListener)  { try { _uberFSPosListener();  } catch (_) {} _uberFSPosListener  = null; }

  // Detruire la carte Leaflet
  if (_uberFSMap) {
    try { _uberFSMap.remove(); } catch (_) {}
    _uberFSMap = null;
  }
  _uberFSMarkers    = [];
  _uberFSLiveMarker = null;
  _uberFSRoutePoly  = null;

  // Retirer l'overlay du DOM
  const overlay = document.getElementById('uber-fs-overlay');
  if (overlay) overlay.remove();

  // Restaurer le scroll body
  document.body.style.overflow = '';
}

/**
 * (Re)dessine tous les markers patients + polyline route. Appelée à chaque
 * changement de nextPatient ou de statut patient.
 */
function _uberFSRender() {
  if (!_uberFSMap) return;

  // 1. Nettoyer les anciens markers patients (pas le live marker)
  _uberFSMarkers.forEach(m => { try { _uberFSMap.removeLayer(m); } catch (_) {} });
  _uberFSMarkers = [];

  // 2. Markers patients
  const patients = APP.get('uberPatients') || [];
  const next     = APP.get('nextPatient');
  const nextKey  = next ? String(next.patient_id || next.id || '') : '';

  patients.forEach((p, idx) => {
    if (!p.lat || !p.lng) return;
    const k = String(p.patient_id || p.id || '');
    const isNext   = (k === nextKey);
    const isDone   = !!p.done;
    const isAbsent = !!p.absent;
    const isUrgent = !!(p.urgent || p.urgence);
    const isLate   = !!p.late && !isDone && !isAbsent;

    let bg, fg = '#fff', size = 32;
    if (isDone)        { bg = '#3dd68c'; }
    else if (isAbsent) { bg = '#6a8099'; }
    else if (isUrgent) { bg = '#ff5f6d'; size = 40; }
    else if (isLate)   { bg = '#ff5f6d'; size = 38; }  // patient en retard
    else if (isNext)   { bg = '#ffb547'; size = 42; }
    else               { bg = '#00d4aa'; }

    let ringStyle;
    if (isNext) {
      ringStyle = 'box-shadow:0 0 0 4px rgba(255,181,71,.35), 0 4px 14px rgba(0,0,0,.4);';
    } else if (isLate) {
      ringStyle = 'box-shadow:0 0 0 3px rgba(255,95,109,.45), 0 4px 12px rgba(0,0,0,.4);';
    } else {
      ringStyle = 'box-shadow:0 2px 8px rgba(0,0,0,.35);';
    }

    // Symbole : ⏰ si retard et non-next, sinon numéro/coche
    const symbol = isDone ? '✓'
                  : isAbsent ? '–'
                  : (isLate && !isNext) ? '⏰'
                  : (idx + 1);
    const fontSize = (isLate && !isNext) ? 16 : (size>=40 ? 14 : 12);

    const marker = L.marker([p.lat, p.lng], {
      zIndexOffset: isNext ? 900 : (isUrgent ? 500 : (isLate ? 400 : 0)),
      icon: L.divIcon({
        className: '',
        html: `<div style="
          width:${size}px;height:${size}px;
          background:${bg};color:${fg};
          border:3px solid white;border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          font-size:${fontSize}px;font-weight:700;
          ${ringStyle}
          ${isDone||isAbsent ? 'opacity:.55;' : ''}
        ">${symbol}</div>`,
        iconSize:   [size, size],
        iconAnchor: [size/2, size/2],
      }),
    });

    const nom  = ((p.prenom || '') + ' ' + (p.nom || '')).trim()
              || p.description || p.label || ('Patient ' + (idx + 1));
    const adr  = p.adresse || p.address || p.addressFull || '';
    const heure = p.heure_soin || p.heure_preferee || p.heure || '';
    // Calcul minutes de retard si applicable
    const lateMin = (isLate && p.time) ? Math.round((Date.now() - p.time) / 60000) : 0;
    marker.bindPopup(`
      <strong style="font-size:13px">${nom}</strong>
      ${adr ? `<br><span style="font-size:11px;color:#666">${adr}</span>` : ''}
      ${heure ? `<br><span style="font-size:11px">🕐 ${heure}</span>` : ''}
      ${isNext ? '<br><span style="color:#ffb547;font-size:11px;font-weight:700">🎯 PROCHAIN</span>' : ''}
      ${isLate ? `<br><span style="color:#ff5f6d;font-size:11px;font-weight:700">⏰ RETARD ${lateMin > 0 ? lateMin + ' min' : ''}</span>` : ''}
      ${isUrgent ? '<br><span style="color:#ff5f6d;font-size:11px;font-weight:700">🚨 URGENT</span>' : ''}
    `);

    marker.addTo(_uberFSMap);
    _uberFSMarkers.push(marker);
  });

  // 3. Polyline route (position infirmière → prochain patient)
  _uberFSDrawRoute();

  // 4. Live marker (au cas où il aurait été supprimé)
  _uberFSDrawLiveMarker();
}

/**
 * Dessine ou met à jour le marker bleu pulsant de l'infirmière.
 */
function _uberFSDrawLiveMarker() {
  if (!_uberFSMap) return;
  const pos = APP.get('userPos');
  if (!pos || !pos.lat || !pos.lng) return;

  if (_uberFSLiveMarker) {
    _uberFSLiveMarker.setLatLng([pos.lat, pos.lng]);
  } else {
    _uberFSLiveMarker = L.marker([pos.lat, pos.lng], {
      zIndexOffset: 1000,
      icon: L.divIcon({
        className: '',
        html: `<div class="uber-fs-live-pulse">
          <div class="uber-fs-live-dot"></div>
        </div>`,
        iconSize:   [40, 40],
        iconAnchor: [20, 20],
      }),
    }).addTo(_uberFSMap);
    _uberFSLiveMarker.bindPopup('📍 Vous êtes ici');
  }
}

/**
 * Trace la route OSRM entre la position actuelle et le prochain patient.
 * Si pas de position GPS, ne fait rien.
 */
async function _uberFSDrawRoute() {
  if (!_uberFSMap) return;

  // Cleanup ancienne route
  if (_uberFSRoutePoly) {
    try { _uberFSMap.removeLayer(_uberFSRoutePoly); } catch (_) {}
    _uberFSRoutePoly = null;
  }

  const pos  = APP.get('userPos') || APP.get('startPoint');
  const next = APP.get('nextPatient');
  if (!pos || !next || !next.lat || !next.lng) return;

  // Polyline droite immédiate (fallback visible avant OSRM)
  const fallback = L.polyline([[pos.lat, pos.lng], [next.lat, next.lng]], {
    color: '#ffb547', weight: 3, opacity: 0.5, dashArray: '6,8',
  }).addTo(_uberFSMap);
  _uberFSRoutePoly = fallback;

  // Route OSRM réelle (asynchrone, remplace le fallback)
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pos.lng},${pos.lat};${next.lng},${next.lat}?overview=full&geometries=geojson`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined,
    });
    const d = await r.json();
    if (d.code !== 'Ok' || !d.routes?.[0]) return;

    if (!_uberFSMap) return; // overlay fermé entre temps

    // Remplacer la polyline droite par la vraie route
    if (_uberFSRoutePoly) {
      try { _uberFSMap.removeLayer(_uberFSRoutePoly); } catch (_) {}
    }
    const latlngs = d.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    _uberFSRoutePoly = L.polyline(latlngs, {
      color: '#ffb547', weight: 5, opacity: 0.85,
    }).addTo(_uberFSMap);

    // Stocker durée + distance pour le HUD
    const dist = (d.routes[0].distance / 1000).toFixed(1);
    const dur  = Math.round(d.routes[0].duration / 60);
    const meta = $('uber-fs-next-meta');
    if (meta && next) {
      const adr   = next.adresse || next.address || next.addressFull || '';
      const heure = next.heure_soin || next.heure_preferee || next.heure || '';
      meta.innerHTML = `
        <span class="uber-fs-meta-pill">📏 ${dist} km</span>
        <span class="uber-fs-meta-pill">⏱️ ~${dur} min</span>
        ${heure ? `<span class="uber-fs-meta-pill">🕐 ${heure}</span>` : ''}
        ${adr ? `<div class="uber-fs-meta-addr">${adr}</div>` : ''}
      `;
    }
  } catch (e) {
    // OSRM KO → on garde le fallback dashé
    log('[Uber FS] OSRM route KO:', e.message);
  }
}

/**
 * Met à jour la card prochain patient + le compteur progression.
 */
function _uberFSUpdateHUD() {
  const next     = APP.get('nextPatient');
  const patients = APP.get('uberPatients') || [];
  const total    = patients.length;
  const done     = patients.filter(p => p.done || p.absent).length;
  const reste    = total - done;

  const progEl = $('uber-fs-progress');
  if (progEl) progEl.textContent = `${done} / ${total} · ${reste} restant${reste > 1 ? 's' : ''}`;

  const nameEl = $('uber-fs-next-name');
  const metaEl = $('uber-fs-next-meta');
  if (next) {
    const nom = ((next.prenom || '') + ' ' + (next.nom || '')).trim()
             || next.description || next.label || 'Patient suivant';
    if (nameEl) nameEl.textContent = nom;

    // Meta provisoire (sera enrichie par OSRM avec dist/durée)
    const adr   = next.adresse || next.address || next.addressFull || '';
    const heure = next.heure_soin || next.heure_preferee || next.heure || '';
    // Pill retard si applicable (calc minutes depuis l'heure planifiée)
    const lateMin = (next.late && next.time)
      ? Math.round((Date.now() - next.time) / 60000)
      : 0;
    const latePill = (lateMin > 0)
      ? `<span class="uber-fs-meta-pill uber-fs-late-pill">⏰ Retard ${lateMin} min</span>`
      : '';
    if (metaEl) {
      metaEl.innerHTML = `
        ${latePill}
        ${heure ? `<span class="uber-fs-meta-pill">🕐 ${heure}</span>` : ''}
        ${adr ? `<div class="uber-fs-meta-addr">${adr}</div>` : '<div class="uber-fs-meta-addr">—</div>'}
      `;
    }
  } else {
    if (nameEl) nameEl.textContent = '✅ Tournée terminée';
    if (metaEl) metaEl.innerHTML = '<div class="uber-fs-meta-addr">Tous les patients ont été visités</div>';
  }
}

/**
 * Recadre la vue pour englober tous les markers + position GPS.
 */
function _uberFSFitView() {
  if (!_uberFSMap) return;
  const points = [];
  const pos = APP.get('userPos') || APP.get('startPoint');
  if (pos?.lat && pos?.lng) points.push([pos.lat, pos.lng]);
  (APP.get('uberPatients') || []).forEach(p => {
    if (p.lat && p.lng && !p.done && !p.absent) points.push([p.lat, p.lng]);
  });
  if (points.length >= 2) {
    try { _uberFSMap.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 15 }); } catch (_) {}
  } else if (points.length === 1) {
    _uberFSMap.setView(points[0], 15);
  }
}

/**
 * Cycle GPS toutes les 10s (compromis batterie choisi par l'utilisateur).
 * Utilise getCurrentPosition + setInterval plutôt que watchPosition pour
 * un contrôle précis de la fréquence.
 */
function _uberFSStartGPSPolling() {
  if (!navigator.geolocation) {
    const el = $('uber-fs-gps-status');
    if (el) el.textContent = 'GPS indisponible';
    return;
  }

  const _statusEl = $('uber-fs-gps-status');
  if (_statusEl) _statusEl.textContent = 'GPS…';

  // Premier fix immédiat (sinon l'utilisateur attend 10s avant de voir le marker)
  const fetchPos = () => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        APP.set('userPos', { lat, lng });
        if (!APP.get('startPoint')) APP.set('startPoint', { lat, lng });
        if (_statusEl) _statusEl.textContent = `GPS · ${new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
        // _uberFSDrawLiveMarker est appelé via le listener APP.on('userPos')
      },
      err => {
        if (_statusEl) _statusEl.textContent = '❌ GPS perdu';
        log('[Uber FS] GPS err:', err.message);
      },
      { enableHighAccuracy: true, maximumAge: 8000, timeout: 9000 }
    );
  };

  fetchPos();
  _uberFSGpsInterval = setInterval(fetchPos, 10000);
}

/**
 * Acquiert un Wake Lock pour empêcher l'écran de s'éteindre pendant la
 * tournée (utile en voiture sur support GPS). Silencieux si non supporté.
 */
async function _uberFSAcquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      _uberFSWakeLock = await navigator.wakeLock.request('screen');
      log('[Uber FS] Wake Lock acquis');
    }
  } catch (e) {
    log('[Uber FS] Wake Lock KO:', e.message);
  }
}

/* ── Wrappers boutons HUD : délèguent à la logique métier existante ── */

/**
 * Détermine si on est sur le dernier patient restant (avant l'action courante).
 * "Restants" = patients non encore done ET non encore absent.
 * Si <= 1, l'action en cours (Terminer ou Absent) clôt la journée.
 */
function _uberFSIsLastPatient() {
  const _before = (APP.get('uberPatients') || []);
  const _restantsAvant = _before.filter(p => !p.done && !p.absent).length;
  return _restantsAvant <= 1;
}

/**
 * Déclenche l'auto-clôture de la journée + ouverture du bilan, en répliquant
 * exactement le comportement du clic "🏁 Clôturer la journée" du Pilotage.
 * Utilisée par _uberFSEndPatient et _uberFSAbsentPatient lorsqu'il s'agit
 * du dernier patient de la journée.
 */
function _uberFSAutoCloseDay(reason) {
  if (typeof terminerTourneeAvecBilan !== 'function') return;

  if (typeof showToast === 'function') {
    const msg = reason === 'absent'
      ? '✅ Dernier patient marqué absent — clôture de la journée…'
      : '✅ Dernier patient terminé — clôture de la journée…';
    showToast(msg);
  }

  // Délai court : laisse markUberDone()/markUberAbsent() finaliser leur cotation
  // async (selectBestPatient + _autoCoterEtImporterPatient en arrière-plan)
  // avant que terminerTourneeAvecBilan ne fasse son inventaire.
  setTimeout(async () => {
    try {
      // Fermer l'overlay AVANT d'ouvrir la modale Bilan, sinon le bilan
      // s'affiche derrière la carte plein écran et reste invisible.
      closeUberFullscreenGPS();

      // skipConfirm: true → bypass du dialogue "Clôturer la journée ?"
      // La logique métier (km journal + bilan) est strictement identique
      // à celle déclenchée par le bouton 🏁 Clôturer du Pilotage.
      await terminerTourneeAvecBilan({ skipConfirm: true });
    } catch (e) {
      logErr('[Uber FS] auto-clôture KO:', e);
      if (typeof showToast === 'function')
        showToast('⚠️ Erreur clôture auto — clique sur 🏁 Clôturer la journée', 'wa');
    }
  }, 600);
}

async function _uberFSEndPatient() {
  if (typeof markUberDone !== 'function') return;

  // Snapshot AVANT markUberDone : sert à détecter si le patient qu'on vient
  // de terminer était le dernier (= aucun autre patient restant).
  const _estDernier = _uberFSIsLastPatient();

  // Cotation + import + km incrémental + sélection du patient suivant
  await markUberDone();

  // markUberDone déclenche selectBestPatient → APP.set('nextPatient', ...)
  // → notre listener APP.on('nextPatient') re-render automatiquement.
  // Recadrer sur le nouveau prochain patient
  setTimeout(() => _uberFSFitView(), 200);

  // ── Si c'était le dernier patient → auto-clôture journée ─────────────
  // Réplique exactement le comportement du clic "🏁 Clôturer la journée".
  if (_estDernier) _uberFSAutoCloseDay('done');
}

/**
 * Marque le patient courant comme absent (pas de cotation, pas de CA).
 * Pose une confirmation rapide (action irréversible côté tournée).
 * Si c'est le dernier patient restant → auto-clôture journée.
 */
async function _uberFSAbsentPatient() {
  if (typeof markUberAbsent !== 'function') return;

  const next = APP.get('nextPatient');
  if (!next) return;

  // Confirmation tactile pour éviter les mis-clics (le bouton est gros)
  const nom = ((next.prenom || '') + ' ' + (next.nom || '')).trim()
           || next.description || next.label || 'ce patient';
  if (!confirm(`Marquer ${nom} comme absent ?\n\nAucune cotation ne sera enregistrée pour ce patient.`)) return;

  // Snapshot AVANT pour détection dernier patient
  const _estDernier = _uberFSIsLastPatient();

  // Pose absent=true et déclenche selectBestPatient → re-render auto via listener
  markUberAbsent();

  // Recadrer sur le nouveau prochain patient
  setTimeout(() => _uberFSFitView(), 200);

  // Si c'était le dernier patient → auto-clôture journée
  if (_estDernier) _uberFSAutoCloseDay('absent');
}

async function _uberFSRecalcRoute() {
  if (typeof recalcRouteUber === 'function') {
    await recalcRouteUber();
  }
  // Redessiner notre polyline locale (la route globale est dans uber-route-info)
  _uberFSDrawRoute();
  if (typeof showToast === 'function') showToast('🔄 Route recalculée');
}

async function _uberFSBestNext() {
  if (typeof selectBestPatient === 'function') {
    await selectBestPatient();
    setTimeout(() => _uberFSFitView(), 200);
  }
  if (typeof showToast === 'function') showToast('🧠 Sélection mise à jour');
}

/* ── Exposition globale (onclick HTML) ────────────────────────────── */
if (typeof window !== 'undefined') {
  window.openUberFullscreenGPS  = openUberFullscreenGPS;
  window.closeUberFullscreenGPS = closeUberFullscreenGPS;
  window._uberFSEndPatient      = _uberFSEndPatient;
  window._uberFSAbsentPatient   = _uberFSAbsentPatient;
  window._uberFSRecalcRoute     = _uberFSRecalcRoute;
  window._uberFSBestNext        = _uberFSBestNext;
  // v5.3 — détection retard + recalcul
  window.recalcOnDelay          = recalcOnDelay;
  window.dismissDelayAlert      = dismissDelayAlert;
}
