/* ════════════════════════════════════════════════
   ai-assistant.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   Assistant vocal IA complet :
   ── NLP AVANCÉ ────────────────────────────────
   1. normalize() / detectIntent() — scoring multi-kw
   2. extractEntities() — soins, zones, patients
   3. processNLP() — pipeline complet
   4. nlpContext — mémoire conversationnelle
   ── IA PRÉDICTIVE (ML-free) ───────────────────
   5. ML.stats — durées, trajets, retards par zone/heure
   6. predictDuration() — durée soin personnalisée
   7. predictTravel() — trajet ajusté au conducteur
   8. predictDelayRisk() — probabilité retard
   9. smartScore() — score global IA
  10. learnFromVisit() — apprentissage continu
  11. getZone() — clustering géographique
   ── LLM OFFLINE (WebLLM optionnel) ────────────
  12. initLLM() — chargement modèle (lazy)
  13. askLLM() / cachedLLM() — inférence + cache
  14. buildLLMContext() — contexte patient injecté
   ── SYNTHÈSE VOCALE ───────────────────────────
  15. speak() / safeSpeak() — TTS fr-FR + anti-spam
  16. muteVoice() / unmuteVoice()
   ── ASSISTANT MAINS LIBRES ────────────────────
  17. handleAICommand() — dispatch intent → action
  18. generateVocalResponse() — réponse naturelle
  19. startHandsFree() / stopHandsFree()
   ── NAVIGATION VOCALE ─────────────────────────
  20. startVoiceNavigation() — guidage GPS vocal
  21. checkVoiceInstruction() — déclenchement
  22. checkDeviation() — recalcul si déviation
════════════════════════════════════════════════ */

/* ── Guards ──────────────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined', 'ai-assistant.js : utils.js non chargé.');
})();

/* ════════════════════════════════════════════════
   1. NLP AVANCÉ — Détection d'intention par score
════════════════════════════════════════════════ */

/* Intentions avec mots-clés + poids */
const NLP_INTENTS = {
  ADD_CARE:      { kw: ['ajoute','faire','réalise','note acte','code','acte','soin'],   w: 1 },
  ADD_NOTE:      { kw: ['note','écris','remarque','commente','signale'],                 w: 1 },
  NAVIGATE:      { kw: ['vas','aller','naviguer','suivant','prochain','route'],           w: 2 },
  PATIENT_DONE:  { kw: ['terminé','fini','vu','suivant','patient ok','passé'],            w: 2 },
  PATIENT_ABSENT:{ kw: ['absent','personne','porte','manque','pas là'],                  w: 2 },
  URGENT:        { kw: ['urgent','urgence','prioritaire','appel','vite'],                 w: 3 },
  COTATION:      { kw: ['facture','coter','cotation','facturer','calculer','tarif'],      w: 2 },
  VERIFY:        { kw: ['vérifier','corriger','vérif','checker'],                        w: 2 },
  STATUS:        { kw: ['status','état','combien','restant','aujourd\'hui'],             w: 1 },
  CLEAR:         { kw: ['effacer','nouveau patient','réinitialiser','vider','reset'],    w: 2 },
  STOP:          { kw: ['stop','arrêter','couper','silence','tais-toi'],                 w: 3 },
};

/* Synonymes médicaux pour meilleures correspondances */
const SYNONYMS = {
  pansement:  ['bandage','compresse','plaie'],
  injection:  ['piqûre','seringue','piquer'],
  toilette:   ['bain','hygiène','nursing'],
  insuline:   ['diabète','glycémie'],
  perfusion:  ['perf','transfusion'],
  prélèvement:['prise de sang','bilan','analyse'],
};

function normalize(text) {
  let t = text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
  /* Expansion synonymes */
  Object.entries(SYNONYMS).forEach(([canonical, syns]) => {
    syns.forEach(s => { t = t.replace(new RegExp(s, 'g'), canonical); });
  });
  return t;
}

function detectIntent(text) {
  const scores = {};
  Object.entries(NLP_INTENTS).forEach(([intent, { kw, w }]) => {
    scores[intent] = kw.reduce((acc, k) => acc + (text.includes(k) ? w : 0), 0);
  });
  const best = Object.entries(scores).sort((a,b) => b[1]-a[1])[0];
  return best[1] > 0 ? best[0] : 'UNKNOWN';
}

