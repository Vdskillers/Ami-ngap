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
let _ADM_INC_CACHE           = []; // ⚡ Cache des incidents chargés pour récupération par ID

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

  // ⚡ Mettre à jour le cache pour les actions Export PDF / Template CNIL
  _ADM_INC_CACHE = Array.isArray(incidents) ? [...incidents] : [];

  // Mise à jour du badge admin (nb incidents ouverts)
  const badge = document.getElementById('adm-inc-badge');
  if (badge) {
    const openCount = (stats?.open || 0) + (stats?.overdue_72h || 0);
    if (openCount > 0) {
      badge.textContent = openCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

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
        ${(inc.severity === 'critical' || inc.severity === 'high') ? `<button onclick="incOpenAffectedModal('${inc.id}','${_escapeHtml(inc.summary).replace(/'/g, '&#39;')}', ${inc.affected_count || 0})" class="btn bs bsm" style="font-size:11px;padding:6px 12px">📧 Notifier personnes</button>` : ''}
        <button onclick="incExportPDF('${inc.id}')" class="btn bs bsm" style="font-size:11px;padding:6px 12px">📄 Export PDF</button>
        <button onclick="incUpdate('${inc.id}','dismissed')" class="btn bs bsm" style="font-size:11px;padding:6px 12px">⚫ Rejeter</button>
       </div>`
    : `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button onclick="incExportPDF('${inc.id}')" class="btn bs bsm" style="font-size:11px;padding:6px 12px">📄 Export PDF</button>
       </div>`;

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

/* ════════════════════════════════════════════════
   PRÉ-REMPLISSAGE NOTIFICATION CNIL
   Génère un texte prêt à coller dans le téléservice
   https://notifications.cnil.fr/notifications/index
════════════════════════════════════════════════ */

const _CNIL_TYPE_LABELS = {
  data_breach:   'Violation de confidentialité (fuite de données)',
  unauthorized:  'Accès non autorisé',
  data_loss:     'Perte d\'intégrité ou de disponibilité (perte de données)',
  service_down:  'Perte de disponibilité (indisponibilité du service)',
  vulnerability: 'Vulnérabilité technique identifiée',
  unknown:       'Indéterminé',
};

const _CNIL_SEVERITY_LABELS = {
  low:      'Faible',
  medium:   'Modérée',
  high:     'Élevée',
  critical: 'Très élevée',
};

window.incGenerateCnilTemplate = function() {
  const id = document.getElementById('inc-notify-id').value;
  const inc = _ADM_INC_CACHE.find(i => i.id === id);
  const ta  = document.getElementById('inc-notify-template');
  if (!inc || !ta) {
    if (ta) ta.value = '⚠️ Incident introuvable dans le cache. Rechargez la liste des incidents.';
    return;
  }
  const detected = new Date(inc.detected_at);
  const deadline = inc.deadline_at ? new Date(inc.deadline_at) : null;
  const fmtDate  = d => d ? d.toLocaleString('fr-FR', { dateStyle:'long', timeStyle:'short' }) : '—';

  const detailsTxt = inc.details && Object.keys(inc.details).length
    ? Object.entries(inc.details)
        .filter(([k]) => !['_decrypt_error'].includes(k))
        .map(([k,v]) => `  • ${k} : ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join('\n')
    : '  (aucun détail technique additionnel)';

  const tpl = `==============================================================
  PRÉ-REMPLISSAGE — NOTIFICATION CNIL (RGPD art. 33)
  À soumettre via : https://notifications.cnil.fr/notifications/index
==============================================================

[1] RESPONSABLE DE TRAITEMENT
- Nom du responsable : AMI — Assistant Médical Infirmier
- Représentant / DPO : (à renseigner — votre nom / email DPO)
- Coordonnées : (à renseigner)

[2] DESCRIPTION DE LA VIOLATION
- Identifiant interne : ${inc.id || 'N/A'}
- Catégorie : ${_CNIL_TYPE_LABELS[inc.incident_type] || inc.incident_type}
- Sévérité estimée : ${_CNIL_SEVERITY_LABELS[inc.severity] || inc.severity}
- Date et heure de prise de connaissance : ${fmtDate(detected)}
- Échéance légale (72h) : ${fmtDate(deadline)}
- Statut actuel : ${inc.status}

[3] NATURE DE LA VIOLATION
${inc.summary || '(à compléter manuellement)'}

[4] CATÉGORIES DE PERSONNES CONCERNÉES
- Patients suivis par les infirmières utilisatrices d'AMI
- ${(inc.affected_count || 0)} personne(s) potentiellement concernée(s)

[5] CATÉGORIES DE DONNÉES CONCERNÉES
☐ Données d'identification (nom, prénom, date de naissance)
☐ Coordonnées (adresse, téléphone, email)
☐ Numéro de sécurité sociale
☐ Données de santé (art. 9 RGPD) ← cocher si applicable
☐ Données de cotation NGAP / facturation
☐ Identifiants techniques (logs, IP)
☐ Autres : __________

[6] CONSÉQUENCES PROBABLES
${inc.impact_estimate || '(à compléter — risque identifié pour les personnes concernées)'}

[7] MESURES PRISES OU ENVISAGÉES
- Mesures techniques : (à compléter — blocage IP, rotation secrets, snapshot logs, etc.)
- Mesures organisationnelles : (à compléter — communication aux utilisateurs, formation, etc.)
- Mesures de remédiation : (à compléter)

[8] DÉTAILS TECHNIQUES (déchiffrés depuis incident_log)
${detailsTxt}

[9] NOTIFICATION AUX PERSONNES CONCERNÉES (art. 34 RGPD)
☐ Effectuée
☐ Non effectuée — justification : __________
☐ Non requise (risque non élevé)

==============================================================
  Texte généré automatiquement le ${new Date().toLocaleString('fr-FR')}
  par AMI — Assistant Médical Infirmier
==============================================================`;
  ta.value = tpl;
  if (typeof showToast === 'function') showToast('📋 Pré-remplissage généré — pensez à compléter les champs marqués (à compléter)');
};

window.incCopyCnilTemplate = function() {
  const ta = document.getElementById('inc-notify-template');
  if (!ta || !ta.value) {
    if (typeof showToast === 'function') showToast('⚠️ Générez d\'abord le pré-remplissage', 'warn');
    return;
  }
  ta.select();
  const fallback = () => {
    try { document.execCommand('copy'); if (typeof showToast === 'function') showToast('✅ Texte copié'); }
    catch { if (typeof showToast === 'function') showToast('⚠️ Copie impossible — sélectionnez manuellement', 'warn'); }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(ta.value)
      .then(() => { if (typeof showToast === 'function') showToast('✅ Texte copié dans le presse-papier'); })
      .catch(fallback);
  } else { fallback(); }
};

/* ════════════════════════════════════════════════
   EXPORT PDF DU RAPPORT D'INCIDENT
   Utilise window.print() comme le reste du projet
════════════════════════════════════════════════ */

window.incExportPDF = function(incidentId) {
  const inc = _ADM_INC_CACHE.find(i => i.id === incidentId);
  if (!inc) {
    if (typeof showToast === 'function') showToast('⚠️ Incident introuvable — rechargez la liste', 'warn');
    return;
  }
  const w = window.open('', '_blank');
  if (!w) {
    alert('❌ Bloqueur de fenêtres détecté. Autorisez les pop-ups pour exporter le rapport.');
    return;
  }
  const detected = new Date(inc.detected_at);
  const deadline = inc.deadline_at ? new Date(inc.deadline_at) : null;
  const notified = inc.notified_at ? new Date(inc.notified_at) : null;
  const resolved = inc.resolved_at ? new Date(inc.resolved_at) : null;
  const fmtDate  = d => d ? d.toLocaleString('fr-FR', { dateStyle:'long', timeStyle:'short' }) : '—';

  const detailsRows = inc.details && Object.keys(inc.details).length
    ? Object.entries(inc.details)
        .filter(([k]) => !['_decrypt_error'].includes(k))
        .map(([k,v]) => `<tr><td style="padding:4px 8px;border:1px solid #999;font-family:monospace;font-size:11px">${_escapeHtml(k)}</td><td style="padding:4px 8px;border:1px solid #999;font-family:monospace;font-size:11px;word-break:break-all">${_escapeHtml(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v))}</td></tr>`)
        .join('')
    : '<tr><td colspan="2" style="padding:8px;text-align:center;color:#666">Aucun détail technique enregistré.</td></tr>';

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Rapport d'incident ${inc.id || ''}</title>
<style>
  @page { size:A4; margin:18mm 16mm }
  body { font-family:-apple-system,Segoe UI,Roboto,sans-serif; color:#111; line-height:1.5; max-width:780px; margin:0 auto; padding:0 16px }
  h1 { font-size:22px; margin:0 0 4px; border-bottom:3px solid #dc2626; padding-bottom:8px }
  h2 { font-size:14px; margin:18px 0 8px; padding-bottom:4px; border-bottom:1px solid #ccc; color:#444 }
  .badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:11px; font-weight:700; margin-right:6px }
  .b-crit { background:#dc2626; color:#fff } .b-high { background:#f59e0b; color:#fff }
  .b-med { background:#3b82f6; color:#fff } .b-low { background:#6b7280; color:#fff }
  .b-open { background:#dc2626; color:#fff } .b-inv { background:#f59e0b; color:#fff }
  .b-not { background:#3b82f6; color:#fff } .b-res { background:#10b981; color:#fff } .b-dis { background:#6b7280; color:#fff }
  .b-overdue { background:#7c2d12; color:#fff }
  table { width:100%; border-collapse:collapse; margin-bottom:8px }
  td { vertical-align:top }
  .meta td { padding:4px 8px; border-bottom:1px solid #eee; font-size:12px }
  .meta td:first-child { width:32%; color:#666; font-weight:600 }
  .footer { margin-top:30px; padding-top:10px; border-top:1px solid #ccc; font-size:10px; color:#777; text-align:center }
  .section { padding:10px 12px; background:#f9f9f9; border-left:3px solid #dc2626; margin-bottom:10px; border-radius:0 4px 4px 0 }
  .summary { font-size:14px; font-weight:600; padding:10px; background:#fff5f5; border:1px solid #fecaca; border-radius:6px; margin-bottom:14px }
  .legal { background:#f0f9ff; border:1px solid #bfdbfe; padding:10px 12px; border-radius:6px; font-size:11px; margin-top:14px }
  @media print { .no-print { display:none } body { padding:0 } }
</style></head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
    <div>
      <h1>🚨 Rapport d'incident de sécurité</h1>
      <div style="font-size:11px;color:#666;font-family:monospace">ID : ${inc.id || '—'}</div>
    </div>
    <div style="text-align:right;font-size:10px;color:#999">
      AMI — Assistant Médical Infirmier<br>
      Document confidentiel — Conformité RGPD art. 33-34<br>
      Conservation 5 ans (recommandation CNIL)
    </div>
  </div>

  <div style="margin:14px 0">
    <span class="badge b-${(inc.severity||'low').slice(0,4)}">${(inc.severity||'').toUpperCase()}</span>
    <span class="badge b-${inc.status === 'open' ? 'open' : inc.status === 'investigating' ? 'inv' : inc.status === 'notified' ? 'not' : inc.status === 'resolved' ? 'res' : 'dis'}">${(inc.status||'').toUpperCase()}</span>
    ${inc.overdue ? `<span class="badge b-overdue">⛔ HORS DÉLAI 72h</span>` : ''}
  </div>

  <div class="summary">${_escapeHtml(inc.summary || '')}</div>

  <h2>📋 Métadonnées</h2>
  <table class="meta">
    <tr><td>Catégorie</td><td>${_CNIL_TYPE_LABELS[inc.incident_type] || inc.incident_type}</td></tr>
    <tr><td>Sévérité</td><td>${_CNIL_SEVERITY_LABELS[inc.severity] || inc.severity}</td></tr>
    <tr><td>Date de détection</td><td>${fmtDate(detected)}</td></tr>
    <tr><td>Échéance CNIL (72h)</td><td>${fmtDate(deadline)}${inc.overdue ? ' <strong style="color:#dc2626">— DÉPASSÉE</strong>' : ''}</td></tr>
    <tr><td>Personnes concernées</td><td>${inc.affected_count || 0}</td></tr>
    <tr><td>Impact estimé</td><td>${_escapeHtml(inc.impact_estimate || '—')}</td></tr>
    <tr><td>Notifié à la CNIL</td><td>${notified ? `✅ ${fmtDate(notified)}` : '❌ Non'}</td></tr>
    <tr><td>Résolu</td><td>${resolved ? `✅ ${fmtDate(resolved)}` : '❌ Non'}</td></tr>
  </table>

  <h2>📝 Détails techniques (déchiffrés)</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #999">
    <thead><tr style="background:#eee"><th style="padding:6px 8px;border:1px solid #999;text-align:left;font-size:11px">Champ</th><th style="padding:6px 8px;border:1px solid #999;text-align:left;font-size:11px">Valeur</th></tr></thead>
    <tbody>${detailsRows}</tbody>
  </table>

  ${inc.resolution ? `<h2>✅ Résolution</h2><div class="section" style="border-left-color:#10b981;background:#f0fdf4">${_escapeHtml(inc.resolution)}</div>` : ''}

  <div class="legal">
    <strong>Cadre légal :</strong> Le présent rapport constitue une trace écrite de la prise de connaissance et du traitement
    de l'incident, conformément aux articles 33 (notification CNIL sous 72h) et 34 (notification aux personnes concernées en cas
    de risque élevé) du Règlement Général sur la Protection des Données (UE 2016/679).
  </div>

  <div class="footer">
    Rapport généré automatiquement le ${new Date().toLocaleString('fr-FR')}<br>
    AMI — Assistant Médical Infirmier · Plan de réponse aux incidents v1.0
  </div>

  <button class="no-print" onclick="window.print()" style="position:fixed;bottom:20px;right:20px;padding:12px 20px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.2)">🖨️ Imprimer / Enregistrer en PDF</button>

  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 600));<\/script>
</body></html>`;
  w.document.write(html);
  w.document.close();
};

/* ════════════════════════════════════════════════
   NOTIFICATION AUX PERSONNES CONCERNÉES (art. 34 RGPD)
   Modal qui génère un courrier/email type prêt à envoyer
════════════════════════════════════════════════ */

window.incOpenAffectedModal = function(incidentId, summary, affectedCount) {
  const inc = _ADM_INC_CACHE.find(i => i.id === incidentId);
  if (!inc) {
    if (typeof showToast === 'function') showToast('⚠️ Incident introuvable', 'warn');
    return;
  }

  // Création dynamique de la modale si elle n'existe pas
  let m = document.getElementById('inc-affected-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'inc-affected-modal';
    m.style.cssText = 'position:fixed;inset:0;z-index:520;display:none;align-items:center;justify-content:center;background:rgba(11,15,20,.85);backdrop-filter:blur(8px);padding:20px';
    m.innerHTML = `
      <div class="mc" style="max-width:620px">
        <div class="mh">
          <div class="mt" style="color:#f59e0b">📧 Notification aux personnes concernées (art. 34 RGPD)</div>
          <button class="mx" onclick="incCloseAffectedModal()">✕</button>
        </div>
        <div class="adm-notice" style="background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.25);margin-bottom:14px">
          <span style="font-size:18px;flex-shrink:0">⚠️</span>
          <p style="font-size:12px">
            <strong>Obligation légale (RGPD art. 34) :</strong> Si la violation présente un <em>risque élevé</em> pour les droits et libertés
            des personnes concernées (données de santé, données financières, mots de passe en clair...), elles doivent être informées
            <strong>sans délai injustifié</strong>. Ce modèle est généré automatiquement, à <strong>relire et adapter</strong> avant envoi.
          </p>
        </div>
        <div style="margin-bottom:10px;font-size:12px;color:var(--m)">
          <strong>Incident :</strong> <span id="inc-aff-summary" style="color:var(--t)"></span><br>
          <strong>Personnes concernées :</strong> <span id="inc-aff-count" style="color:var(--t)"></span>
        </div>
        <textarea id="inc-aff-template" rows="14" style="width:100%;font-family:var(--fm);font-size:11px;padding:10px;background:var(--s);border:1px solid var(--b);border-radius:8px;color:var(--t);resize:vertical;margin-bottom:8px"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:14px">
          <button class="btn bs bsm" onclick="incCopyAffectedTemplate()" style="font-size:11px;padding:6px 12px">📋 Copier</button>
          <button class="btn bs bsm" onclick="incPrintAffectedTemplate()" style="font-size:11px;padding:6px 12px">🖨️ Imprimer/PDF</button>
        </div>

        <div class="aic" style="margin-bottom:14px">
          <div class="ai in" style="font-size:11px"><strong>Recommandation :</strong> Privilégier l'envoi par e-mail simple si vous disposez des adresses (rapide, traçable). À défaut, courrier postal recommandé avec accusé de réception.</div>
          <div class="ai in" style="font-size:11px"><strong>RGPD art. 34.3 :</strong> La communication à la personne concernée n'est pas requise si (a) les données étaient chiffrées de façon adéquate, (b) le risque a été éliminé par mesures ultérieures, (c) la communication exigerait des efforts disproportionnés (alors → information publique).</div>
        </div>

        <div class="msg e" id="inc-aff-err" style="display:none"></div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn bp" onclick="incMarkAffectedNotified()" style="flex:1;justify-content:center;background:linear-gradient(135deg,#f59e0b,#d97706)">
            <span>✅</span> Marquer la notification comme effectuée
          </button>
          <button class="btn bs" onclick="incCloseAffectedModal()" style="padding:10px 18px">Fermer</button>
        </div>
        <input type="hidden" id="inc-aff-id">
      </div>`;
    document.body.appendChild(m);
  }

  // Remplir les champs
  document.getElementById('inc-aff-id').value = incidentId;
  document.getElementById('inc-aff-summary').textContent = summary || inc.summary || '—';
  document.getElementById('inc-aff-count').textContent = (affectedCount || inc.affected_count || 0) + ' personne(s)';

  // Génération du template
  const detected = new Date(inc.detected_at);
  const fmtDate = d => d ? d.toLocaleDateString('fr-FR', { dateStyle:'long' }) : '—';

  const tpl = `Objet : Information importante concernant la sécurité de vos données de santé

Madame, Monsieur,

Conformément à l'article 34 du Règlement Général sur la Protection des Données (RGPD), nous vous informons qu'un incident de sécurité a été constaté le ${fmtDate(detected)} au sein du système de gestion utilisé par votre infirmier(ère) libéral(e).

NATURE DE L'INCIDENT
${inc.summary || '(à préciser en termes accessibles, sans jargon technique)'}

DONNÉES CONCERNÉES
(à compléter — préciser les catégories de données potentiellement affectées : nom, prénom, date de naissance, données de santé, etc.)

CONSÉQUENCES PROBABLES
${inc.impact_estimate || '(à compléter — préciser les risques pour la personne concernée)'}

MESURES MISES EN ŒUVRE
- Identification et confinement immédiat de l'incident
- Notification à la CNIL (Commission Nationale de l'Informatique et des Libertés) effectuée dans le délai légal de 72 heures
- (à compléter — détails des mesures correctives et préventives)

VOS DROITS
Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, de portabilité et d'opposition concernant vos données personnelles. Vous pouvez également déposer une réclamation auprès de la CNIL :
  • Site web : https://www.cnil.fr/fr/plaintes
  • Téléphone : 01 53 73 22 22
  • Adresse : 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07

CONTACT
Pour toute question relative à cet incident ou à vos données personnelles, vous pouvez contacter :
  • Votre infirmier(ère) libéral(e)
  • Le Délégué à la Protection des Données (DPO) d'AMI : (à compléter — email DPO)

Nous vous prions d'accepter nos sincères excuses pour cet incident et vous assurons que toutes les mesures nécessaires ont été prises pour en limiter les conséquences et éviter sa reproduction.

Veuillez agréer, Madame, Monsieur, l'expression de nos salutations distinguées.

[Signature]
[Nom du responsable de traitement]
[Date : ${new Date().toLocaleDateString('fr-FR')}]

---
Référence interne : ${inc.id || ''}`;

  document.getElementById('inc-aff-template').value = tpl;
  document.getElementById('inc-aff-err').style.display = 'none';
  m.classList.add('show');
  m.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.incCloseAffectedModal = function() {
  const m = document.getElementById('inc-affected-modal');
  if (!m) return;
  m.classList.remove('show');
  m.style.display = 'none';
  document.body.style.overflow = '';
};

window.incCopyAffectedTemplate = function() {
  const ta = document.getElementById('inc-aff-template');
  if (!ta) return;
  ta.select();
  const fallback = () => {
    try { document.execCommand('copy'); if (typeof showToast === 'function') showToast('✅ Texte copié'); }
    catch { if (typeof showToast === 'function') showToast('⚠️ Copie impossible', 'warn'); }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(ta.value)
      .then(() => { if (typeof showToast === 'function') showToast('✅ Texte copié dans le presse-papier'); })
      .catch(fallback);
  } else { fallback(); }
};

window.incPrintAffectedTemplate = function() {
  const ta = document.getElementById('inc-aff-template');
  if (!ta || !ta.value) return;
  const w = window.open('', '_blank');
  if (!w) { alert('❌ Bloqueur de fenêtres détecté'); return; }
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Notification personnes concernées</title>
    <style>
      @page { size:A4; margin:25mm 22mm }
      body { font-family:Georgia,'Times New Roman',serif; font-size:13px; line-height:1.7; color:#111; max-width:680px; margin:0 auto; padding:24px }
      pre { white-space:pre-wrap; font-family:inherit; font-size:13px }
      .no-print { } @media print { .no-print { display:none } }
    </style></head><body>
    <pre>${_escapeHtml(ta.value)}</pre>
    <button class="no-print" onclick="window.print()" style="position:fixed;bottom:20px;right:20px;padding:12px 20px;background:#f59e0b;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.2)">🖨️ Imprimer / PDF</button>
    <script>window.addEventListener('load', () => setTimeout(() => window.print(), 600));<\/script>
    </body></html>`);
  w.document.close();
};

window.incMarkAffectedNotified = async function() {
  const incidentId = document.getElementById('inc-aff-id').value;
  const errEl      = document.getElementById('inc-aff-err');
  errEl.style.display = 'none';
  if (!incidentId) {
    errEl.textContent = '❌ ID incident manquant.';
    errEl.style.display = 'block';
    return;
  }
  if (!confirm('Confirmer que la notification aux personnes concernées (art. 34 RGPD) a bien été envoyée ?')) return;

  // On ajoute la trace de notif art.34 dans la résolution (concaténation si déjà rempli)
  const inc = _ADM_INC_CACHE.find(i => i.id === incidentId);
  const stamp = `[ART34-OK ${new Date().toLocaleString('fr-FR')}] Personnes concernées notifiées.`;
  const newRes = inc?.resolution
    ? `${inc.resolution}\n${stamp}`
    : stamp;

  try {
    const res = await wpost('/webhook/incident-update', {
      incident_id: incidentId,
      resolution: newRes,
    });
    if (res?.ok) {
      if (typeof showToast === 'function') showToast('✅ Notification art.34 enregistrée');
      incCloseAffectedModal();
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
