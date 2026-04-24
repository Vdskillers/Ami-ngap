/* ════════════════════════════════════════════════
   tournee.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Tournée IA + Import + Planning + Pilotage Live
   ⚠️  Requiert Leaflet.js, map.js, uber.js, ai-tournee.js
   v5.0 :
   ✅ optimiserTournee() — moteur IA local (VRPTW + 2-opt)
   ✅ Mode dégradé API si IA indisponible
   ✅ Affichage horaires calculés (arrivée, début soin)
   ✅ Score rentabilité €/h après optimisation
   ✅ startLiveOptimization() au démarrage journée
════════════════════════════════════════════════ */

/* ── Guards ──────────────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined',            'tournee.js : utils.js non chargé.');
  assertDep(typeof optimizeTour !== 'undefined',   'tournee.js : ai-tournee.js non chargé.');
  assertDep(typeof L !== 'undefined',              'tournee.js : Leaflet non chargé.');
})();

/* Fallback défensif si optimizeTour non disponible (ne devrait pas arriver) */
if (typeof optimizeTour === 'undefined') {
  window.optimizeTour = async function(patients) {
    return [...patients].sort((a,b) => (a.heure||'').localeCompare(b.heure||''));
  };
}

function storeImportedData(d){
  // Un vrai import utilisateur efface le flag planning-only
  if (d) delete d._planningOnly;
  APP.importedData=d;
  // Synchroniser aussi _planningData pour la vue Planning hebdomadaire
  if (d?.patients?.length || d?.entries?.length) {
    window.APP._planningData = d;
  }
  // Sauvegarder dans localStorage (persistance entre sessions)
  if (d?.patients?.length || d?.entries?.length) _syncPlanningStorage();
  // Mettre à jour le banner Planning
  const banner=$('pla-import-banner');
  const info=$('pla-import-info');
  if(banner&&d){
    const n=d.total||d.patients?.length||d.entries?.length||'?';
    if(info)info.innerHTML=`✅ <strong>${n}</strong> entrée(s) importée(s) disponibles pour générer un planning automatique.`;
    banner.style.display='block';
    const manual=$('pla-manual');
    if(manual)manual.style.display='none';
  }
  // Mettre à jour les selects de contraintes de passage (Pilotage)
  if (typeof populateConstraintSelects === 'function') populateConstraintSelects();
  showCaFromImport();
}

/* ── Mode d'optimisation sélectionné dans le pilotage ── */
function getOptimMode() {
  const el = document.querySelector('input[name="live-optim-mode"]:checked');
  return el ? el.value : 'ia'; // 'ia' | 'heure' | 'mixte'
}

/* ── Style réactif des radio buttons du sélecteur de mode ── */
function _bindOptimModeUI() {
  document.querySelectorAll('input[name="live-optim-mode"]').forEach(radio => {
    // Supprimer les anciens listeners pour éviter les doublons
    radio.removeEventListener('change', _onOptimModeChange);
    radio.addEventListener('change', _onOptimModeChange);
  });
  // Appliquer l'état visuel immédiatement au chargement
  _applyOptimModeStyle();
}

function _onOptimModeChange() {
  _applyOptimModeStyle();
}

function _applyOptimModeStyle() {
  const labels = { ia: 'live-mode-ia-lbl', heure: 'live-mode-heure-lbl', mixte: 'live-mode-mixte-lbl' };
  // Trouver le radio coché parmi tous les radios
  const checked = document.querySelector('input[name="live-optim-mode"]:checked');
  const checkedVal = checked ? checked.value : 'ia';
  Object.entries(labels).forEach(([val, lblId]) => {
    const lbl = $(lblId);
    if (!lbl) return;
    if (val === checkedVal) {
      lbl.style.border = '2px solid var(--a)';
      lbl.style.background = 'rgba(0,212,170,.06)';
    } else {
      lbl.style.border = '1px solid var(--b)';
      lbl.style.background = 'var(--s)';
    }
  });
}

/* Écouter les events de navigation */
const _onNavLive = e => {
  if (e.detail?.view === 'live') {
    setTimeout(_bindOptimModeUI, 100);
    // Peupler les selects de contraintes de passage
    setTimeout(() => {
      if (typeof populateConstraintSelects === 'function') populateConstraintSelects();
    }, 120);
    // Restaurer le CA journée clôturée si la tournée est terminée
    setTimeout(() => {
      try {
        const saved = sessionStorage.getItem('ami_ca_journee');
        if (saved && LIVE_CA_TOTAL === 0) {
          const caEl = document.getElementById('live-ca-total');
          if (caEl && !caEl.textContent.includes('du jour')) {
            caEl.textContent = `💶 CA journée clôturée : ${parseFloat(saved).toFixed(2)} €`;
            caEl.style.display = 'block';
          }
        }
      } catch {}
    }, 150);
  }
};
document.addEventListener('app:nav',     _onNavLive);
document.addEventListener('ui:navigate', _onNavLive);

/* Recharger le planning hebdomadaire quand on navigue vers la vue "pla" */
const _onNavPla = e => {
  if (e.detail?.view === 'pla') {
    setTimeout(() => {
      _planningInitCabinetUI();
      _restorePlanningIfNeeded();
    }, 100);
  }
};
document.addEventListener('app:nav',     _onNavPla);
document.addEventListener('ui:navigate', _onNavPla);

function showCaFromImport(){
  if(!APP.importedData)return;
  const patients=APP.importedData.patients||APP.importedData.entries||[];
  if(!patients.length)return;
  const ca=estimateRevenue(patients);
  const w=$('tur-ca-wrap'),v=$('tur-ca-val');
  if(w&&v){v.textContent=ca.toFixed(2)+' €';w.style.display='block';}
}

function estimateRevenue(patients){
  // Estimation CA par patient selon type de soin — actes_recurrents en priorité
  const RATES={injection:3.15*2,pansement:3.15*3,toilette:3.15*4,bsa:13,bsb:18.20,bsc:28.70,prelevement:3.15*1.5,perfusion:3.15*5,defaut:3.15*2};
  return patients.reduce((sum,p)=>{
    const d=(p.actes_recurrents||p.description||p.texte||p.summary||'').toLowerCase();
    let v=RATES.defaut;
    if(/toilette|bain/.test(d))v=RATES.toilette;
    else if(/perfusion/.test(d))v=RATES.perfusion;
    else if(/prél[eè]vement|prise de sang/.test(d))v=RATES.prelevement;
    else if(/pansement/.test(d))v=RATES.pansement;
    else if(/injection|insuline|piquer/.test(d))v=RATES.injection;
    // + IFD domicile
    if(/domicile/.test(d))v+=2.75;
    return sum+v;
  },0);
}

function showImportedPatients(){
  if(!APP.importedData){alert('Aucune donnée importée. Utilisez le Carnet patients ou l\'Import calendrier d\'abord.');return;}
  const patients=APP.importedData.patients||APP.importedData.entries||[];
  if(!patients.length){alert('Aucun patient dans les données importées.');return;}
  $('tbody').innerHTML=`<div class="card">
    <div class="ct">👥 Patients importés (${patients.length})</div>
    ${patients.map((p,i)=>{
      const _soinImp = (typeof _enrichSoinLabel === 'function')
        ? _enrichSoinLabel({
            actes_recurrents: p.actes_recurrents || '',
            pathologies:      p.pathologies || '',
            description:      p.description || p.texte || p.summary || '',
          }, 100)
        : (p.description || p.texte || p.summary || '');
      return `<div class="route-item"><div class="route-num">${i+1}</div><div class="route-info">
      <strong>${_soinImp || 'Patient '+(i+1)}</strong>
      <div style="font-size:11px;color:var(--m);margin-top:2px">${p.heure_soin||p.heure||''} ${p.patient_id?'· ID:'+p.patient_id:''}</div>
    </div></div>`;
    }).join('')}
  </div>`;
  $('res-tur').classList.add('show');
}

/* ══════════════════════════════════════════════════════
   PLANNING HEBDOMADAIRE — PERSISTANCE localStorage
   Clé isolée par utilisateur : ami_planning_<userId>
   Conserve les données entre sessions et imports
   ══════════════════════════════════════════════════════ */
