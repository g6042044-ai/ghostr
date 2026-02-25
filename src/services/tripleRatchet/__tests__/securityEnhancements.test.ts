// src/services/tripleRatchet/__tests__/securityEnhancements.test.ts
// Tests pour les corrections de sécurité critiques
// Version 1.0

import {
  // Nonces déterministes
  createNonceGenerator,
  generateDeterministicNonce,
  deriveNonceFromMessage,
  
  // Protection temporelle
  createTemporalProtection,
  calculateJitter,
  quantizeTimestamp,
  enqueueForCoalescing,
  shouldFlushQueue,
  flushMessageQueue,
  
  // Comparaisons constant-time
  secureConstantTimeEqual,
  secureStringEqual,
  
  // Configuration
  applySecurityProfile,
  getSecurityConfig,
  SECURITY_CONFIG,
  
  // Validation chunks
  signChunk,
  verifyChunkSignature,
  
  // Padding
  addRandomPadding,
  
  SecurityMode,
} from '../securityEnhancements';

import { getSecureRandomBytes, constantTimeEqual, zeroize } from '../primitives';

// ============================================
// TEST: NONCES DÉTERMINISTES
// ============================================

describe('Deterministic Nonces', () => {
  test('should generate unique nonces for different counters', () => {
    const sessionSecret = getSecureRandomBytes(32);
    const generator = createNonceGenerator(sessionSecret);
    
    const { nonce: nonce1, newGenerator: gen1 } = generateDeterministicNonce(generator);
    const { nonce: nonce2, newGenerator: gen2 } = generateDeterministicNonce(gen1);
    const { nonce: nonce3 } = generateDeterministicNonce(gen2);
    
    // Tous les nonces doivent être différents
    expect(constantTimeEqual(nonce1, nonce2)).toBe(false);
    expect(constantTimeEqual(nonce2, nonce3)).toBe(false);
    expect(constantTimeEqual(nonce1, nonce3)).toBe(false);
    
    // Taille correcte (24 bytes pour XSalsa20)
    expect(nonce1.length).toBe(24);
    expect(nonce2.length).toBe(24);
    expect(nonce3.length).toBe(24);
    
    // Cleanup
    zeroize(sessionSecret);
    zeroize(nonce1);
    zeroize(nonce2);
    zeroize(nonce3);
  });
  
  test('should generate reproducible nonces with same inputs', () => {
    const sessionSecret = getSecureRandomBytes(32);
    
    // Créer deux générateurs avec le même secret
    const gen1 = createNonceGenerator(sessionSecret);
    const gen2 = createNonceGenerator(sessionSecret);
    
    const { nonce: nonce1 } = generateDeterministicNonce(gen1);
    const { nonce: nonce2 } = generateDeterministicNonce(gen2);
    
    // Les nonces doivent être identiques
    expect(constantTimeEqual(nonce1, nonce2)).toBe(true);
    
    // Cleanup
    zeroize(sessionSecret);
    zeroize(nonce1);
    zeroize(nonce2);
  });
  
  test('should derive different nonces for send vs receive', () => {
    const messageKey = getSecureRandomBytes(32);
    const messageNumber = 42;
    
    const sendNonce = deriveNonceFromMessage(messageKey, messageNumber, 'send');
    const receiveNonce = deriveNonceFromMessage(messageKey, messageNumber, 'receive');
    
    // Les nonces doivent être différents pour send vs receive
    expect(constantTimeEqual(sendNonce, receiveNonce)).toBe(false);
    
    // Taille correcte
    expect(sendNonce.length).toBe(24);
    expect(receiveNonce.length).toBe(24);
    
    // Cleanup
    zeroize(messageKey);
    zeroize(sendNonce);
    zeroize(receiveNonce);
  });
  
  test('should derive different nonces for different message numbers', () => {
    const messageKey = getSecureRandomBytes(32);
    
    const nonce1 = deriveNonceFromMessage(messageKey, 0, 'send');
    const nonce2 = deriveNonceFromMessage(messageKey, 1, 'send');
    const nonce3 = deriveNonceFromMessage(messageKey, 1000000, 'send');
    
    // Tous différents
    expect(constantTimeEqual(nonce1, nonce2)).toBe(false);
    expect(constantTimeEqual(nonce2, nonce3)).toBe(false);
    expect(constantTimeEqual(nonce1, nonce3)).toBe(false);
    
    // Cleanup
    zeroize(messageKey);
    zeroize(nonce1);
    zeroize(nonce2);
    zeroize(nonce3);
  });
});

// ============================================
// TEST: PROTECTION TEMPORELLE
// ============================================

