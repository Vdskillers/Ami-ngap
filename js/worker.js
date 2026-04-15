// ═══════════════════════════════════════════════════════════════════════
//  AMI — Cloudflare Worker v6.2  (PRODUCTION READY)
//
//  ✅ NOUVEAUTÉS v6.2 vs v6.1 :
//     - planning-push / planning-pull : sync Planning hebdomadaire PC ↔ mobile
//       Données chiffrées côté client (AES-256), serveur = coffre opaque
//       Table weekly_planning : infirmiere_id + encrypted_data + updated_at
//     - km-push / km-pull : sync Journal kilométrique PC ↔ mobile
//       Même principe que planning — table km_journal
//     - Journal km : clé localStorage isolée par userId (ami_km_journal_<uid>)
//     - Import calendrier : patients auto-ajoutés au Carnet si absents
//
//  ⚠️  NOUVELLES ACTIONS REQUISES AVANT DE DÉPLOYER (Supabase SQL Editor) :
//
//       -- Sync Planning hebdomadaire
//       CREATE TABLE IF NOT EXISTS weekly_planning (
//         id            BIGSERIAL PRIMARY KEY,
//         infirmiere_id UUID NOT NULL UNIQUE,
//         encrypted_data TEXT NOT NULL,
//         updated_at    TIMESTAMPTZ DEFAULT NOW()
//       );
//       ALTER TABLE weekly_planning DISABLE ROW LEVEL SECURITY;
//       CREATE INDEX IF NOT EXISTS idx_weekly_planning_inf ON weekly_planning(infirmiere_id);
//
//       -- Sync Journal kilométrique
//       CREATE TABLE IF NOT EXISTS km_journal (
//         id            BIGSERIAL PRIMARY KEY,
//         infirmiere_id UUID NOT NULL UNIQUE,
//         encrypted_data TEXT NOT NULL,
//         updated_at    TIMESTAMPTZ DEFAULT NOW()
//       );
//       ALTER TABLE km_journal DISABLE ROW LEVEL SECURITY;
//       CREATE INDEX IF NOT EXISTS idx_km_journal_inf ON km_journal(infirmiere_id);
//
//  ✅ NOUVEAUTÉS v6.1 vs v6.0 :
//     - planning_patients : colonnes lat/lng ajoutées (pilotage tournée GPS)
//     - import-calendar : préserve lat/lng si présents dans les données
//     - ami-tournee-ia : retourne adresse dans la réponse route (pilotage)
//     - Isolation admin renforcée : sanitizeForAdmin() couvre tous les champs
//     - toAdminView() : commentaire audit explicite
//     - SQL migration lat/lng documentée dans le header
//
//  ✅ NOUVEAUTÉS v6.0 vs v5.0 :
//     - safeNum() appliqué partout (plus jamais de NaN)
//     - Fallback NGAP enrichi : IK, majorations nuit/dimanche auto
//     - ami-historique KO → renvoie { ok:true, data:[] } jamais d'erreur
//     - ami-calcul : valide réponse n8n → fallback si total=0+actes vides
//     - Route POST /webhook/log → insère dans system_logs (monitoring front)
//     - admin-logs enrichi : audit_logs + system_logs + stats globales
//     - writeSystemLog() : logs auto N8N_FAILURE, IA_FALLBACK, FRAUD_ALERT
//     - Erreur interne → loguée dans system_logs
//
//  ⚠️  ACTIONS REQUISES AVANT DE DÉPLOYER :
//     Supabase SQL Editor (exécuter dans l'ordre) :
//       ALTER TABLE infirmieres DISABLE ROW LEVEL SECURITY;
//       ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
//       ALTER TABLE planning_patients DISABLE ROW LEVEL SECURITY;
//
//       -- ✅ TABLE SYNC CARNET PATIENTS (OBLIGATOIRE pour sync PC ↔ mobile)
//       CREATE TABLE IF NOT EXISTS carnet_patients (
//         id            BIGSERIAL PRIMARY KEY,
//         infirmiere_id UUID NOT NULL,
//         patient_id    TEXT NOT NULL,
//         encrypted_data TEXT NOT NULL,
//         nom_enc       TEXT DEFAULT '',
//         updated_at    TIMESTAMPTZ DEFAULT NOW(),
//         UNIQUE(infirmiere_id, patient_id)
//       );
//       ALTER TABLE carnet_patients DISABLE ROW LEVEL SECURITY;
//       CREATE INDEX IF NOT EXISTS idx_carnet_patients_infirmiere ON carnet_patients(infirmiere_id);
//
//       -- v6.1 : colonnes GPS pour le pilotage de tournée
//       ALTER TABLE planning_patients
//         ADD COLUMN IF NOT EXISTS lat  DOUBLE PRECISION,
//         ADD COLUMN IF NOT EXISTS lng  DOUBLE PRECISION,
//         ADD COLUMN IF NOT EXISTS adresse TEXT;
//
//       CREATE TABLE IF NOT EXISTS system_logs (
//         id SERIAL PRIMARY KEY, level TEXT DEFAULT 'info',
//         source TEXT, event TEXT, message TEXT, meta TEXT,
//         created_at TIMESTAMPTZ DEFAULT NOW()
//       );
//       ALTER TABLE system_logs DISABLE ROW LEVEL SECURITY;
//
//     Cloudflare Workers → Settings → Variables :
//       SUPABASE_SERVICE_KEY = [votre service_role key Supabase]
//
//  🔥 FIX N8N OBLIGATOIRE (cause du message "IA indisponible") :
//     Nœud "AI Agent" → champ Text → ligne 1 :
//     REMPLACER  ==={{ (() => {
//     PAR         ={{ (() => {
//     (supprimer les deux == — sinon n8n n'évalue pas l'expression JS)
// ═══════════════════════════════════════════════════════════════════════

const SALT                 = 'inf2026salt';
const PATIENT_SALT         = 'patient_anon_salt_2026';
const SUPA_URL             = 'https://ycsprblaruusaegohcid.supabase.co/rest/v1';
const N8N_URL              = 'https://n8n-6fyl.onrender.com';
const ADMIN_EMAILS         = ['vdskillers@hotmail.com', 'julien.bonomelli@gmail.com'];
const NGAP_VERSION_CURRENT = '2026.1';
const N8N_TIMEOUT_MS       = 30000;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ami-debug',
};

// ── AMI_SYSTEM GUARD — compteurs enrichis pour monitoring admin ────────
// Enrichit writeSystemLog() avec compteurs en mémoire + détail par type d'erreur N8N
// Compatible avec l'existant — ne remplace rien, s'ajoute par-dessus
const AMI_SYSTEM = {
  counters: { n8n_errors: 0, ia_fallbacks: 0, fraud_alerts: 0, front_errors: 0 },
  n8n_diag: { timeout: 0, parse_fail: 0, empty: 0, http_error: 0, html: 0, other: 0 },

  recordN8NError(type = 'other') {
    this.counters.n8n_errors++;
    if (this.n8n_diag[type] !== undefined) this.n8n_diag[type]++;
    else this.n8n_diag.other++;
  },

  recordFallback() { this.counters.ia_fallbacks++; },
  recordFraud()    { this.counters.fraud_alerts++; },
  recordFrontErr() { this.counters.front_errors++; },

  getStats() {
    return {
      n8n_failures:    this.counters.n8n_errors,
      ia_fallbacks:    this.counters.ia_fallbacks,
      fraud_alerts:    this.counters.fraud_alerts,
      frontend_errors: this.counters.front_errors,
      n8n_diag_detail: this.n8n_diag,
    };
  },
};

// ── UTILITAIRES ────────────────────────────────────────────────────────

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── AES-256-GCM — chiffrement côté backend (RGPD/HDS) ─────────────────
// Dérive une clé AES-256-GCM depuis le SALT via PBKDF2 (100k itérations)
// Usage : encryptField(valeur) → { data, iv }  /  decryptField({ data, iv }) → valeur
const _AES_KEY_CACHE = {};
async function _getAESKey(purpose = 'default') {
  if (_AES_KEY_CACHE[purpose]) return _AES_KEY_CACHE[purpose];
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SALT + '_' + purpose),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('ami_backend_salt_2026'), iterations: 100000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  _AES_KEY_CACHE[purpose] = key;
  return key;
}
async function encryptField(value, purpose = 'default') {
  try {
    const key = await _getAESKey(purpose);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
    );
    return {
      data: btoa(String.fromCharCode(...new Uint8Array(enc))),
      iv:   btoa(String.fromCharCode(...iv)),
    };
  } catch { return null; }
}
async function decryptField(payload, purpose = 'default') {
  try {
    const key  = await _getAESKey(purpose);
    const data = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
    const iv   = Uint8Array.from(atob(payload.iv),   c => c.charCodeAt(0));
    const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(msg, status = 400) { return json({ ok: false, error: msg }, status); }

function dbg(debug, label, data) {
  if (!debug) return;
  console.log(`[AMI-DBG] ${label}`, typeof data === 'object' ? JSON.stringify(data) : data);
}

// ✅ safeNum — jamais NaN ni undefined dans les montants
function safeNum(v, fallback = 0) {
  const n = parseFloat(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

// ── PARSER UNIVERSEL IA (GPT / Grok / Claude) ──────────────────────────
// Extrait le JSON depuis n'importe quel format de réponse IA
function parseAIResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Nettoyer markdown, espaces
  let cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
  // Extraire le bloc JSON le plus externe
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  let jsonStr = cleaned.substring(start, end + 1);
  // Tentative parse directe
  try { return JSON.parse(jsonStr); } catch {}
  // Auto-repair : trailing commas, clés sans guillemets, quotes simples
  try {
    const repaired = jsonStr
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/([{,]\s*)([a-zA-Z0-9_éèàùç]+)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ':"$1"');
    return JSON.parse(repaired);
  } catch { return null; }
}

// ── NORMALISATION RÉPONSE IA ────────────────────────────────────────────
// Garantit une structure stable quelle que soit la source IA
const safeArray = (v) => Array.isArray(v) ? v : [];

function normalizeAI(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    ok:            true,
    actes:         safeArray(data.actes),
    total:         safeNum(data.total),
    part_amo:      safeNum(data.part_amo),
    part_amc:      safeNum(data.part_amc),
    part_patient:  safeNum(data.part_patient),
    amo_amount:    safeNum(data.amo_amount || data.part_amo),
    amc_amount:    safeNum(data.amc_amount || data.part_amc),
    taux_amo:      safeNum(data.taux_amo) || 0.6,
    dre_requise:   !!data.dre_requise,
    alerts:        safeArray(data.alerts),
    optimisations: safeArray(data.optimisations),
    ngap_version:  data.ngap_version || NGAP_VERSION_CURRENT,
    invoice_number:data.invoice_number || null,
    texte_corrige: data.texte_corrige || null,
    corrections:   safeArray(data.corrections),
    prescripteur:  data.prescripteur || null,
    fallback:      !!data.fallback,
  };
}

// ── DÉTECTION HALLUCINATION IA ──────────────────────────────────────────
function isHallucination(data) {
  if (!data || !safeArray(data.actes).length) return true;
  if (safeNum(data.total) > 200 && safeArray(data.actes).length === 1) return true;
  if (safeArray(data.actes).some(a => !a.code)) return true;
  if (/approx|maybe|unknown|undefined/i.test(JSON.stringify(data))) return true;
  return false;
}

async function safeFetchN8N(url, options = {}, debug = false) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);
  let res, upText;
  try {
    res    = await fetch(url, { ...options, signal: controller.signal });
    upText = await res.text();
  } catch (e) {
    clearTimeout(tid);
    if (e.name === 'AbortError') {
      AMI_SYSTEM.recordN8NError('timeout');
      return { ok: false, error: 'timeout_n8n', message: 'N8N timeout (>30s)' };
    }
    AMI_SYSTEM.recordN8NError('other');
    return { ok: false, error: 'fetch_error', message: e.message };
  }
  clearTimeout(tid);
  dbg(debug, 'N8N RAW', { status: res.status, preview: upText?.slice(0, 200) });
  if (!res.ok) { AMI_SYSTEM.recordN8NError('http_error'); }
  if (!upText || upText.trim() === '') {
    console.error('[AMI] N8N réponse vide');
    AMI_SYSTEM.recordN8NError('empty');
    return { ok: false, error: 'empty_response', message: 'Réponse vide de n8n' };
  }
  if (upText.trim().startsWith('<')) {
    console.error('[AMI] N8N HTML:', upText.slice(0, 150));
    AMI_SYSTEM.recordN8NError('html');
    return { ok: false, error: 'html_response', message: 'N8N a retourné du HTML (workflow cassé)' };
  }
  try {
    const parsed = JSON.parse(upText);
    // normalizeAI appliqué pour garantir une structure stable (évite actes:null, total:undefined)
    return { ok: true, status: res.status, data: normalizeAI(parsed) || parsed };
  } catch {
    // Tenter le parser universel IA (cas Grok/Claude qui envoient du texte + JSON)
    const recovered = parseAIResponse(upText);
    if (recovered) {
      dbg(debug, 'N8N PARSER UNIVERSEL', 'JSON récupéré via parseAIResponse');
      return { ok: true, status: res.status, data: normalizeAI(recovered) || recovered };
    }
    console.error('[AMI] JSON invalide:', upText.slice(0, 150));
    AMI_SYSTEM.recordN8NError('parse_fail');
    return { ok: false, error: 'invalid_json', message: 'JSON invalide reçu de n8n' };
  }
}

