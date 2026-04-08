// src/services/pushNotificationService.ts
// GHOSTR — Push Notification Service (Client)
// v9.0 — Expo-only notifications (zero native call screens)
//
// ARCHITECTURE:
//   IN-APP:   IncomingCallOverlay (React plein écran, nom E2E)
//             Sonnerie via call1to1Service.startRingtone() / InCallManager
//             Aucune notification système
//
//   HORS-APP: expo-notifications "Quelqu'un essaie de vous joindre"
//             Android: FLAG_INSISTENT (via withInsistentRingtone plugin)
//                      boucle le son en continu
//             iOS: Son 30s + re-trigger 28s en foreground
//                  APNs push joue le son une fois en background
//             Tap notification → ouvre l'app → IncomingCallOverlay
//
// SÉCURITÉ: Aucune donnée identifiable dans les notifications OS.
// Le nom de l'appelant n'apparaît JAMAIS dans les notifications.

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform, Vibration, AppState } from 'react-native';
import { Asset } from 'expo-asset';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptIfEnabled, decryptIfNeeded } from './localCrypto';

// ============================================
// CONFIGURATION
// ============================================

const PUSH_PROXY_PUBLIC_KEY = process.env.EXPO_PUBLIC_PUSH_PROXY_PUBLIC_KEY || '';
const PUSH_ENABLED_KEY = '@ghostr_push_enabled';
const PEER_TOKEN_PREFIX = '@ghostr_peer_push_';
const NOTIF_ONBOARDING_KEY = '@ghostr_notif_onboarding_done';

const PADDED_PLAINTEXT_SIZE = 256;
const ENCRYPTED_BLOB_SIZE = 32 + 24 + PADDED_PLAINTEXT_SIZE + 16;

const CALL_RING_TIMEOUT_MS = 90_000;

// Ring re-trigger (iOS + fallback)
const RING_RETRIGGER_MS = 28_000;
let _ringTimer: ReturnType<typeof setInterval> | null = null;

// ============================================
// STATE
// ============================================

let _pushEnabled = false;
let _nativeToken: string | null = null;
let _platform: 'fcm' | 'apns' | null = null;
let _onWakeUpCallback: (() => Promise<void>) | null = null;
let _notificationSubscription: Notifications.EventSubscription | null = null;
let _responseSubscription: Notifications.EventSubscription | null = null;
let _tokenChangeSubscription: Notifications.EventSubscription | null = null;
let _isRinging = false;

let _onNativeAnswerCallback: (() => void) | null = null;
let _onNativeDeclineCallback: (() => void) | null = null;

// Missed call dedup
let _lastMissedCallNotifKey: string | null = null;
let _lastMissedCallNotifTime: number = 0;
const MISSED_CALL_DEDUP_WINDOW_MS = 60_000;

// ============================================
// NOTIFICATION ONBOARDING
// ============================================

export async function hasCompletedNotificationOnboarding(): Promise<boolean> {
  try {
    const done = await AsyncStorage.getItem(NOTIF_ONBOARDING_KEY);
    return done === 'true';
  } catch { return false; }
}

export async function markNotificationOnboardingDone(): Promise<void> {
  try { await AsyncStorage.setItem(NOTIF_ONBOARDING_KEY, 'true'); } catch {}
}

// ============================================
// NOTIFICATION HANDLER
// ============================================

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data;

    // ── Appel entrant (t='c') ──
    // Android: Le push FCM est de type notification+data avec channel_id.
    //   Foreground → supprimer (IncomingCallOverlay gère l'affichage)
    //   Background → LAISSER PASSER pour que Android affiche la
    //   notification sur le bon canal (vibration + son distinctifs).
    //   Si on retourne shouldShowBanner:false ici, expo-notifications
    //   supprime la notification FCM même en background.
    if (data?.t === 'c') {
      if (_onWakeUpCallback) {
        try { await _onWakeUpCallback(); } catch {}
      }
      const isForeground = AppState.currentState === 'active';
      if (isForeground) {
        // Foreground: IncomingCallOverlay React prend le relais
        return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
      }
      // Background/killed: laisser Android afficher la notification
      // sur le canal ghostr-incoming-calls-v2 (son + vibration distincts)
      return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
    }

    // ── Wake-up et annulation d'appel (t='w', t='h') ──
    // Toujours supprimer — ce sont des signaux internes, pas des
    // notifications visibles pour l'utilisateur.
    if (data && (data.t === 'w' || data.t === 'h')) {
      if (_onWakeUpCallback) {
        try { await _onWakeUpCallback(); } catch {}
      }
      return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
    }

    return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true };
  },
});

