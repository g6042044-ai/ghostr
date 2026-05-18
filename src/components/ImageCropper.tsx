// src/components/ImageCropper.tsx
// In-app image cropper for avatar selection — replaces the OS-native editor
// invoked by `expo-image-picker` with `allowsEditing: true` (which on Android
// has poor contrast against dark images: tool icons blend into the photo).
//
// DESIGN GOALS
// ────────────
// 1. CONTRAST : every control (cancel / confirm / rotate / flip) sits in a
//    solid circular "chip" with colors.surfaceElevated background and
//    colors.text icon. The chip stays opaque so contrast is preserved
//    on any image — dark, light, busy, or solid black.
// 2. NO NEW DEPS : uses react-native-gesture-handler (already present for
//    GestureHandlerRootView), react-native-reanimated (~4.1), expo-image-
//    manipulator (already used by the screens), @expo/vector-icons.
// 3. SAFETY : rotate/flip actions bake into a working URI via
//    ImageManipulator (one ManipulatorContext per action), so the pan/zoom
//    coordinate math only ever runs against the current working image —
//    no rotation matrices, no off-axis crop bugs.
// 4. EXIF ORIENTATION : on open, the source is passed through one no-op
//    ImageManipulator pass to normalize EXIF orientation across iOS/Android
//    before the user starts cropping. Otherwise Image.getSize() vs the
//    cropped pixel coordinates could disagree on a portrait photo whose
//    raw pixels are landscape + rotation tag.
// 5. RTL : the toolbar uses RN's default flexDirection: 'row', which honors
//    the active locale's writing direction. This matches native OS image
//    editors on the same devices (Samsung Gallery, Photos, etc. mirror in
//    RTL locales). All text strings are translated via i18n.
// 6. CRYPTO POSTURE : no network calls, no logging, no storage writes
//    outside ImageManipulator's cache directory. The returned data: URI is
//    handed straight to the caller's setAvatarUri.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, Image, TouchableOpacity,
  ActivityIndicator, Dimensions, Platform, StatusBar, BackHandler,
} from 'react-native';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';
import { theme, useTheme, useThemedStyles, type ColorPalette } from './ui';

// ============================================================================
// TYPES
// ============================================================================

export interface ImageCropperProps {
  /** When true, the cropper is mounted and visible. */
  visible: boolean;
  /** Source image URI (file:// from ImagePicker, or any URI Image can load). */
  sourceUri: string | null;
  /** Called with the final cropped image as a data:image/jpeg;base64,... URI. */
  onConfirm: (dataUri: string) => void;
  /** Called when the user dismisses the cropper without saving. */
  onCancel: () => void;
  /** Output size in pixels (square). Default 120, matching the existing avatar pipeline. */
  outputSize?: number;
  /** JPEG quality 0..1. Default 0.3, matching the existing avatar pipeline. */
  compress?: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_SCALE = 1;       // 1 = "cover" the square viewport — never smaller
const MAX_SCALE = 5;       // Plenty for tight face crops; prevents pixel-mush
const SPRING_CFG = { damping: 20, stiffness: 180, mass: 0.6 };
const TOOLBAR_HEIGHT = 72; // bottom toolbar with rotate/flip buttons

// ============================================================================
// COMPONENT
// ============================================================================

export function ImageCropper({
  visible,
  sourceUri,
  onConfirm,
  onCancel,
  outputSize = 120,
  compress = 0.3,
}: ImageCropperProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  // ─── Working image state ─────────────────────────────────────────────────
  // workingUri is the URI we display + crop against. It starts as sourceUri
  // (after EXIF normalization), then is replaced after each rotate/flip.
  const [workingUri, setWorkingUri] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);      // true while a transform/crop is running
  const [loadError, setLoadError] = useState(false);

