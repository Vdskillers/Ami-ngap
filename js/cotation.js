/* ════════════════════════════════════════════════
   cotation.js — AMI NGAP v8
   ────────────────────────────────────────────────
   Cotation NGAP + Vérification IA
   - cotation() — appel API calcul NGAP (N8N v9)
   - renderCot() — affiche résultat solo complet
   - printInv() / closeProInfoModal()
   - clrCot() — réinitialise formulaire + cabinet
   - coterDepuisRoute() — cotation depuis tournée
   - openVerify() / closeVM() / applyVerify()
   - verifyStandalone()
   ── CABINET MULTI-IDE v2 ──
   - initCotationCabinetToggle() — affiche/masque le toggle
   - cotationToggleCabinetMode() — ouvre/ferme panneau
   - cotationRenderCabinetActes() — sélecteurs "Qui fait quoi ?"
   - cotationUpdateCabinetTotal() — totaux live par IDE
   - cotationOptimizeDistribution() — répartition IA optimale
   - _cotBuildCabinetPayload() — construit payload multi-IDE
   - cotationCabinet() — pipeline multi-IDE complet
   - renderCotCabinet() — résultat enrichi par IDE

   Tarifs NGAP 2026 :
   AMI1=3,15€ AMI2=6,30€ AMI3=9,45€ AMI4=12,60€ AMI5=15,75€ AMI6=18,90€
   AIS1=2,65€ AIS3=7,95€ BSA=13€ BSB=18,20€ BSC=28,70€
   IFD=2,75€ IK=km×2×0,35€ MCI=5€ MIE=3,15€ NUIT=9,15€ NUIT_PROF=18,30€ DIM=8,50€
   Règles : acte principal×1, secondaires×0,5, majorations×1
   AIS+BSx : INTERDIT — BSA/BSB/BSC : mutuellement exclusifs
════════════════════════════════════════════════ */

let VM_DATA = null;
let _pendingPrintData = null;

/* ════════════════════════════════════════════════
   CABINET MULTI-IDE — CONSTANTES
════════════════════════════════════════════════ */

// ─── TARIFS NGAP — lecture dynamique du référentiel si chargé ───
// Fallback hardcodé complet NGAP 2026.3 (CIR-9/2025)
// Avenant 11 : _COT_TARIFS est rebuildé automatiquement quand le référentiel
// est mis à jour à chaud (event 'ngap:ref_updated' émis par ngap-update-manager.js).
// Les nouvelles lettres-clés (CIA=20€, CIB=20€, RKD=3€) et majorations
// (MSG=3.10€, MSD=7€, MIR=15€) sont incluses automatiquement si présentes.
function _buildCotTarifs() {
  if (window.NGAP_REFERENTIEL) {
    const ref = window.NGAP_REFERENTIEL;
    const out = {};
    // Actes Chap I + II
    [...(ref.actes_chapitre_I||[]), ...(ref.actes_chapitre_II||[])].forEach(a => {
      const key = a.code_facturation || a.code;
      if (key) out[key] = a.tarif;
    });
    // Forfaits BSI
    Object.entries(ref.forfaits_bsi || {}).forEach(([k, v]) => {
      if (v && typeof v === 'object' && v.tarif != null) out[k] = v.tarif;
    });
    // Déplacements
    Object.entries(ref.deplacements || {}).forEach(([k, v]) => { if (v.tarif) out[k] = v.tarif; });
    // Majorations (avec alias) — inclut MSG / MSD / MIR de l'Avenant 11
    Object.entries(ref.majorations || {}).forEach(([k, v]) => { out[k] = v.tarif; });
    out['NUIT'] = ref.majorations?.ISN_NUIT?.tarif || 9.15;
    out['NUIT_PROF'] = ref.majorations?.ISN_NUIT_PROFONDE?.tarif || 18.30;
    out['DIM'] = ref.majorations?.ISD?.tarif || 8.50;
    // Lettres-clés nouvelles Avenant 11 (CIA, CIB, RKD)
    Object.entries(ref.lettres_cles || {}).forEach(([k, v]) => {
      if (['CIA','CIB','RKD'].includes(k) && v && v.valeur != null) out[k] = v.valeur;
    });
    // Indemnités d'astreinte (IAS_PDSA 52€/4h)
    Object.entries(ref.indemnites_astreinte || {}).forEach(([k, v]) => {
      if (v && v.tarif != null) out[k] = v.tarif;
    });
    return out;
  }
  // Fallback NGAP 2026.3 complet (tarifs officiels vérifiés)
  return {
    // Actes techniques — coefficients simples
    AMI0_5:1.58, AMI1:3.15,  AMI1_2:3.78, AMI1_25:3.94, AMI1_5:4.73, AMI1_6:5.04,
    AMI2:6.30,  AMI2_1:6.62, AMI2_4:7.56, AMI2_5:7.88, AMI2_8:8.82, AMI3:9.45,
    AMI3_05:9.61, AMI3_5:11.03, AMI3_9:12.29, AMI4:12.60, AMI4_1:12.92, AMI4_2:13.23,
    AMI4_5:14.18, AMI4_6:14.49, AMI5:15.75, AMI5_1:16.07, AMI5_8:18.27, AMI6:18.90,
    AMI7:22.05, AMI9:28.35, AMI10:31.50, AMI11:34.65, AMI14:44.10, AMI15:47.25,
    // Alias point (AMI4.1 = AMI4_1)
    'AMI4.1':12.92, 'AMI3.9':12.29, 'AMI4.2':13.23, 'AMI5.1':16.07, 'AMI5.8':18.27,
    'AMI1.5':4.73,  'AMI1.1':3.47,  'AMI2.5':7.88,  'AMI2.8':8.82,  'AMI1.25':3.94,
    // AIS
    AIS1:2.65,  AIS3:7.95, AIS3_1:8.22, AIS4:10.60, AIS13:34.45, AIS16:42.40,
    // BSI
    BSA:13.00,  BSB:18.20,  BSC:28.70,
    // Déplacements
    IFD:2.75, IFI:2.75,
    // Majorations
    MCI:5.00,   MIE:3.15, MAU:1.35,
    NUIT:9.15,  NUIT_PROF:18.30, DIM:8.50,
    // Télésoin
    TLS:10.00, TLL:12.00, TLD:15.00, RQD:10.00, TMI:5.04,
  };
}

let _COT_TARIFS = _buildCotTarifs();

// Avenant 11 : rebuild à chaud quand l'override est poussé ou quand le fetch statique arrive
if (typeof document !== 'undefined') {
  const _cotRebuildTarifs = () => {
    try {
      _COT_TARIFS = _buildCotTarifs();
      if (console.info) console.info('[cotation.js] _COT_TARIFS rebuild —', Object.keys(_COT_TARIFS).length, 'codes');
    } catch (e) { if (console.warn) console.warn('[cotation.js] rebuild tarifs failed', e); }
  };
  document.addEventListener('ngap:ref_updated', _cotRebuildTarifs);
  document.addEventListener('ngap:ref_loaded',  _cotRebuildTarifs);
}

// NLP côté client — détection complète des actes NGAP depuis le texte libre
const _COT_NLP_PATTERNS = [
  // Actes techniques
  { rx: /intraveineuse|ivd|iv directe/i,                                code:'AMI2', label:'Injection IV directe', group:'acte' },
  { rx: /injection|insuline|anticoagulant|héparine|fragmine|lovenox|piqûre/i, code:'AMI1', label:'Injection SC/IM', group:'acte' },
  { rx: /prélèvement|prise de sang|bilan sanguin/i,                     code:'AMI1', label:'Prélèvement veineux', group:'acte' },
  // Perfusions — CIR-9/2025 (applicable depuis 25/06/2025)
  { rx: /(retrait|retir[eé])\s+(d[eé]finiti|du\s+dispositif|de\s+(la\s+)?(picc|midline|chambre|perfusion))|d[eé]branchement\s+d[eé]finiti/i,
    code:'AMI5',   label:'Retrait définitif dispositif ≥24h', group:'acte' },
  { rx: /(changement\s+(?:de\s+)?flacon|rebranche(ment)?|2\s*[èe]?me?\s+perfusion|deuxi[èe]me\s+perfusion|branchement\s+en\s+y)/i,
    code:'AMI4_1', label:'Changement flacon / 2e branchement même jour', group:'acte' },
  { rx: /perfusion.*(?:cancer|canc[ée]reux|chimio|immunod[eé]prim|mucoviscidose)|(?:cancer|canc[ée]reux|chimio|immunod[eé]prim|mucoviscidose).*perfusion/i,
    code:'AMI15',  label:'Forfait perfusion longue — immunodéprimé/cancéreux (1x/jour)', group:'acte' },
  { rx: /perfusion.*(?:courte|≤\s*1\s*h|<\s*1\s*h|30\s*min|45\s*min|60\s*min|surveillance\s+continue|inf[eé]rieure?\s+[aà]\s+1\s*h)/i,
    code:'AMI9',   label:'Perfusion courte ≤1h sous surveillance', group:'acte' },
  { rx: /perfusion.*(?:12\s*h|24\s*h|longue|>\s*1\s*h|plus d[eu]?\s*une\s+heure|baxter|chambre\s+implantable)|baxter|chambre\s+implantable|\bpicc\b|midline|diffuseur/i,
    code:'AMI14',  label:'Forfait perfusion longue >1h (1x/jour)', group:'acte' },
  { rx: /perfusion|perf\b/i,
    code:'AMI14',  label:'Forfait perfusion longue (1x/jour)', group:'acte' },
  { rx: /pansement.*(?:complexe|escarre|nécrose|chirurgical|post.op|ulcère)/i, code:'AMI4', label:'Pansement complexe', group:'acte' },
  { rx: /pansement|plaie/i,                                             code:'AMI1', label:'Pansement simple', group:'acte' },
  { rx: /ecg|électrocardiogramme/i,                                     code:'AMI3', label:'ECG', group:'acte' },
  // Bilans soins infirmiers
  { rx: /toilette.*(?:totale|alité|alit[ée]|grabataire|dépendance lourde)/i, code:'BSC', label:'BSC — Dépendance lourde', group:'bsi' },
  { rx: /toilette.*(?:modér|intermédiaire)/i,                           code:'BSB', label:'BSB — Dépendance modérée', group:'bsi' },
  { rx: /toilette|nursing|bilan soins|bsi/i,                            code:'BSA', label:'BSA — Dépendance légère', group:'bsi' },
  // Majorations — toujours affichées car impactent l'attribution
  { rx: /domicile|chez le patient|à domicile/i,                         code:'IFD',      label:'IFD — Déplacement domicile', group:'maj' },
  { rx: /(?:23h|00h|01h|02h|03h|04h|nuit profonde)/i,                  code:'NUIT_PROF', label:'Majoration nuit profonde', group:'maj' },
  { rx: /(?:20h|21h|22h|05h|06h|07h|nuit)\b/i,                        code:'NUIT',     label:'Majoration nuit', group:'maj' },
  { rx: /dimanche|férié|ferie/i,                                        code:'DIM',      label:'Majoration dimanche/férié', group:'maj' },
  { rx: /enfant|nourrisson|< ?7 ?ans/i,                                 code:'MIE',      label:'Majoration enfant <7 ans', group:'maj' },
  { rx: /coordination|pluridisciplinaire|mci/i,                         code:'MCI',      label:'Majoration coordination', group:'maj' },
];

// Couleurs par IDE (jusqu'à 5 IDEs)
const _IDE_COLORS = ['#00d4aa','#4fa8ff','#ff9f43','#a29bfe','#fd79a8'];

/**
 * Détecte les actes depuis le texte libre, sans doublons par code
 */
function _cotDetectActes(texte) {
  const found = [], seenCodes = new Set();
  for (const pat of _COT_NLP_PATTERNS) {
    if (pat.rx.test(texte) && !seenCodes.has(pat.code)) {
      found.push({ code: pat.code, label: pat.label, group: pat.group });
      seenCodes.add(pat.code);
    }
  }
  /* ── Fix A3 : aucun acte détecté → fallback AMI1 avec flag _estimation
     Ce flag est lu par renderCot pour afficher un bandeau d'avertissement
     explicite, évitant toute confusion entre un résultat IA confirmé et
     une estimation automatique par défaut. ── */
  if (!found.length) found.push({ code: 'AMI1', label: 'Acte infirmier (à préciser)', group: 'acte', _estimation: true });
  return found;
}

/**
 * Calcule l'estimation NGAP correcte pour une liste d'actes assignés à un IDE
 * Applique la règle : acte principal plein tarif, suivants ×0.5
 */
function _cotEstimateNGAP(actesIDE) {
  const principaux = actesIDE.filter(a => ['AMI1','AMI2','AMI3','AMI4','AMI5','AMI6','AIS1','AIS3'].includes(a.code));
  const majorations = actesIDE.filter(a => ['IFD','NUIT','NUIT_PROF','DIM','MIE','MCI'].includes(a.code));
  const bilans = actesIDE.filter(a => ['BSA','BSB','BSC'].includes(a.code));

  // Trier les actes principaux par tarif décroissant
  principaux.sort((a, b) => (_COT_TARIFS[b.code]||0) - (_COT_TARIFS[a.code]||0));

  let total = 0;
  principaux.forEach((a, i) => {
    a._coeff = i === 0 ? 1 : 0.5;
    a._montant = (_COT_TARIFS[a.code]||3.15) * a._coeff;
    total += a._montant;
  });
  bilans.forEach(a => {
    a._coeff = 1; a._montant = _COT_TARIFS[a.code]||0; total += a._montant;
  });
  majorations.forEach(a => {
    a._coeff = 1; a._montant = _COT_TARIFS[a.code]||0; total += a._montant;
  });
  return { total: Math.round(total * 100) / 100, actes: [...principaux, ...bilans, ...majorations] };
}

/* ════════════════════════════════════════════════
   INIT & TOGGLE
════════════════════════════════════════════════ */

function initCotationCabinetToggle() {
  const wrap = $('cot-cabinet-toggle-wrap');
  if (!wrap) return;
  const cab = APP.get('cabinet');
  // Admins inclus (pour tester) — masquer si pas de cabinet
  wrap.style.display = cab?.id ? 'block' : 'none';
}

function cotationToggleCabinetMode(active) {
  const panel = $('cot-cabinet-panel');
  if (!panel) return;
  panel.style.display = active ? 'block' : 'none';
  if (active) cotationRenderCabinetActes();
  else { // Réinitialiser les totaux si désactivé
    const totals = $('cot-cabinet-totals');
    if (totals) totals.remove();
    const gain = $('cot-cabinet-gain');
    if (gain) gain.remove();
  }
}

APP.on('cabinet', () => { initCotationCabinetToggle(); });

document.addEventListener('input', e => {
  if (e.target?.id === 'f-txt' && $('cot-cabinet-mode')?.checked) {
    cotationRenderCabinetActes();
  }
});

/* ════════════════════════════════════════════════
   RENDU DU PANNEAU "QUI FAIT QUOI ?"
════════════════════════════════════════════════ */

function cotationRenderCabinetActes() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return;

  const cab     = APP.get('cabinet');
  const members = cab?.members || [];
  const texte   = gv('f-txt');

  if (!members.length) {
    list.innerHTML = `<div class="ai wa" style="font-size:12px">
      ⚠️ Vous n'êtes pas dans un cabinet.
      <a href="#" onclick="if(typeof navTo==='function')navTo('cabinet',null);return false;" style="color:var(--a)">Rejoindre un cabinet →</a>
    </div>`;
    return;
  }

  // Validation critique : l'ID utilisateur est requis pour attribuer les actes
  // (sinon le serveur reçoit performed_by:'moi' = valeur invalide)
  const meId = APP.user?.id;
  if (!meId) {
    list.innerHTML = `<div class="ai wa" style="font-size:12px">
      ⚠️ Session utilisateur non initialisée. Reconnectez-vous pour activer le mode cabinet.
    </div>`;
    return;
  }

  const actes = _cotDetectActes(texte);
  const meLabel = ((APP.user?.prenom||'')+' '+(APP.user?.nom||'')).trim() || 'Moi';

  // Options IDE avec couleur
  const allIDEs = [
    { id: meId, label: `${meLabel} (moi)`, color: _IDE_COLORS[0] },
    ...members
      .filter(m => m.id !== meId)
      .map((m, i) => ({ id: m.id, label: `${m.prenom} ${m.nom}`, color: _IDE_COLORS[(i+1) % _IDE_COLORS.length] }))
  ];

  const memberOptions = allIDEs.map(ide =>
    `<option value="${ide.id}">${ide.label}</option>`
  ).join('');

  // Grouper par type pour clarté visuelle
  const groupLabels = { acte: '🩺 Actes techniques', bsi: '🛁 Bilans soins', maj: '⚡ Majorations' };
  const grouped = {};
  actes.forEach(a => {
    if (!grouped[a.group]) grouped[a.group] = [];
    grouped[a.group].push(a);
  });

  list.innerHTML = Object.entries(grouped).map(([grp, items]) => `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-family:var(--fm);color:var(--m);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">${groupLabels[grp]||grp}</div>
      ${items.map((acte, gi) => {
        const globalIdx = actes.indexOf(acte);
        const tarif = _COT_TARIFS[acte.code];
        const tarifStr = tarif ? `${tarif.toFixed(2)} €` : '—';
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--b);border-radius:8px;background:var(--s);flex-wrap:wrap;margin-bottom:6px">
          <div style="flex:1;min-width:120px">
            <div style="font-weight:600;font-size:13px">${acte.label}</div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${acte.code} · ${tarifStr}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span style="font-size:11px;color:var(--m)">→</span>
            <select id="cot-cab-ide-${globalIdx}"
              data-acte="${acte.code}" data-idx="${globalIdx}" data-group="${acte.group}"
              onchange="cotationUpdateCabinetTotal()"
              style="padding:6px 10px;background:var(--c);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:12px">
              ${memberOptions}
            </select>
          </div>
        </div>`;
      }).join('')}
    </div>`).join('');

  cotationUpdateCabinetTotal();
}

/* ════════════════════════════════════════════════
   CALCUL DES TOTAUX EN TEMPS RÉEL
════════════════════════════════════════════════ */

function cotationUpdateCabinetTotal() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return;

  const selectors = list.querySelectorAll('select[id^="cot-cab-ide-"]');
  if (!selectors.length) return;

  // Grouper les actes par IDE
  const byIDE = {};
  selectors.forEach(sel => {
    const ideId = sel.value;
    if (!byIDE[ideId]) byIDE[ideId] = [];
    byIDE[ideId].push({ code: sel.dataset.acte, group: sel.dataset.group });
  });

  const cab     = APP.get('cabinet');
  const members = cab?.members || [];
  const meId    = APP.user?.id;
  if (!meId) return; // Session non initialisée → rien à afficher (Render a déjà affiché l'erreur)
  const meLabel = ((APP.user?.prenom||'')+' '+(APP.user?.nom||'')).trim() || 'Moi';

  // Calculer NGAP correct par IDE
  const resultsByIDE = Object.entries(byIDE).map(([ideId, actes], i) => {
    const m   = members.find(x => x.id === ideId);
    const nm  = ideId === meId ? meLabel : (m ? `${m.prenom} ${m.nom}` : ideId.slice(0,8)+'…');
    const col = _IDE_COLORS[i % _IDE_COLORS.length];
    const { total, actes: actesCalc } = _cotEstimateNGAP(actes);
    return { ideId, nm, col, total, actes: actesCalc };
  });

  const grandTotal   = resultsByIDE.reduce((s, r) => s + r.total, 0);
  const totalSolo    = _cotEstimateNGAP(Array.from(selectors).map(s => ({ code: s.dataset.acte, group: s.dataset.group }))).total;
  const gainCabinet  = grandTotal - totalSolo;
  const nbIDEs       = resultsByIDE.length;

  // Bloc totaux
  let totalsEl = $('cot-cabinet-totals');
  if (!totalsEl) {
    totalsEl = document.createElement('div');
    totalsEl.id = 'cot-cabinet-totals';
    const panel = $('cot-cabinet-panel');
    const actesWrap = $('cot-cabinet-actes-list');
    if (panel && actesWrap) panel.insertBefore(totalsEl, actesWrap.nextSibling);
  }

  totalsEl.style.cssText = 'margin-top:10px;padding:12px 14px;background:rgba(0,212,170,.06);border-radius:10px;border:1px solid rgba(0,212,170,.15)';

  const rows = resultsByIDE.map(r => {
    const actesDetail = r.actes
      .filter(a => a._montant !== undefined)
      .map(a => `<span style="font-size:10px;color:var(--m);font-family:var(--fm)">${a.code}${a._coeff < 1 ? '×0.5' : ''}</span>`)
      .join(' ');
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:10px;height:10px;border-radius:50%;background:${r.col};flex-shrink:0"></div>
        <div>
          <div style="font-size:13px;font-weight:600">${r.nm}</div>
          <div style="margin-top:2px">${actesDetail}</div>
        </div>
      </div>
      <strong style="color:${r.col};font-size:14px;flex-shrink:0">${r.total.toFixed(2)} €</strong>
    </div>`;
  }).join('');

  const gainHtml = gainCabinet > 0.01
    ? `<div style="margin-top:8px;padding:6px 10px;background:rgba(34,197,94,.08);border-radius:6px;font-size:12px;display:flex;justify-content:space-between">
        <span>💡 Gain vs cotation solo</span>
        <strong style="color:#22c55e">+${gainCabinet.toFixed(2)} €</strong>
      </div>` : '';

  totalsEl.innerHTML = `
    <div style="font-size:10px;font-family:var(--fm);color:var(--m);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">Estimation NGAP par IDE</div>
    ${rows}
    <div style="border-top:1px solid rgba(0,212,170,.2);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:13px">TOTAL CABINET (${nbIDEs} IDE${nbIDEs>1?'s':''})</strong>
      <strong style="color:var(--a);font-size:16px">${grandTotal.toFixed(2)} €</strong>
    </div>
    ${gainHtml}`;
}

/* ════════════════════════════════════════════════
   OPTIMISATION AUTOMATIQUE DE LA RÉPARTITION
════════════════════════════════════════════════ */

function cotationOptimizeDistribution() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return;

  const selectors = Array.from(list.querySelectorAll('select[id^="cot-cab-ide-"]'));
  if (!selectors.length) {
    if (typeof showToast==='function') showToast('Aucun acte détecté — saisissez la description du soin.', 'wa');
    return;
  }

  const cab = APP.get('cabinet');
  if (!cab?.members?.length) return;

  const meId  = APP.user?.id;
  if (!meId) {
    if (typeof showToast==='function') showToast('⚠️ Session utilisateur non initialisée — reconnectez-vous.', 'wa');
    return;
  }
  const allIDEs = [meId, ...cab.members.filter(m => m.id !== meId).map(m => m.id)];
  const nbIDEs  = allIDEs.length;

  // Séparer actes principaux et majorations
  const principaux   = selectors.filter(s => s.dataset.group !== 'maj');
  const majorations  = selectors.filter(s => s.dataset.group === 'maj');

  // Trier les actes principaux par tarif décroissant
  const sortedPrincipaux = [...principaux].sort((a, b) =>
    (_COT_TARIFS[b.dataset.acte]||0) - (_COT_TARIFS[a.dataset.acte]||0)
  );

  // Répartition optimale : IDE 0 prend le plus valorisé, IDE 1 le suivant…
  // = chaque IDE a son acte principal au tarif plein
  sortedPrincipaux.forEach((sel, i) => { sel.value = allIDEs[i % nbIDEs]; });

  // Les majorations IFD, NUIT, DIM, MIE → attribuer à l'IDE ayant le moins d'actes principaux
  // pour optimiser leur coefficient (majorations toujours ×1 quelle que soit l'IDE)
  majorations.forEach(sel => { sel.value = allIDEs[0]; }); // par défaut : moi

  cotationUpdateCabinetTotal();

  // Calculer et afficher le gain
  const selAll  = Array.from(list.querySelectorAll('select[id^="cot-cab-ide-"]'));
  const soloAcH = selAll.map(s => ({ code: s.dataset.acte, group: s.dataset.group }));
  const soloTot = _cotEstimateNGAP(soloAcH).total;

  const byIDE = {};
  selAll.forEach(sel => {
    if (!byIDE[sel.value]) byIDE[sel.value] = [];
    byIDE[sel.value].push({ code: sel.dataset.acte, group: sel.dataset.group });
  });
  const cabTot = Object.values(byIDE).reduce((s, a) => s + _cotEstimateNGAP(a).total, 0);
  const gain   = cabTot - soloTot;

  const sugg = $('cot-cabinet-suggestion');
  if (sugg) {
    sugg.innerHTML = gain > 0.01
      ? `✅ Répartition optimisée${gain > 0.01 ? ` — gain vs solo : <strong style="color:var(--a)">+${gain.toFixed(2)} €</strong>` : ''}`
      : '✅ Répartition optimisée — chaque IDE a son acte principal au tarif plein';
    sugg.style.display = 'block';
    setTimeout(() => { sugg.style.display = 'none'; }, 5000);
  }
}

