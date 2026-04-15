/* ════════════════════════════════════════════════
   signature.js — AMI NGAP
   ────────────────────────────────────────────────
   Signature électronique patient
   ✅ Canvas tactile + souris + stylet
   ✅ Stockage local chiffré (IDB)
   ✅ Export PNG embarqué dans la facture
   ✅ Historique signatures par cotation
   ✅ Conformité : horodatage + IP + user-agent
   ────────────────────────────────────────────────
   Fonctions :
   - openSignatureModal(invoiceId)  — ouvre le pad
   - clearSignature()               — efface le pad
   - saveSignature(invoiceId)       — sauvegarde + ferme
   - getSignature(invoiceId)        — récupère PNG base64
   - deleteSignature(invoiceId)     — supprime (RGPD)
   - injectSignatureInPDF(d, u)     — ajoute à la facture
════════════════════════════════════════════════ */

const SIG_STORE = 'ami_signatures';
let _sigCanvas = null, _sigCtx = null, _sigDrawing = false;
let _currentInvoiceId = null, _sigDB = null;
let _sigDBUserId = null; // Garde la trace du user actif pour la DB signatures

/* ── Retourne le nom de la base IndexedDB signatures isolée par user ──
   Chaque infirmière a sa propre base : ami_sig_db_<userId>.
   Un admin voit uniquement ses propres signatures de test.
───────────────────────────────────────────────────────────────────── */
function _getSigDBName() {
  const uid = (typeof S !== 'undefined') ? (S?.user?.id || S?.user?.email || 'local') : 'local';
  return 'ami_sig_db_' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* ── IndexedDB ── */
async function _initSigDB() {
  const currentUserId = (typeof S !== 'undefined') ? (S?.user?.id || S?.user?.email || 'local') : 'local';
  // Fermer si l'utilisateur a changé
  if (_sigDB && _sigDBUserId !== currentUserId) {
    _sigDB.close();
    _sigDB = null;
    _sigDBUserId = null;
  }
  if (_sigDB) return _sigDB;
  const dbName = _getSigDBName();
  return new Promise((res, rej) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SIG_STORE)) {
        db.createObjectStore(SIG_STORE, { keyPath: 'invoice_id' });
      }
    };
    req.onsuccess = e => {
      _sigDB = e.target.result;
      _sigDBUserId = currentUserId;
      res(_sigDB);
    };
    req.onerror   = () => rej(req.error);
  });
}

