// src/screens/ConversationListScreen.tsx
// Liste des conversations - Design moderne avec header premium
// Liste des conversations 1-à-1
// v16.0 - Design unifié avec dernier message, statut et heure

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, Animated, Image, Easing, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { sessionService } from '../services/tripleRatchet';
import { pendingInviteStore, PendingInvite } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { showInAppNotification } from '../components/InAppNotification';
import { subscribeToAllMessages1to1, getAllUnreadCounts, pollAllSessions, getLocalMessages1to1, clearLocalMessages1to1, clearUnreadCount, waitForSealedSenderReady, getAllLastMessagePreviews, updateLastMessagePreview, onGroupUpdate, isUiInvisibleMessageType } from '../services/api1to1';
import { isSealedSenderReady } from '../services/sealedSender';
import { isSessionMutedSync } from '../services/muteService';
import { isInCall1to1 } from '../services/call1to1Service';
import * as groupService from '../services/groupService';
import { theme, ActionSheet, AlertModal, useTheme, useThemedStyles, type ColorPalette, showAlert } from '../components/ui';
import { getAvatarColor } from '../components/ui/theme';
import { CallIndicator } from '../components/CallIndicator';
import { GroupAvatar } from '../components/GroupAvatar';
import { GROUPS_ENABLED } from '../config/features';
import { startHeartbeatService } from '../services/callHeartbeat';
import { formatCallDuration } from '../services/callMessages';
import { generateAvatarInitials } from '../services/crypto';
import i18n, { getActiveLanguage } from '../i18n';

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
const SettingsIcon = () => {
  const { colors } = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"
        stroke={colors.text}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M19.4 15C19.2669 15.3016 19.2272 15.6362 19.286 15.9606C19.3448 16.285 19.4995 16.5843 19.73 16.82L19.79 16.88C19.976 17.0657 20.1235 17.2863 20.2241 17.5291C20.3248 17.7719 20.3766 18.0322 20.3766 18.295C20.3766 18.5578 20.3248 18.8181 20.2241 19.0609C20.1235 19.3037 19.976 19.5243 19.79 19.71C19.6043 19.896 19.3837 20.0435 19.1409 20.1441C18.8981 20.2448 18.6378 20.2966 18.375 20.2966C18.1122 20.2966 17.8519 20.2448 17.6091 20.1441C17.3663 20.0435 17.1457 19.896 16.96 19.71L16.9 19.65C16.6643 19.4195 16.365 19.2648 16.0406 19.206C15.7162 19.1472 15.3816 19.1869 15.08 19.32C14.7842 19.4468 14.532 19.6572 14.3543 19.9255C14.1766 20.1938 14.0813 20.5082 14.08 20.83V21C14.08 21.5304 13.8693 22.0391 13.4942 22.4142C13.1191 22.7893 12.6104 23 12.08 23C11.5496 23 11.0409 22.7893 10.6658 22.4142C10.2907 22.0391 10.08 21.5304 10.08 21V20.91C10.0723 20.579 9.96512 20.258 9.77251 19.9887C9.5799 19.7194 9.31074 19.5143 9 19.4C8.69838 19.2669 8.36381 19.2272 8.03941 19.286C7.71502 19.3448 7.41568 19.4995 7.18 19.73L7.12 19.79C6.93425 19.976 6.71368 20.1235 6.47088 20.2241C6.22808 20.3248 5.96783 20.3766 5.705 20.3766C5.44217 20.3766 5.18192 20.3248 4.93912 20.2241C4.69632 20.1235 4.47575 19.976 4.29 19.79C4.10405 19.6043 3.95653 19.3837 3.85588 19.1409C3.75523 18.8981 3.70343 18.6378 3.70343 18.375C3.70343 18.1122 3.75523 17.8519 3.85588 17.6091C3.95653 17.3663 4.10405 17.1457 4.29 16.96L4.35 16.9C4.58054 16.6643 4.73519 16.365 4.794 16.0406C4.85282 15.7162 4.81312 15.3816 4.68 15.08C4.55324 14.7842 4.34276 14.532 4.07447 14.3543C3.80618 14.1766 3.49179 14.0813 3.17 14.08H3C2.46957 14.08 1.96086 13.8693 1.58579 13.4942C1.21071 13.1191 1 12.6104 1 12.08C1 11.5496 1.21071 11.0409 1.58579 10.6658C1.96086 10.2907 2.46957 10.08 3 10.08H3.09C3.42099 10.0723 3.742 9.96512 4.0113 9.77251C4.28059 9.5799 4.48572 9.31074 4.6 9C4.73312 8.69838 4.77282 8.36381 4.714 8.03941C4.65519 7.71502 4.50054 7.41568 4.27 7.18L4.21 7.12C4.02405 6.93425 3.87653 6.71368 3.77588 6.47088C3.67523 6.22808 3.62343 5.96783 3.62343 5.705C3.62343 5.44217 3.67523 5.18192 3.77588 4.93912C3.87653 4.69632 4.02405 4.47575 4.21 4.29C4.39575 4.10405 4.61632 3.95653 4.85912 3.85588C5.10192 3.75523 5.36217 3.70343 5.625 3.70343C5.88783 3.70343 6.14808 3.75523 6.39088 3.85588C6.63368 3.95653 6.85425 4.10405 7.04 4.29L7.1 4.35C7.33568 4.58054 7.63502 4.73519 7.95941 4.794C8.28381 4.85282 8.61838 4.81312 8.92 4.68H9C9.29577 4.55324 9.54802 4.34276 9.72569 4.07447C9.90337 3.80618 9.99872 3.49179 10 3.17V3C10 2.46957 10.2107 1.96086 10.5858 1.58579C10.9609 1.21071 11.4696 1 12 1C12.5304 1 13.0391 1.21071 13.4142 1.58579C13.7893 1.96086 14 2.46957 14 3V3.09C14.0013 3.41179 14.0966 3.72618 14.2743 3.99447C14.452 4.26276 14.7042 4.47324 15 4.6C15.3016 4.73312 15.6362 4.77282 15.9606 4.714C16.285 4.65519 16.5843 4.50054 16.82 4.27L16.88 4.21C17.0657 4.02405 17.2863 3.87653 17.5291 3.77588C17.7719 3.67523 18.0322 3.62343 18.295 3.62343C18.5578 3.62343 18.8181 3.67523 19.0609 3.77588C19.3037 3.87653 19.5243 4.02405 19.71 4.21C19.896 4.39575 20.0435 4.61632 20.1441 4.85912C20.2448 5.10192 20.2966 5.36217 20.2966 5.625C20.2966 5.88783 20.2448 6.14808 20.1441 6.39088C20.0435 6.63368 19.896 6.85425 19.71 7.04L19.65 7.1C19.4195 7.33568 19.2648 7.63502 19.206 7.95941C19.1472 8.28381 19.1869 8.61838 19.32 8.92V9C19.4468 9.29577 19.6572 9.54802 19.9255 9.72569C20.1938 9.90337 20.5082 9.99872 20.83 10H21C21.5304 10 22.0391 10.2107 22.4142 10.5858C22.7893 10.9609 23 11.4696 23 12C23 12.5304 22.7893 13.0391 22.4142 13.4142C22.0391 13.7893 21.5304 14 21 14H20.91C20.5882 14.0013 20.2738 14.0966 20.0055 14.2743C19.7372 14.452 19.5268 14.7042 19.4 15Z"
        stroke={colors.text}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
};

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
  // v30.0 — Groupes
  kind?: 'direct' | 'group';
  memberCount?: number;
  groupMembers?: Array<{ fingerprint: string; displayName: string; avatarBase64?: string }>;
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
  const lang = getActiveLanguage();

  if (diff < 60000) return i18n.t('conversationList.time.justNow');
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return i18n.t('conversationList.time.minutesAgo', { count: mins });
  }
  if (diff < 86400000) return date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return date.toLocaleDateString(lang, { weekday: 'short' });
  return date.toLocaleDateString(lang, { day: '2-digit', month: '2-digit' });
}