function _planningKey() {
  // Priorité 1 : S en mémoire (déjà hydraté)
  let uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
  // Priorité 2 : sessionStorage clé 'ami' (celle utilisée par ss.save/load dans utils.js)
  if (!uid) {
    try {
      const sess = JSON.parse(sessionStorage.getItem('ami') || 'null');
      uid = sess?.user?.id || null;
    } catch {}
  }
  uid = uid || 'local';
  return 'ami_planning_' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _savePlanning(patients) {
  try {
    const key = _planningKey();
    // ⚡ Fixer la date d'assignation sur chaque patient qui n'en a pas encore
    // → sans ça, la date par défaut serait recalculée à chaque renderPlanning (= glissement quotidien)
    const todayFixed = new Date().toISOString().split('T')[0];
    const patientsWithDate = patients.map(p => {
      if (p.date || p.date_soin || p.date_prevue) return p;
      return { ...p, date: todayFixed, _dateFixed: true };
    });
    const data = { patients: patientsWithDate, savedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) { console.warn('[Planning] Save KO:', e.message); }
}

function _loadPlanning() {
  try {
    const key = _planningKey();
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // TTL 7 jours
    if (Date.now() - (data.savedAt || 0) > 7 * 24 * 3600 * 1000) {
      localStorage.removeItem(key);
      return null;
    }
    return Array.isArray(data.patients) ? data.patients : null;
  } catch { return null; }
}

function _clearPlanning() {
  try { localStorage.removeItem(_planningKey()); } catch {}
}

/* Sauvegarder le planning chaque fois que les données changent */
function _syncPlanningStorage() {
  // Source : _planningData en priorité (source de vérité pour renderPlanning)
  const patients = window.APP._planningData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  if (patients.length) {
    _savePlanning(patients);
    _syncPlanningToServer(patients).catch(() => {});
  }
}

/* ════════════════════════════════════════════════════════════════════════
   SYNC PLANNING HEBDOMADAIRE — navigateur ↔ mobile
   Blob AES-256 chiffré côté client — le worker stocke sans déchiffrer.
   Table weekly_planning : 1 ligne / infirmiere_id (upsert).
════════════════════════════════════════════════════════════════════════ */
async function _syncPlanningToServer(patients) {
  if (typeof S === 'undefined' || !S?.token) return;
  try {
    let encrypted_data;
    if (typeof _enc === 'function') {
      try { encrypted_data = _enc({ __weekly_planning: patients }); } catch { encrypted_data = JSON.stringify(patients); }
    } else {
      encrypted_data = JSON.stringify(patients);
    }
    await wpost('/webhook/planning-push', { encrypted_data, updated_at: new Date().toISOString() });
  } catch (e) { console.warn('[AMI] Planning push KO (silencieux):', e.message); }
}

// Flag positionné à true après un effacement volontaire — bloque la re-sync serveur
let _planningManuallyCleared = false;

async function _syncPlanningFromServer() {
  if (typeof S === 'undefined' || !S?.token) return;
  // Ne pas restaurer depuis le serveur si l'utilisateur vient d'effacer volontairement
  if (_planningManuallyCleared) return;
  try {
    const res = await wpost('/webhook/planning-pull', {});
    if (!res?.ok || !res.data?.encrypted_data) return;

    let remote = null;
    try {
      if (typeof _dec === 'function') {
        const d = _dec(res.data.encrypted_data);
        remote = d?.__weekly_planning || null;
      }
      if (!remote) remote = JSON.parse(res.data.encrypted_data);
    } catch {}
    if (!Array.isArray(remote) || !remote.length) return;

    // Utiliser les données distantes seulement si le local est vide
    // (la version locale fait foi si elle existe — évite d'écraser un travail en cours)
    const localSaved = _loadPlanning();
    if (!localSaved || !localSaved.length) {
      _savePlanning(remote);
      window.APP._planningData = { patients: remote, total: remote.length, source: 'planning_serveur' };
      _renderPlanningIfVisible();
      console.info('[AMI] Planning sync depuis serveur :', remote.length, 'patient(s)');
    } else {
      // Fusion : ajouter les entrées distantes absentes localement (par id)
      const localIds = new Set(localSaved.map(p => p.id || p.patient_id || ''));
      const toAdd = remote.filter(p => {
        const pid = p.id || p.patient_id || '';
        return pid && !localIds.has(pid);
      });
      if (toAdd.length) {
        const merged = [...localSaved, ...toAdd];
        _savePlanning(merged);
        window.APP._planningData = { patients: merged, total: merged.length, source: 'planning_fusionné' };
        _renderPlanningIfVisible();
        console.info('[AMI] Planning fusion :', toAdd.length, 'patient(s) ajouté(s) depuis le serveur');
      }
    }
  } catch (e) { console.warn('[AMI] Planning pull KO:', e.message); }
}

/* Écoute réactive : sauvegarde automatique quand APP.importedData change */
document.addEventListener('app:update', e => {
  if (e.detail.key !== 'importedData') return;
  const d = e.detail.value;
  if (d?.patients?.length || d?.entries?.length) {
    const pats = d.patients || d.entries;
    // Maintenir _planningData en sync avec importedData
    window.APP._planningData = { patients: pats, total: pats.length, source: 'import' };
    _savePlanning(pats);
  }
});

/* Restauration du planning au login (après hydratation de S = bonne clé userId) */
document.addEventListener('ami:login', () => {
  setTimeout(() => {
    _restorePlanningIfNeeded();
    // Sync depuis le serveur après restauration locale (navigateur ↔ mobile)
    setTimeout(() => _syncPlanningFromServer().catch(() => {}), 800);
  }, 200);
});

/* ⚡ Purge du state local au logout pour éviter les fuites de données cross-utilisateur.
   Sans ça, après logout Manon → login Bastien, les patients importés de Manon, les
   assignations IDE et le planning restaient en mémoire jusqu'au premier reload, créant
   l'impression que le cabinet ou la tournée n'avait pas changé. */
document.addEventListener('ami:logout', () => {
  try {
    window.APP._planningData = null;
    APP._ideAssignments = {};
    APP._constraintFirst = null;
    APP._constraintSecond = null;
    if (typeof APP.set === 'function') {
      APP.set('uberPatients', []);
      APP.set('nextPatient', null);
    }
    // Purger rendu DOM pour retirer visuellement les anciennes données
    const turCab = document.getElementById('tur-cabinet-result');
    if (turCab) turCab.innerHTML = '';
    const uberNext = document.getElementById('uber-next-patient');
    if (uberNext) uberNext.innerHTML = '<div style="color:var(--m);font-size:13px">Démarrez la journée pour charger vos patients.</div>';
    const banner = document.getElementById('pilotage-progress-banner');
    if (banner) banner.remove();
  } catch(e) {
    logWarn && logWarn('logout cleanup:', e.message);
  }
});

/* Restaurer APP.importedData depuis le planning sauvegardé si vide */
function _restorePlanningIfNeeded() {
  // Ne JAMAIS écrire dans APP.importedData depuis ici :
  // importedData = tournée du jour (vide au login).
  // Le planning hebdomadaire est stocké séparément dans APP._planningData.
  const saved = _loadPlanning();
  if (saved?.length) {
    window.APP._planningData = { patients: saved, total: saved.length, source: 'planning_sauvegardé' };
  }
  _renderPlanningIfVisible();
}

/* Rendre le planning uniquement si la vue pla est actuellement visible */
function _renderPlanningIfVisible() {
  const view = document.getElementById('view-pla');
  if (!view || !view.classList.contains('on')) return;
  const patients = window.APP._planningData?.patients
    || APP.importedData?.patients
    || APP.state?.importedData?.patients || [];
  if (!patients.length) return;
  renderPlanning({}).catch(() => {});
}

/* Actualiser le planning manuellement (bouton Actualiser dans view-pla) */
function refreshPlanning() {
  _planningInitCabinetUI(); // mettre à jour toggle cabinet
  _restorePlanningIfNeeded();
  const patients = window.APP._planningData?.patients
    || APP.importedData?.patients || APP.importedData?.entries
    || APP.state?.importedData?.patients || [];
  if (patients.length) {
    renderPlanning({}).catch(() => {});
  } else {
    const pbody = document.getElementById('pbody');
    if (pbody) pbody.innerHTML = '<div class="ai in" style="margin-top:12px">Aucune donnée disponible. Importez un planning depuis "Import calendrier" ou saisissez manuellement.</div>';
    const resPla = document.getElementById('res-pla');
    if (resPla) resPla.classList.add('show');
    if (typeof showToast === 'function') showToast('ℹ️ Aucune donnée à charger.', 'ok');
  }
}

/* ════════════════════════════════════════════════
   PLANNING HEBDOMADAIRE CABINET — variables d'état
════════════════════════════════════════════════ */
let _planningWeekOffset = 0; // 0 = semaine courante, -1 = précédente, +1 = suivante

// ⚡ Cabinet mode : TOUJOURS lire/écrire localStorage directement
// Élimine tout risque de variable JS stale entre renders async
function _getCabinetMode() {
  try { return localStorage.getItem('ami_planning_cabinet_mode') === '1'; } catch { return false; }
}
function _setCabinetMode(v) {
  try { localStorage.setItem('ami_planning_cabinet_mode', v ? '1' : '0'); } catch {}
}
// Compatibilité rétro — alias vers les fonctions (lecture seule désormais)
Object.defineProperty(window, '_planningCabinetMode', {
  get() { return _getCabinetMode(); },
  set(v) { _setCabinetMode(v); },
  configurable: true,
});

/** Naviguer d'une semaine en avant/arrière */
function planningWeekNav(delta) {
  _planningWeekOffset += delta;
  refreshPlanning();
}

/** Activer / désactiver la vue cabinet */
function planningToggleCabinetView(active) {
  _setCabinetMode(!!active);

  refreshPlanning();
}

/** Affiche ou masque le toggle cabinet selon APP.cabinet */
function _planningInitCabinetUI() {
  const wrap   = document.getElementById('pla-cabinet-toggle-wrap');
  const btnCab = document.getElementById('btn-pla-cabinet');
  const cab    = typeof APP !== 'undefined' && APP.get ? APP.get('cabinet') : null;
  const hasCab = !!(cab?.id);

  const _cabMode = _getCabinetMode();
  if (wrap) {
    if (hasCab || _cabMode) wrap.style.display = 'block';
    else wrap.style.display = 'none';
    const label = wrap.querySelector('label');
    if (label) { label.style.opacity = '1'; label.title = ''; }
    const cb = wrap.querySelector('input[type=checkbox]');
    if (cb) cb.disabled = false;
    // NE PAS toucher cb.checked par code
  }
  if (btnCab) btnCab.style.display = (hasCab || _cabMode) ? 'inline-flex' : 'none';

  if (!hasCab && !window._planningCabinetInitDone) {
    setTimeout(() => {
      const cabRetry = typeof APP !== 'undefined' && APP.get ? APP.get('cabinet') : null;
      if (cabRetry?.id) {
        _planningCabinetInitDone = true;
        _planningInitCabinetUI();
        if (_getCabinetMode()) renderPlanning({}).catch(() => {});
      }
    }, 1000);
  }
}

let _planningCabinetInitDone = false;
/** Réagir aux changements de cabinet */
if (typeof APP !== 'undefined' && APP.on) {
  APP.on('cabinet', () => { _planningCabinetInitDone = true; _planningInitCabinetUI(); });
}
window._planningInitCabinetUI = _planningInitCabinetUI;

/** Génère et affiche un planning multi-IDE depuis les patients importés */
async function planningGenerateCabinet() {
  const patients = window.APP._planningData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries || [];
  if (!patients.length) {
    if (typeof showToast === 'function') showToast('Aucun patient à répartir.', 'wa');
    return;
  }
  const cab = APP.get ? APP.get('cabinet') : null;
  if (!cab?.id) {
    if (typeof showToast === 'function') showToast('Vous n\'êtes pas dans un cabinet.', 'wa');
    return;
  }
  // Activer automatiquement le mode cabinet et re-rendre
  _setCabinetMode(true);
  const cb = document.getElementById('pla-cabinet-mode');
  if (cb) cb.checked = true;
  renderPlanning({}).catch(() => {});
}

async function generatePlanningFromImport(){
  if(!APP.importedData){alert('Aucune donnée importée. Utilisez le Carnet patients ou l\'Import calendrier.');return;}
  const patients=APP.importedData.patients||APP.importedData.entries||[];
  if(!patients.length){alert('Aucun patient dans les données importées.');return;}
  // Construire un texte structuré depuis l'import
  const txt=patients.map((p,i)=>{
    // ⚡ Enrichir avant envoi IA — "Diabète" seul ne génère pas d'actes NGAP.
    // Avec l'enrichissement, l'IA reçoit "Injection insuline SC, surveillance
    // glycémie capillaire, éducation thérapeutique" et peut coter correctement.
    const desc = (typeof _enrichSoinLabel === 'function')
      ? _enrichSoinLabel({
          actes_recurrents: p.actes_recurrents || '',
          pathologies:      p.pathologies || '',
          description:      p.description || p.texte || p.summary || '',
        }, 180)
      : (p.description||p.texte||p.summary||'Soin infirmier');
    const freq=p.frequence||p.recurrence||'quotidien';
    return `Patient P${i+1} : ${desc||'Soin infirmier'} (${freq})`;
  }).join('\n');
  $('pl-txt').value=txt;
  ld('btn-pla',true);
  $('res-pla').classList.remove('show');
  try{
    const d=await apiCall('/webhook/ami-calcul',{mode:'planning',texte:txt});
    renderPlanning(d).catch(()=>{});
    $('perr').style.display='none';
  }catch(e){$('perr').style.display='flex';$('perr-m').textContent=e.message;}
  $('res-pla').classList.add('show');
  ld('btn-pla',false);
}

/* ════════════════════════════════════════════════
   GUARD CABINET — source de vérité centralisée
════════════════════════════════════════════════ */
function _getCabinetReadyState() {
  const cab = APP.get ? APP.get('cabinet') : null;
  return {
    exists:     !!(cab?.id),
    hasMembers: !!(cab?.members && cab.members.length),
    ready:      !!(cab?.id && cab?.members && cab.members.length),
    members:    cab?.members || [],
    cab,
  };
}

async function renderPlanning(d){
  // ── Initialiser UI cabinet ──────────────────────────────────────────────
  _planningInitCabinetUI();

  // ── Patients source ─────────────────────────────────────────────────────
  const rawPatients = window.APP._planningData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  const ca = rawPatients.length ? estimateRevenue(rawPatients) : null;

  // ── Calcul des dates de la semaine affichée ──────────────────────────────
  const today      = new Date();
  const dayOfWeek  = today.getDay(); // 0=dim, 1=lun…
  const mondayThis = new Date(today);
  mondayThis.setDate(today.getDate() - ((dayOfWeek + 6) % 7) + _planningWeekOffset * 7);
  mondayThis.setHours(0, 0, 0, 0);
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d2 = new Date(mondayThis);
    d2.setDate(mondayThis.getDate() + i);
    return d2;
  });

  // Mettre à jour le label de semaine
  const labelEl = document.getElementById('pla-week-label');
  if (labelEl) {
    if (_planningWeekOffset === 0) {
      labelEl.textContent = 'Cette semaine';
    } else if (_planningWeekOffset === 1) {
      labelEl.textContent = 'Semaine prochaine';
    } else if (_planningWeekOffset === -1) {
      labelEl.textContent = 'Semaine dernière';
    } else {
      const d1s = weekDates[0].toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
      const d7s = weekDates[6].toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
      labelEl.textContent = `${d1s} – ${d7s}`;
    }
  }

  // ⚡ Date locale (pas UTC) — évite le décalage timezone (ex: lundi 23h FR = mardi UTC)
  const todayISO = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');

  // ── Enrichir depuis le carnet patient (IDB) par patient_id ──────────────
  let carnetIndex = {};
  try {
    if (typeof _idbGetAll === 'function') {
      const rows = await _idbGetAll(PATIENTS_STORE);
      rows.forEach(r => {
        const decoded = (typeof _dec === 'function') ? (_dec(r._data) || {}) : {};
        carnetIndex[r.id] = { nom: r.nom || '', prenom: r.prenom || '', ...decoded };
      });
    }
  } catch(e) { console.warn('[Planning] IDB KO:', e.message); }

  // ── Enrichir depuis uberPatients ─────────────────────────────────────────
  const uberIndex = {};
  (APP.get('uberPatients') || []).forEach(p => {
    const k = p.patient_id || p.id;
    if (k) uberIndex[k] = p;
  });

  // ── Construire la liste enrichie ──────────────────────────────────────────
  const patients = rawPatients.map((p, idx) => {
    const pid   = p.patient_id || p.id || '';
    const fiche = carnetIndex[pid] || {};
    const uber  = uberIndex[pid]   || {};

    const nomFiche  = [fiche.prenom, fiche.nom].filter(Boolean).join(' ').trim();
    const nomDirect = [p.prenom, p.nom].filter(Boolean).join(' ').trim();
    const nomUber   = [uber.prenom, uber.nom].filter(Boolean).join(' ').trim();
    let nom = nomFiche || nomDirect || nomUber;

    if (!nom) {
      const raw = (p.description || p.texte || '').trim();
      const sep = raw.match(/^([^—\-:]+?)(?:\s*[—\-:]\s*|\s+(?:injection|pansement|toilette|prélèvement|perfusion|insuline|soin\s|bilan|visite|acte\s))/i);
      if (sep && sep[1].trim().length > 1) {
        nom = sep[1].trim();
      } else {
        const nameW = [];
        for (const w of raw.split(/\s+/).slice(0, 4)) {
          if (/^[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜÇ]/.test(w)) nameW.push(w); else break;
        }
        nom = nameW.length >= 2 ? nameW.join(' ') : '';
      }
    }

    // ⚡ La date est fixée au moment de la sauvegarde (_savePlanning).
    // Ne jamais substituer todayISO ici : sinon le patient glisse chaque jour.
    const date = p.date || p.date_soin || p.date_prevue || null;

    return {
      ...p,
      nom:              (fiche.nom    || p.nom    || uber.nom    || '').trim(),
      prenom:           (fiche.prenom || p.prenom || uber.prenom || '').trim(),
      _nomAff:          nom || 'Patient',
      date,
      actes_recurrents: fiche.actes_recurrents || p.actes_recurrents || '',
      _cotation:        p._cotation || uber._cotation,
      done:             p.done   || p._done   || uber.done   || false,
      absent:           p.absent || p._absent || uber.absent || false,
      _planIdx:         idx,
    };
  });

  // ── Filtrer par semaine affichée ──────────────────────────────────────────
  const weekStart = weekDates[0];
  const weekEnd   = weekDates[6];
  const patientsThisWeek = patients.filter(p => {
    // ⚡ Si pas de date fixée → inclure dans la semaine courante uniquement
    if (!p.date) return _planningWeekOffset === 0;
    try {
      const pd = new Date(p.date);
      if (isNaN(pd)) return _planningWeekOffset === 0;
      return pd >= weekStart && pd <= weekEnd;
    } catch { return true; }
  });
  // Si la semaine filtrée est vide et qu'on est sur la semaine courante → afficher tous
  const patientsToShow = (patientsThisWeek.length === 0 && _planningWeekOffset === 0)
    ? patients
    : patientsThisWeek;

  // ── Distribution par jour de la semaine ──────────────────────────────────
  const JOURS = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
  const byDay = {};
  JOURS.forEach((j, i) => { byDay[j] = { label: j, date: weekDates[i], patients: [] }; });

  // ⚡ Distribution STRICTE par date explicite : un patient n'apparaît QUE
  //    le jour où il a été explicitement planifié (via sa date).
  //    Plus de fallback hash qui faisait "glisser" les patients d'un jour à l'autre.
  //    Si pas de date valide ET pas de jour dans la description → zone "non_planifies".
  const nonPlanifies = [];
  patientsToShow.forEach((p) => {
    let jourKey = null;
    // 1) Priorité absolue : la date du patient doit tomber dans la semaine affichée
    try {
      const pd = new Date(p.date);
      if (!isNaN(pd)) {
        // Vérifier que la date appartient bien à la semaine affichée (évite les leftovers
        // d'une autre semaine qui se retrouveraient collés sur un jour au hasard)
        const pdKey = pd.toISOString().slice(0, 10);
        const matchIdx = weekDates.findIndex(d => d === pdKey);
        if (matchIdx >= 0) {
          jourKey = JOURS[matchIdx];
        }
      }
    } catch {}
    // 2) Fallback : mot-clé jour explicite dans la description ("mardi matin")
    //    → uniquement si on est sur la semaine courante (sinon risque de mauvaise assignation)
    if (!jourKey && _planningWeekOffset === 0) {
      const desc = (p.description || p.texte || '').toLowerCase();
      jourKey = JOURS.find(j => new RegExp(`\\b${j}\\b`).test(desc)) || null;
    }
    // 3) Sinon → zone "non planifiés" (visible mais hors des jours)
    if (!jourKey) {
      nonPlanifies.push(p);
      return;
    }
    byDay[jourKey].patients.push(p);
  });
  // Exposer les non-planifiés pour le rendu
  byDay._nonPlanifies = nonPlanifies;

  // ── Cabinet : calcul répartition multi-IDE ───────────────────────────────
  const cab = APP.get ? APP.get('cabinet') : null;

  // ⚡ Lecture DIRECTE localStorage — source de vérité absolue, zéro variable stale
  const cabinetActive = _getCabinetMode();
  if (cabinetActive && !cab?.id) {
    // Cabinet pas encore chargé → retry silencieux
    setTimeout(() => {
      const cabRetry = APP.get ? APP.get('cabinet') : null;
      if (cabRetry?.id) renderPlanning({}).catch(() => {});
    }, 800);
  }
  // patientsForCabinet déclaré ici (scope renderPlanning) → accessible dans renderCabinetView()
  const patientsForCabinet = patients.length ? patients : patientsToShow;
  let cabinetAssignments = {};

  if (cabinetActive) {
    const cabNow = APP.get ? APP.get('cabinet') : null;
    const cabMembers = cabNow?.members?.length ? cabNow.members : null;

    // ⚡ Pas de early return — renderCabinetView() gère l'état "membres pas encore chargés"
    // Si membres pas disponibles → retry dans 600ms, cabinetAssignments reste vide → spinner
    if (!cabMembers) {
      setTimeout(() => renderPlanning({}).catch(() => {}), 600);
      // cabinetAssignments reste {} → renderCabinetView affichera le spinner
    } else {
      // ✅ Membres disponibles → distribuer les patients
      const effectiveMembers = cabMembers;
    const COLORS = ['#00d4aa','#4fa8ff','#ff9f43','#ff6b6b','#a29bfe'];
    effectiveMembers.forEach((m, i) => {
      const ideId = m.id || m.infirmiere_id || `ide_${i}`;
      cabinetAssignments[ideId] = {
        nom:      m.nom    || '',
        prenom:   m.prenom || `IDE ${i+1}`,
        role:     m.role   || 'membre',
        patients: [],
        color:    COLORS[i % 5],
      };
    });
      // Helper : récupère la liste des IDEs assignés manuellement à un patient
      // (rétrocompat : _assignedIde singleton → converti en liste)
      const _getAssignedIdes = (p) => {
        if (Array.isArray(p._assignedIdes) && p._assignedIdes.length) return p._assignedIdes;
        if (p._assignedIde) return [p._assignedIde];
        return [];
      };

      // Patients avec au moins une assignation manuelle valide
      const patsWithManual = patientsForCabinet.filter(p => {
        const ides = _getAssignedIdes(p);
        return ides.some(id => cabinetAssignments[id]);
      });
      // Patients sans assignation → clustering auto
      const patsNeedsClustering = patientsForCabinet.filter(p => {
        const ides = _getAssignedIdes(p);
        return !ides.some(id => cabinetAssignments[id]);
      });

      // Distribuer les patients manuels : un patient peut apparaître dans PLUSIEURS IDEs
      patsWithManual.forEach(p => {
        _getAssignedIdes(p).forEach(ideId => {
          if (cabinetAssignments[ideId]) cabinetAssignments[ideId].patients.push(p);
        });
      });

      if (patsNeedsClustering.length && typeof cabinetGeoCluster === 'function') {
        const clusters = cabinetGeoCluster(patsNeedsClustering, effectiveMembers.length);
        effectiveMembers.forEach((m, i) => {
          const ideId = m.id || m.infirmiere_id || `ide_${i}`;
          (clusters[i] || []).forEach(p => cabinetAssignments[ideId].patients.push(p));
        });
      } else if (patsNeedsClustering.length) {
        patsNeedsClustering.forEach((p, i) => {
          const ideId = Object.keys(cabinetAssignments)[i % effectiveMembers.length];
          if (cabinetAssignments[ideId]) cabinetAssignments[ideId].patients.push(p);
        });
      }
    } // fin else (membres chargés)
  } // fin if (cabinetActive)

  // ── KPIs semaine ─────────────────────────────────────────────────────────
  const totalCot = patientsToShow.reduce((s, p) => s + (p._cotation?.validated ? (p._cotation.total||0) : 0), 0);
  const nbCot    = patientsToShow.filter(p => p._cotation?.validated).length;
  const caWeek   = ca ? ca * (patientsToShow.length / Math.max(patients.length, 1)) : null;

  // ── Rendu carte patient (solo) ────────────────────────────────────────────
  function renderPatientCard(p, ideColor) {
    const nom     = p._nomAff || [p.prenom, p.nom].filter(Boolean).join(' ') || 'Patient';
    const date    = p.date || todayISO;
    let dateAff   = '';
    try {
      const d2 = new Date(date);
      if (!isNaN(d2)) dateAff = d2.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
    } catch {}
    const heure   = p.heure_soin || p.heure_preferee || p.heure || '';
    const actes   = (p.actes_recurrents || '').trim();
    // ⚡ Utiliser _enrichSoinLabel pour que "Diabète" ou "HTA" bruts soient
    // convertis en description détaillée d'actes NGAP ("Injection insuline SC,
    // surveillance glycémie capillaire, éducation thérapeutique"). Sinon le
    // Planning hebdo affichait juste "Diabète" alors que la cotation et
    // l'Historique montraient le détail — incohérence visuelle.
    let soin = (typeof _enrichSoinLabel === 'function')
      ? _enrichSoinLabel({
          actes_recurrents: p.actes_recurrents || '',
          pathologies:      p.pathologies || '',
          description:      p.description || p.texte || '',
        }, 120)
      : (actes || (p.description || p.texte || '').trim());
    if (!actes && nom !== 'Patient' && soin.toLowerCase().startsWith(nom.toLowerCase())) {
      soin = soin.slice(nom.length).replace(/^\s*[—\-:]\s*/, '').trim();
    }
    soin = soin.slice(0, 80);
    const cot     = p._cotation?.validated;
    const idx     = p._planIdx;
    const borderL = ideColor ? `border-left:3px solid ${ideColor};` : '';

    return `<div style="background:var(--c);border:1px solid var(--b);border-radius:10px;padding:10px 12px;margin-bottom:8px;overflow:hidden;${borderL}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:4px;flex-wrap:wrap">
        <div style="font-size:13px;font-weight:600;color:var(--t);overflow-wrap:anywhere;word-break:break-word;flex:1;min-width:100px">${nom}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0">
          <span style="font-size:10px;font-family:var(--fm);background:rgba(79,168,255,.1);color:var(--a2);border:1px solid rgba(79,168,255,.2);padding:1px 7px;border-radius:20px;white-space:nowrap">${dateAff}</span>
          ${heure ? `<span style="font-size:10px;font-family:var(--fm);background:rgba(255,181,71,.08);color:var(--w);border:1px solid rgba(255,181,71,.2);padding:1px 7px;border-radius:20px;white-space:nowrap">⏰ ${heure}</span>` : ''}
          ${p.done ? `<span style="font-size:9px;background:rgba(0,212,170,.1);color:var(--a);border-radius:20px;padding:1px 6px">✅</span>` : ''}
        </div>
      </div>
      ${soin ? `<div style="font-size:11px;color:${actes ? 'var(--a)' : 'var(--m)'};margin-bottom:6px;line-height:1.4">${actes ? '💊 ' : ''}${soin}</div>` : ''}
      ${cot  ? (() => {
        // ⚡ Bloc enrichi : Date+Heure + N° Facture + ID — facilite le rapprochement
        // avec l'Historique des soins pour repérer/auditer les doublons éventuels.
        const _invNumP = p._cotation.invoice_number || null;
        const _heureP  = p._cotation._heure_reelle || p._cotation.heure || null;
        const _dateP   = p._cotation._tournee_date || (typeof _localDateStr === 'function' ? _localDateStr() : new Date().toISOString().slice(0,10));
        let _dateAffP = _dateP;
        try { _dateAffP = new Date(_dateP + 'T00:00:00').toLocaleDateString('fr-FR',{weekday:'short',day:'2-digit',month:'2-digit'}); } catch {}
        const _pidP    = p.patient_id || p.id || '—';
        const _syncIco = p._cotation._synced ? '☁️✓' : '☁️…';
        return `<div style="background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.15);border-radius:6px;padding:6px 8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--a);font-family:var(--fm);font-weight:600;margin-bottom:3px">
            ✅ Cotation : ${parseFloat(p._cotation.total||0).toFixed(2)} € ${_syncIco}
          </div>
          <div style="font-size:9px;color:var(--m);font-family:var(--fm);line-height:1.5">
            ${_dateAffP}${_heureP ? ' · ' + _heureP : ''}<br>
            ${_invNumP ? `N° <span style="color:var(--a)">${_invNumP}</span>` : '<span style="color:#f59e0b">N° en attente</span>'}
            <span style="opacity:.6"> · ID #${String(_pidP).slice(-6)}</span>
          </div>
        </div>`;
      })() : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">

        <button onclick="_planningRemovePatient(${idx})" style="font-size:10px;font-family:var(--fm);padding:3px 9px;border-radius:20px;border:1px solid var(--b);background:none;color:var(--m);cursor:pointer">✕</button>
      </div>
    </div>`;
  }

  // ── Rendu vue CABINET (colonnes par IDE + CA estimé + sélecteur IDE) ────────
  function renderCabinetView() {
    const ideList = Object.entries(cabinetAssignments);

    // ⚡ Pas de membres → cabinet en cours de chargement (initCabinet async)
    if (!ideList.length) {
      setTimeout(() => {
        const cabNow = APP.get ? APP.get('cabinet') : null;
        if (cabNow?.members?.length) renderPlanning({}).catch(() => {});
      }, 900);
      return `<div style="text-align:center;padding:32px 16px">
        <div class="spin spinw" style="width:24px;height:24px;margin:0 auto 10px"></div>
        <div style="font-size:13px;color:var(--m)">Chargement des membres du cabinet…</div>
        <div style="font-size:11px;color:var(--m);margin-top:6px">Si le problème persiste, cliquez sur ↻ Actualiser</div>
      </div>`;
    }

    // ── CA validé + CA estimé par IDE ─────────────────────────────────────
    // Par IDE : compte le CA complet de chaque patient qui lui est assigné (un IDE "voit" tout le CA de ses patients)
    // Total global : dédupliqué par patient pour éviter de compter 2 fois un patient assigné à 2 IDEs
    const caValByIde = {}, caEstByIde = {};
    ideList.forEach(([ideId, a]) => {
      caValByIde[ideId] = a.patients.reduce((s, p) =>
        s + (p._cotation?.validated ? parseFloat(p._cotation.total||0) : 0), 0);
      caEstByIde[ideId] = typeof estimateRevenue === 'function'
        ? estimateRevenue(a.patients) : a.patients.length * 6.30;
    });
    // Total dédupliqué : chaque patient compté une seule fois (clé patient_id ou _planIdx)
    const _seenPat = new Set();
    let caValTotal = 0, caEstTotal = 0;
    ideList.forEach(([_, a]) => {
      (a.patients || []).forEach(p => {
        const key = p.patient_id || p.id || `_idx_${p._planIdx}`;
        if (_seenPat.has(key)) return;
        _seenPat.add(key);
        if (p._cotation?.validated) caValTotal += parseFloat(p._cotation.total||0);
        caEstTotal += (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 6.30);
      });
    });

    // ── Sélecteur multi-IDE (cases à cocher) — un patient peut être assigné à plusieurs IDEs ─
    // Affiché dans chaque carte patient de la vue cabinet : permet de cocher/décocher
    // les IDEs qui réalisent l'acte. Le patient apparaît dans toutes les colonnes cochées.
    function ideSelectHtml(p, currentIdeId) {
      const safeIdx = p._planIdx ?? -1;
      // Récupère la liste des IDEs assignés (rétrocompat _assignedIde unique)
      const assigned = Array.isArray(p._assignedIdes)
        ? p._assignedIdes.slice()
        : (p._assignedIde ? [p._assignedIde] : []);
      // Si vide → le patient est dans l'IDE courant (clustering auto)
      if (!assigned.length && currentIdeId) assigned.push(currentIdeId);

      return `<details style="margin-top:4px;font-family:var(--fm)">
        <summary style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--b);
          background:var(--s);color:var(--t);cursor:pointer;user-select:none;display:inline-flex;
          align-items:center;gap:4px;list-style:none;max-width:140px">
          <span style="color:var(--a)">👥</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">
            ${assigned.length} IDE${assigned.length > 1 ? 's' : ''}
          </span>
          <span style="color:var(--m)">▾</span>
        </summary>
        <div style="position:absolute;z-index:100;background:var(--c);border:1px solid var(--b);
          border-radius:8px;padding:6px;margin-top:2px;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,.3)">
          ${ideList.map(([id, a]) => {
            const chk   = assigned.includes(id);
            const label = `${a.prenom} ${a.nom}`.trim() || id;
            const safeId = id.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
            return `<label style="display:flex;align-items:center;gap:6px;padding:4px 6px;
              border-radius:5px;cursor:pointer;font-size:11px;color:var(--t);
              background:${chk?'rgba(0,212,170,.08)':'transparent'};
              transition:background .1s">
              <input type="checkbox" ${chk?'checked':''}
                onchange="window._planningToggleIDE('${safeId}', ${safeIdx}, this.checked)"
                onclick="event.stopPropagation()"
                style="accent-color:var(--a);width:12px;height:12px;flex-shrink:0">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
            </label>`;
          }).join('')}
        </div>
      </details>`;
    }

    // ── Carte patient compacte pour la grille cabinet ─────────────────────
    function patCardCab(p, ideId, color) {
      const nom   = p._nomAff || [p.prenom, p.nom].filter(Boolean).join(' ') || 'Patient';
      const soin  = ((typeof _enrichSoinLabel === 'function')
        ? _enrichSoinLabel({
            actes_recurrents: p.actes_recurrents || '',
            pathologies:      p.pathologies || '',
            description:      p.description || p.texte || '',
          }, 55)
        : (p.actes_recurrents || p.description || p.texte || '')
      ).slice(0, 55);
      const heure = p.heure_soin || p.heure_preferee || p.heure || '';
      const cot   = p._cotation?.validated;
      const caEst = typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 6.30;
      return `<div style="background:var(--c);border:1px solid var(--b);border-left:3px solid ${color};
                          border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="font-size:12px;font-weight:600;color:var(--t);margin-bottom:2px">${nom}</div>
        ${heure ? `<div style="font-size:10px;color:var(--w);font-family:var(--fm)">⏰ ${heure}</div>` : ''}
        ${soin  ? `<div style="font-size:10px;color:var(--m);margin:2px 0;line-height:1.3">${soin}</div>` : ''}
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;margin-top:4px">
          <span style="font-size:10px;font-family:var(--fm);font-weight:600;color:${cot ? 'var(--a)' : color}">
            💶 ${cot ? parseFloat(p._cotation.total).toFixed(2) : '~' + caEst.toFixed(2)} €
          </span>
          ${ideSelectHtml(p, ideId)}
        </div>
      </div>`;
    }

    // ── Résoudre le jour d'un patient ─────────────────────────────────────
    function resolveJour(p) {
      if (p.date) {
        try {
          const pd = new Date(p.date);
          if (!isNaN(pd)) {
            const nj = pd.toLocaleDateString('fr-FR', { weekday:'long' }).toLowerCase();
            return JOURS.find(jj => nj.startsWith(jj)) || null;
          }
        } catch {}
      }
      const desc = (p.description || p.texte || '').toLowerCase();
      const fromDesc = JOURS.find(jj => new RegExp('\\b' + jj + '\\b').test(desc));
      if (fromDesc) return fromDesc;
      // FIX : plus de fallback hash — un patient sans date explicite ni mot-clé jour
      //       ne doit PAS apparaître sur un jour au hasard (bug "patients qui glissent").
      return null;
    }

    // ── Layout : bandeau IDEs en haut (flex wrap) + liste jours en dessous ──
    // Scalable : fonctionne avec 2 comme avec 10 IDEs sans casser la mise en page

    // Bandeau IDEs — cartes horizontales avec wrap automatique
    const ideCards = ideList.map(([ideId, a]) => {
      const caV   = caValByIde[ideId] || 0;
      const caE   = caEstByIde[ideId] || 0;
      const shown = caV > 0 ? caV : caE;
      const isVal = caV > 0;
      return `<div style="flex:1;min-width:160px;max-width:280px;padding:12px 14px;
                          background:${a.color}10;border:1px solid ${a.color}30;
                          border-top:3px solid ${a.color};border-radius:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="width:28px;height:28px;border-radius:50%;background:${a.color}20;
                      display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">
            ${a.role === 'titulaire' ? '👑' : '👤'}
          </div>
          <div>
            <div style="font-weight:700;font-size:13px;color:var(--t)">${a.prenom} ${a.nom}</div>
            <div style="font-size:10px;color:var(--m);font-family:var(--fm)">${a.patients.length} patient(s)</div>
          </div>
        </div>
        <div style="font-size:14px;font-weight:700;color:${a.color};font-family:var(--fm)">
          💶 ${shown.toFixed(2)} €
          <span style="font-size:9px;font-weight:400;opacity:.7">${isVal ? 'validé' : 'estimé'}</span>
        </div>
      </div>`;
    }).join('');

    // Lignes de jours — colonne Jour + patients de TOUS les IDEs avec badge couleur IDE
    const dayRows = JOURS.map((j, ji) => {
      const dateJ  = weekDates[ji];
      const _y = dateJ.getFullYear(), _m = String(dateJ.getMonth()+1).padStart(2,'0'), _d = String(dateJ.getDate()).padStart(2,'0');
      const isToday = `${_y}-${_m}-${_d}` === todayISO;
      const dateStr = dateJ.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
      const jourCap = j.charAt(0).toUpperCase() + j.slice(1);

      // Tous les patients de ce jour, tous IDEs confondus — avec couleur IDE
      const allDayPats = [];
      ideList.forEach(([ideId, a]) => {
        a.patients.filter(p => resolveJour(p) === j).forEach(p => {
          allDayPats.push({ p, ideId, color: a.color, prenom: a.prenom });
        });
      });

      const patsHtml = allDayPats.length
        ? allDayPats.map(({ p, ideId, color, prenom }) => {
            const nom   = p._nomAff || [p.prenom, p.nom].filter(Boolean).join(' ') || 'Patient';
            const soin  = ((typeof _enrichSoinLabel === 'function')
              ? _enrichSoinLabel({
                  actes_recurrents: p.actes_recurrents || '',
                  pathologies:      p.pathologies || '',
                  description:      p.description || p.texte || '',
                }, 60)
              : (p.actes_recurrents || p.description || p.texte || '')
            ).slice(0, 60);
            const heure = p.heure_soin || p.heure_preferee || p.heure || '';
            const cot   = p._cotation?.validated;
            const caEst = typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 6.30;
            return `<div style="background:var(--c);border:1px solid var(--b);border-left:3px solid ${color};
                                border-radius:8px;padding:8px 10px;margin-bottom:6px;display:flex;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;color:var(--t)">${nom}</div>
                ${heure ? `<div style="font-size:10px;color:var(--w);font-family:var(--fm)">⏰ ${heure}</div>` : ''}
                ${soin  ? `<div style="font-size:10px;color:var(--m);margin-top:2px">${soin}</div>` : ''}
                <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
                  <span style="font-size:10px;font-family:var(--fm);font-weight:600;color:${cot ? 'var(--a)' : color}">
                    💶 ${cot ? parseFloat(p._cotation.total).toFixed(2) : '~' + caEst.toFixed(2)} €
                  </span>
                  ${ideSelectHtml(p, ideId)}
                </div>
              </div>
              <div style="flex-shrink:0;font-size:10px;font-family:var(--fm);color:${color};
                          background:${color}15;padding:2px 7px;border-radius:20px;border:1px solid ${color}30;
                          white-space:nowrap;margin-top:2px">${prenom}</div>
            </div>`;
          }).join('')
        : `<div style="font-size:11px;color:var(--b);padding:12px 0;text-align:center">—</div>`;

      return `<div style="display:grid;grid-template-columns:72px 1fr;border-bottom:1px solid var(--b)${isToday ? ';background:rgba(0,212,170,.025)' : ''}">
        <div style="padding:8px 6px;border-right:1px solid var(--b);display:flex;flex-direction:column;justify-content:center;gap:2px">
          <div style="font-size:11px;font-weight:${isToday ? '700' : '600'};color:${isToday ? 'var(--a)' : 'var(--t)'}">${jourCap}</div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm)">${dateStr}</div>
          ${isToday ? '<div style="font-size:9px;color:var(--a);font-family:var(--fm)">Auj.</div>' : ''}
          ${allDayPats.length ? `<div style="font-size:9px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);padding:1px 5px;border-radius:10px;text-align:center;margin-top:2px">${allDayPats.length}</div>` : ''}
        </div>
        <div style="padding:8px">${patsHtml}</div>
      </div>`;
    }).join('');

    return `
      <!-- Bandeau IDEs — flex wrap, scalable -->
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        ${ideCards}
      </div>
      <!-- Grille jours — 1 colonne, patients avec badge IDE coloré -->
      <div style="border:1px solid var(--b);border-radius:10px;overflow:hidden">
        ${dayRows}
      </div>
      <!-- Barre CA cabinet -->
      <div style="margin-top:12px;padding:12px 16px;background:rgba(0,212,170,.07);border:1px solid rgba(0,212,170,.2);border-radius:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        <div style="flex:1;min-width:140px">
          <div style="font-size:10px;color:var(--m);font-family:var(--fm);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">CA ESTIMÉ SEMAINE · CABINET</div>
          <div style="font-size:20px;font-weight:700;color:var(--a)">${(caValTotal > 0 ? caValTotal : caEstTotal).toFixed(2)} €</div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-top:2px">${caValTotal > 0 ? 'cotations validées' : 'estimation NGAP'} · ${patientsForCabinet.length} patient(s)</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${ideList.map(([ideId, a]) => {
            const shown = (caValByIde[ideId]||0) > 0 ? caValByIde[ideId] : caEstByIde[ideId]||0;
            return `<div style="padding:6px 12px;background:${a.color}12;border:1px solid ${a.color}30;border-radius:8px;text-align:center;min-width:72px">
              <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-bottom:1px">${a.prenom}</div>
              <div style="font-size:13px;font-weight:700;color:${a.color}">${shown.toFixed(2)} €</div>
              <div style="font-size:9px;color:var(--m);font-family:var(--fm)">${a.patients.length} pat.</div>
            </div>`;
          }).join('')}
        </div>
        <button onclick="planningOptimiseCabinetWeek()" class="btn bs bsm" style="font-size:11px;white-space:nowrap">⚡ Optimiser</button>
      </div>
    `;
  }

  // ── Rendu vue SOLO — disposition verticale identique à la vue cabinet ────
  // Lignes = jours (lundi → dimanche), colonne label 80px + colonne contenu
  function renderSoloView() {

    // En-tête : même structure que cabinet — "Jour" + colonne "Mes patients"
    const totalPatients = patientsToShow.length;
    const totalCotVal   = patientsToShow.filter(p => p._cotation?.validated).length;
    const header = `
      <div style="display:grid;grid-template-columns:80px 1fr;border-radius:8px 8px 0 0;overflow:hidden">
        <div style="padding:8px;background:var(--s);border:1px solid var(--b);border-radius:8px 0 0 0;display:flex;align-items:center;justify-content:center">
          <span style="font-size:11px;color:var(--m);font-family:var(--fm);text-align:center">Jour</span>
        </div>
        <div style="padding:8px 12px;background:rgba(0,212,170,.06);border-top:3px solid var(--a);border:1px solid var(--b);border-left:none;display:flex;align-items:center;gap:10px">
          <div style="font-weight:700;font-size:13px;color:var(--a)">Planning de la semaine</div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-left:auto">
            ${totalPatients} patient${totalPatients > 1 ? 's' : ''}
            ${totalCotVal > 0 ? ` · ${totalCotVal} coté${totalCotVal > 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </div>`;

    // Lignes jours — même structure exacte que renderCabinetView dayRows
    const dayRows = JOURS.map((j, ji) => {
      const dateJ   = weekDates[ji];
      // ⚡ Comparaison en heure locale (pas UTC) — évite le décalage timezone
      const _djY2 = dateJ.getFullYear(), _djM2 = String(dateJ.getMonth()+1).padStart(2,'0'), _djD2 = String(dateJ.getDate()).padStart(2,'0');
      const isToday = `${_djY2}-${_djM2}-${_djD2}` === todayISO;
      const dateStr = dateJ.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
      const jourCap = j.charAt(0).toUpperCase() + j.slice(1);
      const pDay    = byDay[j].patients;

      return `<div style="display:grid;grid-template-columns:80px 1fr;border-bottom:1px solid var(--b)${isToday ? ';background:rgba(0,212,170,.025)' : ''}">
        <div style="padding:8px;border-right:1px solid var(--b);display:flex;flex-direction:column;justify-content:center;flex-shrink:0">
          <div style="font-size:12px;font-weight:${isToday ? '700' : '600'};color:${isToday ? 'var(--a)' : 'var(--t)'}">${jourCap}</div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm)">${dateStr}</div>
          ${isToday ? '<div style="font-size:9px;color:var(--a);font-family:var(--fm)">Aujourd\'hui</div>' : ''}
          ${pDay.length ? `<div style="font-size:9px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);padding:1px 6px;border-radius:10px;display:inline-block;margin-top:4px;text-align:center">${pDay.length}</div>` : ''}
          ${pDay.length ? `<button onclick="planningImportDayToTour('${j}', '${_djY2}-${_djM2}-${_djD2}')" title="Importer les ${pDay.length} patient(s) de ${jourCap} dans la Tournée IA" style="margin-top:6px;padding:4px 6px;font-size:10px;font-family:var(--fm);background:linear-gradient(135deg,var(--a),#10b981);border:none;color:#fff;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:3px;justify-content:center">⚡<span style="font-size:9px">Tournée IA</span></button>` : ''}
        </div>
        <div style="padding:6px 8px;min-height:44px">
          ${pDay.length
            ? pDay.map(p => renderPatientCard(p, isToday ? 'var(--a)' : null)).join('')
            : `<div style="font-size:11px;color:var(--b);padding:12px 0;text-align:center">—</div>`}
        </div>
      </div>`;
    }).join('');

    // Total cotations semaine
    const totalCot = patientsToShow.reduce((s, p) => s + (p._cotation?.validated ? (p._cotation.total||0) : 0), 0);

    return `
      ${header}
      <div style="border:1px solid var(--b);border-top:none;border-radius:0 0 8px 8px;overflow:hidden">
        ${dayRows}
      </div>
      ${totalCot > 0 ? `
      <div style="margin-top:12px;padding:10px 14px;background:rgba(0,212,170,.08);border-radius:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span style="font-size:13px;font-weight:600">💶 Total cotations validées cette semaine</span>
        <strong style="font-size:16px;color:var(--a)">${totalCot.toFixed(2)} €</strong>
      </div>` : ''}`;
  }

  // ── Assemblage final ──────────────────────────────────────────────────────
  // cabinetBar uniquement en mode cabinet (jamais en solo)
  const cabinetBar = cabinetActive ? `
    <div style="margin-bottom:16px;padding:10px 14px;background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);border-radius:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:13px">🏥 <strong>${cab?.nom || 'Mon cabinet'}</strong></span>
      <span style="font-size:12px;color:var(--m)">${Object.keys(cabinetAssignments).length} IDE(s) · Vue cabinet active</span>
      <button onclick="planningOptimiseCabinetWeek()" class="btn bs bsm" style="margin-left:auto"><span>⚡</span> Optimiser la répartition</button>
    </div>` : '';

  // ⚡ Construire le HTML en 2 étapes pour éviter qu'une erreur dans renderCabinetView()
  // fasse échouer silencieusement tout le template literal (pbody.innerHTML non mis à jour)
  let _dynamicView = '';
  if (cabinetActive) {
    try {
      _dynamicView = renderCabinetView();
    } catch(e) {
      console.error('[AMI Planning] renderCabinetView ERREUR :', e.message, e.stack);
      _dynamicView = `<div class="ai er">Erreur vue cabinet : ${e.message}<br><small>${e.stack}</small></div>`;
    }
  } else {
    try {
      _dynamicView = renderSoloView();
    } catch(e) {
      console.error('[AMI Planning] renderSoloView ERREUR :', e.message);
      _dynamicView = `<div class="ai er">Erreur vue solo : ${e.message}</div>`;
    }
  }

  const _shellHTML = `
    <div class="card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
        <div>
          <div class="ct" style="margin-bottom:4px">📅 Planning hebdomadaire${cabinetActive ? ' — Vue cabinet' : ''}</div>
          <div style="font-size:12px;color:var(--m);font-family:var(--fm)">${patientsToShow.length} patient(s) · ${nbCot} cotation(s) validée(s)${_planningWeekOffset !== 0 ? ` · ${_planningWeekOffset > 0 ? '+' : ''}${_planningWeekOffset} sem.` : ''}</div>
        </div>
        <button onclick="_planningResetAll()" style="font-family:var(--fm);font-size:11px;padding:6px 14px;border-radius:20px;border:1px solid rgba(255,95,109,.35);background:rgba(255,95,109,.06);color:var(--d);cursor:pointer;white-space:nowrap">
          🗑️ Effacer tout le planning
        </button>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${caWeek ? `<div style="background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">CA ESTIMÉ SEMAINE</div><div style="color:var(--a);font-weight:700">${caWeek.toFixed(2)} €</div></div>` : ''}
        ${nbCot > 0 ? `<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">COTATIONS VALIDÉES</div><div style="color:#22c55e;font-weight:700">${totalCot.toFixed(2)} €</div></div>` : ''}
        ${cabinetActive ? `<div style="background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">CABINET</div><div style="color:var(--a);font-weight:700">${Object.keys(cabinetAssignments).length} IDE(s)</div></div>` : ''}
      </div>
      ${cabinetBar}
      <div id="planning-dynamic-view"></div>
    </div>`;

  $('pbody').innerHTML = _shellHTML;

  // Injecter la vue dynamique dans son conteneur dédié (évite le crash silencieux)
  const _dynEl = document.getElementById('planning-dynamic-view');
  if (_dynEl) _dynEl.innerHTML = _dynamicView;

  const resPla = document.getElementById('res-pla');
  if (resPla) resPla.classList.add('show');
}


/* Optimiser la répartition cabinet pour la semaine affichée */
async function planningOptimiseCabinetWeek() {
  const cab = APP.get ? APP.get('cabinet') : null;
  if (!cab?.id || !cab.members?.length) return;

  const patients = window.APP._planningData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries || [];
  if (!patients.length) { if (typeof showToast === 'function') showToast('Aucun patient à optimiser.', 'wa'); return; }

  if (typeof showToast === 'function') showToast('⚡ Optimisation en cours…', 'ok');

  try {
    // Reclustering intelligent si disponible
    if (typeof smartCluster === 'function' && typeof cabinetGeoCluster === 'function') {
      const clusters = smartCluster(patients, cab.members.length);
      cab.members.forEach((m, i) => {
        (clusters[i] || []).forEach(p => { p.performed_by = m.id || m.infirmiere_id; });
      });
    }
    renderPlanning({}).catch(() => {});
    if (typeof showToast === 'function') showToast('✅ Répartition optimisée !', 'ok');
  } catch(e) {
    if (typeof showToast === 'function') showToast('❌ ' + e.message, 'err');
  }
}
function _planningDeleteCotation(idx) {
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const p = patients[idx];
  if (!p) return;
  if (!confirm(`Supprimer la cotation de ${[p.prenom, p.nom].filter(Boolean).join(' ') || 'ce patient'} ?`)) return;
  delete p._cotation;
  // Ré-afficher le planning
  renderPlanning({}).catch(()=>{});
  if (typeof showToast === 'function') showToast('🗑️ Cotation supprimée.');
}

/* Retirer un patient du planning */
function _planningRemovePatient(idx) {
  // Source unique de vérité : APP._planningData (utilisée par renderPlanning)
  const planData = window.APP._planningData;
  const arr = planData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  if (!arr.length) return;

  const p = arr[idx];
  if (!p) return;
  const nom = [p?.prenom, p?.nom].filter(Boolean).join(' ')
    || p?.description?.split(' ').slice(0,3).join(' ')
    || 'ce patient';
  if (!confirm(`Retirer ${nom} du planning ?`)) return;

  const newArr = arr.filter((_, i) => i !== idx);

  // Mettre à jour APP._planningData (source que renderPlanning utilise)
  if (planData) {
    planData.patients = newArr;
    planData.total    = newArr.length;
  }
  // Mettre à jour APP.importedData en miroir si présent
  if (APP.importedData) {
    const key = APP.importedData.patients ? 'patients' : 'entries';
    APP.importedData[key] = newArr;
    APP.importedData.total = newArr.length;
  }

  // Persister localement + serveur
  if (newArr.length) {
    _savePlanning(newArr);
    _syncPlanningToServer(newArr).catch(() => {});
  } else {
    // Plus aucun patient : vider complètement
    _clearPlanning();
    _syncPlanningToServer([]).catch(() => {});
  }

  renderPlanning({}).catch(() => {});
  if (typeof showToast === 'function') showToast('✅ Patient retiré du planning.');
}

/* Réassigner un patient à un autre IDE dans la vue cabinet */
window._planningReassignIDE = function(newIdeId, patientIdx) {
  // Rétrocompat : si un ancien code appelle encore cette fonction, on REMPLACE toute la liste
  const planData = window.APP._planningData;
  const arr = planData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  if (patientIdx < 0 || patientIdx >= arr.length) return;
  arr[patientIdx] = { ...arr[patientIdx], _assignedIdes: [newIdeId], _assignedIde: newIdeId };
  _savePlanning(arr);
  _syncPlanningToServer(arr).catch(() => {});
  renderPlanning({}).catch(() => {});
};

/* Toggle un IDE pour un patient : coche/décoche l'IDE dans la liste _assignedIdes.
   Garantit qu'au moins un IDE reste assigné (empêche un patient orphelin). */
window._planningToggleIDE = function(ideId, patientIdx, checked) {
  const planData = window.APP._planningData;
  const arr = planData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  if (patientIdx < 0 || patientIdx >= arr.length) return;

  const p = arr[patientIdx];
  // Normaliser : rétrocompat _assignedIde singleton → tableau
  let ides = Array.isArray(p._assignedIdes)
    ? p._assignedIdes.slice()
    : (p._assignedIde ? [p._assignedIde] : []);

  if (checked) {
    if (!ides.includes(ideId)) ides.push(ideId);
  } else {
    ides = ides.filter(id => id !== ideId);
    // Garde-fou : au moins un IDE doit rester assigné
    if (!ides.length) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Au moins un IDE doit rester assigné', 'wa');
      }
      renderPlanning({}).catch(() => {});
      return;
    }
  }

  arr[patientIdx] = {
    ...p,
    _assignedIdes: ides,
    _assignedIde:  ides[0],   // rétrocompat : champ singleton = premier IDE de la liste
  };

  _savePlanning(arr);
  _syncPlanningToServer(arr).catch(() => {});
  renderPlanning({}).catch(() => {});
};

/* ════════════════════════════════════════════════════════════════════════
   Importer les patients d'un jour du planning hebdo dans la Tournée IA
   Appelé par le bouton "⚡ Tournée IA" de chaque ligne jour.
   jourKey : 'lundi', 'mardi', ... (utilisé pour le libellé du toast)
   dateISO : 'YYYY-MM-DD' (date du jour pour filtrer)
════════════════════════════════════════════════════════════════════════ */
window.planningImportDayToTour = async function(jourKey, dateISO) {
  try {
    // Récupérer tous les patients du planning hebdomadaire
    const allPatients = (window.APP?._planningData?.patients) ||
                         (window.APP?._planningData?.entries) ||
                         (window.APP?.importedData?.patients) ||
                         (window.APP?.importedData?.entries) ||
                         [];
    if (!allPatients.length) {
      if (typeof showToast === 'function') showToast('warning', 'Aucun patient', 'Le planning est vide.');
      return;
    }

    // Filtrer les patients du jour spécifié (même logique que la distribution hebdo)
    const patientsDuJour = allPatients.filter(p => {
      try {
        const pd = new Date(p.date);
        if (!isNaN(pd)) {
          const pdKey = pd.toISOString().slice(0, 10);
          return pdKey === dateISO;
        }
      } catch {}
      // Fallback : mot-clé jour dans la description (uniquement si date manquante)
      const desc = (p.description || p.texte || '').toLowerCase();
      return new RegExp('\\b' + jourKey + '\\b').test(desc);
    });

    if (patientsDuJour.length === 0) {
      if (typeof showToast === 'function') showToast('info', 'Aucun patient', `Pas de patient planifié pour ${jourKey}.`);
      return;
    }

    // Confirmation
    const jourCap = jourKey.charAt(0).toUpperCase() + jourKey.slice(1);
    const ok = confirm(
      `Importer ${patientsDuJour.length} patient(s) du ${jourCap} dans la Tournée IA ?\n\n` +
      `Cela remplacera la tournée actuelle (si présente).`
    );
    if (!ok) return;

    // Construire la structure importedData attendue par la tournée
    const importData = {
      patients: patientsDuJour,
      entries:  patientsDuJour,
      source:   'planning_hebdo',
      day:      jourKey,
      date:     dateISO,
      imported_at: new Date().toISOString(),
    };
    // Stocker et notifier
    storeImportedData(importData);
    if (typeof showToast === 'function') {
      showToast('success', `${patientsDuJour.length} patient(s) importé(s)`,
                `Tournée IA prête — ouvrez "Tournée IA" pour l'optimiser.`, 4500);
    }
    // Option : naviguer vers la tournée
    setTimeout(() => {
      if (typeof navTo === 'function') navTo('tur', null);
    }, 800);
  } catch(e) {
    console.warn('[planningImportDayToTour] KO:', e.message);
    if (typeof showToast === 'function') showToast('error', 'Import KO', e.message);
  }
};

/* Effacer tout le planning hebdomadaire */
function _planningResetAll() {
  const arr = window.APP._planningData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  const n = arr.length;
  if (!confirm(`Réinitialiser le planning ?\n\n${n} patient(s) seront supprimés.\nCette action ne supprime PAS les fiches du carnet patient.`)) return;

  // Vider les DEUX sources pour éviter toute résurrection
  window.APP._planningData = null;
  APP.importedData          = null;

  // Bloquer la re-sync serveur pour cette session
  _planningManuallyCleared = true;

  // Vider le stockage local + serveur
  _clearPlanning();
  _syncPlanningToServer([]).catch(() => {});

  $('pbody').innerHTML = '<div class="ai in" style="margin-top:12px">Planning effacé. Importez de nouvelles données depuis "Import calendrier".</div>';
  $('res-pla').classList.add('show');
  const banner = $('pla-import-banner');
  if (banner) banner.style.display = 'none';
  if (typeof showToast === 'function') showToast('🗑️ Planning effacé.');
}

/* ============================================================
   ROUTING OSRM
   ============================================================ */

/* Préférence autoroutes — 'auto' (inclure, défaut) | 'avoid' (éviter) */
if (typeof APP !== 'undefined') APP._routeAutoroutes = APP._routeAutoroutes || 'auto';

function _setRouteAutoroutes(mode) {
  if (typeof APP !== 'undefined') APP._routeAutoroutes = mode;
  // Mettre à jour le style des boutons
  const btnAuto   = document.getElementById('btn-route-auto');
  const btnNoAuto = document.getElementById('btn-route-noauto');
  const lbl       = document.getElementById('route-autoroute-label');
  if (btnAuto) {
    btnAuto.style.background   = mode === 'auto' ? 'rgba(0,212,170,.15)' : 'var(--s)';
    btnAuto.style.borderColor  = mode === 'auto' ? 'rgba(0,212,170,.4)'  : 'var(--b)';
    btnAuto.style.color        = mode === 'auto' ? 'var(--a)' : 'var(--m)';
  }
  if (btnNoAuto) {
    btnNoAuto.style.background  = mode === 'avoid' ? 'rgba(255,181,71,.15)' : 'var(--s)';
    btnNoAuto.style.borderColor = mode === 'avoid' ? 'rgba(255,181,71,.4)'  : 'var(--b)';
    btnNoAuto.style.color       = mode === 'avoid' ? 'var(--w)' : 'var(--m)';
  }
  if (lbl) lbl.textContent = mode === 'avoid'
    ? '🚫 Autoroutes exclues — routes nationales / dép.'
    : '✅ Itinéraire standard';
  if (typeof showToast === 'function')
    showToast(mode === 'avoid' ? '🚫 Autoroutes exclues — relancez l\'optimisation' : '✅ Autoroutes incluses — relancez l\'optimisation');
}
window._setRouteAutoroutes = _setRouteAutoroutes;

