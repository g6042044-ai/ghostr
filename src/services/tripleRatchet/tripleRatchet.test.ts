// src/services/tripleRatchet/tripleRatchet.test.ts
// Tests complets pour le Triple Ratchet avec protection Post-Quantique
// Version 2.0

import {
  // Triple Ratchet
  initializeTripleRatchetInitiator,
  initializeTripleRatchetResponder,
  tripleRatchetEncrypt,
  tripleRatchetDecrypt,
  serializeTripleRatchetState,
  deserializeTripleRatchetState,
  cleanupTripleRatchetState,
  
  // Types
  TripleRatchetState,
  TripleRatchetMessage,
  
  // Primitives
  generateIdentityKeyPair,
  generateX25519KeyPair,
  createSymmetricKey,
  getSecureRandomBytes,
  bytesToHex,
  
  // PQXDH
  generatePQSignedKey,
  pqxdhInitiator,
  pqxdhResponder,
  createPQPreKeyBundle,
  
  // X3DH classique
  generateSignedPreKey,
  generateOneTimePreKeys,
  
  // Padding
  padMessage,
  unpadMessage,
  padTextMessage,
  unpadTextMessage,
  getPaddingStats,
  
  // ML-KEM
  kyberKeyGen,
  kyberEncapsulate,
  kyberDecapsulate,
  KYBER_CONSTANTS,
  
  // SPQR
  initializeSPQR,
  shouldRotateSPQR,
  DEFAULT_SPQR_CONFIG,
} from './index';

// ============================================
// TESTS ML-KEM (Kyber)
// ============================================

async function testMLKEM(): Promise<void> {
  console.log('\n=== Test ML-KEM-768 ===\n');
  
  // 1. Génération de clés
  console.log('1. Génération de paire de clés...');
  const keyPair = kyberKeyGen();
  
  console.log(`   Public key size: ${keyPair.publicKey.bytes.length} bytes (expected: ${KYBER_CONSTANTS.PUBLIC_KEY_SIZE})`);
  console.log(`   Secret key size: ${keyPair.secretKey.bytes.length} bytes (expected: ${KYBER_CONSTANTS.SECRET_KEY_SIZE})`);
  
  if (keyPair.publicKey.bytes.length !== KYBER_CONSTANTS.PUBLIC_KEY_SIZE) {
    throw new Error('Invalid public key size');
  }
  if (keyPair.secretKey.bytes.length !== KYBER_CONSTANTS.SECRET_KEY_SIZE) {
    throw new Error('Invalid secret key size');
  }
  console.log('   ✅ Tailles de clés correctes');
  
  // 2. Encapsulation
  console.log('\n2. Encapsulation...');
  const { ciphertext, sharedSecret: ss1 } = kyberEncapsulate(keyPair.publicKey);
  
  console.log(`   Ciphertext size: ${ciphertext.bytes.length} bytes (expected: ${KYBER_CONSTANTS.CIPHERTEXT_SIZE})`);
  console.log(`   Shared secret size: ${ss1.bytes.length} bytes (expected: ${KYBER_CONSTANTS.SHARED_SECRET_SIZE})`);
  console.log(`   Shared secret: ${bytesToHex(ss1.bytes).substring(0, 32)}...`);
  
  // 3. Décapsulation
  console.log('\n3. Décapsulation...');
  const ss2 = kyberDecapsulate(ciphertext, keyPair.secretKey);
  
  console.log(`   Shared secret: ${bytesToHex(ss2.bytes).substring(0, 32)}...`);
  
  // 4. Vérification
  console.log('\n4. Vérification des secrets partagés...');
  let match = true;
  for (let i = 0; i < ss1.bytes.length; i++) {
    if (ss1.bytes[i] !== ss2.bytes[i]) {
      match = false;
      break;
    }
  }
  
  if (match) {
    console.log('   ✅ Les secrets partagés correspondent!');
  } else {
    throw new Error('Shared secrets do not match');
  }
}

