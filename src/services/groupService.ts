// ════════════════════════════════════════════════════════════════════════════
// groupService.ts — Cœur cryptographique & données des conversations de groupe
// ════════════════════════════════════════════════════════════════════════════
//
// PHASE 3A — la couche la plus critique, conçue pour être VÉRIFIABLE EN ISOLATION
// (round-trip chiffrement, ratchet, rotation testés sans dépendance réseau/UI).
//
// MODÈLE : Sender Keys (cf. CONCEPTION-GROUPES.md §1)
//   • Chaque membre possède une CHAIN KEY d'émission qui ratchet par message
//     (hash ratchet HKDF → forward secrecy intra-groupe).
//   • Cette senderKey est distribuée aux autres via les sessions 1:1 Triple
//     Ratchet existantes (PQXDH + SPQR/ML-KEM-768) — fait par la couche réseau
//     (Phase 3B), PAS ici. Ce module ne fait QUE la crypto + l'état.
//   • Le contenu est chiffré UNE fois avec la senderKey, puis (couche réseau)
//     ré-encapsulé par-destinataire dans la session 1:1 → on hérite du sealed
//     sender et des tags. Ici on ne s'occupe que de la couche senderKey.
//
// CHIFFREMENT : nacl.secretbox (XSalsa20-Poly1305), identique au 1:1.
// DÉRIVATION  : HKDF (réutilise les primitives de tripleRatchet/primitives).
//
// SÉCURITÉ
//   • Forward secrecy intra-groupe : chain key avancée ⇒ anciennes messageKeys
//     non dérivables (cache borné pour la livraison désordonnée).
//   • Rotation à chaque add/remove (epoch++) : un membre retiré, qui détient
//     les anciennes chain keys, ne peut plus déchiffrer après rotation (PCS).
//   • Le nouveau membre N'OBTIENT PAS l'historique (chain keys dérivées par
//     epoch ; il ne reçoit que celles de son epoch d'entrée et suivantes).
//
// AUTORITÉ : modèle admin-centrique (option C). Le créateur est admin ; il peut
//   promouvoir des co-admins. Seuls les admins ajoutent/retirent/approuvent.
//   (L'APPLICATION de ces règles se fait à la couche réseau ; ce module fournit
//   les helpers de rôle et la mutation d'état.)
//
// ════════════════════════════════════════════════════════════════════════════

import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import { encryptIfEnabled, decryptIfNeeded, hasAnyEncryptionKey } from './localCrypto';
import {
  hkdfSync,
  hkdfExpand,
  hmacSha256,
  createMessageKey,
  encrypt as symEncrypt,
  decrypt as symDecrypt,
  bytesToHex,
  hexToBytes,
  zeroize,
  getSecureRandomBytes,
} from './tripleRatchet/primitives';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

declare const __DEV__: boolean;

// ────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = '@ghostr_groups_v2'; // _v2 : @ghostr_groups est déjà pris

/** Domain separation pour la dérivation des chain keys de groupe. */
const SENDERKEY_INFO = 'ghostr-group-senderkey-v1';
const RATCHET_MSG_INFO = 'ghostr-group-msgkey-v1';
const RATCHET_CHAIN_INFO = 'ghostr-group-chainstep-v1';
const GROUPSEED_LABEL = 'ghostr-group-seed-v1';

/** Taille maximale d'un groupe (décision produit). */
export const MAX_GROUP_MEMBERS = 50;

/**
 * Nombre maximum de messageKeys « sautées » conservées par chaîne de réception,
 * pour déchiffrer les messages arrivés dans le désordre. Analogue au MAX_SKIP du
 * Triple Ratchet (50). Au-delà, on suppose une désync → group_key_request.
 */
const MAX_SKIP_PER_CHAIN = 200;

/** Cap dur sur le cache de messageKeys sautées (toutes chaînes confondues). */
const MAX_SKIPPED_TOTAL = 2000;

const KEY_LEN = 32;
const ID_LEN = 16;

/**
 * Domaine de séparation pour la signature d'expéditeur de groupe (Phase 2).
 * La signature Ed25519 couvre groupId‖epoch‖gen‖senderFingerprint‖nonce‖ct,
 * ce qui authentifie l'émetteur de façon cryptographique (indépendamment du
 * transport) et empêche tout membre de forger un message attribué à un autre.
 */
const GROUP_MSG_SIG_DOMAIN = 'ghostr-group-msg-sig-v1';

// ────────────────────────────────────────────────────────────────────────────
// FOURNISSEUR D'IDENTITÉ (signature d'expéditeur)
// ────────────────────────────────────────────────────────────────────────────
//
// La couche applicative DOIT câbler ce fournisseur AU DÉMARRAGE (une fois la
// session/identité chargée) :
//
//   import { setGroupIdentityProvider } from './groupService';
//   setGroupIdentityProvider({
//     getMySigningSecretKey: () => sessionService.identityKeyPair?.secretKey?.bytes ?? null,
//     getMyIdentityPublicKey: () => sessionService.identityKeyPair?.publicKey?.bytes ?? null,
//   });
//
// `getMySigningSecretKey` renvoie la clé secrète Ed25519 (64o, format tweetnacl).
// `getMyIdentityPublicKey` renvoie la clé publique Ed25519 (32o) ; son hex tronqué
// à 16 caractères DOIT être égal au fingerprint du membre (modèle d'identité de
// l'app : fingerprint = hex(identityPublicKey)[:16]).

export interface GroupIdentityProvider {
  getMySigningSecretKey: () => Uint8Array | null;
  getMyIdentityPublicKey: () => Uint8Array | null;
}

let _identityProvider: GroupIdentityProvider | null = null;
/** Active la signature/vérification stricte. true par défaut (sécurité). */
let _enforceSignatures = true;

export function setGroupIdentityProvider(p: GroupIdentityProvider | null): void {
  _identityProvider = p;
}

/**
 * Active/désactive l'EXIGENCE de signature à la réception. À NE désactiver que
 * pour des migrations contrôlées (ex. compat ascendante temporaire). En
 * production, garder true.
 */
export function setGroupSignatureEnforcement(enforce: boolean): void {
  _enforceSignatures = enforce;
}

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export type GroupRole = 'admin' | 'member';

export interface GroupMember {
  fingerprint: string;            // identité (hex) — clé primaire
  sessionId: string;              // session 1:1 vers ce membre (distribution des clés)
  displayName: string;
  avatarBase64?: string;
  role: GroupRole;
  joinedAtEpoch: number;          // epoch d'entrée → borne l'historique visible
  // Chaîne de RÉCEPTION : la senderKey de CE membre, telle qu'il nous l'a donnée.
  recvChainKey?: string;          // base64 (32o) ; absent tant que non reçue
  recvGen: number;                // index courant de sa chaîne de réception
  recvEpoch: number;              // epoch de la chaîne de réception détenue
  senderKeyAckedEpoch: number;    // dernière epoch dont CE membre a ACK NOTRE senderKey
  // Clé publique d'identité Ed25519 (hex, 32o) de CE membre, si connue. Sert au
  // liage FORT de la signature d'expéditeur (Phase 2). Quand absente, on retombe
  // sur le liage via le préfixe de fingerprint = hex(identityPublicKey)[:16].
  identityPub?: string;
}

export interface GroupTicket {
  ticketId: string;
  secret: string;                 // base64 ; prouvé par le joiner, jamais au serveur
  createdAt: number;
  expiresAt: number;
  maxUses: number;                // 0 = illimité
  uses: number;
  revoked: boolean;
}

