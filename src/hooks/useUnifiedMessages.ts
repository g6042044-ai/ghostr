// src/hooks/useUnifiedMessages.ts
// Hook pour les conversations 1:1
// Version 1.0 - Full Mesh Triple Ratchet pour tous les modes
//
// Utilise sessionService + api1to1 (Triple Ratchet direct)

import * as React from 'react';
import { sessionService, StoredSession } from '../services/tripleRatchet';
import {
  sendMessage1to1,
  sendReaction1to1,
  sendReadReceipt1to1,
  fetchMessages1to1,
  subscribe1to1,
  getLocalMessages1to1,
  clearLocalMessages1to1,
  clearUnreadCount,
  onStatusChange,
  onReaction,
  pollAllSessions,
  Message1to1,
  loadReactions,
  toggleReactionStorage,
  StoredReaction,
  retryFailedMessage1to1,
  deleteFailedMessage1to1,
} from '../services/api1to1';
import {
  sendImageMessage1to1,
  sendFileMessage1to1,
  sendVoiceMessage1to1,
} from '../services/media1to1';
import { getDeviceId, getGlobalDisplayName } from '../services/storage';
import { LocalMessage } from '../services/storage';
import { MessageStatus } from '../services/messageStatus';

// ============================================
// TYPES UNIFIÉS
// ============================================

export interface UnifiedMessage {
  id: string;
  conversationId: string;
  content: string;
  senderToken: string;
  senderId?: string;
  senderName?: string;
  timestamp: number;
  isMine: boolean;
  displayName: string;
  avatarBase64?: string;
  status?: MessageStatus;
  
  // Type de message
  messageType?: 'text' | 'image' | 'file' | 'voice' | 'reaction' | 'read_receipt' | 'delivered_receipt' | 'system';
  
  // Images
  imageData?: string;
  thumbnailData?: string;
  imageWidth?: number;
  imageHeight?: number;
  
  // Fichiers
  fileData?: string;
  fileName?: string;
  fileSize?: number;
  fileMimeType?: string;
  
  // Vocaux
  voiceData?: string;
  voiceDuration?: number;
  
  // Réponses
  replyToId?: string;
  replyToContent?: string;
  replyToSender?: string;
  
  // Réactions (format UI: groupées par emoji)
  reactions?: { emoji: string; count: number; userReacted: boolean }[];
  
  // v26.0: Blob storage — référence vers un média chiffré hors-bande
  sessionId?: string;         // Nécessaire pour downloadMediaBlob
  blobId?: string;
  blobKey?: string;
  blobNonce?: string;
  blobSize?: number;
  blobMediaType?: 'image' | 'file' | 'voice';
}

export interface ConversationInfo {
  type: '1to1';
  id: string;
  name: string;
  avatarBase64?: string;
  
  // Pour 1:1
  session?: StoredSession | null;
  contactFingerprint?: string;
  myFingerprint?: string;
  
  
  // Commun
  isSecure: boolean;
  protocol: string;
  
}

export interface UseUnifiedMessagesResult {
  // État
  messages: UnifiedMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  
  
  // Actions - Texte
  sendMessage: (content: string, replyTo?: { id: string; content: string; sender: string }) => Promise<boolean>;
  
  // Actions - Médias
  sendImage: (imageUri: string, thumbnailData?: string, width?: number, height?: number, caption?: string) => Promise<boolean>;
  sendFile: (fileUri: string, fileName: string, fileSize: number, mimeType: string) => Promise<boolean>;
  sendVoice: (voiceUri: string, duration: number, waveform?: number[]) => Promise<boolean>;
  
  // Actions - Réactions & Accusés (1:1 seulement pour l'instant)
  toggleReaction: (messageId: string, emoji: string) => Promise<boolean>;
  markAsRead: (messageIds: string[]) => Promise<boolean>;
  
  // Actions - Gestion
  refresh: () => Promise<void>;
  deleteMessages: (messageIds: string[]) => Promise<boolean>;
  deleteAllMessages: () => Promise<boolean>;
  addMessage: (message: UnifiedMessage) => void;
  updateMessage: (messageId: string, updates: Partial<UnifiedMessage>) => void;
  
  // P7 FIX: Actions - Messages échoués
  retryMessage: (messageId: string) => Promise<boolean>;
  deleteFailedMessage: (messageId: string) => Promise<boolean>;
  
