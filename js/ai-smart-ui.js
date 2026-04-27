/* ════════════════════════════════════════════════════════════════════
   ai-smart-ui.js — AMI NGAP v5.10.2
   ────────────────────────────────────────────────────────────────────
   Couche UI de ai-smart-tour.js.

   Ce module ne contient AUCUNE logique métier — il branche les
   capacités d'AMI_SMART à des éléments DOM :

     • Panneau "🧠 Intelligence terrain" dans Pilotage
        - Carte "Mode automatique" (toggle + safetyLevel)
        - Carte "Simulation de journée"
        - Carte "Recommandation zone de départ"
        - Carte "Météo"

     • Status pills dans le card "Mode Uber Médical"
        - 🕒 Fin estimée
        - ⚠️ Retard détecté
        - 🥱 Fatigue
        - 💡 Suggestion d'ajustement
        - 🤖 Autopilote (toggle)

     • 3 modals
        - Configuration "Mode automatique"
        - Résultat "Simulation de journée"
        - Suggestion "Tournée optimisée"

   Le rendu se rafraîchit :
     - sur changement de uberPatients / userPos / nextPatient (APP.on)
     - toutes les 15s (interval) tant que la vue tournée est active

   ⚠️  Garde-fous médico-légaux respectés :
     - Mode auto désactivé par défaut
     - safetyLevel = 3 par défaut (soins critiques jamais déplacés)
     - Toute action irréversible passe par une confirmation utilisateur
   ════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AMI_SMART_UI && window.AMI_SMART_UI._loaded) return;

  const UI = (window.AMI_SMART_UI = window.AMI_SMART_UI || {});
  UI._loaded = true;
  UI.version = '5.10.2';

  /* ╔══════════════════════════════════════════════╗
     ║  Helpers                                       ║
     ╚══════════════════════════════════════════════╝ */

  const $ = (id) => document.getElementById(id);
  const SMART = () => window.AMI_SMART;
  const APP_  = () => (typeof APP !== 'undefined' ? APP : null);

  function _toast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type);
  }

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _patientName(p) {
    if (!p) return 'patient';
    const nom = (p.prenom || '') + ' ' + (p.nom || '');
    return nom.trim() || p.label || p.description || 'patient';
  }

  /* ╔══════════════════════════════════════════════╗
     ║  HTML INJECTION — Panneau Intelligence        ║
     ╚══════════════════════════════════════════════╝ */

  /**
   * Injecte le panneau "🧠 Intelligence terrain" dans la vue Pilotage,
   * juste avant le panel cabinet multi-IDE.
   */
  function _injectPilotagePanel() {
    if ($('smart-pilotage-panel')) return; // déjà injecté
    const cabinet = $('tur-cabinet-panel');
    if (!cabinet) return;

    const html = `
      <div id="smart-pilotage-panel" style="margin-top:16px;padding:14px;border:1px solid rgba(124,77,255,.25);border-radius:10px;background:linear-gradient(135deg,rgba(124,77,255,.04),rgba(0,212,170,.04))">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <div style="font-weight:600;font-size:14px">🧠 Intelligence terrain — <span style="font-size:11px;color:var(--m);font-weight:400">apprentissage continu</span></div>
          <button class="btn bs bsm" onclick="AMI_SMART_UI.toggleAdvanced()" id="smart-advanced-toggle" style="font-size:11px;padding:4px 10px">⚙️ Avancé</button>
        </div>

        <!-- Grille 2x2 cards principales -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">

          <!-- Card 1 : Mode automatique -->
          <div style="padding:12px;border:1px solid var(--b);border-radius:8px;background:var(--s)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-weight:600;font-size:12px">🤖 Mode automatique</div>
              <span id="smart-automode-badge" style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(120,120,120,.15);color:var(--m)">OFF</span>
            </div>
            <div style="font-size:11px;color:var(--m);margin-bottom:10px;line-height:1.4">
              L'IA replanifie en live, propose des pauses et peut parler. <b>Sécurité maximale</b> : les soins critiques ne sont jamais déplacés sans confirmation.
            </div>
            <button class="btn bp bsm" onclick="AMI_SMART_UI.openAutoModeModal()" style="width:100%;justify-content:center;font-size:11px">⚙️ Configurer</button>
          </div>

          <!-- Card 2 : Simulation -->
          <div style="padding:12px;border:1px solid var(--b);border-radius:8px;background:var(--s)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-weight:600;font-size:12px">🧪 Simulation de journée</div>
            </div>
            <div style="font-size:11px;color:var(--m);margin-bottom:10px;line-height:1.4">
              Avant de partir, AMI projette ta journée : heure de fin réaliste, retards probables, patients à risque.
            </div>
            <button class="btn bp bsm" onclick="AMI_SMART_UI.runSimulation()" style="width:100%;justify-content:center;font-size:11px">▶️ Simuler ma journée</button>
          </div>

          <!-- Card 3 : Recommandation départ -->
          <div style="padding:12px;border:1px solid var(--b);border-radius:8px;background:var(--s)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-weight:600;font-size:12px">🧭 Stratégie de départ</div>
            </div>
            <div id="smart-strategy-result" style="font-size:11px;color:var(--m);margin-bottom:10px;line-height:1.4">
              Clique pour qu'AMI te conseille un secteur de départ optimal.
            </div>
            <button class="btn bs bsm" onclick="AMI_SMART_UI.suggestStartZone()" style="width:100%;justify-content:center;font-size:11px">🎯 Conseille-moi</button>
          </div>

          <!-- Card 4 : Météo -->
          <div style="padding:12px;border:1px solid var(--b);border-radius:8px;background:var(--s)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-weight:600;font-size:12px">🌦️ Météo</div>
              <span id="smart-weather-badge" style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(120,120,120,.15);color:var(--m)">—</span>
            </div>
            <div id="smart-weather-detail" style="font-size:11px;color:var(--m);margin-bottom:10px;line-height:1.4">
              Adapte les durées de trajet selon la pluie, le vent, la chaleur.
            </div>
            <button class="btn bs bsm" onclick="AMI_SMART_UI.refreshWeather()" style="width:100%;justify-content:center;font-size:11px">🔄 Actualiser</button>
          </div>

        </div>

        <!-- Zone avancée (cachée par défaut) : stats apprentissage -->
        <div id="smart-advanced-zone" style="display:none;margin-top:14px;padding:12px;border:1px dashed var(--b);border-radius:8px;background:var(--s)">
          <div style="font-weight:600;font-size:12px;margin-bottom:10px">📊 Apprentissage accumulé</div>
          <div id="smart-learning-stats" style="font-size:11px;color:var(--m);line-height:1.6">…</div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn bs bsm" onclick="AMI_SMART_UI.refreshLearningStats()" style="font-size:10px;padding:4px 10px">🔄 Rafraîchir</button>
            <button class="btn bs bsm" onclick="AMI_SMART_UI.resetLearning()" style="font-size:10px;padding:4px 10px;color:var(--d);border-color:rgba(255,95,109,.3)">🗑️ Réinitialiser</button>
          </div>
        </div>
      </div>
    `;

    cabinet.insertAdjacentHTML('beforebegin', html);
  }

  /**
   * Injecte la barre de status pills dans le card Mode Uber Médical,
   * juste après uber-route-info.
   */
  function _injectUberStatusPills() {
    if ($('smart-uber-pills')) return;
    const anchor = $('uber-route-info');
    if (!anchor) return;

    const html = `
      <div id="smart-uber-pills" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:10px;font-size:11px">
        <span id="smart-pill-end"     class="smart-pill" style="display:none"></span>
        <span id="smart-pill-late"    class="smart-pill" style="display:none"></span>
        <span id="smart-pill-fatigue" class="smart-pill" style="display:none"></span>
        <span id="smart-pill-weather" class="smart-pill" style="display:none"></span>
        <span id="smart-pill-suggest" class="smart-pill" style="display:none;cursor:pointer" onclick="AMI_SMART_UI.openSuggestModal()"></span>
        <span id="smart-pill-auto"    class="smart-pill" style="display:none;cursor:pointer" onclick="AMI_SMART_UI.openAutoModeModal()"></span>
      </div>
    `;
    anchor.insertAdjacentHTML('afterend', html);

    /* Style commun pour les pills (injecté une seule fois) */
    if (!$('smart-pills-style')) {
      const style = document.createElement('style');
      style.id = 'smart-pills-style';
      style.textContent = `
        .smart-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 9px;
          border-radius: 12px;
          background: rgba(120,120,120,.10);
          border: 1px solid rgba(120,120,120,.20);
          color: var(--t);
          white-space: nowrap;
        }
        .smart-pill.smart-pill-end     { background: rgba(0,212,170,.10); border-color: rgba(0,212,170,.30); color: var(--a); }
        .smart-pill.smart-pill-late    { background: rgba(255,181,71,.12); border-color: rgba(255,181,71,.35); color: #ffb547; }
        .smart-pill.smart-pill-late-bad{ background: rgba(255,95,109,.15); border-color: rgba(255,95,109,.4);  color: #ff5f6d; }
        .smart-pill.smart-pill-fatigue { background: rgba(255,181,71,.12); border-color: rgba(255,181,71,.35); color: #ffb547; }
        .smart-pill.smart-pill-suggest { background: rgba(124,77,255,.10); border-color: rgba(124,77,255,.30); color: #a78bfa; }
        .smart-pill.smart-pill-auto-on { background: rgba(0,212,170,.15); border-color: rgba(0,212,170,.4);  color: var(--a); }
        .smart-pill.smart-pill-auto-off{ background: var(--s); border-color: var(--b); color: var(--m); }
      `;
      document.head.appendChild(style);
    }
  }

  /* ╔══════════════════════════════════════════════╗
     ║  MODALS                                        ║
     ╚══════════════════════════════════════════════╝ */

  function _injectModals() {
    if ($('smart-modal-root')) return;
    const root = document.createElement('div');
    root.id = 'smart-modal-root';
    root.innerHTML = `
      <!-- Modal : Configuration Mode Auto -->
      <div id="smart-automode-modal" class="smart-modal" style="display:none">
        <div class="smart-modal-bg" onclick="AMI_SMART_UI.closeAutoModeModal()"></div>
        <div class="smart-modal-card">
          <div class="smart-modal-head">
            <div style="font-weight:600;font-size:15px">🤖 Mode automatique</div>
            <button class="smart-modal-close" onclick="AMI_SMART_UI.closeAutoModeModal()">✕</button>
          </div>
          <div class="smart-modal-body">
            <div style="background:rgba(255,181,71,.08);border:1px solid rgba(255,181,71,.3);border-radius:8px;padding:10px;margin-bottom:14px;font-size:11px;line-height:1.5;color:var(--t)">
              ⚠️ <b>Responsabilité IDE</b> — AMI propose, vous décidez. Les soins vitaux (urgences, perfusions critiques, insuline) ne sont <b>jamais</b> replanifiés sans votre confirmation, même en mode auto activé.
            </div>

            <div class="smart-row">
              <label class="smart-toggle-label">
                <input type="checkbox" id="smart-cfg-enabled" onchange="AMI_SMART_UI._cfgChange()">
                <span>Activer le mode automatique</span>
              </label>
              <div class="smart-help">L'IA replanifie en arrière-plan, propose des pauses et anticipe les retards.</div>
            </div>

            <div class="smart-row">
              <label class="smart-toggle-label">
                <input type="checkbox" id="smart-cfg-voice" onchange="AMI_SMART_UI._cfgChange()">
                <span>Assistant vocal</span>
              </label>
              <div class="smart-help">L'IA peut te parler (annonces, alertes, propositions). Comprend "oui", "non", "prochain patient", "stop auto".</div>
            </div>

            <div class="smart-row">
              <label class="smart-toggle-label">
                <input type="checkbox" id="smart-cfg-navigation" onchange="AMI_SMART_UI._cfgChange()">
                <span>Annonce du prochain patient</span>
              </label>
              <div class="smart-help">Annonce vocale dès qu'un nouveau patient devient le prochain à visiter.</div>
            </div>

            <div class="smart-row">
              <div style="font-weight:600;font-size:12px;margin-bottom:6px">🛡️ Niveau de sécurité</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <label class="smart-radio">
                  <input type="radio" name="smart-cfg-safety" value="3" onchange="AMI_SMART_UI._cfgChange()">
                  <span>Ultra strict (recommandé)</span>
                </label>
                <label class="smart-radio">
                  <input type="radio" name="smart-cfg-safety" value="2" onchange="AMI_SMART_UI._cfgChange()">
                  <span>Sécurisé</span>
                </label>
                <label class="smart-radio">
                  <input type="radio" name="smart-cfg-safety" value="1" onchange="AMI_SMART_UI._cfgChange()">
                  <span>Libre</span>
                </label>
              </div>
              <div class="smart-help">
                <b>Ultra strict</b> : aucun soin priorité 3 (urgence, insuline, perfusion critique) n'est déplacé.<br>
                <b>Sécurisé</b> : seuls les déplacements à très faible risque sont automatiques.<br>
                <b>Libre</b> : l'IA peut tout réorganiser (à utiliser uniquement si vous validez chaque action).
              </div>
            </div>
          </div>
          <div class="smart-modal-foot">
            <button class="btn bs" onclick="AMI_SMART_UI.closeAutoModeModal()">Fermer</button>
            <button class="btn bp" onclick="AMI_SMART_UI._cfgApply()" id="smart-cfg-apply">✅ Appliquer</button>
          </div>
        </div>
      </div>

      <!-- Modal : Résultat Simulation -->
      <div id="smart-sim-modal" class="smart-modal" style="display:none">
        <div class="smart-modal-bg" onclick="AMI_SMART_UI.closeSimModal()"></div>
        <div class="smart-modal-card">
          <div class="smart-modal-head">
            <div style="font-weight:600;font-size:15px">🧪 Simulation de journée</div>
            <button class="smart-modal-close" onclick="AMI_SMART_UI.closeSimModal()">✕</button>
          </div>
          <div class="smart-modal-body" id="smart-sim-body">…</div>
          <div class="smart-modal-foot">
            <button class="btn bp" onclick="AMI_SMART_UI.closeSimModal()">Fermer</button>
          </div>
        </div>
      </div>

      <!-- Modal : Suggestion ajustement -->
      <div id="smart-suggest-modal" class="smart-modal" style="display:none">
        <div class="smart-modal-bg" onclick="AMI_SMART_UI.closeSuggestModal()"></div>
        <div class="smart-modal-card">
          <div class="smart-modal-head">
            <div style="font-weight:600;font-size:15px">💡 Suggestion d'ajustement</div>
            <button class="smart-modal-close" onclick="AMI_SMART_UI.closeSuggestModal()">✕</button>
          </div>
          <div class="smart-modal-body" id="smart-suggest-body">…</div>
          <div class="smart-modal-foot">
            <button class="btn bs" onclick="AMI_SMART_UI.rejectSuggestion()">❌ Rejeter</button>
            <button class="btn bp" onclick="AMI_SMART_UI.applySuggestion()">✅ Appliquer</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    /* Style modals (injecté une seule fois) */
    if (!$('smart-modal-style')) {
      const style = document.createElement('style');
      style.id = 'smart-modal-style';
      style.textContent = `
        .smart-modal {
          position: fixed; inset: 0; z-index: 9999;
          display: flex; align-items: center; justify-content: center;
          padding: 20px;
        }
        .smart-modal-bg {
          position: absolute; inset: 0;
          background: rgba(0,0,0,.55);
          backdrop-filter: blur(3px);
        }
        .smart-modal-card {
          position: relative;
          background: var(--bg, #1a1a1f);
          border: 1px solid var(--b);
          border-radius: 14px;
          max-width: 540px; width: 100%;
          max-height: 88vh;
          display: flex; flex-direction: column;
          box-shadow: 0 20px 60px rgba(0,0,0,.5);
        }
        .smart-modal-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 18px;
          border-bottom: 1px solid var(--b);
        }
        .smart-modal-close {
          background: none; border: none; color: var(--m);
          font-size: 18px; cursor: pointer; padding: 4px 8px;
        }
        .smart-modal-close:hover { color: var(--t); }
        .smart-modal-body {
          padding: 16px 18px;
          overflow-y: auto;
          flex: 1;
        }
        .smart-modal-foot {
          display: flex; gap: 8px; justify-content: flex-end;
          padding: 12px 18px;
          border-top: 1px solid var(--b);
        }
        .smart-row {
          padding: 10px 0;
          border-bottom: 1px dashed var(--b);
        }
        .smart-row:last-child { border-bottom: none; }
        .smart-toggle-label {
          display: flex; align-items: center; gap: 8px;
          font-size: 13px; font-weight: 500; cursor: pointer;
        }
        .smart-toggle-label input[type=checkbox] {
          width: 16px; height: 16px; cursor: pointer;
        }
        .smart-help {
          font-size: 11px; color: var(--m);
          margin-top: 6px; line-height: 1.5;
        }
        .smart-radio {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px; border: 1px solid var(--b); border-radius: 16px;
          font-size: 11px; cursor: pointer;
          background: var(--s);
        }
        .smart-radio input { margin: 0; }
        .smart-radio:has(input:checked) {
          background: rgba(0,212,170,.10);
          border-color: var(--a);
          color: var(--a);
        }
        .smart-sim-row {
          display: flex; justify-content: space-between;
          padding: 6px 0; font-size: 12px;
          border-bottom: 1px dashed var(--b);
        }
        .smart-sim-row:last-child { border-bottom: none; }
      `;
      document.head.appendChild(style);
    }
  }

  /* ╔══════════════════════════════════════════════╗
     ║  RENDER : pills HUD live                       ║
     ╚══════════════════════════════════════════════╝ */

  function _renderUberPills() {
    const wrap = $('smart-uber-pills');
    if (!wrap) return;
    const smart = SMART();
    if (!smart) return;
    const app = APP_();
    if (!app) return;

    const route = app.get('uberPatients') || [];
    const idx   = app.get('currentIndex') || 0;
    const hasRoute = route.length > 0;

    if (!hasRoute) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'flex';

    /* Pill : fin estimée */
    const pillEnd = $('smart-pill-end');
    try {
      const end = smart.predictEndOfTour(route, idx);
      if (Number.isFinite(end)) {
        pillEnd.className = 'smart-pill smart-pill-end';
        pillEnd.textContent = `🕒 Fin ≈ ${smart.formatTime(end)}`;
        pillEnd.style.display = 'inline-flex';
      } else {
        pillEnd.style.display = 'none';
      }
    } catch { pillEnd.style.display = 'none'; }

    /* Pill : retard détecté */
    const pillLate = $('smart-pill-late');
    try {
      const late = smart.checkProactiveDelay(route, idx);
      if (late.length === 0) {
        pillLate.style.display = 'none';
      } else {
        const worst = late.reduce((m, x) => (x.etaMin - x.planned) > (m.etaMin - m.planned) ? x : m, late[0]);
        const delay = Math.round(worst.etaMin - worst.planned);
        const target = route.find(p => p.id === worst.patientId);
        const cls = delay > 20 ? 'smart-pill-late-bad' : 'smart-pill-late';
        pillLate.className = 'smart-pill ' + cls;
        pillLate.textContent = `⚠️ +${delay} min · ${_patientName(target)}`;
        pillLate.style.display = 'inline-flex';
      }
    } catch { pillLate.style.display = 'none'; }

    /* Pill : fatigue */
    const pillFatigue = $('smart-pill-fatigue');
    try {
      const f = smart.fatigueScore();
      if (f >= 1.2) {
        pillFatigue.className = 'smart-pill smart-pill-fatigue';
        const lbl = f >= 1.6 ? 'Fatigue élevée' : 'Fatigue';
        pillFatigue.textContent = `🥱 ${lbl}`;
        pillFatigue.style.display = 'inline-flex';
      } else {
        pillFatigue.style.display = 'none';
      }
    } catch { pillFatigue.style.display = 'none'; }

    /* Pill : météo */
    const pillWeather = $('smart-pill-weather');
    const w = smart._weather;
    if (w) {
      let icon = '☀️', lbl = '';
      if (w.rain) { icon = '🌧️'; lbl = 'Pluie'; }
      else if (w.wind > 50) { icon = '💨'; lbl = 'Vent fort'; }
      else if (w.heat > 32) { icon = '🥵'; lbl = 'Chaleur'; }
      else if (w.heat < -2) { icon = '🥶'; lbl = 'Gel'; }
      if (lbl) {
        pillWeather.className = 'smart-pill';
        pillWeather.textContent = `${icon} ${lbl}`;
        pillWeather.style.display = 'inline-flex';
      } else {
        pillWeather.style.display = 'none';
      }
    } else {
      pillWeather.style.display = 'none';
    }

    /* Pill : suggestion */
    const pillSuggest = $('smart-pill-suggest');
    const suggested = app.get('suggestedRoute');
    const gain = app.get('suggestedRouteGain');
    if (suggested && gain >= 5) {
      pillSuggest.className = 'smart-pill smart-pill-suggest';
      pillSuggest.textContent = `💡 Suggestion : −${gain} min`;
      pillSuggest.style.display = 'inline-flex';
    } else {
      pillSuggest.style.display = 'none';
    }

    /* Pill : autopilote on/off */
    const pillAuto = $('smart-pill-auto');
    const cfg = smart.config?.autoMode;
    if (cfg) {
      const on = !!cfg.enabled;
      pillAuto.className = 'smart-pill ' + (on ? 'smart-pill-auto-on' : 'smart-pill-auto-off');
      pillAuto.textContent = on ? '🤖 Auto ON' : '🤖 Auto OFF';
      pillAuto.style.display = 'inline-flex';
    }

    /* Badge mode auto dans Pilotage */
    const badge = $('smart-automode-badge');
    if (badge && cfg) {
      const on = !!cfg.enabled;
      badge.textContent = on ? 'ON' : 'OFF';
      badge.style.background = on ? 'rgba(0,212,170,.15)' : 'rgba(120,120,120,.15)';
      badge.style.color      = on ? 'var(--a)' : 'var(--m)';
    }
  }

  /* ╔══════════════════════════════════════════════╗
     ║  ACTIONS UI (exposées via window)              ║
     ╚══════════════════════════════════════════════╝ */

  function toggleAdvanced() {
    const z = $('smart-advanced-zone');
    if (!z) return;
    const open = z.style.display === 'none';
    z.style.display = open ? 'block' : 'none';
    if (open) refreshLearningStats();
  }

  async function refreshLearningStats() {
    /* v5.10.5 — relance le scan ET met à jour l'affichage */
    const smart = SMART();
    if (smart && typeof smart.rescanLearning === 'function') {
      try {
        await smart.rescanLearning();
      } catch(_) {}
    }
    _renderLearningStats();
  }

  function _renderLearningStats() {
    const el = $('smart-learning-stats');
    if (!el) return;
    let html = '';
    try {
      const route   = JSON.parse(localStorage.getItem('ami_route_learning')   || '{}');
      const zones   = JSON.parse(localStorage.getItem('ami_zone_stats')       || '{}');
      const noShow  = JSON.parse(localStorage.getItem('ami_no_show_stats')    || '{}');
      const diff    = JSON.parse(localStorage.getItem('ami_patient_difficulty') || '{}');
      const types   = JSON.parse(localStorage.getItem('ami_patient_type_learning') || '{}');
      const ide     = JSON.parse(localStorage.getItem('ami_ide_learning')     || '{}');

      const noShowCount = Object.keys(noShow).reduce((s, k) => s + (noShow[k].shows || 0) + (noShow[k].noShows || 0), 0);
      const diffCount   = Object.keys(diff).reduce((s, k) => s + (diff[k].count || 0), 0);

      html = `
        <div>📍 <b>${Object.keys(zones).length}</b> zones cartographiées</div>
        <div>🛣️ <b>${Object.keys(route).length}</b> profils route appris (urbain / péri / rural)</div>
        <div>🏷️ <b>${Object.keys(types).length}</b> types de patient calibrés</div>
        <div>👥 <b>${Object.keys(noShow).length}</b> patients suivis · ${noShowCount} passages enregistrés</div>
        <div>⏱️ <b>${diffCount}</b> mesures de durée réelle utilisées</div>
        <div>👩‍⚕️ <b>${Object.keys(ide).length}</b> profil(s) IDE</div>
      `;
    } catch (e) {
      html = '<div style="color:var(--d)">Impossible de lire les stats</div>';
    }
    el.innerHTML = html;
  }

  function resetLearning() {
    if (!confirm('⚠️ Réinitialiser tout l\'apprentissage AMI ?\n\nLes statistiques zones, patients, types et IDE seront effacées. Cette action est irréversible.')) return;
    try {
      ['ami_route_learning', 'ami_zone_stats', 'ami_no_show_stats',
       'ami_patient_difficulty', 'ami_patient_type_learning', 'ami_ide_learning',
       'ami_conversation_memory'].forEach(k => localStorage.removeItem(k));
      _toast('🗑️ Apprentissage réinitialisé');
      refreshLearningStats();
    } catch (e) {
      _toast('❌ Erreur : ' + e.message);
    }
  }

  /* ── Mode Auto Modal ── */

  function openAutoModeModal() {
    const m = $('smart-automode-modal');
    if (!m) return;
    const smart = SMART();
    if (!smart) return;
    const cfg = smart.config.autoMode;

    $('smart-cfg-enabled').checked    = !!cfg.enabled;
    $('smart-cfg-voice').checked      = !!cfg.voice;
    $('smart-cfg-navigation').checked = !!cfg.navigation;
    document.querySelectorAll('input[name=smart-cfg-safety]').forEach(r => {
      r.checked = (parseInt(r.value, 10) === (cfg.safetyLevel || 3));
    });
    m.style.display = 'flex';
  }

  function closeAutoModeModal() {
    const m = $('smart-automode-modal');
    if (m) m.style.display = 'none';
  }

  function _cfgChange() {
    /* Note: aucun apply auto — on attend le bouton "Appliquer" pour respecter
       la responsabilité IDE (ne pas activer le mode auto par accident). */
  }

  function _cfgApply() {
    const smart = SMART();
    if (!smart) return;
    const enabled    = !!$('smart-cfg-enabled').checked;
    const voice      = !!$('smart-cfg-voice').checked;
    const navigation = !!$('smart-cfg-navigation').checked;
    const safetyEl   = document.querySelector('input[name=smart-cfg-safety]:checked');
    const safetyLevel = safetyEl ? parseInt(safetyEl.value, 10) : 3;

    if (enabled) {
      smart.enableAutoMode({ voice, navigation, safetyLevel });
      const lvl = safetyLevel === 3 ? 'Ultra strict' : (safetyLevel === 2 ? 'Sécurisé' : 'Libre');
      _toast(`🤖 Mode auto activé · ${lvl}`);
    } else {
      smart.disableAutoMode();
      _toast('⏸️ Mode auto désactivé');
    }
    closeAutoModeModal();
    _renderUberPills();
  }

  /* ── Simulation Modal ── */

  function runSimulation() {
    const smart = SMART();
    const app = APP_();
    if (!smart || !app) { _toast('AMI non disponible'); return; }

    /* Source : patients importés (avant départ) ou tournée live */
    let patients = app.get('uberPatients');
    if (!patients?.length) {
      patients = (app.importedData?.patients || app.importedData?.entries || []);
    }
    if (!patients?.length) {
      _toast('ℹ️ Importe des patients ou démarre la journée d\'abord');
      return;
    }

    const startMin = smart.nowMinutes();
    const sim = smart.simulateDay(patients, startMin);

    const body = $('smart-sim-body');
    if (!body) return;

    const endStr = smart.formatTime(sim.endTime);
    const totalH = Math.floor((sim.endTime - startMin) / 60);
    const totalM = Math.round((sim.endTime - startMin) % 60);
    const dur = `${totalH}h${String(totalM).padStart(2, '0')}`;

    const delayMin = Math.round(sim.totalDelay);
    const lateCount = sim.details.filter(d => d.delay > 10).length;

    let alerts = '';
    if (delayMin > 20) {
      alerts += `<div style="background:rgba(255,95,109,.10);border:1px solid rgba(255,95,109,.3);border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;color:#ff5f6d">⚠️ Risque de retard cumulé : <b>${delayMin} min</b> sur la journée${lateCount ? ` · ${lateCount} patient(s) potentiellement en retard` : ''}</div>`;
    } else if (delayMin > 0) {
      alerts += `<div style="background:rgba(255,181,71,.08);border:1px solid rgba(255,181,71,.3);border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;color:#ffb547">⚠️ Léger retard estimé : ${delayMin} min cumulés</div>`;
    } else {
      alerts += `<div style="background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.3);border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;color:var(--a)">✅ Journée fluide selon les estimations</div>`;
    }

    const detailRows = sim.details.slice(0, 12).map((d, i) => {
      const p = patients[i];
      const icon = d.delay > 10 ? '⚠️' : '·';
      const color = d.delay > 10 ? '#ffb547' : 'var(--m)';
      return `
        <div class="smart-sim-row">
          <span style="color:${color}">${icon} ${_esc(_patientName(p))}</span>
          <span style="color:${color}">${smart.formatTime(d.eta)}${d.delay > 0 ? ` <span style="font-size:10px">(+${Math.round(d.delay)})</span>` : ''}</span>
        </div>
      `;
    }).join('');

    body.innerHTML = `
      ${alerts}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div style="padding:12px;background:var(--s);border:1px solid var(--b);border-radius:8px;text-align:center">
          <div style="font-size:11px;color:var(--m);margin-bottom:4px">⏱️ Durée totale</div>
          <div style="font-size:18px;font-weight:600">${dur}</div>
        </div>
        <div style="padding:12px;background:var(--s);border:1px solid var(--b);border-radius:8px;text-align:center">
          <div style="font-size:11px;color:var(--m);margin-bottom:4px">🏁 Fin estimée</div>
          <div style="font-size:18px;font-weight:600;color:var(--a)">${endStr}</div>
        </div>
      </div>
      <div style="font-weight:600;font-size:12px;margin-bottom:8px">📋 Détail des passages${patients.length > 12 ? ` (12 premiers / ${patients.length})` : ''}</div>
      ${detailRows}
    `;
    $('smart-sim-modal').style.display = 'flex';
  }

  function closeSimModal() {
    const m = $('smart-sim-modal');
    if (m) m.style.display = 'none';
  }

  /* ── Suggestion Modal ── */

  function openSuggestModal() {
    const smart = SMART();
    const app = APP_();
    if (!smart || !app) return;

    /* Si pas encore de suggestion → en générer une */
    let suggested = app.get('suggestedRoute');
    let gain      = app.get('suggestedRouteGain');
    if (!suggested) {
      const route = app.get('uberPatients') || [];
      const idx   = app.get('currentIndex') || 0;
      const r = smart.suggestReplan(route, idx);
      suggested = r.route;
      gain = r.gain;
    }

    const body = $('smart-suggest-body');
    if (!body) return;

    const route = app.get('uberPatients') || [];
    const idx   = app.get('currentIndex') || 0;

    /* Comparaison avant/après — uniquement les patients déplacés */
    const moves = [];
    for (let i = idx + 1; i < Math.min(route.length, idx + 8); i++) {
      const before = route[i];
      const after  = suggested[i];
      if (before?.id !== after?.id) {
        moves.push({ pos: i - idx, before, after });
      }
    }

    let movesHtml = '';
    if (moves.length === 0) {
      movesHtml = '<div style="color:var(--m);font-size:12px">Aucun changement significatif détecté.</div>';
    } else {
      movesHtml = moves.slice(0, 5).map(m => `
        <div class="smart-sim-row">
          <span style="color:var(--m);font-size:11px">Position ${m.pos}</span>
          <span style="font-size:12px"><span style="color:var(--m);text-decoration:line-through">${_esc(_patientName(m.before))}</span> → <b style="color:var(--a)">${_esc(_patientName(m.after))}</b></span>
        </div>
      `).join('');
    }

    body.innerHTML = `
      <div style="background:rgba(124,77,255,.08);border:1px solid rgba(124,77,255,.3);border-radius:8px;padding:10px;margin-bottom:14px;font-size:12px;color:var(--t)">
        💡 Cette suggestion réorganise les patients à venir en tenant compte de la priorité médicale, de la difficulté et de la proximité GPS.
        <br><b>Gain estimé : ${gain || 0} min</b>
      </div>
      <div style="font-weight:600;font-size:12px;margin-bottom:8px">📋 Changements proposés</div>
      ${movesHtml}
      <div style="font-size:11px;color:var(--m);margin-top:14px;line-height:1.5">
        🛡️ Les soins critiques (urgences, perfusions, insuline) ne sont pas déplacés.
      </div>
    `;
    $('smart-suggest-modal').style.display = 'flex';
  }

  function closeSuggestModal() {
    const m = $('smart-suggest-modal');
    if (m) m.style.display = 'none';
  }

  function applySuggestion() {
    const smart = SMART();
    if (!smart) return;
    const ok = smart.applySuggestedRoute();
    closeSuggestModal();
    if (ok) {
      _toast('✅ Tournée ajustée');
      _renderUberPills();
    }
  }

  function rejectSuggestion() {
    const app = APP_();
    if (app) {
      app.set('suggestedRoute', null);
      app.set('suggestedRouteGain', null);
    }
    closeSuggestModal();
    _toast('❌ Suggestion rejetée');
    _renderUberPills();
  }

  /* ── Stratégie de départ ── */

  function suggestStartZone() {
    const smart = SMART();
    const app = APP_();
    if (!smart || !app) return;

    const patients = (app.importedData?.patients || app.importedData?.entries
                      || app.get('uberPatients') || []);
    if (!patients.length) {
      _toast('ℹ️ Importe d\'abord des patients');
      return;
    }

    const zone = smart.bestStartZone(patients);
    const el = $('smart-strategy-result');
    if (!zone?.length) {
      if (el) el.innerHTML = '<span style="color:var(--m)">Pas assez de données géolocalisées.</span>';
      return;
    }

    const first = zone[0];
    const name  = _patientName(first);
    if (el) {
      el.innerHTML = `
        <span style="color:var(--a)">🎯 Commence par le secteur de <b>${_esc(name)}</b></span>
        <span style="color:var(--m);display:block;margin-top:4px">Zone à <b>${zone.length}</b> patient(s) — densité optimale.</span>
      `;
    }
    if (smart.config.autoMode.voice) {
      smart.speakSafe(`Je te conseille de commencer par le secteur de ${name}`);
    }
  }

  /* ── Météo ── */

  async function refreshWeather() {
    const smart = SMART();
    const app = APP_();
    if (!smart || !app) return;
    const pos = app.get('userPos') || app.get('startPoint');
    if (!pos?.lat || !pos?.lng) {
      _toast('ℹ️ Place ton point de départ d\'abord');
      return;
    }
    _toast('🌦️ Récupération météo…');
    smart.config.weather.lastFetch = 0; // force refresh
    const w = await smart.fetchWeather(pos.lat, pos.lng);
    _renderWeatherCard();
    _renderUberPills();
    if (!w) _toast('⚠️ Météo indisponible');
    else    _toast('✅ Météo actualisée');
  }

  function _renderWeatherCard() {
    const smart = SMART();
    if (!smart) return;
    const w = smart._weather;
    const badge = $('smart-weather-badge');
    const detail = $('smart-weather-detail');
    if (!badge || !detail) return;

    if (!w) {
      badge.textContent = '—';
      badge.style.background = 'rgba(120,120,120,.15)';
      badge.style.color = 'var(--m)';
      detail.textContent = 'Adapte les durées de trajet selon la pluie, le vent, la chaleur.';
      return;
    }

    let icon = '☀️', state = 'Clair', factor = 1.0;
    if (w.rain) { icon = '🌧️'; state = 'Pluie'; factor = 1.20; }
    else if (w.wind > 50) { icon = '💨'; state = 'Vent fort'; factor = 1.10; }
    else if (w.heat > 32) { icon = '🥵'; state = 'Forte chaleur'; factor = 1.10; }
    else if (w.heat < -2) { icon = '🥶'; state = 'Gel'; factor = 1.10; }

    badge.textContent = `${icon} ${state}`;
    badge.style.background = factor > 1 ? 'rgba(255,181,71,.15)' : 'rgba(0,212,170,.10)';
    badge.style.color = factor > 1 ? '#ffb547' : 'var(--a)';

    const impact = factor > 1 ? `<b style="color:#ffb547">+${Math.round((factor - 1) * 100)}%</b> sur les temps de trajet` : 'Pas d\'impact significatif';
    detail.innerHTML = `${Math.round(w.heat)}°C · vent ${Math.round(w.wind)} km/h<br>${impact}`;
  }

  /* ╔══════════════════════════════════════════════╗
     ║  HOOKS & LIFECYCLE                             ║
     ╚══════════════════════════════════════════════╝ */

  let _refreshInterval = null;

  function _attachAppHooks() {
    const app = APP_();
    if (!app || typeof app.on !== 'function') return;
    /* throttle naturel via le store : on s'abonne aux changements clés */
    app.on('uberPatients',     () => _renderUberPills());
    app.on('userPos',          () => _renderUberPills());
    app.on('nextPatient',      () => _renderUberPills());
    app.on('predictedEnd',     () => _renderUberPills());
    app.on('suggestedRoute',   () => _renderUberPills());
  }

  function _startRefreshLoop() {
    if (_refreshInterval) return;
    _refreshInterval = setInterval(() => {
      try { _renderUberPills(); } catch(_) {}
    }, 15000);
  }

  function _stopRefreshLoop() {
    if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
  }

  function init() {
    _injectModals();

    /* Tentative immédiate ; les vues peuvent être créées dynamiquement */
    _injectPilotagePanel();
    _injectUberStatusPills();

    /* Re-tenter à la navigation tournée (lazy mount) */
    document.addEventListener('ui:navigate', e => {
      if (e.detail?.view === 'tur') {
        setTimeout(() => {
          _injectPilotagePanel();
          _injectUberStatusPills();
          _renderWeatherCard();
          _renderUberPills();
          _startRefreshLoop();
        }, 350);
      }
    });
    document.addEventListener('app:nav', e => {
      if (e.detail?.view === 'tur') {
        setTimeout(() => {
          _injectPilotagePanel();
          _injectUberStatusPills();
        }, 200);
      }
    });

    _attachAppHooks();
    _startRefreshLoop();
    _renderWeatherCard();
    _renderUberPills();
  }

  /* Exports publics */
  Object.assign(UI, {
    /* lifecycle */
    init,
    /* modals */
    openAutoModeModal, closeAutoModeModal, _cfgChange, _cfgApply,
    openSuggestModal,  closeSuggestModal,  applySuggestion, rejectSuggestion,
    closeSimModal,
    /* actions */
    runSimulation, suggestStartZone, refreshWeather,
    toggleAdvanced, refreshLearningStats, resetLearning,
    /* re-rendus utiles depuis l'extérieur */
    refreshPills: _renderUberPills,
    refreshWeatherCard: _renderWeatherCard,
  });

  /* Auto-init */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.info('[AMI_SMART_UI] v' + UI.version + ' chargé');
})();