/** messageKey sautée mise en cache (réception désordonnée). */
interface SkippedKey {
  fp: string;                     // émetteur
  epoch: number;
  gen: number;
  key: string;                    // base64 de la messageKey
  cachedAt: number;
}

export interface GroupRecord {
  groupId: string;
  groupSeed: string;              // base64 (32o) — secret racine
  name: string;
  avatarBase64?: string;
  description?: string;
  createdAt: number;
  epoch: number;                  // version CRYPTO du roster : ne change qu'au RETRAIT (rotation)
  rosterVersion: number;          // version du roster : change à CHAQUE modif (ajout inclus)
  myFingerprint: string;
  members: GroupMember[];         // roster (inclut moi)
  // MA chaîne d'ÉMISSION pour l'epoch courante :
  sendChainKey: string;           // base64 (32o)
  sendGen: number;                // index courant de ma chaîne d'émission
  sendEpoch: number;              // epoch de ma chaîne d'émission
  tickets: GroupTicket[];         // tickets d'invitation (admin)
  approvalRequired: boolean;      // approbation admin des demandes de jonction
  muted?: boolean;
  skipped: SkippedKey[];          // cache de messageKeys sautées (réception désordonnée)
}

/** Payload de groupe (en clair APRÈS déchiffrement de la session 1:1).
 *  C'est ce que la couche réseau encapsule/décapsule. */
export interface GroupCiphertext {
  groupId: string;
  senderFingerprint: string;
  epoch: number;
  gen: number;
  ct: string;                     // base64 du ciphertext senderKey
  nonce: string;                  // base64 du nonce
  // Phase 2 — authentification d'expéditeur (Ed25519).
  senderIdentityPub?: string;     // base64 (32o) — clé publique Ed25519 de l'émetteur
  senderSig?: string;             // base64 (64o) — signature détachée du transcript
}

// ────────────────────────────────────────────────────────────────────────────
// ÉTAT (module-scope)
// ────────────────────────────────────────────────────────────────────────────

const groups = new Map<string, GroupRecord>();
let _loaded = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

// ────────────────────────────────────────────────────────────────────────────
// HELPERS BASE64 — délègue à tweetnacl-util (déjà dépendance du projet, utilisé
// partout ailleurs ; garantit un comportement identique en RN/Hermes et Node).
// ────────────────────────────────────────────────────────────────────────────

function b64encode(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

function b64decode(s: string): Uint8Array {
  return decodeBase64(s);
}

// ────────────────────────────────────────────────────────────────────────────
// DÉRIVATION DES SENDER KEYS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Dérive la chain key INITIALE d'un membre pour une epoch donnée.
 *
 *   chainKey0 = HKDF(ikm = groupSeed,
 *                    salt = SHA256-domain(fingerprint || epoch),
 *                    info = SENDERKEY_INFO, len = 32)
 *
 * Déterministe : tout membre connaissant groupSeed + (fingerprint, epoch) peut
 * la recalculer. Mais comme groupSeed est secret (jamais hors du groupe), seuls
 * les membres le peuvent. C'est ce qui permet à un membre de RÉGÉNÉRER sa propre
 * senderKey à une nouvelle epoch sans coordination (rotation).
 *
 * NB : on n'expose JAMAIS chainKey0 d'un autre membre en la recalculant — chaque
 * membre distribue SA chaîne via le canal 1:1. La dérivation déterministe sert
 * uniquement à ce que CHACUN génère LA SIENNE de façon reproductible.
 */
/**
 * @deprecated Phase 1 — NE PLUS UTILISER pour des clés vivantes. La dérivation
 * déterministe d'une chaîne à partir d'un `groupSeed` partagé permettait à tout
 * détenteur de la graine (membre actuel, retiré ou nouvel arrivant) de recalculer
 * la chaîne de n'importe quel membre → absence de PCS au retrait, fuite de
 * l'historique à la jonction, et usurpation intra-groupe. Les chaînes sont
 * désormais ALÉATOIRES (cf. `freshChainKey`) et distribuées via les sessions 1:1.
 * Fonction conservée uniquement pour référence/tests de non-régression.
 */
export function deriveInitialChainKey(
  groupSeedB64: string,
  fingerprint: string,
  epoch: number
): Uint8Array {
  const groupSeed = b64decode(groupSeedB64);
  // salt = HMAC(groupSeed-label, fingerprint||epoch) — domain separation forte.
  const label = new TextEncoder().encode(GROUPSEED_LABEL);
  const fpBytes = hexToBytes(fingerprint);
  const epochBytes = u32be(epoch);
  const saltInput = concat(fpBytes, epochBytes);
  const salt = hmacSha256(label, saltInput);
  const ck = hkdfSync(groupSeed, salt, SENDERKEY_INFO, KEY_LEN);
  zeroize(groupSeed);
  zeroize(salt);
  return ck;
}

/**
 * Un pas de ratchet symétrique :
 *   messageKey = HKDF-Expand(chainKey, RATCHET_MSG_INFO, 32)
 *   nextChain  = HKDF-Expand(chainKey, RATCHET_CHAIN_INFO, 32)
 * Renvoie {messageKey, nextChainKey}. N'altère pas l'entrée.
 */
function ratchetStep(chainKey: Uint8Array): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
  const messageKey = hkdfExpand(chainKey, new TextEncoder().encode(RATCHET_MSG_INFO), KEY_LEN);
  const nextChainKey = hkdfExpand(chainKey, new TextEncoder().encode(RATCHET_CHAIN_INFO), KEY_LEN);
  return { messageKey, nextChainKey };
}

// ────────────────────────────────────────────────────────────────────────────
// PETITS UTILITAIRES BINAIRES
// ────────────────────────────────────────────────────────────────────────────

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function randomId(): string {
  return bytesToHex(getSecureRandomBytes(ID_LEN));
}

// ────────────────────────────────────────────────────────────────────────────
// CHIFFREMENT / DÉCHIFFREMENT DE GROUPE (couche senderKey)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Génère une chaîne d'émission INITIALE aléatoire (Phase 1). Remplace l'ancienne
 * dérivation déterministe `deriveInitialChainKey(groupSeed, fp, epoch)` : une
 * chaîne ne doit JAMAIS être recalculable par un tiers (membre actuel, retiré ou
 * futur). Chaque membre génère SA chaîne localement et la distribue via les
 * sessions 1:1 authentifiées.
 */
function freshChainKey(): Uint8Array {
  return getSecureRandomBytes(KEY_LEN);
}

/**
 * Construit le transcript signé d'un message de groupe :
 *   domain ‖ groupId ‖ u32(epoch) ‖ u32(gen) ‖ fingerprintBytes ‖ nonce ‖ ct
 * Lie tous les champs d'en-tête au ciphertext → pas de réutilisation/réflexion.
 */
function buildSigTranscript(
  groupId: string, epoch: number, gen: number,
  senderFingerprint: string, nonce: Uint8Array, ciphertext: Uint8Array
): Uint8Array {
  const domain = new TextEncoder().encode(GROUP_MSG_SIG_DOMAIN);
  const gidBytes = new TextEncoder().encode(groupId);
  const fpBytes = hexToBytes(senderFingerprint);
  return concat(domain, gidBytes, u32be(epoch), u32be(gen), fpBytes, nonce, ciphertext);
}

/**
 * Vérifie l'authentification d'expéditeur d'un GroupCiphertext.
 * - Exige une clé publique + signature quand l'enforcement est actif.
 * - Lie la clé publique au fingerprint du roster : hex(pub)[:16] === senderFingerprint
 *   (modèle d'identité de l'app) ; si la clé d'identité complète du membre est
 *   connue (member.identityPub), exige une égalité EXACTE (liage fort).
 * - Vérifie la signature Ed25519 sur le transcript.
 * Renvoie true si authentique (ou si l'enforcement est désactivé ET qu'aucune
 * signature n'est fournie — chemin de compat explicite).
 */
