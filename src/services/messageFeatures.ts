// src/services/messageFeatures.ts
// Gestion des accusés de lecture ("Vu") et des réactions aux messages
// VERSION 1.0 - Extension du système de messagerie chiffrée
//
// CARACTÉRISTIQUES:
// - Read receipts chiffrés (préserve l'anonymat)
// - Réactions chiffrées (préserve l'anonymat)
// - Stockage local avec synchronisation via messages chiffrés
// - Compatible avec le Double Ratchet existant

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptIfEnabled, decryptIfNeeded } from './localCrypto';

// ============================================
// TYPES
// ============================================

/**
 * Status d'un message envoyé
 * - 'sending': En cours d'envoi
 * - 'sent': Envoyé au serveur
 * - 'delivered': Reçu par au moins un destinataire
 * - 'read': Lu par au moins un destinataire
 */
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read';

/**
 * Une réaction à un message
 */
export interface MessageReaction {
  emoji: string;           // L'emoji de réaction
  senderToken: string;     // Token de l'expéditeur de la réaction
  displayName?: string;    // Nom affiché de l'expéditeur
  timestamp: number;       // Horodatage de la réaction
}

/**
 * Payload d'un accusé de lecture (chiffré et envoyé comme message)
 */
export interface ReadReceiptPayload {
  type: 'read_receipt';
  messageIds: string[];    // IDs des messages lus
  readAt: number;          // Timestamp de lecture
}

/**
 * Payload d'une réaction (chiffré et envoyé comme message)
 */
export interface ReactionPayload {
  type: 'reaction';
  targetMessageId: string; // ID du message ciblé
  emoji: string;           // Emoji de réaction
  action: 'add' | 'remove'; // Ajouter ou retirer
}

/**
 * Type de payload spécial (extension du message normal)
 */
export type SpecialPayloadType = 'message' | 'read_receipt' | 'reaction';

// ============================================
// CONSTANTES
// ============================================

const MESSAGE_STATUS_PREFIX = 'whisper_msg_status_';
const MESSAGE_REACTIONS_PREFIX = 'whisper_msg_reactions_';

// ============================================
// GESTION DES STATUS DE MESSAGES
// ============================================

/**
 * Récupère le status d'un message
 */
export async function getMessageStatus(
  conversationId: string,
  messageId: string
): Promise<MessageStatus | null> {
  try {
    const key = `${MESSAGE_STATUS_PREFIX}${conversationId}`;
    const rawData = await AsyncStorage.getItem(key);
    
    if (!rawData) return null;
    
    const decrypted = decryptIfNeeded(rawData);
    const statusMap: Record<string, MessageStatus> = JSON.parse(decrypted);
    
    return statusMap[messageId] || null;
  } catch (error) {
    console.error('Failed to get message status:', error);
    return null;
  }
}

/**
 * Récupère tous les status d'une conversation
 */
export async function getAllMessageStatuses(
  conversationId: string
): Promise<Record<string, MessageStatus>> {
  try {
    const key = `${MESSAGE_STATUS_PREFIX}${conversationId}`;
    const rawData = await AsyncStorage.getItem(key);
    
    if (!rawData) return {};
    
    const decrypted = decryptIfNeeded(rawData);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to get message statuses:', error);
    return {};
  }
}

/**
 * Met à jour le status d'un ou plusieurs messages
 */
export async function updateMessageStatus(
  conversationId: string,
  messageIds: string | string[],
  status: MessageStatus
): Promise<void> {
  try {
    const key = `${MESSAGE_STATUS_PREFIX}${conversationId}`;
    const statuses = await getAllMessageStatuses(conversationId);
    
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    
    for (const id of ids) {
      // Ne pas rétrograder le status (sent -> read = ok, read -> sent = non)
      const currentStatus = statuses[id];
      if (currentStatus && !shouldUpdateStatus(currentStatus, status)) {
        continue;
      }
      statuses[id] = status;
    }
    
    const encrypted = encryptIfEnabled(JSON.stringify(statuses));
    await AsyncStorage.setItem(key, encrypted);
    
  } catch (error) {
    console.error('Failed to update message status:', error);
  }
}

/**
 * Marque plusieurs messages comme lus
 */
export async function markMessagesAsRead(
  conversationId: string,
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return;
  await updateMessageStatus(conversationId, messageIds, 'read');
}

/**
 * Vérifie si on doit mettre à jour le status
 */
function shouldUpdateStatus(current: MessageStatus, next: MessageStatus): boolean {
  const order: MessageStatus[] = ['sending', 'sent', 'delivered', 'read'];
  return order.indexOf(next) > order.indexOf(current);
}

// ============================================
// GESTION DES RÉACTIONS
// ============================================

/**
 * Récupère toutes les réactions pour un message
 */
export async function getMessageReactions(
  conversationId: string,
  messageId: string
): Promise<MessageReaction[]> {
  try {
    const allReactions = await getAllReactions(conversationId);
    return allReactions[messageId] || [];
  } catch (error) {
    console.error('Failed to get message reactions:', error);
    return [];
  }
}