  // Info
  conversationInfo: ConversationInfo;
}

// ============================================
// HELPER: Détecter le type de conversation
// ============================================

export function getConversationType(id: string): '1to1' {
  return '1to1';
}

// ============================================
// ============================================
// CONVERSION: Message1to1 → UnifiedMessage
// ============================================

function message1to1ToUnified(msg: Message1to1, conversationId: string): UnifiedMessage {
  return {
    id: msg.id,
    conversationId,
    content: msg.content,
    senderToken: msg.isMine ? 'me' : (msg.senderFingerprint || 'them'),
    timestamp: msg.timestamp,
    isMine: msg.isMine,
    displayName: msg.displayName,
    avatarBase64: msg.senderAvatarBase64,
    status: msg.isMine ? (msg.status || 'sent') : undefined,
    messageType: msg.messageType,
    imageData: msg.imageData,
    thumbnailData: msg.thumbnailData,
    imageWidth: msg.imageWidth,
    imageHeight: msg.imageHeight,
    fileData: msg.fileData,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileMimeType: msg.fileMimeType,
    voiceData: msg.voiceData,
    voiceDuration: msg.voiceDuration,
    replyToId: msg.replyToId,
    replyToContent: msg.replyToContent,
    replyToSender: msg.replyToSender,
    // v26.0: Blob storage refs — nécessaires pour BlobMediaPlaceholder + download
    sessionId: msg.sessionId || conversationId,
    blobId: msg.blobId,
    blobKey: msg.blobKey,
    blobNonce: msg.blobNonce,
    blobSize: msg.blobSize,
    blobMediaType: msg.blobMediaType,
  };
}

// ============================================
// HOOK PRINCIPAL
// ============================================