function verifySenderAuth(c: GroupCiphertext, member: GroupMember): boolean {
  if (!c.senderSig || !c.senderIdentityPub) {
    if (_enforceSignatures) {
      __DEV__ && console.warn('[groupService] message non signé rejeté (enforcement actif)');
      return false;
    }
    return true; // compat explicite : pas de signature et enforcement off
  }
  let pub: Uint8Array, sig: Uint8Array;
  try {
    pub = b64decode(c.senderIdentityPub);
    sig = b64decode(c.senderSig);
  } catch {
    return false;
  }
  if (pub.length !== 32 || sig.length !== 64) return false;

  // Liage clé publique ↔ identité du roster.
  const pubFpPrefix = bytesToHex(pub).substring(0, 16);
  if (pubFpPrefix !== c.senderFingerprint) {
    __DEV__ && console.warn('[groupService] clé d\'identité non liée au fingerprint — rejeté');
    return false;
  }
  if (member.identityPub) {
    // Liage FORT : la clé publique exacte est connue → doit correspondre.
    if (member.identityPub.toLowerCase() !== bytesToHex(pub).toLowerCase()) {
      __DEV__ && console.warn('[groupService] clé d\'identité ≠ clé connue du membre — rejeté');
      return false;
    }
  }

  const transcript = buildSigTranscript(c.groupId, c.epoch, c.gen, c.senderFingerprint, b64decode(c.nonce), b64decode(c.ct));
  const ok = nacl.sign.detached.verify(transcript, sig, pub);
  if (!ok) __DEV__ && console.warn('[groupService] signature invalide — rejeté');
  return ok;
}


/**
 * Chiffre un plaintext avec MA chaîne d'émission, avance la chaîne, et renvoie
 * le GroupCiphertext (à passer à la couche réseau pour le fan-out).
 *
 * Idempotence/ordre : chaque message porte `gen` (= index AVANT avancement) et
 * `epoch`. Les récepteurs dérivent la bonne messageKey via ces deux champs.
 */
export function encryptGroupMessage(groupId: string, plaintext: string): GroupCiphertext | null {
  const g = groups.get(groupId);
  if (!g) {
    __DEV__ && console.warn('[groupService] encrypt: unknown group', groupId.slice(0, 8));
    return null;
  }
  const chainKey = b64decode(g.sendChainKey);
  const { messageKey, nextChainKey } = ratchetStep(chainKey);
  try {
    const mk = createMessageKey(messageKey);
    const ptBytes = new TextEncoder().encode(plaintext);
    const { ciphertext, nonce } = symEncrypt(ptBytes, mk);

    const out: GroupCiphertext = {
      groupId,
      senderFingerprint: g.myFingerprint,
      epoch: g.sendEpoch,
      gen: g.sendGen,
      ct: b64encode(ciphertext),
      nonce: b64encode(nonce),
    };

    // Phase 2 — signer le transcript avec MA clé d'identité Ed25519.
    const signSk = _identityProvider?.getMySigningSecretKey?.() ?? null;
    const idPub = _identityProvider?.getMyIdentityPublicKey?.() ?? null;
    if (signSk && idPub) {
      const transcript = buildSigTranscript(groupId, out.epoch, out.gen, out.senderFingerprint, nonce, ciphertext);
      const sig = nacl.sign.detached(transcript, signSk);
      out.senderIdentityPub = b64encode(idPub);
      out.senderSig = b64encode(sig);
    } else if (_enforceSignatures) {
      // L'enforcement est actif mais l'identité n'est pas câblée → on refuse
      // d'émettre un message qui serait rejeté par les destinataires.
      __DEV__ && console.warn('[groupService] encrypt: fournisseur d\'identité absent alors que l\'enforcement est actif — message non émis');
      zeroize(messageKey);
      zeroize(nextChainKey);
      zeroize(chainKey);
      return null;
    }

    // Avance la chaîne (forward secrecy) et persiste.
    g.sendChainKey = b64encode(nextChainKey);
    g.sendGen += 1;
    groups.set(groupId, g);
    schedulePersist();

    zeroize(messageKey);
    zeroize(nextChainKey);
    zeroize(chainKey);
    return out;
  } catch (e) {
    __DEV__ && console.warn('[groupService] encrypt failed:', e);
    zeroize(messageKey);
    zeroize(nextChainKey);
    zeroize(chainKey);
    return null;
  }
}

/**
 * Déchiffre un GroupCiphertext reçu d'un membre. Gère la réception désordonnée
 * (avance la chaîne de réception du membre jusqu'à `gen`, met en cache les
 * messageKeys sautées) et le rejeu (réutilise une clé sautée puis la consomme).
 *
 * Retourne le plaintext, ou null si on n'a pas la chaîne (→ group_key_request),
 * si l'epoch ne correspond pas, ou si l'authentification échoue.
 */
export function decryptGroupMessage(c: GroupCiphertext): { plaintext: string; senderFingerprint: string } | null {
  const g = groups.get(c.groupId);
  if (!g) return null;

  const member = g.members.find(m => m.fingerprint === c.senderFingerprint);
  if (!member) {
    __DEV__ && console.warn('[groupService] decrypt: sender not in roster');
    return null;
  }

  // Phase 2 — AUTHENTIFICATION D'EXPÉDITEUR (avant toute manipulation d'état).
  // Empêche tout membre de forger un message attribué à un autre, et bloque
  // qu'un message forgé ne consomme une clé sautée / n'avance la chaîne.
  if (!verifySenderAuth(c, member)) {
    return null;
  }

  // 1) Clé sautée déjà en cache ? (réception désordonnée / rejeu)
  const skIdx = g.skipped.findIndex(
    s => s.fp === c.senderFingerprint && s.epoch === c.epoch && s.gen === c.gen
  );
  if (skIdx >= 0) {
    const sk = g.skipped[skIdx];
    const pt = trySymDecrypt(b64decode(sk.key), c);
    if (pt !== null) {
      // Consommer la clé sautée (anti-rejeu : une seule utilisation).
      g.skipped.splice(skIdx, 1);
      groups.set(c.groupId, g);
      schedulePersist();
      return { plaintext: pt, senderFingerprint: c.senderFingerprint };
    }
    return null; // clé présente mais auth échoue → message corrompu/forgé
  }

  // 2) Pas de chaîne de réception pour ce membre, ou epoch trop ancienne ?
  if (!member.recvChainKey || member.recvEpoch !== c.epoch) {
    // On ne peut pas (encore) déchiffrer ce message. La couche réseau émettra un
    // group_key_request ciblé. Si recvEpoch < c.epoch, on attend la nouvelle
    // senderKey (rotation). Si recvEpoch > c.epoch, message d'une epoch révolue
    // → on l'ignore.
    __DEV__ && console.log(`[groupService] decrypt: missing/old recv chain for ${c.senderFingerprint.slice(0,8)} (have epoch ${member.recvEpoch}, msg epoch ${c.epoch})`);
    return null;
  }

  // 3) Le message est-il antérieur à notre position courante mais pas en cache ?
  //    → clé déjà consommée (rejeu) ou jamais sautée → refus.
  if (c.gen < member.recvGen) {
    __DEV__ && console.warn('[groupService] decrypt: gen < recvGen and not cached (replay?)');
    return null;
  }

  // 4) Avancer la chaîne de réception de recvGen → c.gen, en cachant les sauts.
  let chainKey = b64decode(member.recvChainKey);
  const jump = c.gen - member.recvGen;
  if (jump > MAX_SKIP_PER_CHAIN) {
    __DEV__ && console.warn(`[groupService] decrypt: jump ${jump} > MAX_SKIP → desync, will request key`);
    zeroize(chainKey);
    return null; // trop loin → la couche réseau redemandera la senderKey
  }

  let result: string | null = null;
  for (let i = member.recvGen; i <= c.gen; i++) {
    const { messageKey, nextChainKey } = ratchetStep(chainKey);
    if (i === c.gen) {
      result = trySymDecrypt(messageKey, c);
      zeroize(messageKey);
    } else {
      // messageKey sautée → cache pour un message antérieur encore en vol.
      pushSkipped(g, {
        fp: c.senderFingerprint, epoch: c.epoch, gen: i,
        key: b64encode(messageKey), cachedAt: Date.now(),
      });
      zeroize(messageKey);
    }
    zeroize(chainKey);
    chainKey = nextChainKey;
  }

  if (result === null) {
    // Auth échouée sur le message cible : NE PAS avancer l'état (le message est
    // invalide ; on restaure en ne persistant pas l'avancement).
    zeroize(chainKey);
    return null;
  }

  // Avancement validé : la nouvelle position est c.gen + 1.
  member.recvChainKey = b64encode(chainKey);
  member.recvGen = c.gen + 1;
  zeroize(chainKey);
  groups.set(c.groupId, g);
  schedulePersist();

  return { plaintext: result, senderFingerprint: c.senderFingerprint };
}