// ============================================
// BACKGROUND TASK
// ============================================

const BACKGROUND_NOTIFICATION_TASK = 'GHOSTR_BACKGROUND_NOTIFICATION';
export { BACKGROUND_NOTIFICATION_TASK };

// ============================================
// PADDING & CRYPTO
// ============================================

function padPlaintext(data: Uint8Array): Uint8Array {
  if (data.length > PADDED_PLAINTEXT_SIZE - 2) throw new Error('Push token data too large');
  const padded = new Uint8Array(PADDED_PLAINTEXT_SIZE);
  padded[0] = (data.length >> 8) & 0xFF;
  padded[1] = data.length & 0xFF;
  padded.set(data, 2);
  padded.set(nacl.randomBytes(PADDED_PLAINTEXT_SIZE - 2 - data.length), 2 + data.length);
  return padded;
}

export function encryptPushBlob(
  token: string, platform: 'fcm' | 'apns', isCall: boolean,
  isCallCancel: boolean = false, isMissedCall: boolean = false
): string {
  if (!PUSH_PROXY_PUBLIC_KEY) return generateRandomPushBlob();
  const proxyPubKey = decodeBase64(PUSH_PROXY_PUBLIC_KEY);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    token, platform, is_call: isCall, is_call_cancel: isCallCancel, is_missed_call: isMissedCall,
  }));
  const padded = padPlaintext(plaintext);
  const ephKeyPair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(padded, nonce, proxyPubKey, ephKeyPair.secretKey);
  if (!ciphertext) return generateRandomPushBlob();
  const blob = new Uint8Array(ENCRYPTED_BLOB_SIZE);
  blob.set(ephKeyPair.publicKey, 0);
  blob.set(nonce, 32);
  blob.set(ciphertext, 56);
  ephKeyPair.secretKey.fill(0);
  return encodeBase64(blob);
}

export function generateRandomPushBlob(): string {
  return encodeBase64(nacl.randomBytes(ENCRYPTED_BLOB_SIZE));
}

// ============================================
// PEER PUSH TOKEN STORAGE
// ============================================

const PEER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function storePeerPushToken(sessionId: string, token: string, platform: 'fcm' | 'apns'): Promise<void> {
  const encrypted = encryptIfEnabled(JSON.stringify({ token, platform, storedAt: Date.now() }));
  await AsyncStorage.setItem(`${PEER_TOKEN_PREFIX}${sessionId}`, encrypted);
}

export async function getPeerPushToken(sessionId: string): Promise<{ token: string; platform: 'fcm' | 'apns' } | null> {
  try {
    const data = await AsyncStorage.getItem(`${PEER_TOKEN_PREFIX}${sessionId}`);
    if (!data) return null;
    const parsed = JSON.parse(decryptIfNeeded(data));
    if (parsed.storedAt && Date.now() - parsed.storedAt > PEER_TOKEN_TTL_MS) {
      await deletePeerPushToken(sessionId);
      return null;
    }
    return { token: parsed.token, platform: parsed.platform };
  } catch { return null; }
}

export async function deletePeerPushToken(sessionId: string): Promise<void> {
  await AsyncStorage.removeItem(`${PEER_TOKEN_PREFIX}${sessionId}`);
}

export async function createPushBlobForPeer(sessionId: string, isCall: boolean, isCallCancel = false, isMissedCall = false): Promise<string> {
  const p = await getPeerPushToken(sessionId);
  return p ? encryptPushBlob(p.token, p.platform, isCall, isCallCancel, isMissedCall) : generateRandomPushBlob();
}

