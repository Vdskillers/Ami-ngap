/* ════════════════════════════════════════════════
   infirmiere-tools.js — AMI NGAP
   ────────────────────────────────────────────────
   Outils pratiques pour infirmières libérales

   1. Calculateur charges & net réel (URSSAF / CARPIMKO)
   2. Journal kilométrique — déplacements & déclaration fiscale
   3. Bibliothèque de modèles de soins (textes pré-remplis)
   4. Simulateur de majoration rapide
   5. Suivi ordonnances & alertes renouvellement
════════════════════════════════════════════════ */

'use strict';

/* ════════════════════════════════════════════════
   1. CALCULATEUR CHARGES & NET RÉEL
   Cotisations URSSAF 2024 + CARPIMKO + déductions
════════════════════════════════════════════════ */

const CHARGES_RATES = {
  // URSSAF — taux global infirmier libéral conventionné (secteur 1)
  urssaf_maladie:        0.0690,   // 6,90% (maladie + maternité)
  urssaf_retraite_base:  0.1775,   // 17,75% (régime de base)
  urssaf_retraite_comp:  0.0700,   // ~7% (retraite complémentaire CARPIMKO)
  urssaf_invalidite:     0.0160,   // 1,60% (invalidité-décès)
  urssaf_csg_crds:       0.0975,   // 9,75% (CSG/CRDS net de cotisations)
  urssaf_formation:      0.0025,   // 0,25% (formation professionnelle)
  // CARPIMKO (simplifié — cotisation minimale puis proportionnelle)
  carpimko_forfait:      892,      // forfait annuel approx. 2024
  carpimko_taux:         0.0130,   // ~1,3% au-delà
  // Abattement frais professionnels conventionnel IDEL
  abattement_frais:      0.10,     // 10% (min 448 €, max 14 157 €)
};

