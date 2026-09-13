// src/screens/Create1to1Screen.tsx
// Création d'invitation 1-à-1
// Utilise SplashScreen comme loading universel
//
// v2.0 — Refactor robustesse SealedSender :
//   • Pré-bootstrap explicite via `waitForSealedSenderReady` (timeout 30s,
//     retries internes, AbortSignal-aware) AVANT toute opération crypto
//   • mountedRef + AbortController pour cleanup propre en cas d'unmount
//     (back gesture, app background → kill, navigation forcée)
//   • Status messages reflètent l'étape RÉELLE (réseau vs crypto locale)
//   • Alert avec retry/cancel en cas d'échec, plus jamais d'écran figé
//   • Une seule entrée dans le bootstrap : sessionService.createInvite a
//     son propre filet de sécurité mais ne fera rien si SS déjà prêt.

import { useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { sessionService } from '../services/tripleRatchet';
import { pendingInviteStore } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { waitForSealedSenderReady } from '../services/api1to1';
import { errorMessage } from '../services/errorMessages';
import { SplashScreen } from './SplashScreen';

import { showAlert, type AlertButton } from '../components/ui';

type RootStackParamList = {
  ConversationList: undefined;
  InviteDetail: { tag: string };
  Create1to1: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Create1to1'>;

// Budget total pour la phase « connexion sécurisée ». Au-delà, on affiche
// une erreur retry/cancel plutôt que de laisser l'utilisateur sur un écran
// figé. 60s couvre les pires cas observés sur Hermes (PoW SHA-256 itératif
// ~3-10× plus lent qu'V8, contention CPU avec polling/crypto) :
//   PoW (3-30s) + initRelay (1-5s) + RPC certificat (1-3s) = jusqu'à ~40s.
const SS_BOOTSTRAP_TIMEOUT_MS = 60_000;

export function Create1to1Screen() {
  const navigation = useNavigation<NavigationProp>();
  const { t } = useTranslation();
  const [statusMessage, setStatusMessage] = useState(() =>
    t('appBoot.preparingSecureConnection'),
  );

  // Block back button during creation. The user shouldn't be able to back
  // out mid-flow (would leave a half-created invite in pendingInviteStore).
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => backHandler.remove();
  }, []);

  // ──────────────────────────────────────────────────────────────────────
  // PIPELINE PRINCIPAL — pré-bootstrap → crypto locale → upload → navigate
  // ──────────────────────────────────────────────────────────────────────
  // Un seul useEffect pour pouvoir partager mountedRef et abortController
  // entre les deux phases. Si le composant unmount avant la fin :
  //   • abortController.abort() court-circuite le wait du SS
  //   • mountedRef.current = false bloque tous les setState/navigate ultérieurs
  // → zéro warning React, zéro navigation parasite vers InviteDetail.
  useEffect(() => {
    const mountedRef = { current: true };
    const abortController = new AbortController();

    const safeSetStatus = (msg: string) => {
      if (mountedRef.current) setStatusMessage(msg);
    };

    const safeNavigate = (tag: string) => {
      if (mountedRef.current) navigation.replace('InviteDetail', { tag });
    };

    const showErrorAndGoBack = (message: string, retryable: boolean) => {
      if (!mountedRef.current) return;
      const buttons: AlertButton[] = [];
      if (retryable) {
        buttons.push({
          text: t('common.retry'),
          onPress: () => {
            if (mountedRef.current) navigation.replace('Create1to1');
          },
        });
      }
      buttons.push({
        text: retryable ? t('common.cancel') : t('common.ok'),
        style: 'cancel',
        onPress: () => {
          if (mountedRef.current) navigation.goBack();
        },
      });
      // `dismissible: false` : fermer par un tap à côté laisserait
      // l'utilisateur sur un écran de création en échec, sans invitation ni
      // chemin de sortie. Il doit choisir « Réessayer » ou « Annuler ».
      void showAlert({ title: t('common.error'), message, buttons, dismissible: false });
    };

    const run = async () => {
      // ── Phase 1 : s'assurer que le SealedSender est opérationnel ──
      // Cette phase EST le plus souvent celle qui prend du temps (réseau).
      // On affiche un status réaliste plutôt qu'un faux "génération de clés".
      const ssReady = await waitForSealedSenderReady({
        timeoutMs: SS_BOOTSTRAP_TIMEOUT_MS,
        onStatus: safeSetStatus,
        signal: abortController.signal,
      });

      if (!mountedRef.current || abortController.signal.aborted) return;

      if (!ssReady) {
        showErrorAndGoBack(t('errors.secureConnectionTimeout'), true);
        return;
      }

      // ── Phase 2 : crypto locale (vraiment générer les clés ici) ──
      // À ce stade, SS est garanti prêt → sessionService.createInvite ne
      // re-fera PAS d'attente (son filet interne `isSealedSenderReady()`
      // retournera true immédiatement). L'utilisateur voit enfin un status
      // qui correspond à ce qui se passe vraiment.
      try {
        safeSetStatus(t('create.generatingKeys'));
        await sessionService.initialize();
        if (!mountedRef.current) return;

        safeSetStatus(t('create.creating'));
        const result = await sessionService.createInvite();
        if (!mountedRef.current) return;

        if (!result.inviteData.tag) {
          throw new Error(t('create.noTagGenerated'));
        }

        const invite = await pendingInviteStore.add(
          result.inviteData.tag,
          result.inviteString,
          result.keyIds,
        );
        if (!mountedRef.current) return;

        // Trigger le watcher pour qu'il commence à poller cette invitation
        // immédiatement, sans attendre le prochain cycle.
        inviteWatcher.forcePoll();

        safeSetStatus(t('create.created'));
        // Petit délai pour que l'utilisateur voie la confirmation avant nav.
        setTimeout(() => safeNavigate(invite.tag), 400);
      } catch (e: any) {
        if (!mountedRef.current) return;
        console.error('[Create1to1] Error:', e);
        // En cas d'échec dans createInvite, c'est probablement le réseau
        // ou un bug crypto — retry possible mais on ne masque pas l'erreur.
        showErrorAndGoBack(errorMessage(e, 'create.createError'), true);
      }
    };

    run();

    return () => {
      mountedRef.current = false;
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <SplashScreen statusMessage={statusMessage} />;
}

export default Create1to1Screen;
