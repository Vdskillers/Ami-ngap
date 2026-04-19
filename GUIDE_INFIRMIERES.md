# AMI — Guide pratique & FAQ Infirmières

> Tout ce que vous devez savoir pour utiliser AMI au quotidien.  
> Application pour infirmières libérales — NGAP 2026 · Données stockées sur votre appareil uniquement.

---

## 🔐 Connexion & Sécurité

### Comment me connecter ?
Saisissez votre email et mot de passe sur l'écran de connexion. Une fois connectée, AMI mémorise votre session. Vous n'avez pas à vous reconnecter à chaque fois.

### Qu'est-ce que le PIN local ?
Après connexion, vous pouvez définir un code PIN à 4 chiffres. Ce PIN verrouille l'app sans vous déconnecter : si vous posez votre téléphone, l'app se verrouille automatiquement. Pour déverrouiller, entrez simplement votre PIN — vos données restent sur place.

### Mes données sont-elles transmises à un serveur ?
**Non.** Vos fiches patients et signatures sont stockées exclusivement sur votre appareil (chiffrées AES-256). Elles ne transitent jamais par nos serveurs. Seules les cotations (codes NGAP + montants) sont synchronisées avec votre espace personnel pour vous permettre de consulter votre historique depuis n'importe quel appareil.

### Que se passe-t-il si je me déconnecte ?
Vos données patients restent sur votre appareil. La déconnexion ferme simplement la session — elle n'efface rien. À la prochaine connexion, tout est là.

### Une autre infirmière peut-elle voir mes patients ?
Non. AMI est conçu pour un usage partagé sur le même appareil : chaque infirmière a sa propre base de données isolée. Personne d'autre ne peut y accéder.

---

## 🧑‍⚕️ Carnet patients

### Comment ajouter un patient ?
Allez dans **Carnet** → bouton **+ Nouveau patient**. Renseignez le nom, prénom, adresse, et les informations de couverture AMO/AMC. Le géocodage de l'adresse se fait automatiquement pour la tournée.

### Comment modifier un patient ?
Dans le carnet, appuyez sur la fiche du patient → icône crayon. Modifiez les champs souhaités et sauvegardez.

### Comment supprimer un patient ?
Ouvrez la fiche patient → menu **⋮** → Supprimer. Une confirmation est demandée.

### Puis-je ajouter des notes à un patient ?
Oui. Sur la fiche patient, section **Notes** : quatre catégories disponibles — Général, Accès (code porte, ascenseur…), Médical, Urgent. Les notes urgentes apparaissent en rouge en haut de la fiche.

### Comment retrouver un patient rapidement ?
Utilisez la barre de recherche en haut du carnet. La recherche porte sur le nom, le prénom et l'adresse.

### Puis-je exporter mes données patients ?
Oui. Dans **Profil** → **Exporter mes données**. Vous obtenez un fichier JSON chiffré que vous pouvez conserver comme sauvegarde.

### À quoi sert le champ « Actes Récurrents à Réaliser » ?
Ce champ, présent dans chaque fiche patient, permet de décrire en langage naturel les soins habituels du patient (ex. : *"Injection insuline SC 2x/jour + surveillance glycémie"*). Il est utilisé automatiquement par la **Tournée IA** et le **Pilotage de journée** pour générer les cotations sans que vous ayez à retaper la description à chaque passage.

### Que se passe-t-il si le champ « Actes Récurrents » est vide ?
💡 Si ce champ est vide, AMI utilise automatiquement le champ **Pathologies** et le convertit en actes médicaux NGAP applicables pour générer la cotation lors de la Tournée IA et du Pilotage de journée.

AMI reconnaît un large spectre de pathologies et d'abréviations médicales courantes :

