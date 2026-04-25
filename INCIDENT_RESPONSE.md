# 🚨 AMI — Plan de Réponse aux Incidents de Sécurité

**Conformité : RGPD art. 33-34 — notification CNIL sous 72h**
**Version : 1.0 — Avril 2026**
**Responsable de traitement : Bastien (DPO de fait)**

---

## 1. Préambule

L'application **AMI (Assistant Médical Infirmier)** traite des **données de santé** au sens de l'article 9 du RGPD. Toute violation de ces données impose une notification à la CNIL dans un délai maximal de **72 heures** après que le responsable en ait pris connaissance, conformément à l'article 33 du RGPD.

Les patients (personnes concernées) doivent en outre être informés sans délai si la violation est susceptible d'engendrer **un risque élevé** pour leurs droits et libertés (art. 34 RGPD).

---

## 2. Catégories d'incident

| Type | Définition | Exemple typique |
|------|------------|-----------------|
| `data_breach` | Fuite confirmée de données patients | Export non autorisé du carnet, leak SQL |
| `unauthorized` | Accès non autorisé détecté | Bruteforce réussi, vol de session, compte compromis |
| `data_loss` | Perte de données | Ransomware, suppression accidentelle non récupérable |
| `service_down` | Indisponibilité prolongée (>2h) | Panne worker Cloudflare, Supabase down, perte HDS |
| `vulnerability` | Faille découverte non encore exploitée | XSS, injection, fuite côté client |

---

## 3. Échelle de sévérité

| Niveau | Critère | Action déclenchée |
|--------|---------|-------------------|
| **critical** | Fuite confirmée OU >50 patients impactés OU données médicales en clair exposées | Notification CNIL **immédiate** + notification patients (art. 34) + log `system_logs` CRITICAL |
| **high** | Suspicion forte OU 1-50 patients potentiellement impactés | Notification CNIL probable sous 24h, décision DPO + log CRITICAL admin |
| **medium** | Anomalie détectée sans impact patient avéré | Surveillance renforcée 7j, pas de notification CNIL si aucun impact confirmé |
| **low** | Événement notable sans risque (ex: erreur de config corrigée) | Log audit uniquement |

---

## 4. Workflow opérationnel

### 4.1 — T0 : Détection

**Source automatique** :
- `detectAutomatedAttacks()` : >10 LOGIN_FAIL même IP en 15min → incident `unauthorized` HIGH
- `watchFraudScore()` côté client : alerte si score ≥ 70 → log audit
- `system_logs` : monitoring temps réel des erreurs critiques

**Source humaine** :
- Email à l'admin / contact DPO
- Signalement infirmière via `/webhook/incident-report` (toute infirmière authentifiée peut signaler)
- Découverte personnelle (audit, journal)

### 4.2 — T0+1h : Qualification

L'admin reçoit une alerte (`system_logs` level=error, event=`INCIDENT_TRIGGERED`).

Action immédiate :
1. Consulter `/webhook/incident-list` (filtres : status=open, severity=critical/high)
2. Confirmer ou ré-évaluer le niveau de sévérité
3. Si `critical` → passer immédiatement à 4.3
4. Si `high` → enquête approfondie sous 24h
5. Si `medium`/`low` → surveillance, mise à jour statut `investigating`

### 4.3 — T0+24h max : Investigation

**Périmètre à établir** :
- [ ] Combien de personnes concernées ?
- [ ] Quelles catégories de données (santé, identifiants, financier) ?
- [ ] Quelle est la cause technique ?
- [ ] L'incident est-il toujours en cours ou contenu ?
- [ ] Quelles preuves disponibles (logs, screenshots, exports) ?

**Mesures conservatoires** :
- Bloquer les comptes compromis (`/webhook/admin-bloquer`)
- Invalider les sessions actives (`DELETE FROM sessions WHERE infirmiere_id IN ...`)
- Forcer rotation des secrets si applicable (XAI_API_KEY, SUPABASE_SERVICE_KEY)
- Snapshot Supabase + journal d'accès Cloudflare

### 4.4 — T0+72h max : Notification CNIL (si critical/high confirmé)

**Si nature des données = données de santé OU >1 personne impactée → notification OBLIGATOIRE.**

