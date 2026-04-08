// src/screens/ConversationListScreen.tsx
// Liste des conversations - Design moderne avec header premium
// Liste des conversations 1-à-1
// v16.0 - Design unifié avec dernier message, statut et heure

import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Animated,
  Platform,
  Image,
  Easing,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { sessionService, StoredSession } from '../services/tripleRatchet';
import { pendingInviteStore, PendingInvite } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { showInAppNotification } from '../components/InAppNotification';
import { subscribeToAllMessages1to1, getAllUnreadCounts, pollAllSessions, getLocalMessages1to1, clearLocalMessages1to1, clearUnreadCount } from '../services/api1to1';
import { getDeviceId } from '../services/storage';
import { isInCall1to1 } from '../services/call1to1Service';
import {
  theme,
  ActionSheet,
  AlertModal,
} from '../components/ui';
import { getAvatarColor } from '../components/ui/theme';
import { CallIndicator } from '../components/CallIndicator';
import { startHeartbeatService, hasActiveCall } from '../services/callHeartbeat';
import { formatCallDuration } from '../services/callMessages';
import { generateAvatarInitials } from '../services/crypto';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  Create1to1: undefined;
  Join1to1: undefined;
  Invitations: undefined;
  InviteDetail: { tag: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string; contactAvatarBase64?: string };
  Settings: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'ConversationList'>;

