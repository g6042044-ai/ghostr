// src/hooks/useCall1to1.tsx
// v12.0 — Full-screen incoming call overlay + all cleanup fixes
//
// COMPORTEMENT:
//   ✅ Appel entrant in-app → IncomingCallOverlay plein écran (nom E2E)
//   ✅ Appel entrant hors-app → notification native "Quelqu'un essaie de vous joindre"
//   ✅ "Ouvrir" sur notification → ouvre l'app → IncomingCallOverlay avec nom E2E
//   ✅ stopRinging() appelé pour TOUT changement d'état (ended, connected, etc.)
//   ✅ ActiveCallOverlay pour appel connecté
//   ✅ Aucune notification système en foreground
//
// SÉCURITÉ:
//   - Le nom de l'appelant est visible UNIQUEMENT dans l'app (déchiffré E2E)
//   - Les notifications OS restent 100% génériques ("Appel chiffré")
//   - Aucune fuite de métadonnées via la bannière (rendue côté client uniquement)

import React, {
  createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode,
} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Vibration,
  Modal, Platform, Image, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../components/ui/theme';
import { Avatar } from '../components/Avatar';
import {
  Call1to1Info,
  CallSignalData,
  startCall1to1,
  acceptCall1to1,
  declineCall1to1,
  hangupCall1to1,
  toggleMute1to1,
  toggleSpeaker1to1,
  addCall1to1StateListener,
  addIncomingCall1to1Listener,
  setCall1to1SignalCallback,
  handleCall1to1Signal,
  getCall1to1State,
} from '../services/call1to1Service';
import { sendCallSignal1to1, onCallSignal, consumePendingCallSignals, pollAllSessions } from '../services/api1to1';
import { stopRinging, setNativeCallCallbacks } from '../services/pushNotificationService';

// ── Helpers ──

function getInitials(name: string): string {
  if (!name.trim()) return '?';
  const p = name.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : name.trim().substring(0, 2).toUpperCase();
}

function avatarColor(name: string): string {
  const c = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#A78BFA','#F7DC6F','#DDA0DD','#FF8C42','#6BCB77','#4D96FF'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return c[Math.abs(h) % c.length];
}

// ── Context ──

interface Call1to1ContextValue {
  callInfo: Call1to1Info | null;
  isInCall: boolean;
  hasIncomingCall: boolean;
  incomingCallInfo: { sessionId: string; callId: string; callerName: string; callerAvatarBase64?: string } | null;
  startCall: (sessionId: string, contactName: string) => Promise<{ success: boolean; error?: string }>;
  acceptCall: () => Promise<{ success: boolean; error?: string }>;
  declineCall: () => Promise<{ success: boolean; error?: string }>;
  hangup: () => Promise<{ success: boolean; error?: string }>;
  toggleMute: () => boolean;
  toggleSpeaker: () => boolean;
}

const Call1to1Context = createContext<Call1to1ContextValue | null>(null);

// ── Provider ──