export function useUnifiedMessages(conversationId: string): UseUnifiedMessagesResult {
  const conversationType = getConversationType(conversationId);
  
  // État commun
  const [messages, setMessages] = React.useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  
  // État 1:1
  const [session, setSession] = React.useState<StoredSession | null>(null);
  const [reactions, setReactions] = React.useState<Map<string, { emoji: string; senderFingerprint: string }[]>>(new Map());
  
  
  // v28.0: État d'exclusion
  
  // Refs
  const pendingContentsRef = React.useRef<Set<string>>(new Set());
  const isInitializedRef = React.useRef(false);

  // ==========================================
  // INITIALISATION - 1:1
  // ==========================================
  
  const initialize1to1 = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      await sessionService.initialize();
      
      const sess = sessionService.getSession(conversationId);
      if (!sess) {
        setError('Session non trouvée. Veuillez recréer la conversation.');
        setLoading(false);
        return;
      }
      
      setSession(sess);
      
      // Remettre à zéro le compteur de messages non lus
      await clearUnreadCount(conversationId);
      
      // Charger les messages locaux
      const localMsgs = await getLocalMessages1to1(conversationId);
      setMessages(localMsgs.map(m => message1to1ToUnified(m, conversationId)));
      
      // v21.0: Charger les réactions persistées
      const storedReactions = await loadReactions(conversationId);
      setReactions(storedReactions);
      
      // Récupérer les nouveaux messages
      const serverMsgs = await fetchMessages1to1(conversationId);
      if (serverMsgs.length > 0) {
        setMessages(prev => mergeMessages(prev, serverMsgs.map(m => message1to1ToUnified(m, conversationId))));
      }
      
      setLoading(false);
      isInitializedRef.current = true;
      
    } catch (e) {
      console.error('[useUnifiedMessages] Init 1:1 error:', e);
      setError('Erreur lors du chargement des messages');
      setLoading(false);
    }
  }, [conversationId]);

  // ==========================================
  // INITIALISATION - GROUPE
  // ==========================================
  

  // ==========================================
  // EFFET D'INITIALISATION
  // ==========================================
  
  React.useEffect(() => {
    let isMounted = true;
    
    if (conversationType === '1to1') {
      initialize1to1();
    }
    
    return () => {
      isMounted = false;
    };
  }, [conversationId, conversationType]);

  // ==========================================
  // SUBSCRIPTIONS - 1:1
  // ==========================================
  
  React.useEffect(() => {
    if (conversationType !== '1to1') return;
    
    const handleNewMessage = (msg: Message1to1) => {
      if (msg.isMine && pendingContentsRef.current.has(msg.content)) {
        return;
      }
      
      setMessages(prev => {
        const unified = message1to1ToUnified(msg, conversationId);
        if (prev.some(m => m.id === unified.id)) {
          return prev;
        }
        
        const tempIndex = prev.findIndex(
          m => m.id.startsWith('temp-') && m.content === unified.content && m.isMine
        );
        
        if (tempIndex !== -1) {
          const updated = [...prev];
          updated[tempIndex] = unified;
          return updated;
        }
        
        return mergeMessages(prev, [unified]);
      });
    };
    
    const handleStatusChange = (messageIds: string[], status: 'delivered' | 'read') => {
      setMessages(prev => prev.map(m => 
        messageIds.includes(m.id) ? { ...m, status } : m
      ));
    };
    
    const handleReaction = async (targetMessageId: string, emoji: string, senderFingerprint: string) => {
      // v21.0: La réaction est déjà persistée dans api1to1.ts, on recharge juste depuis le storage
      const updatedReactions = await loadReactions(conversationId);
      setReactions(updatedReactions);
    };
    
    const unsubscribe = subscribe1to1(conversationId, handleNewMessage);
    const unsubStatus = onStatusChange(conversationId, handleStatusChange);
    const unsubReaction = onReaction(conversationId, handleReaction);
    
    return () => {
      unsubscribe();
      unsubStatus();
      unsubReaction();
    };
  }, [conversationId, conversationType]);

  // ==========================================
  // SUBSCRIPTIONS - GROUPE
  // ==========================================
  

  // ==========================================
  // SEND MESSAGE
  // ==========================================
  
  const sendMessage = React.useCallback(async (
    content: string,
    replyTo?: { id: string; content: string; sender: string }
  ): Promise<boolean> => {
    if (sending || !content.trim()) return false;
    
    setSending(true);
    pendingContentsRef.current.add(content);
    
    try {
      if (conversationType === '1to1') {
        // Message optimiste
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const optimisticMessage: UnifiedMessage = {
          id: tempId,
          conversationId,
          content,
          senderToken: 'me',
          timestamp: Date.now(),
          isMine: true,
          displayName: sessionService.getMyProfile().displayName,
          status: 'sending',
          messageType: 'text',
          replyToId: replyTo?.id,
          replyToContent: replyTo?.content,
          replyToSender: replyTo?.sender,
        };
        
        setMessages(prev => [...prev, optimisticMessage]);
        
        // v23.0: Petit délai pour permettre à React de rendre le message avec 'sending'
        // avant de commencer l'envoi (sinon le rendu peut être batché et 'sending' invisible)
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const result = await sendMessage1to1(conversationId, content, replyTo);
        
        if (!result.success) {
          // Supprimer le message optimiste (peut être tempId ou messageId si déjà remplacé)
          setMessages(prev => prev.filter(m => 
            m.id !== tempId && m.id !== result.messageId
          ));
          setError(result.error || 'Échec de l\'envoi');
          return false;
        }
        
        // v23.0: Le message peut avoir été remplacé par subscribe1to1 pendant l'envoi
        // Il faut chercher par tempId OU par messageId OU par contenu
        setMessages(prev => prev.map(m => {
          // Si c'est le message temporaire
          if (m.id === tempId) {
            return { ...m, id: result.messageId || tempId, status: 'sent' };
          }
          // Si c'est déjà le vrai messageId (remplacé par subscribe1to1)
          if (m.id === result.messageId && m.isMine) {
            return { ...m, status: 'sent' };
          }
          return m;
        }));
        
        return true;
        
      }
      return false;
    } catch (e) {
      console.error('[useUnifiedMessages] Send error:', e);
      return false;
    } finally {
      setSending(false);
      pendingContentsRef.current.delete(content);
    }
  }, [conversationId, conversationType, sending]);

  // ==========================================
  // SEND IMAGE
  // ==========================================
  
  const sendImage = React.useCallback(async (
    imageUri: string,
    thumbnailData?: string,
    width?: number,
    height?: number,
    caption?: string
  ): Promise<boolean> => {
    // v26.1: OPTIMISTIC SEND — le message apparaît immédiatement dans la conversation
    // avec l'image locale. L'upload/chiffrement/envoi se fait en arrière-plan.
    // Comme WhatsApp/Signal : le modal se ferme, l'image s'affiche avec un spinner.
    
    const tempId = `temp-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const myProfile = sessionService.getMyProfile();
    
    const optimisticMessage: UnifiedMessage = {
      id: tempId,
      conversationId,
      content: '[Image]',
      senderToken: 'me',
      timestamp: Date.now(),
      isMine: true,
      displayName: myProfile.displayName,
      status: 'sending',
      messageType: 'image',
      imageData: imageUri, // URI locale pour affichage immédiat
    };
    
    setMessages(prev => [...prev, optimisticMessage]);
    
    // Fire-and-forget : l'upload tourne en background
    (async () => {
      try {
        const result = await sendImageMessage1to1(conversationId, imageUri);
        
        if (result.success && result.localMessage) {
          const unified = message1to1ToUnified(result.localMessage, conversationId);
          // Remplacer le temp par le vrai message
          setMessages(prev => {
            // Vérifier si le vrai message n'a pas déjà été ajouté par subscribe1to1
            const alreadyExists = prev.some(m => m.id === unified.id && m.id !== tempId);
            if (alreadyExists) {
              // Supprimer le temp, le vrai est déjà là
              return prev.filter(m => m.id !== tempId);
            }
            return prev.map(m => m.id === tempId ? { ...unified, status: unified.status || 'sent' } : m);
          });
        } else {
          // Échec : marquer comme failed
          setMessages(prev => prev.map(m =>
            m.id === tempId ? { ...m, status: 'failed' as any } : m
          ));
        }
      } catch (e) {
        console.error('[useUnifiedMessages] Background image send error:', e);
        setMessages(prev => prev.map(m =>
          m.id === tempId ? { ...m, status: 'failed' as any } : m
        ));
      }
    })();
    
    return true; // Retour immédiat
  }, [conversationId]);

  // ==========================================
  // SEND FILE
  // ==========================================
  
  const sendFile = React.useCallback(async (
    fileUri: string,
    fileName: string,
    fileSize: number,
    mimeType: string
  ): Promise<boolean> => {
    // v26.1: OPTIMISTIC SEND — le message fichier apparaît immédiatement
    
    const tempId = `temp-file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const myProfile = sessionService.getMyProfile();
    
    const optimisticMessage: UnifiedMessage = {
      id: tempId,
      conversationId,
      content: `[Fichier: ${fileName}]`,
      senderToken: 'me',
      timestamp: Date.now(),
      isMine: true,
      displayName: myProfile.displayName,
      status: 'sending',
      messageType: 'file',
      fileName,
      fileSize,
      fileMimeType: mimeType,
    };
    
    setMessages(prev => [...prev, optimisticMessage]);
    
    // Fire-and-forget : l'upload tourne en background
    (async () => {
      try {
        const result = await sendFileMessage1to1(conversationId, fileUri, fileName, mimeType);
        
        if (result.success && result.localMessage) {
          const unified = message1to1ToUnified(result.localMessage, conversationId);
          setMessages(prev => {
            const alreadyExists = prev.some(m => m.id === unified.id && m.id !== tempId);
            if (alreadyExists) {
              return prev.filter(m => m.id !== tempId);
            }
            return prev.map(m => m.id === tempId ? { ...unified, status: unified.status || 'sent' } : m);
          });
        } else {
          setMessages(prev => prev.map(m =>
            m.id === tempId ? { ...m, status: 'failed' as any } : m
          ));
        }
      } catch (e) {
        console.error('[useUnifiedMessages] Background file send error:', e);
        setMessages(prev => prev.map(m =>
          m.id === tempId ? { ...m, status: 'failed' as any } : m
        ));
      }
    })();
    
    return true;
  }, [conversationId]);

  // ==========================================
  // SEND VOICE
  // ==========================================
  
  const sendVoice = React.useCallback(async (
    voiceUri: string,
    duration: number,
    waveform?: number[]
  ): Promise<boolean> => {
    if (sending) return false;
    setSending(true);
    
    try {
      const result = await sendVoiceMessage1to1(conversationId, voiceUri, duration);
      
      if (!result.success) {
        setError(result.error || 'Échec de l\'envoi du vocal');
        return false;
      }
      
      if (result.localMessage) {
        const unified = message1to1ToUnified(result.localMessage, conversationId);
        setMessages(prev => {
          if (prev.some(m => m.id === unified.id)) return prev;
          return [...prev, unified];
        });
      }
      
      return true;
      
    } catch (e) {
      console.error('[useUnifiedMessages] Send voice error:', e);
      setError('Erreur lors de l\'envoi du vocal');
      return false;
    } finally {
      setSending(false);
    }
  }, [conversationId, sending]);

  // ==========================================
  // TOGGLE REACTION
  // ==========================================
  
  const toggleReaction = React.useCallback(async (
    messageId: string,
    emoji: string
  ): Promise<boolean> => {
    try {
      const result = await sendReaction1to1(conversationId, messageId, emoji);
      
      if (result.success) {
        const myFingerprint = session?.myIdentityKeyFingerprint || '';
        const updatedReactions = await toggleReactionStorage(conversationId, messageId, emoji, myFingerprint);
        setReactions(updatedReactions);
      }
      
      return result.success;
    } catch (e) {
      console.error('[useUnifiedMessages] Reaction error:', e);
      return false;
    }
  }, [conversationId, session]);

  // ==========================================
  // MARK AS READ
  // ==========================================
  
  const markAsRead = React.useCallback(async (messageIds: string[]): Promise<boolean> => {
    if (messageIds.length === 0) return true;
    
    try {
      const result = await sendReadReceipt1to1(conversationId, messageIds);
      return result.success;
    } catch (e) {
      console.error('[useUnifiedMessages] Mark as read error:', e);
      return false;
    }
  }, [conversationId]);

  // ==========================================
  // REFRESH
  // ==========================================
  
  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const newMsgs = await fetchMessages1to1(conversationId);
      if (newMsgs.length > 0) {
        const unified = newMsgs.map(m => message1to1ToUnified(m, conversationId));
        setMessages(prev => mergeMessages(prev, unified));
      }
    } catch (e) {
      console.error('[useUnifiedMessages] Refresh error:', e);
    }
  }, [conversationId]);

  // ==========================================
  // DELETE MESSAGES
  // ==========================================
  
  const deleteMessages = React.useCallback(async (messageIds: string[]): Promise<boolean> => {
    try {
      setMessages(prev => prev.filter(m => !messageIds.includes(m.id)));
      return true;
    } catch (e) {
      console.error('[useUnifiedMessages] Delete error:', e);
      return false;
    }
  }, []);

  const deleteAllMessages = React.useCallback(async (): Promise<boolean> => {
    try {
      if (conversationType === '1to1') {
        await clearLocalMessages1to1(conversationId);
      }
      setMessages([]);
      return true;
    } catch (e) {
      console.error('[useUnifiedMessages] Delete all error:', e);
      return false;
    }
  }, [conversationId, conversationType]);

  // ==========================================
  // ADD MESSAGE
  // ==========================================
  
  const addMessage = React.useCallback((message: UnifiedMessage) => {
    setMessages(prev => {
      if (prev.some(m => m.id === message.id)) {
        return prev;
      }
      return mergeMessages(prev, [message]);
    });
  }, []);

  // ==========================================
  // UPDATE MESSAGE (v26.0: après download blob)
  // ==========================================
  
  const updateMessage = React.useCallback((messageId: string, updates: Partial<UnifiedMessage>) => {
    setMessages(prev => prev.map(m => 
      m.id === messageId ? { ...m, ...updates } : m
    ));
  }, []);

  // ==========================================
  // P7 FIX: RETRY / DELETE FAILED MESSAGES
  // ==========================================
  
  const retryMessage = React.useCallback(async (messageId: string): Promise<boolean> => {
    try {
      // Mettre à jour l'UI immédiatement (optimiste)
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, status: 'sending' as any } : m
      ));
      
      const result = await retryFailedMessage1to1(conversationId, messageId);
      
      if (result.success) {
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, status: 'sent' as any } : m
        ));
        return true;
      } else {
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, status: 'failed' as any } : m
        ));
        setError(result.error || 'Échec du renvoi');
        return false;
      }
    } catch (e) {
      console.error('[useUnifiedMessages] Retry error:', e);
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, status: 'failed' as any } : m
      ));
      return false;
    }
  }, [conversationId]);
  
  const deleteFailedMessage = React.useCallback(async (messageId: string): Promise<boolean> => {
    try {
      const result = await deleteFailedMessage1to1(conversationId, messageId);
      if (result) {
        setMessages(prev => prev.filter(m => m.id !== messageId));
      }
      return result;
    } catch (e) {
      console.error('[useUnifiedMessages] Delete failed message error:', e);
      return false;
    }
  }, [conversationId]);

  // Accept/decline are no-ops for 1:1

  // ==========================================
  // MESSAGES AVEC RÉACTIONS (1:1 ET GROUPES)
  // ==========================================
  
  const messagesWithReactions: UnifiedMessage[] = React.useMemo(() => {
    // v21.0: Fusionner et convertir les réactions au format attendu par l'UI
    // Format attendu: { emoji: string; count: number; userReacted: boolean }[]
    const myFingerprint = session?.myIdentityKeyFingerprint || sessionService.getMyShortFingerprint();
    
    return messages.map(msg => {
      const rawReactions = reactions.get(msg.id) || [];
      
      if (rawReactions.length === 0) {
        return { ...msg, reactions: [] };
      }
      
      // Grouper par emoji et compter
      const reactionMap = new Map<string, { count: number; userReacted: boolean }>();
      
      for (const r of rawReactions) {
        const existing = reactionMap.get(r.emoji) || { count: 0, userReacted: false };
        existing.count++;
        if (r.senderFingerprint === myFingerprint) {
          existing.userReacted = true;
        }
        reactionMap.set(r.emoji, existing);
      }
      
      // Convertir en tableau
      const convertedReactions = Array.from(reactionMap.entries()).map(([emoji, data]) => ({
        emoji,
        count: data.count,
        userReacted: data.userReacted,
      }));
      
      return { ...msg, reactions: convertedReactions };
    });
  }, [messages, reactions, session]);

  // ==========================================
  // CONVERSATION INFO
  // ==========================================
  
  const conversationInfo: ConversationInfo = React.useMemo(() => {
    if (session) {
      return {
        type: '1to1' as const,
        id: conversationId,
        name: session.theirProfile.displayName || 'Contact',
        avatarBase64: session.theirProfile.avatarBase64,
        session,
        contactFingerprint: session.theirIdentityKeyFingerprint,
        myFingerprint: session.myIdentityKeyFingerprint,
        isSecure: true,
        protocol: 'Triple Ratchet + ML-KEM-768 (Post-Quantum)',
      };
    }
    
    return {
      type: '1to1' as const,
      id: conversationId,
      name: 'Chargement...',
      isSecure: false,
      protocol: 'Initialisation...',
    };
  }, [conversationId, session]);

  // ==========================================
  // RETURN
  // ==========================================
  
  return {
    messages: messagesWithReactions,
    loading,
    sending,
    error,
    sendMessage,
    sendImage,
    sendFile,
    sendVoice,
    toggleReaction,
    markAsRead,
    refresh,
    deleteMessages,
    deleteAllMessages,
    addMessage,
    updateMessage,
    retryMessage,
    deleteFailedMessage,
    conversationInfo,
  };
}