export function getOwnPushTokenInfo(): { token: string; platform: 'fcm' | 'apns' } | null {
  if (!_pushEnabled || !_nativeToken || !_platform) return null;
  return { token: _nativeToken, platform: _platform };
}

// ============================================
// PERMISSIONS & CHANNELS
// ============================================

async function requestNativeToken(): Promise<{ token: string; platform: 'fcm' | 'apns' } | null> {
  if (!Device.isDevice) return null;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('ghostr-messages', {
      name: 'Messages', importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250], lightColor: '#6C63FF',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.SECRET,
    });
    await Notifications.setNotificationChannelAsync('ghostr-missed-calls', {
      name: 'Appels manqués', importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 300], lightColor: '#FF6B6B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.SECRET,
    });
    // ── Migration canal v1 → v2 ──
    // Expo-notifications bug #30762: channelId ignoré en background.
    // Le canal v2 est utilisé via FCM notification.channel_id dans le
    // push-proxy, ce qui bypasse le bug (routage natif Android).
    // On supprime l'ancien canal pour éviter la confusion dans les
    // paramètres de notification de l'utilisateur.
    try { await Notifications.deleteNotificationChannelAsync('ghostr-incoming-calls'); } catch {}

    await Notifications.setNotificationChannelAsync('ghostr-incoming-calls-v2', {
      name: 'Appels entrants', importance: Notifications.AndroidImportance.MAX,
      // ~10s de vibration distincte des messages
      vibrationPattern: [
        0,   800, 200, 800,
        600, 800, 200, 800,
        600, 800, 200, 800,
        600, 800, 200, 800,
        600, 800, 200, 800,
      ],
      lightColor: '#6C63FF',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.SECRET,
      bypassDnd: true,
      sound: 'incallmanager_ringback',
    });
  }

  try {
    const r = await Notifications.getDevicePushTokenAsync();
    return { token: r.data as string, platform: Platform.OS === 'ios' ? 'apns' : 'fcm' };
  } catch { return null; }
}

// ============================================
// NOTIFICATIONS MESSAGES
// ============================================

export async function showLocalNotification(params: {
  title: string; body: string; sessionId: string; isCall?: boolean;
}): Promise<void> {
  if (params.isCall) { await showIncomingCallNotification(); return; }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: params.title, body: params.body,
      data: { sessionId: params.sessionId, t: 'w' },
      ...(Platform.OS === 'android' && { channelId: 'ghostr-messages' }),
    },
    trigger: null,
  });
}

// ============================================
// APPEL ENTRANT
// ============================================

