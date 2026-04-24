"""
NGAP REFERENTIEL EXHAUSTIF — Titre XVI 2025/2026
=================================================
Source : NGAP officielle (ameli.fr + arrêtés UNCAM)
Version : 2026.3 (intègre CIR-9/2025 du 25/06/2025)

Structure :
  - chapter / article : ancrage NGAP officiel
  - codes : forme normalisée (AMI4_1 au lieu de AMI 4,1)
  - coefficient : float ou null si forfait fixe
  - tarif_metropole / tarif_outre_mer
  - lettre_cle : AMI / AMX / AMI/AMX (acte cumulable BSI)
  - cumul : règles spécifiques (article 11B, dérogations, exclusions)
  - prescription_required : true / false / "AP" (accord préalable)
  - description : libellé officiel exact
  - notes : restrictions, max/an, conditions cliniques
"""

import json

# ─── DISPOSITIONS GÉNÉRALES + LETTRES-CLÉS ───────────────────────────
LETTRES_CLES = {
    "AMI":  {"valeur": 3.15, "valeur_om": 3.30, "label": "Acte Médico-Infirmier (hors dépendance)"},
    "AMX":  {"valeur": 3.15, "valeur_om": 3.30, "label": "Acte Médico-Infirmier en contexte dépendance (BSI/AIS)"},
    "AIS":  {"valeur": 2.65, "valeur_om": 2.70, "label": "Acte Infirmier de Soins"},
    "DI":   {"valeur": 10.00, "valeur_om": 10.00, "label": "Démarche de Soins Infirmiers"},
    "TMI":  {"valeur": 3.15, "valeur_om": 3.30, "label": "Acte télésoin réalisé à distance"},
}

# ─── FORFAITS (montants fixes, pas de coefficient × lettre-clé) ─────
FORFAITS_BSI = {
    "BSA": {"tarif": 13.00, "tarif_om": 13.25, "label": "Forfait Bilan Soins Infirmiers — dépendance légère", "coefficient": None},
    "BSB": {"tarif": 18.20, "tarif_om": 18.55, "label": "Forfait Bilan Soins Infirmiers — dépendance intermédiaire", "coefficient": None},
    "BSC": {"tarif": 28.70, "tarif_om": 29.25, "label": "Forfait Bilan Soins Infirmiers — dépendance lourde", "coefficient": None},
}

# ─── BSI — coefficients DI ──────────────────────────────────────────
FORFAITS_DI = {
    "DI_INITIAL":         {"lettre_cle": "DI", "coefficient": 2.5, "tarif": 25.00, "tarif_om": 25.00, "label": "BSI initial"},
    "DI_RENOUVELLEMENT":  {"lettre_cle": "DI", "coefficient": 1.2, "tarif": 12.00, "tarif_om": 12.00, "label": "BSI de renouvellement (12 mois)"},
    "DI_INTERMEDIAIRE":   {"lettre_cle": "DI", "coefficient": 1.2, "tarif": 12.00, "tarif_om": 12.00, "label": "BSI intermédiaire (max 2/an)"},
}

# ─── INDEMNITÉS DE DÉPLACEMENT ──────────────────────────────────────
DEPLACEMENTS = {
    "IFD":         {"tarif": 2.75, "tarif_om": 2.75, "label": "Indemnité forfaitaire de déplacement (hors BSI)", "max_par_passage": 1},
    "IFI":         {"tarif": 2.75, "tarif_om": 2.75, "label": "Indemnité forfaitaire infirmière (en contexte BSI)", "max_par_jour": 4, "note": "Cumul avec 1 acte AMX, IK, nuit, dimanche, MCI, MIE"},
    "IK_PLAINE":   {"tarif_par_km": 0.35, "tarif_om_par_km": 0.35, "label": "IK zone plaine (par km × 2 aller-retour)", "code_facturation": "IK"},
    "IK_MONTAGNE": {"tarif_par_km": 0.50, "tarif_om_par_km": 0.50, "label": "IK zone montagne ou île (par km × 2)", "code_facturation": "IK"},
    "IK_PIED_SKI": {"tarif_par_km": 3.40, "tarif_om_par_km": 3.66, "label": "IK à pied ou à ski (par km)", "code_facturation": "IK"},
}

# ─── PLAFONNEMENT JOURNALIER IK ─────────────────────────────────────
IK_PLAFONNEMENT = {
    "<300_km":  {"abattement": 0.0,  "label": "Aucun abattement"},
    "300-399":  {"abattement": 0.5,  "label": "Abattement 50% sur tranche 300-399 km"},
    ">=400":    {"abattement": 1.0,  "label": "Abattement 100% au-delà de 400 km"},
}

# ─── MAJORATIONS ────────────────────────────────────────────────────
MAJORATIONS = {
    "MAU":       {"tarif": 1.35, "tarif_om": 1.35, "label": "Majoration acte unique (AMI ≤1.5, cabinet ou domicile)",
                  "incompatibles": ["MCI", "AMX", "BSA", "BSB", "BSC", "TLS", "TLD", "TLL"]},
    "MCI":       {"tarif": 5.00, "tarif_om": 5.00, "label": "Majoration coordination infirmière",
                  "max_par_intervention": 1,
                  "conditions": ["pansement_lourd_complexe (Chap I art 3 ou Chap II art 5bis)", "soins_palliatifs"],
                  "incompatibles": ["BSA", "BSB", "BSC", "AMX", "IFI", "MAU", "TLS", "TLD", "TLL"]},
    "MIE":       {"tarif": 3.15, "tarif_om": 3.15, "label": "Majoration jeune enfant <7 ans",
                  "cumul_avec": "toutes_majorations"},
    "ISD":       {"tarif": 8.50, "tarif_om": 8.50, "label": "Majoration dimanche/jour férié",
                  "applicable": "samedi 8h pour appels urgence",
                  "incompatibles": ["ISN_NUIT", "ISN_NUIT_PROFONDE"]},
    "ISN_NUIT":  {"tarif": 9.15, "tarif_om": 9.15, "label": "Majoration nuit (20h-23h / 5h-8h)",
                  "code_alias": "NUIT",
                  "incompatibles": ["ISD", "ISN_NUIT_PROFONDE"]},
    "ISN_NUIT_PROFONDE": {"tarif": 18.30, "tarif_om": 18.30, "label": "Majoration nuit profonde (23h-5h)",
                  "code_alias": "NUIT_PROF",
                  "incompatibles": ["ISD", "ISN_NUIT"]},
}

# ─── ACTES TÉLÉSOIN (Avenant 9) ─────────────────────────────────────
TELESOIN = {
    "TLS": {"tarif": 10.00, "tarif_om": 10.00, "label": "Téléconsultation au décours d'un soin infirmier", "cumulable_taux_plein": True},
    "TLL": {"tarif": 12.00, "tarif_om": 12.00, "label": "Téléconsultation isolée en lieu dédié", "ifd": "incluses", "max_par_jour": 2},
    "TLD": {"tarif": 15.00, "tarif_om": 15.00, "label": "Téléconsultation isolée au domicile patient", "ifd": "incluses"},
    "RQD": {"tarif": 10.00, "tarif_om": 10.00, "label": "Demande de téléexpertise", "lettre_cle": "RQD"},
}