function trySymDecrypt(messageKeyBytes: Uint8Array, c: GroupCiphertext): string | null {
  try {
    const mk = createMessageKey(messageKeyBytes);
    const pt = symDecrypt(b64decode(c.ct), b64decode(c.nonce), mk);
    if (!pt) return null;
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function pushSkipped(g: GroupRecord, sk: SkippedKey): void {
  g.skipped.push(sk);
  if (g.skipped.length > MAX_SKIPPED_TOTAL) {
    // Évince les plus anciennes.
    g.skipped.sort((a, b) => a.cachedAt - b.cachedAt);
    g.skipped.splice(0, g.skipped.length - MAX_SKIPPED_TOTAL);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GESTION DU ROSTER / EPOCH / ROTATION
// ────────────────────────────────────────────────────────────────────────────

/**
 * Crée un groupe localement (côté admin créateur). Génère groupId + groupSeed,
 * initialise MA chaîne d'émission à l'epoch 0. Le créateur est admin.
 */
export function createGroupLocal(params: {
  name: string;
  myFingerprint: string;
  myDisplayName: string;
  myAvatarBase64?: string;
  description?: string;
  approvalRequired?: boolean;
}): GroupRecord {
  const groupId = randomId();
  // `groupSeed` n'est PLUS un secret de dérivation (Phase 1). Conservé comme
  // identifiant opaque/legacy (compat de forme d'enregistrement + welcome).
  const groupSeed = b64encode(getSecureRandomBytes(KEY_LEN));
  const epoch = 0;

  // Phase 1 : MA chaîne d'émission est ALÉATOIRE (jamais dérivée d'une graine
  // partagée → non recalculable par un tiers).
  const myChain = freshChainKey();

  const me: GroupMember = {
    fingerprint: params.myFingerprint,
    sessionId: '', // soi-même : pas de session
    displayName: params.myDisplayName,
    avatarBase64: params.myAvatarBase64,
    role: 'admin',
    joinedAtEpoch: epoch,
    recvEpoch: epoch,
    recvGen: 0,
    senderKeyAckedEpoch: epoch,
  };

  const g: GroupRecord = {
    groupId,
    groupSeed,
    name: params.name,
    avatarBase64: params.myAvatarBase64 ? undefined : undefined,
    description: params.description,
    createdAt: Date.now(),
    epoch,
    rosterVersion: 0,
    myFingerprint: params.myFingerprint,
    members: [me],
    sendChainKey: b64encode(myChain),
    sendGen: 0,
    sendEpoch: epoch,
    tickets: [],
    approvalRequired: params.approvalRequired ?? true,
    skipped: [],
  };
  zeroize(myChain);

  groups.set(groupId, g);
  schedulePersist();
  return g;
}

/**
 * Enregistre/charge un groupe reçu via group_welcome (côté nouveau membre).
 * Initialise MA propre chaîne d'émission pour l'epoch courante (déterministe),
 * et stocke les chaînes de réception fournies pour les membres.
 */
export function adoptGroupFromWelcome(params: {
  groupId: string;
  groupSeed: string;
  name: string;
  avatarBase64?: string;
  description?: string;
  epoch: number;
  myFingerprint: string;
  myDisplayName: string;
  myAvatarBase64?: string;
  members: Array<Omit<GroupMember, 'recvChainKey' | 'recvGen' | 'recvEpoch' | 'senderKeyAckedEpoch'> & {
    recvChainKey?: string; recvGen?: number; recvEpoch?: number;
  }>;
  approvalRequired: boolean;
  rosterVersion?: number;
}): GroupRecord {
  // Phase 1 : MA chaîne d'émission est ALÉATOIRE (et sera distribuée aux autres
  // via les sessions 1:1). `params.groupSeed` n'est plus utilisé pour dériver
  // quoi que ce soit (conservé pour compat de la forme du welcome).
  const myChain = freshChainKey();

  const members: GroupMember[] = params.members.map(m => ({
    fingerprint: m.fingerprint,
    sessionId: m.sessionId,
    displayName: m.displayName,
    avatarBase64: m.avatarBase64,
    role: m.role,
    joinedAtEpoch: m.joinedAtEpoch,
    recvChainKey: m.recvChainKey,
    recvGen: m.recvGen ?? 0,
    recvEpoch: m.recvEpoch ?? params.epoch,
    senderKeyAckedEpoch: params.epoch,
  }));

  const g: GroupRecord = {
    groupId: params.groupId,
    groupSeed: params.groupSeed,
    name: params.name,
    avatarBase64: params.avatarBase64,
    description: params.description,
    createdAt: Date.now(),
    epoch: params.epoch,
    rosterVersion: params.rosterVersion ?? 0,
    myFingerprint: params.myFingerprint,
    members,
    sendChainKey: b64encode(myChain),
    sendGen: 0,
    sendEpoch: params.epoch,
    tickets: [],
    approvalRequired: params.approvalRequired,
    skipped: [],
  };
  zeroize(myChain);

  groups.set(params.groupId, g);
  schedulePersist();
  return g;
}

/**
 * Enregistre la clé publique d'identité Ed25519 (hex, 32o) d'un membre, pour le
 * liage FORT de la signature d'expéditeur. À appeler quand le bundle/clé publique
 * d'un membre devient connu (ex. via storeMemberBundle / réception de bundle).
 * Refuse une clé dont l'hex tronqué ne correspond pas au fingerprint du membre.
 */
export function setMemberIdentityPub(groupId: string, fingerprint: string, identityPubHex: string): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  const m = g.members.find(x => x.fingerprint === fingerprint);
  if (!m) return false;
  if (identityPubHex.toLowerCase().substring(0, 16) !== fingerprint.toLowerCase()) {
    __DEV__ && console.warn('[groupService] setMemberIdentityPub: clé non liée au fingerprint — refusé');
    return false;
  }
  m.identityPub = identityPubHex.toLowerCase();
  groups.set(groupId, g);
  schedulePersist();
  return true;
}

/**
 * Stocke la senderKey (chaîne de réception) qu'un membre nous a distribuée.
 * Appelé à la réception d'un group_senderkey / group_welcome.
 */
export function setMemberSenderKey(
  groupId: string,
  fingerprint: string,
  recvChainKeyB64: string,
  epoch: number,
  startGen: number = 0
): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  const m = g.members.find(x => x.fingerprint === fingerprint);
  if (!m) return false;
  // Ne JAMAIS régresser : ni l'epoch, ni le gen au sein d'une même epoch.
  // (Sinon un relais d'une senderKey plus ancienne — fréquent avec la
  // rediffusion admin — ferait reculer recvGen, base de l'anti-replay de
  // decryptGroupMessage → re-dérivation et messages DUPLIQUÉS.)
  if (m.recvChainKey) {
    if (m.recvEpoch > epoch) return false;
    if (m.recvEpoch === epoch && startGen < m.recvGen) return false;
  }
  m.recvChainKey = recvChainKeyB64;
  m.recvEpoch = epoch;
  m.recvGen = startGen;
  groups.set(groupId, g);
  schedulePersist();
  return true;
}

/**
 * Ajoute un membre au roster. CORRECTION v2 : NE touche NI l'epoch NI les
 * chaînes (un ajout ne doit invalider aucun message en vol). Incrémente
 * seulement `rosterVersion`. Le nouveau membre recevra les Sender Keys
 * courantes à leur génération ACTUELLE (cf. exportMySenderKeyAtCurrentGen) →
 * forward secrecy préservée SANS re-chaînage.
 *
 * Renvoie la nouvelle rosterVersion, ou null si plein/erreur.
 *
 * AUTORITÉ : à n'appeler que si admin (vérifié par la couche réseau).
 */
export function addMemberLocal(groupId: string, member: Omit<GroupMember, 'recvGen' | 'recvEpoch' | 'senderKeyAckedEpoch'>): number | null {
  const g = groups.get(groupId);
  if (!g) return null;
  if (g.members.length >= MAX_GROUP_MEMBERS) {
    __DEV__ && console.warn('[groupService] addMember: group full (max', MAX_GROUP_MEMBERS, ')');
    return null;
  }
  if (g.members.some(m => m.fingerprint === member.fingerprint)) {
    return g.rosterVersion; // déjà membre : no-op
  }
  g.members.push({
    ...member,
    joinedAtEpoch: g.epoch,        // entre à l'epoch COURANTE (pas de rotation)
    recvGen: 0,
    recvEpoch: g.epoch,
    senderKeyAckedEpoch: g.epoch,
  });
  g.rosterVersion += 1;            // SEUL incrément : la version du roster
  // epoch, sendChainKey, sendGen : INCHANGÉS → aucun message en vol cassé.
  groups.set(groupId, g);
  schedulePersist();
  return g.rosterVersion;
}

/**
 * Retire un membre et incrémente l'epoch (rotation obligatoire — le membre
 * retiré détient les anciennes chain keys → PCS). Incrémente AUSSI
 * rosterVersion. Renvoie la nouvelle epoch.
 */
export function removeMemberLocal(groupId: string, fingerprint: string): number | null {
  const g = groups.get(groupId);
  if (!g) return null;
  const before = g.members.length;
  g.members = g.members.filter(m => m.fingerprint !== fingerprint);
  if (g.members.length === before) return g.epoch; // pas membre : no-op
  const newEpoch = g.epoch + 1;
  g.rosterVersion += 1;
  // Purge les chaînes de réception des membres restants : elles seront
  // redistribuées par chacun à la nouvelle epoch. Purge les clés sautées
  // (elles appartiennent à l'ancienne epoch).
  for (const m of g.members) {
    if (m.fingerprint !== g.myFingerprint) {
      m.recvChainKey = undefined;
      m.recvEpoch = newEpoch - 1; // forcera l'attente de la nouvelle senderKey
      m.recvGen = 0;
    }
  }
  g.skipped = [];
  rotateToEpoch(g, newEpoch);
  return newEpoch;
}

/** Régénère MA chaîne d'émission à une nouvelle epoch et met à jour l'état. */
function rotateToEpoch(g: GroupRecord, newEpoch: number): void {
  // Phase 1 : nouvelle chaîne ALÉATOIRE (PCS réelle au retrait — un membre
  // retiré ne peut pas la recalculer, contrairement à l'ancienne dérivation
  // déterministe sur `groupSeed`). Chaque membre restant rediffuse la sienne.
  const newChain = freshChainKey();
  g.epoch = newEpoch;
  g.sendChainKey = b64encode(newChain);
  g.sendGen = 0;
  g.sendEpoch = newEpoch;
  zeroize(newChain);
  // Met à jour MON entrée de roster.
  const me = g.members.find(m => m.fingerprint === g.myFingerprint);
  if (me) { me.recvEpoch = newEpoch; me.recvGen = 0; }
  groups.set(g.groupId, g);
  schedulePersist();
}

/** Données d'un membre dans un état de roster transmis (réconciliation). */
export interface RosterStateMember {
  fingerprint: string;
  sessionId?: string;
  displayName: string;
  avatarBase64?: string;
  role: GroupRole;
  joinedAtEpoch: number;
}

/** Une senderKey transmise (welcome / roster_state / senderkey). */
export interface SenderKeyShare {
  fingerprint: string;
  chainKey: string;
  epoch: number;
  gen: number;
}

/**
 * RÉCONCILIATION (v2) : applique un état de roster reçu d'un admin. Idempotent
 * et tolérant à l'ordre : n'applique QUE si la version reçue est > la version
 * locale (ou si l'epoch reçue est plus récente). Comble les ajouts/retraits
 * manqués (y compris au-delà de la rétention serveur de 48 h).
 *
 * - Remplace le roster par celui reçu (en préservant les chaînes de réception
 *   déjà détenues quand la clé n'est pas re-fournie).
 * - Applique l'epoch reçue (si plus récente, ma chaîne d'émission tourne).
 * - Stocke les senderKeys fournies.
 *
 * Renvoie true si un changement a été appliqué.
 */
export function applyRosterState(params: {
  groupId: string;
  rosterVersion: number;
  epoch: number;
  roster: RosterStateMember[];
  senderKeys?: SenderKeyShare[];
  name?: string;
  avatarBase64?: string;
  description?: string;
}): boolean {
  const g = groups.get(params.groupId);
  if (!g) return false;

  // Idempotence : ne rien faire si on est déjà à jour (ou plus récent).
  if (params.rosterVersion <= g.rosterVersion && params.epoch <= g.epoch) {
    return false;
  }

  // Sauvegarde des chaînes de réception déjà détenues (pour ne pas les perdre
  // si l'état reçu ne les re-fournit pas).
  const prevRecv = new Map<string, { recvChainKey?: string; recvGen: number; recvEpoch: number }>();
  for (const m of g.members) {
    prevRecv.set(m.fingerprint, { recvChainKey: m.recvChainKey, recvGen: m.recvGen, recvEpoch: m.recvEpoch });
  }

  const epochAdvanced = params.epoch > g.epoch;

  // Reconstruire le roster.
  const newMembers: GroupMember[] = params.roster.map(rm => {
    const prev = prevRecv.get(rm.fingerprint);
    const isMe = rm.fingerprint === g.myFingerprint;
    // Préserver la session 1:1 déjà connue pour ce membre (le roster transmis
    // par l'admin contient SES sessionId, inutilisables par moi).
    const existing = g.members.find(m => m.fingerprint === rm.fingerprint);
    const sessionId = isMe ? '' : (existing?.sessionId || '');
    return {
      fingerprint: rm.fingerprint,
      sessionId,
      displayName: rm.displayName,
      avatarBase64: rm.avatarBase64,
      role: rm.role,
      joinedAtEpoch: rm.joinedAtEpoch,
      // Conserver la chaîne de réception détenue SAUF si l'epoch a avancé
      // (rotation → les anciennes chaînes ne valent plus).
      recvChainKey: epochAdvanced ? undefined : prev?.recvChainKey,
      recvGen: epochAdvanced ? 0 : (prev?.recvGen ?? 0),
      recvEpoch: epochAdvanced ? params.epoch : (prev?.recvEpoch ?? params.epoch),
      senderKeyAckedEpoch: prev ? params.epoch : params.epoch - 1,
    };
  });

  g.members = newMembers;
  g.rosterVersion = Math.max(g.rosterVersion, params.rosterVersion);
  if (params.name !== undefined) g.name = params.name;
  if (params.avatarBase64 !== undefined) g.avatarBase64 = params.avatarBase64;
  if (params.description !== undefined) g.description = params.description;

  // Si l'epoch a avancé (un retrait s'est produit pendant mon absence), je dois
  // tourner MA chaîne d'émission à la nouvelle epoch.
  if (epochAdvanced) {
    g.skipped = [];
    rotateToEpoch(g, params.epoch); // met aussi g.epoch = params.epoch et persiste
  } else {
    groups.set(params.groupId, g);
  }

  // Stocker les senderKeys fournies (après reconstruction du roster).
  for (const sk of (params.senderKeys || [])) {
    setMemberSenderKey(params.groupId, sk.fingerprint, sk.chainKey, sk.epoch, sk.gen);
  }

  schedulePersist();
  return true;
}

/**
 * Exporte toutes les Sender Keys que JE détiens actuellement (la mienne au gen
 * courant + celles des autres membres telles que je les ai reçues). Utilisé par
 * l'admin pour répondre à un group_roster_sync_request et pour enrichir un
 * group_welcome. Permet à un membre de récupérer les clés manquantes SANS
 * session directe avec chaque autre membre.
 */
export function exportHeldSenderKeys(groupId: string): SenderKeyShare[] {
  const g = groups.get(groupId);
  if (!g) return [];
  const out: SenderKeyShare[] = [];
  // La mienne, au gen courant.
  out.push({ fingerprint: g.myFingerprint, chainKey: g.sendChainKey, epoch: g.sendEpoch, gen: g.sendGen });
  // Celles des autres que je détiens.
  for (const m of g.members) {
    if (m.fingerprint !== g.myFingerprint && m.recvChainKey) {
      out.push({ fingerprint: m.fingerprint, chainKey: m.recvChainKey, epoch: m.recvEpoch, gen: m.recvGen });
    }
  }
  return out;
}

/**
 * Construit un snapshot d'état de roster (pour group_welcome / group_roster_state).
 */
export function buildRosterState(groupId: string): {
  rosterVersion: number; epoch: number; roster: RosterStateMember[];
  name: string; avatarBase64?: string; description?: string;
} | null {
  const g = groups.get(groupId);
  if (!g) return null;
  return {
    rosterVersion: g.rosterVersion,
    epoch: g.epoch,
    name: g.name,
    avatarBase64: g.avatarBase64,
    description: g.description,
    roster: g.members.map(m => ({
      fingerprint: m.fingerprint,
      sessionId: m.fingerprint === g.myFingerprint ? '' : m.sessionId,
      displayName: m.displayName,
      avatarBase64: m.avatarBase64,
      role: m.role,
      joinedAtEpoch: m.joinedAtEpoch,
    })),
  };
}

/**
 * Exporte MA senderKey courante. Utilisé à la rotation (retrait) : juste après
 * `rotateToEpoch`, `sendChainKey` est une chaîne ALÉATOIRE fraîche à gen 0.
 * (Phase 1 : il n'existe plus de « gen 0 dérivable » — on exporte l'état réel.)
 */
export function exportMySenderKey(groupId: string): { chainKey: string; epoch: number; gen: number } | null {
  const g = groups.get(groupId);
  if (!g) return null;
  return { chainKey: g.sendChainKey, epoch: g.sendEpoch, gen: g.sendGen };
}

/**
 * Exporte MA senderKey à la génération COURANTE (état actuel de ma chaîne
 * d'émission + sendGen). Utilisé pour l'AJOUT d'un membre et la RÉCONCILIATION.
 *
 * SÉCURITÉ (Phase 1) : la chaîne étant ALÉATOIRE et le ratchet à sens unique, le
 * destinataire qui pose recvChainKey = cette valeur / recvGen = gen ne peut PAS
 * remonter aux messages antérieurs — et, n'ayant plus de graine déterministe, ne
 * peut pas non plus recalculer le gen 0. La forward secrecy de jonction est donc
 * réellement assurée (ce qui n'était PAS le cas avec l'ancienne dérivation).
 */
export function exportMySenderKeyAtCurrentGen(groupId: string): { chainKey: string; epoch: number; gen: number } | null {
  const g = groups.get(groupId);
  if (!g) return null;
  // sendChainKey est l'état APRÈS sendGen pas de ratchet → c'est exactement
  // "la chaîne à partir de maintenant".
  return { chainKey: g.sendChainKey, epoch: g.sendEpoch, gen: g.sendGen };
}

// ────────────────────────────────────────────────────────────────────────────
// RÔLES / AUTORITÉ
// ────────────────────────────────────────────────────────────────────────────

export function isAdmin(groupId: string, fingerprint: string): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  return g.members.some(m => m.fingerprint === fingerprint && m.role === 'admin');
}

export function amIAdmin(groupId: string): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  return isAdmin(groupId, g.myFingerprint);
}