// Icône Settings en SVG
const SettingsIcon = () => (
  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"
      stroke={theme.colors.text}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M19.4 15C19.2669 15.3016 19.2272 15.6362 19.286 15.9606C19.3448 16.285 19.4995 16.5843 19.73 16.82L19.79 16.88C19.976 17.0657 20.1235 17.2863 20.2241 17.5291C20.3248 17.7719 20.3766 18.0322 20.3766 18.295C20.3766 18.5578 20.3248 18.8181 20.2241 19.0609C20.1235 19.3037 19.976 19.5243 19.79 19.71C19.6043 19.896 19.3837 20.0435 19.1409 20.1441C18.8981 20.2448 18.6378 20.2966 18.375 20.2966C18.1122 20.2966 17.8519 20.2448 17.6091 20.1441C17.3663 20.0435 17.1457 19.896 16.96 19.71L16.9 19.65C16.6643 19.4195 16.365 19.2648 16.0406 19.206C15.7162 19.1472 15.3816 19.1869 15.08 19.32C14.7842 19.4468 14.532 19.6572 14.3543 19.9255C14.1766 20.1938 14.0813 20.5082 14.08 20.83V21C14.08 21.5304 13.8693 22.0391 13.4942 22.4142C13.1191 22.7893 12.6104 23 12.08 23C11.5496 23 11.0409 22.7893 10.6658 22.4142C10.2907 22.0391 10.08 21.5304 10.08 21V20.91C10.0723 20.579 9.96512 20.258 9.77251 19.9887C9.5799 19.7194 9.31074 19.5143 9 19.4C8.69838 19.2669 8.36381 19.2272 8.03941 19.286C7.71502 19.3448 7.41568 19.4995 7.18 19.73L7.12 19.79C6.93425 19.976 6.71368 20.1235 6.47088 20.2241C6.22808 20.3248 5.96783 20.3766 5.705 20.3766C5.44217 20.3766 5.18192 20.3248 4.93912 20.2241C4.69632 20.1235 4.47575 19.976 4.29 19.79C4.10405 19.6043 3.95653 19.3837 3.85588 19.1409C3.75523 18.8981 3.70343 18.6378 3.70343 18.375C3.70343 18.1122 3.75523 17.8519 3.85588 17.6091C3.95653 17.3663 4.10405 17.1457 4.29 16.96L4.35 16.9C4.58054 16.6643 4.73519 16.365 4.794 16.0406C4.85282 15.7162 4.81312 15.3816 4.68 15.08C4.55324 14.7842 4.34276 14.532 4.07447 14.3543C3.80618 14.1766 3.49179 14.0813 3.17 14.08H3C2.46957 14.08 1.96086 13.8693 1.58579 13.4942C1.21071 13.1191 1 12.6104 1 12.08C1 11.5496 1.21071 11.0409 1.58579 10.6658C1.96086 10.2907 2.46957 10.08 3 10.08H3.09C3.42099 10.0723 3.742 9.96512 4.0113 9.77251C4.28059 9.5799 4.48572 9.31074 4.6 9C4.73312 8.69838 4.77282 8.36381 4.714 8.03941C4.65519 7.71502 4.50054 7.41568 4.27 7.18L4.21 7.12C4.02405 6.93425 3.87653 6.71368 3.77588 6.47088C3.67523 6.22808 3.62343 5.96783 3.62343 5.705C3.62343 5.44217 3.67523 5.18192 3.77588 4.93912C3.87653 4.69632 4.02405 4.47575 4.21 4.29C4.39575 4.10405 4.61632 3.95653 4.85912 3.85588C5.10192 3.75523 5.36217 3.70343 5.625 3.70343C5.88783 3.70343 6.14808 3.75523 6.39088 3.85588C6.63368 3.95653 6.85425 4.10405 7.04 4.29L7.1 4.35C7.33568 4.58054 7.63502 4.73519 7.95941 4.794C8.28381 4.85282 8.61838 4.81312 8.92 4.68H9C9.29577 4.55324 9.54802 4.34276 9.72569 4.07447C9.90337 3.80618 9.99872 3.49179 10 3.17V3C10 2.46957 10.2107 1.96086 10.5858 1.58579C10.9609 1.21071 11.4696 1 12 1C12.5304 1 13.0391 1.21071 13.4142 1.58579C13.7893 1.96086 14 2.46957 14 3V3.09C14.0013 3.41179 14.0966 3.72618 14.2743 3.99447C14.452 4.26276 14.7042 4.47324 15 4.6C15.3016 4.73312 15.6362 4.77282 15.9606 4.714C16.285 4.65519 16.5843 4.50054 16.82 4.27L16.88 4.21C17.0657 4.02405 17.2863 3.87653 17.5291 3.77588C17.7719 3.67523 18.0322 3.62343 18.295 3.62343C18.5578 3.62343 18.8181 3.67523 19.0609 3.77588C19.3037 3.87653 19.5243 4.02405 19.71 4.21C19.896 4.39575 20.0435 4.61632 20.1441 4.85912C20.2448 5.10192 20.2966 5.36217 20.2966 5.625C20.2966 5.88783 20.2448 6.14808 20.1441 6.39088C20.0435 6.63368 19.896 6.85425 19.71 7.04L19.65 7.1C19.4195 7.33568 19.2648 7.63502 19.206 7.95941C19.1472 8.28381 19.1869 8.61838 19.32 8.92V9C19.4468 9.29577 19.6572 9.54802 19.9255 9.72569C20.1938 9.90337 20.5082 9.99872 20.83 10H21C21.5304 10 22.0391 10.2107 22.4142 10.5858C22.7893 10.9609 23 11.4696 23 12C23 12.5304 22.7893 13.0391 22.4142 13.4142C22.0391 13.7893 21.5304 14 21 14H20.91C20.5882 14.0013 20.2738 14.0966 20.0055 14.2743C19.7372 14.452 19.5268 14.7042 19.4 15Z"
      stroke={theme.colors.text}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

// Type pour les conversations avec dernier message
interface LastMessageInfo {
  content: string;
  timestamp: number;
  isMine: boolean;
  status?: 'sent' | 'delivered' | 'read';
  type?: 'text' | 'image' | 'file' | 'voice' | 'call';
}

interface ConversationItem {
  id: string;
  name: string;
  lastMessageAt?: number;
  createdAt: number;
  unreadCount: number;
  theirFingerprint?: string;
  avatarBase64?: string;
  lastMessage?: LastMessageInfo;
}

// ============================================
// PERF: Fonctions et composants purs extraits au niveau module.
// Définis à l'intérieur du composant, ils étaient recréés à chaque render,
// ce qui forçait FlatList à re-rendre TOUTES les lignes à chaque changement
// d'état (ex: ouverture du menu FAB → re-render de 10+ lignes).
// ============================================

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60000) return 'À l\'instant';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return date.toLocaleDateString('fr-FR', { weekday: 'short' });
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

const MessageStatusIcon = React.memo(({ status }: { status?: string }) => {
  switch (status) {
    case 'read':
      return (
        <View style={_statusStyles.icon}>
          <Ionicons name="checkmark-done" size={16} color="#53BDEB" />
        </View>
      );
    case 'delivered':
      return (
        <View style={_statusStyles.icon}>
          <Ionicons name="checkmark-done" size={16} color={theme.colors.textMuted} />
        </View>
      );
    case 'sent':
    case 'sending':
    default:
      return (
        <View style={_statusStyles.icon}>
          <Ionicons name="checkmark" size={16} color={theme.colors.textMuted} />
        </View>
      );
  }
});

