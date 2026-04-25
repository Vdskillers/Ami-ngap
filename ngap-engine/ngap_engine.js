/**
 * NGAP ENGINE v2 — Moteur déclaratif STRICT-247
 * ================================================================
 * Source de vérité : ngap_referentiel_2026.json (247 chunks STRICT du DUAL_RAG)
 * Aligné sur : NGAP_2026.4_STRICT_247_DUAL_RAG
 * Usage :
 *   const engine = new NGAPEngine(referentiel);
 *   const result = engine.compute({
 *     codes: [{ code: 'AMI14', context: 'cancer' }, { code: 'IFD' }],
 *     date_soin: '2026-04-23',
 *     heure_soin: '07:00',
 *     historique_jour: [],     // autres cotations du même jour
 *     mode: 'strict' | 'permissif',
 *     zone: 'metropole' | 'outre_mer' | 'montagne' | 'plaine',
 *     distance_km: 5
 *   });
 *
 * Returns :
 *   {
 *     ok: true,
 *     actes_finaux: [...],     // après application règles
 *     total: 56.00,
 *     alerts: [...],            // règles déclenchées
 *     warnings_strict: [...],   // codes qui auraient été bloqués en mode strict
 *     audit: {...}              // traçabilité complète
 *   }
 */

class NGAPEngine {
  constructor(referentiel) {
    this.ref = referentiel;
    // Index pour lookup O(1)
    this._index = {};
    // Actes Chap I + Chap II — STRICT n'a plus de code_facturation, code uniquement
    [...(referentiel.actes_chapitre_I || []), ...(referentiel.actes_chapitre_II || [])].forEach(a => {
      this._index[a.code] = a;
    });
    Object.entries(referentiel.forfaits_bsi || {}).forEach(([k, v]) => { this._index[k] = { ...v, code: k }; });
    Object.entries(referentiel.forfaits_di || {}).forEach(([k, v]) => { this._index[k] = { ...v, code: k }; });
    Object.entries(referentiel.deplacements || {}).forEach(([k, v]) => { this._index[k] = { ...v, code: k }; });
    Object.entries(referentiel.majorations || {}).forEach(([k, v]) => { this._index[k] = { ...v, code: k }; });
    Object.entries(referentiel.telesoin || {}).forEach(([k, v]) => { this._index[k] = { ...v, code: k }; });
    Object.entries(referentiel.forfaits_ipa || {}).forEach(([k, v]) => { this._index[k] = { ...v, code: k }; });
    // Alias majorations (codes courts utilisés par le moteur de détection horaire)
    this._index['NUIT'] = this._index['ISN_NUIT'];
    this._index['NUIT_PROF'] = this._index['ISN_NUIT_PROFONDE'];
    this._index['DIM'] = this._index['ISD'];
    // Alias IK (code générique calculé dynamiquement, pas de tarif fixe)
    if (!this._index['IK']) {
      this._index['IK'] = { code: 'IK', label: 'Indemnité kilométrique', tarif: 0, tarif_om: 0 };
    }
  }

  // ─── Normalisation de code (AMI 4,1 → AMI4.1 → AMI4_1) ─────────
  normCode(raw) {
    if (!raw) return '';
    let c = String(raw).toUpperCase().trim().replace(/\s+/g, '').replace(/,/g, '.');
    // Code facturation = AMI4.1, code interne = AMI4_1 — normaliser sur code facturation
    if (c === 'AMI4_1') c = 'AMI4.1';
    if (c === 'AMX4_1') c = 'AMX4.1';
    return c;
  }

  // ─── Lookup d'un acte par code (facturation ou interne) ────────
  lookup(code) {
    const c = this.normCode(code);
    return this._index[c] || null;
  }

  // ─── Tarif zone-aware ──────────────────────────────────────────
  getTarif(acte, zone) {
    if (!acte) return 0;
    if (zone === 'outre_mer' && acte.tarif_om != null) return acte.tarif_om;
    return acte.tarif || 0;
  }

  // ─── Calcul IK aller-retour avec plafonnement ──────────────────
  calcIK(distance_km, zone) {
    if (!distance_km || distance_km <= 0) return { tarif: 0, plafonnement: null };
    const distance_ar = distance_km * 2;
    const tarif_par_km = (zone === 'montagne') ? 0.50 : 0.35;
    let total = distance_ar * tarif_par_km;
    let plafonnement = null;
    if (distance_ar >= 400) { total = total * 0; plafonnement = '100%_>=400km'; }
    else if (distance_ar >= 300) { total = total * 0.5; plafonnement = '50%_300-399km'; }
    return { tarif: Math.round(total * 100) / 100, plafonnement };
  }

