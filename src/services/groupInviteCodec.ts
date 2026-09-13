// src/services/groupInviteCodec.ts
// Encodage/décodage des invitations de GROUPE.
//
// ─────────────────────────────────────────────────────────────────────────────
// POURQUOI CE MODULE EXISTE
// ─────────────────────────────────────────────────────────────────────────────
// Le format v3 encodait l'invitation ainsi :
//
//   ab   = JSON.stringify(SerializedPQPreKeyBundle)     ← contient déjà du base64
//   obj  = { v:3, k:'group', g, ti, ts, ab, n }
//   out  = base64(JSON.stringify(obj))                  ← DEUXIÈME passe base64
//
// La clé ML-KEM-768 fait 1184 octets bruts. Passée en base64 (1580 car.), puis
// réencodée dans un JSON lui-même base64 (+33 %), plus l'échappement des
// guillemets internes, plus `encodeURIComponent` sur les `+`, `/`, `=` du base64
// final (+6 %), l'URL d'invitation atteignait ~3 070 caractères.
//
// La capacité MAXIMALE d'un QR code (version 40, mode octet) est de :
//   • 2 953 octets en correction d'erreur « L »
//   • 2 331 octets en correction d'erreur « M »
//
// → le QR de groupe v3 ne pouvait JAMAIS être affiché. `GroupInviteQRScreen`
//   basculait systématiquement sur le fallback « partagez le lien », et tout
//   composant qui tentait le rendu sans garde de capacité plantait.
//
// ─────────────────────────────────────────────────────────────────────────────
// FORMAT v4 — binaire compact, UNE SEULE passe base64
// ─────────────────────────────────────────────────────────────────────────────
// On sérialise directement les octets bruts des clés, sans base64 intermédiaire
// ni JSON. Gain : ~1 500 octets → ~2 010 caractères base64 → ~2 150 caractères
// une fois dans l'URL. Le QR passe sous la barre des 2 331 octets (ECL « M »).
//
//   u8    version           = 4
//   u8    flags             bit0 = présence d'une one-time prekey
//   b16   groupId           (32 caractères hex → 16 octets)
//   b16   ticketId          (32 caractères hex → 16 octets)
//   b32   ticketSecret      (44 caractères base64 → 32 octets)
//   u32   signedPreKeyId
//   u32   oneTimePreKeyId   (0 si absente)
//   u32   pqPreKeyId
//   b32   identityKey
//   b32   signedPreKey.pk
//   b64   signedPreKey.sig
//   b32   oneTimePreKey.pk  (uniquement si flags bit0)
//   u16   pqPreKey.pk length
//   b[n]  pqPreKey.pk       (1184 pour ML-KEM-768)
//   b64   pqPreKey.sig
//   u16   nameLen
//   b[n]  name (UTF-8)
//
// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITÉ
// ─────────────────────────────────────────────────────────────────────────────
// `decodeGroupInvite` accepte les DEUX formats. Un client à jour lit encore les
// liens v3 émis par une version antérieure. Les nouveaux liens sont émis en v4 ;
// un ancien client recevant un v4 échouera proprement (message d'erreur) au lieu
// de planter — c'est le comportement attendu d'une montée de version.
//
// AVERTISSEMENT — ce format reste volumineux. La correction DURABLE est de
// publier le bundle de l'admin côté serveur et de ne mettre qu'une référence
// courte dans le QR, comme le fait déjà le flux 1:1 (`createInvite` téléverse le
// bundle et le QR ne porte que `{v:2, t:tag, n}`, soit ~150 caractères). Voir la
// note « ÉTAPE SUIVANTE » en bas de ce fichier.

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

export const GROUP_INVITE_VERSION = 4;

/**
 * Format v5 — le bundle n'est PAS embarqué : il est publié sur le serveur et
 * référencé par un tag de 16 octets, exactement comme le fait le flux 1:1.
 *
 *   u8    version = 5
 *   u8    flags (réservé, 0)
 *   b16   groupId
 *   b16   ticketId
 *   b32   ticketSecret
 *   b16   bundleTag
 *   u16   nameLen
 *   b[n]  name (UTF-8)
 *
 * ≈ 85 octets → ~115 caractères base64 → ~150 caractères d'URL.
 * QR version 6 environ : scannable instantanément, à distance, en basse
 * lumière. À comparer aux ~2 170 caractères du v4 (QR version 40).
 *
 * CONTREPARTIE : le tag dépend du serveur, qui purge les messages au bout de
 * 48 h. Un v5 photographié puis scanné trois jours plus tard échouera. C'est
 * pourquoi l'écran d'invitation émet le v5 dans le QR (usage immédiat, en
 * présentiel, republié à chaque affichage) et le v4 dans le lien partageable
 * (usage différé, aucune dépendance réseau, aucune limite de taille).
 */