| Pathologie / Abréviation reconnue | Actes NGAP générés automatiquement |
|---|---|
| Diabète, DT1, DT2, DNID, DID, T1D, T2D | Injection insuline SC, surveillance glycémie capillaire, éducation thérapeutique |
| Plaie, ulcère, escarre, nécrose, brûlure, fistule | Pansement complexe, détersion, surveillance plaie, IFD |
| Anticoagulants, HBPM, AVK, AOD, NACO, Lovenox, apixaban, dabigatran, rivaroxaban | Injection SC HBPM, surveillance INR, éducation anticoagulant |
| Perfusion, antibiotique, chimio, KT, VVP, VVC, cathéter central, nutrition parentérale | Perfusion IV domicile, IFD, surveillance tolérance et abord veineux |
| Nursing, grabataire, dépendance, GIR 1-4, Alzheimer, Parkinson, tétraplégie, hémiplégie, SLA | Nursing complet, AMI 4, aide toilette BSC, prévention escarres |
| HTA, hypertension, IC, insuffisance cardiaque, FA, ACFA, SCA, IDM, post-IDM, angor | Prise TA, surveillance cardiaque, surveillance poids/œdèmes, éducation traitement |
| Soins palliatifs, fin de vie, phase terminale, cancer terminal | Soins palliatifs, AMI 4, gestion douleur, nursing complet, surveillance EVA |
| NFS, CRP, HbA1c, INR, bilan sanguin, prélèvement, glycémie capillaire | Prélèvement veineux à domicile, BSA, IFD |
| Sonde urinaire, SAD, stomie, colostomie, trachéotomie, gastrostomie, PEG, SNG | Soin appareillage, surveillance et entretien sonde, AMI 2 |
| Douleur, morphine, oxycodone, antalgique, PCA, patch morphine | Injection antalgique SC/IV, surveillance EVA, gestion PCA |
| Asthme, BPCO, MPOC, VNI, OHD, oxygénothérapie, aérosol, nébulisation, dyspnée | Aérosol médicamenteux, surveillance saturation SpO2, éducation inhalateurs |
| Post-op, chirurgie, TVP, EP, embolie pulmonaire, phlébite, suture, agrafes, drain | Soins post-opératoires, pansement, surveillance cicatrice, injection HBPM si prescrite |
| Psychiatrie, dépression, schizophrénie, trouble bipolaire, TSA, addiction | Suivi infirmier psychiatrique, surveillance observance, éducation thérapeutique |
| IRC, IRT, MRC, DFG, hémodialyse, dialyse péritonéale | Surveillance paramètres rénaux, TA, poids/œdèmes, gestion fistule si dialyse |
| Cancer, lymphome, leucémie, tumeur, néoplasie, HAD oncologique | Soins oncologiques, perfusion chimio, surveillance tolérance, gestion cathéter |
| AVC, AIT, SEP, SLA, séquelles AVC, neuropathie | Soins rééducation infirmière, nursing, surveillance neurologique, prévention escarres |
| Insuffisance veineuse, lymphœdème, bandage compressif, contention | Pose bandage compressif, soins de contention, surveillance circulation |
| NE, NP, nutrition entérale/parentérale, dénutrition, sonde naso-gastrique | Gestion nutrition, entretien sonde, surveillance digestive |
| HBP, LUTS, rétention urinaire, incontinence, troubles mictionnels | Sondage urinaire évacuateur, soins SAD, éducation patient |
| SAS, SAOS, PPC, CPAP, BPAP, apnée du sommeil | Surveillance appareillage PPC/VNI, éducation utilisation masque |
| Prévention escarre, Braden, matelas anti-escarre, risque cutané | Soins préventifs escarres, nursing, changements de position, éducation aidants |
| SSIAD, HAD, maintien à domicile, sortie d'hospit, retour domicile | Soins infirmiers à domicile, évaluation globale, coordination HAD/SSIAD |

> **Conseil :** renseignez le champ *Actes Récurrents* dès la création de la fiche patient pour des cotations automatiques encore plus précises. Le champ *Pathologies* est le filet de sécurité pour les patients dont vous n'avez pas encore détaillé les soins habituels.

> **Note :** si la pathologie n'est pas reconnue, AMI transmet quand même le texte brut à l'IA pour qu'elle tente une cotation par contexte.

---

## 💊 Cotation NGAP

### Comment coter une séance ?
Allez dans **Cotation** → décrivez le soin en texte libre (ex. : *"injection insuline domicile matin"*) ou sélectionnez les actes dans la liste. Appuyez sur **⚡ Coter avec l'IA**.