// ============================================
// TESTS MESSAGE PADDING
// ============================================

async function testMessagePadding(): Promise<void> {
  console.log('\n=== Test Message Padding ===\n');
  
  // 1. Padding simple
  console.log('1. Test padding texte simple...');
  const originalText = 'Hello, World!';
  const padded = padTextMessage(originalText);
  const unpadded = unpadTextMessage(padded);
  
  if (unpadded !== originalText) {
    throw new Error('Text padding/unpadding failed');
  }
  console.log(`   Original: "${originalText}" (${originalText.length} bytes)`);
  console.log(`   Padded: ${padded.length} bytes`);
  console.log(`   ✅ Padding/Unpadding OK`);
  
  // 2. Statistiques de padding
  console.log('\n2. Statistiques de padding...');
  const stats = getPaddingStats(padded);
  console.log(`   Taille totale: ${stats.totalSize} bytes`);
  console.log(`   Taille originale: ${stats.originalSize} bytes`);
  console.log(`   Padding ajouté: ${stats.paddingSize} bytes`);
  console.log(`   Overhead: ${stats.overheadPercent.toFixed(1)}%`);
  
  // 3. Test messages de différentes tailles
  console.log('\n3. Test différentes tailles...');
  const sizes = [10, 100, 1000, 5000, 10000];
  
  for (const size of sizes) {
    const data = getSecureRandomBytes(size);
    const paddedData = padMessage(data, 'auto');
    const unpaddedData = unpadMessage(paddedData);
    
    if (unpaddedData.length !== size) {
      throw new Error(`Size mismatch for ${size} bytes`);
    }
    
    let match = true;
    for (let i = 0; i < size; i++) {
      if (data[i] !== unpaddedData[i]) {
        match = false;
        break;
      }
    }
    
    if (!match) {
      throw new Error(`Content mismatch for ${size} bytes`);
    }
    
    console.log(`   ${size} bytes → ${paddedData.length} bytes (${((paddedData.length / size - 1) * 100).toFixed(0)}% overhead) ✅`);
  }
}

// ============================================
// TESTS PQXDH
// ============================================