function calculerCharges() {
  const caEl  = document.getElementById('calc-ca-annuel');
  const frEl  = document.getElementById('calc-frais-reel');
  const resEl = document.getElementById('calc-result');
  if (!caEl || !resEl) return;

  const ca     = parseFloat(caEl.value) || 0;
  const frais  = parseFloat(frEl?.value) || 0;

  if (ca <= 0) {
    resEl.innerHTML = '<div class="ai wa">Saisissez votre CA annuel pour calculer.</div>';
    return;
  }

  // Base de calcul : CA - abattement forfaitaire (ou frais réels si supérieurs)
  const abattForfait = Math.max(448, Math.min(ca * CHARGES_RATES.abattement_frais, 14157));
  const baseCharges  = Math.max(0, ca - Math.max(abattForfait, frais));

  // Cotisations sociales
  const maladie       = baseCharges * CHARGES_RATES.urssaf_maladie;
  const retraiteBase  = baseCharges * CHARGES_RATES.urssaf_retraite_base;
  const retraiteComp  = CHARGES_RATES.carpimko_forfait + Math.max(0, baseCharges - 8000) * CHARGES_RATES.carpimko_taux;
  const invalidite    = baseCharges * CHARGES_RATES.urssaf_invalidite;
  const csgCrds       = baseCharges * CHARGES_RATES.urssaf_csg_crds;
  const formation     = ca * CHARGES_RATES.urssaf_formation;

  const totalCharges  = maladie + retraiteBase + retraiteComp + invalidite + csgCrds + formation;
  const fraisDeduct   = Math.max(abattForfait, frais);
  const revenuBrut    = ca - fraisDeduct;
  const revenuNet     = Math.max(0, revenuBrut - totalCharges);
  const tauxCharges   = ca > 0 ? (totalCharges / ca * 100) : 0;

  // Estimation IR (barème simplifié 2024 — célibataire, 1 part)
  const revImposable  = Math.max(0, revenuNet * 0.90); // abattement 10%
  let ir = 0;
  if (revImposable > 73167)      ir = (revImposable - 73167)*0.41 + 73167*0.30 - 26070 + 11294;
  else if (revImposable > 27478) ir = (revImposable - 27478)*0.30 + 11294;
  else if (revImposable > 11294) ir = (revImposable - 11294)*0.11;
  ir = Math.max(0, ir);

  const netApresIR    = Math.max(0, revenuNet - ir);
  const caJour        = ca / 220; // environ 220 jours travaillés
  const netJour       = netApresIR / 220;

  resEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px">
      <div style="background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:14px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">CA annuel</div>
        <div style="font-size:22px;font-weight:700;color:var(--a)">${ca.toLocaleString('fr-FR')} €</div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">≈ ${caJour.toFixed(0)} €/jour</div>
      </div>
      <div style="background:rgba(255,95,109,.06);border:1px solid rgba(255,95,109,.2);border-radius:12px;padding:14px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Charges sociales</div>
        <div style="font-size:22px;font-weight:700;color:var(--d)">${totalCharges.toLocaleString('fr-FR', {maximumFractionDigits:0})} €</div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">${tauxCharges.toFixed(1)}% du CA</div>
      </div>
      <div style="background:rgba(255,181,71,.06);border:1px solid rgba(255,181,71,.2);border-radius:12px;padding:14px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Impôt estimé (IR)</div>
        <div style="font-size:22px;font-weight:700;color:var(--w)">${ir.toLocaleString('fr-FR', {maximumFractionDigits:0})} €</div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">Barème simplifié 1 part</div>
      </div>
      <div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:12px;padding:14px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Net après tout</div>
        <div style="font-size:22px;font-weight:700;color:#22c55e">${netApresIR.toLocaleString('fr-FR', {maximumFractionDigits:0})} €</div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">≈ ${netJour.toFixed(0)} €/jour · ${(netApresIR/12).toFixed(0)} €/mois</div>
      </div>
    </div>

    <div style="font-size:12px;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px">
      <div style="font-family:var(--fm);font-size:10px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Détail des cotisations</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:4px 16px">
        <span>Maladie-Maternité URSSAF</span><span style="font-family:var(--fm);color:var(--d);text-align:right">${maladie.toFixed(0)} €</span>
        <span>Retraite de base (CNAVPL)</span><span style="font-family:var(--fm);color:var(--d);text-align:right">${retraiteBase.toFixed(0)} €</span>
        <span>CARPIMKO (retraite + invalidité)</span><span style="font-family:var(--fm);color:var(--d);text-align:right">${retraiteComp.toFixed(0)} €</span>
        <span>Invalidité-Décès</span><span style="font-family:var(--fm);color:var(--d);text-align:right">${invalidite.toFixed(0)} €</span>
        <span>CSG / CRDS</span><span style="font-family:var(--fm);color:var(--d);text-align:right">${csgCrds.toFixed(0)} €</span>
        <span>Formation professionnelle</span><span style="font-family:var(--fm);color:var(--d);text-align:right">${formation.toFixed(0)} €</span>
        <span style="border-top:1px solid var(--b);padding-top:6px;font-weight:600">Frais déduits</span><span style="font-family:var(--fm);color:var(--a);text-align:right;border-top:1px solid var(--b);padding-top:6px">- ${fraisDeduct.toFixed(0)} €</span>
      </div>
    </div>
    <div style="font-size:11px;color:var(--m);margin-top:8px;font-family:var(--fm)">
      ⚠️ Estimation indicative — taux 2024. Consultez votre comptable pour un calcul précis.
    </div>`;
}


/* ════════════════════════════════════════════════
   2. JOURNAL KILOMÉTRIQUE
   Enregistrement déplacements + export fiscal
════════════════════════════════════════════════ */

const KM_STORE_KEY = 'ami_km_journal'; // clé de base — suffixée par userId dans les fonctions

/*
  Barème fiscal officiel 2025 & 2026 (non revalorisé — identique les deux années)
  Source : Service-Public.fr, brochure fiscale publiée le 09/04/2026
  Formule : d × (a × d + b) + c  (d = km parcourus dans l'année)
  Pour ≤ 5 000 km  : d × a
  Pour 5001–20000  : d × a + b
  Pour > 20 000    : d × a
*/
const KM_BAREME_2025_2026 = {
  // cv: { tranche1_taux, tranche2: {a, b}, tranche3_taux, label }
  3:  { t1: 0.529, t2a: 0.316, t2b: 1065, t3: 0.370, label: '3 CV' },
  4:  { t1: 0.606, t2a: 0.340, t2b: 1330, t3: 0.407, label: '4 CV' },
  5:  { t1: 0.636, t2a: 0.357, t2b: 1395, t3: 0.427, label: '5 CV' },
  6:  { t1: 0.665, t2a: 0.374, t2b: 1457, t3: 0.447, label: '6 CV' },
  7:  { t1: 0.697, t2a: 0.394, t2b: 1515, t3: 0.470, label: '7 CV et +' },
};
// Majoration 20% véhicule 100% électrique
const KM_ELECTRIQUE_BONUS = 1.20;

function _getKmRate(cv, kmAnnuel, electrique) {
  const b = KM_BAREME_2025_2026[cv] || KM_BAREME_2025_2026[5];
  let rate;
  if (kmAnnuel <= 5000)       rate = b.t1;
  else if (kmAnnuel <= 20000) rate = b.t2a + b.t2b / kmAnnuel;
  else                        rate = b.t3;
  return electrique ? rate * KM_ELECTRIQUE_BONUS : rate;
}

/* ── Clé localStorage isolée par userId (même principe que ami_planning_<userId>) ──
   Isolation RGPD : chaque infirmière/admin ne lit que ses propres trajets.
   ⚠️ La clé sessionStorage correcte est 'ami' (définie dans utils.js → ss.save/load)
────────────────────────────────────────────────────────────────────────────────── */
function _kmKey() {
  // Priorité 1 : S en mémoire (déjà hydraté)
  let uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : null;
  // Priorité 2 : sessionStorage clé 'ami' (celle utilisée par ss.save/load dans utils.js)
  if (!uid) {
    try {
      const sess = JSON.parse(sessionStorage.getItem('ami') || 'null');
      uid = sess?.user?.id || null;
    } catch {}
  }
  return KM_STORE_KEY + '_' + String(uid || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _loadKmJournal() {
  try { return JSON.parse(localStorage.getItem(_kmKey()) || '[]'); } catch { return []; }
}
function _saveKmJournal(entries) {
  try {
    localStorage.setItem(_kmKey(), JSON.stringify(entries));
    _syncKmToServer(entries).catch(() => {}); // sync silencieux en arrière-plan
  } catch {}
}

/* ════════════════════════════════════════════════════════════════════════
   SYNC JOURNAL KILOMÉTRIQUE — navigateur ↔ mobile
   Identique au mécanisme carnet patients : blob AES-256 opaque côté serveur.
   Le worker ne déchiffre jamais — il stocke/retourne le blob.
   Isolation : table km_journal → infirmiere_id UNIQUE (1 ligne / compte).
════════════════════════════════════════════════════════════════════════ */
async function _syncKmToServer(entries) {
  if (typeof S === 'undefined' || !S?.token) return;
  try {
    const data = entries || _loadKmJournal();
    // Chiffrement côté client — le serveur reçoit un blob opaque
    let encrypted_data;
    if (typeof _enc === 'function') {
      try { encrypted_data = _enc({ __km_journal: data }); } catch { encrypted_data = JSON.stringify(data); }
    } else {
      encrypted_data = JSON.stringify(data);
    }
    await wpost('/webhook/km-push', { encrypted_data, updated_at: new Date().toISOString() });
  } catch (e) { console.warn('[AMI] KM push KO (silencieux):', e.message); }
}

async function syncKmFromServer() {
  if (typeof S === 'undefined' || !S?.token) return;
  try {
    const res = await wpost('/webhook/km-pull', {});
    if (!res?.ok || !res.data?.encrypted_data) return;

    // Déchiffrer le blob
    let remote = null;
    try {
      if (typeof _dec === 'function') {
        const d = _dec(res.data.encrypted_data);
        remote = d?.__km_journal || null;
      }
      if (!remote) remote = JSON.parse(res.data.encrypted_data);
    } catch {}
    if (!Array.isArray(remote) || !remote.length) return;

    // Fusion avec l'existant local — dédoublonnage par id
    const local   = _loadKmJournal();
    const localIds = new Set(local.map(e => e.id));
    let merged = [...local];
    remote.forEach(e => { if (e.id && !localIds.has(e.id)) merged.push(e); });
    merged.sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1);

    // Sauvegarder localement SANS re-push (évite la boucle)
    try { localStorage.setItem(_kmKey(), JSON.stringify(merged)); } catch {}
    if (typeof renderKmJournal === 'function') renderKmJournal();
    console.info('[AMI] KM sync depuis serveur :', merged.length, 'entrée(s)');
  } catch (e) { console.warn('[AMI] KM pull KO:', e.message); }
}

function addKmEntry() {
  const dateEl  = document.getElementById('km-date');
  const depEl   = document.getElementById('km-depart');
  const arrEl   = document.getElementById('km-arrivee');
  const distEl  = document.getElementById('km-distance');
  const motifEl = document.getElementById('km-motif');
  const msgEl   = document.getElementById('km-msg');

  const date    = dateEl?.value || new Date().toISOString().split('T')[0];
  const depart  = depEl?.value?.trim() || '';
  const arrivee = arrEl?.value?.trim() || '';
  const dist    = parseFloat(distEl?.value);
  const motif   = motifEl?.value?.trim() || 'Visite patient';

  if (!dist || dist <= 0) {
    if (msgEl) { msgEl.className='msg e'; msgEl.textContent='Saisissez une distance.'; msgEl.style.display='block'; }
    return;
  }

  const entries = _loadKmJournal();
  entries.push({ id: Date.now(), date, depart, arrivee, km: dist, motif });
  _saveKmJournal(entries);

  if (depEl)  depEl.value  = '';
  if (arrEl)  arrEl.value  = '';
  if (distEl) distEl.value = '';
  if (motifEl) motifEl.value = 'Visite patient';
  if (msgEl)  msgEl.style.display = 'none';

  renderKmJournal();
  if (typeof showToast === 'function') showToast('✅ Trajet enregistré.');
}

function deleteKmEntry(id) {
  const entries = _loadKmJournal().filter(e => e.id !== id);
  _saveKmJournal(entries);
  renderKmJournal();
}

function renderKmJournal() {
  const el = document.getElementById('km-list');
  if (!el) return;

  const entries    = _loadKmJournal();
  const period     = document.getElementById('km-period')?.value || 'month';
  const cv         = parseInt(document.getElementById('km-cv')?.value) || 5;
  const electrique = !!document.getElementById('km-electrique')?.checked;

  // Filtrer par période
  const now = new Date();
  const filtered = entries.filter(e => {
    const d = new Date(e.date);
    if (period === 'week') {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay() + 1);
      return d >= start;
    }
    if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (period === 'year')  return d.getFullYear() === now.getFullYear();
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  // Total km de l'année (pour choisir la bonne tranche)
  const kmAnnuel   = entries
    .filter(e => new Date(e.date).getFullYear() === now.getFullYear())
    .reduce((s, e) => s + e.km, 0);

  const totalKm   = filtered.reduce((s, e) => s + e.km, 0);
  const tauxKm    = _getKmRate(cv, kmAnnuel, electrique);
  const deduction = totalKm * tauxKm;
  const baremeLbl = KM_BAREME_2025_2026[cv]?.label || '5 CV';

  // Tranche applicable
  let trancheLbl = '';
  if (kmAnnuel <= 5000)       trancheLbl = '≤ 5 000 km/an';
  else if (kmAnnuel <= 20000) trancheLbl = '5 001–20 000 km/an';
  else                        trancheLbl = '> 20 000 km/an';

  if (!filtered.length) {
    el.innerHTML = '<div style="color:var(--m);font-size:13px;text-align:center;padding:20px">Aucun trajet sur cette période.</div>';
    const stat = document.getElementById('km-stats');
    if (stat) stat.innerHTML = '';
    return;
  }

  const stat = document.getElementById('km-stats');
  if (stat) stat.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <div style="background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:10px 16px;flex:1;min-width:120px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);margin-bottom:2px">KM PARCOURUS</div>
        <div style="font-size:20px;font-weight:700;color:var(--a)">${totalKm.toFixed(0)} km</div>
        <div style="font-size:10px;color:var(--m);margin-top:1px">${kmAnnuel.toFixed(0)} km sur l'année</div>
      </div>
      <div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:10px;padding:10px 16px;flex:1;min-width:120px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);margin-bottom:2px">DÉDUCTION FISCALE</div>
        <div style="font-size:20px;font-weight:700;color:#22c55e">${deduction.toFixed(0)} €</div>
        <div style="font-size:10px;color:var(--m);margin-top:1px">${tauxKm.toFixed(3)} €/km · ${baremeLbl} · ${trancheLbl}${electrique?' · ⚡+20%':''}</div>
      </div>
      <div style="background:rgba(79,168,255,.07);border:1px solid rgba(79,168,255,.2);border-radius:10px;padding:10px 16px;flex:1;min-width:120px">
        <div style="font-size:10px;font-family:var(--fm);color:var(--m);margin-bottom:2px">TRAJETS</div>
        <div style="font-size:20px;font-weight:700;color:var(--a2)">${filtered.length}</div>
      </div>
    </div>`;

  el.innerHTML = filtered.map(e => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--s);border:1px solid var(--b);border-radius:10px;margin-bottom:6px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-family:var(--fm);font-size:10px;color:var(--m)">${new Date(e.date).toLocaleDateString('fr-FR')}</span>
          <span style="font-size:12px;color:var(--t);font-weight:600">${e.km} km</span>
          ${e.depart ? `<span style="font-size:11px;color:var(--m)">${e.depart} → ${e.arrivee||'?'}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">${e.motif}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;color:var(--a);font-family:var(--fm)">${(e.km * tauxKm).toFixed(2)} €</div>
        <button onclick="deleteKmEntry(${e.id})" style="font-size:10px;background:none;border:none;color:rgba(255,95,109,.6);cursor:pointer;margin-top:2px">✕</button>
      </div>
    </div>`).join('');
}

