// src/components/CallButton1to1.tsx
// Bouton d'appel vocal pour les conversations 1-à-1
// Version 1.0 - Utilise useCall1to1

import { useState, useRef } from 'react';
import { TouchableOpacity, ActivityIndicator, Animated } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { useCall1to1 } from '../hooks/useCall1to1';
import { useTheme, useThemedStyles, type ColorPalette, showAlert } from './ui';

// ============================================
// TYPES
// ============================================

interface CallButton1to1Props {
  sessionId: string;
  contactName: string;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
}

// ============================================
// ICÔNE TÉLÉPHONE
// ============================================

const PhoneIcon = ({ 
  color = '#FFFFFF', 
  size = 24,
}: { 
  color?: string; 
  size?: number;
}) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M22 16.92V19.92C22.0011 20.1985 21.9441 20.4741 21.8325 20.7293C21.7209 20.9845 21.5573 21.2136 21.3521 21.4018C21.1469 21.59 20.9046 21.7335 20.6408 21.8227C20.3769 21.9119 20.0974 21.9451 19.82 21.92C16.7428 21.5856 13.787 20.5341 11.19 18.85C8.77383 17.3146 6.72534 15.2661 5.19001 12.85C3.49998 10.2412 2.44824 7.27097 2.12001 4.17997C2.09501 3.90344 2.12788 3.62474 2.21651 3.3616C2.30513 3.09846 2.44757 2.85666 2.63477 2.6516C2.82196 2.44653 3.04981 2.28268 3.30379 2.1705C3.55778 2.05831 3.83234 2.00024 4.11001 1.99997H7.11001C7.59531 1.9952 8.06579 2.16706 8.43376 2.48351C8.80173 2.79996 9.04208 3.23942 9.11001 3.71997C9.23662 4.68004 9.47145 5.6227 9.81001 6.52997C9.94455 6.8879 9.97366 7.27689 9.89391 7.65086C9.81415 8.02482 9.62886 8.36809 9.36001 8.63997L8.09001 9.90997C9.51356 12.4135 11.5865 14.4864 14.09 15.91L15.36 14.64C15.6319 14.3711 15.9752 14.1858 16.3491 14.1061C16.7231 14.0263 17.1121 14.0554 17.47 14.19C18.3773 14.5285 19.3199 14.7634 20.28 14.89C20.7658 14.9585 21.2094 15.2032 21.5265 15.5775C21.8437 15.9518 22.0122 16.4296 22 16.92Z"
      fill={color}
    />
  </Svg>
);

// ============================================
// COMPOSANT PRINCIPAL
// ============================================

export function CallButton1to1({
  sessionId,
  contactName,
  disabled = false,
  size = 'medium',
}: CallButton1to1Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { startCall, isInCall } = useCall1to1();
  const [isStarting, setIsStarting] = useState(false);
  
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.92,
      useNativeDriver: true,
    }).start();
  };
  
  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  };

  const handlePress = async () => {
    if (disabled || isStarting || isInCall) return;

    try {
      setIsStarting(true);

      // Animation de feedback
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: 0.85,
          duration: 100,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
        }),
      ]).start();

      const result = await startCall(sessionId, contactName);

      if (!result.success) {
        showAlert({
          title: t('common.error'),
          message: result.error || t('contactInfo.callError'),
        });
      }

    } catch (error) {
      console.error('[CallButton1to1] Start call error:', error);
      showAlert({
        title: t('common.error'),
        message: t('contactInfo.callGenericError'),
      });
    } finally {
      setIsStarting(false);
    }
  };

  // Tailles
  const sizeConfig = {
    small: { button: 36, icon: 18 },
    medium: { button: 44, icon: 22 },
    large: { button: 56, icon: 28 },
  };
  
  const config = sizeConfig[size];
  
  const iconColor = disabled 
    ? colors.textMuted 
    : colors.primary;

  const isDisabled = disabled || isInCall;

  return (
    <Animated.View 
      style={[
        styles.iconButtonWrapper,
        { transform: [{ scale: scaleAnim }] }
      ]}
    >
      <TouchableOpacity
        style={[
          styles.iconButton,
          {
            width: config.button,
            height: config.button,
            borderRadius: config.button / 2,
            opacity: isDisabled ? 0.5 : 1,
          },
        ]}
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={isDisabled}
        activeOpacity={0.7}
      >
        {isStarting ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <PhoneIcon color={iconColor} size={config.icon} />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ============================================
// STYLES
// ============================================

const makeStyles = (colors: ColorPalette) => ({
  iconButtonWrapper: {
    alignItems: 'center',
    position: 'relative',
  },
  iconButton: {
    backgroundColor: 'rgba(107, 92, 231, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
}) as const;

export default CallButton1to1;
