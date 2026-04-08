// src/screens/Create1to1Screen.tsx
// Création d'invitation 1-à-1
// Utilise SplashScreen comme loading universel

import React, { useEffect, useRef, useState } from 'react';
import { Alert, BackHandler } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { sessionService } from '../services/tripleRatchet';
import { pendingInviteStore } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { ensureSealedSenderBootstrap, resetSealedSenderBootstrap } from '../services/api1to1';
import { SplashScreen } from './SplashScreen';

type RootStackParamList = {
  ConversationList: undefined;
  InviteDetail: { tag: string };
  Create1to1: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Create1to1'>;

export function Create1to1Screen() {
  const navigation = useNavigation<NavigationProp>();
  const [statusMessage, setStatusMessage] = useState('Préparation du chiffrement…');

  useEffect(() => {
    // Block back button during creation
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => backHandler.remove();
  }, []);

  useEffect(() => {
    // Progress messages
    const t1 = setTimeout(() => setStatusMessage('Génération des clés X25519…'), 400);
    const t2 = setTimeout(() => setStatusMessage('Encapsulation ML-KEM-768…'), 800);

    const doCreate = async () => {
      try {
        const bootstrapOk = await ensureSealedSenderBootstrap();
        if (!bootstrapOk) {
          __DEV__ && console.log('[Create1to1] ⚠️ Bootstrap failed, retrying...');
          resetSealedSenderBootstrap();
          await ensureSealedSenderBootstrap();
        }
      } catch (e) {
        __DEV__ && console.warn('[Create1to1] Bootstrap error:', e);
      }
      createInvite();
    };
    doCreate();

    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const createInvite = async () => {
    try {
      setStatusMessage('Création de l\'invitation…');
      await sessionService.initialize();
      const result = await sessionService.createInvite();

      if (!result.inviteData.tag) throw new Error('Aucun tag généré');

      const invite = await pendingInviteStore.add(
        result.inviteData.tag,
        result.inviteString,
        result.keyIds,
      );

      inviteWatcher.forcePoll();

      setStatusMessage('Invitation créée');

      setTimeout(() => {
        navigation.replace('InviteDetail', { tag: invite.tag });
      }, 500);
    } catch (e: any) {
      console.error('[Create1to1] Error:', e);
      Alert.alert('Erreur', e.message || "Impossible de créer l'invitation", [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  };

  return <SplashScreen statusMessage={statusMessage} />;
}

export default Create1to1Screen;
