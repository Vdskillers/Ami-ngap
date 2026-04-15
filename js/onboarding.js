/* ════════════════════════════════════════════════
   onboarding.js — AMI NGAP
   ────────────────────────────────────────────────
   Système d'introduction contextuelle
   - Intro principale (cotation) au premier login
   - Intros de sections : Carnet patients, Tournée IA, Pilotage de journée
   - Chaque intro est déclenchée une seule fois (localStorage par userId)
   - Bouton "📖 Revoir l'intro" disponible sur chaque section concernée
   ────────────────────────────────────────────────
   Clés localStorage :
     ami_intro_main_<userId>      → intro principale vue
     ami_intro_patients_<userId>  → intro Carnet patients vue
     ami_intro_tournee_<userId>   → intro Tournée IA vue
     ami_intro_live_<userId>      → intro Pilotage de journée vue
════════════════════════════════════════════════ */

/* ── Helpers ─────────────────────────────────── */
function _introKey(name) {
  const uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : 'guest';
  return `ami_intro_${name}_${uid}`;
}
function _introSeen(name)  { return !!localStorage.getItem(_introKey(name)); }
function _introMarkSeen(name) { try { localStorage.setItem(_introKey(name), '1'); } catch {} }
function _introClear(name) { try { localStorage.removeItem(_introKey(name)); } catch {} }

/* ════════════════════════════════════════════════
   MOTEUR GÉNÉRIQUE — modale d'intro à slides
════════════════════════════════════════════════ */
let _introCurrentStep = 0;
let _introSteps = [];
let _introKey_current = '';
let _introOnClose = null;

function _showIntroModal(key, steps, onClose) {
  _introKey_current = key;
  _introSteps = steps;
  _introCurrentStep = 0;
  _introOnClose = onClose || null;

  // Créer ou réutiliser la modale
  let modal = document.getElementById('ami-intro-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ami-intro-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(11,15,20,.88);backdrop-filter:blur(10px);padding:20px';
    modal.innerHTML = `
      <div id="ami-intro-card" style="background:var(--c,#111827);border:1px solid var(--b,#1e2d3d);border-radius:16px;width:100%;max-width:520px;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden">
        <!-- Barre de progression -->
        <div id="ami-intro-progress" style="height:3px;background:rgba(0,212,170,.15)">
          <div id="ami-intro-progress-bar" style="height:100%;background:var(--a,#00d4aa);transition:width .3s ease;width:0%"></div>
        </div>
        <!-- Contenu -->
        <div id="ami-intro-content" style="padding:28px 28px 20px"></div>
        <!-- Footer -->
        <div id="ami-intro-footer" style="padding:16px 28px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--b,#1e2d3d)">
          <div id="ami-intro-dots" style="display:flex;gap:6px"></div>
          <div style="display:flex;gap:8px">
            <button id="ami-intro-skip" onclick="_introSkip()" style="background:none;border:1px solid var(--b,#1e2d3d);color:var(--m,#6b7a8d);font-size:12px;padding:7px 16px;border-radius:8px;cursor:pointer;font-family:var(--fm,monospace);transition:all .15s" onmouseenter="this.style.borderColor='rgba(0,212,170,.3)'" onmouseleave="this.style.borderColor='var(--b)'">Ignorer</button>
            <button id="ami-intro-next" onclick="_introNext()" style="background:var(--a,#00d4aa);color:#0b0f14;border:none;font-size:13px;font-weight:700;padding:8px 20px;border-radius:8px;cursor:pointer;font-family:var(--fi,sans-serif);transition:all .15s" onmouseenter="this.style.opacity='.88'" onmouseleave="this.style.opacity='1'">Suivant →</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // Fermer en cliquant hors de la carte
    modal.addEventListener('click', function(e) {
      if (e.target === modal) _introSkip();
    });
  }

  modal.style.display = 'flex';
  _introRenderStep();
}

function _introRenderStep() {
  const step   = _introSteps[_introCurrentStep];
  const total  = _introSteps.length;
  const isLast = _introCurrentStep === total - 1;

  // Contenu
  const content = document.getElementById('ami-intro-content');
  if (content) {
    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
        <div style="width:48px;height:48px;border-radius:12px;background:${step.bg||'rgba(0,212,170,.12)'};display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0">${step.icon}</div>
        <div>
          <div style="font-family:var(--fs,serif);font-size:20px;color:var(--t,#e8edf2);margin-bottom:2px">${step.title}</div>
          ${step.badge ? `<span style="font-size:10px;font-family:var(--fm,monospace);color:var(--a,#00d4aa);background:rgba(0,212,170,.1);padding:2px 8px;border-radius:20px;border:1px solid rgba(0,212,170,.2)">${step.badge}</span>` : ''}
        </div>
      </div>
      <div style="font-size:13px;color:var(--m,#8892a4);line-height:1.7">${step.body}</div>
      ${step.tip ? `<div style="margin-top:14px;padding:10px 14px;background:rgba(0,212,170,.06);border-left:3px solid var(--a,#00d4aa);border-radius:0 8px 8px 0;font-size:12px;color:var(--a,#00d4aa);font-family:var(--fm,monospace)">${step.tip}</div>` : ''}`;
  }

  // Barre de progression
  const bar = document.getElementById('ami-intro-progress-bar');
  if (bar) bar.style.width = `${(((_introCurrentStep + 1) / total) * 100).toFixed(0)}%`;

  // Dots
  const dots = document.getElementById('ami-intro-dots');
  if (dots) {
    dots.innerHTML = _introSteps.map((_, i) =>
      `<div style="width:${i===_introCurrentStep?'20px':'8px'};height:8px;border-radius:4px;background:${i===_introCurrentStep?'var(--a,#00d4aa)':'rgba(255,255,255,.12)'};transition:all .3s ease;cursor:pointer" onclick="_introGoTo(${i})"></div>`
    ).join('');
  }

  // Bouton suivant / terminer
  const btn = document.getElementById('ami-intro-next');
  if (btn) {
    btn.textContent = isLast ? 'Commencer ✓' : 'Suivant →';
    btn.style.background = isLast ? 'linear-gradient(135deg,var(--a,#00d4aa),#00b891)' : 'var(--a,#00d4aa)';
  }

  // Bouton ignorer
  const skip = document.getElementById('ami-intro-skip');
  if (skip) skip.style.display = isLast ? 'none' : 'inline-block';
}

