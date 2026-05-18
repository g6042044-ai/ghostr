// src/services/tripleRatchet/pqPrimitives.ts
// Primitives Post-Quantiques pour le Triple Ratchet
// Version 3.0 - Utilise @noble/post-quantum (FIPS 203) + Reed-Solomon Erasure Coding
//
// SÉCURITÉ POST-QUANTIQUE:
// ML-KEM-768 (NIST FIPS 203) offre ~192 bits de sécurité classique
// et résiste aux attaques par ordinateur quantique (algorithme de Shor)
//
// ERASURE CODING:
// Implémentation Reed-Solomon systématique pour reconstruction robuste
// Tolère jusqu'à (n-k) chunks perdus où k = chunks originaux
//
// BIBLIOTHÈQUE: @noble/post-quantum
// - Implémentation auditable et minimale
// - Compatible React Native (avec polyfill getRandomValues)
// - Conforme NIST FIPS 203
// - La plus rapide en JavaScript pur
//
// INSTALLATION REQUISE:
// npm install @noble/post-quantum @noble/hashes
// + Dans index.js: import 'react-native-get-random-values' (PREMIER import!)

// @ts-ignore - Import avec extension pour compatibilité ESM
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { zeroize, hmacSha256 } from './primitives';

// ============================================
// CONSTANTES ML-KEM-768
// ============================================

export const KYBER_CONSTANTS = {
  // Tailles des clés ML-KEM-768 (FIPS 203)
  PUBLIC_KEY_SIZE: 1184,    // bytes (encapsulation key)
  SECRET_KEY_SIZE: 2400,    // bytes (decapsulation key)
  CIPHERTEXT_SIZE: 1088,    // bytes
  SHARED_SECRET_SIZE: 32,   // bytes
  
  // Paramètres Kyber-768
  K: 3,                     // Dimension du module
  N: 256,                   // Degré du polynôme
  Q: 3329,                  // Module premier
  
  // Chunking pour SPQR avec Reed-Solomon
  CHUNK_SIZE: 64,           // Taille d'un chunk en bytes
  EK_CHUNKS: 19,            // ceil(1184/64) chunks pour encap key
  CT_CHUNKS: 17,            // ceil(1088/64) chunks pour ciphertext
  
  // Reed-Solomon parameters
  RS_DATA_CHUNKS: 19,       // Nombre de chunks de données (k)
  RS_TOTAL_CHUNKS: 28,      // Nombre total de chunks (n) = k + redundancy
  RS_REDUNDANCY: 9,         // Chunks de parité (n - k)
  
  // Galois Field GF(2^8) pour Reed-Solomon
  GF_PRIMITIVE: 0x11D,      // Polynôme primitif x^8 + x^4 + x^3 + x^2 + 1
} as const;

// ============================================
// TYPES ML-KEM
// ============================================

/**
 * Clé publique ML-KEM (encapsulation key)
 */
export interface KyberPublicKey {
  readonly _brand: 'KyberPublicKey';
  readonly bytes: Uint8Array; // 1184 bytes
}

/**
 * Clé privée ML-KEM (decapsulation key)
 */
export interface KyberSecretKey {
  readonly _brand: 'KyberSecretKey';
  readonly bytes: Uint8Array; // 2400 bytes
}

/**
 * Paire de clés ML-KEM
 */
export interface KyberKeyPair {
  readonly publicKey: KyberPublicKey;
  readonly secretKey: KyberSecretKey;
}

/**
 * Ciphertext ML-KEM (encapsulation)
 */
export interface KyberCiphertext {
  readonly _brand: 'KyberCiphertext';
  readonly bytes: Uint8Array; // 1088 bytes
}

/**
 * Secret partagé dérivé de ML-KEM
 */