/**
 * Récupère toutes les réactions d'une conversation
 */
export async function getAllReactions(
  conversationId: string
): Promise<Record<string, MessageReaction[]>> {
  try {
    const key = `${MESSAGE_REACTIONS_PREFIX}${conversationId}`;
    const rawData = await AsyncStorage.getItem(key);
    
    if (!rawData) return {};
    
    const decrypted = decryptIfNeeded(rawData);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to get reactions:', error);
    return {};
  }
}

/**
 * Ajoute une réaction à un message
 */
export async function addReaction(
  conversationId: string,
  messageId: string,
  reaction: MessageReaction
): Promise<void> {
  try {
    const key = `${MESSAGE_REACTIONS_PREFIX}${conversationId}`;
    const allReactions = await getAllReactions(conversationId);
    
    if (!allReactions[messageId]) {
      allReactions[messageId] = [];
    }
    
    // Vérifier si cette personne a déjà réagi avec cet emoji
    const existingIndex = allReactions[messageId].findIndex(
      r => r.senderToken === reaction.senderToken && r.emoji === reaction.emoji
    );
    
    if (existingIndex === -1) {
      allReactions[messageId].push(reaction);
    }
    
    const encrypted = encryptIfEnabled(JSON.stringify(allReactions));
    await AsyncStorage.setItem(key, encrypted);
    
  } catch (error) {
    console.error('Failed to add reaction:', error);
  }
}

/**
 * Retire une réaction d'un message
 */
export async function removeReaction(
  conversationId: string,
  messageId: string,
  senderToken: string,
  emoji: string
): Promise<void> {
  try {
    const key = `${MESSAGE_REACTIONS_PREFIX}${conversationId}`;
    const allReactions = await getAllReactions(conversationId);
    
    if (!allReactions[messageId]) return;
    
    allReactions[messageId] = allReactions[messageId].filter(
      r => !(r.senderToken === senderToken && r.emoji === emoji)
    );
    
    // Nettoyer si plus de réactions
    if (allReactions[messageId].length === 0) {
      delete allReactions[messageId];
    }
    
    const encrypted = encryptIfEnabled(JSON.stringify(allReactions));
    await AsyncStorage.setItem(key, encrypted);
    
  } catch (error) {
    console.error('Failed to remove reaction:', error);
  }
}

/**
 * Agrège les réactions pour l'affichage
 * Retourne une liste triée par nombre de réactions
 */
export function aggregateReactions(
  reactions: MessageReaction[] | undefined | null,
  mySenderToken: string
): Array<{
  emoji: string;
  count: number;
  userReacted: boolean;
  reactors: string[];
}> {
  // Protection contre undefined/null
  if (!reactions || !Array.isArray(reactions)) {
    return [];
  }
  
  const emojiMap = new Map<string, {
    count: number;
    userReacted: boolean;
    reactors: string[];
  }>();
  
  for (const reaction of reactions) {
    if (!reaction || !reaction.emoji) continue;
    
    const existing = emojiMap.get(reaction.emoji);
    if (existing) {
      existing.count++;
      if (reaction.senderToken === mySenderToken) {
        existing.userReacted = true;
      }
      if (reaction.displayName) {
        existing.reactors.push(reaction.displayName);
      }
    } else {
      emojiMap.set(reaction.emoji, {
        count: 1,
        userReacted: reaction.senderToken === mySenderToken,
        reactors: reaction.displayName ? [reaction.displayName] : [],
      });
    }
  }
  
  // Convertir et trier
  return Array.from(emojiMap.entries())
    .map(([emoji, data]) => ({ emoji, ...data }))
    .sort((a, b) => b.count - a.count);
}

// ============================================
// HELPERS POUR DÉTECTER LES TYPES DE PAYLOAD
// ============================================

/**
 * Vérifie si un payload déchiffré est un accusé de lecture
 */
export function isReadReceiptPayload(payload: any): payload is ReadReceiptPayload {
  return payload && payload.type === 'read_receipt' && Array.isArray(payload.messageIds);
}

/**
 * Vérifie si un payload déchiffré est une réaction
 */
export function isReactionPayload(payload: any): payload is ReactionPayload {
  return payload && payload.type === 'reaction' && 
         typeof payload.targetMessageId === 'string' &&
         typeof payload.emoji === 'string';
}

/**
 * Détermine le type de payload
 */
export function getPayloadType(payload: any): SpecialPayloadType {
  if (isReadReceiptPayload(payload)) return 'read_receipt';
  if (isReactionPayload(payload)) return 'reaction';
  return 'message';
}

// ============================================
// NETTOYAGE
// ============================================

/**
 * Supprime toutes les données de status et réactions pour une conversation
 */
export async function clearConversationFeatures(conversationId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${MESSAGE_STATUS_PREFIX}${conversationId}`);
    await AsyncStorage.removeItem(`${MESSAGE_REACTIONS_PREFIX}${conversationId}`);
  } catch (error) {
    console.error('Failed to clear conversation features:', error);
  }
}
