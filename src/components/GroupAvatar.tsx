// src/components/GroupAvatar.tsx
// Avatar de groupe — image custom OU mosaïque composite des avatars membres
// (pattern WhatsApp/Signal). Fallback : icône "people" sur fond dérivé du groupId.
//
// Cohérent avec le composant Avatar 1:1 : mêmes tailles nommées, même logique
// de couleur déterministe (getAvatarColor), s'intègre au thème.

import React from 'react';
import { View, Image, Text, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './ui/ThemeContext';
import { getAvatarColor } from './ui/theme';

type AvatarSize = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

const SIZES: Record<AvatarSize, number> = {
  tiny: 28,
  small: 40,
  medium: 48,
  large: 64,
  xlarge: 96,
};

export interface GroupMemberLite {
  fingerprint: string;
  displayName: string;
  avatarBase64?: string;
}

interface GroupAvatarProps {
  /** Avatar custom du groupe (base64/URI). Prioritaire sur le composite. */
  avatarUri?: string;
  /** Nom du groupe (pour l'initiale de secours). */
  name?: string;
  /** Membres, pour la mosaïque composite si pas d'avatar custom. */
  members?: GroupMemberLite[];
  /** Identifiant du groupe (couleur de fond déterministe du fallback). */
  groupId?: string;
  size?: AvatarSize;
  style?: ViewStyle;
}

function normalizeUri(s?: string): string | undefined {
  if (!s) return undefined;
  if (s.startsWith('data:') || s.startsWith('http') || s.startsWith('file:')) return s;
  // base64 nu → préfixer
  return `data:image/jpeg;base64,${s}`;
}

export const GroupAvatar: React.FC<GroupAvatarProps> = ({
  avatarUri,
  name,
  members = [],
  groupId,
  size = 'medium',
  style,
}) => {
  const { colors } = useTheme();
  const dim = SIZES[size];
  const radius = dim / 2;

  const customUri = normalizeUri(avatarUri);

  // 1) Avatar custom du groupe.
  if (customUri) {
    return (
      <Image
        source={{ uri: customUri }}
        style={[{ width: dim, height: dim, borderRadius: radius, backgroundColor: colors.surface }, style as object]}
        resizeMode="cover"
      />
    );
  }

  // 2) Mosaïque composite des avatars membres (jusqu'à 4).
  const withAvatars = members.filter(m => m.avatarBase64).slice(0, 4);
  if (withAvatars.length >= 2) {
    return (
      <View style={[styles.mosaic, { width: dim, height: dim, borderRadius: radius, backgroundColor: colors.border }, style]}>
        {withAvatars.map((m, i) => (
          <Image
            key={m.fingerprint || i}
            source={{ uri: normalizeUri(m.avatarBase64) }}
            style={{
              width: withAvatars.length === 2 ? dim / 2 : dim / 2,
              height: withAvatars.length === 2 ? dim : dim / 2,
            }}
            resizeMode="cover"
          />
        ))}
      </View>
    );
  }

  // 3) Fallback : icône people sur fond déterministe (ou initiale du nom).
  const bg = getAvatarColor(groupId || name || 'group');
  const initial = (name || '').trim().charAt(0).toUpperCase();
  return (
    <View
      style={[
        styles.fallback,
        { width: dim, height: dim, borderRadius: radius, backgroundColor: bg },
        style,
      ]}
    >
      {initial ? (
        <Text style={{ color: '#FFFFFF', fontSize: dim * 0.4, fontWeight: '700' }}>{initial}</Text>
      ) : (
        <Ionicons name="people" size={dim * 0.5} color="#FFFFFF" />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  mosaic: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
