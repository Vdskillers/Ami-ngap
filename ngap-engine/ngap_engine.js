/**
 * NGAP ENGINE v2 — Moteur déclaratif basé sur le référentiel JSON
 * ================================================================
 * Source de vérité : ngap_referentiel_2026.json (v2026.4 Avenant 11)
 *
 * Nouveautés v2 (Avenant 11 du 31/03/2026) :
 *   ─ Tarifs AMI date-aware (3.15 → 3.35 nov. 2026 → 3.45 nov. 2027)
 *   ─ Consultations infirmières CIA / CIB (séance dédiée, 20€)
 *   ─ Majoration MSG (avec BSC, SEGA ≥ 35)
 *   ─ Majoration MSD (enfant diabétique scolarisé <16 ans)
 *   ─ Majoration MIR (intervention régulée, plafond 20/sem)
 *   ─ Astreinte IAS_PDSA (52€/4h)
 *   ─ Acte levée de doute AMI1.35
 *   ─ Surveillance hebdomadaire AMI3.77 (01/01/2028)
 *   ─ Bilan plaie simple annuel AMI3.48 (01/01/2027)
 *   ─ Accès direct pansements non chirurgicaux (validation)
 *   ─ Collyres ALD 15/23 (contrôle cible)
 *   ─ Kit dépistage colorectal RKD (3€ + 2€)
 *
 * Usage :
 *   const engine = new NGAPEngine(referentiel);
 *   const result = engine.compute({
 *     codes: [{ code: 'AMI14', context: 'cancer' }, { code: 'IFD' }],
 *     date_soin: '2026-04-23',
 *     heure_soin: '07:00',
 *     historique_jour: [],        // autres cotations du même jour
 *     historique_semaine: [],     // utile pour MIR (plafond 20/sem) et AMI3.77
 *     historique_annee: [],       // utile pour AMI3.48 (1x/12 mois)
 *     mode: 'strict' | 'permissif',
 *     zone: 'metropole' | 'outre_mer' | 'montagne' | 'plaine',
 *     distance_km: 5,
 *     contexte: {                 // contexte clinique enrichi
 *       sega_score: 38,           // score SEGA (pour MSG)
 *       ald_codes: ['ALD15'],     // codes ALD (pour collyres, AMI1.48)
 *       acces_direct: false,      // pansement en accès direct sans prescription
 *       contexte_scolaire: false, // pour MSD (enfant <16 ans diabétique)
 *       regulation_sas: false,    // pour MIR / AMI1.35
 *       age_patient: 72
 *     }
 *   });
 */

class NGAPEngine {
  constructor(referentiel) {
    this.ref = referentiel;

    // Index principal pour lookup O(1) — actes Chapitre I + II
    this._index = {};
    [...referentiel.actes_chapitre_I, ...referentiel.actes_chapitre_II].forEach(a => {
      this._index[a.code] = a;
      if (a.code_facturation) this._index[a.code_facturation] = a;
    });

    // Index BSI, déplacements, majorations, télésoin
    Object.entries(referentiel.forfaits_bsi || {}).forEach(([k, v]) => {
      if (typeof v === 'object' && v.tarif != null) this._index[k] = { ...v, code: k };
    });
    Object.entries(referentiel.forfaits_di || {}).forEach(([k, v]) => {
      this._index[k] = { ...v, code: k };
    });
    Object.entries(referentiel.deplacements || {}).forEach(([k, v]) => {
      this._index[k] = { ...v, code: k };
    });
    Object.entries(referentiel.majorations || {}).forEach(([k, v]) => {
      this._index[k] = { ...v, code: k };
    });
    Object.entries(referentiel.telesoin || {}).forEach(([k, v]) => {
      this._index[k] = { ...v, code: k };
    });

    // ─── NOUVEAU Avenant 11 : indexer CIA/CIB/RKD depuis lettres_cles ───
    ['CIA', 'CIB', 'RKD'].forEach(k => {
      const lc = (referentiel.lettres_cles || {})[k];
      if (lc) {
        this._index[k] = {
          code: k,
          code_facturation: k,
          label: lc.label,
          tarif: lc.valeur,
          tarif_om: lc.valeur_om,
          _is_consultation: ['CIA', 'CIB'].includes(k),
          _seance_dediee: !!lc.seance_dediee,
          _non_cumul_autres_actes: !!lc.non_cumul_autres_actes,
          _is_depistage: k === 'RKD',
        };
      }
    });

    // ─── NOUVEAU Avenant 11 : indemnité d'astreinte PDSA ───
    Object.entries(referentiel.indemnites_astreinte || {}).forEach(([k, v]) => {
      this._index[k] = { ...v, code: k, _is_astreinte: true };
    });

    // Alias majorations (raccourcis historiques)
    this._index['NUIT']       = this._index['ISN_NUIT'];
    this._index['NUIT_PROF']  = this._index['ISN_NUIT_PROFONDE'];
    this._index['DIM']        = this._index['ISD'];
  }

