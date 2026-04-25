/* ════════════════════════════════════════════════
   incident.js — AMI NGAP — Plan incident RGPD/CNIL <72h
   ────────────────────────────────────────────────
   Côté infirmière :
   - Modal #incident-modal pour signaler un incident
   - Catégories : data_breach, unauthorized, data_loss, service_down, vulnerability
   - Sévérités : low, medium, high, critical
   - Soumission via /webhook/incident-report

   Côté admin :
   - Onglet "🚨 Incidents" dans le panneau admin
   - Liste avec compteur deadline 72h (rouge si <12h, ambre si <24h)
   - Action "Marquer comme notifié CNIL" avec champ N° d'enregistrement
   - Filtres statut + sévérité + recherche
   - Mise à jour via /webhook/incident-update
════════════════════════════════════════════════ */

(function checkDeps(){
  if (typeof wpost === 'undefined') console.error('incident.js : utils.js non chargé.');
})();

/* ════════════════════════════════════════════════
   PARTIE INFIRMIÈRE — Modal de signalement
════════════════════════════════════════════════ */

window.openIncidentModal = function() {
  const m = document.getElementById('incident-modal');
  if (!m) { console.warn('[Incident] modal absent du DOM'); return; }
  // Réinitialiser
  document.getElementById('inc-type').value     = 'unauthorized';
  document.getElementById('inc-severity').value = 'medium';
  document.getElementById('inc-summary').value  = '';
  document.getElementById('inc-impact').value   = '';
  document.getElementById('inc-affected').value = '0';
  document.getElementById('inc-details').value  = '';
  document.getElementById('inc-msg-ok').style.display  = 'none';
  document.getElementById('inc-msg-err').style.display = 'none';
  document.getElementById('inc-deadline').textContent  = '';
  m.classList.add('show');
  m.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.closeIncidentModal = function() {
  const m = document.getElementById('incident-modal');
  if (!m) return;
  m.classList.remove('show');
  m.style.display = 'none';
  document.body.style.overflow = '';
};

window.submitIncident = async function() {
  const okEl  = document.getElementById('inc-msg-ok');
  const errEl = document.getElementById('inc-msg-err');
  const btn   = document.getElementById('btn-inc-submit');
  okEl.style.display  = 'none';
  errEl.style.display = 'none';

  const type     = document.getElementById('inc-type').value;
  const severity = document.getElementById('inc-severity').value;
  const summary  = document.getElementById('inc-summary').value.trim();
  const impact   = document.getElementById('inc-impact').value.trim();
  const affected = parseInt(document.getElementById('inc-affected').value, 10) || 0;
  const detailsRaw = document.getElementById('inc-details').value.trim();

  if (!summary || summary.length < 10) {
    errEl.textContent = '❌ Le résumé doit contenir au moins 10 caractères.';
    errEl.style.display = 'block';
    return;
  }

  // Détails libres → object texte (le serveur chiffre AES-GCM)
  const details = detailsRaw ? { description_libre: detailsRaw } : {};

  btn.disabled = true;
  btn.innerHTML = '<span class="spin spinw" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></span> Envoi…';

  try {
    const res = await wpost('/webhook/incident-report', {
      type, severity, summary, impact, affected, details,
    });
    if (res?.ok) {
      const deadlineDate = res.deadline_at ? new Date(res.deadline_at) : null;
      const deadlineFmt = deadlineDate
        ? deadlineDate.toLocaleString('fr-FR', { dateStyle:'medium', timeStyle:'short' })
        : '—';
      okEl.innerHTML = `✅ <strong>Incident enregistré</strong><br>
        ID : <code style="font-family:var(--fm);font-size:11px">${res.incident_id || '—'}</code><br>
        ${(severity === 'critical' || severity === 'high')
          ? `🚨 <strong>Sévérité ${severity.toUpperCase()}</strong> — l'administration a été notifiée. Notification CNIL à effectuer avant le <strong>${deadlineFmt}</strong>.`
          : `Surveillance activée. Aucune action urgente requise.`}`;
      okEl.style.display = 'block';
      // Fermer après 5s pour laisser lire
      setTimeout(() => closeIncidentModal(), 5000);
    } else {
      errEl.textContent = '❌ ' + (res?.error || 'Échec de l\'enregistrement.');
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = '❌ Erreur réseau : ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🚨</span> Envoyer le signalement';
  }
};

/* ════════════════════════════════════════════════
   PARTIE ADMIN — Tableau de bord incidents
════════════════════════════════════════════════ */

let _ADM_INC_FILTER_STATUS   = 'open';
let _ADM_INC_FILTER_SEVERITY = '';

window.loadAdmIncidents = async function() {
  const root = document.getElementById('adm-incidents');
  if (!root) return;
  root.innerHTML = '<div class="empty" style="padding:24px 0"><div class="ei"><div class="spin spinw" style="width:28px;height:28px"></div></div><p style="margin-top:10px">Chargement des incidents...</p></div>';

  try {
    const body = { limit: 200 };
    if (_ADM_INC_FILTER_STATUS)   body.status_filter   = _ADM_INC_FILTER_STATUS;
    if (_ADM_INC_FILTER_SEVERITY) body.severity_filter = _ADM_INC_FILTER_SEVERITY;
    const d = await wpost('/webhook/incident-list', body);
    if (!d?.ok) {
      root.innerHTML = `<div class="msg e" style="display:block">❌ ${d?.error || 'Échec du chargement'}</div>`;
      return;
    }
    _renderIncidentList(d.incidents || [], d.stats || {});
  } catch (e) {
    root.innerHTML = `<div class="msg e" style="display:block">❌ Erreur réseau : ${e.message}</div>`;
  }
};

function _renderIncidentList(incidents, stats) {
  const root = document.getElementById('adm-incidents');
  if (!root) return;

  // Bandeau stats
  const statsHtml = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:16px">
      ${_statBox('Total',         stats.total       || 0, 'var(--m)')}
      ${_statBox('🔴 Ouverts',    stats.open        || 0, '#ef4444')}
      ${_statBox('🚨 Critiques',  stats.critical    || 0, '#dc2626')}
      ${_statBox('🟠 High',       stats.high        || 0, '#f59e0b')}
      ${_statBox('⏰ Hors délai', stats.overdue_72h || 0, '#dc2626')}
      ${_statBox('📨 Notifiés',   stats.notified    || 0, '#10b981')}
      ${_statBox('✅ Résolus',    stats.resolved    || 0, 'var(--a)')}
    </div>
  `;

  if (!incidents.length) {
    root.innerHTML = statsHtml + `
      <div class="empty" style="padding:32px 0">
        <div class="ei">🛡️</div>
        <p style="margin-top:10px;color:var(--m)">Aucun incident ${_ADM_INC_FILTER_STATUS ? `avec le statut "${_ADM_INC_FILTER_STATUS}"` : ''}.</p>
      </div>`;
    return;
  }

  // Trier : overdue d'abord, puis critical, puis par date desc
  const sorted = [...incidents].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (a.severity !== b.severity) return (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9);
    return new Date(b.detected_at) - new Date(a.detected_at);
  });

  const list = sorted.map(_renderIncidentCard).join('');
  root.innerHTML = statsHtml + list;
}