const _statusStyles = StyleSheet.create({
  icon: { marginRight: 4, marginTop: 1 },
});

const _keyExtractor = (item: ConversationItem) => item.id;

export function ConversationListScreen() {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<ConversationItem | null>(null);
  
  const fabRotation = useRef(new Animated.Value(0)).current;
  const logoFloat = useRef(new Animated.Value(0)).current;
  const emptyLogoFloat = useRef(new Animated.Value(0)).current;
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);


  // Animation du logo header
  useEffect(() => {
    const floatAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(logoFloat, {
          toValue: -4,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(logoFloat, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    floatAnimation.start();
    return () => floatAnimation.stop();
  }, []);

  // Animation du logo empty state
  useEffect(() => {
    const floatAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(emptyLogoFloat, {
          toValue: -4,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(emptyLogoFloat, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    floatAnimation.start();
    return () => floatAnimation.stop();
  }, []);

  // Tracking des invitations en attente
  useEffect(() => {
    const refresh = async () => {
      await pendingInviteStore.load();
      setPendingInvites(pendingInviteStore.getPending());
    };
    refresh();
    const unsub = pendingInviteStore.onChange(refresh);
    return () => unsub();
  }, []);

  // PERF A6: Cache du dernier message par session.
  // Au lieu de charger TOUS les messages de TOUTES les sessions (O(n×m)) à chaque refresh,
  // on maintient un cache qui est rempli une seule fois puis mis à jour incrémentalement
  // par subscribeToAllMessages1to1. loadConversations passe de O(n×m) à O(n).
  const lastMessageCacheRef = useRef<Map<string, LastMessageInfo>>(new Map());
  const cacheFilledRef = useRef(false);

  // Helper: convertit un message brut en LastMessageInfo pour le cache/affichage
  const messageToLastInfo = useCallback((msg: any): LastMessageInfo => {
    let msgType: 'text' | 'image' | 'file' | 'voice' | 'call' = 'text';
    let content = msg.content || '';

    if (msg.messageType === 'image' || msg.imageData) {
      msgType = 'image';
      content = '📷 Photo';
    } else if (msg.messageType === 'file' || msg.fileData) {
      msgType = 'file';
      content = '📎 ' + (msg.fileName || 'Fichier');
    } else if (msg.messageType === 'voice' || msg.voiceData) {
      msgType = 'voice';
      content = '🎤 Message vocal';
    } else {
      // Tenter de parser comme message d'appel
      const trimmed = (msg.content || '').trim();
      if (trimmed.startsWith('{') && trimmed.includes('type')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'call') {
            msgType = 'call';
            if (parsed.status === 'ended' && parsed.duration > 0) {
              content = `📞 Appel vocal (${formatCallDuration(parsed.duration)})`;
            } else if (parsed.status === 'missed') {
              content = '📞 Appel manqué';
            } else if (parsed.status === 'declined') {
              content = '📞 Appel refusé';
            } else if (parsed.status === 'cancelled') {
              content = '📞 Appel annulé';
            } else {
              content = '📞 Appel vocal';
            }
          }
        } catch {
          // Fallback regex pour les JSON malformés
          if (trimmed.includes('call')) {
            const statusMatch = trimmed.match(/status\s*[":]\s*["']?(\w+)["']?/i);
            const status = statusMatch ? statusMatch[1].toLowerCase() : '';
            if (status === 'missed') { msgType = 'call'; content = '📞 Appel manqué'; }
            else if (status === 'declined') { msgType = 'call'; content = '📞 Appel refusé'; }
            else if (status === 'cancelled') { msgType = 'call'; content = '📞 Appel annulé'; }
            else if (status === 'ended') {
              msgType = 'call';
              const durMatch = trimmed.match(/duration\s*[":]\s*(\d+)/i);
              content = durMatch && parseInt(durMatch[1]) > 0
                ? `📞 Appel vocal (${formatCallDuration(parseInt(durMatch[1]))})`
                : '📞 Appel vocal';
            }
          }
        }
      }
    }

    return {
      content,
      timestamp: msg.timestamp,
      isMine: msg.isMine,
      status: msg.status as 'sent' | 'delivered' | 'read' | undefined,
      type: msgType,
    };
  }, []);

  // v16.0: Charger les conversations avec le dernier message
  const loadConversations = useCallback(async () => {
    try {
      await sessionService.initialize();
      const sessions = sessionService.getAllSessions();
      
      // v6.1: Charger les compteurs de messages non lus
      const unreadCounts = await getAllUnreadCounts();
      
      // PERF A6: Utiliser le cache du dernier message quand il est rempli.
      // Premier appel (cacheFilledRef.current === false) :
      //   → Charger les messages de chaque session depuis AsyncStorage (O(n×m))
      //   → Remplir le cache
      // Appels suivants (cacheFilledRef.current === true) :
      //   → Utiliser directement le cache (O(n))
      //   → Le cache est mis à jour incrémentalement par subscribeToAllMessages1to1
      const needsFullLoad = !cacheFilledRef.current;
      
      const convsPromises = sessions.map(async (session) => {
        let lastMessage: LastMessageInfo | undefined;
        
        if (needsFullLoad) {
          // Premier chargement : lire depuis le stockage et remplir le cache
          try {
            const messages = await getLocalMessages1to1(session.id);
            if (messages.length > 0) {
              const sorted = messages.sort((a, b) => b.timestamp - a.timestamp);
              lastMessage = messageToLastInfo(sorted[0]);
              lastMessageCacheRef.current.set(session.id, lastMessage);
            }
          } catch (e) {
            // Ignorer les erreurs de chargement de messages
          }
        } else {
          // Appels suivants : utiliser le cache (instantané)
          lastMessage = lastMessageCacheRef.current.get(session.id);
        }
        
        return {
          id: session.id,
          name: session.theirProfile.displayName || 'Contact',
          lastMessageAt: session.lastActivityAt,
          createdAt: session.createdAt,
          unreadCount: unreadCounts.get(session.id) || 0,
          theirFingerprint: session.theirIdentityKeyFingerprint,
          avatarBase64: session.theirProfile.avatarBase64,
          lastMessage,
        };
      });
      
      const convs = await Promise.all(convsPromises);
      convs.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
      setConversations(convs);
      
      if (needsFullLoad) {
        cacheFilledRef.current = true;
      }
      
      return convs;
    } catch (error) {
      console.error('[ConversationList] Error loading:', error);
      return [];
    }
  }, [messageToLastInfo]);

  // S'assurer que l'inviteWatcher tourne et réagir aux acceptations
  useEffect(() => {
    inviteWatcher.ensureRunning();

    const unsub = inviteWatcher.onAccepted((session, invite) => {
      console.log(`[ConversationList] 🎉 Invite accepted: ${invite.label} → ${session.theirProfile.displayName}`);
      loadConversations();
      
      // Naviguer vers l'écran de célébration (pas de notification toast)
      const contactName = session.theirProfile.displayName || 'Contact';
      navigation.navigate('ConnectionSuccess', {
        sessionId: session.id,
        contactName,
        inviteLabel: invite.label,
        inviteTag: invite.tag,
        contactAvatarBase64: session.theirProfile.avatarBase64,
      });
    });
    return () => unsub();
  }, [loadConversations, navigation]);


  useFocusEffect(
    useCallback(() => {
      // S'assurer que l'inviteWatcher tourne à chaque focus
      inviteWatcher.ensureRunning();
      inviteWatcher.forcePoll();

      // PERF A5: Un seul poll au focus, pas de setInterval.
      // Le polling continu est déjà assuré par constantTraffic.ts (5s via OHTTP).
      // Le rafraîchissement de la liste est déclenché par subscribeToAllMessages1to1
      // (useEffect ligne ~377) qui appelle loadConversations() à chaque nouveau message.
      // L'ancien setInterval(3000) doublait les requêtes OHTTP → supprimé.
      const initAndLoad = async () => {
        try {
          await pollAllSessions();
          await loadConversations();
        } catch (error) {
          console.error('[ConversationList] Init/Poll error:', error);
          loadConversations();
        }
      };
      
      initAndLoad();
      
      return () => {
        // PERF A6 FIX: Invalider le cache quand l'écran perd le focus.
        // Quand l'utilisateur navigue vers ConversationScreen et envoie un message,
        // ce message est sauvegardé localement via saveLocalMessage1to1 mais ne passe
        // PAS par subscribeToAllMessages1to1 (qui ne notifie que les messages du poll
        // serveur). Sans cette invalidation, le cache conserverait l'ancien dernier
        // message et le message envoyé n'apparaîtrait pas au retour.
        //
        // Le cache reste utile pour les rafraîchissements rapides déclenchés par
        // les messages entrants pendant que l'écran EST visible (subscribe callback
        // met à jour le cache → loadConversations utilise le cache = instantané).
        cacheFilledRef.current = false;
      };
    }, [loadConversations])
  );

  useEffect(() => {
    startHeartbeatService().catch(console.error);
  }, []);

  // S'abonner aux nouveaux messages pour rafraîchir la liste + notification in-app
  useEffect(() => {
    // Types de messages invisibles (ne pas notifier)
    const SILENT_TYPES = new Set(['read_receipt', 'delivered_receipt', 'typing', 'call_signal', 'handshake_ack', 'reaction']);
    
    const unsubscribe = subscribeToAllMessages1to1((sessionId, message) => {
      // PERF A6: Mettre à jour le cache du dernier message AVANT de rafraîchir la liste.
      // Cela évite que loadConversations recharge tous les messages depuis AsyncStorage.
      // Le cache est mis à jour si ce message est plus récent que l'entrée actuelle.
      if (!SILENT_TYPES.has(message.messageType as string)) {
        const cached = lastMessageCacheRef.current.get(sessionId);
        if (!cached || message.timestamp >= cached.timestamp) {
          lastMessageCacheRef.current.set(sessionId, messageToLastInfo(message));
        }
      }
      
      loadConversations();
      
      // Notification in-app pour les messages entrants visibles uniquement
      if (message.isMine) return;
      if (message.messageType && SILENT_TYPES.has(message.messageType)) return;
      
      const contactName = message.displayName || 'Contact';
      
      // Preview selon le type de message
      let body: string;
      switch (message.messageType) {
        case 'image':
          body = '📷 Photo';
          break;
        case 'voice':
          body = '🎤 Message vocal';
          break;
        case 'file':
          body = `📎 ${message.fileName || 'Fichier'}`;
          break;
        case 'call':
          body = '📞 Appel terminé';
          break;
        default:
          body = message.content?.length > 80
            ? message.content.substring(0, 80) + '…'
            : (message.content || '');
          break;
      }
      
      if (!body) return;
      
      // Avatar color hash (même algo que les invitations)
      const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#A78BFA','#F7DC6F','#DDA0DD','#FF8C42','#6BCB77','#4D96FF'];
      let h = 0;
      for (let i = 0; i < contactName.length; i++) h = contactName.charCodeAt(i) + ((h << 5) - h);
      
      showInAppNotification({
        id: `msg_${message.id}`,
        title: contactName,
        body,
        avatarInitial: generateAvatarInitials(contactName),
        avatarColor: colors[Math.abs(h) % colors.length],
        avatarUri: message.senderAvatarBase64 || sessionService.getSession(sessionId)?.theirProfile?.avatarBase64 || undefined,
        playSound: true,
        duration: 4000,
        onPress: () => {
          navigation.navigate('Conversation', {
            conversationId: sessionId,
            conversationName: contactName,
          });
        },
      });
    });
    
    return () => {
      unsubscribe();
    };
  }, [loadConversations, messageToLastInfo, navigation]);

  useEffect(() => {
    Animated.spring(fabRotation, {
      toValue: showNewMenu ? 1 : 0,
      useNativeDriver: true,
      tension: 200,
      friction: 12,
    }).start();
  }, [showNewMenu]);

  const handleRefresh = async () => {
    setRefreshing(true);
    // PERF A6: Invalider le cache pour forcer un rechargement complet depuis AsyncStorage.
    // Le pull-to-refresh est le seul moyen pour l'utilisateur de demander un refresh total.
    cacheFilledRef.current = false;
    lastMessageCacheRef.current.clear();
    await loadConversations();
    setRefreshing(false);
  };

  const handleConversationPress = useCallback((conv: ConversationItem) => {
    navigation.navigate('Conversation', {
      conversationId: conv.id,
      conversationName: conv.name,
    });
  }, [navigation]);

  const handleConversationLongPress = useCallback((conv: ConversationItem) => {
    setConversationToDelete(conv);
    setShowDeleteConfirm(true);
  }, []);


  const handleDelete = async () => {
    if (conversationToDelete) {
      // BUG FIX #5: Bloquer la suppression si un appel est en cours avec ce contact
      if (isInCall1to1()) {
        Alert.alert('Appel en cours', 'Terminez l\'appel avant de supprimer la conversation.');
        setShowDeleteConfirm(false);
        return;
      }
      // BUG FIX #1: Nettoyer TOUTES les données de transport AVANT de supprimer la session
      // Sans cela, les processedIds/messages/statuts orphelins persistent et polluent
      // une éventuelle reconnexion (même sessionId déterministe).
      await clearLocalMessages1to1(conversationToDelete.id);
      await clearUnreadCount(conversationToDelete.id);
      try { await AsyncStorage.removeItem(`@ghostr_reactions_${conversationToDelete.id}`); } catch {}
      // PERF A6: Nettoyer le cache du dernier message pour cette session
      lastMessageCacheRef.current.delete(conversationToDelete.id);
      await sessionService.deleteSession(conversationToDelete.id);
      await loadConversations();
      setShowDeleteConfirm(false);
      setConversationToDelete(null);
    }
  };

  // Le bandeau "X invitations en attente" fait disparaître l'état vide
  const pendingCount = pendingInvites.length;
  const hasAnyContent = conversations.length > 0 || pendingCount > 0;

  // v16.0: Rendu unifié des conversations 1:1
  // PERF: useCallback empêche la FlatList de re-rendre toutes les lignes
  // quand un état non lié change (ex: showNewMenu, showDeleteConfirm).
  const renderConversation = useCallback(({ item }: { item: ConversationItem }) => {
    const hasUnread = item.unreadCount > 0;
    
    // Formater l'aperçu du dernier message avec "Vous:" si c'est le mien
    const getMessagePreview = () => {
      if (!item.lastMessage) return 'Nouvelle conversation';
      
      // v19.1: Ne pas préfixer "Vous:" pour les messages d'appel
      if (item.lastMessage.type === 'call') {
        return item.lastMessage.content;
      }
      
      const prefix = item.lastMessage.isMine ? 'Vous: ' : '';
      return prefix + item.lastMessage.content;
    };
    
    return (
      <TouchableOpacity
        style={styles.conversationItem}
        onPress={() => handleConversationPress(item)}
        onLongPress={() => handleConversationLongPress(item)}
        activeOpacity={0.7}
      >
        {/* Avatar rond */}
        <View style={styles.avatarContainer}>
          <View style={[styles.avatar, styles.avatarRound, !item.avatarBase64 && { backgroundColor: getAvatarColor(item.id) }]}>
            {item.avatarBase64 ? (
              <Image 
                source={{ uri: item.avatarBase64 }} 
                style={[styles.avatarImage, styles.avatarImageRound]}
              />
            ) : (
              <Text style={styles.avatarText}>
                {generateAvatarInitials(item.name)}
              </Text>
            )}
          </View>
          <CallIndicator 
            conversationId={item.id} 
            size="medium"
            showParticipantCount={true}
          />
        </View>
        
        {/* Info */}
        <View style={styles.conversationInfo}>
          {/* Ligne 1: Nom + Heure */}
          <View style={styles.conversationHeader}>
            <Text style={[
              styles.conversationName,
              hasUnread && styles.conversationNameUnread
            ]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.timestamp, hasUnread && styles.timestampUnread]}>
              {formatTime(item.lastMessageAt || item.createdAt)}
            </Text>
          </View>
          
          {/* Ligne 2: Message + Status/Badge */}
          <View style={styles.conversationFooter}>
            <View style={styles.messagePreviewContainer}>
              {/* v19.1: Icône de statut pour mes messages (sauf appels) */}
              {item.lastMessage?.isMine && item.lastMessage?.type !== 'call' && (
                <MessageStatusIcon status={item.lastMessage.status} />
              )}
              <Text 
                style={[
                  styles.messagePreview,
                  hasUnread && styles.messagePreviewUnread
                ]} 
                numberOfLines={1}
              >
                {getMessagePreview()}
              </Text>
            </View>
            
            {hasUnread && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>
                  {item.unreadCount > 99 ? '99+' : item.unreadCount}
                </Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [handleConversationPress, handleConversationLongPress]);

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconWrapper}>
        <Animated.View style={{ transform: [{ translateY: emptyLogoFloat }] }}>
          <Image 
            source={require('../../assets/icon_nobg.png')} 
            style={styles.emptyLogo}
          />
        </Animated.View>
      </View>
      <Text style={styles.emptyTitle}>Bienvenue sur Ghostr</Text>
      <Text style={styles.emptySubtitle}>
        Créez une invitation ou rejoignez{'\n'}un contact pour commencer
      </Text>
      
      <View style={styles.emptyActions}>
        <TouchableOpacity 
          style={styles.emptyButtonPrimary}
          onPress={() => navigation.navigate('Create1to1')}
          activeOpacity={0.8}
        >
          <Ionicons name="add-circle-outline" size={20} color={theme.colors.textOnPrimary} />
          <Text style={styles.emptyButtonTextPrimary}>Créer</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={styles.emptyButtonSecondary}
          onPress={() => navigation.navigate('Join1to1')}
          activeOpacity={0.8}
        >
          <Ionicons name="scan-outline" size={20} color={theme.colors.text} />
          <Text style={styles.emptyButtonTextSecondary}>Rejoindre</Text>
        </TouchableOpacity>
      </View>


    </View>
  );



  const fabRotateInterpolate = fabRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '45deg'],
  });

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerContent}>
          <View style={styles.brandContainer}>
            <Animated.View style={[styles.logoContainer, { transform: [{ translateY: logoFloat }] }]}>
              <Image source={require('../../assets/icon_nobg.png')} style={styles.logo} />
            </Animated.View>
            
            <View style={styles.titleContainer}>
              <Text style={styles.title}>Ghostr</Text>

            </View>
          </View>
          
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => navigation.navigate('Settings')}
            activeOpacity={0.7}
          >
            <SettingsIcon />
          </TouchableOpacity>
        </View>
        
        <View style={styles.headerDivider}>
          <View style={styles.headerDividerGradient} />
        </View>

      </View>

      {/* Liste des conversations */}
      <FlatList
        data={conversations}
        renderItem={renderConversation}
        keyExtractor={_keyExtractor}
        removeClippedSubviews={true}
        maxToRenderPerBatch={10}
        windowSize={7}
        contentContainerStyle={!hasAnyContent ? styles.emptyListContent : styles.listContent}
        ListEmptyComponent={hasAnyContent ? null : renderEmptyState}
        ListHeaderComponent={pendingCount > 0 ? (
          <TouchableOpacity
            style={styles.pendingBanner}
            onPress={() => navigation.navigate('Invitations')}
            activeOpacity={0.7}
          >
            <View style={styles.pendingBannerIcon}>
              <Ionicons name="qr-code-outline" size={20} color={theme.colors.warning} />
            </View>
            <View style={styles.pendingBannerContent}>
              <Text style={styles.pendingBannerTitle}>
                {pendingCount} invitation{pendingCount > 1 ? 's' : ''} en attente
              </Text>
              <Text style={styles.pendingBannerSub}>Appuyez pour gérer</Text>
            </View>
            <View style={styles.pendingBannerRight}>
              <View style={styles.pendingBannerDot} />
              <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
            </View>
          </TouchableOpacity>
        ) : null}
        ListFooterComponent={conversations.length === 0 && pendingCount > 0 ? (
          <View style={styles.pendingHint}>
            <Text style={styles.pendingHintText}>
              Vos conversations apparaîtront ici dès qu'un contact aura scanné une invitation.
            </Text>
          </View>
        ) : null}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      />

      {/* FAB */}
      {hasAnyContent && (
        <Animated.View 
          style={[
            styles.fab, 
            { 
              bottom: insets.bottom + 20,
              transform: [{ rotate: fabRotateInterpolate }],
            }
          ]}
        >
          <TouchableOpacity
            style={styles.fabTouchable}
            onPress={() => setShowNewMenu(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="chatbubble-ellipses" size={24} color={theme.colors.textOnPrimary} />
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Menu */}
      <ActionSheet
        visible={showNewMenu}
        onClose={() => setShowNewMenu(false)}
        items={[
          {
            title: 'Créer une invitation',
            subtitle: 'Générez un QR code ou lien à partager',
            icon: <Ionicons name="add-circle-outline" size={24} color={theme.colors.primary} />,
            onPress: () => {
              setShowNewMenu(false);
              navigation.navigate('Create1to1');
            },
          },
          {
            title: 'Rejoindre une conversation',
            subtitle: 'Scannez un QR code ou collez un lien',
            icon: <Ionicons name="scan-outline" size={24} color={theme.colors.primary} />,
            onPress: () => {
              setShowNewMenu(false);
              navigation.navigate('Join1to1');
            },
          },
        ]}
      />

      {/* Modal suppression */}
      <AlertModal
        visible={showDeleteConfirm}
        title="Supprimer la conversation"
        message={`Voulez-vous vraiment supprimer "${conversationToDelete?.name}" ? Cette action est irréversible.`}
        secondaryButton={{
          title: 'Annuler',
          onPress: () => {
            setShowDeleteConfirm(false);
            setConversationToDelete(null);
          },
        }}
        primaryButton={{
          title: 'Supprimer',
          variant: 'danger',
          onPress: handleDelete,
        }}
        onClose={() => {
          setShowDeleteConfirm(false);
          setConversationToDelete(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    backgroundColor: theme.colors.background,
    paddingHorizontal: 20,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  logoContainer: {
    marginRight: 12,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 10,
    resizeMode: 'contain',
  },
  titleContainer: {
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: theme.colors.text,
    letterSpacing: -0.5,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
  },
  subtitleDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: theme.colors.primary,
    marginRight: 6,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    letterSpacing: 0.1,
  },
  settingsButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerDivider: {
    height: StyleSheet.hairlineWidth,
    marginTop: 12,
  },
  headerDividerGradient: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.divider,
  },
  listContent: {
    paddingTop: 8,
  },
  
  // Pending invites banner
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 4,
    padding: 12,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  pendingBannerIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255, 181, 71, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  pendingBannerContent: {
    flex: 1,
  },
  pendingBannerTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.text,
  },
  pendingBannerSub: {
    fontSize: 13,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  pendingBannerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pendingBannerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.warning,
  },
  pendingHint: {
    paddingHorizontal: 36,
    paddingVertical: 40,
    alignItems: 'center',
  },
  pendingHintText: {
    fontSize: 14,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  emptyListContent: {
    flex: 1,
  },
  
  conversationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    backgroundColor: theme.colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  conversationItemNew: {
    backgroundColor: 'rgba(0, 217, 166, 0.05)',
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.primary,
  },
  avatarContainer: {
    position: 'relative',
    marginRight: 12,
  },
  avatar: {
    width: 56,
    height: 56,
    backgroundColor: theme.colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarRound: {
    borderRadius: 28,
  },
  avatarSquare: {
    borderRadius: 16,
  },
  avatarText: {
    fontSize: 19,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  avatarImage: {
    width: 56,
    height: 56,
  },
  avatarImageRound: {
    borderRadius: 28,
  },
  avatarImageSquare: {
    borderRadius: 16,
  },
  newDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.primary,
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  // v19.0: Badge animé pour appel en cours
  activeCallDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#4CAF50', // Vert pour appel actif
    borderWidth: 2,
    borderColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  conversationInfo: {
    flex: 1,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  conversationName: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text,
    flexShrink: 1,
    letterSpacing: -0.2,
  },
  conversationNameUnread: {
    fontWeight: '700',
  },
  conversationNameNew: {
    color: theme.colors.primary,
  },
  memberCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
    gap: 3,
  },
  memberCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textMuted,
  },
  timestamp: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginLeft: 8,
  },
  timestampUnread: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  conversationFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  messagePreviewContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  messagePreview: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.textMuted,
    lineHeight: 19,
  },
  messagePreviewUnread: {
    color: theme.colors.text,
    fontWeight: '500',
  },
  messagePreviewNew: {
    color: theme.colors.primary,
    fontStyle: 'italic',
  },
  // v19.0: Style pour appel en cours
  messagePreviewActiveCall: {
    color: '#4CAF50',
    fontWeight: '600',
  },
  statusIcon: {
    marginRight: 4,
  },
  badgesContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  unreadBadge: {
    backgroundColor: theme.colors.primary,
    borderRadius: 11,
    minWidth: 22,
    height: 22,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  unreadBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.textOnPrimary,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 60,
  },
  emptyIconWrapper: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: theme.colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyLogo: {
    width: 72,
    height: 72,
    borderRadius: 18,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 6,
    letterSpacing: -0.4,
  },
  emptyTagline: {
    fontSize: 15,
    fontWeight: '500',
    color: theme.colors.primary,
    marginBottom: 12,
    letterSpacing: 0.1,
  },
  emptySubtitle: {
    fontSize: 15,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  emptyActions: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  emptyButtonPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: 15,
    borderRadius: 14,
    gap: 8,
    ...theme.shadow.glow,
  },
  emptyButtonSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    paddingVertical: 15,
    borderRadius: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyButtonTextPrimary: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.textOnPrimary,
  },
  emptyButtonTextSecondary: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text,
  },
  emptySecurityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 24,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(0, 217, 166, 0.08)',
    borderRadius: 20,
  },
  emptySecurityText: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.primary,
    opacity: 0.8,
  },
  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...theme.shadow.glow,
  },
  fabTouchable: {
    width: 58,
    height: 58,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default ConversationListScreen;