  // ─── Détection horaire (NUIT, NUIT_PROF, DIM) ──────────────────
  detectMajorationsTemporelles(date_soin, heure_soin) {
    const out = [];
    // Heure
    const h = (heure_soin || '').slice(0, 5);
    if (h) {
      if (h >= '23:00' || h < '05:00') out.push('NUIT_PROF');
      else if (h >= '20:00' || h < '08:00') out.push('NUIT');
    }
    // Date — dimanche / férié
    if (date_soin) {
      const d = new Date(date_soin);
      const FERIES_FR = new Set([
        '2025-01-01','2025-04-21','2025-05-01','2025-05-08','2025-05-29',
        '2025-06-09','2025-07-14','2025-08-15','2025-11-01','2025-11-11','2025-12-25',
        '2026-01-01','2026-04-06','2026-05-01','2026-05-08','2026-05-14',
        '2026-05-25','2026-07-14','2026-08-15','2026-11-01','2026-11-11','2026-12-25',
        '2027-01-01','2027-03-29','2027-05-01','2027-05-08','2027-05-06',
        '2027-05-17','2027-07-14','2027-08-15','2027-11-01','2027-11-11','2027-12-25',
      ]);
      const isDimanche = d.getDay() === 0;
      const isFerie = FERIES_FR.has(date_soin.slice(0, 10));
      if (isDimanche || isFerie) out.push('DIM');
    }
    return out;
  }

  // ─── Application incompatibilités du référentiel (format groupe_a/groupe_b) ─
  applyIncompatibilities(actes, alerts) {
    let result = [...actes];
    for (const rule of (this.ref.incompatibilites || [])) {
      const groupeA = rule.groupe_a || [];
      const groupeB = rule.groupe_b || [];
      const presentInA = groupeA.some(c =>
        result.some(a => this.normCode(a.code) === this.normCode(c))
      );
      const presentInB = groupeB.some(c =>
        result.some(a => this.normCode(a.code) === this.normCode(c))
      );
      if (presentInA && presentInB) {
        const groupeASupp = rule.supprimer === 'groupe_a' ? groupeA : groupeB;
        const codesToRemove = groupeASupp.map(c => this.normCode(c));
        const beforeLen = result.length;
        result = result.filter(a => !codesToRemove.includes(this.normCode(a.code)));
        if (beforeLen !== result.length) {
          const icon = rule.severity === 'critical' ? '🚨' : '⚠️';
          alerts.push(`${icon} ${rule.label || 'Incompatibilité NGAP'}`);
        }
      }
    }
    return result;
  }

  // ─── Vérifier si 2 actes sont en dérogation taux plein ─────────
  isDerogatoireCumul(codeA, codeB) {
    const a = this.normCode(codeA);
    const b = this.normCode(codeB);
    for (const d of (this.ref.derogations_taux_plein || [])) {
      const groupeA = d.groupe_a || [];
      const groupeB = d.groupe_b || [];
      // Cas spécial Article 5bis : groupe_b === ['mêmes codes'] → tous les codes du groupe_a se cumulent ENTRE EUX
      const memesCodes = groupeB.length === 1 && /m[êe]mes\s+codes/i.test(groupeB[0]);
      if (memesCodes) {
        const inA1 = groupeA.some(c => this.normCode(c) === a);
        const inA2 = groupeA.some(c => this.normCode(c) === b);
        if (inA1 && inA2) return true;
        continue;
      }
      const inA = groupeA.some(c => this.normCode(c) === a);
      const inB = groupeB.some(c => this.normCode(c) === b);
      const inA2 = groupeA.some(c => this.normCode(c) === b);
      const inB2 = groupeB.some(c => this.normCode(c) === a);
      if ((inA && inB) || (inA2 && inB2)) return true;
    }
    return false;
  }

  // ─── Helpers de classification basés sur le référentiel STRICT ──
  isMajorationCode(code) {
    const c = this.normCode(code);
    // Majorations du référentiel + alias horaires + IK/IFD/IFI
    if (this.ref.majorations && this.ref.majorations[c]) return true;
    if (this.ref.deplacements && this.ref.deplacements[c]) return true;
    if (['NUIT', 'NUIT_PROF', 'DIM', 'IK'].includes(c)) return true;
    return false;
  }
  isBSICode(code) {
    const c = this.normCode(code);
    return !!(this.ref.forfaits_bsi && this.ref.forfaits_bsi[c]);
  }
  isDICode(code) {
    const c = this.normCode(code);
    return !!(this.ref.forfaits_di && this.ref.forfaits_di[c]);
  }
  isTelesoinCode(code) {
    const c = this.normCode(code);
    return !!(this.ref.telesoin && this.ref.telesoin[c]);
  }
  isIPACode(code) {
    const c = this.normCode(code);
    return !!(this.ref.forfaits_ipa && this.ref.forfaits_ipa[c]);
  }