export const Call1to1Provider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [callInfo, setCallInfo] = useState<Call1to1Info | null>(null);
  const [incomingCallInfo, setIncomingCallInfo] = useState<{
    sessionId: string; callId: string; callerName: string; callerAvatarBase64?: string;
  } | null>(null);

  useEffect(() => {
    const unsub1 = addCall1to1StateListener((info) => {
      if (info?.state === 'ended' || !info) {
        // ── CLEANUP: stopper sonnerie + notification native ──
        // Couvre TOUS les scénarios: timeout, remote_hangup, decline, error.
        // Sans ça, la notification Android native persiste après un timeout.
        stopRinging();
        setCallInfo(null);
        setIncomingCallInfo(null);
      } else {
        setCallInfo(info);
      }
      if (info?.state === 'connecting' || info?.state === 'connected') {
        stopRinging();
        setIncomingCallInfo(null);
      }
    });

    const unsub2 = addIncomingCall1to1Listener((sid, cid, name, avatar) => {
      setIncomingCallInfo({ sessionId: sid, callId: cid, callerName: name, callerAvatarBase64: avatar });
    });

    setCall1to1SignalCallback(async (sid: string, sig: CallSignalData) => {
      await sendCallSignal1to1(sid, sig.type, sig.callId, sig.roomTag, sig.authToken,
        sig.senderKey ? JSON.stringify(sig.senderKey) : undefined,
        sig.cryptoSignal ? JSON.stringify(sig.cryptoSignal) : undefined,
        sig.callStartedAt);
    });

    const unsub3 = onCallSignal((sid, sig, name, avatar) => {
      handleCall1to1Signal(sid, {
        type: sig.type, callId: sig.callId, roomTag: sig.roomTag, authToken: sig.authToken,
        senderKey: sig.senderKeyDistribution ? JSON.parse(sig.senderKeyDistribution) : undefined,
        cryptoSignal: sig.cryptoSignal ? JSON.parse(sig.cryptoSignal) : undefined,
        callStartedAt: sig.callStartedAt, timestamp: sig.timestamp,
      }, name, avatar);
    });

    // Check for pending incoming call (app opened from native notification)
    const pendingState = getCall1to1State();
    if (pendingState?.state === 'incoming') {
      setCallInfo(pendingState);
      setIncomingCallInfo({
        sessionId: pendingState.sessionId,
        callId: pendingState.callId,
        callerName: pendingState.remoteDisplayName,
        callerAvatarBase64: pendingState.remoteAvatarBase64,
      });
      // Poll immédiat: vérifier que l'appel est toujours actif.
      // Si l'appelant a raccroché entre-temps (cancel push raté ou
      // traité pendant que l'app était killed), le poll récupère le
      // signal hangup → endCall('remote_hangup') → state='ended'
      // → le listener ci-dessus fera setIncomingCallInfo(null).
      pollAllSessions().catch(() => {});
    }

    // Consume buffered call signals
    const pendingSignals = consumePendingCallSignals();
    for (const p of pendingSignals) {
      try {
        handleCall1to1Signal(p.sessionId, {
          type: p.signal.type,
          callId: p.signal.callId,
          roomTag: p.signal.roomTag,
          authToken: p.signal.authToken,
          senderKey: p.signal.senderKeyDistribution ? JSON.parse(p.signal.senderKeyDistribution) : undefined,
          cryptoSignal: p.signal.cryptoSignal ? JSON.parse(p.signal.cryptoSignal) : undefined,
          callStartedAt: p.signal.callStartedAt,
          timestamp: p.signal.timestamp,
        }, p.senderName, p.senderAvatarBase64);
      } catch (e) {
        __DEV__ && console.error('[useCall1to1] Error processing pending call signal:', e);
      }
    }

    // Native call callbacks (Android notification, iOS CallKit)
    //
    // "Ouvrir": Stoppe la sonnerie native, l'app s'ouvre et
    // l'IncomingCallOverlay plein ecran prend le relais (nom E2E).
    // On n'accepte PAS l'appel — l'utilisateur choisit depuis l'overlay.
    //
    // "Ignorer" / iOS dismiss: Refuse l'appel.
    setNativeCallCallbacks(
      () => {
        stopRinging();
        // Poll immédiat: si l'appelant a raccroché entre-temps,
        // le signal hangup fermera l'overlay automatiquement.
        pollAllSessions().catch(() => {});
        __DEV__ && console.log('[useCall1to1] Native open: app opened, polling to verify call');
      },
      () => {
        stopRinging();
        declineCall1to1().then(() => {
          setIncomingCallInfo(null);
        }).catch(() => {});
      },
    );

    return () => { unsub1(); unsub2(); unsub3(); setNativeCallCallbacks(() => {}, () => {}); };
  }, []);

  const startCall = useCallback(async (sid: string, name: string) => startCall1to1(sid, name), []);

  const acceptCall = useCallback(async () => {
    stopRinging();
    const r = await acceptCall1to1();
    if (r.success) { setIncomingCallInfo(null); }
    return r;
  }, []);

  const declineCall = useCallback(async () => {
    stopRinging();
    const r = await declineCall1to1();
    setIncomingCallInfo(null);
    return r;
  }, []);

  const hangup = useCallback(async () => {
    stopRinging();
    setCallInfo(null);
    return hangupCall1to1();
  }, []);

  const toggleMute = useCallback(() => toggleMute1to1(), []);
  const toggleSpeaker = useCallback(() => toggleSpeaker1to1(), []);

  const isInCall = callInfo !== null && callInfo.state !== 'idle' && callInfo.state !== 'ended';

  return (
    <Call1to1Context.Provider value={{
      callInfo, isInCall, hasIncomingCall: incomingCallInfo !== null,
      incomingCallInfo, startCall, acceptCall, declineCall, hangup, toggleMute, toggleSpeaker,
    }}>
      {children}

      {/* ── APPEL ENTRANT: Overlay plein écran (nom déchiffré E2E) ── */}
      {incomingCallInfo && (
        <IncomingCallOverlay
          callerName={incomingCallInfo.callerName}
          callerAvatarBase64={incomingCallInfo.callerAvatarBase64}
          onAccept={acceptCall}
          onDecline={declineCall}
        />
      )}

      {/* ── APPEL ACTIF: Overlay plein écran ── */}
      {callInfo && callInfo.state !== 'idle' && callInfo.state !== 'ended' && callInfo.state !== 'incoming' && (
        <ActiveCallOverlay
          callInfo={callInfo}
          onHangup={hangup}
          onToggleMute={toggleMute}
          onToggleSpeaker={toggleSpeaker}
        />
      )}
    </Call1to1Context.Provider>
  );
};