/* ════════════════════════════════════════════════
   PAYLOAD MULTI-IDE
════════════════════════════════════════════════ */

function _cotBuildCabinetPayload() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return null;
  const selectors = list.querySelectorAll('select[id^="cot-cab-ide-"]');
  if (!selectors.length) return null;

  // Validation : tous les performed_by doivent être des IDs valides
  // (soit l'utilisateur courant, soit un membre du cabinet)
  const cab      = APP.get('cabinet');
  const meId     = APP.user?.id;
  const validIDs = new Set([meId, ...(cab?.members || []).map(m => m.id)]);

  const actes = [];
  let invalidCount = 0;
  selectors.forEach(sel => {
    const performed_by = sel.value;
    if (!validIDs.has(performed_by)) {
      invalidCount++;
      console.warn('[cotation] performed_by invalide:', performed_by, '— réattribué à moi');
    }
    actes.push({
      code:         sel.dataset.acte,
      group:        sel.dataset.group || 'acte', // acte / bsi / maj
      label:        sel.closest('div')?.querySelector('div[style*="font-weight:600"]')?.textContent || sel.dataset.acte,
      performed_by: validIDs.has(performed_by) ? performed_by : meId, // Fallback : moi si invalide
    });
  });

  if (invalidCount > 0 && typeof showToast === 'function') {
    showToast(`⚠️ ${invalidCount} acte(s) avec attribution invalide — réattribué(s) à vous`, 'wa');
  }

  return actes;
}

/* ════════════════════════════════════════════════
   PIPELINE COTATION CABINET
════════════════════════════════════════════════ */

async function cotationCabinet(txt) {
  ld('btn-cot', true);
  $('res-cot').classList.remove('show');
  $('cerr').style.display = 'none';

  const _btnEl   = $('btn-cot');
  const _origHTML = _btnEl?.innerHTML;
  const _slow = [];
  const _showSlow = m => { if (_btnEl) _btnEl.innerHTML = `<span style="font-size:12px;font-weight:400">${m}</span>`; };
  _slow.push(setTimeout(() => _showSlow('🏥 Cotation cabinet en cours…'), 5000));
  _slow.push(setTimeout(() => _showSlow('🤖 Calcul multi-IDE — patience…'), 15000));
  _slow.push(setTimeout(() => _showSlow('🤖 Encore quelques secondes…'), 30000));
  const _clear = () => { _slow.forEach(t => clearTimeout(t)); if (_btnEl && _origHTML) _btnEl.innerHTML = _origHTML; };

  try {
    const cab    = APP.get('cabinet');
    const u      = S?.user || {};
    const actes  = _cotBuildCabinetPayload();

    if (!actes?.length) {
      _clear(); ld('btn-cot', false);
      return _cotationSolo(); // fallback solo — PAS cotation() car récursion mode cabinet
    }

    // Vérifier si plusieurs IDEs distincts — sinon fallback solo
    const uniqIDEs = [...new Set(actes.map(a => a.performed_by))];
    if (uniqIDEs.length < 2) {
      _clear(); ld('btn-cot', false);
      return _cotationSolo(); // fallback solo — PAS cotation() car récursion mode cabinet
    }

    const payload = {
      cabinet_mode: true,
      cabinet_id:   cab.id,
      actes,
      texte:        txt,
      mode:         'ngap',
      date_soin:    gv('f-ds') || new Date().toISOString().slice(0,10),
      heure_soin:   gv('f-hs') || '',
      exo:          gv('f-exo') || '',
      regl:         gv('f-regl') || 'patient',
      infirmiere:   ((u.prenom||'')+' '+(u.nom||'')).trim(),
      adeli:        u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      // Preuve soin
      preuve_soin: {
        type: 'auto_declaration', timestamp: new Date().toISOString(), certifie_ide: true, force_probante: 'STANDARD',
      },
    };

    const d = await apiCall('/webhook/cabinet-calcul', payload);
    _clear();

    if (!d.ok) throw new Error(d.error || 'Erreur cotation cabinet');

    $('cbody').innerHTML = renderCotCabinet(d);
    $('res-cot').classList.add('show');

    // ── Persistance IDB de la part utilisateur courant ─────────────────────
    // Extraire la cotation correspondant à l'IDE connecté (u.id) et l'appliquer
    // dans son carnet patient (IDB), en respectant la règle upsert du solo.
    try {
      await _cotationCabinetPersistMyPart(d, txt);
    } catch (_ePersist) {
      console.warn('[cotation] Persistance IDB cabinet KO:', _ePersist.message);
      // Non bloquant — la cotation serveur reste valide
    }

    // Scroll vers résultat
    setTimeout(() => document.getElementById('res-cot')?.scrollIntoView({ behavior:'smooth', block:'start' }), 100);

    if (typeof showToast === 'function') showToast(`✅ Cabinet : ${(d.total_global||0).toFixed(2)} € (${d.nb_ide||uniqIDEs.length} IDEs)`, 'ok');

  } catch(e) {
    _clear();
    // Re-cotation cabinet en erreur → retire le FAB
    try { if (typeof _cotHideReCoteBar === 'function') _cotHideReCoteBar(); } catch (_) {}
    $('cerr').style.display = 'flex';
    $('cerr-m').textContent = e.message;
    $('res-cot').classList.add('show');
  }
  ld('btn-cot', false);
}

/* ════════════════════════════════════════════════
   PERSISTANCE IDB DE LA PART UTILISATEUR (mode cabinet)
   ────────────────────────────────────────────────
   Après une cotation cabinet, extraire la cotation correspondant à l'IDE
   connecté et l'appliquer dans son carnet patient (IDB) en respectant
   exactement la même règle upsert que le pipeline solo :

     Patient existant + _editRef + index trouvé → Upsert (MAJ)
     Patient existant + pas de _editRef         → Push (1ère cotation)
     Patient existant + _editRef + pas d'index  → Rien (évite doublon)
     Patient absent   + pas de _editRef         → Création fiche + cotation
     Patient absent   + _editRef                → Rien (pas de fiche fantôme)

   Cette fonction échoue en silence (try/catch externe) pour ne pas bloquer
   la cotation cabinet si l'IDB est indisponible.
════════════════════════════════════════════════ */

async function _cotationCabinetPersistMyPart(d, txt) {
  // Pré-conditions
  if (typeof _idbGetAll !== 'function' || typeof PATIENTS_STORE === 'undefined') return;
  if (typeof _dec !== 'function' || typeof _enc !== 'function') return;
  if (typeof _idbPut !== 'function') return;

  const cotations = d?.cotations || [];
  if (!cotations.length) return;

  const meId = APP.user?.id;
  if (!meId) return;

  // Trouver la part correspondant à l'utilisateur courant
  const myCot = cotations.find(c => c.ide_id === meId || c.infirmiere_id === meId);
  if (!myCot) return; // L'utilisateur n'a pas d'acte attribué (possible en cabinet)

  // Guard : pas d'acte technique → ne pas polluer le carnet
  const _CODES_MAJ = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
  const _actesTech = (myCot.actes || []).filter(a => !_CODES_MAJ.has((a.code||'').toUpperCase()));
  const _editRef   = window._editingCotation;
  if (!_actesTech.length && !_editRef) {
    console.warn('[cotation] Cabinet IDB save ignoré — pas d\'acte technique pour moi:', (myCot.actes||[]).map(a=>a.code));
    return;
  }

  const _patNom = (gv('f-pt') || '').trim();
  if (!_patNom) return; // Pas de nom patient → on ne persiste pas

  const _cotDate = gv('f-ds') || new Date().toISOString().slice(0,10);
  const _invNum  = myCot.invoice_number || _editRef?.invoice_number || null;

  // Recherche du patient dans l'IDB (même logique que le pipeline solo)
  const _allRows = await _idbGetAll(PATIENTS_STORE);
  const _nomLow  = _patNom.toLowerCase();
  const _patRow  = _allRows.find(r =>
    ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
    ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
  );

  const _newCot = {
    date:           _cotDate,
    heure:          gv('f-hs') || '',
    actes:          myCot.actes || [],
    total:          parseFloat(myCot.total || 0),
    part_amo:       parseFloat(myCot.part_amo || 0),
    part_amc:       parseFloat(myCot.part_amc || 0),
    part_patient:   parseFloat(myCot.part_patient || 0),
    soin:           (txt || '').slice(0, 120),
    invoice_number: _invNum,
    source:         _editRef ? 'cabinet_edit' : 'cabinet_form',
    cabinet_id:     APP.get('cabinet')?.id || null,
    _synced:        true,
  };

  if (_patRow) {
    // ── Patient existant → upsert strict ────────────────────────────────
    const _pat = { id: _patRow.id, nom: _patRow.nom, prenom: _patRow.prenom, ...(_dec(_patRow._data)||{}) };
    if (!Array.isArray(_pat.cotations)) _pat.cotations = [];

    // Résolution index (mêmes priorités que le solo)
    let _idx = -1;
    if (typeof _editRef?.cotationIdx === 'number' && _editRef.cotationIdx >= 0)
      _idx = _editRef.cotationIdx;
    if (_idx < 0 && _invNum)
      _idx = _pat.cotations.findIndex(c => c.invoice_number === _invNum);
    if (_idx < 0 && _editRef?.invoice_number)
      _idx = _pat.cotations.findIndex(c => c.invoice_number === _editRef.invoice_number);
    // ⚠️ Fallback par date : UNIQUEMENT si _editRef est un vrai mode édition
    // (cotationIdx ou invoice_number fourni). Si l'utilisateur a cliqué
    // "✨ Nouvelle cotation" dans la modale doublon, _editRef = { _userChose: true }
    // SANS cotationIdx/invoice_number → le fallback par date trouverait l'ancienne
    // cotation et ferait un upsert silencieux au lieu de respecter le choix utilisateur.
    const _isForceNew = _editRef?._userChose && !_editRef?.cotationIdx && !_editRef?.invoice_number;
    if (_idx < 0 && _editRef && _cotDate && !_isForceNew) {
      _idx = _pat.cotations.findIndex(c =>
        (c.date || '').slice(0, 10) === _cotDate.slice(0, 10)
      );
    }

    if (_idx >= 0) {
      // Cotation existante → upsert
      _pat.cotations[_idx] = { ..._pat.cotations[_idx], ..._newCot, date_edit: new Date().toISOString() };
    } else if (!_editRef || _isForceNew) {
      // Pas de _editRef OU choix explicite "Nouvelle cotation" → push
      _pat.cotations.push(_newCot);
    }
    // Si _editRef avec cotationIdx/invoice_number mais pas d'index trouvé → ne rien faire (évite doublons)

    _pat.updated_at = new Date().toISOString();
    const _toStore = { id: _pat.id, nom: _pat.nom, prenom: _pat.prenom, _data: _enc(_pat), updated_at: _pat.updated_at };
    await _idbPut(PATIENTS_STORE, _toStore);
    if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore).catch(() => {});

  } else if (!_editRef) {
    // ── Patient absent + pas de correction → créer fiche + cotation ────
    const _parts  = _patNom.trim().split(/\s+/);
    const _prenom = _parts.slice(0, -1).join(' ') || _patNom;
    const _nom    = _parts.length > 1 ? _parts[_parts.length - 1] : '';
    const _newPat = {
      id:         'pat_' + Date.now(),
      nom:        _nom,
      prenom:     _prenom,
      ddn:        gv('f-ddn') || '',
      amo:        gv('f-amo') || '',
      amc:        gv('f-amc') || '',
      exo:        gv('f-exo') || '',
      medecin:    gv('f-pr')  || '',
      cotations:  [_newCot],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source:     'cabinet_auto',
    };
    const _toStore = {
      id:         _newPat.id,
      nom:        _nom,
      prenom:     _prenom,
      _data:      _enc(_newPat),
      updated_at: _newPat.updated_at,
    };
    await _idbPut(PATIENTS_STORE, _toStore);
    if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore).catch(() => {});
    if (typeof showToast === 'function')
      showToast('👤 Fiche patient créée automatiquement pour ' + _patNom);
  }
  // Sinon (patient absent + _editRef) → rien (pas de fiche fantôme)
}

/* ════════════════════════════════════════════════
   RENDU RÉSULTAT CABINET — enrichi
════════════════════════════════════════════════ */

function renderCotCabinet(d) {
  const cotations = d.cotations || [];
  const cab       = APP.get('cabinet');
  const members   = cab?.members || [];
  const meId      = APP.user?.id || null; // null safe : ideId === null sera false pour tout vrai ID
  const meLabel   = ((APP.user?.prenom||'')+' '+(APP.user?.nom||'')).trim() || 'Moi';

  function getIDEName(ideId) {
    if (ideId === meId) return meLabel + ' (moi)';
    const m = members.find(x => x.id === ideId);
    return m ? `${m.prenom} ${m.nom}` : ideId?.slice(0,8)+'…';
  }

  const cotHTML = cotations.map((cot, i) => {
    const nm  = getIDEName(cot.ide_id);
    const col = _IDE_COLORS[i % _IDE_COLORS.length];

    // Détail des actes
    const actesList = (cot.actes || []).map(a =>
      `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:5px 0;border-bottom:1px solid var(--b)">
        <div style="flex:1">
          <span style="font-weight:600;font-size:11px;color:${col};font-family:var(--fm);margin-right:6px">${a.code||'?'}</span>
          <span style="color:var(--t)">${a.nom||''}</span>
          ${a.coefficient < 1 ? `<span style="font-size:10px;color:var(--m);margin-left:4px">×${a.coefficient?.toFixed(1)}</span>` : ''}
          ${i === 0 && (cot.actes||[]).indexOf(a) === 0 ? `<span style="font-size:9px;background:rgba(0,212,170,.1);color:var(--a);padding:1px 5px;border-radius:10px;margin-left:4px;font-family:var(--fm)">principal</span>` : ''}
        </div>
        <span style="font-family:var(--fm);font-weight:600">${(a.total||0).toFixed(2)} €</span>
      </div>`
    ).join('');

    // Alertes NGAP de cette cotation
    const alerts = (cot.alerts || []).filter(a => !a.startsWith('✅'));
    const alertsHtml = alerts.length
      ? `<div style="margin-top:6px">${alerts.map(a => `<div style="font-size:10px;color:${a.startsWith('🚨') ? '#ef4444' : '#f59e0b'};padding:2px 0">${a}</div>`).join('')}</div>`
      : '';

    // Badge fraud si disponible
    const fraud = cot.fraud || {};
    const fraudBadge = fraud.level && fraud.level !== 'LOW'
      ? `<span style="font-size:10px;padding:1px 8px;border-radius:20px;font-family:var(--fm);background:${fraud.level==='HIGH'?'rgba(239,68,68,.12)':'rgba(251,191,36,.12)'};color:${fraud.level==='HIGH'?'#ef4444':'#f59e0b'}">${fraud.level==='HIGH'?'🔴':'🟡'} Fraude ${fraud.level}</span>`
      : '';

    return `
    <div style="border:1px solid var(--b);border-left:4px solid ${col};border-radius:10px;margin-bottom:12px;overflow:hidden">
      <!-- En-tête IDE -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:${col}0f;flex-wrap:wrap;gap:8px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:32px;height:32px;border-radius:50%;background:${col}22;border:2px solid ${col};display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">👤</div>
          <div>
            <div style="font-weight:700;font-size:14px">${nm}</div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${(cot.actes||[]).length} acte(s) ${cot.fallback ? '· estimation locale' : '· calculé par IA'}</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:700;color:${col};font-family:var(--fs)">${(cot.total||0).toFixed(2)} €</div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm)">AMO : ${(cot.part_amo||cot.total*0.6||0).toFixed(2)} € · Patient : ${(cot.part_patient||cot.total*0.4||0).toFixed(2)} €</div>
        </div>
      </div>
      <!-- Détail actes -->
      <div style="padding:10px 14px">
        ${actesList || '<span style="font-size:12px;color:var(--m)">—</span>'}
        ${alertsHtml}
        ${fraudBadge ? `<div style="margin-top:6px">${fraudBadge}</div>` : ''}
      </div>
      <!-- Actions par IDE -->
      <div style="padding:8px 14px;border-top:1px solid var(--b);display:flex;gap:8px;flex-wrap:wrap;background:var(--s)">
        ${cot.invoice_number ? `<button class="btn bv bsm" onclick="openSignatureModal('${cot.invoice_number}')">✍️ Signature patient</button>` : ''}
        <button class="btn bs bsm" onclick='printInv(${JSON.stringify({...cot,total:cot.total}).replace(/'/g, "&#39;")})' title="${cot.invoice_number ? 'Télécharger la facture' : 'Télécharger — n° provisoire (cotation pas encore synchronisée)'}">📥 Facture${cot.invoice_number ? '' : ' <span style=\"font-size:9px;opacity:.7\">(provisoire)</span>'}</button>
      </div>
    </div>`;
  }).join('');

  // Comparaison solo vs cabinet
  const totalSolo   = _cotEstimateNGAP(cotations.flatMap(c => (c.actes||[]).map(a => ({ code: a.code, group: ['IFD','NUIT','NUIT_PROF','DIM','MIE','MCI'].includes(a.code) ? 'maj' : 'acte' })))).total;
  const gainCabinet = (d.total_global||0) - totalSolo;

  const gainBloc = gainCabinet > 0.01 ? `
    <div style="margin-top:10px;padding:10px 14px;background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:13px;font-weight:600;color:#22c55e">💡 Gain mode cabinet</div>
        <div style="font-size:11px;color:var(--m)">vs cotation solo (avec décotes NGAP)</div>
      </div>
      <strong style="font-size:18px;color:#22c55e">+${gainCabinet.toFixed(2)} €</strong>
    </div>` : '';

  return `<div class="card">
    <!-- Titre -->
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-size:20px;font-family:var(--fs);font-weight:700">🏥 Cotation cabinet</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="background:rgba(0,212,170,.12);color:var(--a);border-radius:20px;font-size:11px;padding:2px 10px;font-family:var(--fm)">${cotations.length} IDE(s)</span>
        <span style="background:rgba(0,212,170,.08);color:var(--a);border-radius:20px;font-size:11px;padding:2px 10px;font-family:var(--fm)">NGAP 2026</span>
      </div>
    </div>

    <!-- Cotations par IDE -->
    ${cotHTML || '<div class="ai wa">Aucune cotation retournée.</div>'}

    <!-- Total cabinet -->
    <div style="padding:14px;background:rgba(0,212,170,.08);border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:13px;font-weight:700">TOTAL CABINET</div>
        <div style="font-size:11px;color:var(--m)">${cotations.length} infirmière(s) · ${cotations.reduce((s,c)=>(c.actes||[]).length+s,0)} acte(s)</div>
      </div>
      <div style="font-size:24px;font-weight:700;color:var(--a);font-family:var(--fs)">${(d.total_global||0).toFixed(2)} €</div>
    </div>

    <!-- Gain cabinet vs solo -->
    ${gainBloc}

    <!-- Info NGAP cabinet -->
    <div class="ai in" style="margin-top:10px;font-size:11px">
      🏥 <strong>Mode cabinet actif</strong> — Chaque infirmière bénéficie de son <strong>acte principal au tarif plein</strong>.
      Les décotes NGAP s'appliquent uniquement au sein des actes d'une même IDE, pas entre IDEs.
    </div>
  </div>`;
}

