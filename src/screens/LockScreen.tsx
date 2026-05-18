// src/screens/LockScreen.tsx
// Signal-style: flex-based, logo shrinks with keyboard, no scroll

import { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Vibration, Animated, Platform, StatusBar, Keyboard, KeyboardAvoidingView, Image, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { getEncryptionKeysWithInfo, getLockState, ArgonUnavailableError } from '../services/appLock';
import { setEncryptionKeys } from '../services/storage';
import { precomputePoW } from '../services/api1to1';
import { theme, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { SplashScreen } from './SplashScreen';

interface Props { onUnlock: () => void; }

const LOGO_FULL = 90;
const LOGO_SMALL = 52;
const LOGO_SCALE_SMALL = LOGO_SMALL / LOGO_FULL;  // ≈ 0.578 — utilisé par le native driver

export function LockScreen({ onUnlock }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [kbVisible, setKbVisible] = useState(false);

  const inputRef = useRef<TextInput>(null);
  // ── PAS de fade-in ──
  // `fadeAnim` reste à 1 en permanence (constante). Il n'anime rien — il est
  // conservé uniquement parce qu'il est référencé dans le style de mainContent
  // (`opacity: fadeAnim`). Le retirer demanderait de retirer aussi la prop de
  // style, ce qui n'est pas nécessaire.
  //
  // Pourquoi pas d'animation : le LockScreen doit apparaître IMMÉDIATEMENT
  // au 1er paint, sans transition de transparence. Toute fenêtre opacity<1
  // au mount expose ce qui est dessous (typiquement un fond sombre vide
  // pendant le re-render), perçu comme un « écran noir ». L'apparition
  // brutale (opacity=1 dès le 1er frame) est la meilleure UX pour un écran
  // de saisie de mot de passe : l'utilisateur n'a pas besoin d'animation,
  // il a besoin du TextInput tout de suite.
  const fadeAnim = useRef(new Animated.Value(1)).current;
  // logoScaleAnim : on utilise une transform scale (native driver compatible)
  // au lieu d'animer width/height (non-native driver → bloque le thread JS à
  // chaque frame de l'animation, provoquant un lag clavier visible).
  // La scale équivaut visuellement à l'ancien redimensionnement, mais tourne
  // entièrement sur le thread UI.
  const logoScaleAnim = useRef(new Animated.Value(1)).current;
  const decorOpacity = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  // Ref miroir du password pour éviter les captures de closure obsolètes.
  // Sans cette ref, si l'utilisateur appuie sur "Entrée" du clavier avant
  // que le dernier setPassword() n'ait propagé (batching React), handleUnlock
  // lit l'ancienne valeur du password dans sa closure → "mot de passe
  // incorrect" alors qu'il est bon.
  const passwordRef = useRef('');

  // Protection contre les doubles-clics et doubles-submit.
  // Sans ce verrou, appuyer sur "Entrée" puis sur "Déverrouiller" (ou deux
  // fois sur le bouton par impatience) lance DEUX dérivations Argon2id
  // en parallèle → chacune peut incrémenter le compteur de failed attempts
  // et déclencher un lockout temporaire, ou l'une peut terminer après que
  // onUnlock() ait fait unmount le composant (warning setState on unmounted).
  const unlockInProgress = useRef(false);

  // Suivi du cycle de vie du composant.
  // ────────────────────────────────────────────────────────────────────────
  // SÉCURITÉ : `handleUnlock` lance une dérivation Argon2id (1-2s) puis,
  // sur succès, appelle setEncryptionKeys() (place les clés en RAM module-
  // level) et onUnlock() (transitionne le parent vers l'app principale).
  // Si pendant cette dérivation l'utilisateur background l'app et que le
  // handler AppState d'App.tsx force un remount du LockScreen (via le
  // changement de `key={lockSessionId}`), notre instance est démontée
  // mais la promesse Argon2 continue dans la closure capturée.
  //
  // Sans cette garde, à la résolution de la promesse :
  //   - setEncryptionKeys() écrirait quand même les clés en RAM, alors
  //     que `clearEncryptionKey()` venait d'être appelée par le AppState
  //     handler → contournement silencieux du re-verrouillage.
  //   - onUnlock() forcerait App à passer isLocked=false → l'app
  //     deviendrait accessible au prochain plan, sans saisie de PIN.
  //
  // Avec la garde : si on est démonté, on zéroise défensivement les clés
  // dérivées (Uint8Arrays orphelins en mémoire) et on n'appelle ni
  // setEncryptionKeys ni onUnlock. Le ré-essai se fera sur la nouvelle
  // instance du LockScreen.
  // ────────────────────────────────────────────────────────────────────────
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // PoW pré-calcul dès le mount du LockScreen
  // ────────────────────────────────────────────────────────────────────────
  // PERF: On lance le PoW DÈS l'affichage du LockScreen, pas à la 1re frappe.
  //   (1) Le PoW est purement client (SHA-256 itératif ~200ms-1s), aucune
  //       dépendance sur le PIN ou les clés utilisateur.
  //   (2) En le lançant au mount, on profite du temps de saisie du PIN pour
  //       qu'il termine en arrière-plan → souvent déjà prêt au moment de
  //       waitForSealedSender(), gain 200ms-1s sur le chemin critique.
  //   (3) Le PoW tourne en JS (pas natif), yielding toutes les 50k itérations.
  //       Le lancer APRÈS la 1re frappe faisait laguer le clavier car les
  //       batches bloquent le thread JS 30-100ms chacun entre les yields.
  //       En le démarrant au mount, la plupart des batches s'exécutent AVANT
  //       que l'utilisateur ne commence à taper.
  //   (4) Idempotent grâce au cache `_precomputedPowPromise` dans api1to1.
  //       Si App.initializeApp l'a déjà lancé, cet appel est un no-op. Si le
  //       certificat sealed sender est déjà valide (retour de background
  //       rapide), ensureSealedSenderBootstrap skipe aussi le PoW → ici le
  //       cache peut même rester inutilisé, pas de souci.
  //
  // NOTE — Plus de callback `onReady()` :
  // Précédemment, on utilisait un requestAnimationFrame pour signaler à
  // App.tsx que le LockScreen avait fini son 1er paint, afin qu'App retire
  // un overlay privacy posé par-dessus. Ce mécanisme créait paradoxalement
  // l'écran noir qu'il prétendait éviter : entre setIsLocked(true) et le
  // round-trip useEffect → rAF → setState → re-render → commit → paint
  // (3-4 frames sur device rapide, jusqu'à 500ms sous charge JS), l'overlay
  // restait visible et masquait le LockScreen. App.tsx pilote désormais
  // l'overlay uniquement sur la base d'AppState (showPrivacyOverlay), et
  // le clear dans le même batch que setIsLocked(true). Le LockScreen
  // apparaît donc directement, sans masquage transitoire.
  // ────────────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  // PoW EN ARRIÈRE-PLAN PENDANT LA SAISIE
  // ────────────────────────────────────────────────────────────────────────
  // Le PoW (~3-4s sur device mobile) est nécessaire pour `waitForSealedSender`
  // dans handleUnlock — donc il DOIT terminer avant le déverrouillage.
  //
  // Stratégie : lancer le PoW dès le mount du LockScreen, puis l'utilisateur
  // tape son mot de passe pendant que le PoW tourne. Au moment du tap sur
  // « Déverrouiller » (typiquement 5-10s après le mount), le PoW est
  // largement terminé. ZÉRO temps d'attente perçu si l'utilisateur tape
  // normalement.
  //
  // CONDITION DE FLUIDITÉ — taille des batches PoW
  // ────────────────────────────────────────────────────────────────────────
  // Pour que le formulaire soit RÉACTIF pendant le PoW (frappes clavier,
  // animations), le PoW doit yielder fréquemment au JS thread. Cf.
  // `proofOfWork.ts` : BATCH_SIZE = 5000 → yield toutes les ~110ms.
  //
  // Avec ce yield rapide, les events clavier sont traités dans les fenêtres
  // libres entre batches : keyboardDidShow → setKbVisible(true) → animation
  // logo, onChangeText → setPassword(t), etc. L'utilisateur perçoit une UI
  // fluide même pendant que le PoW tourne en arrière-plan.
  //
  // DOUBLE-rAF avant lancement
  // ────────────────────────────────────────────────────────────────────────
  // On attend 2 frames (≈32ms) avant de lancer le PoW pour garantir que le
  // 1er paint du LockScreen est déjà à l'écran. Sans ce délai, le 1er batch
  // de PoW (~110ms) bloque la frame de mount → l'utilisateur voit un délai
  // de ~110ms avant que le LockScreen soit visible. Avec le double-rAF, le
  // LockScreen apparaît instantanément puis le PoW démarre.
  //
  // CANCELLATION
  // ────────────────────────────────────────────────────────────────────────
  // Si le composant unmount avant le démarrage (ex : retour de background
  // avec lockSessionId++), on annule le rAF planifié. Si le PoW a déjà
  // démarré, il continue (idempotent via cache _precomputedPowPromise dans
  // api1to1.ts) et sera consommé par la nouvelle instance via
  // waitForSealedSender → ZÉRO double calcul.
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (__DEV__) console.log(`[LockScreen] mounted at ${Date.now()}`);

    let raf1: number | null = null;
    let raf2: number | null = null;

    raf1 = requestAnimationFrame(() => {
      raf1 = null;
      if (__DEV__) console.log(`[LockScreen] first paint at ${Date.now()}`);
      raf2 = requestAnimationFrame(() => {
        raf2 = null;
        if (__DEV__) console.log(`[LockScreen] dispatching PoW at ${Date.now()}`);
        precomputePoW();
      });
    });

    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
  }, []);

  // Keyboard → shrink logo, hide decor
  // Toutes les animations passent par le NATIVE DRIVER :
  //   - scale (transform) : supporté nativement, tourne sur le thread UI
  //   - opacity : supporté nativement
  // Aucune animation ne bloque le thread JS pendant l'ouverture du clavier,
  // d'où la réactivité retrouvée du champ de saisie. Avant, `logoSizeAnim`
  // animait width/height qui ne sont pas supportés par le native driver,
  // forçant chaque frame à passer par le thread JS.
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, () => {
      setKbVisible(true);
      Animated.parallel([
        Animated.timing(logoScaleAnim, { toValue: LOGO_SCALE_SMALL, duration: 250, useNativeDriver: true }),
        Animated.timing(decorOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
    const s2 = Keyboard.addListener(hide, () => {
      setKbVisible(false);
      Animated.parallel([
        Animated.timing(logoScaleAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.timing(decorOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    });
    return () => { s1.remove(); s2.remove(); };
  }, []);

  // Lockout countdown
  useEffect(() => {
    if (!lockedUntil) { setRemainingSeconds(0); return; }
    const update = () => {
      const now = Date.now();
      if (now >= lockedUntil) { setLockedUntil(null); setRemainingSeconds(0); setError(null); }
      else setRemainingSeconds(Math.ceil((lockedUntil - now) / 1000));
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [lockedUntil]);

  const formatLockout = (s: number) => s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` : `${s}s`;

  const shake = useCallback(() => {
    if (Platform.OS !== 'web') Vibration.vibrate(100);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleUnlock = useCallback(async () => {
    Keyboard.dismiss();

    // Verrou anti double-submit : si une tentative est déjà en cours, ignorer.
    // Se libère dans le finally, y compris en cas d'exception.
    if (unlockInProgress.current) {
      return;
    }
    if (lockedUntil && Date.now() < lockedUntil) { shake(); return; }

    // Lire le password depuis la ref : c'est la valeur LA PLUS RÉCENTE,
    // garantie à jour même si React n'a pas encore fini de propager le
    // dernier setState (cas : onSubmitEditing juste après un onChangeText).
    const pwd = passwordRef.current;
    if (!pwd.trim()) { setError(t('lock.enterPassword')); shake(); return; }

    unlockInProgress.current = true;
    setLoading(true); setError(null);
    // Attendre UN frame pour que React ait commit le setLoading(true) et que
    // le SplashScreen soit effectivement peint avant d'enchaîner sur Argon2.
    // Argon2id étant natif, il ne bloque pas le thread JS, mais l'étape qui
    // suit (setEncryptionKeys → reencryptAllEntries) peut, elle, bloquer un
    // peu le JS. requestAnimationFrame attend le prochain vsync réel plutôt
    // qu'un délai arbitraire (80ms était du gras de sécurité sur Android).
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      const result = await getEncryptionKeysWithInfo(pwd);

      // GARDE DE SÉCURITÉ : si le LockScreen a été démonté pendant la
      // dérivation Argon2id (typiquement : l'utilisateur background l'app,
      // le handler AppState d'App.tsx force un remount via lockSessionId),
      // ne PAS appliquer le résultat. La nouvelle instance du LockScreen
      // attend une nouvelle saisie. Zéroiser défensivement les clés dérivées
      // qui viennent de naître pour qu'aucun reste de matériel cryptographique
      // ne traîne dans la heap après GC.
      if (!isMountedRef.current) {
        if (result.keys) {
          try { result.keys.localKey.fill(0); } catch {}
          try { result.keys.conversationsKey.fill(0); } catch {}
        }
        return;
      }

      if (result.keys) {
        await setEncryptionKeys(result.keys.localKey, result.keys.conversationsKey);
        // Re-vérifier la garde après l'await : setEncryptionKeys peut prendre
        // quelques dizaines de ms (re-chiffrement des entrées AsyncStorage),
        // fenêtre suffisante pour qu'un AppState 'background' arrive.
        // Si on a été démonté entre-temps, ne PAS appeler onUnlock — sinon
        // App passerait à isLocked=false alors qu'on voulait re-verrouiller.
        if (!isMountedRef.current) {
          return;
        }
        onUnlock();
      } else {
        const state = await getLockState();
        if (!isMountedRef.current) return;
        if (state.remainingLockoutSeconds > 0) {
          setLockedUntil(Date.now() + (state.remainingLockoutSeconds * 1000));
          setRemainingSeconds(state.remainingLockoutSeconds);
        } else { setError(t('lock.incorrect')); }
        shake();
        setPassword('');
        passwordRef.current = '';
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      // Erreur de configuration du build : Argon2id natif absent. Ce n'est pas
      // un mauvais mot de passe et ce n'est pas une simple erreur transitoire —
      // l'utilisateur doit savoir que c'est irrécupérable sans rebuild.
      if (e instanceof ArgonUnavailableError) {
        setError(t('lock.cryptoMissing'));
      } else {
        setError(t('lock.genericError'));
      }
      shake();
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
      unlockInProgress.current = false;
    }
  }, [lockedUntil, onUnlock]);

  const isBlocked = lockedUntil !== null && Date.now() < lockedUntil;
  // SplashScreen pendant Argon2.
  // ──────────────────────────────────────────────────────────────────────
  // instant={true} ━ raisons :
  //  (1) Continuité avec le SplashScreen post-unlock d'App.tsx, qui sera
  //      monté juste après onUnlock() avec lui aussi instant={true} via
  //      `splashInstant`. Les deux instances sont visuellement identiques
  //      (toutes les Animated.Value d'entrée à 1) → quand React bascule
  //      de l'instance LockScreen vers l'instance App.tsx, l'utilisateur
  //      ne voit aucun saut/fade.
  //  (2) Réactivité au tap "Déverrouiller" : afficher le SplashScreen
  //      pleinement opaque tout de suite donne un retour visuel immédiat
  //      à l'action utilisateur. Un fade-in 700ms à ce moment-là retarde
  //      le feedback et fait paraître l'app figée.
  //  (3) Les animations RÉCURRENTES (clock 60s pour les dots pulsants,
  //      breathing du logo, etc.) tournent normalement — seules les
  //      animations d'entrée ONE-SHOT sont sautées.
  // ──────────────────────────────────────────────────────────────────────
  if (loading) return <SplashScreen statusMessage={t('lock.unlocking')} instant />;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={[styles.mainContent, { opacity: fadeAnim }]}>

          {/* Logo — shrinks via native driver scale transform when keyboard is up.
              La taille du VIEW est FIXE ; seule la scale change. Comme ça le
              layout flex ne reflow PAS quand le clavier s'ouvre → pas de saut
              de position pour l'input en-dessous, et le thread JS n'est pas
              sollicité pour l'animation. */}
          <View style={styles.logoSection}>
            <Animated.View style={[styles.logoCard, {
              width: LOGO_FULL + 28,
              height: LOGO_FULL + 28,
              borderRadius: 24,
              transform: [{ scale: logoScaleAnim }],
            }]}>
              <Image
                source={require('../../assets/icon_nobg.png')}
                style={{ width: LOGO_FULL, height: LOGO_FULL, borderRadius: 18 }}
                resizeMode="contain"
              />
            </Animated.View>
            {/* Titre toujours rendu — son opacity suit decorOpacity. Avant,
                on le retirait du DOM avec `{!kbVisible && ...}` ce qui forçait
                un reflow du flex parent à chaque ouverture/fermeture du clavier
                (saut de position visible + latence). Maintenant il est toujours
                là mais invisible, le layout reste stable. pointerEvents none
                pour ne pas intercepter les taps quand invisible. */}
            <Animated.Text
              style={[styles.title, { opacity: decorOpacity }]}
              pointerEvents="none"
            >
              Ghostr
            </Animated.Text>
          </View>

          {/* Input + Error + Button */}
          <View style={styles.formSection}>
            <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
              <View style={[
                styles.inputWrapper,
                error && styles.inputWrapperError,
                isBlocked && styles.inputWrapperDisabled,
              ]}>
                <TextInput
                  ref={inputRef}
                  style={[styles.input, isBlocked && { color: colors.textMuted }]}
                  placeholder="••••••••"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    passwordRef.current = t; // miroir sync pour handleUnlock
                    if (!isBlocked) setError(null);
                  }}
                  editable={!isBlocked}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="password"
                  textContentType="password"
                  returnKeyType="done"
                  onSubmitEditing={handleUnlock}
                  blurOnSubmit
                />
              </View>
            </Animated.View>

            {error && <Text style={styles.errorText} numberOfLines={2}>{error}</Text>}

            {isBlocked && remainingSeconds > 0 && (
              <View style={styles.lockoutPill}>
                <Text style={styles.lockoutText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{t('lock.retryIn', { time: formatLockout(remainingSeconds) })}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.unlockBtn, isBlocked && styles.unlockBtnDisabled]}
              onPress={handleUnlock}
              disabled={isBlocked}
              activeOpacity={0.8}
            >
              <Text
                style={styles.unlockLabel}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.82}
              >
                {isBlocked ? t('lock.locked') : t('lock.unlock')}
              </Text>
            </TouchableOpacity>
          </View>

        </Animated.View>

        {/* Footer — opacity animée (native driver), PAS de retrait du DOM.
            Avant : `{!kbVisible && ...}` → reflow layout quand clavier s'ouvre.
            pointerEvents none quand invisible pour ne pas intercepter les taps. */}
        <Animated.View
          style={[styles.footer, { paddingBottom: insets.bottom + 20, opacity: decorOpacity }]}
          pointerEvents={kbVisible ? 'none' : 'auto'}
        >
          <Text style={styles.footerText}>{t('lock.endToEndFooter')}</Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  mainContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },

  // Logo
  logoSection: { alignItems: 'center', marginBottom: 32 },
  logoCard: {
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    ...theme.shadow.md,
  },
  title: { fontSize: 30, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },

  // Form
  formSection: { width: '100%' },
  inputWrapper: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  inputWrapperError: { borderColor: colors.danger },
  inputWrapperDisabled: { backgroundColor: colors.surface + '80', borderColor: colors.textMuted + '40' },
  input: {
    paddingHorizontal: 24, paddingVertical: 18,
    fontSize: 20, color: colors.text, textAlign: 'center', letterSpacing: 4,
  },
  errorText: { color: colors.danger, fontSize: 14, fontWeight: '500', textAlign: 'center', marginTop: 12 },
  lockoutPill: {
    alignSelf: 'center', marginTop: 10,
    paddingVertical: 8, paddingHorizontal: 20,
    backgroundColor: colors.warning + '18', borderRadius: 20,
  },
  lockoutText: { color: colors.warning, fontSize: 14, fontWeight: '600' },

  unlockBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 18, borderRadius: 18,
    marginTop: 20,
    ...theme.shadow.md,
  },
  unlockBtnDisabled: { opacity: 0.5 },
  unlockLabel: { color: colors.textOnPrimary, fontSize: 17, fontWeight: '600' },

  // Footer
  footer: { alignItems: 'center' },
  footerTagline: { fontSize: 14, color: colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  footerText: { fontSize: 13, color: colors.textMuted, fontWeight: '500' },
}) as const;

export default LockScreen;