/** Promeut un membre admin (option C). Renvoie false si l'appelant n'est pas
 *  admin ou le membre est absent. (Garde d'autorité appliquée par le réseau.) */
export function promoteToAdminLocal(groupId: string, fingerprint: string): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  const m = g.members.find(x => x.fingerprint === fingerprint);
  if (!m) return false;
  m.role = 'admin';
  groups.set(groupId, g);
  schedulePersist();
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// TICKETS D'INVITATION (admin)
// ────────────────────────────────────────────────────────────────────────────

export function createTicket(groupId: string, opts?: { ttlMs?: number; maxUses?: number }): GroupTicket | null {
  const g = groups.get(groupId);
  if (!g) return null;
  const now = Date.now();
  const ticket: GroupTicket = {
    ticketId: randomId(),
    secret: b64encode(getSecureRandomBytes(KEY_LEN)),
    createdAt: now,
    expiresAt: now + (opts?.ttlMs ?? 7 * 24 * 60 * 60 * 1000), // 7 j par défaut
    maxUses: opts?.maxUses ?? 0, // illimité par défaut (révocable)
    uses: 0,
    revoked: false,
  };
  g.tickets.push(ticket);
  groups.set(groupId, g);
  schedulePersist();
  return ticket;
}

/** Révoque tous les tickets (UX « réinitialiser le lien »). */
export function revokeAllTickets(groupId: string): void {
  const g = groups.get(groupId);
  if (!g) return;
  for (const t of g.tickets) t.revoked = true;
  groups.set(groupId, g);
  schedulePersist();
}

