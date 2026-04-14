// ─────────────────────────────────────────────────────────────
//  geocode.js
//  Pipeline de géocodage multi-source avec cache IndexedDB
//  Sources : Photon (komoot) → Nominatim → fallback
//  0€ — aucune API payante
// ─────────────────────────────────────────────────────────────

/**
 * Géocode une adresse propre.
 * Ordre : cache local → Photon → Nominatim
 * Retourne { lat, lng, confidence, source }
 */
async function smartGeocode(address) {
  const cacheKey = hashAddr(address);

  // 1. cache local (IndexedDB)
  try {
    const cached = await loadSecure('geocache', cacheKey);
    if (cached) {
      console.info('[Geocode] Cache hit :', address);
      return { ...cached, source: 'cache' };
    }
  } catch (_) {}

  /* Générer des variantes de l'adresse pour améliorer la précision
     Ex: "Puget Ville" → "Puget-Ville", "st " → "Saint " */
  const variants = _buildAddrVariants(address);

  // 2. Photon (komoot) — essayer toutes les variantes, garder le meilleur résultat
  let bestPhoton = null;
  for (const variant of variants) {
    try {
      const res  = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(variant)}&limit=3&lang=fr`
      );
      const data = await res.json();

      if (data.features?.length) {
        // Prendre le premier résultat de type house/street si disponible
        const f = data.features.find(ft =>
          ['house','street'].includes(ft.properties?.type)
        ) || data.features[0];

        const confidence = f.properties?.score || 0.7;
        const result = {
          lat:        f.geometry.coordinates[1],
          lng:        f.geometry.coordinates[0],
          confidence: confidence,
          source:     'photon',
        };
        // Garder le résultat avec la meilleure confidence
        if (!bestPhoton || confidence > bestPhoton.confidence) {
          bestPhoton = result;
        }
        // Si on a un résultat de type house (adresse exacte), inutile de continuer
        if (f.properties?.type === 'house') break;
      }
    } catch (_) {}
  }

  if (bestPhoton) {
    await saveSecure('geocache', cacheKey, bestPhoton);
    return bestPhoton;
  }

  // 3. Nominatim (fallback) — essayer les variantes aussi
  for (const variant of variants) {
    try {
      const res  = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(variant)}&limit=3&countrycodes=fr&addressdetails=1`,
        { headers: { 'Accept-Language': 'fr' } }
      );
      const data = await res.json();

      if (data.length) {
        // Préférer les résultats de type house/building/road
        const best = data.find(d => ['house','building','road'].includes(d.type)) || data[0];
        // Confidence plus haute si on a trouvé un numéro de rue exact
        const hasHouseNum = /^\d/.test(variant);
        const confidence = (best.type === 'house' || best.type === 'building') ? 0.75
          : hasHouseNum ? 0.65
          : 0.55;
        const result = {
          lat:        parseFloat(best.lat),
          lng:        parseFloat(best.lon),
          confidence: confidence,
          source:     'nominatim',
        };
        await saveSecure('geocache', cacheKey, result);
        return result;
      }
    } catch (_) {}
  }

  throw new Error('Géocodage impossible pour : ' + address);
}

/* Génère des variantes d'une adresse pour maximiser les chances de géocodage précis */
function _buildAddrVariants(address) {
  const variants = [address];

  // Variante avec tirets dans les noms de communes composés
  // Ex: "Puget Ville" → "Puget-Ville", "Saint Germain" → "Saint-Germain"
  const withHyphen = address.replace(
    /\b(Saint|Sainte|Sur|Sous|En|Les|Le|La|Du|Des|De|Mont|Bois|Val|Puy|Puget|Pont|Port|Bourg|Ville|Roc|Grand|Vieux|Neuf)\s+([A-Z][a-zÀ-ÿ]+)/g,
    (_, a, b) => `${a}-${b}`
  );
  if (withHyphen !== address) variants.push(withHyphen);

  // Variante sans le numéro (pour les adresses où le numéro est inconnu d'OSM)
  const withoutNum = address.replace(/^\d+\s+/, '');
  if (withoutNum !== address) variants.push(withoutNum);

  // Variante avec "Rue de la" → "Route de la" (communes rurales)
  if (/rue de la/i.test(address)) {
    variants.push(address.replace(/rue de la/i, 'Route de la'));
  }

  return [...new Set(variants)]; // dédoublonner
}

