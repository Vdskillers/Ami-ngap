/* ════════════════════════════════════════════════
   voice.js — AMI NGAP
   ────────────────────────────────────────────────
   Assistant vocal & dictée médicale
   - toggleVoice() / startVoice() / stopVoice()
   - normalizeMedical() — normalisation terminologie
   - handleVoice() — interprétation commandes vocales
   Compatibilité : Chrome / Edge uniquement
   (webkitSpeechRecognition / SpeechRecognition)
════════════════════════════════════════════════ */
/* ASSISTANT VOCAL */
let recognition=null,voiceActive=false;
const VOICE_CONFIDENCE=0.55;
function normalizeMedical(txt){
  let t=txt.toLowerCase();
  const nums={zéro:0,un:1,une:1,deux:2,trois:3,quatre:4,cinq:5,six:6,sept:7,huit:8,neuf:9,dix:10,onze:11,douze:12,treize:13,quatorze:14,quinze:15,seize:16,vingt:20,'vingt-deux':22,'vingt-trois':23,trente:30,quarante:40,cinquante:50,soixante:60,'soixante-dix':70,'quatre-vingt':80,'quatre-vingt-dix':90};
  Object.entries(nums).sort((a,b)=>b[0].length-a[0].length).forEach(([w,n])=>{t=t.replace(new RegExp(w,'g'),n);});
  t=t.replace(/(\d+)\s*heures?/g,'$1h').replace(/\bmidi\b/g,'12h').replace(/\bminuit\b/g,'0h');
  t=t.replace(/(\d+)\s*kilomètres?/g,'$1 km');
  const med=[[/\b(piquer|piqûre|injecter)\b/g,'injection SC'],[/\bprise de sang\b/g,'prélèvement sanguin'],[/\b(toilette totale|bain complet)\b/g,'toilette complète'],[/\b(grabataire|alité|immobilisé)\b/g,'patient grabataire'],[/\b(chez le patient|au domicile|à domicile)\b/g,'domicile']];
  med.forEach(([rx,rep])=>{t=t.replace(rx,rep);});
  return t.trim();
}
const NGAP_KEYWORDS=['injection','pansement','prélèvement','perfusion','toilette','domicile','grabataire','soin','km','nuit','dimanche'];
function handleVoice(transcript,confidence){
  if(confidence<VOICE_CONFIDENCE)return;
  const t=transcript.toLowerCase().trim();
  /* Ne pas afficher ni traiter si le TTS est en cours (évite l'auto-captation) */
  if(typeof _ttsActive!=='undefined'&&_ttsActive)return;
  $('voice-interim').textContent=t;

  /* ── Pipeline IA avancé (ai-assistant.js) ──────
     Si disponible, délègue au moteur NLP + ML.
     Sinon, fallback règles NGAP natives.
  ─────────────────────────────────────────────── */
  if(typeof handleAICommand==='function'){
    handleAICommand(transcript,confidence);
    return;
  }

  /* ── Fallback règles NGAP natives ─────────────── */
  if(/nouveau patient|réinitialiser/.test(t)){clrCot();return;}
  if(/générer la facture|calculer|facturer|valider/.test(t)){document.querySelector('[data-v=cot]')?.click();setTimeout(cotation,300);return;}
  if(/vérifier|corriger/.test(t)){document.querySelector('[data-v=cot]')?.click();setTimeout(openVerify,300);return;}
  if(/patient terminé/.test(t)){liveAction('patient_done');return;}
  if(/patient absent/.test(t)){liveAction('patient_absent');return;}
  if(/stop assistant|arrêter|couper/.test(t)){stopVoice();return;}
  const nomM=t.match(/nom du patient\s+(.+)/);if(nomM){const e=$('f-pt');if(e)e.value=nomM[1];return;}
  if(/date du soin|aujourd'hui/.test(t)){const e=$('f-ds');if(e)e.value=new Date().toISOString().split('T')[0];return;}
  const hM=t.match(/heure du soin\s+(?:à\s+)?(\d{1,2})/);if(hM){const e=$('f-hs');if(e)e.value=hM[1].padStart(2,'0')+':00';return;}
  if(/tiers payant complet/.test(t)){const e=$('f-regl');if(e)e.value='tiers_amc';return;}
  if(/tiers payant/.test(t)){const e=$('f-regl');if(e)e.value='tiers';return;}
  if(/\bald\b|exonéré|cent pour cent/.test(t)){const e=$('f-exo');if(e)e.value='ALD';return;}
  if(NGAP_KEYWORDS.some(kw=>t.includes(kw))){const el=$('f-txt');if(el)el.value=(el.value?el.value+', ':'')+normalizeMedical(transcript);}
}
function toggleVoice(){if(voiceActive)stopVoice();else startVoice();}
function startVoice(){
  if(!('webkitSpeechRecognition' in window)&&!('SpeechRecognition' in window)){alert('Reconnaissance vocale non supportée. Utilisez Chrome.');return;}
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  recognition=new SR();recognition.lang='fr-FR';recognition.continuous=true;recognition.interimResults=true;recognition.maxAlternatives=1;
  recognition.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++){const res=e.results[i];if(res.isFinal)handleVoice(res[0].transcript,res[0].confidence);else{/* Ne pas afficher les résultats intermédiaires pendant le TTS */if(typeof _ttsActive==='undefined'||!_ttsActive)$('voice-interim').textContent=res[0].transcript;}}};
  recognition.onerror=e=>{if(e.error!=='no-speech')stopVoice();};
  recognition.onend=()=>{if(voiceActive)recognition.start();};
  recognition.start();voiceActive=true;
  /* ── Activer mains libres si IA disponible ── */
  if(typeof startHandsFree==='function') startHandsFree();
  $('voicebtn').classList.add('listening');$('voice-topbtn').classList.add('active');$('voice-topbtn').textContent='🔴 Stop';
  $('voice-toast').classList.add('show');$('voice-interim').textContent='En écoute...';
}
function stopVoice(){
  voiceActive=false;if(recognition){try{recognition.stop();}catch{}recognition=null;}
  if(typeof stopHandsFree==='function') stopHandsFree();
  if(typeof stopVoiceNavigation==='function') stopVoiceNavigation();
  $('voicebtn').classList.remove('listening');$('voice-topbtn').classList.remove('active');$('voice-topbtn').textContent='🎤 Vocal';
  $('voice-toast').classList.remove('show');
}

/* ============================================================
   DASHBOARD — CACHE
   fetchAPI est défini dans utils.js (source unique de vérité)
   ============================================================ */

/* Cache local 5 minutes — DASH_CACHE_KEY défini ici (une seule fois) */
const DASH_CACHE_KEY = 'ami_dash_cache';

function saveDashCache(data) {
  try { localStorage.setItem(DASH_CACHE_KEY, JSON.stringify({t:Date.now(),data})); } catch{}
}