async function _sigPut(val) {
  const db = await _initSigDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(SIG_STORE, 'readwrite');
    tx.objectStore(SIG_STORE).put(val).onsuccess = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function _sigGet(id) {
  const db = await _initSigDB();
  return new Promise((res) => {
    const tx = db.transaction(SIG_STORE, 'readonly');
    const req = tx.objectStore(SIG_STORE).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror   = () => res(null);
  });
}

async function _sigDelete(id) {
  const db = await _initSigDB();
  return new Promise((res) => {
    const tx = db.transaction(SIG_STORE, 'readwrite');
    tx.objectStore(SIG_STORE).delete(id);
    tx.oncomplete = () => res();
  });
}

/* ════════════════════════════════════════════════
   MODAL SIGNATURE
════════════════════════════════════════════════ */
function openSignatureModal(invoiceId) {
  _currentInvoiceId = invoiceId || 'sig_' + Date.now();

  let modal = document.getElementById('sig-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'sig-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:1500;display:flex;align-items:center;
      justify-content:center;background:rgba(11,15,20,.92);
      backdrop-filter:blur(12px);padding:20px`;
    modal.innerHTML = `
      <div style="background:var(--c);border:1px solid var(--b);border-radius:20px;
        padding:28px;width:100%;max-width:520px;box-shadow:0 0 60px rgba(0,0,0,.6)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div style="font-family:var(--fs);font-size:20px">✍️ Signature patient</div>
          <button onclick="closeSignatureModal()" style="background:var(--s);border:1px solid var(--b);
            color:var(--m);width:32px;height:32px;border-radius:50%;cursor:pointer;
            display:grid;place-items:center;font-size:16px">✕</button>
        </div>
        <p style="font-size:12px;color:var(--m);margin-bottom:14px">
          Signez dans le cadre ci-dessous pour valider le soin et autoriser la télétransmission.
          La signature est stockée localement et n'est jamais transmise au serveur.
        </p>
        <div style="position:relative;border:2px dashed var(--b);border-radius:var(--r);
          background:var(--s);overflow:hidden;touch-action:none" id="sig-wrap">
          <canvas id="sig-canvas" width="480" height="200"
            style="width:100%;height:200px;display:block;cursor:crosshair"></canvas>
          <div id="sig-placeholder" style="position:absolute;inset:0;display:flex;
            align-items:center;justify-content:center;color:var(--m);font-size:13px;
            pointer-events:none;font-family:var(--fm)">Signez ici ✍️</div>
        </div>
        <div id="sig-info" style="font-family:var(--fm);font-size:10px;color:var(--m);
          margin-top:8px;text-align:right"></div>
        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
          <button class="btn bp" onclick="saveSignature()" style="flex:1">💾 Valider la signature</button>
          <button class="btn bs bsm" onclick="clearSignature()">🗑️ Effacer</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  modal.style.display = 'flex';
  _initCanvas();

  // Afficher l'horodatage
  const info = document.getElementById('sig-info');
  if (info) info.textContent = new Date().toLocaleString('fr-FR') + ' · Facture ' + (_currentInvoiceId || '—');
}

function closeSignatureModal() {
  const modal = document.getElementById('sig-modal');
  if (modal) modal.style.display = 'none';
}

/* ════════════════════════════════════════════════
   CANVAS — DESSIN
════════════════════════════════════════════════ */
function _initCanvas() {
  _sigCanvas = document.getElementById('sig-canvas');
  if (!_sigCanvas) return;
  _sigCtx = _sigCanvas.getContext('2d');
  _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
  _sigCtx.strokeStyle = '#e8f0f8';
  _sigCtx.lineWidth   = 2.5;
  _sigCtx.lineCap     = 'round';
  _sigCtx.lineJoin    = 'round';
  _sigDrawing = false;

  // Masquer le placeholder quand on commence à dessiner
  const placeholder = document.getElementById('sig-placeholder');

  const getPos = (e) => {
    const rect = _sigCanvas.getBoundingClientRect();
    const scaleX = _sigCanvas.width  / rect.width;
    const scaleY = _sigCanvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - rect.left) * scaleX,
      y: (src.clientY - rect.top)  * scaleY,
    };
  };

  const start = (e) => {
    e.preventDefault();
    _sigDrawing = true;
    if (placeholder) placeholder.style.display = 'none';
    const { x, y } = getPos(e);
    _sigCtx.beginPath();
    _sigCtx.moveTo(x, y);
  };

  const draw = (e) => {
    e.preventDefault();
    if (!_sigDrawing) return;
    const { x, y } = getPos(e);
    _sigCtx.lineTo(x, y);
    _sigCtx.stroke();
  };

  const end = () => { _sigDrawing = false; };

  // Souris
  _sigCanvas.addEventListener('mousedown',  start);
  _sigCanvas.addEventListener('mousemove',  draw);
  _sigCanvas.addEventListener('mouseup',    end);
  _sigCanvas.addEventListener('mouseleave', end);

  // Tactile (tablette, smartphone)
  _sigCanvas.addEventListener('touchstart', start, { passive: false });
  _sigCanvas.addEventListener('touchmove',  draw,  { passive: false });
  _sigCanvas.addEventListener('touchend',   end);
}

function clearSignature() {
  if (!_sigCanvas || !_sigCtx) return;
  _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
  const placeholder = document.getElementById('sig-placeholder');
  if (placeholder) placeholder.style.display = 'flex';
}

/* ════════════════════════════════════════════════
   SAUVEGARDE & RÉCUPÉRATION
════════════════════════════════════════════════ */
async function saveSignature() {
  if (!_sigCanvas) { closeSignatureModal(); return; }

  // Vérifier si la signature est vide
  const imageData = _sigCtx.getImageData(0, 0, _sigCanvas.width, _sigCanvas.height);
  const hasDrawing = imageData.data.some(v => v !== 0);
  if (!hasDrawing) {
    if (!confirm('Aucune signature tracée. Valider quand même ?')) return;
  }

  const png = _sigCanvas.toDataURL('image/png');
  await _sigPut({
    invoice_id:  _currentInvoiceId,
    png,
    signed_at:   new Date().toISOString(),
    user_agent:  navigator.userAgent.slice(0, 100),
  });

  closeSignatureModal();

  // Feedback visuel sur le bouton d'impression si présent
  const sigBtn = document.querySelector(`[data-sig="${_currentInvoiceId}"]`);
  if (sigBtn) {
    sigBtn.textContent = '✅ Signé';
    sigBtn.style.background = 'rgba(0,212,170,.15)';
    sigBtn.style.color = 'var(--a)';
  }

  if (typeof showToast === 'function') showToast('✍️ Signature enregistrée.', 'ok');
}

async function getSignature(invoiceId) {
  const row = await _sigGet(invoiceId);
  return row?.png || null;
}

async function deleteSignature(invoiceId) {
  await _sigDelete(invoiceId);
  if (typeof showToast === 'function') showToast('🗑️ Signature supprimée.', 'ok');
}

