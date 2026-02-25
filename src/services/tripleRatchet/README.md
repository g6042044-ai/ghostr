# Triple Ratchet avec Protection Post-Quantique ML-KEM-768

## Vue d'ensemble

Implémentation complète du protocole **Triple Ratchet** avec protection post-quantique, conforme aux dernières spécifications Signal (PQXDH, SPQR, 2024-2025).

## Garanties de Sécurité

| Propriété | Description | Implémentation |
|-----------|-------------|----------------|
| **Forward Secrecy** | Compromission future ne révèle pas le passé | DH Ratchet (X25519) |
| **Post-Compromise Security** | Récupération après compromission | Symmetric Ratchet |
| **Post-Quantum Security** | Résistance ordinateurs quantiques | SPQR (ML-KEM-768) |
| **Harvest Now, Decrypt Later** | Protection collecte passive | Hybride X25519+ML-KEM |
| **Traffic Analysis Protection** | Dissimulation type contenu | Message Padding |

## Structure des fichiers

```
tripleRatchet/
├── index.ts           # Point d'entrée, exports
├── types.ts           # Types TypeScript stricts
├── primitives.ts      # Primitives crypto (X25519, Ed25519, HKDF)
├── pqPrimitives.ts    # ML-KEM-768 (CRYSTALS-Kyber)
├── pqxdh.ts           # Post-Quantum X3DH
├── spqr.ts            # Sparse Post-Quantum Ratchet
├── tripleRatchet.ts   # Orchestrateur principal
├── messagePadding.ts  # Padding anonymat
├── sessionService.ts  # Service de session complet
└── tripleRatchet.test.ts # Tests
```

## Usage rapide

```typescript
import { sessionService } from './tripleRatchet';

// Initialisation
await sessionService.initialize();

// Créer une invitation (afficher en QR code)
const { inviteString } = await sessionService.createInvite();

// Accepter une invitation (scanner QR code)
const { session } = await sessionService.acceptInviteAndRespond(inviteString);

// Finaliser côté créateur (après réception réponse)
const { session } = await sessionService.finalizeSession(responseString);

// Chiffrer un message
const encrypted = await sessionService.encryptMessageForSession(sessionId, "Hello!");

// Déchiffrer un message
const plaintext = await sessionService.decryptMessageForSession(sessionId, encrypted);
```

## Spécifications ML-KEM-768

```
Paramètres:
- k = 3 (dimension module)
- n = 256 (degré polynôme)
- q = 3329 (module premier)

Tailles:
- Clé publique: 1184 bytes
- Clé secrète: 2400 bytes
- Ciphertext: 1088 bytes
- Secret partagé: 32 bytes

Sécurité:
- ~192 bits classique
- Résistant Shor (quantique)
- NIST FIPS 203 standardisé
```

## Architecture Triple Ratchet

```
┌─────────────────────────────────────────────────────────────┐
│                     TRIPLE RATCHET                          │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────┐  ┌────────────┐  ┌────────────────────────┐ │
│  │DH RATCHET │  │ SYMMETRIC  │  │ SPQR                   │ │
│  │ (X25519)  │  │  RATCHET   │  │ (ML-KEM-768)           │ │
│  │           │  │            │  │                        │ │
│  │ Forward   │  │ Per-msg    │  │ Rotation périodique    │ │
│  │ Secrecy   │  │ keys       │  │ Post-quantum           │ │
│  └─────┬─────┘  └─────┬──────┘  └───────────┬────────────┘ │
│        │              │                      │              │
│        └──────────────┴──────────────────────┘              │
│                       │                                     │
│                       ▼                                     │
│              ┌─────────────────┐                           │
│              │  Root Key       │                           │
│              │  KDF(DH ║ PQ)   │                           │
│              └────────┬────────┘                           │
│                       │                                     │
│                       ▼                                     │
│              ┌─────────────────┐                           │
│              │  XSalsa20-      │                           │
│              │  Poly1305       │                           │
│              └─────────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

## Protocole d'échange PQXDH

```
Alice                                          Bob
  │                                              │
  │           ←── PreKey Bundle (PQ) ───         │
  │           IK_B, SPK_B, OPK_B, KEM_PK_B       │
  │                                              │
  │  DH1 = X25519(IK_A_dh, SPK_B)               │
  │  DH2 = X25519(EK_A, IK_B_dh)                │
  │  DH3 = X25519(EK_A, SPK_B)                  │
  │  DH4 = X25519(EK_A, OPK_B)                  │
  │  (ct, ss) = ML-KEM.Encaps(KEM_PK_B)         │
  │                                              │
  │  SK = KDF(DH1║DH2║DH3║DH4║ss)               │
  │                                              │
  │           ─── Initial Message ───→           │
  │           IK_A, EK_A, ct                     │
  │                                              │
  │                    DH1 = X25519(SPK_B, IK_A_dh)
  │                    DH2 = X25519(IK_B_dh, EK_A)
  │                    DH3 = X25519(SPK_B, EK_A)
  │                    DH4 = X25519(OPK_B, EK_A)
  │                    ss = ML-KEM.Decaps(ct)
  │                                              │
  │                    SK = KDF(DH1║DH2║DH3║DH4║ss)
  │                                              │
```

## Configuration SPQR

```typescript
const SPQR_CONFIG = {
  ratchetInterval: 50,        // Rotation ML-KEM tous les 50 msgs
  maxMessagesWithoutPQ: 100,  // Rotation forcée après 100 msgs
  enableBraid: true,          // Chunking activé
  chunksPerMessage: 4,        // Chunks ML-KEM par message
};
```

## Types de message (wire format)

**Invitation:**
```json
{
  "version": 2,
  "type": "ghostr_invite_pq",
  "bundle": "<PQPreKeyBundle JSON>",
  "profile": { "displayName": "..." },
  "tag": "<random 32 hex chars>"
}
```

**Acceptation:**
```json
{
  "version": 2,
  "type": "ghostr_accept_pq",
  "pqxdhMessage": "<PQXDHMessage JSON>",
  "profile": { "displayName": "..." }
}
```

**Message chiffré:**
```json
{
  "version": 2,
  "message": {
    "header": "<TripleRatchetHeader JSON>",
    "ciphertext": "<base64>",
    "nonce": "<base64>"
  },
  "timestamp": 1234567890
}
```

## Références

- [Signal PQXDH Specification](https://signal.org/docs/specifications/pqxdh/)
- [NIST FIPS 203 - ML-KEM](https://csrc.nist.gov/pubs/fips/203/final)
- [Triple Ratchet with SPQR (Eurocrypt 2025)](https://eprint.iacr.org/)
- [RFC 5869 - HKDF](https://tools.ietf.org/html/rfc5869)

## Licence

Propriétaire - Ghostr