function extractEntities(text) {
  const acts = [];
  if (/injection|insuline/.test(text))    acts.push('AMI1');
  if (/pansement/.test(text))             acts.push('AMI2');
  if (/prélèvement/.test(text))           acts.push('AMI3');
  if (/perfusion/.test(text))             acts.push('AMI4');
  if (/toilette/.test(text))              acts.push('AIS3');

  const heureM  = text.match(/(\d{1,2})h(?:(\d{2}))?/);
  const kmM     = text.match(/(\d+)\s*km/);
  const nomM    = text.match(/(?:patient|monsieur|madame)\s+([a-zéèêëàâîïùûç\-]+)/i);

  return {
    acts,
    heure:   heureM  ? `${heureM[1].padStart(2,'0')}:${(heureM[2]||'00')}` : null,
    km:      kmM     ? parseInt(kmM[1]) : null,
    patient: nomM    ? nomM[1] : null,
    urgent:  /urgent|urgence|prioritaire/.test(text),
  };
}

/* Contexte conversationnel (mémoire courte) */
const nlpContext = {
  lastIntent:   null,
  lastEntities: {},
  currentPatient: null,
  pendingConfirm: null,
};

function processNLP(rawText) {
  const text = normalize(rawText);
  const intent   = detectIntent(text);
  const entities = extractEntities(text);
  nlpContext.lastIntent   = intent;
  nlpContext.lastEntities = entities;
  log('NLP →', intent, entities);
  return { intent, entities };
}

/* ════════════════════════════════════════════════
   2. IA PRÉDICTIVE ML-FREE
   Apprentissage local par zone / heure / type soin
════════════════════════════════════════════════ */

const ML = (() => {
  try {
    const saved = localStorage.getItem('ami_ml_stats');
    return saved ? JSON.parse(saved) : { duration: {}, travel: {}, delays: {}, visits: 0 };
  } catch { return { duration: {}, travel: {}, delays: {}, visits: 0 }; }
})();

function _saveML() {
  try { localStorage.setItem('ami_ml_stats', JSON.stringify(ML)); } catch {}
}

/* Zone géographique (clustering 0.02° ≈ 2km) */
function getZone(lat, lng) {
  return `${(lat/0.02|0)*0.02}_${(lng/0.02|0)*0.02}`;
}

/* Durée prédite selon type de soin + contexte */
function predictDuration(patient, context = {}) {
  const type = _detectSoinType(patient);
  const stat = ML.duration[type];
  let base   = stat ? stat.avg : (patient.duration || 20);

  if (context.hour > 18) base *= 1.1;      /* fin de journée = plus lent */
  if (context.rain)      base *= 1.15;
  if (patient.complexity === 'high') base += 10;

  return Math.round(base);
}

/* Trajet prédit selon zone (style conducteur appris) */
function predictTravel(baseTimeMin, lat, lng) {
  const zone = getZone(lat, lng);
  const stat = ML.travel[zone];
  if (!stat || stat.count < 3) return baseTimeMin; /* pas assez de données */
  return Math.round(baseTimeMin * stat.ratio);
}

/* Risque de retard selon heure */
function predictDelayRisk(hour) {
  const stat = ML.delays[hour];
  return stat ? stat.rate : 0.1;
}

/* Score global IA (remplace dynamicScore d'ai-tournee.js pour le mode live) */
function smartScore({ patient, travelTime, context = {} }) {
  const duration   = predictDuration(patient, context);
  const delayRisk  = predictDelayRisk(context.hour || new Date().getHours());
  const profitRate = patient.amount ? patient.amount / duration : 0;

  let score = 0;
  score += travelTime * 2;
  score += duration   * 1.5;
  score += delayRisk  * 300;
  score -= profitRate * 50;   /* favorise les soins rentables */
  if (patient.urgent) score -= 300;
  return score;
}