// ============================================
// HELPERS
// ============================================

function mergeMessages(existing: UnifiedMessage[], incoming: UnifiedMessage[]): UnifiedMessage[] {
  // Utiliser une Map pour garantir l'unicité par ID
  const messageMap = new Map<string, UnifiedMessage>();
  
  // Ajouter les messages existants
  for (const msg of existing) {
    messageMap.set(msg.id, msg);
  }
  
  // Ajouter/mettre à jour avec les nouveaux messages
  for (const msg of incoming) {
    // Si le message existe déjà, garder celui avec le statut le plus avancé
    const existingMsg = messageMap.get(msg.id);
    if (existingMsg) {
      // Mettre à jour le statut si le nouveau est plus avancé
      const statusOrder = { 'sending': 0, 'sent': 1, 'delivered': 2, 'read': 3 };
      const existingOrder = statusOrder[existingMsg.status as keyof typeof statusOrder] ?? 0;
      const newOrder = statusOrder[msg.status as keyof typeof statusOrder] ?? 0;
      if (newOrder > existingOrder) {
        messageMap.set(msg.id, { ...existingMsg, status: msg.status });
      }
    } else {
      messageMap.set(msg.id, msg);
    }
  }
  
  // Convertir en tableau et trier par timestamp
  const result = Array.from(messageMap.values());
  result.sort((a, b) => a.timestamp - b.timestamp);
  
  return result;
}