# ═══════════════════════════════════════════════════════════════════════
# CHAPITRE I — SOINS DE PRATIQUE COURANTE
# ═══════════════════════════════════════════════════════════════════════

CHAP_I = []

# ─── Article 1 — PRÉLÈVEMENTS ET INJECTIONS ─────────────────────────
ART_1_INJECTIONS = [
    {"code": "AMI1_5_PONCTION", "lettre_cle": "AMI/AMX", "coefficient": 1.5, "tarif": 4.73, "tarif_om": 4.95,
     "label": "Prélèvement par ponction veineuse directe",
     "cumul_taux_plein": True, "derogation": "art. 11B (cumul taux plein quel que soit l'acte associé)",
     "code_facturation": "AMI1.5"},
    {"code": "AMI5_SAIGNEE", "lettre_cle": "AMI", "coefficient": 5, "tarif": 15.75, "tarif_om": 16.50,
     "label": "Saignée", "code_facturation": "AMI5"},
    {"code": "AMI1_PRELEV_AUTRE", "lettre_cle": "AMI", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Prélèvement aseptique cutané/muqueux/selles/urine pour examens cyto/bactério/myco/virologique/parasitologique",
     "code_facturation": "AMI1"},
    {"code": "AMI2_INJ_IV_DIRECTE", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Injection intraveineuse directe isolée",
     "code_facturation": "AMI2"},
    {"code": "AMI1_5_INJ_IV_SERIE", "lettre_cle": "AMI", "coefficient": 1.5, "tarif": 4.73, "tarif_om": 4.95,
     "label": "Injection intraveineuse directe en série",
     "code_facturation": "AMI1.5"},
    {"code": "AMI2_INJ_IV_ENFANT", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Injection intraveineuse directe chez enfant <5 ans",
     "code_facturation": "AMI2"},
    {"code": "AMI1_INJ_IM", "lettre_cle": "AMI/AMX", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Injection intramusculaire",
     "note": "Vaccinations IM possibles sans prescription (décret 2022-610)",
     "code_facturation": "AMI1"},
    {"code": "AMI5_BESREDKA", "lettre_cle": "AMI", "coefficient": 5, "tarif": 15.75, "tarif_om": 16.50,
     "label": "Injection sérum origine humaine/animale méthode Besredka (avec surveillance)",
     "code_facturation": "AMI5"},
    {"code": "AMI1_INJ_SC", "lettre_cle": "AMI/AMX", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Injection sous-cutanée",
     "note": "Vaccinations SC possibles sans prescription",
     "code_facturation": "AMI1"},
    {"code": "AMI1_INJ_ID", "lettre_cle": "AMI/AMX", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Injection intradermique",
     "code_facturation": "AMI1"},
    {"code": "AMI3_INJ_ALLERG", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Injection allergène (hyposensibilisation, surveillance, dossier, transmission médecin)",
     "code_facturation": "AMI3"},
    {"code": "AMI2_5_IMPLANT", "lettre_cle": "AMI", "coefficient": 2.5, "tarif": 7.88, "tarif_om": 8.25,
     "label": "Injection implant sous-cutané (Zoladex, Décapeptyl, Énantone)",
     "code_facturation": "AMI2.5"},
    {"code": "AMI2_INJ_RECTAL", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Injection en goutte à goutte par voie rectale",
     "code_facturation": "AMI2"},
    {"code": "AMI2_4_VACC_PRESC", "lettre_cle": "AMI/AMX", "coefficient": 2.4, "tarif": 7.56, "tarif_om": 7.92,
     "label": "Vaccination AVEC prescription médicale ou si vaccin sans prescription",
     "code_facturation": "AMI2.4"},
    {"code": "AMI3_05_VACC_SS_PRESC", "lettre_cle": "AMI/AMX", "coefficient": 3.05, "tarif": 9.61, "tarif_om": 10.01,
     "label": "Vaccination SANS prescription médicale (compétence élargie)",
     "code_facturation": "AMI3.05"},
]

