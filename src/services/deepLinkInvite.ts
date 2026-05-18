// src/services/deepLinkInvite.ts
// Hook qui gère la réception des deep links d'invitation Ghostr.
//
// FLOW :
//   1. Au mount, vérifier si l'app a été lancée via un deep link
//      (Linking.getInitialURL).
//   2. Écouter les nouveaux deep links pendant la durée de vie de
//      l'app (Linking.addEventListener('url')).
//   3. Stocker l'inviteString reçu dans une ref EN MÉMOIRE — jamais
//      en SecureStore ni AsyncStorage. Si l'utilisateur kill l'app
//      avant déverrouillage, l'invitation est perdue (et c'est OK :
//      il pourra rescanner ou recliquer le lien).
//   4. Dès que l'app est complètement initialisée ET déverrouillée,
//      consommer le pending invite et naviguer vers Join1to1.
//
// SÉCURITÉ :
//   - Le inviteString N'EST JAMAIS persisté sur disque (mémoire seule).
//   - Le inviteString N'EST JAMAIS loggé (console.log neutralisé en prod).
//   - On ne traite JAMAIS un invite tant que sessionService n'est pas
//     initialisé : sinon acceptInvite échoue et on perd silencieusement
//     l'invitation.
//   - Si l'app est lockée à l'arrivée du lien, on attend le déverrouillage
//     avant traitement. Le LockScreen s'affiche normalement.

import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { parseInviteString } from './inviteUrl';
import type { RootStackParamList } from '../../App';

interface UseDeepLinkInviteOptions {
  /**
   * Ref de navigation. Utilisée pour naviguer vers Join1to1 dès que
   * l'app est prête. Doit être prête (isReady=true) avant que la
   * navigation puisse aboutir.
   */
  navigationRef: NavigationContainerRefWithCurrent<RootStackParamList>;

  /**
   * True quand l'app est entièrement bootée et déverrouillée.
   * Le hook ne consomme le pending invite QUE quand cette valeur est true.
   */
  appReady: boolean;
}

export function useDeepLinkInvite({ navigationRef, appReady }: UseDeepLinkInviteOptions) {
  // Stockage MÉMOIRE UNIQUEMENT du dernier inviteString reçu, en attente
  // de consommation. Une ref (pas un state) car on ne veut pas re-render
  // App à chaque arrivée de lien.
  const pendingInviteRef = useRef<string | null>(null);

  // Flag pour éviter de re-traiter un invite déjà consommé (anti double-tap).
  const consumingRef = useRef<boolean>(false);

  // ═══════════════════════════════════════════════════════════════════
  // ÉTAPE 1 : Brancher les listeners Linking dès le mount
  // ═══════════════════════════════════════════════════════════════════
  useEffect(() => {
    let cancelled = false;

    // Cold start : l'app a été lancée par un deep link
    Linking.getInitialURL()
      .then((url) => {
        if (cancelled || !url) return;
        const invite = parseInviteString(url);
        if (invite) {
          if (__DEV__) console.log('[DeepLink] cold-start invite received');
          pendingInviteRef.current = invite;
        }
      })
      .catch((e) => {
        if (__DEV__) console.warn('[DeepLink] getInitialURL error:', e);
      });

    // Warm path : nouveau deep link reçu pendant que l'app tourne
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url) return;
      const invite = parseInviteString(url);
      if (invite) {
        if (__DEV__) console.log('[DeepLink] runtime invite received');
        pendingInviteRef.current = invite;
        consumingRef.current = false; // permet de retraiter si nouveau lien
      }
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════════
  // ÉTAPE 2 : Quand l'app est prête, consommer le pending invite
  // ═══════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!appReady) return;
    if (consumingRef.current) return;

    const invite = pendingInviteRef.current;
    if (!invite) return;

    // Attendre que la navigation soit ready (NavigationContainer mounted).
    // En pratique elle l'est dès que appReady=true mais on protège.
    if (!navigationRef.isReady()) {
      // Réessayer au prochain tick
      const t = setTimeout(() => {
        if (navigationRef.isReady() && pendingInviteRef.current) {
          consumePendingInvite();
        }
      }, 50);
      return () => clearTimeout(t);
    }

    consumePendingInvite();

    function consumePendingInvite() {
      const inviteString = pendingInviteRef.current;
      if (!inviteString) return;
      consumingRef.current = true;
      pendingInviteRef.current = null;

      // Naviguer vers Join1to1 avec le pendingInviteString.
      // Join1to1Screen lira ce param et appellera processInvite directement
      // (en sautant l'écran de choix scan/manuel).
      try {
        navigationRef.navigate('Join1to1', { pendingInviteString: inviteString } as any);
      } catch (e) {
        if (__DEV__) console.warn('[DeepLink] navigate failed:', e);
        // En cas d'échec on remet le pending pour réessai
        pendingInviteRef.current = inviteString;
        consumingRef.current = false;
      }
    }
  }, [appReady, navigationRef]);
}
