// src/screens/MigrationLockdownScreen.tsx
// Wipe-recovery screen.
//
// This screen ONLY shows when the device boots and finds a migration marker
// in 'wiping' (or legacy 'frozen') state — i.e. a wipe was interrupted by
// a crash / kill / battery death between markWiping() and clearMarker().
//
// In normal operation, the export flow's "Wipe device" button:
//   1. Calls wipeAfterExport() which markWiping → nuclearReset → clearMarker.
//   2. Returns straight to the onboarding flow (handled by App.tsx).
// The user does NOT see this screen in the happy path.
//
// HISTORY:
//   Previously this was a "frozen" lockdown with two manual choices ("wipe"
//   or "cancel"). That intermediate state was removed at the user's request:
//   the wipe is now automatic, immediate, and irreversible. This screen is
//   reduced to a recovery splash that auto-resumes the wipe.

import { useEffect, useRef, useCallback } from 'react';
import { BackHandler } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resumePendingWipe } from '../services/migrationService';
import { SplashScreen } from './SplashScreen';

interface Props {
  /** Called after the wipe completes — App.tsx should re-init from scratch */
  onWiped: () => void;
}

export function MigrationLockdownScreen({ onWiped }: Props) {
  const { t } = useTranslation();
  const ranRef = useRef(false);

  // Block hardware back: there is no legitimate exit. The wipe will
  // complete in 1–3s and the parent will re-render to onboarding.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const runWipe = useCallback(async () => {
    if (ranRef.current) return;
    ranRef.current = true;
    try {
      await resumePendingWipe();
    } catch (e) {
      __DEV__ && console.error('[MigrationLockdown] resume wipe error:', e);
      // Even if resumePendingWipe throws, it has already markered 'wiping'
      // and called nuclearReset (which is fault-tolerant). The marker is
      // cleared in the finally branch of wipeAfterExport. Worst case the
      // user sees a brief retry on next launch.
    } finally {
      onWiped();
    }
  }, [onWiped]);

  useEffect(() => {
    // Defer one frame so the splash paints before nuclearReset blocks
    // the JS thread (storage.clear + many SecureStore deletes).
    const id = requestAnimationFrame(() => { runWipe(); });
    return () => cancelAnimationFrame(id);
  }, [runWipe]);

  return (
    <SplashScreen
      statusMessage={t('migrationLockdown.wiping') || 'Effacement…'}
      instant
    />
  );
}