  // ─── Normalisation de code (AMI 4,1 → AMI4.1 → AMI4_1) ─────────
  normCode(raw) {
    if (!raw) return '';
    let c = String(raw).toUpperCase().trim().replace(/\s+/g, '').replace(/,/g, '.');
    if (c === 'AMI4_1') c = 'AMI4.1';
    if (c === 'AMX4_1') c = 'AMX4.1';
    return c;
  }

  // ─── Lookup d'un acte par code (facturation ou interne) ────────
  lookup(code) {
    const c = this.normCode(code);
    return this._index[c] || null;
  }

  // ─── NOUVEAU : Résolution tarif AMI date-aware (Avenant 11) ────
  //   avant 01/11/2026 → 3.15 €
  //   01/11/2026 → 31/10/2027 → 3.35 €
  //   à partir du 01/11/2027 → 3.45 €
  getAMIValueForDate(date_soin, zone = 'metropole') {
    const cal = ((this.ref.lettres_cles || {}).AMI || {}).calendrier_avenant_11 || {};
    const fallback = zone === 'outre_mer'
      ? (this.ref.lettres_cles?.AMI?.valeur_om || 3.30)
      : (this.ref.lettres_cles?.AMI?.valeur || 3.15);
    if (!date_soin) return fallback;

    // On cherche la date la plus récente antérieure ou égale à date_soin
    const dateKey = String(date_soin).slice(0, 10);
    const steps = Object.keys(cal)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort();
    let active = null;
    for (const k of steps) {
      if (k <= dateKey) active = cal[k];
    }
    if (!active) return fallback;
    return zone === 'outre_mer' ? (active.valeur_om || active.valeur) : active.valeur;
  }