const MessageStatusIcon = React.memo(({ status }: { status?: string }) => {
  const { colors } = useTheme();
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
          <Ionicons name="checkmark-done" size={16} color={colors.textMuted} />
        </View>
      );
    case 'sent':
    case 'sending':
    default:
      return (
        <View style={_statusStyles.icon}>
          <Ionicons name="checkmark" size={16} color={colors.textMuted} />
        </View>
      );
  }
});

const _statusStyles = StyleSheet.create({
  icon: { marginRight: 4, marginTop: 1 },
});

const _keyExtractor = (item: ConversationItem) => item.id;

// ════════════════════════════════════════════════════════════════════════════
// PERF — SNAPSHOT INITIAL DEPUIS sessionService (RAM)
// ════════════════════════════════════════════════════════════════════════════
// Lecture SYNCHRONE des sessions déjà chargées en RAM par sessionService au
// boot (handleUnlock / initializeApp ont awaité sessionService.initialize()
// AVANT de basculer le rendu sur le NavigationContainer). Au moment où ce
// composant mount, la Map sessionService.sessions est donc peuplée.
//
// Utilisé par le useState initializer ci-dessous pour que le PREMIER paint
// affiche déjà la liste structurée — noms, avatars, ordre par dernière
// activité — sans attendre qu'un useEffect ne lance loadConversations().
// L'utilisateur perçoit la liste comme instantanée.
//
// Les `lastMessage` (aperçu du dernier message) et `unreadCount` ne sont
// délibérément PAS résolus ici : ils nécessitent des lectures AsyncStorage
// asynchrones par session. Ils seront enrichis par le 1er loadConversations
// dans le useFocusEffect, typiquement < 200 ms après le mount. Sans cet
// enrichissement intermédiaire, l'UI montre des items "blank preview" qui
// se remplissent en cascade — acceptable et bien plus propre qu'une liste
// vide.
//
// GROUPES : lus de la même façon, depuis la Map RAM de groupService, peuplée
// par `loadGroups()` sur le chemin critique du boot (App.tsx, aux côtés de
// sessionService.initialize()). Avant, loadGroups n'était appelé qu'en effet
// de bord de recoverOrphanedSendingMessages(), déféré de 5 s : les groupes
// étaient absents ici ET du premier loadConversations, et n'apparaissaient
// qu'au premier rafraîchissement déclenché par le réseau — d'où les 10 s+
// avant qu'ils ne s'affichent.
//
// Faute de champ d'activité dans GroupRecord, le tri initial d'un groupe
// utilise `createdAt`. Le 1er loadConversations (< 200 ms) le remplace par
// le timestamp du dernier message et re-trie : même compromis assumé que
// pour les aperçus 1:1 ci-dessus.
//
// SÉCURITÉ : aucune donnée chiffrée n'est touchée ici. Tous les champs lus
// (id, displayName, lastActivityAt, fingerprint, avatarBase64 ; côté groupe
// groupId, name, avatarBase64, members) sont en RAM dans des objets JS purs
// après que la clé locale ait déchiffré l'index de sessions et celui des
// groupes au boot. Aucun secret cryptographique du groupe (groupSeed,
// sendChainKey) n'est lu. Si pour une raison quelconque sessionService ou
// groupService n'est PAS initialisé (cas extrême : composant rendu hors flux
// normal), les accesseurs retournent [] et le snapshot est vide — pas de
// crash, juste un fallback silencieux vers le comportement antérieur
// (loadConversations remplira).
// ════════════════════════════════════════════════════════════════════════════
function getInitialConversationsSnapshot(): ConversationItem[] {
  try {
    const sessions = sessionService.getAllSessions();
    // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. La Map RAM de
    // groupService peut être peuplée (loadGroups() reste sur le chemin de boot
    // pour préserver l'intégrité des données), mais rien n'en sort vers l'UI :
    // le snapshot ne contient que des conversations 1:1.
    const groups = GROUPS_ENABLED ? groupService.getAllGroups() : [];
    if (sessions.length === 0 && groups.length === 0) return [];
    // Fallback name : utilise i18n.t directement (le module i18n est initialisé
    // tôt au boot via initI18n() dans App.tsx, typiquement résolu < 30 ms après
    // le module load — donc bien avant que ConversationListScreen ne mount).
    // Si jamais i18n n'est pas encore prêt, on récupère la clé brute, ce qui
    // est strictement préférable à une chaîne vide (qui ferait 'avatar ?? ').
    const fallbackName = i18n.t('common.contact');
    const items: ConversationItem[] = sessions.map((s) => ({
      id: s.id,
      name: s.theirProfile.displayName || fallbackName,
      lastMessageAt: s.lastActivityAt,
      createdAt: s.createdAt,
      unreadCount: 0,
      theirFingerprint: s.theirIdentityKeyFingerprint,
      avatarBase64: s.theirProfile.avatarBase64,
      lastMessage: undefined,
      kind: 'direct' as const,
    }));
    for (const g of groups) {
      items.push({
        id: g.groupId,
        name: g.name,
        lastMessageAt: undefined,
        createdAt: g.createdAt,
        unreadCount: 0,
        avatarBase64: g.avatarBase64,
        lastMessage: undefined,
        kind: 'group' as const,
        memberCount: g.members.length,
        groupMembers: g.members.map((m) => ({
          fingerprint: m.fingerprint,
          displayName: m.displayName,
          avatarBase64: m.avatarBase64,
        })),
      });
    }
    items.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
    return items;
  } catch {
    // sessionService/groupService non initialisé ou erreur quelconque : fallback silencieux.
    // loadConversations se chargera de remplir la liste au 1er useFocusEffect.
    return [];
  }
}