/* ════════════════════════════════════════════════
   COTATION SOLO — pipeline principal
════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════
   VÉRIFICATION DOUBLON AVANT COTATION
   Affiche une modale de choix si une cotation existe déjà pour ce patient/date.
   Retourne true si on peut continuer, false si on attend le choix utilisateur.
════════════════════════════════════════════════ */
async function _cotationCheckDoublon(onUpdate, onNew) {
  // Seul _userChose (choix explicite de l'utilisateur dans cette session) bypasse la modale.
  // cotationIdx et invoice_number ne bypasses PAS la modale — ils servent uniquement à l'upsert.
  if (window._editingCotation && window._editingCotation._userChose) return true;

  // ── BYPASS FAB « Re-coter » ────────────────────────────────────────────
  // Si la cotation est déclenchée par le FAB (et non par un clic manuel sur
  // « Coter avec l'IA »), on choisit automatiquement « Mettre à jour » sans
  // afficher de modale — c'est l'intention implicite de l'utilisateur.
  // Cas : Bastien clique sur des chips puis sur le FAB → veut MAJ, pas une nouvelle ligne.
  if (window._cotFromReCoteFAB) {
    try {
      const _patNomCheck = (gv('f-pt') || '').trim();
      const _dateCheck   = gv('f-ds') || new Date().toISOString().slice(0, 10);
      if (_patNomCheck && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const _allRows = await _idbGetAll(PATIENTS_STORE);
        const _nomLow  = _patNomCheck.toLowerCase();
        const _foundRow = _allRows.find(r =>
          ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
          ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
        );
        if (_foundRow && typeof _dec === 'function') {
          const _foundPat = { ...(_dec(_foundRow._data) || {}), id: _foundRow.id };
          if (Array.isArray(_foundPat.cotations)) {
            const _existIdx = _foundPat.cotations.findIndex(c =>
              (c.date || '').slice(0, 10) === _dateCheck.slice(0, 10)
            );
            if (_existIdx >= 0) {
              const _existCot = _foundPat.cotations[_existIdx];
              window._editingCotation = {
                patientId:      _foundRow.id,
                cotationIdx:    _existIdx,
                invoice_number: _existCot.invoice_number || null,
                _userChose:     true, // bypass définitif pour cette session
                _fromTournee:   (window._editingCotation || {})._fromTournee || false,
                _fromFAB:       true,
                _prevActes:     (_existCot.actes || []).map(a => ({
                  code: a.code, nom: a.nom || '', total: a.total || 0,
                })),
              };
            }
          }
        }
      }
    } catch (_e) { console.warn('[cotation] FAB bypass doublon KO:', _e.message); }
    return true; // Continuer le pipeline directement, sans modale
  }

  try {
    const _patNomCheck = (gv('f-pt') || '').trim();
    const _dateCheck   = gv('f-ds') || new Date().toISOString().slice(0, 10);
    if (!_patNomCheck || typeof _idbGetAll !== 'function' || typeof PATIENTS_STORE === 'undefined') return true;

    const _allRows = await _idbGetAll(PATIENTS_STORE);
    const _nomLow  = _patNomCheck.toLowerCase();
    const _foundRow = _allRows.find(r =>
      ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
      ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
    );
    if (!_foundRow || typeof _dec !== 'function') return true;

    const _foundPat = { ...(_dec(_foundRow._data) || {}), id: _foundRow.id };
    if (!Array.isArray(_foundPat.cotations)) return true;

    // Comparer en YYYY-MM-DD (f-ds retourne ce format, c.date peut être ISO complet)
    const _existIdx = _foundPat.cotations.findIndex(c =>
      (c.date || '').slice(0, 10) === _dateCheck.slice(0, 10)
    );
    if (_existIdx < 0) return true; // Pas de cotation existante → continuer normalement

    // ── Cotation existante détectée → afficher modale de choix ──
    const _existCot = _foundPat.cotations[_existIdx];
    const _total    = parseFloat(_existCot.total || 0).toFixed(2);
    const _invNum   = _existCot.invoice_number || '—';
    const _nomAff   = (_foundPat.prenom || '') + ' ' + (_foundPat.nom || '');
    const _dateAff  = new Date(_dateCheck).toLocaleDateString('fr-FR');

    // Créer la modale de choix
    const _existMod = document.createElement('div');
    _existMod.id = 'cot-doublon-modal';
    _existMod.style.cssText = `
      position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.55);backdrop-filter:blur(4px);padding:20px;
    `;
    _existMod.innerHTML = `
      <div style="background:var(--c);border:1px solid var(--b);border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4)">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <div style="width:42px;height:42px;border-radius:50%;background:rgba(251,191,36,.15);border:2px solid #f59e0b;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">⚠️</div>
          <div>
            <div style="font-weight:700;font-size:15px;color:var(--t)">Cotation déjà existante</div>
            <div style="font-size:12px;color:var(--m);font-family:var(--fm)">Patient · ${_dateAff}</div>
          </div>
        </div>
        <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px;margin-bottom:18px">
          <div style="font-size:13px;font-weight:600;color:var(--t);margin-bottom:4px">${_nomAff.trim()}</div>
          <div style="font-size:11px;color:var(--m);font-family:var(--fm)">
            ${_invNum !== '—' ? `Facture <span style="color:var(--a);font-weight:600">${_invNum}</span> · ` : ''}
            Montant <span style="color:var(--a);font-weight:700">${_total} €</span>
          </div>
          ${(_existCot.actes||[]).length ? `<div style="font-size:11px;color:var(--m);margin-top:4px;font-family:var(--fm)">${(_existCot.actes||[]).map(a=>a.code).join(' + ')}</div>` : ''}
        </div>
        <div style="font-size:13px;color:var(--m);margin-bottom:18px">
          Que souhaitez-vous faire avec cette nouvelle cotation ?
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button id="cot-doublon-update" class="btn bp" style="width:100%;background:var(--a);color:#fff;border-color:var(--a);padding:12px;font-size:14px;font-weight:600;border-radius:10px">
            💾 Mettre à jour la cotation existante
          </button>
          <button id="cot-doublon-new" class="btn bs" style="width:100%;padding:12px;font-size:14px;border-radius:10px">
            ✨ Créer une nouvelle cotation
          </button>
          <button id="cot-doublon-cancel" class="btn" style="width:100%;padding:10px;font-size:13px;color:var(--m);background:transparent;border:1px solid var(--b);border-radius:10px">
            Annuler
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(_existMod);

    // Handlers boutons
    _existMod.querySelector('#cot-doublon-update').onclick = () => {
      _existMod.remove();
      // Poser _editingCotation → mode mise à jour (choix explicite → _userChose pour ne pas re-afficher la modale)
      window._editingCotation = {
        patientId:      _foundRow.id,
        cotationIdx:    _existIdx,
        invoice_number: _existCot.invoice_number || null,
        _userChose:     true, // choix explicite utilisateur → bypass la modale au prochain appel
        _fromTournee:   (window._editingCotation || {})._fromTournee || false,
        // Mémoriser les codes de l'ancienne cotation pour détecter régressions
        // (ex: AMI4 disparu après re-cotation avec une description incomplète)
        _prevActes:     (_existCot.actes || []).map(a => ({
          code: a.code, nom: a.nom || '', total: a.total || 0,
        })),
      };
      onUpdate();
    };
    _existMod.querySelector('#cot-doublon-new').onclick = () => {
      _existMod.remove();
      // Réinitialiser _editingCotation → mode nouvelle cotation
      window._editingCotation = null;
      onNew();
    };
    _existMod.querySelector('#cot-doublon-cancel').onclick = () => {
      _existMod.remove();
    };

    return false; // On attend le choix utilisateur
  } catch (_e) {
    console.warn('[cotation] checkDoublon error:', _e.message);
    return true; // En cas d'erreur → continuer normalement
  }
}

async function cotation() {
  const txt = gv('f-txt');
  if (!txt) { alert('Veuillez saisir une description.'); return; }

  // ── Mode cabinet : pipeline multi-IDE ─────────────────────────────────────
  const cabinetCheckbox = $('cot-cabinet-mode');
  if (cabinetCheckbox?.checked && APP.get('cabinet')?.id) {
    // Check doublon AVANT lancement cotation cabinet (même logique qu'en solo)
    // Si une cotation existe déjà pour ce patient/date → modale Mettre à jour / Nouveau
    const _canContinueCab = await _cotationCheckDoublon(
      () => cotationCabinet(txt), // Mettre à jour → on relance en mode cabinet, _editingCotation posé
      () => cotationCabinet(txt)  // Nouvelle cotation → _editingCotation null, cabinet
    );
    if (!_canContinueCab) return; // Attend le choix utilisateur

    await cotationCabinet(txt);
    return;
  }

  // ── Sinon : pipeline solo (avec vérification doublon) ────────────────────
  await _cotationSolo();
}

/**
 * Pipeline solo = check doublon → pipeline IA.
 * Extrait de cotation() pour être appelable en fallback depuis cotationCabinet()
 * SANS re-déclencher la détection du mode cabinet (qui causerait une récursion infinie :
 *   cotation() → cotationCabinet() → cotation() → cotationCabinet() → …).
 */
async function _cotationSolo() {
  const txt = gv('f-txt');
  if (!txt) { alert('Veuillez saisir une description.'); return; }

  // ── Vérification doublon AVANT l'appel IA ────────────────────────────────
  // Si une cotation existe déjà pour ce patient à cette date,
  // proposer Mettre à jour ou Nouvelle cotation.
  const _canContinue = await _cotationCheckDoublon(
    () => _cotationPipeline(), // Mettre à jour → pipeline en mode édition
    () => _cotationPipeline()  // Nouvelle cotation → pipeline sans _editRef
  );
  if (!_canContinue) return; // Attend le choix utilisateur

  await _cotationPipeline();
}

async function _cotationPipeline() {
  const txt = gv('f-txt');
  if (!txt) { alert('Veuillez saisir une description.'); return; }

  // ── Check consentement avant acte (médico-légal) ───────────────────────
  // Hook vers consentements.js — détecte automatiquement les types requis
  // à partir du texte libre. Si un consentement manque :
  //   - mode normal : warning + possibilité de continuer (loggé)
  //   - mode STRICT : blocage + redirection vers signature
  try {
    if (typeof consentCheckBeforeAct === 'function') {
      // Résoudre l'ID patient depuis le carnet
      const _patNom = (gv('f-pt') || '').trim();
      let _patIdForCheck = null;
      if (_patNom && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const _rows = await _idbGetAll(PATIENTS_STORE);
        const _low = _patNom.toLowerCase();
        const _match = _rows.find(r =>
          ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_low) ||
          ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_low)
        );
        if (_match) _patIdForCheck = _match.id;
      }
      if (_patIdForCheck) {
        const _ck = await consentCheckBeforeAct(_patIdForCheck, txt);
        if (_ck && !_ck.allowed && _ck.level === 'BLOCK') {
          // Mode STRICT : bloquer et rediriger vers signature
          if (typeof showToast === 'function')
            showToast('error', 'Consentement requis',
              `Manquant : ${(_ck.types_label || []).join(', ')}`);
          if (typeof window.navigate === 'function') window.navigate('consentements');
          setTimeout(() => { if (typeof consentSelectPatient === 'function') consentSelectPatient(_patIdForCheck); }, 300);
          return;
        }
        if (_ck && !_ck.allowed === false && _ck.level === 'WARN') {
          // Mode normal : avertissement non bloquant
          if (typeof showToast === 'function')
            showToast('warning', 'Consentement à compléter',
              `${(_ck.types_label || []).join(', ')} — acte loggé pour traçabilité`);
          if (typeof auditLog === 'function')
            auditLog('ACT_WITHOUT_CONSENT', { patient_id: _patIdForCheck, types: _ck.types });

          // ⚡ Mémoriser les consentements manquants pour auto-création à la signature.
          //    Quand l'infirmière cliquera sur "Faire signer le patient" après cotation,
          //    signature.js créera automatiquement le(s) consentement(s) pré-rempli(s)
          //    avec la signature saisie, le type détecté, et la date du soin.
          //    Pas de signature pour le moment → pas de consentement créé (juste mémorisé).
          window._pendingConsentsForPatient = window._pendingConsentsForPatient || {};
          window._pendingConsentsForPatient[_patIdForCheck] = {
            patient_id:  _patIdForCheck,
            patient_nom: _patNom,
            types:       _ck.types || [],
            types_label: _ck.types_label || [],
            actes_text:  txt,
            created_at:  Date.now(),
          };
        }
      }
    }
  } catch (_consentCheckErr) {
    console.warn('[cotation] consent check KO:', _consentCheckErr.message);
    // Non bloquant — continue la cotation
  }

  ld('btn-cot', true);
  $('res-cot').classList.remove('show');
  $('cerr').style.display = 'none';

  // ── Feedback progressif si l'IA est lente (Grok cold start) ──
  const _btnEl = $('btn-cot');
  const _origBtnHTML = _btnEl ? _btnEl.innerHTML : null;
  const _slowTimers = [];
  const _showSlowMsg = (msg) => { if (_btnEl) _btnEl.innerHTML = `<span style="font-size:12px;font-weight:400">${msg}</span>`; };
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Analyse NGAP en cours…'),           5000));
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Calcul en cours — merci de patienter…'), 15000));
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Encore quelques secondes…'),        30000));
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Dernière tentative…'),               44000));
  const _clearSlowTimers = () => {
    _slowTimers.forEach(t => clearTimeout(t));
    if (_btnEl && _origBtnHTML) _btnEl.innerHTML = _origBtnHTML;
  };

  const u = S?.user || {};
  try {
    // Récupérer le prescripteur sélectionné (select ou champ texte libre)
    const prescSel = $('f-prescripteur-select');
    const prescripteur_id = prescSel?.value || null;

    // ── Correction heure soin ───────────────────────────────────────────────
    // Si f-hs n'a pas été édité manuellement (_userEdited) ET qu'on n'est PAS
    // en mode édition d'une cotation existante → utiliser l'heure courante.
    // En mode édition (_editingCotation posé), on conserve l'heure d'origine.
    const _fHsEl = document.getElementById('f-hs');
    const _isEditMode = !!(window._editingCotation && (window._editingCotation.invoice_number || window._editingCotation.cotationIdx != null));
    if (_fHsEl && !_fHsEl._userEdited && !_isEditMode) {
      const _now = new Date();
      _fHsEl.value = String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0');
    }

    // ── Auto-détection mode édition ─────────────────────────────────────────
    // Si _editingCotation n'est pas encore positionné, vérifier dans l'IDB
    // si une cotation existe déjà pour ce patient à cette date.
    // Si oui → forcer le mode édition pour éviter tout doublon.
    if (!window._editingCotation) {
      try {
        const _patNomCheck = (gv('f-pt') || '').trim();
        const _dateCheck   = gv('f-ds') || new Date().toISOString().slice(0, 10);
        if (_patNomCheck && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
          const _allRows = await _idbGetAll(PATIENTS_STORE);
          const _nomLow  = _patNomCheck.toLowerCase();
          const _foundRow = _allRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
          );
          if (_foundRow && typeof _dec === 'function') {
            const _foundPat = { ...(_dec(_foundRow._data) || {}), id: _foundRow.id };
            if (Array.isArray(_foundPat.cotations)) {
              // Chercher une cotation existante à la même date (comparaison YYYY-MM-DD)
              const _existIdx = _foundPat.cotations.findIndex(c =>
                (c.date || '').slice(0, 10) === _dateCheck.slice(0, 10)
              );
              if (_existIdx >= 0) {
                const _existCot = _foundPat.cotations[_existIdx];
                // Renseigner automatiquement _editingCotation
                window._editingCotation = {
                  patientId:    _foundRow.id,
                  cotationIdx:  _existIdx,
                  invoice_number: _existCot.invoice_number || null,
                  _autoDetected: true, // flag : positionné automatiquement (pas par l'utilisateur)
                  // Mémoriser les codes de l'ancienne cotation pour détecter régressions
                  _prevActes:   (_existCot.actes || []).map(a => ({
                    code: a.code, nom: a.nom || '', total: a.total || 0,
                  })),
                };
              }
            }
          }
        }
      } catch (_autoDetectErr) {
        // Non bloquant — si la détection échoue, comportement normal
        console.warn('[cotation] auto-détection doublon:', _autoDetectErr.message);
      }
    }

    // Si mode édition, passer l'invoice_number original pour upsert Supabase
    const _editRef = window._editingCotation || null;

    // ── Pré-résolution patient IDB ─────────────────────────────────────────
    // Nécessaire pour envoyer patient_id à planning_patients AVANT le résultat IA
    let _prePatientId = _editRef?.patientId || null;
    if (!_prePatientId) {
      try {
        const _patNomPre = (gv('f-pt') || '').trim();
        if (_patNomPre && typeof _idbGetAll === 'function') {
          const _preRows = await _idbGetAll(PATIENTS_STORE);
          const _nomPre  = _patNomPre.toLowerCase();
          const _preRow  = _preRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomPre) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomPre)
          );
          if (_preRow) _prePatientId = _preRow.id;
        }
      } catch (_) {}
    }
    // ── Preuve soin (N8N v7) — bouclier anti-redressement CPAM ──
    // La photo / signature ne sont JAMAIS transmises — uniquement leur hash
    // La géolocalisation est floue (département uniquement — RGPD compatible)
    const _sigEl = document.querySelector('[data-last-sig-hash]');
    const _sigHash = _sigEl?.dataset?.lastSigHash || '';
    const _preuveType = _sigHash ? 'signature_patient' : 'auto_declaration';
    const _preuveForce = _sigHash ? 'FORTE' : 'STANDARD';

    // Si on est passé par le FAB « Re-coter avec les ajouts », on force N8N :
    // l'utilisateur a explicitement cliqué pour AVOIR une vraie correction IA,
    // pas un fallback local.
    const _viaFab = !!window._cotFromReCoteFAB;

    // ⚡ « Coter avec l'IA » FORCE N8N PAR DÉFAUT (intention utilisateur claire).
    // Stratégie en deux temps :
    //   1) 1er appel avec _force_n8n: true → tente vraiment N8N (bypass cache,
    //      circuit breaker, smart engine). Si N8N répond → on a la vraie IA.
    //   2) Si N8N indisponible (502) → 2ème appel automatique SANS _force_n8n
    //      → le worker bascule sur Smart Engine v8 + RL + fallback NGAP local.
    // Garantit toujours une réponse, tout en privilégiant l'IA réelle.
    // L'utilisateur ne voit pas la différence et n'a rien à cliquer.

    const _basePayload = {
      mode: 'ngap', texte: txt,
      infirmiere: ((u.prenom || '') + ' ' + (u.nom || '')).trim(),
      adeli: u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      ddn: gv('f-ddn'), amo: gv('f-amo'), amc: gv('f-amc'),
      exo: gv('f-exo'), regl: gv('f-regl'),
      date_soin: gv('f-ds'), heure_soin: gv('f-hs'),
      prescripteur_nom: gv('f-pr') || '',
      prescripteur_rpps: gv('f-pr-rp') || '',
      date_prescription: gv('f-pr-dt') || '',
      ...(prescripteur_id ? { prescripteur_id } : {}),
      // patient_nom → affiché dans l'historique (champ f-pt)
      ...((gv('f-pt') || '').trim() ? { patient_nom: (gv('f-pt') || '').trim() } : {}),
      // patient_id IDB → rattachement cotation ↔ fiche dans planning_patients
      ...(_prePatientId ? { patient_id: _prePatientId } : {}),
      // invoice_number existant → le worker fera un PATCH au lieu d'un POST
      ...(_editRef?.invoice_number ? { invoice_number: _editRef.invoice_number } : {}),
      // Preuve soin — N8N v7 : hash uniquement, jamais les données brutes
      preuve_soin: {
        type:         _preuveType,
        timestamp:    new Date().toISOString(),
        hash_preuve:  _sigHash,
        certifie_ide: true,
        force_probante: _preuveForce,
      },
    };

    let d;
    let _usedFallback = false;
    try {
      // 1ère tentative : force N8N (vraie IA)
      d = await apiCall('/webhook/ami-calcul', {
        ..._basePayload,
        _force_n8n: true,
        ...(_viaFab ? { _from_fab: true } : {}),
      });
      // Si le worker renvoie ok:false avec _force_n8n:true → c'est aussi un échec
      if (d && d.ok === false && d._force_n8n) {
        throw new Error(d.error || 'force_n8n_failed');
      }
    } catch (_n8nErr) {
      const errMsg = _n8nErr?.message || '';
      const is502 = /502|service.*indisponible|n8n.*indisponible|n8n_unavailable|force_n8n_failed/i.test(errMsg);
      if (!is502) {
        // Erreur autre que N8N down → propager
        throw _n8nErr;
      }
      // N8N down : retry avec Smart Engine v8 + fallback worker
      console.info('[cotation] N8N indisponible → bascule sur Smart Engine v8 (worker)');
      _usedFallback = true;
      d = await apiCall('/webhook/ami-calcul', _basePayload);
      // Marqueur visuel discret pour informer l'utilisateur
      d.alerts = d.alerts || [];
      d.alerts.unshift('ℹ️ N8N (IA distante) temporairement indisponible — cotation calculée par le moteur Smart Engine v8 du serveur.');
    }
    if (d.error) throw new Error(d.error);

    // ══ FALLBACK NGAP LOCAL ══
    // Si N8N renvoie 0 acte (ou que des majorations), on tente d'extraire les
    // codes NGAP directement depuis le textarea via _cotExtractNgapChips et le
    // moteur local NGAPEngine. Évite le « Aucun acte détecté » sur des textes
    // contenant des codes explicites mais pas de verbe d'action (ex. issu du FAB).
    try {
      const _CODES_MAJ = new Set(['DIM','NUIT','NUIT_PROF','IFD','IFI','MIE','MCI','IK']);
      const _hasTech = (d.actes || []).some(a => !_CODES_MAJ.has(String(a.code||'').toUpperCase()));
      if (!_hasTech && typeof _cotExtractNgapChips === 'function') {
        const enriched = _cotEnrichWithLocalEngine(d, txt);
        if (enriched && enriched.actes && enriched.actes.length > (d.actes||[]).length) {
          // Conserver les métadonnées N8N (alerts, suggestions, cpam_simulation…)
          // mais remplacer les actes/totaux par ceux du moteur local
          Object.assign(d, {
            actes:        enriched.actes,
            total:        enriched.total,
            part_amo:     enriched.part_amo,
            part_amc:     enriched.part_amc,
            part_patient: enriched.part_patient,
            _local_engine_used: true,
          });
          // Marqueur visuel discret dans alerts
          d.alerts = d.alerts || [];
          d.alerts.unshift('ℹ️ Cotation calculée localement (moteur NGAP) — N8N indisponible ou texte sans verbe d\'action');
        }
      }
    } catch (_engErr) {
      console.warn('[cotation] Fallback NGAP local KO:', _engErr.message);
    }

    // Afficher le numéro de facture retourné par le worker (séquentiel CPAM)
    if (d.invoice_number && typeof displayInvoiceNumber === 'function') {
      displayInvoiceNumber(d.invoice_number);
    }
    // ── Mettre à jour _editingCotation avec l'invoice_number final ───────────
    // Garantit que toute re-cotation (ex : Vérifier→Corriger→Coter) fait un
    // PATCH Supabase et non un INSERT, évitant les doublons dans l'historique.
    if (d.invoice_number) {
      const _existRef = window._editingCotation;
      window._editingCotation = {
        patientId:      _existRef?.patientId      || null,
        cotationIdx:    _existRef?.cotationIdx     ?? -1,
        invoice_number: d.invoice_number,
        _autoDetected:  _existRef?._autoDetected   || false,
        // Préserver _prevActes pour que renderCot puisse continuer à détecter
        // les régressions d'acte principal entre les re-cotations successives
        _prevActes:     _existRef?._prevActes      || null,
      };
    }
    // ── Mémoriser l'heure de soin dans le cache persistant (analyse horaire Dashboard) ──
    // Permet à l'analyse horaire de fonctionner même sans recharger l'historique API.
    try {
      if (typeof _updateHeureCache === 'function') {
        const heure = gv('f-hs');
        const date  = gv('f-ds') || new Date().toISOString().slice(0,10);
        if (heure) {
          _updateHeureCache([{
            id:         d.invoice_number || ('local_' + Date.now()),
            date_soin:  date,
            heure_soin: heure,
          }]);
        }
      }
    } catch {}
    _clearSlowTimers();
    $('cbody').innerHTML = renderCot(d);
    $('res-cot').classList.add('show');

    // ── Upsert cotation dans le carnet patient (IDB) ───────────────────────
    // RÈGLE STRICTE :
    //   • Patient existant → toujours upsert (mise à jour), jamais de doublon
    //   • Patient absent du carnet → créer la fiche + la cotation (1 seule fois)
    try {
      const _patNom = (gv('f-pt') || '').trim();
      if (_patNom && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const _patRows = await _idbGetAll(PATIENTS_STORE);

        // Recherche par ID (mode édition) puis par nom exact/partiel
        let _patRow = _editRef?.patientId
          ? _patRows.find(r => r.id === _editRef.patientId)
          : null;
        if (!_patRow) {
          const _nomLow = _patNom.toLowerCase();
          _patRow = _patRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
          );
        }

        const _invNum = d.invoice_number || _editRef?.invoice_number || null;
        const _cotDate = gv('f-ds') || new Date().toISOString().slice(0,10);

        // Guard : ne pas sauvegarder si aucun acte technique (juste des majorations DIM/NUIT/IFD)
        const _CODES_MAJ_CHK = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
        const _actesTechCheck = (d.actes || []).filter(a => !_CODES_MAJ_CHK.has((a.code||'').toUpperCase()));
        if (!_actesTechCheck.length && !_editRef) {
          // Affichage OK mais on ne pollue pas le carnet avec une cotation incomplète
          console.warn('[cotation] IDB save ignoré — pas d\'acte technique:', (d.actes||[]).map(a=>a.code));
          throw new Error('__SKIP_IDB__'); // intercepté par le catch local ci-dessous
        }

        const _newCot = {
          date:           _cotDate,
          heure:          gv('f-hs') || '',
          actes:          d.actes || [],
          total:          parseFloat(d.total || 0),
          part_amo:       parseFloat(d.part_amo || 0),
          part_amc:       parseFloat(d.part_amc || 0),
          part_patient:   parseFloat(d.part_patient || 0),
          soin:           txt.slice(0, 120),
          invoice_number: _invNum,
          source:         _editRef ? 'cotation_edit' : 'cotation_form',
          _synced:        true,
        };

        if (_patRow) {
          // ── Patient existant → upsert strict ──────────────────────────
          const _pat = { id: _patRow.id, nom: _patRow.nom, prenom: _patRow.prenom, ...(_dec(_patRow._data)||{}) };
          if (!Array.isArray(_pat.cotations)) _pat.cotations = [];

          // Résoudre l'index à mettre à jour (ordre de priorité)
          let _idx = -1;
          // 1. cotationIdx direct (depuis fiche patient / carnet)
          if (typeof _editRef?.cotationIdx === 'number' && _editRef.cotationIdx >= 0)
            _idx = _editRef.cotationIdx;
          // 2. Par invoice_number retourné par l'API
          if (_idx < 0 && _invNum)
            _idx = _pat.cotations.findIndex(c => c.invoice_number === _invNum);
          // 3. Par invoice_number original du ref (cas correction post-tournée / planning)
          if (_idx < 0 && _editRef?.invoice_number)
            _idx = _pat.cotations.findIndex(c => c.invoice_number === _editRef.invoice_number);
          // 4. Par date YYYY-MM-DD — UNIQUEMENT pour vrai mode édition.
          //    Si l'utilisateur a cliqué "✨ Nouvelle cotation" dans la modale doublon,
          //    _editRef vaut { _userChose: true } SANS cotationIdx/invoice_number → on
          //    skip ce fallback pour respecter le choix utilisateur (sinon upsert
          //    silencieux de l'ancienne cotation au lieu de créer une nouvelle).
          const _isForceNewSolo = _editRef?._userChose && !_editRef?.cotationIdx && !_editRef?.invoice_number;
          if (_idx < 0 && _editRef && _cotDate && !_isForceNewSolo) {
            _idx = _pat.cotations.findIndex(c =>
              (c.date || '').slice(0, 10) === _cotDate.slice(0, 10)
            );
          }

          if (_idx >= 0) {
            // Cotation existante trouvée → mettre à jour (upsert)
            _pat.cotations[_idx] = { ..._pat.cotations[_idx], ..._newCot, date_edit: new Date().toISOString() };
          } else if (!_editRef || _isForceNewSolo) {
            // Pas en mode édition OU choix explicite "Nouvelle cotation" → push
            _pat.cotations.push(_newCot);
          }
          // Si _editRef avec cotationIdx/invoice_number mais pas d'index trouvé → ne rien faire (évite les doublons)

          _pat.updated_at = new Date().toISOString();
          const _toStore1 = { id: _pat.id, nom: _pat.nom, prenom: _pat.prenom, _data: _enc(_pat), updated_at: _pat.updated_at };
          await _idbPut(PATIENTS_STORE, _toStore1);
          // Sync immédiate vers carnet_patients — propagation inter-appareils
          if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore1).catch(() => {});

        } else if (!_editRef) {
          // ── Patient absent du carnet → créer la fiche + la cotation ──
          // Uniquement si ce n'est pas une correction (mode édition)
          const _parts = _patNom.trim().split(/\s+/);
          const _prenom = _parts.slice(0, -1).join(' ') || _patNom;
          const _nom    = _parts.length > 1 ? _parts[_parts.length - 1] : '';
          const _newPat = {
            id:         'pat_' + Date.now(),
            nom:        _nom,
            prenom:     _prenom,
            ddn:        gv('f-ddn') || '',
            amo:        gv('f-amo') || '',
            amc:        gv('f-amc') || '',
            exo:        gv('f-exo') || '',
            medecin:    gv('f-pr')  || '',
            cotations:  [_newCot],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            source:     'cotation_auto',
          };
          const _toStore2 = {
            id:         _newPat.id,
            nom:        _nom,
            prenom:     _prenom,
            _data:      _enc(_newPat),
            updated_at: _newPat.updated_at,
          };
          await _idbPut(PATIENTS_STORE, _toStore2);
          // Sync immédiate vers carnet_patients — propagation inter-appareils
          if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore2).catch(() => {});
          if (typeof showToast === 'function')
            showToast('👤 Fiche patient créée automatiquement pour ' + _patNom);
        }
      }
    } catch(_idbErr) { if (_idbErr.message !== '__SKIP_IDB__') console.warn('[cotation] IDB save KO:', _idbErr.message); }

    // ── 🛡️ Vérification post-cotation Carnet → Historique des soins ────────
    // Quand la cotation a été initiée depuis le Carnet patients
    // (coterDepuisPatient → _editingCotation._fromCarnet:true), on vérifie
    // après quelques secondes que la ligne est bien arrivée dans
    // planning_patients (ce qui alimente l'Historique des soins).
    // Si absente → relance ami-save-cotation avec upsert tri-critères
    // côté worker (zéro risque de doublon).
    try {
      if ((_editRef?._fromCarnet || _editRef?._fromTournee) && d?.invoice_number && typeof _ensureCotationInHistorique === 'function') {
        // Résoudre le patient_id IDB si pas encore connu
        let _patIdEnsure = _editRef.patientId || null;
        if (!_patIdEnsure) {
          const _patNomE = (gv('f-pt') || '').trim();
          if (_patNomE && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
            const _rowsE = await _idbGetAll(PATIENTS_STORE);
            const _lowE  = _patNomE.toLowerCase();
            const _hitE  = _rowsE.find(r =>
              ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_lowE) ||
              ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_lowE)
            );
            if (_hitE) _patIdEnsure = _hitE.id;
          }
        }
        const _ensureCot = {
          actes:          d.actes || [],
          total:          parseFloat(d.total || 0),
          date_soin:      gv('f-ds') || new Date().toISOString().slice(0,10),
          heure_soin:     gv('f-hs') || null,
          soin:           (txt || '').slice(0, 200),
          invoice_number: d.invoice_number,
          source:         _editRef ? 'carnet_edit' : 'carnet_form',
          patient_id:     _patIdEnsure || undefined,
          patient_nom:    (gv('f-pt') || '').trim(),
          part_amo:       parseFloat(d.part_amo || 0),
          part_amc:       parseFloat(d.part_amc || 0),
          part_patient:   parseFloat(d.part_patient || 0),
        };
        setTimeout(() => {
          _ensureCotationInHistorique({
            invoice_number: d.invoice_number,
            cotation:       _ensureCot,
          }).catch(() => {});
        }, 4000);
      }
    } catch (_ensureErr) { console.warn('[cotation] Hook ensureHistorique KO:', _ensureErr.message); }

    // ── Déclencher la signature après cotation ──────────────────────────────
    // Dispatch ami:cotation_done pour signature.js + injection directe du bouton
    const _invoiceId = d.invoice_number || null;
    if (_invoiceId) {  // admin inclus — peut tester et démontrer la signature

      // ⚡ Transférer les consentements en attente (patient → invoice) pour que
      //    saveSignature puisse créer automatiquement le(s) consentement(s)
      //    pré-rempli(s) avec la signature, le type d'acte et la date.
      //    Extrait le _patIdForCheck mémorisé plus haut dans le scope.
      let _patIdResolved = null;
      try {
        const _pnCurrent = (gv('f-pt') || '').trim();
        if (_pnCurrent && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
          const _rows2 = await _idbGetAll(PATIENTS_STORE);
          const _lowC = _pnCurrent.toLowerCase();
          const _m2 = _rows2.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_lowC) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_lowC)
          );
          if (_m2) _patIdResolved = _m2.id;
        }
      } catch (_) {}

      const _pendingForPatient = _patIdResolved
        ? window._pendingConsentsForPatient?.[_patIdResolved]
        : null;

      if (_pendingForPatient) {
        window._pendingConsentsByInvoice = window._pendingConsentsByInvoice || {};
        window._pendingConsentsByInvoice[_invoiceId] = {
          ..._pendingForPatient,
          invoice_number: _invoiceId,
          date_soin:      d.date_soin || new Date().toISOString().slice(0, 10),
          created_at:     Date.now(),  // utilisé par le TTL de signature.js
        };
      }

      // Injection directe du bouton de signature dans la card résultat
      const _cbody = $('cbody');
      if (_cbody && !_cbody.querySelector('.sig-btn-wrap')) {
        const _wrap = document.createElement('div');
        _wrap.className = 'sig-btn-wrap';
        _wrap.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--b);display:flex;align-items:center;gap:12px;flex-wrap:wrap';

        // Badge visible si consentement(s) à créer à la signature
        const _consentBadge = _pendingForPatient
          ? `<span style="font-size:10px;background:rgba(255,181,71,.12);color:var(--w);border:1px solid rgba(255,181,71,.3);padding:3px 8px;border-radius:20px;font-family:var(--fm)">📄 Consentement sera ajouté : ${(_pendingForPatient.types_label || []).join(', ')}</span>`
          : '';

        _wrap.innerHTML = `
          <button class="btn bv bsm" id="sig-btn-${_invoiceId}" data-sig="${_invoiceId}"
            onclick="openSignatureModal('${_invoiceId}', { patient_id: '${_patIdResolved || ''}', invoice_number: '${_invoiceId}' })">
            ✍️ Faire signer le patient
          </button>
          <span style="font-size:11px;color:var(--m)">Signature stockée localement · non transmise</span>
          ${_consentBadge}`;
        _cbody.querySelector('.card')?.appendChild(_wrap);
      }
      // Dispatch pour tout listener externe
      document.dispatchEvent(new CustomEvent('ami:cotation_done', { detail: { invoice_number: _invoiceId } }));
    }
    // ── Nettoyer _editingCotation après pipeline ──────────────────────────────
    // Couvre : auto-détection, choix explicite modale, et résolution depuis tournée/planning
    if (window._editingCotation?._autoDetected ||
        window._editingCotation?._userChose ||
        window._editingCotation?._fromTournee) {
      window._editingCotation = null;
    }

  } catch (e) {
    // Nettoyer aussi en cas d'erreur
    if (window._editingCotation?._autoDetected ||
        window._editingCotation?._userChose ||
        window._editingCotation?._fromTournee) {
      window._editingCotation = null;
    }
    // Une re-cotation en erreur → retire le FAB (évite qu'il reste loading indéfiniment)
    try { if (typeof _cotHideReCoteBar === 'function') _cotHideReCoteBar(); } catch (_) {}
    _clearSlowTimers();
    $('cerr').style.display = 'flex';
    // Message plus clair selon le type d'erreur
    const msgRaw = e.message || '';
    const isSlowTimeout = msgRaw.includes("prend plus de temps");
    const is502N8N = /502|N8N|Service de v[eé]rification IA/i.test(msgRaw);
    let userMsg = msgRaw;
    if (isSlowTimeout) {
      userMsg = "⏱️ L'IA a mis trop de temps à répondre. Réessayez ou utilisez « Cotation rapide NGAP » pour un calcul local immédiat.";
    } else if (is502N8N) {
      userMsg = "🤖 Service IA temporairement indisponible (cold-start ou erreur réseau). Réessayez dans 15-30s ou utilisez « Cotation rapide NGAP » pour un calcul local immédiat.";
    }
    $('cerr-m').innerHTML = userMsg + (
      is502N8N || isSlowTimeout
        ? `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
             <button class="btn bp bsm" onclick="cotation()">🔄 Réessayer N8N</button>
             <button class="btn bs bsm" onclick="cotationLocaleNGAP()">⚡ Cotation locale NGAP</button>
           </div>`
        : ''
    );
    $('res-cot').classList.add('show');
  }
  ld('btn-cot', false);
}

/* ═══════════════════════════════════════════════════════════════════════════
   COTATION LOCALE NGAP : calcule directement avec _cotMinimalLocalCalc
   sans appeler N8N. Utile quand le service IA est down ou pour gagner du
   temps sur des cotations simples. Bouton dédié ajouté dans l'UI.
   ═══════════════════════════════════════════════════════════════════════════ */
async function cotationLocaleNGAP() {
  const txt = (gv('f-txt') || '').trim();
  if (!txt) { alert('Veuillez saisir une description.'); return; }
  ld('btn-cot-local', true);
  // Cacher l'erreur précédente s'il y en a une
  const cerr = $('cerr'); if (cerr) cerr.style.display = 'none';
  try {
    // 1) Extraire les codes NGAP du textarea (codes explicites)
    let codes = _cotExtractCodesFromText(txt);

    // 2) Si aucun code explicite trouvé, utiliser un mini-NLP texte→code pour
    //    les actes courants saisis en langage naturel (« injection insuline »)
    if (!codes.length) {
      codes = _cotInferCodesFromText(txt);
    }

    const result = _cotMinimalLocalCalc(
      codes,
      { part_amo: null, part_amc: null, part_patient: null }
    );
    if (!result || !result.actes || !result.actes.length) {
      throw new Error('Aucun code NGAP reconnu dans la description. Essayez un format clair comme : "AMI 4 + MCI", "injection insuline", "perfusion 1h", "pansement complexe", ou cliquez sur « Coter avec l\'IA » pour la détection IA complète.');
    }
    // 2) Composer l'objet d compatible avec renderCot
    const d = {
      actes:        result.actes,
      total:        result.total,
      part_amo:     result.part_amo,
      part_amc:     result.part_amc,
      part_patient: result.part_patient,
      alerts:       ['ℹ️ Cotation calculée localement (mode NGAP rapide, sans IA) — utilisez « Coter avec l\'IA » pour la validation IA complète.'],
      optimisations: [],
      suggestions_optimisation: [],
      _local_only:  true,
      _ngap_version: (typeof _COT_NGAP_VERSION !== 'undefined' ? _COT_NGAP_VERSION : 'NGAP 2026'),
    };
    // 3) Render
    renderCot(d);
    if (typeof showToast === 'function') {
      showToast(`✅ Cotation locale NGAP : ${result.total.toFixed(2)} €`, 'su');
    }

    // ── 🛡️ RENFORCEMENT « Carnet → Historique des soins » ──────────────────
    // Le mode local NGAP ne passait PAS par /webhook/ami-calcul → la cotation
    // n'arrivait jamais dans planning_patients (Historique). On corrige :
    //   1. Persistance IDB stricte (mêmes règles upsert que cotation IA).
    //   2. Push synchrone vers /webhook/ami-save-cotation (tri-critères
    //      worker : invoice_number > patient_id+date_soin > patient_nom+date_soin).
    //   3. Si offline → mise en file via queueCotation (replay automatique).
    //
    // Respecte la doctrine upsert :
    //   • Patient existant + _editRef + idx trouvé → MAJ
    //   • Patient existant + pas _editRef          → 1ère cotation (push)
    //   • Patient existant + _editRef + pas d'idx  → rien (évite doublon)
    //   • Patient absent + pas _editRef            → crée fiche + cotation
    //   • Patient absent + _editRef                → rien (pas de fiche fantôme)
    try { await _cotationLocalPersist(d, txt); }
    catch (_pErr) { console.warn('[cotation] Persistance locale KO:', _pErr.message); }
  } catch (e) {
    if (cerr) {
      cerr.style.display = 'flex';
      $('cerr-m').textContent = e.message;
      $('res-cot').classList.add('show');
    } else {
      alert(e.message);
    }
  } finally {
    ld('btn-cot-local', false);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MINI-NLP : convertit du langage naturel en codes NGAP officiels.
   Utilisé par cotationLocaleNGAP() quand l'utilisateur saisit du texte libre
   (« injection insuline + perfusion 3x/semaine ») au lieu de codes explicites.
   Retourne un tableau [{code: 'AMI1'}, {code: 'AMI9'}, ...] compatible avec
   _cotMinimalLocalCalc.
   ═══════════════════════════════════════════════════════════════════════════ */
function _cotInferCodesFromText(txt) {
  const s = String(txt || '').toLowerCase();
  if (!s) return [];

  // Table de mapping : motif (regex) → code NGAP
  // Ordonné du plus spécifique au plus générique
  // ⚠️ Si group=true, dès qu'un mapping de ce groupe match, on saute les
  //    autres mappings du même groupe (évite double match perfusion >1h ET perfusion seul).
  const mappings = [
    // ── Perfusions (groupe « perfusion ») ──────────────────────────────
    { re: /perfusion\s*(?:>|sup[eé]rieure?\s*[aà]?)\s*1\s*h|perfusion\s+longue|perfusion\s+>\s*1h/, code: 'AMI14', group: 'perfusion' },
    { re: /perfusion\s*(?:<|inf[eé]rieure?\s*[aà]?)\s*1\s*h|perfusion\s+courte|perfusion\s+<\s*1h/, code: 'AMI9', group: 'perfusion' },
    { re: /perfusion\b(?!\s*(?:de|du|en|sous))/, code: 'AMI9', group: 'perfusion' }, // perfusion par défaut
    // ── Injections (groupe « injection ») ──────────────────────────────
    { re: /injection\s+insuline|insuline\s+(?:sous-cutan[eé]e|sc|sous\s*cutan)/, code: 'AMI1', group: 'injection' },
    { re: /injection\s+(?:sous-?cutan[eé]e|sc|im|intra-?musculaire|hbpm|h[eé]parine|anticoagulant|vaccin)/, code: 'AMI1', group: 'injection' },
    { re: /injection\s+intra-?veineuse|injection\s+iv\b/, code: 'AMI2', group: 'injection' },
    // ── Pansements (groupe « pansement ») ──────────────────────────────
    { re: /pansement\s+(?:complexe|lourd|cicatris)|pansement\s+(?:escarre|ulc[eè]re|n[eé]crose|br[uû]l[uû]re)/, code: 'AMI4', group: 'pansement' },
    { re: /pansement\s+(?:simple|l[eé]ger|sec)|pansement\b(?!\s+(?:complexe|simple|lourd|escarre|ulc))/, code: 'AMI2', group: 'pansement' },
    // ── Dialyse / soins spécialisés (groupe « dialyse ») ───────────────
    { re: /dialyse\s+p[eé]riton[eé]ale|dpa\b|dpac\b/, code: 'AMI14', group: 'dialyse' },
    { re: /chambre\s+implantable|picc-?line|cathe?ter\s+central/, code: 'AMI9', group: 'catheter' },
    // ── Glycémie / soins courants ──────────────────────────────────────
    { re: /glyc[eé]mie\s+capillaire|hgt\b|dextro\b/, code: 'AMI1', group: 'glycemie' },
    { re: /prise\s+de\s+sang|pr[eé]l[eè]vement\s+sanguin/, code: 'AMI1', group: 'prelevement' },
    { re: /sond(?:age|e)\s+(?:urinaire|v[eé]sical)|sondage\s+a\s+demeure/, code: 'AMI4', group: 'sondage' },
    { re: /lavement\s+[eé]vacuateur/, code: 'AMI3', group: 'lavement' },
    { re: /a[eé]rosol|n[eé]bulisation/, code: 'AMI1', group: 'aerosol' },
    // ── BSI (groupe « bsi ») ────────────────────────────────────────────
    { re: /bsi\s+(?:autonome|patient\s+autonome)|bsa\b/, code: 'BSA', group: 'bsi' },
    { re: /bsi\s+(?:l[eé]g[eè]re?\s+perte|d[eé]pendance\s+l[eé]g[eè]re)|bsb\b/, code: 'BSB', group: 'bsi' },
    { re: /bsi\s+(?:lourde\s+perte|d[eé]pendance\s+lourde)|bsc\b/, code: 'BSC', group: 'bsi' },
    { re: /bilan\s+soins?\s+infirmiers?|bsi\b/, code: 'BSB', group: 'bsi' }, // BSI par défaut
    // ── Surveillance / ulcère stade ────────────────────────────────────
    { re: /surveillance\s+(?:thérapeutique|continue|post-op)/, code: 'AMI4', group: 'surveillance' },
    { re: /ulc[eè]re\s+stade\s+(?:3|4|iii|iv)|escarre\s+stade\s+(?:3|4|iii|iv)/, code: 'AMI4', group: 'ulcere' },
  ];

  const found = [];
  const seen = new Set();
  const matchedGroups = new Set();
  for (const { re, code, group } of mappings) {
    // Si un mapping du même groupe a déjà matché, on saute
    if (group && matchedGroups.has(group)) continue;
    if (re.test(s) && !seen.has(code)) {
      seen.add(code);
      found.push({ code });
      if (group) matchedGroups.add(group);
    }
  }

  // ── Majorations contextuelles ──────────────────────────────────────────
  // MCI : explicitement mentionnée
  if (/\bmci\b|coordination\s+infirm/i.test(s) && !seen.has('MCI')) {
    seen.add('MCI'); found.push({ code: 'MCI' });
  }
  // MIE : enfant de moins de 7 ans
  if (/(enfant|nourrisson|p[eé]diatrique)\s*(?:de|<|moins\s+de)?\s*(?:[1-6]|sept|7)\s*ans?/i.test(s) && !seen.has('MIE')) {
    seen.add('MIE'); found.push({ code: 'MIE' });
  }
  // IFD : déplacement mentionné explicitement
  if (/\bifd\b|d[eé]placement|domicile/i.test(s) && !seen.has('IFD')) {
    seen.add('IFD'); found.push({ code: 'IFD' });
  }
  // Note : NUIT et DIM sont gérés automatiquement par renderCot selon l'heure

  return found;
}

/* ═══════════════════════════════════════════════════════════════════════════
   _cotationLocalPersist — persistance + sync Supabase pour cotation locale
   ───────────────────────────────────────────────────────────────────────────
   Appelée après cotationLocaleNGAP() pour garantir que la cotation arrive
   dans l'Historique des soins (planning_patients) malgré l'absence de N8N.

   Étapes :
   1. Génère un invoice_number temporaire (TMP-LOCAL-…) si absent.
      Le worker /ami-save-cotation détectera ce préfixe et générera un
      vrai numéro côté serveur lors du POST.
   2. Upsert IDB carnet patient (mêmes règles que cotation IA).
   3. Push vers /webhook/ami-save-cotation. Si offline → queueCotation.
   4. Vérifie via _ensureCotationInHistorique() que la ligne est bien
      en base après quelques secondes ; relance ami-save-cotation sinon.
   ═══════════════════════════════════════════════════════════════════════════ */
async function _cotationLocalPersist(d, txt) {
  const _patNom = (gv('f-pt') || '').trim();
  if (!_patNom) return;
  if (typeof _idbGetAll !== 'function' || typeof PATIENTS_STORE === 'undefined') return;

  const _editRef = window._editingCotation;
  const _cotDate = gv('f-ds') || new Date().toISOString().slice(0,10);
  const _cotHeure = gv('f-hs') || '';

  // Guard : pas d'acte technique ET pas de mode édition → ne pas polluer
  const _CODES_MAJ_LP = new Set(['DIM','NUIT','NUIT_PROF','IFD','MIE','MCI','IK']);
  const _actesTech = (d.actes || []).filter(a => !_CODES_MAJ_LP.has((a.code||'').toUpperCase()));
  if (!_actesTech.length && !_editRef) {
    console.warn('[cotation] Local persist ignoré — pas d\'acte technique');
    return;
  }

  // 1) Génération invoice_number temporaire (réservé au mode local)
  const _invNum = _editRef?.invoice_number
               || `TMP-LOCAL-${_cotDate.replace(/-/g,'')}-${Date.now().toString(36).slice(-6).toUpperCase()}`;

  // 2) Upsert IDB
  const _patRows = await _idbGetAll(PATIENTS_STORE);
  let _patRow = _editRef?.patientId
    ? _patRows.find(r => r.id === _editRef.patientId)
    : null;
  if (!_patRow) {
    const _nomLow = _patNom.toLowerCase();
    _patRow = _patRows.find(r =>
      ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
      ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
    );
  }

  const _newCot = {
    date:           _cotDate,
    heure:          _cotHeure,
    actes:          d.actes || [],
    total:          parseFloat(d.total || 0),
    part_amo:       parseFloat(d.part_amo || 0),
    part_amc:       parseFloat(d.part_amc || 0),
    part_patient:   parseFloat(d.part_patient || 0),
    soin:           (txt || '').slice(0, 120),
    invoice_number: _invNum,
    source:         _editRef ? 'local_ngap_edit' : 'local_ngap',
    _synced:        false, // sera passé à true après push réussi
    _local_only:    true,
  };

  let _resolvedPatientId = _patRow?.id || null;

  if (_patRow) {
    // ── Patient existant → upsert strict ──────────────────────────────────
    const _pat = { id: _patRow.id, nom: _patRow.nom, prenom: _patRow.prenom, ...(_dec(_patRow._data)||{}) };
    if (!Array.isArray(_pat.cotations)) _pat.cotations = [];

    let _idx = -1;
    if (typeof _editRef?.cotationIdx === 'number' && _editRef.cotationIdx >= 0)
      _idx = _editRef.cotationIdx;
    if (_idx < 0 && _invNum)
      _idx = _pat.cotations.findIndex(c => c.invoice_number === _invNum);
    if (_idx < 0 && _editRef?.invoice_number)
      _idx = _pat.cotations.findIndex(c => c.invoice_number === _editRef.invoice_number);
    const _isForceNewLocal = _editRef?._userChose && !_editRef?.cotationIdx && !_editRef?.invoice_number;
    if (_idx < 0 && _editRef && _cotDate && !_isForceNewLocal) {
      _idx = _pat.cotations.findIndex(c =>
        (c.date || '').slice(0, 10) === _cotDate.slice(0, 10)
      );
    }

    if (_idx >= 0) {
      _pat.cotations[_idx] = { ..._pat.cotations[_idx], ..._newCot, date_edit: new Date().toISOString() };
    } else if (!_editRef || _isForceNewLocal) {
      _pat.cotations.push(_newCot);
    } else {
      // _editRef avec idx introuvable → rien (évite doublon)
      return;
    }

    _pat.updated_at = new Date().toISOString();
    const _toStore = { id: _pat.id, nom: _pat.nom, prenom: _pat.prenom, _data: _enc(_pat), updated_at: _pat.updated_at };
    await _idbPut(PATIENTS_STORE, _toStore);
    if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore).catch(() => {});

  } else if (!_editRef) {
    // ── Patient absent → créer fiche + cotation ──────────────────────────
    const _parts = _patNom.trim().split(/\s+/);
    const _prenom = _parts.slice(0, -1).join(' ') || _patNom;
    const _nom    = _parts.length > 1 ? _parts[_parts.length - 1] : '';
    const _newPat = {
      id:         'pat_' + Date.now(),
      nom:        _nom,
      prenom:     _prenom,
      ddn:        gv('f-ddn') || '',
      amo:        gv('f-amo') || '',
      amc:        gv('f-amc') || '',
      exo:        gv('f-exo') || '',
      medecin:    gv('f-pr')  || '',
      cotations:  [_newCot],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source:     'local_ngap_auto',
    };
    const _toStore = {
      id:         _newPat.id,
      nom:        _nom,
      prenom:     _prenom,
      _data:      _enc(_newPat),
      updated_at: _newPat.updated_at,
    };
    await _idbPut(PATIENTS_STORE, _toStore);
    _resolvedPatientId = _newPat.id;
    if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore).catch(() => {});
    if (typeof showToast === 'function')
      showToast('👤 Fiche patient créée automatiquement pour ' + _patNom);
  } else {
    // Patient absent + _editRef → rien (pas de fiche fantôme)
    return;
  }

  // 3) Push vers /webhook/ami-save-cotation (tri-critères upsert worker)
  const _payloadServer = {
    cotations: [{
      actes:          _newCot.actes,
      total:          _newCot.total,
      date_soin:      _cotDate,
      heure_soin:     _cotHeure || null,
      soin:           _newCot.soin,
      invoice_number: _invNum,
      source:         _newCot.source,
      patient_id:     _resolvedPatientId || undefined,
      patient_nom:    _patNom,
      part_amo:       _newCot.part_amo,
      part_amc:       _newCot.part_amc,
      part_patient:   _newCot.part_patient,
    }],
  };

  const _isOnline = (typeof navigator !== 'undefined') ? navigator.onLine !== false : true;
  if (!_isOnline) {
    // Hors-ligne → mise en file pour replay automatique
    if (typeof queueCotation === 'function') {
      queueCotation({
        ..._payloadServer.cotations[0],
        // queueCotation rejouera via /ami-calcul ; on conserve _saveTarget pour
        // que le replay tente d'abord ami-save-cotation (cotation déjà calculée).
        _saveTarget: '/webhook/ami-save-cotation',
        texte:       (txt || '').slice(0, 200),
      });
    }
    return;
  }

  try {
    const _res = typeof apiCall === 'function'
      ? await apiCall('/webhook/ami-save-cotation', _payloadServer)
      : null;
    if (_res?.ok && _resolvedPatientId) {
      // Marquer la cotation comme synchronisée dans l'IDB
      try {
        const _refreshed = await _idbGetAll(PATIENTS_STORE);
        const _updRow = _refreshed.find(r => r.id === _resolvedPatientId);
        if (_updRow) {
          const _updPat = { id: _updRow.id, nom: _updRow.nom, prenom: _updRow.prenom, ...(_dec(_updRow._data)||{}) };
          if (Array.isArray(_updPat.cotations)) {
            const _ci = _updPat.cotations.findIndex(c => c.invoice_number === _invNum);
            if (_ci >= 0) {
              _updPat.cotations[_ci]._synced = true;
              _updPat.updated_at = new Date().toISOString();
              const _toStoreS = { id: _updPat.id, nom: _updPat.nom, prenom: _updPat.prenom, _data: _enc(_updPat), updated_at: _updPat.updated_at };
              await _idbPut(PATIENTS_STORE, _toStoreS);
            }
          }
        }
      } catch (_) {}
      if (typeof showToast === 'function')
        showToast('✅ Cotation locale synchronisée dans l\'Historique des soins', 'su');
    }
  } catch (_pushErr) {
    console.warn('[cotation] Push local→Supabase KO, mise en file:', _pushErr.message);
    if (typeof queueCotation === 'function') {
      queueCotation({
        ..._payloadServer.cotations[0],
        _saveTarget: '/webhook/ami-save-cotation',
        texte:       (txt || '').slice(0, 200),
      });
    }
  }

  // 4) Vérification post-save : la cotation est-elle bien dans l'Historique ?
  if (_invNum && typeof _ensureCotationInHistorique === 'function') {
    setTimeout(() => {
      _ensureCotationInHistorique({
        invoice_number: _invNum,
        cotation:       _payloadServer.cotations[0],
      }).catch(() => {});
    }, 4000);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   _ensureCotationInHistorique — garantie « cotation Carnet → Historique »
   ───────────────────────────────────────────────────────────────────────────
   Appelée après TOUTE cotation (IA ou locale) initiée depuis le Carnet
   patients (_editingCotation._fromCarnet = true). Vérifie via
   /webhook/ami-historique que la ligne est bien arrivée dans
   planning_patients ; si absente, relance /webhook/ami-save-cotation
   en rattrapage (jusqu'à 2 tentatives).

   Garantie zéro doublon : le worker ami-save-cotation utilise un upsert
   tri-critères (invoice_number → patient_id+date → patient_nom+date),
   donc relancer N fois la même cotation ne crée pas de duplicata.
   ═══════════════════════════════════════════════════════════════════════════ */
async function _ensureCotationInHistorique({ invoice_number, cotation, _retry = 0 }) {
  if (!invoice_number || !cotation) return;
  if (_retry > 2) {
    console.warn('[cotation] Vérif Historique : abandon après 3 tentatives pour', invoice_number);
    return;
  }
  if (typeof apiCall !== 'function') return;
  const _isOnline = (typeof navigator !== 'undefined') ? navigator.onLine !== false : true;
  if (!_isOnline) return; // offline-queue prendra le relais

  try {
    // 1) Vérifier la présence dans l'Historique des soins
    const _hist = await apiCall('/webhook/ami-historique?period=month', {});
    const _rows = Array.isArray(_hist?.data) ? _hist.data : (Array.isArray(_hist) ? _hist : []);
    const _found = _rows.find(r =>
      r.invoice_number === invoice_number ||
      // Fallback : match par patient_id + date_soin + total (tolérance 0.01€)
      (r.patient_id && cotation.patient_id && r.patient_id === cotation.patient_id &&
       (r.date_soin || '').slice(0,10) === (cotation.date_soin || '').slice(0,10) &&
       Math.abs(parseFloat(r.total||0) - parseFloat(cotation.total||0)) < 0.01)
    );
    if (_found) {
      console.info('[cotation] ✅ Cotation présente dans Historique :', invoice_number);
      return;
    }
    // 2) Absente → relancer ami-save-cotation (upsert tri-critères côté worker)
    console.warn(`[cotation] ⚠️ Cotation absente Historique — rattrapage tentative ${_retry+1}/3 :`, invoice_number);
    await apiCall('/webhook/ami-save-cotation', { cotations: [cotation] });
    // 3) Re-vérifier après délai
    setTimeout(() => {
      _ensureCotationInHistorique({ invoice_number, cotation, _retry: _retry + 1 }).catch(() => {});
    }, 5000);
  } catch (e) {
    console.warn('[cotation] Vérif Historique KO:', e.message);
  }
}

/* Helper : extrait les codes NGAP d'un texte au format attendu par
   _cotMinimalLocalCalc, en utilisant _cotExtractNgapChips puis en décomposant
   les chips combo (AMI4 + MCI → 2 codes séparés). */
function _cotExtractCodesFromText(txt) {
  const chips = (typeof _cotExtractNgapChips === 'function')
    ? _cotExtractNgapChips(txt || '')
    : [];
  const codes = [];
  for (const c of chips) {
    const parts = c.insert.split(/\s*\+\s*/);
    for (const p of parts) {
      const m = p.match(/^([A-Z][A-Z_]*)\s*(\d+(?:[._/]\d+)*)?/i);
      if (m) {
        const lettre = m[1].toUpperCase();
        const coef   = m[2] || '';
        codes.push({ code: lettre + coef });
      }
    }
  }
  return codes;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS CLIQUABLES : ajouter du texte à la description des soins (f-txt)
   depuis les lignes du "Détail des actes", "Optimisations" et "Suggestions".
   Permet ensuite de relancer "Coter avec l'IA" pour recalculer avec ce code.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Nettoie & ajoute le fragment à f-txt sans doublon. Ne remplace pas. */
function _cotAppendDesc(fragment) {
  const el = typeof $ === 'function' ? $('f-txt') : document.getElementById('f-txt');
  if (!el) return false;
  const frag = String(fragment || '').trim();
  if (!frag) return false;
  const cur = (el.value || '').trim();
  // Évite d'ajouter un fragment déjà présent (casse-insensible)
  const curNorm = cur.toLowerCase();
  const fragNorm = frag.toLowerCase();
  if (curNorm.includes(fragNorm)) return 'exists';
  // Séparateur : « + » entre fragments pour une syntaxe lisible par l'IA
  const sep = cur ? (/[.,+]$/.test(cur) ? ' ' : ' + ') : '';
  el.value = cur + sep + frag;
  // Déclenche les listeners (cabinet mode, validation…)
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/* Handler commun appelé en onclick : ajoute + feedback visuel + toast léger */
function _cotClickAppend(btnOrRow, fragment, label) {
  const res = _cotAppendDesc(fragment);
  if (res === true || res === 'exists') {
    // Feedback visuel sur l'élément cliqué
    try {
      if (btnOrRow && btnOrRow.classList) btnOrRow.classList.add('added');
      setTimeout(() => { try { btnOrRow.classList.remove('added'); } catch (_) {} }, 2200);
    } catch (_) {}
    const toast = typeof showToast === 'function' ? showToast
                : (typeof showToastSafe === 'function' ? showToastSafe : null);
    if (toast) {
      const msg = res === 'exists'
        ? `ℹ️ "${label || fragment}" déjà dans la description`
        : `✅ "${label || fragment}" ajouté`;
      toast(msg, res === 'exists' ? 'in' : 'su');
    }
    // Scroll doux vers le champ f-txt (utile sur mobile)
    const elTxt = typeof $ === 'function' ? $('f-txt') : document.getElementById('f-txt');
    if (elTxt && typeof elTxt.scrollIntoView === 'function') {
      try { elTxt.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    }
    // FAB « Re-coter » : on ne l'affiche que si un nouvel ajout a réellement été fait
    if (res === true) _cotShowReCoteBar();
  }
}

/* FAB flottant « Re-coter » : apparaît dès qu'un ajout a été fait, disparaît
   à la re-cotation, au clic ou à la navigation hors de la page cotation. */
function _cotShowReCoteBar() {
  // Si on n'est pas sur la page cotation, ne pas afficher le FAB
  // (sécurité contre _cotClickAppend déclenché depuis un autre contexte)
  try {
    const cotPage = document.getElementById('p-cot') || document.getElementById('section-cot');
    if (cotPage && cotPage.style && cotPage.style.display === 'none') return;
  } catch (_) {}

  let fab = document.getElementById('recote-fab');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'recote-fab';
    fab.className = 'recote-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Re-coter avec les ajouts');
    fab.innerHTML = `
      <span class="recote-fab-ico" aria-hidden="true">🔄</span>
      <span class="recote-fab-lbl">Re-coter avec les ajouts</span>
      <span class="recote-fab-badge" data-count="1">1</span>
      <span class="recote-fab-close" role="button" aria-label="Fermer" title="Fermer (n'annule pas les ajouts)">✕</span>
    `;
    // Clic principal → relance la cotation
    fab.addEventListener('click', (ev) => {
      // Sécurité : empêcher tout bubbling vers les éléments en dessous
      // (notamment le bouton vocal qui se trouve dans la même zone)
      ev.stopPropagation();
      ev.preventDefault();
      // Clic sur la croix : ferme sans re-coter
      if (ev.target && ev.target.classList && ev.target.classList.contains('recote-fab-close')) {
        _cotHideReCoteBar();
        return;
      }
      // Sinon : relance la cotation
      fab.classList.add('loading');
      // Drapeau : la prochaine cotation est issue du FAB → force mode édition
      // si une cotation existe déjà (bypass modale doublon, choix implicite « Mettre à jour »)
      window._cotFromReCoteFAB = true;
      try {
        if (typeof cotation === 'function') {
          Promise.resolve(cotation()).catch(() => {}).finally(() => {
            window._cotFromReCoteFAB = false;
            // Si la cotation échoue silencieusement, on retire le loading après 1.5s
            setTimeout(() => { if (fab && document.body.contains(fab)) fab.classList.remove('loading'); }, 1500);
          });
        } else {
          // Fallback : click sur le bouton principal
          const mainBtn = document.getElementById('btn-cot');
          if (mainBtn) mainBtn.click();
          setTimeout(() => { window._cotFromReCoteFAB = false; }, 5000);
        }
      } catch (_) {
        window._cotFromReCoteFAB = false;
        fab.classList.remove('loading');
      }
    });
    // Capture précoce (avant les autres listeners) pour éviter tout double-déclenchement
    document.body.appendChild(fab);
  } else {
    // Bouton déjà présent → incrémenter le compteur
    const badge = fab.querySelector('.recote-fab-badge');
    if (badge) {
      const cur = parseInt(badge.getAttribute('data-count') || '0', 10) || 0;
      const n   = cur + 1;
      badge.setAttribute('data-count', String(n));
      badge.textContent = String(n);
      // Petit pulse pour signaler l'incrément
      badge.style.transform = 'scale(1.3)';
      setTimeout(() => { if (badge) badge.style.transform = ''; }, 180);
    }
    // Retire l'éventuel état 'out' si un clic très proche
    fab.classList.remove('out', 'loading');
  }
}

function _cotHideReCoteBar() {
  const fab = document.getElementById('recote-fab');
  if (!fab) return;
  // Anim sortie puis suppression
  fab.classList.add('out');
  setTimeout(() => { try { fab.remove(); } catch (_) {} }, 260);
}

/* ═══════════════════════════════════════════════════════════════════════════
   FALLBACK NGAP LOCAL : utilise NGAPEngine + window.NGAP_REFERENTIEL
   pour calculer une cotation à partir des codes extraits du textarea.
   Appelé quand N8N renvoie 0 acte technique (cold start, texte sans verbe…).
   ═══════════════════════════════════════════════════════════════════════════ */
function _cotEnrichWithLocalEngine(d, txt) {
  // Pré-conditions : moteur + référentiel chargés (de préférence)
  const Engine = window.NGAPEngine || (typeof NGAPEngine !== 'undefined' ? NGAPEngine : null);
  const ref    = window.NGAP_REFERENTIEL;

  // Extraire tous les codes du textarea (codes seuls + combos AMI4 + MCI)
  const chips = _cotExtractNgapChips(txt || '');
  if (!chips.length) return null;

  // Décomposer chaque chip en codes individuels (un chip combo "AMI4 + MCI" → ["AMI4","MCI"])
  const codes = [];
  for (const c of chips) {
    const parts = c.insert.split(/\s*\+\s*/);
    for (const p of parts) {
      // Récupérer le code seul + son éventuel coefficient (avec ou sans espace)
      // Ex: "AMI 4" → "AMI4", "AMI 4.1 2ème passage" → "AMI4.1", "AMI 14/15 longue" → "AMI14/15"
      const m = p.match(/^([A-Z][A-Z_]*)\s*(\d+(?:[._/]\d+)*)?/i);
      if (m) {
        const lettre = m[1].toUpperCase();
        const coef   = m[2] || '';
        codes.push({ code: lettre + coef });
      }
    }
  }
  if (!codes.length) return null;

  // ── Cas 1 : moteur déclaratif chargé → l'utiliser ──────────────────────
  if (Engine && ref) {
    try {
      const engine = new Engine(ref);
      const result = engine.compute({
        codes,
        date_soin:  gv('f-ds') || new Date().toISOString().slice(0,10),
        heure_soin: gv('f-hs') || '',
        mode:       'permissif', // tolérant pour ne pas bloquer
      });
      if (result && result.ok && Array.isArray(result.actes_finaux) && result.actes_finaux.length) {
        const actes = result.actes_finaux.map(a => ({
          code:        a.code || a.code_facturation || '?',
          nom:         a.nom || a.libelle || '',
          coefficient: a.coefficient || 1,
          total:       parseFloat(a.tarif || a.total || 0),
          description: a.description || '',
        }));
        const total = actes.reduce((s, a) => s + (parseFloat(a.total) || 0), 0);
        const pAmo  = parseFloat(d.part_amo) || (total * 0.60);
        const pAmc  = parseFloat(d.part_amc) || 0;
        const pPat  = parseFloat(d.part_patient) || (total - pAmo - pAmc);
        return {
          actes,
          total:        +total.toFixed(2),
          part_amo:     +pAmo.toFixed(2),
          part_amc:     +pAmc.toFixed(2),
          part_patient: +pPat.toFixed(2),
        };
      }
    } catch (e) {
      console.warn('[cotation] NGAPEngine.compute KO → fallback minimal:', e.message);
    }
  }

  // ── Cas 2 : fallback minimal — utilise juste _COT_TARIFS ─────────────────
  // Marche même si NGAPEngine n'est pas chargé. Pas de gestion fine des
  // cumuls interdits, mais permet d'avoir une cotation visible et chiffrée
  // au lieu d'« aucun acte détecté ».
  return _cotMinimalLocalCalc(codes, d);
}

/* Fallback minimal : calcule une cotation à partir des codes extraits en
   utilisant uniquement la table _COT_TARIFS (toujours disponible).
   Applique les actes au tarif officiel et somme. Aucune règle de cumul. */
function _cotMinimalLocalCalc(codes, d) {
  // Récupérer la table des tarifs (déjà construite au chargement)
  const tarifs = (typeof _COT_TARIFS !== 'undefined' && _COT_TARIFS)
    ? _COT_TARIFS
    : (typeof _buildCotTarifs === 'function' ? _buildCotTarifs() : null);
  if (!tarifs) {
    console.warn('[cotation] _COT_TARIFS indisponible → pas de fallback minimal');
    return null;
  }
  // Libellés courants (fallback texte si non fournis)
  const libelles = {
    AMI1:  'Acte technique AMI 1',
    AMI2:  'Acte technique AMI 2',
    AMI3:  'Acte technique AMI 3',
    AMI4:  'Pansement complexe / acte AMI 4',
    'AMI4.1': 'Pansement complexe (2ème passage)',
    AMI5:  'Acte AMI 5',
    AMI9:  'Perfusion courte (≤1h)',
    AMI10: 'Acte AMI 10',
    AMI14: 'Forfait perfusion >1h avec organisation surveillance',
    AMI15: 'Perfusion >1h avec surveillance continue',
    BSA:   'BSI Bilan Soins Infirmiers (autonome)',
    BSB:   'BSI Bilan Soins Infirmiers (légère perte)',
    BSC:   'BSI Bilan Soins Infirmiers (lourde perte)',
    MCI:   'Majoration coordination infirmière',
    MIE:   'Majoration enfant <7 ans',
    IFD:   'Indemnité forfaitaire de déplacement',
    IFI:   'Indemnité forfaitaire infirmier',
    NUIT:  'Majoration nuit (20h-23h / 5h-8h)',
    NUIT_PROF: 'Majoration nuit profonde (23h-5h)',
    DIM:   'Majoration dimanche / férié',
    DI:    'Démarche infirmière',
  };

  const actes = [];
  const seen = new Set();
  for (const c of codes) {
    const code = String(c.code || '').toUpperCase();
    if (!code) continue;
    // Dédoublonnage simple (pas le même code 2x)
    if (seen.has(code)) continue;
    seen.add(code);
    // Lookup tarif : essai direct, puis variantes (point/underscore)
    let tarif = tarifs[code]
             || tarifs[code.replace('.', '_')]
             || tarifs[code.replace('_', '.')]
             || tarifs[code.replace('/', '_')];
    // Variante AMI14/15 : on prend le 1er nombre (AMI14)
    if (tarif === undefined && code.includes('/')) {
      const firstNum = code.split('/')[0];
      tarif = tarifs[firstNum];
    }
    if (tarif === undefined || tarif === null) {
      console.warn('[cotation] code sans tarif:', code);
      continue;
    }
    actes.push({
      code,
      nom:         libelles[code] || code,
      coefficient: 1,
      total:       parseFloat(tarif),
      description: '',
    });
  }

  if (!actes.length) return null;

  const total = actes.reduce((s, a) => s + (parseFloat(a.total) || 0), 0);
  const pAmo  = parseFloat(d?.part_amo) || (total * 0.60);
  const pAmc  = parseFloat(d?.part_amc) || 0;
  const pPat  = parseFloat(d?.part_patient) || (total - pAmo - pAmc);
  return {
    actes,
    total:        +total.toFixed(2),
    part_amo:     +pAmo.toFixed(2),
    part_amc:     +pAmc.toFixed(2),
    part_patient: +pPat.toFixed(2),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PRÉ-WARM N8N : ping silencieux pour réveiller le worker Render avant que
   l'utilisateur clique sur « Coter avec l'IA ». Casse le cold-start de ~30s.
   Appelé une seule fois par session, à l'ouverture de la page de cotation.
   ═══════════════════════════════════════════════════════════════════════════ */
function _cotPrewarmN8N() {
  if (window._cotN8NPrewarmed) return;
  // 🔒 Garde authentification : pas de prewarm tant que l'utilisateur n'est pas connecté.
  // Sinon le worker renvoie 401 Unauthorized (pollution console + log admin).
  if (!_cotIsAuthenticated()) {
    // Réessayera au prochain navTo('cot') ou après login (auth-success event)
    return;
  }
  window._cotN8NPrewarmed = true;
  try {
    if (typeof apiCall !== 'function') return;
    // Appel avec mode: 'ping' — le worker peut court-circuiter ce mode et
    // répondre 200 immédiatement. Si non géré, le worker traitera comme une
    // requête normale avec un texte vide → 200/erreur, peu importe : le but
    // est juste de réveiller le conteneur Render.
    Promise.resolve(apiCall('/webhook/ami-calcul', {
      mode: 'ping', texte: '', _prewarm: true,
    }, { silent: true })).catch(() => {
      // Aucun retour utilisateur — c'est un ping silencieux
    });
    console.info('[cotation] Pré-warm N8N envoyé');
  } catch (_) {}
}

/* Version « forte » : envoie un vrai appel N8N avec un texte factice pour
   garantir que tout le pipeline IA est chaud (parsing, Grok, NGAPEngine côté
   worker). Appelée quand l'utilisateur arrive sur la page cotation — plus
   agressif que _cotPrewarmN8N() qui ne fait qu'un ping. Non bloquant.
   Une fois par session uniquement. */
function _cotPrewarmN8N_FullPipeline() {
  if (window._cotN8NFullPrewarmed) return;
  // 🔒 Idem : pas de prewarm si non authentifié
  if (!_cotIsAuthenticated()) return;
  window._cotN8NFullPrewarmed = true;
  try {
    if (typeof apiCall !== 'function') return;
    // Texte factice standard — le worker ne le persiste pas car _prewarm:true
    Promise.resolve(apiCall('/webhook/ami-calcul', {
      mode: 'ngap',
      texte: 'injection insuline',
      _prewarm: true,          // drapeau : pas de sauvegarde Supabase/IDB
      _no_local_fallback: true, // on veut vraiment N8N pour le réveil complet
    }, { silent: true })).catch(() => {
      // Ignorer — c'est juste un warm-up
    });
    console.info('[cotation] Pré-warm N8N complet envoyé (pipeline IA)');
  } catch (_) {}
}

/* Détection robuste : l'utilisateur est-il connecté ?
   Vérifie tous les indicateurs disponibles : token JWT, user en mémoire,
   session storage, cookie. Tolérant aux variantes d'app. */
function _cotIsAuthenticated() {
  try {
    // 1) Token JWT en mémoire
    if (typeof window !== 'undefined') {
      if (window.AUTH_TOKEN || window.JWT || window.SESSION_TOKEN) return true;
      if (window.AMI_USER && (window.AMI_USER.id || window.AMI_USER.email)) return true;
      if (window.currentUser && (window.currentUser.id || window.currentUser.email)) return true;
    }
    // 2) localStorage
    if (typeof localStorage !== 'undefined') {
      const keys = ['ami_token', 'auth_token', 'jwt', 'session_token', 'ami_session', 'ami_user'];
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v && v.length > 10) return true;
      }
    }
    // 3) Présence du DOM "post-login" : la sidebar n'est visible qu'une fois loggué
    if (typeof document !== 'undefined') {
      // Si le formulaire de connexion est visible → pas connecté
      const loginForm = document.getElementById('p-login') ||
                        document.querySelector('[data-page="login"]') ||
                        document.querySelector('.login-card');
      if (loginForm && loginForm.offsetParent !== null) return false;
      // Si la sidebar nav est visible → connecté
      const nav = document.querySelector('.sidebar-nav') ||
                  document.querySelector('#sidebar') ||
                  document.querySelector('nav.main-nav');
      if (nav && nav.offsetParent !== null) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTO-REMPLISSAGE DATE / HEURE COURANTES
   À l'ouverture de la page cotation, si f-ds (date) ou f-hs (heure) sont vides
   et que l'utilisateur n'est pas en mode édition (_editingCotation), on les
   pré-remplit avec maintenant. Évite que l'utilisateur ait à les saisir.
   ═══════════════════════════════════════════════════════════════════════════ */
function _cotAutoFillDateHeure() {
  try {
    const fDs = document.getElementById('f-ds');
    const fHs = document.getElementById('f-hs');
    if (!fDs && !fHs) return;
    // En mode édition (_editingCotation posé) → on respecte la valeur existante
    // (la cotation à modifier a déjà été chargée avec sa date/heure)
    const isEditing = !!(window._editingCotation && (window._editingCotation.cotationIdx !== undefined || window._editingCotation.invoice_number));
    const now = new Date();
    if (fDs && !fDs.value) {
      fDs.value = now.toISOString().slice(0, 10);
    }
    if (fHs && !fHs.value && !isEditing) {
      fHs.value = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    }
  } catch (_e) {
    // Non bloquant
  }
}

/* Hook sur navTo : déclencher le pré-warm dès qu'on entre sur la page cotation */
if (typeof window !== 'undefined' && !window._cotPrewarmHookInstalled) {
  window._cotPrewarmHookInstalled = true;
  // ⚠️ Plus de pré-warm aveugle au DOMContentLoaded : le worker exige un token
  // d'auth et renvoie 401 si l'utilisateur n'est pas encore connecté.
  // Le prewarm est désormais conditionné par _cotIsAuthenticated() (côté
  // _cotPrewarmN8N et _cotPrewarmN8N_FullPipeline) ET déclenché à 3 endroits :
  //   1. Chargement direct sur la page cotation (URL = ?p=cot ou #cot)
  //   2. Événement de login réussi (auth-success / ami:login)
  //   3. Navigation vers la page cotation (hook navTo plus bas)

  try {
    // 1) Chargement direct sur la page cotation
    if (typeof location !== 'undefined' && /[?&#]p=cot|#cot/.test(location.href)) {
      // Délai plus long (3s) pour laisser le temps à l'auth de s'établir
      setTimeout(_cotPrewarmN8N, 3000);
      setTimeout(_cotPrewarmN8N_FullPipeline, 4500);
    }
  } catch (_) {}

  try {
    // 2) Hook sur les événements de login — déclenche le prewarm dès que connecté
    if (typeof document !== 'undefined') {
      const _onAuthSuccess = () => {
        setTimeout(_cotPrewarmN8N, 1000);             // ping léger après login
        setTimeout(_cotPrewarmN8N_FullPipeline, 3000); // pipeline complet 2s plus tard
      };
      // Plusieurs noms d'events possibles selon les versions de l'app
      ['auth:success', 'ami:login', 'ami:auth-success', 'login:success', 'user:logged-in'].forEach(evt => {
        document.addEventListener(evt, _onAuthSuccess, { once: false });
      });
    }
  } catch (_) {}

  try {
    // 3) Polling léger : si déjà connecté quand cotation.js charge, déclencher
    // après un court délai. Évite de manquer le prewarm si l'event login est
    // émis avant que cotation.js soit prêt.
    if (typeof document !== 'undefined') {
      const _checkAndPrewarm = () => {
        if (_cotIsAuthenticated()) {
          _cotPrewarmN8N();
          setTimeout(_cotPrewarmN8N_FullPipeline, 2000);
        }
      };
      // 5s après DOMContentLoaded — laisse largement le temps à l'auth
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(_checkAndPrewarm, 5000);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(_checkAndPrewarm, 5000);
        }, { once: true });
      }
    }
  } catch (_) {}
}

/* Nettoyage du FAB lors de la navigation hors de la page cotation */
if (typeof window !== 'undefined' && !window._cotRecoteNavHookInstalled) {
  window._cotRecoteNavHookInstalled = true;
  // Hook sur navTo si disponible — purement défensif, pas bloquant
  try {
    const _origNavTo = window.navTo;
    if (typeof _origNavTo === 'function') {
      window.navTo = function patchedNavTo(section, ...rest) {
        if (section && section !== 'cot') _cotHideReCoteBar();
        // Pré-warm N8N quand l'utilisateur arrive sur la page cotation
        // - _cotPrewarmN8N : ping léger (réveille le conteneur Render)
        // - _cotPrewarmN8N_FullPipeline : vrai appel N8N (réveille l'IA en entier)
        // - Auto-fill date/heure : si vides, mettre maintenant
        if (section === 'cot') {
          try { setTimeout(_cotPrewarmN8N, 300); } catch (_) {}
          try { setTimeout(_cotPrewarmN8N_FullPipeline, 800); } catch (_) {}
          try { setTimeout(_cotAutoFillDateHeure, 200); } catch (_) {}
        }
        return _origNavTo.apply(this, [section, ...rest]);
      };
    }
  } catch (_) {}
}

/* Détecte si une suggestion est purement informative (non-actionnable).
   Ex: PROTECTION, RGPD, AUDIT, INFO, VIGILANCE — pas de code à ajouter. */
function _cotIsInfoSuggestion(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // Mots-clés d'en-tête en MAJUSCULES indiquant une info (pas une action cotation)
  const infoKeywords = [
    'PROTECTION',
    'RGPD',
    'INFO',
    'NOTE',
    'AUDIT',
    'VIGILANCE',
    'TRACABILITE',
    'TRAÇABILITÉ',
    'CONFORMITÉ',
    'CONFORMITE',
    'SIGNATURE',
    'PREUVE',
  ];
  // Détection : "MOTCLE — " ou "MOTCLE : " ou "MOTCLE - " en début de chaîne
  const reHeader = new RegExp('^(' + infoKeywords.join('|') + ')\\s*[—\\-:·]', 'i');
  if (reHeader.test(s)) return true;
  // Ou action orientée UI/outil plutôt que cotation (ex: "Activer preuve forte")
  const actionInfo = /\bactiver\s+(preuve|signature|photo|tra[cç]abilit)/i;
  if (actionInfo.test(s)) return true;
  return false;
}

/* Extraction des codes NGAP en GROUPES (chaque groupe = 1 chip).
   Les codes reliés par "+" forment un groupe unique (combinaison).
   Les séparateurs forts (→, , ou, vs, puis) délimitent les groupes distincts.
   Ex: "AMI1 → AMI4 + MCI"              → [ {insert:"AMI 1"}, {insert:"AMI 4 + MCI"} ]
       "AMI 14 longue, AMI 9 courte"    → [ {insert:"AMI 14 longue"}, {insert:"AMI 9 courte"} ]
       "AMI 14 + BSA + IFD"             → [ {insert:"AMI 14 + BSA + IFD"} ] */
function _cotExtractNgapChips(text) {
  const s = String(text || '');
  if (!s) return [];

  // 1) Collecter tous les tokens (codes NGAP) avec leur position dans la chaîne
  const tokens = [];

  // Codes avec coefficient : AMI/AIS/SFI/SF
  const reCoef = /\b(AMI|AIS|SFI|SF)\s*(\d{1,2}(?:\.\d{1,2})?(?:\/\d{1,2})?)\b/gi;
  let m;
  while ((m = reCoef.exec(s)) !== null) {
    const codeNorm    = m[1].toUpperCase() + m[2];
    const codeDisplay = m[1].toUpperCase() + ' ' + m[2];
    // Libellé court qui suit (max 3 mots)
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const labelM = after.match(/^\s*([\wàâéèêëïîôùûüçÀÂÉÈÊËÏÎÔÙÛÜÇ]+(?:\s+[\wàâéèêëïîôùûüçÀÂÉÈÊËÏÎÔÙÛÜÇ]+){0,2})/);
    const label = labelM ? labelM[1].trim() : '';
    const insert = codeDisplay + (label ? ' ' + label : '');
    const endPos = m.index + m[0].length + (label ? (labelM[0].length) : 0);
    tokens.push({
      code:    codeNorm,
      display: insert,
      insert,
      start:   m.index,
      end:     endPos,
    });
  }

  // Codes simples (sans coef) : BSB, BSC, MIE, IFD, NUIT_PROF…
  const simpleCodes = [
    'NUIT_PROF',                         // Doit être testé AVANT 'NUIT' (longest-first)
    'BSB', 'BSC', 'BSA', 'BSI',
    'MIE', 'MAU', 'MCI',
    'IFD', 'IFI', 'IFSD',
    'DIP', 'DIE', 'DI',
    'NUIT', 'DIM',
  ];
  for (const c of simpleCodes) {
    const re = new RegExp('\\b' + c + '\\b', 'gi');
    let mm;
    while ((mm = re.exec(s)) !== null) {
      // Skip si déjà capturé par un code plus long (ex: NUIT_PROF contient NUIT)
      const overlap = tokens.some(t => mm.index < t.end && mm.index + c.length > t.start);
      if (overlap) continue;
      tokens.push({
        code:    c,
        display: c,
        insert:  c,
        start:   mm.index,
        end:     mm.index + c.length,
      });
    }
  }

  if (!tokens.length) return [];

  // 2) Trier par position pour pouvoir examiner le texte entre 2 codes consécutifs
  tokens.sort((a, b) => a.start - b.start);

  // 3) Regrouper : les codes reliés par "+" (avec éventuellement espaces/parenthèses)
  //    appartiennent au même groupe. Les séparateurs forts (→, ,, ou, vs, puis, ;)
  //    terminent un groupe.
  const reSepSoft = /^[\s(]*\+[\s)]*$/;                              // " + " entre codes
  const reSepHard = /[→←⇒,;]|\b(ou|vs|puis|alors|sinon|plut[ôo]t)\b/i; // vrais séparateurs
  const groups = [];
  let current = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const cur  = tokens[i];
    const between = s.slice(prev.end, cur.start);
    if (reSepHard.test(between)) {
      // Séparateur fort → nouveau groupe
      groups.push(current);
      current = [cur];
    } else if (reSepSoft.test(between)) {
      // "+" → combo dans le même groupe
      current.push(cur);
    } else {
      // Autre cas (espace simple, parenthèse…) → par défaut nouveau groupe
      // (évite qu'une phrase continue agrège trop de codes)
      groups.push(current);
      current = [cur];
    }
  }
  groups.push(current);

  // 4) Dédupliquer (même combinaison de codes → 1 seul chip)
  const seenKeys = new Set();
  const chips = [];
  for (const g of groups) {
    const insert  = g.map(t => t.insert).join(' + ');
    const display = g.map(t => t.display).join(' + ');
    const key     = g.map(t => t.code).join('+').toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    chips.push({ insert, display, codes: g.map(t => t.code) });
  }
  return chips;
}

/* Compat : ancienne API — renvoie un code par chip (pas de combo "+"). */
function _cotExtractNgapCodes(text) {
  return _cotExtractNgapChips(text).map(c => ({
    code:    c.codes[0],
    display: c.display,
    insert:  c.insert,
  }));
}

/* Expose en global pour usage depuis les handlers inline onclick="" */
if (typeof window !== 'undefined') {
  window._cotAppendDesc          = _cotAppendDesc;
  window._cotClickAppend         = _cotClickAppend;
  window._cotExtractNgapCodes    = _cotExtractNgapCodes;
  window._cotExtractNgapChips    = _cotExtractNgapChips;
  window._cotExtractCodesFromText = _cotExtractCodesFromText;
  window._cotInferCodesFromText  = _cotInferCodesFromText;
  window._cotIsInfoSuggestion    = _cotIsInfoSuggestion;
  window._cotShowReCoteBar       = _cotShowReCoteBar;
  window._cotHideReCoteBar       = _cotHideReCoteBar;
  window._cotEnrichWithLocalEngine = _cotEnrichWithLocalEngine;
  window._cotMinimalLocalCalc    = _cotMinimalLocalCalc;
  window._cotPrewarmN8N          = _cotPrewarmN8N;
  window._cotPrewarmN8N_FullPipeline = _cotPrewarmN8N_FullPipeline;
  window._cotIsAuthenticated     = _cotIsAuthenticated;
  window._cotAutoFillDateHeure   = _cotAutoFillDateHeure;
  window.cotationLocaleNGAP      = cotationLocaleNGAP;
  // Bouton « Vérifier & corriger » (handlers inline du HTML)
  if (typeof openVerify       === 'function') window.openVerify       = openVerify;
  if (typeof applyVerify      === 'function') window.applyVerify      = applyVerify;
  if (typeof closeVM          === 'function') window.closeVM          = closeVM;
  if (typeof verifyStandalone === 'function') window.verifyStandalone = verifyStandalone;
}

function renderCot(d) {
  // Une cotation fraîche arrive → retire le FAB « Re-coter » s'il traîne
  try { _cotHideReCoteBar(); } catch (_) {}
  const a   = d.actes  || [];
  const al  = d.alerts || [];
  const op  = d.optimisations || [];
  const sugg = d.suggestions_optimisation || [];

  // ── Badge NGAP version ──────────────────────────────────────────────────────
  const ngapBadge = d.ngap_version
    ? `<span style="font-size:10px;color:var(--m);background:var(--s);border:1px solid var(--b);padding:2px 8px;border-radius:20px">NGAP v${d.ngap_version}</span>`
    : '';

  // ── Badge fraud N8N v7 ──────────────────────────────────────────────────────
  const fraud = d.fraud || {};
  const fraudBadge = fraud.level ? (() => {
    const cfg = {
      LOW:    { bg: 'rgba(0,212,170,.12)',  col: '#00b894', icon: '🟢', label: 'Faible risque CPAM' },
      MEDIUM: { bg: 'rgba(251,191,36,.15)', col: '#f59e0b', icon: '🟡', label: 'Risque CPAM modéré' },
      HIGH:   { bg: 'rgba(239,68,68,.15)',  col: '#ef4444', icon: '🔴', label: 'RISQUE CPAM ÉLEVÉ' },
    }[fraud.level] || { bg: '', col: 'var(--m)', icon: 'ℹ️', label: fraud.level };
    return `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${cfg.bg};color:${cfg.col}">
      ${cfg.icon} ${cfg.label}${fraud.score != null ? ` (${fraud.score} pts)` : ''}
    </div>`;
  })() : '';

  // ── Badge preuve soin N8N v7 ────────────────────────────────────────────────
  const preuve = d.preuve_soin || {};
  const preuveBadge = preuve.force_probante ? (() => {
    const cfg = {
      FORTE:    { bg: 'rgba(0,212,170,.12)',  col: '#00b894', icon: '🛡️', label: preuve.type === 'signature_patient' ? 'Preuve forte — Signature' : 'Preuve forte — Photo' },
      STANDARD: { bg: 'rgba(99,102,241,.1)',  col: '#6366f1', icon: '📋', label: 'Auto-déclaration IDE' },
      ABSENTE:  { bg: 'rgba(239,68,68,.1)',   col: '#ef4444', icon: '⚠️', label: 'Aucune preuve terrain' },
    }[preuve.force_probante] || null;
    if (!cfg) return '';
    return `<div style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:20px;font-size:11px;background:${cfg.bg};color:${cfg.col}">
      ${cfg.icon} ${cfg.label}
    </div>`;
  })() : '';

  // ── Badge horaire ───────────────────────────────────────────────────────────
  const horaireBadge = d.horaire_type && d.horaire_type !== 'jour'
    ? `<div style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;font-size:11px;background:rgba(99,102,241,.1);color:#6366f1">
        ${d.horaire_type === 'nuit' ? '🌙 Nuit' : d.horaire_type === 'nuit_profonde' ? '🌑 Nuit profonde' : d.horaire_type === 'dimanche' ? '☀️ Dimanche/Férié' : ''}
      </div>`
    : '';

  // ── Bloc simulation CPAM N8N v7 ─────────────────────────────────────────────
  const cpam = d.cpam_simulation || {};
  const cpamBloc = (cpam.niveau && cpam.niveau !== 'OK') ? (() => {
    const isKO = cpam.niveau === 'CRITIQUE';
    return `<div style="margin-top:12px;padding:12px 14px;border-radius:8px;background:${isKO ? 'rgba(239,68,68,.08)' : 'rgba(251,191,36,.08)'};border:1px solid ${isKO ? '#ef4444' : '#f59e0b'}">
      <div style="font-size:11px;font-weight:700;color:${isKO ? '#ef4444' : '#f59e0b'};margin-bottom:6px">
        ${isKO ? '🚨' : '⚠️'} Simulation CPAM — ${cpam.decision || cpam.niveau}
      </div>
      ${(cpam.anomalies||[]).map(a => `<div style="font-size:11px;color:var(--fg);margin-bottom:2px">• ${a}</div>`).join('')}
    </div>`;
  })() : '';

  // ── Suggestions alternatives N8N v7 ─────────────────────────────────────────
  const suggBloc = sugg.length ? `<div style="margin-top:12px">
    <div class="lbl" style="font-size:10px;margin-bottom:6px;color:#22c55e">💰 Suggestions de valorisation</div>
    <div class="aic">${sugg.map((s, i) => {
      const reason = s.reason || '';
      const action = s.action || '';
      const gain   = s.gain   || '';
      const fullTxt = [reason, action].filter(Boolean).join(' ');

      // Détection info/protection → non-cliquable, pas de chips
      const isInfo = _cotIsInfoSuggestion(reason) || _cotIsInfoSuggestion(fullTxt) || (s.type && /info|protection|audit/i.test(s.type));

      if (isInfo) {
        // Rendu purement informatif — aucune interaction, aucune flèche "+"
        return `<div class="ai su" style="border-left:3px solid #6366f1;cursor:default">
          ${gain ? `<strong style="color:var(--a)">${gain}</strong> — ` : ''}${reason}
          ${action ? `<span style="font-size:10px;opacity:.7"> → ${action}</span>` : ''}
        </div>`;
      }

      // Cliquable : extraction des groupes (codes reliés par "+" → 1 chip combo)
      let chips = [];
      try { chips = _cotExtractNgapChips(fullTxt); } catch (_) {}
      const frag = (reason || action || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const chipsHtml = chips.length
        ? `<div class="ngap-chip-lbl">💡 Ajouter à la description :</div>
           <div class="ngap-chips">${chips.map(c => {
             const ins = c.insert.replace(/'/g, "\\'").replace(/"/g, '&quot;');
             const dsp = c.display.replace(/"/g, '&quot;');
             return `<span class="ngap-chip" onclick="event.stopPropagation();window._cotClickAppend(this,'${ins}','${dsp}')" title="Ajouter « ${dsp} » à la description">${dsp}</span>`;
           }).join('')}</div>`
        : '';
      return `<div class="ai su clk" style="border-left:3px solid #22c55e"
                   onclick="window._cotClickAppend(this,'${frag}','Suggestion ${i + 1}')"
                   title="Cliquer pour ajouter cette suggestion à la description">
        ${gain ? `<strong style="color:var(--a)">${gain}</strong> — ` : ''}${reason}
        ${action ? `<span style="font-size:10px;opacity:.7"> → ${action}</span>` : ''}
        <span class="clk-plus"></span>
        ${chipsHtml}
      </div>`;
    }).join('')}</div>
  </div>` : '';

  // ── Scoring infirmière N8N v7 ────────────────────────────────────────────────
  const scoring = d.infirmiere_scoring || {};
  const scoringBloc = (scoring.level && scoring.level !== 'SAFE') ? (() => {
    const col = scoring.level === 'DANGER' ? '#ef4444' : '#f59e0b';
    return `<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:rgba(239,68,68,.06);border:1px solid ${col};font-size:11px">
      <span style="color:${col};font-weight:700">${scoring.level === 'DANGER' ? '🚨' : '⚠️'} Scoring IDE : ${scoring.level}</span>
      ${scoring.score != null ? ` (${scoring.score} pts)` : ''}
    </div>`;
  })() : '';

  // ── Bandeau estimation automatique (A3) ────────────────────────────────────
  // Affiché UNIQUEMENT quand la détection NGAP a vraiment échoué :
  // - 0 acte détecté (impossible en pratique, mais au cas où)
  // - 1 seul acte AMI1 qui est le DÉFAUT (pas un vrai match)
  // Si le moteur a ajouté d'autres codes (AMI14, NUIT_PROF, BSC, etc.) via règles
  // déclaratives ou majorations temporelles, la détection a fonctionné → pas de bandeau.
  // NB : distinguer AMI1_INJ_INSULINE/AMI1_INJ_IM (vraies détections) de "AMI1 défaut".
  const _hasOnlyDefaultAMI1 =
    a.length === 0 ||
    (a.length === 1 && a[0].code === 'AMI1' && !!a[0]._estimation);
  const _hasNoRealAct = !a.some(x =>
    x && x.code &&
    x.code !== 'AMI1' &&      // exclut AMI1 défaut
    !/^(NUIT|DIM|IFD|IFI|IK|MCI|MIE|MAU)$/.test(x.code)  // exclut majorations/déplacements seuls
  );
  // Bandeau affiché UNIQUEMENT si aucun acte médical réel n'a été détecté
  const _isEstimation = _hasOnlyDefaultAMI1 || (!!d.fallback && _hasNoRealAct && a.length <= 1);
  const estimationBannerBloc = _isEstimation
    ? `<div style="margin-bottom:14px;padding:10px 14px;border-radius:8px;
          background:rgba(251,191,36,.10);border:1px solid rgba(251,191,36,.35);
          display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;flex-shrink:0;line-height:1.3">⚠️</span>
        <div>
          <div style="font-size:12px;font-weight:700;color:#b45309;margin-bottom:2px">
            Estimation automatique — vérification recommandée
          </div>
          <div style="font-size:11px;color:var(--m);line-height:1.5">
            Aucun acte NGAP n'a été détecté avec certitude dans votre description.
            Le code <strong>AMI1</strong> a été appliqué par défaut.
            Précisez le type de soin (injection, pansement, perfusion…) pour
            obtenir une cotation exacte.
          </div>
        </div>
      </div>`
    : '';

  // ── Alertes NGAP ────────────────────────────────────────────────────────────
  // Les alertes de type "cumul interdit" ou "code non reconnu" deviennent cliquables :
  // elles ouvrent une ligne d'actions (remplacer/supprimer/préciser) directement dans la carte.
  const alertsBloc = al.length
    ? `<div class="aic" style="margin-top:12px">${al.map((x, i) => {
        const isErr = x.startsWith('🚨') || x.startsWith('❌');
        const isOk  = x.startsWith('✅');
        const isInfo = x.startsWith('ℹ️');
        const cls = isErr ? 'er' : isOk ? 'su' : isInfo ? 'in' : 'wa';
        // Pas d'actions sur les messages OK / Info
        const actionsHtml = (isOk || isInfo) ? '' : _vmBuildAlertActions(x);
        return `<div class="ai ${cls}${actionsHtml ? ' ai-has-actions' : ''}">
          <div>${x}</div>
          ${actionsHtml}
        </div>`;
      }).join('')}</div>`
    : `<div class="ai su" style="margin-top:12px">✅ Aucune alerte NGAP</div>`;

  // ── Optimisations ajoutées par N8N ──────────────────────────────────────────
  const opBloc = op.length ? `<div style="margin-top:12px">
    <div class="lbl" style="font-size:10px;margin-bottom:6px">⬆️ Optimisations appliquées</div>
    <div class="aic">${op.map((o, i) => {
      const msg = typeof o === 'string' ? o : (o.msg || JSON.stringify(o));
      const msgEsc = msg.replace(/'/g, "\\'").replace(/"/g, '&quot;');

      // Info/protection au milieu des optims → non-cliquable
      const isInfo = _cotIsInfoSuggestion(msg);
      if (isInfo) {
        return `<div class="ai su" style="border-left:3px solid #6366f1;cursor:default">💡 ${msg}</div>`;
      }

      // Extraction des groupes (codes reliés par "+" → 1 chip combo)
      let chips = [];
      try { chips = _cotExtractNgapChips(msg); } catch (_) {}
      const chipsHtml = chips.length
        ? `<div class="ngap-chip-lbl">💡 Ajouter à la description :</div>
           <div class="ngap-chips">${chips.map(c => {
             const ins = c.insert.replace(/'/g, "\\'").replace(/"/g, '&quot;');
             const dsp = c.display.replace(/"/g, '&quot;');
             return `<span class="ngap-chip" onclick="event.stopPropagation();window._cotClickAppend(this,'${ins}','${dsp}')" title="Ajouter « ${dsp} » à la description">${dsp}</span>`;
           }).join('')}</div>`
        : '';
      return `<div class="ai su clk"
                   onclick="window._cotClickAppend(this,'${msgEsc}','Optimisation ${i + 1}')"
                   title="Cliquer pour ajouter cette optimisation à la description">
        💰 ${msg}
        <span class="clk-plus"></span>
        ${chipsHtml}
      </div>`;
    }).join('')}</div>
  </div>` : '';

  return `<div class="card cot-res-premium">

  <!-- ══ HEADER : total + actions ══ -->
  <div class="cot-res-header">
    <div>
      <div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--m);margin-bottom:6px">Total cotation</div>
      <div class="cot-res-total-wrap">
        <div class="ta">${(d.total || 0).toFixed(2)}</div>
        <div class="tu">€</div>
      </div>
      <!-- Badges statut : conformité NGAP, DRE, horaire -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center">
        ${al.every(x => !x.startsWith('🚨') && !x.startsWith('❌')) && !al.some(x=>x.startsWith('⚠️'))
          ? `<div class="cot-conformite-badge">✓ Conforme NGAP</div>`
          : `<div class="cot-conformite-badge warn">⚠ Vérification requise</div>`}
        ${d.dre_requise ? '<div class="dreb">📋 DRE requise</div>' : ''}
        ${ngapBadge}
        ${horaireBadge}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
        ${fraudBadge}
        ${preuveBadge}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;flex-shrink:0">
      <button class="btn bs bsm" onclick='printInv(${JSON.stringify(d).replace(/'/g, "&#39;")})'>📥 Télécharger facture</button>
      ${window._editingCotation ? `<button class="btn bp bsm" onclick='_saveEditedCotation(${JSON.stringify(d).replace(/'/g, "&#39;")})'>💾 Mettre à jour</button>` : ''}
    </div>
  </div>

  <!-- ══ DÉCOMPOSITION AMO / AMC / PATIENT ══ -->
  <div class="rg" style="margin-bottom:20px">
    <div class="rc am">
      <div class="rl">Part AMO (SS)</div>
      <div class="ra">${fmt(d.part_amo)}</div>
      <div class="rp">${d.taux_amo ? Math.round(d.taux_amo * 100) + '%' : '60%'} Séc. Sociale</div>
    </div>
    <div class="rc mc">
      <div class="rl">Part AMC</div>
      <div class="ra">${fmt(d.part_amc)}</div>
      <div class="rp">Complémentaire</div>
    </div>
    <div class="rc pa">
      <div class="rl">Part Patient</div>
      <div class="ra">${fmt(d.part_patient)}</div>
      <div class="rp">Ticket modérateur</div>
    </div>
  </div>

  <!-- ══ DÉTAIL DES ACTES ══ -->
  <div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--m);margin-bottom:10px">Détail des actes <span style="color:var(--m);opacity:.7;text-transform:none;letter-spacing:0;font-family:inherit;font-size:10px;margin-left:6px">(cliquez pour ajouter à la description)</span></div>
  <div class="al" style="margin-bottom:0">${a.length
    ? a.map(x => {
        const code = (x.code || '').trim();
        const nom  = (x.nom  || '').trim();
        // Fragment à injecter : code + libellé court (ex : "AMI9 Perfusion courte")
        // On tronque le nom au 1er séparateur pour garder l'insertion compacte
        const nomShort = nom.split(/[—–\-:()]/)[0].trim().slice(0, 48);
        const insertTxt = (code + (nomShort ? ' ' + nomShort : '')).trim();
        const insertEsc = insertTxt.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const labelEsc  = (code || nomShort || 'acte').replace(/"/g, '&quot;');
        // Pas de clic si aucun code/nom exploitable
        const clickable = !!insertTxt;
        return `<div class="ar${clickable ? ' clk' : ''}"
            ${clickable ? `onclick="window._cotClickAppend(this,'${insertEsc}','${labelEsc}')"` : ''}
            ${clickable ? `title="Cliquer pour ajouter « ${labelEsc} » à la description"` : ''}>
        <div class="ac ${cc(x.code)}">${x.code || '?'}</div>
        <div class="an" style="flex:1">
          <div style="font-size:13px;color:var(--t)">${x.nom || ''}</div>
          ${x.description && x.description !== x.nom ? `<div style="font-size:11px;color:var(--m);margin-top:1px">${x.description}</div>` : ''}
        </div>
        <div class="ao" style="color:var(--m)">×${(x.coefficient || 1).toFixed(1)}</div>
        <div class="at" style="color:var(--t);font-weight:700">${fmt(x.total)}</div>
      </div>`;
      }).join('')
    : '<div class="ai wa">⚠️ Aucun acte retourné</div>'}
  </div>

  ${(() => {
    // ══ BANDEAU RÉGRESSION D'ACTES ══
    // Détecte les actes présents dans l'ancienne cotation (_prevActes) qui ont
    // disparu de la nouvelle. Arrive typiquement quand une re-cotation utilise
    // une description incomplète (ex: AMI4 n'est plus dans f-txt).
    try {
      const editRef = window._editingCotation;
      const prevActes = editRef?._prevActes;
      if (!Array.isArray(prevActes) || !prevActes.length) return '';
      // Codes présents dans la nouvelle cotation (normalisation MAJ sans espaces)
      const normNew = new Set((a || []).map(x => String(x.code || '').toUpperCase().replace(/\s+/g, '')));
      const missing = prevActes.filter(p => {
        const k = String(p.code || '').toUpperCase().replace(/\s+/g, '');
        return k && !normNew.has(k);
      });
      if (!missing.length) return '';
      // Chip pour chaque acte manquant : clic = ajoute "CODE NOM" à f-txt
      const missChips = missing.map(p => {
        const code   = String(p.code || '').trim();
        const nom    = String(p.nom  || '').trim();
        const short  = nom.split(/[—–\-:()]/)[0].trim().slice(0, 40);
        const insTxt = (code + (short ? ' ' + short : '')).trim();
        const insEsc = insTxt.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const dspEsc = code.replace(/"/g, '&quot;');
        return `<span class="ngap-chip warn" onclick="window._cotClickAppend(this,'${insEsc}','${dspEsc}')" title="Remettre « ${dspEsc} » dans la description">${dspEsc}</span>`;
      }).join('');
      return `
      <div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(251,191,36,.08);border:1px solid #f59e0b">
        <div style="font-size:11px;font-weight:700;color:#f59e0b;margin-bottom:4px;display:flex;align-items:center;gap:6px">
          ⚠️ Acte${missing.length > 1 ? 's' : ''} principal${missing.length > 1 ? 'aux' : ''} disparu${missing.length > 1 ? 's' : ''} depuis la re-cotation
        </div>
        <div style="font-size:11px;color:var(--m);margin-bottom:8px">
          La cotation précédente contenait ${missing.length} acte${missing.length > 1 ? 's' : ''} qui ne figure${missing.length > 1 ? 'nt' : ''} plus dans celle-ci.
          Si vous validez « Mettre à jour », il${missing.length > 1 ? 's' : ''} sera${missing.length > 1 ? 'nt' : ''} perdu${missing.length > 1 ? 's' : ''}.
        </div>
        <div class="ngap-chip-lbl" style="margin-top:0">💡 Remettre dans la description et re-coter :</div>
        <div class="ngap-chips">${missChips}</div>
      </div>`;
    } catch (_) { return ''; }
  })()}

  <!-- ══ ALERTES + OPTIMISATIONS + SUGGESTIONS + CPAM + SCORING ══ -->
  ${estimationBannerBloc}
  ${alertsBloc}
  ${opBloc}
  ${suggBloc}
  ${cpamBloc}
  ${scoringBloc}

  </div>`;
}

/* Sauvegarde le résultat re-coté dans la cotation existante du carnet patient */
async function _saveEditedCotation(d) {
  const ref = window._editingCotation;
  if (!ref) return;

  const { patientId, cotationIdx, invoice_number: refInvoice, _fromTournee } = ref;
  // invoice_number final : préférer celui retourné par l'IA (PATCH Supabase),
  // sinon celui stocké dans ref (tournée sans re-cotation)
  const invNum = d.invoice_number || refInvoice || null;

  try {
    // ── 1. Mise à jour IDB carnet patient ───────────────────────────────────
    if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
      // Chercher la fiche patient : par ID direct si dispo, sinon par nom dans f-pt
      let row = null;
      const allRows = await _idbGetAll(PATIENTS_STORE);

      if (patientId) {
        row = allRows.find(r => r.id === patientId);
      }
      if (!row) {
        // Fallback : recherche par nom dans le champ f-pt
        const nomField = (typeof gv === 'function' ? gv('f-pt') : '') || '';
        const nomLow   = nomField.toLowerCase().trim();
        if (nomLow) {
          row = allRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(nomLow) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(nomLow)
          );
        }
      }

      // Si aucune fiche trouvée et qu'on vient de la tournée (pas depuis fiche patient)
      // → créer la fiche patient automatiquement avec cette cotation
      if (!row && _fromTournee && typeof _enc === 'function') {
        const nomField = (typeof gv === 'function' ? gv('f-pt') : '') || '';
        if (nomField.trim()) {
          const parts  = nomField.trim().split(/\s+/);
          const prenom = parts.slice(0, -1).join(' ') || nomField.trim();
          const nom    = parts.length > 1 ? parts[parts.length - 1] : '';
          const newPat = {
            id: 'pat_' + Date.now(), nom, prenom,
            ddn:        (typeof gv === 'function' ? gv('f-ddn') : '') || '',
            amo:        (typeof gv === 'function' ? gv('f-amo') : '') || '',
            cotations: [{
              date:           new Date().toISOString(),
              actes:          d.actes || [],
              total:          parseFloat(d.total || 0),
              invoice_number: invNum,
              source:         'cotation_edit',
              _synced:        false,
            }],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            source:     'tournee_auto',
          };
          if (typeof _idbPut === 'function') {
            const _toStoreTN = { id: newPat.id, nom, prenom, _data: _enc(newPat), updated_at: newPat.updated_at };
            await _idbPut(PATIENTS_STORE, _toStoreTN);
            // Sync immédiate vers carnet_patients — propagation inter-appareils
            if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStoreTN).catch(() => {});
          }
          const toast = typeof showToast === 'function' ? showToast : (typeof showToastSafe === 'function' ? showToastSafe : null);
          if (toast) toast('👤 Fiche patient créée : ' + nomField.trim());
        }
      }

      if (row) {
        const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
        if (!Array.isArray(p.cotations)) p.cotations = [];

        // Résoudre l'index de la cotation à mettre à jour :
        // 1. cotationIdx direct (fiche patient)
        // 2. Recherche par invoice_number (tournée)
        // 3. Recherche par source tournee + date du jour (dernier fallback)
        let idx = (typeof cotationIdx === 'number' && cotationIdx >= 0) ? cotationIdx : -1;
        if (idx < 0 && invNum) {
          idx = p.cotations.findIndex(c => c.invoice_number === invNum);
        }
        if (idx < 0 && invNum && refInvoice) {
          idx = p.cotations.findIndex(c => c.invoice_number === refInvoice);
        }
        if (idx < 0 && _fromTournee) {
          const today = new Date().toISOString().slice(0, 10);
          idx = p.cotations.findIndex(c =>
            (c.source === 'tournee' || c.source === 'tournee_auto' ||
             c.source === 'tournee_live' || c.source === 'cotation_edit') &&
            (c.date || '').slice(0, 10) === today
          );
        }

        const updatedCot = {
          ...(idx >= 0 ? p.cotations[idx] : {}),
          actes:        d.actes || [],
          total:        parseFloat(d.total || 0),
          part_amo:     parseFloat(d.part_amo || 0),
          part_amc:     parseFloat(d.part_amc || 0),
          part_patient: parseFloat(d.part_patient || 0),
          dre_requise:  !!d.dre_requise,
          invoice_number: invNum || (idx >= 0 ? p.cotations[idx]?.invoice_number : null),
          source:       'cotation_edit',
          date_edit:    new Date().toISOString(),
          // Conserver la date originale du soin
          date: (idx >= 0 && p.cotations[idx]?.date)
            ? p.cotations[idx].date
            : (typeof gv === 'function' ? gv('f-ds') : '') || new Date().toISOString().slice(0, 10),
          heure: (idx >= 0 && p.cotations[idx]?.heure)
            ? p.cotations[idx].heure
            : (typeof gv === 'function' ? gv('f-hs') : '') || '',
          soin: (idx >= 0 && p.cotations[idx]?.soin)
            ? p.cotations[idx].soin
            : (typeof gv === 'function' ? (gv('f-txt') || '').slice(0, 120) : ''),
        };

        if (idx >= 0) {
          // Cotation existante → mise à jour stricte
          p.cotations[idx] = updatedCot;
        }
        // Si idx < 0 : cotation introuvable mais patient existe
        // → NE PAS créer de doublon. L'upsert Supabase (bloc 2) gérera la synchro.

        p.updated_at = new Date().toISOString();
        const _toStoreTE = { id: row.id, nom: row.nom, prenom: row.prenom, _data: _enc(p), updated_at: p.updated_at };
        await _idbPut(PATIENTS_STORE, _toStoreTE);
        // Sync immédiate vers carnet_patients — propagation inter-appareils
        if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStoreTE).catch(() => {});
      }
    }

    // ── 2. Sync Supabase (PATCH si invoice_number connu) ────────────────────
    if (invNum && typeof apiCall === 'function') {
      apiCall('/webhook/ami-save-cotation', {
        cotations: [{
          actes:          d.actes || [],
          total:          d.total || 0,
          part_amo:       d.part_amo || 0,
          part_amc:       d.part_amc || 0,
          part_patient:   d.part_patient || 0,
          dre_requise:    !!d.dre_requise,
          source:         'cotation_edit',
          invoice_number: invNum,
        }]
      }).catch(() => {});
    }

    // ── 3. Invalider le cache dashboard ─────────────────────────────────────
    try {
      const _key = (typeof _dashCacheKey === 'function') ? _dashCacheKey()
        : 'ami_dash_cache_' + ((typeof S !== 'undefined' ? S?.user?.id : '') || '');
      localStorage.removeItem(_key);
    } catch {}

    // ── 4. Réinitialiser + feedback ─────────────────────────────────────────
    window._editingCotation = null;

    const toast = typeof showToast === 'function' ? showToast
      : (typeof showToastSafe === 'function' ? showToastSafe : null);
    if (toast) toast('✅ Cotation mise à jour — ' + (d.total||0).toFixed(2) + ' €');

    // Retourner sur la fiche patient si on vient de la fiche (pas de la tournée)
    if (!_fromTournee && patientId) {
      setTimeout(() => {
        if (typeof navTo === 'function') navTo('patients', null);
        setTimeout(() => {
          if (typeof openPatientDetail === 'function') openPatientDetail(patientId);
        }, 200);
      }, 800);
    }

  } catch(e) {
    const toast = typeof showToast === 'function' ? showToast
      : (typeof showToastSafe === 'function' ? showToastSafe : null);
    if (toast) toast('❌ ' + e.message);
    console.warn('[AMI] _saveEditedCotation KO:', e.message);
  }
}

/* ════════════════════════════════════════════════
   IMPRESSION / PDF
   ────────────────────────────────────────────────
   1. Vérifie si ADELI, RPPS, Structure sont renseignés
   2. Si manquants → modale de complétion avec 2 choix :
        a) Enregistrer + Imprimer
        b) Imprimer sans ces infos
   3. Si complets → impression directe
════════════════════════════════════════════════ */
async function printInv(d) {
  const u = S?.user || {};
  const missing = [];
  if (!u.adeli)     missing.push('N° ADELI');
  if (!u.rpps)      missing.push('N° RPPS');
  if (!u.structure) missing.push('Cabinet / Structure');

  if (missing.length > 0) {
    /* Infos manquantes → afficher la modale de complétion */
    _pendingPrintData = d;
    _showProInfoModal(u, missing);
  } else {
    /* Tout est renseigné → imprimer directement */
    await _doPrint(d, u);
  }
}

/* Affiche la modale avec les champs manquants pré-remplis */
async function _showProInfoModal(u, missing) {
  const modal = $('pro-info-modal');
  if (!modal) { /* fallback si la modale n'existe pas dans le HTML */ await _doPrint(_pendingPrintData, u); return; }

  /* Liste des champs manquants */
  const listEl = $('pro-info-missing-list');
  if (listEl) listEl.innerHTML = `⚠️ Ces informations sont absentes de votre profil :<br><strong>${missing.join(' · ')}</strong><br><span style="font-size:11px;opacity:.8">Elles sont recommandées sur une facture de soins réglementaire.</span>`;

  /* Pré-remplir avec les valeurs existantes si partielles */
  const piAdeli = $('pi-adeli'), piRpps = $('pi-rpps'), piStruct = $('pi-structure');
  if (piAdeli)  { piAdeli.value  = u.adeli     || ''; piAdeli.required  = !u.adeli; }
  if (piRpps)   { piRpps.value   = u.rpps      || ''; piRpps.required   = !u.rpps; }
  if (piStruct) { piStruct.value = u.structure || ''; piStruct.required = !u.structure; }

  /* Masquer uniquement les champs déjà renseignés */
  if ($('pi-adeli')?.closest('.af'))  $('pi-adeli').closest('.af').style.display  = u.adeli     ? 'none' : '';
  if ($('pi-rpps')?.closest('.af'))   $('pi-rpps').closest('.af').style.display   = u.rpps      ? 'none' : '';
  if ($('pi-structure')?.closest('.af')) $('pi-structure').closest('.af').style.display = u.structure ? 'none' : '';

  /* Reset message */
  const msg = $('pro-info-msg');
  if (msg) msg.style.display = 'none';

  /* Bouton "Enregistrer et imprimer" */
  const btnSave = $('btn-pi-save-print');
  if (btnSave) {
    btnSave.onclick = async () => {
      const adeli     = sanitize(gv('pi-adeli')  || u.adeli     || '');
      const rpps      = sanitize(gv('pi-rpps')   || u.rpps      || '');
      const structure = sanitize(gv('pi-structure') || u.structure || '');

      btnSave.disabled = true;
      btnSave.innerHTML = '<span class="spin"></span> Enregistrement…';

      try {
        const res = await wpost('/webhook/profil-save', {
          nom: u.nom || '', prenom: u.prenom || '',
          adeli, rpps, structure,
          adresse: u.adresse || '', tel: u.tel || ''
        });
        if (!res.ok) throw new Error(res.error || 'Erreur sauvegarde');

        /* Mettre à jour la session locale */
        S.user = { ...S.user, adeli, rpps, structure };
        ss.save(S.token, S.role, S.user);

        closeProInfoModal();
        await _doPrint(_pendingPrintData, S.user);
      } catch (e) {
        const msg = $('pro-info-msg');
        if (msg) { msg.textContent = '❌ ' + e.message; msg.style.display = 'block'; }
      } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = '<span>💾</span> Enregistrer et imprimer';
      }
    };
  }

  /* Bouton "Imprimer sans ces informations" */
  const btnAnyway = $('btn-pi-print-anyway');
  if (btnAnyway) {
    btnAnyway.onclick = async () => {
      closeProInfoModal();
      await _doPrint(_pendingPrintData, u);
    };
  }

  modal.style.display = 'flex';
}

function closeProInfoModal() {
  const modal = $('pro-info-modal');
  if (modal) modal.style.display = 'none';
  _pendingPrintData = null;
}

/* ════════════════════════════════════════════════
   GÉNÉRATION PDF / IMPRESSION
   ────────────────────────────────────────────────
   Affiche toutes les infos pro disponibles :
   - Nom complet
   - N° ADELI (si présent)
   - N° RPPS (si présent)
   - Cabinet / Structure (si présent)
   - Date + N° facture
   - Signature électronique patient (si disponible)
════════════════════════════════════════════════ */
async function _doPrint(d, u) {
  if (!d) return;
  const ac  = d.actes || [];
  // Priorité au numéro généré par le serveur (séquentiel CPAM)
  // Fallback local uniquement si le worker n'a pas encore renvoyé le numéro
  const num = d.invoice_number || ('F' + new Date().getFullYear() + '-' + String(Date.now()).slice(-6));
  const inf = ((u.prenom || '') + ' ' + (u.nom || '')).trim() || 'Infirmier(ère) libéral(e)';

  /* ── Récupération signature électronique (si cotation signée) ──
     Priorité :
       1. d._sig_html pré-calculé par le monkey-patch signature.js
       2. Appel direct à injectSignatureInPDF(invoice_number) — fallback robuste
     Résultat : bloc HTML avec signature PNG base64 + zone infirmier. */
  let sigHtml = d._sig_html || '';
  if (!sigHtml && d.invoice_number && typeof window.injectSignatureInPDF === 'function') {
    try {
      sigHtml = await window.injectSignatureInPDF(d.invoice_number) || '';
    } catch (_e) {
      sigHtml = '';
    }
  }

  /* Bloc infos prescripteur (si disponible) */
  const prescBloc = d.prescripteur
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e0e7ef">
        <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:6px">Prescripteur</div>
        <div style="font-weight:600">${d.prescripteur.nom || ''}</div>
        ${d.prescripteur.rpps ? `<div style="font-size:12px;color:#6b7a99">RPPS : <strong style="color:#1a1a2e">${d.prescripteur.rpps}</strong></div>` : ''}
        ${d.prescripteur.specialite ? `<div style="font-size:12px;color:#6b7a99">${d.prescripteur.specialite}</div>` : ''}
        ${gv('f-pr-dt') ? `<div style="font-size:12px;color:#6b7a99">Prescription du : ${gv('f-pr-dt')}</div>` : ''}
       </div>`
    : (gv('f-pr') ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e0e7ef">
        <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:6px">Prescripteur</div>
        <div style="font-weight:600">${gv('f-pr')}</div>
        ${gv('f-pr-rp') ? `<div style="font-size:12px;color:#6b7a99">RPPS : ${gv('f-pr-rp')}</div>` : ''}
        ${gv('f-pr-dt') ? `<div style="font-size:12px;color:#6b7a99">Prescription du : ${gv('f-pr-dt')}</div>` : ''}
       </div>` : '');

  /* Bloc infos professionnelles — affiche seulement les champs renseignés */
  const infoPro = [
    u.structure ? `<div style="font-weight:600;margin-bottom:2px">${u.structure}</div>` : '',
    `<div>${inf}</div>`,
    u.adeli  ? `<div style="color:#6b7a99;font-size:12px">N° ADELI : <strong style="color:#1a1a2e">${u.adeli}</strong></div>`  : '',
    u.rpps   ? `<div style="color:#6b7a99;font-size:12px">N° RPPS : <strong style="color:#1a1a2e">${u.rpps}</strong></div>`    : '',
    u.adresse? `<div style="color:#6b7a99;font-size:12px">${u.adresse}</div>` : '',
    u.tel    ? `<div style="color:#6b7a99;font-size:12px">Tél : ${u.tel}</div>` : '',
  ].filter(Boolean).join('\n');

  /* Avertissement si infos manquantes */
  const missingWarning = (!u.adeli || !u.rpps || !u.structure)
    ? `<div style="background:#fff8e1;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#92400e">
        ⚠️ Facture générée sans : ${[!u.adeli?'N° ADELI':'',!u.rpps?'N° RPPS':'',!u.structure?'Cabinet/Structure':''].filter(Boolean).join(', ')}
       </div>`
    : '';

  /* ── Construction du HTML de facture ── */
  const htmlContent = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Facture ${num}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; padding: 40px; font-size: 14px; color: #1a1a2e; }
  h1 { font-size: 26px; color: #0b3954; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #6b7a99; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 18px; border-bottom: 2px solid #e0e7ef; gap: 20px; }
  .hdr-left h1 { margin-bottom: 4px; }
  .hdr-right { text-align: right; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th { background: #f0f4fa; padding: 9px 12px; text-align: left; font-size: 11px; text-transform: uppercase; color: #6b7a99; letter-spacing: .5px; }
  td { padding: 10px 12px; border-bottom: 1px solid #e8edf5; }
  tfoot td { font-weight: 700; border-top: 2px solid #ccd5e0; background: #f7f9fc; }
  .rep { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 20px; }
  .rc { background: #f7f9fc; padding: 14px; border-radius: 8px; text-align: center; }
  .rl { font-size: 11px; text-transform: uppercase; color: #6b7a99; margin-bottom: 4px; }
  .rv { font-size: 22px; font-weight: 700; color: #0b3954; }
  .dre { margin-top: 16px; padding: 10px 14px; background: #e8f4ff; border-radius: 6px; font-size: 13px; color: #2563eb; }
  .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #e0e7ef; font-size: 11px; color: #9ca3af; text-align: center; }
  .print-btn { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 20px; padding: 10px 20px; background: #0b3954; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  @media print { .print-btn, .no-print { display: none !important; } body { padding: 20px; } }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>
${missingWarning}
<div class="hdr">
  <div class="hdr-left">
    <h1>Feuille de soins</h1>
    <div class="meta">N° ${num} · ${new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
    ${d.date_soin ? `<div class="meta">Date du soin : ${d.date_soin}</div>` : ''}
    ${d.ngap_version ? `<div class="meta" style="color:#9ca3af">NGAP v${d.ngap_version}</div>` : ''}
  </div>
  <div class="hdr-right">
    ${infoPro}
    ${prescBloc}
  </div>
</div>

<table>
  <thead><tr><th>Code</th><th>Acte médical</th><th style="text-align:right">Coef.</th><th style="text-align:right">Montant</th></tr></thead>
  <tbody>
    ${ac.map(x => `<tr>
      <td style="font-weight:600;font-size:13px;color:#0b3954">${x.code || ''}</td>
      <td>${x.nom || ''}</td>
      <td style="text-align:right;color:#6b7a99">×${(x.coefficient || 1).toFixed(1)}</td>
      <td style="text-align:right;font-weight:600">${fmt(x.total)}</td>
    </tr>`).join('')}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="3" style="text-align:right">TOTAL</td>
      <td style="text-align:right;font-size:16px">${fmt(d.total)}</td>
    </tr>
  </tfoot>
</table>

<div class="rep">
  <div class="rc"><div class="rl">Part AMO (SS)</div><div class="rv">${fmt(d.part_amo)}</div></div>
  <div class="rc"><div class="rl">Part AMC</div><div class="rv">${fmt(d.part_amc)}</div></div>
  <div class="rc"><div class="rl">Part Patient</div><div class="rv">${fmt(d.part_patient)}</div></div>
</div>

${d.dre_requise ? '<div class="dre">📋 <strong>DRE requise</strong> — Demande de Remboursement Exceptionnel</div>' : ''}

${sigHtml || ''}

<div class="footer">
  AMI NGAP · N° facture : ${num} · Tarifs NGAP 2026 — AMI 3,15 € · BSA 13,00 € · BSB 18,20 € · BSC 28,70 € · IFD 2,75 € · MCI 5,00 € · MIE 3,15 € · Nuit 9,15 € · Nuit prof. 18,30 € · Dim./Fér. 8,50 € · Généré le ${new Date().toLocaleDateString('fr-FR')}
</div>
</body>
</html>`;

  /* ── Téléchargement via Blob (contourne le blocage popup navigateur) ── */
  try {
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `facture-${num}.html`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    /* Nettoyer après 3s */
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (a.parentNode) document.body.removeChild(a);
    }, 3000);
    /* Feedback visuel */
    const btn = document.querySelector('[onclick*="printInv"]') || document.querySelector('.btn.bs');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✅ Téléchargé !';
      setTimeout(() => { btn.innerHTML = orig; }, 2500);
    }
  } catch (e) {
    /* Fallback : essayer window.open si Blob échoue (très rare) */
    const w = window.open('', '_blank');
    if (!w) { alert('Impossible d\'ouvrir la facture. Vérifiez que les popups sont autorisés.'); return; }
    w.document.write(htmlContent);
    w.document.close();
  }
}