function _introNext() {
  if (_introCurrentStep < _introSteps.length - 1) {
    _introCurrentStep++;
    _introRenderStep();
  } else {
    _introClose(true);
  }
}

function _introGoTo(i) {
  _introCurrentStep = i;
  _introRenderStep();
}

function _introSkip() {
  _introClose(false);
}

function _introClose(completed) {
  const modal = document.getElementById('ami-intro-modal');
  if (modal) modal.style.display = 'none';
  if (_introKey_current) _introMarkSeen(_introKey_current);
  if (typeof _introOnClose === 'function') _introOnClose(completed);
  _introKey_current = '';
  _introSteps = [];
}

/* ════════════════════════════════════════════════
   INTRO PRINCIPALE — Cotation (premier login)
════════════════════════════════════════════════ */
function checkOnboarding() {
  if (_introSeen('main')) return;
  setTimeout(() => showMainIntro(), 600);
}

function resetOnboarding() {
  _introClear('main');
  showMainIntro();
}

function showMainIntro() {
  const steps = [
    {
      icon: '👋',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Bienvenue',
      title: 'Bienvenue sur AMI',
      body: `<strong style="color:var(--t)">AMI</strong> est votre assistant de cotation NGAP intelligent. Il analyse vos descriptions de soins, calcule automatiquement les actes et majorations, et génère vos feuilles de soins — le tout en quelques secondes.<br><br>Ce guide rapide vous présente les fonctionnalités essentielles.`,
      tip: '💡 Cette intro est disponible à tout moment via le bouton "📖 Revoir l\'intro" en haut de la cotation.'
    },
    {
      icon: '⚡',
      bg: 'rgba(0,212,170,.12)',
      badge: 'IA NGAP 2026',
      title: 'Cotation intelligente',
      body: `Décrivez les soins en langage naturel dans le champ texte :<br><br><em style="color:var(--a)">"Injection insuline SC + prise de sang à domicile 22h dimanche, patient grabataire, 8km"</em><br><br>AMI détecte automatiquement <strong style="color:var(--t)">les actes NGAP</strong>, les <strong style="color:var(--t)">majorations</strong> (nuit, dimanche, IFD, IK) et les <strong style="color:var(--t)">incompatibilités</strong> à corriger.`,
      tip: '🔍 Utilisez "Vérifier & corriger" pour analyser votre description avant de coter.'
    },
    {
      icon: '👤',
      bg: 'rgba(0,212,170,.12)',
      badge: 'RGPD · 100% local',
      title: 'Carnet patients',
      body: `Enregistrez vos patients une fois pour les retrouver à chaque cotation. Le carnet patients vous permet de :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>🏠 Stocker les adresses pour l'<strong style="color:var(--t)">optimisation de tournée</strong></span>
          <span>📋 Gérer les <strong style="color:var(--t)">ordonnances</strong> et soins récurrents</span>
          <span>⚡ Pré-remplir automatiquement le formulaire de cotation</span>
          <span>📤 Importer directement dans la Tournée IA</span>
        </span>`,
      tip: '🔒 Toutes les données sont chiffrées AES-256 et stockées uniquement sur votre appareil.'
    },
    {
      icon: '🗺️',
      bg: 'rgba(0,212,170,.1)',
      badge: 'Tournée IA · GPS',
      title: 'Tournée optimisée par IA',
      body: `Importez votre planning (calendrier, Excel, texte libre…) et laissez AMI calculer l'<strong style="color:var(--t)">ordre de passage optimal</strong> :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>🚀 Minimise les kilomètres parcourus</span>
          <span>⏰ Respecte vos contraintes horaires (insuline à 7h30…)</span>
          <span>📍 Routage GPS réel via OSRM</span>
          <span>▶️ Démarrez ensuite le <strong style="color:var(--t)">Pilotage de journée</strong> en temps réel</span>
        </span>`,
    },
    {
      icon: '🧾',
      bg: 'rgba(255,181,71,.1)',
      badge: 'Profil · Factures',
      title: 'Complétez votre profil',
      body: `Pour des feuilles de soins conformes, renseignez vos informations professionnelles dans <strong style="color:var(--t)">Mon profil</strong> :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>📋 Numéro ADELI ou RPPS</span>
          <span>🏥 Cabinet / Structure</span>
          <span>📍 Adresse professionnelle</span>
          <span>📞 Téléphone</span>
        </span><br>Ces informations apparaîtront automatiquement sur chaque facture imprimée.`,
      tip: '👤 Accédez à votre profil via le bouton en haut à droite ou dans le menu "Plus".'
    }
  ];

  _showIntroModal('main', steps);
}