/* ════════════════════════════════════════════════
   INJECTION DANS LA FACTURE PDF
════════════════════════════════════════════════ */
async function injectSignatureInPDF(invoiceId) {
  const png = await getSignature(invoiceId);
  if (!png) return '';

  return `
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e0e7ef">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start">
        <div>
          <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:8px">Signature infirmier(ère)</div>
          <div style="height:80px;border:1px dashed #ccd5e0;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px">
            À signer
          </div>
        </div>
        <div>
          <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:8px">Signature patient — accord soins</div>
          <img src="${png}" style="width:100%;max-height:80px;border:1px solid #e0e7ef;border-radius:6px;object-fit:contain;background:#fff">
          <div style="font-size:9px;color:#9ca3af;margin-top:3px">Signé électroniquement · ${new Date().toLocaleDateString('fr-FR')}</div>
        </div>
      </div>
    </div>`;
}

/* Exposer globalement */
window.openSignatureModal  = openSignatureModal;
window.closeSignatureModal = closeSignatureModal;
window.clearSignature      = clearSignature;
window.saveSignature       = saveSignature;
window.getSignature        = getSignature;
window.deleteSignature     = deleteSignature;
window.injectSignatureInPDF = injectSignatureInPDF;

/* ── Patch printInv pour injecter la signature automatiquement ── */
document.addEventListener('DOMContentLoaded', () => {
  const _origPrintInv = window.printInv;
  if (typeof _origPrintInv === 'function') {
    window.printInv = async function(d) {
      // Injecter la signature si elle existe
      if (d?.invoice_number) {
        const sigBloc = await injectSignatureInPDF(d.invoice_number);
        if (sigBloc) d._sig_html = sigBloc;
      }
      return _origPrintInv(d);
    };
  }

  // Ajouter le bouton signature dans les résultats de cotation
  // ami:cotation_done — géré directement dans cotation.js (injection immédiate)
  // Ce listener reste en fallback pour d'autres contextes (tournée, etc.)
  document.addEventListener('ami:cotation_done', async (e) => {
    const invoiceId = e.detail?.invoice_number;
    if (!invoiceId) return;
    const cbody = document.getElementById('cbody');
    if (!cbody) return;
    if (cbody.querySelector('.sig-btn-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'sig-btn-wrap';
    wrap.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--b);display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    wrap.innerHTML = `
      <button class="btn bv bsm" data-sig="${invoiceId}"
        onclick="openSignatureModal('${invoiceId}')">
        ✍️ Faire signer le patient
      </button>
      <span style="font-size:11px;color:var(--m)">Signature stockée localement · non transmise</span>`;
    cbody.querySelector('.card')?.appendChild(wrap);
  });
});

/* ════════════════════════════════════════════════
   LISTE DES SIGNATURES (vue #view-sig)
════════════════════════════════════════════════ */
async function loadSignatureList() {
  const el = document.getElementById('sig-list-body');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--m);font-size:13px;padding:20px 0;text-align:center">Chargement…</p>';
  try {
    const db = await _initSigDB();
    const tx = db.transaction(SIG_STORE, 'readonly');
    const store = tx.objectStore(SIG_STORE);
    const all = await new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror  = () => rej(req.error);
    });

    if (!all.length) {
      el.innerHTML = `<p style="color:var(--m);font-size:13px;padding:20px 0;text-align:center">
        Aucune signature enregistrée.<br><span style="font-size:11px;opacity:.6">Les signatures apparaissent après chaque cotation signée.</span>
      </p>`;
      return;
    }

    el.innerHTML = all.map(sig => {
      const _dateRaw = sig.signed_at || sig.created_at || null;
      const date = _dateRaw ? new Date(_dateRaw).toLocaleString('fr-FR', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
      const invoiceId = sig.invoice_id || '—';
      const _previewSrc = sig.png || sig.data_url || null;
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--b)">
        <div style="width:48px;height:48px;border-radius:8px;border:1px solid var(--b);overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.04)">
          ${_previewSrc ? `<img src="${_previewSrc}" style="width:100%;height:100%;object-fit:contain">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:20px">✍️</div>'}
        </div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:500;font-family:var(--fm)">${invoiceId}</div>
          <div style="font-size:11px;color:var(--m)">${date}</div>
        </div>
        <button class="btn bs bsm" onclick="deleteSignature('${sig.invoice_id}').then(loadSignatureList)" style="font-size:11px;padding:6px 10px">🗑️</button>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = '<p style="color:var(--d);font-size:13px;padding:20px 0;text-align:center">Erreur de chargement des signatures.</p>';
    console.warn('[Signatures] loadSignatureList:', e);
  }
}

/* Charger la liste quand on navigue vers #view-sig */
document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'sig') loadSignatureList();
});
