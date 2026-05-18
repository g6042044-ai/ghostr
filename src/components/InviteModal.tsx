// src/components/InviteModal.tsx
// Modal pour inviter quelqu'un à rejoindre une conversation
// Design moderne et épuré

import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Share, Modal, ScrollView, Platform } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { masterKeyToCode } from '../services/crypto';
import { withExternalActivity } from '../services/lockGuard';
import { theme, Button, useThemedStyles, type ColorPalette } from './ui';

interface InviteModalProps {
  visible: boolean;
  onClose: () => void;
  masterKey: Uint8Array | null;
  conversationName: string;
}

export function InviteModal({
  visible,
  onClose,
  masterKey,
  conversationName,
}: InviteModalProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [code, setCode] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (masterKey) {
      const fullCode = masterKeyToCode(masterKey);
      setCode(fullCode);
    }
  }, [masterKey]);

  const handleCopyCode = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleShare = async () => {
    try {
      // withExternalActivity supprime le verrouillage automatique pendant
      // l'ouverture de la sheet de partage système (Android ouvre une vraie
      // Activity externe → AppState devient 'background' → verrouillage
      // déclenché sans cette garde). La grâce de 5s couvre le délai Android
      // entre la résolution de la Promise (au choix de la cible) et le
      // retour effectif de l'utilisateur dans Ghostr.
      await withExternalActivity(() =>
        Share.share({
          message: t('inviteModal.shareMessage', { name: conversationName, code }),
          title: t('inviteModal.shareTitle'),
        })
      );
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch (error) {
      console.error('Share error:', error);
    }
  };

  // Formater le code pour l'affichage (groupes de 13 caractères)
  const formatCodeForDisplay = (code: string) => {
    const groups = code.match(/.{1,13}/g) || [];
    return groups;
  };

  const codeLines = formatCodeForDisplay(code);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>{t('inviteModal.closeBtn')}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('inviteModal.inviteHeader')}</Text>
          <View style={styles.closeButton} />
        </View>

        <ScrollView 
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Titre et nom de conversation */}
          <View style={styles.titleSection}>
            <Text style={styles.emoji}>👥</Text>
            <Text style={styles.title}>{t('inviteModal.inviteSomeone')}</Text>
            <View style={styles.conversationBadge}>
              <Text style={styles.conversationName}>{conversationName}</Text>
            </View>
          </View>

          {/* QR Code */}
          <View style={styles.qrSection}>
            <View style={styles.qrContainer}>
              <View style={styles.qrInner}>
                {code ? (
                  <QRCode
                    value={code.replace(/-/g, '')}
                    size={180}
                    backgroundColor="white"
                    color="#111B21"
                    quietZone={10}
                  />
                ) : (
                  <View style={styles.qrPlaceholder}>
                    <Text style={styles.qrPlaceholderText}>{t('inviteModal.generating')}</Text>
                  </View>
                )}
              </View>
              
              {/* QR Decorative corners */}
              <View style={[styles.qrCorner, styles.qrCornerTL]} />
              <View style={[styles.qrCorner, styles.qrCornerTR]} />
              <View style={[styles.qrCorner, styles.qrCornerBL]} />
              <View style={[styles.qrCorner, styles.qrCornerBR]} />
            </View>
            
            <Text style={styles.qrHint}>
              {t('inviteModal.qrHint')}
            </Text>
          </View>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('inviteModal.orShareCode')}</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Code Section */}
          <View style={styles.codeSection}>
            <TouchableOpacity
              style={styles.codeBox}
              onPress={handleCopyCode}
              activeOpacity={0.8}
            >
              <View style={styles.codeContent}>
                {codeLines.map((line, index) => (
                  <Text key={index} style={styles.codeText}>
                    {line}
                  </Text>
                ))}
              </View>
              
              <View style={[
                styles.copyIndicator,
                copied && styles.copyIndicatorActive
              ]}>
                <Text style={styles.copyIcon}>{copied ? '✓' : '📋'}</Text>
                <Text style={[
                  styles.copyText,
                  copied && styles.copyTextActive
                ]}>
                  {copied ? t('inviteModal.copied') : t('inviteModal.tapToCopy')}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Info */}
          <View style={styles.infoCard}>
            <Text style={styles.infoIcon}>ℹ️</Text>
            <Text style={styles.infoText}>
              {t('inviteModal.infoText')}
            </Text>
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <Button
              title={shared ? t('inviteModal.shared') : t('inviteModal.shareInvite')}
              onPress={handleShare}
              variant="primary"
              size="large"
              fullWidth
              icon={!shared ? <Text style={{ fontSize: 18 }}>📤</Text> : undefined}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  closeButton: {
    width: 70,
  },
  closeText: {
    fontSize: 16,
    color: colors.primary,
    fontWeight: '500',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingBottom: 40,
  },
  
  // Title Section
  titleSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
  conversationBadge: {
    backgroundColor: colors.surface,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  conversationName: {
    fontSize: 15,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  
  // QR Section
  qrSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  qrContainer: {
    position: 'relative',
    padding: 24,
    marginBottom: 12,
  },
  qrInner: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 16,
    ...theme.shadow.lg,
  },
  qrPlaceholder: {
    width: 180,
    height: 180,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
  qrPlaceholderText: {
    color: colors.textSecondary,
  },
  qrCorner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: colors.primary,
  },
  qrCornerTL: {
    top: 8,
    left: 8,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 8,
  },
  qrCornerTR: {
    top: 8,
    right: 8,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 8,
  },
  qrCornerBL: {
    bottom: 8,
    left: 8,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },
  qrCornerBR: {
    bottom: 8,
    right: 8,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },
  qrHint: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
  
  // Divider
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 24,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.divider,
  },
  dividerText: {
    fontSize: 13,
    color: colors.textMuted,
    paddingHorizontal: 16,
  },
  
  // Code Section
  codeSection: {
    width: '100%',
    marginBottom: 24,
  },
  codeBox: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  codeContent: {
    padding: 16,
    alignItems: 'center',
  },
  codeText: {
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.text,
    letterSpacing: 1,
    lineHeight: 24,
  },
  copyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceLight,
    paddingVertical: 14,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  copyIndicatorActive: {
    backgroundColor: colors.success + '20',
  },
  copyIcon: {
    fontSize: 16,
  },
  copyText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  copyTextActive: {
    color: colors.success,
  },
  
  // Info Card
  infoCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 24,
    gap: 12,
  },
  infoIcon: {
    fontSize: 16,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  
  // Actions
  actions: {
    width: '100%',
  },
}) as const;

export default InviteModal;