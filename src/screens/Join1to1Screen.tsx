// src/screens/Join1to1Screen.tsx
// v4.0 - Uses ConnectionSuccessScreen for success + SplashScreen for processing
//
// Changes from v3:
// - Processing step uses SplashScreen component for consistent loading UX
// - Success step navigates to ConnectionSuccessScreen (same design as creator)
// - Removed inline success UI (was inconsistent with ConnectionSuccessScreen)

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';

import { sessionService } from '../services/tripleRatchet';
import { theme, Header, Button } from '../components/ui';
import { SplashScreen } from './SplashScreen';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string };
  Join1to1: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Join1to1'>;

type Step = 'choose' | 'scan' | 'manual' | 'processing';

export function Join1to1Screen() {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  
  const [step, setStep] = useState<Step>('choose');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  
  // Manual input
  const [codeInput, setCodeInput] = useState('');
  
  const scannedRef = useRef(false);
  const lastInviteStringRef = useRef<string>('');

  useEffect(() => {
    sessionService.initialize().catch(console.error);
  }, []);

  useEffect(() => {
    if (step === 'choose' || step === 'scan' || step === 'manual') {
      scannedRef.current = false;
      setError(null);
    }
  }, [step]);

  // ==========================================
  // PROCESS INVITE → ConnectionSuccessScreen
  // ==========================================
  
  const processInvite = async (inviteString: string) => {
    setStep('processing');
    setLoading(true);
    setError(null);
    setStatusMessage('Décodage de l\'invitation…');
    lastInviteStringRef.current = inviteString;
    
    try {
      await sessionService.initialize();
      
      setStatusMessage('Établissement de la connexion sécurisée…');
      
      const result = await sessionService.acceptInviteAndRespond(inviteString);
      
      setStatusMessage('Connexion établie !');
      
      const contactName = result.session.theirProfile.displayName || 'Contact';
      
      // Navigate to the SAME ConnectionSuccessScreen used by creators
      navigation.replace('ConnectionSuccess', {
        sessionId: result.session.id,
        contactName,
        inviteLabel: 'code d\'invitation',
      });
      
    } catch (e: any) {
      console.error('[Join1to1] Error:', e);
      
      // Existing session detected → offer replacement
      if (e.isExistingSession) {
        setLoading(false);
        Alert.alert(
          'Conversation existante',
          `Vous avez déjà une conversation avec ${e.existingContactName}. Voulez-vous reconnecter ? L'ancienne session sera remplacée.`,
          [
            {
              text: 'Annuler',
              style: 'cancel',
              onPress: () => {
                scannedRef.current = false;
                setStep('choose');
              },
            },
            {
              text: 'Reconnecter',
              style: 'destructive',
              onPress: () => processInviteReplace(inviteString, e.existingSessionId),
            },
          ],
        );
        return;
      }
      
      setError(e.message || 'Erreur lors de la connexion');
      setStep('choose');
    } finally {
      setLoading(false);
    }
  };
  
  const processInviteReplace = async (inviteString: string, existingSessionId: string) => {
    setStep('processing');
    setLoading(true);
    setError(null);
    setStatusMessage('Remplacement de la session…');
    
    try {
      await sessionService.initialize();
      
      setStatusMessage('Établissement de la connexion sécurisée…');
      
      const result = await sessionService.acceptInviteAndReplace(inviteString, existingSessionId);
      
      const contactName = result.session.theirProfile.displayName || 'Contact';
      
      navigation.replace('ConnectionSuccess', {
        sessionId: result.session.id,
        contactName,
        inviteLabel: 'code d\'invitation',
      });
      
    } catch (e: any) {
      console.error('[Join1to1] Replace error:', e);
      setError(e.message || 'Erreur lors de la reconnexion');
      setStep('choose');
    } finally {
      setLoading(false);
    }
  };

  // ==========================================
  // SCAN QR CODE
  // ==========================================
  
  const handleQRScanned = useCallback(async (result: BarcodeScanningResult) => {
    if (scannedRef.current) return;
    
    const { data } = result;
    
    if (data.length < 20 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      return;
    }
    
    console.log('[Join1to1] QR scanned, length:', data.length);
    
    scannedRef.current = true;
    await processInvite(data);
  }, []);

  // ==========================================
  // MANUAL SUBMIT
  // ==========================================
  
  const handleManualSubmit = async () => {
    const input = codeInput.trim().replace(/\s+/g, '');
    
    if (!input) {
      setError('Veuillez coller le code d\'invitation');
      return;
    }
    
    if (input.length < 20) {
      setError('Code trop court. Assurez-vous de copier le code complet.');
      return;
    }
    
    console.log('[Join1to1] Manual input, length:', input.length);
    
    await processInvite(input);
  };

  // ==========================================
  // CHOOSE METHOD
  // ==========================================
  
  if (step === 'choose') {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title="Rejoindre" onBackPress={() => navigation.goBack()} />
        
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
          <View style={styles.headerSection}>
            <View style={styles.iconContainer}>
              <Text style={styles.icon}>🔗</Text>
            </View>
            <Text style={styles.title}>Rejoindre une conversation</Text>
            <Text style={styles.subtitle}>
              Scannez le QR code pour établir une connexion privée
            </Text>
          </View>

          <View style={styles.options}>
            <TouchableOpacity style={styles.optionCard} onPress={() => setStep('scan')} activeOpacity={0.7}>
              <View style={styles.optionIconWrapper}>
                <Text style={styles.optionIcon}>📷</Text>
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>Scanner le QR code</Text>
                <Text style={styles.optionSubtitle}>Rapide et facile</Text>
              </View>
              <Text style={styles.optionChevron}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.optionCard} onPress={() => setStep('manual')} activeOpacity={0.7}>
              <View style={styles.optionIconWrapper}>
                <Text style={styles.optionIcon}>📋</Text>
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>Coller le code</Text>
                <Text style={styles.optionSubtitle}>Si vous avez reçu le code par message</Text>
              </View>
              <Text style={styles.optionChevron}>›</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.infoBox}>
            <Text style={styles.infoTitle}>🔐 Sécurité automatique</Text>
            <Text style={styles.infoText}>
              Les clés de chiffrement sont créées localement sur chaque téléphone. Aucune donnée sensible ne transite par le serveur.
            </Text>
          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  // ==========================================
  // SCAN QR
  // ==========================================
  
  if (step === 'scan') {
    if (!permission) {
      return (
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
          <Header title="Scanner" onBackPress={() => setStep('choose')} />
          <View style={styles.centerContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        </View>
      );
    }

    if (!permission.granted) {
      return (
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
          <Header title="Scanner" onBackPress={() => setStep('choose')} />
          <View style={styles.permissionContent}>
            <View style={styles.iconContainer}>
              <Text style={styles.icon}>📷</Text>
            </View>
            <Text style={styles.title}>Accès à la caméra</Text>
            <Text style={styles.subtitle}>
              Autorisez l'accès à la caméra pour scanner le QR code
            </Text>
            <View style={{ marginTop: 24, width: '100%', paddingHorizontal: 40 }}>
              <Button title="Autoriser" onPress={requestPermission} variant="primary" size="large" fullWidth />
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.container}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleQRScanned}
        >
          <View style={[styles.scannerOverlay, { paddingTop: insets.top }]}>
            <View style={styles.scannerHeader}>
              <TouchableOpacity style={styles.scannerBackButton} onPress={() => setStep('choose')}>
                <Text style={styles.scannerBackIcon}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.scannerTitle}>Scanner le QR code</Text>
              <View style={styles.scannerPlaceholder} />
            </View>
            
            <View style={styles.scanFrameContainer}>
              <View style={styles.scanFrame}>
                <View style={[styles.corner, styles.topLeft]} />
                <View style={[styles.corner, styles.topRight]} />
                <View style={[styles.corner, styles.bottomLeft]} />
                <View style={[styles.corner, styles.bottomRight]} />
              </View>
            </View>
            
            <View style={[styles.scannerFooter, { paddingBottom: insets.bottom + 20 }]}>
              <Text style={styles.scannerHint}>
                Placez le QR code dans le cadre
              </Text>
            </View>
          </View>
        </CameraView>
      </View>
    );
  }

  // ==========================================
  // MANUAL INPUT
  // ==========================================
  
  if (step === 'manual') {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title="Coller le code" onBackPress={() => setStep('choose')} />
        
        <KeyboardAvoidingView 
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.headerSection}>
            <Text style={styles.title}>Code d'invitation</Text>
            <Text style={styles.subtitle}>
              Collez le code que vous avez reçu de votre contact
            </Text>
          </View>

          <View style={styles.form}>
            <TextInput
              style={styles.codeInput}
              value={codeInput}
              onChangeText={setCodeInput}
              placeholder="Collez le code ici..."
              placeholderTextColor={theme.colors.textMuted}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>
              Le code est une longue chaîne de caractères
            </Text>
          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.bottomActions}>
          <Button
            title="Se connecter"
            onPress={handleManualSubmit}
            variant="primary"
            size="large"
            fullWidth
            loading={loading}
          />
        </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ==========================================
  // PROCESSING → Uses SplashScreen for consistent UX
  // ==========================================
  
  if (step === 'processing') {
    return <SplashScreen statusMessage={statusMessage} />;
  }

  return null;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  scrollView: { flex: 1 },
  content: { padding: 24 },
  centerContent: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  permissionContent: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  
  headerSection: { alignItems: 'center', marginBottom: 24 },
  iconContainer: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: theme.colors.primary + '20',
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  icon: { fontSize: 36 },
  title: { fontSize: 24, fontWeight: '700', color: theme.colors.text, marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  
  options: { gap: 12, marginBottom: 24 },
  optionCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.colors.surface, borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  optionIconWrapper: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: theme.colors.primary + '15',
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  optionIcon: { fontSize: 22 },
  optionContent: { flex: 1 },
  optionTitle: { fontSize: 16, fontWeight: '600', color: theme.colors.text, marginBottom: 2 },
  optionSubtitle: { fontSize: 13, color: theme.colors.textSecondary },
  optionChevron: { fontSize: 24, color: theme.colors.textMuted },
  
  infoBox: {
    backgroundColor: theme.colors.primary + '10',
    borderRadius: 12, padding: 16,
  },
  infoTitle: { fontSize: 15, fontWeight: '600', color: theme.colors.text, marginBottom: 8 },
  infoText: { fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 },
  
  // Scanner
  camera: { flex: 1 },
  scannerOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  scannerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.5)',
  },
  scannerBackButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  scannerBackIcon: { fontSize: 28, color: '#FFF', marginTop: -2 },
  scannerTitle: { fontSize: 17, fontWeight: '600', color: '#FFF' },
  scannerPlaceholder: { width: 40 },
  scanFrameContainer: { alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 250, height: 250 },
  corner: { position: 'absolute', width: 40, height: 40, borderColor: theme.colors.primary },
  topLeft: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  topRight: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 },
  scannerFooter: {
    alignItems: 'center', backgroundColor: theme.colors.background,
    paddingTop: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  scannerHint: { fontSize: 15, color: theme.colors.text },
  
  // Form
  form: { marginBottom: 20 },
  codeInput: {
    backgroundColor: theme.colors.inputBackground,
    borderRadius: 16, borderWidth: 1.5, borderColor: theme.colors.inputBorder,
    paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 13, color: theme.colors.text,
    minHeight: 140, textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  hint: { fontSize: 12, color: theme.colors.textMuted, marginTop: 8, marginLeft: 4 },
  
  // Error
  errorBanner: {
    backgroundColor: theme.colors.danger + '15',
    borderRadius: 12, padding: 16, marginTop: 16,
  },
  errorText: { fontSize: 14, color: theme.colors.danger, textAlign: 'center' },
  
  // Bottom
  bottomActions: { padding: 20, borderTopWidth: 1, borderTopColor: theme.colors.divider },
});

export default Join1to1Screen;
