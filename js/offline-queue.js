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
      await apiCall('/webhook/ami-calcul', payload);
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
  // Afficher le bandeau
  const banner = document.getElementById('offline-banner');
  if (banner) {
    if (!navigator.onLine) {
      banner.style.display = 'flex';
      banner.innerHTML = `<span>📡 Mode hors-ligne</span>${q.length > 0 ? `<span style="font-family:var(--fm);font-size:11px">${q.length} cotation(s) en attente de sync</span>` : ''}`;
    } else {
      banner.style.display = 'none';
    }
  }
}

/* Écouter la reconnexion */
window.addEventListener('online',  () => { _updateQueueBadge(); syncOfflineQueue(); showToast('🌐 Connexion rétablie — synchronisation en cours…', 'ok'); });
window.addEventListener('offline', () => { _updateQueueBadge(); showToast('📡 Hors-ligne — les cotations seront mises en file', 'warn'); });

/* ═══════════════════════════════════════════════
   STATISTIQUES AVANCÉES
   ═══════════════════════════════════════════════ */

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
    const arr1 = Array.isArray(m1?.data) ? m1.data : [];

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
  const evoColor = evo >= 0 ? 'var(--a)' : 'var(--d)';
  const evoArrow = evo >= 0 ? '↑' : '↓';

  // ── Km du mois depuis le journal local ───────────────────────────────────
  let kmMois = 0, kmDeduction = 0;
  try {
    const kmEntries = JSON.parse(localStorage.getItem('ami_km_journal') || '[]');
    const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const filtered = kmEntries.filter(e => new Date(e.date) >= since);
    kmMois = Math.round(filtered.reduce((s, e) => s + parseFloat(e.km||0), 0) * 10) / 10;
    const kmAnnuel = kmEntries.filter(e => new Date(e.date).getFullYear() === new Date().getFullYear())
      .reduce((s, e) => s + parseFloat(e.km||0), 0);
    const taux = kmAnnuel <= 5000 ? 0.636 : kmAnnuel <= 20000 ? (0.319 + 1587/kmAnnuel) : 0.370;
    kmDeduction = Math.round(kmMois * taux * 100) / 100;
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

  el.innerHTML = `
    <!-- Comparatif mois/mois -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">📊 Comparatif mensuel</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px">
        <div class="sc g"><div class="si">📅</div><div class="sv">${ca1.toFixed(0)}€</div><div class="sn">Mois actuel</div></div>
        <div class="sc b"><div class="si">🗓️</div><div class="sv">${ca2.toFixed(0)}€</div><div class="sn">Mois précédent</div></div>
        <div class="sc ${evo>=0?'g':'r'}"><div class="si">${evoArrow}</div><div class="sv" style="color:${evoColor}">${evo>=0?'+':''}${evo.toFixed(1)}%</div><div class="sn">Évolution</div></div>
        <div class="sc o"><div class="si">📆</div><div class="sv">${joursTravailles}j</div><div class="sn">Jours travaillés</div></div>
        <div class="sc b"><div class="si">💹</div><div class="sv">${caParJour.toFixed(0)}€</div><div class="sn">CA/jour moyen</div></div>
        <div class="sc g"><div class="si">📈</div><div class="sv">${ca3.toFixed(0)}€</div><div class="sn">3 mois cumulés</div></div>
        ${kmMois > 0 ? `<div class="sc b"><div class="si">🚗</div><div class="sv">${kmMois} km</div><div class="sn">Km ce mois</div></div>` : ''}
        ${kmDeduction > 0 ? `<div class="sc g"><div class="si">💸</div><div class="sv">${kmDeduction} €</div><div class="sn">Déd. fiscale km</div></div>` : ''}
      </div>
      ${evo < -10 ? `<div class="ai wa">📉 Baisse de CA de ${Math.abs(evo).toFixed(0)}% vs mois précédent — vérifiez vos cotations manquées</div>` : ''}
      ${evo > 15 ? `<div class="ai su">🚀 Excellente progression +${evo.toFixed(0)}% ce mois !</div>` : ''}
    </div>

    <!-- Évolution des actes -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">🩺 Évolution des actes (M vs M-1)</div>
      ${allCodes.length ? `<div class="al">
        ${allCodes.map(code => {
          const n1 = freq1[code]||0, n2 = freq2[code]||0;
          const diff = n1 - n2;
          const pct  = n2 > 0 ? Math.round((n1-n2)/n2*100) : (n1>0?100:0);
          const color= diff > 0 ? 'var(--a)' : diff < 0 ? 'var(--d)' : 'var(--m)';
          const icon = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
          return `<div class="ar">
            <div class="ac">${code}</div>
            <div class="an"><div style="height:5px;background:var(--b);border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.min(n1/Math.max(...Object.values(freq1),1)*100,100)}%;background:var(--a);transition:width .4s"></div></div></div>
            <div class="ao">${n1}× ce mois</div>
            <div style="font-family:var(--fm);font-size:11px;color:${color};min-width:44px;text-align:right">${icon} ${n2}×</div>
          </div>`;
        }).join('')}
      </div>` : '<div class="ai in">Pas encore assez de données pour comparer.</div>'}
    </div>

    <!-- Meilleure heure de travail -->
    <div class="card">
      <div class="ct">⏰ Analyse horaire</div>
      ${_renderHeureStats(moisActuel)}
    </div>`;
}