L'IA calcule automatiquement : les codes NGAP, les coefficients, les majorations (IFD, nuit, dimanche, enfant…), le total, la part AMO et la part patient.

### L'IA peut-elle se tromper ?
L'IA est très fiable sur les cas courants, mais vous pouvez toujours vérifier en appuyant sur **Vérifier avec l'IA** après le résultat. Vous pouvez aussi modifier manuellement les actes avant d'imprimer.

### Qu'est-ce que l'alerte rouge "RISQUE CPAM ÉLEVÉ" ?
AMI détecte automatiquement les configurations à risque (acte complexe sans justification, BSI sans dépendance documentée, schéma répétitif…). Cette alerte vous invite à vérifier la cotation avant de l'envoyer. Elle ne bloque pas votre facturation.

### Comment imprimer une facture ?
Une fois la cotation affichée, appuyez sur **Imprimer**. Un numéro de facture séquentiel est généré automatiquement (ex. : F2026-001234).

### Puis-je corriger une cotation déjà enregistrée ?
Oui. Depuis la fiche patient, ouvrez la cotation concernée → **Modifier**. La correction met à jour la cotation existante sans créer de doublon.

### Que se passe-t-il si je n'ai pas internet pendant une séance ?
AMI enregistre la cotation dans une file d'attente hors-ligne. Dès que la connexion revient, la synchronisation se fait automatiquement. Un badge indique le nombre de cotations en attente.

### Quels sont les tarifs 2026 intégrés ?

| Acte | Tarif |
|---|---|
| AMI 1 (injection, prélèvement…) | 3,15 € |
| AMI 4 (pansement complexe, perfusion) | 12,60 € |
| AMI 6 (perfusion longue durée > 1h) | 18,90 € |
| BSA (dépendance légère) | 13,00 € |
| BSB (dépendance intermédiaire) | 18,20 € |
| BSC (dépendance lourde) | 28,70 € |
| IFD (déplacement domicile) | 2,75 € |
| MCI (coordination infirmière) | 5,00 € |
| MIE (majoration enfant < 7 ans) | 3,15 € |
| Majoration nuit (20h–23h, 5h–7h) | 9,15 € |
| Majoration nuit profonde (23h–5h) | 18,30 € |
| Majoration dimanche/férié | 8,50 € |
| IK (indemnité kilométrique) | km × 2 × 0,35 € |

---

## ✍️ Signatures électroniques

### Comment faire signer un patient ?
Allez dans **Signatures** → **Nouvelle signature**. Entrez le numéro de facture, puis le patient signe directement sur l'écran tactile de votre téléphone/tablette. La signature est enregistrée chiffrée sur votre appareil.

### Les signatures sont-elles stockées sur le serveur ?
Non. Comme les fiches patients, les signatures sont exclusivement sur votre appareil (IndexedDB chiffré).

### Puis-je retrouver une signature ancienne ?
Oui, dans **Signatures** → liste des signatures. Filtrez par date ou numéro de facture.

---

## 🗺️ Tournée

### Comment créer ma tournée ?
Dans **Tournée**, appuyez sur **Optimiser ma tournée**. L'IA calcule l'ordre optimal de passage en tenant compte du trafic selon l'heure de la journée (données CEREMA). Vous pouvez aussi importer un fichier ICS (agenda) ou CSV.

### Puis-je ajouter un patient urgent en cours de tournée ?
Oui. En mode **Pilotage live**, bouton **+ Urgent** : le patient est inséré au meilleur endroit dans la tournée restante sans tout recalculer.

### Comment naviguer vers un patient ?
Appuyez sur le bouton **GPS** sur la fiche patient de la tournée. Si l'adresse est bien géocodée, la navigation GPS démarre directement.

### Comment AMI génère-t-il la cotation automatiquement pendant la tournée ?
Quand vous appuyez sur **Coter** pour un patient pendant le pilotage, AMI construit le texte de soin dans cet ordre de priorité :

1. **Actes récurrents** de la fiche patient (le plus précis)
2. **Description importée** — si elle contient déjà des actes NGAP explicites
3. **Pathologies converties** — si la description est une pathologie brute (ex : "Diabète"), AMI l'enrichit automatiquement avec les actes correspondants avant de les envoyer à l'IA