/* ════════════════════════════════════════════════
   VÉRIFICATION IA (modale)
════════════════════════════════════════════════ */
async function openVerify() {
  const txt = gv('f-txt');
  if (!txt) { alert("Saisissez d'abord une description du soin."); return; }

  // Loading visuel sur le bouton lui-même (en plus de la modale)
  const _btnVerify = $('btn-verify');
  const _origLabel = _btnVerify ? _btnVerify.innerHTML : null;
  if (_btnVerify) {
    _btnVerify.innerHTML = '<span class="spin spinw" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></span> Analyse en cours…';
    _btnVerify.disabled = true;
  }

  $('vm').classList.add('open');
  $('vm-loading').style.display = 'block';
  $('vm-result').style.display = 'none';
  $('vm-apply').style.display = 'none';
  $('vm-cotate').style.display = 'none';
  VM_DATA = null;

  // ── Pré-warm N8N en parallèle (au cas où le worker dort) ──
  // Ne bloque pas — le vrai appel est verify ci-dessous
  try { if (typeof _cotPrewarmN8N === 'function') _cotPrewarmN8N(); } catch (_) {}

  // ── Feedback progressif si N8N est lent (cold-start Render ~30s) ──
  const _slowMsgs = [
    { delay: 6000,  msg: '🤖 N8N analyse votre description…' },
    { delay: 18000, msg: '🤖 Service en cours de réveil — patientez…' },
    { delay: 35000, msg: '🤖 Démarrage du service N8N (cold-start)…' },
  ];
  const _slowTimers = [];
  const _vmLoadingMsg = $('vm-loading')?.querySelector('p');
  const _origMsg = _vmLoadingMsg ? _vmLoadingMsg.textContent : null;
  _slowMsgs.forEach(({ delay, msg }) => {
    _slowTimers.push(setTimeout(() => {
      if (_vmLoadingMsg) _vmLoadingMsg.textContent = msg;
    }, delay));
  });
  const _clearVerifyTimers = () => {
    _slowTimers.forEach(t => clearTimeout(t));
    if (_vmLoadingMsg && _origMsg) _vmLoadingMsg.textContent = _origMsg;
    if (_btnVerify) {
      if (_origLabel) _btnVerify.innerHTML = _origLabel;
      _btnVerify.disabled = false;
    }
  };

  try {
    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'verify',
      _force_n8n: true,       // ⚡ force l'appel N8N — bypass moteur local + cache + circuit breaker
      _no_local_fallback: true, // pas de fallback NGAPEngine ici : on VEUT N8N pour la vérif
      texte: txt, ddn: gv('f-ddn'),
      date_soin: gv('f-ds'), heure_soin: gv('f-hs'),
      exo: gv('f-exo'), regl: gv('f-regl'),
    });
    _clearVerifyTimers();
    VM_DATA = d;
    renderVM(d);
  } catch (e) {
    _clearVerifyTimers();
    $('vm-loading').style.display = 'none';
    // Message d'erreur plus parlant selon le type
    let errMsg = e.message || 'Erreur inconnue';
    let errIcon = '⚠️';
    let errAdvice = '';
    if (/timeout|aborted|signal/i.test(errMsg)) {
      errIcon = '⏱️';
      errMsg = 'N8N n\'a pas répondu dans les temps (cold-start probable)';
      errAdvice = '<div style="margin-top:10px;font-size:12px;color:var(--m)">💡 Réessayez dans 15-30 secondes — le service est en cours de démarrage.</div>';
    } else if (/network|fetch|failed/i.test(errMsg)) {
      errIcon = '📡';
      errMsg = 'Connexion réseau impossible';
      errAdvice = '<div style="margin-top:10px;font-size:12px;color:var(--m)">💡 Vérifiez votre connexion internet.</div>';
    }
    $('vm-result').innerHTML = `
      <div class="vm-item warn">${errIcon} ${errMsg}</div>
      ${errAdvice}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="btn bp bsm" onclick="closeVM();setTimeout(openVerify,500)">🔄 Réessayer</button>
        <button class="btn bs bsm" onclick="closeVM();setTimeout(cotation,100)">⚡ Coter quand même</button>
      </div>
    `;
    $('vm-result').style.display = 'block';
  }
}

