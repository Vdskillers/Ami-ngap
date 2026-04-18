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

| Pathologie détectée | Actes NGAP générés |
| Diabète (type 1/2) | Injection insuline SC|
| Plaie / ulcère / escarre | Pansement complexe BSB, détersion |
| Anticoagulants / HBPM | Injection SC, surveillance INR |
| Perfusion / antibio | Perfusion IV domicile, IFD |
| Nursing / grabataire / Alzheimer | AMI 4, nursing complet, prévention escarre |
| HTA / insuffisance cardiaque | Prise TA, surveillance, éducation |
| Soins palliatifs | AMI 4, gestion douleur, nursing |
| Bilan sanguin / prélèvement | BSA, IFD |
| Sonde / stomie / trachéo | AMI 2, surveillance appareillage |
| Morphine / douleur | Injection antalgique, évaluation EVA |
| Asthme / BPCO | Aérosol, surveillance saturation, IFD |
| Post-op / chirurgie | Pansement, surveillance cicatrice |
| Psychiatrie / dépression | Suivi psychiatrique, éducation traitement |

> **Conseil** : renseignez le champ *Actes Récurrents* dès la création de la fiche patient pour des cotations automatiques encore plus précises. Le champ *Pathologies* reste utile comme filet de sécurité pour les patients dont vous n'avez pas encore détaillé les soins habituels.

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
| AMI 1 (injection, prélèvement…) | 3,15 € |
| AMI 4 (pansement complexe, perfusion) | 12,60 € |
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
Appuyez sur le bouton **GPS** sur la fiche patient de la tournée. Si l'adresse est bien géocodée, la navigation GPS démarre directement. Sinon, l'adresse texte est transmise à Google Maps / Plans.

### Qu'est-ce que le Mode Uber Médical ?
Ce mode affiche automatiquement le prochain patient à voir sans que vous ayez à interagir avec l'écran. Pratique entre deux soins.

### Comment facturer automatiquement en fin de tournée ?
Lorsque vous terminez la tournée, AMI vous propose de générer automatiquement les cotations pour tous les patients marqués comme "fait". Les montants estimés sont pré-remplis.

### La tournée fonctionne-t-elle hors-ligne ?
L'optimisation de la tournée et la navigation GPS fonctionnent hors-ligne si les tuiles de carte ont été téléchargées au préalable (dans **Paramètres** → **Télécharger la carte**).

---

## 💰 Trésorerie & Rapports

### Comment consulter mes revenus du mois ?
Dans **Trésorerie**, sélectionnez la période souhaitée. Vous voyez le total des cotations, la part AMO, la part AMC, la part patient, et une estimation des pertes (impayés estimés).

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

### Comment accéder au Copilote sur mobile ?
Sur mobile, le Copilote est accessible via le menu **Plus** → **Copilote IA**.

---

## 🎙️ Dictée vocale

### Comment dicter un soin ?
Dans **Cotation**, appuyez sur l'icône microphone 🎙️. Dictez le soin normalement : *"Injection insuline sous-cutanée domicile ce matin"*. AMI transcrit et normalise automatiquement le texte médical.

### La dictée vocale fonctionne-t-elle hors-ligne ?
Oui. La reconnaissance vocale utilise l'API native de votre appareil, qui fonctionne hors-ligne sur la plupart des téléphones récents.

---

## 🛠️ Outils professionnels

### Quels outils professionnels sont disponibles ?
Dans **Outils IDEL** :
- **Simulateur de charges** : calcul annuel URSSAF + CARPIMKO + IR selon votre CA — barème 2026
- **Journal kilométrique** : saisie trajets, barème IK selon la puissance fiscale, export CSV pour déclaration
- **Modèles de soins** : créez des descriptions réutilisables (ex. : "pansement escarre jambe gauche") pour coter en 1 clic
- **Simulateur de majorations** : entrez l'heure et le type de soin pour connaître instantanément les majorations applicables
- **Suivi ordonnances** : enregistrez vos ordonnances, AMI vous alerte 30 jours avant expiration

### Comment créer un modèle de soin ?
Dans **Outils IDEL** → **Modèles de soins** → **+ Nouveau modèle**. Donnez un nom et une description complète. Depuis la cotation, tapez le nom du modèle pour l'utiliser directement.

---

## 📡 Hors-ligne & PWA

### AMI fonctionne-t-il sans internet ?
Pour la plupart des fonctions, oui : carnet patients, tournée (avec carte pré-téléchargée), dictée vocale, consultation des cotations. La cotation IA nécessite une connexion pour les calculs NGAP précis, mais une estimation locale est disponible en cas de coupure.

### Comment installer AMI sur mon téléphone ?
Sur Chrome (Android) ou Safari (iPhone) : une bannière d'installation apparaît automatiquement. Sinon, menu du navigateur → **Ajouter à l'écran d'accueil**. AMI se comporte comme une application native.

### Comment télécharger la carte pour utilisation hors-ligne ?
Dans **Paramètres** (ou **Profil**) → **Télécharger les tuiles de carte**. Sélectionnez votre zone géographique. La carte est ensuite disponible sans connexion.

---

## ❓ Problèmes fréquents

### L'IA répond "indisponible" — que faire ?
Cela arrive rarement (surcharge momentanée du serveur IA). AMI bascule automatiquement sur un calcul local de secours. Le résultat peut être moins précis sur les cas complexes — vérifiez manuellement les majorations. Réessayez dans quelques minutes pour un calcul IA complet.

### Ma tournée ne s'affiche pas sur la carte — que faire ?
Vérifiez que vos patients ont une adresse complète (numéro + rue + code postal + ville). Si l'adresse n'est pas géocodée, appuyez sur **Recalculer position** depuis la fiche patient.

### Un patient a disparu de mon carnet — pourquoi ?
Si vous utilisez AMI sur plusieurs appareils, chaque appareil a sa propre base locale. Les données ne sont pas automatiquement synchronisées d'un appareil à l'autre (par choix de confidentialité). Utilisez **Export** sur l'appareil source et **Import** sur le nouvel appareil.

### Je ne reçois plus les alertes d'ordonnances expirantes ?
Vérifiez que les notifications sont autorisées pour AMI dans les réglages de votre téléphone. Sur iPhone : Réglages → Notifications → AMI → Autoriser.

### Comment changer mon mot de passe ?
Dans **Profil** → **Changer le mot de passe**. L'ancien mot de passe est requis pour confirmer.

### Comment supprimer mon compte ?
Dans **Profil** → **Supprimer mon compte**. Cette action est irréversible et supprime toutes vos cotations du serveur. Vos données locales (patients, signatures) restent sur votre appareil jusqu'à désinstallation.

---

## 📞 Contacter le support

Depuis l'application : **Menu** → **Contact** → rédigez votre message. L'équipe AMI vous répond sous 24–48h ouvrées.

---

*Guide AMI v7 — NGAP 2026 · Mise à jour : avril 2026*
