/**
 * BANQUE ÉTENDUE — 50 tests cliniques NGAP 2026.3
 * Couverture exhaustive : tous les chapitres + cas-limites + erreurs fréquentes
 */
const fs = require('fs');
const NGAPEngine = require('./ngap_engine.js');
const ref = JSON.parse(fs.readFileSync('./ngap_referentiel_2026.json', 'utf-8'));
const engine = new NGAPEngine(ref);

const TESTS = [
  // ════════ PERFUSIONS (CIR-9/2025) ════════
  { nom: '01. Perf 12h matin (7h)', input: { codes: [{ code: 'AMI14' }, { code: 'IFD' }], heure_soin: '07:00' }, total_attendu: 44.10 + 2.75 + 9.15 },
  { nom: '02. Perf 12h soir (rebranchement 19h)', input: { codes: [{ code: 'AMI4.1' }, { code: 'IFD' }], heure_soin: '19:00' }, total_attendu: 12.92 + 2.75 },
  { nom: '03. Perf chimio (cancer)', input: { codes: [{ code: 'AMI15' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 47.25 + 2.75 },
  { nom: '04. Perf courte 30min standard', input: { codes: [{ code: 'AMI9' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 28.35 + 2.75 },
  { nom: '05. Perf courte cancer (AMI10)', input: { codes: [{ code: 'AMI10' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 31.50 + 2.75 },
  { nom: '06. Retrait définitif PICC', input: { codes: [{ code: 'AMI5' }, { code: 'IFD' }], heure_soin: '14:00' }, total_attendu: 15.75 + 2.75 },
  { nom: '07. CIR-9/2025 : AMI14+AMI15 → AMI15', input: { codes: [{ code: 'AMI14' }, { code: 'AMI15' }], heure_soin: '10:00' }, total_attendu: 47.25, alerts_attendues_contiennent: ['CIR-9/2025'] },
  { nom: '08. Hist J : 2e AMI14 même jour', input: { codes: [{ code: 'AMI14' }], heure_soin: '19:00', historique_jour: [{ actes: [{ code: 'AMI14' }] }] }, total_attendu: 44.10, alerts_attendues_contiennent: ['Forfait perfusion longue déjà coté'] },
  { nom: '09. AMI9 + AMI6 supplément 2h', input: { codes: [{ code: 'AMI9' }, { code: 'AMI6' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 28.35 + 18.90 + 2.75 },

  // ════════ INJECTIONS / PRÉLÈVEMENTS (Article 1) ════════
  { nom: '10. Prise sang isolée domicile', input: { codes: [{ code: 'AMI1.5' }, { code: 'IFD' }], heure_soin: '09:00' }, total_attendu: 4.73 + 2.75 },
  { nom: '11. Injection insuline + glycémie', input: { codes: [{ code: 'AMI1' }, { code: 'AMI1' }, { code: 'IFD' }], heure_soin: '08:00' }, total_attendu: 3.15 + 1.58 + 2.75 },
  { nom: '12. Vaccination grippe avec presc', input: { codes: [{ code: 'AMI2.4' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 7.56 + 2.75 },
  { nom: '13. Vaccination sans prescription', input: { codes: [{ code: 'AMI3.05' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 9.61 + 2.75 },
  { nom: '14. Injection IV directe isolée', input: { codes: [{ code: 'AMI2' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 6.30 + 2.75 },
  { nom: '15. Injection allergène (hyposensibilisation)', input: { codes: [{ code: 'AMI3' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 9.45 + 2.75 },
  { nom: '16. Injection implant SC (Zoladex)', input: { codes: [{ code: 'AMI2.5' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 7.88 + 2.75 },

  // ════════ PANSEMENTS (Articles 2 et 3) ════════
  { nom: '17. Pansement simple', input: { codes: [{ code: 'AMI2' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 6.30 + 2.75 },
  { nom: '18. Pansement complexe escarre', input: { codes: [{ code: 'AMI4' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 12.60 + 2.75 },
  { nom: '19. Pans. complexe + analgésie topique (déroga.)', input: { codes: [{ code: 'AMI4' }, { code: 'AMI1.1' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 12.60 + 3.47 + 2.75 },
  { nom: '20. Bilan plaie initial annuel AMI11', input: { codes: [{ code: 'AMI11' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 34.65 + 2.75 },
  { nom: '21. Bilan plaie + MCI INTERDIT', input: { codes: [{ code: 'AMI11' }, { code: 'MCI' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 34.65 + 2.75, alerts_attendues_contiennent: ['Bilan plaie initial AMI11'] },
  { nom: '22. Pansement ulcère + compression', input: { codes: [{ code: 'AMI5.1' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 16.07 + 2.75 },
  { nom: '23. Pansement stomie', input: { codes: [{ code: 'AMI3' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 9.45 + 2.75 },
  { nom: '24. TPN pose système', input: { codes: [{ code: 'AMI4.6' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 14.49 + 2.75 },

  // ════════ SONDES & ALIMENTATION (Article 4 et 6) ════════
  { nom: '25. Sonde gastrique pose', input: { codes: [{ code: 'AMI3' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 9.45 + 2.75 },
  { nom: '26. Sonde urinaire H', input: { codes: [{ code: 'AMI4' }, { code: 'IFD' }], heure_soin: '11:00' }, total_attendu: 12.60 + 2.75 },
  { nom: '27. Retrait sonde urinaire', input: { codes: [{ code: 'AMI2' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 6.30 + 2.75 },
  { nom: '28. Alim entérale par gavage', input: { codes: [{ code: 'AMI3' }, { code: 'IFD' }], heure_soin: '08:00' }, total_attendu: 9.45 + 2.75 },
  { nom: '29. Alim entérale jéjunale', input: { codes: [{ code: 'AMI4' }, { code: 'IFD' }], heure_soin: '08:00' }, total_attendu: 12.60 + 2.75 },

  // ════════ BSI / DÉPENDANCE (Article 11 et 12) ════════
  { nom: '30. BSC seul (toilette grabataire)', input: { codes: [{ code: 'BSC' }, { code: 'IFI' }], heure_soin: '08:00' }, total_attendu: 28.70 + 2.75 },
  { nom: '31. BSC + perf longue (déroga. taux plein)', input: { codes: [{ code: 'BSC' }, { code: 'AMI14' }, { code: 'IFI' }], heure_soin: '10:00' }, total_attendu: 28.70 + 44.10 + 2.75 },
  { nom: '32. BSC + AIS3 INTERDIT', input: { codes: [{ code: 'BSC' }, { code: 'AIS3' }], heure_soin: '10:00' }, total_attendu: 28.70, alerts_attendues_contiennent: ['AIS + BSI'] },
  { nom: '33. BSC + BSA → BSC seul', input: { codes: [{ code: 'BSC' }, { code: 'BSA' }], heure_soin: '10:00' }, total_attendu: 28.70, alerts_attendues_contiennent: ['BSA'] },
  { nom: '34. BSC + MCI INTERDIT', input: { codes: [{ code: 'BSC' }, { code: 'MCI' }], heure_soin: '10:00' }, total_attendu: 28.70, alerts_attendues_contiennent: ['MCI + BSI'] },
  { nom: '35. AIS3 + ponction veineuse (déroga.)', input: { codes: [{ code: 'AIS3' }, { code: 'AMI1.5' }, { code: 'IFD' }], heure_soin: '08:00' }, total_attendu: 7.95 + 4.73 + 2.75 },
  { nom: '36. BSI initial DI 2.5', input: { codes: [{ code: 'DI2.5' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 25.00 + 2.75 },

  // ════════ POST-OP (Article 7 - Avenant 6) ════════
  { nom: '37. Surv post-op + retrait sonde (déroga.)', input: { codes: [{ code: 'AMI3.9' }, { code: 'AMI2' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 12.29 + 6.30 + 2.75 },
  { nom: '38. Surv post-op + retrait drain redon', input: { codes: [{ code: 'AMI3.9' }, { code: 'AMI2.8' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 12.29 + 8.82 + 2.75 },
  { nom: '39. Cathéter périnerveux post-op', input: { codes: [{ code: 'AMI4.2' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 13.23 + 2.75 },
  { nom: '40. AMI3.9 + AMI4.2 INTERDIT', input: { codes: [{ code: 'AMI3.9' }, { code: 'AMI4.2' }], heure_soin: '10:00' }, total_attendu: 12.29, alerts_attendues_contiennent: ['post-op'] },

  // ════════ BPCO / IC (Article 5ter) ════════
  { nom: '41. Surveillance BPCO/IC hebdo', input: { codes: [{ code: 'AMI5.8' }, { code: 'IFD' }], heure_soin: '10:00' }, total_attendu: 18.27 + 2.75 },

  // ════════ MAJORATIONS TEMPORELLES ════════
  { nom: '42. NUIT_PROF (3h)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], heure_soin: '03:00' }, total_attendu: 3.15 + 2.75 + 18.30 },
  { nom: '43. NUIT (06h)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], heure_soin: '06:00' }, total_attendu: 3.15 + 2.75 + 9.15 },
  { nom: '44. DIMANCHE (auto)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], date_soin: '2026-04-26', heure_soin: '10:00' }, total_attendu: 3.15 + 2.75 + 8.50 },
  { nom: '45. NUIT + DIM → NUIT prioritaire', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }, { code: 'NUIT' }, { code: 'DIM' }], heure_soin: '10:00' }, total_attendu: 3.15 + 2.75 + 9.15, alerts_attendues_contiennent: ['NUIT + DIM'] },
  { nom: '46. Férié (1er mai)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], date_soin: '2026-05-01', heure_soin: '10:00' }, total_attendu: 3.15 + 2.75 + 8.50 },

  // ════════ IK / DISTANCE ════════
  { nom: '47. IK 5 km (auto)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], distance_km: 5, heure_soin: '10:00' }, total_attendu: 3.15 + 2.75 + 3.50 },
  { nom: '48. IK 175 km (plafonnement 50%)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], distance_km: 175, heure_soin: '10:00' }, total_attendu: 3.15 + 2.75 + 61.25 },
  { nom: '49. IK 250 km (plafonnement 100%)', input: { codes: [{ code: 'AMI1' }, { code: 'IFD' }], distance_km: 250, heure_soin: '10:00' }, total_attendu: 3.15 + 2.75 + 0 },

  // ════════ CAS RÉEL DE BASTIEN ════════
  { nom: '50. Cas Bastien : perf 12h matin férié 7h (NUIT+DIM→NUIT)', input: { codes: [{ code: 'AMI14' }, { code: 'IFD' }], date_soin: '2026-05-01', heure_soin: '07:00' }, total_attendu: 44.10 + 2.75 + 9.15 },
];

console.log('═'.repeat(95));
console.log('BANQUE ÉTENDUE — 50 SCÉNARIOS NGAP 2026.3 + CIR-9/2025');
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
  if (!ok) {
    console.log(`${status} Test ${num}: ${t.nom}`);
    console.log(`    Attendu : ${t.total_attendu.toFixed(2)}€  |  Obtenu : ${r.total.toFixed(2)}€`);
    console.log(`    Détail  : ${r.actes_finaux.map(a => `${a.code}=${a.tarif_final}€`).join(' + ')}`);
    if (r.alerts.length > 0) console.log(`    Alerts  : ${r.alerts.join(' | ')}`);
    failures.push({ num: i+1, nom: t.nom, attendu: t.total_attendu, obtenu: r.total });
  } else {
    console.log(`${status} Test ${num}: ${t.nom}`);
  }
});

console.log('\n' + '═'.repeat(95));
const pct = Math.round(pass/TESTS.length*100);
console.log(`📊 RÉSULTATS : ${pass}/${TESTS.length} tests passent (${pct}%)`);
console.log('═'.repeat(95));
if (failures.length > 0) {
  console.log(`\n⚠️ ${failures.length} échecs à investiguer`);
  failures.forEach(f => console.log(`  Test ${f.num}: ${f.nom}`));
}