/* Apprentissage après chaque visite */
function learnFromVisit({ type, actualDuration, zone, realTravel, estimatedTravel, hour, delay }) {
  /* Durée */
  const prev = ML.duration[type] || { avg: actualDuration, count: 0 };
  ML.duration[type] = {
    avg:   (prev.avg * prev.count + actualDuration) / (prev.count + 1),
    count: prev.count + 1,
  };

  /* Trajet */
  if (zone && realTravel && estimatedTravel) {
    const ratio  = realTravel / Math.max(estimatedTravel, 1);
    const prevT  = ML.travel[zone] || { ratio: 1, count: 0 };
    ML.travel[zone] = {
      ratio: (prevT.ratio * prevT.count + ratio) / (prevT.count + 1),
      count: prevT.count + 1,
    };
  }

  /* Retard */
  if (hour != null) {
    const isLate  = (delay || 0) > 5 ? 1 : 0;
    const prevD   = ML.delays[hour] || { rate: 0, count: 0 };
    ML.delays[hour] = {
      rate:  (prevD.rate * prevD.count + isLate) / (prevD.count + 1),
      count: prevD.count + 1,
    };
  }

  ML.visits++;
  _saveML();
  log('ML mis à jour, total visites:', ML.visits);
}

function _detectSoinType(p) {
  const d = (p.description || p.label || '').toLowerCase();
  if (/injection|insuline/.test(d)) return 'injection';
  if (/pansement/.test(d))          return 'pansement';
  if (/toilette/.test(d))           return 'toilette';
  if (/perfusion/.test(d))          return 'perfusion';
  if (/prélèvement/.test(d))        return 'prelevement';
  return 'defaut';
}

/* ════════════════════════════════════════════════
   3. LLM OFFLINE (WebLLM — lazy + cache réponses)
   Chargé uniquement si le navigateur supporte WebGPU.
   Utilisation : cas complexes non couverts par NLP.
════════════════════════════════════════════════ */

let _llmEngine     = null;
let _llmLoading    = false;
const _llmCache    = new Map();

const LLM_SYSTEM_PROMPT = `
Tu es AMI, un assistant vocal médical pour infirmier libéral français.
Tu dois :
- comprendre les soins (NGAP : AMI1, AMI2, AMI4, AIS3…)
- proposer des cotations courtes
- optimiser la tournée
- répondre en moins de 20 mots, en français, de façon directe
Tu ne dois JAMAIS inventer de données patient.
`.trim();

/* Modèles WebLLM disponibles — par ordre de préférence (léger → lourd) */
const LLM_MODELS = [
  'Llama-3.2-1B-Instruct-q4f32_1-MLC',   /* ~800 MB — le plus léger */
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',   /* ~2 GB  — meilleure qualité */
  'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',/* ~600 MB — fallback compact */
];

async function initLLM() {
  if (_llmEngine) {
    const el = document.getElementById('llm-progress');
    if (el) { el.textContent = '🤖 IA locale déjà prête ✅'; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 3000); }
    return;
  }
  if (_llmLoading) {
    const el = document.getElementById('llm-progress');
    if (el) { el.textContent = '⏳ Chargement IA déjà en cours…'; el.style.display = 'block'; }
    return;
  }

  /* Vérifier WebGPU — afficher un message clair si non supporté */
  if (!navigator.gpu) {
    const el = document.getElementById('llm-progress');
    if (el) {
      el.textContent = '⚠️ IA locale non disponible — WebGPU requis (Chrome 113+ avec GPU)';
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 5000);
    }
    if (typeof showToast === 'function') showToast('⚠️ IA locale indisponible : WebGPU non supporté par ce navigateur.');
    log('WebGPU non supporté — LLM désactivé');
    return;
  }

  _llmLoading = true;
  const el = document.getElementById('llm-progress');
  if (el) { el.textContent = '⏳ Chargement IA locale… (peut prendre 1-2 min)'; el.style.display = 'block'; }

  let lastError = null;
  for (const modelId of LLM_MODELS) {
    try {
      if (el) el.textContent = `⏳ Chargement ${modelId.split('-').slice(0,2).join(' ')}…`;
      const { CreateMLCEngine } = await import('https://esm.run/@mlc-ai/web-llm');
      _llmEngine = await CreateMLCEngine(modelId, {
        initProgressCallback: p => {
          const pct = Math.round((p.progress || 0) * 100);
          if (el) el.textContent = `🤖 Chargement IA locale : ${pct}%`;
        }
      });
      log(`LLM offline prêt ✅ (${modelId})`);
      if (el) { el.textContent = '🤖 IA locale prête ✅'; setTimeout(() => el.style.display = 'none', 4000); }
      if (typeof showToast === 'function') showToast('🤖 IA locale chargée et prête.');
      _llmLoading = false;
      return; /* succès — on sort */
    } catch (e) {
      lastError = e;
      logWarn(`Modèle ${modelId} indisponible:`, e.message);
      _llmEngine = null; /* réinitialiser pour tenter le suivant */
    }
  }

  /* Tous les modèles ont échoué */
  logWarn('Aucun modèle LLM disponible:', lastError?.message);
  if (el) { el.textContent = `❌ IA locale indisponible — ${lastError?.message?.slice(0, 60) || 'modèle non trouvé'}`; setTimeout(() => el.style.display = 'none', 6000); }
  if (typeof showToast === 'function') showToast('❌ IA locale indisponible sur ce navigateur. Le Copilote cloud reste actif.');
  _llmLoading = false;
}