/* ════════════════════════════════════════════════
   INTRO — Carnet patients
════════════════════════════════════════════════ */
function checkPatientsIntro() {
  if (_introSeen('patients')) return;
  setTimeout(() => showPatientsIntro(), 400);
}

function showPatientsIntro() {
  const steps = [
    {
      icon: '👤',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Première visite',
      title: 'Votre carnet patients',
      body: `Le carnet patients est votre <strong style="color:var(--t)">annuaire médical personnel</strong>. Il centralise toutes les informations de vos patients pour les réutiliser dans chaque partie de l'application — sans jamais les retaper.`,
      tip: '🔒 Stockage 100% local et chiffré. Aucune donnée ne quitte votre appareil.'
    },
    {
      icon: '➕',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Ajout rapide',
      title: 'Ajouter un patient',
      body: `Cliquez sur <strong style="color:var(--a)">➕ Nouveau patient</strong> pour créer une fiche. Pour chaque patient vous pouvez renseigner :<br><br>
        <span style="display:flex;flex-direction:column;gap:5px">
          <span>👤 <strong style="color:var(--t)">Identité</strong> — prénom, nom, date de naissance, N° Sécu</span>
          <span>📍 <strong style="color:var(--t)">Adresse complète</strong> — géocodée automatiquement pour la tournée</span>
          <span>📞 <strong style="color:var(--t)">Contact</strong> — téléphone, email, contact d'urgence</span>
          <span>🩺 <strong style="color:var(--t)">Médical</strong> — médecin traitant, pathologies, notes de soin</span>
          <span>💊 <strong style="color:var(--t)">Ordonnances</strong> — actes récurrents avec horaires contraints</span>
        </span>`
    },
    {
      icon: '⚡',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Gain de temps',
      title: 'Pré-remplissage automatique',
      body: `Depuis le formulaire de <strong style="color:var(--t)">Cotation NGAP</strong>, tapez le nom d'un patient dans le champ "Nom patient" — AMI propose la liste de vos patients enregistrés.<br><br>Un clic suffit pour pré-remplir automatiquement :<br><br>
        <span style="display:flex;flex-direction:column;gap:5px">
          <span>✅ Nom, prénom, date de naissance</span>
          <span>✅ Numéro de sécurité sociale</span>
          <span>✅ Médecin prescripteur habituel</span>
          <span>✅ Caisse AMO et mutuelle AMC</span>
        </span>`,
      tip: '⏱️ Vous économisez 2-3 minutes par cotation sur vos patients réguliers.'
    },
    {
      icon: '🗺️',
      bg: 'rgba(0,212,170,.1)',
      badge: 'Tournée IA',
      title: 'Import vers la tournée',
      body: `Cliquez sur <strong style="color:var(--a)">🗺️ Importer vers tournée</strong> pour sélectionner vos patients du jour et les envoyer directement dans la <strong style="color:var(--t)">Tournée IA</strong>.<br><br>L'adresse géocodée de chaque patient est utilisée pour calculer l'ordre de passage optimal et le routage GPS réel — pas besoin de resaisir les adresses.`,
      tip: '📍 L\'adresse est géocodée automatiquement lors de l\'enregistrement du patient.'
    },
    {
      icon: '📋',
      bg: 'rgba(255,181,71,.1)',
      badge: 'Ordonnances',
      title: 'Soins récurrents & ordonnances',
      body: `Pour chaque patient, vous pouvez enregistrer ses <strong style="color:var(--t)">ordonnances en cours</strong> avec les actes NGAP à réaliser et les éventuelles contraintes horaires.<br><br>
        <span style="display:flex;flex-direction:column;gap:5px">
          <span>💊 Actes à réaliser (AMI1, BSC, IFD…)</span>
          <span>⏰ Horaire contraint (ex: insuline à 7h30 pile)</span>
          <span>📅 Date de fin d'ordonnance</span>
          <span>📝 Notes de soin personnalisées</span>
        </span><br>Ces données sont utilisées par la Tournée IA pour bloquer les horaires contraints.`,
      tip: '🔔 Un badge orange s\'affiche sur l\'onglet Patients quand des ordonnances approchent de leur expiration.'
    },
    {
      icon: '📥',
      bg: 'rgba(0,212,170,.08)',
      badge: 'Export RGPD',
      title: 'Export & portabilité',
      body: `Le bouton <strong style="color:var(--a)">📥 Export RGPD</strong> vous permet d'exporter l'intégralité de vos données patients au format JSON.<br><br>Vous pouvez :<br><br>
        <span style="display:flex;flex-direction:column;gap:5px">
          <span>💾 Sauvegarder vos données sur un autre appareil</span>
          <span>🔄 Synchroniser entre PC et mobile (via la sync cloud chiffrée)</span>
          <span>📤 Exercer votre droit à la portabilité RGPD</span>
        </span>`,
      tip: '🛡️ Le fichier exporté est chiffré — seul votre compte AMI peut le déchiffrer.'
    }
  ];

  _showIntroModal('patients', steps);
}