  // ─── Layout ──────────────────────────────────────────────────────────────
  // We recompute viewport size when the window resizes (rotation, tablet,
  // foldable). Square, capped so toolbars + header always fit.
  const [windowDims, setWindowDims] = useState(() => Dimensions.get('window'));
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => setWindowDims(window));
    return () => sub.remove();
  }, []);
  const V = useMemo(() => {
    const headerH = insets.top + 56;
    const toolbarH = insets.bottom + TOOLBAR_HEIGHT + 24;
    const maxByHeight = windowDims.height - headerH - toolbarH;
    const maxByWidth = windowDims.width - 24; // 12px gutter each side
    return Math.max(200, Math.min(maxByHeight, maxByWidth));
  }, [windowDims, insets.top, insets.bottom]);

  // ─── Gesture shared values ───────────────────────────────────────────────
  // tx/ty: cumulative translation in screen pixels.
  // scale: cumulative scale multiplier on top of baseScale.
  // saved*: snapshot taken at gesture start, so onUpdate is incremental.
  // Wd/Hd: displayed image dimensions at scale=1 (Wo*baseScale, Ho*baseScale).
  //        Held as shared values so the gesture worklets can read them
  //        without a stale-closure dance when imgSize changes.
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const savedScale = useSharedValue(1);
  const Wd = useSharedValue(1);
  const Hd = useSharedValue(1);
  // Pinch focal point (in viewport-local coords, origin = top-left). We need
  // these on the UI thread so zoom can stay anchored at the user's fingers
  // rather than jumping to the image center.
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  // ─── Reset transforms ────────────────────────────────────────────────────
  // Called when the cropper opens with a new source, and after rotate/flip
  // (image semantics changed; pan/zoom must restart from the centered fit).
  const resetTransforms = useCallback(() => {
    tx.value = 0; ty.value = 0; scale.value = 1;
    savedTx.value = 0; savedTy.value = 0; savedScale.value = 1;
  }, [tx, ty, scale, savedTx, savedTy, savedScale]);

  // ─── Compute Wd/Hd from imgSize ──────────────────────────────────────────
  // baseScale = max(V/Wo, V/Ho) ⇒ min(Wd, Hd) === V ("cover" the viewport).
  // baseScale itself is recomputed inside the worklet from Wd/Hd/imgSize
  // when needed; we don't store it separately.
  useEffect(() => {
    if (!imgSize) return;
    const baseScale = Math.max(V / imgSize.w, V / imgSize.h);
    Wd.value = imgSize.w * baseScale;
    Hd.value = imgSize.h * baseScale;
  }, [imgSize, V, Wd, Hd]);

  // ─── EXIF-normalize on open ──────────────────────────────────────────────
  // ImageManipulator re-encodes the file, baking the EXIF orientation tag
  // into actual pixel orientation. This guarantees Image.getSize()'s width
  // and height match the orientation the user sees, so the crop rect we
  // compute later maps to the right pixels on both iOS and Android.
  useEffect(() => {
    if (!visible || !sourceUri) {
      setWorkingUri(null); setImgSize(null); setLoadError(false);
      return;
    }
    let cancelled = false;
    setBusy(true); setLoadError(false);
    (async () => {
      try {
        // No-op rotate forces re-encode; PNG keeps quality, JPEG loses a
        // negligible amount at the avatar's final 0.3 compression budget.
        const normalized = await ImageManipulator.manipulateAsync(
          sourceUri, [{ rotate: 0 }], { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );
        if (cancelled) return;
        setWorkingUri(normalized.uri);
        setImgSize({ w: normalized.width, h: normalized.height });
        resetTransforms();
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, sourceUri, resetTransforms]);

  // ─── Android hardware back ───────────────────────────────────────────────
  // While the cropper is open, the back button cancels (matches the OS
  // cropper it replaces — which closes on back). Disabled mid-transform to
  // avoid leaving a half-applied state.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      onCancel();
      return true;
    });
    return () => sub.remove();
  }, [visible, busy, onCancel]);

  // ─── Clamp helpers (worklets) ────────────────────────────────────────────
  // Inside gesture callbacks we need to know the current pan bounds. With
  // `s` the user scale and `s_base` baked into Wd/Hd, the displayed image
  // is Wd*s × Hd*s, and to keep it covering the V×V viewport:
  //     |tx| ≤ (Wd*s - V) / 2   ;   |ty| ≤ (Hd*s - V) / 2
  // These are non-negative for s ≥ 1 because min(Wd, Hd) = V (by baseScale).
  const clampToBounds = useCallback(() => {
    'worklet';
    const maxTx = Math.max(0, (Wd.value * scale.value - V) / 2);
    const maxTy = Math.max(0, (Hd.value * scale.value - V) / 2);
    if (tx.value > maxTx) tx.value = withSpring(maxTx, SPRING_CFG);
    else if (tx.value < -maxTx) tx.value = withSpring(-maxTx, SPRING_CFG);
    if (ty.value > maxTy) ty.value = withSpring(maxTy, SPRING_CFG);
    else if (ty.value < -maxTy) ty.value = withSpring(-maxTy, SPRING_CFG);
  }, [V, Wd, Hd, tx, ty, scale]);

  // ─── Gestures ────────────────────────────────────────────────────────────
  const panGesture = useMemo(() => Gesture.Pan()
    .averageTouches(true)       // smoother with two fingers down for pinch
    .onStart(() => {
      'worklet';
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    })
    .onUpdate((e) => {
      'worklet';
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      'worklet';
      clampToBounds();
    }), [tx, ty, savedTx, savedTy, clampToBounds]);

  const pinchGesture = useMemo(() => Gesture.Pinch()
    .onStart((e) => {
      'worklet';
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      // Convert focal point from viewport-local to image-local around the
      // current image-center anchor so the zoom appears to anchor under the
      // fingers rather than at the image's geometric center. The viewport
      // center is at (V/2, V/2); the focal offset from center is what we
      // need to feed into the corrective translation below.
      focalX.value = e.focalX - V / 2;
      focalY.value = e.focalY - V / 2;
    })
    .onUpdate((e) => {
      'worklet';
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value * e.scale));
      // Anchor zoom under the pinch's focal point. We want the image-local
      // point currently under the user's fingers (F) to stay under the
      // fingers as scale changes from s0 → s1. Image center is at
      //   C = (V/2 + tx, V/2 + ty)
      // and we stored focalX/Y = e.focalX/Y - V/2 at onStart, so:
      //   F.x - V/2 = focalX     (focal in viewport-center-relative coords)
      // The "point in image-local coords" relative to image center is
      // (F - C) / s. To keep that point under F at the new scale:
      //   F = C_new + ((F - C_old) / s_old) * s_new
      // Solving for tx_new (and similarly for ty):
      //   tx_new = savedTx * (s_new/s_old) + focalX * (1 - s_new/s_old)
      // which factors as:
      //   tx_new = savedTx + (focalX - savedTx) * (1 - s_new/s_old)
      const k = 1 - nextScale / savedScale.value;
      tx.value = savedTx.value + (focalX.value - savedTx.value) * k;
      ty.value = savedTy.value + (focalY.value - savedTy.value) * k;
      scale.value = nextScale;
    })
    .onEnd(() => {
      'worklet';
      clampToBounds();
    }), [scale, tx, ty, savedScale, savedTx, savedTy, focalX, focalY, V, clampToBounds]);

  // Run both gestures simultaneously: a two-finger interaction is at once
  // a pinch (zoom) and a pan (drag the centroid). Without Simultaneous, the
  // first to win the recognizer race blocks the other.
  const composedGesture = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture),
    [panGesture, pinchGesture]
  );

  // ─── Animated style on the image container ───────────────────────────────
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  // ─── Rotate / Flip actions ───────────────────────────────────────────────
  // Each action calls ImageManipulator on the current workingUri, replaces
  // workingUri with the result, refreshes imgSize, and resets transforms.
  // Bakes the operation into pixels so subsequent crop math stays trivial.
  const applyAction = useCallback(async (action: ImageManipulator.Action) => {
    if (!workingUri || busy) return;
    setBusy(true);
    try {
      const r = await ImageManipulator.manipulateAsync(
        workingUri, [action],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
      );
      setWorkingUri(r.uri);
      setImgSize({ w: r.width, h: r.height });
      resetTransforms();
    } catch {
      // Surface as a transient error; user can retry or cancel.
      setLoadError(true);
    } finally {
      setBusy(false);
    }
  }, [workingUri, busy, resetTransforms]);

  const handleRotate = useCallback(() => {
    applyAction({ rotate: 90 });
  }, [applyAction]);

  const handleFlipH = useCallback(() => {
    applyAction({ flip: ImageManipulator.FlipType.Horizontal });
  }, [applyAction]);

  const handleFlipV = useCallback(() => {
    applyAction({ flip: ImageManipulator.FlipType.Vertical });
  }, [applyAction]);

  // ─── Confirm ─────────────────────────────────────────────────────────────
  // Compute the crop rectangle in *working-image pixel coordinates* from the
  // current pan/zoom, then call ImageManipulator with [crop, resize] in one
  // pass so we emit a single final JPEG.
  //
  // Derivation:
  //   baseScale = max(V/Wo, V/Ho), Wd = Wo*baseScale, Hd = Ho*baseScale.
  //   Image is centered in the viewport, then transform: translate(tx, ty)
  //   then scale(s) (RN applies transforms in the listed order, with scale
  //   anchored at the element center). The viewport's top-left in
  //   image-local coords is:
  //       x_local_TL = Wd/2 + (-V/2 - tx)/s
  //   and the viewport's width in image-local coords is V/s.
  //   Convert to original-image pixel coords by dividing by baseScale:
  //       originX = (Wd/2 - V/(2s) - tx/s) / baseScale
  //               = Wo/2 - V/(2*s*baseScale) - tx/(s*baseScale)
  //       cropW   = V / (s*baseScale)
  //   Same for Y. Then clamp into [0, Wo - cropW] for safety against FP error.
  const handleConfirm = useCallback(async () => {
    if (!workingUri || !imgSize || busy) return;
    setBusy(true);
    try {
      const s = scale.value;
      const t_x = tx.value;
      const t_y = ty.value;
      const baseScale = Math.max(V / imgSize.w, V / imgSize.h);

      const cropW = V / (s * baseScale);
      const cropH = V / (s * baseScale);
      let originX = imgSize.w / 2 - V / (2 * s * baseScale) - t_x / (s * baseScale);
      let originY = imgSize.h / 2 - V / (2 * s * baseScale) - t_y / (s * baseScale);

      // Clamp into the image bounds (defends against FP drift from gestures
      // that just barely overshot the spring-back into bounds).
      originX = Math.max(0, Math.min(imgSize.w - cropW, originX));
      originY = Math.max(0, Math.min(imgSize.h - cropH, originY));

      const result = await ImageManipulator.manipulateAsync(
        workingUri,
        [
          { crop: { originX, originY, width: cropW, height: cropH } },
          { resize: { width: outputSize, height: outputSize } },
        ],
        { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (!result.base64) {
        setLoadError(true);
        setBusy(false);
        return;
      }
      onConfirm(`data:image/jpeg;base64,${result.base64}`);
    } catch {
      setLoadError(true);
      setBusy(false);
    }
    // Note: we don't setBusy(false) on success — the caller closes the modal
    // and unmounts us. Leaving busy=true prevents double-tap re-entry.
  }, [workingUri, imgSize, busy, scale, tx, ty, V, outputSize, compress, onConfirm]);

  // ─── Render ──────────────────────────────────────────────────────────────
  // Recompute wDisp/hDisp directly from imgSize+V at every render. The
  // shared values Wd/Hd are written from a useEffect that may not run by
  // the time we render the new imgSize (e.g., right after a rotate), so
  // reading them here would be one frame stale and the image would jump
  // visibly. JS-side recompute is cheap and always correct.
  const imageReady = !!workingUri && !!imgSize && !loadError;
  const baseScaleForRender = imgSize ? Math.max(V / imgSize.w, V / imgSize.h) : 1;
  const wDisp = imgSize ? imgSize.w * baseScaleForRender : V;
  const hDisp = imgSize ? imgSize.h * baseScaleForRender : V;

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={() => { if (!busy) onCancel(); }}
    >
      <GestureHandlerRootView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor="#000" translucent />
        <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          {/* The toolbar uses flexDirection: 'row' which honors the locale's
              writing direction (e.g., mirrors in Arabic/Urdu). This matches
              native OS image editors on the same devices, so it's the right
              default — we don't force LTR. */}
          {/* ─── Top toolbar : cancel ┄ title ┄ confirm ─── */}
          <View style={[styles.toolbar, styles.topToolbar]}>
            <ToolbarChip
              onPress={() => { if (!busy) onCancel(); }}
              disabled={busy}
              accessibilityLabel={t('cropper.cancel')}
            >
              <Ionicons name="close" size={24} color={colors.text} />
            </ToolbarChip>

            <View style={styles.titleWrap}>
              <Text style={styles.title} numberOfLines={1}>{t('cropper.title')}</Text>
              <Text style={styles.hint} numberOfLines={1}>{t('cropper.hint')}</Text>
            </View>

            <ToolbarChip
              onPress={handleConfirm}
              disabled={!imageReady || busy}
              variant="primary"
              accessibilityLabel={t('cropper.confirm')}
            >
              {busy
                ? <ActivityIndicator size="small" color={colors.textOnPrimary} />
                : <Ionicons name="checkmark" size={24} color={colors.textOnPrimary} />}
            </ToolbarChip>
          </View>

          {/* ─── Crop viewport ─── */}
          <View style={styles.viewportContainer}>
            <View
              style={[styles.viewport, { width: V, height: V }]}
              // Mask everything outside the V×V square with the same dark
              // backdrop, so the user sees clearly what will be saved.
            >
              {imageReady ? (
                <GestureDetector gesture={composedGesture}>
                  <Animated.View
                    style={[
                      styles.imageWrap,
                      { width: wDisp, height: hDisp },
                      animatedStyle,
                    ]}
                  >
                    <Image
                      source={{ uri: workingUri! }}
                      style={styles.image}
                      resizeMode="cover"
                      // Avoid Android caching artifacts when workingUri
                      // changes due to rotate/flip — the URI differs each
                      // time so cache key is fine; we just disable fade-in
                      // to prevent the brief blink on swap.
                      fadeDuration={0}
                    />
                  </Animated.View>
                </GestureDetector>
              ) : loadError ? (
                <Text style={styles.errorText}>{t('cropper.loadError')}</Text>
              ) : (
                <ActivityIndicator size="large" color={colors.primary} />
              )}

              {/* Rule-of-thirds grid — purely visual, drawn over image. */}
              {imageReady && (
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  <View style={[styles.gridLine, styles.gridLineH, { top: V / 3 }]} />
                  <View style={[styles.gridLine, styles.gridLineH, { top: (2 * V) / 3 }]} />
                  <View style={[styles.gridLine, styles.gridLineV, { left: V / 3 }]} />
                  <View style={[styles.gridLine, styles.gridLineV, { left: (2 * V) / 3 }]} />
                  {/* Corner indicators for a polished look */}
                  <View style={[styles.corner, styles.cornerTL]} />
                  <View style={[styles.corner, styles.cornerTR]} />
                  <View style={[styles.corner, styles.cornerBL]} />
                  <View style={[styles.corner, styles.cornerBR]} />
                </View>
              )}
            </View>
          </View>

          {/* ─── Bottom toolbar : rotate ┄ flipH ┄ flipV ─── */}
          <View style={[styles.toolbar, styles.bottomToolbar]}>
            <ToolbarChip
              onPress={handleRotate}
              disabled={!imageReady || busy}
              accessibilityLabel={t('cropper.rotate')}
            >
              <MaterialCommunityIcons name="rotate-right" size={24} color={colors.text} />
            </ToolbarChip>
            <ToolbarChip
              onPress={handleFlipH}
              disabled={!imageReady || busy}
              accessibilityLabel={t('cropper.flipHorizontal')}
            >
              <MaterialCommunityIcons name="flip-horizontal" size={24} color={colors.text} />
            </ToolbarChip>
            <ToolbarChip
              onPress={handleFlipV}
              disabled={!imageReady || busy}
              accessibilityLabel={t('cropper.flipVertical')}
            >
              <MaterialCommunityIcons name="flip-vertical" size={24} color={colors.text} />
            </ToolbarChip>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// ============================================================================
// CHIP — the reusable circular control with guaranteed contrast
// ============================================================================
// A circular button with an opaque dark background and a high-contrast icon
// inside. Stays legible against any underlying image because it's positioned
// outside the viewport (over the cropper's own dark backdrop), and its own
// background is opaque. The user's bug report asked for "lighter background
// overlay behind the icons" — this is exactly that, themed for the app.

interface ChipProps {
  onPress: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary';
  accessibilityLabel?: string;
  children: React.ReactNode;
}

function ToolbarChip({ onPress, disabled, variant = 'default', accessibilityLabel, children }: ChipProps) {
  const styles = useThemedStyles(makeStyles);
  const isPrimary = variant === 'primary';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[
        styles.chip,
        isPrimary ? styles.chipPrimary : styles.chipDefault,
        disabled && styles.chipDisabled,
      ]}
    >
      {children}
    </TouchableOpacity>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const makeStyles = (colors: ColorPalette) => ({
  root: {
    flex: 1,
    backgroundColor: '#000', // pure black for maximum image contrast
  },

  // Toolbars
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  topToolbar: {
    height: 56,
    justifyContent: 'space-between',
  },
  bottomToolbar: {
    height: TOOLBAR_HEIGHT,
    justifyContent: 'space-around',
    paddingHorizontal: 32,
  },

  // Title block in the top toolbar
  titleWrap: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  title: {
    color: colors.text,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  hint: {
    color: colors.textSecondary,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },

  // Chip — the contrast solution
  chip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    // Subtle outline + shadow so the chip itself reads against the
    // surrounding black even though both are dark.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.4,
        shadowRadius: 4,
      },
      android: { elevation: 4 },
    }),
  },
  chipDefault: {
    backgroundColor: colors.surfaceElevated, // #243240 — opaque, light enough vs black
  },
  chipPrimary: {
    backgroundColor: colors.primary, // accent for the confirm CTA
    borderColor: 'transparent',
  },
  chipDisabled: {
    opacity: 0.45,
  },

  // Viewport
  viewportContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewport: {
    backgroundColor: '#000',
    overflow: 'hidden',
    borderRadius: 4,
    // Soft accent border so the crop area is unmistakable. The corners below
    // reinforce it for extra readability.
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageWrap: {
    // No `position: absolute` here: the viewport uses
    //   alignItems: 'center', justifyContent: 'center'
    // to center us at tx=ty=0, scale=1. The crop math depends on the
    // image starting precisely centered in the V×V viewport — translate
    // and scale then offset from that fixed origin. With overflow:hidden
    // on the viewport, anything past the V×V bounds is clipped.
  },
  image: {
    width: '100%',
    height: '100%',
  },

  // Grid lines (rule of thirds)
  gridLine: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  gridLineH: {
    left: 0, right: 0, height: StyleSheet.hairlineWidth,
  },
  gridLineV: {
    top: 0, bottom: 0, width: StyleSheet.hairlineWidth,
  },

  // Corner indicators
  corner: {
    position: 'absolute',
    width: 18, height: 18,
    borderColor: '#fff',
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2 },

  errorText: {
    color: colors.error,
    fontSize: theme.fontSize.md,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
}) as const;

export default ImageCropper;