export function ConversationListScreen() {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  
  // PERF: état initial pré-rempli depuis sessionService (RAM) — voir
  // getInitialConversationsSnapshot ci-dessus. Le 1er paint affiche la liste
  // structurée immédiatement ; loadConversations() enrichit ensuite avec les
  // lastMessage/unreadCount lus en async depuis AsyncStorage. La fonction est
  // passée non-appelée à useState (lazy initializer) pour ne s'exécuter QUE
  // lors du tout premier render et pas à chaque re-render.
  const [conversations, setConversations] = useState<ConversationItem[]>(getInitialConversationsSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<ConversationItem | null>(null);
  
  const fabRotation = useRef(new Animated.Value(0)).current;
  const logoFloat = useRef(new Animated.Value(0)).current;
  const emptyLogoFloat = useRef(new Animated.Value(0)).current;
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);

  // ════════════════════════════════════════════════════════════════════════
  // SEALED SENDER GATING — Solution 5
  // ════════════════════════════════════════════════════════════════════════
  // PROBLÈME : taper "Créer"/"Rejoindre" alors que le bootstrap SS est en
  // cours (typique : cold start + tap rapide) faisait apparaître l'écran
  // Create1to1/Join1to1 puis bloquait dessus jusqu'à 30s. UX médiocre :
  // l'utilisateur a basculé d'écran « pour rien ».
  //
  // SOLUTION : gating au tap, avant la navigation.
  //   • Fast path (SS prêt) : navigation immédiate, zéro UI parasite
  //   • Slow path (SS bootstrap) : modal léger « Préparation… » avec Cancel
  //     reste sur la liste de conversations. Quand SS devient prêt, on
  //     navigate automatiquement vers la destination demandée.
  //   • Timeout 20s : si SS ne se prépare pas, on dismiss le modal et
  //     on affiche une erreur claire (au lieu de bloquer 30s sur un splash).
  //
  // L'utilisateur a TOUJOURS la liste sous les yeux pendant l'attente
  // (vs basculer sur un splash plein écran), c'est plus rassurant.
  //
  // mountedRef + AbortController gèrent le unmount propre (back gesture,
  // app killée, etc.). Aucun setState après unmount, aucune navigation
  // parasite.
  // ════════════════════════════════════════════════════════════════════════
  
  // Cible de navigation en attente. Sentinel `null` = pas d'attente en cours.
  type GatedTarget = 'Create1to1' | 'Join1to1' | 'CreateGroup';
  const [pendingTarget, setPendingTarget] = useState<GatedTarget | null>(null);
  // Status affiché dans le modal d'attente (mis à jour par waitForSealedSenderReady)
  const [pendingStatus, setPendingStatus] = useState<string>('');
  // AbortController pour annuler le wait courant si l'utilisateur tape Cancel
  // ou re-tape un autre bouton.
  const gateAbortRef = useRef<AbortController | null>(null);
  // mountedRef pour bloquer setState/navigate après unmount
  const gateMountedRef = useRef(true);

  useEffect(() => {
    gateMountedRef.current = true;
    return () => {
      gateMountedRef.current = false;
      try { gateAbortRef.current?.abort(); } catch {}
    };
  }, []);
  
  const dismissGate = useCallback(() => {
    try { gateAbortRef.current?.abort(); } catch {}
    if (gateMountedRef.current) {
      setPendingTarget(null);
      setPendingStatus('');
    }
  }, []);
  
  /**
   * Wrapper de navigation qui s'assure que le SealedSender est prêt
   * AVANT de naviguer vers Create1to1/Join1to1.
   *
   * - SS déjà prêt → navigation immédiate (fast path, 0 await).
   * - SS pas prêt → modal léger « Préparation… » + Cancel, reste sur la liste,
   *   navigation automatique quand SS devient prêt.
   * - Timeout 60s → modal dismiss + Alert d'erreur claire.
   *   (Le bootstrap interne tente 3× avec backoff exponentiel ~15s max, MAIS
   *    sur Hermes le SHA-256 du PoW prend 5-30s selon contention CPU. 60s
   *    couvre largement les devices lents.)
   *
   * COORDINATION : `waitForSealedSenderReady` est un OBSERVATEUR PASSIF qui
   * ne reset jamais le bootstrap. Cancel ferme juste la modal — le
   * bootstrap continue paisiblement en arrière-plan. Re-tap = re-observer.
   */
  const handleSecureNavigate = useCallback((target: GatedTarget) => {
    // Fast path : SS prêt → navigation immédiate, pas d'UI parasite
    if (isSealedSenderReady()) {
      navigation.navigate(target);
      return;
    }
    
    // Slow path : afficher le modal et attendre
    // Reset l'AbortController au cas où un wait précédent serait encore actif
    try { gateAbortRef.current?.abort(); } catch {}
    gateAbortRef.current = new AbortController();
    const signal = gateAbortRef.current.signal;
    
    setPendingTarget(target);
    setPendingStatus(t('appBoot.preparingSecureConnection'));
    
    waitForSealedSenderReady({
      timeoutMs: 60_000,
      onStatus: (msg) => {
        if (gateMountedRef.current && !signal.aborted) {
          setPendingStatus(msg);
        }
      },
      signal,
    })
      .then((ready) => {
        // Abort = user cancelled OR component unmounted → ne rien faire,
        // dismissGate a déjà nettoyé l'état.
        if (signal.aborted || !gateMountedRef.current) return;
        
        // Fermer le modal AVANT la navigation pour éviter qu'il reste
        // affiché par-dessus le nouvel écran (race React Navigation).
        setPendingTarget(null);
        setPendingStatus('');
        
        if (ready) {
          navigation.navigate(target);
        } else {
          // Échec après le retry interne du bootstrap : message clair,
          // l'utilisateur peut re-tenter quand il veut (re-tap relancera
          // un cycle frais automatiquement).
          showAlert({
            title: t('common.error'),
            message: t('errors.secureConnectionTimeout'),
          });
        }
      })
      .catch(() => {
        // waitForSealedSenderReady ne devrait pas throw, mais par sécurité
        if (gateMountedRef.current) {
          setPendingTarget(null);
          setPendingStatus('');
        }
      });
  }, [navigation, t]);


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
      content = t('conversationList.preview.photo');
    } else if (msg.messageType === 'file' || msg.fileData) {
      msgType = 'file';
      content = msg.fileName
        ? t('conversationList.preview.file', { name: msg.fileName })
        : t('conversationList.preview.fileGeneric');
    } else if (msg.messageType === 'voice' || msg.voiceData) {
      msgType = 'voice';
      content = t('conversationList.preview.voice');
    } else {
      // Tenter de parser comme message d'appel
      const trimmed = (msg.content || '').trim();
      if (trimmed.startsWith('{') && trimmed.includes('type')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'call') {
            msgType = 'call';
            if (parsed.status === 'ended' && parsed.duration > 0) {
              content = t('conversationList.preview.callEnded', { duration: formatCallDuration(parsed.duration) });
            } else if (msg.isMine) {
              // J'ai initié l'appel → c'est MOI qui ai appelé
              content = t('conversationList.preview.callUnanswered');
            } else {
              // J'ai reçu l'appel → quelqu'un m'a appelé
              content = t('conversationList.preview.callMissed');
            }
          }
        } catch {
          // Fallback regex pour les JSON malformés
          if (trimmed.includes('call')) {
            const statusMatch = trimmed.match(/status\s*[":]\s*["']?(\w+)["']?/i);
            const status = statusMatch ? statusMatch[1].toLowerCase() : '';
            if (status === 'ended') {
              msgType = 'call';
              const durMatch = trimmed.match(/duration\s*[":]\s*(\d+)/i);
              content = durMatch && parseInt(durMatch[1]) > 0
                ? t('conversationList.preview.callEnded', { duration: formatCallDuration(parseInt(durMatch[1])) })
                : t('conversationList.preview.callEndedNoDuration');
            } else if (status === 'missed' || status === 'declined' || status === 'cancelled') {
              msgType = 'call';
              content = msg.isMine
                ? t('conversationList.preview.callUnanswered')
                : t('conversationList.preview.callMissed');
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
  }, [t]);

  // v16.0: Charger les conversations avec le dernier message
  const loadConversations = useCallback(async () => {
    // Instrumentation (dev only) : au cold start le thread JS est disputé par
    // le PoW du sealed sender, et un seul await lent suffit à retarder TOUS les
    // aperçus — la liste reste alors en « Nouvelle conversation ». Ces relevés
    // disent lequel, au lieu de laisser deviner.
    const _t0 = Date.now();
    const _lap = (label: string) =>
      __DEV__ && console.log(`[ConversationList] ⏱️ ${label}: ${Date.now() - _t0}ms`);
    let fullReads1to1 = 0;
    let fullReadsGroups = 0;

    try {
      await sessionService.initialize();
      const sessions = sessionService.getAllSessions();
      
      // v6.1: Charger les compteurs de messages non lus
      const unreadCounts = await getAllUnreadCounts();
      _lap('unreadCounts');
      
      // PERF A6: Utiliser le cache du dernier message quand il est rempli.
      // Premier appel (cacheFilledRef.current === false) :
      //   → Charger les messages de chaque session depuis AsyncStorage (O(n×m))
      //   → Remplir le cache
      // Appels suivants (cacheFilledRef.current === true) :
      //   → Utiliser directement le cache (O(n))
      //   → Le cache est mis à jour incrémentalement par subscribeToAllMessages1to1
      const needsFullLoad = !cacheFilledRef.current;

      // PERF (correctif) : au premier chargement, on lit l'index d'aperçus —
      // UNE seule entrée AsyncStorage de quelques Ko — au lieu de déchiffrer et
      // parser l'historique complet de CHAQUE conversation (jusqu'à 1000
      // messages chacun). C'était le principal coût d'affichage au démarrage.
      //
      // L'index n'est qu'un cache : toute session absente déclenche le
      // chargement complet d'origine, qui repeuple l'index au passage. Après la
      // première ouverture suivant la mise à jour, plus aucune session ne
      // manque à l'appel.
      //
      // L'index est chargé INCONDITIONNELLEMENT : après la première lecture, il
      // est en RAM (cf. `_previewIndex` dans api1to1) et l'appel se réduit à une
      // copie superficielle d'un objet de quelques dizaines d'entrées. Il sert
      // de repli aux groupes lors des rafraîchissements incrémentaux, quand le
      // cache RAM ne connaît pas encore une conversation (groupe rejoint alors
      // que l'écran est déjà affiché) — sans lui, cette ligne resterait sans
      // aperçu jusqu'au prochain chargement complet.
      const previews = await getAllLastMessagePreviews();
      _lap(`previews (${Object.keys(previews).length} entrée(s))`);

      const convsPromises = sessions.map(async (session) => {
        let lastMessage: LastMessageInfo | undefined;
        
        if (needsFullLoad) {
          const stub = previews[session.id];
          if (stub) {
            // Chemin rapide : l'aperçu suffit. `messageToLastInfo` reste appelé
            // ici pour que la mise en forme (« Photo », « Message vocal »…)
            // suive la langue courante au lieu d'être figée à l'écriture.
            lastMessage = messageToLastInfo(stub);
            lastMessageCacheRef.current.set(session.id, lastMessage);
          } else {
            // Repli : aucun aperçu connu (historique antérieur à la mise à
            // jour, ou index purgé). On lit tout, et l'index se remplira au
            // prochain message enregistré pour cette session.
            try {
              fullReads1to1++;
              const messages = await getLocalMessages1to1(session.id);
              if (messages.length > 0) {
                const sorted = messages.sort((a, b) => b.timestamp - a.timestamp);
                lastMessage = messageToLastInfo(sorted[0]);
                lastMessageCacheRef.current.set(session.id, lastMessage);
                // Amorcer l'index pour que le prochain démarrage soit rapide.
                void updateLastMessagePreview(session.id, sorted[0]);
              }
            } catch (e) {
              // Ignorer les erreurs de chargement de messages
            }
          }
        } else {
          // Appels suivants : utiliser le cache (instantané)
          lastMessage = lastMessageCacheRef.current.get(session.id);
        }
        
        return {
          id: session.id,
          name: session.theirProfile.displayName || t('common.contact'),
          lastMessageAt: session.lastActivityAt,
          createdAt: session.createdAt,
          unreadCount: unreadCounts.get(session.id) || 0,
          theirFingerprint: session.theirIdentityKeyFingerprint,
          avatarBase64: session.theirProfile.avatarBase64,
          lastMessage,
          kind: 'direct' as const,
        };
      });
      
      // Annotation explicite : sans elle, TS infère le type des seules lignes
      // 1:1 (`kind: 'direct'`) et refuse le push des groupes plus bas.
      let convs: ConversationItem[] = await Promise.all(convsPromises);
      _lap(`1:1 (${convs.length} conv, ${fullReads1to1} repli(s) historique complet)`);

      // Filet idempotent : garantit que la Map des groupes est peuplée même si
      // cet écran est atteint par un chemin qui n'a pas awaité `loadGroups()`
      // au boot (App.tsx le fait sur les trois chemins d'entrée). Retour
      // immédiat une fois chargé (garde `_loaded`), et no-op silencieux si la
      // clé de chiffrement n'est pas encore disponible — auquel cas un appel
      // ultérieur réessaiera.
      //
      // DOIT précéder le filtre ci-dessous ET la fusion des groupes : les deux
      // lisent la Map. C'est l'absence de ce chargement au premier
      // loadConversations qui faisait apparaître les groupes 10 s trop tard.
      // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. Inutile de payer ce
      // chargement quand aucun groupe ne sera affiché.
      if (GROUPS_ENABLED) {
        try {
          await groupService.loadGroups();
        } catch (e) {
          __DEV__ && console.warn('[ConversationList] loadGroups failed:', e);
        }
      }

      // Masquer les conversations 1:1 VIDES dont le contact est membre d'un
      // groupe : leur session est préservée pour le transport mesh du groupe,
      // mais il n'y a aucun historique 1:1 à afficher (conversation « supprimée »).
      // Elles réapparaissent dès qu'un message 1:1 arrive (lastMessage défini).
      //
      // [GROUPES DÉSACTIVÉS] Ce filtre DOIT sauter quand les groupes sont
      // coupés, sinon il masque une conversation 1:1 vide sans que le groupe
      // qui justifie ce masquage soit visible : le contact disparaîtrait
      // purement et simplement de la liste, sans aucun moyen de le retrouver.
      if (GROUPS_ENABLED) {
        convs = convs.filter((c) =>
          c.lastMessage !== undefined ||
          (c.unreadCount || 0) > 0 ||
          !c.theirFingerprint ||
          !groupService.isContactInAnyGroup(c.theirFingerprint)
        );
      }

      // v30.0 — Fusionner les GROUPES dans la liste unifiée.
      //
      // PERF : les groupes suivent désormais EXACTEMENT la même stratégie
      // d'aperçu que le 1:1 quelques lignes plus haut. Avant, ce bloc appelait
      // `getGroupMessages()` — c'est-à-dire `getLocalMessages1to1()`, donc
      // lecture disque + déchiffrement + JSON.parse + tri de l'historique
      // COMPLET — pour CHAQUE groupe, en séquentiel, et cela à chaque
      // rafraîchissement (donc à chaque message entrant, via le subscribe).
      // C'est précisément le coût que l'index d'aperçus avait supprimé côté
      // 1:1 et qui avait été oublié ici.
      //
      // L'index contient déjà les groupes : les messages de groupe sont
      // persistés par `saveLocalMessage1to1(groupId, …)` (cf. apiGroups), qui
      // appelle `updateLastMessagePreview` — les stubs étaient simplement
      // jamais relus.

      // Les bandeaux système (isSystem) ne sont jamais « de moi » : sans ça,
      // getMessagePreview() leur collerait un préfixe « Vous: ». Ils sont déjà
      // persistés avec isMine=false (cf. appendSystemMessage) ; la garde rend
      // l'invariant explicite là où le champ existe encore — `LastMessageInfo`
      // ne le transporte pas.
      const groupLastInfo = (msg: any): LastMessageInfo => {
        const info = messageToLastInfo(msg);
        return msg?.isSystem && info.isMine ? { ...info, isMine: false } : info;
      };

      try {
        // NOTE — apiGroups n'est PAS importé ici.
        // Il ne sert qu'au repli « historique complet » ci-dessous, cas rare
        // (un groupe absent de l'index d'aperçus). L'importer en tête de bloc
        // coûtait, en dev, un chargement paresseux Metro de ~950 modules —
        // mesuré à +3,6 s sur l'affichage de la liste, pour un repli utilisé
        // zéro fois. L'import est donc fait à l'intérieur de la branche qui en
        // a besoin, et l'abstraction `getGroupMessages` reste préservée.
        //
        // Résolution CONCURRENTE, comme pour le 1:1 juste au-dessus. En
        // séquentiel, un seul groupe dont l'aperçu manque à l'index (donc
        // lecture de l'historique complet) retardait l'affichage de TOUTE la
        // liste, aperçus 1:1 compris — le `setConversations` final est unique.
        // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. La fusion est
        // neutralisée À LA SOURCE plutôt qu'en sautant le bloc : la liste des
        // groupes à fusionner est vide, donc `Promise.all` résout sur [] et
        // rien n'est poussé dans la liste unifiée. Aucune donnée n'est
        // détruite — les groupes restent sur disque, simplement invisibles.
        // Neutraliser la source plutôt que la structure garde ce bloc (et ses
        // trois niveaux de repli d'aperçu) typé et lisible pour la
        // réactivation.
        const groupsToMerge = GROUPS_ENABLED ? groupService.getAllGroups() : [];
        const groupItems = await Promise.all(groupsToMerge.map(async (g) => {
          let lastMessage: LastMessageInfo | undefined;

          // 1) Cache RAM (rafraîchissements incrémentaux) — instantané.
          if (!needsFullLoad) {
            lastMessage = lastMessageCacheRef.current.get(g.groupId);
          }

          // 2) Index d'aperçus — UNE entrée de quelques centaines d'octets.
          if (!lastMessage) {
            const stub = previews[g.groupId];
            if (stub) {
              lastMessage = groupLastInfo(stub);
              lastMessageCacheRef.current.set(g.groupId, lastMessage);
            }
          }

          // 3) Repli : aucun aperçu connu (groupe antérieur à l'index, ou index
          //    purgé). On lit l'historique complet une fois et on amorce
          //    l'index pour que le prochain démarrage soit rapide. Réservé au
          //    chargement complet : hors de lui, un groupe sans aperçu est un
          //    groupe sans message, inutile de payer une lecture disque à
          //    chaque message entrant.
          if (!lastMessage && needsFullLoad) {
            try {
              fullReadsGroups++;
              const apiG = await import('../services/apiGroups');
              const msgs = await apiG.getGroupMessages(g.groupId);
              if (msgs && msgs.length > 0) {
                const sorted = msgs.slice().sort((a: any, b: any) => b.timestamp - a.timestamp);
                const last: any = sorted[0];
                lastMessage = groupLastInfo(last);
                lastMessageCacheRef.current.set(g.groupId, lastMessage);
                void updateLastMessagePreview(g.groupId, last);
              }
            } catch (e) {
              __DEV__ && console.warn('[ConversationList] group history fallback failed:', g.groupId.slice(0, 12), e);
            }
          }

          const lastAt = lastMessage?.timestamp || g.createdAt;
          return {
            id: g.groupId,
            name: g.name,
            lastMessageAt: lastAt,
            createdAt: g.createdAt,
            unreadCount: unreadCounts.get(g.groupId) || 0,
            avatarBase64: g.avatarBase64,
            lastMessage,
            kind: 'group' as const,
            memberCount: g.members.length,
            groupMembers: g.members.map((m: any) => ({ fingerprint: m.fingerprint, displayName: m.displayName, avatarBase64: m.avatarBase64 })),
          };
        }));
        // push(...tableau) évité : un spread trop large dépasse la limite
        // d'arguments de l'appel.
        for (const item of groupItems) convs.push(item);
        _lap(`groupes (${groupItems.length}, ${fullReadsGroups} repli(s) historique complet)`);
      } catch (e) {
        // Dégradation : liste 1:1 seulement. Le `catch {}` muet d'origine est
        // ce qui rendait invisible l'absence des groupes au démarrage — aucune
        // trace, aucun moyen de distinguer « pas de groupe » de « groupes pas
        // encore chargés ». On journalise désormais en dev.
        __DEV__ && console.warn('[ConversationList] group merge failed:', e);
      }

      convs.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
      setConversations(convs);
      _lap(`TOTAL — liste affichée (${convs.length} conv)`);
      
      if (needsFullLoad) {
        cacheFilledRef.current = true;
      }
      
      return convs;
    } catch (error) {
      console.error('[ConversationList] Error loading:', error);
      return [];
    }
  }, [messageToLastInfo, t]);

  // S'assurer que l'inviteWatcher tourne et réagir aux acceptations
  useEffect(() => {
    inviteWatcher.ensureRunning();

    const unsub = inviteWatcher.onAccepted((session, invite) => {
      console.log(`[ConversationList] 🎉 Invite accepted: ${invite.label} → ${session.theirProfile.displayName}`);
      loadConversations();
      
      // Naviguer vers l'écran de célébration (pas de notification toast)
      const contactName = session.theirProfile.displayName || t('common.contact');
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

      // ════════════════════════════════════════════════════════════════════
      // PERF — LOCAL D'ABORD, RÉSEAU EN ARRIÈRE-PLAN
      // ════════════════════════════════════════════════════════════════════
      // Avant : on awaitait pollAllSessions() AVANT loadConversations().
      // pollAllSessions déclenche un secureRpc → si initRelay n'est pas
      // encore prêt (cas typique au cold start depuis que sealedSender est
      // sorti du chemin critique), il y a 1-3 s d'attente OHTTP/manifest
      // pendant lesquelles loadConversations() n'était PAS appelé → la
      // liste restait vide en regardant l'utilisateur. Symptôme exact :
      // « les conversations mettent du temps à apparaître après l'unlock ».
      //
      // Maintenant : on charge depuis le cache local IMMÉDIATEMENT
      // (lecture AsyncStorage déchiffrée + tri en RAM, ~30-200 ms typique)
      // puis on lance le poll en fire-and-forget. Les nouveaux messages
      // arrivés depuis la dernière session sont récupérés via le poll
      // background, et le subscribe `subscribeToAllMessages1to1` met à jour
      // la liste de manière incrémentale dès qu'ils arrivent.
      //
      // SÉCURITÉ : aucune dépendance au sealed sender pour la lecture
      // locale ni pour le poll lui-même (le sealed sender ne sert qu'à
      // l'envoi). Les paths d'envoi ont leur propre garde
      // ensureSealedSenderBootstrap() — voir App.tsx.
      // ════════════════════════════════════════════════════════════════════
      const initAndLoad = async () => {
        // 1) Lecture LOCALE — affiche les conversations immédiatement.
        try {
          await loadConversations();
        } catch (e) {
          console.error('[ConversationList] Local load error:', e);
        }

        // 2) Poll réseau en arrière-plan. La liste est déjà visible ;
        //    le subscribe rafraîchira si de nouveaux messages reviennent.
        //    Pas d'await — on ne bloque ni l'UI ni d'autres effects.
        pollAllSessions().catch(error => {
          __DEV__ && console.warn('[ConversationList] Background poll error:', error);
        });
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

  // v30.0 — Rafraîchir la liste quand un groupe change (nouveau message,
  // roster modifié, welcome reçu…). onGroupUpdate est émis par api1to1 à la
  // réception de tout message de groupe visible.
  //
  // `onGroupUpdate` est importé STATIQUEMENT : api1to1 fait déjà partie du
  // graphe statique de cet écran (cf. l'import en tête de fichier), donc
  // l'`await import()` d'origine n'apportait aucun chargement paresseux — il
  // ne faisait que déclencher une requête de bundle séparée côté Metro en dev.
  //
  // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. Aucun groupe n'étant
  // affiché, un message de groupe entrant n'a rien à rafraîchir : on ne
  // s'abonne pas, plutôt que de déclencher un rechargement complet de la liste
  // pour un changement invisible. Le dispatch réseau côté api1to1/apiGroups
  // reste, lui, intact.
  useEffect(() => {
    if (!GROUPS_ENABLED) return;
    const unsub = onGroupUpdate(() => {
      // Invalider le cache du dernier message puis recharger.
      cacheFilledRef.current = false;
      loadConversations().catch(() => {});
    });
    return () => unsub();
  }, [loadConversations]);

  useEffect(() => {
    startHeartbeatService().catch(console.error);
  }, []);

  // S'abonner aux nouveaux messages pour rafraîchir la liste + notification in-app
  useEffect(() => {
    // Types de messages qui ne doivent PAS déclencher de notification in-app
    // ni écraser l'aperçu du dernier message. Deux familles :
    // - les événements d'état local (accusés, frappe, signaux d'appel,
    //   réactions), listés ici ;
    // - les messages de protocole et de groupe, dont la liste de référence
    //   est PROTOCOL_MESSAGE_TYPES dans api1to1 (`isUiInvisibleMessageType`).
    //   Ne JAMAIS les recopier ici : cette copie avait dérivé et laissait
    //   passer push_token_update, mute_preference et catch_up_request, qui
    //   s'affichaient avec leur JSON. api1to1 ne les notifie plus, la garde
    //   ci-dessous est une ceinture en plus des bretelles.
    const NOTIFICATION_SILENT_TYPES = new Set([
      'read_receipt', 'delivered_receipt', 'typing', 'call_signal', 'handshake_ack', 'reaction',
    ]);
    // Un message sans type (champ optionnel) reste visible, comme avant.
    const isSilent = (type: string | undefined): boolean =>
      !!type && (NOTIFICATION_SILENT_TYPES.has(type) || isUiInvisibleMessageType(type));
    // PERF FIX (4.3) : types qui ne doivent PAS rafraîchir la liste de conversations.
    // - typing/call_signal/handshake_ack/reaction : n'affectent ni le dernier message
    //   ni le compteur de non-lus → rafraîchir = setState avec un nouveau tableau
    //   pour rien → re-render de tout l'écran inutilement à chaque keystroke distant.
    // - read_receipt/delivered_receipt : on les LAISSE rafraîchir car ils mettent à
    //   jour l'icône de statut (✓ → ✓✓ → ✓✓ bleu) du dernier message émis par moi.
    const LIST_SKIP_REFRESH_TYPES = new Set([
      'typing', 'call_signal', 'handshake_ack', 'reaction',
    ]);

    const unsubscribe = subscribeToAllMessages1to1((sessionId, message) => {
      // PERF A6: Mettre à jour le cache du dernier message AVANT de rafraîchir la liste.
      // Cela évite que loadConversations recharge tous les messages depuis AsyncStorage.
      // Le cache est mis à jour si ce message est plus récent que l'entrée actuelle.
      if (!isSilent(message.messageType as string | undefined)) {
        const cached = lastMessageCacheRef.current.get(sessionId);
        if (!cached || message.timestamp >= cached.timestamp) {
          lastMessageCacheRef.current.set(sessionId, messageToLastInfo(message));
        }
      }

      // PERF FIX (4.3) : skip le reload pour les types qui n'affectent pas la liste.
      if (!LIST_SKIP_REFRESH_TYPES.has(message.messageType as string)) {
        loadConversations();
      }

      // Notification in-app pour les messages entrants visibles uniquement
      if (message.isMine) return;
      if (isSilent(message.messageType as string | undefined)) return;
      
      // CORRECTION: Ne pas afficher la notification si la conversation est mutée
      if (isSessionMutedSync(sessionId)) return;
      
      const contactName = message.displayName || t('common.contact');
      
      // Preview selon le type de message
      let body: string;
      switch (message.messageType) {
        case 'image':
          body = t('conversationList.preview.photo');
          break;
        case 'voice':
          body = t('conversationList.preview.voice');
          break;
        case 'file':
          body = message.fileName
            ? t('conversationList.preview.file', { name: message.fileName })
            : t('conversationList.preview.fileGeneric');
          break;
        case 'call':
          body = t('conversationList.preview.callEndedNoDuration');
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
        showAlert({
          title: t('conversationList.callInProgressTitle'),
          message: t('conversationList.callInProgressMessage'),
        });
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
      // Préserver la session si le contact est membre d'un groupe (transport
      // mesh) : on ne supprime alors que l'historique 1:1. La conversation vidée
      // est masquée par le filtre « vide + dans un groupe » de loadConversations.
      //
      // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. Cette préservation
      // n'a plus de sens quand les groupes sont coupés : le filtre qui masquait
      // la conversation vidée est lui aussi désactivé (il ferait disparaître le
      // contact sans raison visible), donc la « suppression » laisserait une
      // conversation vide dans la liste. On supprime alors la session pour de
      // bon — comportement 1:1 attendu par l'utilisateur.
      const delFp = sessionService.getSession(conversationToDelete.id)?.theirIdentityKeyFingerprint;
      if (!delFp || !GROUPS_ENABLED || !groupService.isContactInAnyGroup(delFp)) {
        await sessionService.deleteSession(conversationToDelete.id);
      }
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
      if (!item.lastMessage) return t('conversationList.newConversation');
      
      // v19.1: Ne pas préfixer "Vous:" pour les messages d'appel
      if (item.lastMessage.type === 'call') {
        return item.lastMessage.content;
      }
      
      if (item.lastMessage.isMine) {
        return t('conversationList.youPrefix', { message: item.lastMessage.content });
      }
      return item.lastMessage.content;
    };
    
    return (
      <TouchableOpacity
        style={styles.conversationItem}
        onPress={() => handleConversationPress(item)}
        onLongPress={() => handleConversationLongPress(item)}
        activeOpacity={0.7}
      >
        {/* Avatar rond — groupe (composite) ou contact 1:1 */}
        <View style={styles.avatarContainer}>
          {item.kind === 'group' ? (
            <GroupAvatar
              name={item.name}
              members={item.groupMembers}
              groupId={item.id}
              avatarUri={item.avatarBase64}
              size="large"
            />
          ) : (
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
          )}
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
  }, [handleConversationPress, handleConversationLongPress, t, styles, colors]);

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
      <Text style={styles.emptyTitle}>{t('conversationList.emptyTitle')}</Text>
      <Text style={styles.emptySubtitle}>
        {t('conversationList.emptySubtitle')}
      </Text>
      
      <View style={styles.emptyActions}>
        {/*
          `adjustsFontSizeToFit` retiré des trois boutons : il servait à
          compenser la contrainte de largeur du layout en rangée. En pile,
          le libellé tient, et laisser la police rétrécir automatiquement
          annulerait le réglage de taille de texte système de
          l'utilisateur — exactement ce que l'accessibilité interdit.
        */}
        <TouchableOpacity
          style={styles.emptyButtonPrimary}
          onPress={() => handleSecureNavigate('Create1to1')}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('conversationList.emptyCreate')}
        >
          <Ionicons name="add-circle-outline" size={20} color={colors.textOnPrimary} />
          <Text style={styles.emptyButtonTextPrimary} numberOfLines={2}>
            {t('conversationList.emptyCreate')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.emptyButtonSecondary}
          onPress={() => handleSecureNavigate('Join1to1')}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('conversationList.emptyJoin')}
        >
          <Ionicons name="scan-outline" size={20} color={colors.text} />
          <Text style={styles.emptyButtonTextSecondary} numberOfLines={2}>
            {t('conversationList.emptyJoin')}
          </Text>
        </TouchableOpacity>

        {/*
          3ᵉ action — parité avec le FAB. L'état vide ne proposait que
          « Créer » et « Rejoindre » alors que le menu du FAB offre aussi
          « Nouveau groupe ». Un utilisateur qui découvre l'app se fie à
          l'état vide, pas au FAB : la fonctionnalité groupe lui était de
          fait invisible tant qu'il n'avait aucune conversation.

          [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. L'état vide
          retombe donc à deux actions (« Créer » / « Rejoindre »), exactement
          comme le menu du FAB : la parité entre les deux surfaces est
          maintenue dans les deux états du drapeau.
        */}
        {GROUPS_ENABLED && (
          <TouchableOpacity
            style={styles.emptyButtonSecondary}
            onPress={() => handleSecureNavigate('CreateGroup')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('groups.menu.createTitle')}
          >
            <Ionicons name="people-outline" size={20} color={colors.text} />
            <Text style={styles.emptyButtonTextSecondary} numberOfLines={2}>
              {t('groups.menu.createTitle')}
            </Text>
          </TouchableOpacity>
        )}
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
              <Ionicons name="qr-code-outline" size={20} color={colors.warning} />
            </View>
            <View style={styles.pendingBannerContent}>
              <Text style={styles.pendingBannerTitle}>
                {t('conversationList.pendingInvitations', { count: pendingCount })}
              </Text>
              <Text style={styles.pendingBannerSub}>{t('conversationList.pendingTapToManage')}</Text>
            </View>
            <View style={styles.pendingBannerRight}>
              <View style={styles.pendingBannerDot} />
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </View>
          </TouchableOpacity>
        ) : null}
        ListFooterComponent={conversations.length === 0 && pendingCount > 0 ? (
          <View style={styles.pendingHint}>
            <Text style={styles.pendingHintText}>
              {t('conversationList.pendingHint')}
            </Text>
          </View>
        ) : null}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
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
            <Ionicons name="chatbubble-ellipses" size={24} color={colors.textOnPrimary} />
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Menu */}
      <ActionSheet
        visible={showNewMenu}
        onClose={() => setShowNewMenu(false)}
        items={[
          {
            title: t('conversationList.menu.createTitle'),
            subtitle: t('conversationList.menu.createSubtitle'),
            icon: <Ionicons name="add-circle-outline" size={24} color={colors.primary} />,
            // PERF FIX : pas de setShowNewMenu(false) ici — l'ActionSheet appelle
            // déjà onClose() (qui fait setShowNewMenu(false)) avant de défer
            // ce onPress. Doubler créait la race condition expliquée dans Modal.tsx.
            // GATING : handleSecureNavigate gère le cas où le SealedSender n'est
            // pas encore prêt (modal d'attente sur cette liste, pas de splash
            // plein écran sur Create1to1Screen).
            onPress: () => handleSecureNavigate('Create1to1'),
          },
          {
            title: t('conversationList.menu.joinTitle'),
            subtitle: t('conversationList.menu.joinSubtitle'),
            icon: <Ionicons name="scan-outline" size={24} color={colors.primary} />,
            onPress: () => handleSecureNavigate('Join1to1'),
          },
          // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. L'entrée
          // « Nouveau groupe » est retirée du menu du FAB. Le spread
          // conditionnel évite un `null` dans le tableau, que l'ActionSheet ne
          // sait pas rendre (il map sur `items` sans filtrer).
          ...(GROUPS_ENABLED ? [{
            title: t('groups.menu.createTitle'),
            subtitle: t('groups.menu.createSubtitle'),
            icon: <Ionicons name="people-outline" size={24} color={colors.primary} />,
            onPress: () => handleSecureNavigate('CreateGroup'),
          }] : []),
        ]}
      />

      {/* Modal suppression */}
      <AlertModal
        visible={showDeleteConfirm}
        title={t('conversationList.deleteTitle')}
        message={t('conversationList.deleteMessage', { name: conversationToDelete?.name ?? '' })}
        secondaryButton={{
          title: t('common.cancel'),
          onPress: () => {
            setShowDeleteConfirm(false);
            setConversationToDelete(null);
          },
        }}
        primaryButton={{
          title: t('common.delete'),
          variant: 'danger',
          onPress: handleDelete,
        }}
        onClose={() => {
          setShowDeleteConfirm(false);
          setConversationToDelete(null);
        }}
      />

      {/* ──────────────────────────────────────────────────────────────────
         GATING SEALED SENDER (Solution 5)
         ──────────────────────────────────────────────────────────────────
         Affiché UNIQUEMENT quand l'utilisateur a tapé Créer/Rejoindre alors
         que le SealedSender n'était pas encore prêt. Le user reste sur la
         liste de conversations pendant l'attente (vs un splash plein écran),
         peut annuler à tout moment, et le système navigue automatiquement
         dès que SS devient prêt.
         ────────────────────────────────────────────────────────────────── */}
      <AlertModal
        visible={pendingTarget !== null}
        title={t('conversationList.gating.title')}
        message={pendingStatus || t('appBoot.preparingSecureConnection')}
        icon={
          <View style={{ alignItems: 'center' }}>
            <Ionicons name="shield-checkmark-outline" size={36} color={colors.primary} />
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={{ marginTop: 8 }}
            />
          </View>
        }
        secondaryButton={{
          title: t('common.cancel'),
          onPress: dismissGate,
        }}
        onClose={dismissGate}
      />
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    backgroundColor: colors.background,
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
    color: colors.text,
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
    backgroundColor: colors.primary,
    marginRight: 6,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    letterSpacing: 0.1,
  },
  settingsButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surface,
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
    backgroundColor: colors.divider,
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
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
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
    color: colors.text,
  },
  pendingBannerSub: {
    fontSize: 13,
    color: colors.textMuted,
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
    backgroundColor: colors.warning,
  },
  pendingHint: {
    paddingHorizontal: 36,
    paddingVertical: 40,
    alignItems: 'center',
  },
  pendingHintText: {
    fontSize: 14,
    color: colors.textMuted,
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
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  conversationItemNew: {
    backgroundColor: 'rgba(0, 217, 166, 0.05)',
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  avatarContainer: {
    position: 'relative',
    marginRight: 12,
  },
  avatar: {
    width: 56,
    height: 56,
    backgroundColor: colors.surfaceLight,
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
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.background,
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
    borderColor: colors.background,
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
    color: colors.text,
    flexShrink: 1,
    letterSpacing: -0.2,
  },
  conversationNameUnread: {
    fontWeight: '700',
  },
  conversationNameNew: {
    color: colors.primary,
  },
  memberCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
    gap: 3,
  },
  memberCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  timestamp: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 8,
  },
  timestampUnread: {
    color: colors.primary,
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
    color: colors.textMuted,
    lineHeight: 19,
  },
  messagePreviewUnread: {
    color: colors.text,
    fontWeight: '500',
  },
  messagePreviewNew: {
    color: colors.primary,
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
    backgroundColor: colors.primary,
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
    color: colors.textOnPrimary,
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
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyLogo: {
    width: 72,
    height: 72,
    borderRadius: 18,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 6,
    letterSpacing: -0.4,
  },
  emptyTagline: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.primary,
    marginBottom: 12,
    letterSpacing: 0.1,
  },
  emptySubtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  // ══════════════════════════════════════════════════════════════════════
  // Passage d'une RANGÉE à une PILE verticale.
  //
  // Avec deux boutons `flex: 1` côte à côte, chaque libellé disposait de la
  // moitié de l'écran. En ajoutant la 3ᵉ action (« Nouveau groupe »), on
  // tombait à un tiers — soit ~100 px pour « Gruppe erstellen » ou
  // « Создать группу », icône comprise. Les libellés auraient été réduits
  // au `minimumFontScale` de 0,82 puis tronqués, et les cibles tactiles
  // seraient passées sous le seuil confortable.
  //
  // En pile, chaque action occupe toute la largeur : libellé entier quelle
  // que soit la langue, cible tactile pleine largeur × 48 px, et la
  // hiérarchie reste lisible (le bouton plein en premier, les deux
  // secondaires ensuite).
  // ══════════════════════════════════════════════════════════════════════
  emptyActions: {
    flexDirection: 'column',
    gap: 12,
    width: '100%',
  },
  emptyButtonPrimary: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 15,
    borderRadius: 14,
    gap: 8,
    ...theme.shadow.glow,
  },
  emptyButtonSecondary: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    paddingVertical: 15,
    borderRadius: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyButtonTextPrimary: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textOnPrimary,
    flexShrink: 1,
  },
  emptyButtonTextSecondary: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
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
    color: colors.primary,
    opacity: 0.8,
  },
  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.primary,
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
}) as const;

export default ConversationListScreen;