// ── FALLBACK IA NGAP enrichi v2 ────────────────────────────────────────
function fallbackCotation(body) {
  const texte = (body.texte || '').toLowerCase();
  const heure = String(body.heure_soin || '');
  const actes = [];
  let total   = 0;

  if (texte.includes('injection') || texte.includes('insuline') || texte.includes('piquer')) {
    actes.push({ code: 'AMI1', nom: 'Injection SC/IM', coefficient: 1, total: 3.15 }); total += 3.15;
  }
  if (texte.includes('perfusion')) {
    actes.push({ code: 'AMI4', nom: 'Perfusion domicile', coefficient: 4, total: 12.60 }); total += 12.60;
  }
  if (texte.includes('pansement complexe') || texte.includes('escarre') || texte.includes('plaie')) {
    actes.push({ code: 'AMI4', nom: 'Pansement complexe', coefficient: 4, total: 12.60 }); total += 12.60;
  } else if (texte.includes('pansement')) {
    actes.push({ code: 'AMI1', nom: 'Pansement simple', coefficient: 1, total: 3.15 }); total += 3.15;
  }
  if (texte.includes('prélèvement') || texte.includes('prise de sang')) {
    actes.push({ code: 'AMI1', nom: 'Prélèvement sanguin', coefficient: 1, total: 3.15 }); total += 3.15;
  }
  if (texte.includes('toilette')) {
    actes.push({ code: 'BSC', nom: 'Bilan soins infirmiers C', coefficient: 1, total: 28.00 }); total += 28.00;
  }
  if (texte.includes('domicile') || texte.includes('chez')) {
    actes.push({ code: 'IFD', nom: 'Indemnité déplacement', coefficient: 1, total: 2.75 }); total += 2.75;
  }
  const kmM = texte.match(/(\d+)\s*km/);
  if (kmM) {
    const ik = safeNum(parseInt(kmM[1]) * 0.35);
    actes.push({ code: 'IK', nom: `${kmM[1]} km`, coefficient: 1, total: ik }); total += ik;
  }
  if (heure) {
    const h = heure.slice(0, 5);
    if (h >= '23:00' || h < '05:00') {
      actes.push({ code: 'MN2', nom: 'Majoration nuit profonde', coefficient: 1, total: 18.30 }); total += 18.30;
    } else if (h >= '20:00' || h < '08:00') {
      actes.push({ code: 'MN', nom: 'Majoration nuit', coefficient: 1, total: 9.15 }); total += 9.15;
    }
  }
  if (texte.includes('dimanche') || texte.includes('férié')) {
    actes.push({ code: 'MD', nom: 'Majoration dimanche/férié', coefficient: 1, total: 8.50 }); total += 8.50;
  }
  if (!actes.length) {
    actes.push({ code: 'AMI1', nom: 'Acte infirmier', coefficient: 1, total: 3.15 }); total = 3.15;
  }
  total             = safeNum(total);
  const partAMO     = safeNum(total * 0.6);
  const partPatient = safeNum(total - partAMO);
  const fallbackResult = {
    ok: true, fallback: true, actes, total,
    part_amo: partAMO, part_amc: 0, part_patient: partPatient,
    amo_amount: partAMO, amc_amount: 0, taux_amo: 0.6, dre_requise: false,
    alerts: ['⚠️ Estimation automatique — IA indisponible. Vérifiez cette cotation avant envoi.'],
    optimisations: [], ngap_version: NGAP_VERSION_CURRENT,
  };
  // Enrichir le fallback avec les mêmes optimisations que la vraie réponse
  const ngapOpts = ngapOptimize(body.texte, actes);
  fallbackResult.optimisations = ngapOpts.map(o => o.msg);
  fallbackResult.gain_potentiel = safeNum(ngapOpts.reduce((s,o) => s+(o.gain||0), 0));
  Object.assign(fallbackResult, scoreAIQuality(fallbackResult));
  Object.assign(fallbackResult, patientScore(body.texte, total, body.km));
  return fallbackResult;
}

// ── DB SUPABASE ─────────────────────────────────────────────────────────
async function db(path, opts = {}, supaKey = '') {
  const res  = await fetch(`${SUPA_URL}/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'apikey': supaKey, 'Authorization': `Bearer ${supaKey}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return []; }
}

async function getSession(token, supaKey) {
  if (!token) return null;
  const sessions = await db(`sessions?token=eq.${encodeURIComponent(token)}&select=infirmiere_id`, {}, supaKey);
  if (!Array.isArray(sessions) || !sessions[0]) return null;
  const id    = sessions[0].infirmiere_id;
  const users = await db(`infirmieres?id=eq.${id}&select=id,email,nom,prenom,role,is_blocked,adeli,rpps,structure`, {}, supaKey);
  return (Array.isArray(users) && users[0]) ? users[0] : null;
}

// ⚠️ RGPD/HDS — toAdminView() est la seule transformation autorisée pour les données infirmières côté admin.
// Elle ne retourne JAMAIS : email, mot de passe, adeli, rpps, structure, adresse, tel, ni aucune donnée patient.
// Toute modification de cette fonction doit être soumise à revue de sécurité.
function toAdminView(u) {
  return {
    id:         u.id,
    nom:        u.nom        || '',
    prenom:     u.prenom     || '',
    is_blocked: !!u.is_blocked,
    // ⛔ email, password, adeli, rpps, structure, adresse, tel → jamais exposés
  };
}

async function anonymizePatient(raw) {
  const h = await sha256(raw + PATIENT_SALT); return 'anon_' + h.slice(0, 12);
}

// ⚠️ RGPD/HDS — sanitizeForAdmin() purge TOUS les champs identifiants patient
// avant envoi à N8N en mode admin. Liste exhaustive — à maintenir à jour.
function sanitizeForAdmin(body) {
  const safe = { ...body };
  const SENSITIVE_FIELDS = [
    'nom_patient','prenom_patient','numero_secu','date_naissance',
    'f_pt','f_sec','patient_nom','patient_prenom',
    'nir','ddn','amo','amc','secu',
    'adresse_patient','tel_patient','email_patient',
    'mutuelle','num_adherent','num_contrat',
    'prescripteur_nom','prescripteur_prenom',
  ];
  SENSITIVE_FIELDS.forEach(k => delete safe[k]);
  safe.patient    = 'ANONYMISÉ';
  safe.mode_admin = true;
  safe.exo        = safe.exo  || '0';
  safe.regl       = safe.regl || 'CB';
  return safe;
}

async function generateInvoiceNumber(infirmiereId, D) {
  const year = new Date().getFullYear(), short = infirmiereId.replace(/-/g,'').slice(0,6).toUpperCase();
  let counter = 0;
  try { const rows = await D(`invoice_counters?infirmiere_id=eq.${infirmiereId}&select=last_seq`); if (Array.isArray(rows)&&rows[0]) counter = rows[0].last_seq||0; } catch {}
  const newSeq = counter + 1;
  await D('invoice_counters', { method:'POST', headers:{'Prefer':'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify({ infirmiere_id: infirmiereId, last_seq: newSeq }) });
  return `F${year}-${short}-${String(newSeq).padStart(6,'0')}`;
}

const PERMISSIONS = {
  nurse: ['create_invoice','view_own_data','import_calendar','manage_tournee','change_password','delete_account','manage_prescripteurs'],
  admin: ['block_user','unblock_user','delete_user','view_stats','view_logs','view_users_list'],
};
function hasPermission(role, permission) { return (PERMISSIONS[role]||[]).includes(permission); }

async function writeAuditLog(D, { user_id, event, score=null, ip='', meta={} }) {
  try {
    // ip n'est pas une colonne de audit_logs — on la stocke dans meta
    const metaWithIp = ip ? { ...meta, ip } : meta;
    await D('audit_logs', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_id, event, score, meta: metaWithIp, created_at: new Date().toISOString() })
    });
  } catch (e) { console.warn('audit_logs non disponible:', e.message); }
}

async function writeSystemLog(D, { level='info', source='worker', event='', message='', meta={} }) {
  try { await D('system_logs', { method:'POST', headers:{'Prefer':'return=minimal'}, body: JSON.stringify({ level, source, event, message: String(message).slice(0,500), meta: JSON.stringify(meta), created_at: new Date().toISOString() }) }); } catch (e) { console.warn('[AMI] system_logs non disponible:', e.message); }
}