export async function showIncomingCallNotification(): Promise<void> {
  if (_isRinging) return;

  // ════════════════════════════════════════════════════════════
  // FOREGROUND: Pas de notification système.
  // IncomingCallOverlay (React) + call1to1Service.startRingtone()
  // ════════════════════════════════════════════════════════════
  if (AppState.currentState === 'active') {
    _isRinging = true;
    return;
  }

  // ════════════════════════════════════════════════════════════
  // BACKGROUND / KILLED: expo-notifications
  //
  // ANDROID:
  //   Le push FCM inclut notification.channel_id → route vers
  //   ghostr-incoming-calls-v2 NATIVEMENT (bypass bug expo #30762).
  //   Le plugin withInsistentRingtone ajoute FLAG_INSISTENT.
  //   → Vibration ~10s + son en boucle via le canal.
  //
  // iOS:
  //   Apple ne permet PAS aux apps de contrôler la vibration des
  //   notifications. Tous les tiers reçoivent une seule vibration.
  //   Ce qu'on peut faire :
  //   1. Son custom (ghostr_ringtone.mp3) → différent du "default"
  //   2. Vibration.vibrate() depuis le JS (si app pas killed)
  //      → pattern distinctif ~10s de double-buzzes
  //   3. interruption-level: time-sensitive → bypass Focus modes
  //   App killed → seul le son APNs joue (pas de JS = pas de vibration)
  //
  // Tap:     expo-notifications ouvre l'app naturellement.
  //          Le response listener appelle stopRinging().
  //          IncomingCallOverlay s'affiche avec le nom E2E.
  // ════════════════════════════════════════════════════════════
  _isRinging = true;

  if (Platform.OS === 'ios') {
    // iOS: notification locale avec son custom + re-trigger 28s
    await _scheduleCallNotification();

    // Vibration distinctive ~10s (format iOS)
    // iOS: TOUS les nombres = durée de PAUSE entre vibrations
    // Chaque vibration dure ~400ms (fixe, non configurable par Apple)
    // Pattern "double-buzz + silence" × 5 ≈ 10s
    // Ce call ne fonctionne que si le JS tourne (app background, pas killed)
    // App killed → seul le son APNs joue (ghostr_ringtone.mp3)
    Vibration.vibrate([
      0, 200,        // ring 1 : buzz-buzz (2×400ms, séparés de 200ms)
      1000,          // silence
      0, 200,        // ring 2
      1000,          // silence
      0, 200,        // ring 3
      1000,          // silence
      0, 200,        // ring 4
      1000,          // silence
      0, 200,        // ring 5
    ]);

    _stopRingTimer();
    _ringTimer = setInterval(async () => {
      if (!_isRinging) { _stopRingTimer(); return; }
      await _scheduleCallNotification();
    }, RING_RETRIGGER_MS);
  }
  // Android: rien à faire ici — le push FCM a déjà créé la
  // notification sur le bon canal avec vibration + son.
}

async function _scheduleCallNotification(): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: 'ghostr_incoming_call',
    content: {
      title: 'Ghostr',
      body: `Quelqu'un essaie de vous joindre`,
      subtitle: Platform.OS === 'ios' ? 'Appel chiffré' : undefined,
      categoryIdentifier: 'incoming_call',
      sound: Platform.OS === 'ios' ? 'ghostr_ringtone.mp3' : 'incallmanager_ringback',
      data: { t: 'call_ring', isCall: true },
      interruptionLevel: 'timeSensitive' as any,
      ...(Platform.OS === 'android' && {
        channelId: 'ghostr-incoming-calls-v2',
        sticky: true,
        autoDismiss: false,
      }),
    },
    trigger: null,
  });
}

function _stopRingTimer(): void {
  if (_ringTimer) { clearInterval(_ringTimer); _ringTimer = null; }
}

export async function stopRinging(): Promise<void> {
  _isRinging = false;
  _stopRingTimer();
  Vibration.cancel();
  await dismissCallNotification();
}

export function isRinging(): boolean { return _isRinging; }

export function setNativeCallCallbacks(onAnswer: () => void, onDecline: () => void): void {
  _onNativeAnswerCallback = onAnswer;
  _onNativeDeclineCallback = onDecline;
}

// ============================================
// APPEL MANQUÉ
// ============================================

export async function showMissedCallNotification(callerName: string): Promise<void> {
  const now = Date.now();
  if (_lastMissedCallNotifKey === callerName && now - _lastMissedCallNotifTime < MISSED_CALL_DEDUP_WINDOW_MS) return;
  _lastMissedCallNotifKey = callerName;
  _lastMissedCallNotifTime = now;
  await stopRinging();
  await new Promise(r => setTimeout(r, 200));
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Ghostr',
      body: 'Appel manqué',
      subtitle: Platform.OS === 'ios' ? 'Ouvrez pour voir les détails' : undefined,
      data: { t: 'missed' },
      ...(Platform.OS === 'android' && { channelId: 'ghostr-missed-calls' }),
    },
    trigger: null,
  });
}