async function getOsrmRoute(waypoints){
  // waypoints = [{lat,lng}, ...]
  if(!waypoints||waypoints.length<2)return null;
  try{
    const coords = waypoints.map(w=>`${w.lng},${w.lat}`).join(';');
    const avoidMotorway = (typeof APP !== 'undefined') && APP._routeAutoroutes === 'avoid';
    // OSRM v5 supporte ?exclude=motorway,toll pour éviter les autoroutes
    const excludeParam = avoidMotorway ? '&exclude=motorway,toll' : '';
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&steps=false${excludeParam}`;
    const r = await fetch(url);
    const d = await r.json();
    if(d.code!=='Ok') return null;
    const route = d.routes[0];
    return{
      total_km:  Math.round(route.distance/100)/10,
      total_min: Math.round(route.duration/60),
      legs: route.legs.map(l=>({km:Math.round(l.distance/100)/10, min:Math.round(l.duration/60)})),
      avoid_motorway: avoidMotorway,
    };
  }catch{return null;}
}

/* ============================================================
   TOURNÉE IA — Moteur local VRPTW + 2-opt + MAP PREMIUM
   ============================================================ */
async function optimiserTournee(){
  if(!requireAuth()) return;

  /* ══════════════════════════════════════════════════════════════════
     1. SOURCE DE DONNÉES — toutes sources, ordre de priorité garanti
     ══════════════════════════════════════════════════════════════════ */
  const _impData = APP.importedData
    || APP.get('importedData')
    || window.APP._planningData
    || (typeof loadTourneeData === 'function' ? loadTourneeData() : null);
  const rawPatients = _impData?.patients || _impData?.entries || [];

  if(!rawPatients.length){
    const tbody=$('tbody');
    if(tbody) tbody.innerHTML=`<div class="card">
      <div class="ct">⚠️ Aucune donnée importée</div>
      <div class="ai wa" style="margin-bottom:12px">Importez vos patients via le <strong>👤 Carnet patients</strong> ou l'<strong>📂 Import calendrier</strong>.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn bp bsm" onclick="navTo('patients',null)"><span>👤</span> Carnet patients</button>
        <button class="btn bs bsm" onclick="navTo('imp',null)"><span>📂</span> Import calendrier</button>
      </div>
    </div>`;
    $('res-tur').classList.add('show');
    return;
  }

  /* ══════════════════════════════════════════════════════════════════
     2. POINT DE DÉPART
     ══════════════════════════════════════════════════════════════════ */
  const startLat = parseFloat($('t-lat')?.value) || APP.get('startPoint')?.lat || null;
  const startLng = parseFloat($('t-lng')?.value) || APP.get('startPoint')?.lng || null;
  if(!startLat || !startLng){
    $('terr').style.display='flex';
    $('terr-m').textContent='📍 Définis ton point de départ (bouton GPS ou clic sur la carte)';
    $('res-tur').classList.add('show'); return;
  }

  ld('btn-tur',true); $('res-tur').classList.remove('show');
  _showOptimProgress('🧠 Calcul des temps de trajet réels…');

  const optimMode  = getOptimMode();
  const startPoint = { lat: startLat, lng: startLng };

  /* ── Fonction locale de persistance d'erreur (audit) ── */
  const _logErr = (e, stage) => {
    console.error(`[AMI] optimiserTournee crash @ ${stage}:`, e?.message, e);
    try {
      const _arr = JSON.parse(localStorage.getItem('ami_errors') || '[]');
      _arr.push({ t: Date.now(), stage, msg: e?.message, stack: e?.stack?.slice(0,400) });
      localStorage.setItem('ami_errors', JSON.stringify(_arr.slice(-10)));
    } catch {}
  };

  /* ── Fallback local : tri par heures sans OSRM ── */
  const _fallbackRender = (route, errMsg) => {
    const caF = estimateRevenue(route);
    const tbodyEl = $('tbody');
    if(tbodyEl) tbodyEl.innerHTML = _renderRouteHTML(route, null, caF, null, optimMode);
    $('terr').style.display = 'flex';
    $('terr-m').textContent = errMsg;
    APP.set('uberPatients', route.map((p,i) => ({
      ...p, id: p.patient_id||p.id||i, done:false, absent:false, late:false,
      amount: parseFloat(p.total||p.amount||0)||estimateRevenue([p]),
    })));
    _renderCabinetAssignmentPanel();
    startLiveOptimization();
  };

  try {
    const startPoint = { lat: startLat, lng: startLng };

    /* ── MODE HEURES PRÉFÉRÉES ── */
    if (optimMode === 'heure') {
      _showOptimProgress('🕐 Tri par heures préférées…');
      const withHeure = rawPatients.filter(p => p.heure_preferee || p.heure_soin)
        .sort((a,b)=>(a.heure_preferee||a.heure_soin||'99:99').localeCompare(b.heure_preferee||b.heure_soin||'99:99'));
      const withoutH  = rawPatients.filter(p => !p.heure_preferee && !p.heure_soin);
      let route = applyPassageConstraints([...withHeure, ...withoutH]);
      const ca  = estimateRevenue(route);
      const pts = route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
      let osrm = null;
      if(pts.length >= 2) osrm = await getOsrmRoute([startPoint,...pts]);
      $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, null, 'heure');
      $('terr').style.display = 'none';
      if(osrm?.total_km){ APP.set('tourneeKmJour', osrm.total_km); try{localStorage.setItem('ami_tournee_km', String(osrm.total_km));}catch{} }
      if(typeof renderPatientsOnMap === 'function') renderPatientsOnMap(route, startPoint).catch(()=>{});
      APP.set('uberPatients', route.map((p,i)=>({...p,id:p.patient_id||p.id||i,label:p.description||'Patient '+(i+1),done:false,absent:false,late:false,amount:parseFloat(p.total||p.montant||0)||estimateRevenue([p])})));
      startLiveOptimization();
      $('res-tur').classList.add('show');
      ld('btn-tur',false);
      return;
    }

    /* ══ MOTEUR IA LOCAL — VRPTW + 2-opt ══
       ⚠️  startTimeMin DOIT être déclaré ICI, avant toute utilisation
           (const en zone morte temporelle = ReferenceError si inversé) */
    const _now         = new Date();
    const startTimeMin = _now.getHours() * 60 + _now.getMinutes();
    const _tfInfo      = (typeof getTrafficInfo === 'function') ? getTrafficInfo(startTimeMin) : { label: '' };
    _showOptimProgress(`⚡ Optimisation VRPTW en cours… ${_tfInfo.label}`);

    let route = await optimizeTour(rawPatients, startPoint, startTimeMin, optimMode);
    _showOptimProgress('🔁 Optimisation géométrique (2-opt + Or-opt si ≥20)…');
    // refineRouteGeometry : 2-opt seul si <20 patients, pipeline complet au-delà
    route = (typeof refineRouteGeometry === 'function')
      ? refineRouteGeometry(route)
      : twoOpt(route); // fallback défensif
    route = applyPassageConstraints(route);

    /* Enrichir CA patient par patient */
    route = route.map(p => {
      if(parseFloat(p.total || p.amount || 0) > 0) return p;
      return { ...p, amount: estimateRevenue([p]) };
    });

    const ca     = estimateRevenue(route);
    const rentab = scoreTourneeRentabilite(route);

    /* OSRM */
    let osrm = null;
    const pts = route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
    if(pts.length >= 2) osrm = await getOsrmRoute([startPoint, ...pts]);

    /* Rendu */
    $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, rentab, optimMode);
    $('terr').style.display = 'none';
    if(osrm?.total_km){ APP.set('tourneeKmJour', osrm.total_km); try{localStorage.setItem('ami_tournee_km', String(osrm.total_km));}catch{} }
    if(typeof renderPatientsOnMap === 'function') renderPatientsOnMap(route, startPoint).catch(e=>logWarn('map:',e.message));

    APP.set('uberPatients', route.map((p,i) => ({
      ...p,
      id:      p.patient_id || p.id || i,
      label:   p.description || p.label || 'Patient '+(i+1),
      done:false, absent:false, late:false, urgence:!!(p.urgent||p.urgence),
      time:    p.start_min ? p.start_min * 60000 : null,
      amount:  parseFloat(p.total||p.montant||0) || parseFloat(p.amount||0) || estimateRevenue([p]),
      _legKm:  parseFloat(osrm?.legs?.[i]?.km || 0),
    })));

    _renderCabinetAssignmentPanel();
    startLiveOptimization();

  } catch(e) {
    /* ══ CATCH ROBUSTE — jamais silencieux, jamais l'API fantôme ══
       1. Log + persistance pour audit
       2. Fallback local : tri par heures (fonctionne sans réseau)
       3. Message clair dans l'UI (pas "Aucun patient importé") */
    _logErr(e, 'main');

    try {
      const fallback = [...rawPatients].sort((a,b) =>
        (a.heure_soin||a.heure_preferee||'99:99')
          .localeCompare(b.heure_soin||b.heure_preferee||'99:99')
      );
      _fallbackRender(fallback,
        `⚠️ Moteur IA indisponible — Tri par heures · Erreur : ${e.message}`);
    } catch(fe) {
      _logErr(fe, 'fallback');
      const terr = $('terr'); if(terr) terr.style.display='flex';
      const terrm = $('terr-m'); if(terrm) terrm.textContent = `❌ Erreur : ${e.message}`;
    }
  }

  $('res-tur').classList.add('show');
  ld('btn-tur',false);
  document.dispatchEvent(new CustomEvent('tournee:updated'));
}

/* Indicateur de progression optimisation */
function _showOptimProgress(msg) {
  const el = $('terr');
  if(!el) return;
  el.style.display = 'flex';
  const span = $('terr-m');
  if(span) span.textContent = msg;
}

/* Rendu HTML de la route optimisée */
function _renderRouteHTML(route, osrm, ca, rentab, mode) {
  const total = route.filter(p=>p.lat&&p.lng).length;
  const modeBadge = mode === 'heure'
    ? `<span style="font-family:var(--fm);font-size:10px;background:rgba(0,212,170,.12);color:var(--a);border:1px solid rgba(0,212,170,.3);padding:2px 10px;border-radius:20px;letter-spacing:1px">🕐 Heures préférées</span>`
    : mode === 'mixte'
    ? `<span style="font-family:var(--fm);font-size:10px;background:rgba(79,168,255,.1);color:var(--a2);border:1px solid rgba(79,168,255,.3);padding:2px 10px;border-radius:20px;letter-spacing:1px">⚡ Mode mixte</span>`
    : `<span style="font-family:var(--fm);font-size:10px;background:rgba(255,181,71,.1);color:var(--w);border:1px solid rgba(255,181,71,.25);padding:2px 10px;border-radius:20px;letter-spacing:1px">🧠 IA VRPTW</span>`;

  // Badge trafic calculé à l'heure d'affichage
  const _nowMin = (new Date().getHours() * 60 + new Date().getMinutes());
  const _tf = (typeof getTrafficInfo === 'function') ? getTrafficInfo(_nowMin) : { label: '🟢 Fluide', factor: 1.0 };
  const _tfColor = _tf.label.includes('🔴') ? 'rgba(255,95,109,.15)' : _tf.label.includes('🟡') ? 'rgba(255,181,71,.12)' : 'rgba(0,212,170,.1)';
  const _tfBorder = _tf.label.includes('🔴') ? 'rgba(255,95,109,.35)' : _tf.label.includes('🟡') ? 'rgba(255,181,71,.3)' : 'rgba(0,212,170,.25)';
  const _tfText = _tf.label.includes('🔴') ? 'var(--d)' : _tf.label.includes('🟡') ? 'var(--w)' : 'var(--a)';
  const trafficBadge = `<span style="font-family:var(--fm);font-size:10px;background:${_tfColor};color:${_tfText};border:1px solid ${_tfBorder};padding:2px 10px;border-radius:20px;letter-spacing:.5px">${_tf.label}</span>`;

  return `<div class="card">
    <div class="ct" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      🗺️ Tournée optimisée — ${total} patients ${modeBadge} ${trafficBadge}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;margin-top:10px">
      <div class="dreb">📍 ${total} patients</div>
      ${osrm?`<div class="dreb">🚗 ${osrm.total_km} km</div><div class="dreb">⏱ ~${osrm.total_min} min</div>`:''}
      ${osrm?.avoid_motorway ? `<div class="dreb" style="background:rgba(255,181,71,.1);border-color:rgba(255,181,71,.3);color:var(--w)">🚫 Sans autoroutes</div>` : ''}
      <div class="ca-pill">💶 CA estimé : ${parseFloat(ca).toFixed(2)} €</div>
      ${rentab?`<div class="ca-pill" style="background:rgba(79,168,255,.1);border-color:rgba(79,168,255,.3);color:var(--a2)">📊 ${rentab.euro_heure}€/h</div>`:''}
      <button class="btn bs bsm" style="margin-left:auto;color:var(--d);border-color:rgba(255,95,109,.3);font-size:11px" onclick="clearTournee()">🗑️ Vider</button>
    </div>
    ${route.map((p,i)=>{
      const sd  = encodeURIComponent(p.acte || p.texte || p.description || '');
      const spn = encodeURIComponent(((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.patient || '');
      const nomAff = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.label || 'Patient ' + (i+1);
      const pId = encodeURIComponent(p.id || p.patient_id || String(i));
      const leg = osrm?.legs?.[i];
      const hasTime = p.start_str && p.start_str !== '—';
      const heureAff = p.heure_preferee || p.heure_soin || '';
      const contrainteBadge = p.respecter_horaire
        ? `<span style="font-size:10px;background:rgba(0,212,170,.1);color:var(--a);border:1px solid rgba(0,212,170,.25);padding:1px 7px;border-radius:20px;font-family:var(--fm)">🔒 ${heureAff}</span>`
        : heureAff
        ? `<span style="font-size:10px;background:rgba(255,181,71,.08);color:var(--w);border:1px solid rgba(255,181,71,.2);padding:1px 7px;border-radius:20px;font-family:var(--fm)">⏰ ${heureAff}</span>`
        : '';
      return `<div class="route-item ${p.urgent?'route-urgent':''}">
        <div class="route-num">${i+1}</div>
        <div class="route-info">
          <strong style="font-size:13px">${nomAff}</strong>
          <div style="font-size:11px;color:var(--m);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${hasTime?`🕐 Arrivée ~${p.arrival_str} · Soin ${p.start_str}`:''}
            ${p.urgent?'<span style="color:#ff5f6d;font-weight:700">🚨 URGENT</span>':''}
            ${contrainteBadge}
          </div>
        </div>
        ${leg?`<div class="route-km">+${leg.km}km·${leg.min}min</div>`:(p.travel_min?`<div class="route-km" title="Inclut correction trafic">~${p.travel_min}min</div>`:'')}
        ${(p.lat && p.lng) || p.adresse || p.addressFull ? `<button class="btn bv bsm" onclick="openNavigation(${JSON.stringify({lat:p.lat||null,lng:p.lng||null,address:p.adresse||p.addressFull||p.address||'',addressFull:p.addressFull||p.adresse||'',adresse:p.adresse||p.addressFull||'',geoScore:p.geoScore||0}).replace(/"/g,'&quot;')})" title="Naviguer vers ce patient">🗺️</button>` : ''}
        <button class="btn bs bsm" style="padding:6px 8px;color:var(--d)" onclick="removeFromTournee('${pId}',${i})" title="Retirer de la tournée">✕</button>
      </div>`;
    }).join('')}
  </div>`;
}

/* ════════════════════════════════════════════════════════════════════
   ASSIGNATION IDE PAR LEG — Panel Tournée cabinet
   APP._ideAssignments = { patientKey: [{id, label}] }
   Persisté en mémoire (réinitialisé avec la tournée)
═════════════════════════════════════════════════════════════════════= */
function _toggleIdeAssignment(nurseId, nurseName, patientKey, checked) {
  if (!APP._ideAssignments) APP._ideAssignments = {};
  if (!APP._ideAssignments[patientKey]) APP._ideAssignments[patientKey] = [];
  if (checked) {
    if (!APP._ideAssignments[patientKey].some(a => a.id === nurseId)) {
      APP._ideAssignments[patientKey].push({ id: nurseId, label: nurseName });
    }
  } else {
    APP._ideAssignments[patientKey] = APP._ideAssignments[patientKey].filter(a => a.id !== nurseId);
  }
  // Rafraîchir les stats CA/km sans re-render complet du panel
  _refreshCabinetStats();
}
window._toggleIdeAssignment = _toggleIdeAssignment;

/* ── Helper géodésique local (fallback si _haversine global indisponible) ── */
if (typeof _haversine !== 'function') {
  window._haversine = function(la1, lo1, la2, lo2) {
    const R    = 6371;
    const dLat = (la2 - la1) * Math.PI / 180;
    const dLon = (lo2 - lo1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(la1 * Math.PI / 180)
               * Math.cos(la2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
}

/* ────────────────────────────────────────────────────────────────────
   _renderCabinetAssignmentPanel()
   Affiche dans #tur-cabinet-result chaque IDE avec ses patients
   sous forme de cases à cocher + CA/km calculés en temps réel.
   Appelé automatiquement après chaque optimisation de tournée.
──────────────────────────────────────────────────────────────────── */
function _renderCabinetAssignmentPanel() {
  const result = document.getElementById('tur-cabinet-result');
  if (!result) return;

  const cab     = (typeof APP !== 'undefined' && APP.get) ? APP.get('cabinet') : null;
  const me      = (typeof APP !== 'undefined') ? APP.user : null;
  const members = cab?.members ? [...cab.members] : [];
  if (me && !members.find(m => m.id === me.id)) {
    members.unshift({ id: me.id, nom: me.nom || '', prenom: me.prenom || '' });
  }
  if (!members.length) return; // solo — panel non affiché

  const patients = (typeof APP !== 'undefined' && APP.get) ? (APP.get('uberPatients') || []) : [];
  if (!patients.length) {
    result.innerHTML = '<div class="ai wa" style="font-size:12px">Aucun patient dans la tournée — optimisez d\'abord.</div>';
    return;
  }

  const COLORS = ['var(--a)', '#4fa8ff', 'var(--w)', '#ff6b6b', '#b0a8ff'];

  // ── Helper : calcul km robuste d'un patient (fallback multi-champs) ──
  // ── Helper : calcul km robuste d'un patient ──
  const _ptKm = (p) => {
    const d = parseFloat(p._legKm || p.distance_km || p.km || 0);
    return isFinite(d) && d > 0 ? d : 0;
  };

  // Km total des patients assignés à un IDE + km retour au dernier point
  const _ideKmTotal = (ideId, ps) => {
    const assigned = ps.filter(p => {
      const pk = String(p.patient_id || p.id || '');
      return (APP._ideAssignments?.[pk] || []).some(a => a.id === ideId);
    });
    let total = assigned.reduce((s, p) => s + _ptKm(p), 0);
    // Si 0 km total ET au moins 1 patient → fallback estimation géodésique
    if (total === 0 && assigned.length >= 1) {
      const sp = (typeof APP !== 'undefined' && APP.get) ? APP.get('startPoint') : null;
      if (sp?.lat && sp?.lng) {
        // Aller : start → 1er patient
        const first = assigned[0];
        if (first.lat && first.lng) total += _haversine(sp.lat, sp.lng, first.lat, first.lng);
        // Enchaînements
        for (let i = 1; i < assigned.length; i++) {
          const a = assigned[i-1], b = assigned[i];
          if (a.lat && a.lng && b.lat && b.lng) total += _haversine(a.lat, a.lng, b.lat, b.lng);
        }
        // Retour : dernier patient → start
        const last = assigned[assigned.length - 1];
        if (last.lat && last.lng) total += _haversine(last.lat, last.lng, sp.lat, sp.lng);
      }
    }
    return Math.round(total * 10) / 10;
  };

  result.innerHTML = members.map((m, idx) => {
    const c       = COLORS[idx % COLORS.length];
    const mid     = m.id || `ide_${idx}`;
    const mLabel  = (`${m.prenom||''} ${m.nom||''}`).trim() || mid;
    const isMe    = me && m.id === me.id;
    const safeMid = mid.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    const safeLbl = mLabel.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    const elemId  = `ide-stats-${mid.replace(/[^a-zA-Z0-9]/g,'_')}`;
    const panelId = `ide-panel-${mid.replace(/[^a-zA-Z0-9]/g,'_')}`;

    // Stats initiales pour cet IDE
    let ca = 0, nb = 0;
    patients.forEach(p => {
      const pk = String(p.patient_id || p.id || '');
      if ((APP._ideAssignments?.[pk] || []).some(a => a.id === mid)) {
        ca += parseFloat(p.amount || 0) || (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 0);
        nb++;
      }
    });
    const km = _ideKmTotal(mid, patients);

    // ⚡ IDE sans aucun patient assigné → mode compact collapsed par défaut.
    // Évite la confusion visuelle où les patients apparaissaient sous chaque IDE
    // avec leurs €/km propres (donnant l'impression que l'IDE "touchait" ces
    // montants). L'utilisateur peut cliquer pour déplier et assigner manuellement.
    const _isEmptyIde = (nb === 0);
    const _collapsedInitially = _isEmptyIde && !isMe;

    const patientsHTML = patients.map(p => {
      const pk     = String(p.patient_id || p.id || '');
      const pNom   = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.label || 'Patient';
      const isChk  = (APP._ideAssignments?.[pk] || []).some(a => a.id === mid);
      const safePk = pk.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
      const pCa    = parseFloat(p.amount || 0) || (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 0);
      const pKm    = parseFloat(p._legKm || 0);
      // ⚡ Rendre les €/km visuellement différents selon coché/non coché pour
      // lever l'ambiguïté : coché = revenus réels de l'IDE, non coché = simulation
      const _statOpacity = isChk ? '1' : '.45';
      const _statPrefix  = isChk ? '' : '~';
      return `<label data-ide="${mid.replace(/"/g,'&quot;')}" data-pk="${pk.replace(/"/g,'&quot;')}"
        style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;
          cursor:pointer;user-select:none;
          background:${isChk?'rgba(0,212,170,.07)':'transparent'};
          border:1px solid ${isChk?'rgba(0,212,170,.2)':'transparent'};
          transition:background .12s,border-color .12s;margin-bottom:2px"
        onmouseenter="if(!this.querySelector('input').checked)this.style.background='rgba(255,255,255,.03)'"
        onmouseleave="if(!this.querySelector('input').checked)this.style.background='transparent'">
        <input type="checkbox" ${isChk?'checked':''}
          onchange="_toggleIdeAssignment('${safeMid}','${safeLbl}','${safePk}',this.checked)"
          style="accent-color:${c};width:14px;height:14px;flex-shrink:0">
        <span style="font-size:12px;flex:1;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${pNom}</span>
        ${pKm > 0 ? `<span style="font-size:10px;font-family:var(--fm);color:var(--m);flex-shrink:0;opacity:${_statOpacity}">🚗 ${_statPrefix}${pKm.toFixed(1)}km</span>` : ''}
        <span style="font-size:10px;font-family:var(--fm);color:var(--a);flex-shrink:0;opacity:${_statOpacity}">💶 ${_statPrefix}${pCa.toFixed(2)}€</span>
      </label>`;
    }).join('');

    // Header de l'IDE — compact si pas de patient assigné, étendu sinon
    return `<div style="border:1px solid var(--b);border-radius:10px;margin-bottom:10px;overflow:hidden;border-left:4px solid ${c}">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--s);cursor:${_collapsedInitially?'pointer':'default'}"
           ${_collapsedInitially ? `onclick="(function(){var p=document.getElementById('${panelId}');if(p){var show=p.style.display==='none';p.style.display=show?'block':'none';var ic=document.getElementById('${panelId}-ic');if(ic)ic.textContent=show?'▼':'▶';}})()"` : ''}>
        <div style="width:10px;height:10px;border-radius:50%;background:${c};flex-shrink:0;opacity:${_isEmptyIde?'.5':'1'}"></div>
        <strong style="font-size:13px;flex:1;color:${_isEmptyIde?'var(--m)':'var(--t)'}">${mLabel}${isMe?' <em style="font-size:10px;font-weight:400;color:var(--a)">(moi)</em>':''}</strong>
        ${_isEmptyIde ? `<span style="font-size:10px;font-family:var(--fm);color:var(--m);font-style:italic;margin-right:6px">Aucun patient assigné</span>` : ''}
        <span id="${elemId}" data-ide-id="${mid.replace(/"/g,'&quot;')}"
          style="font-size:12px;font-family:var(--fm);color:var(--m);white-space:nowrap;display:flex;align-items:center;gap:6px">
          <span style="background:var(--ad);color:var(--a);border-radius:20px;padding:1px 7px;font-size:11px">
            <span class="ide-nb-val">${nb}</span> pt
          </span>
          💶 <span class="ide-ca-val">${ca.toFixed(2)}</span> €
          🚗 <span class="ide-km-val">${km.toFixed(1)}</span> km
        </span>
        ${_collapsedInitially ? `<span id="${panelId}-ic" style="font-size:11px;color:var(--m);font-family:var(--fm);margin-left:4px">▶</span>` : ''}
      </div>
      <div id="${panelId}" style="padding:6px 8px;display:${_collapsedInitially?'none':'block'}">${patientsHTML}</div>
    </div>`;
  }).join('');
}
window._renderCabinetAssignmentPanel = _renderCabinetAssignmentPanel;

/* Mise à jour CA/km/nb par IDE sans re-render complet du panel */
function _refreshCabinetStats() {
  const patients    = (typeof APP !== 'undefined' && APP.get) ? (APP.get('uberPatients') || []) : [];
  const assignments = (typeof APP !== 'undefined') ? (APP._ideAssignments || {}) : {};
  const sp          = (typeof APP !== 'undefined' && APP.get) ? APP.get('startPoint') : null;

  const _ptKm = (p) => {
    const d = parseFloat(p._legKm || p.distance_km || p.km || 0);
    return isFinite(d) && d > 0 ? d : 0;
  };

  // Stats par IDE
  document.querySelectorAll('#tur-cabinet-result [data-ide-id]').forEach(statsEl => {
    const ideId = statsEl.dataset.ideId;
    if (!ideId) return;
    let ca = 0, nb = 0;
    const assigned = [];
    patients.forEach(p => {
      const pk = String(p.patient_id || p.id || '');
      if ((assignments[pk] || []).some(a => a.id === ideId)) {
        ca += parseFloat(p.amount || 0) || (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 0);
        nb++;
        assigned.push(p);
      }
    });
    // Km : somme _legKm → si 0, fallback géodésique
    let km = assigned.reduce((s, p) => s + _ptKm(p), 0);
    if (km === 0 && assigned.length >= 1 && sp?.lat && sp?.lng && typeof _haversine === 'function') {
      const first = assigned[0];
      if (first.lat && first.lng) km += _haversine(sp.lat, sp.lng, first.lat, first.lng);
      for (let i = 1; i < assigned.length; i++) {
        const a = assigned[i-1], b = assigned[i];
        if (a.lat && a.lng && b.lat && b.lng) km += _haversine(a.lat, a.lng, b.lat, b.lng);
      }
      const last = assigned[assigned.length - 1];
      if (last.lat && last.lng) km += _haversine(last.lat, last.lng, sp.lat, sp.lng);
    }
    const caEl = statsEl.querySelector('.ide-ca-val');
    const kmEl = statsEl.querySelector('.ide-km-val');
    const nbEl = statsEl.querySelector('.ide-nb-val');
    if (caEl) caEl.textContent = ca.toFixed(2);
    if (kmEl) kmEl.textContent = km.toFixed(1);
    if (nbEl) nbEl.textContent = nb;
  });

  // Couleur de fond des labels
  document.querySelectorAll('#tur-cabinet-result label[data-ide]').forEach(lbl => {
    const chk = lbl.querySelector('input[type=checkbox]');
    if (!chk) return;
    lbl.style.background  = chk.checked ? 'rgba(0,212,170,.07)' : 'transparent';
    lbl.style.borderColor = chk.checked ? 'rgba(0,212,170,.2)'  : 'transparent';
  });
}
window._refreshCabinetStats = _refreshCabinetStats;

// Auto-refresh panel quand la tournée est recalculée
document.addEventListener('tournee:updated', () => setTimeout(_renderCabinetAssignmentPanel, 200));


/* Retirer un patient de la tournée optimisée */
function removeFromTournee(encodedId, fallbackIndex) {
  const id = decodeURIComponent(encodedId);
  const data = APP.get('importedData') || APP.importedData;
  if (!data) return;
  const patients = data.patients || data.entries || [];
  const idx = patients.findIndex((p, i2) =>
    String(p.id || p.patient_id) === String(id) || i2 === Number(fallbackIndex)
  );
  if (idx === -1) return;
  patients.splice(idx, 1);
  data.total = patients.length;
  if (typeof storeImportedData === 'function') storeImportedData(data);
  else APP.importedData = data;
  if (typeof showToast === 'function') showToast('Patient retiré de la tournée');
  optimiserTournee();
}

/* Vider entièrement la tournée */
function clearTournee() {
  if (!confirm('Vider la tournée ? Tous les patients importés seront retirés.')) return;
  APP.importedData = null;
  APP.uberPatients = [];
  if (typeof storeImportedData === 'function') storeImportedData(null);
  const tbody = $('tbody');
  if (tbody) tbody.innerHTML = '';
  const resTur = $('res-tur');
  if (resTur) resTur.classList.remove('show');
  if (typeof showToast === 'function') showToast('🗑️ Tournée vidée');
}

/* Fallback API backend (ancien comportement) */
async function _optimiserTourneeAPI(startLat, startLng) {
  try {
    const d = await apiCall('/webhook/ami-tournee-ia',{start_lat:startLat,start_lng:startLng});
    if(!d.ok) throw new Error(d.error||'Erreur API');
    const ca = estimateRevenue(d.route||[]);
    $('tbody').innerHTML = _renderRouteHTML(d.route||[], null, ca, null);
    if(d.total_km) {
      APP.set('tourneeKmJour', d.total_km);
      try { localStorage.setItem('ami_tournee_km', String(d.total_km)); } catch {}
    }
    if(typeof renderPatientsOnMap==='function' && d.route?.length) {
      renderPatientsOnMap(d.route,{lat:startLat,lng:startLng}).catch(()=>{});
    }
  } catch(e) {
    $('terr').style.display='flex';
    $('terr-m').textContent=e.message;
  }
}

/* ============================================================
   PILOTAGE LIVE — ÉTENDU
   ============================================================ */
let LIVE_CA_TOTAL=0;
let LIVE_START_TIME=null;
let LIVE_TIMER_ID=null;
/* Exposer pour terminerTourneeAvecBilan (index.html) */
Object.defineProperty(window, '_LIVE_CA_TOTAL', { get: () => LIVE_CA_TOTAL });

/* ── Mise à jour bandeau CA en continu ────────────────────────────────────
   Calcule depuis cotations validées + amount estimé des patients faits.
   Appelée après chaque action patient (done/absent) et renderLivePatientList.
──────────────────────────────────────────────────────────────────────────── */
function _updateLiveCADisplay() {
  const all = APP.get('uberPatients') || APP.importedData?.patients || APP.importedData?.entries || [];
  const caFromCotations = all.reduce((s, p) => s + parseFloat(p._cotation?.total || 0), 0);
  const caFromAmount    = all.filter(p => p.done || p._done).reduce((s, p) => {
    return s + (p._cotation?.validated ? 0 : parseFloat(p.amount || 0));
  }, 0);
  const ca = Math.max(LIVE_CA_TOTAL, caFromCotations + caFromAmount);
  const caEl = document.getElementById('live-ca-total');
  if (caEl && ca > 0) {
    caEl.textContent = `💶 CA du jour : ${ca.toFixed(2)} €`;
    caEl.style.display = 'block';
  }
  return ca;
}

/* ══════════════════════════════════════════════════════════════
   SYNC COTATIONS LOCALES → SUPABASE
   Envoie les cotations créées localement (mode live, auto-fin tournée)
   vers le worker pour persistance dans planning_patients.
   Silencieux en cas d'erreur (l'IDB reste la source de vérité locale).
══════════════════════════════════════════════════════════════ */
async function _syncCotationsToSupabase(patients, { skipIDB = false } = {}) {
  try {
    const isAdmin = (typeof S !== 'undefined') && S?.role === 'admin';
    if (isAdmin) return; // admins: cotations de test, pas de sync

    // Source 1 : patients en mémoire (uberPatients, snapshot tournée)
    const fromMemory = (patients || APP.get('uberPatients') || []).filter(p =>
      p._cotation?.validated && parseFloat(p._cotation?.total || 0) > 0 && !p._cotation?._synced
    );

    // Source 2 : cotations IDB locales non encore envoyées
    // skipIDB=true quand appelé depuis _validateCotationLive : la cotation vient d'être
    // créée en mémoire, elle n'a pas encore d'invoice_number en IDB → évite INSERT double
    let fromIDB = [];
    if (!skipIDB) {
      try {
        if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
          // Pré-construire les clés composites de fromMemory pour dédoublonnage robuste
          // Format : "patient_id|YYYY-MM-DD|total" — utilisé quand invoice_number est null
          // (ex: cotation tournée fraîchement créée par /ami-calcul qui ne retourne PAS
          // d'invoice_number — celui-ci n'est généré qu'au PUSH /ami-save-cotation).
          const _memKeys = new Set();
          for (const m of fromMemory) {
            const _mPid  = m.patient_id || m.id;
            const _mDate = (m._cotation?._tournee_date || new Date().toISOString()).slice(0, 10);
            const _mTot  = parseFloat(m._cotation?.total || 0).toFixed(2);
            if (_mPid) _memKeys.add(`${_mPid}|${_mDate}|${_mTot}`);
          }

          const rows = await _idbGetAll(PATIENTS_STORE);
          for (const row of rows) {
            const p = { id: row.id, ...((typeof _dec === 'function' ? _dec(row._data) : {}) || {}) };
            if (!Array.isArray(p.cotations)) continue;
            for (const cot of p.cotations) {
              if (cot._synced) continue;
              if (cot.source === 'cotation_edit' || cot.source === 'ngap_edit') continue;
              // Dédoublonnage 1 : invoice_number identique
              if (cot.invoice_number && fromMemory.some(m => m._cotation?.invoice_number === cot.invoice_number)) continue;
              // Dédoublonnage 2 : clé composite (patient_id + date + total) quand invoice_number absent
              // Évite le doublon quand la cotation IDB et fromMemory pointent sur le même soin
              // mais que l'invoice_number n'a pas encore été retourné par Supabase.
              const _cotDate10 = (cot.date || '').slice(0, 10);
              const _cotTot    = parseFloat(cot.total || 0).toFixed(2);
              if (!cot.invoice_number && _memKeys.has(`${row.id}|${_cotDate10}|${_cotTot}`)) continue;

              const cotDate = _cotDate10;
              const sevenDaysAgo = new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10);
              if (cotDate < sevenDaysAgo) continue;
              if (parseFloat(cot.total || 0) <= 0) continue;
              fromIDB.push({
                _idb_patient_id: row.id,
                _idb_nom:        row.nom    || '',
                _idb_prenom:     row.prenom || '',
                _idb_cot: cot,
                _cotation: { actes: cot.actes || [], total: parseFloat(cot.total), validated: true, auto: cot.source === 'tournee_auto' },
                heure_soin: cot.heure || null,
                description: cot.soin || '',
              });
            }
          }
        }
      } catch(e) { console.warn('[AMI] Lecture IDB pour sync KO:', e.message); }
    }

    const allToSync = [...fromMemory, ...fromIDB];
    if (!allToSync.length) return;

    // ── Enrichissement noms patients (fromMemory sans nom/prenom) ─────────
    // Les uberPatients issus d'un import calendrier n'ont souvent que `description`
    // (pas de champs nom/prenom séparés). On les enrichit depuis l'IDB avant sync.
    try {
      if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const _idbRowsEnrich = await _idbGetAll(PATIENTS_STORE);
        const _idbIdxEnrich  = {};
        _idbRowsEnrich.forEach(r => { _idbIdxEnrich[r.id] = r; });

        fromMemory.forEach(p => {
          if ((p.nom || p.prenom)) return; // déjà renseigné
          const pid = p.patient_id || p.id || p._idb_patient_id;
          const row = pid ? _idbIdxEnrich[pid] : null;
          if (row) {
            p.nom    = row.nom    || '';
            p.prenom = row.prenom || '';
          }
        });
      }
    } catch (_enrichErr) { /* silencieux */ }

    const cotations = allToSync
      // Ne jamais envoyer sans actes valides (évite les entrées DIM-seul parasites)
      .filter(p => (p._cotation.actes || []).length > 0 && parseFloat(p._cotation.total || 0) > 0)
      .map(p => {
        // ── Nom patient : mémoire > IDB row > soin field ──────────────────
        const _nom    = (p.nom    || p._idb_nom    || '').trim();
        const _prenom = (p.prenom || p._idb_prenom || '').trim();
        const _patNom = [_prenom, _nom].filter(Boolean).join(' ')
          || (p.description || p._idb_cot?.soin || '').slice(0, 80)
          || null;
        const _patId  = p.patient_id || p.id || p._idb_patient_id || null;

        // ── IDEs assignés à ce patient (pour Historique des soins) ──────
        const _pKeySync = String(p.patient_id || p.id || p._idb_patient_id || '');
        const _ideArrSync = (typeof APP !== 'undefined' ? APP._ideAssignments?.[_pKeySync] : null) || [];
        const _idesSuffix = _ideArrSync.length
          ? ` [IDEs: ${_ideArrSync.map(a => a.label).join(', ')}]` : '';
        // ⚡ Description enrichie pour stockage Supabase : permet que le soin
        // apparaisse détaillé ("Injection insuline SC, surveillance glycémie…")
        // dans l'Historique des soins au lieu de "Diabète" brut.
        // Priorité : cotation IDB existante (déjà enrichie par uber.js/tournee.js) > helper.
        const _soinBase = p._idb_cot?.soin
          || (typeof _enrichSoinLabel === 'function'
                ? _enrichSoinLabel({
                    actes_recurrents: p.actes_recurrents || '',
                    pathologies:      p.pathologies || '',
                    description:      p.description || p.texte || '',
                  }, 180)
                : (p.description || p.texte || '').slice(0, 180));

        return {
          actes:          p._cotation.actes || [],
          total:          parseFloat(p._cotation.total || 0),
          date_soin:      p._cotation._tournee_date
                            || (typeof _localDateStr === 'function' ? _localDateStr() : new Date().toISOString().slice(0, 10)),
          // ⚡ Heure RÉELLE du soin (clic "Terminer") — JAMAIS la contrainte horaire
          // planifiée (p.heure_soin / p.heure_preferee) qui vient de la tournée.
          // Priorité : _heure_reelle (mémoire, taguée par uber.js/_validateCotationLive)
          //        puis cot.heure (IDB, posée à la sauvegarde) → null sinon.
          heure_soin:     p._cotation?._heure_reelle || p._idb_cot?.heure || null,
          soin:           (_soinBase + _idesSuffix).slice(0, 255),
          source:         p._cotation.auto ? 'tournee_auto' : 'tournee_live',
          dre_requise:    !!p._cotation.dre_requise,
          // patient_nom → affiché dans Historique des soins (identique à cotation.js)
          ...(_patNom ? { patient_nom: _patNom } : {}),
          // patient_id → rattachement IDB / Supabase
          ...(_patId  ? { patient_id:  _patId  } : {}),
          // ides → champ dédié si le worker le supporte
          ...(_ideArrSync.length ? { ides: _ideArrSync.map(a => a.label) } : {}),
          // invoice_number existant -> PATCH (correction), sinon POST (nouvelle ligne)
          invoice_number: p._cotation.invoice_number || null,
        };
      });

    const result = await apiCall('/webhook/ami-save-cotation', { cotations });
    if (result?.ok) {
      // Récupérer les invoice_numbers retournés par le worker (alignés sur l'ordre cotations[])
      // Format possible : { invoice_numbers: [...] } | { invoices: [...] } | { invoice_number: "..." }
      const _retInvs = Array.isArray(result.invoice_numbers) ? result.invoice_numbers
                     : Array.isArray(result.invoices)        ? result.invoices
                     : (result.invoice_number ? [result.invoice_number] : []);

      // ── 1. fromMemory : marquer mémoire + propager invoice_number à l'IDB ──
      // CRITIQUE : sans cette propagation, la cotation IDB reste avec
      // invoice_number=null + _synced=false → re-envoyée à la prochaine
      // clôture (skipIDB=false) → DOUBLON garanti.
      for (let i = 0; i < fromMemory.length; i++) {
        const p   = fromMemory[i];
        const inv = _retInvs[i] || p._cotation?.invoice_number || null;
        if (p._cotation) {
          p._cotation._synced = true;
          if (inv && !p._cotation.invoice_number) p._cotation.invoice_number = inv;
        }
        // Mettre à jour l'IDB : invoice_number + _synced=true
        try {
          const pid = p.patient_id || p.id;
          if (!pid) continue;
          const rows = await _idbGetAll(PATIENTS_STORE);
          const row  = rows.find(r => r.id === pid);
          if (!row) continue;
          const pat = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data) || {}) };
          if (!Array.isArray(pat.cotations)) continue;
          // Résolution : invoice_number connu, sinon (date + total) sur cotation non-synced
          const _dKey = (p._cotation?._tournee_date || new Date().toISOString()).slice(0, 10);
          const _tKey = parseFloat(p._cotation?.total || 0);
          let cIdx = inv ? pat.cotations.findIndex(c => c.invoice_number === inv) : -1;
          if (cIdx < 0) {
            cIdx = pat.cotations.findIndex(c =>
              (c.source === 'tournee' || c.source === 'tournee_live' || c.source === 'tournee_auto') &&
              (c.date || '').slice(0, 10) === _dKey &&
              Math.abs(parseFloat(c.total || 0) - _tKey) < 0.01 &&
              !c._synced
            );
          }
          if (cIdx >= 0) {
            if (inv && !pat.cotations[cIdx].invoice_number) pat.cotations[cIdx].invoice_number = inv;
            pat.cotations[cIdx]._synced = true;
            pat.updated_at = new Date().toISOString();
            const _tsM = { id: pat.id, nom: pat.nom, prenom: pat.prenom, _data: _enc(pat), updated_at: pat.updated_at };
            await _idbPut(PATIENTS_STORE, _tsM);
            if (typeof _syncPatientNow === 'function') _syncPatientNow(_tsM).catch(() => {});
          }
        } catch (_) {}
      }

      // ── 2. fromIDB : marquer comme synced + propager invoice_number ──
      for (let j = 0; j < fromIDB.length; j++) {
        const item = fromIDB[j];
        const inv  = _retInvs[fromMemory.length + j] || item._idb_cot?.invoice_number || null;
        try {
          const rows = await _idbGetAll(PATIENTS_STORE);
          const row  = rows.find(r => r.id === item._idb_patient_id);
          if (!row) continue;
          const pat = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data) || {}) };
          if (Array.isArray(pat.cotations)) {
            // Match prioritaire : invoice_number, sinon (date + total)
            let c = inv ? pat.cotations.find(x => x.invoice_number === inv) : null;
            if (!c) {
              c = pat.cotations.find(x =>
                x.date === item._idb_cot.date &&
                Math.abs(parseFloat(x.total || 0) - parseFloat(item._idb_cot.total || 0)) < 0.01
              );
            }
            if (c) {
              if (inv && !c.invoice_number) c.invoice_number = inv;
              c._synced = true;
            }
          }
          pat.updated_at = new Date().toISOString();
          const _ts1 = { id: pat.id, nom: pat.nom, prenom: pat.prenom, _data: _enc(pat), updated_at: pat.updated_at };
          await _idbPut(PATIENTS_STORE, _ts1);
          if (typeof _syncPatientNow === 'function') _syncPatientNow(_ts1).catch(() => {});
        } catch {}
      }
      console.info(`[AMI] ${result.saved} cotation(s) synchronisées vers Supabase.`);
      // Invalider le cache dashboard
      try {
        const key = (typeof _dashCacheKey === 'function') ? _dashCacheKey() : 'ami_dash_cache';
        localStorage.removeItem(key);
      } catch {}
    }
  } catch(e) {
    console.warn('[AMI] Sync cotations KO (silencieux):', e.message);
  }
}