function _statBox(label, value, color) {
  return `<div style="background:var(--c);border:1px solid var(--b);border-radius:8px;padding:8px 10px;text-align:center">
    <div style="font-size:18px;font-weight:700;color:${color};font-family:var(--fm)">${value}</div>
    <div style="font-size:10px;color:var(--m);margin-top:2px">${label}</div>
  </div>`;
}

function _renderIncidentCard(inc) {
  // Couleur sévérité
  const SEV_COLOR = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
  const SEV_LABEL = { critical: '🚨 CRITICAL', high: '🟠 HIGH', medium: '🔵 MEDIUM', low: '⚪ LOW' };
  const STATUS_LABEL = {
    open: '🔴 Ouvert', investigating: '🔍 En enquête',
    resolved: '✅ Résolu', notified: '📨 CNIL notifiée', dismissed: '⚫ Rejeté',
  };
  const TYPE_LABEL = {
    data_breach: '💥 Fuite de données', unauthorized: '🔓 Accès non autorisé',
    data_loss: '🗑️ Perte de données', service_down: '⛔ Service indisponible',
    vulnerability: '🔍 Vulnérabilité', unknown: '❓ Indéterminé',
  };

  const sevColor = SEV_COLOR[inc.severity] || '#6b7280';
  const statusOk = inc.status === 'open' || inc.status === 'investigating';

  // Compteur deadline 72h
  let deadlineHtml = '';
  if (statusOk && inc.hours_remaining !== null && inc.hours_remaining !== undefined) {
    const h = inc.hours_remaining;
    let bg = 'rgba(16,185,129,.1)', border = 'rgba(16,185,129,.3)', col = '#10b981', icon = '⏱️';
    if (inc.overdue) {
      bg = 'rgba(220,38,38,.15)'; border = '#dc2626'; col = '#fff'; icon = '⛔';
    } else if (h < 12) {
      bg = 'rgba(220,38,38,.12)'; border = '#dc2626'; col = '#dc2626'; icon = '🚨';
    } else if (h < 24) {
      bg = 'rgba(245,158,11,.12)'; border = '#f59e0b'; col = '#f59e0b'; icon = '⚠️';
    }
    const label = inc.overdue ? `HORS DÉLAI (+${Math.abs(h)}h)` : `${h}h restantes`;
    deadlineHtml = `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:6px 10px;margin-top:8px;display:inline-flex;align-items:center;gap:6px;font-family:var(--fm);font-size:12px;font-weight:600;color:${col}">
      ${icon} CNIL : <strong>${label}</strong>
    </div>`;
  } else if (inc.notified_at) {
    deadlineHtml = `<div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.25);border-radius:6px;padding:6px 10px;margin-top:8px;display:inline-flex;align-items:center;gap:6px;font-family:var(--fm);font-size:11px;color:#10b981">
      📨 Notifié le ${new Date(inc.notified_at).toLocaleString('fr-FR', { dateStyle:'short', timeStyle:'short' })}
    </div>`;
  }

  // Détails déchiffrés
  const detailsHtml = inc.details && Object.keys(inc.details).length
    ? `<details style="margin-top:8px">
        <summary style="font-size:11px;color:var(--m);cursor:pointer;font-family:var(--fm)">📋 Détails (déchiffrés)</summary>
        <pre style="background:var(--s);border:1px solid var(--b);border-radius:6px;padding:10px;margin-top:6px;font-size:10px;overflow:auto;max-height:200px;color:var(--t)">${_escapeHtml(JSON.stringify(inc.details, null, 2))}</pre>
       </details>`
    : '';

  // Actions disponibles selon statut
  const actionsHtml = statusOk
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        ${inc.status === 'open' ? `<button onclick="incUpdate('${inc.id}','investigating')" class="btn bs bsm" style="font-size:11px;padding:6px 12px">🔍 En enquête</button>` : ''}
        <button onclick="incOpenNotifyModal('${inc.id}','${_escapeHtml(inc.summary).replace(/'/g, '&#39;')}')" class="btn bp bsm" style="font-size:11px;padding:6px 12px;background:linear-gradient(135deg,#3b82f6,#2563eb)">📨 Notifier CNIL</button>
        <button onclick="incOpenResolveModal('${inc.id}')" class="btn bv bsm" style="font-size:11px;padding:6px 12px;background:linear-gradient(135deg,#10b981,#059669)">✅ Résoudre</button>
        <button onclick="incUpdate('${inc.id}','dismissed')" class="btn bs bsm" style="font-size:11px;padding:6px 12px">⚫ Rejeter</button>
       </div>`
    : '';

  // Resolution affichée si présente
  const resolutionHtml = inc.resolution
    ? `<div style="background:rgba(16,185,129,.05);border-left:3px solid #10b981;padding:8px 10px;margin-top:8px;border-radius:0 6px 6px 0;font-size:12px;color:var(--t)">
        <strong style="color:#10b981">Résolution :</strong> ${_escapeHtml(inc.resolution)}
      </div>`
    : '';

  return `<div style="background:var(--c);border:1px solid var(--b);border-left:4px solid ${sevColor};border-radius:10px;padding:14px 16px;margin-bottom:10px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <div style="flex:1;min-width:200px">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
          <span style="background:${sevColor}20;color:${sevColor};border:1px solid ${sevColor}40;font-size:10px;font-family:var(--fm);font-weight:700;padding:2px 8px;border-radius:20px">${SEV_LABEL[inc.severity] || inc.severity}</span>
          <span style="font-size:10px;color:var(--m);font-family:var(--fm)">${TYPE_LABEL[inc.incident_type] || inc.incident_type}</span>
          <span style="font-size:10px;color:var(--m);font-family:var(--fm)">${STATUS_LABEL[inc.status] || inc.status}</span>
        </div>
        <div style="font-size:14px;font-weight:600;color:var(--t);line-height:1.4;overflow-wrap:anywhere">${_escapeHtml(inc.summary)}</div>
        ${inc.impact_estimate ? `<div style="font-size:12px;color:var(--m);margin-top:4px">💥 ${_escapeHtml(inc.impact_estimate)}</div>` : ''}
      </div>
      <div style="text-align:right;flex-shrink:0;font-family:var(--fm);font-size:10px;color:var(--m)">
        <div>📅 ${new Date(inc.detected_at).toLocaleString('fr-FR', { dateStyle:'short', timeStyle:'short' })}</div>
        ${inc.affected_count > 0 ? `<div style="margin-top:2px;color:#f59e0b">👥 ${inc.affected_count} personnes</div>` : ''}
      </div>
    </div>
    ${deadlineHtml}
    ${resolutionHtml}
    ${detailsHtml}
    ${actionsHtml}
  </div>`;
}

function _escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ════════════════════════════════════════════════
   ACTIONS ADMIN — Update statut
════════════════════════════════════════════════ */

window.incUpdate = async function(incidentId, status) {
  if (!incidentId || !status) return;
  if (!confirm(`Confirmer le passage au statut "${status}" ?`)) return;
  try {
    const res = await wpost('/webhook/incident-update', { incident_id: incidentId, status });
    if (res?.ok) {
      if (typeof showToast === 'function') showToast('✅ Statut mis à jour');
      loadAdmIncidents();
    } else {
      alert('❌ ' + (res?.error || 'Échec mise à jour'));
    }
  } catch (e) { alert('❌ Erreur : ' + e.message); }
};

/* ── Modal "Notifier CNIL" ──────────────────────────────── */

window.incOpenNotifyModal = function(incidentId, summary) {
  const m = document.getElementById('inc-notify-modal');
  if (!m) return;
  document.getElementById('inc-notify-id').value = incidentId;
  document.getElementById('inc-notify-summary').textContent = summary || '';
  document.getElementById('inc-notify-num').value = '';
  document.getElementById('inc-notify-comment').value = '';
  document.getElementById('inc-notify-err').style.display = 'none';
  m.classList.add('show');
  m.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.incCloseNotifyModal = function() {
  const m = document.getElementById('inc-notify-modal');
  if (!m) return;
  m.classList.remove('show');
  m.style.display = 'none';
  document.body.style.overflow = '';
};

window.incSubmitNotify = async function() {
  const incidentId = document.getElementById('inc-notify-id').value;
  const numCnil    = document.getElementById('inc-notify-num').value.trim();
  const comment    = document.getElementById('inc-notify-comment').value.trim();
  const errEl      = document.getElementById('inc-notify-err');
  errEl.style.display = 'none';

  if (!numCnil) {
    errEl.textContent = '❌ Le numéro d\'enregistrement CNIL est obligatoire.';
    errEl.style.display = 'block';
    return;
  }
  // Construire la résolution avec le numéro CNIL en tête (traçabilité)
  const resolution = `[CNIL #${numCnil}] ${comment || 'Notification CNIL effectuée'}`;
  try {
    const res = await wpost('/webhook/incident-update', {
      incident_id: incidentId,
      status: 'notified',
      notified: true,
      resolution,
    });
    if (res?.ok) {
      if (typeof showToast === 'function') showToast('📨 Incident marqué comme notifié CNIL');
      incCloseNotifyModal();
      loadAdmIncidents();
    } else {
      errEl.textContent = '❌ ' + (res?.error || 'Échec mise à jour');
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = '❌ Erreur : ' + e.message;
    errEl.style.display = 'block';
  }
};

/* ── Modal "Résoudre" ──────────────────────────────────── */

window.incOpenResolveModal = function(incidentId) {
  const m = document.getElementById('inc-resolve-modal');
  if (!m) return;
  document.getElementById('inc-resolve-id').value = incidentId;
  document.getElementById('inc-resolve-text').value = '';
  document.getElementById('inc-resolve-err').style.display = 'none';
  m.classList.add('show');
  m.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.incCloseResolveModal = function() {
  const m = document.getElementById('inc-resolve-modal');
  if (!m) return;
  m.classList.remove('show');
  m.style.display = 'none';
  document.body.style.overflow = '';
};

window.incSubmitResolve = async function() {
  const incidentId = document.getElementById('inc-resolve-id').value;
  const text       = document.getElementById('inc-resolve-text').value.trim();
  const errEl      = document.getElementById('inc-resolve-err');
  errEl.style.display = 'none';

  if (!text || text.length < 10) {
    errEl.textContent = '❌ La résolution doit contenir au moins 10 caractères.';
    errEl.style.display = 'block';
    return;
  }
  try {
    const res = await wpost('/webhook/incident-update', {
      incident_id: incidentId,
      status: 'resolved',
      resolution: text,
    });
    if (res?.ok) {
      if (typeof showToast === 'function') showToast('✅ Incident résolu');
      incCloseResolveModal();
      loadAdmIncidents();
    } else {
      errEl.textContent = '❌ ' + (res?.error || 'Échec mise à jour');
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = '❌ Erreur : ' + e.message;
    errEl.style.display = 'block';
  }
};

/* ════════════════════════════════════════════════
   FILTRES — appelés depuis les selects HTML
════════════════════════════════════════════════ */

window.incFilterStatus = function(value) {
  _ADM_INC_FILTER_STATUS = value || '';
  loadAdmIncidents();
};
window.incFilterSeverity = function(value) {
  _ADM_INC_FILTER_SEVERITY = value || '';
  loadAdmIncidents();
};

/* ════════════════════════════════════════════════
   AUTO-REFRESH compteur deadline (toutes les 60s)
   N'agit que si la vue admin incidents est active
════════════════════════════════════════════════ */

setInterval(() => {
  // Détection : onglet incidents actif ET au moins une carte affichée
  const section = document.querySelector('.adm-tab-section[data-tab="incidents"]');
  if (!section || section.style.display === 'none') return;
  if (!document.getElementById('adm-incidents')?.children?.length) return;
  loadAdmIncidents();
}, 60000);
