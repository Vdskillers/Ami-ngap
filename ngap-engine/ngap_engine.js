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

    // 1.5. DÉDUPLICATION par code de facturation
    // Si l'IA (ou le NLP fallback) a renvoyé deux fois le même code,
    // on garde uniquement la 1ère occurrence — sinon le 2e doublon
    // serait pénalisé à 0.5 par l'article 11B (règle Bastien : un
    // même code NGAP ne peut être facturé qu'une fois par séance).
    {
      const _seen = new Set();
      const _kept = [];
      let _drops = 0;
      for (const a of actes) {
        const _k = this.normCode(a.code);
        if (!_k) { _kept.push(a); continue; }
        if (_seen.has(_k)) { _drops++; continue; }
        _seen.add(_k);
        _kept.push(a);
      }
      if (_drops > 0) {
        alerts.push(`ℹ️ ${_drops} doublon(s) de code NGAP supprimé(s) — un même code ne peut être facturé qu'une fois par séance.`);
      }
      actes = _kept;
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

// ═══════════════════════════════════════════════════════════════════════
// 🧠 NGAP PIPELINE — Reproduction fidèle du workflow N8N (v15 DUAL RAG)
// ═══════════════════════════════════════════════════════════════════════
// Reproduit côté local le pipeline complet du workflow N8N
// "AI_Agent_AMI_v15_NGAP2026_4_DUAL_RAG", à l'identique des 7 étapes :
//
//   1. NLP Médical          (regex + détection contexte clinique)
//   2. AI Agent (Grok)      → REMPLACÉ localement par génération depuis NLP
//   3. Parser résultat IA   (parts AMO/AMC selon exo/amo/amc/regl)
//   4. Validateur NGAP V1   (10 règles de cumul)
//   5. Optimisateur €       (upgrades AMI6→AMI14, AMI→AMX, +MCI, +IFD, +IK, +MIE…)
//   6. Validateur NGAP V2   (re-application V1)
//   7. Recalcul Officiel    (moteur déclaratif NGAPEngine — CIR-9/2025 + 11B)
//
// Sans Grok, l'étape 4 (AI Agent) est remplacée par une projection directe
// du `nlp_detected` en cotation draft. Le moteur déclaratif final corrige
// alors les écarts (tarifs, coefficients, dérogations) — la sortie reste
// alignée sur le résultat N8N pour un texte donné, à la nuance près que
// l'IA Grok peut détecter des patterns que la regex NLP ne voit pas.
//
// API d'entrée :
//   const pipeline = new NGAPPipeline(referentiel);
//   const result = pipeline.cotateFromText({
//     texte:        'Injection insuline SC',
//     date_soin:    '2026-04-28',
//     heure_soin:   '08:00',
//     distance_km:  0,
//     preuve_soin:  { type: 'auto_declaration' },
//     historique:   [],
//     mode_admin:   false,
//     exo:          '0',     amo: '', amc: '', regl: 'CB',
//     infirmiere:   'Manon TEST',
//     // ... + tout autre champ passé tel quel par le pipeline
//   });
//
// API de sortie : strictement identique au format retourné par le webhook
// N8N (ami-calcul) et au worker → directement consommable par cotation.js.
// ═══════════════════════════════════════════════════════════════════════
class NGAPPipeline {
  constructor(referentiel) {
    this.ref    = referentiel;
    this.engine = new NGAPEngine(referentiel);
  }

  // ─── Helper hash (port du _hashStr de N8N pour traçabilité texte/preuve) ─
  _hashStr(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
      hash = hash >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  // ─── Helper normalisation de code (mêmes règles que N8N) ──────────────
  _normCode(c) {
    if (!c) return '';
    let s = String(c).toUpperCase().trim().replace(/,/g, '.').replace(/\s+/g, '');
    if (s === 'AMI4.1') s = 'AMI4_1';
    if (s === 'AMX4.1') s = 'AMX4_1';
    return s;
  }

  // ═════════════════════════════════════════════════════════════════════
  // STAGE 1 — NLP Médical (port direct du noeud N8N "NLP Médical" v8)
  // ═════════════════════════════════════════════════════════════════════
  _stage1_nlp(input) {
    const body  = input.body || input;
    const texte = String(body.texte || '').toLowerCase();
    const texteOriginalHash = this._hashStr(body.texte || '');

    const detected = [];
    const contexte = {};

    // ─── CONTEXTE PATIENT ─────────────────────────────────────────────
    const isCancerCtx   = /cancer|canc[ée]reux|chimio|immunod[eé]prim|mucoviscidose|h[eé]mato|lymphome|my[ée]lome|leuc[eé]mie|m[ée]tastas/.test(texte);
    // ⚡ FIX CPAM-safe : exiger DEUX preuves textuelles pour activer 5bis
    //   1. contexte patient (diabétique / insulino-traité / type 1 / DT1 / DT2 / ALD)
    //   2. acte/geste insuline (injection insuline / glycémie capillaire)
    // Évite que la simple mention "insuline" déclenche le 5bis sans contexte
    // patient documenté → fallback automatique sur 11B (plus prudent CPAM).
    const _hasDiabContext = /diab[eé]tique|insulino[-\s]?trait[ée]|\bdt[12]\b|\btype\s*[12]\b|ald.*diab[eé]t/i.test(texte);
    const _hasInsulinAct  = /insuline|insulino|glyc[eé]mie|dextro\b|hgt\b/i.test(texte);
    const isInsulinoCtx = _hasDiabContext && _hasInsulinAct;
    const isDependant   = /d[eé]pendance|grabataire|alit[eé]|nursing|toilette compl[eè]te|bsi|bsa|bsb|bsc/.test(texte);
    const isPostOp      = /post.?op[eé]|post op|postop|surveillance clinique|chirurgie|redon|drain/.test(texte);
    const isBPCO        = /bpco|insuffisance cardiaque|ic\b|bronchopneumopathie chronique/.test(texte);
    const isPalliatif   = /palliatif|palliative|fin de vie|soins palliatifs/.test(texte);
    const isDomicile    = texte.includes('domicile') || texte.includes('chez ');

    // Lettre-clé par défaut : AMX si dépendance détectée, sinon AMI
    const LC = isDependant ? 'AMX' : 'AMI';

    // ─── INJECTIONS ───────────────────────────────────────────────────
    if (texte.match(/injection|piqûre|piqure|insuline|anticoagulant|h[eé]parine|lovenox|fragmine|calciparine/)) {
      if (texte.match(/intraveineuse|iv directe|ivd/)) {
        detected.push({ code: LC, label: 'Injection intraveineuse directe', coeff: 2 });
      } else if (texte.match(/allerg[eè]ne|d[eé]sensibilis|hyposensibilis/)) {
        detected.push({ code: LC, label: 'Injection allergène', coeff: 3 });
      } else if (texte.match(/implant|zoladex|d[eé]capeptyl|enantone/)) {
        detected.push({ code: LC, label: 'Injection implant sous-cutané', coeff: 2.5 });
      } else {
        detected.push({ code: LC, label: 'Injection SC/IM', coeff: 1 });
      }
    }

    // ─── PRÉLÈVEMENT ──────────────────────────────────────────────────
    if (texte.match(/prise de sang|pr[eé]l[eè]vement.*veineu|ponction veineuse|pds|tube|bilan sanguin/)) {
      detected.push({ code: LC, label: 'Prélèvement veineux', coeff: 1.5 });
    } else if (texte.match(/pr[eé]l[eè]vement.*(cutan|muqueu|urinaire|selles|gorge|nez|expectoration)/)) {
      detected.push({ code: LC, label: 'Prélèvement autre', coeff: 1 });
    }

    // ─── PERFUSION (CIR-9/2025) ───────────────────────────────────────
    const isPerfusion = /perfusion|perfu|baxter|chambre implantable|\bpicc\b|midline|diffuseur|iv lente|ivl|goutte [àa] goutte|\bantibio\b.*(?:iv|intraveineu)/.test(texte);
    if (isPerfusion) {
      const isRetrait   = /(retrait|retir[eé])\s+(d[eé]finiti|du\s+dispositif|de\s+(la\s+)?(picc|midline|chambre|perfusion))|d[eé]branchement\s+d[eé]finiti|fin\s+de\s+(traitement|chimio|perfusion)/.test(texte);
      const is2ePassage = /(changement\s+(?:de\s+)?flacon|rebranche|rebranchement|2\s*[èe]?me?\s+perfusion|deuxi[èe]me\s+perfusion|branchement\s+en\s+y|changement\s+de\s+baxter)/.test(texte);
      const isCourte    = /(perfusion\s+courte|perfusion\s+[≤<=]\s*1\s*h|perfusion\s+(30|45|60)\s*min|perfusion\s+d['eu]?\s*(une?\s+)?demi\s*[-\s]?heure|perfusion\s+inf[eé]rieure?\s+[aà]\s+(une?\s+heure|1\s*h)|≤\s*1\s*h|moins d.une heure)/.test(texte);

      if (isRetrait) {
        detected.push({ code: LC, label: 'Retrait définitif dispositif ≥24h', coeff: 5, forfait: true });
      } else if (is2ePassage) {
        detected.push({ code: LC, label: 'Changement flacon / 2e branchement même jour', coeff: '4.1', forfait: true, tarif_forfait: 6.30 });
      } else if (isCourte) {
        if (isCancerCtx) {
          detected.push({ code: LC, label: 'Perfusion courte ≤1h — immunodéprimé/cancéreux', coeff: 10, forfait: true });
        } else {
          detected.push({ code: LC, label: 'Perfusion courte ≤1h sous surveillance continue', coeff: 9, forfait: true });
        }
      } else {
        if (isCancerCtx) {
          detected.push({ code: LC, label: 'Forfait perfusion longue — immunodéprimé/cancéreux (1x/jour)', coeff: 15, forfait: true });
        } else {
          detected.push({ code: LC, label: 'Forfait perfusion longue >1h (1x/jour)', coeff: 14, forfait: true });
        }
      }
    }

    // ─── PANSEMENT ────────────────────────────────────────────────────
    if (texte.match(/pansement|plaie|escarre|ulc[eè]re|cicatrice|n[eé]crose|d[eé]tersion/)) {
      if (texte.match(/stomie|colostomie|il[eé]ostomie/)) {
        detected.push({ code: LC, label: 'Pansement stomie', coeff: 3 });
      } else if (texte.match(/trach[eé]otomie|canule/)) {
        detected.push({ code: LC, label: 'Pansement trachéotomie', coeff: 3 });
      } else if (texte.match(/complexe|escarre|n[eé]crose|chirurgical|post.?op|d[eé]tersion|greffe|ulc[eè]re|pied diab[eé]tique/)) {
        detected.push({ code: LC, label: 'Pansement lourd et complexe', coeff: 4 });
        if (texte.match(/analg[eé]sie topique|emla|lidoca[ïi]ne topique/)) {
          detected.push({ code: LC, label: 'Analgésie topique préalable', coeff: 1.1 });
        }
      } else {
        detected.push({ code: LC, label: 'Pansement simple', coeff: 1 });
      }
    }

    // ─── SONDES & ALIMENTATION ────────────────────────────────────────
    if (texte.match(/sonde naso.?gastrique|sng|pose.*sonde.*gastrique/)) {
      detected.push({ code: LC, label: 'Pose sonde naso-gastrique', coeff: 3 });
    }
    if (texte.match(/sonde v[eé]sicale|pose.*sonde.*v[eé]sicale|changement sonde urinaire|sonde urinaire/)) {
      if (texte.match(/homme|masculin|urétral|uretral/)) {
        detected.push({ code: LC, label: 'Cathétérisme urétral homme', coeff: 4 });
      } else {
        detected.push({ code: LC, label: 'Sonde vésicale femme', coeff: 3 });
      }
    }
    if (texte.match(/retrait.*sonde|ablation.*sonde|retrait sonde urinaire/)) {
      detected.push({ code: LC, label: 'Retrait sonde urinaire', coeff: 2 });
    }
    if (texte.match(/alimentation ent[eé]rale|gavage|nutri.?pompe|pompe.*nutrition/)) {
      if (texte.match(/j[eé]junal|jejunal|pj/)) {
        detected.push({ code: LC, label: 'Alimentation entérale jéjunale', coeff: 4 });
      } else {
        detected.push({ code: LC, label: 'Alimentation entérale par gavage', coeff: 3 });
      }
    }

    // ─── SURVEILLANCES & POST-OP ──────────────────────────────────────
    if (isPostOp && texte.match(/surveillance clinique|surveillance post.?op|accompagnement post.?op/)) {
      detected.push({ code: LC, label: 'Séance surveillance post-opératoire', coeff: 3.9, forfait: false });
    }
    if (texte.match(/retrait.*drain|retrait.*redon|surveillance drain/)) {
      detected.push({ code: LC, label: 'Retrait drain de redon', coeff: 2.8, forfait: false });
    }
    if (texte.match(/cath[eé]ter p[eé]riveineux|analg[eé]sie post.?op/)) {
      detected.push({ code: LC, label: 'Cathéter périveineux post-op', coeff: 4.2, forfait: false });
    }
    if (isBPCO && texte.match(/surveillance|hebdomadaire/)) {
      detected.push({ code: LC, label: 'Surveillance clinique BPCO/IC (hebdo)', coeff: 5.8, forfait: false });
    }

    // ─── DIABÈTE (article 5bis — cumul taux plein entre eux) ─────────
    if (isInsulinoCtx && texte.match(/glyc[eé]mie|dextro|hgt/)) {
      detected.push({ code: LC, label: 'Surveillance glycémie capillaire', coeff: 1 });
    }

    // ─── TOILETTE / DÉPENDANCE → BSI ──────────────────────────────────
    if (texte.match(/toilette|nursing|aide.*vie quotidienne/)) {
      const depLourde = texte.match(/totale|alit[eé]|grabataire|d[eé]pendance lourde/);
      const depMod    = texte.match(/mod[eé]r[eé]e|interm[eé]diaire|d[eé]pendance mod[eé]r[eé]e/);
      const depLegere = texte.match(/l[eé]g[eè]re|partielle|d[eé]pendance l[eé]g[eè]re/);
      const depClaire = texte.match(/d[eé]pendance/);
      if (depLourde)       detected.push({ code: 'BSC', label: 'Dépendance lourde', coeff: 1 });
      else if (depMod)     detected.push({ code: 'BSB', label: 'Dépendance intermédiaire', coeff: 1 });
      else if (depLegere)  detected.push({ code: 'BSA', label: 'Dépendance légère', coeff: 1 });
      else if (depClaire)  detected.push({ code: 'BSA', label: 'Dépendance (niveau à préciser)', coeff: 1 });
      else                 detected.push({ code: 'AIS', label: 'Aide toilette (dépendance non documentée)', coeff: 1 });
    }

    // ─── ECG ──────────────────────────────────────────────────────────
    if (texte.match(/ecg|électrocardiogramme|electrocardiogramme/)) {
      detected.push({ code: LC, label: 'ECG', coeff: 3 });
    }

    // ─── DISTANCE KM ──────────────────────────────────────────────────
    let distanceKm = 0;
    const kmMatch = texte.match(/(\d+(?:[.,]\d+)?)\s*(?:km|kilom[eè]tres?)/);
    if (kmMatch) distanceKm = parseFloat(kmMatch[1].replace(',', '.'));
    // Si distance fournie en input, prioriser celle-ci
    if (parseFloat(body.distance_km) > 0) distanceKm = parseFloat(body.distance_km);

    // ─── CONTEXTE COMPLET ────────────────────────────────────────────
    contexte.domicile       = isDomicile;
    contexte.nuit           = !!(texte.match(/nuit|20h|21h|22h|23h|00h|01h|02h|03h|04h|05h/));
    contexte.nuitProfonde   = !!(texte.match(/23h|00h|01h|02h|03h|04h/));
    contexte.dimanche       = !!(texte.match(/dimanche|férié|ferie/));
    contexte.enfant         = !!(texte.match(/enfant|bébé|bebe|nourrisson|< ?7 ?ans|moins de 7/));
    contexte.ald            = !!(texte.match(/ald|affection longue durée/));
    contexte.distance       = distanceKm > 0;
    contexte.complexe       = !!(texte.match(/complexe|escarre|nécrose|chirurgical|post.op/));
    contexte.cancer         = isCancerCtx;
    contexte.insulino       = isInsulinoCtx;
    contexte.dependant      = isDependant;
    contexte.postop         = isPostOp;
    contexte.bpco           = isBPCO;
    contexte.palliatif      = isPalliatif;
    contexte.lettre_cle     = LC;

    // ─── JUSTIFICATION HORODATÉE ──────────────────────────────────────
    const justification = {
      dependance:          isDependant,
      dependance_lourde:   !!(texte.match(/grabataire|alité|alit[ée]|dépendance lourde|totale/)),
      plaie:               !!(texte.match(/plaie|escarre|ulcère|ulcere|nécrose|necrose/)),
      plaie_complexe:      !!(texte.match(/escarre|nécrose|chirurgical|post.op|détersion|pied diabétique/)),
      domicile:            isDomicile,
      enfant:              !!(texte.match(/enfant|bébé|< ?7 ?ans/)),
      nuit_horaire:        !!(texte.match(/20h|21h|22h|23h|00h|01h|02h|03h|04h|05h/)),
      ald:                 !!(texte.match(/ald|affection longue durée/)),
      prescription:        !!(texte.match(/ordonnance|prescrit|prescription/)),
      cancer:              isCancerCtx,
      insulino:            isInsulinoCtx,
      postop:              isPostOp,
      bpco:                isBPCO,
      palliatif:           isPalliatif,
      distance_km:         distanceKm,
      timestamp:           new Date().toISOString(),
      source:              'NLP_PIPELINE_LOCAL_NGAP2026',
      texte_original_hash: texteOriginalHash,
    };

    // ─── PREUVE SOIN ──────────────────────────────────────────────────
    const preuveRaw = body.preuve_soin || {};
    const preuveHashInput = preuveRaw.hash_preuve || preuveRaw.signature_data || preuveRaw.photo_hash || '';
    const preuveHash = preuveHashInput
      ? this._hashStr(preuveHashInput + (body.date_soin || '') + (body.infirmiere || ''))
      : '';
    const geoZone = preuveRaw.geo_zone || body.geo_zone || '';
    const preuveSoin = {
      type:              preuveRaw.type || 'auto_declaration',
      timestamp:         preuveRaw.timestamp || new Date().toISOString(),
      hash_preuve:       preuveHash || '',
      certifie_ide:      preuveRaw.certifie_ide === true || preuveRaw.type === 'auto_declaration',
      signature_patient: preuveRaw.type === 'signature_patient' && preuveHash !== '',
      photo_presente:    preuveRaw.type === 'photo' && preuveHash !== '',
      geo_zone:          geoZone,
      force_probante:    preuveRaw.type === 'photo'              ? 'FORTE'
                       : preuveRaw.type === 'signature_patient'  ? 'FORTE'
                       : preuveRaw.type === 'auto_declaration'   ? 'STANDARD'
                       : 'ABSENTE',
    };

    return {
      ...body,
      nlp_detected:  detected,
      nlp_contexte:  contexte,
      justification,
      distance_km:   distanceKm,
      _texte_hash:   texteOriginalHash,
      preuve_soin:   preuveSoin,
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // STAGE 2 — AI Output local (substitut Grok)
  // ═════════════════════════════════════════════════════════════════════
  // Convertit `nlp_detected` en cotation draft `{actes, total, alerts, optimisations}`,
  // au format que produirait l'AI Agent. Les tarifs sont récupérés du référentiel.
  _stage2_aiOutput(data) {
    const detected = data.nlp_detected || [];
    const ctx      = data.nlp_contexte || {};
    const heure    = String(data.heure_soin || '');
    const dateSoin = String(data.date_soin || '');

    // ─── Convertir chaque acte NLP en {code, nom, coefficient, total} ─
    const actes = [];
    for (const d of detected) {
      const baseLC = String(d.code || '').toUpperCase(); // AMI, AMX, AIS, BSA, BSB, BSC
      let codeFinal = baseLC;
      let tarif = 0;

      if (['BSA', 'BSB', 'BSC'].includes(baseLC)) {
        // Forfait BSI — tarif fixe
        const f = this.ref.forfaits_bsi?.[baseLC];
        tarif = f ? f.tarif : (baseLC === 'BSA' ? 13.0 : baseLC === 'BSB' ? 18.2 : 28.7);
      } else if (['AMI', 'AMX', 'AIS'].includes(baseLC)) {
        // Code lettre-clé + coefficient → AMI1, AMI4, AMI4.1, AIS3...
        const coef = d.coeff;
        if (coef === '4.1' || coef === 4.1) {
          codeFinal = baseLC + '4.1';
          tarif = baseLC === 'AIS' ? 0 : (d.tarif_forfait || 12.92);
        } else {
          codeFinal = baseLC + String(coef);
          // Lookup dans le référentiel pour le tarif exact
          const ref = this.engine.lookup(codeFinal);
          if (ref && ref.tarif != null) {
            tarif = ref.tarif;
          } else {
            // Fallback : valeur lettre-clé × coefficient
            const lc = this.ref.lettres_cles?.[baseLC];
            const lcVal = lc ? lc.valeur : (baseLC === 'AIS' ? 2.65 : 3.15);
            tarif = Math.round(lcVal * Number(coef) * 100) / 100;
          }
        }
      }

      actes.push({
        code:        codeFinal,
        nom:         d.label || codeFinal,
        coefficient: 1,
        total:       tarif,
      });
    }

    // ─── Majorations temporelles automatiques ────────────────────────
    const h = heure.slice(0, 5);
    const FERIES_FR = new Set([
      '2025-01-01','2025-04-21','2025-05-01','2025-05-08','2025-05-29',
      '2025-06-09','2025-07-14','2025-08-15','2025-11-01','2025-11-11','2025-12-25',
      '2026-01-01','2026-04-06','2026-05-01','2026-05-08','2026-05-14',
      '2026-05-25','2026-07-14','2026-08-15','2026-11-01','2026-11-11','2026-12-25',
      '2027-01-01','2027-03-29','2027-05-01','2027-05-08','2027-05-06',
      '2027-05-17','2027-07-14','2027-08-15','2027-11-01','2027-11-11','2027-12-25',
    ]);
    if (h) {
      if (h >= '23:00' || h < '05:00') {
        actes.push({ code: 'NUIT_PROF', nom: 'Majoration nuit profonde (23h–5h)', coefficient: 1, total: 18.30 });
      } else if (h >= '20:00' || h < '08:00') {
        actes.push({ code: 'NUIT', nom: 'Majoration nuit (20h–23h / 5h–8h)', coefficient: 1, total: 9.15 });
      }
    }
    if (dateSoin) {
      const dParts = dateSoin.slice(0, 10).split('-');
      const localDate = dParts.length === 3 ? new Date(+dParts[0], +dParts[1] - 1, +dParts[2]) : null;
      const isDimanche = localDate && localDate.getDay() === 0;
      const isFerie    = FERIES_FR.has(dateSoin.slice(0, 10));
      const hasNuit    = actes.some(a => ['NUIT', 'NUIT_PROF'].includes(this._normCode(a.code)));
      if ((isDimanche || isFerie || ctx.dimanche) && !hasNuit) {
        actes.push({ code: 'DIM', nom: 'Majoration dimanche/férié', coefficient: 1, total: 8.50 });
      }
    }

    // ─── Calcul total brut ──────────────────────────────────────────
    const total = Math.round(actes.reduce((s, a) => s + (a.total || 0), 0) * 100) / 100;

    return {
      ...data,
      actes,
      total,
      alerts:        [],
      optimisations: [],
      _ai_source:    'NLP_LOCAL_DRAFT',
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // STAGE 3 — Parser résultat (port Parser_resultat_IA.js)
  // ═════════════════════════════════════════════════════════════════════
  _stage3_parser(data, input) {
    const body = input.body || input;
    const modeAdmin = body.mode_admin === true;
    const exo  = String(body.exo  || '0');
    const regl = String(body.regl || 'CB');
    const rawAMO = body.amo || '';
    const rawAMC = body.amc || '';
    const amoValue = (rawAMO !== '' && isFinite(parseFloat(rawAMO))) ? parseFloat(rawAMO) : null;
    const amcValue = (rawAMC !== '' && isFinite(parseFloat(rawAMC))) ? parseFloat(rawAMC) : null;
    const total    = isFinite(parseFloat(data.total)) ? Math.round(parseFloat(data.total) * 100) / 100 : 0;

    let partAMO, partAMC, partPatient, dreRequise, tauxAMO;
    if (exo === '1' || exo.toLowerCase() === 'ald') {
      tauxAMO = 1.0; partAMO = total; partAMC = 0; partPatient = 0; dreRequise = false;
    } else if (amoValue !== null && amcValue !== null) {
      tauxAMO = amoValue;
      partAMO = Math.round(total * amoValue * 100) / 100;
      partAMC = Math.round(total * amcValue * 100) / 100;
      partPatient = Math.round((total - partAMO - partAMC) * 100) / 100;
      dreRequise = amcValue > 0 && (regl === 'TP' || regl.toLowerCase().includes('tiers'));
    } else if (amoValue !== null) {
      tauxAMO = amoValue;
      partAMO = Math.round(total * amoValue * 100) / 100;
      partAMC = 0;
      partPatient = Math.round((total - partAMO) * 100) / 100;
      dreRequise = false;
    } else {
      tauxAMO = 0.6;
      partAMO = Math.round(total * 0.6 * 100) / 100;
      partAMC = 0;
      partPatient = Math.round(total * 0.4 * 100) / 100;
      dreRequise = false;
    }

    if (!isFinite(partAMO))     partAMO = 0;
    if (!isFinite(partAMC))     partAMC = 0;
    if (!isFinite(partPatient)) partPatient = 0;

    return {
      ok:               true,
      actes:            data.actes || [],
      total,
      part_amo:         partAMO,
      part_amc:         partAMC,
      part_patient:     partPatient,
      amo_amount:       partAMO,
      amc_amount:       partAMC,
      taux_amo:         tauxAMO,
      dre_requise:      dreRequise,
      alerts:           data.alerts || [],
      optimisations:    data.optimisations || [],
      ngap_version:     body.ngap_version || '2026.4',
      mode_admin:       modeAdmin,
      texte:            body.texte || '',
      historique:       body.historique || [],
      patient_id:       body.patient_id || body.infirmiere_id || '',
      nlp_detected:     data.nlp_detected || [],
      nlp_contexte:     data.nlp_contexte || {},
      justification:    data.justification || {},
      preuve_soin:      data.preuve_soin || { type: 'auto_declaration', force_probante: 'ABSENTE' },
      distance_km:      data.distance_km || 0,
      _texte_hash:      data._texte_hash || '',
      invoice_number:   modeAdmin ? null : (body.invoice_number || null),
      date_soin:        body.date_soin  || '',
      heure_soin:       body.heure_soin || '',
      infirmiere:       body.infirmiere || '',
      structure:        body.structure  || '',
      _exo: exo, _amo: rawAMO, _amc: rawAMC, _regl: regl,
      _mode: body.mode || 'ngap',
      _skip_db: modeAdmin,
      _ai_source: data._ai_source,
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // STAGE 4/6 — Validateur NGAP V1 / V2 (port Validateur_NGAP_V1.js)
  // ═════════════════════════════════════════════════════════════════════
  // 10 règles de cumul appliquées de façon identique en V1 et V2.
  _stage4_validateur(data, label = 'V1') {
    let actes  = JSON.parse(JSON.stringify(data.actes || []));
    let alerts = [...(data.alerts || [])];

    const norm = (c) => this._normCode(c);
    const isMaj = (c) => ['IFD','IFI','IK','MCI','MIE','MAU','NUIT','NUIT_PROF','DIM'].includes(norm(c));
    const isBSI = (c) => ['BSA','BSB','BSC'].includes(norm(c));
    const isPerfForfait = (c) => ['AMI9','AMX9','AMI10','AMX10','AMI14','AMX14','AMI15','AMX15','AMI4_1','AMX4_1'].includes(norm(c));

    // R1 : Coefficient — principal(100%) + secondaires(50%) + majorations/forfaits(100%)
    let principalFound = false;
    actes = actes.map(a => {
      const c = norm(a.code);
      if (isMaj(c) || isBSI(c) || isPerfForfait(c)) return { ...a, coefficient: 1 };
      if (!principalFound) { principalFound = true; return { ...a, coefficient: 1 }; }
      return { ...a, coefficient: 0.5 };
    });

    // R2 : AIS + BSI interdit
    if (actes.some(a => norm(a.code).startsWith('AIS')) && actes.some(a => isBSI(a.code))) {
      alerts.push(`❌ [${label}] AIS + BSI interdit → AIS supprimé`);
      actes = actes.filter(a => !norm(a.code).startsWith('AIS'));
    }

    // R3 : BSI exclusifs entre eux
    const bsActs = actes.filter(a => isBSI(a.code));
    if (bsActs.length > 1) {
      const order = { BSA: 1, BSB: 2, BSC: 3 };
      const best = [...bsActs].sort((a, b) => order[norm(b.code)] - order[norm(a.code)])[0];
      alerts.push(`❌ [${label}] Plusieurs BSI → conservation du plus élevé`);
      actes = actes.filter(a => !isBSI(a.code));
      actes.unshift(best);
    }

    // R4 : IFD/IFI unique par passage
    let ifdCount = 0;
    actes = actes.filter(a => {
      const c = norm(a.code);
      if (c === 'IFD' || c === 'IFI') {
        if (ifdCount++) { alerts.push(`❌ [${label}] IFD/IFI multiple → réduit à 1`); return false; }
      }
      return true;
    });

    // R5 : NUIT/NUIT_PROF + DIM non cumulables
    if (actes.some(a => ['NUIT','NUIT_PROF'].includes(norm(a.code))) && actes.some(a => norm(a.code) === 'DIM')) {
      alerts.push(`❌ [${label}] Nuit + dimanche interdit → dimanche supprimé`);
      actes = actes.filter(a => norm(a.code) !== 'DIM');
    }

    // R6 : NUIT + NUIT_PROF non cumulables (garder NUIT_PROF)
    if (actes.some(a => norm(a.code) === 'NUIT') && actes.some(a => norm(a.code) === 'NUIT_PROF')) {
      alerts.push(`❌ [${label}] NUIT + NUIT_PROF → NUIT supprimé`);
      actes = actes.filter(a => norm(a.code) !== 'NUIT');
    }

    // R7 : IK sans distance
    const distKm = parseFloat(data.distance_km) || 0;
    if (actes.some(a => norm(a.code) === 'IK') && distKm <= 0) {
      alerts.push(`⚠️ [${label}] IK sans distance documentée → supprimée`);
      actes = actes.filter(a => norm(a.code) !== 'IK');
    }

    // R8 : CIR-9/2025 — AMI14 + AMI15 interdits même jour
    const hasAMI14 = actes.some(a => ['AMI14','AMX14'].includes(norm(a.code)));
    const hasAMI15 = actes.some(a => ['AMI15','AMX15'].includes(norm(a.code)));
    if (hasAMI14 && hasAMI15) {
      alerts.push(`🚨 [${label}] CIR-9/2025 : AMI14 + AMI15 même jour interdit → AMI14 supprimé (AMI15 prioritaire cancer/immunodépr)`);
      actes = actes.filter(a => !['AMI14','AMX14'].includes(norm(a.code)));
    }

    // R9 : MCI non cumulable avec BSI/AMX/IFI
    const hasBSI = actes.some(a => isBSI(a.code));
    const hasAMX = actes.some(a => norm(a.code).startsWith('AMX'));
    const hasIFI = actes.some(a => norm(a.code) === 'IFI');
    if ((hasBSI || hasAMX || hasIFI) && actes.some(a => norm(a.code) === 'MCI')) {
      alerts.push(`❌ [${label}] MCI non cumulable avec BSI/AMX/IFI → MCI supprimée`);
      actes = actes.filter(a => norm(a.code) !== 'MCI');
    }

    // R10 : MAU non cumulable avec BSI
    if (hasBSI && actes.some(a => norm(a.code) === 'MAU')) {
      alerts.push(`❌ [${label}] MAU non cumulable avec BSI → MAU supprimée`);
      actes = actes.filter(a => norm(a.code) !== 'MAU');
    }

    return { ...data, actes, alerts };
  }

  // ═════════════════════════════════════════════════════════════════════
  // STAGE 5 — Optimisateur € (port Optimisateur_EUR.js v4)
  // ═════════════════════════════════════════════════════════════════════
  _stage5_optimisateur(data) {
    let actes = JSON.parse(JSON.stringify(data.actes || []));
    let optimisations = [...(data.optimisations || [])];
    const texte = String(data.texte || '').toLowerCase();
    const ctx   = data.nlp_contexte || {};
    const just  = data.justification || {};

    const norm = (c) => this._normCode(c);
    const hasCode = (c) => actes.some(a => norm(a.code) === c.toUpperCase());

    // Contextes enrichis
    const isPerfusion  = /perfusion|perfu|baxter|chambre implantable|\bpicc\b|midline|diffuseur/.test(texte);
    const isPerfLongue = isPerfusion && /(12\s*h|24\s*h|longue|>\s*1\s*h|plus d'une heure|matin\s+et\s+soir|2\s*fois par jour|chambre implantable|baxter|picc|midline)/.test(texte);
    const isPerfCourte = isPerfusion && /(30\s*min|45\s*min|60\s*min|≤\s*1\s*h|<\s*1\s*h|surveillance continue|courte)/.test(texte);
    const isCancerCtx  = ctx.cancer || /cancer|canc[ée]reux|chimio|immunod[eé]prim|mucoviscidose/.test(texte);
    const is2ePassage  = /(changement\s+(?:de\s+)?flacon|rebranche|rebranchement|2\s*[èe]?me?\s+perfusion|deuxi[èe]me\s+perfusion|branchement\s+en\s+y)/.test(texte);
    const isBSI        = hasCode('BSA') || hasCode('BSB') || hasCode('BSC');
    const isPostOp     = ctx.postop || /post.?op|surveillance clinique|redon|drain/.test(texte);

    // ── SECTION 1 — Perfusions (CIR-9/2025) ──────────────────────────
    // AMI6 → AMI14/AMI15 (sous-cotation perfusion longue)
    if (hasCode('AMI6') && !hasCode('AMI14') && !hasCode('AMI15') && isPerfLongue) {
      const target = isCancerCtx ? 'AMI15' : 'AMI14';
      const targetTarif = isCancerCtx ? 47.25 : 44.10;
      optimisations.push(`🚀 AMI6 (18,90€) → ${target} (${targetTarif}€) CIR-9/2025 : perfusion longue = forfait journalier. Gain +${(targetTarif - 18.90).toFixed(2)}€`);
      actes = actes.filter(a => norm(a.code) !== 'AMI6');
      actes.unshift({ code: target, nom: isCancerCtx ? 'Forfait perfusion longue cancer/immunodépr' : 'Forfait perfusion longue >1h', coefficient: 1, total: targetTarif });
    }
    // AMI5 → AMI14/AMI15 (si pas retrait réel)
    if (hasCode('AMI5') && !hasCode('AMI14') && !hasCode('AMI15') && isPerfLongue && !/retrait|d[eé]branch/.test(texte)) {
      const target = isCancerCtx ? 'AMI15' : 'AMI14';
      const targetTarif = isCancerCtx ? 47.25 : 44.10;
      optimisations.push(`🚀 AMI5 (15,75€) → ${target} (${targetTarif}€) CIR-9/2025 : AMI5 réservé au retrait définitif. Gain +${(targetTarif - 15.75).toFixed(2)}€`);
      actes = actes.filter(a => norm(a.code) !== 'AMI5');
      actes.unshift({ code: target, nom: isCancerCtx ? 'Forfait perfusion longue cancer/immunodépr' : 'Forfait perfusion longue >1h', coefficient: 1, total: targetTarif });
    }
    // AMI4 → AMI9/AMI10 (sous-cotation perfusion courte)
    if (hasCode('AMI4') && !hasCode('AMI9') && !hasCode('AMI10') && !hasCode('AMI14') && !hasCode('AMI15') && isPerfCourte) {
      const target = isCancerCtx ? 'AMI10' : 'AMI9';
      const targetTarif = isCancerCtx ? 31.50 : 28.35;
      optimisations.push(`🚀 AMI4 (12,60€) → ${target} (${targetTarif}€) : perfusion courte sous surveillance. Gain +${(targetTarif - 12.60).toFixed(2)}€`);
      actes = actes.filter(a => norm(a.code) !== 'AMI4');
      actes.unshift({ code: target, nom: 'Perfusion courte sous surveillance continue', coefficient: 1, total: targetTarif });
    }
    // AMI14 → AMI15 si cancer
    if (hasCode('AMI14') && !hasCode('AMI15') && isCancerCtx) {
      optimisations.push('🚀 AMI14 → AMI15 (+3,15€) — patient cancéreux/immunodéprimé/mucoviscidose détecté');
      actes = actes.map(a => norm(a.code) === 'AMI14'
        ? { ...a, code: 'AMI15', total: 47.25, nom: 'Forfait perfusion longue cancer/immunodépr (1x/jour)' }
        : a);
    }
    // 2ème passage = AMI4.1 (alerte si AMI14/15 déjà coté)
    if (is2ePassage && !hasCode('AMI4_1') && (hasCode('AMI14') || hasCode('AMI15'))) {
      optimisations.push('⚠️ CIR-9/2025 — 2e perfusion du jour : retirer AMI14/15 et coter AMI4.1 (6,30€)');
    }

    // ── SECTION 2 — Dépendance / BSI / AMX ───────────────────────────
    // AIS → BSI si dépendance documentée
    if (actes.some(a => norm(a.code).startsWith('AIS')) && !isBSI && (just.dependance || /d[eé]pendance|grabataire|alit[ée]/.test(texte))) {
      const targetCode = just.dependance_lourde
        ? 'BSC'
        : (/mod[eé]r[eé]e|interm[eé]diaire/.test(texte) ? 'BSB' : 'BSA');
      const targetTarif = { BSA: 13.00, BSB: 18.20, BSC: 28.70 }[targetCode];
      const gain = targetTarif - 2.65;
      optimisations.push(`🚀 AIS → ${targetCode} (${targetTarif}€) — dépendance documentée. Gain +${gain.toFixed(2)}€`);
      actes = actes.filter(a => !norm(a.code).startsWith('AIS'));
      actes.unshift({ code: targetCode, nom: `Bilan soins infirmiers — ${targetCode}`, coefficient: 1, total: targetTarif });
    }
    // AMI → AMX en contexte BSI
    if (isBSI) {
      let changed = 0;
      actes = actes.map(a => {
        const c = norm(a.code);
        if (c.startsWith('AMI') && !c.startsWith('AMX')) {
          changed++;
          return { ...a, code: c.replace(/^AMI/, 'AMX') };
        }
        return a;
      });
      if (changed > 0) optimisations.push(`ℹ️ ${changed} AMI convertis en AMX (contexte BSI — article 11B)`);
    }

    // ── SECTION 3 — Pansements ───────────────────────────────────────
    const isComplexPansement = actes.some(a => /pansement complexe|escarre|plaie|ulc[eè]re|n[eé]crose|chirurgical|post.op|pied diab[eé]tique/.test((a.nom || '').toLowerCase()))
      || /pansement complexe|escarre|ulc[eè]re|n[eé]crose|plaie chirurgicale|post.op|pied diab[eé]tique/.test(texte);
    if (isComplexPansement && !hasCode('MCI') && !isBSI) {
      optimisations.push('🚀 MCI +5,00€ — soin complexe (pansement/palliatif)');
      actes.push({ code: 'MCI', nom: 'Majoration coordination infirmière', coefficient: 1, total: 5.00 });
    }
    if (hasCode('AMI1') && isComplexPansement && !hasCode('AMI4')) {
      optimisations.push('🚀 AMI1 → AMI4 (+9,45€) — critères de pansement complexe détectés');
    }

    // ── SECTION 4 — IFD / IFI / IK / MIE ─────────────────────────────
    if (!hasCode('IFD') && !hasCode('IFI') && (texte.includes('domicile') || ctx.domicile || just.domicile)) {
      const code = isBSI ? 'IFI' : 'IFD';
      optimisations.push(`🚀 ${code} +2,75€ — soin à domicile`);
      actes.push({ code, nom: isBSI ? 'Indemnité forfaitaire infirmière (BSI)' : 'Indemnité forfaitaire déplacement', coefficient: 1, total: 2.75 });
    }
    const distKm = parseFloat(data.distance_km) || 0;
    if (!hasCode('IK') && distKm > 0) {
      const ikTotal = Math.round(distKm * 2 * 0.35 * 100) / 100;
      optimisations.push(`🚀 IK +${ikTotal}€ (${distKm} km aller-retour)`);
      actes.push({ code: 'IK', nom: 'Indemnité kilométrique', coefficient: 1, base: ikTotal, total: ikTotal });
    }
    if (!hasCode('MIE') && (ctx.enfant || just.enfant || /enfant|b[eé]b[eé]|nourrisson|< ?7 ?ans|moins de 7/.test(texte))) {
      optimisations.push('🚀 MIE +3,15€ — enfant < 7 ans');
      actes.push({ code: 'MIE', nom: 'Majoration enfant < 7 ans', coefficient: 1, total: 3.15 });
    }

    // ── SECTION 5 — Post-op / surveillance (Avenant 6) ───────────────
    if (isPostOp && !actes.some(a => /^AMI3\.9$|^AMX3\.9$/.test(norm(a.code)))) {
      if (/surveillance clinique|accompagnement post.?op/.test(texte)) {
        optimisations.push('💡 Surveillance post-op détectée — AMI 3.9 (12,29€) applicable');
      }
    }

    return { ...data, actes, optimisations };
  }

  // ═════════════════════════════════════════════════════════════════════
  // STAGE 7 — Recalcul Officiel (port Recalcul_NGAP_Officiel.js)
  // ═════════════════════════════════════════════════════════════════════
  // Délègue au moteur déclaratif `this.engine.compute()` puis fusionne le
  // résultat avec les données du pipeline (parts AMO/AMC, audit, etc.)
  _stage7_recalcul(data) {
    const codesInput = (data.actes || []).map(a => ({ code: a.code || 'AMI1' }));
    const result = this.engine.compute({
      codes:           codesInput,
      date_soin:       data.date_soin || '',
      heure_soin:      data.heure_soin || '',
      historique_jour: data.historique || [],
      mode:            'permissif',
      zone:            data.zone || 'metropole',
      distance_km:     parseFloat(data.distance_km) || 0,
    });

    // Recomposer parts AMO/AMC sur la base du nouveau total
    const taux = parseFloat(data.taux_amo) || 0.6;
    const total = result.total;
    const partAMO = Math.round(total * taux * 100) / 100;
    const oldTotal = parseFloat(data.total) || 1;
    const amcRatio = parseFloat(data.amc_amount) / oldTotal;
    const partAMC = isFinite(amcRatio) && amcRatio > 0 ? Math.round(total * amcRatio * 100) / 100 : 0;
    const partPatient = Math.round((total - partAMO - partAMC) * 100) / 100;

    const audit = {
      version:                'NGAP_2026.4',
      validated:              true,
      engine:                 'NGAP_PIPELINE_LOCAL_V1',
      ruleset_version:        result.audit?.version_referentiel,
      rules_applied:          result.audit?.regles_appliquees || [],
      ik_blocked:             false,
      distance_km_used:       parseFloat(data.distance_km) || 0,
      distance_km_source:     (parseFloat(data.distance_km) || 0) > 0 ? 'NLP_EXTRAIT' : 'NON_DISPONIBLE',
      actes_count:            (result.actes_finaux || []).length,
      circulaire_cir9_2025:   { applied: true, rule: 'AMI14/15 1x/jour max, 2e perfusion = AMI4.1' },
      ai_source:              data._ai_source || 'unknown',
      timestamp:              new Date().toISOString(),
    };

    return {
      ...data,
      actes: (result.actes_finaux || []).map(a => ({
        code:        a.code,
        nom:         a.label,
        coefficient: a.coefficient,
        total:       a.tarif_final,
      })),
      total,
      part_amo:     partAMO,
      part_amc:     partAMC,
      part_patient: partPatient,
      amo_amount:   partAMO,
      amc_amount:   partAMC,
      alerts:       [...(data.alerts || []), ...(result.alerts || [])],
      warnings_strict: result.warnings_strict || [],
      audit,
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // 🎯 ENTRY POINT — exécute les 7 étapes dans l'ordre du workflow N8N
  // ═════════════════════════════════════════════════════════════════════
  cotateFromText(input) {
    const stage1 = this._stage1_nlp(input);                  // NLP Médical
    const stage2 = this._stage2_aiOutput(stage1);            // AI Output local (substitut Grok)
    const stage3 = this._stage3_parser(stage2, input);       // Parser résultat IA
    const stage4 = this._stage4_validateur(stage3, 'V1');    // Validateur V1
    const stage5 = this._stage5_optimisateur(stage4);        // Optimisateur €
    const stage6 = this._stage4_validateur(stage5, 'V2');    // Validateur V2 (mêmes règles)
    const stage7 = this._stage7_recalcul(stage6);            // Recalcul Officiel (moteur déclaratif)
    return stage7;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 🛡️  CPAM STRICT MODE — Validator + AutoCorrector + Optimizer (offline)
// ═══════════════════════════════════════════════════════════════════════
// Pipeline embarqué côté frontend pour la cotation OFFLINE.
// Identique fonctionnellement à celui de worker.js (server-side).
// Branché APRÈS engine.compute() dans cotation.js → _cotationOfflinePipeline.
// ═══════════════════════════════════════════════════════════════════════

function _isDomicileStrict(texte) {
  if (!texte || typeof texte !== 'string') return false;
  return /(?:à|au)\s+domicile|domicile\s+du?\s+patient|chez\s+(?:le|la|son|sa|monsieur|madame|m\.|mme|mr|le\s+patient)|au\s+lit\s+du\s+patient|ehpad|résidence(?:\s+autonomie)?|maison\s+de\s+retraite|au\s+foyer|foyer\s+logement/i.test(texte);
}

function _hasPreuveSoinOpposable(preuve_soin) {
  if (!preuve_soin || typeof preuve_soin !== 'object') return false;
  return (
    preuve_soin.signature_patient === true ||
    preuve_soin.signature_b64 ||
    preuve_soin.photo_presente === true ||
    preuve_soin.photo_b64 ||
    preuve_soin.geo_zone ||
    preuve_soin.qr_validation ||
    preuve_soin.nfc_tag ||
    preuve_soin.empreinte_horodatee
  );
}

function validateCPAM({ actes = [], contexte = {}, preuve_soin = null, total = 0, _refIncompat = [] } = {}) {
  const alerts = [];
  const errors = [];
  let riskScore = 0;
  const _norm = (c) => String(c || '').toUpperCase().replace(/[\s_]/g, '');
  const codes = actes.map(a => String(a.code || '').toUpperCase());

  const isMajoration = (c) => /^(IFD|IFI|IK|MCI|MIE|MAU|NUIT|NUIT_PROF|DIM|ISN_NUIT|ISN_NUIT_PROFONDE|ISD|MSG|MSD|MIR|RKD|IAS_PDSA)$/.test(c);
  const isBSI = (c) => /^(BSA|BSB|BSC)$/.test(c);
  const isDI  = (c) => /^(DI2\.5|DI1\.2|DI)$/.test(c);
  const isTele= (c) => /^(TLS|TLD|TLL|TMI|RQD)$/.test(c);
  const techActs = (actes || []).filter(a => {
    const c = String(a.code || '').toUpperCase();
    return !isMajoration(c) && !isBSI(c) && !isDI(c) && !isTele(c) && !a._hors_ngap;
  });
  const fullActs = techActs.filter(a => {
    const coef = (typeof a.coefficient_applique === 'number') ? a.coefficient_applique
               : (typeof a.coefficient === 'number') ? a.coefficient : 1;
    const taux = String(a.taux || '').toLowerCase();
    return coef >= 0.99 && !taux.includes('demi') && !taux.includes('art11b');
  });
  if (techActs.length > 1 && fullActs.length > 1) {
    const allDerog = fullActs.every(a => /derogatoire|plein_perfusion|plein_5bis|plein_postop|plein_bsi|plein_pansement/i.test(String(a.taux || '')));
    if (!allDerog) {
      alerts.push('Article 11B : plusieurs actes à taux plein sans dérogation explicite');
      riskScore += 3;
    }
  }

  const hasIFD = codes.some(c => /^IF[DI]$/.test(c));
  if (hasIFD) {
    const texte = String(contexte.texte || contexte.texte_original || '');
    const ctxDomicile = (contexte.domicile === true) || _isDomicileStrict(texte);
    const preuveOk = _hasPreuveSoinOpposable(preuve_soin);
    if (!ctxDomicile) {
      errors.push('IFD/IFI sans preuve textuelle domicile (mention "à domicile", "EHPAD", "résidence" requise)');
      riskScore += 5;
    } else if (!preuveOk) {
      alerts.push('IFD/IFI : domicile mentionné mais aucune preuve opposable (signature, photo ou geo)');
      riskScore += 2;
    }
  }

  const hasBSI = codes.some(c => /^BS[ABC]$/.test(c));
  const hasAIS = codes.some(c => /^AIS/.test(c));
  const bsiCount = codes.filter(c => /^BS[ABC]$/.test(c)).length;
  if (hasBSI && hasAIS) { errors.push('Cumul interdit : AIS + BSI'); riskScore += 5; }
  if (bsiCount > 1) { errors.push(`Cumul interdit : ${bsiCount} forfaits BSI`); riskScore += 5; }
  for (const incompat of _refIncompat) {
    if (incompat.severity !== 'critical') continue;
    const inA = codes.some(c => (incompat.groupe_a || []).map(_norm).includes(_norm(c)));
    const inB = codes.some(c => (incompat.groupe_b || []).map(_norm).includes(_norm(c)));
    if (inA && inB) {
      errors.push(`Incompatibilité NGAP : ${incompat.msg || (incompat.groupe_a.join('+') + ' avec ' + incompat.groupe_b.join('+'))}`);
      riskScore += 4;
    }
  }

  const has5bisPlein = (actes || []).some(a => /5bis|plein_derogatoire/i.test(String(a.taux || '')));
  if (has5bisPlein) {
    const texte = String(contexte.texte || contexte.texte_original || '').toLowerCase();
    const hasDiabCtx = /diab[eé]tique|insulino[-\s]?trait[eé]|\bdt[12]\b|\btype\s*[12]\b|ald.*diab/i.test(texte);
    const hasInsAct = /insuline|insulino|glyc[eé]mie|dextro|hgt/i.test(texte);
    if (!(hasDiabCtx && hasInsAct)) {
      alerts.push('Article 5bis sans double preuve (diabète + insuline)');
      riskScore += 2;
    }
  }

  const distKm = parseFloat(contexte.distance_km || 0) || 0;
  const hasIK = codes.some(c => c === 'IK');
  if (hasIK && distKm > 30) {
    const geoOk = preuve_soin && (preuve_soin.geo_zone || preuve_soin.geo_lat || preuve_soin.geo_distance_calculee);
    if (!geoOk) { alerts.push(`IK ${distKm} km sans preuve géographique`); riskScore += 2; }
  }
  if (hasIK && distKm > 100 && !preuve_soin?.geo_zone) {
    errors.push(`IK ${distKm} km absurde sans preuve geo → bloqué (suspicion fraude)`);
    riskScore += 5;
  }

  let status = 'OK';
  if (errors.length > 0) status = 'BLOCKED';
  else if (alerts.length > 0) status = 'WARNING';
  return { status, riskScore, alerts, errors, isSafe: status === 'OK' };
}

function autoCorrectCPAM({ actes = [], contexte = {}, preuve_soin = null, _refIncompat = [] } = {}) {
  let correctedActes = actes.map(a => ({ ...a }));
  const corrections = [];

  const hasIF = correctedActes.some(a => /^IF[DI]$/.test(String(a.code).toUpperCase()));
  if (hasIF) {
    const texte = String(contexte.texte || contexte.texte_original || '');
    const ctxDomicile = (contexte.domicile === true) || _isDomicileStrict(texte);
    if (!ctxDomicile) {
      const before = correctedActes.length;
      correctedActes = correctedActes.filter(a => !/^IF[DI]$/.test(String(a.code).toUpperCase()));
      if (correctedActes.length < before) corrections.push('IFD/IFI supprimé (absence preuve domicile)');
    }
  }

  const codes = correctedActes.map(a => String(a.code).toUpperCase());
  const hasBSI = codes.some(c => /^BS[ABC]$/.test(c));
  const hasAIS = codes.some(c => /^AIS/.test(c));
  if (hasBSI && hasAIS) {
    const before = correctedActes.length;
    correctedActes = correctedActes.filter(a => !/^AIS/.test(String(a.code).toUpperCase()));
    corrections.push(`${before - correctedActes.length} acte(s) AIS supprimé(s) (incompatible BSI)`);
  }

  const bsiActs = correctedActes.filter(a => /^BS[ABC]$/.test(String(a.code).toUpperCase()));
  if (bsiActs.length > 1) {
    const tariffs = { 'BSA': 13.0, 'BSB': 18.2, 'BSC': 28.7 };
    const highest = bsiActs.reduce((a, b) => (tariffs[String(a.code).toUpperCase()] || 0) > (tariffs[String(b.code).toUpperCase()] || 0) ? a : b);
    const highestCode = String(highest.code).toUpperCase();
    correctedActes = correctedActes.filter(a => {
      const c = String(a.code).toUpperCase();
      return !/^BS[ABC]$/.test(c) || c === highestCode;
    });
    corrections.push(`BSI multiples corrigés (${bsiActs.length} → 1, ${highestCode} conservé)`);
  }

  const _norm = (c) => String(c || '').toUpperCase().replace(/[\s_]/g, '');
  for (const incompat of _refIncompat) {
    if (incompat.severity !== 'critical') continue;
    const codesNow = correctedActes.map(a => _norm(a.code));
    const inA = codesNow.some(c => (incompat.groupe_a || []).map(_norm).includes(c));
    const inB = codesNow.some(c => (incompat.groupe_b || []).map(_norm).includes(c));
    if (inA && inB) {
      const toRemove = (incompat.supprimer === 'groupe_a') ? (incompat.groupe_a || []) : (incompat.groupe_b || []);
      const toRemoveNorm = toRemove.map(_norm);
      const before = correctedActes.length;
      correctedActes = correctedActes.filter(a => !toRemoveNorm.includes(_norm(a.code)));
      if (correctedActes.length < before) corrections.push(incompat.msg || `Incompatibilité corrigée`);
    }
  }

  const distKm = parseFloat(contexte.distance_km || 0) || 0;
  const geoOk = preuve_soin && (preuve_soin.geo_zone || preuve_soin.geo_distance_calculee);
  if (distKm > 100 && !geoOk) {
    const before = correctedActes.length;
    correctedActes = correctedActes.filter(a => String(a.code).toUpperCase() !== 'IK');
    if (correctedActes.length < before) corrections.push(`IK supprimé (${distKm} km sans preuve geo)`);
  }

  return { actes: correctedActes, corrections, hasCorrection: corrections.length > 0 };
}

function applyCPAMPipeline(rawResult, body, engine) {
  const opts = {
    strict: body?.mode_cpam_strict === true,
    autocorrect: body?.mode_cpam_autocorrect !== false,
    optimize: body?.mode_cpam_optimize === true,
  };
  const contexte = {
    texte: body?.texte || body?.texte_original || '',
    texte_original: body?.texte_original || '',
    domicile: body?.domicile === true || body?.contexte?.domicile === true,
    distance_km: parseFloat(body?.distance_km || body?.km || 0) || 0,
    ...(body?.contexte || {}),
  };
  const preuve_soin = body?.preuve_soin || body?.preuveSoin || null;
  const _refIncompat = engine?.ref?.incompatibilites || [];

  const validation = validateCPAM({
    actes: rawResult.actes_finaux || [],
    contexte, preuve_soin, total: rawResult.total, _refIncompat,
  });

  let corrections = [];
  let finalResult = rawResult;
  let _ikRemoved = false;
  if (opts.autocorrect && validation.status !== 'OK') {
    const ac = autoCorrectCPAM({
      actes: rawResult.actes_finaux || [],
      contexte, preuve_soin, _refIncompat,
    });
    if (ac.hasCorrection) {
      corrections = ac.corrections;
      _ikRemoved = ac.corrections.some(c => /IK supprimé/i.test(c));
      const correctedInput = {
        codes: ac.actes.map(a => ({ code: a.code })),
        date_soin: body?.date_soin || '',
        heure_soin: body?.heure_soin || '',
        historique_jour: body?.historique_jour || [],
        mode: body?.mode_strict ? 'strict' : 'permissif',
        zone: body?.zone || (body?.outre_mer ? 'outre_mer' : 'metropole'),
        distance_km: _ikRemoved ? 0 : contexte.distance_km,
        contexte_bsi: body?.contexte_bsi === true,
      };
      try { finalResult = engine.compute(correctedInput); } catch (e) {}
    }
  }

  const finalValidation = (corrections.length > 0) ? validateCPAM({
    actes: finalResult.actes_finaux || [],
    contexte, preuve_soin, total: finalResult.total, _refIncompat,
  }) : validation;

  return {
    result: finalResult,
    cpam: {
      status: finalValidation.status,
      riskScore: finalValidation.riskScore,
      alerts: finalValidation.alerts,
      errors: finalValidation.errors,
      corrections,
      original_status: validation.status,
      original_total: rawResult.total,
    },
    blocked: opts.strict && finalValidation.status === 'BLOCKED',
  };
}

// Export pour Node.js (worker, n8n)
if (typeof module !== 'undefined' && module.exports) {
  module.exports        = NGAPEngine;
  module.exports.NGAPEngine   = NGAPEngine;
  module.exports.NGAPPipeline = NGAPPipeline;
  module.exports.validateCPAM = validateCPAM;
  module.exports.autoCorrectCPAM = autoCorrectCPAM;
  module.exports.applyCPAMPipeline = applyCPAMPipeline;
  module.exports._isDomicileStrict = _isDomicileStrict;
  module.exports._hasPreuveSoinOpposable = _hasPreuveSoinOpposable;
}
// Export navigateur (charge via <script src=…> puis window.NGAPEngine)
if (typeof window !== 'undefined') {
  window.NGAPEngine   = NGAPEngine;
  window.NGAPPipeline = NGAPPipeline;
  window.validateCPAM = validateCPAM;
  window.autoCorrectCPAM = autoCorrectCPAM;
  window.applyCPAMPipeline = applyCPAMPipeline;
  window._isDomicileStrictCPAM = _isDomicileStrict;
}