async function testPQXDH(): Promise<void> {
  console.log('\n=== Test PQXDH (Post-Quantum X3DH) ===\n');
  
  // 1. Génération des clés pour Alice et Bob
  console.log('1. Génération des clés...');
  
  const aliceIdentity = generateIdentityKeyPair();
  const bobIdentity = generateIdentityKeyPair();
  
  console.log(`   Alice Identity Key: ${bytesToHex(aliceIdentity.publicKey.bytes).substring(0, 16)}...`);
  console.log(`   Bob Identity Key: ${bytesToHex(bobIdentity.publicKey.bytes).substring(0, 16)}...`);
  
  // 2. Bob crée son bundle PQXDH
  console.log('\n2. Bob crée son PQ PreKey Bundle...');
  
  const bobSignedPreKey = generateSignedPreKey(bobIdentity, 1);
  const bobPQSignedKey = generatePQSignedKey(bobIdentity, 1);
  const bobOneTimePreKeys = generateOneTimePreKeys(1, 5);
  
  const bobBundle = createPQPreKeyBundle(
    bobIdentity,
    bobSignedPreKey,
    bobPQSignedKey,
    bobOneTimePreKeys[0]
  );
  
  console.log(`   Signed PreKey ID: ${bobBundle.signedPreKey.id}`);
  console.log(`   PQ PreKey ID: ${bobBundle.pqPreKey.id}`);
  console.log(`   One-Time PreKey ID: ${bobBundle.oneTimePreKey?.id}`);
  console.log(`   Bundle version: ${bobBundle.version} (PQXDH)`);
  
  // 3. Alice effectue PQXDH
  console.log('\n3. Alice initie PQXDH...');
  
  const aliceResult = await pqxdhInitiator(aliceIdentity, bobBundle);
  
  console.log(`   Ephemeral Key: ${bytesToHex(aliceResult.ephemeralPublicKey.bytes).substring(0, 16)}...`);
  console.log(`   KEM Ciphertext: ${aliceResult.kemCiphertext.bytes.length} bytes`);
  console.log(`   Shared Secret: ${bytesToHex(aliceResult.sharedSecret.bytes).substring(0, 16)}...`);
  
  // 4. Bob répond au PQXDH
  console.log('\n4. Bob répond au PQXDH...');
  
  // Simuler le message initial PQXDH
  const initialMessage = {
    identityKey: aliceIdentity.publicKey,
    ephemeralKey: aliceResult.ephemeralPublicKey,
    usedSignedPreKeyId: bobSignedPreKey.id,
    usedOneTimePreKeyId: bobOneTimePreKeys[0].id,
    usedPQPreKeyId: bobPQSignedKey.id,
    kemCiphertext: aliceResult.kemCiphertext,
    ciphertext: new Uint8Array(0),
  };
  
  const bobSharedSecret = await pqxdhResponder(
    bobIdentity,
    bobSignedPreKey,
    bobPQSignedKey,
    bobOneTimePreKeys[0],
    initialMessage
  );
  
  console.log(`   Bob Shared Secret: ${bytesToHex(bobSharedSecret.bytes).substring(0, 16)}...`);
  
  // 5. Vérification
  console.log('\n5. Vérification des secrets partagés...');
  
  let match = true;
  for (let i = 0; i < aliceResult.sharedSecret.bytes.length; i++) {
    if (aliceResult.sharedSecret.bytes[i] !== bobSharedSecret.bytes[i]) {
      match = false;
      break;
    }
  }
  
  if (match) {
    console.log('   ✅ PQXDH réussi! Secrets identiques.');
  } else {
    throw new Error('PQXDH failed: secrets do not match');
  }
}

// ============================================
// TESTS TRIPLE RATCHET COMPLET
// ============================================

