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
    ${patients.map((p,i)=>`<div class="route-item"><div class="route-num">${i+1}</div><div class="route-info">
      <strong>${p.description||p.texte||p.summary||'Patient '+(i+1)}</strong>
      <div style="font-size:11px;color:var(--m);margin-top:2px">${p.heure_soin||p.heure||''} ${p.patient_id?'· ID:'+p.patient_id:''}</div>
    </div></div>`).join('')}
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
// ⚡ Restaurer l'état cabinet mode depuis localStorage (survive aux rechargements)
let _planningCabinetMode = (() => {
  try { return localStorage.getItem('ami_planning_cabinet_mode') === '1'; } catch { return false; }
})();

/** Naviguer d'une semaine en avant/arrière */
function planningWeekNav(delta) {
  _planningWeekOffset += delta;
  refreshPlanning();
}

/** Activer / désactiver la vue cabinet */
function planningToggleCabinetView(active) {
  _planningCabinetMode = !!active;
  // ⚡ Persister l'état pour survive aux refreshPlanning() asynchrones
  try { localStorage.setItem('ami_planning_cabinet_mode', active ? '1' : '0'); } catch {}
  refreshPlanning();
}

/** Affiche ou masque le toggle cabinet selon APP.cabinet */
function _planningInitCabinetUI() {
  const wrap   = document.getElementById('pla-cabinet-toggle-wrap');
  const btnCab = document.getElementById('btn-pla-cabinet');
  const cab    = typeof APP !== 'undefined' && APP.get ? APP.get('cabinet') : null;
  const hasCab = !!(cab?.id);

  if (wrap) {
    // ⚡ Ne jamais masquer si mode cabinet actif — évite que le chargement async efface l'état
    if (hasCab || _planningCabinetMode) wrap.style.display = 'block';
    else wrap.style.display = 'none';
    const label = wrap.querySelector('label');
    if (label) { label.style.opacity = '1'; label.title = ''; }
    const cb = wrap.querySelector('input[type=checkbox]');
    if (cb) {
      cb.disabled = false;
      // ⚡ Ne pas écraser checked si l'utilisateur vient de cocher
      if (cb.checked !== _planningCabinetMode) cb.checked = _planningCabinetMode;
    }
  }
  if (btnCab) btnCab.style.display = (hasCab || _planningCabinetMode) ? 'inline-flex' : 'none';

  // Retry si cabinet pas encore chargé — déclencher un re-render quand il arrive
  if (!hasCab && !window._planningCabinetInitDone) {
    setTimeout(() => {
      const cabRetry = typeof APP !== 'undefined' && APP.get ? APP.get('cabinet') : null;
      if (cabRetry?.id) {
        _planningCabinetInitDone = true;
        _planningInitCabinetUI();
        if (_planningCabinetMode) renderPlanning({}).catch(() => {});
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
  _planningCabinetMode = true;
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
    const desc=p.description||p.texte||p.summary||'Soin infirmier';
    const freq=p.frequence||p.recurrence||'quotidien';
    return `Patient P${i+1} : ${desc} (${freq})`;
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

  patientsToShow.forEach((p, listIdx) => {
    let jourKey = null;
    try {
      const pd = new Date(p.date);
      if (!isNaN(pd)) {
        const nomJour = pd.toLocaleDateString('fr-FR', { weekday: 'long' }).toLowerCase();
        jourKey = JOURS.find(j => nomJour.startsWith(j)) || null;
      }
    } catch {}
    if (!jourKey) {
      const desc = (p.description || p.texte || '').toLowerCase();
      jourKey = JOURS.find(j => desc.includes(j)) || null;
    }
    // ⚡ Fallback stable : hash basé sur patient_id/nom, pas sur listIdx (qui change)
    if (!jourKey) {
      const stableKey = (p.patient_id || p.id || p.nom || String(listIdx));
      let hash = 0;
      for (let ci = 0; ci < stableKey.length; ci++) hash = (hash * 31 + stableKey.charCodeAt(ci)) & 0x7fffffff;
      jourKey = JOURS[hash % JOURS.length];
    }
    byDay[jourKey].patients.push(p);
  });

  // ── Cabinet : calcul répartition multi-IDE ───────────────────────────────
  const cab = APP.get ? APP.get('cabinet') : null;
  // ⚡ Synchroniser _planningCabinetMode avec le DOM ET localStorage
  const _cbEl = document.getElementById('pla-cabinet-mode');
  if (_cbEl) {
    // DOM → mémoire (si l'utilisateur a coché manuellement)
    if (_cbEl.checked && !_planningCabinetMode) _planningCabinetMode = true;
    // Mémoire → DOM (restauration après rechargement)
    if (_planningCabinetMode && !_cbEl.checked) _cbEl.checked = true;
  }
  // Fallback localStorage si DOM pas encore dispo
  if (!_planningCabinetMode) {
    try { if (localStorage.getItem('ami_planning_cabinet_mode') === '1') _planningCabinetMode = true; } catch {}
  }

  // cabinetActive : mode actif suffit — ne bloque plus sur cab?.id
  const cabinetActive = !!_planningCabinetMode;
  if (cabinetActive && !cab?.id) {
    // Cabinet pas encore chargé → retry silencieux
    setTimeout(() => {
      const cabRetry = APP.get ? APP.get('cabinet') : null;
      if (cabRetry?.id) renderPlanning({}).catch(() => {});
    }, 800);
  }
  let cabinetAssignments = {};

  if (cabinetActive) {
    // Membres réels, ou synthétique si cab pas encore chargé / admin seul
    const effectiveMembers = (cab?.members?.length)
      ? cab.members
      : [{ id: APP.user?.id || 'ide_0', nom: APP.user?.nom || APP.user?.email?.split('@')[0] || '', prenom: APP.user?.prenom || 'Moi', role: 'titulaire' }];

    // ⚡ En mode cabinet, on distribue TOUS les patients (pas seulement patientsToShow)
    // La grille filtre déjà par jour dans chaque colonne → pas de risque de doublon
    const patientsForCabinet = patients.length ? patients : patientsToShow;

    // Initialiser les assignments pour chaque membre
    const COLORS = ['#00d4aa','#4fa8ff','#ff9f43','#ff6b6b','#a29bfe'];
    effectiveMembers.forEach((m, i) => {
      const ideId = m.id || m.infirmiere_id || `ide_${i}`;
      cabinetAssignments[ideId] = {
        nom:      m.nom    || '',
        prenom:   m.prenom || '',
        role:     m.role   || 'membre',
        patients: [],
        color:    COLORS[i % 5],
      };
    });

    // ⚡ Distribuer les patients : respecter _assignedIde (choix manuel) en priorité
    const patsWithManual    = patientsForCabinet.filter(p => p._assignedIde && cabinetAssignments[p._assignedIde]);
    const patsNeedsClustering = patientsForCabinet.filter(p => !p._assignedIde || !cabinetAssignments[p._assignedIde]);

    // Patients avec assignation manuelle → direct
    patsWithManual.forEach(p => {
      cabinetAssignments[p._assignedIde].patients.push(p);
    });

    // Patients sans assignation → clustering géographique
    if (patsNeedsClustering.length && typeof cabinetGeoCluster === 'function') {
      const clusters = cabinetGeoCluster(patsNeedsClustering, effectiveMembers.length);
      effectiveMembers.forEach((m, i) => {
        const ideId = m.id || m.infirmiere_id || `ide_${i}`;
        (clusters[i] || []).forEach(p => cabinetAssignments[ideId].patients.push(p));
      });
    } else if (patsNeedsClustering.length) {
      // Fallback : répartition circulaire
      patsNeedsClustering.forEach((p, i) => {
        const ideId = Object.keys(cabinetAssignments)[i % effectiveMembers.length];
        if (cabinetAssignments[ideId]) cabinetAssignments[ideId].patients.push(p);
      });
    }
  }

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
    let soin      = actes || (p.description || p.texte || '').trim();
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
      ${cot  ? `<div style="font-size:10px;color:var(--a);font-family:var(--fm);margin-bottom:6px">✅ Cotation : ${parseFloat(p._cotation.total||0).toFixed(2)} €</div>` : ''}
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
    const caValByIde = {}, caEstByIde = {};
    ideList.forEach(([ideId, a]) => {
      caValByIde[ideId] = a.patients.reduce((s, p) =>
        s + (p._cotation?.validated ? parseFloat(p._cotation.total||0) : 0), 0);
      caEstByIde[ideId] = typeof estimateRevenue === 'function'
        ? estimateRevenue(a.patients) : a.patients.length * 6.30;
    });
    const caValTotal = Object.values(caValByIde).reduce((s, v) => s + v, 0);
    const caEstTotal = Object.values(caEstByIde).reduce((s, v) => s + v, 0);

    // ── Sélecteur IDE pour réassigner un patient manuellement ─────────────
    function ideSelectHtml(p, currentIdeId) {
      const safeIdx = p._planIdx ?? -1;
      return `<select
        onchange="window._planningReassignIDE(this.value, ${safeIdx})"
        style="font-size:10px;font-family:var(--fm);padding:2px 5px;border-radius:6px;
               border:1px solid var(--b);background:var(--s);color:var(--t);cursor:pointer;
               max-width:120px;margin-top:4px">
        ${ideList.map(([id, a]) =>
          `<option value="${id}" ${id === currentIdeId ? 'selected' : ''}>${a.prenom} ${a.nom}</option>`
        ).join('')}
      </select>`;
    }

    // ── Carte patient compacte pour la grille cabinet ─────────────────────
    function patCardCab(p, ideId, color) {
      const nom   = p._nomAff || [p.prenom, p.nom].filter(Boolean).join(' ') || 'Patient';
      const soin  = (p.actes_recurrents || p.description || p.texte || '').slice(0, 55);
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
      const fromDesc = JOURS.find(jj => desc.includes(jj));
      if (fromDesc) return fromDesc;
      const stableKey = String(p.patient_id || p.id || p.nom || p._nomAff || '');
      if (stableKey) {
        let hash = 0;
        for (let ci = 0; ci < stableKey.length; ci++) hash = (hash * 31 + stableKey.charCodeAt(ci)) & 0x7fffffff;
        return JOURS[hash % JOURS.length];
      }
      return null;
    }

    // ── Grille jours × IDEs ───────────────────────────────────────────────
    const dayRows = JOURS.map((j, ji) => {
      const dateJ  = weekDates[ji];
      const _y = dateJ.getFullYear(), _m = String(dateJ.getMonth()+1).padStart(2,'0'), _d = String(dateJ.getDate()).padStart(2,'0');
      const isToday = `${_y}-${_m}-${_d}` === todayISO;
      const dateStr = dateJ.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
      const jourCap = j.charAt(0).toUpperCase() + j.slice(1);

      // Nb patients ce jour (tous IDEs confondus)
      const nbJour = ideList.reduce((s, [, a]) => s + a.patients.filter(p => resolveJour(p) === j).length, 0);

      const cols = ideList.map(([ideId, a]) => {
        const dayPats = a.patients.filter(p => resolveJour(p) === j);
        return `<div style="padding:6px 8px;min-height:44px;border-left:1px solid var(--b)">
          ${dayPats.length
            ? dayPats.map(p => patCardCab(p, ideId, a.color)).join('')
            : `<div style="font-size:11px;color:var(--b);text-align:center;padding:12px 0">—</div>`}
        </div>`;
      }).join('');

      return `<div style="display:grid;grid-template-columns:68px repeat(${ideList.length},1fr);border-bottom:1px solid var(--b)${isToday ? ';background:rgba(0,212,170,.03)' : ''}">
        <div style="padding:8px 6px;border-right:1px solid var(--b);display:flex;flex-direction:column;justify-content:center;gap:2px">
          <div style="font-size:11px;font-weight:${isToday ? '700' : '600'};color:${isToday ? 'var(--a)' : 'var(--t)'}">${jourCap}</div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm)">${dateStr}</div>
          ${isToday ? '<div style="font-size:9px;color:var(--a);font-family:var(--fm)">Auj.</div>' : ''}
          ${nbJour ? `<div style="font-size:9px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);padding:1px 5px;border-radius:10px;text-align:center;margin-top:2px">${nbJour}</div>` : ''}
        </div>
        ${cols}
      </div>`;
    }).join('');

    return `
      <!-- En-tête IDEs avec CA estimé par IDE -->
      <div style="display:grid;grid-template-columns:68px repeat(${ideList.length},1fr);border-radius:10px 10px 0 0;overflow:hidden;border:1px solid var(--b)">
        <div style="padding:8px 6px;background:var(--s);display:flex;align-items:center;justify-content:center">
          <span style="font-size:10px;color:var(--m);font-family:var(--fm);text-align:center">Jour</span>
        </div>
        ${ideList.map(([ideId, a]) => {
          const caV = caValByIde[ideId] || 0;
          const caE = caEstByIde[ideId] || 0;
          const shown = caV > 0 ? caV : caE;
          const isVal = caV > 0;
          return `<div style="padding:10px 12px;background:${a.color}12;border-left:1px solid var(--b);border-top:3px solid ${a.color}">
            <div style="font-weight:700;font-size:13px;color:var(--t)">${a.prenom} ${a.nom}</div>
            <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-top:2px">${a.role === 'titulaire' ? '👑' : '👤'} · ${a.patients.length} patient(s)</div>
            <div style="font-size:12px;font-weight:700;color:${a.color};font-family:var(--fm);margin-top:5px">
              💶 ${shown.toFixed(2)} €
              <span style="font-size:9px;font-weight:400;opacity:.7">${isVal ? 'validé' : 'estimé'}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
      <!-- Grille jours × IDEs -->
      <div style="border:1px solid var(--b);border-top:none;border-radius:0 0 10px 10px;overflow:hidden">
        ${dayRows}
      </div>
      <!-- Barre récap CA cabinet semaine -->
      <div style="margin-top:12px;padding:14px 16px;background:rgba(0,212,170,.07);border:1px solid rgba(0,212,170,.2);border-radius:10px">
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
          <div style="flex:1;min-width:150px">
            <div style="font-size:10px;color:var(--m);font-family:var(--fm);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">CA ESTIMÉ SEMAINE · CABINET</div>
            <div style="font-size:20px;font-weight:700;color:var(--a)">${(caValTotal > 0 ? caValTotal : caEstTotal).toFixed(2)} €</div>
            <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-top:2px">${caValTotal > 0 ? 'cotations validées' : 'estimation NGAP'} · ${patientsForCabinet.length} patient(s)</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${ideList.map(([ideId, a]) => {
              const shown = (caValByIde[ideId]||0) > 0 ? caValByIde[ideId] : caEstByIde[ideId]||0;
              return `<div style="padding:8px 12px;background:${a.color}12;border:1px solid ${a.color}30;border-radius:8px;text-align:center;min-width:80px">
                <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-bottom:2px">${a.prenom}</div>
                <div style="font-size:14px;font-weight:700;color:${a.color}">${shown.toFixed(2)} €</div>
                <div style="font-size:9px;color:var(--m);font-family:var(--fm)">${a.patients.length} pat.</div>
              </div>`;
            }).join('')}
          </div>
          <button onclick="planningOptimiseCabinetWeek()" class="btn bs bsm" style="font-size:11px;white-space:nowrap">⚡ Optimiser</button>
        </div>
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

  $('pbody').innerHTML = `
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

      <!-- KPI bande -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${caWeek ? `<div style="background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">CA ESTIMÉ SEMAINE</div><div style="color:var(--a);font-weight:700">${caWeek.toFixed(2)} €</div></div>` : ''}
        ${nbCot > 0 ? `<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">COTATIONS VALIDÉES</div><div style="color:#22c55e;font-weight:700">${totalCot.toFixed(2)} €</div></div>` : ''}
        ${cabinetActive ? `<div style="background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">CABINET</div><div style="color:var(--a);font-weight:700">${Object.keys(cabinetAssignments).length} IDE(s)</div></div>` : ''}
      </div>

      ${cabinetBar}

      <!-- Vue dynamique : cabinet ou solo -->
      ${cabinetActive ? renderCabinetView() : renderSoloView()}
    </div>`;

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
  const planData = window.APP._planningData;
  const arr = planData?.patients
    || APP.importedData?.patients
    || APP.importedData?.entries
    || [];
  if (patientIdx < 0 || patientIdx >= arr.length) return;

  // Stocker l'assignation IDE dans le patient (clé _assignedIde)
  arr[patientIdx] = { ...arr[patientIdx], _assignedIde: newIdeId };

  // Persister + re-render
  _savePlanning(arr);
  _syncPlanningToServer(arr).catch(() => {});
  renderPlanning({}).catch(() => {});
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
async function getOsrmRoute(waypoints){
  // waypoints = [{lat,lng}, ...]
  if(!waypoints||waypoints.length<2)return null;
  try{
    const coords=waypoints.map(w=>`${w.lng},${w.lat}`).join(';');
    const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&steps=false`);
    const d=await r.json();
    if(d.code!=='Ok')return null;
    const route=d.routes[0];
    return{
      total_km:Math.round(route.distance/100)/10,
      total_min:Math.round(route.duration/60),
      legs:route.legs.map(l=>({km:Math.round(l.distance/100)/10,min:Math.round(l.duration/60)}))
    };
  }catch{return null;}
}