function renderVM(d) {
  $('vm-loading').style.display = 'none';
  $('vm-result').style.display = 'block';
  const corrige = d.texte_corrige || '', fixes = d.corrections || [],
        alerts = d.alerts || [], sugg = d.optimisations || [];
  const hasChanges = corrige || fixes.length || alerts.length || sugg.length;
  if (corrige && corrige !== gv('f-txt')) {
    $('vm-corr-wrap').style.display = 'block';
    $('vm-corrected-text').textContent = corrige;
    $('vm-apply').style.display = 'flex';
  } else { $('vm-corr-wrap').style.display = 'none'; }

  // ── Corrections : cliquables pour appliquer directement le fix au textarea ──
  if (fixes.length) {
    $('vm-fixes-wrap').style.display = 'block';
    $('vm-fixes').innerHTML = fixes.map((f, i) => {
      const txt = typeof f === 'string' ? f : (f.msg || f.text || JSON.stringify(f));
      const esc = txt.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      return `<div class="vm-item fix vm-clickable" onclick="window._vmApplyFix('${esc}',this)" title="Cliquer pour appliquer cette correction dans la description">✏️ ${txt} <span class="vm-act">+ Appliquer</span></div>`;
    }).join('');
  } else { $('vm-fixes-wrap').style.display = 'none'; }

  // ── Incohérences NGAP : actions contextuelles ──
  // Ex: "NUIT + NUIT_PROF non cumulables — appliquer NUIT_PROF si après 23h"
  //     → boutons "Remplacer NUIT par NUIT_PROF" et "Garder NUIT"
  // Ex: "Code AMI non reconnu dans le référentiel"
  //     → boutons "Supprimer AMI" et "Corriger en AMI 1"
  if (alerts.length) {
    $('vm-alerts-wrap').style.display = 'block';
    $('vm-alerts').innerHTML = alerts.map((a, i) => {
      const txt = typeof a === 'string' ? a : (a.msg || a.text || JSON.stringify(a));
      const actionsHtml = _vmBuildAlertActions(txt);
      return `<div class="vm-item warn" data-alert-idx="${i}">
        <div>⚠️ ${txt}</div>
        ${actionsHtml}
      </div>`;
    }).join('');
  } else { $('vm-alerts-wrap').style.display = 'none'; }

  // ── Suggestions : cliquables (ajout du code extrait ou de la suggestion entière) ──
  if (sugg.length) {
    $('vm-sugg-wrap').style.display = 'block';
    $('vm-sugg').innerHTML = sugg.map((s, i) => {
      const txt = typeof s === 'string' ? s : (s.msg || s.text || JSON.stringify(s));
      // Extraire les codes NGAP éventuels pour créer des chips
      let chips = [];
      try { chips = _cotExtractNgapChips(txt); } catch (_) {}
      const chipsHtml = chips.length
        ? `<div class="ngap-chips" style="margin-top:6px">${chips.map(c => {
            const ins = c.insert.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const dsp = c.display.replace(/"/g, '&quot;');
            return `<span class="ngap-chip" onclick="event.stopPropagation();window._cotClickAppend(this,'${ins}','${dsp}');window.closeVM&&setTimeout(window.closeVM,300)" title="Ajouter « ${dsp} » à la description puis fermer">${dsp}</span>`;
          }).join('')}</div>`
        : '';
      const esc = txt.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      return `<div class="vm-item sugg vm-clickable" onclick="window._vmApplySuggestion('${esc}',this)" title="Cliquer pour ajouter à la description">
        <div>💡 ${txt} <span class="vm-act">+ Ajouter</span></div>
        ${chipsHtml}
      </div>`;
    }).join('');
  } else { $('vm-sugg-wrap').style.display = 'none'; }

  $('vm-ok-wrap').style.display = hasChanges ? 'none' : 'block';
  $('vm-cotate').style.display = 'flex';
}