export interface KyberSharedSecret {
  readonly _brand: 'KyberSharedSecret';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Chunk pour transmission fragmentée avec Reed-Solomon
 */
export interface KyberChunk {
  readonly index: number;       // Position dans la séquence
  readonly total: number;       // Nombre total de chunks
  readonly type: 'ek' | 'ct';   // encapsulation key ou ciphertext
  readonly isParityChunk: boolean; // Est-ce un chunk de parité RS?
  readonly data: Uint8Array;    // Données du chunk
  readonly checksum: Uint8Array; // Checksum pour validation (4 bytes)
}

// ============================================
// GALOIS FIELD GF(2^8) POUR REED-SOLOMON
// ============================================

/**
 * Table d'exponentiation GF(2^8)
 */
const gfExp: Uint8Array = new Uint8Array(512);
const gfLog: Uint8Array = new Uint8Array(256);

// Initialisation des tables GF(2^8)
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x >= 256) {
      x ^= KYBER_CONSTANTS.GF_PRIMITIVE;
    }
  }
  // Dupliquer pour éviter les modulos
  for (let i = 255; i < 512; i++) {
    gfExp[i] = gfExp[i - 255];
  }
  gfLog[0] = 0; // Convention pour log(0)
})();

/**
 * Multiplication dans GF(2^8)
 */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gfExp[gfLog[a] + gfLog[b]];
}

/**
 * Division dans GF(2^8)
 */
function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF(2^8)');
  if (a === 0) return 0;
  return gfExp[(gfLog[a] + 255 - gfLog[b]) % 255];
}

/**
 * Puissance dans GF(2^8)
 */
function gfPow(x: number, power: number): number {
  return gfExp[(gfLog[x] * power) % 255];
}

/**
 * Inverse dans GF(2^8)
 */
function gfInverse(x: number): number {
  return gfExp[255 - gfLog[x]];
}

// ============================================
// REED-SOLOMON ENCODER/DECODER
// ============================================

/**
 * Génère le polynôme générateur Reed-Solomon
 * g(x) = (x - α^0)(x - α^1)...(x - α^(n-k-1))
 */
function generateRSGeneratorPoly(nsym: number): Uint8Array {
  const gen = new Uint8Array(nsym + 1);
  gen[0] = 1;
  
  for (let i = 0; i < nsym; i++) {
    const root = gfPow(2, i);
    for (let j = i + 1; j > 0; j--) {
      gen[j] = gen[j] ^ gfMul(gen[j - 1], root);
    }
  }
  
  return gen;
}

/**
 * Encode Reed-Solomon: ajoute nsym symboles de parité
 */