/** Vérifie qu'un (ticketId, secret) est valide et consommable. Ne consomme PAS
 *  (la consommation est faite à l'ajout effectif via consumeTicket). */
export function validateTicket(groupId: string, ticketId: string, secret: string): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  const t = g.tickets.find(x => x.ticketId === ticketId);
  if (!t) return false;
  if (t.revoked) return false;
  if (Date.now() > t.expiresAt) return false;
  if (t.maxUses !== 0 && t.uses >= t.maxUses) return false;
  // Comparaison constante du secret.
  return timingSafeEqualB64(t.secret, secret);
}

export function consumeTicket(groupId: string, ticketId: string): void {
  const g = groups.get(groupId);
  if (!g) return;
  const t = g.tickets.find(x => x.ticketId === ticketId);
  if (!t) return;
  t.uses += 1;
  groups.set(groupId, g);
  schedulePersist();
}

function timingSafeEqualB64(a: string, b: string): boolean {
  const ba = b64decode(a);
  const bb = b64decode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

// ────────────────────────────────────────────────────────────────────────────
// ACCESSEURS
// ────────────────────────────────────────────────────────────────────────────

export function getGroup(groupId: string): GroupRecord | undefined {
  return groups.get(groupId);
}

export function getAllGroups(): GroupRecord[] {
  return Array.from(groups.values());
}

/**
 * Vrai si ce fingerprint est membre d'AU MOINS un groupe (hors moi-même).
 * Sert à préserver la session 1:1 (transport mesh du groupe) lorsqu'on supprime
 * la conversation 1:1 : sans ça, supprimer la session briserait la messagerie de
 * groupe vers ce membre (perte de données).
 */
export function isContactInAnyGroup(fingerprint: string): boolean {
  if (!fingerprint) return false;
  for (const g of groups.values()) {
    if (g.myFingerprint === fingerprint) continue;
    if (g.members.some(m => m.fingerprint === fingerprint && m.fingerprint !== g.myFingerprint)) {
      return true;
    }
  }
  return false;
}

export function getMembers(groupId: string): GroupMember[] {
  return groups.get(groupId)?.members ?? [];
}

/** Renvoie les fingerprints des destinataires d'un fan-out (tous sauf moi). */
export function getFanoutRecipients(groupId: string): GroupMember[] {
  const g = groups.get(groupId);
  if (!g) return [];
  return g.members.filter(m => m.fingerprint !== g.myFingerprint);
}

export function updateGroupMeta(groupId: string, patch: Partial<Pick<GroupRecord, 'name' | 'avatarBase64' | 'description' | 'muted' | 'approvalRequired'>>): void {
  const g = groups.get(groupId);
  if (!g) return;
  Object.assign(g, patch);
  groups.set(groupId, g);
  schedulePersist();
}

/** Quitte/supprime un groupe localement. */
export function deleteGroupLocal(groupId: string): void {
  if (groups.delete(groupId)) schedulePersist();
}

// ────────────────────────────────────────────────────────────────────────────
// PERSISTANCE
// ────────────────────────────────────────────────────────────────────────────

function schedulePersist(): void {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    void persistNow();
  }, 800);
}

