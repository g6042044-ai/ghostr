// src/components/InviteModal.tsx
// Modal pour inviter quelqu'un à rejoindre une conversation
// Design moderne et épuré

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  Modal,
  ScrollView,
  Platform,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { masterKeyToCode } from '../services/crypto';
import { theme, Button } from './ui';

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
      await Share.share({
        message: `🔐 Rejoins la conversation "${conversationName}" sur Ghostr!\n\n📱 Code d'invitation:\n${code}\n\n👉 Ouvre Ghostr > Rejoindre > Entre ce code`,
        title: 'Invitation Ghostr',
      });
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
            <Text style={styles.closeText}>Fermer</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Inviter</Text>
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
            <Text style={styles.title}>Inviter quelqu'un</Text>
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
                    <Text style={styles.qrPlaceholderText}>Génération...</Text>
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
              Scannez ce QR code pour rejoindre
            </Text>
          </View>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>ou partagez le code</Text>
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
                  {copied ? 'Copié !' : 'Appuyez pour copier'}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Info */}
          <View style={styles.infoCard}>
            <Text style={styles.infoIcon}>ℹ️</Text>
            <Text style={styles.infoText}>
              Partagez ce code uniquement avec les personnes que vous souhaitez inviter. 
              Toute personne possédant ce code peut rejoindre la conversation.
            </Text>
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <Button
              title={shared ? '✓ Partagé !' : 'Partager l\'invitation'}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  closeButton: {
    width: 70,
  },
  closeText: {
    fontSize: 16,
    color: theme.colors.primary,
    fontWeight: '500',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.text,
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
    color: theme.colors.text,
    marginBottom: 12,
  },
  conversationBadge: {
    backgroundColor: theme.colors.surface,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  conversationName: {
    fontSize: 15,
    color: theme.colors.textSecondary,
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
    backgroundColor: theme.colors.surface,
    borderRadius: 8,
  },
  qrPlaceholderText: {
    color: theme.colors.textSecondary,
  },
  qrCorner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: theme.colors.primary,
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
    color: theme.colors.textMuted,
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
    backgroundColor: theme.colors.divider,
  },
  dividerText: {
    fontSize: 13,
    color: theme.colors.textMuted,
    paddingHorizontal: 16,
  },
  
  // Code Section
  codeSection: {
    width: '100%',
    marginBottom: 24,
  },
  codeBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  codeContent: {
    padding: 16,
    alignItems: 'center',
  },
  codeText: {
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: theme.colors.text,
    letterSpacing: 1,
    lineHeight: 24,
  },
  copyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceLight,
    paddingVertical: 14,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  copyIndicatorActive: {
    backgroundColor: theme.colors.success + '20',
  },
  copyIcon: {
    fontSize: 16,
  },
  copyText: {
    fontSize: 14,
    fontWeight: '500',
    color: theme.colors.textSecondary,
  },
  copyTextActive: {
    color: theme.colors.success,
  },
  
  // Info Card
  infoCard: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
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
    color: theme.colors.textSecondary,
    lineHeight: 19,
  },
  
  // Actions
  actions: {
    width: '100%',
  },
});

export default InviteModal;