export async function dismissCallNotification(): Promise<void> {
  try {
    try { await Notifications.dismissNotificationAsync('ghostr_incoming_call'); } catch {}
    const all = await Notifications.getPresentedNotificationsAsync();
    for (const n of all) {
      const d = n.request.content.data;
      const b = n.request.content.body || '';
      if (d?.t === 'c' || d?.t === 'call_ring' || d?.t === 'h' || d?.isCall
        || b.includes('Appel vocal') || b.includes('Appel entrant')
        || b.includes('essaie de vous joindre'))
        await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch {}
}

// ============================================
// CATÉGORIE iOS
// ============================================

const IOS_DISMISS_ACTION_ID = 'com.apple.UNNotificationDismissActionIdentifier';

async function setupCallNotificationCategory(): Promise<void> {
  await Notifications.setNotificationCategoryAsync('incoming_call', [
    { identifier: 'answer_call', buttonTitle: 'Ouvrir', options: { opensAppToForeground: true } },
    { identifier: 'decline_call', buttonTitle: 'Ignorer', options: { opensAppToForeground: false, isDestructive: true } },
  ], { customDismissAction: true });
}

// ============================================
// INITIALISATION
// ============================================

export async function initPushNotifications(onWakeUp: () => Promise<void>): Promise<boolean> {
  const pushEnabled = await AsyncStorage.getItem(PUSH_ENABLED_KEY);
  if (pushEnabled === 'false') return false;
  if (!PUSH_PROXY_PUBLIC_KEY) return false;

  _onWakeUpCallback = onWakeUp;
  const tokenResult = await requestNativeToken();
  if (!tokenResult) return false;
  _nativeToken = tokenResult.token;
  _platform = tokenResult.platform;
  _pushEnabled = true;

  await setupCallNotificationCategory();

  _tokenChangeSubscription = Notifications.addPushTokenListener((t) => { _nativeToken = t.data as string; });

  _notificationSubscription = Notifications.addNotificationReceivedListener((n) => {
    const d = n.request.content.data;
    if (d?.t === 'w' || d?.t === 'c' || d?.t === 'h')
      __DEV__ && console.log(`[PushService] Wake-up (${d.t})`);
  });

  _responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const actionId = response.actionIdentifier;
    const data = response.notification.request.content.data;

    if (actionId === 'answer_call') {
      stopRinging();
      _onNativeAnswerCallback?.();
      return;
    }
    if (actionId === 'decline_call') {
      stopRinging();
      _onNativeDeclineCallback?.();
      return;
    }
    if (actionId === IOS_DISMISS_ACTION_ID) {
      if (data?.isCall || data?.t === 'call_ring') {
        stopRinging();
        _onNativeDeclineCallback?.();
      }
      return;
    }
    if (actionId === Notifications.DEFAULT_ACTION_IDENTIFIER) {
      if (data?.isCall || data?.t === 'call_ring' || data?.t === 'c') {
        // Tap notification body → app s'ouvre.
        // Stopper la notification (son + vibration).
        // IncomingCallOverlay prend le relais.
        stopRinging();
      }
    }
  });

  await AsyncStorage.setItem(PUSH_ENABLED_KEY, 'true');
  return true;
}

// ============================================
// CONTRÔLE
// ============================================

export async function setPushEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(PUSH_ENABLED_KEY, enabled ? 'true' : 'false');
  _pushEnabled = enabled;
  if (!enabled) {
    _notificationSubscription?.remove(); _responseSubscription?.remove(); _tokenChangeSubscription?.remove();
    _notificationSubscription = null; _responseSubscription = null; _tokenChangeSubscription = null;
    _nativeToken = null; _platform = null;
    await stopRinging();
  }
}

export function isPushEnabled(): boolean { return _pushEnabled; }

export function cleanupPushNotifications(): void {
  _notificationSubscription?.remove(); _responseSubscription?.remove(); _tokenChangeSubscription?.remove();
  _notificationSubscription = null; _responseSubscription = null; _tokenChangeSubscription = null;
  _onWakeUpCallback = null; _onNativeAnswerCallback = null; _onNativeDeclineCallback = null;
  _nativeToken = null; _platform = null; _pushEnabled = false; _isRinging = false;
  _stopRingTimer(); Vibration.cancel();
}