function computeFraudScore(body) {
  let score = 0;
  const total = safeNum(body.total||body._total), km = safeNum(body.km||body.distance_km);
  const nbPat = isFinite(parseInt(body.nb_patients,10)) ? parseInt(body.nb_patients,10) : 0;
  if (total>100) score+=15; if (total>200) score+=25; if (total>400) score+=20;
  if (body.night_without_hour) score+=30; if (km>100) score+=20; if (km>150) score+=25;
  if (nbPat>20) score+=40; if (km>50&&nbPat>20) score+=40; if (body.duplicate_act) score+=50;
  return Math.min(score, 100);
}

// ── SCORING QUALITÉ IA ──────────────────────────────────────────────────
function scoreAIQuality(data) {
  let score = 100;
  const issues = [];
  if (!data.actes || data.actes.length === 0) { score -= 50; issues.push('Aucun acte détecté'); }
  if (safeNum(data.total) <= 0) { score -= 40; issues.push('Total nul'); }
  const sumActes = (data.actes||[]).reduce((s,a) => s + safeNum(a.total), 0);
  if (Math.abs(sumActes - safeNum(data.total)) > 0.5) { score -= 30; issues.push('Total incohérent avec la somme des actes'); }
  const VALID = ['AMI','AIS','BSA','BSB','BSC','IFD','IK','MN','MN2','MD','MIE','MCI'];
  (data.actes||[]).forEach(a => {
    if (a.code && !VALID.some(v => (a.code||'').includes(v))) { score -= 20; issues.push('Code suspect: ' + a.code); }
  });
  return { ai_score: Math.max(score,0), ai_quality: score>80?'high':score>50?'medium':'low', ai_issues: issues };
}

// ── NGAP OPTIMIZER — suggestions revenu ────────────────────────────────
function ngapOptimize(texte, actes) {
  const t = (texte||'').toLowerCase();
  const codes = (actes||[]).map(a => a.code||'');
  const opts = [];
  if ((t.includes('domicile')||t.includes('chez')) && !codes.includes('IFD'))
    opts.push({ type:'lost_revenue', msg:'IFD oublié — +2,75 € (déplacement domicile)', gain: 2.75 });
  if (/\d+\s*km/.test(t) && !codes.includes('IK'))
    opts.push({ type:'lost_revenue', msg:'IK non coté — vérifier distance × 0,35 €/km', gain: 0 });
  if (t.includes('nuit') && !codes.some(c=>c.includes('MN')))
    opts.push({ type:'lost_revenue', msg:'Majoration nuit détectée mais non cotée — +9,15 € ou +18,30 €', gain: 9.15 });
  if (t.includes('dimanche') && !codes.includes('MD'))
    opts.push({ type:'lost_revenue', msg:'Majoration dimanche/férié oubliée — +8,50 €', gain: 8.50 });
  if ((t.includes('toilette')||t.includes('bain')) && !codes.some(c=>c.startsWith('BS')))
    opts.push({ type:'optimization', msg:'Toilette détectée — vérifier forfait BSA/BSB/BSC (+13 à +28,70 €)', gain: 0 });
  if (t.includes('ald') && actes.length && !t.includes('exo')) {
    opts.push({ type:'optimization', msg:'ALD mentionné — appliquer exonération ticket modérateur', gain: 0 });
  }
  return opts;
}

// ── PATIENT PROFITABILITY SCORE ─────────────────────────────────────────
function patientScore(texte, total, km) {
  const t = (texte||'').toLowerCase();
  let temps = 10;
  if (t.includes('toilette')) temps += 20;
  if (t.includes('pansement')) temps += 15;
  if (t.includes('perfusion')) temps += 30;
  if (t.includes('prélèvement')) temps += 5;
  const distance = safeNum(km) || 2;
  const rentabilite = temps > 0 ? safeNum(total) / temps : 0;
  const score = Math.round(rentabilite * 10 - distance * 0.5);
  return { patient_score: score, rentabilite_minute: rentabilite, temps_estime: temps, distance_estimee: distance };
}

