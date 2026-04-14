// ─────────────────────────────────────────────────────────────
//  geocode.js
//  Pipeline de géocodage multi-source avec cache IndexedDB
//  Sources : Photon (komoot) → Nominatim → fallback
//  0€ — aucune API payante
// ─────────────────────────────────────────────────────────────

/**
 * Géocode une adresse propre.
 * Ordre : cache → API Adresse gouv.fr (officiel France) → Photon → Nominatim
 * Retourne { lat, lng, confidence, source }
 *
 * ✅ API Adresse data.gouv.fr = données cadastrales IGN + La Poste
 *    → précision au numéro de rue, 100% gratuit, sans clé, France uniquement
 */
async function smartGeocode(address) {
  const cacheKey = hashAddr(address);

  // 1. Cache IndexedDB — ignorer les entrées invalides (sans coordonnées)
  try {
    const cached = await loadSecure('geocache', cacheKey);
    if (cached && cached.lat && cached.lng) {
      console.debug('[GEO] cache hit:', address, '→', cached.source, cached.type || '');
      return { ...cached, source: 'cache' };
    }
  } catch (_) {}

  // Extraire le code postal si présent
  const cpMatch = address.match(/\b(\d{5})\b/);
  const postcode = cpMatch ? cpMatch[1] : '';

  // Variantes d'adresse
  const variants = _buildAddrVariants(address);

  // Utilitaire timeout compatible tous navigateurs
  function _fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal })
      .finally(() => clearTimeout(tid));
  }

  // 2. ── API Adresse data.gouv.fr — PRIORITÉ ABSOLUE ──────────────────────
  //    Données cadastrales IGN + La Poste — précision housenumber garantie
  for (const variant of variants) {
    try {
      const variantFr = variant.replace(/,?\s*France\s*$/i, '').trim();
      // Stratégie optimale : numéro+rue uniquement dans q=, CP dans &postcode=
      // Évite les erreurs de ville mal orthographiée / avec/sans tiret
      const variantCp = postcode
        ? variantFr.replace(new RegExp(`,?\s*${postcode}[^,]*`), '').trim()
        : variantFr;
      const query = variantCp || variantFr;

      let url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=5`;
      if (postcode) url += `&postcode=${postcode}`;

      console.debug('[GEO] gouv.fr →', url);

      const res  = await _fetchWithTimeout(url, { headers: { 'User-Agent': 'AMI-NGAP/1.0' } }, 7000);
      const data = await res.json();
      const feats = data.features || [];

      console.debug('[GEO] gouv.fr résultats:', feats.length, feats.map(f => f.properties?.type + ':' + f.properties?.score?.toFixed(2)).join(', '));

      if (feats.length) {
        const best = feats.find(f => f.properties?.type === 'housenumber')
                  || feats.find(f => f.properties?.type === 'street')
                  || feats[0];

        const p = best.properties;
        const c = best.geometry.coordinates;
        const apiScore = p.score || 0.5;

        const confidence = p.type === 'housenumber' && apiScore >= 0.9 ? 0.98
                         : p.type === 'housenumber'                    ? Math.min(0.97, 0.75 + apiScore * 0.23)
                         : p.type === 'street'                         ? 0.70
                         : p.type === 'municipality'                   ? 0.45
                         : 0.55;

        const result = { lat: c[1], lng: c[0], confidence, source: 'gouv', type: p.type, label: p.label };
        console.info('[GEO] ✅ gouv.fr:', p.type, 'score', apiScore.toFixed(3), '→', p.label, result.lat, result.lng);
        try { await saveSecure('geocache', cacheKey, result); } catch(_) {}
        return result;
      }
    } catch (e) {
      console.warn('[GEO] gouv.fr erreur:', e.message, '— adresse:', variant);
    }
  }

  // 3. ── Photon (komoot) — fallback ────────────────────────────────────────
  for (const variant of variants) {
    try {
      const res  = await _fetchWithTimeout(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(variant)}&limit=3&lang=fr`,
        {}, 6000
      );
      const data = await res.json();

      if (data.features?.length) {
        const f = data.features.find(ft => ['house','street'].includes(ft.properties?.type))
               || data.features[0];
        const result = {
          lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
          confidence: f.properties?.score || 0.65, source: 'photon',
          type: f.properties?.type,
        };
        console.info('[GEO] photon:', f.properties?.type, result.lat, result.lng);
        try { await saveSecure('geocache', cacheKey, result); } catch(_) {}
        return result;
      }
    } catch (e) {
      console.warn('[GEO] photon erreur:', e.message);
    }
  }

  // 4. ── Nominatim — dernier recours ──────────────────────────────────────
  for (const variant of variants) {
    try {
      const res  = await _fetchWithTimeout(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(variant)}&limit=3&countrycodes=fr&addressdetails=1`,
        { headers: { 'Accept-Language': 'fr' } }, 6000
      );
      const data = await res.json();

      if (data.length) {
        const best = data.find(r => ['house','building'].includes(r.type)) || data[0];
        const hasNum = /^\d/.test(variant);
        const result = {
          lat: parseFloat(best.lat), lng: parseFloat(best.lon),
          confidence: best.type === 'house' ? 0.72 : hasNum ? 0.62 : 0.52,
          source: 'nominatim', type: best.type,
        };
        console.info('[GEO] nominatim:', best.type, result.lat, result.lng);
        try { await saveSecure('geocache', cacheKey, result); } catch(_) {}
        return result;
      }
    } catch (e) {
      console.warn('[GEO] nominatim erreur:', e.message);
    }
  }

  throw new Error('Géocodage impossible pour : ' + address);
}

/* Génère des variantes d'une adresse pour maximiser les chances de géocodage */
function _buildAddrVariants(address) {
  const variants = [address];

  // Communes composées : "Puget Ville" → "Puget-Ville"
  const withHyphen = address.replace(
    /\b(Saint|Sainte|Sur|Sous|En|Les|Le|La|Du|Des|De|Mont|Bois|Val|Puy|Puget|Pont|Port|Bourg|Roc|Grand|Vieux|Neuf)\s+([A-ZÀ-Ÿ][a-zà-ÿ]+)/g,
    (_, a, b) => `${a}-${b}`
  );
  if (withHyphen !== address) variants.push(withHyphen);

  // Variante avec tirets ET sans "France" (meilleur pour l'API gouv.fr)
  const cleanFr = withHyphen.replace(/,?\s*France\s*$/i, '').trim();
  if (cleanFr !== withHyphen && cleanFr !== address) variants.push(cleanFr);

  // Sans numéro (OSM ne connaît pas tous les numéros)
  const withoutNum = address.replace(/^\d+\s+/, '');
  if (withoutNum !== address) variants.push(withoutNum);

  // "Rue de la" → "Route de la" (fréquent en rural)
  if (/rue de la/i.test(address)) variants.push(address.replace(/rue de la/i, 'Route de la'));

  // Variante sans accents (certaines BAN ont les adresses sans accent)
  const noAccent = address.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (noAccent !== address) variants.push(noAccent);

  return [...new Set(variants)];
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