function exportKmCSV() {
  const entries = _loadKmJournal();
  if (!entries.length) { if (typeof showToast === 'function') showToast('⚠️ Aucun trajet à exporter.'); return; }

  const cv         = parseInt(document.getElementById('km-cv')?.value) || 5;
  const electrique = !!document.getElementById('km-electrique')?.checked;
  const kmAnnuel   = entries
    .filter(e => new Date(e.date).getFullYear() === new Date().getFullYear())
    .reduce((s, e) => s + e.km, 0);
  const taux = _getKmRate(cv, kmAnnuel, electrique);
  const baremeLbl = `${KM_BAREME_2025_2026[cv]?.label || '5 CV'} · barème 2025/2026${electrique ? ' · électrique +20%' : ''}`;

  const header = ['Date','Départ','Arrivée','Distance (km)','Motif','Taux (€/km)','Déduction (€)','Barème'];
  const lines  = entries.map(e => [
    e.date, e.depart||'', e.arrivee||'', e.km, e.motif,
    taux.toFixed(3),
    (e.km * taux).toFixed(2),
    baremeLbl
  ].join(';'));

  const csv  = [header.join(';'), ...lines].join('\n');
  const blob = new Blob(['\ufeff'+csv], { type:'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `ami-km-${new Date().getFullYear()}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  if (typeof showToast === 'function') showToast('📊 Export kilométrique téléchargé.');
}


/* ════════════════════════════════════════════════
   3. BIBLIOTHÈQUE DE MODÈLES DE SOINS
   Textes pré-remplis réutilisables pour la cotation
════════════════════════════════════════════════ */

const MODELES_KEY = 'ami_modeles_soins';

const MODELES_DEFAULT = [
  { id: 1, titre: 'Injection insuline matin', categorie: 'injection',
    texte: 'Injection sous-cutanée insuline rapide au domicile du patient, matin. Surveillance glycémie avant injection.' },
  { id: 2, titre: 'Pansement plaie chronique', categorie: 'pansement',
    texte: 'Pansement complexe plaie chronique avec détersion mécanique, pose compresse alginate et bandage. Domicile patient.' },
  { id: 3, titre: 'Toilette patient grabataire', categorie: 'toilette',
    texte: 'Toilette complète patient grabataire, aide à la mobilisation, soins de nursing. Dépendance lourde. Domicile.' },
  { id: 4, titre: 'Prélèvement sanguin à jeun', categorie: 'prelevement',
    texte: 'Prélèvement sanguin à jeun au domicile du patient, pose de 3 tubes, étiquetage et envoi laboratoire.' },
  { id: 5, titre: 'Perfusion domicile', categorie: 'perfusion',
    texte: 'Pose et surveillance perfusion IV au domicile, vérification voie veineuse, rinçage cathéter, surveillance tolérance.' },
  { id: 6, titre: 'Pansement simple post-op', categorie: 'pansement',
    texte: 'Pansement simple cicatrice chirurgicale propre, détersion légère, pose compresse, bande souple. Domicile.' },
  { id: 7, titre: 'Bilan soins dépendance légère (BSA)', categorie: 'bilan',
    texte: 'Bilan de soins infirmiers, patient autonome pour toilette, aide partielle habillage. Dépendance légère. Soins quotidiens au domicile.' },
  { id: 8, titre: 'Injection IM + préparation', categorie: 'injection',
    texte: 'Injection intramusculaire médicament prescrit sur ordonnance, préparation et vérification dose, injection fesse droite, surveillance 15 minutes.' },
];

function _loadModeles() {
  try {
    const saved = JSON.parse(localStorage.getItem(MODELES_KEY) || 'null');
    return saved || [...MODELES_DEFAULT];
  } catch { return [...MODELES_DEFAULT]; }
}
function _saveModeles(modeles) {
  try { localStorage.setItem(MODELES_KEY, JSON.stringify(modeles)); } catch {}
}

function renderModeles() {
  const el = document.getElementById('modeles-list');
  if (!el) return;

  const modeles   = _loadModeles();
  const filtre    = document.getElementById('modeles-categorie')?.value || '';
  const recherche = (document.getElementById('modeles-search')?.value || '').toLowerCase();

  const filtres = modeles.filter(m => {
    const matchCat = !filtre || m.categorie === filtre;
    const matchQ   = !recherche || m.titre.toLowerCase().includes(recherche) || m.texte.toLowerCase().includes(recherche);
    return matchCat && matchQ;
  });

  if (!filtres.length) {
    el.innerHTML = '<div style="color:var(--m);font-size:13px;text-align:center;padding:20px">Aucun modèle trouvé.</div>';
    return;
  }

  const CAT_ICONS = { injection:'💉', pansement:'🩹', toilette:'🧼', prelevement:'🩸', perfusion:'💊', bilan:'📋', autre:'📝' };

  el.innerHTML = filtres.map(m => `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:12px;padding:14px;margin-bottom:10px">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px">
        <div style="width:32px;height:32px;background:rgba(0,212,170,.1);border-radius:8px;display:grid;place-items:center;font-size:16px;flex-shrink:0">${CAT_ICONS[m.categorie]||'📝'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--t)">${m.titre}</div>
          <div style="font-size:10px;font-family:var(--fm);color:var(--m);text-transform:capitalize;margin-top:1px">${m.categorie}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--m);line-height:1.5;margin-bottom:10px;padding:8px;background:var(--c);border-radius:6px">${m.texte}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button onclick="utiliserModele(${m.id})"
          style="font-size:11px;font-family:var(--fm);padding:4px 12px;border-radius:20px;border:1px solid rgba(0,212,170,.3);background:rgba(0,212,170,.06);color:var(--a);cursor:pointer">
          ⚡ Utiliser pour coter
        </button>
        <button onclick="modifierModele(${m.id})"
          style="font-size:11px;font-family:var(--fm);padding:4px 12px;border-radius:20px;border:1px solid var(--b);background:none;color:var(--m);cursor:pointer">
          ✏️ Modifier
        </button>
        ${m.id > 8 ? `
        <button onclick="supprimerModele(${m.id})"
          style="font-size:11px;font-family:var(--fm);padding:4px 12px;border-radius:20px;border:1px solid rgba(255,95,109,.2);background:none;color:var(--d);cursor:pointer">
          🗑️ Supprimer
        </button>` : ''}
      </div>
    </div>`).join('');
}

function utiliserModele(id) {
  const m = _loadModeles().find(m => m.id === id);
  if (!m) return;
  const textarea = document.getElementById('f-txt');
  if (textarea) textarea.value = m.texte;
  if (typeof navTo === 'function') navTo('cot', null);
  if (typeof showToast === 'function') showToast(`✅ Modèle "${m.titre}" chargé dans la cotation.`);
}

function sauvegarderModele() {
  const titreEl = document.getElementById('modele-new-titre');
  const texteEl = document.getElementById('modele-new-texte');
  const catEl   = document.getElementById('modele-new-cat');
  const msgEl   = document.getElementById('modele-msg');

  const titre = titreEl?.value?.trim();
  const texte = texteEl?.value?.trim();
  const cat   = catEl?.value || 'autre';

  if (!titre || !texte) {
    if (msgEl) { msgEl.className='msg e'; msgEl.textContent='Remplissez le titre et le texte.'; msgEl.style.display='block'; }
    return;
  }

  const modeles = _loadModeles();
  const editId  = parseInt(document.getElementById('modele-edit-id')?.value || '0');

  if (editId) {
    const idx = modeles.findIndex(m => m.id === editId);
    if (idx >= 0) modeles[idx] = { ...modeles[idx], titre, texte, categorie: cat };
  } else {
    modeles.push({ id: Date.now(), titre, texte, categorie: cat });
  }

  _saveModeles(modeles);
  if (titreEl) titreEl.value = '';
  if (texteEl) texteEl.value = '';
  if (msgEl)  msgEl.style.display = 'none';
  const editIdEl = document.getElementById('modele-edit-id');
  if (editIdEl) editIdEl.value = '';
  const formTitre = document.getElementById('modele-form-title');
  if (formTitre) formTitre.textContent = '✏️ Nouveau modèle';

  renderModeles();
  if (typeof showToast === 'function') showToast('✅ Modèle sauvegardé.');
}

function modifierModele(id) {
  const m = _loadModeles().find(m => m.id === id);
  if (!m) return;
  const titreEl = document.getElementById('modele-new-titre');
  const texteEl = document.getElementById('modele-new-texte');
  const catEl   = document.getElementById('modele-new-cat');
  const editIdEl= document.getElementById('modele-edit-id');
  const formTitre= document.getElementById('modele-form-title');

  if (titreEl) titreEl.value = m.titre;
  if (texteEl) texteEl.value = m.texte;
  if (catEl)   catEl.value   = m.categorie;
  if (editIdEl) editIdEl.value = m.id;
  if (formTitre) formTitre.textContent = '✏️ Modifier le modèle';

  document.getElementById('modele-form-section')?.scrollIntoView({ behavior:'smooth' });
}

function supprimerModele(id) {
  if (!confirm('Supprimer ce modèle ?')) return;
  _saveModeles(_loadModeles().filter(m => m.id !== id));
  renderModeles();
}


/* ════════════════════════════════════════════════
   4. SIMULATEUR DE MAJORATION RAPIDE
   Calcule immédiatement la majoration applicable
   selon heure, jour, contexte patient
════════════════════════════════════════════════ */

function simulerMajoration() {
  const heureEl   = document.getElementById('sim-heure');
  const jourEl    = document.getElementById('sim-jour');
  const acteEl    = document.getElementById('sim-acte');
  const domEl     = document.getElementById('sim-domicile');
  const enfantEl  = document.getElementById('sim-enfant');
  const coordEl   = document.getElementById('sim-coordination');
  const kmEl      = document.getElementById('sim-km');
  const resEl     = document.getElementById('sim-result');

  if (!resEl) return;

  const heureStr  = heureEl?.value || '08:00';
  const [hh, mm]  = heureStr.split(':').map(Number);
  const heure     = hh + (mm||0)/60;
  const jour      = jourEl?.value || 'lundi';
  const acte      = acteEl?.value || 'AMI1';
  const domicile  = domEl?.checked !== false;
  const enfant    = !!enfantEl?.checked;
  const coord     = !!coordEl?.checked;
  const km        = parseFloat(kmEl?.value) || 0;

  // Tarif de l'acte principal
  const TARIFS = { AMI1:3.15, AMI2:6.30, AMI3:9.45, AMI4:12.60, AMI5:15.75,
                   BSA:13.00, BSB:18.20, BSC:28.70, AIS1:2.65, AIS3:7.95 };
  const tarifActe = TARIFS[acte] || 3.15;

  // Majorations applicables
  const majorations = [];

  // IFD (domicile)
  if (domicile) majorations.push({ nom:'IFD — Indemnité déplacement domicile', montant:2.75, code:'IFD' });

  // IK (kilométrique)
  if (km > 0) majorations.push({ nom:`IK — ${km} km × 0,35 €`, montant:km*0.35, code:'IK' });

  // MIE (enfant < 7 ans)
  if (enfant) majorations.push({ nom:'MIE — Majoration enfant < 7 ans', montant:3.15, code:'MIE' });

  // MCI (coordination)
  if (coord) majorations.push({ nom:'MCI — Majoration coordination', montant:5.00, code:'MCI' });

  // Majorations horaires
  const estNuitProfonde = heure < 5 || heure >= 23;
  const estNuit         = (heure >= 20 && heure < 23) || (heure >= 5 && heure < 8);
  const estDimFerie     = ['dimanche','ferie'].includes(jour);

  if (estNuitProfonde)
    majorations.push({ nom:'MN2 — Nuit profonde (23h–5h)', montant:18.30, code:'MN2', highlight:true });
  else if (estNuit)
    majorations.push({ nom:'MN — Nuit (20h–8h)', montant:9.15, code:'MN', highlight:true });

  if (estDimFerie)
    majorations.push({ nom:'MD — Dimanche / jour férié', montant:8.50, code:'MD', highlight:true });

  const totalMajorations = majorations.reduce((s, m) => s + m.montant, 0);
  const totalActe        = tarifActe + totalMajorations;

  const heureAff = `${String(hh).padStart(2,'0')}h${mm?String(mm).padStart(2,'0'):'00'}`;

  resEl.innerHTML = `
    <div style="background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:16px;margin-bottom:14px">
      <div style="font-family:var(--fm);font-size:10px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">
        ${acte} · ${heureAff} · ${jour.charAt(0).toUpperCase()+jour.slice(1)}
      </div>
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <div style="font-size:32px;font-weight:700;color:var(--a)">${totalActe.toFixed(2)} €</div>
        <div style="font-size:13px;color:var(--m)">
          ${tarifActe.toFixed(2)} € (acte) + ${totalMajorations.toFixed(2)} € (majorations)
        </div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--s);border-radius:8px;font-size:13px">
        <span>${acte} — Acte principal</span>
        <span style="font-family:var(--fm);color:var(--a);font-weight:600">${tarifActe.toFixed(2)} €</span>
      </div>
      ${majorations.map(m => `
      <div style="display:flex;justify-content:space-between;padding:8px 12px;background:${m.highlight?'rgba(255,181,71,.06)':'var(--s)'};border:1px solid ${m.highlight?'rgba(255,181,71,.2)':'var(--b)'};border-radius:8px;font-size:12px">
        <span>${m.nom}</span>
        <span style="font-family:var(--fm);color:${m.highlight?'var(--w)':'var(--a)'};font-weight:600">+${m.montant.toFixed(2)} €</span>
      </div>`).join('')}
    </div>

    ${majorations.length === 0 && !domicile
      ? '<div class="ai in" style="font-size:12px">Aucune majoration détectée pour ces paramètres.</div>' : ''}

    <button onclick="utiliserSimulation('${acte}', ${hh}, '${jour}', ${domicile}, ${enfant}, ${coord}, ${km})"
      style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(0,212,170,.3);background:rgba(0,212,170,.08);color:var(--a);font-size:13px;cursor:pointer;font-family:var(--fm)">
      ⚡ Utiliser cette cotation
    </button>`;
}

function utiliserSimulation(acte, heure, jour, domicile, enfant, coord, km) {
  const heureStr = `${String(heure).padStart(2,'0')}h00`;
  const jourStr  = jour === 'dimanche' ? 'dimanche' : jour === 'ferie' ? 'jour férié' : '';
  let texte = `${acte} `;
  if (domicile) texte += 'au domicile du patient ';
  if (heure >= 20 || heure < 8) texte += `à ${heureStr} `;
  if (jourStr) texte += `${jourStr} `;
  if (enfant) texte += 'patient enfant de moins de 7 ans ';
  if (coord) texte += 'coordination pluridisciplinaire ';
  if (km > 0) texte += `${km} km `;

  const textarea = document.getElementById('f-txt');
  if (textarea) textarea.value = texte.trim();
  if (typeof navTo === 'function') navTo('cot', null);
  if (typeof showToast === 'function') showToast('✅ Simulation chargée dans la cotation.');
}


/* ════════════════════════════════════════════════
   5. SUIVI ORDONNANCES & ALERTES RENOUVELLEMENT
   Connecté au carnet patient (IndexedDB chiffré)
   — Les ordonnances sont lues depuis les fiches
     patient du carnet ET depuis le stockage local
   ════════════════════════════════════════════════ */

const ORDO_STORE_KEY = 'ami_ordonnances';

function _loadOrdos() {
  try { return JSON.parse(localStorage.getItem(ORDO_STORE_KEY) || '[]'); } catch { return []; }
}
function _saveOrdos(ordos) {
  try { localStorage.setItem(ORDO_STORE_KEY, JSON.stringify(ordos)); } catch {}
}

/* Lire les ordonnances depuis le carnet patient IndexedDB
   — retry automatique si la connexion IDB est en cours de fermeture */
async function _loadOrdosFromCarnet() {
  try {
    if (typeof _idbGetAll !== 'function' || typeof _dec !== 'function') return [];
    const STORE = (typeof PATIENTS_STORE !== 'undefined') ? PATIENTS_STORE : 'ami_patients';

    // Retry si InvalidStateError (DB closing) — jusqu'à 3 tentatives
    let rows = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rows = await _idbGetAll(STORE);
        break; // succès
      } catch (retryErr) {
        const isClosing = retryErr?.name === 'InvalidStateError'
          || (retryErr?.message || '').includes('closing')
          || (retryErr?.message || '').includes('closed');
        if (isClosing && attempt < 2) {
          // Forcer la réouverture si initPatientsDB est disponible
          if (typeof initPatientsDB === 'function') {
            try {
              if (typeof _patientsDB !== 'undefined' && _patientsDB) {
                _patientsDB.close();
              }
            } catch (_) {}
            if (typeof _patientsDB !== 'undefined') {
              // eslint-disable-next-line no-global-assign
              try { window._patientsDB = null; } catch (_) {}
            }
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
            await initPatientsDB().catch(() => {});
          } else {
            await new Promise(r => setTimeout(r, 150));
          }
          continue;
        }
        throw retryErr;
      }
    }
    if (!rows) return [];
    const ordos = [];
    for (const row of rows) {
      const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data) || {}) };
      const nomAff = [p.prenom, p.nom].filter(Boolean).join(' ') || p.nom || 'Patient';

      // Lire le tableau ordonnances[] (nouveau format)
      const list = Array.isArray(p.ordonnances) ? p.ordonnances : [];

      // Rétrocompatibilité : migrer ordo_date ancien format
      if (!list.length && p.ordo_date) {
        list.push({
          id:              'legacy_' + row.id,
          date_expiration: p.ordo_date,
          actes:           '',
          medecin:         p.medecin || '',
          duree:           30,
        });
      }

      for (const o of list) {
        if (!o.date_expiration) continue;
        ordos.push({
          id:             `carnet_${row.id}_${o.id || o.date_expiration}`,
          patient:        nomAff,
          patient_id:     row.id,
          medecin:        o.medecin || '',
          actes:          typeof o.actes === 'string' ? o.actes : JSON.stringify(o.actes || ''),
          duree:          o.duree || 30,
          dateDebut:      o.date_prescription || '',
          dateExpiration: o.date_expiration,
          notes:          o.notes || '',
          _source:        'carnet',
          _ordo_id:       o.id,
        });
      }
    }
    return ordos;
  } catch (e) {
    console.warn('[AMI] Lecture ordos carnet KO:', e.message);
    return [];
  }
}