/* ════════════════════════════════════════════════
   INTRO — Tournée optimisée par IA
════════════════════════════════════════════════ */
function checkTourneeIntro() {
  if (_introSeen('tournee')) return;
  setTimeout(() => showTourneeIntro(), 400);
}

function showTourneeIntro() {
  const steps = [
    {
      icon: '🗺️',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Première visite',
      title: 'Tournée optimisée par IA',
      body: `Cet outil calcule l'<strong style="color:var(--t)">ordre de passage optimal</strong> pour votre journée de soins. En croisant les adresses de vos patients, le trafic réel et vos contraintes horaires, AMI minimise vos trajets et vous fait gagner du temps.`,
      tip: '🚗 Les infirmières utilisant l\'optimisation économisent en moyenne 25 km par tournée.'
    },
    {
      icon: '📥',
      bg: 'rgba(0,212,170,.1)',
      badge: 'Étape 1',
      title: 'Importez vos patients',
      body: `Avant d'optimiser, vous devez importer votre liste de patients du jour. Plusieurs méthodes :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>👤 <strong style="color:var(--t)">Depuis le Carnet patients</strong> — sélectionnez vos patients directement</span>
          <span>📂 <strong style="color:var(--t)">Depuis un fichier</strong> — Google Calendar, Excel, CSV, texte libre</span>
          <span>🎤 <strong style="color:var(--t)">Via le vocal</strong> — dictez votre liste à l'assistant</span>
        </span><br>Rendez-vous dans <strong style="color:var(--a)">Import calendrier</strong> pour importer votre planning.`,
    },
    {
      icon: '📍',
      bg: 'rgba(0,212,170,.1)',
      badge: 'Étape 2',
      title: 'Définissez votre départ',
      body: `Indiquez votre <strong style="color:var(--t)">point de départ</strong> (domicile, cabinet…) en :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>🔍 Tapant votre adresse dans la barre de recherche</span>
          <span>📍 Cliquant directement sur la carte</span>
          <span>🛰️ Utilisant <strong style="color:var(--t)">📍 GPS</strong> pour votre position actuelle</span>
        </span><br>Le point de départ est sauvegardé automatiquement pour votre prochaine tournée.`,
      tip: '💡 Le point de départ sert aussi de point de retour pour calculer la distance totale.'
    },
    {
      icon: '🧠',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Étape 3',
      title: '3 modes d\'optimisation',
      body: `Choisissez comment l'IA organise votre tournée :<br><br>
        <span style="display:flex;flex-direction:column;gap:8px">
          <span>🚀 <strong style="color:var(--t)">Automatique</strong> — L'IA choisit le meilleur ordre librement</span>
          <span>⏰ <strong style="color:var(--t)">Horaires fixes</strong> — Vous fixez l'heure de chaque patient, l'IA optimise les trajets en respectant ces horaires</span>
          <span>🎯 <strong style="color:var(--t)">Hybride</strong> — Certains patients ont un horaire bloqué (insuline à 7h30), les autres sont librement optimisés autour</span>
        </span>`,
      tip: '⚡ Le mode Automatique est recommandé pour démarrer — il donne les meilleurs résultats dans 90% des cas.'
    },
    {
      icon: '🚀',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Résultat',
      title: 'Votre tournée optimisée',
      body: `Cliquez sur <strong style="color:var(--a)">🚀 Optimiser la tournée</strong>. AMI calcule en quelques secondes :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>📍 L'ordre de passage optimal avec le tracé sur la carte</span>
          <span>🚗 La distance totale et le temps estimé par trajet</span>
          <span>💶 Une estimation du CA de la journée</span>
          <span>⚠️ Les alertes de fraude ou incohérences NGAP</span>
        </span>`,
    },
    {
      icon: '▶️',
      bg: 'rgba(0,212,170,.1)',
      badge: 'Démarrage',
      title: 'Démarrez le Pilotage',
      body: `Une fois la tournée optimisée, cliquez sur <strong style="color:var(--t)">▶️ Démarrer la journée</strong> pour passer en mode <strong style="color:var(--a)">Pilotage de journée</strong>.<br><br>Vous aurez alors un assistant temps réel qui vous guide de patient en patient, détecte les retards et génère les cotations automatiquement à chaque passage.`,
      tip: '📱 Le pilotage fonctionne sur mobile — installez AMI en PWA pour une expérience optimale.'
    }
  ];

  _showIntroModal('tournee', steps);
}

