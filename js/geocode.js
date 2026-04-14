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

  // 2. Photon (komoot) — plus précis que Nominatim seul
  try {
    const res  = await fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1&lang=fr`
    );
    const data = await res.json();

    if (data.features?.length) {
      const f      = data.features[0];
      const result = {
        lat:        f.geometry.coordinates[1],
        lng:        f.geometry.coordinates[0],
        confidence: f.properties?.score || 0.7,
        source:     'photon',
      };
      await saveSecure('geocache', cacheKey, result);
      return result;
    }
  } catch (_) {}

  // 3. Nominatim (fallback)
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&countrycodes=fr`,
      { headers: { 'Accept-Language': 'fr' } }
    );
    const data = await res.json();

    if (data.length) {
      const result = {
        lat:        parseFloat(data[0].lat),
        lng:        parseFloat(data[0].lon),
        confidence: 0.6,
        source:     'nominatim',
      };
      await saveSecure('geocache', cacheKey, result);
      return result;
    }
  } catch (_) {}

  throw new Error('Géocodage impossible pour : ' + address);
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
    .replace(/\bav\b\.?/gi,  'Avenue')
    .replace(/\bbd\b\.?/gi,  'Boulevard')
    .replace(/\bbl\b\.?/gi,  'Boulevard')
    .replace(/\br\b\.?/gi,   'Rue')
    .replace(/\bst\b/gi,     'Saint')
    .replace(/\bste\b/gi,    'Sainte')
    .replace(/chez\s+\S+\s*/gi, '')
    .replace(/appt?\s*\d+/gi,   '')
    .replace(/\s+/g, ' ')
    .trim();

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
