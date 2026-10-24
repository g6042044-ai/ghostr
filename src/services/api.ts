// src/services/api.ts
// Configuration Supabase et exports réseau
//
// v13.0 - NETTOYAGE:
//   - Suppression de tout le code legacy (sendMessage, polling, realtime, 
//     chiffrement Sender Keys, Double Ratchet wrapper)
//   - Le système actif utilise api1to1.ts + tripleRatchet/*
//   - Ce fichier ne conserve que la configuration réseau partagée
//
// ARCHITECTURE (tâche 0.4, 2026-10-24) :
//   - Plus aucun client Supabase instancié côté app. Tous les RPC passent par
//     secureRpc() (relayTransport.ts, tunnel OHTTP) et tous les blobs par
//     encryptedBlobService.ts (upload_blob / download_blob via OHTTP).
//   - Ce fichier ne garde que les constantes réseau et les helpers d'URL.

// ============================================
// CONFIGURATION AVEC RELAY
// ============================================

const RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL || '';
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'your-anon-key';

const API_URL = RELAY_URL || SUPABASE_URL;

// v26.0: Exporté pour downloadAndDecryptBlob (fetch direct via relay)
export { API_URL, SUPABASE_ANON_KEY };

// Note: Le certificate pinning est géré de manière transparente par
// react-native-ssl-public-key-pinning (initialisé dans App.tsx).
// Toutes les requêtes fetch sont automatiquement pinnées, pas besoin
// de custom fetch ici.

export function isRelayEnabled(): boolean {
  return !!RELAY_URL && RELAY_URL.length > 0;
}

export function getApiUrl(): string {
  return API_URL;
}