async function addOrdonnance() {
  const patEl   = document.getElementById('ordo-patient');
  const medEl   = document.getElementById('ordo-medecin');
  const dateEl  = document.getElementById('ordo-date');
  const durEl   = document.getElementById('ordo-duree');
  const actesEl = document.getElementById('ordo-actes');
  const msgEl   = document.getElementById('ordo-msg');

  const patient = patEl?.value?.trim();
  const date    = dateEl?.value;
  const duree   = parseInt(durEl?.value) || 30;
  const actes   = actesEl?.value?.trim() || '';
  const medecin = medEl?.value?.trim() || '';

  if (!patient || !date) {
    if (msgEl) { msgEl.className='msg e'; msgEl.textContent='Saisissez le nom du patient et la date de prescription.'; msgEl.style.display='block'; }
    return;
  }

  const dateExpir = new Date(date);
  dateExpir.setDate(dateExpir.getDate() + duree);
  const dateExpStr = dateExpir.toISOString().split('T')[0];

  const ordo = {
    id:               'ordo_' + Date.now(),
    date_prescription: date,
    date_expiration:   dateExpStr,
    duree, actes, medecin, notes: '',
    created_at: new Date().toISOString(),
  };

  /* ── Tenter d'écrire dans le carnet patient si le patient existe ── */
  let savedToCarnet = false;
  try {
    if (typeof _idbGetAll === 'function' && typeof _dec === 'function' && typeof _enc === 'function' && typeof _idbPut === 'function') {
      const STORE = (typeof PATIENTS_STORE !== 'undefined') ? PATIENTS_STORE : 'patients';
      const rows  = await _idbGetAll(STORE);
      const patientNorm = patient.toLowerCase().replace(/\s+/g,' ').trim();
      const row = rows.find(r => {
        const nom = `${r.prenom||''} ${r.nom}`.toLowerCase().trim();
        const nom2 = `${r.nom} ${r.prenom||''}`.toLowerCase().trim();
        return nom.includes(patientNorm) || nom2.includes(patientNorm) || patientNorm.includes((r.nom||'').toLowerCase());
      });
      if (row) {
        const pat = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };
        if (!pat.ordonnances) pat.ordonnances = [];
        pat.ordonnances.push(ordo);
        pat.updated_at = new Date().toISOString();
        const _tsOrdo = { id: pat.id, nom: pat.nom, prenom: pat.prenom, _data: _enc(pat), updated_at: pat.updated_at };
        await _idbPut(STORE, _tsOrdo);
        // Sync immédiate vers carnet_patients — propagation inter-appareils
        if (typeof _syncPatientNow === 'function') _syncPatientNow(_tsOrdo).catch(() => {});
        savedToCarnet = true;
      }
    }
  } catch (e) { console.warn('[AMI] Écriture ordo carnet KO:', e.message); }

  /* ── Toujours sauvegarder aussi en localStorage (vue unifiée) ── */
  const ordos = _loadOrdos();
  ordos.push({
    id: ordo.id, patient, medecin, actes, duree,
    dateDebut: date, dateExpiration: dateExpStr,
    _source: savedToCarnet ? 'carnet' : 'manuel',
    _patient_id: null,
  });
  _saveOrdos(ordos);

  if (patEl)   patEl.value   = '';
  if (medEl)   medEl.value   = '';
  if (dateEl)  dateEl.value  = '';
  if (actesEl) actesEl.value = '';
  if (msgEl)   msgEl.style.display = 'none';

  await renderOrdonnances();
  const msg = savedToCarnet
    ? `✅ Ordonnance enregistrée et ajoutée dans la fiche de ${patient}.`
    : `✅ Ordonnance enregistrée. (Patient non trouvé dans le carnet — saisie manuelle)`;
  if (typeof showToast === 'function') showToast(msg);
}