function _renderHeureStats(arr) {
  const byHour = {};
  arr.forEach(r => {
    let h = '';

    // Priorité 1 : heure_soin ("HH:MM" ou "HH:MM:SS")
    const hSoin = (r.heure_soin || '').trim().slice(0, 2);
    if (hSoin && !isNaN(parseInt(hSoin))) h = hSoin;

    // Priorité 2 : extraire l'heure depuis date_soin si c'est un timestamp ISO
    // ex : "2024-01-15T14:30:00" ou "2024-01-15T14:30:00.000Z"
    if (!h && r.date_soin && r.date_soin.includes('T')) {
      const timePart = r.date_soin.split('T')[1] || '';
      const hIso = timePart.slice(0, 2);
      if (hIso && !isNaN(parseInt(hIso))) h = hIso;
    }

    // Priorité 3 : extraire l'heure depuis notes/description
    // ex : "14h30", "14:30", "14H", "à 9h", "09h00", "matin" → 9, "après-midi" → 14, "soir" → 19
    if (!h) {
      const txt = (r.notes || r.description || r.texte || '').toLowerCase();
      const matchH = txt.match(/\b(\d{1,2})[h:]\d{0,2}\b/);
      if (matchH) {
        h = String(parseInt(matchH[1])).padStart(2, '0');
      } else if (/matin\b|morning/.test(txt)) {
        h = '09';
      } else if (/apr[eè]s.?midi\b|afternoon/.test(txt)) {
        h = '14';
      } else if (/\bsoir\b|evening/.test(txt)) {
        h = '19';
      }
    }

    if (h && !isNaN(parseInt(h))) {
      const k = parseInt(h);
      if (k >= 0 && k <= 23) byHour[k] = (byHour[k] || 0) + 1;
    }
  });
  if (!Object.keys(byHour).length) return '<div class="ai in">Renseignez l\'heure des soins pour voir l\'analyse horaire.</div>';

  const max = Math.max(...Object.values(byHour), 1);
  const hours = Array.from({length:24},(_,i)=>i);
  return `<div style="display:flex;align-items:flex-end;gap:2px;height:80px;margin-top:12px">
    ${hours.map(h => {
      const count = byHour[h]||0;
      const height = count > 0 ? Math.max(8, Math.round(count/max*70)) : 3;
      const color  = h < 8 ? 'rgba(255,95,109,.6)' : h < 12 ? 'var(--a)' : h < 18 ? 'var(--a2)' : 'rgba(255,181,71,.7)';
      return `<div title="${h}h : ${count} soin(s)" style="flex:1;height:${height}px;background:${count>0?color:'var(--b)'};border-radius:2px 2px 0 0;opacity:${count>0?1:0.3}"></div>`;
    }).join('')}
  </div>
  <div style="display:flex;gap:0;margin-top:4px;font-family:var(--fm);font-size:8px;color:var(--m)">
    ${hours.map(h => `<div style="flex:1;text-align:center">${h%6===0?h+'h':''}</div>`).join('')}
  </div>`;
}

/* ═══════════════════════════════════════════════
   TOAST SYSTÈME GLOBAL
   ═══════════════════════════════════════════════ */

let _toastTimer = null;

function showToast(msg, type='ok') {
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
  toast.textContent = msg;
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
window.loadTresorerie         = window.loadTresorerie || function(){};
window.checklistCPAM          = window.checklistCPAM  || function(){};
window.exportComptable        = window.exportComptable || function(){};