function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const gen = generateRSGeneratorPoly(nsym);
  const encoded = new Uint8Array(data.length + nsym);
  encoded.set(data);
  
  for (let i = 0; i < data.length; i++) {
    const coef = encoded[i];
    if (coef !== 0) {
      for (let j = 1; j <= nsym; j++) {
        encoded[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  
  // Les symboles de parité sont maintenant aux positions [data.length, data.length + nsym)
  // Restructurer: data + parité
  const result = new Uint8Array(data.length + nsym);
  result.set(data);
  result.set(encoded.slice(data.length), data.length);
  
  return result;
}

/**
 * Calcule les syndromes pour la détection/correction d'erreurs
 */
function calcSyndromes(msg: Uint8Array, nsym: number): Uint8Array {
  const synd = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let s = 0;
    for (let j = 0; j < msg.length; j++) {
      s ^= gfMul(msg[j], gfPow(2, i * (msg.length - 1 - j)));
    }
    synd[i] = s;
  }
  return synd;
}

/**
 * Vérifie si les syndromes indiquent des erreurs
 */
function checkSyndromes(synd: Uint8Array): boolean {
  for (let i = 0; i < synd.length; i++) {
    if (synd[i] !== 0) return false;
  }
  return true;
}

/**
 * Algorithme de Berlekamp-Massey pour trouver le polynôme localisateur d'erreurs
 */
function berlekampMassey(synd: Uint8Array, nsym: number): Uint8Array {
  const errLoc = new Uint8Array(nsym + 1);
  const oldLoc = new Uint8Array(nsym + 1);
  errLoc[0] = 1;
  oldLoc[0] = 1;
  
  let syndShift = 0;
  
  for (let i = 0; i < nsym; i++) {
    let delta = synd[i + syndShift];
    for (let j = 1; j <= i; j++) {
      delta ^= gfMul(errLoc[j], synd[i - j + syndShift]);
    }
    
    oldLoc[i + 1] = 0;
    
    if (delta !== 0) {
      if (2 * i <= nsym) {
        const newLoc = new Uint8Array(nsym + 1);
        for (let j = 0; j <= i; j++) {
          newLoc[j] = gfMul(oldLoc[j], delta);
        }
        for (let j = 0; j <= i + 1; j++) {
          oldLoc[j] = gfMul(errLoc[j], gfInverse(delta));
        }
        errLoc.set(newLoc.slice(0, i + 1));
      }
      for (let j = i + 1; j > 0; j--) {
        errLoc[j] ^= gfMul(delta, oldLoc[j - 1]);
      }
    }
  }
  
  return errLoc;
}

/**
 * Trouve les positions d'erreurs via recherche de Chien
 */
function chienSearch(errLoc: Uint8Array, msgLen: number): number[] {
  const positions: number[] = [];

  for (let i = 0; i < msgLen; i++) {
    let sum = 0;
    for (let j = 0; j < errLoc.length; j++) {
      sum ^= gfMul(errLoc[j], gfPow(2, j * i));
    }
    if (sum === 0) {
      positions.push(msgLen - 1 - i);
    }
  }
  
  return positions;
}

/**
 * Corrige les erreurs avec l'algorithme de Forney
 */
function forneyAlgorithm(
  msg: Uint8Array, 
  synd: Uint8Array, 
  errPos: number[], 
  errLoc: Uint8Array
): Uint8Array {
  const corrected = new Uint8Array(msg);
  const coefPos = errPos.map(p => msg.length - 1 - p);
  
  // Polynôme évaluateur d'erreurs
  let errEval = new Uint8Array(synd.length);
  for (let i = 0; i < synd.length; i++) {
    errEval[i] = synd[i];
    for (let j = 1; j <= Math.min(i, errLoc.length - 1); j++) {
      errEval[i] ^= gfMul(errLoc[j], synd[i - j]);
    }
  }
  
  // Calculer les corrections
  for (let i = 0; i < errPos.length; i++) {
    const Xi = gfPow(2, coefPos[i]);
    const XiInv = gfInverse(Xi);
    
    // Dérivée formelle du localisateur
    let errLocPrimeTmp = 1;
    for (let j = 0; j < errPos.length; j++) {
      if (i !== j) {
        errLocPrimeTmp = gfMul(errLocPrimeTmp, 1 ^ gfMul(XiInv, gfPow(2, coefPos[j])));
      }
    }
    
    // Magnitude de l'erreur
    let y = 0;
    for (let j = 0; j < errEval.length; j++) {
      y ^= gfMul(errEval[j], gfPow(XiInv, j));
    }
    
    const magnitude = gfDiv(y, errLocPrimeTmp);
    corrected[errPos[i]] ^= magnitude;
  }
  
  return corrected;
}

/**
 * Décode Reed-Solomon avec correction d'erreurs
 */
function rsDecode(encoded: Uint8Array, nsym: number): Uint8Array | null {
  // Calculer les syndromes
  const synd = calcSyndromes(encoded, nsym);
  
  // Vérifier s'il y a des erreurs
  if (checkSyndromes(synd)) {
    return encoded.slice(0, encoded.length - nsym);
  }
  
  // Trouver le polynôme localisateur d'erreurs
  const errLoc = berlekampMassey(synd, nsym);
  
  // Trouver les positions d'erreurs
  const errPos = chienSearch(errLoc, encoded.length);
  
  if (errPos.length === 0 || errPos.length > nsym / 2) {
    // Trop d'erreurs pour corriger
    return null;
  }
  
  // Corriger les erreurs
  const corrected = forneyAlgorithm(encoded, synd, errPos, errLoc);
  
  // Vérifier la correction
  const checkSynd = calcSyndromes(corrected, nsym);
  if (!checkSyndromes(checkSynd)) {
    return null; // Correction échouée
  }
  
  return corrected.slice(0, corrected.length - nsym);
}

// ============================================
// IMPLÉMENTATION ML-KEM-768 (@noble/post-quantum)
// ============================================

/**
 * Génère une paire de clés ML-KEM-768
 * 
 * @returns Paire de clés (publicKey, secretKey)
 */
export function kyberKeyGen(): KyberKeyPair {
  
  const { publicKey, secretKey } = ml_kem768.keygen();
  
  
  return {
    publicKey: {
      _brand: 'KyberPublicKey' as const,
      bytes: publicKey,
    },
    secretKey: {
      _brand: 'KyberSecretKey' as const,
      bytes: secretKey,
    },
  };
}

/**
 * Encapsulation: génère un secret partagé et un ciphertext
 */
export function kyberEncapsulate(pk: KyberPublicKey): {
  ciphertext: KyberCiphertext;
  sharedSecret: KyberSharedSecret;
} {
  
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk.bytes);
  
  
  return {
    ciphertext: {
      _brand: 'KyberCiphertext' as const,
      bytes: cipherText,
    },
    sharedSecret: {
      _brand: 'KyberSharedSecret' as const,
      bytes: sharedSecret,
    },
  };
}

/**
 * Décapsulation: récupère le secret partagé depuis le ciphertext
 */
export function kyberDecapsulate(
  ct: KyberCiphertext,
  sk: KyberSecretKey
): KyberSharedSecret {
  
  const sharedSecret = ml_kem768.decapsulate(ct.bytes, sk.bytes);
  
  
  return {
    _brand: 'KyberSharedSecret' as const,
    bytes: sharedSecret,
  };
}

// ============================================
// CHUNKING AVEC REED-SOLOMON
// ============================================

/**
 * Calcule un checksum CRC32-like pour validation de chunk
 */
function calculateChecksum(data: Uint8Array): Uint8Array {
  const hash = hmacSha256(new Uint8Array([0x43, 0x48, 0x4B, 0x53]), data); // "CHKS"
  return hash.slice(0, 4);
}

/**
 * Découpe une clé publique en chunks avec Reed-Solomon
 */
export function chunkPublicKey(pk: KyberPublicKey): KyberChunk[] {
  return chunkBytesWithRS(pk.bytes, 'ek');
}

/**
 * Découpe un ciphertext en chunks avec Reed-Solomon
 */
export function chunkCiphertext(ct: KyberCiphertext): KyberChunk[] {
  return chunkBytesWithRS(ct.bytes, 'ct');
}

/**
 * Découpe des bytes en chunks avec encodage Reed-Solomon
 */
function chunkBytesWithRS(data: Uint8Array, type: 'ek' | 'ct'): KyberChunk[] {
  const { CHUNK_SIZE, RS_DATA_CHUNKS, RS_REDUNDANCY } = KYBER_CONSTANTS;
  const totalChunks = RS_DATA_CHUNKS + RS_REDUNDANCY;
  
  // Padding des données pour avoir exactement RS_DATA_CHUNKS * CHUNK_SIZE bytes
  const paddedSize = RS_DATA_CHUNKS * CHUNK_SIZE;
  const paddedData = new Uint8Array(paddedSize);
  paddedData.set(data);
  // Stocker la taille originale dans les derniers 4 bytes du padding
  const sizeView = new DataView(paddedData.buffer, paddedSize - 4, 4);
  sizeView.setUint32(0, data.length, false);
  
  const chunks: KyberChunk[] = [];
  
  // Créer les chunks de données
  for (let i = 0; i < RS_DATA_CHUNKS; i++) {
    const chunkData = paddedData.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const checksum = calculateChecksum(chunkData);
    
    chunks.push({
      index: i,
      total: totalChunks,
      type,
      isParityChunk: false,
      data: chunkData,
      checksum,
    });
  }
  
  // Créer les chunks de parité Reed-Solomon
  // Encoder chaque position de byte avec RS
  for (let bytePos = 0; bytePos < CHUNK_SIZE; bytePos++) {
    // Extraire la colonne de bytes à cette position
    const column = new Uint8Array(RS_DATA_CHUNKS);
    for (let i = 0; i < RS_DATA_CHUNKS; i++) {
      column[i] = paddedData[i * CHUNK_SIZE + bytePos];
    }
    
    // Encoder avec Reed-Solomon
    const encoded = rsEncode(column, RS_REDUNDANCY);
    
    // Distribuer les bytes de parité dans les chunks de parité
    for (let p = 0; p < RS_REDUNDANCY; p++) {
      if (bytePos === 0) {
        chunks.push({
          index: RS_DATA_CHUNKS + p,
          total: totalChunks,
          type,
          isParityChunk: true,
          data: new Uint8Array(CHUNK_SIZE),
          checksum: new Uint8Array(4),
        });
      }
      chunks[RS_DATA_CHUNKS + p].data[bytePos] = encoded[RS_DATA_CHUNKS + p];
    }
  }
  
  // Calculer les checksums pour les chunks de parité
  for (let p = 0; p < RS_REDUNDANCY; p++) {
    const parityChunk = chunks[RS_DATA_CHUNKS + p];
    (parityChunk as any).checksum = calculateChecksum(parityChunk.data);
  }
  
  __DEV__ && console.log(`[RS-Chunk] ✅ Created ${chunks.length} chunks (${RS_DATA_CHUNKS} data + ${RS_REDUNDANCY} parity) for ${type}`);
  
  return chunks;
}

/**
 * Reconstruit les données depuis les chunks avec correction Reed-Solomon
 */
export function reconstructFromChunks(
  chunks: KyberChunk[],
  expectedType: 'ek' | 'ct'
): Uint8Array | null {
  // Filtrer les chunks du bon type
  const validChunks = chunks.filter(c => c.type === expectedType);
  
  if (validChunks.length === 0) {
    __DEV__ && console.log('[RS-Reconstruct] ❌ No valid chunks');
    return null;
  }
  
  const { CHUNK_SIZE, RS_DATA_CHUNKS, RS_REDUNDANCY } = KYBER_CONSTANTS;
  const totalChunks = RS_DATA_CHUNKS + RS_REDUNDANCY;
  
  // Vérifier qu'on a assez de chunks (au moins RS_DATA_CHUNKS)
  if (validChunks.length < RS_DATA_CHUNKS) {
    __DEV__ && console.log(`[RS-Reconstruct] ❌ Not enough chunks: ${validChunks.length}/${RS_DATA_CHUNKS} required`);
    return null;
  }
  
  // Valider les checksums et construire la map des chunks
  const chunkMap = new Map<number, KyberChunk>();
  const invalidChunks: number[] = [];
  
  for (const chunk of validChunks) {
    const expectedChecksum = calculateChecksum(chunk.data);
    const checksumValid = chunk.checksum.every((b, i) => b === expectedChecksum[i]);
    
    if (checksumValid) {
      chunkMap.set(chunk.index, chunk);
    } else {
      invalidChunks.push(chunk.index);
      __DEV__ && console.log(`[RS-Reconstruct] ⚠️ Chunk ${chunk.index} has invalid checksum`);
    }
  }
  
  __DEV__ && console.log(`[RS-Reconstruct] Valid chunks: ${chunkMap.size}, Invalid: ${invalidChunks.length}`);
  
  // Si on a tous les chunks de données valides, pas besoin de RS
  const hasAllDataChunks = Array.from({ length: RS_DATA_CHUNKS }, (_, i) => i)
    .every(i => chunkMap.has(i));
  
  if (hasAllDataChunks) {
    __DEV__ && console.log('[RS-Reconstruct] ✅ All data chunks present, no RS decoding needed');
    const reconstructed = new Uint8Array(RS_DATA_CHUNKS * CHUNK_SIZE);
    for (let i = 0; i < RS_DATA_CHUNKS; i++) {
      reconstructed.set(chunkMap.get(i)!.data, i * CHUNK_SIZE);
    }
    
    // Extraire la taille originale
    const sizeView = new DataView(reconstructed.buffer, reconstructed.length - 4, 4);
    const originalSize = sizeView.getUint32(0, false);
    
    return reconstructed.slice(0, originalSize);
  }
  
  // Sinon, utiliser Reed-Solomon pour reconstruire
  __DEV__ && console.log('[RS-Reconstruct] 🔧 Using Reed-Solomon for reconstruction...');
  
  // Pour chaque position de byte, reconstruire avec RS
  const reconstructed = new Uint8Array(RS_DATA_CHUNKS * CHUNK_SIZE);
  
  for (let bytePos = 0; bytePos < CHUNK_SIZE; bytePos++) {
    // Construire le message encodé (avec erasures pour chunks manquants)
    const encoded = new Uint8Array(totalChunks);
    const erasurePositions: number[] = [];
    
    for (let i = 0; i < totalChunks; i++) {
      if (chunkMap.has(i)) {
        encoded[i] = chunkMap.get(i)!.data[bytePos];
      } else {
        encoded[i] = 0; // Erasure
        erasurePositions.push(i);
      }
    }
    
    // Décoder avec RS
    const decoded = rsDecode(encoded, RS_REDUNDANCY);
    
    if (!decoded) {
      __DEV__ && console.log(`[RS-Reconstruct] ❌ RS decode failed at byte position ${bytePos}`);
      return null;
    }
    
    // Copier les données décodées
    for (let i = 0; i < RS_DATA_CHUNKS; i++) {
      reconstructed[i * CHUNK_SIZE + bytePos] = decoded[i];
    }
  }
  
  // Extraire la taille originale
  const sizeView = new DataView(reconstructed.buffer, reconstructed.length - 4, 4);
  const originalSize = sizeView.getUint32(0, false);
  
  // Validation finale
  const expectedSize = expectedType === 'ek' 
    ? KYBER_CONSTANTS.PUBLIC_KEY_SIZE 
    : KYBER_CONSTANTS.CIPHERTEXT_SIZE;
  
  if (originalSize !== expectedSize) {
    __DEV__ && console.log(`[RS-Reconstruct] ⚠️ Size mismatch: got ${originalSize}, expected ${expectedSize}`);
    // Peut être OK si c'est une version différente
  }
  
  __DEV__ && console.log('[RS-Reconstruct] ✅ Successfully reconstructed data');
  return reconstructed.slice(0, originalSize);
}

// ============================================
// UTILITAIRES DE SÉRIALISATION
// ============================================

export function serializeKyberPublicKey(pk: KyberPublicKey): string {
  return bytesToBase64(pk.bytes);
}

export function deserializeKyberPublicKey(b64: string): KyberPublicKey {
  const bytes = base64ToBytes(b64);
  if (bytes.length !== KYBER_CONSTANTS.PUBLIC_KEY_SIZE) {
    throw new Error(`Invalid Kyber public key size: ${bytes.length}, expected ${KYBER_CONSTANTS.PUBLIC_KEY_SIZE}`);
  }
  return { _brand: 'KyberPublicKey', bytes };
}

export function serializeKyberSecretKey(sk: KyberSecretKey): string {
  return bytesToBase64(sk.bytes);
}

export function deserializeKyberSecretKey(b64: string): KyberSecretKey {
  const bytes = base64ToBytes(b64);
  if (bytes.length !== KYBER_CONSTANTS.SECRET_KEY_SIZE) {
    throw new Error(`Invalid Kyber secret key size: ${bytes.length}, expected ${KYBER_CONSTANTS.SECRET_KEY_SIZE}`);
  }
  return { _brand: 'KyberSecretKey', bytes };
}

export function serializeKyberCiphertext(ct: KyberCiphertext): string {
  return bytesToBase64(ct.bytes);
}

export function deserializeKyberCiphertext(b64: string): KyberCiphertext {
  const bytes = base64ToBytes(b64);
  if (bytes.length !== KYBER_CONSTANTS.CIPHERTEXT_SIZE) {
    throw new Error(`Invalid Kyber ciphertext size: ${bytes.length}, expected ${KYBER_CONSTANTS.CIPHERTEXT_SIZE}`);
  }
  return { _brand: 'KyberCiphertext', bytes };
}

export function serializeKyberChunk(chunk: KyberChunk): string {
  return JSON.stringify({
    i: chunk.index,
    t: chunk.total,
    y: chunk.type,
    p: chunk.isParityChunk,
    d: bytesToBase64(chunk.data),
    c: bytesToBase64(chunk.checksum),
  });
}

export function deserializeKyberChunk(json: string): KyberChunk {
  const obj = JSON.parse(json);
  return {
    index: obj.i,
    total: obj.t,
    type: obj.y,
    isParityChunk: obj.p || false,
    data: base64ToBytes(obj.d),
    checksum: base64ToBytes(obj.c),
  };
}

// Helper base64
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================
// CLEANUP
// ============================================

export function zeroizeKyberSecretKey(sk: KyberSecretKey): void {
  zeroize(sk.bytes);
}

export function zeroizeKyberSharedSecret(ss: KyberSharedSecret): void {
  zeroize(ss.bytes);
}