  // ─── Application de l'article 11B (coefficients) ───────────────
  applyArticle11B(actes, alerts) {
    const isMajoration = (c) => this.isMajorationCode(c);
    const isBSI = (c) => this.isBSICode(c);
    const isDI = (c) => this.isDICode(c);
    const isTele = (c) => this.isTelesoinCode(c);
    const isIPA = (c) => this.isIPACode(c);

    // Forfaits / majorations / téléconsultations / IPA restent à coefficient 1
    let result = actes.map(a => {
      if (isMajoration(a.code) || isBSI(a.code) || isDI(a.code) || isTele(a.code) || isIPA(a.code)) {
        return { ...a, coefficient_applique: 1, taux: 'plein_majoration_ou_forfait' };
      }
      return a;
    });

    // Actes techniques (AMI/AMX/AIS) — application 11B
    const techActs = result.filter(a =>
      !isMajoration(a.code) && !isBSI(a.code) && !isDI(a.code) && !isTele(a.code) && !isIPA(a.code)
    );

    if (techActs.length === 0) return result;

    // Tri par tarif décroissant — le plus valorisé devient principal
    techActs.sort((a, b) => (b._tarif_base || 0) - (a._tarif_base || 0));

    // 1er acte = principal à 100%
    techActs[0].coefficient_applique = 1;
    techActs[0].taux = 'plein_principal';

    // 2e acte : 50% sauf dérogation taux plein
    if (techActs.length >= 2) {
      const a = techActs[1];
      const isCumulTauxPlein =
        techActs.slice(0, 1).some(b => this.isDerogatoireCumul(a.code, b.code)) ||
        result.some(b => isBSI(b.code) && this.isDerogatoireCumul(a.code, b.code));
      if (isCumulTauxPlein) {
        a.coefficient_applique = 1;
        a.taux = 'plein_derogatoire';
      } else {
        a.coefficient_applique = 0.5;
        a.taux = 'demi_tarif_art11B';
      }
    }

    // 3e acte et au-delà : 0€ SAUF dérogation explicite taux plein
    for (let i = 2; i < techActs.length; i++) {
      const a = techActs[i];
      const isCumulTauxPlein =
        techActs.slice(0, i).some(b => this.isDerogatoireCumul(a.code, b.code)) ||
        result.some(b => isBSI(b.code) && this.isDerogatoireCumul(a.code, b.code));
      if (isCumulTauxPlein) {
        a.coefficient_applique = 1;
        a.taux = 'plein_derogatoire';
      } else {
        a.coefficient_applique = 0; // Article 11B : "Les actes suivant le second ne donnent pas lieu à honoraires"
        a.taux = 'gratuit_art11B_3eme';
        alerts.push(`ℹ️ Article 11B : ${a.code} en 3e position → non facturable (honoraires nuls)`);
      }
    }

    return result;
  }

  // ─── Validation CIR-9/2025 (forfait journalier perfusion) ──────
  applyCIR92025(actes, historique_jour, alerts) {
    let result = [...actes];
    const codesFortLong = ['AMI14', 'AMX14', 'AMI15', 'AMX15'];
    
    // 1. Vérifier si AMI14 et AMI15 même cotation
    const has14 = result.some(a => ['AMI14', 'AMX14'].includes(this.normCode(a.code)));
    const has15 = result.some(a => ['AMI15', 'AMX15'].includes(this.normCode(a.code)));
    if (has14 && has15) {
      alerts.push('🚨 CIR-9/2025 : AMI14 + AMI15 même jour interdits — suppression AMI14 (AMI15 prioritaire si cancer)');
      result = result.filter(a => !['AMI14', 'AMX14'].includes(this.normCode(a.code)));
    }
    
    // 2. Vérifier dans l'historique du jour s'il y a déjà un AMI14/15
    if (historique_jour && historique_jour.length > 0) {
      const histHasForfaitLong = historique_jour.some(h => 
        (h.actes || []).some(a => codesFortLong.includes(this.normCode(a.code)))
      );
      if (histHasForfaitLong) {
        const currentHasForfaitLong = result.some(a => codesFortLong.includes(this.normCode(a.code)));
        if (currentHasForfaitLong) {
          alerts.push('🚨 CIR-9/2025 : Forfait perfusion longue déjà coté ce jour — la 2e perfusion doit être AMI 4.1 (6.30€)');
          // En mode strict on supprimerait. En mode permissif on alerte.
        }
      }
    }
    
    return result;
  }