export function useCall1to1(): Call1to1ContextValue {
  const ctx = useContext(Call1to1Context);
  if (!ctx) throw new Error('useCall1to1 must be used within a Call1to1Provider');
  return ctx;
}

// ============================================
// INCOMING CALL — EXPANDED (full screen after tap)
// ============================================

const IncomingCallOverlay: React.FC<{
  callerName: string; callerAvatarBase64?: string; onAccept: () => void; onDecline: () => void;
}> = ({ callerName, callerAvatarBase64, onAccept, onDecline }) => {
  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(0.6)).current;
  const nameSlide = useRef(new Animated.Value(30)).current;
  const btnSlide = useRef(new Animated.Value(60)).current;

  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;

  const accent = avatarColor(callerName);

  useEffect(() => {
    // Staggered entrance
    Animated.stagger(80, [
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.spring(avatarScale, { toValue: 1, tension: 50, friction: 7, useNativeDriver: true }),
      Animated.timing(nameSlide, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(btnSlide, { toValue: 0, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    const pulseRing = (ring: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(ring, { toValue: 1, duration: 2000, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(ring, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const r1 = pulseRing(ring1, 0);
    const r2 = pulseRing(ring2, 600);
    const r3 = pulseRing(ring3, 1200);
    r1.start(); r2.start(); r3.start();

    return () => { r1.stop(); r2.stop(); r3.stop(); };
  }, []);

  const ringStyle = (ring: Animated.Value) => ({
    position: 'absolute' as const,
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 1.5,
    borderColor: accent,
    opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
    transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) }],
  });

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent>
      <Animated.View style={[{ flex: 1, opacity: fadeAnim }]}>
        <LinearGradient
          colors={['#080C10', '#0D1218', '#080C10']}
          style={[StyleSheet.absoluteFillObject]}
        />
        <View style={[s.incomingWrap, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
          {/* Top */}
          <View style={s.incomingTop}>
            <View style={s.encBadge}>
              <Ionicons name="shield-checkmark" size={13} color={theme.colors.success} />
              <Text style={s.encText}>Appel chiffré de bout en bout</Text>
            </View>
          </View>

          {/* Center */}
          <View style={s.incomingCenter}>
            <View style={s.avatarRingsContainer}>
              <Animated.View style={ringStyle(ring1)} />
              <Animated.View style={ringStyle(ring2)} />
              <Animated.View style={ringStyle(ring3)} />
              <Animated.View style={{ transform: [{ scale: avatarScale }] }}>
                <Avatar
                  displayName={callerName}
                  senderToken={callerName}
                  avatarUri={callerAvatarBase64}
                  size="call"
                  backgroundColor={accent}
                />
              </Animated.View>
            </View>

            <Animated.View style={{ alignItems: 'center', opacity: fadeAnim, transform: [{ translateY: nameSlide }] }}>
              <Text style={s.inName}>{callerName}</Text>
              <Text style={s.inSubtitle}>Appel vocal entrant…</Text>
            </Animated.View>
          </View>

          {/* Bottom actions */}
          <Animated.View style={[s.inActions, { transform: [{ translateY: btnSlide }] }]}>
            <TouchableOpacity style={s.inActionCol} onPress={onDecline} activeOpacity={0.75}>
              <View style={s.declineBtn}>
                <Ionicons name="call" size={30} color="#FFF" style={{ transform: [{ rotate: '135deg' }] }} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={s.inActionCol} onPress={onAccept} activeOpacity={0.75}>
              <View style={s.acceptBtn}>
                <Ionicons name="call" size={30} color="#FFF" />
              </View>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </Animated.View>
    </Modal>
  );
};

// ============================================
// ACTIVE CALL
// ============================================

const ActiveCallOverlay: React.FC<{
  callInfo: Call1to1Info;
  onHangup: () => void;
  onToggleMute: () => boolean;
  onToggleSpeaker: () => boolean;
}> = ({ callInfo, onHangup, onToggleMute, onToggleSpeaker }) => {
  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const accent = avatarColor(callInfo.remoteDisplayName);
  const isConnected = callInfo.state === 'connected';

  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    if (callInfo.state === 'outgoing' || callInfo.state === 'connecting') {
      const seq = Animated.loop(Animated.stagger(200, [
        Animated.sequence([
          Animated.timing(dot1, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(dot1, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(dot2, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(dot2, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(dot3, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(dot3, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ]),
      ]));
      seq.start();
      return () => seq.stop();
    }
  }, [callInfo.state]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent>
      <Animated.View style={[{ flex: 1, opacity: fadeAnim }]}>
        <LinearGradient colors={['#080C10', '#0E1319', '#080C10']} style={StyleSheet.absoluteFillObject} />

        <View style={[s.activeWrap, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
          {/* Top bar */}
          <View style={s.activeTop}>
            <View style={s.encBadge}>
              <Ionicons name="shield-checkmark" size={13} color={theme.colors.success} />
              <Text style={s.encText}>Chiffré de bout en bout</Text>
            </View>
          </View>

          {/* Center */}
          <View style={s.activeCenter}>
            <View style={s.acAvatarWrap}>
              <Avatar
                displayName={callInfo.remoteDisplayName}
                senderToken={callInfo.remoteDisplayName}
                avatarUri={callInfo.remoteAvatarBase64}
                size="call"
                backgroundColor={accent}
              />
            </View>

            <Text style={s.acName}>{callInfo.remoteDisplayName}</Text>

            {isConnected ? (
              <View style={s.timerRow}>
                <View style={s.liveDot} />
                <Text style={s.timerText}>{formatDuration(callInfo.duration)}</Text>
              </View>
            ) : (
              <View style={s.connectingRow}>
                <Text style={s.connectingText}>
                  {callInfo.state === 'outgoing' ? 'Appel en cours' : 'Connexion'}
                </Text>
                <View style={s.dotsRow}>
                  <Animated.View style={[s.dot, { opacity: dot1 }]} />
                  <Animated.View style={[s.dot, { opacity: dot2 }]} />
                  <Animated.View style={[s.dot, { opacity: dot3 }]} />
                </View>
              </View>
            )}
          </View>

          {/* Bottom controls */}
          <View style={s.controls}>
            <View style={s.ctrlRow}>
              <ControlButton
                icon={callInfo.isMuted ? 'mic-off' : 'mic'}
                active={callInfo.isMuted}
                onPress={onToggleMute}
              />
              <ControlButton
                icon={callInfo.isSpeakerOn ? 'volume-high' : 'volume-medium'}
                active={callInfo.isSpeakerOn}
                onPress={onToggleSpeaker}
              />
            </View>
            <TouchableOpacity style={s.hangup} onPress={onHangup} activeOpacity={0.8}>
              <Ionicons name="call" size={30} color="#FFF" style={{ transform: [{ rotate: '135deg' }] }} />
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
};

// ── Reusable control button with press animation ──

const ControlButton: React.FC<{
  icon: string; active: boolean; onPress: () => any;
}> = ({ icon, active, onPress }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.88, duration: 80, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, tension: 200, friction: 10, useNativeDriver: true }),
    ]).start();
    onPress();
  };

  return (
    <TouchableOpacity style={s.ctrlCol} onPress={handlePress} activeOpacity={1}>
      <Animated.View style={[
        s.ctrlBtn,
        active && s.ctrlBtnActive,
        { transform: [{ scale: scaleAnim }] },
      ]}>
        <Ionicons
          name={icon as any}
          size={26}
          color={active ? '#0A0F14' : '#F0F4F8'}
        />
      </Animated.View>
    </TouchableOpacity>
  );
};

// ============================================
// STYLES
// ============================================

const AVATAR_SIZE = 110;
const CTRL_SIZE = 64;
const HANGUP_SIZE = 68;

const s = StyleSheet.create({
  // ── Shared ──
  encBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0, 217, 166, 0.08)',
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
  },
  encText: { fontSize: 12, fontWeight: '600', color: theme.colors.success },

  // ── Incoming Expanded ──
  incomingWrap: {
    flex: 1, justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 32,
  },
  incomingTop: { alignItems: 'center' },
  incomingCenter: { alignItems: 'center', gap: 32 },
  avatarRingsContainer: {
    width: AVATAR_SIZE * 2.4, height: AVATAR_SIZE * 2.4,
    alignItems: 'center', justifyContent: 'center',
  },
  inName: { fontSize: 30, fontWeight: '700', color: theme.colors.text, letterSpacing: -0.5, textAlign: 'center' },
  inSubtitle: { fontSize: 16, color: theme.colors.textSecondary, marginTop: 6 },
  inActions: {
    flexDirection: 'row', justifyContent: 'center', width: '100%', gap: 64,
  },
  inActionCol: { alignItems: 'center' },
  declineBtn: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#E74C3C',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#E74C3C', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 10,
  },
  acceptBtn: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#2ECC71',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#2ECC71', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 10,
  },

  // ── Active call ──
  activeWrap: {
    flex: 1, justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 32,
  },
  activeTop: { alignItems: 'center' },
  activeCenter: { alignItems: 'center' },
  acAvatarWrap: {
    width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 14,
    marginBottom: 24,
  },
  acName: { fontSize: 28, fontWeight: '700', color: theme.colors.text, letterSpacing: -0.5, marginBottom: 10 },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.success },
  timerText: {
    fontSize: 18, fontWeight: '600', color: theme.colors.success,
    fontVariant: ['tabular-nums'],
  },
  connectingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  connectingText: { fontSize: 16, fontWeight: '500', color: theme.colors.textSecondary },
  dotsRow: { flexDirection: 'row', gap: 3, marginLeft: 2, marginTop: 2 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: theme.colors.textSecondary },

  // ── Controls ──
  controls: { alignItems: 'center', width: '100%' },
  ctrlRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 32, marginBottom: 32,
  },
  ctrlCol: { alignItems: 'center' },
  ctrlBtn: {
    width: CTRL_SIZE, height: CTRL_SIZE, borderRadius: CTRL_SIZE / 2,
    backgroundColor: 'rgba(240, 244, 248, 0.08)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(240, 244, 248, 0.05)',
  },
  ctrlBtnActive: {
    backgroundColor: '#F0F4F8', borderColor: '#F0F4F8',
  },
  hangup: {
    width: HANGUP_SIZE, height: HANGUP_SIZE, borderRadius: HANGUP_SIZE / 2,
    backgroundColor: '#E74C3C', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#E74C3C', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 10,
  },
});

export default Call1to1Provider;