// ── PARSEURS CALENDRIER ─────────────────────────────────────────────────
function parseICS(text){const events=[],blocks=text.split('BEGIN:VEVENT');for(let i=1;i<blocks.length;i++){const b=blocks[i],extract=(key)=>{const m=b.match(new RegExp(key+'[^:]*:([^\r\n]+)'));return m?m[1].trim():'';};const dtstart=extract('DTSTART');let date='',heure='';if(dtstart.length>=8){const y=dtstart.slice(0,4),mo=dtstart.slice(4,6),d=dtstart.slice(6,8);date=`${y}-${mo}-${d}`;if(dtstart.length>=13)heure=`${dtstart.slice(9,11)}:${dtstart.slice(11,13)}`;}events.push({date,heure,description:extract('SUMMARY'),location:extract('LOCATION'),source:'ics'});}return events;}
function parseCSV(text){const lines=text.trim().split('\n'),header=lines[0].toLowerCase().split(/[,;]/);return lines.slice(1).filter(l=>l.trim()).map(line=>{const cols=line.split(/[,;]/),get=(keys)=>{for(const k of keys){const i=header.findIndex(h=>h.includes(k));if(i>=0)return(cols[i]||'').trim().replace(/"/g,'');}return'';};return{date:get(['date','jour']),heure:get(['heure','time','début']),description:get(['soin','description','acte','titre','summary']),patient:get(['patient','nom']),source:'csv'};});}
function parseJSON(text){try{const d=JSON.parse(text),a=Array.isArray(d)?d:[d];return a.map(e=>({date:e.date||'',heure:e.heure||e.time||'',description:e.description||e.soin||e.acte||'',patient:e.patient||'',source:'json'}));}catch{return[];}}
function parseTXT(text){return text.trim().split('\n').filter(l=>l.trim()).map(line=>({description:line.trim(),date:'',heure:'',source:'txt'}));}
function normalizeMedical(desc){if(!desc)return'';let t=desc.toLowerCase();[[/piquer|piqûre|injecter/g,'injection SC'],[/administrer insuline/g,'injection insuline SC'],[/prise de sang|bilan sanguin/g,'prélèvement sanguin'],[/toilette totale|bain complet/g,'toilette complète'],[/grabataire|alité|immobilisé/g,'patient grabataire'],[/chez le patient|au domicile/g,'domicile']].forEach(([rx,rep])=>{t=t.replace(rx,rep);});return t;}

// ── OPTIMISATION TOURNÉE ────────────────────────────────────────────────
function haversine(a,b){const R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLon=(b.lng-a.lng)*Math.PI/180,x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function optimizeTour(patients,startLat=null,startLng=null){if(!patients.length)return[];if(!startLat||!startLng)return[...patients].sort((a,b)=>(a.heure||'').localeCompare(b.heure||''));let remaining=patients.filter(p=>p.lat&&p.lng),fixed=patients.filter(p=>!p.lat||!p.lng),route=[],cur={lat:startLat,lng:startLng};while(remaining.length){let best=null,bestDist=Infinity;for(const p of remaining){const d=haversine(cur,p);if(d<bestDist){bestDist=d;best=p;}}route.push({...best,distance_km:Math.round(bestDist*10)/10});cur=best;remaining=remaining.filter(p=>p!==best);}fixed.sort((a,b)=>(a.heure||'').localeCompare(b.heure||''));return[...route,...fixed];}
function priorityScore(p){let s=0;const d=(p.description||p.actes||'').toLowerCase();if(d.includes('insuline'))s+=40;if(d.includes('urgent'))s+=50;if(p.heure&&p.heure<'09:00')s+=30;return s;}

// ═══════════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url      = new URL(request.url);
    const path     = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
    const debug    = url.searchParams.get('debug') === '1' || request.headers.get('x-ami-debug') === '1';

    const supaKey = env.SUPABASE_SERVICE_KEY;
    if (!supaKey) return err('Configuration manquante : SUPABASE_SERVICE_KEY non définie.', 500);

    let body = {};
    if (request.method === 'POST') {
      try { const raw = await request.text(); if (raw) body = JSON.parse(raw); } catch {}
    }

    const token = (() => { const auth = request.headers.get('Authorization')||''; return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null; })();
    const D = (p, opts={}) => db(p, opts, supaKey);

    try {

      // ════ ROUTES PUBLIQUES ════

      if (path === '/webhook/auth-login') {
        const { email='', password='' } = body;
        if (!email || !password) return err('Email et mot de passe requis.', 400);
        const e = email.toLowerCase().trim();
        const rows = await D(`infirmieres?email=eq.${encodeURIComponent(e)}&select=*`);
        if (!Array.isArray(rows)||!rows[0]) return err('Email ou mot de passe incorrect.', 401);
        const user = rows[0];
        if (user.is_blocked) return err('Compte suspendu. Contactez un administrateur.', 403);
        const hash = await sha256(password + SALT);
        if (user.password_hash !== hash) { await writeAuditLog(D,{user_id:user.id,event:'LOGIN_FAIL',ip:clientIP,meta:{email:e}}); return err('Email ou mot de passe incorrect.', 401); }
        const isAdmin      = ADMIN_EMAILS.includes(e) || (user.role||'').toLowerCase()==='admin';
        const sessionToken = await sha256(user.id + Date.now().toString() + Math.random().toString());
        const sessionInsert = await D('sessions',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify({infirmiere_id:user.id,token:sessionToken})});
        if (!Array.isArray(sessionInsert)||!sessionInsert[0]) return err('Erreur création session — vérifiez la table sessions et que le RLS est désactivé.', 500);
        await writeAuditLog(D,{user_id:user.id,event:'LOGIN_SUCCESS',ip:clientIP,meta:{role:isAdmin?'admin':'nurse'}});
        return json({ ok:true, token:sessionToken, role:isAdmin?'admin':'nurse', user:{ id:user.id, email:user.email, nom:user.nom||'', prenom:user.prenom||'', adeli:user.adeli||'', rpps:user.rpps||'', structure:user.structure||'', role:isAdmin?'admin':'nurse' } });
      }

      if (path === '/webhook/infirmiere-register') {
        const { nom='', prenom='', email='', password='', adeli='', rpps='', structure='' } = body;
        if (!nom||!prenom) return err('Prénom et nom obligatoires.', 400);
        if (!email) return err('Email obligatoire.', 400);
        if (!password||password.length<8) return err('Mot de passe minimum 8 caractères.', 400);
        const e = email.toLowerCase().trim();
        if (ADMIN_EMAILS.includes(e)) return err("Email non autorisé à l'inscription.", 403);
        const exist = await D(`infirmieres?email=eq.${encodeURIComponent(e)}&select=id`);
        if (Array.isArray(exist)&&exist[0]) return err('Cet email est déjà utilisé.', 409);
        const hash = await sha256(password + SALT);
        const rows = await D('infirmieres',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify({nom,prenom,email:e,password_hash:hash,adeli,rpps,structure,role:'nurse',is_blocked:false})});
        const profil = Array.isArray(rows)?rows[0]:rows;
        if (!profil?.id) return err('Création du compte échouée.', 500);
        await writeAuditLog(D,{user_id:profil.id,event:'REGISTER',ip:clientIP,meta:{email:e}});
        return json({ ok:true, profil:{ id:profil.id, nom, prenom } });
      }

      // ✅ v6.0 — Route log frontend (sans auth requise)
      if (path === '/webhook/log') {
        const logType = String(body.type || body.event || 'FRONTEND_ERROR');
        if (logType === 'FRONT_ERROR' || logType === 'PROMISE_ERROR' || logType === 'FRONTEND_ERROR') {
          AMI_SYSTEM.recordFrontErr();
        }
        await writeSystemLog(D, {
          level:   String(body.level   || 'error').slice(0, 20),
          source:  String(body.source  || 'frontend').slice(0, 50),
          event:   String(body.event   || logType).slice(0, 100),
          message: String(body.message || '').slice(0, 500),
          meta:    { stack: String(body.stack||'').slice(0,500), ua: String(body.userAgent||'').slice(0,200) },
        });
        return json({ ok: true });
      }

      // ════ VÉRIFICATION SESSION ════

      const user = await getSession(token, supaKey);
      if (!user)           return err('Session invalide — reconnectez-vous.', 401);
      if (user.is_blocked) return err('Compte suspendu.', 403);
      const isAdmin  = !!(ADMIN_EMAILS.includes(user.email) || (user.role||'').toLowerCase()==='admin');
      const userRole = isAdmin ? 'admin' : 'nurse';
      dbg(debug, 'SESSION', { user_id:user.id, role:userRole, path });

      // ════ PROFIL ════

      if (path==='/webhook/profil-get') {
        const rows=await D(`infirmieres?id=eq.${user.id}&select=id,email,nom,prenom,adeli,rpps,structure,adresse,tel`);
        if(!Array.isArray(rows)||!rows[0]) return err('Profil non trouvé.',404);
        return json({ok:true,profil:rows[0]});
      }
      if (path==='/webhook/profil-save') {
        const {nom='',prenom='',adeli='',rpps='',structure='',adresse='',tel=''}=body;
        const rows=await D(`infirmieres?id=eq.${user.id}`,{method:'PATCH',headers:{'Prefer':'return=representation'},body:JSON.stringify({nom,prenom,adeli,rpps,structure,adresse,tel})});
        const profil=Array.isArray(rows)?rows[0]:rows; if(!profil?.id) return err('Mise à jour échouée.',500);
        await writeAuditLog(D,{user_id:user.id,event:'PROFIL_UPDATE',ip:clientIP,meta:{}}); return json({ok:true,profil});
      }
      if (path==='/webhook/change-password') {
        if(!hasPermission(userRole,'change_password')) return err('Accès non autorisé.',403);
        const {ancien='',nouveau=''}=body; if(!ancien||!nouveau) return err('Champs manquants.',400); if(nouveau.length<8) return err('Minimum 8 caractères.',400);
        const check=await D(`infirmieres?id=eq.${user.id}&select=id,password_hash`); if(!Array.isArray(check)||!check[0]) return err('Compte non trouvé.',404);
        if(check[0].password_hash!==await sha256(ancien+SALT)) return err('Mot de passe actuel incorrect.',401);
        await D(`infirmieres?id=eq.${user.id}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({password_hash:await sha256(nouveau+SALT)})});
        await writeAuditLog(D,{user_id:user.id,event:'PASSWORD_CHANGE',ip:clientIP,meta:{}}); return json({ok:true});
      }
      if (path==='/webhook/delete-account') {
        if(!hasPermission(userRole,'delete_account')) return err('Accès non autorisé.',403);
        const id=user.id;
        await D(`sessions?infirmiere_id=eq.${id}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await D(`planning_patients?infirmiere_id=eq.${id}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await D(`invoice_counters?infirmiere_id=eq.${id}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await D(`infirmieres?id=eq.${id}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await writeAuditLog(D,{user_id:id,event:'ACCOUNT_DELETED_SELF',ip:clientIP,meta:{}}); return json({ok:true});
      }

      // ════ PRESCRIPTEURS ════

      if (path==='/webhook/prescripteur-liste') {
        if(!hasPermission(userRole,'manage_prescripteurs')) return err('Accès réservé aux infirmières.',403);
        const rows=await D('prescripteurs?select=id,nom,rpps,specialite&order=nom.asc'); return json({ok:true,prescripteurs:Array.isArray(rows)?rows:[]});
      }
      if (path==='/webhook/prescripteur-add') {
        if(!hasPermission(userRole,'manage_prescripteurs')) return err('Accès réservé aux infirmières.',403);
        const {nom='',rpps='',specialite='',adresse=''}=body; if(!nom) return err('Nom du médecin obligatoire.',400);
        if(rpps&&rpps.length!==11) return err('Le RPPS doit contenir 11 chiffres.',400);
        if(rpps){const exist=await D(`prescripteurs?rpps=eq.${encodeURIComponent(rpps)}&select=id`);if(Array.isArray(exist)&&exist[0]) return err('Un médecin avec ce RPPS existe déjà.',409);}
        const rows=await D('prescripteurs',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify({nom:nom.trim(),rpps:rpps||null,specialite:specialite||null,adresse:adresse||null})});
        const prescripteur=Array.isArray(rows)?rows[0]:rows; if(!prescripteur?.id) return err('Création échouée.',500);
        await writeAuditLog(D,{user_id:user.id,event:'PRESCRIPTEUR_ADD',ip:clientIP,meta:{prescripteur_id:prescripteur.id,nom}}); return json({ok:true,prescripteur});
      }
      if (path==='/webhook/prescripteur-get') {
        if(!hasPermission(userRole,'manage_prescripteurs')) return err('Accès réservé aux infirmières.',403);
        const {id=''}=body; if(!id) return err('ID prescripteur manquant.',400);
        const rows=await D(`prescripteurs?id=eq.${id}&select=id,nom,rpps,specialite,adresse`); if(!Array.isArray(rows)||!rows[0]) return err('Prescripteur non trouvé.',404);
        return json({ok:true,prescripteur:rows[0]});
      }

      // ════ IMPORT CALENDRIER ════

      if (path==='/webhook/import-calendar') {
        if(!hasPermission(userRole,'import_calendar')) return err('Import non disponible en mode admin.',403);
        const {content='',type='',filename=''}=body; if(!content) return err('Contenu manquant.',400);
        let entries=[]; const t=type.toLowerCase()+filename.toLowerCase();
        if(t.includes('calendar')||t.includes('.ics')||content.includes('BEGIN:VCALENDAR')) entries=parseICS(content);
        else if(t.includes('json')||content.trim().startsWith('[')||content.trim().startsWith('{')) entries=parseJSON(content);
        else if(t.includes('csv')||content.includes(',')||content.includes(';')) entries=parseCSV(content);
        else entries=parseTXT(content);
        if(!entries.length) return err('Aucune entrée détectée.',400);
        const alerts=[], normalized=await Promise.all(entries.map(async(e,i)=>{
          const patientRaw=e.patient||e.description||`patient_${i}`, patient_id=await anonymizePatient(patientRaw+user.id), actes=normalizeMedical(e.description);
          if(!e.heure) alerts.push(`Entrée ${i+1} : heure manquante`); if(!actes) alerts.push(`Entrée ${i+1} : acte non reconnu`);
          // v6.1 : conserver lat/lng/adresse si présents dans les données source (carnet patients)
          const lat  = (e.lat  !== undefined && e.lat  !== null && !isNaN(parseFloat(e.lat)))  ? parseFloat(e.lat)  : null;
          const lng  = (e.lng  !== undefined && e.lng  !== null && !isNaN(parseFloat(e.lng)))  ? parseFloat(e.lng)  : null;
          const adr  = typeof e.adresse === 'string' && e.adresse.trim() ? e.adresse.trim() : null;
          return{infirmiere_id:user.id,date_soin:e.date||null,heure_soin:e.heure||null,actes:JSON.stringify([{code:'IMPORT',nom:actes||e.description}]),patient_id,source:e.source||'import',total:0,part_amo:0,part_amc:0,part_patient:0,dre_requise:false,alerts:JSON.stringify([]),ngap_version:NGAP_VERSION_CURRENT,...(lat!==null&&lng!==null?{lat,lng}:{}),...(adr?{adresse:adr}:{})};
        }));
        const inserted=await D('planning_patients',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify(normalized)});
        await writeAuditLog(D,{user_id:user.id,event:'CALENDAR_IMPORT',ip:clientIP,meta:{count:normalized.length}});
        return json({ok:true,total:normalized.length,stored:Array.isArray(inserted)?inserted.length:0,alerts,message:`${normalized.length} entrée(s) importée(s)`});
      }

      // ════ TOURNÉE + LIVE ════

      if (path==='/webhook/ami-tournee-ia') {
        // Admin et infirmière accèdent à leurs propres données (infirmiere_id=eq.user.id)
        if(!isAdmin && !hasPermission(userRole,'manage_tournee')) return err('Accès non autorisé.',403);
        const rows=await D(`planning_patients?infirmiere_id=eq.${user.id}&select=*&order=date_soin.asc`), patients=Array.isArray(rows)?rows:[];
        if(!patients.length) return json({ok:false,route:[],error:"Aucun patient importé.",message:"Aucun patient importé."});
        const enriched=patients.map((p,i)=>{const notes=p.notes||'';return{index:i,patient_id:p.patient_id,date:p.date_soin,heure:p.date_soin,description:notes,adresse:p.adresse||null,lat:p.lat||null,lng:p.lng||null,priority:priorityScore({heure:p.date_soin,description:actes[0]?.nom||''})};});
        const sorted=[...enriched].sort((a,b)=>b.priority-a.priority), optimized=optimizeTour(sorted,body.start_lat,body.start_lng);
        const tourAlerts=optimized.map((p,i)=>!p.heure?`Patient ${i+1} : heure manquante`:null).filter(Boolean), totalKm=optimized.reduce((s,p)=>s+(p.distance_km||0),0);
        return json({ok:true,route:optimized,total_patients:optimized.length,total_km:Math.round(totalKm*10)/10,alerts:tourAlerts,message:`Tournée : ${optimized.length} patients, ~${Math.round(totalKm)} km`});
      }

      if (path==='/webhook/ami-live') {
        // ── Accès identique admin et infirmière — chacun voit ses propres données (infirmiere_id=eq.user.id) ──
        // L'admin teste avec ses propres patients de test, comme une infirmière avec les siens.
        const {action='',patient_id=''}=body;
        if(action==='patient_done'){await D(`planning_patients?infirmiere_id=eq.${user.id}&patient_id=eq.${patient_id}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({done:true})});return json({ok:true,action:'patient_done'});}
        if(action==='patient_absent'){await D(`planning_patients?infirmiere_id=eq.${user.id}&patient_id=eq.${patient_id}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({done:true,absent:true})});return json({ok:true,action:'patient_absent',suggestion:'Patient retiré de la tournée'});}
        if(action==='get_status'){const remaining=await D(`planning_patients?infirmiere_id=eq.${user.id}&done=is.false&select=patient_id,notes,date_soin&order=date_soin.asc&limit=20`);return json({ok:true,patients_restants:Array.isArray(remaining)?remaining.length:0,prochain:Array.isArray(remaining)?remaining[0]:null});}
        if(action==='recalcul'){const remaining=await D(`planning_patients?infirmiere_id=eq.${user.id}&done=is.false&select=*&order=date_soin.asc`);return json({ok:true,action:'recalcul',patients_restants:Array.isArray(remaining)?remaining.length:0});}
        return json({ok:true,action:'unknown'});
      }

      // ══════════════════════════════════════════════════════════════
      //  PROXY N8N — ami-calcul / ami-historique / ami-supprimer
      //  ✅ v6.0 : réponse 100% sécurisée + fallback + retry + logs
      // ══════════════════════════════════════════════════════════════

      // ════ AMI-HISTORIQUE — lecture directe Supabase (plus de N8N) ════
      // Fix : N8N retournait des réponses vides sur /ami-historique → 90% des erreurs system_logs
      // Solution : lire planning_patients directement, N8N n'est plus dans la boucle pour l'historique
      if (path.startsWith('/webhook/ami-historique')) {
        // Admins : accès view_stats → données agrégées anonymisées (tous utilisateurs, sans données patient)
        // Nurses : accès view_own_data → leurs propres cotations
        const canAdmin = hasPermission(userRole, 'view_stats');
        const canNurse = hasPermission(userRole, 'view_own_data');
        if (!canAdmin && !canNurse) return err('Accès non autorisé.', 403);

        const periodParam = url.searchParams.get('period') || 'month';
        const today = new Date();
        let since = new Date();
        if      (periodParam === 'today')     { since.setHours(0,0,0,0); }
        else if (periodParam === 'week')      { since.setDate(today.getDate() - 7); }
        else if (periodParam === '3month')    { since = new Date(today.getFullYear(), today.getMonth() - 3, 1); }
        else if (periodParam === 'lastmonth') { since = new Date(today.getFullYear(), today.getMonth() - 1, 1); }
        else if (periodParam === 'year')      { since = new Date(today.getFullYear(), 0, 1); }
        else /* month = ce mois */            { since = new Date(today.getFullYear(), today.getMonth(), 1); }
        const sinceStr = since.toISOString().slice(0,10);
        let rows = [];
        try {
          if (canAdmin) {
            // ⚠️ RGPD/HDS — Admin : données financières agrégées UNIQUEMENT
            // Les descriptions d'actes (texte médical) sont retirées — seuls les codes et montants sont conservés.
            // L'admin ne voit jamais le texte libre saisi par les infirmières (noms de patients, pathologies, etc.)
            // Isolation admin/admin : chaque admin ne voit que ses propres données de test (infirmiere_id=eq.${user.id})
            rows = await D(`planning_patients?infirmiere_id=eq.${user.id}&date_soin=gte.${sinceStr}&order=date_soin.desc&select=id,date_soin,total,part_amo,part_amc,part_patient,fraud_score,ai_score,source,ngap_version,dre_requise&limit=1000`);
            // Supprimer toute description textuelle résiduelle — défense en profondeur
            rows = (Array.isArray(rows) ? rows : []).map(r => {
              const { notes, heure_soin, ...safe } = r;
              return safe;
            });
          } else {
            // ✅ Nurse : uniquement SES PROPRES cotations (isolation stricte par infirmiere_id)
            rows = await D(`planning_patients?infirmiere_id=eq.${user.id}&date_soin=gte.${sinceStr}&order=date_soin.desc&select=id,date_soin,heure_soin,notes,total,part_amo,part_amc,part_patient,fraud_score,ai_score,source,ngap_version,dre_requise&limit=500`);
          }
          if (!Array.isArray(rows)) rows = [];
        } catch(e) {
          console.warn('[AMI] ami-historique Supabase KO:', e.message);
          rows = [];
        }
        return json({ ok:true, data:rows, count:rows.length }, 200);
      }

      // ════ AMI-SAVE-COTATION — sauvegarde directe Supabase (cotations locales/live) ════
      // Utilisé pour synchroniser les cotations générées localement (fin de tournée, mode live)
      // qui ne sont pas passées par n8n. Isolation stricte par infirmiere_id.
      if (path.startsWith('/webhook/ami-save-cotation')) {
        if (isAdmin) return err('Sauvegarde désactivée en mode admin.', 403);
        if (!hasPermission(userRole, 'create_invoice')) return err('Accès non autorisé.', 403);

        const cotations = Array.isArray(body.cotations) ? body.cotations : (body.cotation ? [body.cotation] : []);
        if (!cotations.length) return err('Aucune cotation à sauvegarder.', 400);

        let saved = 0, errors = 0;
        for (const cot of cotations) {
          try {
            const actes = Array.isArray(cot.actes) ? cot.actes : [];
            const total  = safeNum(cot.total);
            if (total <= 0 && actes.length === 0) continue; // ignorer les cotations vides

            const row = {
              infirmiere_id: user.id,
              date_soin:     cot.date_soin || new Date().toISOString().slice(0,10),
              heure_soin:    cot.heure_soin || null,
              notes:         String(cot.soin || cot.description || '').slice(0, 200),
              actes:         JSON.stringify(actes),
              total:         total,
              part_amo:      safeNum(cot.part_amo  || total * 0.6),
              part_amc:      safeNum(cot.part_amc  || 0),
              part_patient:  safeNum(cot.part_patient || total * 0.4),
              dre_requise:   !!cot.dre_requise,
              source:        cot.source || 'tournee_local',
              ngap_version:  NGAP_VERSION_CURRENT,
              fraud_score:   0,
              ai_score:      0,
              alerts:        JSON.stringify([]),
            };
            // Générer un numéro de facture
            try {
              const invoiceNumber = await generateInvoiceNumber(user.id, D);
              row.invoice_number = invoiceNumber;
            } catch {}

            await D('planning_patients', {
              method: 'POST',
              headers: { 'Prefer': 'return=minimal' },
              body: JSON.stringify(row),
            });
            saved++;
          } catch (e) {
            console.warn('[AMI] ami-save-cotation KO:', e.message);
            errors++;
          }
        }
        await writeAuditLog(D, { user_id: user.id, event: 'COTATIONS_SYNC', ip: clientIP, meta: { saved, errors, count: cotations.length } });
        return json({ ok: true, saved, errors }, 200);
      }

      // ════ AMI-SUPPRIMER — suppression directe Supabase ════
      if (path.startsWith('/webhook/ami-supprimer')) {
        // ⚠️ RGPD/HDS : l'admin peut supprimer UNIQUEMENT ses propres données de test
        // (infirmiere_id = user.id garantit l'isolation — les données des infirmières sont inaccessibles)
        if (!isAdmin && !hasPermission(userRole, 'view_own_data')) return err('Accès non autorisé.', 403);
        const supId = body.id || '';
        if (!supId) return err('ID manquant.', 400);
        const check = await D(`planning_patients?id=eq.${supId}&infirmiere_id=eq.${user.id}&select=locked`);
        if (!Array.isArray(check) || !check[0]) return err('Cotation introuvable ou accès non autorisé.', 404);
        if (check[0].locked) return err('Facture verrouillée — suppression impossible (conformité CPAM).', 403);
        await D(`planning_patients?id=eq.${supId}&infirmiere_id=eq.${user.id}`, { method:'DELETE', headers:{'Prefer':'return=minimal'} });
        await writeAuditLog(D, { user_id:user.id, event:'COTATION_DELETE', ip:clientIP, meta:{ id:supId } });
        return json({ ok:true, message:'Cotation supprimée.' });
      }

      if (path.startsWith('/webhook/ami-calcul')) {

        // ══════════════════════════════════════════════════════════════
        //  ADMIN — cotation locale directe (sans n8n, sans données patient)
        //  Les admins testent le moteur NGAP, pas des vrais soins.
        //  → on court-circuite n8n et on renvoie le calcul local enrichi.
        // ══════════════════════════════════════════════════════════════
        if (isAdmin && path.startsWith('/webhook/ami-calcul')) {
          const adminTexte = String(body.texte || '').trim();
          if (!adminTexte) return err('Veuillez saisir une description du soin pour tester la cotation.', 400);
          const localResult = fallbackCotation({ texte: adminTexte, heure_soin: body.heure_soin || '' });
          localResult.alerts = localResult.alerts.filter(a => !a.includes('IA indisponible'));
          localResult.alerts.unshift('ℹ️ Mode test administrateur — cotation calculée par le moteur NGAP local (données patient masquées).');
          localResult._admin_test = true;
          const ngapOpts = ngapOptimize(adminTexte, localResult.actes);
          localResult.optimisations = ngapOpts.map(o => o.msg);
          localResult.gain_potentiel = safeNum(ngapOpts.reduce((s,o) => s+(o.gain||0), 0));
          Object.assign(localResult, scoreAIQuality(localResult));
          Object.assign(localResult, patientScore(adminTexte, localResult.total, 0));

          // ── Sauvegarder dans planning_patients (données de test admin isolées) ──
          // L'admin voit ses propres données de test dans Historique/Dashboard.
          // Isolation garantie : infirmiere_id = user.id (admin ne voit pas les infirmières).
          try {
            const invoiceNumber = await generateInvoiceNumber(user.id, D);
            const row = {
              infirmiere_id: user.id,
              date_soin:     body.date_soin || new Date().toISOString().slice(0,10),
              heure_soin:    body.heure_soin || null,
              notes:         adminTexte.slice(0, 200),
              actes:         JSON.stringify(localResult.actes || []),
              total:         safeNum(localResult.total),
              part_amo:      safeNum(localResult.part_amo  || localResult.total * 0.6),
              part_amc:      safeNum(localResult.part_amc  || 0),
              part_patient:  safeNum(localResult.part_patient || localResult.total * 0.4),
              dre_requise:   !!localResult.dre_requise,
              source:        'admin_test',
              ngap_version:  NGAP_VERSION_CURRENT,
              fraud_score:   0,
              ai_score:      safeNum(localResult.ai_score),
              alerts:        JSON.stringify(localResult.alerts || []),
              invoice_number: invoiceNumber,
            };
            await D('planning_patients', { method:'POST', headers:{'Prefer':'return=minimal'}, body: JSON.stringify(row) });
            localResult.invoice_number = invoiceNumber;
          } catch(e) { console.warn('[AMI] Admin cotation save KO:', e.message); }

          return json(localResult, 200);
        }

        const payload = isAdmin ? sanitizeForAdmin(body) : { ...body };

        // Génération N° facture
        if (!isAdmin && path.startsWith('/webhook/ami-calcul') && !payload.invoice_number) {
          try {
            const invoiceNumber = await generateInvoiceNumber(user.id, D);
            payload.invoice_number = invoiceNumber; payload.ngap_version = NGAP_VERSION_CURRENT;
            if (body.patient_id) { try { await D(`planning_patients?infirmiere_id=eq.${user.id}&patient_id=eq.${body.patient_id}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({invoice_number:invoiceNumber,ngap_version:NGAP_VERSION_CURRENT,locked:true})}); } catch {} }
          } catch (invErr) { console.warn('Génération N° facture échouée :', invErr.message); }
        }

        // Hydratation prescripteur
        if (!isAdmin && body.prescripteur_id) {
          try { const pRows=await D(`prescripteurs?id=eq.${body.prescripteur_id}&select=id,nom,rpps,specialite`); if(Array.isArray(pRows)&&pRows[0]) payload.prescripteur=pRows[0]; } catch {}
        }

        // Fraude + audit + system_log
        if (!isAdmin && path.startsWith('/webhook/ami-calcul') && body.mode==='ngap') {
          const fraudScore = computeFraudScore(body);
          payload._fraud_score = fraudScore;
          if (fraudScore >= 70) {
            payload._fraud_alert = true;
            AMI_SYSTEM.recordFraud();
            await writeAuditLog(D,{user_id:user.id,event:'COTATION_FRAUD_ALERT',score:fraudScore,ip:clientIP,meta:{total:body.total,km:body.km,invoice_number:payload.invoice_number}});
            await writeSystemLog(D,{level:'critical',source:'worker',event:'FRAUD_ALERT',message:`Score fraude ${fraudScore}/100`,meta:{user_id:user.id,total:body.total,km:body.km}});
          }
          await writeAuditLog(D,{user_id:user.id,event:'COTATION_NGAP',score:fraudScore,ip:clientIP,meta:{invoice_number:payload.invoice_number,ngap_version:NGAP_VERSION_CURRENT}});
        }

        payload.infirmiere_id = user.id;

        const n8nBase   = N8N_URL.replace(/\/+$/, '');
        const n8nPath   = path.replace(/^\/+/, '/');
        const n8nTarget = n8nBase + n8nPath + (url.search || '');
        const fwdHeaders = { 'Content-Type':'application/json', 'x-proxy-source':'cloudflare-worker-v6' };
        const authHeader = request.headers.get('Authorization');
        if (authHeader) fwdHeaders['Authorization'] = authHeader;

        dbg(debug, 'N8N CALL', { url:n8nTarget, isAdmin, keys:Object.keys(payload) });

        // ✅ Appel n8n sécurisé — retry 1× si fail (sauf timeout)
        let result = await safeFetchN8N(n8nTarget, { method:request.method, headers:fwdHeaders, body:request.method==='GET'?undefined:JSON.stringify(payload) }, debug);

        if (!result.ok && result.error !== 'timeout_n8n') {
          dbg(debug, 'N8N RETRY', result);
          await new Promise(r => setTimeout(r, 800));
          result = await safeFetchN8N(n8nTarget, { method:request.method, headers:fwdHeaders, body:request.method==='GET'?undefined:JSON.stringify(payload) }, debug);
        }

        // ✅ N8N KO après retry → log + fallback
        if (!result.ok) {
          console.error('[AMI] N8N KO après retry :', result.error, result.message);
          await writeSystemLog(D,{level:'error',source:'worker',event:'N8N_FAILURE',message:result.message||result.error,meta:{path,error:result.error}});

          if (path.startsWith('/webhook/ami-calcul')) {
            await writeSystemLog(D,{level:'warn',source:'worker',event:'IA_FALLBACK',message:'N8N KO → fallback local',meta:{path}});
            AMI_SYSTEM.recordFallback();
            const fallback = fallbackCotation(body);
            if (debug) fallback._debug = { n8n_error: result };
            return json(fallback, 200);
          }
          return json({ ok:false, error:result.message||'Service IA temporairement indisponible.', error_type:result.error }, 502);
        }

        const rawData = result.data;

        // ✅ ami-calcul : sécuriser les montants + valider réponse
        if (path.startsWith('/webhook/ami-calcul')) {
          const responseData = {
            ...rawData,
            ok:            rawData.ok !== false,
            total:         safeNum(rawData.total),
            amo_amount:    safeNum(rawData.amo_amount),
            amc_amount:    safeNum(rawData.amc_amount),
            part_amo:      safeNum(rawData.part_amo),
            part_amc:      safeNum(rawData.part_amc),
            part_patient:  safeNum(rawData.part_patient),
            taux_amo:      safeNum(rawData.taux_amo) || 0.6,
            actes:         Array.isArray(rawData.actes) ? rawData.actes : [],
            alerts:        Array.isArray(rawData.alerts) ? rawData.alerts : [],
            optimisations: Array.isArray(rawData.optimisations) ? rawData.optimisations : [],
          };
          // Réponse invalide (total=0 + actes vides, quelle que soit la valeur de ok) → fallback
          // NOTE : n8n peut renvoyer ok:true mais avec un résultat vide si le parser a échoué
          if (responseData.total === 0 && responseData.actes.length === 0) {
            console.warn('[AMI] Réponse n8n invalide (vide) → fallback déclenché');
            await writeSystemLog(D,{level:'warn',source:'worker',event:'IA_FALLBACK',message:'Réponse n8n vide → fallback',meta:{path}});
            AMI_SYSTEM.recordFallback();
            const fallback = fallbackCotation(body);
            if (debug) fallback._debug = { n8n_raw: rawData };
            return json(fallback, 200);
          }
          // Hallucination IA détectée → fallback
          if (isHallucination(responseData)) {
            console.warn('[AMI] Hallucination IA détectée → fallback déclenché');
            await writeSystemLog(D,{level:'warn',source:'worker',event:'IA_HALLUCINATION',message:'Réponse IA incohérente → fallback',meta:{path}});
            const fallback = fallbackCotation(body);
            fallback.alerts.unshift('⚠️ Réponse IA incohérente corrigée automatiquement.');
            if (debug) fallback._debug = { n8n_raw: rawData, hallucination: true };
            return json(fallback, 200);
          }
          if (debug) responseData._debug = { n8n_status:result.status, payload_keys:Object.keys(payload) };
          // Enrichir avec scoring qualité IA + optimisations NGAP + score patient
          const aiQuality = scoreAIQuality(responseData);
          const ngapOpts  = ngapOptimize(body.texte, responseData.actes);
          const pScore    = patientScore(body.texte, responseData.total, body.km||body.distance_km);
          // Fusionner les optimisations (IA + NGAP)
          const allOpts = [
            ...(responseData.optimisations||[]),
            ...ngapOpts.map(o => o.msg),
          ];
          const gainPotentiel = ngapOpts.reduce((s,o) => s + (o.gain||0), 0);
          return json({
            ...responseData,
            ...aiQuality,
            ...pScore,
            optimisations: allOpts,
            gain_potentiel: safeNum(gainPotentiel),
          }, result.status || 200);
        }

        // ami-supprimer et autres → passer tel quel
        if (debug) rawData._debug = { n8n_status:result.status };
        return json(rawData, result.status || 200);
      }

      // ════ MESSAGERIE CONTACT ════

      // Infirmière → envoyer un message aux admins
      if (path === '/webhook/contact-send') {
        if (!hasPermission(userRole, 'create_invoice')) return err('Accès réservé aux infirmières.', 403);
        const sujet    = String(body.sujet    || '').trim().slice(0, 120);
        const message  = String(body.message  || '').trim().slice(0, 2000);
        const categorie= String(body.categorie|| 'autre').trim().slice(0, 30);
        if (!sujet)   return err('Sujet manquant.', 400);
        if (message.length < 10) return err('Message trop court.', 400);
        const validCats = ['bug','amelioration','question','ngap','autre'];
        const cat = validCats.includes(categorie) ? categorie : 'autre';
        const row = {
          infirmiere_id: user.id,
          infirmiere_nom:    user.nom    || '',
          infirmiere_prenom: user.prenom || '',
          categorie: cat,
          sujet,
          message,
          status: 'sent',
          created_at: new Date().toISOString(),
        };
        const inserted = await D('contact_messages', { method:'POST', headers:{'Prefer':'return=representation'}, body: JSON.stringify(row) });
        const newMsg   = Array.isArray(inserted) ? inserted[0] : inserted;
        if (!newMsg?.id) return err('Erreur lors de l\'enregistrement du message.', 500);
        await writeAuditLog(D, { user_id: user.id, event: 'CONTACT_MESSAGE_SENT', ip: clientIP, meta: { message_id: newMsg.id, categorie: cat } });
        return json({ ok: true, message_id: newMsg.id });
      }

      // Infirmière → voir ses propres messages (+ réponses admin)
      if (path === '/webhook/contact-mes-messages') {
        if (!hasPermission(userRole, 'create_invoice')) return err('Accès réservé aux infirmières.', 403);
        const rows = await D(`contact_messages?infirmiere_id=eq.${user.id}&select=id,categorie,sujet,message,status,reply_message,replied_at,created_at&order=created_at.desc&limit=50`);
        return json({ ok: true, messages: Array.isArray(rows) ? rows : [] });
      }

      // Admin → voir tous les messages (avec filtre optionnel)
      if (path === '/webhook/admin-messages') {
        if (!hasPermission(userRole, 'view_users_list')) return err('Accès réservé aux administrateurs.', 403);
        const filter = String(body.filter || 'all').trim();
        let query = 'contact_messages?select=id,infirmiere_id,infirmiere_nom,infirmiere_prenom,categorie,sujet,message,status,reply_message,replied_at,created_at&order=created_at.desc&limit=100';
        if (filter === 'unread')    query += '&status=eq.sent';
        else if (filter !== 'all') query += `&categorie=eq.${encodeURIComponent(filter)}`;
        const rows = await D(query);
        const messages = Array.isArray(rows) ? rows : [];
        // Masquer l'id infirmière pour les admins (RGPD — seuls nom+prénom visibles)
        const safe = messages.map(m => { const { infirmiere_id, ...rest } = m; return rest; });
        return json({ ok: true, messages: safe });
      }

      // Admin → marquer un message comme lu
      if (path === '/webhook/admin-message-read') {
        if (!hasPermission(userRole, 'view_users_list')) return err('Accès réservé aux administrateurs.', 403);
        const id = String(body.id || '').trim();
        if (!id) return err('ID manquant.', 400);
        await D(`contact_messages?id=eq.${id}`, { method:'PATCH', headers:{'Prefer':'return=minimal'}, body: JSON.stringify({ status: 'read' }) });
        await writeAuditLog(D, { user_id: user.id, event: 'CONTACT_MESSAGE_READ', ip: clientIP, meta: { message_id: id } });
        return json({ ok: true });
      }

      // Admin → répondre à un message
      if (path === '/webhook/admin-message-reply') {
        if (!hasPermission(userRole, 'view_users_list')) return err('Accès réservé aux administrateurs.', 403);
        const id    = String(body.id    || '').trim();
        const reply = String(body.reply || '').trim().slice(0, 1000);
        if (!id)    return err('ID manquant.', 400);
        if (reply.length < 5) return err('Réponse trop courte.', 400);
        await D(`contact_messages?id=eq.${id}`, {
          method:'PATCH',
          headers:{'Prefer':'return=minimal'},
          body: JSON.stringify({ status: 'replied', reply_message: reply, replied_at: new Date().toISOString() })
        });
        await writeAuditLog(D, { user_id: user.id, event: 'CONTACT_MESSAGE_REPLIED', ip: clientIP, meta: { message_id: id } });
        return json({ ok: true });
      }

      // ════ COPILOTE IA — xAI (Grok) ════
      if (path === '/webhook/ami-copilot') {
        if (!hasPermission(userRole, 'create_invoice') && !hasPermission(userRole, 'view_stats')) return err('Accès non autorisé.', 403);
        const question = String(body.question || body.texte || '').trim().slice(0, 2000);
        if (!question) return err('Question manquante.', 400);

        // Historique conversationnel transmis par le frontend (max 10 échanges)
        const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
        const messages = [
          ...history
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: String(m.content).slice(0, 500) })),
          { role: 'user', content: question }
        ];

        const xaiKey = env.XAI_API_KEY;

        // ── Appel xAI Grok si clé disponible ─────────────────────────
        if (xaiKey) {
          try {
            const xaiRes = await fetch('https://api.x.ai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${xaiKey}`,
              },
              body: JSON.stringify({
                model: 'grok-3-mini',
                messages: [
                  {
                    role: 'system',
                    content: `Tu es un expert NGAP (Nomenclature Générale des Actes Professionnels) pour infirmiers libéraux en France. Tu réponds en français, de façon claire, précise et concise. Tarifs 2026 : AMI=3,15€/unité (AMI1=3,15€, AMI2=6,30€, AMI3=9,45€, AMI4=12,60€, AMI5=15,75€), AIS=2,65€/unité. Majorations : MN(20h-8h)=9,15€, MN2(23h-5h)=18,30€, MD=8,50€, MIE=2,65€, MCI=5€. Déplacements : IFD=2,75€, IK=0,35€/km. Forfaits BSI : BSA=13€, BSB=18,20€, BSC=28,70€. Tu aides l'infirmière à optimiser ses cotations et revenus. Sois direct et opérationnel.`
                  },
                  ...messages
                ],
                max_tokens: 800,
                temperature: 0.3,
              }),
            });

            if (xaiRes.ok) {
              const xaiData = await xaiRes.json();
              const answer = xaiData.choices?.[0]?.message?.content || 'Aucune réponse.';
              await writeAuditLog(D, { user_id: user.id, event: 'COPILOT_QUERY', ip: clientIP, meta: { q: question.slice(0,100), source: 'xai' } });
              return json({ ok: true, answer, source: 'xai_grok' });
            }
            console.warn('[AMI] xAI copilot KO:', xaiRes.status);
          } catch(e) {
            console.warn('[AMI] xAI copilot error:', e.message);
          }
        }

        // ── Fallback règles NGAP statiques ───────────────────────────
        const q = question.toLowerCase();
        let answer = '';
        if (/ifd|déplacement|domicile/.test(q))
          answer = "L'IFD (Indemnité Forfaitaire de Déplacement) est de 2,75 € par passage au domicile du patient.";
        else if (/ik|kilomètre|km/.test(q))
          answer = "Les IK sont de 0,35 €/km. Indiquez la distance réelle aller-retour.";
        else if (/nuit profonde|23h|mn2/.test(q))
          answer = "Majoration nuit profonde MN2 (23h–5h) : +18,30 €.";
        else if (/nuit|majoration|mn/.test(q))
          answer = "MN (20h–8h) : +9,15 €. MN2 (23h–5h) : +18,30 €. MD (dimanche/férié) : +8,50 €.";
        else if (/ald|exonération|100%/.test(q))
          answer = "En ALD, remboursement à 100% et ticket modérateur supprimé. Part patient = 0 €.";
        else if (/ami|coefficient|tarif/.test(q))
          answer = "AMI = 3,15 €/unité. AMI1=3,15€, AMI2=6,30€, AMI3=9,45€, AMI4=12,60€. AIS = 2,65 €/unité.";
        else if (/bsa|bsb|bsc|toilette|dépendance|bilan/.test(q))
          answer = "BSI : BSA=13€, BSB=18,20€, BSC=28,70€. Incompatible avec AIS le même jour.";
        else if (/cumul|incompatible|interdit/.test(q))
          answer = "Cumuls interdits : AMI+AIS, BSA/BSB/BSC+AIS, MN+MN2 sur le même passage.";
        else if (/mci|coordination/.test(q))
          answer = "MCI (Majoration Coordination Infirmière) = 5 €.";
        else if (/fraude|urssaf|contrôle/.test(q))
          answer = "Vigilance CPAM : éviter >4 actes/passage, IK >50km sans justification, majorations nuit sans heure documentée.";
        else
          answer = `Assistant NGAP : pour "${question.slice(0,60)}…", consultez la nomenclature 2026 ou utilisez la cotation IA.`;

        await writeAuditLog(D, { user_id: user.id, event: 'COPILOT_QUERY', ip: clientIP, meta: { q: question.slice(0,100), source: 'rules' } });
        return json({ ok: true, answer, source: 'ngap_rules_fallback' });
      }


      // ════ SCORING TOURNÉE HEBDO ════
      if (path === '/webhook/ami-week-analytics') {
        if (!hasPermission(userRole, 'manage_tournee')) return err('Accès non autorisé.', 403);
        const rows = await D(`planning_patients?infirmiere_id=eq.${user.id}&select=total,notes,date_soin&order=date_soin.asc`);
        const arr = Array.isArray(rows) ? rows : [];
        const byDay = {};
        const jours = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
        arr.forEach(r => {
          const d = r.date_soin ? new Date(r.date_soin).getDay() : -1;
          const key = d >= 0 ? (jours[d===0?6:d-1]||'?') : 'Inconnu';
          if (!byDay[key]) byDay[key] = { patients: 0, ca: 0 };
          byDay[key].patients++;
          byDay[key].ca += safeNum(r.total);
        });
        const totalCA = arr.reduce((s,r) => s + safeNum(r.total), 0);
        const caProjection = safeNum(totalCA * 4.33);
        return json({ ok: true, by_day: byDay, total_ca: safeNum(totalCA), ca_mensuel_projection: caProjection, nb_patients: arr.length });
      }

      // ════ ADMIN ROUTES ════

      // ════ RESET SYSTEM LOGS (admin) ════
      if (path === '/webhook/admin-system-reset') {
        if (!hasPermission(userRole, 'view_logs')) return err('Accès réservé aux administrateurs.', 403);
        let deleted = 0;
        try {
          // Supabase refuse DELETE sans filtre — filtrer sur id >= 0 pour tout supprimer
          await D('system_logs?id=gte.0', { method:'DELETE', headers:{'Prefer':'return=minimal'} });
          deleted++;
        } catch(e1) {
          // Fallback : filtrer par date epoch (= toutes les entrées)
          try {
            await D('system_logs?created_at=gte.1970-01-01T00:00:00.000Z', { method:'DELETE', headers:{'Prefer':'return=minimal'} });
            deleted++;
          } catch(e2) {
            return err('Impossible de vider system_logs : ' + e2.message, 500);
          }
        }
        // Remettre à zéro les compteurs mémoire AMI_SYSTEM
        AMI_SYSTEM.counters = { n8n_errors: 0, ia_fallbacks: 0, fraud_alerts: 0, front_errors: 0 };
        AMI_SYSTEM.n8n_diag = { timeout: 0, parse_fail: 0, empty: 0, http_error: 0, html: 0, other: 0 };
        await writeAuditLog(D, { user_id: user.id, event: 'ADMIN_SYSTEM_RESET', ip: clientIP, meta: { action: 'system_logs_cleared' } });
        return json({ ok: true, message: 'Logs système réinitialisés.' });
      }

      if (path==='/webhook/admin-liste') {
        if(!hasPermission(userRole,'view_users_list')) return err('Accès réservé aux administrateurs.',403);
        // Les admins ne voient PAS les autres admins — uniquement les infirmières (role=nurse)
        const rows=await D('infirmieres?role=eq.nurse&select=id,nom,prenom,is_blocked&order=nom.asc'); if(!Array.isArray(rows)) return err('Erreur base de données.',500);
        return json({ok:true,comptes:rows.map(toAdminView)});
      }
      if (path==='/webhook/admin-stats') {
        if(!hasPermission(userRole,'view_stats')) return err('Accès réservé aux administrateurs.',403);
        // ⚠️ RGPD/HDS : admin-stats ne retourne que des métriques agrégées (codes NGAP + montants)
        // Aucune description textuelle (noms, pathologies) n'est exposée.
        // Les données récupérées sont celles de toutes les infirmières mais réduites aux codes + totaux uniquement.
        let rows=[];
        try{ rows=await D('planning_patients?select=total,dre_requise,notes&order=created_at.desc&limit=1000'); }
        catch{ try{ rows=await D('planning_patients?select=total,notes&limit=1000'); }catch{} }
        const arr=Array.isArray(rows)?rows:[];
        const totalCA=arr.reduce((s,r)=>s+safeNum(r.total),0);
        const actesFreq={};
        arr.forEach(r=>{
          try{
            JSON.parse(r.actes||'[]').forEach(a=>{
              // ✅ Seul le CODE NGAP (ex: AMI1, BSC, IFD) est comptabilisé — jamais le champ "nom" (texte libre)
              if(a.code && /^[A-Z]{2,5}\d*$/.test(a.code)) actesFreq[a.code]=(actesFreq[a.code]||0)+1;
            });
          }catch{}
        });
        const topActes=Object.entries(actesFreq).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([code,count])=>({code,count}));
        return json({ok:true,stats:{ca_total:safeNum(totalCA),nb_actes:arr.length,panier_moyen:arr.length?safeNum(totalCA/arr.length):0,nb_dre:arr.filter(r=>r.dre_requise).length,nb_alertes:arr.filter(r=>{try{return JSON.parse(r.alerts||'[]').length>0}catch{return false}}).length,top_actes:topActes}});
      }

      // ✅ v6.0 — admin-logs enrichi : audit_logs + system_logs + stats globales
      if (path==='/webhook/admin-logs') {
        if(!hasPermission(userRole,'view_logs')) return err('Accès réservé aux administrateurs.',403);
        let auditLogs=[], systemLogs=[];
        try{auditLogs=await D('audit_logs?select=id,user_id,event,score,ip,created_at&order=created_at.desc&limit=100');}catch{}
        try{systemLogs=await D('system_logs?select=id,level,source,event,message,created_at&order=created_at.desc&limit=100');}catch{}
        const audit=Array.isArray(auditLogs)?auditLogs:[], system=Array.isArray(systemLogs)?systemLogs:[];
        // Fusionner compteurs DB + compteurs mémoire AMI_SYSTEM (plus précis en temps réel)
        const memStats = AMI_SYSTEM.getStats();
        return json({ok:true, logs:audit, system_logs:system, stats:{
          fraud_alerts:    Math.max(audit.filter(l=>l.event==='COTATION_FRAUD_ALERT').length, memStats.fraud_alerts),
          n8n_failures:    Math.max(system.filter(l=>l.event==='N8N_FAILURE').length,         memStats.n8n_failures),
          ia_fallbacks:    Math.max(system.filter(l=>l.event==='IA_FALLBACK').length,          memStats.ia_fallbacks),
          frontend_errors: Math.max(system.filter(l=>l.source==='frontend').length,            memStats.frontend_errors),
          login_fails:     audit.filter(l=>l.event==='LOGIN_FAIL').length,
          n8n_diag_detail: memStats.n8n_diag_detail,
        }});
      }

      if (path==='/webhook/admin-security-stats') {
        if(!hasPermission(userRole,'view_logs')) return err('Accès réservé aux administrateurs.',403);
        let logs=[];try{logs=await D('audit_logs?select=event,score,created_at&order=created_at.desc&limit=1000');}catch{}
        const arr=Array.isArray(logs)?logs:[];
        return json({ok:true,security:{login_fails:arr.filter(l=>l.event==='LOGIN_FAIL').length,fraud_alerts:arr.filter(l=>l.event==='COTATION_FRAUD_ALERT').length,high_score_events:arr.filter(l=>(l.score||0)>=70).length,recent_alerts:arr.filter(l=>l.event==='COTATION_FRAUD_ALERT'||l.event==='LOGIN_FAIL').slice(0,20).map(l=>({event:l.event,score:l.score,created_at:l.created_at}))}});
      }
      if (path==='/webhook/admin-bloquer') {
        if(!hasPermission(userRole,'block_user')) return err('Accès non autorisé.',403);
        const targetId=String(body.id||'').trim(); if(!targetId) return err('ID manquant.',400);
        const target=await D(`infirmieres?id=eq.${targetId}&select=id,role,email`); if(!Array.isArray(target)||!target[0]) return err('Compte non trouvé.',404);
        if(target[0].role==='admin'||ADMIN_EMAILS.includes(target[0].email)) return err('Impossible de bloquer un administrateur.',403);
        await D(`infirmieres?id=eq.${targetId}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({is_blocked:true})});
        await D(`sessions?infirmiere_id=eq.${targetId}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await writeAuditLog(D,{user_id:user.id,event:'ADMIN_BLOCK_USER',ip:clientIP,meta:{target_id:targetId}}); return json({ok:true,action:'blocked',id:targetId});
      }
      if (path==='/webhook/admin-debloquer') {
        if(!hasPermission(userRole,'unblock_user')) return err('Accès non autorisé.',403);
        const targetId=String(body.id||'').trim(); if(!targetId) return err('ID manquant.',400);
        const target=await D(`infirmieres?id=eq.${targetId}&select=id,role,email`); if(!Array.isArray(target)||!target[0]) return err('Compte non trouvé.',404);
        if(target[0].role==='admin'||ADMIN_EMAILS.includes(target[0].email)) return err('Action non autorisée.',403);
        await D(`infirmieres?id=eq.${targetId}`,{method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({is_blocked:false})});
        await writeAuditLog(D,{user_id:user.id,event:'ADMIN_UNBLOCK_USER',ip:clientIP,meta:{target_id:targetId}}); return json({ok:true,action:'unblocked',id:targetId});
      }
      if (path==='/webhook/admin-supprimer') {
        if(!hasPermission(userRole,'delete_user')) return err('Accès non autorisé.',403);
        const targetId=String(body.id||'').trim(); if(!targetId) return err('ID manquant.',400);
        const target=await D(`infirmieres?id=eq.${targetId}&select=id,role,email`); if(!Array.isArray(target)||!target[0]) return err('Compte non trouvé.',404);
        if(target[0].role==='admin'||ADMIN_EMAILS.includes(target[0].email)) return err('Impossible de supprimer un administrateur.',403);
        await D(`sessions?infirmiere_id=eq.${targetId}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await D(`planning_patients?infirmiere_id=eq.${targetId}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await D(`invoice_counters?infirmiere_id=eq.${targetId}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await D(`infirmieres?id=eq.${targetId}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
        await writeAuditLog(D,{user_id:user.id,event:'ADMIN_DELETE_USER',ip:clientIP,meta:{target_id:targetId}}); return json({ok:true,action:'deleted',id:targetId});
      }

      // ════ SYNC CARNET PATIENTS (données chiffrées côté client) ════

      if (path === '/webhook/patients-push') {
        // Reçoit { patients: [{id, encrypted_data, nom_enc, updated_at}] }
        // encrypted_data = blob AES chiffré côté client — le serveur ne déchiffre jamais
        if (!user) return err('Non authentifié.', 401);
        const { patients: incoming = [] } = body;
        if (!Array.isArray(incoming) || !incoming.length) return json({ ok: true, synced: 0 });

        // Charger les patient_id existants pour distinguer INSERT vs UPDATE
        const existing = await D(`carnet_patients?infirmiere_id=eq.${user.id}&select=patient_id,updated_at`);
        const existMap = new Map((Array.isArray(existing) ? existing : []).map(r => [r.patient_id, r.updated_at]));

        let synced = 0;
        for (const p of incoming) {
          if (!p.id || !p.encrypted_data) continue;
          const payload = {
            infirmiere_id:  user.id,
            patient_id:     p.id,
            encrypted_data: p.encrypted_data,
            nom_enc:        p.nom_enc || '',
            updated_at:     p.updated_at || new Date().toISOString(),
          };

          if (existMap.has(p.id)) {
            // Mise à jour — PATCH sur la ligne existante
            await D(`carnet_patients?infirmiere_id=eq.${user.id}&patient_id=eq.${p.id}`, {
              method: 'PATCH',
              headers: { 'Prefer': 'return=minimal' },
              body: JSON.stringify({ encrypted_data: p.encrypted_data, nom_enc: p.nom_enc || '', updated_at: payload.updated_at }),
            });
          } else {
            // Insertion — POST
            await D('carnet_patients', {
              method: 'POST',
              headers: { 'Prefer': 'return=minimal' },
              body: JSON.stringify(payload),
            });
          }
          synced++;
        }
        await writeAuditLog(D, { user_id: user.id, event: 'PATIENTS_PUSH', ip: clientIP, meta: { count: synced } });
        return json({ ok: true, synced });
      }

      if (path === '/webhook/patients-pull') {
        // Retourne tous les patients chiffrés de l'infirmière
        if (!user) return err('Non authentifié.', 401);
        const rows = await D(`carnet_patients?infirmiere_id=eq.${user.id}&select=patient_id,encrypted_data,nom_enc,updated_at&order=updated_at.desc`);
        return json({ ok: true, patients: Array.isArray(rows) ? rows : [] });
      }

      if (path === '/webhook/patients-delete') {
        // Supprime un patient du serveur { patient_id }
        if (!user) return err('Non authentifié.', 401);
        const { patient_id } = body;
        if (!patient_id) return err('patient_id manquant.', 400);
        await D(`carnet_patients?infirmiere_id=eq.${user.id}&patient_id=eq.${patient_id}`, {
          method: 'DELETE',
          headers: { 'Prefer': 'return=minimal' },
        });
        return json({ ok: true, deleted: patient_id });
      }

      // ════ SYNC PLANNING HEBDOMADAIRE (blob chiffré côté client) ════

      if (path === '/webhook/planning-push') {
        // Reçoit { encrypted_data: string, updated_at: string }
        // Le serveur stocke le blob opaque — il ne déchiffre jamais
        if (!user) return err('Non authentifié.', 401);
        const { encrypted_data, updated_at } = body;
        if (!encrypted_data) return json({ ok: true, synced: 0 });

        const existing = await D(`weekly_planning?infirmiere_id=eq.${user.id}&select=id`);
        const payload = {
          infirmiere_id:  user.id,
          encrypted_data,
          updated_at: updated_at || new Date().toISOString(),
        };

        if (Array.isArray(existing) && existing.length > 0) {
          await D(`weekly_planning?infirmiere_id=eq.${user.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ encrypted_data, updated_at: payload.updated_at }),
          });
        } else {
          await D('weekly_planning', {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify(payload),
          });
        }
        await writeAuditLog(D, { user_id: user.id, event: 'PLANNING_PUSH', ip: clientIP, meta: {} });
        return json({ ok: true, synced: 1 });
      }

      if (path === '/webhook/planning-pull') {
        // Retourne le blob chiffré du planning de l'infirmière
        if (!user) return err('Non authentifié.', 401);
        const rows = await D(`weekly_planning?infirmiere_id=eq.${user.id}&select=encrypted_data,updated_at&limit=1`);
        if (!Array.isArray(rows) || !rows.length) return json({ ok: true, data: null });
        return json({ ok: true, data: rows[0] });
      }

      // ════ SYNC JOURNAL KILOMÉTRIQUE (blob chiffré côté client) ════

      if (path === '/webhook/km-push') {
        // Reçoit { encrypted_data: string, updated_at: string }
        if (!user) return err('Non authentifié.', 401);
        const { encrypted_data, updated_at } = body;
        if (!encrypted_data) return json({ ok: true, synced: 0 });

        const existing = await D(`km_journal?infirmiere_id=eq.${user.id}&select=id`);
        const payload = {
          infirmiere_id:  user.id,
          encrypted_data,
          updated_at: updated_at || new Date().toISOString(),
        };

        if (Array.isArray(existing) && existing.length > 0) {
          await D(`km_journal?infirmiere_id=eq.${user.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ encrypted_data, updated_at: payload.updated_at }),
          });
        } else {
          await D('km_journal', {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify(payload),
          });
        }
        await writeAuditLog(D, { user_id: user.id, event: 'KM_PUSH', ip: clientIP, meta: {} });
        return json({ ok: true, synced: 1 });
      }

      if (path === '/webhook/km-pull') {
        // Retourne le blob chiffré du journal km de l'infirmière
        if (!user) return err('Non authentifié.', 401);
        const rows = await D(`km_journal?infirmiere_id=eq.${user.id}&select=encrypted_data,updated_at&limit=1`);
        if (!Array.isArray(rows) || !rows.length) return json({ ok: true, data: null });
        return json({ ok: true, data: rows[0] });
      }

      return err('Route non trouvée.', 404);

    } catch (e) {
      console.error('[AMI] Erreur interne :', e.message);
      try { await writeSystemLog(D, { level:'error', source:'worker', event:'INTERNAL_ERROR', message:e.message, meta:{path} }); } catch {}
      return err('Erreur interne : ' + e.message, 500);
    }
  },
};
