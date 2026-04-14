// ─────────────────────────────────────────────────────────────
//  navigation.js
//  Gestion de la navigation GPS vers les patients
//  Stratégie : coordonnées fiables → GPS direct
//              sinon → adresse texte complète → Google Maps géocode
// ─────────────────────────────────────────────────────────────

/**
 * Ouvre Google Maps en navigation vers le patient.
 * Priorité : coordonnées GPS validées (geoScore >= 70)
 * Fallback  : adresse texte complète → Google géocode lui-même
 */
function openNavigation(patient) {
  /* Priorité adresse texte → Google Maps géocode précisément (évite reverse geocoding approx)
     Ordre : addressFull > adresse > address complet > reconstruit depuis street/zip/city > coords GPS */
  const addrFull = (patient.addressFull || patient.adresse || '').trim();

  // Si address contient déjà une adresse complète (numéro + rue + CP + ville), l'utiliser directement
  const addrRaw  = (patient.address || '').trim();
  const hasFullAddr = addrRaw && /\d{5}/.test(addrRaw); // contient un CP → adresse complète

  const addr = addrFull || (hasFullAddr ? addrRaw : '') || buildNavigationAddress(patient);

  const origin = APP.get('startPoint');
  const originParam = (origin?.lat && origin?.lng)
    ? `&origin=${origin.lat},${origin.lng}` : '';

  if (addr) {
    const url = `https://www.google.com/maps/dir/?api=1`
      + originParam
      + `&destination=${encodeURIComponent(addr)}`
      + `&travelmode=driving`;
    window.open(url, '_blank');
  } else if (patient.lat && patient.lng) {
    const url = `https://www.google.com/maps/dir/?api=1`
      + originParam
      + `&destination=${patient.lat},${patient.lng}`
      + `&travelmode=driving`;
    window.open(url, '_blank');
  } else {
    alert('Adresse du patient non disponible.');
  }
}

/**
 * Construit une adresse navigation propre et complète
 * Format : "12 Rue Victor Hugo, Bâtiment B, 69003 Lyon, France"
 */
function buildNavigationAddress(patient) {
  let rue  = (patient.street  || patient.address || '').trim();
  let comp = (patient.extra   || '').trim();
  let cp   = (patient.zip     || patient.codePostal || '').trim();
  let city = (patient.city    || APP.get('userCity') || '').trim();

  // normalisation abréviations courantes
  rue = rue
    .replace(/\bav\b\.?/gi,  'Avenue')
    .replace(/\bbd\b\.?/gi,  'Boulevard')
    .replace(/\bbl\b\.?/gi,  'Boulevard')
    .replace(/\br\b\.?/gi,   'Rue')
    .replace(/\bst\b/gi,     'Saint')
    .replace(/\bste\b/gi,    'Sainte')
    .replace(/chez\s+\S+\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = [rue, comp, [cp, city].filter(Boolean).join(' '), 'France']
    .map(s => s.trim())
    .filter(Boolean);

  return parts.join(', ');
}

/**
 * Calcule un score de fiabilité géographique (0–100)
 * Utilisé pour choisir entre coordonnées GPS et adresse texte
 */
function computeGeoScore(addr, geocodeResult) {
  let score = 50;

  if (/\d/.test(addr))                                                      score += 10; // numéro rue
  if (/rue|avenue|boulevard|impasse|allée|route|chemin|passage|place/i.test(addr)) score += 10;
  if (addr.length > 20)                                                     score +=  5;

  // API Adresse gouv.fr = données cadastrales officielles France
  if (geocodeResult.source === 'gouv' && geocodeResult.type === 'housenumber') score += 30;
  else if (geocodeResult.source === 'gouv' && geocodeResult.type === 'street') score += 15;
  else if ((geocodeResult.confidence || 0) >= 0.80)                           score += 20;
  else if ((geocodeResult.confidence || 0) >= 0.65)                           score += 10;
  if (geocodeResult.source === 'photon')                                    score +=  5;
  if (geocodeResult.source === 'nominatim' && (geocodeResult.confidence || 0) >= 0.65) score += 5;

  // pénalités
  if (/chez |bat[i]?|appt?/i.test(addr))                                   score -= 15;
  if (!geocodeResult.lat || !geocodeResult.lng)                             score  =  0;

  return Math.min(100, Math.max(0, score));
}