/**
 * Snap sur la route la plus proche (OSRM gratuit)
 * Évite les coordonnées au centre d'un bâtiment
 */
async function snapToRoad(lat, lng) {
  try {
    const res  = await fetch(
      `https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`
    );
    const data = await res.json();

    if (data.waypoints?.[0]) {
      return {
        lat: data.waypoints[0].location[1],
        lng: data.waypoints[0].location[0],
      };
    }
  } catch (_) {}

  // si OSRM échoue, on retourne les coords d'origine
  return { lat, lng };
}

/**
 * Reverse geocoding : coordonnées → adresse texte
 * Utilisé après correction manuelle tap-to-correct
 */
async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=fr`
    );
    const data = await res.json();
    return data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch (_) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

// ─────────────────────────────────────────────────────────────
//  Correction apprise : mémorise les corrections manuelles
// ─────────────────────────────────────────────────────────────

/**
 * Sauvegarde une correction d'adresse faite par l'utilisateur.
 * Sera réutilisée automatiquement à la prochaine saisie identique.
 */
async function saveLearnedCorrection(original, corrected) {
  const key = hashAddr(original);
  await saveSecure('geo_corrections', key, {
    original,
    corrected,
    timestamp: Date.now(),
    uses: 1,
  });
  console.info('[IA] Correction mémorisée :', original, '→', corrected);
}

/**
 * Récupère une correction déjà apprise pour cette adresse.
 * Retourne l'adresse corrigée ou null.
 */
async function getLearnedCorrection(input) {
  try {
    const key  = hashAddr(input);
    const data = await loadSecure('geo_corrections', key);
    if (data) {
      data.uses = (data.uses || 1) + 1;
      await saveSecure('geo_corrections', key, data);
      return data.corrected;
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Pipeline complet : normalisation → correction → géocodage
// ─────────────────────────────────────────────────────────────

/**
 * Traitement complet d'une adresse avant géocodage.
 * 1. Vérifie les corrections apprises
 * 2. Normalise les abréviations
 * 3. Enrichit avec ville + CP + pays
 */
async function processAddressBeforeGeocode(rawAddr, patient) {
  // 1. correction déjà apprise ?
  const learned = await getLearnedCorrection(rawAddr);
  if (learned) {
    if (patient) patient.addrSource = 'learned';
    return learned;
  }

  // 2. normalisation
  let addr = rawAddr
    .replace(/\bav\b\.?/gi,    'Avenue')
    .replace(/\bbd\b\.?/gi,    'Boulevard')
    .replace(/\bbl\b\.?/gi,    'Boulevard')
    .replace(/\br\b\.?/gi,     'Rue')
    .replace(/\bst\b/gi,       'Saint')
    .replace(/\bste\b/gi,      'Sainte')
    .replace(/chez\s+\S+\s*/gi,  '')
    .replace(/appt?\s*\d+/gi,    '')
    .replace(/\s+/g, ' ')
    .trim();

  // Normaliser les noms de communes composés avec espace → tiret
  // Ex: "Puget Ville" → "Puget-Ville", "Saint Germain" → "Saint-Germain"
  // Seulement si suivi d'une majuscule (pour éviter "Rue de la Paix")
  addr = addr.replace(
    /\b(Puget|Saint|Sainte|Mont|Bois|Val|Puy|Pont|Port|Bourg|Vieux|Neuf|Grand|Petit|Haut|Bas|Vieux|Neuf|Roc|Croix|Bel|Belle)\s+([A-ZÀ-Ÿ][a-zà-ÿ]+)/g,
    (_, a, b) => `${a}-${b}`
  );

  // 3. enrichissement si ville/CP disponibles dans l'objet patient
  if (patient) {
    const city = patient.city || '';
    const zip  = patient.zip  || '';
    if (zip  && !addr.includes(zip))                          addr += ', ' + zip;
    if (city && !addr.toLowerCase().includes(city.toLowerCase())) addr += ' ' + city;
  }

  if (!/france/i.test(addr)) addr += ', France';

  return addr;
}

// ─────────────────────────────────────────────────────────────
//  Utilitaires
// ─────────────────────────────────────────────────────────────

function hashAddr(s) {
  return s.toLowerCase().replace(/[\s,.']/g, '').slice(0, 50);
}

function isPreciseGeocode(result) {
  return result && result.confidence >= 0.75;
}