/* ═══════════════════════════════════════════════════════════════════════════
   Handlers pour les éléments cliquables dans la modale « Vérifier & corriger »
   ═══════════════════════════════════════════════════════════════════════════ */

/* Applique une correction proposée : ajoute le texte à f-txt */
function _vmApplyFix(fix, el) {
  if (typeof _cotAppendDesc === 'function') _cotAppendDesc(fix);
  if (el && el.classList) {
    el.classList.add('vm-applied');
    setTimeout(() => { try { el.classList.remove('vm-applied'); } catch(_){} }, 2000);
  }
  // Pas de fermeture automatique — on laisse l'utilisateur enchaîner
}

/* Applique une suggestion : ajoute le texte et ferme la modale */
function _vmApplySuggestion(sug, el) {
  if (typeof _cotAppendDesc === 'function') _cotAppendDesc(sug);
  if (el && el.classList) {
    el.classList.add('vm-applied');
  }
  setTimeout(() => { try { closeVM(); } catch(_) {} }, 400);
}

/* Construit les boutons d'action pour une alerte NGAP selon son contenu */
function _vmBuildAlertActions(alertTxt) {
  const s = String(alertTxt || '');
  const actions = [];

  // ── Pattern 1 : cumul interdit "X + Y non cumulables — appliquer Y si …" ──
  //   Ex: NUIT + NUIT_PROF non cumulables — appliquer NUIT_PROF si après 23h
  const cumul = s.match(/\b([A-Z][A-Z_0-9]*)\s*\+\s*([A-Z][A-Z_0-9]*)\s+non\s+cumulables?\s*[—\-:]+\s*appliquer\s+([A-Z][A-Z_0-9]*)/i);
  if (cumul) {
    const codeA = cumul[1].toUpperCase();
    const codeB = cumul[2].toUpperCase();
    const codeKeep = cumul[3].toUpperCase();
    const codeDrop = codeKeep === codeA ? codeB : codeA;
    actions.push({
      label: `→ Remplacer par ${codeKeep} seul`,
      action: `_vmReplaceCode('${codeDrop}','${codeKeep}',this)`,
      title: `Supprimer ${codeDrop} et conserver ${codeKeep} dans la description`,
    });
    actions.push({
      label: `Supprimer ${codeDrop}`,
      action: `_vmRemoveCode('${codeDrop}',this)`,
      title: `Retirer ${codeDrop} de la description`,
      secondary: true,
    });
  }

  // ── Pattern 2 : "Code X non reconnu dans le référentiel — accepté tel quel" ──
  // Ex: Code "AMI" non reconnu dans le référentiel — accepté tel quel
  const unknown = s.match(/code\s*["«]?\s*([A-Z][A-Z_0-9]*)\s*["»]?\s+non\s+reconnu/i);
  if (unknown && !cumul) {
    const code = unknown[1].toUpperCase();
    actions.push({
      label: `Supprimer "${code}"`,
      action: `_vmRemoveCode('${code}',this)`,
      title: `Retirer "${code}" de la description (code incomplet)`,
    });
    // Propose des remplacements courants si c'est "AMI" seul
    if (code === 'AMI') {
      ['AMI 1', 'AMI 4', 'AMI 9', 'AMI 14'].forEach(sug => {
        actions.push({
          label: `→ ${sug}`,
          action: `_vmReplaceCode('${code}','${sug}',this)`,
          title: `Remplacer "${code}" par "${sug}"`,
          secondary: true,
        });
      });
    }
    if (code === 'AIS') {
      ['AIS 3', 'AIS 4'].forEach(sug => {
        actions.push({
          label: `→ ${sug}`,
          action: `_vmReplaceCode('${code}','${sug}',this)`,
          secondary: true,
        });
      });
    }
  }

  // ── Pattern 3 : "Coefficient manquant pour X" / "coefficient requis" ──
  const coefMiss = s.match(/coefficient\s+(?:manquant|requis|obligatoire)\s*(?:pour\s*)?([A-Z][A-Z_0-9]*)?/i);
  if (coefMiss && !cumul && !unknown) {
    const code = (coefMiss[1] || '').toUpperCase();
    if (code) {
      actions.push({
        label: `Préciser ${code}…`,
        action: `_vmPromptCoef('${code}',this)`,
        title: `Saisir le coefficient correct pour ${code}`,
      });
    }
  }

  // ── Pattern 4 : "Acte X requis" / "manque X" ──
  const missReq = s.match(/(?:manque|requis|ajouter)\s+([A-Z][A-Z_0-9]*\s*\d*(?:[._/]\d+)?)/i);
  if (missReq && !cumul && !unknown && !coefMiss) {
    const code = missReq[1].trim();
    actions.push({
      label: `+ Ajouter ${code}`,
      action: `_vmAppendCode('${code}',this)`,
      title: `Ajouter ${code} à la description`,
    });
  }

  // ── Extraction générique : tout code NGAP mentionné dans l'alerte ──
  // (si aucun pattern spécifique n'a matché, on propose d'extraire les codes)
  if (!actions.length) {
    try {
      const chips = _cotExtractNgapChips(s);
      chips.forEach(c => {
        const ins = c.insert.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const dsp = c.display.replace(/"/g, '&quot;');
        actions.push({
          label: `+ ${dsp}`,
          action: `_vmAppendCode('${ins}',this)`,
          title: `Ajouter « ${dsp} » à la description`,
          secondary: true,
        });
      });
    } catch (_) {}
  }

  if (!actions.length) return '';
  return `<div class="vm-actions-row">${actions.map(a =>
    `<button type="button" class="vm-act-btn${a.secondary ? ' sec' : ''}" onclick="event.stopPropagation();window.${a.action}" title="${a.title || ''}">${a.label}</button>`
  ).join('')}</div>`;
}

/* Retire toutes les occurrences d'un code de la description (f-txt) */
function _vmRemoveCode(code, btn) {
  const el = $('f-txt'); if (!el) return;
  const cur = el.value || '';
  // Regex insensible à la casse, frontière mot, gère le "+" séparateur
  const reCode = new RegExp('\\s*\\+?\\s*\\b' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?:\\s+[a-zàâéèêëïîôùûüç0-9éè]+(?:\\s+[a-zàâéèêëïîôùûüç0-9éè]+){0,2})?', 'gi');
  const cleaned = cur.replace(reCode, '').replace(/\s{2,}/g, ' ').replace(/^\s*\+?\s*|\s*\+?\s*$/g, '').trim();
  el.value = cleaned;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (btn && btn.classList) btn.classList.add('vm-applied');
  if (typeof showToast === 'function') showToast(`✅ "${code}" retiré de la description`, 'su');
  // Active le FAB pour que l'utilisateur puisse relancer
  if (typeof _cotShowReCoteBar === 'function') _cotShowReCoteBar();
}

/* Remplace un code par un autre dans la description */
function _vmReplaceCode(oldCode, newCode, btn) {
  const el = $('f-txt'); if (!el) return;
  const cur = el.value || '';
  const reCode = new RegExp('\\b' + oldCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
  if (reCode.test(cur)) {
    // Remplacement direct
    const replaced = cur.replace(reCode, newCode);
    el.value = replaced;
  } else {
    // oldCode n'était pas présent → append newCode
    const sep = cur && !/[,+]\s*$/.test(cur) ? ' + ' : ' ';
    el.value = cur.trim() + sep + newCode;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (btn && btn.classList) btn.classList.add('vm-applied');
  if (typeof showToast === 'function') showToast(`✅ Remplacé par "${newCode}"`, 'su');
  if (typeof _cotShowReCoteBar === 'function') _cotShowReCoteBar();
}

/* Ajoute un code à la description */
function _vmAppendCode(code, btn) {
  if (typeof _cotAppendDesc === 'function') _cotAppendDesc(code);
  if (btn && btn.classList) btn.classList.add('vm-applied');
  if (typeof showToast === 'function') showToast(`✅ "${code}" ajouté`, 'su');
  if (typeof _cotShowReCoteBar === 'function') _cotShowReCoteBar();
}

/* Prompt pour préciser le coefficient d'un code */
function _vmPromptCoef(code, btn) {
  const coef = prompt(`Coefficient pour ${code} ? (ex: 1, 4, 4.1, 9, 14/15)`);
  if (!coef) return;
  const cleaned = String(coef).trim().replace(/,/g, '.');
  _vmReplaceCode(code, code + ' ' + cleaned, btn);
}

function applyVerify() { if (VM_DATA?.texte_corrige) $('f-txt').value = VM_DATA.texte_corrige; closeVM(); }
function closeVM() { $('vm').classList.remove('open'); }

async function verifyStandalone() {
  const txt = gv('v-txt');
  if (!txt) { alert('Saisissez une description.'); return; }
  ld('btn-ver', true);
  $('res-ver').classList.remove('show');
  try {
    const d = await apiCall('/webhook/ami-calcul', { mode: 'verify', _force_n8n: true, texte: txt, date_soin: gv('v-ds'), heure_soin: gv('v-hs'), exo: gv('v-exo') });
    const corrige = d.texte_corrige || '', fixes = d.corrections || [], alerts = d.alerts || [], sugg = d.optimisations || [];
    $('vbody').innerHTML = `<div class="card"><div class="ct">🔍 Résultat</div>
    ${corrige ? `<div style="margin-bottom:16px"><div class="lbl" style="color:var(--ok)">Texte normalisé</div><div style="background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:14px;font-style:italic;font-size:14px;line-height:1.7">${corrige}</div></div>` : ''}
    ${fixes.length  ? `<div class="aic" style="margin-bottom:14px">${fixes.map(f  => `<div class="ai su">✏️ ${f}</div>`).join('')}</div>` : ''}
    ${alerts.length ? `<div class="aic" style="margin-bottom:14px">${alerts.map(a => `<div class="ai wa">⚠️ ${a}</div>`).join('')}</div>` : ''}
    ${sugg.length   ? `<div class="aic">${sugg.map(s => `<div class="ai in">💡 ${s}</div>`).join('')}</div>` : ''}
    ${!corrige && !fixes.length && !alerts.length && !sugg.length ? '<div class="ai su">✅ Description correcte</div>' : ''}
    </div>`;
    $('verr').style.display = 'none';
  } catch (e) {
    $('verr').style.display = 'flex';
    $('verr-m').textContent = e.message;
  }
  $('res-ver').classList.add('show');
  ld('btn-ver', false);
}

/* ════════════════════════════════════════════════
   UTILITAIRES
════════════════════════════════════════════════ */
function clrCot() {
  // Purger le FAB « Re-coter » s'il était affiché
  try { if (typeof _cotHideReCoteBar === 'function') _cotHideReCoteBar(); } catch (_) {}
  ['f-pr','f-pr-rp','f-pr-dt','f-pt','f-ddn','f-sec','f-amo','f-amc','f-txt','f-ds','f-hs']
    .forEach(id => { const e = $(id); if (e) e.value = ''; });
  ['f-exo','f-regl'].forEach(id => { const e = $(id); if (e) e.selectedIndex = 0; });
  const prescSel = $('f-prescripteur-select');
  if (prescSel) prescSel.value = '';
  const invSec = $('invoice-number-section');
  if (invSec) invSec.style.display = 'none';
  const invDisplay = $('invoice-number-display');
  if (invDisplay) invDisplay.textContent = '';
  $('res-cot').classList.remove('show');
  if (typeof cotClearPatient === 'function') cotClearPatient();
  const liveReco = $('live-reco');
  if (liveReco) liveReco.style.display = 'none';
  window._editingCotation = null;

  // ── Réinitialiser le mode cabinet ─────────────────────────────────────
  const cb = $('cot-cabinet-mode');
  if (cb) cb.checked = false;
  const panel = $('cot-cabinet-panel');
  if (panel) panel.style.display = 'none';
  const totals = $('cot-cabinet-totals');
  if (totals) totals.remove();
  const sugg = $('cot-cabinet-suggestion');
  if (sugg) { sugg.textContent = ''; sugg.style.display = 'none'; }
  const actesList = $('cot-cabinet-actes-list');
  if (actesList) actesList.innerHTML = '<div class="ai in" style="font-size:12px">Saisissez la description des soins ci-dessus pour assigner les actes aux IDEs.</div>';
}

function coterDepuisRoute(desc, nomPatient) {
  // 🛡️ HARMONISATION CARNET ↔ TOURNÉE (route IA) → Historique des soins
  // ----------------------------------------------------------------------
  // Marqueur _fromCarnet pour que _cotationPipeline déclenche après-coup
  // _ensureCotationInHistorique (vérif présence dans planning_patients +
  // rattrapage ami-save-cotation si absente — upsert tri-critères = zéro
  // doublon). Pré-résolution patient_id par nom pour que le worker fasse
  // un PATCH sur la bonne ligne (Critère 2 : patient_id+date_soin).
  window._editingCotation = null;
  (async () => {
    try {
      if (!nomPatient || typeof _idbGetAll !== 'function' || typeof PATIENTS_STORE === 'undefined') {
        // Pas de patient connu → marquer simplement pour ensureHistorique
        window._editingCotation = { _fromCarnet: true, _fromTournee: true };
        return;
      }
      const _rows = await _idbGetAll(PATIENTS_STORE);
      const _low  = nomPatient.toLowerCase().trim();
      const _hit  = _rows.find(r =>
        ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_low) ||
        ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_low)
      );
      const _ed = {
        _fromCarnet:  true,
        _fromTournee: true,
      };
      if (_hit) {
        _ed.patientId = _hit.id;
        // Pré-détection cotation existante AUJOURD'HUI pour ce patient (toutes sources)
        try {
          const _p = { ...((typeof _dec === 'function' ? _dec(_hit._data) : {}) || {}) };
          if (Array.isArray(_p.cotations)) {
            const _todayStr = new Date().toISOString().slice(0, 10);
            const _existIdx = _p.cotations.findIndex(c => (c.date || '').slice(0,10) === _todayStr);
            if (_existIdx >= 0) {
              _ed.cotationIdx    = _existIdx;
              _ed.invoice_number = _p.cotations[_existIdx].invoice_number || null;
              _ed._autoDetected  = true;
            }
          }
        } catch (_) {}
      }
      window._editingCotation = _ed;
    } catch (_) {
      window._editingCotation = { _fromCarnet: true, _fromTournee: true };
    }
  })();

  navTo('cot', null);
  setTimeout(() => {
    const elTxt = $('f-txt'); if (elTxt) { elTxt.value = desc; elTxt.focus(); }
    const elPt  = $('f-pt');  if (elPt && nomPatient) elPt.value = nomPatient;
  }, 150);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Exposition globale (fin de fichier) des fonctions appelées par les
   handlers inline `onclick=""` du HTML. Doit être après la définition
   des fonctions concernées.
   ═══════════════════════════════════════════════════════════════════════════ */
if (typeof window !== 'undefined') {
  if (typeof openVerify       === 'function') window.openVerify       = openVerify;
  if (typeof applyVerify      === 'function') window.applyVerify      = applyVerify;
  if (typeof closeVM          === 'function') window.closeVM          = closeVM;
  if (typeof verifyStandalone === 'function') window.verifyStandalone = verifyStandalone;
  if (typeof renderVM         === 'function') window.renderVM         = renderVM;
  // Handlers pour les actions des alertes de la modale Verify + carte résultat
  if (typeof _vmApplyFix        === 'function') window._vmApplyFix        = _vmApplyFix;
  if (typeof _vmApplySuggestion === 'function') window._vmApplySuggestion = _vmApplySuggestion;
  if (typeof _vmBuildAlertActions === 'function') window._vmBuildAlertActions = _vmBuildAlertActions;
  if (typeof _vmRemoveCode      === 'function') window._vmRemoveCode      = _vmRemoveCode;
  if (typeof _vmReplaceCode     === 'function') window._vmReplaceCode     = _vmReplaceCode;
  if (typeof _vmAppendCode      === 'function') window._vmAppendCode      = _vmAppendCode;
  if (typeof _vmPromptCoef      === 'function') window._vmPromptCoef      = _vmPromptCoef;
}