function startLiveTimer(){
  LIVE_START_TIME=Date.now();
  $('live-timer').style.display='block';
  $('live-ca-total').style.display='block';
  if(LIVE_TIMER_ID)clearInterval(LIVE_TIMER_ID);
  LIVE_TIMER_ID=setInterval(()=>{
    const elapsed=Math.floor((Date.now()-LIVE_START_TIME)/1000);
    const h=Math.floor(elapsed/3600),m=Math.floor((elapsed%3600)/60),s=elapsed%60;
    $('live-timer').textContent=`⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  },1000);
}

function detectDelay(currentPatient){
  if(!currentPatient?.heure_soin)return;
  const now=new Date();
  const [hh,mm]=(currentPatient.heure_soin||'00:00').split(':').map(Number);
  const planned=new Date(now);planned.setHours(hh,mm,0,0);
  const diffMin=Math.round((now-planned)/60000);
  const alertEl=$('live-delay-alert'),msgEl=$('live-delay-msg');
  if(diffMin>15&&alertEl&&msgEl){
    msgEl.textContent=`Retard de ${diffMin} min sur ${currentPatient.heure_soin||'l\'horaire prévu'}. Souhaitez-vous recalculer ?`;
    alertEl.style.display='block';
  }else if(alertEl){
    alertEl.style.display='none';
  }
}

async function autoFacturation(patient){
  // Génère la cotation automatique — ne met plus à jour le CA directement
  // (c'est la modale de vérification qui l'incrémente après validation)
  if(!patient) return;
  try{
    const u = S?.user || {};

    /* ── 1. Récupérer la fiche IDB complète (actes_recurrents + pathologies) ──
       Les patients importés dans le Pilotage n'ont souvent que description="Diabète"
       sans pathologies ni actes_recurrents. On les récupère depuis l'IDB. */
    let ficheIDB = {};
    try {
      if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const rows = await _idbGetAll(PATIENTS_STORE);
        const pid  = patient.patient_id || patient.id;
        const row  = rows.find(r => r.id === pid);
        if (row && typeof _dec === 'function') ficheIDB = _dec(row._data) || {};
      }
    } catch(_) {}

    /* ── 2. Construire le texte enrichi ── */
    const actesRec    = (ficheIDB.actes_recurrents || patient.actes_recurrents || '').trim();
    const rawDesc     = (patient.description || patient.texte || '').trim();
    // pathologies = champ IDB > champ patient > rawDesc lui-même (si c'est une pathologie brute)
    const pathologies = ficheIDB.pathologies || patient.pathologies || rawDesc;

    const _hasActeKeyword = /injection|pansement|prélèvement|perfusion|nursing|toilette|bilan|sonde|aérosol|insuline|glycémie/i;

    // Convertir les pathologies en actes NGAP lisibles
    // Fonctionne même si rawDesc = "Diabète" et patient.pathologies est vide
    const _pathoConverti = pathologies && typeof pathologiesToActes === 'function'
      ? pathologiesToActes(pathologies)
      : '';

    // Base : si rawDesc contient déjà des actes → garder tel quel
    //        sinon enrichir avec la conversion pathologies→actes
    const _texteBase = (() => {
      if (_hasActeKeyword.test(rawDesc)) return rawDesc; // déjà des actes explicites
      if (_pathoConverti && _pathoConverti !== rawDesc) {
        return rawDesc ? (rawDesc + ' — ' + _pathoConverti) : _pathoConverti;
      }
      return rawDesc || 'soin infirmier à domicile';
    })();

    // actes_recurrents prime ; on ne concatène _texteBase que s'il apporte une info nouvelle
    // (évite "insuline SC — Diabète — Injection insuline SC" → double AMI1)
    const texteForCot = actesRec
      ? actesRec  // actes_recurrents suffisent, pas besoin d'ajouter la pathologie brute
      : _texteBase;

    /* ── 3. Résoudre patient_nom + patient_id — INDISPENSABLE pour l'Historique ──
       Sans ces champs, la ligne Supabase reste avec patient_nom=null et affiche
       "?" + ID#XXX dans la colonne Patient de l'Historique des soins.
       Priorité : patient.prenom/nom (mémoire) > ficheIDB (fallback IDB).      */
    let _patNom = ((patient.prenom || '') + ' ' + (patient.nom || '')).trim();
    if (!_patNom && ficheIDB && (ficheIDB.nom || ficheIDB.prenom)) {
      _patNom = ((ficheIDB.prenom || '') + ' ' + (ficheIDB.nom || '')).trim();
      // Enrichir le patient en mémoire pour que les appels downstream l'aient aussi
      patient.nom    = patient.nom    || ficheIDB.nom    || '';
      patient.prenom = patient.prenom || ficheIDB.prenom || '';
    }
    const _patId = patient.patient_id || patient.id || null;

    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap', texte: texteForCot,
      infirmiere: ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
      adeli: u.adeli||'', rpps: u.rpps||'', structure: u.structure||'',
      date_soin: new Date().toISOString().split('T')[0],
      // ⚡ Heure RÉELLE. Priorité :
      //   1. patient._done_at : posé par liveAction('patient_done') ou markUberDone
      //      au clic "Terminer" — préservé même si autoFacturation est rappelée
      //      plus tard en batch.
      //   2. new Date() : fallback direct (auto-facturation déclenchée sans
      //      clic "Terminer" préalable).
      // Jamais patient.heure_soin / patient.heure_preferee (contrainte planifiée).
      heure_soin: patient?._done_at || new Date().toTimeString().slice(0, 5),
      _live_auto: true,
      // ⚡ Nom + ID patient → stockés dans planning_patients pour affichage dans
      // l'Historique des soins (colonne Patient). Sans ces champs, la ligne
      // remontait avec un avatar "?" et "ID #XXX" seul.
      ...(_patNom ? { patient_nom: _patNom } : {}),
      ...(_patId  ? { patient_id:  _patId  } : {}),
      preuve_soin: { type:'auto_declaration', timestamp:new Date().toISOString(), certifie_ide:true, force_probante:'STANDARD' },
    });
    return d;
  } catch(e){ console.warn('Auto-facturation: ', e.message); }
}

function updateLiveCaCard(patient, cot) {
  const card   = $('live-ca-card');
  const detail = $('live-ca-detail');
  if (!card || !detail) return;
  card.style.display = 'block';

  const total = parseFloat(cot?.total || 0);

  // Incrémenter le CA live (évite les doublons si déjà compté par _validateCotationLive)
  if (total > 0 && !patient?._caCardCounted) {
    LIVE_CA_TOTAL += total;
    patient._caCardCounted = true;
    const caEl = $('live-ca-total');
    if (caEl) { caEl.textContent = `💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`; caEl.style.display = 'block'; }
  }

  const nom = [patient?.prenom, patient?.nom].filter(Boolean).join(' ')
           || patient?.description?.slice(0, 40) || 'Soin';
  detail.innerHTML += `<div class="route-item"><div class="route-num">✅</div><div class="route-info" style="font-size:12px">${nom}</div><div class="route-km" style="color:var(--a)">${total.toFixed(2)} €</div></div>`;
}

async function recalculTournee(){
  try{
    const d=await apiCall('/webhook/ami-live',{action:'recalcul'});
    if(d.ok)await liveStatus();
  }catch(e){alert('Erreur recalcul: '+e.message);}
}

/* ============================================================
   IMPORT CALENDRIER
   ============================================================ */
function importCalendar() {
  const fileEl  = $('imp-file');
  const textEl  = $('imp-text');
  const result  = $('imp-result');
  const text    = textEl ? textEl.value.trim() : '';

  if (!result) return;

  if (fileEl && fileEl.files && fileEl.files.length > 0) {
    const file   = fileEl.files[0];
    const reader = new FileReader();
    reader.onload = e => _processImportData(e.target.result, file.name);
    reader.onerror = () => {
      result.innerHTML = '<div class="ai er">❌ Impossible de lire le fichier.</div>';
      result.classList.add('show');
    };
    reader.readAsText(file, 'UTF-8');
    return;
  }

  if (text) {
    _processImportData(text, 'texte collé');
    return;
  }

  result.innerHTML = '<div class="ai er">⚠️ Aucun fichier ou texte fourni. Déposez un fichier ou collez votre planning.</div>';
  result.classList.add('show');
}

/* ════════════════════════════════════════════════════════════════════
   PARSERS CALENDRIERS — support multi-format grand public
   ──────────────────────────────────────────────────────────────────
   Formats pris en charge :
     • ICS / iCalendar  (Google Calendar, Apple Calendar, Outlook,
                         Thunderbird, Nextcloud, ProtonCalendar,
                         Fantastical, Zimbra, Yahoo Calendar)
     • CSV              (Outlook.com, Google Calendar CSV export,
                         Excel, LibreOffice, Doctolib export)
     • JSON             (APIs, exports custom)
     • Texte libre      (copier-coller tableau, plannings Word/PDF,
                         WhatsApp, SMS)
   Chaque ligne produit un "patient" avec les champs canoniques
   exploitables par Carnet patients + Tournée IA.
   ════════════════════════════════════════════════════════════════════ */

/* Décompose une adresse brute en { street, zip, city, adresse }
   Heuristique : CP français = 5 chiffres. La rue est ce qui précède le CP,
   la ville est ce qui suit. Sans CP, split sur la virgule. */
function _parseAdresseImport(raw) {
  if (!raw || !String(raw).trim()) return { street: '', zip: '', city: '', adresse: '' };
  const s = String(raw).replace(/\s+/g, ' ').trim();
  // CP français (5 chiffres, pas précédés d'un autre chiffre)
  const cpMatch = s.match(/(?:^|[\s,;])(\d{5})(?=[\s,;]|$)/);
  let street = '', zip = '', city = '';
  if (cpMatch) {
    zip = cpMatch[1];
    const idx = s.indexOf(cpMatch[0]);
    street = s.slice(0, idx).replace(/[,;\s]+$/, '').trim();
    city   = s.slice(idx + cpMatch[0].length)
              .replace(/^[,;\s]+/, '')
              .replace(/,?\s*France\s*$/i, '')
              .trim();
  } else {
    // Pas de CP : heuristique "rue…, ville"
    const commaParts = s.split(',').map(x => x.trim()).filter(Boolean);
    if (commaParts.length >= 2) {
      street = commaParts[0];
      city   = commaParts.slice(1).join(', ').replace(/,?\s*France\s*$/i, '').trim();
    } else {
      street = s.trim();
    }
  }
  const adresse = [street, [zip, city].filter(Boolean).join(' '), 'France']
    .map(x => (x || '').trim()).filter(Boolean).join(', ');
  return { street, zip, city, adresse };
}

/* Extrait { nom, prenom } depuis un intitulé style SUMMARY ou Subject.
   Supprime les civilités (M., Mme, Dr, Monsieur, Madame, Mlle, M seul, etc.),
   détecte le mot en MAJUSCULES comme nom de famille, et prend le premier
   mot non-civilité comme prénom. */
function _extractNomPrenom(label) {
  if (!label) return { nom: '', prenom: '' };
  const CIV = /^(M\.|Mme|Mlle|Mll|Mr|Dr\.|Dr|Monsieur|Madame|Mademoiselle|Docteur|M)\s+/i;
  let clean = String(label).trim();
  // Supprimer jusqu'à 2 civilités successives ("Mme Dr DUPONT")
  for (let k = 0; k < 2 && CIV.test(clean); k++) clean = clean.replace(CIV, '').trim();
  // Couper sur séparateur type "NOM Prénom - Soin" → ne garder que "NOM Prénom"
  const sepIdx = clean.search(/\s[-—–]\s|\s:\s/);
  if (sepIdx > 0) clean = clean.slice(0, sepIdx).trim();
  const parts = clean.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return { nom: '', prenom: '' };
  if (parts.length === 1) return { nom: parts[0], prenom: '' };
  // Détecter un mot en MAJUSCULES (longueur ≥ 2 pour exclure les initiales)
  const upIdx = parts.findIndex(w => w.length > 1 && w === w.toUpperCase() && /[A-ZÀ-Ý]/.test(w));
  if (upIdx >= 0) {
    const nom    = parts[upIdx];
    const others = parts.filter((_, j) => j !== upIdx);
    return { nom, prenom: others[0] || '' };
  }
  // Pas de MAJUSCULES : convention FR "Prénom Nom"
  return { prenom: parts[0], nom: parts.slice(1).join(' ') };
}

/* Parser ICS/iCalendar — compatible RFC 5545.
   Gère :
   - Le dépliage des lignes ("line unfolding" : suite par espace/tab)
   - Les paramètres ICS (TZID=..., VALUE=...)
   - L'échappement RFC (\n, \,, \;, \\)
   - Les VEVENT avec SUMMARY, LOCATION, DTSTART, DESCRIPTION, ATTENDEE, UID */
function _parseICS(content) {
  if (!/BEGIN:VCALENDAR|BEGIN:VEVENT/i.test(content)) return null;
  // 1. Line unfolding — RFC 5545 : une ligne commençant par espace ou tab continue la précédente
  const lines = content.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');

  const unescapeIcs = (v) => String(v || '')
    .replace(/\\n/gi, '\n').replace(/\\,/g, ',')
    .replace(/\\;/g, ';').replace(/\\\\/g, '\\');

  const parseIcsDate = (raw) => {
    if (!raw) return { date: '', heure: '' };
    // Format possible : 20260422T083000Z, 20260422T083000, 20260422 (all day)
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
    if (!m) return { date: '', heure: '' };
    const date  = `${m[1]}-${m[2]}-${m[3]}`;
    const heure = m[4] ? `${m[4]}:${m[5]}` : '';
    return { date, heure };
  };

  const events = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (/^BEGIN:VEVENT$/i.test(line)) { current = {}; continue; }
    if (/^END:VEVENT$/i.test(line))   { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    // Format : KEY[;PARAM=VAL]:VALUE
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const rawKey = line.slice(0, idx);
    const value  = line.slice(idx + 1);
    const key    = rawKey.split(';')[0].toUpperCase();
    current[key] = value;
  }

  // Conversion VEVENT → patient
  return events.map((ev, i) => {
    const summary = unescapeIcs(ev.SUMMARY || '');
    const desc    = unescapeIcs(ev.DESCRIPTION || '');
    const loc     = unescapeIcs(ev.LOCATION || '');
    const { date, heure } = parseIcsDate(ev.DTSTART || '');
    const parsedAdr = _parseAdresseImport(loc);
    const { nom, prenom } = _extractNomPrenom(summary);
    return {
      id:          ev.UID || ('imp_ics_' + i),
      nom,
      prenom,
      description: summary || desc,
      texte:       summary,
      summary,
      notes:       desc,
      date_soin:   date,
      heure_soin:  heure,
      street:      parsedAdr.street,
      zip:         parsedAdr.zip,
      city:        parsedAdr.city,
      adresse:     parsedAdr.adresse || loc,
      _source:     'ics',
    };
  });
}

/* Parser CSV — compatible Outlook.com, Google Calendar CSV, Excel.
   Détecte automatiquement les colonnes par nom (Subject/Summary/Title, Location,
   Start Date, Start Time, Description…). Supporte guillemets + virgules
   échappées. */
function _parseCSV(content) {
  const firstLine = content.split(/\r?\n/)[0] || '';
  // Détection de séparateur : ; (Excel FR), , (Outlook/Google), \t (TSV)
  const sep = firstLine.includes(';') && !firstLine.includes(',')
    ? ';'
    : firstLine.includes('\t') ? '\t' : ',';

  // Parseur CSV robuste (gère les guillemets et les retours ligne dans les champs)
  const parseLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; }
      } else if (ch === sep && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };

  const rows = content.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length);
  if (rows.length < 2) return null;
  const header = parseLine(rows[0]).map(h => h.toLowerCase().trim().replace(/^"|"$/g, ''));

  // Cartographie des colonnes standard → clé canonique
  const findCol = (aliases) => header.findIndex(h => aliases.some(a => h === a || h.includes(a)));
  const colIdx = {
    subject:  findCol(['subject', 'summary', 'title', 'sujet', 'titre', 'objet', 'nom']),
    start:    findCol(['start date', 'start_date', 'date début', 'date debut', 'start']),
    stime:    findCol(['start time', 'start_time', 'heure début', 'heure debut', 'time']),
    location: findCol(['location', 'lieu', 'adresse', 'address']),
    descr:    findCol(['description', 'notes', 'note', 'commentaire', 'body']),
    attendee: findCol(['attendees', 'attendee', 'participant', 'required attendees']),
  };
  // Heuristique : si aucune colonne standard détectée → ce n'est pas un CSV calendrier
  if (colIdx.subject < 0 && colIdx.location < 0 && colIdx.descr < 0) return null;

  const norm = (v) => String(v || '').trim().replace(/^"|"$/g, '');
  const parseCsvDate = (d) => {
    if (!d) return '';
    // ISO YYYY-MM-DD
    const m1 = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
    // Format ambigu : DD/MM/YYYY (FR) ou MM/DD/YYYY (US)
    const m2 = d.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m2) {
      const a  = parseInt(m2[1], 10);
      const b  = parseInt(m2[2], 10);
      const yr = m2[3].length === 2 ? '20' + m2[3] : m2[3];
      let day, month;
      if (a > 12)      { day = a; month = b; }  // DD/MM/YYYY (jour > 12 = sûr)
      else if (b > 12) { day = b; month = a; }  // MM/DD/YYYY (jour > 12 = sûr)
      else             { day = a; month = b; }  // ambigu : FR par défaut
      return `${yr}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    return d;
  };
  const parseCsvTime = (t) => {
    if (!t) return '';
    const m = t.match(/(\d{1,2})[h:]\s*(\d{2})?/);
    return m ? `${String(m[1]).padStart(2,'0')}:${m[2] || '00'}` : '';
  };

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells  = parseLine(rows[r]);
    const subj   = colIdx.subject  >= 0 ? norm(cells[colIdx.subject])  : '';
    const loc    = colIdx.location >= 0 ? norm(cells[colIdx.location]) : '';
    const descr  = colIdx.descr    >= 0 ? norm(cells[colIdx.descr])    : '';
    const dDate  = colIdx.start    >= 0 ? parseCsvDate(norm(cells[colIdx.start])) : '';
    const dTime  = colIdx.stime    >= 0 ? parseCsvTime(norm(cells[colIdx.stime])) : '';
    if (!subj && !loc && !descr) continue; // ligne vide

    const { nom, prenom } = _extractNomPrenom(subj);

    const parsedAdr = _parseAdresseImport(loc);
    out.push({
      id:          'imp_csv_' + r,
      nom, prenom,
      description: subj || descr,
      texte:       subj,
      summary:     subj,
      notes:       descr,
      date_soin:   dDate,
      heure_soin:  dTime,
      street:      parsedAdr.street,
      zip:         parsedAdr.zip,
      city:        parsedAdr.city,
      adresse:     parsedAdr.adresse || loc,
      _source:     'csv',
    });
  }
  return out.length ? out : null;
}

function _processImportData(content, source) {
  const result = $('imp-result');
  if (!result) return;

  let patients     = [];
  let formatDetect = 'texte';

  // 1. Tentative JSON
  try {
    const parsed = JSON.parse(content);
    const found  = parsed.patients || parsed.entries || (Array.isArray(parsed) ? parsed : null);
    if (found && Array.isArray(found) && found.length) {
      patients     = found;
      formatDetect = 'json';
    }
  } catch { /* pas JSON */ }

  // 2. Tentative ICS / iCalendar (Google Calendar, Apple Calendar, Outlook, etc.)
  if (!patients.length) {
    const ics = _parseICS(content);
    if (ics && ics.length) { patients = ics; formatDetect = 'ics'; }
  }

  // 3. Tentative CSV (Outlook.com, Google Calendar CSV export, Excel)
  if (!patients.length) {
    const csv = _parseCSV(content);
    if (csv && csv.length) { patients = csv; formatDetect = 'csv'; }
  }

  // 4. Fallback texte libre (plannings copiés-collés, SMS, WhatsApp)
  if (!patients.length) {
    const lines = content.split('\n').filter(l => l.trim().length > 3);
    patients = lines.map((l, i) => {
      // Essayer d'extraire une adresse depuis la ligne (format : "Nom — 12 rue X, Ville")
      const addrMatch = l.match(/(?:—|-|:)\s*(\d+[^,\n]+(?:rue|avenue|bd|boulevard|allée|impasse|chemin|place|villa|résidence)[^,\n]*(?:,\s*\d{5}[^,\n]*)?)/i);
      const rawAdresse = addrMatch ? addrMatch[1].trim() : '';
      const parsedAdr  = _parseAdresseImport(rawAdresse);
      return {
        id:          'imp_txt_' + i,
        description: l.trim().replace(/^[-*•→]+\s*/, ''),
        texte:       l.trim(),
        heure_soin:  (l.match(/(\d{1,2})[hH:](\d{2})/) || [])[0] || '',
        street:      parsedAdr.street,
        zip:         parsedAdr.zip,
        city:        parsedAdr.city,
        adresse:     parsedAdr.adresse,
        _source:     'texte_libre',
      };
    });
    formatDetect = 'texte';
  }

  // 5. Normalisation finale : adresses alias (rue/cp/ville → street/zip/city)
  //    + adresse brute à parser si composants structurés absents
  patients = patients.map(p => {
    const street = p.street || p.rue   || '';
    const zip    = p.zip    || p.cp    || '';
    const city   = p.city   || p.ville || '';
    if (street || zip || city) {
      const adresse = [street, [zip, city].filter(Boolean).join(' '), 'France']
        .map(s => (s || '').trim()).filter(Boolean).join(', ');
      return { ...p, street, zip, city, adresse: p.adresse || adresse };
    }
    if (p.adresse) {
      const parsedAdr = _parseAdresseImport(p.adresse);
      return { ...p, ...parsedAdr };
    }
    return p;
  });

  storeImportedData({ patients, total: patients.length, source });

  // ── Auto-ajout dans le Carnet patients ────────────────────────────────────
  // Chaque patient importé avec un nom/prénom identifiable est ajouté au carnet
  // s'il n'y est pas déjà (déduplication par nom + prénom normalisés).
  // Ceci assure que Planning ↔ Carnet restent cohérents sans doublon.
  _autoAddImportedToCarnet(patients).catch(() => {});

  // Compter les patients avec adresse pour proposer le géocodage
  const withAddr    = patients.filter(p => p.adresse && p.adresse.trim()).length;
  const withStruct  = patients.filter(p => p.street && p.zip && p.city).length;
  const withGPS     = patients.filter(p => p.lat && p.lng).length;
  const missingGPS  = patients.filter(p => (!p.lat || !p.lng) && p.adresse && p.adresse.trim()).length;
  const withIdent   = patients.filter(p => (p.nom || p.prenom)).length;

  const formatLabel = {
    json:   '🗂️ JSON',
    ics:    '📅 iCalendar (Google / Apple / Outlook / Thunderbird)',
    csv:    '📊 CSV (Outlook / Google Calendar / Excel)',
    texte:  '📝 texte libre',
  }[formatDetect] || source;

  result.innerHTML = `
    <div class="ai su">
      ✅ Import réussi — ${formatLabel}<br>
      📋 <strong>${patients.length}</strong> entrée(s) chargée(s)
      ${withIdent > 0 ? `<br><span style="font-size:12px;color:var(--a)">👤 ${withIdent} patient(s) identifié(s) (nom/prénom)</span>` : ''}
      ${withStruct > 0 ? `<br><span style="font-size:12px;color:var(--a)">🏠 ${withStruct} adresse(s) complète(s) (rue + CP + ville)</span>` : ''}
      ${withGPS > 0 ? `<br><span style="font-size:12px;color:var(--a)">📍 ${withGPS} GPS déjà résolu(s)</span>` : ''}
      ${missingGPS > 0 ? `<br><span style="font-size:12px;color:var(--w)">⚠️ ${missingGPS} adresse(s) sans coordonnées GPS</span>` : ''}
      <span style="font-size:11px;color:var(--m);margin-top:4px;display:block">Allez dans <strong>Tournée IA</strong> ou <strong>Planning</strong> pour utiliser ces données.</span>
    </div>
    ${missingGPS > 0 ? `
    <div style="margin-top:10px">
      <button class="btn bv bsm" id="btn-geocode-import" onclick="geocodeImportedPatients()">
        <span>📡</span> Résoudre ${missingGPS} adresse(s) GPS
      </button>
      <span style="font-size:11px;color:var(--m);margin-left:8px">Recommandé pour optimiser la tournée</span>
    </div>` : ''}`;
  result.classList.add('show');

  /* ── WARMUP CACHE OSRM (tâche de fond, non bloquant) ──────────
     Pré-charge la matrice des temps de trajet dès l'import.
     Le calcul de la tournée sera INSTANTANÉ quand l'infirmière
     cliquera sur "Optimiser" (cache déjà chaud). */
  if (typeof warmupTravelCache === 'function') {
    const geocoded = patients.filter(p => p.lat && p.lng);
    if (geocoded.length >= 2) {
      const startPt = (typeof _getStartPoint === 'function')
        ? _getStartPoint()
        : (APP.get('userPos') || geocoded[0]);
      // fire-and-forget : ne bloque pas le flow d'import
      warmupTravelCache(geocoded, startPt).catch(() => {});
    }
  }
}

