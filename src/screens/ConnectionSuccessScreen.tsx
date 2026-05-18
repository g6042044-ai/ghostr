// src/screens/ConnectionSuccessScreen.tsx
// Écran de célébration quand un contact accepte une invitation
// Full-screen animé avec avatar, badges sécurité, CTA

import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing, Image, BackHandler } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { suppressNotification } from '../components/InAppNotification';
import { generateAvatarInitials } from '../services/crypto';
import { sendPushTokenToPeer } from '../services/api1to1';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  ConnectionSuccess: {
    sessionId: string;
    contactName: string;
    inviteLabel: string;
    inviteTag?: string;
    contactAvatarBase64?: string;
  };
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'ConnectionSuccess'>;
type ScreenRouteProp = RouteProp<RootStackParamList, 'ConnectionSuccess'>;

// Couleur avatar déterministe depuis le nom
function avatarColor(name: string): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#A78BFA',
    '#F7DC6F', '#DDA0DD', '#FF8C42', '#6BCB77', '#4D96FF',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function ConnectionSuccessScreen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ScreenRouteProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { sessionId, contactName, inviteLabel, inviteTag, contactAvatarBase64 } = route.params;

  // Supprimer le toast "Connexion établie" — cet écran affiche déjà l'info
  useEffect(() => {
    if (inviteTag) {
      suppressNotification(`accept_${inviteTag}`);
    }
  }, [inviteTag]);

  // Bloquer le retour arrière Android — l'utilisateur doit utiliser les boutons
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => backHandler.remove();
  }, []);

  // Envoyer notre push token au nouveau contact via E2E
  useEffect(() => {
    sendPushTokenToPeer(sessionId).catch((err: any) => {
      __DEV__ && console.warn('[ConnectionSuccess] Push token send failed:', err);
    });
  }, [sessionId]);

  // ── Animation values ──
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(0)).current;
  const checkScale = useRef(new Animated.Value(0)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleTranslateY = useRef(new Animated.Value(20)).current;
  const subtitleOpacity = useRef(new Animated.Value(0)).current;
  const subtitleTranslateY = useRef(new Animated.Value(16)).current;
  const badgesOpacity = useRef(new Animated.Value(0)).current;
  const badgesTranslateY = useRef(new Animated.Value(20)).current;
  const buttonOpacity = useRef(new Animated.Value(0)).current;
  const buttonTranslateY = useRef(new Animated.Value(30)).current;
  const laterOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const sequence = Animated.stagger(60, [
      // 1: Backdrop
      Animated.timing(backdropOpacity, {
        toValue: 1, duration: 300, useNativeDriver: true,
      }),
      // 2: Avatar
      Animated.spring(avatarScale, {
        toValue: 1, tension: 100, friction: 6, useNativeDriver: true,
      }),
      // 3: Check badge
      Animated.spring(checkScale, {
        toValue: 1, tension: 120, friction: 5, useNativeDriver: true,
      }),
      // 6: Title
      Animated.parallel([
        Animated.timing(titleOpacity, {
          toValue: 1, duration: 350, useNativeDriver: true,
        }),
        Animated.timing(titleTranslateY, {
          toValue: 0, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true,
        }),
      ]),
      // 7: Subtitle
      Animated.parallel([
        Animated.timing(subtitleOpacity, {
          toValue: 1, duration: 300, useNativeDriver: true,
        }),
        Animated.timing(subtitleTranslateY, {
          toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true,
        }),
      ]),
      // 8: Badges
      Animated.parallel([
        Animated.timing(badgesOpacity, {
          toValue: 1, duration: 350, useNativeDriver: true,
        }),
        Animated.timing(badgesTranslateY, {
          toValue: 0, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true,
        }),
      ]),
      // 9: Button
      Animated.parallel([
        Animated.timing(buttonOpacity, {
          toValue: 1, duration: 300, useNativeDriver: true,
        }),
        Animated.timing(buttonTranslateY, {
          toValue: 0, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true,
        }),
      ]),
      // 10: Later
      Animated.timing(laterOpacity, {
        toValue: 1, duration: 300, useNativeDriver: true,
      }),
    ]);
    sequence.start();

    return () => { sequence.stop(); };
  }, []);

  const handleOpenConversation = () => {
    // Reset complet: ConversationList → Conversation
    // Empêche tout retour vers ConnectionSuccess
    navigation.reset({
      index: 1,
      routes: [
        { name: 'ConversationList' },
        { name: 'Conversation', params: { conversationId: sessionId, conversationName: contactName } },
      ],
    });
  };

  const handleLater = () => {
    // Reset complet: retour à ConversationList seul
    // Empêche tout retour vers ConnectionSuccess
    navigation.reset({
      index: 0,
      routes: [{ name: 'ConversationList' }],
    });
  };

  const accentColor = avatarColor(contactName);
  const initial = generateAvatarInitials(contactName);

  return (
    <Animated.View style={[
      styles.container,
      {
        opacity: backdropOpacity,
        paddingBottom: insets.bottom + 16,
        paddingTop: insets.top,
      },
    ]}>

      {/* ═══ Visual: Avatar + Check ═══ */}
      <View style={styles.visualCenter}>
        <Animated.View style={[styles.avatar, {
          backgroundColor: contactAvatarBase64 ? 'transparent' : accentColor,
          transform: [{ scale: avatarScale }],
          overflow: 'hidden',
        }]}>
          {contactAvatarBase64 ? (
            <Image
              source={{ uri: contactAvatarBase64 }}
              style={{ width: 88, height: 88, borderRadius: 44 }}
              resizeMode="cover"
            />
          ) : (
            <Text style={styles.avatarText}>{initial}</Text>
          )}
        </Animated.View>

        <Animated.View style={[styles.checkBadge, {
          transform: [{ scale: checkScale }],
        }]}>
          <Ionicons name="checkmark" size={14} color={colors.background} />
        </Animated.View>
      </View>

      {/* ═══ Title ═══ */}
      <Animated.Text style={[styles.title, {
        opacity: titleOpacity,
        transform: [{ translateY: titleTranslateY }],
      }]}>
        {t('connectionSuccess.title')}
      </Animated.Text>

      {/* ═══ Subtitle ═══ */}
      <Animated.View style={{
        opacity: subtitleOpacity,
        transform: [{ translateY: subtitleTranslateY }],
        alignItems: 'center' as const,
      }}>
        <Text style={styles.contactName}>{contactName}</Text>
        <Text style={styles.subtitle}>{t('connectionSuccess.connectedVia', { label: inviteLabel })}</Text>
      </Animated.View>

      {/* ═══ Security Badges ═══ */}
      <Animated.View style={[styles.badges, {
        opacity: badgesOpacity,
        transform: [{ translateY: badgesTranslateY }],
      }]}>
        <View style={styles.badge}>
          <View style={styles.badgeIcon}>
            <Ionicons name="shield-checkmark" size={14} color="#34D399" />
          </View>
          <Text style={styles.badgeText}>{t('connectionSuccess.badgeE2E')}</Text>
        </View>
        <View style={styles.badgeSep} />
        <View style={styles.badge}>
          <View style={styles.badgeIcon}>
            <Ionicons name="key" size={14} color="#34D399" />
          </View>
          <Text style={styles.badgeText}>{t('connectionSuccess.badgePQ')}</Text>
        </View>
        <View style={styles.badgeSep} />
        <View style={styles.badge}>
          <View style={styles.badgeIcon}>
            <Ionicons name="eye-off" size={14} color="#34D399" />
          </View>
          <Text style={styles.badgeText}>{t('connectionSuccess.badgeNoTrace')}</Text>
        </View>
      </Animated.View>

      {/* ═══ Actions ═══ */}
      <View style={styles.actions}>
        <Animated.View style={{
          opacity: buttonOpacity,
          transform: [{ translateY: buttonTranslateY }],
          width: '100%' as const,
        }}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleOpenConversation}
            activeOpacity={0.85}
          >
            <Ionicons
              name="chatbubble"
              size={18}
              color={colors.background}
              style={{ marginRight: 8 }}
            />
            <Text
              style={styles.primaryButtonText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
            >
              {t('connectionSuccess.startChatting')}
            </Text>
          </TouchableOpacity>
        </Animated.View>

        <Animated.View style={{ opacity: laterOpacity }}>
          <TouchableOpacity
            style={styles.laterButton}
            onPress={handleLater}
            activeOpacity={0.6}
          >
            <Text
              style={styles.laterText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {t('app.later')}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  visualCenter: {
    width: 160,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  avatarText: {
    fontSize: 30,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  checkBadge: {
    position: 'absolute',
    bottom: 28,
    right: 28,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.background,
    shadowColor: '#34D399',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 6,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: 12,
    textAlign: 'center',
  },
  contactName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#00D9A6',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  tagline: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: 28,
    opacity: 0.8,
  },
  badges: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(139, 164, 184, 0.10)',
    marginBottom: 36,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 3,
  },
  badgeIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(52, 211, 153, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '500',
    flex: 1,
  },
  badgeSep: {
    height: 1,
    backgroundColor: 'rgba(240, 244, 248, 0.04)',
    marginVertical: 8,
    marginLeft: 40,
  },
  actions: {
    width: '100%',
    alignItems: 'center',
    gap: 12,
  },
  primaryButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00D9A6',
    borderRadius: 16,
    paddingVertical: 17,
    shadowColor: '#00D9A6',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.background,
    letterSpacing: -0.2,
  },
  laterButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  laterText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textMuted,
  },
}) as const;

export default ConnectionSuccessScreen;