### Qu'est-ce que le Mode Uber Médical ?
Ce mode affiche automatiquement le prochain patient à voir sans que vous ayez à interagir avec l'écran. Pratique entre deux soins.

### Comment facturer automatiquement en fin de tournée ?
Lorsque vous terminez la tournée, AMI vous propose de générer automatiquement les cotations pour tous les patients marqués comme "fait".

### La tournée fonctionne-t-elle hors-ligne ?
L'optimisation de la tournée et la navigation GPS fonctionnent hors-ligne si les tuiles de carte ont été téléchargées au préalable (dans **Paramètres** → **Télécharger la carte**).

---

## 🏥 Mode Cabinet multi-IDE

### Qu'est-ce que le mode Cabinet ?
Le mode Cabinet permet à plusieurs infirmières d'un même cabinet de coordonner leurs tournées, répartir les patients et partager les cotations multi-IDE. Un toggle **Mode Cabinet** apparaît dans la cotation et la tournée dès que vous êtes membre d'un cabinet.

### Comment créer ou rejoindre un cabinet ?
Dans **Mon Cabinet** → **Créer un cabinet** (vous obtenez un ID à partager) ou **Rejoindre** (entrez l'ID reçu d'une collègue).

### Comment fonctionne la synchronisation cabinet ?
Vous choisissez explicitement **quoi** synchroniser (planning, patients, cotations, ordonnances…) et **avec qui**. Rien n'est partagé sans votre accord.

---

## 📊 Modules cliniques

### Constantes patients
Suivez les paramètres vitaux de vos patients (TA, glycémie, SpO2, T°, FC, EVA, poids) avec des graphiques Canvas et des alertes automatiques en rouge si les valeurs sont hors des seuils ANSM.

### Pilulier / Semainier
Créez des semainiers médicamenteux personnalisés pour chaque patient (7 jours × 4 prises). Impression directe pour remettre au patient ou à la famille.

### BSI — Bilan de Soins Infirmiers
Évaluez le niveau de dépendance en 10 critères. AMI calcule automatiquement le niveau BSI 1/2/3 et pré-remplit la cotation. Alerte de renouvellement à 90 jours.

### Consentements éclairés
6 types de consentements disponibles (sonde urinaire, perfusion, soins palliatifs, photo de plaie, pansement complexe, injections). Signature canvas + archivage local.

### Alertes médicamenteuses
Détection automatique des interactions médicamenteuses à risque (14 règles ANSM 2026) dès que vous saisissez un soin. Niveaux : CI (contre-indication absolue), DANGER, ATTENTION.

### Simulateur audit CPAM
Analysez votre historique de cotations sur 3, 6 ou 12 mois et simulez un contrôle CPAM selon 8 règles NGAP. Identifiez les risques avant qu'ils ne deviennent un problème.