/* ════════════════════════════════════════════════
   INTRO — Pilotage de journée
════════════════════════════════════════════════ */
function checkLiveIntro() {
  if (_introSeen('live')) return;
  setTimeout(() => showLiveIntro(), 400);
}

function showLiveIntro() {
  const steps = [
    {
      icon: '▶️',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Première visite',
      title: 'Pilotage de journée',
      body: `Le Pilotage de journée est votre <strong style="color:var(--t)">assistant temps réel</strong> pendant votre tournée. Il vous guide de patient en patient, s'adapte aux imprévus et génère vos cotations automatiquement au fil des passages.`,
      tip: '📱 Cette vue est optimisée pour une utilisation en mobilité — idéale sur smartphone.'
    },
    {
      icon: '🧠',
      bg: 'rgba(0,212,170,.1)',
      badge: 'Mode de démarrage',
      title: 'Choisissez votre mode',
      body: `Avant de démarrer, sélectionnez comment l'IA organise votre tournée :<br><br>
        <span style="display:flex;flex-direction:column;gap:8px">
          <span>🚀 <strong style="color:var(--t)">Automatique</strong> — ordre optimal calculé par l'IA</span>
          <span>⏰ <strong style="color:var(--t)">Horaires fixes</strong> — vous définissez l'heure pour chaque patient</span>
          <span>🎯 <strong style="color:var(--t)">Hybride</strong> — certains patients ont un horaire bloqué, les autres sont optimisés</span>
        </span><br>Si vous venez de la Tournée IA, le mode choisi là-bas est conservé.`,
    },
    {
      icon: '🛰️',
      bg: 'rgba(0,212,170,.1)',
      badge: 'GPS temps réel',
      title: 'Suivi GPS automatique',
      body: `Une fois démarré, AMI active le <strong style="color:var(--t)">suivi GPS</strong> de votre position et :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>📍 Affiche votre position en temps réel sur la carte</span>
          <span>🔔 Vous notifie quand vous approchez d'un patient</span>
          <span>⏱️ Détecte automatiquement les <strong style="color:var(--t)">retards</strong> et recalcule l'ordre si nécessaire</span>
          <span>🗣️ Donne des <strong style="color:var(--t)">instructions vocales</strong> pour chaque trajet</span>
        </span>`,
      tip: '🔋 Le GPS peut consommer de la batterie. Pensez à brancher votre téléphone en voiture.'
    },
    {
      icon: '✅',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Passage patient',
      title: 'Valider un passage',
      body: `À chaque patient, vous avez 3 actions possibles :<br><br>
        <span style="display:flex;flex-direction:column;gap:8px">
          <span>✅ <strong style="color:var(--t)">Soin effectué</strong> — marque le patient comme vu, génère la cotation automatiquement et passe au suivant</span>
          <span>❌ <strong style="color:var(--t)">Absent</strong> — note l'absence pour la facturation et recalcule l'ordre</span>
          <span>📋 <strong style="color:var(--t)">Voir état</strong> — consulte le bilan de tournée en cours</span>
        </span>`,
    },
    {
      icon: '⚡',
      bg: 'rgba(0,212,170,.12)',
      badge: 'Auto-facturation',
      title: 'Cotations automatiques',
      body: `À la fin de chaque passage, AMI génère la <strong style="color:var(--t)">cotation NGAP complète</strong> automatiquement :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>⚡ Détecte les actes depuis l'ordonnance du carnet patients</span>
          <span>🌙 Applique les majorations horaires (nuit, dimanche) en temps réel</span>
          <span>🚗 Intègre les indemnités kilométriques (IK) du trajet</span>
          <span>💾 Enregistre dans le carnet patient et l'historique</span>
        </span>`,
      tip: '✏️ Vous pouvez corriger chaque cotation depuis le bilan de tournée avant l\'envoi.'
    },
    {
      icon: '🏁',
      bg: 'rgba(255,181,71,.1)',
      badge: 'Fin de tournée',
      title: 'Terminer la journée',
      body: `Cliquez sur <strong style="color:var(--a)">🏁 Terminer la tournée</strong> pour clôturer votre journée. AMI :<br><br>
        <span style="display:flex;flex-direction:column;gap:6px">
          <span>📊 Génère le <strong style="color:var(--t)">bilan complet</strong> de la journée (CA, km, actes)</span>
          <span>💾 Enregistre les cotations dans l'historique et le carnet patients</span>
          <span>🚗 Exporte les km dans le <strong style="color:var(--t)">Journal kilométrique</strong></span>
          <span>✏️ Vous permet de corriger les cotations avant validation finale</span>
        </span>`,
      tip: '📄 Le bilan peut être imprimé ou exporté pour votre comptabilité.'
    }
  ];

  _showIntroModal('live', steps);
}

/* ════════════════════════════════════════════════
   HOOK NAVIGATION — déclenche les intros par section
════════════════════════════════════════════════ */
document.addEventListener('ui:navigate', function(e) {
  const view = e?.detail?.view;
  if (view === 'patients') checkPatientsIntro();
  if (view === 'tur')      checkTourneeIntro();
  if (view === 'live')     checkLiveIntro();
});