export const GROUP_INVITE_VERSION_TAG = 5;

/** Longueurs attendues, en octets. */
const LEN = {
  GROUP_ID: 16,
  TICKET_ID: 16,
  TICKET_SECRET: 32,
  X25519_PK: 32,
  ED25519_PK: 32,
  ED25519_SIG: 64,
  BUNDLE_TAG: 16,
} as const;

/** Borne de sûreté sur la clé ML-KEM (ML-KEM-768 = 1184, ML-KEM-1024 = 1568). */
const MAX_PQ_PK_LEN = 4096;

/** Borne de sûreté sur le nom de groupe encodé en UTF-8. */
const MAX_NAME_BYTES = 512;

/**
 * Capacité d'un QR code version 40 en mode octet, par niveau de correction.
 * Source : ISO/IEC 18004, tableau 7.
 */
export const QR_BYTE_CAPACITY = {
  L: 2953,
  M: 2331,
  Q: 1663,
  H: 1273,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Bundle PQXDH tel que produit par `serializePQPreKeyBundle`. */
export interface SerializedBundle {
  v: 2;
  ik: string;
  spk: { id: number; pk: string; sig: string };
  opk?: { id: number; pk: string };
  pqk: { id: number; pk: string; sig: string };
}

export interface GroupInvitePayload {
  /** Identifiant du groupe (32 caractères hex). */
  groupId: string;
  /** Identifiant du ticket d'invitation (32 caractères hex). */
  ticketId: string;
  /** Secret du ticket (base64, 32 octets). */
  ticketSecret: string;
  /**
   * Bundle PQXDH de l'admin sérialisé en JSON — présent pour les formats v3 et
   * v4, qui l'embarquent. `undefined` en v5 : il faut alors le récupérer sur le
   * serveur via `bundleTag`.
   */
  bundleJson?: string;
  /**
   * Tag permettant de récupérer le bundle sur le serveur — présent en v5
   * uniquement. Exactement un des deux champs `bundleJson` / `bundleTag` est
   * renseigné.
   */
  bundleTag?: string;
  /** Nom du groupe. */
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PETITS UTILITAIRES BINAIRES
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex: string, expectedLen: number, field: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length !== expectedLen * 2) {
    throw new Error(`groupInviteCodec: ${field} doit faire ${expectedLen * 2} caractères hex`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`groupInviteCodec: ${field} n'est pas de l'hexadécimal valide`);
  }
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function b64ToBytes(b64: string, expectedLen: number, field: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(b64);
  } catch {
    throw new Error(`groupInviteCodec: ${field} n'est pas du base64 valide`);
  }
  if (bytes.length !== expectedLen) {
    throw new Error(
      `groupInviteCodec: ${field} fait ${bytes.length} octets, ${expectedLen} attendus`
    );
  }
  return bytes;
}

/** Écriture séquentielle dans un buffer de taille connue. */
class Writer {
  private buf: Uint8Array;
  private off = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }

  u8(v: number): void {
    this.buf[this.off++] = v & 0xff;
  }

  u16(v: number): void {
    this.buf[this.off++] = (v >>> 8) & 0xff;
    this.buf[this.off++] = v & 0xff;
  }

  u32(v: number): void {
    this.buf[this.off++] = (v >>> 24) & 0xff;
    this.buf[this.off++] = (v >>> 16) & 0xff;
    this.buf[this.off++] = (v >>> 8) & 0xff;
    this.buf[this.off++] = v & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.buf.set(b, this.off);
    this.off += b.length;
  }

  finish(): Uint8Array {
    if (this.off !== this.buf.length) {
      throw new Error(
        `groupInviteCodec: taille incohérente (écrit ${this.off}, alloué ${this.buf.length})`
      );
    }
    return this.buf;
  }
}

/** Lecture séquentielle avec contrôle de bornes systématique. */
class Reader {
  private off = 0;