  // ─── Calcul total avec arrondi 2 décimales ─────────────────────
  computeTotal(actes) {
    return Math.round(actes.reduce((s, a) => s + (a._tarif_final || 0), 0) * 100) / 100;
  }

  // ─── MAIN — pipeline complet ───────────────────────────────────
  compute(input) {
    const {
      codes = [],
      date_soin = '',
      heure_soin = '',
      historique_jour = [],
      mode = 'permissif',
      zone = 'metropole',
      distance_km = 0,
      contexte_bsi = false,
    } = input;

    const alerts = [];
    const warnings_strict = [];
    let actes = [];

    // 1. Lookup chaque code → enrichir
    for (const item of codes) {
      const acte = this.lookup(item.code);
      if (!acte) {
        if (mode === 'strict') {
          warnings_strict.push(`Code "${item.code}" non reconnu — bloqué en mode strict`);
          continue;
        } else {
          alerts.push(`⚠️ Code "${item.code}" non reconnu dans le référentiel — accepté tel quel`);
          actes.push({ code: item.code, _tarif_base: item.tarif || 0, label: item.label || 'Inconnu' });
          continue;
        }
      }
      const tarif = this.getTarif(acte, zone);
      actes.push({
        code: acte.code,
        label: acte.label,
        coefficient: acte.coefficient,
        _tarif_base: tarif,
        article: acte.article,
        chunk_id: acte.chunk_id || null,
        ...item,
      });
    }

    // 2. Ajouter majorations temporelles automatiquement
    const majorations = this.detectMajorationsTemporelles(date_soin, heure_soin);
    for (const maj of majorations) {
      if (!actes.some(a => this.normCode(a.code) === maj)) {
        const m = this.lookup(maj);
        if (m) {
          actes.push({ code: maj, label: m.label, _tarif_base: this.getTarif(m, zone), _auto_added: true });
          alerts.push(`ℹ️ Majoration ${maj} ajoutée automatiquement (heure/date)`);
        }
      }
    }

    // 3. Ajouter IK si distance > 0
    if (distance_km > 0 && !actes.some(a => this.normCode(a.code) === 'IK')) {
      const ikCalc = this.calcIK(distance_km, zone);
      if (ikCalc.tarif > 0) {
        actes.push({
          code: 'IK', label: `Indemnité kilométrique (${distance_km} km AR)`,
          _tarif_base: ikCalc.tarif, _auto_added: true
        });
        if (ikCalc.plafonnement) alerts.push(`ℹ️ IK plafonnée : ${ikCalc.plafonnement}`);
      }
    }

    // 4. Appliquer CIR-9/2025
    actes = this.applyCIR92025(actes, historique_jour, alerts);

    // 5. Appliquer incompatibilités du référentiel
    actes = this.applyIncompatibilities(actes, alerts);

    // 6. Appliquer article 11B (coefficients)
    actes = this.applyArticle11B(actes, alerts);

    // 7. Calculer tarifs finaux
    actes = actes.map(a => ({
      ...a,
      _tarif_final: Math.round((a._tarif_base || 0) * (a.coefficient_applique != null ? a.coefficient_applique : 1) * 100) / 100
    }));

    // 8. Total
    const total = this.computeTotal(actes);

    // 9. Audit
    const audit = {
      version_referentiel: this.ref.version,
      mode,
      zone,
      distance_km,
      majorations_auto: majorations,
      nb_alerts: alerts.length,
      regles_appliquees: [
        'CIR-9/2025_perfusions',
        'Incompatibilites_referentiel',
        'Article_11B_coefficients',
        'Majorations_temporelles_auto',
        'IK_aller_retour_avec_plafonnement',
      ],
      timestamp: new Date().toISOString(),
    };

    return {
      ok: true,
      actes_finaux: actes.map(a => ({
        code: a.code,
        label: a.label,
        tarif_base: a._tarif_base,
        coefficient: a.coefficient_applique != null ? a.coefficient_applique : 1,
        tarif_final: a._tarif_final,
        taux: a.taux,
        article: a.article,
        chunk_id: a.chunk_id,
        auto_added: a._auto_added || false,
      })),
      total,
      alerts,
      warnings_strict,
      audit,
    };
  }
}

// Export pour Node.js (worker, n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NGAPEngine;
}