/* ============================================================
   AUTO-AJOUT AU CARNET PATIENTS — depuis Import calendrier
   ─────────────────────────────────────────────────────────
   Après chaque import, les patients identifiables (ayant un
   nom/prénom ou une description exploitable) sont ajoutés
   silencieusement dans le carnet local (IndexedDB) s'ils
   n'y sont pas déjà.
   Déduplication : normalisation nom+prénom en minuscules.
   RGPD : stockage local chiffré AES-256 — aucune transmision.
   ============================================================ */
async function _autoAddImportedToCarnet(patients) {
  // Prérequis : fonctions IDB disponibles (patients.js chargé)
  if (typeof _idbGetAll !== 'function' || typeof _idbPut !== 'function' ||
      typeof _enc !== 'function' || typeof PATIENTS_STORE === 'undefined') return;

  try {
    // Charger le carnet existant pour déduplication
    const rows = await _idbGetAll(PATIENTS_STORE);
    // Index de normalisation : "prénom nom" → true
    const existIndex = new Set(
      rows.map(r => {
        const d = (typeof _dec === 'function') ? (_dec(r._data) || {}) : {};
        return _normalizePatientKey(r.nom, r.prenom, d);
      }).filter(Boolean)
    );

    let added = 0;
    for (const p of patients) {
      // Extraire nom / prénom depuis les différents formats possibles
      let nom    = p.nom    || '';
      let prenom = p.prenom || '';

      // Fallback : essayer de décomposer la description (ex: "Marie DUPONT — soins")
      if (!nom && !prenom && (p.description || p.texte)) {
        const raw = (p.description || p.texte || '').split(/[—\-–:,]/)[0].trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          // Convention : MAJUSCULE = nom de famille, première lettre maj = prénom
          const uppercaseIdx = parts.findIndex(w => w === w.toUpperCase() && w.length > 1);
          if (uppercaseIdx > 0) {
            nom    = parts.slice(uppercaseIdx).join(' ');
            prenom = parts.slice(0, uppercaseIdx).join(' ');
          } else {
            prenom = parts[0];
            nom    = parts.slice(1).join(' ');
          }
        }
      }

      // Ne pas créer de fiche sans nom exploitable
      if (!nom.trim() && !prenom.trim()) continue;

      const key = _normalizePatientKey(nom, prenom, p);
      if (!key || existIndex.has(key)) continue; // déjà dans le carnet

      // Construire la fiche avec TOUS les champs canoniques (schéma savePatient)
      // Les champs absents du calendrier sont initialisés vides mais présents,
      // pour garantir cohérence lors de l'édition manuelle ultérieure.
      const street = p.street || p.rue   || '';
      const zip    = p.zip    || p.cp    || '';
      const city   = p.city   || p.ville || '';
      const address        = [street, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const addressFull    = [street, [zip, city].filter(Boolean).join(' '), 'France']
        .map(s => (s || '').trim()).filter(Boolean).join(', ');

      const fiche = {
        // Identité
        nom:               nom.trim(),
        prenom:            prenom.trim(),
        ddn:               p.ddn    || p.date_naissance || '',
        secu:              p.secu   || '',
        // Adresse structurée (3 champs canoniques) + aliases
        street,
        zip,
        city,
        address,
        addressFull,
        adresse:           p.adresse || addressFull || '',
        lat:               p.lat    || null,
        lng:               p.lng    || null,
        // Couverture
        amo:               p.amo    || '',
        amc:               p.amc    || '',
        exo:               p.exo    || '',
        // Médical
        medecin:           p.medecin       || '',
        allergies:         p.allergies     || '',
        pathologies:       p.pathologies   || '',
        traitements:       p.traitements   || '',
        actes_recurrents:  p.actes_recurrents || '',
        ordo_date:         p.ordo_date     || '',
        // Contact urgence (le tél calendrier est rattaché ici à défaut d'un champ tél patient dédié)
        contact_nom:       p.contact_nom   || '',
        contact_tel:       p.contact_tel   || p.telephone || p.tel || '',
        // Agenda
        heure_preferee:    p.heure_preferee || p.heure_soin || '',
        respecter_horaire: !!p.respecter_horaire,
        // Notes libres — description ICS/calendrier conservée ici si disponible
        notes:             p.notes || p.description || '',
        // Collections liées (initialisées vides pour cohérence)
        ordonnances:       [],
        cotations:         [],
        // Métadonnées
        _enc:              true,
        _source:           'import_calendrier',
        created_at:        new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      };

      const id = p.patient_id || p.id || ('imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      const _tsImp = { id, nom: fiche.nom, prenom: fiche.prenom, _data: _enc(fiche), updated_at: fiche.updated_at };
      await _idbPut(PATIENTS_STORE, _tsImp);
      if (typeof _syncPatientNow === 'function') _syncPatientNow(_tsImp).catch(() => {});

      existIndex.add(key); // évite les doublons dans la même passe
      added++;
    }

    if (added > 0) {
      console.info(`[AMI] ${added} patient(s) ajouté(s) au carnet depuis l'import.`);
      if (typeof showToast === 'function')
        showToast(`📋 ${added} nouveau(x) patient(s) ajouté(s) au Carnet.`);
      // Sync carnet vers le serveur si disponible
      if (typeof syncPatientsToServer === 'function')
        setTimeout(() => syncPatientsToServer().catch(() => {}), 1000);
    }
  } catch (e) {
    console.warn('[AMI] Auto-ajout carnet KO:', e.message);
  }
}

/* Clé de normalisation pour déduplication (insensible à la casse/accents) */
function _normalizePatientKey(nom, prenom, extra) {
  const n = String(nom || extra?.nom || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const p = String(prenom || extra?.prenom || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!n && !p) return null;
  return `${p}__${n}`;
}

/* ============================================================
   GÉOCODAGE POST-IMPORT
   Résout les adresses manquantes après un import ICS/CSV/texte.
   Utilise Nominatim (OpenStreetMap) — 1 req/s max.
   ============================================================ */
async function geocodeImportedPatients() {
  const btn = $('btn-geocode-import');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span> Géocodage…'; }

  const data     = APP.importedData;
  if (!data || !data.patients || !data.patients.length) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>📡</span> Résoudre les adresses GPS'; }
    return;
  }

  const patients = [...data.patients];
  let geocoded = 0, failed = 0;

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    // Sauter si déjà géocodé ou pas d'adresse
    if ((p.lat && p.lng) || !p.adresse || !p.adresse.trim()) continue;

    if (btn) btn.innerHTML = `<span>📡</span> ${i + 1}/${patients.length}…`;

    try {
      const q   = encodeURIComponent(p.adresse.trim());
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
        headers: { 'Accept-Language': 'fr', 'User-Agent': 'AMI-NGAP/6.1' },
      });
      const data = await res.json();
      if (data && data[0]) {
        patients[i] = { ...p, lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        geocoded++;
      } else {
        failed++;
      }
    } catch { failed++; }

    // Respecter rate-limit Nominatim : 1 req/s
    if (i < patients.length - 1) await new Promise(r => setTimeout(r, 1100));
  }

  storeImportedData({ ...APP.importedData, patients, total: patients.length });

  const msg = `✅ ${geocoded} GPS résolu(s)${failed > 0 ? ` · ⚠️ ${failed} non trouvé(s)` : ''}`;
  showToastSafe(msg);

  if (btn) {
    btn.disabled  = false;
    btn.innerHTML = `<span>✅</span> ${msg}`;
    btn.style.background = 'var(--a)';
  }
}

/* ============================================================
   MODE IA PLANNING
   ============================================================ */
function modeAI(mode) {
  if (mode === 'planning') {
    const txtEl = $('pl-txt');
    const texte = txtEl ? txtEl.value.trim() : '';

    // Masquer erreur précédente
    const perr = $('perr');
    if (perr) perr.style.display = 'none';

    if (!texte) {
      if (perr) { $('perr-m').textContent = 'Saisissez des informations patients avant de générer le planning (ex: "Patient A : injection 2x/jour").'; perr.style.display = 'flex'; }
      return;
    }

    // Parser le texte comme des patients
    const lines = texte.split('\n').filter(l => l.trim());
    const patients = lines.map((l, i) => ({
      id: 'manual_' + i,
      description: l.trim(),
      texte: l.trim(),
    }));

    // Stocker temporairement et générer
    if (!APP.importedData) {
      APP.importedData = { patients, total: patients.length, source: 'saisie manuelle' };
    } else {
      // Fusionner avec import existant
      APP.importedData.patients = [...(APP.importedData.patients || []), ...patients];
    }

    generatePlanningFromImport();
  }
}

/* ============================================================
   STOP JOURNÉE (terminer la tournée)
   ============================================================ */
function stopDay() {
  if (!confirm('Terminer la tournée du jour ?\n\nLe chronomètre sera arrêté et la journée sera clôturée.')) return;
  _stopDayInternal();
}

/* Version interne sans confirm — appelée par terminerTourneeAvecBilan
   caOverride : CA déjà calculé par terminerTourneeAvecBilan (évite le double-calcul à 0) */
function _stopDayInternal(caOverride) {
  // Arrêter le timer
  if (LIVE_TIMER_ID) { clearInterval(LIVE_TIMER_ID); LIVE_TIMER_ID = null; }

  // allPatients déclaré ici pour être accessible partout dans la fonction (sync, etc.)
  const allPatients = APP.get('uberPatients') || APP.importedData?.patients || APP.importedData?.entries || [];

  let caFinal = 0;

  if (caOverride != null && parseFloat(caOverride) > 0) {
    // CA fourni par terminerTourneeAvecBilan — cotations déjà calculées, on l'utilise directement
    caFinal = parseFloat(caOverride);
  } else {
    // Calcul autonome (stopDay simple sans bilan)
    const caFromCotations = allPatients.reduce((s, p) => s + parseFloat(p._cotation?.total || 0), 0);
    // Fallback : CA estimé des patients marqués done (p.done) OU _done (mode live pilotage)
    const caFromAmounts = caFromCotations === 0
      ? allPatients.filter(p => p.done || p._done).reduce((s, p) => s + parseFloat(p.amount || 0), 0)
      : 0;
    // Fallback ultime : tous les patients (aucun marqué done) — cas d'arrêt prématuré
    const caFromAll = (caFromCotations === 0 && caFromAmounts === 0)
      ? allPatients.reduce((s, p) => s + parseFloat(p.amount || 0), 0)
      : 0;
    caFinal = Math.max(LIVE_CA_TOTAL, caFromCotations, caFromAmounts, caFromAll);
  }

  // Rattrapage : sync uniquement les cotations IDB des jours précédents non encore envoyées
  // (skipIDB=false ici car c'est le seul passage qui peut rattraper les cotations manquées)
  // Les cotations du jour viennent d'être synced individuellement dans _validateCotationLive
  _syncCotationsToSupabase([], { skipIDB: false }).catch(() => {});

  // Reset badge
  const badge = $('live-badge');
  if (badge) { badge.textContent = 'TERMINÉE'; badge.style.background = 'rgba(34,197,94,.15)'; badge.style.color = '#22c55e'; }

  $('live-patient-name').textContent = 'Tournée terminée ✅';
  $('live-info').textContent = `🏁 Bonne fin de journée ! CA total : ${caFinal.toFixed(2)} €`;
  $('live-controls').style.display = 'none';

  const btnStart = $('btn-live-start');
  const btnStop  = $('btn-live-stop');
  if (btnStart) btnStart.style.display = 'inline-flex';
  if (btnStop)  btnStop.style.display  = 'none';

  const caEl = $('live-ca-total');
  if (caEl) { caEl.textContent = `💶 CA journée clôturée : ${caFinal.toFixed(2)} €`; caEl.style.display = 'block'; }

  // Persister le CA final en sessionStorage pour survivre au changement de page
  try { sessionStorage.setItem('ami_ca_journee', caFinal.toFixed(2)); } catch {}

  // Reset CA pour prochaine journée
  LIVE_CA_TOTAL = 0;

  if (typeof showToast === 'function') showToast(`🏁 Tournée terminée · CA : ${caFinal.toFixed(2)} €`);
}

/* ============================================================
   RECOMMANDATIONS NGAP TEMPS RÉEL (live input)
   ============================================================ */
function analyzeLive(texte) {
  const t = texte.toLowerCase();
  const recos = [];

  if ((t.includes('domicile') || t.includes('chez')) && !t.includes('ifd'))
    recos.push({ type: 'gain', msg: 'Ajouter IFD — indemnité déplacement (+2,75 €)', gain: 2.75 });

  const kmMatch = t.match(/(\d+)\s*km/);
  if (kmMatch && !t.includes(' ik'))
    recos.push({ type: 'gain', msg: `Ajouter IK — ${kmMatch[1]} km (+${(parseInt(kmMatch[1])*0.35).toFixed(2)} €)`, gain: parseInt(kmMatch[1])*0.35 });

  if ((t.includes('22h') || t.includes('23h') || t.includes('0h') || t.includes('1h') || t.includes('2h') || t.includes('3h') || t.includes('4h') || t.includes('5h') || t.includes('6h') || t.includes('7h')) && !t.includes('nuit') && !t.includes('mn'))
    recos.push({ type: 'gain', msg: 'Majoration nuit possible (+9,15 €)', gain: 9.15 });

  if (t.includes('dimanche') && !t.includes('md'))
    recos.push({ type: 'gain', msg: 'Majoration dimanche possible (+9,15 €)', gain: 9.15 });

  if (t.includes('injection') && !t.includes('ami'))
    recos.push({ type: 'info', msg: 'Acte AMI1 probable (injection SC/IM — 3,15 €)', gain: 0 });

  if (t.includes('ald') && !t.includes('exo'))
    recos.push({ type: 'warn', msg: 'Patient ALD détecté — penser à cocher exonération', gain: 0 });

  return recos;
}

function renderLiveReco(texte) {
  const el = $('live-reco');
  if (!el) return;
  const recos = analyzeLive(texte);
  if (!recos.length) { el.innerHTML = ''; el.style.display = 'none'; return; }

  const totalGain = recos.reduce((s, r) => s + (r.gain||0), 0);
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px">💡 Suggestions NGAP</div>
    ${recos.map(r => `<div style="padding:5px 8px;border-radius:6px;margin:3px 0;font-size:12px;background:${r.type==='gain'?'rgba(34,197,94,.08)':r.type==='warn'?'rgba(255,180,0,.1)':'rgba(79,168,255,.08)'};border:1px solid ${r.type==='gain'?'rgba(34,197,94,.2)':r.type==='warn'?'rgba(255,180,0,.2)':'rgba(79,168,255,.2)'}">
      ${r.type==='gain'?'💰':r.type==='warn'?'⚠️':'💡'} ${r.msg}
    </div>`).join('')}
    ${totalGain > 0 ? `<div style="font-size:11px;color:var(--a);margin-top:6px;font-family:var(--fm)">💶 Gain potentiel : +${totalGain.toFixed(2)} €</div>` : ''}
  `;
}

/* ============================================================
   AUTO-COTATION LOCALE (réponse immédiate sans réseau)
   ============================================================ */
function autoCotationLocale(texte) {
  // Fallback local — déclenché si l'API N8N est indisponible.
  // Enrichit d'abord le texte si c'est une pathologie brute sans actes NGAP.
  const _hasActeKeyword = /injection|pansement|prélèvement|perfusion|nursing|toilette|bilan|sonde|aérosol|insuline|glycémie/i;
  let texteEnrichi = texte;
  if (texte && !_hasActeKeyword.test(texte) && typeof pathologiesToActes === 'function') {
    const conv = pathologiesToActes(texte);
    if (conv && conv !== texte) texteEnrichi = texte + ' — ' + conv;
  }
  const t = texteEnrichi.toLowerCase();
  const actes = []; let total = 0;

  // ── Actes techniques ──
  if (/injection|insuline|piquer|hbpm|lovenox|fragmine|anticoagul|sc|im/.test(t)) {
    actes.push({ code:'AMI1', nom:'Injection SC/IM', total:3.15 }); total += 3.15;
  }
  if (/perfusion|baxter|chambre implantable|\bpicc\b|midline|diffuseur|perf\b|intraveineux|iv\b|antibio|chimio/.test(t)) {
    const _isCancerCtx = /cancer|canc[éé]reux|chimio|immunod[eé]prim|mucoviscidose/.test(t);
    const _isRetrait   = /(retrait|retir[eé])\s+(d[eé]finiti|du\s+dispositif|de\s+(la\s+)?(picc|midline|chambre|perfusion))|d[eé]branchement\s+d[eé]finiti|fin\s+de\s+(traitement|chimio|perfusion)/.test(t);
    const _is2ePassage = /(changement\s+(?:de\s+)?flacon|rebranche|rebranchement|2\s*[èe]?me?\s+perfusion|deuxi[èe]me\s+perfusion|branchement\s+en\s+y|changement\s+de\s+baxter)/.test(t);
    const _isCourte    = /(perfusion\s+courte|perfusion\s+[≤<=]\s*1\s*h|perfusion\s+(30|45|60)\s*min|perfusion\s+d['eu]?\s*(une?\s+)?demi\s*[-\s]?heure|perfusion\s+inf[eé]rieure?\s+[aà]\s+(une?\s+heure|1\s*h))/.test(t);

    if (_isRetrait) {
      actes.push({ code:'AMI5', nom:'Retrait définitif dispositif ≥24h', total:15.75 }); total += 15.75;
    } else if (_is2ePassage) {
      actes.push({ code:'AMI4_1', nom:'Changement flacon / 2e branchement même jour', total:6.30 }); total += 6.30;
    } else if (_isCourte) {
      if (_isCancerCtx) { actes.push({ code:'AMI10', nom:'Perfusion courte ≤1h — immunodéprimé/cancéreux', total:31.50 }); total += 31.50; }
      else              { actes.push({ code:'AMI9',  nom:'Perfusion courte ≤1h sous surveillance', total:28.35 }); total += 28.35; }
    } else {
      if (_isCancerCtx) { actes.push({ code:'AMI15', nom:'Forfait perfusion longue — immunodéprimé/cancéreux (1x/jour)', total:47.25 }); total += 47.25; }
      else              { actes.push({ code:'AMI14', nom:'Forfait perfusion longue >1h (1x/jour)', total:44.10 }); total += 44.10; }
    }
  } else if (/pansement.*(complexe|escarre|n[eé]crose|chirurgical|plaie)|escarre|ulc[eè]re|d[eé]tersion/.test(t)) {
    actes.push({ code:'AMI4', nom:'Pansement complexe', total:12.60 }); total += 12.60;
  } else if (/pansement|plaie/.test(t)) {
    actes.push({ code:'AMI1', nom:'Pansement simple', total:3.15 }); total += 3.15;
  }
  if (/pr[eé]l[eè]vement|prise de sang|bilan sanguin|glyc[eé]mie capillaire/.test(t)) {
    actes.push({ code:'AMI1', nom:'Prélèvement/Glycémie capillaire', total:3.15 }); total += 3.15;
  }
  if (/a[eé]rosol|n[eé]buli/.test(t)) {
    actes.push({ code:'AMI2', nom:'Aérosol médicamenteux', total:6.30 }); total += 6.30;
  }
  if (/ecg|[eé]lectrocardiogramme/.test(t)) {
    actes.push({ code:'AMI3', nom:'ECG', total:9.45 }); total += 9.45;
  }

  // ── Bilans soins infirmiers ──
  if (/nursing complet|bsc|d[eé]pendance lourde|grabataire/.test(t)) {
    actes.push({ code:'BSC', nom:'BSC — Dépendance lourde', total:28.70 }); total += 28.70;
  } else if (/bsb|d[eé]pendance mod/.test(t)) {
    actes.push({ code:'BSB', nom:'BSB — Dépendance modérée', total:18.20 }); total += 18.20;
  } else if (/toilette|nursing|bsa|aide.{0,20}toilette/.test(t)) {
    actes.push({ code:'BSA', nom:'BSA — Aide à la toilette', total:13.00 }); total += 13.00;
  }

  // ── Majorations ──
  if (/domicile|chez le patient|ifd/.test(t)) {
    actes.push({ code:'IFD', nom:'Déplacement domicile', total:2.75 }); total += 2.75;
  }
  // Dimanche / Férié — détecté depuis le texte OU depuis la date actuelle
  const _isDimanche = /dimanche|f[eé]ri[eé]|dim\b/.test(t) || new Date().getDay() === 0;
  const _isNuitProf = /(?:23h|00h|01h|02h|03h|04h|nuit profonde|nuit_prof)/.test(t);
  const _isNuit     = !_isNuitProf && /(?:20h|21h|22h|05h|06h|07h|\bnuit\b)/.test(t);
  if (_isDimanche) {
    actes.push({ code:'DIM', nom:'Majoration dimanche/férié', total:8.50 }); total += 8.50;
  } else if (_isNuitProf) {
    actes.push({ code:'NUIT_PROF', nom:'Majoration nuit profonde', total:18.30 }); total += 18.30;
  } else if (_isNuit) {
    actes.push({ code:'NUIT', nom:'Majoration nuit', total:9.15 }); total += 9.15;
  }
  if (/enfant|nourrisson|< ?7 ?ans|mie/.test(t)) {
    actes.push({ code:'MIE', nom:'Majoration enfant', total:3.15 }); total += 3.15;
  }
  if (/coordination|mci/.test(t)) {
    actes.push({ code:'MCI', nom:'Majoration coordination', total:5.00 }); total += 5.00;
  }
  const kmM = t.match(/(\d+)\s*km/);
  if (kmM) {
    const ik = Math.round(parseInt(kmM[1]) * 2 * 0.35 * 100) / 100;
    actes.push({ code:'IK', nom:`Indemnité kilométrique (${kmM[1]} km)`, total: ik }); total += ik;
  }

  // Filet de sécurité : si aucun acte détecté mais texte non vide → AMI1 par défaut
  if (!actes.length && t.trim()) {
    actes.push({ code:'AMI1', nom:'Acte infirmier (à préciser)', total:3.15 }); total += 3.15;
  }

  return { actes, total: Math.round(total*100)/100, source:'local_fallback' };
}

/* Patch startDay pour démarrer timer + optimisation live */
const _origStartDay=window.startDay||(()=>{});
window.startDay=async function(){
  // Tenter de restaurer depuis localStorage si importedData est vide
  if (!APP.importedData?.patients?.length && !APP.importedData?.entries?.length) {
    if (typeof _restorePlanningIfNeeded === 'function') _restorePlanningIfNeeded();
  }
  // Bloquer si les données viennent uniquement du planning hebdomadaire (pas d'import tournée)
  if (APP.importedData?._planningOnly) {
    if(typeof showToast==='function') showToast('⚠️ Importez des patients via Import calendrier ou Carnet patients pour démarrer la tournée.');
    return;
  }
  // Fallback : utiliser uberPatients déjà chargés par loadUberPatients()
  let patients = APP.importedData?.patients || APP.importedData?.entries || [];
  if (!patients.length) {
    const uber = APP.get('uberPatients') || [];
    if (uber.length) {
      // Reconstruire importedData depuis uberPatients
      APP.importedData = { patients: uber, total: uber.length, source: 'uber_fallback' };
      patients = uber;
    }
  }
  if (!patients.length) {
    if(typeof showToast==='function') showToast('⚠️ Importez des patients avant de démarrer la journée.');
    return;
  }
  // Reset état des patients + CA persisté pour une nouvelle journée
  patients.forEach(p => { p._done=false; p._absent=false; });
  try { sessionStorage.removeItem('ami_ca_journee'); } catch {}

  startLiveTimer();
  // live-controls reste caché (IDs fantômes — live-next géré via uber-next-patient)
  const el=$('live-badge');
  if(el){el.textContent='EN COURS';el.style.background='var(--ad)';el.style.color='var(--a)';}
  const btnStart=$('btn-live-start');
  if(btnStart) btnStart.style.display='none';
  // Afficher bouton "Terminer la tournée"
  const btnStop = $('btn-live-stop');
  if (btnStop) btnStop.style.display = 'inline-flex';
  // live-controls reste caché — live-next géré uniquement via uber-next-patient

  /* ── Initialiser le premier patient actif ────────────────────
     ⚠️ Priorité à l'ordre uberPatients (ordre optimisé IA) quand il existe,
     sinon fallback ordre importedData (ordre d'import brut).
     Sans ça, après optimisation de la tournée, l'UI affichait brièvement
     le mauvais patient en tête (ordre d'import) avant que
     renderLivePatientList ne remette l'ordre optimisé.

     ⚠️ ORDRE CRITIQUE : on DIFFÈRE l'APP.set('nextPatient', firstP) après
     renderLivePatientList() (plus bas) car les deux écrivent dans le même
     élément #uber-next-patient. Si on set nextPatient ici, _renderNextPatient
     écrirait la card → puis renderLivePatientList l'écraserait avec la liste
     → l'utilisateur verrait la liste pendant ~5s avant que le throttle GPS
     ne remette la card. D'où le délai signalé au démarrage. */
  const _uberForFirst = APP.get('uberPatients') || [];
  const _ordered = _uberForFirst.length ? _uberForFirst : patients;
  const firstP = _ordered[0];
  if(firstP){
    LIVE_PATIENT_ID = firstP.patient_id || firstP.id || null;
    $('live-patient-name').textContent = firstP.description||firstP.texte||firstP.label||'Premier patient';
    $('live-info').textContent = `Soin 1/${_ordered.length}${firstP.heure_soin?' · '+firstP.heure_soin:''}`;
    // ⚠️ APP.set('nextPatient', firstP) déplacé après renderLivePatientList — voir bloc final
  }

  /* ── Synchroniser uberPatients depuis importedData si pas déjà peuplé ── */
  const uberCurrent = APP.get('uberPatients') || [];
  if (!uberCurrent.length && patients.length) {
    APP.set('uberPatients', patients.map((p, i) => ({
      ...p,
      id:      p.patient_id || p.id || i,
      label:   p.description || p.texte || 'Patient ' + (i + 1),
      done:    false, absent: false, late: false,
      urgence: !!(p.urgent || p.urgence),
      time:    p.heure_soin ? (function(h){ const [hh,mm]=(h||'').split(':').map(Number); const t=new Date(); t.setHours(hh||0,mm||0,0,0); return t.getTime(); })(p.heure_soin) : null,
      amount:  parseFloat(p.total || p.montant || p.amount || 0) || (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 6.30),
    })));
  }

  /* ── WARMUP CACHE OSRM (tâche de fond, non bloquant) ─────────
     Pré-charge la matrice des temps de trajet dès le démarrage.
     Quand l'infirmière cliquera sur "Optimiser la tournée",
     le calcul sera INSTANTANÉ (cache L1/L2 déjà chaud). */
  if (typeof warmupTravelCache === 'function') {
    const geocoded = patients.filter(p => p.lat && p.lng);
    if (geocoded.length >= 2) {
      const startPt = (typeof _getStartPoint === 'function')
        ? _getStartPoint()
        : (APP.get('userPos') || geocoded[0]);
      // fire-and-forget : ne bloque jamais le démarrage de journée
      warmupTravelCache(geocoded, startPt).catch(() => {});
    }
  }

  /* ── Démarrer le moteur IA temps réel ── */
  if(typeof startLiveOptimization==='function') startLiveOptimization();

  /* ⚡ Afficher le prochain patient en publiant nextPatient dans le store.
     Le listener APP.on('nextPatient') déclenche _renderNextPatient (uber.js)
     qui met à jour le header + appelle renderLivePatientList (seule source
     de vérité visuelle pour #uber-next-patient). */
  if (firstP && typeof APP.set === 'function') {
    APP.set('nextPatient', firstP);
  } else {
    // Si pas de firstP (cas limite), déclencher quand même le rendu initial
    renderLivePatientList();
  }

  // Tenter appel API, mais ne pas bloquer si indisponible
  liveStatusCore().catch(()=>{});
};

/* liveStatusCore = contenu de liveStatus original */
async function liveStatusCore(){
  try{
    const d=await apiCall('/webhook/ami-live',{action:'get_status'});
    if(!d.ok)return;
    if(d.prochain){
      let actes=[];try{actes=JSON.parse(d.prochain.actes||'[]');}catch{}
      const desc=actes[0]?.nom||'Soin';
      LIVE_PATIENT_ID=d.prochain.patient_id;

      /* Chercher l'heure dans les données locales si l'API ne la retourne pas
         (cas migration SQL incomplète — colonne heure_soin absente en base) */
      const patients = APP.importedData?.patients || APP.importedData?.entries || [];
      const localP = patients.find(p => p.patient_id === d.prochain.patient_id || p.id === d.prochain.patient_id);
      const heure = d.prochain.heure_soin || localP?.heure_soin || localP?.heure_preferee || localP?.heure || '';
      const nomPatient = ((localP?.nom||'') + ' ' + (localP?.prenom||'')).trim() || localP?.description || desc;

      $('live-patient-name').textContent = nomPatient;
      $('live-info').textContent = heure ? `Prochain patient · ⏰ ${heure}` : 'Prochain patient';
      $('live-next').innerHTML=`<div class="card"><div class="ct">📋 Patients restants</div><div class="ai in">📍 ${d.patients_restants} patient(s) restant(s) aujourd'hui</div></div>`;
      detectDelay({...d.prochain, heure_soin: heure});
    }else{
      $('live-patient-name').textContent='Tournée terminée ✅';
      $('live-info').textContent='Tous les patients ont été vus';
      $('live-next').innerHTML='<div class="card"><div class="ai su">✅ Journée terminée ! Tous les patients ont été pris en charge.</div></div>';
    }
    if(LIVE_START_TIME){
      $('live-ca-total').textContent=`💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`;
      $('live-ca-total').style.display='block';
    }
  }catch(e){console.error(e);}
}

/* Patch liveAction pour auto-facturation + modale cotation */
const _origLiveActionFn=window.liveAction;
window.liveAction=async function(action){
  const patients=APP.importedData?.patients||APP.importedData?.entries||[];

  if(action==='patient_done'){
    /* ── Trouver le patient actif ── */
    let activeP = null;
    if(LIVE_PATIENT_ID){
      activeP = patients.find(x=>x.patient_id===LIVE_PATIENT_ID||(String(x.id)===String(LIVE_PATIENT_ID)));
    }
    if(!activeP){
      // Prendre le premier patient non-traité
      activeP = patients.find(x => !x._done && !x._absent);
    }
    if(activeP){
      // Marquer comme fait
      activeP._done = true;
      // ⚡ Mémoriser l'heure RÉELLE du clic "Terminer" (cohérent avec markUberDone).
      // Sert d'ancre pour autoFacturation + tout rattrapage ultérieur en batch
      // depuis terminerTourneeAvecBilan ("Clôturer la journée").
      activeP._done_at     = new Date().toTimeString().slice(0, 5);
      activeP._done_at_iso = new Date().toISOString();
      // Auto-facturation CA
      const cot = await autoFacturation(activeP);
      // Cotation locale en fallback si API indisponible
      // Enrichir le texte du fallback local avec pathologiesToActes()
      // Fonctionne même si description = "Diabète" et pathologies est vide
      const _cotLocalDesc = (() => {
        const raw   = (activeP.description || activeP.texte || '').trim();
        const patho = activeP.pathologies || raw; // utiliser rawDesc si pathologies vide
        const conv  = patho && typeof pathologiesToActes === 'function' ? pathologiesToActes(patho) : '';
        const hasActe = /injection|pansement|perfusion|nursing|insuline|prélèvement|glycémie/i.test(raw);
        if (hasActe) return raw;
        return (conv && conv !== raw) ? (raw ? raw + ' — ' + conv : conv) : (raw || 'soin infirmier à domicile');
      })();
      const cotLocal = autoCotationLocale(_cotLocalDesc);
      const cotAffichee = (cot && cot.actes?.length) ? cot : cotLocal;
      // ⚡ Propager l'heure RÉELLE (_done_at) dans _cotation._heure_reelle AVANT
      // d'ouvrir la modale. Ainsi, si l'utilisatrice clique "Valider" plus tard
      // (heures voire jours après le clic "Terminer"), _validateCotationLive
      // préservera l'ancre d'origine au lieu de capturer l'heure du clic "Valider".
      activeP._cotation = {
        ...(activeP._cotation || {}),
        actes:         cotAffichee.actes || [],
        total:         parseFloat(cotAffichee.total || 0),
        auto:          true,
        _heure_reelle: activeP._done_at,
      };
      // Afficher la modale de cotation
      showCotationModal(activeP, cotAffichee);
      // Avancer au patient suivant
      const nextP = patients.find(x => !x._done && !x._absent);
      if(nextP){
        LIVE_PATIENT_ID = nextP.patient_id || nextP.id || null;
        $('live-patient-name').textContent = nextP.description||nextP.texte||'Prochain patient';
        $('live-info').textContent = `Prochain soin${nextP.heure_soin?' à '+nextP.heure_soin:''}`;
      }else{
        $('live-patient-name').textContent = 'Tournée terminée ✅';
        $('live-info').textContent = 'Tous les patients ont été pris en charge';
      }
      renderLivePatientList();
    }else{
      if(typeof showToast==='function') showToast('ℹ️ Aucun patient actif.');
    }
    return;
  }

  if(action==='patient_absent'){
    let activeP = patients.find(x=>x.patient_id===LIVE_PATIENT_ID||(String(x.id)===String(LIVE_PATIENT_ID)));
    if(!activeP) activeP = patients.find(x => !x._done && !x._absent);
    if(activeP){
      activeP._absent = true;
      const nextP = patients.find(x => !x._done && !x._absent);
      if(nextP){
        LIVE_PATIENT_ID = nextP.patient_id || nextP.id || null;
        $('live-patient-name').textContent = nextP.description||nextP.texte||'Prochain patient';
        $('live-info').textContent = `Prochain soin${nextP.heure_soin?' à '+nextP.heure_soin:''}`;
      }
      renderLivePatientList();
      if(typeof showToast==='function') showToast('❌ Patient absent noté.');
    }
    return;
  }

  // Appel API pour autres actions (get_status, recalcul…)
  try{
    const d=await apiCall('/webhook/ami-live',{action,patient_id:LIVE_PATIENT_ID||''});
    if(d.suggestion)showToast?showToast('💡 '+d.suggestion):alert('💡 '+d.suggestion);
    await liveStatusCore();
  }catch(e){
    // Pas d'alert bloquant si API indisponible — afficher le statut local
    renderLivePatientList();
  }
};

/* ============================================================
   LISTE PATIENTS PILOTAGE — Affichage local avec état
   ============================================================ */