function buildLLMContext() {
  const p = nlpContext.currentPatient || APP.get('nextPatient');
  const pts = (APP.get('uberPatients') || []).filter(x => !x.done).length;
  return `Patient actuel: ${p?.label || p?.description || 'aucun'}. Patients restants: ${pts}. Heure: ${new Date().getHours()}h.`;
}

async function cachedLLM(input) {
  const key = input.slice(0, 80);
  if (_llmCache.has(key)) return _llmCache.get(key);
  if (!_llmEngine) return null;
  try {
    const reply = await _llmEngine.chat.completions.create({
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'system', content: buildLLMContext() },
        { role: 'user',   content: input }
      ],
      max_tokens: 60,
    });
    const text = reply.choices[0].message.content;
    _llmCache.set(key, text);
    if (_llmCache.size > 50) _llmCache.delete(_llmCache.keys().next().value); /* LRU */
    return text;
  } catch (e) { logWarn('LLM error:', e.message); return null; }
}

/* ════════════════════════════════════════════════
   4. SYNTHÈSE VOCALE TTS — anti-spam + mute
════════════════════════════════════════════════ */

let _voiceMuted = false;
let _lastSpeak  = 0;
let _ttsActive  = false; /* true pendant que le TTS parle — évite l'auto-captation micro */

function speak(text, force = false) {
  if (_voiceMuted && !force) return;
  if (!text || !('speechSynthesis' in window)) return;
  const MIN_GAP = 2000;
  const now = Date.now();
  if (!force && now - _lastSpeak < MIN_GAP) return;
  _lastSpeak = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = 'fr-FR';
  u.rate  = 1.05;
  u.pitch = 1;
  const voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('fr'));
  if (voices.length) u.voice = voices[0];
  /* Bloquer le micro pendant la synthèse pour éviter l'auto-captation */
  _ttsActive = true;
  u.onend = u.onerror = () => {
    setTimeout(() => { _ttsActive = false; }, 600); /* 600ms de délai après la fin */
  };
  speechSynthesis.speak(u);
}

function safeSpeak(text) { speak(text); }
function muteVoice()   { _voiceMuted = true;  log('Vocal coupé'); }
function unmuteVoice() { _voiceMuted = false; log('Vocal actif'); }

/* ════════════════════════════════════════════════
   5. ASSISTANT MAINS LIBRES — dispatch intent
════════════════════════════════════════════════ */

async function handleAICommand(rawText, confidence = 1) {
  if (confidence < 0.5) return;
  /* Ignorer si le TTS est en train de parler — évite l'auto-captation */
  if (_ttsActive) return;

  const { intent, entities } = processNLP(rawText);

  /* 1. Tenter NLP local d'abord */
  const handled = _dispatchIntent(intent, entities, rawText);

  /* 2. Fallback LLM si commande inconnue ou ambiguë */
  if (!handled && _llmEngine) {
    const llmResponse = await cachedLLM(rawText);
    if (llmResponse) {
      speak(llmResponse);
      /* Parser la réponse LLM pour extraire des actions */
      _parseLLMActions(llmResponse);
    }
  }

  /* 3. Afficher dans le toast vocal */
  const interim = document.getElementById('voice-interim');
  if (interim) interim.textContent = rawText;
}