# ─── Article 2 — PANSEMENTS COURANTS ────────────────────────────────
ART_2_PANSEMENTS = [
    {"code": "AMI3_STOMIE", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Pansement de stomie", "code_facturation": "AMI3"},
    {"code": "AMI3_TRACHEO", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Pansement trachéotomie (avec aspiration et changement canule éventuel)",
     "code_facturation": "AMI3"},
    {"code": "AMI2_FILS_MOINS_10", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Ablation fils/agrafes ≤10 (avec pansement éventuel)",
     "code_facturation": "AMI2"},
    {"code": "AMI4_FILS_PLUS_10", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Ablation fils/agrafes >10 (avec pansement éventuel)",
     "code_facturation": "AMI4"},
    {"code": "AMI3_PANS_OP_ETENDU", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Pansement plaies opératoires étendues/multiples (abdominoplastie, chirurgie mammaire)",
     "note": "Chirurgie mammaire bilatérale: 2 actes possibles, le 2e à 50% (art. 11B)",
     "code_facturation": "AMI3"},
    {"code": "AMI3_PANS_VARICES", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Pansement post-op exérèses varices/ligatures veines perforantes",
     "note": "Max 2 actes facturables (même membre ou 2 membres)",
     "code_facturation": "AMI3"},
    {"code": "AMI2_PANS_AUTRE", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Autre pansement",
     "code_facturation": "AMI2"},
]

# ─── Article 3 — PANSEMENTS LOURDS ET COMPLEXES ─────────────────────
ART_3_PANS_LOURDS = [
    {"code": "AMI11_BILAN_PLAIE", "lettre_cle": "AMI/AMX", "coefficient": 11, "tarif": 34.65, "tarif_om": 36.30,
     "label": "Bilan 1ère prise en charge d'une plaie nécessitant pansement lourd et complexe",
     "max_par_an": 1, "note": "Pour plaies >1 an, 1/an. Pour plaies <1 an, nouveau bilan si récidive après 2 mois interruption. NON cumulable avec MCI.",
     "code_facturation": "AMI11"},
    {"code": "AMI4_BRULURE_5PCT", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement brûlure étendue ou plaie chimique/thermique >5% surface corporelle",
     "code_facturation": "AMI4"},
    {"code": "AMI4_BRULURE_RADIO", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement brûlure post-radiothérapie >2% surface corporelle",
     "code_facturation": "AMI4"},
    {"code": "AMI4_ULCERE_60CM2", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement ulcère étendu ou greffe cutanée >60 cm²",
     "code_facturation": "AMI4"},
    {"code": "AMI4_AMPUTATION", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement amputation (détersion, épluchage, régularisation)",
     "code_facturation": "AMI4"},
    {"code": "AMI4_FISTULE_DIG", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement fistule digestive",
     "code_facturation": "AMI4"},
    {"code": "AMI4_PERTE_SUBSTANCE", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement pertes substance traumatique/néoplasique avec lésions profondes (sous-aponévrotiques, musculaires, tendineuses, osseuses)",
     "code_facturation": "AMI4"},
    {"code": "AMI4_MECHAGE", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement nécessitant méchage ou irrigation",
     "code_facturation": "AMI4"},
    {"code": "AMI4_ESCARRE_PROFONDE", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement escarre profonde et étendue (atteinte muscles/tendons)",
     "code_facturation": "AMI4"},
    {"code": "AMI4_OSTEOSYNTHESE", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement chirurgical avec matériel d'ostéosynthèse extériorisé",
     "code_facturation": "AMI4"},
    {"code": "AMI5_1_ULCERE_COMPRESSION", "lettre_cle": "AMI/AMX", "coefficient": 5.1, "tarif": 16.07, "tarif_om": 16.83,
     "label": "Pansement ulcère ou greffe cutanée AVEC pose de compression",
     "code_facturation": "AMI5.1"},
    {"code": "AMI1_1_ANALGESIE_TOPIQUE", "lettre_cle": "AMI/AMX", "coefficient": 1.1, "tarif": 3.47, "tarif_om": 3.63,
     "label": "Analgésie topique préalable (EMLA) à pansement ulcère/escarre",
     "max_par_episode": 8, "renouvelable": "1 fois/épisode cicatrisation",
     "cumul_taux_plein_avec": ["AMI4 (pansement complexe)"],
     "derogation": "art. 11B (cumul taux plein avec pansement complexe même séance)",
     "code_facturation": "AMI1.1"},
    {"code": "AMI4_6_TPN_POSE", "lettre_cle": "AMI/AMX", "coefficient": 4.6, "tarif": 14.49, "tarif_om": 15.18,
     "label": "Pose système traitement par pression négative (TPN console + pansement à usage unique)",
     "note": "Prescription initiale hospitalière 30j renouvelable 1×. Indications HAS: plaies chroniques exsudatives 2nde intention. Renouvellement à saturation ou après 7 jours.",
     "code_facturation": "AMI4.6"},
    {"code": "AMI2_1_TPN_PANS_ADD", "lettre_cle": "AMI/AMX", "coefficient": 2.1, "tarif": 6.62, "tarif_om": 6.93,
     "label": "Mise en place pansement additionnel TPN (sans changement console)",
     "code_facturation": "AMI2.1"},
]

# ─── Article 4 — POSE DE SONDE ET ALIMENTATION ──────────────────────
ART_4_SONDES = [
    {"code": "AMI3_SONDE_GASTRIQUE", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Pose sonde gastrique", "code_facturation": "AMI3"},
    {"code": "AMI3_ALIM_ENTERALE", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Alimentation entérale par gavage/déclive/nutri-pompe (avec surveillance), par séance",
     "code_facturation": "AMI3"},
    {"code": "AMI4_ALIM_JEJUNALE", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Alimentation entérale voie jéjunale (sondage stomie + pansement + surveillance)",
     "code_facturation": "AMI4"},
]

# ─── Article 5 — APPAREIL RESPIRATOIRE ──────────────────────────────
ART_5_RESPIRATOIRE = [
    {"code": "AMI1_5_AEROSOL", "lettre_cle": "AMI", "coefficient": 1.5, "tarif": 4.73, "tarif_om": 4.95,
     "label": "Séance d'aérosol", "code_facturation": "AMI1.5"},
    {"code": "AMI2_LAVAGE_SINUS", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Lavage d'un sinus", "code_facturation": "AMI2"},
]

# ─── Article 6 — APPAREIL GÉNITO-URINAIRE ───────────────────────────
ART_6_URINAIRE = [
    {"code": "AMI1_25_INJ_VAGINALE", "lettre_cle": "AMI", "coefficient": 1.25, "tarif": 3.94, "tarif_om": 4.13,
     "label": "Injection vaginale", "code_facturation": "AMI1.25"},
    {"code": "AMI1_5_GYNE_CURIE", "lettre_cle": "AMI", "coefficient": 1.5, "tarif": 4.73, "tarif_om": 4.95,
     "label": "Soins gynécologiques au décours immédiat curiethérapie", "code_facturation": "AMI1.5"},
    {"code": "AMI3_CATH_URET_F", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Cathétérisme urétral femme", "code_facturation": "AMI3"},
    {"code": "AMI4_CATH_URET_H", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Cathétérisme urétral homme", "code_facturation": "AMI4"},
    {"code": "AMI3_CHGT_SONDE_F", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Changement sonde urinaire à demeure femme", "code_facturation": "AMI3"},
    {"code": "AMI4_CHGT_SONDE_H", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Changement sonde urinaire à demeure homme", "code_facturation": "AMI4"},
    {"code": "AMI3_5_AUTOSONDAGE", "lettre_cle": "AMI", "coefficient": 3.5, "tarif": 11.03, "tarif_om": 11.55,
     "label": "Éducation autosondage (avec sondage éventuel, max 10 séances)",
     "max_total": 10, "code_facturation": "AMI3.5",
     "incompatibles_avec": ["AMI3_CATH_URET_F", "AMI4_CATH_URET_H", "AMI3_CHGT_SONDE_F", "AMI4_CHGT_SONDE_H"]},
    {"code": "AMI4_5_VESSIE_NEUR", "lettre_cle": "AMI", "coefficient": 4.5, "tarif": 14.18, "tarif_om": 14.85,
     "label": "Réadaptation vessie neurologique (avec sondage éventuel)",
     "code_facturation": "AMI4.5",
     "incompatibles_avec": ["AMI3_CATH_URET_F", "AMI4_CATH_URET_H", "AMI3_CHGT_SONDE_F", "AMI4_CHGT_SONDE_H"]},
    {"code": "AMI1_25_LAVAGE_VESICAL", "lettre_cle": "AMI", "coefficient": 1.25, "tarif": 3.94, "tarif_om": 4.13,
     "label": "Instillation/lavage vésical (sonde en place)", "code_facturation": "AMI1.25"},
    {"code": "AMI1_ETUI_PENIEN", "lettre_cle": "AMI", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Pose isolée étui pénien (1 fois/24h)", "max_par_jour": 1, "code_facturation": "AMI1"},
    {"code": "AMI2_RETRAIT_SONDE", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Retrait sonde urinaire", "code_facturation": "AMI2"},
]

# ─── Article 7 — APPAREIL DIGESTIF ──────────────────────────────────
ART_7_DIGESTIF = [
    {"code": "AMI1_25_BOUCHE_RADIO", "lettre_cle": "AMI", "coefficient": 1.25, "tarif": 3.94, "tarif_om": 4.13,
     "label": "Soins de bouche avec produits médicamenteux au décours radiothérapie",
     "code_facturation": "AMI1.25"},
    {"code": "AMI3_LAVEMENT", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Lavement évacuateur ou médicamenteux", "code_facturation": "AMI3"},
    {"code": "AMI3_FECALOME", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Extraction fécalome ou extraction manuelle des selles", "code_facturation": "AMI3"},
]

# ─── Article 8 — ENVELOPPE CUTANÉE ──────────────────────────────────
ART_8_CUTANE = [
    {"code": "AMI1_25_PULVERISATION", "lettre_cle": "AMI", "coefficient": 1.25, "tarif": 3.94, "tarif_om": 4.13,
     "label": "Pulvérisation produit(s) médicamenteux", "code_facturation": "AMI1.25"},
    {"code": "AMI0_5_TEST_TUBERCU", "lettre_cle": "AMI", "coefficient": 0.5, "tarif": 1.58, "tarif_om": 1.65,
     "label": "Réalisation test tuberculinique", "code_facturation": "AMI0.5"},
    {"code": "AMI1_LECTURE_TIMBRE", "lettre_cle": "AMI", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Lecture timbre tuberculinique + transmission médecin", "code_facturation": "AMI1"},
]

# Article 9 supprimé par décision UNCAM 21/07/14

# ─── Article 10 — SURVEILLANCE & ACCOMPAGNEMENT MÉDICAMENTEUX ──────
ART_10_SURVEILLANCE = [
    {"code": "AMI1_2_SURV_PSY_NEURO", "lettre_cle": "AMI", "coefficient": 1.2, "tarif": 3.78, "tarif_om": 3.96,
     "label": "Administration/surveillance thérapeutique orale à domicile (troubles psychiatriques/cognitifs/neurodégénératifs) — par passage",
     "note": "Domicile n'inclut PAS établissements de santé/EHPAD/MAS sauf Résidences Autonomie",
     "prescription_required": True, "code_facturation": "AMI1.2"},
    {"code": "AMI1_2_SURV_AP", "lettre_cle": "AMI", "coefficient": 1.2, "tarif": 3.78, "tarif_om": 3.96,
     "label": "Surveillance thérapeutique orale (psy/cognitif) au-delà du 1er mois",
     "prescription_required": "AP", "code_facturation": "AMI1.2 AP"},
    {"code": "AMI1_SURV_TRAITEMENT", "lettre_cle": "AMI", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Surveillance/observation patient lors mise en œuvre ou modification traitement (max 15 passages)",
     "max_total": 15, "code_facturation": "AMI1"},
    {"code": "AMI5_1_ACCOMP_PRISE_MED_INIT", "lettre_cle": "AMI", "coefficient": 5.1, "tarif": 16.07, "tarif_om": 16.83,
     "label": "Accompagnement prise médicamenteuse — séance INITIALE (patient non dépendant polymédiqué fragile)",
     "note": "3 séances dans 1 mois, renouvelables 1× sur 12 mois suivants. Non cumulable avec autres actes art. 10 même séance.",
     "code_facturation": "AMI5.1"},
    {"code": "AMI4_6_ACCOMP_PRISE_MED_2_3", "lettre_cle": "AMI", "coefficient": 4.6, "tarif": 14.49, "tarif_om": 15.18,
     "label": "Accompagnement prise médicamenteuse — 2e et 3e séances",
     "code_facturation": "AMI4.6"},
]

# ─── Article 11 — SOINS À DOMICILE PATIENT DÉPENDANT (AIS) ─────────
ART_11_AIS = [
    {"code": "AIS3_SEANCE_SOINS", "lettre_cle": "AIS", "coefficient": 3, "tarif": 7.95, "tarif_om": 8.10,
     "label": "Séance soins infirmiers (1/2 heure, max 4/24h)",
     "note": "Cumul TAUX PLEIN avec: perfusion (Chap II art 3,4,5), pansement complexe (Chap I art 3 ou Chap II art 5bis), surveillance BPCO/IC (Chap II art 5ter), ponction veineuse. Cumul à 50%: injection IM/ID/SC, vaccination grippe, insuline diabète insulino.",
     "subordonne_a": "BSI préalable", "code_facturation": "AIS3"},
    {"code": "AIS3_1_PROG_AIDE", "lettre_cle": "AIS", "coefficient": 3.1, "tarif": 8.22, "tarif_om": 8.37,
     "label": "Programme aide personnalisée (1/2 heure, max 4/24h)",
     "subordonne_a": "BSI préalable", "code_facturation": "AIS3.1"},
    {"code": "AIS4_SURV_HEBDO", "lettre_cle": "AIS", "coefficient": 4, "tarif": 10.60, "tarif_om": 10.80,
     "label": "Séance hebdomadaire surveillance clinique infirmière + prévention",
     "max_par_semaine": 1,
     "incompatibles": ["pendant_periode_seances_soins_infirmiers", "pendant_programme_aide", "actes_avec_surveillance_incluse"],
     "subordonne_a": "BSI préalable",
     "code_facturation": "AIS4"},
]

# ─── Article 12 — BSI / FORFAITS BSA-BSB-BSC ────────────────────────
ART_12_BSI = [
    {"code": "DI_BSI_INITIAL", "lettre_cle": "DI", "coefficient": 2.5, "tarif": 25.00, "tarif_om": 25.00,
     "label": "BSI initial (élaboration bilan dématérialisé 3 volets: admin + médical + facturation)",
     "code_facturation": "DI2.5"},
    {"code": "DI_BSI_RENOUVELLEMENT", "lettre_cle": "DI", "coefficient": 1.2, "tarif": 12.00, "tarif_om": 12.00,
     "label": "BSI renouvellement (à 12 mois)",
     "code_facturation": "DI1.2"},
    {"code": "DI_BSI_INTERMEDIAIRE", "lettre_cle": "DI", "coefficient": 1.2, "tarif": 12.00, "tarif_om": 12.00,
     "label": "BSI intermédiaire (max 2/an si situation clinique évolutive)",
     "max_par_an": 2,
     "code_facturation": "DI1.2"},
    {"code": "BSA", "lettre_cle": "BSA", "coefficient": None, "tarif": 13.00, "tarif_om": 13.25,
     "label": "Forfait journalier BSI — dépendance LÉGÈRE",
     "subordonne_a": "BSI préalable",
     "cumul_taux_plein": ["perfusion (Chap II art 3,4,5)", "pansement complexe (Chap I art 3 ou Chap II art 5bis)", "surveillance BPCO/IC (Chap II art 5ter)", "ponction veineuse"],
     "cumul_50pct": ["injection IM/ID/SC", "insuline + surveillance diabète insulino"],
     "incompatibles": ["AIS_meme_jour", "MAU"],
     "code_facturation": "BSA"},
    {"code": "BSB", "lettre_cle": "BSB", "coefficient": None, "tarif": 18.20, "tarif_om": 18.55,
     "label": "Forfait journalier BSI — dépendance INTERMÉDIAIRE",
     "subordonne_a": "BSI préalable",
     "code_facturation": "BSB"},
    {"code": "BSC", "lettre_cle": "BSC", "coefficient": None, "tarif": 28.70, "tarif_om": 29.25,
     "label": "Forfait journalier BSI — dépendance LOURDE",
     "subordonne_a": "BSI préalable",
     "code_facturation": "BSC"},
]

# ─── Article 13 — GARDE À DOMICILE ──────────────────────────────────
ART_13_GARDE = [
    {"code": "AIS13_GARDE_JOUR", "lettre_cle": "AIS", "coefficient": 13, "tarif": 34.45, "tarif_om": 35.10,
     "label": "Garde malade domicile 6h (8h-20h)",
     "prescription_required": "AP", "max_periodes_consecutives": 2,
     "code_facturation": "AIS13 AP"},
    {"code": "AIS16_GARDE_NUIT", "lettre_cle": "AIS", "coefficient": 16, "tarif": 42.40, "tarif_om": 43.20,
     "label": "Garde malade domicile 6h (20h-8h)",
     "prescription_required": "AP", "max_periodes_consecutives": 2,
     "code_facturation": "AIS16 AP"},
]

# ─── Article 14 — TÉLÉSURVEILLANCE PANSEMENT ────────────────────────
ART_14_TELESURV = [
    {"code": "AMI1_6_TELESURV_PANS", "lettre_cle": "AMI", "coefficient": 1.6, "tarif": 5.04, "tarif_om": 5.28,
     "label": "Acte surveillance à distance (télésoin vidéo) d'un pansement",
     "max_par_mois": 4, "max_par_patient": True,
     "note": "Préalable: pansement présentiel pour cet épisode. PAS cumulable avec pansement le même jour. Code facturation: TMI au lieu de AMI1.6",
     "code_facturation": "TMI"},
]

# ═══════════════════════════════════════════════════════════════════════
# CHAPITRE II — SOINS SPÉCIALISÉS
# ═══════════════════════════════════════════════════════════════════════

CHAP_II = []

# ─── Article 1 — ENTRETIEN DES CATHÉTERS ────────────────────────────
ART_II_1_CATHETERS = [
    {"code": "AMI4_CATH_PERITONEAL", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Entretien cathéter péritonéal (avec pansement)",
     "code_facturation": "AMI4"},
    {"code": "AMI4_CATH_EXT_SITE", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Entretien cathéter extériorisé/site implantable/cathéter veineux central PICC (avec pansement)",
     "code_facturation": "AMI4"},
]

# ─── Article 2 — INJECTIONS ET PRÉLÈVEMENTS (CHAP II) ──────────────
ART_II_2_INJECTIONS = [
    {"code": "AMI5_INJ_INTRATHEC", "lettre_cle": "AMI", "coefficient": 5, "tarif": 15.75, "tarif_om": 16.50,
     "label": "Injection analgésique(s) (sauf 1ère) par cathéter intrathécal/péridural",
     "prescription_required": "AP", "code_facturation": "AMI5 AP"},
    {"code": "AMI4_INJ_IV_SITE_IMPLANTE", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Injection IV par site implanté (avec héparinisation + pansement)",
     "code_facturation": "AMI4"},
    {"code": "AMI3_INJ_IV_CATH_CENTRAL", "lettre_cle": "AMI", "coefficient": 3, "tarif": 9.45, "tarif_om": 9.90,
     "label": "Injection IV par cathéter central (avec héparinisation + pansement)",
     "code_facturation": "AMI3"},
    {"code": "AMI1_PRELEV_CATH_CENTRAL", "lettre_cle": "AMI", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Prélèvement sanguin sur cathéter veineux central extériorisé ou chambre implantable",
     "code_facturation": "AMI1"},
]

# ─── Article 3 — PERFUSIONS (CRITIQUE — CIR-9/2025) ─────────────────
ART_II_3_PERFUSIONS = [
    {"code": "AMI9_PERF_COURTE", "lettre_cle": "AMI/AMX", "coefficient": 9, "tarif": 28.35, "tarif_om": 29.70,
     "label": "Forfait perfusion COURTE ≤1h sous SURVEILLANCE CONTINUE",
     "duree": "≤ 60 minutes",
     "comprend": ["préparation produits", "préparation matériel", "perfusion (succession ou simultanée)", "surveillance continue", "arrêt", "pansement"],
     "code_facturation": "AMI9"},
    {"code": "AMI6_SUPPL_HORAIRE_PERF_COURTE", "lettre_cle": "AMI/AMX", "coefficient": 6, "tarif": 18.90, "tarif_om": 19.80,
     "label": "Supplément forfaitaire surveillance continue d'une perfusion AU-DELÀ de la 1ère heure (par heure, max 5h)",
     "max_total": 5, "applique_apres": "AMI9 ou AMI10",
     "code_facturation": "AMI6"},
    {"code": "AMI14_PERF_LONGUE", "lettre_cle": "AMI/AMX", "coefficient": 14, "tarif": 44.10, "tarif_om": 46.20,
     "label": "Forfait perfusion >1h avec ORGANISATION DE SURVEILLANCE (sans surveillance continue)",
     "duree": "> 60 minutes",
     "regle_cir9_2025": "FORFAIT JOURNALIER — 1× par jour par patient maximum (CIR-9/2025 du 25/06/2025)",
     "comprend": ["préparation produits", "préparation matériel", "pose perfusion", "organisation contrôles", "gestion complications"],
     "incompatibles_meme_jour": ["AMI14", "AMI15"],
     "code_facturation": "AMI14"},
    {"code": "AMI4_ORG_SURVEILLANCE", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Forfait organisation surveillance perfusion (planification + coordination), par jour",
     "exclus": ["jour de pose", "jour de retrait"],
     "non_cumulable_avec": ["IFD", "majoration_nuit", "majoration_dimanche"],
     "code_facturation": "AMI4"},
    {"code": "AMI5_RETRAIT_PERF", "lettre_cle": "AMI/AMX", "coefficient": 5, "tarif": 15.75, "tarif_om": 16.50,
     "label": "Forfait arrêt et retrait dispositif perfusion (avec pansement, dossier, transmission médecin)",
     "non_cumulable_avec": ["AMI9 (perf courte sous surveillance continue)"],
     "code_facturation": "AMI5"},
    {"code": "AMI4_1_CHGT_FLACON", "lettre_cle": "AMI/AMX", "coefficient": 4.1, "tarif": 12.92, "tarif_om": 13.53,
     "label": "Changement flacon(s) ou branchement Y sur dispositif en place / débranchement / déplacement / contrôle débit (perfusion sans surveillance continue, hors séance pose)",
     "regle_cir9_2025": "Cote la 2ème perfusion longue dans la journée si AMI14/AMI15 déjà coté ce jour",
     "code_facturation": "AMI4.1"},
]

# ─── Article 4 — PATIENT IMMUNODÉPRIMÉ OU CANCÉREUX ─────────────────
ART_II_4_IMMUNO_CANCER = [
    {"code": "AMI5_AEROSOL_PROPHY", "lettre_cle": "AMI", "coefficient": 5, "tarif": 15.75, "tarif_om": 16.50,
     "label": "Séance aérosol à visée prophylactique (immunodéprimé/cancéreux)",
     "code_facturation": "AMI5"},
    {"code": "AMI1_5_INJ_IM_SC_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 1.5, "tarif": 4.73, "tarif_om": 4.95,
     "label": "Injection IM ou SC (patient immunodéprimé/cancéreux)",
     "code_facturation": "AMI1.5"},
    {"code": "AMI2_5_INJ_IV_CANCER", "lettre_cle": "AMI", "coefficient": 2.5, "tarif": 7.88, "tarif_om": 8.25,
     "label": "Injection IV (patient immunodéprimé/cancéreux)",
     "code_facturation": "AMI2.5"},
    {"code": "AMI7_INJ_CHIMIO", "lettre_cle": "AMI", "coefficient": 7, "tarif": 22.05, "tarif_om": 23.10,
     "label": "Injection IV produit de chimiothérapie anticancéreuse",
     "code_facturation": "AMI7"},
    {"code": "AMI10_PERF_COURTE_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 10, "tarif": 31.50, "tarif_om": 33.00,
     "label": "Forfait perfusion COURTE ≤1h sous surveillance continue — patient immunodéprimé/cancéreux",
     "duree": "≤ 60 minutes",
     "code_facturation": "AMI10"},
    {"code": "AMI6_SUPPL_HORAIRE_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 6, "tarif": 18.90, "tarif_om": 19.80,
     "label": "Supplément forfaitaire surveillance continue au-delà de la 1ère heure (cancer/immunodéprimé), par heure (max 5h)",
     "max_total": 5,
     "code_facturation": "AMI6"},
    {"code": "AMI15_PERF_LONGUE_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 15, "tarif": 47.25, "tarif_om": 49.50,
     "label": "Forfait perfusion >1h avec organisation surveillance — patient immunodéprimé/cancéreux",
     "regle_cir9_2025": "FORFAIT JOURNALIER — 1× par jour par patient maximum (CIR-9/2025)",
     "incompatibles_meme_jour": ["AMI14", "AMI15"],
     "code_facturation": "AMI15"},
    {"code": "AMI4_ORG_SURV_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Forfait organisation surveillance perfusion (cancer/immunodéprimé), par jour",
     "exclus": ["jour de pose", "jour de retrait"],
     "non_cumulable_avec": ["IFD", "majoration_nuit", "majoration_dimanche"],
     "code_facturation": "AMI4"},
    {"code": "AMI5_RETRAIT_PERF_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 5, "tarif": 15.75, "tarif_om": 16.50,
     "label": "Forfait arrêt et retrait dispositif perfusion (cancer/immunodéprimé)",
     "non_cumulable_avec": ["AMI9", "AMI10"],
     "code_facturation": "AMI5"},
    {"code": "AMI4_1_CHGT_FLACON_CANCER", "lettre_cle": "AMI/AMX", "coefficient": 4.1, "tarif": 12.92, "tarif_om": 13.53,
     "label": "Changement flacon / branchement Y / débranchement / contrôle débit (cancer/immunodéprimé)",
     "code_facturation": "AMI4.1"},
]

# ─── Article 5 — MUCOVISCIDOSE PERFUSIONS ANTIBIO ───────────────────
ART_II_5_MUCO = [
    {"code": "AMI15_PERF_MUCO", "lettre_cle": "AMI/AMX", "coefficient": 15, "tarif": 47.25, "tarif_om": 49.50,
     "label": "Séance perfusion IV antibiotiques sous surveillance continue (mucoviscidose)",
     "note": "Cotation globale incluant tous gestes. Feuille de surveillance détaillée obligatoire. Si pas de surveillance continue: AMI15 (perfusion >1h avec organisation surveillance)",
     "protocole_obligatoire": ["nom produits", "mode/durée/horaires admin", "nb/durée/horaires séances/24h", "nb jours cure", "gestes associés (prélèv, hépariniz)"],
     "code_facturation": "AMI15"},
]

# ─── Article 5bis — PATIENT INSULINO-TRAITÉ (Article 5bis) ──────────
ART_II_5BIS_INSULINO = [
    {"code": "AMI1_SURV_DIAB_INSULINO", "lettre_cle": "AMI/AMX", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Surveillance/observation patient diabétique insulino-traité (adaptation doses, fiche surveillance)",
     "code_facturation": "AMI1"},
    {"code": "AMI1_INJ_INSULINE", "lettre_cle": "AMI/AMX", "coefficient": 1, "tarif": 3.15, "tarif_om": 3.30,
     "label": "Injection sous-cutanée d'insuline",
     "code_facturation": "AMI1"},
    {"code": "AMI4_SURV_HEBDO_75ANS", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Séance hebdomadaire surveillance clinique + prévention (insulino-traité >75 ans)",
     "duree": "30 min",
     "incompatibles": ["BSI Chap I art 11/12"],
     "code_facturation": "AMI4"},
    {"code": "AMI4_PANS_PIED_DIAB", "lettre_cle": "AMI/AMX", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Pansement lourd et complexe (diabétique insulino-traité, asepsie + détersion + défibrination)",
     "code_facturation": "AMI4"},
    {"code": "AMI1_1_ANALGESIE_TOPIQUE_DIAB", "lettre_cle": "AMI/AMX", "coefficient": 1.1, "tarif": 3.47, "tarif_om": 3.63,
     "label": "Analgésie topique préalable au pansement (diabétique)",
     "max_par_episode": 8, "renouvelable": "1 fois/épisode",
     "code_facturation": "AMI1.1"},
]
ART_II_5BIS_NOTE = "Article 5bis: TOUS ces actes se cumulent ENTRE EUX à TAUX PLEIN par dérogation à l'article 11B. Avec BSI: appliquer le 11B (1er à 100%, 2e à 50%)."

# ─── Article 5ter — SURVEILLANCE BPCO / INSUFFISANCE CARDIAQUE ──────
ART_II_5TER_BPCO = [
    {"code": "AMI5_8_BPCO_IC", "lettre_cle": "AMI/AMX", "coefficient": 5.8, "tarif": 18.27, "tarif_om": 19.14,
     "label": "Séance domicile surveillance + prévention post-hospit décompensation IC ou exacerbation BPCO",
     "frequence": "1 visite/semaine pendant 2 mois minimum (1ère visite dans 7j post-sortie)",
     "duree_prog": "4-6 mois IC, jusqu'à 6 mois BPCO sévère",
     "max_total": 15,
     "non_cumulable_avec": ["majoration_nuit", "majoration_dimanche", "AIS4 (surv. hebdo Chap I art 11)", "AMI4 (surv. hebdo insulino >75 ans)"],
     "formation_requise": True,
     "code_facturation": "AMI5.8"},
]

# ─── Article 6 — APPAREIL DIGESTIF/URINAIRE SPÉCIALISÉ ──────────────
ART_II_6_DIG_URI = [
    {"code": "AMI4_IRRIG_COLIQUE", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Irrigation colique post-stomie définitive (max 20 séances)",
     "max_total": 20, "code_facturation": "AMI4"},
    {"code": "AMI4_DIALYSE_PERIT", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Dialyse péritonéale (max 4 séances/jour)",
     "max_par_jour": 4, "code_facturation": "AMI4"},
    {"code": "AMI4_DIALYSE_CYCL_BR", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Dialyse péritonéale par cycleur — branchement/débranchement",
     "code_facturation": "AMI4"},
    {"code": "AMI4_DIALYSE_CYCL_SURV", "lettre_cle": "AMI", "coefficient": 4, "tarif": 12.60, "tarif_om": 13.20,
     "label": "Dialyse péritonéale par cycleur — organisation surveillance par 12h",
     "code_facturation": "AMI4"},
]

# ─── Article 7 — POSTOPÉRATOIRE (Avenant 6) ─────────────────────────
ART_II_7_POSTOP = [
    {"code": "AMI3_9_SURV_POSTOP", "lettre_cle": "AMI", "coefficient": 3.9, "tarif": 12.29, "tarif_om": 12.87,
     "label": "Séance surveillance clinique + accompagnement postopératoire (chirurgie ambulatoire ou RAAC)",
     "max_total": 3, "fenetre": "J0 à veille 1ère consultation post-op chirurgien (ou J0 à J+6 si pas de RDV)",
     "incompatibles_meme_jour_entre_eux": ["AMI3.9", "AMI4.2"],
     "cumul_taux_plein_avec": ["AMI2 (retrait sonde urinaire)", "AMI2.8 (surv/retrait drain redon)"],
     "code_facturation": "AMI3.9"},
    {"code": "AMI4_2_CATH_PERINERVEUX", "lettre_cle": "AMI", "coefficient": 4.2, "tarif": 13.23, "tarif_om": 13.86,
     "label": "Séance surveillance/retrait cathéter périnerveux pour analgésie post-op",
     "max_par_jour": "1 (avec aidant) ou 2 (sans aidant)", "max_jours_consec": 3,
     "incompatibles_meme_jour_entre_eux": ["AMI3.9", "AMI4.2"],
     "cumul_taux_plein_avec": ["AMI2 (retrait sonde urinaire)", "AMI2.8 (surv/retrait drain redon)"],
     "note": "Terme 'cathéter périarticulaire' toléré sur prescription",
     "code_facturation": "AMI4.2"},
    {"code": "AMI2_RETRAIT_SONDE_URI", "lettre_cle": "AMI", "coefficient": 2, "tarif": 6.30, "tarif_om": 6.60,
     "label": "Retrait sonde urinaire (post-op)",
     "code_facturation": "AMI2"},
    {"code": "AMI2_8_SURV_DRAIN_REDON", "lettre_cle": "AMI", "coefficient": 2.8, "tarif": 8.82, "tarif_om": 9.24,
     "label": "Surveillance drain redon ou retrait postopératoire drain (max 2 séances)",
     "max_total": 2,
     "code_facturation": "AMI2.8"},
]

# ═══════════════════════════════════════════════════════════════════════
# ASSEMBLAGE FINAL
# ═══════════════════════════════════════════════════════════════════════

def add_meta(actes, chapitre, article):
    out = []
    for a in actes:
        a["chapitre"] = chapitre
        a["article"] = article
        out.append(a)
    return out

CHAP_I = (
    add_meta(ART_1_INJECTIONS,    "I", "1") +
    add_meta(ART_2_PANSEMENTS,    "I", "2") +
    add_meta(ART_3_PANS_LOURDS,   "I", "3") +
    add_meta(ART_4_SONDES,        "I", "4") +
    add_meta(ART_5_RESPIRATOIRE,  "I", "5") +
    add_meta(ART_6_URINAIRE,      "I", "6") +
    add_meta(ART_7_DIGESTIF,      "I", "7") +
    add_meta(ART_8_CUTANE,        "I", "8") +
    add_meta(ART_10_SURVEILLANCE, "I", "10") +
    add_meta(ART_11_AIS,          "I", "11") +
    add_meta(ART_12_BSI,          "I", "12") +
    add_meta(ART_13_GARDE,        "I", "13") +
    add_meta(ART_14_TELESURV,     "I", "14")
)

CHAP_II = (
    add_meta(ART_II_1_CATHETERS,    "II", "1") +
    add_meta(ART_II_2_INJECTIONS,   "II", "2") +
    add_meta(ART_II_3_PERFUSIONS,   "II", "3") +
    add_meta(ART_II_4_IMMUNO_CANCER,"II", "4") +
    add_meta(ART_II_5_MUCO,         "II", "5") +
    add_meta(ART_II_5BIS_INSULINO,  "II", "5bis") +
    add_meta(ART_II_5TER_BPCO,      "II", "5ter") +
    add_meta(ART_II_6_DIG_URI,      "II", "6") +
    add_meta(ART_II_7_POSTOP,       "II", "7")
)

# ─── DISPOSITIONS GÉNÉRALES — RÈGLES D'OR ─────────────────────────
REGLES_ART_11B = {
    "principe": "Seul l'acte du coefficient le plus important est coté à 100%. Le 2e acte de la même séance est coté à 50%. Les actes suivants ne donnent pas lieu à honoraires.",
    "applicable_a": ["AMI", "AMX", "AIS", "BSA", "BSB", "BSC", "TLS", "TLD", "TLL"],
    "exceptions_taux_plein": [
        "Forfaits BSI (BSA/BSB/BSC) toujours à taux plein",
        "Perfusions: AMI/AMX 9, 10, 14, 15, 5, 4, 4.1, 6 (Chap II art 3, 4, 5)",
        "Pansements lourds et complexes (Chap I art 3 et Chap II art 5bis): AMI/AMX 4, 11, 5.1, 1.1, 4.6, 2.1",
        "Article 5bis diabète insulino-traité: cumul taux plein entre eux",
        "Surveillance post-op (AMI 3.9) + retrait sonde (AMI 2) + retrait drain redon (AMI 2.8) — Avenant 6",
        "Surveillance cathéter périnerveux (AMI 4.2) + retrait sonde + retrait drain redon",
        "Ponction veineuse (AMI 1.5) en contexte BSI/AIS — cumul taux plein avec forfait",
        "Téléconsultation TLS au décours d'un soin — taux plein"
    ],
    "actes_non_decotables_jamais": ["BSA", "BSB", "BSC", "DI", "TLS", "TLD", "TLL"]
}

REGLES_CIR9_2025 = {
    "date_application": "25/06/2025",
    "reference": "CIR-9/2025 — Circulaire CNAM",
    "regles": [
        "AMI 14 ou AMI 15 = forfait JOURNALIER (1× par jour par patient max)",
        "Si 2 perfusions longues le même jour: 1ère = AMI 14/15, 2ème = AMI 4.1",
        "AMI 5 réservé au RETRAIT DÉFINITIF de dispositif ≥24h (PICC, MidLine, chambre)",
        "AMI 4.1 cote: changement flacon, branchement Y, débranchement, déplacement, contrôle débit",
        "Cumul perfusion courte (AMI 9/10) + perfusion longue (AMI 14/15) = TAUX PLEIN une seule fois/jour"
    ],
    "interdits": [
        "AMI 14 + AMI 15 même jour (garder AMI 15 si cancer/immunodéprimé)",
        "2× AMI 14 ou 2× AMI 15 même jour"
    ],
    "exemples": [
        {"cas": "Perf 12h matin + perf 12h soir (non cancéreux) sur 7 jours",
         "cotation": "J1-J6 matin: AMI 14. J1-J6 soir: AMI 4.1. J7 matin: AMI 14. J7 soir: AMI 5 (retrait définitif)"},
        {"cas": "Patient cancéreux PICC 3 jours",
         "cotation": "Matin: AMI 10 (antalgique) + AMI 15 (NaCl). Soir: AMI 10 + AMI 4.1. Dernier soir: AMI 5"}
    ]
}

# ─── INCOMPATIBILITÉS GLOBALES ────────────────────────────────────
INCOMPATIBILITES = [
    {"codes": ["AIS3", "AIS3.1", "AIS4", "BSA"], "msg": "AIS + BSA interdits — cumul exclu", "severity": "critical"},
    {"codes": ["AIS3", "AIS3.1", "AIS4", "BSB"], "msg": "AIS + BSB interdits — cumul exclu", "severity": "critical"},
    {"codes": ["AIS3", "AIS3.1", "AIS4", "BSC"], "msg": "AIS + BSC interdits — cumul exclu", "severity": "critical"},
    {"codes": ["BSA", "BSB"], "msg": "BSA + BSB exclusifs — un seul BSI/jour", "severity": "critical"},
    {"codes": ["BSA", "BSC"], "msg": "BSA + BSC exclusifs — un seul BSI/jour", "severity": "critical"},
    {"codes": ["BSB", "BSC"], "msg": "BSB + BSC exclusifs — un seul BSI/jour", "severity": "critical"},
    {"codes": ["NUIT", "NUIT_PROF"], "msg": "NUIT + NUIT_PROF exclusifs — garder NUIT_PROF", "severity": "warning"},
    {"codes": ["NUIT", "DIM"], "msg": "NUIT + DIM exclusifs — non cumulables", "severity": "warning"},
    {"codes": ["NUIT_PROF", "DIM"], "msg": "NUIT_PROF + DIM exclusifs — garder NUIT_PROF", "severity": "warning"},
    {"codes": ["AMI14", "AMI15"], "msg": "CIR-9/2025 — AMI14 + AMI15 même jour interdits, garder AMI15 si cancer", "severity": "critical"},
    {"codes": ["MCI", "BSA"], "msg": "MCI + BSI interdit", "severity": "critical"},
    {"codes": ["MCI", "BSB"], "msg": "MCI + BSI interdit", "severity": "critical"},
    {"codes": ["MCI", "BSC"], "msg": "MCI + BSI interdit", "severity": "critical"},
    {"codes": ["MAU", "BSA"], "msg": "MAU + BSI interdit", "severity": "critical"},
    {"codes": ["MAU", "BSB"], "msg": "MAU + BSI interdit", "severity": "critical"},
    {"codes": ["MAU", "BSC"], "msg": "MAU + BSI interdit", "severity": "critical"},
    {"codes": ["MAU", "MCI"], "msg": "MAU + MCI non cumulables", "severity": "warning"},
    {"codes": ["AMI3.9", "AMI4.2"], "msg": "AMI 3.9 + AMI 4.2 (surveillances post-op) non cumulables entre elles", "severity": "warning"},
    {"codes": ["AMI3", "AMI3.5"], "msg": "Cathétérisme + éducation autosondage non cumulables (Chap I art 6)", "severity": "warning"},
    {"codes": ["AMI4", "AMI3.5"], "msg": "Cathétérisme H + éducation autosondage non cumulables", "severity": "warning"},
    {"codes": ["AMI4", "AMI4.5"], "msg": "Cathétérisme H + réadaptation vessie non cumulables", "severity": "warning"},
    {"codes": ["AMI3", "AMI4.5"], "msg": "Cathétérisme F + réadaptation vessie non cumulables", "severity": "warning"},
    {"codes": ["AMI11", "MCI"], "msg": "Bilan plaie initial (AMI 11) NON cumulable avec MCI", "severity": "warning"},
]

# ─── DÉROGATIONS TAUX PLEIN ───────────────────────────────────────
DEROGATIONS_TAUX_PLEIN = [
    {"codes_groupe_a": ["AMI4", "AMI11", "AMI5.1", "AMI4.6", "AMI2.1"],
     "codes_groupe_b": ["AMI1.1"],
     "msg": "Pansement complexe + analgésie topique = cumul taux plein (Chap I art 3)"},
    {"codes_groupe_a": ["AMI3.9"],
     "codes_groupe_b": ["AMI2", "AMI2.8"],
     "msg": "Surveillance post-op + retrait sonde/drain = cumul taux plein (Avenant 6 — Chap II art 7)"},
    {"codes_groupe_a": ["AMI4.2"],
     "codes_groupe_b": ["AMI2", "AMI2.8"],
     "msg": "Cathéter périnerveux + retrait sonde/drain = cumul taux plein (Avenant 6 — Chap II art 7)"},
    {"codes_groupe_a": ["AIS3", "BSA", "BSB", "BSC"],
     "codes_groupe_b": ["AMI9", "AMI10", "AMI14", "AMI15", "AMI5", "AMI4.1", "AMI6"],
     "msg": "BSI/AIS + perfusion = cumul taux plein (dérogation Chap II art 3-5)"},
    {"codes_groupe_a": ["AIS3", "BSA", "BSB", "BSC"],
     "codes_groupe_b": ["AMI4", "AMI11", "AMI5.1", "AMI4.6"],
     "msg": "BSI/AIS + pansement complexe = cumul taux plein"},
    {"codes_groupe_a": ["AIS3", "BSA", "BSB", "BSC"],
     "codes_groupe_b": ["AMI5.8"],
     "msg": "BSI/AIS + surveillance BPCO/IC = cumul taux plein"},
    {"codes_groupe_a": ["AIS3", "BSA", "BSB", "BSC"],
     "codes_groupe_b": ["AMI1.5"],
     "msg": "BSI/AIS + ponction veineuse = cumul taux plein"},
    {"codes_groupe_a": ["AMI1_SURV_DIAB_INSULINO", "AMI1_INJ_INSULINE", "AMI4_PANS_PIED_DIAB", "AMI1.1"],
     "codes_groupe_b": ["mêmes codes"],
     "msg": "Article 5bis (insulino-traité): tous les actes cumulent à taux plein entre eux"},
]

# ─── RÉFÉRENTIEL FINAL ────────────────────────────────────────────
REFERENTIEL = {
    "version": "NGAP_2026.3_CIR9_2025",
    "source": "Titre XVI NGAP - ameli.fr - intègre arrêtés UNCAM jusqu'au 08/02/2023 + Circulaire CIR-9/2025",
    "date_compilation": "2026-04-23",
    "lettres_cles": LETTRES_CLES,
    "forfaits_bsi": FORFAITS_BSI,
    "forfaits_di": FORFAITS_DI,
    "deplacements": DEPLACEMENTS,
    "ik_plafonnement": IK_PLAFONNEMENT,
    "majorations": MAJORATIONS,
    "telesoin": TELESOIN,
    "actes_chapitre_I": CHAP_I,
    "actes_chapitre_II": CHAP_II,
    "regles_article_11B": REGLES_ART_11B,
    "regles_cir9_2025": REGLES_CIR9_2025,
    "incompatibilites": INCOMPATIBILITES,
    "derogations_taux_plein": DEROGATIONS_TAUX_PLEIN,
    "note_5bis": ART_II_5BIS_NOTE,
}

# Stats
total_actes = len(CHAP_I) + len(CHAP_II)
print(f"📊 Référentiel NGAP 2026.3 généré")
print(f"   - {len(CHAP_I)} actes Chapitre I (Soins de pratique courante)")
print(f"   - {len(CHAP_II)} actes Chapitre II (Soins spécialisés)")
print(f"   - Total : {total_actes} actes structurés")
print(f"   - {len(INCOMPATIBILITES)} règles d'incompatibilité")
print(f"   - {len(DEROGATIONS_TAUX_PLEIN)} dérogations taux plein article 11B")
print(f"   - {len(MAJORATIONS)} majorations")
print(f"   - {len(TELESOIN)} actes télésoin (Avenant 9)")
print(f"   - {len(FORFAITS_BSI)} forfaits BSI + {len(FORFAITS_DI)} forfaits DI")
print(f"   - {len(LETTRES_CLES)} lettres-clés")

with open('/home/claude/ami/ref/ngap_referentiel_2026.json', 'w', encoding='utf-8') as f:
    json.dump(REFERENTIEL, f, ensure_ascii=False, indent=2)

import os
size = os.path.getsize('/home/claude/ami/ref/ngap_referentiel_2026.json')
print(f"\n💾 Sauvegardé : /home/claude/ami/ref/ngap_referentiel_2026.json ({size:,} bytes)")