function renderLivePatientList() {
  // Fusionner importedData + uberPatients pour avoir les statuts à jour des deux modes
  const imported = APP.importedData?.patients || APP.importedData?.entries || [];
  const uber = APP.get('uberPatients') || [];

  // Construire un index uberPatients par id/patient_id pour synchroniser les statuts
  const uberIndex = {};
  uber.forEach(p => {
    const k = p.patient_id || p.id;
    if (k) uberIndex[String(k)] = p;
  });

  // Patients de référence = importedData si disponible, sinon uberPatients
  const base = imported.length ? imported : uber;
  const patients = base.map(p => {
    const k = String(p.patient_id || p.id || '');
    const u = uberIndex[k] || {};
    return {
      ...p,
      _done:   p._done   || p.done   || u._done   || u.done   || false,
      _absent: p._absent || p.absent || u._absent || u.absent || false,
      amount:  p.amount  || u.amount  || 0,
      _cotation: p._cotation || u._cotation,
    };
  });

  // ── Réordonner pour que la liste suive l'ordre uber (sélection GPS temps réel) ──
  // nextPatient en tête des restants, puis ordre uberPatients, puis done/absent en bas.
  const nextPat = APP.get('nextPatient');
  const nextKey = nextPat ? String(nextPat.patient_id || nextPat.id || '') : '';

  const uberOrder = {};
  uber.forEach((p, i) => {
    const k = String(p.patient_id || p.id || '');
    if (k) uberOrder[k] = i;
  });

  const restants = patients.filter(p => !p._done && !p._absent);
  const termines = patients.filter(p => p._done || p._absent);

  restants.sort((a, b) => {
    const ka = String(a.patient_id || a.id || '');
    const kb = String(b.patient_id || b.id || '');
    if (ka === nextKey) return -1;
    if (kb === nextKey) return 1;
    return (uberOrder[ka] ?? 9999) - (uberOrder[kb] ?? 9999);
  });

  const orderedPatients = [...restants, ...termines];

  // ── Filtre IDE : chaque infirmière ne voit que ses patients assignés ──
  // Actif uniquement si des assignations existent (cabinet multi-IDE).
  // Les admins voient toujours tout.
  const _ideAssnLive = (typeof APP !== 'undefined') ? (APP._ideAssignments || {}) : {};
  const _hasAssnLive = Object.values(_ideAssnLive).some(arr => arr?.length > 0);
  let displayPatients = orderedPatients;
  if (_hasAssnLive) {
    const _myIdLive    = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
    const _isAdminLive = (typeof S !== 'undefined') && S?.role === 'admin';
    if (_myIdLive && !_isAdminLive) {
      const _myFiltered = orderedPatients.filter(p => {
        const pk = String(p.patient_id || p.id || '');
        return (_ideAssnLive[pk] || []).some(a => a.id === _myIdLive);
      });
      if (_myFiltered.length > 0) displayPatients = _myFiltered;
    }
  }

  // Écrire uniquement dans uber-next-patient (visible) — live-next reste caché (compat fantôme)
  const el = $('uber-next-patient');
  if (!el) return;

  if (!displayPatients.length) {
    el.innerHTML = `<div class="card">
      <div class="ai wa">⚠️ Aucun patient importé. Allez dans <strong>Import calendrier</strong> ou <strong>Tournée IA</strong> pour importer des patients.</div>
      <button class="btn bp bsm" style="margin-top:10px" onclick="navTo('imp',null)"><span>📂</span> Importer des patients</button>
    </div>`;
    return;
  }

  const done   = displayPatients.filter(p => p._done).length;
  const absent = displayPatients.filter(p => p._absent).length;
  const reste  = displayPatients.length - done - absent;

  const caRealise = displayPatients.filter(p => p._done).reduce((s, p) => {
    if (p._cotation?.validated) return s + parseFloat(p._cotation.total || 0);
    if (p.amount > 0) return s + parseFloat(p.amount);
    return s;
  }, 0);

  // ⚡ Bandeau compteur visible en haut de la section Pilotage (au-dessus des contrôles GPS).
  // Injecté dynamiquement pour éviter de modifier index.html. Suivi continu Fait/Absent/Restant.
  try {
    const parent = el.parentNode;
    let banner = document.getElementById('pilotage-progress-banner');
    if (!banner && parent) {
      banner = document.createElement('div');
      banner.id = 'pilotage-progress-banner';
      banner.style.cssText = 'position:sticky;top:0;z-index:5;background:linear-gradient(90deg,rgba(0,212,170,.04),rgba(0,212,170,0));border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:10px 14px;margin-bottom:12px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)';
      parent.insertBefore(banner, el);
    }
    if (banner) {
      const pct = displayPatients.length ? Math.round(((done + absent) / displayPatients.length) * 100) : 0;
      banner.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px">
          <div style="font-size:11px;font-family:var(--fm);color:var(--m);letter-spacing:1px;text-transform:uppercase">📊 Suivi tournée en temps réel</div>
          <div style="font-size:11px;font-family:var(--fm);color:var(--a);font-weight:600">${pct}% complété</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <div style="display:flex;align-items:center;gap:5px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35);color:#22c55e;border-radius:20px;padding:4px 11px;font-size:12px;font-weight:600">
            <span style="font-size:13px">✅</span> ${done} <span style="opacity:.8;font-weight:500">visité${done>1?'s':''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:5px;background:rgba(255,95,109,.1);border:1px solid rgba(255,95,109,.3);color:var(--d);border-radius:20px;padding:4px 11px;font-size:12px;font-weight:600">
            <span style="font-size:13px">❌</span> ${absent} <span style="opacity:.8;font-weight:500">absent${absent>1?'s':''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:5px;background:rgba(79,168,255,.1);border:1px solid rgba(79,168,255,.3);color:var(--a2);border-radius:20px;padding:4px 11px;font-size:12px;font-weight:600">
            <span style="font-size:13px">⏳</span> ${reste} <span style="opacity:.8;font-weight:500">restant${reste>1?'s':''}</span>
          </div>
          ${caRealise > 0 ? `<div style="display:flex;align-items:center;gap:5px;background:rgba(0,212,170,.12);border:1px solid rgba(0,212,170,.3);color:var(--a);border-radius:20px;padding:4px 11px;font-size:12px;font-weight:600;margin-left:auto">
            <span style="font-size:13px">💶</span> ${caRealise.toFixed(2)} € <span style="opacity:.8;font-weight:500">réalisés</span>
          </div>` : ''}
        </div>
        <div style="margin-top:8px;height:5px;background:rgba(255,255,255,.04);border-radius:20px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#22c55e,var(--a));border-radius:20px;transition:width .4s ease"></div>
        </div>`;
    }
  } catch {}

  const html = `<div class="card">
    <div class="ct" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span>📋 Patients de la journée (${displayPatients.length})</span>
      <button class="btn bs bsm" onclick="removeAllImportedPatients()" style="font-size:11px;padding:4px 10px">🗑️ Tout supprimer</button>
    </div>
    ${displayPatients.map((p, i) => {
      const k = String(p.patient_id || p.id || '');
      const isNext = !p._done && !p._absent && k === nextKey;
      // Index original dans importedData pour les callbacks (évite décalage après réordonnancement)
      const origIdx = (APP.importedData?.patients || APP.importedData?.entries || [])
        .findIndex(op => String(op.patient_id || op.id || '') === k);
      const safeIdx = origIdx >= 0 ? origIdx : i;
      const desc = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.texte || `Patient ${i+1}`;
      const statusIcon  = p._done ? '✅' : p._absent ? '❌' : isNext ? '📍' : '⏳';
      const statusColor = p._done
        ? 'rgba(34,197,94,.08)'
        : p._absent
          ? 'rgba(255,95,109,.05)'
          : isNext ? 'rgba(0,212,170,.08)' : 'var(--s)';
      const borderStyle = isNext ? 'border:2px solid var(--a);' : 'border:1px solid var(--b);';
      const heure = p.heure_soin || p.heure_preferee || p.heure || '';
      // ⚡ Soin enrichi affiché sous le nom — évite que "Diabète" brut apparaisse
      // alors que la cotation et l'Historique contiennent le détail.
      const _soinLivePat = (typeof _enrichSoinLabel === 'function')
        ? _enrichSoinLabel({
            actes_recurrents: p.actes_recurrents || '',
            pathologies:      p.pathologies || '',
            description:      p.description || p.texte || '',
          }, 80)
        : (p.description || p.texte || '').slice(0, 80);
      // Si le soin enrichi est juste le nom du patient (pas d'acte technique
      // identifiable), on ne l'affiche pas pour éviter la redondance.
      const _pNomLowerLive = desc.toLowerCase();
      const _showSoin = _soinLivePat && _soinLivePat.toLowerCase() !== _pNomLowerLive
                        && !_soinLivePat.toLowerCase().startsWith(_pNomLowerLive);
      return `<div class="route-item" style="background:${statusColor};${borderStyle}border-radius:10px;margin-bottom:6px;padding:10px 12px;align-items:center">
        <div class="route-num" style="font-size:16px">${statusIcon}</div>
        <div class="route-info" style="flex:1;min-width:0">
          <strong style="font-size:13px${isNext ? ';color:var(--a)' : ''}">${desc}</strong>
          ${_showSoin ? `<div style="font-size:10px;color:var(--m);margin-top:2px;line-height:1.3">💊 ${_soinLivePat}</div>` : ''}
          ${isNext ? `<div style="font-size:10px;font-family:var(--fm);color:var(--a);margin-top:1px">▶ Prochain patient</div>` : ''}
          ${heure ? `<div style="font-size:11px;color:var(--m);margin-top:2px">🕐 ${heure}</div>` : ''}
          ${p._cotation?.validated ? `<div style="font-size:10px;color:var(--a);margin-top:2px;font-family:var(--fm)">✅ ${p._cotation.total?.toFixed(2)} € validés</div>` : ''}
          ${((APP._ideAssignments||{})[k]||[]).length ? `<div style="font-size:10px;font-family:var(--fm);color:var(--a2);margin-top:2px">🎯 ${(APP._ideAssignments[k]).map(a=>a.label).join(' · ')}</div>` : ''}
          ${isNext ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <button class="btn bp bsm" onclick="markUberDone()" style="font-size:11px;padding:4px 10px"><span>✅</span> Terminé</button>
            <button class="btn bs bsm" onclick="markUberAbsent()" style="font-size:11px;padding:4px 10px"><span>❌</span> Absent</button>
            ${p.lat ? `<button class="btn bv bsm" onclick="openNavigation(APP.get('nextPatient'))" style="font-size:11px;padding:4px 10px"><span>🗺️</span> Naviguer</button>` : ''}
          </div>` : ''}
        </div>
        ${!isNext && ((p.lat && p.lng) || p.adresse || p.addressFull) ? `<button class="btn bv bsm" onclick="openNavigation(${JSON.stringify({lat:p.lat,lng:p.lng,address:p.adresse||p.addressFull||p.address||'',addressFull:p.addressFull||p.adresse||'',adresse:p.adresse||p.addressFull||'',geoScore:p.geoScore||0}).replace(/"/g,'&quot;')})" style="font-size:11px;padding:4px 8px;flex-shrink:0" title="Naviguer vers ce patient">🗺️</button>` : ''}
        <button class="btn bs bsm" onclick="removeImportedPatient(${safeIdx})" style="font-size:11px;padding:3px 8px;flex-shrink:0;color:var(--d);border-color:rgba(255,95,109,.2);background:rgba(255,95,109,.05)" title="Supprimer ce patient">✕</button>
      </div>`;
    }).join('')}
  </div>`;

  el.innerHTML = html;
  // Masquer uber-progress (doublon)
  const uberProg = $('uber-progress');
  if (uberProg) uberProg.style.display = 'none';
  // Mettre à jour le bandeau CA en continu
  if (typeof _updateLiveCADisplay === 'function') _updateLiveCADisplay();
}

/* ════════════════════════════════════════════════════════════
   CONTRAINTES DE PASSAGE — Premier & Suivant obligatoire
   ════════════════════════════════════════════════════════════
   APP._constraintFirst  → id/patient_id du 1er patient forcé
   APP._constraintSecond → id/patient_id du 2ème patient forcé
   ══════════════════════════════════════════════════════════ */

/* Peuple les selects avec les patients importés */
function populateConstraintSelects() {
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const selFirst  = $('constraint-first-patient');
  const selSecond = $('constraint-second-patient');
  if (!selFirst || !selSecond) return;

  const savedFirst  = APP._constraintFirst  || '';
  const savedSecond = APP._constraintSecond || '';

  const opts = patients.map(p => {
    const id    = String(p.patient_id || p.id || '');
    const nom   = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.texte || 'Patient';
    const heure = p.heure_soin || p.heure_preferee || '';
    const label = nom + (heure ? ` (${heure})` : '');
    return `<option value="${id}">${label}</option>`;
  }).join('');

  const empty = '<option value="">— Aucune contrainte —</option>';
  selFirst.innerHTML  = empty + opts;
  selSecond.innerHTML = empty + opts;

  // Restaurer les sélections précédentes si le patient est toujours dans la liste
  if (savedFirst  && patients.some(p => String(p.patient_id || p.id || '') === savedFirst))
    selFirst.value  = savedFirst;
  if (savedSecond && patients.some(p => String(p.patient_id || p.id || '') === savedSecond))
    selSecond.value = savedSecond;

  updateConstraintBadge('first');
  updateConstraintBadge('second');
}

/* Met à jour le badge de confirmation sous chaque select */
function updateConstraintBadge(which) {
  const selId   = which === 'first' ? 'constraint-first-patient'  : 'constraint-second-patient';
  const badgeId = which === 'first' ? 'constraint-first-badge'    : 'constraint-second-badge';
  const sel   = $(selId);
  const badge = $(badgeId);
  if (!sel || !badge) return;

  const val = sel.value;
  if (which === 'first')  APP._constraintFirst  = val || null;
  if (which === 'second') APP._constraintSecond = val || null;

  if (!val) { badge.style.display = 'none'; return; }

  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const p = patients.find(pt => String(pt.patient_id || pt.id || '') === val);
  if (!p) { badge.style.display = 'none'; return; }

  const nom   = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || 'Patient';
  const heure = p.heure_soin || p.heure_preferee || '';
  const pos   = which === 'first' ? '🥇 1ère position' : '🥈 2ème position';
  badge.style.display = 'block';
  badge.textContent   = `${pos} → ${nom}${heure ? ' · ' + heure : ''}`;
}

/* Efface une contrainte */
function clearConstraint(which) {
  const selId = which === 'first' ? 'constraint-first-patient' : 'constraint-second-patient';
  const sel = $(selId);
  if (sel) sel.value = '';
  if (which === 'first')  APP._constraintFirst  = null;
  if (which === 'second') APP._constraintSecond = null;
  updateConstraintBadge(which);
  if (typeof showToast === 'function')
    showToast(`🔓 Contrainte ${which === 'first' ? '1ère' : '2ème'} position effacée.`);
}

/* Applique les contraintes sur un tableau de patients trié.
   Retourne le tableau réordonné avec les patients contraints en tête. */
function applyPassageConstraints(route) {
  const firstId  = APP._constraintFirst  || null;
  const secondId = APP._constraintSecond || null;
  if (!firstId && !secondId) return route;

  let result = [...route];

  // Extraire secondId d'abord (firstId viendra l'écraser en position 0 ensuite)
  if (secondId) {
    const idx = result.findIndex(p => String(p.patient_id || p.id || '') === secondId);
    if (idx > 0) { const [p] = result.splice(idx, 1); result.unshift(p); }
  }

  // Extraire firstId et le forcer absolument en tête
  if (firstId) {
    const idx = result.findIndex(p => String(p.patient_id || p.id || '') === firstId);
    if (idx > 0) { const [p] = result.splice(idx, 1); result.unshift(p); }
  }

  return result;
}

function removeImportedPatient(index) {
  if (!APP.importedData?.patients) return;
  const p = APP.importedData.patients[index];
  const desc = (p?.description || p?.texte || `Patient ${index+1}`).slice(0, 30);
  if (!confirm(`Supprimer "${desc}" de la tournée ?`)) return;
  APP.importedData.patients.splice(index, 1);
  APP.importedData.total = APP.importedData.patients.length;
  storeImportedData(APP.importedData);
  renderLivePatientList();
  if (typeof showToast === 'function') showToast(`🗑️ Patient supprimé de la tournée.`);
}

function removeAllImportedPatients() {
  const n = APP.importedData?.patients?.length || 0;
  if (!n) return;
  if (!confirm(`Supprimer tous les ${n} patients de la tournée ?`)) return;
  APP.importedData = null;
  const banner = $('pla-import-banner');
  if (banner) banner.style.display = 'none';
  const caWrap = $('tur-ca-wrap');
  if (caWrap) caWrap.style.display = 'none';
  renderLivePatientList();
  if (typeof showToast === 'function') showToast(`🗑️ Tous les patients supprimés.`);
}

/* ============================================================
   AJOUT PATIENT URGENT EN COURS DE TOURNÉE
   ─────────────────────────────────────────
   - Modale avec liste carnet patient + recherche + saisie libre
   - Insertion à la position de détour minimal dans les restants
   - Ajout automatique au carnet si patient inconnu
   ============================================================ */

/* Distance euclidienne (° → score relatif, suffisant pour comparer détours) */
function _urgDist(a, b) {
  if (!a?.lat || !b?.lat) return 9999;
  const dlat = a.lat - b.lat;
  const dlng = (a.lng || a.lon || 0) - (b.lng || b.lon || 0);
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

/* Calcule la position d'insertion avec détour minimal parmi les patients restants.
   Renvoie l'index d'insertion dans le tableau complet (avant le 1er non-fait). */
function _findBestInsertPosition(newP, allPatients) {
  // Séparer faits / restants avec leurs indices dans allPatients
  const remainingIdx = [];
  allPatients.forEach((p, i) => {
    if (!p._done && !p._absent) remainingIdx.push(i);
  });
  if (!remainingIdx.length) return allPatients.length;
  if (remainingIdx.length === 1) return remainingIdx[0]; // avant le seul restant

  // Position GPS courante (infirmière) ou 1er patient restant comme proxy
  const userPos = APP.get('userPos') || APP.get('startPoint') || allPatients[remainingIdx[0]];

  let bestIdx = remainingIdx[0]; // par défaut : 1ère position restante
  let bestDetour = Infinity;

  // Tester l'insertion avant chaque patient restant
  for (let k = 0; k < remainingIdx.length; k++) {
    const idxBefore = remainingIdx[k];
    const prev = k === 0 ? userPos : allPatients[remainingIdx[k - 1]];
    const curr = allPatients[idxBefore];
    const detour = _urgDist(prev, newP) + _urgDist(newP, curr) - _urgDist(prev, curr);
    if (detour < bestDetour) {
      bestDetour = detour;
      bestIdx = idxBefore; // insérer AVANT cet index
    }
  }
  // Tester aussi l'insertion en toute dernière position restante
  const lastRemaining = allPatients[remainingIdx[remainingIdx.length - 1]];
  const prev = remainingIdx.length > 1 ? allPatients[remainingIdx[remainingIdx.length - 2]] : userPos;
  const detourLast = _urgDist(prev, newP) + _urgDist(newP, lastRemaining) - _urgDist(prev, lastRemaining);
  if (detourLast < bestDetour) bestIdx = remainingIdx[remainingIdx.length - 1];

  return bestIdx;
}

/* Insère le patient urgent dans importedData + uberPatients, met à jour l'affichage,
   et s'assure qu'il existe dans le carnet IDB. */
async function _insertUrgentPatient(patientData) {
  // ── 1. Préparer la fiche tournée ──────────────────────────────────────
  const urgentP = {
    ...patientData,
    id:          patientData.id || ('urg_' + Date.now()),
    patient_id:  patientData.id || patientData.patient_id || ('urg_' + Date.now()),
    description: patientData.description || ((patientData.prenom || '') + ' ' + (patientData.nom || '')).trim() || 'Patient urgent',
    texte:       patientData.texte || patientData.description || '',
    heure_soin:  patientData.heure_soin || '',
    urgence:     true,
    _urgent:     true,
    _done:       false,
    _absent:     false,
  };

  // ── 2. Insertion positionnelle optimale ───────────────────────────────
  if (!APP.importedData) APP.importedData = { patients: [], total: 0 };
  if (!APP.importedData.patients) APP.importedData.patients = [];
  const all = APP.importedData.patients;

  const insertIdx = _findBestInsertPosition(urgentP, all);
  all.splice(insertIdx, 0, urgentP);
  APP.importedData.total = all.length;
  storeImportedData(APP.importedData);

  // Synchroniser uberPatients
  const uber = APP.get('uberPatients') || [];
  uber.splice(insertIdx, 0, { ...urgentP, urgence: true });
  APP.set('uberPatients', uber);

  // ── 3. Ajouter au carnet IDB si absent ────────────────────────────────
  if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
    try {
      const rows = await _idbGetAll(PATIENTS_STORE);
      const alreadyIn = rows.some(r => r.id === urgentP.id ||
        ((r.nom || '').toLowerCase() === (urgentP.nom || '').toLowerCase() &&
         (r.prenom || '').toLowerCase() === (urgentP.prenom || '').toLowerCase() &&
         urgentP.nom));

      if (!alreadyIn && (urgentP.nom || urgentP.prenom || urgentP.description)) {
        const now = new Date().toISOString();
        const newPat = {
          id:         urgentP.id,
          nom:        urgentP.nom || '',
          prenom:     urgentP.prenom || '',
          ddn:        urgentP.ddn || '',
          amo:        urgentP.amo || '',
          amc:        urgentP.amc || '',
          adresse:    urgentP.adresse || urgentP.addressFull || '',
          lat:        urgentP.lat || null,
          lng:        urgentP.lng || null,
          cotations:  [],
          created_at: now,
          updated_at: now,
          source:     'urgent_live',
        };
        const row = {
          id:         newPat.id,
          nom:        newPat.nom,
          prenom:     newPat.prenom,
          _data:      (typeof _enc === 'function') ? _enc(newPat) : JSON.stringify(newPat),
          updated_at: now,
        };
        await _idbPut(PATIENTS_STORE, row);
        if (typeof _syncPatientNow === 'function') _syncPatientNow(row).catch(() => {});
        if (typeof showToast === 'function') showToast(`👤 ${urgentP.prenom || urgentP.nom || 'Patient'} ajouté au carnet.`, 'ok');
      }
    } catch(e) {
      console.warn('[AMI] _insertUrgentPatient carnet KO:', e.message);
    }
  }

  // ── 4. Rafraîchir l'affichage ─────────────────────────────────────────
  renderLivePatientList();
  if (typeof selectBestPatient === 'function') selectBestPatient();
  const pos = insertIdx + 1;
  const total = all.length;
  if (typeof showToast === 'function')
    showToast(`🚨 Patient urgent inséré en position ${pos}/${total} (détour minimal).`, 'ok');
}

/* Ouvre la modale de saisie d'un patient urgent */
async function openUrgentPatientModal() {
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const remaining = patients.filter(p => !p._done && !p._absent);
  if (!remaining.length) {
    if (typeof showToast === 'function') showToast('⚠️ Aucun patient restant dans la tournée.', 'warn');
    return;
  }

  // Charger le carnet IDB
  let carnet = [];
  if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
    try {
      const rows = await _idbGetAll(PATIENTS_STORE);
      carnet = rows.map(r => {
        const d = (typeof _dec === 'function') ? (_dec(r._data) || {}) : {};
        return { id: r.id, nom: r.nom || d.nom || '', prenom: r.prenom || d.prenom || '',
                 ddn: d.ddn || '', amo: d.amo || '', amc: d.amc || '',
                 adresse: d.adresse || d.addressFull || '',
                 lat: d.lat || null, lng: d.lng || null };
      }).filter(p => p.nom || p.prenom);
      carnet.sort((a, b) => (a.nom + a.prenom).localeCompare(b.nom + b.prenom, 'fr'));
    } catch(e) { console.warn('[AMI] openUrgentPatientModal carnet KO:', e.message); }
  }

  // Supprimer la modale existante si elle existe
  const existing = document.getElementById('modal-urgent-patient');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'modal-urgent-patient';
  modal.style.cssText = 'position:fixed;inset:0;z-index:1200;display:flex;align-items:flex-start;justify-content:center;background:rgba(11,15,20,.88);backdrop-filter:blur(10px);padding:16px;overflow-y:auto';

  const carnetHTML = carnet.length ? carnet.map(p => {
    const nom = ((p.prenom || '') + ' ' + (p.nom || '')).trim();
    const addr = p.adresse ? `<span style="font-size:10px;color:var(--m);display:block;margin-top:1px">${p.adresse.slice(0, 50)}</span>` : '';
    const dataAttr = `data-nom="${(p.nom||'').replace(/"/g,'')}" data-prenom="${(p.prenom||'').replace(/"/g,'')}" data-id="${p.id}" data-ddn="${p.ddn||''}" data-amo="${p.amo||''}" data-amc="${p.amc||''}" data-adresse="${(p.adresse||'').replace(/"/g,'')}" data-lat="${p.lat||''}" data-lng="${p.lng||''}"`;
    return `<div class="urg-pat-item" ${dataAttr} onclick="_urgSelectCarnet(this)" style="padding:10px 12px;border-radius:8px;border:1px solid var(--b);cursor:pointer;margin-bottom:6px;transition:background .15s">
      <div style="font-size:13px;font-weight:600">${nom}</div>${addr}
    </div>`;
  }).join('') : `<div style="color:var(--m);font-size:12px;padding:12px 0;text-align:center">Aucun patient dans le carnet — saisissez les informations manuellement ci-dessous.</div>`;

  modal.innerHTML = `
  <div style="background:var(--c);border:1px solid var(--b);border-radius:20px;width:100%;max-width:480px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);margin-top:20px">
    <!-- Header -->
    <div style="background:rgba(255,95,109,.08);border-bottom:1px solid rgba(255,95,109,.2);padding:18px 20px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-family:var(--fs);font-size:18px;font-weight:700;color:#ff5f6d">🚨 Patient urgent</div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">Sera inséré au meilleur endroit dans les ${remaining.length} patients restants</div>
      </div>
      <button onclick="closeUrgentPatientModal()" style="background:var(--s);border:1px solid var(--b);color:var(--m);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
    </div>
    <!-- Corps -->
    <div style="padding:20px;max-height:70vh;overflow-y:auto">
      ${carnet.length ? `
      <!-- Recherche dans le carnet -->
      <div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin-bottom:8px">Carnet patients (${carnet.length})</div>
      <input id="urg-search" type="text" placeholder="🔍 Rechercher nom, prénom…"
        style="width:100%;padding:9px 12px;background:var(--s);border:1px solid var(--b);border-radius:var(--r);color:var(--t);font-size:13px;margin-bottom:10px;box-sizing:border-box"
        oninput="_urgFilterCarnet(this.value)">
      <div id="urg-carnet-list" style="max-height:200px;overflow-y:auto;margin-bottom:16px;border:1px solid var(--b);border-radius:var(--r);padding:8px">
        ${carnetHTML}
      </div>
      <div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin-bottom:8px">— ou saisir manuellement —</div>
      ` : `<div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;color:var(--m);text-transform:uppercase;margin-bottom:8px">Nouveau patient</div>`}
      <!-- Formulaire saisie manuelle -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:11px;color:var(--m);display:block;margin-bottom:4px">Prénom</label>
          <input id="urg-prenom" type="text" placeholder="Prénom" style="width:100%;padding:8px 10px;background:var(--s);border:1px solid var(--b);border-radius:var(--r);color:var(--t);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;color:var(--m);display:block;margin-bottom:4px">Nom</label>
          <input id="urg-nom" type="text" placeholder="Nom" style="width:100%;padding:8px 10px;background:var(--s);border:1px solid var(--b);border-radius:var(--r);color:var(--t);font-size:13px;box-sizing:border-box">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:11px;color:var(--m);display:block;margin-bottom:4px">Heure souhaitée</label>
          <input id="urg-heure" type="time" style="width:100%;padding:8px 10px;background:var(--s);border:1px solid var(--b);border-radius:var(--r);color:var(--t);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;color:var(--m);display:block;margin-bottom:4px">Actes / Motif</label>
          <input id="urg-acte" type="text" placeholder="ex: pansement, glycémie…" style="width:100%;padding:8px 10px;background:var(--s);border:1px solid var(--b);border-radius:var(--r);color:var(--t);font-size:13px;box-sizing:border-box">
        </div>
      </div>
      <div style="margin-bottom:14px">
        <label style="font-size:11px;color:var(--m);display:block;margin-bottom:4px">Adresse (pour calcul de position)</label>
        <input id="urg-adresse" type="text" placeholder="ex: 12 rue de la Paix, Quimper" style="width:100%;padding:8px 10px;background:var(--s);border:1px solid var(--b);border-radius:var(--r);color:var(--t);font-size:13px;box-sizing:border-box">
      </div>
      <!-- Champ caché : id patient carnet sélectionné -->
      <input type="hidden" id="urg-patient-id" value="">
      <!-- Zone de confirmation patient sélectionné depuis carnet -->
      <div id="urg-selected-info" style="display:none;background:rgba(0,212,170,.07);border:1px solid rgba(0,212,170,.25);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--a)"></div>
    </div>
    <!-- Footer -->
    <div style="padding:14px 20px;border-top:1px solid var(--b);display:flex;gap:10px">
      <button class="btn bp" style="flex:1;background:rgba(255,95,109,.15);border-color:rgba(255,95,109,.4);color:#ff5f6d" onclick="_confirmUrgentPatient()">🚨 Insérer dans la tournée</button>
      <button class="btn bs bsm" onclick="closeUrgentPatientModal()">Annuler</button>
    </div>
  </div>`;

  document.body.appendChild(modal);

  // Focus sur la recherche si carnet disponible, sinon sur prénom
  setTimeout(() => {
    const focusEl = document.getElementById(carnet.length ? 'urg-search' : 'urg-prenom');
    if (focusEl) focusEl.focus();
  }, 80);
}

function closeUrgentPatientModal() {
  const modal = document.getElementById('modal-urgent-patient');
  if (modal) modal.remove();
}

/* Filtre la liste carnet en temps réel */
function _urgFilterCarnet(query) {
  const q = (query || '').toLowerCase().trim();
  const items = document.querySelectorAll('.urg-pat-item');
  items.forEach(el => {
    const nom = (el.dataset.nom + ' ' + el.dataset.prenom).toLowerCase();
    el.style.display = (!q || nom.includes(q)) ? 'block' : 'none';
  });
}

/* Sélection d'un patient depuis la liste carnet */
function _urgSelectCarnet(el) {
  // Désélectionner les autres
  document.querySelectorAll('.urg-pat-item').forEach(e => {
    e.style.background = '';
    e.style.borderColor = 'var(--b)';
  });
  el.style.background = 'rgba(0,212,170,.1)';
  el.style.borderColor = 'rgba(0,212,170,.4)';

  // Remplir les champs
  const prenom = el.dataset.prenom || '';
  const nom    = el.dataset.nom    || '';
  const id     = el.dataset.id     || '';
  const adresse = el.dataset.adresse || '';

  const fPrenom  = document.getElementById('urg-prenom');
  const fNom     = document.getElementById('urg-nom');
  const fAdresse = document.getElementById('urg-adresse');
  const fId      = document.getElementById('urg-patient-id');

  if (fPrenom)  fPrenom.value  = prenom;
  if (fNom)     fNom.value     = nom;
  if (fAdresse && adresse) fAdresse.value = adresse;
  if (fId)      fId.value      = id;

  const infoEl = document.getElementById('urg-selected-info');
  if (infoEl) {
    const nomAff = (prenom + ' ' + nom).trim();
    infoEl.innerHTML = `✅ Patient carnet sélectionné : <strong>${nomAff}</strong>${adresse ? ' · ' + adresse.slice(0,40) : ''}`;
    infoEl.style.display = 'block';
  }
}

/* Valide la saisie et insère le patient urgent */
async function _confirmUrgentPatient() {
  const prenom  = (document.getElementById('urg-prenom')?.value  || '').trim();
  const nom     = (document.getElementById('urg-nom')?.value     || '').trim();
  const heure   = (document.getElementById('urg-heure')?.value   || '').trim();
  const acte    = (document.getElementById('urg-acte')?.value    || '').trim();
  const adresse = (document.getElementById('urg-adresse')?.value || '').trim();
  const patId   = (document.getElementById('urg-patient-id')?.value || '').trim();

  if (!prenom && !nom) {
    if (typeof showToast === 'function') showToast('⚠️ Saisissez au moins un nom ou un prénom.', 'warn');
    return;
  }

  // Géocoder l'adresse si elle est renseignée (et pas déjà dans le carnet avec coords)
  let lat = null, lng = null;
  if (adresse) {
    // Chercher les coords dans le carnet d'abord
    if (patId && typeof _idbGetAll === 'function') {
      try {
        const rows = await _idbGetAll(PATIENTS_STORE);
        const row = rows.find(r => r.id === patId);
        if (row) {
          const d = (typeof _dec === 'function') ? (_dec(row._data) || {}) : {};
          lat = d.lat || null;
          lng = d.lng || null;
        }
      } catch(_) {}
    }
    // Géocodage si pas de coords connues
    if (!lat && typeof geocodeAddress === 'function') {
      try {
        const geo = await geocodeAddress(adresse);
        if (geo?.lat) { lat = geo.lat; lng = geo.lng || geo.lon; }
      } catch(_) {}
    }
  }

  const patientData = {
    id:          patId || ('urg_' + Date.now()),
    patient_id:  patId || ('urg_' + Date.now()),
    nom,
    prenom,
    heure_soin:  heure,
    description: (prenom + ' ' + nom).trim() + (acte ? ' — ' + acte : ''),
    texte:       acte,
    adresse,
    addressFull: adresse,
    lat,
    lng:         lng || null,
    amo:         document.getElementById('urg-patient-id') ? '' : '',
    urgence:     true,
  };

  closeUrgentPatientModal();
  await _insertUrgentPatient(patientData);
}

/* Exposer globalement */
window.openUrgentPatientModal  = openUrgentPatientModal;
window.closeUrgentPatientModal = closeUrgentPatientModal;
window._urgFilterCarnet        = _urgFilterCarnet;
window._urgSelectCarnet        = _urgSelectCarnet;
window._confirmUrgentPatient   = _confirmUrgentPatient;

/* ============================================================
   MODALE COTATION — Vérification / modification après soin
   ============================================================
   Appelée :
   - automatiquement quand patient marqué "terminé"
   - manuellement via bouton "📋 Cotation" dans la liste
   Permet de voir, modifier et valider chaque acte.
============================================================ */

/* Stockage temporaire des actes en cours d'édition dans la modale */
let _cotModalState = { actes: [], patient: null, onValidate: null };

function showCotationModal(patient, cotation, onValidate) {
  const existing = document.getElementById('cot-modal-live');
  if (existing) existing.remove();

  _cotModalState = {
    actes: (cotation?.actes || []).map((a, i) => ({ ...a, _idx: i })),
    patient,
    onValidate: onValidate || null,
  };

  _renderCotModal(patient, cotation);
}

/* Rendu (appelé aussi après modification d'un acte) */
function _renderCotModal(patient, cotationOriginal) {
  const existing = document.getElementById('cot-modal-live');
  if (existing) existing.remove();

  const actes = _cotModalState.actes;
  const total = actes.reduce((s, a) => s + (parseFloat(a.total) || 0), 0);
  // ⚡ Affichage de l'heure dans la modale. Priorité stricte à l'heure RÉELLE.
  //   1. patient._done_at : ancre posée par markUberDone / liveAction au clic "Terminer"
  //   2. patient._cotation._heure_reelle : taguée par autoFacturation / _autoCoterEtImporterPatient
  //   3. patient._cotation.heure : heure IDB déjà posée par une validation précédente
  //   4. patient.heure_soin / patient.heure_preferee : CONTRAINTE HORAIRE PLANIFIÉE —
  //      gardée en dernier recours uniquement, avec un libellé différent.
  const heureReelle = patient._done_at
    || patient._cotation?._heure_reelle
    || patient._cotation?.heure
    || '';
  const heurePlanifiee = patient.heure_soin || patient.heure_preferee || patient.heure || '';
  const heureAffichee = heureReelle || heurePlanifiee;
  const heureIsReelle = !!heureReelle;
  const desc  = (patient.description || patient.texte || 'Soin infirmier').slice(0, 100);

  /* Catalogue d'actes courants pour ajout rapide — Tarifs NGAP 2026 (CIR-9/2025) */
  // ─── ACTES RAPIDES — lecture dynamique du référentiel NGAP si chargé ───
  // window.NGAP_REFERENTIEL est injecté au chargement de l'app (voir index.html)
  // Fallback hardcodé si le référentiel n'est pas disponible
  const ACTES_RAPIDES = (() => {
    if (window.NGAP_REFERENTIEL && window.NGAP_REFERENTIEL.actes_chapitre_I) {
      // Codes les plus fréquents en tournée IDEL — extraits dynamiquement
      const codes_frequents = [
        'AMI1', 'AMI2', 'AMI4', 'AMI4.1', 'AMI5', 'AMI9', 'AMI10', 'AMI14', 'AMI15',
        'BSA', 'BSB', 'BSC', 'IFD', 'MCI', 'MIE', 'NUIT', 'NUIT_PROF', 'DIM'
      ];
      const all = [...window.NGAP_REFERENTIEL.actes_chapitre_I, ...window.NGAP_REFERENTIEL.actes_chapitre_II];
      const forfaits = window.NGAP_REFERENTIEL.forfaits_bsi || {};
      const dep = window.NGAP_REFERENTIEL.deplacements || {};
      const maj = window.NGAP_REFERENTIEL.majorations || {};
      return codes_frequents.map(code => {
        // Chercher dans actes Chap I/II
        let a = all.find(x => x.code_facturation === code || x.code === code);
        if (a) return { code, nom: a.label, total: a.tarif };
        // Sinon chercher dans forfaits/deplacements/majorations
        if (forfaits[code]) return { code, nom: forfaits[code].label, total: forfaits[code].tarif };
        if (dep[code]) return { code, nom: dep[code].label, total: dep[code].tarif };
        // Alias majorations
        const majKey = { 'NUIT':'ISN_NUIT', 'NUIT_PROF':'ISN_NUIT_PROFONDE', 'DIM':'ISD' }[code] || code;
        if (maj[majKey]) return { code, nom: maj[majKey].label, total: maj[majKey].tarif };
        return null;
      }).filter(Boolean);
    }
    // Fallback hardcodé (NGAP 2026.3 tarifs officiels, AMI4.1 = 12.92€ corrigé)
    return [
      { code:'AMI1',      nom:'Soin infirmier',         total: 3.15 },
      { code:'AMI2',      nom:'Acte infirmier ×2',      total: 6.30 },
      { code:'AMI4',      nom:'Pansement complexe',     total:12.60 },
      { code:'AMI4.1',    nom:'Changement flacon / 2e perf. même jour', total:12.92 },
      { code:'AMI5',      nom:'Retrait définitif dispositif ≥24h',      total:15.75 },
      { code:'AMI9',      nom:'Perfusion courte ≤1h surveillance',      total:28.35 },
      { code:'AMI10',     nom:'Perfusion courte — cancer/immunodépr.',  total:31.50 },
      { code:'AMI14',     nom:'Forfait perfusion longue >1h (1x/jour)', total:44.10 },
      { code:'AMI15',     nom:'Forfait perfusion — cancer/immunodépr.', total:47.25 },
      { code:'BSA',       nom:'Bilan soins A (dép. légère)',   total:13.00 },
      { code:'BSB',       nom:'Bilan soins B (dép. modérée)',  total:18.20 },
      { code:'BSC',       nom:'Bilan soins C (dép. lourde)',   total:28.70 },
      { code:'IFD',       nom:'Forfait déplacement',    total: 2.75 },
      { code:'MCI',       nom:'Majoration coordination',total: 5.00 },
      { code:'MIE',       nom:'Majoration enfant < 7 ans', total: 3.15 },
      { code:'NUIT',      nom:'Majoration nuit (20h-23h/5h-8h)', total: 9.15 },
      { code:'NUIT_PROF', nom:'Majoration nuit profonde (23h-5h)', total:18.30 },
      { code:'DIM',       nom:'Majoration dim./férié',  total: 8.50 },
    ];
  })();

  const modal = document.createElement('div');
  modal.id = 'cot-modal-live';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.8);display:flex;align-items:flex-end;justify-content:center;padding:0;box-sizing:border-box';

  modal.innerHTML = `
    <div id="cot-modal-inner" style="background:var(--bg,#0b0f14);border:1px solid rgba(0,212,170,.3);border-radius:20px 20px 0 0;padding:20px 20px 32px;width:100%;max-width:580px;max-height:90vh;overflow-y:auto;box-shadow:0 -12px 50px rgba(0,0,0,.6)">

      <!-- En-tête -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px">
        <div>
          <div style="font-family:var(--fs);font-size:20px;color:var(--t)">📋 Cotation du soin</div>
          <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-top:2px">Vérifiez et corrigez avant validation</div>
        </div>
        <button onclick="document.getElementById('cot-modal-live').remove()" style="background:none;border:1px solid var(--b);border-radius:50%;width:32px;height:32px;color:var(--m);font-size:18px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center">✕</button>
      </div>

      <!-- Résumé patient -->
      <div style="padding:10px 12px;background:var(--s);border:1px solid var(--b);border-radius:10px;margin-bottom:16px">
        <div style="font-size:13px;color:var(--t);font-weight:600">${desc}</div>
        ${heureAffichee
          ? `<div style="font-size:11px;color:var(--m);margin-top:3px;font-family:var(--fm)">
              ${heureIsReelle
                ? `🕐 Heure de fin de soin : <span style="color:var(--a);font-weight:600">${heureAffichee}</span>`
                : `⏰ Heure planifiée : <span style="color:var(--m)">${heureAffichee}</span> <span style="opacity:.6;font-size:10px">· heure réelle posée à la validation</span>`}
            </div>`
          : ''}
      </div>

      <!-- Liste des actes modifiables -->
      <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px">Actes — cliquez pour modifier</div>
      <div id="cot-actes-list">
        ${actes.length ? actes.map((a, i) => `
          <div id="cot-acte-${i}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(0,212,170,.04);border:1px solid rgba(0,212,170,.15);border-radius:10px;margin-bottom:8px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <input id="cot-code-${i}" value="${a.code||''}" oninput="_cotUpdateTotal()" style="font-family:var(--fm);font-size:11px;background:var(--ad);color:var(--a);border:1px solid rgba(0,212,170,.3);border-radius:20px;padding:2px 10px;width:70px;text-align:center">
                <input id="cot-nom-${i}" value="${(a.nom||'').replace(/"/g,'&quot;')}" oninput="_cotUpdateTotal()" style="font-size:12px;color:var(--t);background:transparent;border:none;border-bottom:1px solid var(--b);flex:1;min-width:80px;padding:2px 0" placeholder="Description acte">
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <input id="cot-total-${i}" type="number" step="0.01" value="${(parseFloat(a.total)||0).toFixed(2)}" oninput="_cotUpdateTotal()" style="font-family:var(--fm);font-size:13px;color:var(--a);font-weight:700;background:transparent;border:1px solid rgba(0,212,170,.2);border-radius:6px;padding:4px 6px;width:72px;text-align:right">
              <span style="font-size:12px;color:var(--m)">€</span>
            </div>
            <button onclick="_cotRemoveActe(${i})" style="background:none;border:none;color:rgba(255,95,109,.6);font-size:16px;cursor:pointer;flex-shrink:0;padding:2px 4px" title="Supprimer cet acte">✕</button>
          </div>
        `).join('') : `<div class="ai wa" style="margin-bottom:12px">⚠️ Aucun acte détecté — ajoutez-en manuellement ci-dessous.</div>`}
      </div>

      <!-- Ajout rapide d'acte -->
      <div style="margin-bottom:16px">
        <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">Ajouter un acte</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          ${ACTES_RAPIDES.map(a => `
            <button onclick="_cotAddActe('${a.code}','${a.nom.replace(/'/g,"\\'")}',${a.total})"
              style="font-size:11px;font-family:var(--fm);background:var(--s);border:1px solid var(--b);border-radius:20px;padding:4px 10px;cursor:pointer;color:var(--t);white-space:nowrap">
              ${a.code} <span style="color:var(--m)">${a.total.toFixed(2)}€</span>
            </button>
          `).join('')}
        </div>
        <div style="display:flex;gap:6px">
          <input id="cot-add-code" placeholder="Code (ex: AMI1)" style="width:90px;font-size:12px;font-family:var(--fm)">
          <input id="cot-add-nom" placeholder="Description" style="flex:1;font-size:12px">
          <input id="cot-add-total" type="number" step="0.01" placeholder="€" style="width:70px;font-size:12px">
          <button class="btn bp bsm" onclick="_cotAddCustomActe()">+ Ajouter</button>
        </div>
      </div>

      <!-- Total -->
      <div id="cot-total-display" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.3);border-radius:12px;margin-bottom:18px">
        <span style="font-size:15px;color:var(--t);font-weight:600">Total</span>
        <span id="cot-total-val" style="font-family:var(--fs);font-size:26px;color:var(--a)">${total.toFixed(2)} €</span>
      </div>

      <!-- Actions -->
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn bp" style="flex:2;min-width:160px" onclick="_validateCotationLive()">
          ✅ Valider cette cotation
        </button>
        <button class="btn bv" style="flex:1;min-width:120px" onclick="_openCotationComplete()">
          🖊️ Cotation complète
        </button>
        <button class="btn bs" style="flex:none" onclick="document.getElementById('cot-modal-live').remove()">
          Plus tard
        </button>
      </div>
      <p style="font-size:11px;color:var(--m);margin-top:12px;font-family:var(--fm);text-align:center;line-height:1.5">
        💡 Cotation basée sur la description du soin · Modifiez les actes si nécessaire avant de valider
      </p>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/* Met à jour le total affiché en lisant tous les inputs */
function _cotUpdateTotal() {
  const actes = _cotModalState.actes;
  let total = 0;
  actes.forEach((a, i) => {
    const codeEl  = document.getElementById(`cot-code-${i}`);
    const nomEl   = document.getElementById(`cot-nom-${i}`);
    const totalEl = document.getElementById(`cot-total-${i}`);
    if (codeEl)  a.code  = codeEl.value;
    if (nomEl)   a.nom   = nomEl.value;
    if (totalEl) { a.total = parseFloat(totalEl.value) || 0; total += a.total; }
  });
  const display = document.getElementById('cot-total-val');
  if (display) display.textContent = total.toFixed(2) + ' €';
}

/* Ajoute un acte rapide */
function _cotAddActe(code, nom, montant) {
  _cotUpdateTotal(); // sauvegarder l'état courant
  _cotModalState.actes.push({ code, nom, total: montant, _idx: _cotModalState.actes.length });
  _renderCotModal(_cotModalState.patient, null);
}

/* Ajoute un acte personnalisé */
function _cotAddCustomActe() {
  const code  = (document.getElementById('cot-add-code')?.value  || '').trim().toUpperCase();
  const nom   = (document.getElementById('cot-add-nom')?.value   || '').trim();
  const total = parseFloat(document.getElementById('cot-add-total')?.value) || 0;
  if (!code && !nom) { if (typeof showToast === 'function') showToast('Remplissez au moins le code ou la description'); return; }
  _cotUpdateTotal();
  _cotModalState.actes.push({ code: code || 'AMI', nom: nom || 'Acte infirmier', total });
  _renderCotModal(_cotModalState.patient, null);
}

/* Supprime un acte par index */
function _cotRemoveActe(idx) {
  _cotUpdateTotal();
  _cotModalState.actes.splice(idx, 1);
  _renderCotModal(_cotModalState.patient, null);
}

/* Valide la cotation et met à jour le CA */
function _validateCotationLive() {
  _cotUpdateTotal();
  const actes   = _cotModalState.actes;
  const total   = actes.reduce((s, a) => s + (parseFloat(a.total) || 0), 0);
  const patient = _cotModalState.patient;

  // ⚡ Heure RÉELLE de validation de la cotation. NE PAS utiliser
  // patient.heure_soin / patient.heure_preferee — ce sont les contraintes
  // horaires PLANIFIÉES (🕐 Tournée — Contrainte horaire / Heure de passage
  // préférée), pas l'horodatage effectif du soin à inscrire dans la cotation
  // CPAM / Historique des soins.
  const heureReelleLive = new Date().toTimeString().slice(0, 5); // "HH:MM" locale

  // Correction CA : soustraire l'ancien montant avant d'ajouter le nouveau
  const ancienTotal = patient?._cotation?.validated ? parseFloat(patient._cotation.total || 0) : 0;
  LIVE_CA_TOTAL = Math.max(0, LIVE_CA_TOTAL - ancienTotal) + total;
  const caEl = $('live-ca-total');
  if (caEl) { caEl.textContent = `💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`; caEl.style.display = 'block'; }

  if (patient) patient._caCardCounted = true;
  updateLiveCaCard(patient, { actes, total });

  // Conserver l'invoice_number existant (evite un nouvel ID a chaque correction)
  const existingInvoice = patient?._cotation?.invoice_number || null;
  // Préserver l'heure réelle déjà posée (ex: par uber.js au clic "Terminer")
  // pour qu'une correction manuelle ultérieure n'écrase pas l'horodatage du soin.
  const existingHeureMem = patient?._cotation?._heure_reelle || patient?._cotation?.heure || null;

  if (patient) patient._cotation = {
    actes,
    total,
    validated:      true,
    invoice_number: existingInvoice,
    _tournee_date:  patient._cotation?._tournee_date
                      || (typeof _localDateStr === 'function' ? _localDateStr() : new Date().toISOString().slice(0, 10)),
    _heure_reelle:  existingHeureMem || heureReelleLive, // ⚡ propagé à _syncCotationsToSupabase
  };

  // Sync Supabase + sauvegarde IDB en séquence pour garantir la cohérence
  // skipIDB=true : évite que _syncCotationsToSupabase relise l'IDB et double-envoie
  (async () => {
    try {
      const pid = patient?.patient_id || patient?.id;
      if (!pid || typeof _idbGetAll !== 'function') return;
      const rows = await _idbGetAll(PATIENTS_STORE);
      const row  = rows.find(r => r.id === pid);
      if (!row) return;
      const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };
      if (!p.cotations) p.cotations = [];
      const today     = (typeof _localDateStr === 'function') ? _localDateStr() : new Date().toISOString().slice(0, 10);
      // ⚡ Description enrichie : patient.description peut être "Diabète" brut.
      // On charge actes_recurrents depuis l'IDB (source de vérité patient) puis
      // on enrichit via pathologiesToActes si nécessaire. Cohérent avec uber.js
      // et le flux "Coter depuis fiche patient".
      const soinLabel = (typeof _enrichSoinLabel === 'function')
        ? _enrichSoinLabel({
            actes_recurrents: p.actes_recurrents || '',
            pathologies:      p.pathologies || '',
            description:      patient.description || patient.texte || '',
          }, 200)
        : (patient.description || patient.texte || '').slice(0, 200);
      // Chercher la cotation existante par invoice_number (plus fiable),
      // puis par fenêtre temporelle 6h sur source tournée (fallback)
      let existingIdx = existingInvoice
        ? p.cotations.findIndex(c => c.invoice_number === existingInvoice)
        : -1;
      if (existingIdx < 0) {
        // ⚠️ Fallback : fenêtre temporelle 6h, PAS comparaison de date UTC.
        // Une cotation faite à 1h du matin France stocke "2026-04-20" (UTC)
        // au lieu de "2026-04-21" (local) → confusion entre tournées de fin
        // de soirée et début de matinée. La fenêtre temporelle gère bien
        // les deux cas : double-clic accidentel (upsert dans 6h) vs vraie
        // nouvelle tournée le même jour ou le lendemain (push neuf).
        const _DEDUP_WINDOW_MS_VL = 6 * 3600 * 1000;
        const _nowMsVL = Date.now();
        existingIdx = p.cotations.findIndex(c => {
          if (c.source !== 'tournee' && c.source !== 'tournee_auto' && c.source !== 'tournee_live') return false;
          const _cMs = new Date(c.date || 0).getTime();
          if (isNaN(_cMs) || _cMs <= 0) return false;
          return Math.abs(_nowMsVL - _cMs) < _DEDUP_WINDOW_MS_VL;
        });
      }
      // Garder la cotation uniquement si elle contient au moins un acte technique (pas juste une majoration)
      const _CODES_MAJ = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
      const _hasActeTech = actes.some(a => !_CODES_MAJ.has((a.code||'').toUpperCase()));
      if (!_hasActeTech) {
        console.warn('[AMI] Cotation ignorée (majoration seule sans acte technique):', actes.map(a=>a.code));
        return;
      }
      // ⚡ Heure finale : préserver l'heure existante de l'IDB si on upsert une cotation
      // déjà saisie (ne pas écraser l'horodatage réel du soin lors d'une correction),
      // sinon utiliser l'heure réelle calculée au moment du clic "Valider".
      const _heureExistIDB = existingIdx >= 0 ? (p.cotations[existingIdx].heure || null) : null;
      const heureFinalLive = existingHeureMem || _heureExistIDB || heureReelleLive;
      // Re-taguer patient._cotation avec l'heure finale pour que _syncCotationsToSupabase
      // (et autres sync différés) envoient systématiquement la bonne valeur.
      if (patient?._cotation) patient._cotation._heure_reelle = heureFinalLive;

      const cotEntry = {
        date:           existingIdx >= 0
                          ? p.cotations[existingIdx].date
                          : (typeof _localDateTimeISO === 'function' ? _localDateTimeISO() : new Date().toISOString()),
        heure:          heureFinalLive, // ⚡ heure RÉELLE du soin (pas la contrainte horaire planifiée)
        actes,
        total,
        soin:           soinLabel,
        source:         'tournee',
        invoice_number: existingInvoice || (existingIdx >= 0 ? p.cotations[existingIdx].invoice_number : null),
        _synced:        false,
        updated_at:     new Date().toISOString(),
      };
      if (existingIdx >= 0) {
        p.cotations[existingIdx] = cotEntry;
      } else if (!existingInvoice) {
        p.cotations.push(cotEntry);
      }
      p.updated_at = new Date().toISOString();
      const _tsLive = { id: p.id, nom: p.nom, prenom: p.prenom, _data: _enc(p), updated_at: p.updated_at };
      await _idbPut(PATIENTS_STORE, _tsLive);
      if (typeof _syncPatientNow === 'function') _syncPatientNow(_tsLive).catch(() => {});

      // ── Sync Supabase après IDB (skipIDB=true : évite double INSERT) ──────
      // On passe l'invoice_number déjà connu pour faire un PATCH si correction
      try {
        const isAdmin = (typeof S !== 'undefined') && S?.role === 'admin';
        if (!isAdmin) {
          const _CODES_MAJ_SB = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
          const _hasTechSB = actes.some(a => !_CODES_MAJ_SB.has((a.code||'').toUpperCase()));
          if (_hasTechSB) {
            // ⚡ patient_nom : résolu depuis p (déchiffré IDB) — garantit l'affichage
            // correct dans l'Historique des soins (évite "?" + ID seul).
            const _patNomSB = ((p.prenom || '') + ' ' + (p.nom || '')).trim();
            const sbRes = await apiCall('/webhook/ami-save-cotation', {
              cotations: [{
                actes,
                total,
                date_soin:      today,
                heure_soin:     heureFinalLive, // ⚡ heure RÉELLE (pas la contrainte horaire)
                soin:           soinLabel,
                source:         'tournee',
                invoice_number: cotEntry.invoice_number || null,
                patient_id:     pid,
                ...(_patNomSB ? { patient_nom: _patNomSB } : {}),
              }]
            });
            // Mettre à jour l'invoice_number retourné dans IDB + mémoire
            const invReturned = sbRes?.invoice_numbers?.[0] || sbRes?.invoice_number || null;
            if (invReturned) {
              // En mémoire
              if (patient._cotation) patient._cotation.invoice_number = invReturned;
              // En IDB
              const finalIdx = p.cotations.findIndex(c =>
                c.source === 'tournee' && (c.date||'').slice(0,10) === today && !c._synced
              );
              if (finalIdx >= 0) {
                p.cotations[finalIdx].invoice_number = invReturned;
                p.cotations[finalIdx]._synced = true;
                p.updated_at = new Date().toISOString();
                const _tsLive2 = { id: p.id, nom: p.nom, prenom: p.prenom, _data: _enc(p), updated_at: p.updated_at };
                await _idbPut(PATIENTS_STORE, _tsLive2);
                if (typeof _syncPatientNow === 'function') _syncPatientNow(_tsLive2).catch(() => {});
              }
            }
          }
        }
      } catch(_sbErr) { console.warn('[AMI] Sync Supabase KO (silencieux):', _sbErr.message); }
    } catch(e) { console.warn('[AMI] Sauvegarde cotation IDB KO:', e.message); }
  })();

  if (typeof _cotModalState.onValidate === 'function') _cotModalState.onValidate(actes, total);
  const modal = document.getElementById('cot-modal-live');
  if (modal) modal.remove();
  const isCorrection = ancienTotal > 0;
  if (typeof showToast === 'function') {
    showToast(isCorrection
      ? `✏️ Cotation corrigée — ${total.toFixed(2)} €`
      : `✅ Cotation validée — ${total.toFixed(2)} € ajoutés au CA`
    );
  }
  renderLivePatientList();
}

/* Ouvre la section cotation complète en pré-remplissant le texte */
async function _openCotationComplete() {
  const patient = _cotModalState.patient;
  const modal   = document.getElementById('cot-modal-live');
  if (modal) modal.remove();

  // Poser _editingCotation AVANT la navigation pour que renderCot affiche
  // le bouton 'Mettre à jour' et que cotation() fasse un upsert.
  // ── Résolution IDB préalable ──────────────────────────────────────────────
  // Si invoice_number est absent, chercher en IDB pour résoudre cotationIdx.
  // Sans cela, _cotationCheckDoublon ne peut pas détecter la cotation existante
  // et crée un doublon dans l'historique des soins.
  const existingInvoice = patient?._cotation?.invoice_number || null;
  const patientIDBId    = patient?.patient_id || patient?.id || null;
  const _dateForCheck   = (patient._cotation?.date || patient.date || patient.date_soin || new Date().toISOString()).slice(0, 10);

  // Valeur par défaut — sera enrichie si IDB résolu
  window._editingCotation = {
    invoice_number: existingInvoice,
    patientId:      patientIDBId,
    cotationIdx:    null,
    _fromTournee:   true,
  };

  // Résolution asynchrone IDB : chercher une cotation existante pour ce patient/date
  if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
    try {
      const _allRowsOC  = await _idbGetAll(PATIENTS_STORE);
      const _nomCheckOC = ([patient.prenom, patient.nom].filter(Boolean).join(' ') || patient._nomAff || '').trim().toLowerCase();
      const _rowOC = patientIDBId
        ? _allRowsOC.find(r => r.id === patientIDBId)
        : _allRowsOC.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomCheckOC) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomCheckOC)
          );
      if (_rowOC && typeof _dec === 'function') {
        const _patOC = { ...(_dec(_rowOC._data) || {}), id: _rowOC.id };
        if (Array.isArray(_patOC.cotations)) {
          const _existIdxOC = _patOC.cotations.findIndex(c =>
            (c.date || '').slice(0, 10) === _dateForCheck
          );
          if (_existIdxOC >= 0) {
            const _existCotOC = _patOC.cotations[_existIdxOC];
            // Cotation existante trouvée → enrichir _editingCotation avec l'index résolu.
            // ⚠️ PAS de _userChose ici : c'est une résolution automatique, pas un choix
            // explicite. _cotationCheckDoublon affichera la modale pour que l'utilisateur
            // confirme s'il veut mettre à jour ou créer une nouvelle cotation.
            window._editingCotation = {
              invoice_number: _existCotOC.invoice_number || existingInvoice,
              patientId:      _rowOC.id,
              cotationIdx:    _existIdxOC,
              _fromTournee:   true,
              // _userChose intentionnellement absent → la modale doublon s'affichera
            };
          }
        }
      }
    } catch (_ocErr) {
      console.warn('[_openCotationComplete] IDB resolution:', _ocErr.message);
    }
  }

  if (typeof navTo === 'function') navTo('cot', null);

  // Pre-remplir TOUS les champs patient apres navigation
  setTimeout(() => {
    if (!patient) return;

    const setV = (elId, val) => {
      const el = document.getElementById(elId);
      if (el && val) el.value = val;
    };

    const nomComplet = ([patient.prenom, patient.nom].filter(Boolean).join(' ')
      || patient._nomAff || patient.patient || '').trim();
    setV('f-pt',  nomComplet);
    setV('f-ddn', patient.ddn  || patient.date_naissance || '');
    setV('f-sec', patient.nir  || patient.secu || '');
    setV('f-amo', patient.amo  || '');
    setV('f-amc', patient.amc  || '');
    setV('f-exo', patient.exo  || '');
    setV('f-pr',  patient.medecin || '');

    // Pré-remplir f-txt avec les actes de la cotation existante
    // Priorité : soin (description d'origine) > actes codés > description brute
    const fTxt = document.getElementById('f-txt');
    if (fTxt) {
      const cotActes = (patient._cotation?.actes || []);
      const cotSoin  = patient._cotation?.soin || '';

      let actesTxt = '';
      if (cotActes.length) {
        // Construire un texte lisible par l'IA : "AMI1 Injection SC/IM + DIM Majoration dimanche/férié"
        // Inclure nom/label pour que l'IA comprenne ce qu'elle recalcule
        actesTxt = cotActes
          .map(a => [a.code, a.nom || a.label || a.description].filter(Boolean).join(' '))
          .join(' + ');
      }
      // Si les actes ne donnent qu'un code court sans description, enrichir avec le soin d'origine
      if (!actesTxt || actesTxt === cotActes.map(a => a.code).join(' + ')) {
        actesTxt = cotSoin || actesTxt;
      }
      // Dernier fallback : description brute enrichie via pathologiesToActes si pathologie brute
      if (!actesTxt) {
        const rawFallback = (patient.actes_recurrents || patient.texte || patient.description || '').trim();
        const _hasActeKw = /injection|pansement|prélèvement|perfusion|nursing|insuline/i;
        if (rawFallback && !_hasActeKw.test(rawFallback) && typeof pathologiesToActes === 'function') {
          const conv = pathologiesToActes(rawFallback);
          actesTxt = conv && conv !== rawFallback ? rawFallback + ' — ' + conv : rawFallback;
        } else {
          actesTxt = rawFallback;
        }
      }
      if (actesTxt) {
        fTxt.value = actesTxt;
        if (typeof renderLiveReco === 'function') renderLiveReco(actesTxt);
      }
    }

    if (typeof cotClearPatient === 'function') cotClearPatient();

    // ── Date et heure du soin d'origine ──────────────────────────────────────
    // Date : conserver celle de la cotation existante (édition) ou celle du patient,
    //        sinon aujourd'hui.
    // Heure : RÈGLE CRITIQUE — ne jamais utiliser patient.heure_soin / patient.heure_preferee
    //         qui sont des CONTRAINTES HORAIRES planifiées (🕐 Tournée), pas l'horodatage
    //         effectif du soin. Utiliser uniquement :
    //           - l'heure d'une cotation DÉJÀ validée (patient._cotation.heure) si on édite
    //           - sinon l'heure COURANTE pour une nouvelle cotation
    const fDs = document.getElementById('f-ds');
    const fHs = document.getElementById('f-hs');
    if (fDs) {
      const dateSoin = (patient._cotation?.date || patient.date || patient.date_soin || '').slice(0, 10);
      fDs.value = dateSoin || new Date().toISOString().slice(0, 10);
    }
    if (fHs) {
      const _heureCotation = (patient._cotation?.heure || '').trim().slice(0, 5);
      if (_heureCotation && /^\d{1,2}:\d{2}$/.test(_heureCotation)) {
        // Édition d'une cotation validée — conserver son heure réelle d'origine
        fHs.value = _heureCotation;
        fHs._userEdited = true;
      } else {
        // Nouvelle cotation — heure courante (jamais la contrainte horaire planifiée)
        const _now = new Date();
        fHs.value = String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0');
        // _userEdited = false → autorise l'actualisation par cotation.js au clic "Coter"
        fHs._userEdited = false;
      }
    }

    const badge     = document.getElementById('cot-patient-badge');
    const badgeText = document.getElementById('cot-patient-badge-text');
    if (badge && badgeText && nomComplet) {
      const ddnStr = patient.ddn
        ? ' — ' + new Date(patient.ddn).toLocaleDateString('fr-FR') : '';
      badgeText.textContent = '👤 ' + nomComplet + ddnStr;
      badge.style.display = 'flex';
    }

    const isEdit = !!existingInvoice;
    if (typeof showToast === 'function') {
      showToast(isEdit
        ? '✏️ ' + (nomComplet || 'Patient') + ' — correction de cotation'
        : '👤 ' + (nomComplet || 'Patient') + ' — fiche pre-remplie'
      );
    }
  }, 220);
}

/* Ouvre la modale de cotation pour un patient spécifique depuis la liste tournée */
async function openCotationPatient(patientIndex) {
  // Sources par priorité :
  // 1. uberPatients   — tournée du jour en cours
  // 2. _planningData  — planning hebdomadaire (source du bouton "Coter" dans le planning)
  // 3. importedData   — import direct
  const uberPats     = APP.get('uberPatients') || [];
  const planningPats = window.APP._planningData?.patients || [];
  const impPats      = APP.importedData?.patients || APP.importedData?.entries || [];

  let patient;
  if (uberPats.length && uberPats[patientIndex] !== undefined) {
    patient = uberPats[patientIndex];
  } else if (planningPats[patientIndex] !== undefined) {
    patient = planningPats[patientIndex];
  } else {
    patient = impPats[patientIndex];
  }

  // Filet de sécurité : chercher par _planIdx dans toutes les sources
  if (!patient) {
    const all = [...planningPats, ...impPats, ...uberPats];
    patient = all.find(p => p._planIdx === patientIndex);
  }

  if (!patient) {
    if (typeof showToast === 'function') showToast('Patient introuvable.', 'wa');
    return;
  }

  // ── Vérification doublon IDB avant l'appel IA ────────────────────────────
  // Si une cotation existe déjà dans le carnet pour ce patient à cette date
  // (qu'elle soit validée ou non), proposer de la mettre à jour ou d'en créer une nouvelle.
  // Chercher par date du patient (Planning) OU aujourd'hui (Pilotage)
  const _todayCheck = new Date().toISOString().slice(0, 10);
  const _patientDate = (patient.date || patient.date_soin || _todayCheck).slice(0, 10);
  try {
    if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
      const _patId  = patient.patient_id || patient.id;
      const _patNom = ([patient.prenom, patient.nom].filter(Boolean).join(' ') || patient._nomAff || '').toLowerCase();
      const _allRows = await _idbGetAll(PATIENTS_STORE);
      const _row = _patId
        ? _allRows.find(r => r.id === _patId)
        : _allRows.find(r => (((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_patNom) || ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_patNom)));

      if (_row && typeof _dec === 'function') {
        const _pat = { ...(_dec(_row._data) || {}), id: _row.id };
        if (Array.isArray(_pat.cotations)) {
          // Chercher par date du patient (YYYY-MM-DD) — couvre Planning et Pilotage
          const _existIdx = _pat.cotations.findIndex(c =>
            (c.date || '').slice(0, 10) === _patientDate
          );
          if (_existIdx >= 0) {
            const _existCot = _pat.cotations[_existIdx];
            const _total    = parseFloat(_existCot.total || 0).toFixed(2);
            const _invNum   = _existCot.invoice_number || '—';
            const _nomAff   = ([_pat.prenom, _pat.nom].filter(Boolean).join(' ') || _patNom).trim();

            // Modale de choix : Mettre à jour ou Nouvelle cotation
            const _choice = await new Promise(resolve => {
              const _mod = document.createElement('div');
              _mod.id = 'cot-doublon-modal-tournee';
              _mod.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);padding:20px';
              _mod.innerHTML = `
                <div style="background:var(--c,#0b0f14);border:1px solid var(--b,#1e2d3d);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)">
                  <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
                    <div style="width:40px;height:40px;border-radius:50%;background:rgba(251,191,36,.15);border:2px solid #f59e0b;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">⚠️</div>
                    <div>
                      <div style="font-weight:700;font-size:15px;color:var(--t,#e2e8f0)">Cotation déjà existante</div>
                      <div style="font-size:11px;color:var(--m,#64748b);font-family:var(--fm,'monospace')">Aujourd'hui · ${new Date().toLocaleDateString('fr-FR')}</div>
                    </div>
                  </div>
                  <div style="background:var(--s,#111827);border:1px solid var(--b,#1e2d3d);border-radius:10px;padding:10px 14px;margin-bottom:16px">
                    <div style="font-size:13px;font-weight:600;color:var(--t,#e2e8f0)">${_nomAff}</div>
                    <div style="font-size:11px;color:var(--m,#64748b);font-family:var(--fm,'monospace');margin-top:3px">
                      ${_invNum !== '—' ? `Facture <span style="color:#00d4aa;font-weight:600">${_invNum}</span> · ` : ''}
                      Montant <span style="color:#00d4aa;font-weight:700">${_total} €</span>
                    </div>
                    ${(_existCot.actes||[]).length ? `<div style="font-size:11px;color:var(--m,#64748b);margin-top:4px">${(_existCot.actes||[]).map(a=>a.code).join(' + ')}</div>` : ''}
                  </div>
                  <div style="font-size:13px;color:var(--m,#64748b);margin-bottom:16px">Que souhaitez-vous faire ?</div>
                  <div style="display:flex;flex-direction:column;gap:10px">
                    <button id="cdt-update" style="width:100%;padding:12px;background:#00d4aa;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer">
                      💾 Mettre à jour la cotation existante
                    </button>
                    <button id="cdt-new" style="width:100%;padding:12px;background:var(--s,#111827);color:var(--t,#e2e8f0);border:1px solid var(--b,#1e2d3d);border-radius:10px;font-size:14px;cursor:pointer">
                      ✨ Créer une nouvelle cotation
                    </button>
                    <button id="cdt-cancel" style="width:100%;padding:10px;background:transparent;color:var(--m,#64748b);border:1px solid var(--b,#1e2d3d);border-radius:10px;font-size:13px;cursor:pointer">
                      Annuler
                    </button>
                  </div>
                </div>
              `;
              document.body.appendChild(_mod);

              _mod.querySelector('#cdt-update').onclick = () => {
                _mod.remove();
                window._editingCotation = {
                  patientId:      _row.id,
                  cotationIdx:    _existIdx,
                  invoice_number: _existCot.invoice_number || null,
                  _fromTournee:   true,
                  _userChose:     true,
                };
                // ── Synchroniser patient._cotation avec la cotation IDB existante ──
                // Indispensable pour que _openCotationComplete remplisse f-txt avec
                // les vrais actes (AMI1 + DIM) et non la description brute ("Diabète")
                patient._cotation = {
                  actes:          _existCot.actes || [],
                  total:          parseFloat(_existCot.total || 0),
                  validated:      true,
                  invoice_number: _existCot.invoice_number || null,
                  heure:          _existCot.heure || '',
                  date:           _existCot.date || '',
                  soin:           _existCot.soin || patient.description || '',
                };
                showCotationModal(patient, _existCot, null);
                resolve('update');
              };
              _mod.querySelector('#cdt-new').onclick = () => {
                _mod.remove();
                window._editingCotation = null;
                resolve('new');
              };
              _mod.querySelector('#cdt-cancel').onclick = () => {
                _mod.remove();
                resolve('cancel');
              };
            });

            // Mettre à jour / Annuler → showCotationModal déjà appelé ou abandon, sortir
            if (_choice === 'update' || _choice === 'cancel') return;
            // Nouvelle cotation → continuer le flux normal (appel API ci-dessous)
          } else if (patient._cotation?.validated) {
            // Cotation validée en mémoire mais absente en IDB → ouvrir directement la modale
            showCotationModal(patient, patient._cotation, null);
            return;
          }
        }
      } else if (patient._cotation?.validated) {
        // Pas de fiche IDB → ouvrir directement la modale sur la cotation en mémoire
        showCotationModal(patient, patient._cotation, null);
        return;
      }
    }
  } catch (_doubErr) {
    console.warn('[openCotationPatient] doublon check:', _doubErr.message);
    // Fallback : si cotation validée, ouvrir la modale quand même
    if (patient._cotation?.validated) {
      showCotationModal(patient, patient._cotation, null);
      return;
    }
  }

  // Sinon générer une cotation automatique via API ou fallback local
  if (typeof showToast === 'function') showToast('⚡ Génération de la cotation…');

  /* ── Récupérer actes_recurrents depuis la fiche IDB ── */
  let actesRecurrents = '';
  try {
    if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
      const rows = await _idbGetAll(PATIENTS_STORE);
      const row  = rows.find(r => r.id === patient.patient_id || r.id === patient.id);
      if (row && typeof _dec === 'function') {
        const pat = _dec(row._data) || {};
        if (pat.actes_recurrents) actesRecurrents = pat.actes_recurrents;
      }
    }
  } catch (_) {}

  /* Priorité : actes_recurrents > (texte importé + pathologies converties) > pathologies seules
     BUG FIX : texteImport seul peut ne contenir que "Diabète" sans actes NGAP.
     On enrichit TOUJOURS avec _pathoConverti quand disponible, même si texteImport existe.
     Cela garantit que l'IA reçoit "Diabète — Injection insuline SC, surveillance glycémie..."
     plutôt que simplement "Diabète" qui ne génère aucun acte technique. */
  const texteImport = (patient.texte || patient.description || '').trim();
  // pathologiesToActes sur champ pathologies OU sur texteImport lui-même si c'est une patho brute
  const _pathoSrcOCP   = patient.pathologies || texteImport;
  const _hasActeKwOCP  = /injection|pansement|prélèvement|perfusion|nursing|toilette|bilan|sonde|aérosol|insuline|glycémie/i;
  const _pathoConverti = _pathoSrcOCP && typeof pathologiesToActes === 'function'
    ? pathologiesToActes(_pathoSrcOCP) : '';

  const _texteBase = (() => {
    if (_hasActeKwOCP.test(texteImport)) return texteImport; // déjà des actes explicites
    if (_pathoConverti && _pathoConverti !== texteImport) {
      return texteImport ? (texteImport + ' — ' + _pathoConverti) : _pathoConverti;
    }
    return texteImport || 'soin infirmier à domicile';
  })();

  const texteForCot = actesRecurrents
    ? (actesRecurrents + (_texteBase ? ' — ' + _texteBase : ''))
    : _texteBase;

  let cotation = null;
  try {
    const u = S?.user || {};
    // ⚡ Heure : préserver l'heure existante si on édite une cotation déjà en
    // IDB (patient._cotation.heure, posé par le chemin "mettre à jour" plus haut),
    // sinon utiliser l'heure RÉELLE — jamais la contrainte horaire planifiée.
    const _heureEditExist = patient._cotation?._heure_reelle
      || patient._cotation?.heure
      || null;
    const _heureForApi = _heureEditExist || new Date().toTimeString().slice(0, 5);
    // ⚡ Nom + ID patient — INDISPENSABLE pour l'Historique des soins.
    // Sans ces champs, la ligne remonte avec un avatar "?" et "ID #XXX" seul.
    const _patNomOCP = ((patient.prenom || '') + ' ' + (patient.nom || '')).trim();
    const _patIdOCP  = patient.patient_id || patient.id || null;
    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap',
      texte: texteForCot,
      infirmiere: ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
      adeli: u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      date_soin: new Date().toISOString().split('T')[0],
      heure_soin: _heureForApi,
      _live_auto: true,
      ...(_patNomOCP ? { patient_nom: _patNomOCP } : {}),
      ...(_patIdOCP  ? { patient_id:  _patIdOCP  } : {}),
      preuve_soin:{ type:'auto_declaration', timestamp:new Date().toISOString(), certifie_ide:true, force_probante:'STANDARD' },
    });
    cotation = d;
  } catch (_) {
    if (typeof autoCotationLocale === 'function') cotation = autoCotationLocale(texteForCot);
  }

  // Propager invoice_number vers patient._cotation pour que _openCotationComplete
  // et _cotationCheckDoublon puissent identifier la cotation Supabase existante.
  // Sans cela, toute re-cotation fait un INSERT au lieu d'un PATCH → doublon.
  if (cotation?.invoice_number) {
    patient._cotation = {
      ...(patient._cotation || {}),
      invoice_number: cotation.invoice_number,
      actes:          cotation.actes || [],
      total:          parseFloat(cotation.total || 0),
      validated:      true,
      auto:           true,
      // ⚡ Tag d'heure réelle → _syncCotationsToSupabase enverra cette valeur.
      // Priorité : ancre _done_at (clic Terminer) > _heure_reelle existant >
      // heure IDB > fallback new Date().
      _heure_reelle:  patient._done_at
                       || patient._cotation?._heure_reelle
                       || patient._cotation?.heure
                       || new Date().toTimeString().slice(0, 5),
    };
  }

  showCotationModal(patient, cotation || { actes: [], total: 0 }, null);
}

/* ============================================================
   RÉINITIALISATION TOURNÉE DU JOUR
   Efface tous les patients importés, remet le pilotage à zéro.
   Accessible depuis Tournée IA ET Pilotage de journée.
   ============================================================ */
function resetTourneeJour() {
  const n = (APP.importedData?.patients || APP.importedData?.entries || []).length;
  const msg = n > 0
    ? `Réinitialiser la tournée du jour ?\n\n${n} patient(s) seront effacés de la Tournée IA et du Pilotage de journée.\nCette action ne supprime PAS les fiches du carnet patient.`
    : 'Réinitialiser la tournée du jour ?\n\nLe pilotage sera remis à zéro.';
  if (!confirm(msg)) return;

  // Reset données importées
  APP.importedData  = null;
  APP.uberPatients  = [];
  APP.nextPatient   = null;
  APP._ideAssignments = {};

  // Arrêter le timer live
  if (LIVE_TIMER_ID) { clearInterval(LIVE_TIMER_ID); LIVE_TIMER_ID = null; }
  LIVE_START_TIME = null;
  LIVE_CA_TOTAL   = 0;

  // Reset badge statut
  const badge = $('live-badge');
  if (badge) {
    badge.textContent = 'EN ATTENTE';
    badge.style.background = '';
    badge.style.color = '';
  }

  // Reset textes pilotage
  const patName = $('live-patient-name');
  if (patName) patName.textContent = 'Démarrez votre journée';
  const liveInfo = $('live-info');
  if (liveInfo) liveInfo.textContent = 'Cliquez sur "Démarrer" pour activer le pilotage automatique';

  // Reset timer + CA
  const timerEl = $('live-timer');
  if (timerEl) { timerEl.textContent = ''; timerEl.style.display = 'none'; }
  const caTotal = $('live-ca-total');
  if (caTotal) { caTotal.textContent = ''; caTotal.style.display = 'none'; }

  // Cacher bloc contrôles live + reset boutons démarrer/arrêter
  const liveControls = $('live-controls');
  if (liveControls) liveControls.style.display = 'none';
  const btnStart = $('btn-live-start');
  if (btnStart) btnStart.style.display = 'inline-flex';
  const btnStop = $('btn-live-stop');
  if (btnStop) btnStop.style.display = 'none';

  // Vider la liste patients du pilotage
  const liveNext = $('live-next');
  if (liveNext) liveNext.innerHTML = '';

  // Vider la tournée IA
  const tbody = $('tbody');
  if (tbody) tbody.innerHTML = '';
  const resTur = $('res-tur');
  if (resTur) resTur.classList.remove('show');

  // Cacher CA estimé
  const caWrap = $('tur-ca-wrap');
  if (caWrap) caWrap.style.display = 'none';
  const caBox = $('ca-box');
  if (caBox) caBox.style.display = 'none';

  // Cacher banner planning
  const banner = $('pla-import-banner');
  if (banner) banner.style.display = 'none';

  // Cacher CA journée
  const caCard = $('live-ca-card');
  if (caCard) caCard.style.display = 'none';
  const caDetail = $('live-ca-detail');
  if (caDetail) caDetail.innerHTML = '';

  // Arrêter GPS Uber si actif
  if (typeof stopLiveTracking === 'function') stopLiveTracking();

  // ── Nettoyer la carte Leaflet (markers patients + tracé de route) ──────────
  try {
    const mapInst = APP.map?.instance || APP.map;
    if (mapInst && typeof mapInst.removeLayer === 'function') {
      // Markers patients
      if (APP.markers && Array.isArray(APP.markers)) {
        APP.markers.forEach(m => { try { mapInst.removeLayer(m); } catch(_){} });
        APP.markers = [];
      }
      // Tracé de route
      if (APP._routePolyline) {
        try { mapInst.removeLayer(APP._routePolyline); } catch(_){}
        APP._routePolyline = null;
      }
      // Marker point de départ
      if (APP._startMarker) {
        try { mapInst.removeLayer(APP._startMarker); } catch(_){}
        APP._startMarker = null;
      }
      // Marker GPS live infirmière (uber.js)
      if (window._liveMarker) {
        try { mapInst.removeLayer(window._liveMarker); } catch(_){}
        window._liveMarker = null;
      }
    }
  } catch(e) { console.warn('[AMI] Reset carte KO:', e.message); }
  // Arrêter l'optimisation live IA si active
  if (typeof stopLiveOptimization === 'function') stopLiveOptimization();
  // Effacer le planning local sauvegardé
  if (typeof _clearPlanning === 'function') _clearPlanning();

  // Reset affichage Mode Uber Médical
  const uberNext = $('uber-next-patient');
  if (uberNext) uberNext.innerHTML = '<div style="color:var(--m);font-size:13px">Démarrez la journée pour charger vos patients.</div>';
  const uberStatus = $('uber-tracking-status');
  if (uberStatus) uberStatus.textContent = '⏸️ GPS non démarré — cliquez sur "Démarrer la journée"';
  const uberProg = $('uber-progress');
  if (uberProg) uberProg.textContent = '';
  const uberRoute = $('uber-route-info');
  if (uberRoute) uberRoute.textContent = '';

  /* ── Nettoyages ajoutés pour corriger les résidus visuels après reset ─ */

  // 1. Supprimer le banner "📊 Suivi tournée en temps réel" injecté dynamiquement.
  //    Sans ça, après reset, le bandeau restait affiché dans le Pilotage.
  const progBanner = document.getElementById('pilotage-progress-banner');
  if (progBanner) progBanner.remove();

  // 2. Vider la Tournée cabinet multi-IDE (même après reset, la répartition
  //    restait visible avec les patients précédents).
  const turCabResult = document.getElementById('tur-cabinet-result');
  if (turCabResult) turCabResult.innerHTML = '';

  // 3. Purger les assignations IDE + contraintes de tournée en mémoire
  //    pour éviter que la prochaine optimisation ré-affecte les anciens patients.
  APP._constraintFirst  = null;
  APP._constraintSecond = null;
  // _ideAssignments déjà nettoyé plus haut

  // 4. Publier l'état vide dans le store observable pour déclencher
  //    les listeners (map, rentabilité, bandeau cabinet, etc.).
  if (typeof APP.set === 'function') {
    APP.set('uberPatients', []);
    APP.set('nextPatient', null);
  }

  LIVE_PATIENT_ID = null;

  if (typeof showToast === 'function') showToast('🗑️ Tournée du jour réinitialisée.');
}

/* Patch liveStatus global — affiche TOUJOURS l'état local d'abord */
window.liveStatus = function() {
  // Affichage local immédiat (toujours disponible, même hors ligne)
  renderLivePatientList();
  // Tentative de synchronisation API en arrière-plan (non bloquant)
  liveStatusCore().catch(() => {});
};

/* ════════════════════════════════════════════════
   TOURNÉE CABINET MULTI-IDE — v1.0
   ────────────────────────────────────────────────
   optimiserTourneeCabinet()    — répartit les patients entre IDEs
   optimiserTourneeCabinetCA()  — optimise pour maximiser les revenus
   _renderTourneeCabinetHTML()  — rendu visuel du planning multi-IDE
════════════════════════════════════════════════ */

/**
 * optimiserTourneeCabinet — distribue les patients du jour entre IDEs du cabinet
 * Utilise cabinetPlanDay() + cabinetScoreDistribution() de ai-tournee.js
 */
async function optimiserTourneeCabinet() {
  const result = document.getElementById('tur-cabinet-result');
  if (!result) return;

  const cab = APP.get ? APP.get('cabinet') : null;
  if (!cab?.id) {
    result.innerHTML = '<div class="ai wa">Vous n\'êtes pas dans un cabinet.</div>';
    return;
  }

  // Membres normalisés — accepter id | infirmiere_id
  const members = (cab.members?.length
    ? cab.members
    : [{ id: APP.user?.id || 'ide_0', nom: APP.user?.nom || '', prenom: APP.user?.prenom || 'Moi' }]
  ).map((m, idx) => ({
    id:     m.id || m.infirmiere_id || `ide_${idx}`,
    nom:    m.nom    || '',
    prenom: m.prenom || `IDE ${idx + 1}`,
    role:   m.role   || 'membre',
  }));

  // Source patients : uberPatients (avec _legKm) > _planningData > importedData
  const rawPatientsSrc = (
    APP.get('uberPatients') ||
    window.APP._planningData?.patients ||
    APP.importedData?.patients ||
    APP.importedData?.entries ||
    []
  );
  const patients = rawPatientsSrc.map(p => ({
    ...p,
    id:      p.id || p.patient_id || null,
    nom:     p.nom || p._nomAff || '',
    prenom:  p.prenom || '',
    lat:     parseFloat(p.lat ?? p.latitude ?? '') || null,
    lng:     parseFloat(p.lng ?? p.lon ?? p.longitude ?? '') || null,
    adresse: p.adresse || p.address || p.addressFull || '',
  }));

  if (!patients.length) {
    result.innerHTML = '<div class="ai wa">Aucun patient disponible. Optimisez d\'abord la tournée.</div>';
    return;
  }

  result.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto 8px"></div><p style="font-size:12px;color:var(--m)">Répartition IA en cours…</p></div>';

  try {
    // Appel backend
    let assignments;
    try {
      const d = await apiCall('/webhook/cabinet-tournee', {
        cabinet_id: cab.id,
        patients,
        members,
      });
      assignments = d.ok ? d.assignments : null;
    } catch {}

    // Fallback client (cabinetPlanDay de ai-tournee.js)
    if (!assignments && typeof cabinetPlanDay === 'function') {
      assignments = cabinetPlanDay(patients, members);
    }

    if (!assignments?.length) {
      result.innerHTML = '<div class="ai er">Impossible de calculer la répartition.</div>';
      return;
    }

    // ── Pré-remplir APP._ideAssignments depuis la répartition IA ──────────
    // Chaque assignment { ide_id, prenom, nom, patients: [{id,...}] }
    if (!APP._ideAssignments) APP._ideAssignments = {};
    assignments.forEach(a => {
      const mid    = a.ide_id || a.id || '';
      const mLabel = (`${a.prenom||''} ${a.nom||''}`).trim() || mid;
      (a.patients || []).forEach(p => {
        const pk = String(p.id || p.patient_id || '');
        if (!pk) return;
        if (!APP._ideAssignments[pk]) APP._ideAssignments[pk] = [];
        if (!APP._ideAssignments[pk].some(x => x.id === mid)) {
          APP._ideAssignments[pk].push({ id: mid, label: mLabel });
        }
      });
    });

    // Afficher le panel d'assignation avec les pré-cochages IA
    _renderCabinetAssignmentPanel();
    if (typeof showToast === 'function') showToast('✅ Répartition IA appliquée — ajustez les cases si besoin', 'ok');

  } catch(e) {
    result.innerHTML = `<div class="ai er">Erreur : ${e.message}</div>`;
  }
}

/**
 * optimiserTourneeCabinetCA — optimise la répartition pour maximiser les revenus
 * Pré-remplit APP._ideAssignments puis affiche le panel interactif.
 */
async function optimiserTourneeCabinetCA() {
  const result = document.getElementById('tur-cabinet-result');
  if (!result) return;

  const cab = APP.get ? APP.get('cabinet') : null;
  if (!cab?.id) return;

  // Membres normalisés
  const members = (cab.members?.length
    ? cab.members
    : [{ id: APP.user?.id || 'ide_0', nom: APP.user?.nom || '', prenom: APP.user?.prenom || 'Moi' }]
  ).map((m, idx) => ({
    id:     m.id || m.infirmiere_id || `ide_${idx}`,
    nom:    m.nom    || '',
    prenom: m.prenom || `IDE ${idx + 1}`,
  }));

  // Source patients : uberPatients (avec _legKm + amount) > importedData
  const rawSrc = APP.get('uberPatients') || APP.importedData?.patients || APP.importedData?.entries || [];
  if (!rawSrc.length) {
    result.innerHTML = '<div class="ai wa">Optimisez d\'abord la tournée pour charger les patients.</div>';
    return;
  }

  result.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto 8px"></div><p style="font-size:12px;color:var(--m)">Optimisation des revenus…</p></div>';

  try {
    const patients = rawSrc.map(p => {
      const amt = parseFloat(p.amount || p.total || p.montant || 0)
                    || (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 0);
      const km  = parseFloat(p._legKm || p.distance_km || p.km || 0);
      return {
        ...p,
        id:          p.id || p.patient_id || null,
        nom:         p.nom || p._nomAff || '',
        prenom:      p.prenom || '',
        total:       amt,
        amount:      amt,
        // Champ consommé par cabinetScoreDistribution — garantit un calcul correct
        distance_km: km,
        _legKm:      km,
      };
    });

    // Répartition initiale
    let assignments = typeof cabinetPlanDay === 'function'
      ? cabinetPlanDay(patients, members) : null;
    if (!assignments?.length) { result.innerHTML = '<div class="ai er">Impossible de calculer.</div>'; return; }

    const before = typeof cabinetScoreDistribution === 'function'
      ? cabinetScoreDistribution(assignments) : null;

    // Optimisation revenus
    if (typeof cabinetOptimizeRevenue === 'function') {
      assignments = cabinetOptimizeRevenue(assignments, members);
    }

    const after = typeof cabinetScoreDistribution === 'function'
      ? cabinetScoreDistribution(assignments) : null;

    const gain = (after && before)
      ? (after.total_revenue - before.total_revenue).toFixed(2) : '0.00';

    // ── Pré-remplir APP._ideAssignments depuis la répartition optimisée ──
    if (!APP._ideAssignments) APP._ideAssignments = {};
    // Effacer les assignations existantes pour repartir d'une base propre
    Object.keys(APP._ideAssignments).forEach(k => { APP._ideAssignments[k] = []; });

    assignments.forEach(a => {
      const mid    = a.ide_id || a.id || '';
      const mLabel = (`${a.prenom||''} ${a.nom||''}`).trim() || mid;
      (a.patients || []).forEach(p => {
        const pk = String(p.id || p.patient_id || '');
        if (!pk) return;
        if (!APP._ideAssignments[pk]) APP._ideAssignments[pk] = [];
        if (!APP._ideAssignments[pk].some(x => x.id === mid)) {
          APP._ideAssignments[pk].push({ id: mid, label: mLabel });
        }
      });
    });

    // Afficher le panel interactif avec les pré-cochages optimisés
    _renderCabinetAssignmentPanel();

    if (typeof showToast === 'function') {
      const msg = parseFloat(gain) > 0
        ? `⚡ Revenus optimisés +${gain} € — ajustez si besoin`
        : '✅ Répartition optimale calculée — ajustez si besoin';
      showToast(msg, 'ok');
    }

  } catch(e) {
    result.innerHTML = `<div class="ai er">Erreur : ${e.message}</div>`;
  }
}

/**
 * _renderTourneeCabinetHTML — génère le HTML du planning multi-IDE
 */
function _renderTourneeCabinetHTML(assignments, scoreData) {
  if (!assignments?.length) return '<div class="ai in">Aucune répartition calculée.</div>';

  // Si cabinetBuildUI disponible, l'utiliser
  if (typeof cabinetBuildUI === 'function' && scoreData) {
    return cabinetBuildUI(assignments, scoreData);
  }

  const colors = ['var(--a)', 'var(--w)', '#4fa8ff', '#ff6b6b'];

  const rows = assignments.map((a, idx) => {
    const c = colors[idx % colors.length];
    const nb = a.patients?.length || 0;
    const pts = (a.patients || []).slice(0, 5).map(p =>
      `<div style="font-size:11px;color:var(--m);padding:2px 0">· ${p.label || p.description || p.patient_id || 'Patient'}</div>`
    ).join('');
    const more = nb > 5 ? `<div style="font-size:11px;color:var(--m)">+ ${nb - 5} autres…</div>` : '';

    return `<div style="padding:12px;border:1px solid var(--b);border-radius:10px;margin-bottom:10px;border-left:4px solid ${c}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="width:10px;height:10px;border-radius:50%;background:${c};flex-shrink:0"></div>
        <strong style="font-size:14px">${a.prenom || ''} ${a.nom || a.ide_id || 'IDE'}</strong>
        <span style="margin-left:auto;font-size:12px;background:var(--s);padding:2px 8px;border-radius:20px;border:1px solid var(--b)">${nb} patient(s)</span>
      </div>
      ${pts}${more}
    </div>`;
  }).join('');

  const totalRev = scoreData?.total_revenue?.toFixed(2) || '?';
  const totalKm  = scoreData?.total_km?.toFixed(1) || '?';

  return `${rows}
    <div style="margin-top:12px;padding:10px 14px;background:rgba(0,212,170,.08);border-radius:8px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px">
      <span>💶 <strong>${totalRev} €</strong> estimés</span>
      <span>🚗 <strong>${totalKm} km</strong></span>
      <span>👥 <strong>${assignments.length} IDEs</strong></span>
    </div>`;
}

/* ════════════════════════════════════════════════════════
   LISTENER CABINET MODE — câblé une seule fois au boot
   Utilise addEventListener (pas onchange inline) pour pouvoir
   distinguer les clics utilisateur des modifications par code.
   On utilise un flag _ignoreNextCabinetChange pour éviter que
   la mise à jour programmatique de checked déclenche l'event.
════════════════════════════════════════════════════════ */
(function _initCabinetCheckboxListener() {
  function _bindCabinetCheckbox() {
    const cb = document.getElementById('pla-cabinet-mode');
    if (!cb || cb._cabinetListenerBound) return;
    cb._cabinetListenerBound = true;
    cb.addEventListener('change', function(e) {
      // Ignorer si c'est une modification programmatique (pas un vrai clic)
      if (this._programmaticChange) return;
      planningToggleCabinetView(this.checked);
    });
  }
  // Essayer au boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bindCabinetCheckbox);
  } else {
    _bindCabinetCheckbox();
  }
  // Retry après navigation (SPA)
  document.addEventListener('app:nav', () => setTimeout(_bindCabinetCheckbox, 200));
  document.addEventListener('ui:navigate', () => setTimeout(_bindCabinetCheckbox, 200));
  window._bindCabinetCheckbox = _bindCabinetCheckbox;
})();



/* ════════════════════════════════════════════════════════════════════
   TRAJET CABINET — UI Pilotage de journée v2
   ────────────────────────────────────────────────────────────────────
   Lit directement les données de la Tournée optimisée par IA :
     APP.get('uberPatients')  → liste des patients avec distances leg
     APP.get('tourneeKmJour') → distance totale OSRM en km
     APP.get('startPoint')    → point de départ {lat,lng}
   Aucun champ dupliqué — seule la sélection IDE est demandée.
═════════════════════════════════════════════════════════════════════= */

async function _initLiveCabinetTrajetUI() {
  const card    = document.getElementById('live-cabinet-km-card');
  const noCab   = document.getElementById('live-cab-no-cabinet');
  const form    = document.getElementById('live-cab-form');
  const recap   = document.getElementById('km-cab-tournee-recap');
  const noTour  = document.getElementById('km-cab-no-tournee');
  if (!card) return;

  card.style.display = 'block';

  const cab = (typeof APP !== 'undefined' && APP.get) ? APP.get('cabinet') : null;

  // ── Pas de cabinet ──────────────────────────────────────────────
  if (!cab?.id) {
    if (noCab) noCab.style.display = 'block';
    if (form)  form.style.display  = 'none';
    return;
  }
  if (noCab) noCab.style.display = 'none';
  if (form)  form.style.display  = 'block';

  // ── Lire les données de la tournée ─────────────────────────────
  const uberPats = (typeof APP !== 'undefined' && APP.get) ? (APP.get('uberPatients') || []) : [];
  const totalKm  = (typeof APP !== 'undefined' && APP.get)
    ? (APP.get('tourneeKmJour') || parseFloat(localStorage.getItem('ami_tournee_km') || '0') || 0)
    : 0;
  const startPt  = (typeof APP !== 'undefined' && APP.get) ? APP.get('startPoint') : null;
  const today    = new Date().toISOString().slice(0, 10);

  // Patients filtrés : ceux qui ont un nom
  const patients = uberPats
    .map((p, i) => ({
      nom:    ((p.nom || '') + ' ' + (p.prenom || '')).trim() || p.label || p.description || `Patient ${i + 1}`,
      km:     p._legKm || null,   // km du leg individuel si dispo
      adresse: p.adresse || p.addressFull || p.address || '',
    }))
    .filter(p => p.nom && !p.nom.startsWith('Patient '));

  // Dernier patient = destination finale
  const lastPat = patients.length ? patients[patients.length - 1] : null;

  // ── Récapitulatif tournée ───────────────────────────────────────
  if (recap) {
    if (!uberPats.length || totalKm <= 0) {
      // Pas de tournée calculée
      recap.innerHTML = '';
      if (noTour) noTour.style.display = 'block';
    } else {
      if (noTour) noTour.style.display = 'none';

      const patBadges = patients.length
        ? patients.map(p =>
            `<span style="display:inline-flex;align-items:center;gap:4px;
              background:rgba(79,168,255,.07);border:1px solid rgba(79,168,255,.15);
              border-radius:20px;padding:3px 10px;font-family:var(--fm);font-size:11px;color:var(--a2);margin:2px">
              👤 ${p.nom}${p.km ? ` <em style="font-size:10px;opacity:.7">${p.km} km</em>` : ''}
            </span>`
          ).join('')
        : `<span style="font-size:11px;color:var(--m);font-style:italic">Aucun patient nommé dans la tournée.</span>`;

      recap.innerHTML = `
        <div style="background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);
          border-radius:10px;padding:14px">
          <div style="font-family:var(--fm);font-size:10px;color:var(--a);text-transform:uppercase;
            letter-spacing:1.5px;margin-bottom:10px">📋 Données de la Tournée optimisée</div>

          <!-- Métriques -->
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
            <div style="background:var(--s);border:1px solid var(--b);border-radius:8px;padding:8px 14px;flex:1;min-width:90px;text-align:center">
              <div style="font-size:18px;font-weight:700;color:var(--a)">${totalKm.toFixed(1)}</div>
              <div style="font-size:10px;color:var(--m);font-family:var(--fm)">km OSRM</div>
            </div>
            <div style="background:var(--s);border:1px solid var(--b);border-radius:8px;padding:8px 14px;flex:1;min-width:90px;text-align:center">
              <div style="font-size:18px;font-weight:700;color:var(--a2)">${uberPats.length}</div>
              <div style="font-size:10px;color:var(--m);font-family:var(--fm)">patient${uberPats.length > 1 ? 's' : ''}</div>
            </div>
            <div style="background:var(--s);border:1px solid var(--b);border-radius:8px;padding:8px 14px;flex:1;min-width:90px;text-align:center">
              <div style="font-size:14px;font-weight:700;color:var(--t)">${new Date(today).toLocaleDateString('fr-FR', {weekday:'short',day:'2-digit',month:'short'})}</div>
              <div style="font-size:10px;color:var(--m);font-family:var(--fm)">date</div>
            </div>
          </div>

          <!-- Patients -->
          <div style="margin-bottom:10px">
            <div style="font-size:11px;font-family:var(--fm);color:var(--m);margin-bottom:6px">PATIENTS</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${patBadges}</div>
          </div>

          <!-- Départ → Arrivée -->
          <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--m)">
            <span style="background:rgba(0,212,170,.1);color:var(--a);border:1px solid rgba(0,212,170,.2);
              border-radius:6px;padding:2px 8px;font-family:var(--fm)">
              📍 Départ : ${startPt ? `${startPt.lat?.toFixed(4)}, ${startPt.lng?.toFixed(4)}` : 'Point de départ tournée'}
            </span>
            <span style="color:var(--b)">→</span>
            <span style="background:rgba(79,168,255,.08);color:var(--a2);border:1px solid rgba(79,168,255,.15);
              border-radius:6px;padding:2px 8px;font-family:var(--fm)">
              🏁 ${lastPat ? lastPat.nom : 'Dernier patient'}
            </span>
          </div>
        </div>`;
    }
  }

  // ── Membres IDEs ─────────────────────────────────────────────────
  const nursesList = document.getElementById('km-cab-nurses-list');
  if (nursesList) {
    const members = cab.members || [];
    const me = (typeof APP !== 'undefined') ? APP.user : null;

    const allIDEs = [...members];
    if (me && !allIDEs.find(m => m.id === me.id)) {
      allIDEs.unshift({ id: me.id, nom: me.nom || '', prenom: me.prenom || '', role: 'me' });
    }

    if (!allIDEs.length) {
      nursesList.innerHTML = '<div style="font-size:12px;color:var(--m);font-style:italic">Aucun membre dans le cabinet.</div>';
    } else {
      nursesList.innerHTML = allIDEs.map(m => {
        const label = `${m.prenom || ''} ${m.nom || ''}`.trim() || m.id;
        const isMe  = m.id === me?.id;
        const icon  = m.role === 'titulaire' ? '👑' : isMe ? '🙋' : '👤';
        return `
          <label style="display:inline-flex;align-items:center;gap:7px;padding:7px 14px;
            background:${isMe ? 'rgba(0,212,170,.1)' : 'var(--s)'};
            border:1px solid ${isMe ? 'rgba(0,212,170,.35)' : 'var(--b)'};
            border-radius:20px;cursor:pointer;font-size:12px;color:var(--t);
            transition:background .15s;user-select:none"
            onmouseenter="this.style.background='rgba(0,212,170,.08)'"
            onmouseleave="this.style.background='${isMe ? 'rgba(0,212,170,.1)' : 'var(--s)'}'">
            <input type="checkbox"
              class="km-cab-nurse-cb"
              data-nurse-id="${m.id}"
              data-nurse-nom="${(m.nom || '').replace(/"/g, '&quot;')}"
              data-nurse-prenom="${(m.prenom || '').replace(/"/g, '&quot;')}"
              ${isMe ? 'checked' : ''}
              style="width:15px;height:15px;accent-color:var(--a);flex-shrink:0">
            <span>${icon} ${label}${isMe ? ' <em style="font-size:10px;color:var(--a);font-style:normal">(moi)</em>' : ''}</span>
          </label>`;
      }).join('');
    }
  }
}

// ── Auto-init à chaque navigation vers "live" ─────────────────────────
document.addEventListener('app:nav',     e => { if (e.detail?.view === 'live') _initLiveCabinetTrajetUI(); });
document.addEventListener('ui:navigate', e => { if (e.detail?.view === 'live') _initLiveCabinetTrajetUI(); });
// Re-init quand la tournée est recalculée (uberPatients mis à jour)
document.addEventListener('tournee:updated', () => {
  if (document.getElementById('view-live')?.classList.contains('on')) _initLiveCabinetTrajetUI();
});
if (typeof APP !== 'undefined' && APP.on) {
  APP.on('cabinet', () => {
    if (document.getElementById('view-live')?.classList.contains('on')) _initLiveCabinetTrajetUI();
  });
}

window._initLiveCabinetTrajetUI = _initLiveCabinetTrajetUI;
