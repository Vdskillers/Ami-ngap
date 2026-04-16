/* ════════════════════════════════════════════════
   ai-proactive.js — AMI NGAP v7.0
   ────────────────────────────────────────────────
   Module IA proactive frontend
   - Suggestions en temps réel pendant la saisie
   - Apprentissage des patterns acceptés
   - Tournée live avec recalcul dynamique
   - Score fraude ML post-calcul
   ────────────────────────────────────────────────
   Dépendances : utils.js (S, W), auth.js (S)
   Chargement : après auth.js dans index.html
════════════════════════════════════════════════ */

/* ════ 1. IA SUGGESTION PROACTIVE ════════════════
   Attache un écouteur sur le champ de saisie texte
   et affiche les suggestions IA en temps réel
═══════════════════════════════════════════════ */

const AISuggest = (() => {
  let _debounceTimer = null;
  let _lastText = '';
  let _panel = null;
  let _currentSuggestion = null;

  /* ── Créer le panneau de suggestion ─────────── */
  function _createPanel(inputEl) {
    if (_panel) return _panel;
    _panel = document.createElement('div');
    _panel.id = 'ai-suggest-panel';
    _panel.style.cssText = `
      display:none;
      position:absolute;
      z-index:1000;
      background:var(--s, #fff);
      border:1.5px solid var(--a, #0F172A);
      border-radius:14px;
      padding:14px 16px;
      min-width:280px;
      max-width:360px;
      box-shadow:0 8px 32px rgba(0,0,0,.12);
      font-size:13px;
      line-height:1.5;
    `;
    // Positionner sous le champ
    const parent = inputEl.parentElement || document.body;
    parent.style.position = parent.style.position || 'relative';
    parent.appendChild(_panel);
    return _panel;
  }

  /* ── Afficher les suggestions ────────────────── */
  function _render(data) {
    if (!_panel) return;
    if (!data || !data.suggestions || !data.suggestions.length) {
      _panel.style.display = 'none';
      return;
    }

    const actes = data.suggestions;
    const total = data.total_estime || 0;
    const conf  = Math.round((data.confidence || 0) * 100);
    const src   = data.source === 'learning' ? '🧠 Personnel' : '🔮 Suggestion';
    const opts  = data.optimisations || [];

    _panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-weight:700;font-size:12px;color:var(--a, #0F172A);">${src}</span>
        <span style="font-size:11px;color:var(--t2,#64748B);">Confiance ${conf}%</span>
        <button onclick="AISuggest.hide()" style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1;color:var(--t2);">×</button>
      </div>
      ${actes.map(a => `
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--b,#eee);">
          <span style="font-weight:600;">${a.code}</span>
          <span style="color:var(--t2,#64748B);font-size:12px;">${a.nom}</span>
          <span style="font-weight:700;color:var(--a);">${(a.total||0).toFixed(2)}€</span>
        </div>
      `).join('')}
      <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:var(--t2);">Total estimé</span>
        <span style="font-size:18px;font-weight:800;color:var(--a);">${total.toFixed(2)} €</span>
      </div>
      ${opts.length ? `<div style="margin-top:8px;">${opts.map(o => `<div style="font-size:11px;color:#F59E0B;padding:2px 0;">${o}</div>`).join('')}</div>` : ''}
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button id="ai-suggest-accept" style="flex:1;padding:8px;background:var(--a,#0F172A);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:12px;">
          ✓ Appliquer
        </button>
        <button id="ai-suggest-dismiss" style="padding:8px 14px;background:none;border:1px solid var(--b,#eee);border-radius:8px;cursor:pointer;font-size:12px;">
          Ignorer
        </button>
      </div>
    `;

    _panel.querySelector('#ai-suggest-accept')?.addEventListener('click', () => {
      AISuggest.accept();
    });
    _panel.querySelector('#ai-suggest-dismiss')?.addEventListener('click', () => {
      AISuggest.hide();
    });

    _panel.style.display = 'block';
  }

  /* ── Appel API suggest ───────────────────────── */
  async function _fetchSuggestion(text) {
    try {
      const res = await W('/webhook/ami-suggest', { texte: text });
      if (res && res.ok) {
        _currentSuggestion = { ...res, texte: text };
        _render(res);
      }
    } catch { /* silencieux */ }
  }

  return {
    /* ── Initialiser sur un champ textarea/input ── */
    attach(inputSelector, options = {}) {
      const inputEl = typeof inputSelector === 'string'
        ? document.querySelector(inputSelector)
        : inputSelector;
      if (!inputEl) return;

      _createPanel(inputEl);

      inputEl.addEventListener('input', (e) => {
        const text = e.target.value.trim();
        if (text === _lastText) return;
        _lastText = text;

        clearTimeout(_debounceTimer);
        if (text.length < 4) { this.hide(); return; }

        // Debounce 350ms
        _debounceTimer = setTimeout(() => _fetchSuggestion(text), 350);
      });

      // Fermer si on clique ailleurs
      document.addEventListener('click', (e) => {
        if (!_panel?.contains(e.target) && e.target !== inputEl) this.hide();
      });
    },

    /* ── Accepter la suggestion ─────────────────── */
    async accept() {
      if (!_currentSuggestion) return;
      this.hide();

      // Notifier l'apprentissage
      try {
        await W('/webhook/ami-learning-update', {
          texte:    _currentSuggestion.texte,
          actes:    _currentSuggestion.suggestions,
          accepted: true,
        });
      } catch { /* optionnel */ }

      // Émettre un événement custom pour que le formulaire puisse remplir les champs
      document.dispatchEvent(new CustomEvent('ai:suggestion:accepted', {
        detail: {
          actes:       _currentSuggestion.suggestions,
          total:       _currentSuggestion.total_estime,
          texte:       _currentSuggestion.texte,
        },
      }));
    },

    hide() {
      if (_panel) _panel.style.display = 'none';
    },

    /* ── Attacher au champ principal de cotation ── */
    attachToMainForm() {
      // Essayer plusieurs sélecteurs possibles (selon la structure du formulaire)
      const selectors = ['#f-texte', '#texte-soin', '[name="texte"]', 'textarea[placeholder*="soin"]', 'textarea[placeholder*="Décris"]'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { this.attach(el); return; }
      }
      // Réessayer après 1s si le formulaire n'est pas encore chargé
      setTimeout(() => this.attachToMainForm(), 1000);
    },
  };
})();


/* ════ 2. TOURNÉE LIVE V7 ════════════════════════
   Gestion de session tournée GPS avec recalcul
═══════════════════════════════════════════════ */

const TournéeLive = (() => {
  let _tourId = null;
  let _watchId = null;
  let _currentPos = null;

  return {
    /* ── Démarrer une session tournée ────────────── */
    async start(lat, lng) {
      try {
        const res = await W('/webhook/ami-tour-start', { lat, lng });
        if (res && res.ok) {
          _tourId = res.tour_id;
          sessionStorage.setItem('ami_tour_id', _tourId);
          console.log('[TournéeLive] Session démarrée :', _tourId);
          this.startGPSWatch();
          return _tourId;
        }
      } catch (e) { console.warn('[TournéeLive] Erreur start :', e.message); }
      return null;
    },

    /* ── Reprendre une session existante ─────────── */
    resume() {
      const saved = sessionStorage.getItem('ami_tour_id');
      if (saved) { _tourId = saved; this.startGPSWatch(); return true; }
      return false;
    },

    /* ── GPS watch ───────────────────────────────── */
    startGPSWatch() {
      if (!navigator.geolocation || _watchId) return;
      _watchId = navigator.geolocation.watchPosition(
        pos => {
          _currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          document.dispatchEvent(new CustomEvent('tour:position', { detail: _currentPos }));
        },
        err => console.warn('[GPS]', err.message),
        { enableHighAccuracy: true, maximumAge: 10000 }
      );
    },

    stopGPSWatch() {
      if (_watchId) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
    },

    /* ── Marquer patient fait / absent ───────────── */
    async updatePatient(patientId, status = 'patient_done') {
      if (!_tourId) return;
      try {
        return await W('/webhook/ami-tournee-live', {
          tour_id:    _tourId,
          action:     status,
          patient_id: patientId,
        });
      } catch (e) { console.warn('[TournéeLive] updatePatient :', e.message); }
    },

    /* ── Recalcul de route ───────────────────────── */
    async recalcul() {
      if (!_tourId) return null;
      try {
        const res = await W('/webhook/ami-tournee-live', { tour_id: _tourId, action: 'recalcul' });
        if (res && res.ok) {
          document.dispatchEvent(new CustomEvent('tour:recalcul', { detail: res.remaining }));
          return res.remaining;
        }
      } catch (e) { console.warn('[TournéeLive] recalcul :', e.message); }
      return null;
    },

    /* ── Terminer la session ─────────────────────── */
    async end(kmTotal) {
      if (!_tourId) return;
      this.stopGPSWatch();
      try {
        const res = await W('/webhook/ami-tour-end', { tour_id: _tourId, km_total: kmTotal });
        sessionStorage.removeItem('ami_tour_id');
        _tourId = null;
        return res;
      } catch (e) { console.warn('[TournéeLive] end :', e.message); }
    },

    get tourId() { return _tourId; },
    get position() { return _currentPos; },
  };
})();


/* ════ 3. FRAUDE ML — POST-CALCUL ════════════════
   Appelé après un calcul de cotation pour enrichir
   le score fraude avec l'analyse comportementale
═══════════════════════════════════════════════ */

async function enrichFraudML(cotationData) {
  try {
    const res = await W('/webhook/ami-fraud-ml', {
      cotation_id: cotationData.id || null,
      total:       cotationData.total,
      km:          cotationData.km,
      nb_patients: cotationData.nb_patients || 1,
    });
    if (res && res.ok && res.score >= 50) {
      console.warn('[FraudeML] Score :', res.score, res.flags);
      // Affichage discret si score élevé (pas d'accusation frontale)
      if (res.score >= 70 && res.flags?.length) {
        document.dispatchEvent(new CustomEvent('fraud:alert', { detail: { score: res.score, flags: res.flags } }));
      }
    }
    return res;
  } catch { return null; }
}


/* ════ 4. INITIALISATION AUTOMATIQUE ════════════ */

document.addEventListener('DOMContentLoaded', () => {
  // Attacher la suggestion IA au formulaire principal (délai pour laisser le DOM se charger)
  setTimeout(() => {
    if (typeof S !== 'undefined' && S?.token) {
      AISuggest.attachToMainForm();
    }
  }, 1500);
});

// Ré-attacher après connexion
document.addEventListener('app:ready', () => {
  AISuggest.attachToMainForm();
});

// Reprendre tournée live si session en cours
document.addEventListener('app:ready', () => {
  TournéeLive.resume();
});

// Écouter les suggestions acceptées pour feedback utilisateur
document.addEventListener('ai:suggestion:accepted', (e) => {
  const { total, actes } = e.detail;
  if (typeof showToast === 'function') {
    showToast(`✓ Suggestion appliquée — ${total?.toFixed(2)}€`, 'success');
  }
});