/* ============================================================
   TOURNÉE IA — Moteur local VRPTW + 2-opt + MAP PREMIUM
   ============================================================ */
async function optimiserTournee(){
  if(!requireAuth()) return;

  const rawPatients = APP.get('importedData')?.patients || APP.get('importedData')?.entries || [];
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

  const startLat = parseFloat($('t-lat')?.value) || APP.get('startPoint')?.lat || null;
  const startLng = parseFloat($('t-lng')?.value) || APP.get('startPoint')?.lng || null;
  if(!startLat || !startLng){
    $('terr').style.display='flex';
    $('terr-m').textContent='📍 Définis ton point de départ (bouton GPS ou clic sur la carte)';
    $('res-tur').classList.add('show'); return;
  }

  ld('btn-tur',true); $('res-tur').classList.remove('show');
  _showOptimProgress('🧠 Calcul des temps de trajet réels…');

  /* ── Lire le mode d'optimisation choisi ── */
  const optimMode = getOptimMode();

  try {
    const startPoint = { lat: startLat, lng: startLng };

    /* ── MODE HEURES PRÉFÉRÉES : tri chronologique strict ── */
    if (optimMode === 'heure') {
      _showOptimProgress('🕐 Tri par heures préférées…');
      const withHeure  = rawPatients.filter(p => p.heure_preferee || p.heure_soin).sort((a,b)=>
        (a.heure_preferee||a.heure_soin||'99:99').localeCompare(b.heure_preferee||b.heure_soin||'99:99'));
      const withoutH   = rawPatients.filter(p => !p.heure_preferee && !p.heure_soin);
      let route        = [...withHeure, ...withoutH];
      route            = applyPassageConstraints(route);
      const ca         = estimateRevenue(route);
      const pts        = route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
      let osrm = null;
      if(pts.length >= 2) osrm = await getOsrmRoute([startPoint,...pts]);
      $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, null, 'heure');
      $('terr').style.display = 'none';
      if(osrm?.total_km) {
        APP.set('tourneeKmJour', osrm.total_km);
        try { localStorage.setItem('ami_tournee_km', String(osrm.total_km)); } catch {}
      }
      if(typeof renderPatientsOnMap === 'function')
        renderPatientsOnMap(route, startPoint).catch(()=>{});
      APP.set('uberPatients', route.map((p,i)=>({...p,id:p.patient_id||p.id||i,label:p.description||'Patient '+(i+1),done:false,absent:false,late:false,amount:parseFloat(p.total||p.montant||0)||estimateRevenue([p])})));
      startLiveOptimization();
      $('res-tur').classList.add('show');
      ld('btn-tur',false);
      return;
    }

    /* ── 1. Moteur IA local — VRPTW greedy + cache OSRM ── */
    // Badge trafic en temps réel pendant l'optimisation
    const _tfInfo = (typeof getTrafficInfo === 'function') ? getTrafficInfo(startTimeMin) : { label: '' };
    _showOptimProgress(`⚡ Optimisation VRPTW en cours… ${_tfInfo.label}`);
    /* Heure de départ = heure actuelle en minutes depuis minuit (pas 8h00 fixe) */
    const _now = new Date();
    const startTimeMin = _now.getHours() * 60 + _now.getMinutes();
    let route = await optimizeTour(rawPatients, startPoint, startTimeMin, optimMode);

    /* ── 2. 2-opt — amélioration du chemin (sauf si contraintes strictes) ── */
    _showOptimProgress('🔁 Optimisation 2-opt…');
    route = twoOpt(route);

    /* ── 2b. Appliquer les contraintes de passage (premier/suivant obligatoire) ── */
    route = applyPassageConstraints(route);

    /* ── 2c. Enrichir route avec CA estimé par patient ──────────────────────
       scoreTourneeRentabilite lit p.total || p.amount.
       Les patients importés n'ont ni l'un ni l'autre → totalCA = 0 → 0€/h.
       On injecte le CA estimé individuellement via estimateRevenue([patient]).
    ─────────────────────────────────────────────────────────────────────── */
    route = route.map(p => {
      if (parseFloat(p.total || p.amount || 0) > 0) return p; // déjà valorisé
      const ca = estimateRevenue([p]);
      return { ...p, amount: ca };
    });

    /* ── 3. Scoring rentabilité ───────────────────────── */
    const ca     = estimateRevenue(route);
    const rentab = scoreTourneeRentabilite(route);

    /* ── 4. OSRM route pour distances précises ────────── */
    let osrm = null;
    const pts = route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
    if(pts.length >= 2) {
      const wps = [startPoint, ...pts];
      osrm = await getOsrmRoute(wps);
    }

    /* ── 5. Rendu liste ───────────────────────────────── */
    $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, rentab, optimMode);
    $('terr').style.display = 'none';
    if(osrm?.total_km) {
      APP.set('tourneeKmJour', osrm.total_km);
      try { localStorage.setItem('ami_tournee_km', String(osrm.total_km)); } catch {}
    }

    /* ── 6. Map premium — markers + route + timeline ──── */
    if(typeof renderPatientsOnMap === 'function') {
      renderPatientsOnMap(route, startPoint).catch(e=>logWarn('renderPatientsOnMap:',e.message));
    }

    /* ── 7. Préparer patients Uber pour mode live ─────── */
    APP.set('uberPatients', route.map((p,i) => ({
      ...p,
      id:      p.patient_id || p.id || i,
      label:   p.description || p.label || 'Patient '+(i+1),
      done:    false, absent: false, late: false,
      urgence: !!(p.urgent || p.urgence),
      time:    p.start_min ? p.start_min * 60000 : null,
      // amount : cotation réelle > montant enrichi (étape 2b) > estimation
      amount:  parseFloat(p.total || p.montant || 0) || parseFloat(p.amount || 0) || estimateRevenue([p]),
    })));

    /* ── 8. Démarrer optimisation live ───────────────── */
    startLiveOptimization();

  } catch(e) {
    /* Fallback API backend si moteur local échoue */
    logWarn('Moteur IA local échoué, fallback API:', e.message);
    await _optimiserTourneeAPI(startLat, startLng);
  }

  $('res-tur').classList.add('show');
  ld('btn-tur',false);
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
          const rows = await _idbGetAll(PATIENTS_STORE);
          for (const row of rows) {
            const p = { id: row.id, ...((typeof _dec === 'function' ? _dec(row._data) : {}) || {}) };
            if (!Array.isArray(p.cotations)) continue;
            for (const cot of p.cotations) {
              if (cot._synced) continue;
              if (cot.source === 'cotation_edit' || cot.source === 'ngap_edit') continue;
              // Ne pas re-envoyer les cotations déjà envoyées depuis la mémoire (même invoice_number)
              if (cot.invoice_number && fromMemory.some(m => m._cotation?.invoice_number === cot.invoice_number)) continue;
              const cotDate = (cot.date || '').slice(0, 10);
              const sevenDaysAgo = new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10);
              if (cotDate < sevenDaysAgo) continue;
              if (parseFloat(cot.total || 0) <= 0) continue;
              fromIDB.push({
                _idb_patient_id: row.id,
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

    const cotations = allToSync
      // Ne jamais envoyer sans actes valides (évite les entrées DIM-seul parasites)
      .filter(p => (p._cotation.actes || []).length > 0 && parseFloat(p._cotation.total || 0) > 0)
      .map(p => ({
        actes:          p._cotation.actes || [],
        total:          parseFloat(p._cotation.total || 0),
        date_soin:      p._cotation._tournee_date || new Date().toISOString().slice(0, 10),
        heure_soin:     p.heure_soin || p.heure_preferee || p._idb_cot?.heure || null,
        soin:           (p.description || p.texte || p._idb_cot?.soin || '').slice(0, 200),
        source:         p._cotation.auto ? 'tournee_auto' : 'tournee_live',
        dre_requise:    !!p._cotation.dre_requise,
        // invoice_number existant -> PATCH (correction), sinon POST (nouvelle ligne)
        invoice_number: p._cotation.invoice_number || null,
      }));

    const result = await apiCall('/webhook/ami-save-cotation', { cotations });
    if (result?.ok) {
      // Marquer comme synced en mémoire
      fromMemory.forEach(p => { if (p._cotation) p._cotation._synced = true; });
      // Marquer comme synced dans IDB
      for (const item of fromIDB) {
        try {
          const rows = await _idbGetAll(PATIENTS_STORE);
          const row = rows.find(r => r.id === item._idb_patient_id);
          if (!row) continue;
          const pat = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data) || {}) };
          if (Array.isArray(pat.cotations)) {
            const c = pat.cotations.find(c => c.date === item._idb_cot.date && c.total === item._idb_cot.total);
            if (c) c._synced = true;
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

    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap', texte: texteForCot,
      infirmiere: ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
      adeli: u.adeli||'', rpps: u.rpps||'', structure: u.structure||'',
      date_soin: new Date().toISOString().split('T')[0],
      heure_soin: patient.heure_soin || patient.heure_preferee || new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}),
      _live_auto: true,
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

function _processImportData(content, source) {
  const result = $('imp-result');
  if (!result) return;

  let parsed    = null;
  let patients  = [];

  // Tentative JSON
  try {
    parsed = JSON.parse(content);
    const found = parsed.patients || parsed.entries || (Array.isArray(parsed) ? parsed : null);
    if (found) patients = found;
  } catch { /* pas JSON */ }

  // Tentative ICS / texte libre
  if (!patients.length) {
    const lines = content.split('\n').filter(l => l.trim().length > 3);
    patients = lines.map((l, i) => {
      // Essayer d'extraire une adresse depuis la ligne (format : "Nom — 12 rue X, Ville")
      const addrMatch = l.match(/(?:—|-|:)\s*(\d+[^,\n]+(?:rue|avenue|bd|boulevard|allée|impasse|chemin|place|villa|résidence)[^,\n]+(?:,\s*\d{5}[^,\n]*)?)/i);
      return {
        id:          'imp_' + i,
        description: l.trim().replace(/^[-*•→]+\s*/, ''),
        texte:       l.trim(),
        heure_soin:  (l.match(/(\d{1,2})[hH:](\d{2})/) || [])[0] || '',
        adresse:     addrMatch ? addrMatch[1].trim() : '',
      };
    });
  }

  storeImportedData({ patients, total: patients.length, source });

  // ── Auto-ajout dans le Carnet patients ────────────────────────────────────
  // Chaque patient importé avec un nom/prénom identifiable est ajouté au carnet
  // s'il n'y est pas déjà (déduplication par nom + prénom normalisés).
  // Ceci assure que Planning ↔ Carnet restent cohérents sans doublon.
  _autoAddImportedToCarnet(patients).catch(() => {});

  // Compter les patients avec adresse pour proposer le géocodage
  const withAddr = patients.filter(p => p.adresse && p.adresse.trim()).length;
  const missingGPS = patients.filter(p => (!p.lat || !p.lng) && p.adresse && p.adresse.trim()).length;

  result.innerHTML = `
    <div class="ai su">
      ✅ Import réussi depuis <strong>${source}</strong><br>
      📋 <strong>${patients.length}</strong> entrée(s) chargée(s)
      ${missingGPS > 0
        ? `<br><span style="font-size:12px;color:var(--w)">⚠️ ${missingGPS} adresse(s) sans coordonnées GPS</span>`
        : withAddr > 0
          ? `<br><span style="font-size:12px;color:var(--a)">📍 ${withAddr} adresse(s) détectée(s)</span>`
          : ''}
      <span style="font-size:11px;color:var(--m);margin-top:4px;display:block">Allez dans <strong>Planning</strong> ou <strong>Tournée IA</strong> pour utiliser ces données.</span>
    </div>
    ${missingGPS > 0 ? `
    <div style="margin-top:10px">
      <button class="btn bv bsm" id="btn-geocode-import" onclick="geocodeImportedPatients()">
        <span>📡</span> Résoudre ${missingGPS} adresse(s) GPS
      </button>
      <span style="font-size:11px;color:var(--m);margin-left:8px">Recommandé pour optimiser la tournée</span>
    </div>` : ''}`;
  result.classList.add('show');
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

      // Construire la fiche minimale avec toutes les données disponibles
      const fiche = {
        nom:         nom.trim(),
        prenom:      prenom.trim(),
        ddn:         p.ddn || p.date_naissance || '',
        adresse:     p.adresse || p.address || p.addressFull || '',
        street:      p.street || '',
        zip:         p.zip || '',
        city:        p.city || '',
        lat:         p.lat || null,
        lng:         p.lng || null,
        telephone:   p.telephone || p.tel || '',
        medecin:     p.medecin || '',
        amo:         p.amo || '',
        amc:         p.amc || '',
        exo:         p.exo || '',
        notes:       p.notes || p.description || '',
        ordonnances: [],
        cotations:   [],
        _source:     'import_calendrier',
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
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
  if (/perfusion|perf|intraveineux|iv|antibio|chimio/.test(t)) {
    actes.push({ code:'AMI5', nom:'Perfusion à domicile', total:15.75 }); total += 15.75;
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

  // Initialiser le premier patient actif
  const firstP = patients[0];
  const _isAdminSD = false; // unused, kept for reference
  if(firstP){
    LIVE_PATIENT_ID = firstP.patient_id || firstP.id || null;
    $('live-patient-name').textContent = firstP.description||firstP.texte||'Premier patient';
    $('live-info').textContent = `Soin 1/${patients.length}${firstP.heure_soin?' · '+firstP.heure_soin:''}`;
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

  /* ── Démarrer le moteur IA temps réel ── */
  if(typeof startLiveOptimization==='function') startLiveOptimization();

  // Afficher la liste des patients
  renderLivePatientList();

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

  // Écrire uniquement dans uber-next-patient (visible) — live-next reste caché (compat fantôme)
  const el = $('uber-next-patient');
  if (!el) return;

  if (!orderedPatients.length) {
    el.innerHTML = `<div class="card">
      <div class="ai wa">⚠️ Aucun patient importé. Allez dans <strong>Import calendrier</strong> ou <strong>Tournée IA</strong> pour importer des patients.</div>
      <button class="btn bp bsm" style="margin-top:10px" onclick="navTo('imp',null)"><span>📂</span> Importer des patients</button>
    </div>`;
    return;
  }

  const done   = orderedPatients.filter(p => p._done).length;
  const absent = orderedPatients.filter(p => p._absent).length;
  const reste  = orderedPatients.length - done - absent;

  const caRealise = orderedPatients.filter(p => p._done).reduce((s, p) => {
    if (p._cotation?.validated) return s + parseFloat(p._cotation.total || 0);
    if (p.amount > 0) return s + parseFloat(p.amount);
    return s;
  }, 0);

  const html = `<div class="card">
    <div class="ct" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span>📋 Patients de la journée (${orderedPatients.length})</span>
      <button class="btn bs bsm" onclick="removeAllImportedPatients()" style="font-size:11px;padding:4px 10px">🗑️ Tout supprimer</button>
    </div>
    <div style="display:flex;gap:8px;margin:10px 0 14px;flex-wrap:wrap">
      <span class="dreb" style="background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3);color:#22c55e">✅ ${done} fait(s)</span>
      <span class="dreb" style="background:rgba(255,95,109,.08);border-color:rgba(255,95,109,.2);color:var(--d)">❌ ${absent} absent(s)</span>
      <span class="dreb">⏳ ${reste} restant(s)</span>
      ${caRealise > 0 ? `<span class="dreb" style="background:rgba(0,212,170,.08);border-color:rgba(0,212,170,.25);color:var(--a)">💶 ${caRealise.toFixed(2)} € réalisés</span>` : ''}
    </div>
    ${orderedPatients.map((p, i) => {
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
      return `<div class="route-item" style="background:${statusColor};${borderStyle}border-radius:10px;margin-bottom:6px;padding:10px 12px;align-items:center">
        <div class="route-num" style="font-size:16px">${statusIcon}</div>
        <div class="route-info" style="flex:1;min-width:0">
          <strong style="font-size:13px${isNext ? ';color:var(--a)' : ''}">${desc}</strong>
          ${isNext ? `<div style="font-size:10px;font-family:var(--fm);color:var(--a);margin-top:1px">▶ Prochain patient</div>` : ''}
          ${heure ? `<div style="font-size:11px;color:var(--m);margin-top:2px">🕐 ${heure}</div>` : ''}
          ${p._cotation?.validated ? `<div style="font-size:10px;color:var(--a);margin-top:2px;font-family:var(--fm)">✅ ${p._cotation.total?.toFixed(2)} € validés</div>` : ''}
        </div>
        ${(p.lat && p.lng) || p.adresse || p.addressFull ? `<button class="btn bv bsm" onclick="openNavigation(${JSON.stringify({lat:p.lat,lng:p.lng,address:p.adresse||p.addressFull||p.address||'',addressFull:p.addressFull||p.adresse||'',adresse:p.adresse||p.addressFull||'',geoScore:p.geoScore||0}).replace(/"/g,'&quot;')})" style="font-size:11px;padding:4px 8px;flex-shrink:0" title="Naviguer vers ce patient">🗺️</button>` : ''}

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
  const heure = patient.heure_soin || patient.heure_preferee || patient.heure || '';
  const desc  = (patient.description || patient.texte || 'Soin infirmier').slice(0, 100);

  /* Catalogue d'actes courants pour ajout rapide — Tarifs NGAP 2026 */
  const ACTES_RAPIDES = [
    { code:'AMI1',      nom:'Soin infirmier',         total: 3.15 },
    { code:'AMI2',      nom:'Acte infirmier ×2',      total: 6.30 },
    { code:'AMI4',      nom:'Pansement complexe',     total:12.60 },
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
        ${heure ? `<div style="font-size:11px;color:var(--m);margin-top:3px;font-family:var(--fm)">🕐 Heure de soin : ${heure}</div>` : ''}
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

  // Correction CA : soustraire l'ancien montant avant d'ajouter le nouveau
  const ancienTotal = patient?._cotation?.validated ? parseFloat(patient._cotation.total || 0) : 0;
  LIVE_CA_TOTAL = Math.max(0, LIVE_CA_TOTAL - ancienTotal) + total;
  const caEl = $('live-ca-total');
  if (caEl) { caEl.textContent = `💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`; caEl.style.display = 'block'; }

  if (patient) patient._caCardCounted = true;
  updateLiveCaCard(patient, { actes, total });

  // Conserver l'invoice_number existant (evite un nouvel ID a chaque correction)
  const existingInvoice = patient?._cotation?.invoice_number || null;

  if (patient) patient._cotation = {
    actes,
    total,
    validated:      true,
    invoice_number: existingInvoice,
    _tournee_date:  patient._cotation?._tournee_date || new Date().toISOString().slice(0, 10),
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
      const today     = new Date().toISOString().slice(0, 10);
      const soinLabel = (patient.description || patient.texte || '').slice(0, 120);
      // Chercher la cotation existante par invoice_number (plus fiable),
      // puis par source tournee + date du jour (fallback)
      let existingIdx = existingInvoice
        ? p.cotations.findIndex(c => c.invoice_number === existingInvoice)
        : -1;
      if (existingIdx < 0) {
        existingIdx = p.cotations.findIndex(c =>
          (c.source === 'tournee' || c.source === 'tournee_auto' || c.source === 'tournee_live') &&
          (c.date || '').slice(0, 10) === today
        );
      }
      // Garder la cotation uniquement si elle contient au moins un acte technique (pas juste une majoration)
      const _CODES_MAJ = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
      const _hasActeTech = actes.some(a => !_CODES_MAJ.has((a.code||'').toUpperCase()));
      if (!_hasActeTech) {
        console.warn('[AMI] Cotation ignorée (majoration seule sans acte technique):', actes.map(a=>a.code));
        return;
      }
      const cotEntry = {
        date:           existingIdx >= 0 ? p.cotations[existingIdx].date : new Date().toISOString(),
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
            const sbRes = await apiCall('/webhook/ami-save-cotation', {
              cotations: [{
                actes,
                total,
                date_soin:      today,
                heure_soin:     patient.heure_soin || patient.heure_preferee || null,
                soin:           soinLabel,
                source:         'tournee',
                invoice_number: cotEntry.invoice_number || null,
                patient_id:     pid,
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
    // Conserve toujours la date/heure du patient, jamais l'heure courante.
    // _userEdited = true bloque l'écrasement par extras.js / cotation.js.
    const fDs = document.getElementById('f-ds');
    const fHs = document.getElementById('f-hs');
    if (fDs) {
      // Priorité : date de la cotation existante > date du patient > aujourd'hui
      const dateSoin = (patient._cotation?.date || patient.date || patient.date_soin || '').slice(0, 10);
      fDs.value = dateSoin || new Date().toISOString().slice(0, 10);
    }
    if (fHs) {
      // Priorité : heure de la cotation existante > heure_soin du patient > vide
      fHs.value = (patient._cotation?.heure || patient.heure_soin || patient.heure_preferee || patient.heure || '').trim().slice(0, 5);
      fHs._userEdited = true; // bloque tout écrasement ultérieur
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
    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap',
      texte: texteForCot,
      infirmiere: ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
      adeli: u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      date_soin: new Date().toISOString().split('T')[0],
      heure_soin: patient.heure_soin || patient.heure_preferee || '',
      _live_auto: true,
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

  // Source patients : _planningData (enrichi IDB) > importedData > uberPatients
  const rawPatientsSrc = (
    window.APP._planningData?.patients ||
    APP.importedData?.patients ||
    APP.importedData?.entries ||
    APP.get('uberPatients') ||
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
    result.innerHTML = '<div class="ai wa">Aucun patient disponible. Ajoutez des patients via le Carnet patients.</div>';
    return;
  }

  result.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto 8px"></div><p style="font-size:12px;color:var(--m)">Calcul de la répartition…</p></div>';

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

    // Calcul du score
    const scoreData = typeof cabinetScoreDistribution === 'function'
      ? cabinetScoreDistribution(assignments)
      : null;

    result.innerHTML = _renderTourneeCabinetHTML(assignments, scoreData);

    if (typeof showToast === 'function') showToast('✅ Répartition calculée !', 'ok');

  } catch(e) {
    result.innerHTML = `<div class="ai er">Erreur : ${e.message}</div>`;
  }
}

/**
 * optimiserTourneeCabinetCA — optimise la répartition pour maximiser les revenus
 */
async function optimiserTourneeCabinetCA() {
  const result = document.getElementById('tur-cabinet-result');
  if (!result) return;

  const cab = APP.get ? APP.get('cabinet') : null;
  if (!cab?.id) return;

  // Accepter même 1 seul membre (admin solo en test)
  const members = cab.members?.length ? cab.members : [{ id: APP.user?.id || 'ide_0', nom: APP.user?.nom || '', prenom: APP.user?.prenom || 'Moi' }];

  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  if (!patients.length) {
    result.innerHTML = '<div class="ai wa">Importez d\'abord vos patients.</div>';
    return;
  }

  result.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto 8px"></div><p style="font-size:12px;color:var(--m)">Optimisation des revenus…</p></div>';

  try {
    // Calcul initial avec members corrigé
    let assignments = typeof cabinetPlanDay === 'function'
      ? cabinetPlanDay(patients, members)
      : null;

    if (!assignments?.length) {
      result.innerHTML = '<div class="ai er">Impossible de calculer.</div>';
      return;
    }

    const before = typeof cabinetScoreDistribution === 'function'
      ? cabinetScoreDistribution(assignments)
      : null;

    // Optimisation itérative avec members corrigé
    if (typeof cabinetOptimizeRevenue === 'function') {
      assignments = cabinetOptimizeRevenue(assignments, members);
    }

    const after = typeof cabinetScoreDistribution === 'function'
      ? cabinetScoreDistribution(assignments)
      : null;

    const gain = after && before
      ? (after.total_revenue - before.total_revenue).toFixed(2)
      : '?';

    result.innerHTML = `
      ${gain > 0 ? `<div class="ai su" style="margin-bottom:10px;font-size:13px">⚡ Optimisation : <strong>+${gain} €</strong> par rapport à la répartition initiale</div>` : ''}
      ${_renderTourneeCabinetHTML(assignments, after)}`;

    if (typeof showToast === 'function') showToast(`⚡ Revenus optimisés +${gain} €`, 'ok');

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