### Compte-rendu de passage
Rédigez et archivez vos comptes-rendus de passage (constantes, actes réalisés, transmissions, niveau d'urgence). Impression PDF incluse.

### Transmissions infirmières
Rédigez vos transmissions en format SOAP ou DAR, adressez-les à une IDE spécifique ou à tout le cabinet. Badge de notifications pour les transmissions non lues.

---

## 💰 Trésorerie & Rapports

### Comment consulter mes revenus du mois ?
Dans **Trésorerie**, sélectionnez la période souhaitée. Vous voyez le total des cotations, la part AMO, la part AMC, la part patient, et une estimation des pertes.

### Comment générer mon rapport mensuel ?
Dans **Rapport mensuel** → sélectionnez le mois → **Générer**. Vous obtenez un rapport PDF imprimable avec le récapitulatif NGAP, les statistiques et un état de santé de l'application.

### Puis-je exporter pour mon comptable ?
Oui. Dans **Trésorerie** → **Export comptable** : génère un fichier CSV avec toutes les cotations de la période, compatible tableur.

---

## 🤖 Copilote IA

### À quoi sert le Copilote IA ?
Le Copilote est un assistant conversationnel spécialisé NGAP. Posez-lui des questions comme : *"Comment coter une perfusion longue durée ?"*, *"Puis-je facturer IFD et IK ensemble ?"*, *"Quel code pour un pansement d'escarre ?"*.

### Le Copilote a-t-il accès à mes données patients ?
Non. Le Copilote répond à des questions générales sur la nomenclature NGAP. Il n'accède pas à votre carnet patients.

---

## 🎙️ Dictée vocale

### Comment dicter un soin ?
Dans **Cotation**, appuyez sur l'icône microphone 🎙️. Dictez le soin normalement : *"Injection insuline sous-cutanée domicile ce matin"*. AMI transcrit et normalise automatiquement le texte médical.

### La dictée vocale fonctionne-t-elle hors-ligne ?
Oui. La reconnaissance vocale utilise l'API native de votre appareil, qui fonctionne hors-ligne sur la plupart des téléphones récents.

---

## 🛠️ Outils professionnels

### Quels outils professionnels sont disponibles ?

- **Simulateur de charges** : calcul annuel URSSAF + CARPIMKO + IR selon votre CA — barème 2026
- **Journal kilométrique** : saisie trajets, barème IK selon la puissance fiscale, export CSV pour déclaration
- **Modèles de soins** : créez des descriptions réutilisables pour coter en 1 clic
- **Simulateur de majorations** : entrez l'heure et le type de soin pour connaître instantanément les majorations applicables
- **Suivi ordonnances** : enregistrez vos ordonnances, AMI vous alerte 30 jours avant expiration

---

## 📡 Hors-ligne & PWA

### AMI fonctionne-t-il sans internet ?
Pour la plupart des fonctions, oui : carnet patients, tournée (avec carte pré-téléchargée), dictée vocale, consultation des cotations. La cotation IA nécessite une connexion pour les calculs NGAP précis, mais une estimation locale est disponible en cas de coupure.

### Comment installer AMI sur mon téléphone ?
Sur Chrome (Android) ou Safari (iPhone) : une bannière d'installation apparaît automatiquement. Sinon, menu du navigateur → **Ajouter à l'écran d'accueil**. AMI se comporte comme une application native.

---

## ❓ Problèmes fréquents

### L'IA répond "indisponible" — que faire ?
Cela arrive rarement (surcharge momentanée du serveur IA). AMI bascule automatiquement sur un calcul local de secours. Le résultat peut être moins précis sur les cas complexes — vérifiez manuellement les majorations. Réessayez dans quelques minutes pour un calcul IA complet.

### La cotation ne génère que la majoration dimanche sans l'acte principal — pourquoi ?
Vérifiez que le champ **Pathologies** ou **Actes Récurrents** de la fiche patient est bien renseigné. Si le champ contient uniquement un mot très court comme "Diabète", AMI v6.1 l'enrichit automatiquement avec les actes correspondants. Si le problème persiste, renseignez directement les actes dans le champ **Actes Récurrents** (ex : *"Injection insuline SC 2x/jour"*).

### Ma tournée ne s'affiche pas sur la carte — que faire ?
Vérifiez que vos patients ont une adresse complète (numéro + rue + code postal + ville). Si l'adresse n'est pas géocodée, appuyez sur **Recalculer position** depuis la fiche patient.

### Un patient a disparu de mon carnet — pourquoi ?
Si vous utilisez AMI sur plusieurs appareils, chaque appareil a sa propre base locale. Les données ne sont pas automatiquement synchronisées d'un appareil à l'autre (par choix de confidentialité). Utilisez **Export** sur l'appareil source et **Import** sur le nouvel appareil.

### Comment changer mon mot de passe ?
Dans **Profil** → **Changer le mot de passe**. L'ancien mot de passe est requis pour confirmer.

### Comment supprimer mon compte ?
Dans **Profil** → **Supprimer mon compte**. Cette action est irréversible et supprime toutes vos cotations du serveur. Vos données locales (patients, signatures) restent sur votre appareil jusqu'à désinstallation.

---

## 📞 Contacter le support

Depuis l'application : **Menu** → **Contact** → rédigez votre message. L'équipe AMI vous répond sous 24–48h ouvrées.

---

*Guide AMI v2.0 — NGAP 2026 · Mise à jour : avril 2026*