  constructor(private buf: Uint8Array) {}

  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new Error('groupInviteCodec: données tronquées');
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.off++];
  }

  u16(): number {
    this.need(2);
    return (this.buf[this.off++] << 8) | this.buf[this.off++];
  }

  u32(): number {
    this.need(4);
    return (
      ((this.buf[this.off++] << 24) >>> 0) +
      (this.buf[this.off++] << 16) +
      (this.buf[this.off++] << 8) +
      this.buf[this.off++]
    );
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENCODAGE v4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode une invitation de groupe au format v4 compact.
 *
 * @throws si un champ est malformé (taille de clé inattendue, hex invalide…).
 *         L'appelant DOIT intercepter : mieux vaut afficher une erreur que
 *         produire un QR corrompu qui échouera silencieusement au scan.
 */
export function encodeGroupInvite(payload: GroupInvitePayload): string {
  const { groupId, ticketId, ticketSecret, bundleJson, name } = payload;

  let bundle: SerializedBundle;
  try {
    bundle = JSON.parse(bundleJson);
  } catch {
    throw new Error('groupInviteCodec: bundle JSON illisible');
  }
  if (!bundle || bundle.v !== 2 || !bundle.ik || !bundle.spk || !bundle.pqk) {
    throw new Error('groupInviteCodec: bundle PQXDH incomplet');
  }

  const gid = hexToBytes(groupId, LEN.GROUP_ID, 'groupId');
  const tid = hexToBytes(ticketId, LEN.TICKET_ID, 'ticketId');
  const tsec = b64ToBytes(ticketSecret, LEN.TICKET_SECRET, 'ticketSecret');

  const ik = b64ToBytes(bundle.ik, LEN.ED25519_PK, 'bundle.ik');
  const spkPk = b64ToBytes(bundle.spk.pk, LEN.X25519_PK, 'bundle.spk.pk');
  const spkSig = b64ToBytes(bundle.spk.sig, LEN.ED25519_SIG, 'bundle.spk.sig');

  const hasOpk = !!bundle.opk;
  const opkPk = hasOpk
    ? b64ToBytes(bundle.opk!.pk, LEN.X25519_PK, 'bundle.opk.pk')
    : null;

  let pqkPk: Uint8Array;
  try {
    pqkPk = decodeBase64(bundle.pqk.pk);
  } catch {
    throw new Error('groupInviteCodec: bundle.pqk.pk base64 invalide');
  }
  if (pqkPk.length === 0 || pqkPk.length > MAX_PQ_PK_LEN) {
    throw new Error(`groupInviteCodec: taille de clé ML-KEM invalide (${pqkPk.length})`);
  }
  const pqkSig = b64ToBytes(bundle.pqk.sig, LEN.ED25519_SIG, 'bundle.pqk.sig');

  const nameBytes = new TextEncoder().encode(name ?? '');
  if (nameBytes.length > MAX_NAME_BYTES) {
    throw new Error('groupInviteCodec: nom de groupe trop long');
  }

  const size =
    1 + // version
    1 + // flags
    LEN.GROUP_ID +
    LEN.TICKET_ID +
    LEN.TICKET_SECRET +
    4 + // spkId
    4 + // opkId
    4 + // pqkId
    LEN.ED25519_PK +
    LEN.X25519_PK +
    LEN.ED25519_SIG +
    (hasOpk ? LEN.X25519_PK : 0) +
    2 + // pqkPkLen
    pqkPk.length +
    LEN.ED25519_SIG +
    2 + // nameLen
    nameBytes.length;

  const w = new Writer(size);
  w.u8(GROUP_INVITE_VERSION);
  w.u8(hasOpk ? 0x01 : 0x00);
  w.bytes(gid);
  w.bytes(tid);
  w.bytes(tsec);
  w.u32(bundle.spk.id >>> 0);
  w.u32(hasOpk ? bundle.opk!.id >>> 0 : 0);
  w.u32(bundle.pqk.id >>> 0);
  w.bytes(ik);
  w.bytes(spkPk);
  w.bytes(spkSig);
  if (opkPk) w.bytes(opkPk);
  w.u16(pqkPk.length);
  w.bytes(pqkPk);
  w.bytes(pqkSig);
  w.u16(nameBytes.length);
  w.bytes(nameBytes);

  return encodeBase64(w.finish());
}

// ─────────────────────────────────────────────────────────────────────────────
// ENCODAGE v5 (référence par tag serveur)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode une invitation de groupe qui référence le bundle admin par son tag
 * serveur, au lieu de l'embarquer. Destiné au QR code.
 *
 * @param bundleTag tag renvoyé par `sessionService.publishGroupAdminBundle()`
 *                  (32 caractères hexadécimaux).
 * @throws si un champ est malformé.
 */
export function encodeGroupInviteWithTag(params: {
  groupId: string;
  ticketId: string;
  ticketSecret: string;
  bundleTag: string;
  name: string;
}): string {
  const gid = hexToBytes(params.groupId, LEN.GROUP_ID, 'groupId');
  const tid = hexToBytes(params.ticketId, LEN.TICKET_ID, 'ticketId');
  const tsec = b64ToBytes(params.ticketSecret, LEN.TICKET_SECRET, 'ticketSecret');
  const btag = hexToBytes(params.bundleTag, LEN.BUNDLE_TAG, 'bundleTag');

  const nameBytes = new TextEncoder().encode(params.name ?? '');
  if (nameBytes.length > MAX_NAME_BYTES) {
    throw new Error('groupInviteCodec: nom de groupe trop long');
  }

  const size =
    1 + 1 +
    LEN.GROUP_ID + LEN.TICKET_ID + LEN.TICKET_SECRET + LEN.BUNDLE_TAG +
    2 + nameBytes.length;

  const w = new Writer(size);
  w.u8(GROUP_INVITE_VERSION_TAG);
  w.u8(0); // flags réservés
  w.bytes(gid);
  w.bytes(tid);
  w.bytes(tsec);
  w.bytes(btag);
  w.u16(nameBytes.length);
  w.bytes(nameBytes);

  return encodeBase64(w.finish());
}

// ─────────────────────────────────────────────────────────────────────────────
// DÉCODAGE (v5 tag + v4 binaire + v3 JSON hérité)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Décode une invitation de groupe, quel que soit son format.
 * Retourne `null` si la chaîne n'est PAS une invitation de groupe (invitation
 * 1:1, QR étranger, texte quelconque) — le cas normal côté scanner.
 * Ne lance jamais : un scanner ne doit pas planter sur une entrée hostile.
 */