describe('Temporal Protection', () => {
  test('should calculate jitter within bounds', () => {
    // Test standard mode (no jitter)
    for (let i = 0; i < 10; i++) {
      const jitter = calculateJitter('standard');
      expect(jitter).toBe(0);
    }
    
    // Test enhanced mode
    for (let i = 0; i < 10; i++) {
      const jitter = calculateJitter('enhanced');
      expect(jitter).toBeGreaterThanOrEqual(SECURITY_CONFIG.JITTER_MS.enhanced.min);
      expect(jitter).toBeLessThanOrEqual(SECURITY_CONFIG.JITTER_MS.enhanced.max);
    }
    
    // Test paranoid mode
    for (let i = 0; i < 10; i++) {
      const jitter = calculateJitter('paranoid');
      expect(jitter).toBeGreaterThanOrEqual(SECURITY_CONFIG.JITTER_MS.paranoid.min);
      expect(jitter).toBeLessThanOrEqual(SECURITY_CONFIG.JITTER_MS.paranoid.max);
    }
  });
  
  test('should quantize timestamps correctly', () => {
    const timestamp = 1705500000123; // Some timestamp with milliseconds
    
    // Standard: 1 second buckets
    const standardQuantized = quantizeTimestamp(timestamp, 'standard');
    expect(standardQuantized % 1000).toBe(0);
    expect(timestamp - standardQuantized).toBeLessThan(1000);
    
    // Enhanced: 1 minute buckets
    const enhancedQuantized = quantizeTimestamp(timestamp, 'enhanced');
    expect(enhancedQuantized % 60000).toBe(0);
    expect(timestamp - enhancedQuantized).toBeLessThan(60000);
    
    // Paranoid: 5 minute buckets
    const paranoidQuantized = quantizeTimestamp(timestamp, 'paranoid');
    expect(paranoidQuantized % 300000).toBe(0);
    expect(timestamp - paranoidQuantized).toBeLessThan(300000);
  });
  
  test('should manage message queue correctly', () => {
    let state = createTemporalProtection('enhanced');
    
    // Enqueue some messages
    const msg1 = new Uint8Array([1, 2, 3]);
    const msg2 = new Uint8Array([4, 5, 6]);
    
    state = enqueueForCoalescing(state, msg1);
    state = enqueueForCoalescing(state, msg2);
    
    expect(state.messageQueue.length).toBe(2);
    
    // Flush the queue
    const { messages, newState } = flushMessageQueue(state);
    
    expect(messages.length).toBe(2);
    expect(newState.messageQueue.length).toBe(0);
    expect(constantTimeEqual(messages[0], msg1)).toBe(true);
    expect(constantTimeEqual(messages[1], msg2)).toBe(true);
  });
  
  test('should detect when queue should be flushed', () => {
    // Standard mode: immediate flush
    let standardState = createTemporalProtection('standard');
    standardState = enqueueForCoalescing(standardState, new Uint8Array([1]));
    expect(shouldFlushQueue(standardState)).toBe(true);
    
    // Enhanced mode: wait for interval
    let enhancedState = createTemporalProtection('enhanced');
    enhancedState = enqueueForCoalescing(enhancedState, new Uint8Array([1]));
    expect(shouldFlushQueue(enhancedState)).toBe(false);
    
    // High priority should trigger immediate flush
    enhancedState = enqueueForCoalescing(enhancedState, new Uint8Array([2]), 'high');
    expect(shouldFlushQueue(enhancedState)).toBe(true);
  });
});

// ============================================
// TEST: COMPARAISONS CONSTANT-TIME
// ============================================

describe('Constant-Time Comparisons', () => {
  test('should correctly compare equal arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    
    expect(secureConstantTimeEqual(a, b)).toBe(true);
  });
  
  test('should correctly compare unequal arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 6]);
    
    expect(secureConstantTimeEqual(a, b)).toBe(false);
  });
  
  test('should correctly compare arrays of different lengths', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    
    expect(secureConstantTimeEqual(a, b)).toBe(false);
  });
  
  test('should correctly compare strings', () => {
    expect(secureStringEqual('hello', 'hello')).toBe(true);
    expect(secureStringEqual('hello', 'world')).toBe(false);
    expect(secureStringEqual('hello', 'hello!')).toBe(false);
  });
});

// ============================================
// TEST: VALIDATION DES CHUNKS
// ============================================

describe('Chunk Signatures', () => {
  test('should sign and verify chunks correctly', () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const epochKey = getSecureRandomBytes(32);
    const chunkIndex = 5;
    
    const signature = signChunk(chunk, chunkIndex, epochKey);
    
    // Signature should be 8 bytes
    expect(signature.length).toBe(8);
    
    // Verification should succeed
    const isValid = verifyChunkSignature(chunk, chunkIndex, signature, epochKey);
    expect(isValid).toBe(true);
    
    // Cleanup
    zeroize(epochKey);
  });
  
  test('should reject tampered chunks', () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const epochKey = getSecureRandomBytes(32);
    const chunkIndex = 5;
    
    const signature = signChunk(chunk, chunkIndex, epochKey);
    
    // Tamper with the chunk
    const tamperedChunk = new Uint8Array(chunk);
    tamperedChunk[0] = 99;
    
    // Verification should fail
    const isValid = verifyChunkSignature(tamperedChunk, chunkIndex, signature, epochKey);
    expect(isValid).toBe(false);
    
    // Cleanup
    zeroize(epochKey);
  });
  
  test('should reject wrong chunk index', () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const epochKey = getSecureRandomBytes(32);
    
    const signature = signChunk(chunk, 5, epochKey);
    
    // Wrong index should fail verification
    const isValid = verifyChunkSignature(chunk, 6, signature, epochKey);
    expect(isValid).toBe(false);
    
    // Cleanup
    zeroize(epochKey);
  });
});