function deleteOrdonnance(id) {
  // Supprimer uniquement les ordonnances manuelles (pas celles du carnet)
  _saveOrdos(_loadOrdos().filter(o => o.id !== id));
  renderOrdonnances();
}

async function renderOrdonnances() {
  const el = document.getElementById('ordo-list');
  if (!el) return;

  el.innerHTML = '<div style="color:var(--m);font-size:12px;padding:12px">Chargement…</div>';

  // Fusionner ordonnances manuelles + ordonnances du carnet patient
  const manuel  = _loadOrdos();
  const carnet  = await _loadOrdosFromCarnet();

  // Dédupliquer : si une ordo manuelle et une ordo carnet ont même patient + dateDebut, garder carnet
  const carnetKeys = new Set(carnet.map(o => `${o.patient}_${o.dateDebut}`));
  const manuelFiltrees = manuel.filter(o => !carnetKeys.has(`${o.patient}_${o.dateDebut}`));
  const toutes = [...carnet, ...manuelFiltrees];

  const today  = new Date(); today.setHours(0,0,0,0);
  const filtre = document.getElementById('ordo-filtre')?.value || 'all';

  const classified = toutes.map(o => {
    const exp = new Date(o.dateExpiration); exp.setHours(0,0,0,0);
    const diffDays = Math.ceil((exp - today) / 86400000);
    let statut = 'ok';
    if (diffDays < 0)       statut = 'expire';
    else if (diffDays <= 7) statut = 'urgent';
    else if (diffDays <= 21) statut = 'proche';
    return { ...o, diffDays, statut };
  }).sort((a, b) => a.diffDays - b.diffDays);

  const filtered = classified.filter(o => {
    if (filtre === 'active')   return o.statut !== 'expire';
    if (filtre === 'alerte')   return ['urgent','proche'].includes(o.statut);
    if (filtre === 'expiree')  return o.statut === 'expire';
    if (filtre === 'carnet')   return o._source === 'carnet';
    return true;
  });

  // Mettre à jour badge alerte dans nav
  const nbAlertes = classified.filter(o => ['urgent','proche'].includes(o.statut)).length;
  const badge = document.getElementById('ordo-nav-badge');
  if (badge) { badge.textContent = nbAlertes > 0 ? nbAlertes : ''; badge.style.display = nbAlertes > 0 ? 'inline' : 'none'; }

  // Compteurs
  const nbCarnet = carnet.length;
  const nbManuel = manuelFiltrees.length;
  const sourceInfo = document.getElementById('ordo-source-info');
  if (sourceInfo) {
    sourceInfo.innerHTML = `<span style="font-size:11px;color:var(--m);font-family:var(--fm)">
      ${nbCarnet > 0 ? `📂 ${nbCarnet} depuis le carnet · ` : ''}${nbManuel > 0 ? `✍️ ${nbManuel} manuelles · ` : ''}${nbAlertes > 0 ? `<span style="color:var(--w)">⚠️ ${nbAlertes} en alerte</span>` : '✅ Aucune alerte'}
    </span>`;
  }

  if (!filtered.length) {
    el.innerHTML = '<div style="color:var(--m);font-size:13px;text-align:center;padding:20px">Aucune ordonnance sur ce filtre.</div>';
    return;
  }

  const STATUT_STYLE = {
    expire: { bg:'rgba(255,95,109,.08)',  border:'rgba(255,95,109,.3)',  color:'var(--d)',  label:'Expirée' },
    urgent: { bg:'rgba(255,181,71,.08)',  border:'rgba(255,181,71,.3)',  color:'var(--w)',  label:'Urgent !' },
    proche: { bg:'rgba(255,181,71,.04)',  border:'rgba(255,181,71,.15)', color:'var(--w)',  label:'Bientôt' },
    ok:     { bg:'var(--s)',              border:'var(--b)',             color:'var(--a)',   label:'Valide' },
  };

  el.innerHTML = filtered.map(o => {
    const st = STATUT_STYLE[o.statut];
    const diffLabel = o.diffDays < 0
      ? `Expirée il y a ${Math.abs(o.diffDays)} jour(s)`
      : o.diffDays === 0 ? `Expire aujourd'hui !`
      : `Expire dans ${o.diffDays} jour(s)`;
    const sourceBadge = o._source === 'carnet'
      ? `<span style="font-size:9px;font-family:var(--fm);background:rgba(79,168,255,.1);color:var(--a2);border-radius:20px;padding:1px 7px;margin-left:6px">📂 Carnet</span>`
      : `<span style="font-size:9px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);border-radius:20px;padding:1px 7px;margin-left:6px">✍️ Manuel</span>`;
    return `
    <div style="background:${st.bg};border:1px solid ${st.border};border-radius:12px;padding:14px;margin-bottom:8px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--t)">${o.patient}${sourceBadge}</div>
          ${o.medecin ? `<div style="font-size:11px;color:var(--m)">Dr ${o.medecin}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:10px;font-family:var(--fm);color:${st.color};background:${st.bg};border:1px solid ${st.border};padding:2px 8px;border-radius:20px">${st.label}</div>
        </div>
      </div>
      ${o.actes ? `<div style="font-size:12px;color:var(--m);margin-bottom:6px">Actes : ${o.actes}</div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <div style="font-size:11px;font-family:var(--fm);color:${st.color}">
          ${diffLabel}${o.dateDebut && !isNaN(new Date(o.dateDebut)) ? ' · ' + new Date(o.dateDebut).toLocaleDateString('fr-FR') : ''} → ${new Date(o.dateExpiration).toLocaleDateString('fr-FR')}
        </div>
        ${o._source !== 'carnet' ? `
        <button onclick="deleteOrdonnance(${o.id})"
          style="font-size:10px;font-family:var(--fm);padding:3px 8px;border-radius:20px;border:1px solid rgba(255,95,109,.2);background:none;color:var(--d);cursor:pointer">
          ✕ Supprimer
        </button>` : `<span style="font-size:10px;color:var(--m);font-family:var(--fm)">Gérer dans Carnet patients</span>`}
      </div>
    </div>`;
  }).join('');
}

/* Badge ordonnances en alerte dans la sidebar */
async function refreshOrdoBadge() {
  try {
    const manuel  = _loadOrdos();
    const carnet  = await _loadOrdosFromCarnet();
    const carnetKeys = new Set(carnet.map(o => `${o.patient}_${o.dateDebut}`));
    const toutes  = [...carnet, ...manuel.filter(o => !carnetKeys.has(`${o.patient}_${o.dateDebut}`))];
    const today   = new Date(); today.setHours(0,0,0,0);
    const nb = toutes.filter(o => {
      const exp = new Date(o.dateExpiration); exp.setHours(0,0,0,0);
      return Math.ceil((exp - today) / 86400000) <= 21;
    }).length;
    const badge = document.getElementById('ordo-nav-badge');
    if (badge) { badge.textContent = nb > 0 ? nb : ''; badge.style.display = nb > 0 ? 'inline' : 'none'; }
  } catch {}
}

/* ════════════════════════════════════════════════
   INIT — navigation events
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const onNav = e => {
    const v = e.detail?.view;
    if (v === 'outils-charges')    calculerCharges();
    if (v === 'outils-km')         renderKmJournal();
    if (v === 'outils-modeles')    renderModeles();
    if (v === 'outils-simulation') simulerMajoration();
    if (v === 'outils-ordos') {
      // Délai court pour laisser la DB IDB se stabiliser après navigation
      setTimeout(() => renderOrdonnances().then(() => refreshOrdoBadge()).catch(() => {}), 80);
    }
  };
  document.addEventListener('app:nav',     onNav);
  document.addEventListener('ui:navigate', onNav);

  // Badge ordonnances au login
  document.addEventListener('ami:login', () => {
    // Délai 1.2s : laisser initPatientsDB() se terminer après le login
    setTimeout(() => refreshOrdoBadge().catch(() => {}), 1200);
    // Sync Journal kilométrique depuis le serveur au login (navigateur ↔ mobile)
    setTimeout(() => syncKmFromServer().catch(() => {}), 1500);
  });
  refreshOrdoBadge();
});

/* Exports globaux */
window.calculerCharges    = calculerCharges;
window.addKmEntry         = addKmEntry;
window.deleteKmEntry      = deleteKmEntry;
window.renderKmJournal    = renderKmJournal;
window.exportKmCSV        = exportKmCSV;
window.syncKmFromServer   = syncKmFromServer;
window.renderModeles      = renderModeles;
window.utiliserModele     = utiliserModele;
window.sauvegarderModele  = sauvegarderModele;
window.modifierModele     = modifierModele;
window.supprimerModele    = supprimerModele;
window.simulerMajoration  = simulerMajoration;
window.utiliserSimulation = utiliserSimulation;
window.addOrdonnance      = addOrdonnance;
window.deleteOrdonnance   = deleteOrdonnance;
window.renderOrdonnances  = renderOrdonnances;