export function decodeGroupInvite(inviteString: string | null | undefined): GroupInvitePayload | null {
  if (!inviteString || typeof inviteString !== 'string') return null;

  // Base64 URL-safe toléré (certains canaux réécrivent + et /).
  const normalized = inviteString.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(normalized);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  // v5 / v4 : le tout premier octet porte la version.
  if (bytes[0] === GROUP_INVITE_VERSION_TAG) {
    try {
      return decodeV5(bytes);
    } catch {
      return null;
    }
  }
  if (bytes[0] === GROUP_INVITE_VERSION) {
    try {
      return decodeV4(bytes);
    } catch {
      return null;
    }
  }

  // v3 hérité : JSON encodé en base64.
  try {
    return decodeV3(bytes);
  } catch {
    return null;
  }
}

function decodeV5(bytes: Uint8Array): GroupInvitePayload {
  const r = new Reader(bytes);

  const version = r.u8();
  if (version !== GROUP_INVITE_VERSION_TAG) throw new Error('version inattendue');
  r.u8(); // flags réservés, ignorés

  const groupId = bytesToHex(r.bytes(LEN.GROUP_ID));
  const ticketId = bytesToHex(r.bytes(LEN.TICKET_ID));
  const ticketSecret = encodeBase64(r.bytes(LEN.TICKET_SECRET));
  const bundleTag = bytesToHex(r.bytes(LEN.BUNDLE_TAG));

  const nameLen = r.u16();
  if (nameLen > MAX_NAME_BYTES) throw new Error('nom trop long');
  const name = new TextDecoder().decode(r.bytes(nameLen));

  if (r.remaining !== 0) throw new Error('octets excédentaires');

  return { groupId, ticketId, ticketSecret, bundleTag, name };
}