  // ─── Tarif zone-aware + date-aware (v2) ────────────────────────
  getTarif(acte, zone, date_soin) {
    if (!acte) return 0;

    // Si c'est un acte AMI/AMX/TMI et qu'on a une date, recalculer le tarif
    // selon le calendrier Avenant 11 (lettre-clé × coefficient)
    const coef = acte.coefficient;
    const lettre = acte.lettre_cle || '';
    if (date_soin && coef && /AMI|AMX|TMI/.test(lettre)) {
      const val = this.getAMIValueForDate(date_soin, zone);
      return Math.round(val * coef * 100) / 100;
    }

    // Fallback sur tarif figé du référentiel
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
    const h = (heure_soin || '').slice(0, 5);
    if (h) {
      if (h >= '23:00' || h < '05:00') out.push('NUIT_PROF');
      else if (h >= '20:00' || h < '08:00') out.push('NUIT');
    }
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

  // ─── Application incompatibilités du référentiel ────────────────
  applyIncompatibilities(actes, alerts) {
    let result = [...actes];
    for (const rule of this.ref.incompatibilites) {
      const presentInA = rule.groupe_a.some(c =>
        result.some(a => this.normCode(a.code) === this.normCode(c))
      );
      const presentInB = rule.groupe_b.some(c =>
        result.some(a => this.normCode(a.code) === this.normCode(c))
      );
      if (presentInA && presentInB) {
        const groupeASupp = rule.supprimer === 'groupe_a' ? rule.groupe_a : rule.groupe_b;
        const codesToRemove = groupeASupp.map(c => this.normCode(c));
        const beforeLen = result.length;
        result = result.filter(a => !codesToRemove.includes(this.normCode(a.code)));
        if (beforeLen !== result.length) {
          const icon = rule.severity === 'critical' ? '🚨' : '⚠️';
          const src = rule.source ? ` [${rule.source}]` : '';
          alerts.push(`${icon} ${rule.msg}${src}`);
        }
      }
    }
    return result;
  }

  // ─── Vérifier si 2 actes sont en dérogation taux plein ─────────
  isDerogatoireCumul(codeA, codeB) {
    const a = this.normCode(codeA);
    const b = this.normCode(codeB);
    for (const d of this.ref.derogations_taux_plein) {
      const inA = d.codes_groupe_a.some(c => this.normCode(c) === a);
      const inB = d.codes_groupe_b.some(c => this.normCode(c) === b);
      const inA2 = d.codes_groupe_a.some(c => this.normCode(c) === b);
      const inB2 = d.codes_groupe_b.some(c => this.normCode(c) === a);
      if ((inA && inB) || (inA2 && inB2)) return true;
      if (d.codes_groupe_b[0] === 'mêmes codes' && inA && d.codes_groupe_a.some(c => this.normCode(c) === b)) return true;
    }
    return false;
  }

  // ─── NOUVEAU : un code est-il une consultation dédiée (CIA/CIB) ? ───
  isSeanceDedieeCode(code) {
    return ['CIA', 'CIB'].includes(this.normCode(code));
  }

  // ─── NOUVEAU : un code est-il un forfait/majoration hors 11B ? ───
  isForfaitOuMajorationHors11B(code) {
    const c = this.normCode(code);
    return [
      'IFD','IFI','IK','MCI','MIE','MAU','NUIT','NUIT_PROF','DIM',
      'ISN_NUIT','ISN_NUIT_PROFONDE','ISD',
      'BSA','BSB','BSC',
      'DI','DI2.5','DI1.2',
      'TLS','TLD','TLL','TMI','RQD',
      // Avenant 11
      'MSG','MSD','MIR',
      'CIA','CIB','RKD',
      'IAS_PDSA'
    ].includes(c);
  }

  // ─── NOUVEAU : Règle "séance dédiée" pour CIA / CIB (Avenant 11) ───
  //  Si CIA ou CIB présente, AUCUN autre acte technique/dépendance toléré.
  //  Seuls IFD/IK/MIE/NUIT/DIM (frais de déplacement) autorisés.
  applySeanceDedieeRule(actes, alerts) {
    const hasSeanceDediee = actes.some(a => this.isSeanceDedieeCode(a.code));
    if (!hasSeanceDediee) return actes;

    const ALLOWED_WITH_CONSULT = new Set(['CIA', 'CIB', 'IFD', 'IFI', 'IK', 'MIE']);
    const FORBIDDEN_CODES = actes.filter(a => {
      const c = this.normCode(a.code);
      if (ALLOWED_WITH_CONSULT.has(c)) return false;
      // On supprime TOUT autre acte (technique, BSI, AIS, télésoin…)
      return true;
    });

    if (FORBIDDEN_CODES.length > 0) {
      const removedCodes = FORBIDDEN_CODES.map(a => a.code).join(', ');
      alerts.push(
        `🚨 Consultation CIA/CIB en séance dédiée — retrait des actes non cumulables : ${removedCodes} [Avenant 11]`
      );
      return actes.filter(a => ALLOWED_WITH_CONSULT.has(this.normCode(a.code)));
    }
    return actes;
  }

  // ─── NOUVEAU : Règle MSG (Majoration Soins Gériatriques) ────────
  //  Requiert BSC + score SEGA ≥ 35 (puis 32 en phase 2).
  applyMSGRule(actes, contexte, alerts) {
    const hasMSG = actes.some(a => this.normCode(a.code) === 'MSG');
    if (!hasMSG) return actes;

    const hasBSC = actes.some(a => this.normCode(a.code) === 'BSC');
    const sega = Number(contexte?.sega_score || 0);

    if (!hasBSC) {
      alerts.push('🚨 MSG requiert obligatoirement BSC associé — MSG supprimée [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'MSG');
    }
    if (sega && sega < 35) {
      alerts.push(`🚨 MSG requiert score SEGA ≥ 35 (actuel : ${sega}) — MSG supprimée [Avenant 11]`);
      return actes.filter(a => this.normCode(a.code) !== 'MSG');
    }
    if (!sega) {
      alerts.push('⚠️ MSG : score SEGA non fourni — à justifier (≥ 35 requis) [Avenant 11]');
    }
    return actes;
  }

  // ─── NOUVEAU : Règle MSD (Majoration Scolaire Diabète) ──────────
  //  Requiert contexte scolaire + enfant <16 ans + acte AMI1 associé.
  applyMSDRule(actes, contexte, alerts) {
    const hasMSD = actes.some(a => this.normCode(a.code) === 'MSD');
    if (!hasMSD) return actes;

    const hasAMI1 = actes.some(a => this.normCode(a.code) === 'AMI1');
    const ageOk = !contexte?.age_patient || Number(contexte.age_patient) < 16;
    const scolaire = !!contexte?.contexte_scolaire;

    if (!hasAMI1) {
      alerts.push('🚨 MSD requiert un AMI1 (lecture glycémie ou bolus) associé — MSD supprimée [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'MSD');
    }
    if (!ageOk) {
      alerts.push('🚨 MSD réservé aux enfants <16 ans — MSD supprimée [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'MSD');
    }
    if (!scolaire) {
      alerts.push('⚠️ MSD : contexte scolaire/périscolaire non déclaré — à justifier [Avenant 11]');
    }
    return actes;
  }

  // ─── NOUVEAU : Règle MIR / Astreinte PDSA ───────────────────────
  //  MIR : intervention sur régulation SAMU/SAS, plafond 20/semaine/infirmier.
  applyMIRRule(actes, contexte, historique_semaine, alerts) {
    const hasMIR = actes.some(a => this.normCode(a.code) === 'MIR');
    if (!hasMIR) return actes;

    if (!contexte?.regulation_sas) {
      alerts.push('🚨 MIR : requiert demande explicite de la régulation SAMU/SAS — MIR supprimée [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'MIR');
    }

    // Plafond hebdomadaire
    const countWeek = (historique_semaine || []).reduce((n, h) => {
      return n + (h.actes || []).filter(a => this.normCode(a.code) === 'MIR').length;
    }, 0);
    if (countWeek >= 20) {
      alerts.push(`🚨 MIR : plafond 20/semaine atteint (actuel: ${countWeek}) — MIR supprimée [Avenant 11]`);
      return actes.filter(a => this.normCode(a.code) !== 'MIR');
    }
    if (countWeek >= 16) {
      alerts.push(`⚠️ MIR : ${countWeek}/20 cette semaine — plafond proche [Avenant 11]`);
    }
    return actes;
  }

  // ─── NOUVEAU : Règle Collyres (Avenant 11) ──────────────────────
  //  Instillation collyre : réservé ALD 15 ou 23, justificatif d'auto-administration impossible.
  applyCollyreRule(actes, contexte, alerts) {
    const collyres = actes.filter(a =>
      String(a._code_interne || a.code || '').toUpperCase().includes('COLLYRE')
      || String(a.label || '').toLowerCase().includes('collyre')
    );
    if (collyres.length === 0) return actes;

    const aldCodes = (contexte?.ald_codes || []).map(c => String(c).toUpperCase());
    const hasALD_15_23 = aldCodes.some(c => /ALD\s*15|ALD\s*23/.test(c));

    if (!hasALD_15_23) {
      alerts.push('⚠️ Collyre : vérifier que le patient relève bien d\'une ALD (15 ou 23) et fournir justificatif d\'impossibilité d\'auto-administration [Avenant 11]');
    }

    // Règle : une seule facturation par passage, peu importe le nombre d'administrations
    if (collyres.length > 1) {
      alerts.push('🚨 Collyre : facturable une seule fois par passage — doublons supprimés [Avenant 11]');
      const ids = collyres.slice(1).map(c => c.code);
      return actes.filter((a, i) => {
        if (a.code && ids.includes(a.code) && i !== actes.indexOf(collyres[0])) return false;
        return true;
      });
    }
    return actes;
  }

  // ─── NOUVEAU : Règle AMI3.48 (bilan plaie simple annuel) ────────
  //  1x / patient / 12 mois consécutifs, incompatible BSI et AMI11.
  applyAMI348Rule(actes, historique_annee, alerts) {
    const has348 = actes.some(a => this.normCode(a.code) === 'AMI3.48');
    if (!has348) return actes;

    // Vérifier BSI ou AMI11 dans les actes courants (incompatibilites déjà gérées avant, double sécurité)
    const hasBSI = actes.some(a => ['BSA','BSB','BSC'].includes(this.normCode(a.code)));
    const hasAMI11 = actes.some(a => this.normCode(a.code) === 'AMI11');
    if (hasBSI || hasAMI11) {
      alerts.push('🚨 AMI3.48 (bilan plaie annuel) NON cumulable avec BSI/AMI11 — AMI3.48 supprimé [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'AMI3.48');
    }

    // Vérifier historique 12 mois
    const deja = (historique_annee || []).some(h =>
      (h.actes || []).some(a => this.normCode(a.code) === 'AMI3.48')
    );
    if (deja) {
      alerts.push('🚨 AMI3.48 : déjà facturé dans les 12 derniers mois (max 1x/12 mois) — AMI3.48 supprimé [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'AMI3.48');
    }
    return actes;
  }

  // ─── NOUVEAU : Règle AMI3.77 (surveillance hebdomadaire) ────────
  //  1x / semaine max. Applicable à partir du 01/01/2028.
  applyAMI377Rule(actes, date_soin, historique_semaine, alerts) {
    const has377 = actes.some(a => this.normCode(a.code) === 'AMI3.77');
    if (!has377) return actes;

    // Vérifier date d'entrée en vigueur
    if (date_soin && date_soin < '2028-01-01') {
      alerts.push('⚠️ AMI3.77 : applicable à compter du 01/01/2028 uniquement [Avenant 11]');
    }

    const countWeek = (historique_semaine || []).reduce((n, h) => {
      return n + (h.actes || []).filter(a => this.normCode(a.code) === 'AMI3.77').length;
    }, 0);
    if (countWeek >= 1) {
      alerts.push('🚨 AMI3.77 : surveillance hebdomadaire déjà cotée cette semaine — AMI3.77 supprimé [Avenant 11]');
      return actes.filter(a => this.normCode(a.code) !== 'AMI3.77');
    }
    return actes;
  }

  // ─── NOUVEAU : Règle accès direct pansements (Avenant 11) ───────
  //  À compter du 01/01/2027, pansements plaies NON chirurgicales possibles sans prescription.
  //  Vérifie la cohérence date / flag.
  applyAccesDirectRule(actes, contexte, date_soin, alerts) {
    if (!contexte?.acces_direct) return actes;
    const dateStr = String(date_soin || '').slice(0, 10);
    if (dateStr && dateStr < '2027-01-01') {
      alerts.push('⚠️ Accès direct pansement : non applicable avant le 01/01/2027 — prescription requise [Avenant 11]');
    }
    // Avertissement si l'acte en accès direct n'est pas un pansement non chirurgical
    const pansementAccesDirectOk = new Set(['AMI2.02', 'AMI3.48']);
    const actesSansPrescription = actes.filter(a => {
      const c = this.normCode(a.code);
      return !pansementAccesDirectOk.has(c) && /^AMI/.test(c) && a._tarif_base > 0;
    });
    if (actesSansPrescription.length > 0) {
      alerts.push(`⚠️ Accès direct déclaré mais actes non éligibles présents : ${actesSansPrescription.map(a => a.code).join(', ')} — vérifier prescription [Avenant 11]`);
    }
    return actes;
  }

  // ─── Application de l'article 11B (coefficients) ───────────────
  applyArticle11B(actes, alerts) {
    // Forfaits / majorations / téléconsultations / consultations dédiées → taux plein
    let result = actes.map(a => {
      if (this.isForfaitOuMajorationHors11B(a.code)) {
        return { ...a, coefficient_applique: 1, taux: 'plein_forfait_ou_majoration' };
      }
      return a;
    });

    // Actes techniques (AMI/AMX/AIS) — application 11B
    const techActs = result.filter(a => !this.isForfaitOuMajorationHors11B(a.code));
    if (techActs.length === 0) return result;

    // Tri par tarif décroissant
    techActs.sort((a, b) => (b._tarif_base || 0) - (a._tarif_base || 0));

    // 1er acte = principal à 100%
    techActs[0].coefficient_applique = 1;
    techActs[0].taux = 'plein_principal';

    if (techActs.length >= 2) {
      const a = techActs[1];
      const isCumulTauxPlein = techActs.slice(0, 1).some(b =>
        this.isDerogatoireCumul(a.code, b.code)
      ) || result.some(b =>
        ['BSA','BSB','BSC'].includes(this.normCode(b.code)) &&
        this.isDerogatoireCumul(a.code, b.code)
      );
      if (isCumulTauxPlein) {
        a.coefficient_applique = 1;
        a.taux = 'plein_derogatoire';
      } else {
        a.coefficient_applique = 0.5;
        a.taux = 'demi_tarif_art11B';
      }
    }

    for (let i = 2; i < techActs.length; i++) {
      const a = techActs[i];
      const isCumulTauxPlein = techActs.slice(0, i).some(b =>
        this.isDerogatoireCumul(a.code, b.code)
      ) || result.some(b =>
        ['BSA','BSB','BSC'].includes(this.normCode(b.code)) &&
        this.isDerogatoireCumul(a.code, b.code)
      );
      if (isCumulTauxPlein) {
        a.coefficient_applique = 1;
        a.taux = 'plein_derogatoire';
      } else {
        a.coefficient_applique = 0;
        a.taux = 'gratuit_art11B_3eme';
        alerts.push(`ℹ️ Article 11B : ${a.code} en ${i + 1}e position → non facturable (honoraires nuls)`);
      }
    }
    return result;
  }

  // ─── Validation CIR-9/2025 (forfait journalier perfusion) ──────
  applyCIR92025(actes, historique_jour, alerts) {
    let result = [...actes];
    const codesFortLong = ['AMI14', 'AMX14', 'AMI15', 'AMX15'];

    const has14 = result.some(a => ['AMI14', 'AMX14'].includes(this.normCode(a.code)));
    const has15 = result.some(a => ['AMI15', 'AMX15'].includes(this.normCode(a.code)));
    if (has14 && has15) {
      alerts.push('🚨 CIR-9/2025 : AMI14 + AMI15 même jour interdits — suppression AMI14 (AMI15 prioritaire si cancer)');
      result = result.filter(a => !['AMI14', 'AMX14'].includes(this.normCode(a.code)));
    }

    if (historique_jour && historique_jour.length > 0) {
      const histHasForfaitLong = historique_jour.some(h =>
        (h.actes || []).some(a => codesFortLong.includes(this.normCode(a.code)))
      );
      if (histHasForfaitLong) {
        const currentHasForfaitLong = result.some(a => codesFortLong.includes(this.normCode(a.code)));
        if (currentHasForfaitLong) {
          alerts.push('🚨 CIR-9/2025 : Forfait perfusion longue déjà coté ce jour — la 2e perfusion doit être AMI 4.1 (6.30€)');
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
      historique_semaine = [],
      historique_annee = [],
      mode = 'permissif',
      zone = 'metropole',
      distance_km = 0,
      contexte_bsi = false,
      contexte = {},
    } = input;

    const alerts = [];
    const warnings_strict = [];
    let actes = [];

    // 1. Lookup chaque code → enrichir (avec tarif date-aware)
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
      const tarif = this.getTarif(acte, zone, date_soin);
      actes.push({
        code: acte.code_facturation || acte.code,
        _code_interne: acte.code,
        label: acte.label,
        coefficient: acte.coefficient,
        _tarif_base: tarif,
        chapitre: acte.chapitre,
        article: acte.article,
        ...item,
      });
    }

    // 2. Ajouter majorations temporelles automatiquement
    const majorations = this.detectMajorationsTemporelles(date_soin, heure_soin);
    for (const maj of majorations) {
      if (!actes.some(a => this.normCode(a.code) === maj)) {
        const m = this.lookup(maj);
        if (m) {
          actes.push({ code: maj, label: m.label, _tarif_base: this.getTarif(m, zone, date_soin), _auto_added: true });
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

    // 4. Appliquer CIR-9/2025 (perfusions)
    actes = this.applyCIR92025(actes, historique_jour, alerts);

    // 5. Appliquer incompatibilités du référentiel (JSON déclaratif)
    actes = this.applyIncompatibilities(actes, alerts);

    // 6. NOUVEAU Avenant 11 : règles spécifiques
    actes = this.applySeanceDedieeRule(actes, alerts);            // CIA/CIB
    actes = this.applyMSGRule(actes, contexte, alerts);            // MSG + BSC + SEGA ≥ 35
    actes = this.applyMSDRule(actes, contexte, alerts);            // MSD + AMI1 scolaire + <16 ans
    actes = this.applyMIRRule(actes, contexte, historique_semaine, alerts);  // MIR + régulation + plafond 20/sem
    actes = this.applyCollyreRule(actes, contexte, alerts);        // Collyre ALD 15/23
    actes = this.applyAMI348Rule(actes, historique_annee, alerts); // Bilan plaie simple annuel
    actes = this.applyAMI377Rule(actes, date_soin, historique_semaine, alerts); // Surveillance hebdo
    actes = this.applyAccesDirectRule(actes, contexte, date_soin, alerts);       // Accès direct plaies

    // 7. Appliquer article 11B (coefficients)
    actes = this.applyArticle11B(actes, alerts);

    // 8. Calculer tarifs finaux
    actes = actes.map(a => ({
      ...a,
      _tarif_final: Math.round((a._tarif_base || 0) * (a.coefficient_applique != null ? a.coefficient_applique : 1) * 100) / 100
    }));

    // 9. Total
    const total = this.computeTotal(actes);

    // 10. Audit
    const audit = {
      version_referentiel: this.ref.version,
      version_moteur: 'NGAPEngine_v2_Avenant11',
      mode,
      zone,
      distance_km,
      ami_valeur_applicable: this.getAMIValueForDate(date_soin, zone),
      majorations_auto: majorations,
      nb_alerts: alerts.length,
      regles_appliquees: [
        'CIR-9/2025_perfusions',
        'Incompatibilites_referentiel',
        'Avenant11_seance_dediee_CIA_CIB',
        'Avenant11_MSG_BSC_SEGA',
        'Avenant11_MSD_scolaire',
        'Avenant11_MIR_regulation_plafond20',
        'Avenant11_collyres_ALD15_23',
        'Avenant11_bilan_plaie_annuel_AMI3.48',
        'Avenant11_surveillance_hebdo_AMI3.77',
        'Avenant11_acces_direct_pansements',
        'Article_11B_coefficients',
        'Majorations_temporelles_auto',
        'IK_aller_retour_avec_plafonnement',
        'AMI_valeur_date_aware_calendrier_Avenant11',
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
        chapitre: a.chapitre,
        article: a.article,
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