function _dispatchIntent(intent, entities, raw) {
  switch (intent) {

    case 'ADD_CARE':
      if (entities.acts.length) {
        entities.acts.forEach(code => {
          const el = document.getElementById('f-txt');
          if (el) el.value = (el.value ? el.value + ', ' : '') + code;
        });
        speak(generateVocalResponse(intent, entities));
        return true;
      }
      /* Fallback texte brut vers cotation */
      const el = document.getElementById('f-txt');
      if (el && raw) { el.value = (el.value ? el.value + ', ' : '') + raw; speak('Soin noté.'); return true; }
      return false;

    case 'ADD_NOTE':
      speak('Note enregistrée.'); return true;

    case 'NAVIGATE':
      if (typeof goToNextPatient === 'function') goToNextPatient();
      else speak('Navigation non disponible.');
      return true;

    case 'PATIENT_DONE':
      if (typeof liveAction === 'function') liveAction('patient_done');
      speak('Patient marqué terminé.'); return true;

    case 'PATIENT_ABSENT':
      if (typeof liveAction === 'function') liveAction('patient_absent');
      speak('Patient marqué absent.'); return true;

    case 'URGENT':
      if (entities.patient && typeof addUrgentPatient === 'function') {
        addUrgentPatient({ description: raw, label: entities.patient });
      }
      speak('Patient urgent ajouté en priorité.'); return true;

    case 'COTATION':
      document.querySelector('[data-v=cot]')?.click();
      setTimeout(() => { if (typeof cotation === 'function') cotation(); }, 400);
      speak('Cotation en cours.'); return true;

    case 'VERIFY':
      if (typeof openVerify === 'function') openVerify();
      speak('Vérification lancée.'); return true;

    case 'STATUS': {
      const remaining = (APP.get('uberPatients') || []).filter(p => !p.done && !p.absent).length;
      speak(`${remaining} patient${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}.`);
      return true;
    }

    case 'CLEAR':
      if (typeof clrCot === 'function') clrCot();
      speak('Formulaire réinitialisé.'); return true;

    case 'STOP':
      if (typeof stopVoice === 'function') stopVoice();
      return true;

    default: return false;
  }
}

function _parseLLMActions(text) {
  if (/AMI\s*1/i.test(text)) { const e=document.getElementById('f-txt'); if(e) e.value=(e.value?e.value+', ':'')+' AMI1'; }
  if (/AMI\s*4/i.test(text)) { const e=document.getElementById('f-txt'); if(e) e.value=(e.value?e.value+', ':'')+' AMI4'; }
}

function generateVocalResponse(intent, entities) {
  if (intent === 'ADD_CARE' && entities.acts.length)
    return `${entities.acts.join(' et ')} ajouté${entities.acts.length > 1 ? 's' : ''}.`;
  if (intent === 'NAVIGATE') return 'Navigation lancée.';
  if (intent === 'PATIENT_DONE') return 'Patient suivant.';
  return 'Fait.';
}

/* ── Wake word "assistant" ────────────────────── */
function checkWakeWord(text) {
  if (/\bassistant\b|\bami\b/.test(text.toLowerCase())) {
    speak('Oui ?', true);
    return true;
  }
  return false;
}

/* Mode mains libres : connecte à voice.js */
function startHandsFree() {
  /* Patch handleVoice pour passer par le pipeline IA */
  window._origHandleVoice = window.handleVoice;
  window.handleVoice = (transcript, confidence) => {
    if (checkWakeWord(transcript)) return;
    handleAICommand(transcript, confidence);
  };
  /* ⚠️ Pas de speak() ici — évite que "Mode mains libres activé"
     soit capté par le micro et réinjecté dans le champ transcript */
  log('Mains libres actif');
}

function stopHandsFree() {
  if (window._origHandleVoice) window.handleVoice = window._origHandleVoice;
  /* Pas de speak() ici non plus — évite le feedback TTS indésirable */
  log('Mains libres arrêté');
}

function goToNextPatient() {
  const next = APP.get('nextPatient');
  if (!next) { speak('Aucun patient suivant.'); return; }
  nlpContext.currentPatient = next;
  if (typeof startVoiceNavigation === 'function') startVoiceNavigation(next);
  speak(`Navigation vers ${next.label || next.description || 'patient suivant'}.`);
}