function decodeV4(bytes: Uint8Array): GroupInvitePayload {
  const r = new Reader(bytes);

  const version = r.u8();
  if (version !== GROUP_INVITE_VERSION) {
    throw new Error('version inattendue');
  }
  const flags = r.u8();
  const hasOpk = (flags & 0x01) !== 0;

  const groupId = bytesToHex(r.bytes(LEN.GROUP_ID));
  const ticketId = bytesToHex(r.bytes(LEN.TICKET_ID));
  const ticketSecret = encodeBase64(r.bytes(LEN.TICKET_SECRET));

  const spkId = r.u32();
  const opkId = r.u32();
  const pqkId = r.u32();

  const ik = encodeBase64(r.bytes(LEN.ED25519_PK));
  const spkPk = encodeBase64(r.bytes(LEN.X25519_PK));
  const spkSig = encodeBase64(r.bytes(LEN.ED25519_SIG));
  const opkPk = hasOpk ? encodeBase64(r.bytes(LEN.X25519_PK)) : null;

  const pqkPkLen = r.u16();
  if (pqkPkLen === 0 || pqkPkLen > MAX_PQ_PK_LEN) {
    throw new Error('taille ML-KEM invalide');
  }
  const pqkPk = encodeBase64(r.bytes(pqkPkLen));
  const pqkSig = encodeBase64(r.bytes(LEN.ED25519_SIG));

  const nameLen = r.u16();
  if (nameLen > MAX_NAME_BYTES) throw new Error('nom trop long');
  const name = new TextDecoder().decode(r.bytes(nameLen));

  // Octets excédentaires = données malformées, on refuse plutôt que d'ignorer.
  if (r.remaining !== 0) {
    throw new Error('octets excédentaires');
  }

  const bundle: SerializedBundle = {
    v: 2,
    ik,
    spk: { id: spkId, pk: spkPk, sig: spkSig },
    pqk: { id: pqkId, pk: pqkPk, sig: pqkSig },
  };
  if (hasOpk && opkPk) {
    bundle.opk = { id: opkId, pk: opkPk };
  }

  return {
    groupId,
    ticketId,
    ticketSecret,
    bundleJson: JSON.stringify(bundle),
    name,
  };
}

function decodeV3(bytes: Uint8Array): GroupInvitePayload {
  const json = new TextDecoder().decode(bytes);
  const obj = JSON.parse(json);
  if (!obj || obj.k !== 'group' || !obj.g || !obj.ti || !obj.ts || !obj.ab) {
    throw new Error('pas une invitation de groupe v3');
  }
  return {
    groupId: String(obj.g),
    ticketId: String(obj.ti),
    ticketSecret: String(obj.ts),
    bundleJson: String(obj.ab),
    name: typeof obj.n === 'string' ? obj.n : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AIDE À LA DÉCISION D'AFFICHAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Longueur en OCTETS de la charge utile telle qu'elle sera encodée dans le QR.
 * `value.length` ne suffit pas : un caractère non-ASCII compte pour plusieurs
 * octets en UTF-8, et c'est bien l'octet qui est la limite du mode octet.
 */
export function qrPayloadByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Décide si une valeur tient dans un QR code au niveau de correction donné.
 * Une marge de 5 % est conservée : les bibliothèques de rendu ajoutent parfois
 * quelques octets de mode/terminateur, et un QR saturé à 100 % est fragile.
 */
export function qrFitsCapacity(
  value: string,
  ecl: keyof typeof QR_BYTE_CAPACITY = 'L'
): boolean {
  if (!value) return false;
  const budget = Math.floor(QR_BYTE_CAPACITY[ecl] * 0.95);
  return qrPayloadByteLength(value) <= budget;
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE SUIVANTE (non implémentée ici — nécessite un aller-retour serveur)
// ─────────────────────────────────────────────────────────────────────────────
// Même compacté, un QR de ~2 150 octets est un QR version 40 : 177×177 modules.
// Il scanne, mais il exige une taille d'affichage d'au moins ~320 px et un bon
// capteur. Le format vraiment confortable serait :
//
//   { v:5, k:'group', g, ti, ts, t:<tag>, n }   → ~200 caractères, QR version 10
//
// où `<tag>` référence le bundle de l'admin téléversé au serveur, exactement
// comme `sessionService.createInvite()` le fait pour le 1:1. Cela demande :
//   1. une RPC de publication du bundle admin (réutiliser celle du 1:1) ;
//   2. la récupération du bundle par tag côté joigneur avant
//      `createMeshInitiatorSession` ;
//   3. une politique d'expiration alignée sur celle des tickets.
// C'est la correction recommandée à terme ; elle n'a pas été faite ici car elle
// touche au chemin réseau et ne peut pas être validée sans environnement de test.