// ============================================
// TEST: CONFIGURATION DE SÉCURITÉ
// ============================================

describe('Security Configuration', () => {
  test('should apply security profiles correctly', () => {
    // Standard profile
    applySecurityProfile('standard');
    let config = getSecurityConfig();
    expect(config.mode).toBe('standard');
    expect(config.enableDummyTraffic).toBe(false);
    expect(config.enableTemporalProtection).toBe(false);
    
    // Enhanced profile
    applySecurityProfile('enhanced');
    config = getSecurityConfig();
    expect(config.mode).toBe('enhanced');
    expect(config.enableDummyTraffic).toBe(false);
    expect(config.enableTemporalProtection).toBe(true);
    expect(config.enableRandomPadding).toBe(true);
    
    // Paranoid profile
    applySecurityProfile('paranoid');
    config = getSecurityConfig();
    expect(config.mode).toBe('paranoid');
    expect(config.enableDummyTraffic).toBe(true);
    expect(config.enableTemporalProtection).toBe(true);
    expect(config.enableRandomPadding).toBe(true);
    expect(config.logLevel).toBe('none');
  });
});

// ============================================
// TEST: PADDING ALÉATOIRE
// ============================================

describe('Random Padding', () => {
  test('should not add padding in standard mode', () => {
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const padded = addRandomPadding(message, 'standard');
    
    expect(constantTimeEqual(padded, message)).toBe(true);
  });
  
  test('should add padding in enhanced mode', () => {
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    
    // Run multiple times to test randomness
    let differentSizes = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const padded = addRandomPadding(message, 'enhanced');
      differentSizes.add(padded.length);
      
      // Should be at least as long as original
      expect(padded.length).toBeGreaterThanOrEqual(message.length);
      
      // Should not exceed max padding
      const maxExpected = message.length + 2 + SECURITY_CONFIG.RANDOM_PADDING_MAX.enhanced;
      expect(padded.length).toBeLessThanOrEqual(maxExpected);
    }
    
    // Should have some variation (not all same size)
    // Note: There's a small chance all are same, but very unlikely with 20 samples
    expect(differentSizes.size).toBeGreaterThan(1);
  });
  
  test('should add more padding in paranoid mode', () => {
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    
    // Paranoid should have larger max padding
    let maxSeenPadding = 0;
    for (let i = 0; i < 50; i++) {
      const padded = addRandomPadding(message, 'paranoid');
      const extraPadding = padded.length - message.length;
      if (extraPadding > maxSeenPadding) {
        maxSeenPadding = extraPadding;
      }
    }
    
    // Should see some significant padding (at least 100 bytes at some point)
    // This might occasionally fail due to randomness, but very unlikely
    expect(maxSeenPadding).toBeGreaterThan(50);
  });
});

// ============================================
// INTEGRATION TEST
// ============================================

describe('Security Enhancements Integration', () => {
  test('should work together for secure message flow', async () => {
    // 1. Apply enhanced security profile
    applySecurityProfile('enhanced');
    const config = getSecurityConfig();
    
    // 2. Create nonce generator
    const sessionSecret = getSecureRandomBytes(32);
    let nonceGen = createNonceGenerator(sessionSecret);
    
    // 3. Create temporal protection
    let temporalState = createTemporalProtection(config.mode);
    
    // 4. Simulate message encryption with deterministic nonces
    const messages: Uint8Array[] = [];
    const nonces: Uint8Array[] = [];
    
    for (let i = 0; i < 5; i++) {
      // Generate deterministic nonce
      const { nonce, newGenerator } = generateDeterministicNonce(nonceGen);
      nonceGen = newGenerator;
      nonces.push(nonce);
      
      // Create a fake encrypted message
      const message = getSecureRandomBytes(64);
      messages.push(message);
      
      // Queue for coalescing
      temporalState = enqueueForCoalescing(temporalState, message);
    }
    
    // 5. Verify all nonces are unique
    for (let i = 0; i < nonces.length; i++) {
      for (let j = i + 1; j < nonces.length; j++) {
        expect(constantTimeEqual(nonces[i], nonces[j])).toBe(false);
      }
    }
    
    // 6. Apply quantized timestamp
    const now = Date.now();
    const quantized = quantizeTimestamp(now, config.mode);
    expect(quantized).toBeLessThanOrEqual(now);
    expect(now - quantized).toBeLessThan(SECURITY_CONFIG.TIMESTAMP_BUCKET_MS[config.mode]);
    
    // 7. Cleanup
    zeroize(sessionSecret);
    for (const nonce of nonces) {
      zeroize(nonce);
    }
    for (const msg of messages) {
      zeroize(msg);
    }
  });
});