/**
 * Écrit l'état courant sur disque.
 *
 * GARDE ANTI-DESTRUCTION — `_loaded` doit être vrai.
 * L'écriture remplace l'enregistrement ENTIER par le contenu de la Map. Tant
 * que `loadGroups()` n'a pas abouti, cette Map n'est PAS l'état de référence :
 * elle est vide (ou partielle). Persister à ce moment-là écrase sur disque des
 * groupes qu'on n'a simplement pas encore réussi à lire — et comme les
 * `groupSeed` n'existent nulle part ailleurs, la perte est DÉFINITIVE.
 *
 * Scénario réel : un échec de déchiffrement transitoire laisse la Map vide,
 * l'utilisateur crée un groupe (ou reçoit un welcome) → `groups` contient une
 * seule entrée → l'enregistrement de tous les autres groupes est écrasé.
 *
 * On préfère donc perdre une mutation en RAM (un groupe à recréer) plutôt que
 * l'historique de groupes sur disque. Le cas ne se produit que dans l'état
 * dégradé « enregistrement présent mais illisible » ; en marche normale
 * `_loaded` est vrai dès le boot (y compris sur une installation neuve, où
 * l'absence d'enregistrement est un état définitif).
 */
async function persistNow(): Promise<void> {
  if (!_loaded) {
    __DEV__ && console.warn(
      '[groupService] persist REFUSÉ : les groupes ne sont pas chargés — ' +
      'écrire maintenant écraserait l\'enregistrement sur disque'
    );
    return;
  }
  try {
    const arr = Array.from(groups.values());
    const json = JSON.stringify(arr);
    const enc = encryptIfEnabled(json);
    await AsyncStorage.setItem(STORAGE_KEY, enc);
  } catch (e) {
    __DEV__ && console.warn('[groupService] persist failed:', e);
  }
}

/**
 * Charge les groupes persistés. Idempotent : `_loaded` évite toute relecture.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT — `_loaded` ne doit être posé QUE sur un état DÉFINITIF
 * ════════════════════════════════════════════════════════════════════════════
 * `_loaded = true` est irréversible : il neutralise tous les appels suivants.
 * Le poser sur un échec TEMPORAIRE (clé pas encore active) fait disparaître
 * les groupes pour toute la durée du process, sans aucun symptôme visible
 * autre que « il n'y a plus de groupes ».
 *
 * C'est exactement ce qui est arrivé : `loadGroups()` appelé en parallèle de
 * `sessionService.initialize()` lisait l'enregistrement AVANT que
 * `ensureDeviceLevelEncryption()` n'ait installé la clé device-level. Le garde
 * `!hasAnyEncryptionKey()` ne le rattrapait pas — la `hardwareKey` (une clé
 * DIFFÉRENTE, simple repli de getActiveKey) était présente — donc `decrypt()`
 * échouait sur le MAC Poly1305, levait, et l'ancien catch posait `_loaded`.
 *
 * Règle : seuls « aucun enregistrement » et « chargement réussi » sont
 * définitifs. Tout échec de lecture, de déchiffrement ou de parsing est
 * considéré comme RÉESSAYABLE — le prochain appel (boot suivant, ou
 * loadConversations qui appelle cette fonction en filet) retentera dès qu'une
 * clé valide sera active. Le surcoût d'un réessai est un getItem et une
 * ouverture secretbox ratée : sans commune mesure avec la perte silencieuse
 * de tous les groupes.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function loadGroups(): Promise<void> {
  if (_loaded) return;

  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch (e) {
    // Stockage illisible : transitoire par nature → réessayable.
    __DEV__ && console.warn('[groupService] loadGroups: storage unreadable, will retry:', e);
    return;
  }

  // Aucun enregistrement = aucun groupe. État légitime et définitif.
  if (!raw) {
    _loaded = true;
    return;
  }

  if (raw.startsWith('enc1:') && !hasAnyEncryptionKey()) {
    __DEV__ && console.log('[groupService] groups encrypted, key not ready — deferring');
    return;
  }

  try {
    const json = decryptIfNeeded(raw);
    const arr: GroupRecord[] = JSON.parse(json);
    // clear() APRÈS le parse : une tentative ratée ne détruit jamais un état
    // déjà chargé.
    groups.clear();
    for (const g of arr) {
      if (g && g.groupId && g.groupSeed) groups.set(g.groupId, normalizeRecord(g));
    }
    _loaded = true;
    __DEV__ && console.log(`[groupService] loaded ${groups.size} group(s)`);
  } catch (e) {
    // Déchiffrement ou parsing en échec : le plus souvent « la bonne clé n'est
    // pas encore active ». On NE pose PAS `_loaded` → réessai au prochain appel.
    __DEV__ && console.warn('[groupService] loadGroups: decrypt/parse failed, will retry:', e);
  }
}

/** Garantit la présence des champs récents (compat ascendante). */
function normalizeRecord(g: GroupRecord): GroupRecord {
  if (!Array.isArray(g.skipped)) g.skipped = [];
  if (!Array.isArray(g.tickets)) g.tickets = [];
  if (typeof g.sendGen !== 'number') g.sendGen = 0;
  if (typeof g.sendEpoch !== 'number') g.sendEpoch = g.epoch ?? 0;
  if (typeof g.rosterVersion !== 'number') g.rosterVersion = 0;
  for (const m of g.members) {
    if (typeof m.recvGen !== 'number') m.recvGen = 0;
    if (typeof m.recvEpoch !== 'number') m.recvEpoch = g.epoch ?? 0;
    if (typeof m.senderKeyAckedEpoch !== 'number') m.senderKeyAckedEpoch = 0;
  }
  return g;
}