Procédure :
1. Se rendre sur **https://notifications.cnil.fr/notifications/index** (téléservice CNIL)
2. Renseigner les rubriques :
   - Description de la violation (utiliser `summary` de l'incident)
   - Date et heure de prise de connaissance (`detected_at`)
   - Nombre de personnes concernées (`affected_count`)
   - Catégories de données (santé, identifiants, etc.)
   - Conséquences probables
   - Mesures prises ou envisagées
3. Marquer l'incident `notified` : `POST /webhook/incident-update { incident_id, status: 'notified', notified: true }`
4. Conserver le numéro d'enregistrement CNIL dans le champ `resolution`

### 4.5 — Notification aux personnes concernées (art. 34)

Obligatoire si **risque élevé** : santé exposée, mots de passe en clair leakés, identifiants bancaires.

Méthode AMI :
- Envoi groupé via Cloudflare Email Workers OU SMTP de secours
- Template à inclure :
  - Description de la violation en termes clairs
  - Conséquences probables
  - Mesures prises pour remédier
  - Coordonnées DPO pour questions

### 4.6 — T+30j : Clôture

Une fois l'incident résolu :
1. `POST /webhook/incident-update { incident_id, status: 'resolved', resolution: '...' }`
2. Rédiger un retour d'expérience (REX) interne
3. Mettre à jour la doctrine de sécurité si applicable
4. Conservation incident dans `incident_log` pendant **5 ans minimum** (recommandation CNIL)

---

## 5. Routes API

### 5.1 — `POST /webhook/incident-report`

**Auth** : tout utilisateur authentifié

**Body** :
```json
{
  "type":     "data_breach | unauthorized | data_loss | service_down | vulnerability",
  "severity": "low | medium | high | critical",
  "summary":  "Description courte (≥10 chars)",
  "impact":   "Estimation impact",
  "affected": 0,
  "details":  { "...": "tout objet, sera chiffré AES-256-GCM" }
}
```

**Réponse** :
```json
{
  "ok": true,
  "incident_id": "uuid",
  "deadline_at": "ISO timestamp T+72h",
  "message": "..."
}
```

### 5.2 — `POST /webhook/incident-list`

**Auth** : admin uniquement (`view_logs`)

**Body (optionnel)** :
```json
{
  "status_filter":   "open | investigating | resolved | notified | dismissed",
  "severity_filter": "low | medium | high | critical",
  "limit":           100
}
```

**Réponse** :
```json
{
  "ok": true,
  "incidents": [
    {
      "id": "...", "incident_type": "...", "severity": "...",
      "detected_at": "...", "deadline_at": "...",
      "hours_remaining": 48, "overdue": false,
      "summary": "...", "details": {...}, "status": "open"
    }
  ],
  "stats": { "total": 12, "open": 3, "critical": 1, "overdue_72h": 0, ... }
}
```

### 5.3 — `POST /webhook/incident-update`

**Auth** : admin uniquement

**Body** :
```json
{
  "incident_id": "uuid",
  "status":      "investigating | resolved | notified | dismissed",
  "resolution":  "Texte libre",
  "notified":    true
}
```

---

## 6. Migration SQL requise

À exécuter **une fois** côté Supabase avant déploiement :

```sql
CREATE TABLE IF NOT EXISTS incident_log (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  incident_type   TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at     TIMESTAMPTZ,
  deadline_at     TIMESTAMPTZ NOT NULL,
  reporter_id     UUID,
  summary         TEXT,
  impact_estimate TEXT,
  affected_count  INTEGER DEFAULT 0,
  details_enc     JSONB,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','investigating','resolved','notified','dismissed')),
  resolved_at     TIMESTAMPTZ,
  resolution      TEXT
);

ALTER TABLE incident_log DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_incident_status   ON incident_log(status, severity);
CREATE INDEX IF NOT EXISTS idx_incident_deadline ON incident_log(deadline_at) WHERE status='open';
```

---

## 7. Annexe : Coordonnées CNIL

- **Téléservice notification** : https://notifications.cnil.fr/notifications/index
- **Téléphone** : 01 53 73 22 22
- **Adresse** : 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07
- **Délai légal** : 72 heures à partir de la prise de connaissance

---

## 8. Checklist rapide « Incident détecté »

```
[ ] T0     — Incident détecté (auto ou humain)
[ ] T+1h   — Qualifier sévérité, vérifier alerte system_logs
[ ] T+6h   — Bloquer accès compromis, snapshot logs/DB
[ ] T+24h  — Investigation complète : périmètre, cause, impact
[ ] T+48h  — Décision notification CNIL (si critical/high confirmé)
[ ] T+72h  — Notification CNIL effectuée (si requis) + statut 'notified'
[ ] T+7j   — Notification personnes concernées si risque élevé
[ ] T+30j  — Clôture incident, REX, mise à jour doctrine
```

---

**Dernière révision** : Avril 2026 — Bastien
**Prochaine revue obligatoire** : Avril 2027 (annuelle) ou après chaque incident critical/high