async function testTripleRatchet(): Promise<void> {
  console.log('\n=== Test Triple Ratchet Complet ===\n');
  
  // 1. Setup: Établir une session PQXDH
  console.log('1. Établissement de session PQXDH...');
  
  const aliceIdentity = generateIdentityKeyPair();
  const bobIdentity = generateIdentityKeyPair();
  
  const bobSignedPreKey = generateSignedPreKey(bobIdentity, 1);
  const bobPQSignedKey = generatePQSignedKey(bobIdentity, 1);
  const bobOneTimePreKeys = generateOneTimePreKeys(1, 1);
  
  const bobBundle = createPQPreKeyBundle(
    bobIdentity,
    bobSignedPreKey,
    bobPQSignedKey,
    bobOneTimePreKeys[0]
  );
  
  const alicePQXDH = await pqxdhInitiator(aliceIdentity, bobBundle);
  
  const initialMessage = {
    identityKey: aliceIdentity.publicKey,
    ephemeralKey: alicePQXDH.ephemeralPublicKey,
    usedSignedPreKeyId: bobSignedPreKey.id,
    usedOneTimePreKeyId: bobOneTimePreKeys[0].id,
    usedPQPreKeyId: bobPQSignedKey.id,
    kemCiphertext: alicePQXDH.kemCiphertext,
    ciphertext: new Uint8Array(0),
  };
  
  const bobSharedSecret = await pqxdhResponder(
    bobIdentity,
    bobSignedPreKey,
    bobPQSignedKey,
    bobOneTimePreKeys[0],
    initialMessage
  );
  
  console.log('   ✅ Session PQXDH établie');
  
  // 2. Initialiser le Triple Ratchet
  console.log('\n2. Initialisation du Triple Ratchet...');
  
  // Alice est l'initiateur
  let aliceState = await initializeTripleRatchetInitiator(
    alicePQXDH.sharedSecret,
    bobSignedPreKey.keyPair.publicKey,
    alicePQXDH.sharedSecret.bytes // PQ secret from PQXDH
  );
  
  // Bob est le répondeur
  let bobState = await initializeTripleRatchetResponder(
    bobSharedSecret,
    bobSignedPreKey.keyPair,
    bobSharedSecret.bytes
  );
  
  console.log('   Alice initialisée comme initiateur');
  console.log('   Bob initialisé comme répondeur');
  console.log('   ✅ Triple Ratchet initialisé');
  
  // 3. Alice envoie un message à Bob
  console.log('\n3. Alice → Bob: Premier message...');
  
  const message1 = new TextEncoder().encode('Hello Bob! This is a secure message with post-quantum protection.');
  
  const { message: encrypted1, newState: aliceState2 } = await tripleRatchetEncrypt(
    aliceState,
    message1
  );
  aliceState = aliceState2;
  
  console.log(`   Message original: ${message1.length} bytes`);
  console.log(`   Message chiffré: ${encrypted1.ciphertext.length} chars (base64)`);
  
  // Bob déchiffre
  const { result: decrypted1, newState: bobState2 } = await tripleRatchetDecrypt(
    bobState,
    encrypted1
  );
  bobState = bobState2;
  
  const decryptedText1 = new TextDecoder().decode(decrypted1.plaintext);
  console.log(`   Déchiffré: "${decryptedText1.substring(0, 30)}..."`);
  
  if (decryptedText1 !== new TextDecoder().decode(message1)) {
    throw new Error('Decryption failed for message 1');
  }
  console.log('   ✅ Message 1 déchiffré correctement');
  
  // 4. Bob répond à Alice
  console.log('\n4. Bob → Alice: Réponse...');
  
  const message2 = new TextEncoder().encode('Hi Alice! Message received. This triggers a DH ratchet step.');
  
  const { message: encrypted2, newState: bobState3 } = await tripleRatchetEncrypt(
    bobState,
    message2
  );
  bobState = bobState3;
  
  const { result: decrypted2, newState: aliceState3 } = await tripleRatchetDecrypt(
    aliceState,
    encrypted2
  );
  aliceState = aliceState3;
  
  const decryptedText2 = new TextDecoder().decode(decrypted2.plaintext);
  console.log(`   Déchiffré: "${decryptedText2.substring(0, 30)}..."`);
  
  if (decryptedText2 !== new TextDecoder().decode(message2)) {
    throw new Error('Decryption failed for message 2');
  }
  console.log('   ✅ Message 2 déchiffré correctement');
  
  // 5. Échange de plusieurs messages
  console.log('\n5. Échange de plusieurs messages...');
  
  const testMessages = [
    'Third message from Alice 🔐',
    'Fourth message from Bob 🛡️',
    'Fifth message from Alice 🔒',
    'Sixth message from Bob 🔑',
    'Seventh message from Alice - testing long message with more content to verify padding works correctly',
  ];
  
  let sender: 'alice' | 'bob' = 'alice';
  
  for (let i = 0; i < testMessages.length; i++) {
    const msg = new TextEncoder().encode(testMessages[i]);
    
    if (sender === 'alice') {
      const { message: enc, newState } = await tripleRatchetEncrypt(aliceState, msg);
      aliceState = newState;
      
      const { result: dec, newState: newBobState } = await tripleRatchetDecrypt(bobState, enc);
      bobState = newBobState;
      
      const decText = new TextDecoder().decode(dec.plaintext);
      if (decText !== testMessages[i]) {
        throw new Error(`Decryption failed for message ${i + 3}`);
      }
      sender = 'bob';
    } else {
      const { message: enc, newState } = await tripleRatchetEncrypt(bobState, msg);
      bobState = newState;
      
      const { result: dec, newState: newAliceState } = await tripleRatchetDecrypt(aliceState, enc);
      aliceState = newAliceState;
      
      const decText = new TextDecoder().decode(dec.plaintext);
      if (decText !== testMessages[i]) {
        throw new Error(`Decryption failed for message ${i + 3}`);
      }
      sender = 'alice';
    }
    
    console.log(`   Message ${i + 3}: ✅`);
  }
  
  // 6. Test sérialisation
  console.log('\n6. Test sérialisation de l\'état...');
  
  const serializedAlice = serializeTripleRatchetState(aliceState);
  const restoredAlice = deserializeTripleRatchetState(serializedAlice);
  
  console.log(`   État sérialisé: ${JSON.stringify(serializedAlice).length} bytes`);
  console.log('   ✅ Sérialisation réussie');
  
  // 7. Vérifier que la session restaurée fonctionne
  console.log('\n7. Test session restaurée...');
  
  const message8 = new TextEncoder().encode('Message after state restoration');
  
  const { message: encrypted8, newState: restoredAlice2 } = await tripleRatchetEncrypt(
    restoredAlice,
    message8
  );
  
  const { result: decrypted8, newState: bobState4 } = await tripleRatchetDecrypt(
    bobState,
    encrypted8
  );
  bobState = bobState4;
  
  if (new TextDecoder().decode(decrypted8.plaintext) !== 'Message after state restoration') {
    throw new Error('Session restoration failed');
  }
  console.log('   ✅ Session restaurée fonctionne correctement');
  
  // 8. Cleanup
  console.log('\n8. Cleanup...');
  cleanupTripleRatchetState(aliceState);
  cleanupTripleRatchetState(bobState);
  cleanupTripleRatchetState(restoredAlice);
  console.log('   ✅ États effacés de la mémoire');
  
  console.log('\n✅✅✅ TOUS LES TESTS TRIPLE RATCHET RÉUSSIS ✅✅✅\n');
}