// ── Migration (export/import du backup) ──────────────────────────────────────

export function serializeGroups(): string {
  try { return JSON.stringify(Array.from(groups.values())); } catch { return '[]'; }
}

export async function replaceGroupsFromImport(json: string | null | undefined): Promise<void> {
  try {
    if (!json) return;
    const arr: GroupRecord[] = JSON.parse(json);
    groups.clear();
    for (const g of arr) {
      if (g && g.groupId && g.groupSeed) groups.set(g.groupId, normalizeRecord(g));
    }
    _loaded = true;
    await persistNow();
    __DEV__ && console.log(`[groupService] imported ${groups.size} group(s) from backup`);
  } catch (e) {
    __DEV__ && console.warn('[groupService] replaceGroupsFromImport failed:', e);
  }
}

export async function clearAllGroups(): Promise<void> {
  groups.clear();
  try { await AsyncStorage.removeItem(STORAGE_KEY); } catch {}
}

// ── Test hooks (utilisés uniquement par le harnais de test en isolation) ──────
// ────────────────────────────────────────────────────────────────────────────
// MESH — RÉSOLUTION DES SESSIONS CONCURRENTES (« glare »)
// ────────────────────────────────────────────────────────────────────────────
//
// Dans le maillage, deux membres peuvent initier une session l'un vers l'autre
// « en même temps » → deux sessions concurrentes pour la même paire. Sans règle
// déterministe, les deux côtés divergent (chacun chiffre vers SA session). On
// applique une règle de résolution stable et symétrique, calculable
// identiquement par les deux pairs SANS communication :
//
//   L'INITIATEUR LÉGITIME est celui dont le fingerprint est LEXICOGRAPHIQUEMENT
//   le plus PETIT. L'autre ABANDONNE sa session sortante et ADOPTE la session
//   entrante (celle initiée par le pair au fingerprint le plus petit).
//
// Les deux pairs arrivent à la même conclusion (la comparaison est symétrique),
// donc ils convergent vers UNE seule session : celle initiée par min(fpA, fpB).

/**
 * Décide qui doit être l'initiateur d'une session entre `myFp` et `theirFp`.
 * Retourne true si JE dois être l'initiateur (mon fingerprint est le plus petit).
 */
export function shouldIInitiateSession(myFp: string, theirFp: string): boolean {
  // Comparaison lexicographique stable. Égalité impossible (fingerprints
  // distincts), mais on renvoie false par sécurité si jamais égaux.
  if (myFp === theirFp) return false;
  return myFp < theirFp;
}

/**
 * Résout un conflit de sessions concurrentes pour une paire donnée.
 *
 * @param myFp        mon fingerprint
 * @param theirFp     fingerprint du pair
 * @param hasOutbound ai-je déjà une session SORTANTE (que J'AI initiée) ?
 * @param hasInbound  ai-je reçu une session ENTRANTE (que le pair a initiée) ?
 * @returns l'action à prendre :
 *   - 'keep_outbound'   : garder ma session sortante (je suis l'initiateur légitime)
 *   - 'adopt_inbound'   : abandonner ma sortante, adopter l'entrante (le pair est légitime)
 *   - 'create_outbound' : aucune session → en créer une (si je suis l'initiateur légitime)
 *   - 'await_inbound'   : aucune session, et c'est au pair d'initier → attendre
 *   - 'keep'            : situation déjà cohérente (une seule session)
 */
export function resolveSessionGlare(
  myFp: string,
  theirFp: string,
  hasOutbound: boolean,
  hasInbound: boolean
): 'keep_outbound' | 'adopt_inbound' | 'create_outbound' | 'await_inbound' | 'keep' {
  const iAmInitiator = shouldIInitiateSession(myFp, theirFp);

  // Conflit : les deux sessions existent → la règle tranche.
  if (hasOutbound && hasInbound) {
    return iAmInitiator ? 'keep_outbound' : 'adopt_inbound';
  }
  // Une seule session existe → cohérent, on garde.
  if (hasOutbound || hasInbound) {
    return 'keep';
  }
  // Aucune session → qui doit initier ?
  return iAmInitiator ? 'create_outbound' : 'await_inbound';
}

// ────────────────────────────────────────────────────────────────────────────
// MESH — suivi des bundles connus (pour créer des sessions à la demande)
// ────────────────────────────────────────────────────────────────────────────
//
// Le welcome / roster_state transporte les bundles PQXDH (clés publiques) des
// membres. On les stocke par groupe+fingerprint pour pouvoir créer une session
// à la demande (lazy mesh) au premier besoin d'écrire à ce membre.

const knownBundles = new Map<string, string>(); // clé: groupId+':'+fp → bundle JSON sérialisé

function bundleKey(groupId: string, fp: string): string { return groupId + ':' + fp; }

export function storeMemberBundle(groupId: string, fingerprint: string, serializedBundle: string): void {
  if (!groupId || !fingerprint || !serializedBundle) return;
  knownBundles.set(bundleKey(groupId, fingerprint), serializedBundle);
}

export function getMemberBundle(groupId: string, fingerprint: string): string | undefined {
  return knownBundles.get(bundleKey(groupId, fingerprint));
}

export function hasMemberBundle(groupId: string, fingerprint: string): boolean {
  return knownBundles.has(bundleKey(groupId, fingerprint));
}

/** Met à jour le sessionId d'un membre une fois la session établie (lazy mesh). */
export function setMemberSession(groupId: string, fingerprint: string, sessionId: string): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  const m = g.members.find(x => x.fingerprint === fingerprint);
  if (!m) return false;
  m.sessionId = sessionId;
  groups.set(groupId, g);
  schedulePersist();
  return true;
}

/** Membres SANS session établie (cibles d'un établissement à la demande). */
export function getMembersWithoutSession(groupId: string): GroupMember[] {
  const g = groups.get(groupId);
  if (!g) return [];
  return g.members.filter(m => m.fingerprint !== g.myFingerprint && !m.sessionId);
}

/**
 * Exporte tous les bundles connus pour les membres d'un groupe (pour que
 * l'admin les diffuse dans un roster_state → mesh à la demande chez les autres).
 * Format : [{ fingerprint, bundle }]. N'inclut que les membres actuels.
 */
export function exportHeldBundles(groupId: string): Array<{ fingerprint: string; bundle: string }> {
  const g = groups.get(groupId);
  if (!g) return [];
  const out: Array<{ fingerprint: string; bundle: string }> = [];
  for (const m of g.members) {
    if (m.fingerprint === g.myFingerprint) continue;
    const b = knownBundles.get(bundleKey(groupId, m.fingerprint));
    if (b) out.push({ fingerprint: m.fingerprint, bundle: b });
  }
  return out;
}

export const _test = {
  reset(): void { groups.clear(); _loaded = false; },
  ratchetStep,
  deriveInitialChainKey,
  setGroupDirect(g: GroupRecord): void { groups.set(g.groupId, g); },
  b64encode, b64decode,
};