/* ════════════════════════════════════════════════
   6. NAVIGATION GPS VOCALE
   Guidage vocal étape par étape depuis OSRM
════════════════════════════════════════════════ */

let _navSteps        = [];
let _navWatchId      = null;
let _navTargetPatient= null;

async function startVoiceNavigation(patient) {
  if (!patient?.lat || !patient?.lng) { speak('Coordonnées GPS manquantes.'); return; }
  _navTargetPatient = patient;
  _navSteps = [];

  /* Récupérer les étapes OSRM */
  const pos = APP.get('userPos') || APP.get('startPoint');
  if (!pos) { speak('Position GPS non disponible.'); return; }

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pos.lng},${pos.lat};${patient.lng},${patient.lat}?steps=true&overview=simplified&language=fr`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code === 'Ok') {
      _navSteps = _parseOSRMSteps(d.routes[0].legs[0].steps);
      speak(`Navigation démarrée. ${_navSteps.length} étapes. ${Math.round(d.routes[0].duration/60)} minutes.`);
    }
  } catch {
    /* Fallback offline */
    speak('Navigation directe activée.');
  }

  /* Démarrer le suivi GPS pour guidage */
  if (_navWatchId) navigator.geolocation.clearWatch(_navWatchId);
  _navWatchId = navigator.geolocation.watchPosition(
    pos => _onNavGPS(pos.coords),
    err => logWarn('Nav GPS:', err.message),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 }
  );
}

function _parseOSRMSteps(steps) {
  return steps.map(s => ({
    text:   _osrmManeuverToFR(s.maneuver?.type, s.maneuver?.modifier, s.name),
    coords: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] },
    distM:  s.distance,
    done:   false,
  }));
}

function _osrmManeuverToFR(type, modifier, name) {
  const road = name ? ` sur ${name}` : '';
  if (type === 'turn' && modifier === 'right') return `Tournez à droite${road}`;
  if (type === 'turn' && modifier === 'left')  return `Tournez à gauche${road}`;
  if (type === 'arrive')                       return 'Vous êtes arrivé';
  if (type === 'depart')                       return `Démarrez${road}`;
  return `Continuez${road}`;
}

function _dist2D(a, b) {
  const dx = (a.lat - b.lat) * 111000;
  const dy = (a.lng - b.lng) * 111000 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dx*dx + dy*dy);
}

const _onNavGPS = throttle((coords) => {
  const pos = { lat: coords.latitude, lng: coords.longitude };

  /* Vérifier chaque étape non faite */
  for (const step of _navSteps) {
    if (step.done) continue;
    const dist = _dist2D(pos, step.coords);
    if (dist < 80 && !step.done) {     /* < 80m → annoncer */
      step.done = true;
      safeSpeak(step.text);
    } else if (dist < 200 && !step._announced) {
      step._announced = true;
      safeSpeak(`Dans ${Math.round(dist)} mètres, ${step.text.toLowerCase()}`);
    }
  }

  /* Détecter déviation > 100m depuis la route */
  checkDeviation(pos);
}, 2000);

let _lastDeviationCheck = 0;
async function checkDeviation(pos) {
  if (!_navTargetPatient) return;
  if (Date.now() - _lastDeviationCheck < 15000) return; /* max 1x/15s */
  _lastDeviationCheck = Date.now();

  /* Distance à la destination */
  const distToDest = _dist2D(pos, _navTargetPatient);

  /* Si toutes les étapes sont passées mais pas encore arrivé → OK */
  const remaining = _navSteps.filter(s => !s.done);
  if (!remaining.length) {
    if (distToDest < 50) {
      safeSpeak('Vous êtes arrivé.');
      stopVoiceNavigation();
    }
    return;
  }

  /* Vérifier si trop loin du prochain point */
  const nextStep = remaining[0];
  const distToNext = _dist2D(pos, nextStep.coords);
  if (distToNext > 300 && _navSteps.filter(s=>s.done).length > 0) {
    safeSpeak('Recalcul de l\'itinéraire.');
    await startVoiceNavigation(_navTargetPatient);
  }
}

function stopVoiceNavigation() {
  if (_navWatchId) { navigator.geolocation.clearWatch(_navWatchId); _navWatchId = null; }
  _navSteps = []; _navTargetPatient = null;
  log('Navigation vocale arrêtée');
}
