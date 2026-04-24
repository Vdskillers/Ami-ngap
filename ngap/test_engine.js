/**
 * BANQUE DE TESTS CLINIQUES NGAP 2026
 * ====================================
 * Couvre les cas types des Chapitres I et II + dérogations
 * Pour chaque cas : entrée + cotation attendue (validée manuellement)
 */
const fs = require('fs');
const NGAPEngine = require('./ngap_engine.js');
const ref = JSON.parse(fs.readFileSync('./ngap_referentiel_2026.json', 'utf-8'));
const engine = new NGAPEngine(ref);

// Format attendu : { codes: [...], total_attendu, alerts_attendues_contiennent: [...] }
const TESTS = [
  // ─── PERFUSIONS (CRITIQUE — CIR-9/2025) ──────────────────────
  {
    nom: '1. Perfusion 12h matin (non cancéreux, 7h)',
    input: { codes: [{ code: 'AMI14' }, { code: 'IFD' }], heure_soin: '07:00' },
    total_attendu: 44.10 + 2.75 + 9.15, // AMI14 + IFD + NUIT (auto)
    description: 'AMI14 forfait journalier + IFD + NUIT auto',
  },
  {
    nom: '2. Perfusion 12h soir rebranchement 19h',
    input: { codes: [{ code: 'AMI4.1' }, { code: 'IFD' }], heure_soin: '19:00' },
    total_attendu: 12.92 + 2.75, // AMI4.1 = 4.1 × 3.15 = 12.92€ (tarif officiel !)
    description: 'AMI4.1 = 12.92€ (tarif officiel NGAP, pas 6.30€)',
  },
  {
    nom: '3. Perfusion chimio chambre implantable',
    input: { codes: [{ code: 'AMI15' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 47.25 + 2.75,
    description: 'AMI15 cancer + IFD',
  },
  {
    nom: '4. Perfusion courte 30 min standard',
    input: { codes: [{ code: 'AMI9' }, { code: 'IFD' }], heure_soin: '11:00' },
    total_attendu: 28.35 + 2.75,
    description: 'AMI9 perfusion courte standard',
  },
  {
    nom: '5. Retrait définitif PICC',
    input: { codes: [{ code: 'AMI5' }, { code: 'IFD' }], heure_soin: '14:00' },
    total_attendu: 15.75 + 2.75,
    description: 'AMI5 retrait définitif',
  },
  {
    nom: '6. CIR-9/2025 violation : AMI14 + AMI15 même cotation',
    input: { codes: [{ code: 'AMI14' }, { code: 'AMI15' }], heure_soin: '10:00' },
    total_attendu: 47.25, // AMI14 supprimé, garder AMI15
    alerts_attendues_contiennent: ['CIR-9/2025'],
    description: 'CIR-9/2025 : suppression AMI14, garder AMI15',
  },
  {
    nom: '7. CIR-9/2025 historique : 2e AMI14 dans la journée',
    input: { 
      codes: [{ code: 'AMI14' }],
      heure_soin: '19:00',
      historique_jour: [{ actes: [{ code: 'AMI14' }] }]
    },
    total_attendu: 44.10, // En mode permissif, on alerte mais on garde
    alerts_attendues_contiennent: ['Forfait perfusion longue déjà coté'],
    description: 'Alerte CIR-9/2025 sur 2e AMI14 mais garde en permissif',
  },

  // ─── INJECTIONS / PRÉLÈVEMENTS ───────────────────────────────
  {
    nom: '8. Prise de sang isolée à domicile',
    input: { codes: [{ code: 'AMI1.5' }, { code: 'IFD' }], heure_soin: '09:00' },
    total_attendu: 4.73 + 2.75,
    description: 'AMI1.5 ponction veineuse + IFD',
  },
  {
    nom: '9. Injection insuline + glycémie capillaire (insulino-traité)',
    input: { codes: [{ code: 'AMI1' }, { code: 'AMI1' }, { code: 'IFD' }], heure_soin: '08:00' },
    total_attendu: 3.15 + 1.58 + 2.75, // 1er AMI1 100%, 2e AMI1 50%
    description: 'Cas 11B classique : 1er à 100%, 2e à 50%',
  },

  // ─── PANSEMENTS ──────────────────────────────────────────────
  {
    nom: '10. Pansement complexe + analgésie topique (dérogation)',
    input: { codes: [{ code: 'AMI4' }, { code: 'AMI1.1' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 12.60 + 3.47 + 2.75, // Cumul taux plein dérogation art 11B
    description: 'Dérogation pansement complexe + EMLA = taux plein',
  },
  {
    nom: '11. Pansement simple seul',
    input: { codes: [{ code: 'AMI2' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 6.30 + 2.75,
    description: 'AMI2 pansement simple',
  },
  {
    nom: '12. Bilan plaie initial AMI11',
    input: { codes: [{ code: 'AMI11' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 34.65 + 2.75,
    description: 'AMI11 bilan annuel plaie complexe',
  },

  // ─── BSI / DÉPENDANCE ────────────────────────────────────────
  {
    nom: '13. BSC seul (toilette grabataire)',
    input: { codes: [{ code: 'BSC' }, { code: 'IFI' }], heure_soin: '08:00' },
    total_attendu: 28.70 + 2.75,
    description: 'BSC forfait journalier dépendance lourde + IFI',
  },
  {
    nom: '14. BSC + perfusion (dérogation taux plein)',
    input: { codes: [{ code: 'BSC' }, { code: 'AMI14' }, { code: 'IFI' }], heure_soin: '10:00' },
    total_attendu: 28.70 + 44.10 + 2.75, // Dérogation BSI + perfusion taux plein
    description: 'Dérogation BSI + perfusion = cumul taux plein',
  },
  {
    nom: '15. BSC + AIS3 (interdit)',
    input: { codes: [{ code: 'BSC' }, { code: 'AIS3' }], heure_soin: '10:00' },
    total_attendu: 28.70, // AIS3 supprimé
    alerts_attendues_contiennent: ['AIS + BSI'],
    description: 'AIS + BSI exclu — AIS supprimé',
  },

  // ─── POST-OPÉRATOIRE (Avenant 6) ─────────────────────────────
  {
    nom: '16. Surveillance post-op + retrait sonde (dérogation)',
    input: { codes: [{ code: 'AMI3.9' }, { code: 'AMI2' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 12.29 + 6.30 + 2.75, // Cumul taux plein avenant 6
    description: 'Dérogation post-op : AMI3.9 + AMI2 = taux plein',
  },
  {
    nom: '17. Surv post-op + retrait drain redon',
    input: { codes: [{ code: 'AMI3.9' }, { code: 'AMI2.8' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 12.29 + 8.82 + 2.75,
    description: 'Dérogation post-op : AMI3.9 + AMI2.8 = taux plein',
  },

  // ─── SONDES (Article 6) ──────────────────────────────────────
  {
    nom: '18. Changement sonde urinaire homme',
    input: { codes: [{ code: 'AMI4' }, { code: 'IFD' }], heure_soin: '11:00' },
    total_attendu: 12.60 + 2.75,
    description: 'AMI4 changement sonde H',
  },

  // ─── BPCO/IC (Article 5ter) ──────────────────────────────────
  {
    nom: '19. Surveillance BPCO hebdo',
    input: { codes: [{ code: 'AMI5.8' }, { code: 'IFD' }], heure_soin: '10:00' },
    total_attendu: 18.27 + 2.75,
    description: 'AMI5.8 surveillance BPCO/IC hebdo',
  },

  // ─── MAJORATIONS ─────────────────────────────────────────────
  {
    nom: '20. Acte de nuit profonde (3h du matin)',
    input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], heure_soin: '03:00' },
    total_attendu: 3.15 + 2.75 + 18.30,
    description: 'NUIT_PROF auto-ajoutée à 3h',
  },
  {
    nom: '21. Acte le dimanche',
    input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], date_soin: '2026-04-26', heure_soin: '10:00' },
    total_attendu: 3.15 + 2.75 + 8.50,
    description: 'DIM auto-ajoutée le dimanche',
  },
  {
    nom: '22. NUIT + DIM même cotation (interdit)',
    input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }, { code: 'NUIT' }, { code: 'DIM' }], heure_soin: '10:00' },
    total_attendu: 3.15 + 2.75 + 9.15, // DIM supprimé (NUIT prioritaire)
    alerts_attendues_contiennent: ['NUIT + DIM'],
    description: 'NUIT + DIM : DIM supprimé',
  },

  // ─── IK ──────────────────────────────────────────────────────
  {
    nom: '23. Acte avec distance 5 km',
    input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], distance_km: 5, heure_soin: '10:00' },
    total_attendu: 3.15 + 2.75 + 3.50, // IK = 5×2×0.35 = 3.50
    description: 'IK ajoutée auto, 5 km AR = 3.50€',
  },
  {
    nom: '24. IK plafonnement 350 km',
    input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], distance_km: 175, heure_soin: '10:00' },
    // 175 km AR = 350 km. Tranche 300-399 = abattement 50%. IK normale = 350×0.35 = 122.50€, après abattement 50% = 61.25€
    total_attendu: 3.15 + 2.75 + 61.25,
    description: 'IK 350 km AR avec abattement 50%',
  },

  // ─── ARTICLE 5BIS (DIABÈTE INSULINO) ─────────────────────────
  {
    nom: '25. Glycémie + insuline + pansement pied diabétique',
    input: { codes: [{ code: 'AMI1' }, { code: 'AMI1' }, { code: 'AMI4' }, { code: 'IFD' }], heure_soin: '08:00' },
    // Hors article 5bis, le 11B s'applique : AMI4 (12.60) + AMI1 50% (1.58) + AMI1 0% = 14.18€ + IFD
    // En mode permissif on n'applique pas auto la dérogation 5bis
    total_attendu: 12.60 + 1.58 + 0 + 2.75, // AMI4 100%, AMI1 50%, AMI1 0% (3e acte)
    description: 'Cas 5bis NON détecté (mode permissif neutre)',
  },
];

// ─── EXÉCUTION ─────────────────────────────────────────────────
console.log('═'.repeat(95));
console.log('BANQUE DE TESTS CLINIQUES NGAP 2026.3 — 25 SCÉNARIOS');
console.log('═'.repeat(95));

let pass = 0, fail = 0;
const failures = [];

TESTS.forEach((t, i) => {
  const r = engine.compute(t.input);
  const totalOk = Math.abs(r.total - t.total_attendu) < 0.01;
  let alertsOk = true;
  if (t.alerts_attendues_contiennent) {
    alertsOk = t.alerts_attendues_contiennent.every(needle =>
      r.alerts.some(a => a.includes(needle))
    );
  }
  const ok = totalOk && alertsOk;
  if (ok) pass++; else fail++;
  
  const status = ok ? '✅' : '❌';
  const num = (i + 1).toString().padStart(2, ' ');
  console.log(`${status} Test ${num}: ${t.nom}`);
  if (!ok) {
    console.log(`    Attendu : ${t.total_attendu.toFixed(2)}€`);
    console.log(`    Obtenu  : ${r.total.toFixed(2)}€`);
    console.log(`    Détail  : ${r.actes_finaux.map(a => `${a.code}=${a.tarif_final}€`).join(' + ')}`);
    if (r.alerts.length > 0) console.log(`    Alerts  : ${r.alerts.join(' | ')}`);
    failures.push({ num: i+1, nom: t.nom, attendu: t.total_attendu, obtenu: r.total });
  }
});

console.log('\n' + '═'.repeat(95));
console.log(`📊 RÉSULTATS : ${pass}/${TESTS.length} tests passent (${Math.round(pass/TESTS.length*100)}%)`);
console.log('═'.repeat(95));
if (failures.length > 0) {
  console.log(`\n⚠️ ${failures.length} échecs :`);
  failures.forEach(f => console.log(`  Test ${f.num}: ${f.nom} — attendu ${f.attendu}€, obtenu ${f.obtenu}€`));
}