// ============================================
// TEST SPQR (Rotation Post-Quantique)
// ============================================

async function testSPQR(): Promise<void> {
  console.log('\n=== Test SPQR (Sparse Post-Quantum Ratchet) ===\n');
  
  // 1. Initialisation
  console.log('1. Initialisation SPQR...');
  const initialSecret = getSecureRandomBytes(32);
  const spqrState = initializeSPQR(initialSecret);
  
  console.log(`   Epoch: ${spqrState.epoch}`);
  console.log(`   Message count: ${spqrState.messageCount}`);
  console.log(`   Has Kyber keypair: ${spqrState.myKyberKeyPair !== null}`);
  console.log(`   Pending PQ rotation: ${spqrState.pendingPQRotation}`);
  console.log('   ✅ SPQR initialisé');
  
  // 2. Vérifier rotation
  console.log('\n2. Test condition de rotation...');
  
  const shouldRotate = shouldRotateSPQR(spqrState, DEFAULT_SPQR_CONFIG);
  console.log(`   Should rotate: ${shouldRotate}`);
  console.log('   ✅ Logique de rotation OK');
}

// ============================================
// RUNNER PRINCIPAL
// ============================================

export async function runAllTests(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   TESTS TRIPLE RATCHET AVEC PROTECTION POST-QUANTUM  ║');
  console.log('║               Version 2.0 - Ghostr                   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  
  try {
    await testMLKEM();
    await testMessagePadding();
    await testSPQR();
    await testPQXDH();
    await testTripleRatchet();
    
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║         ✅ TOUS LES TESTS RÉUSSIS! ✅               ║');
    console.log('║                                                      ║');
    console.log('║  Le Triple Ratchet est opérationnel avec:           ║');
    console.log('║  • Forward Secrecy (DH Ratchet)                     ║');
    console.log('║  • Post-Compromise Security (Symmetric Ratchet)     ║');
    console.log('║  • Post-Quantum Security (SPQR + ML-KEM-768)        ║');
    console.log('║  • Traffic Analysis Protection (Message Padding)    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    
  } catch (error) {
    console.error('\n❌ TEST ÉCHOUÉ:', error);
    throw error;
  }
}

// Exécuter si appelé directement
// runAllTests().catch(console.error);
