// src/screens/Create1to1Screen.tsx
// Écran de création d'invitation 1-à-1
// Présenté en modal — lance la création crypto, puis navigue vers InviteDetail
// La liste des invitations vit dans ConversationListScreen

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  Platform,
  Animated,
  Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { sessionService } from '../services/tripleRatchet';
import { pendingInviteStore } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { ensureSealedSenderBootstrap, resetSealedSenderBootstrap } from '../services/api1to1';
import { theme } from '../components/ui';

type RootStackParamList = {
  ConversationList: undefined;
  InviteDetail: { tag: string };
  Create1to1: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Create1to1'>;

export function Create1to1Screen() {
  const navigation = useNavigation<NavigationProp>();
  const [step, setStep] = useState(0);
  const spinAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const checkScale = useRef(new Animated.Value(0)).current;

  const steps = [
    'Génération X25519…',
    'Encapsulation ML-KEM-768…',
    'Upload du bundle chiffré…',
    'Invitation créée ✓',
  ];

  useEffect(() => {
    // Fade in
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();

    // Spinner
    Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ).start();

    // Animate step labels
    const t1 = setTimeout(() => setStep(1), 400);
    const t2 = setTimeout(() => setStep(2), 800);

    // FIX: Déclencher le bootstrap sealed sender ET attendre sa complétion.
    // Sans l'await, createInvite() démarre avant que le bootstrap soit terminé
    // → isSealedSenderReady() retourne false → timeout 15s.
    const doCreate = async () => {
      try {
        const bootstrapOk = await ensureSealedSenderBootstrap();
        if (!bootstrapOk) {
          // Le bootstrap a échoué — retry avec un fresh bootstrap
          __DEV__ && console.log('[Create1to1] ⚠️ Bootstrap failed, retrying...');
          resetSealedSenderBootstrap();
          await ensureSealedSenderBootstrap();
        }
      } catch (e) {
        __DEV__ && console.warn('[Create1to1] Bootstrap error:', e);
      }
      // createInvite gère ses propres erreurs via Alert
      createInvite();
    };
    doCreate();

    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const createInvite = async () => {
    try {
      await sessionService.initialize();
      const result = await sessionService.createInvite();

      if (!result.inviteData.tag) throw new Error('Aucun tag généré');

      const invite = await pendingInviteStore.add(
        result.inviteData.tag,
        result.inviteString,
        result.keyIds,
      );

      inviteWatcher.forcePoll();

      // Show success
      setStep(3);
      Animated.spring(checkScale, {
        toValue: 1,
        tension: 100,
        friction: 6,
        useNativeDriver: true,
      }).start();

      // Navigate to detail after brief pause
      setTimeout(() => {
        navigation.replace('InviteDetail', { tag: invite.tag });
      }, 600);
    } catch (e: any) {
      console.error('[Create1to1] Error:', e);
      Alert.alert('Erreur', e.message || "Impossible de créer l'invitation", [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  };

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* Spinner / Check */}
      <View style={styles.spinnerWrap}>
        {step < 3 ? (
          <Animated.View style={[styles.spinner, { transform: [{ rotate: spin }] }]} />
        ) : (
          <Animated.View style={[styles.checkCircle, { transform: [{ scale: checkScale }] }]}>
            <Text style={styles.checkMark}>✓</Text>
          </Animated.View>
        )}
      </View>

      {/* Steps */}
      <View style={styles.stepsWrap}>
        {steps.map((s, i) => (
          <Text
            key={i}
            style={[
              styles.stepText,
              {
                color: i < step
                  ? theme.colors.textMuted
                  : i === step
                    ? theme.colors.text
                    : 'transparent',
                opacity: i <= step ? 1 : 0,
              },
            ]}
          >
            {s}
          </Text>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinnerWrap: {
    marginBottom: 24,
  },
  spinner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2.5,
    borderColor: theme.colors.surfaceLight,
    borderTopColor: theme.colors.primary,
  },
  checkCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(52, 211, 153, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: {
    fontSize: 24,
    color: '#34D399',
  },
  stepsWrap: {
    alignItems: 'center',
    gap: 4,
  },
  stepText: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: -0.3,
  },
});

export default Create1to1Screen;