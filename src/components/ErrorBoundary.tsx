// src/components/ErrorBoundary.tsx
// Garde-fou global : capture toute exception levée pendant le rendu d'un écran
// (ex. un composant tiers qui throw — comme un QR dont la valeur dépasse la
// capacité maximale) et affiche un écran de repli au lieu de laisser l'app
// planter en écran noir nécessitant un redémarrage forcé.
//
// Sans ce boundary, une exception de rendu non capturée démonte tout l'arbre
// React → écran blanc/noir figé (le symptôme rapporté sur l'invitation QR).

import { Component, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
  /** Repli personnalisé (optionnel). Reçoit l'erreur + une fonction de reset. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Notifié à chaque capture (journalisation/télémétrie). */
  onError?: (error: Error, info: { componentStack: string }) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // eslint-disable-next-line no-undef
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.error('[ErrorBoundary] Exception de rendu capturée:', error, info.componentStack);
    }
    try { this.props.onError?.(error, info); } catch {}
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const tr = (k: string, fallback: string) => {
      try { return i18n.t(k, { defaultValue: fallback }) as string; } catch { return fallback; }
    };
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.icon}>⚠️</Text>
          <Text style={styles.title}>{tr('errorBoundary.title', 'Something went wrong')}</Text>
          <Text style={styles.subtitle}>
            {tr('errorBoundary.subtitle', 'This screen ran into an unexpected problem. You can go back and try again without closing the app.')}
          </Text>
          {isDev ? (
            <Text style={styles.errorText} numberOfLines={8}>
              {error.message}
            </Text>
          ) : null}
          <TouchableOpacity style={styles.button} onPress={this.reset} activeOpacity={0.8}>
            <Text style={styles.buttonText}>{tr('errorBoundary.action', 'Go back')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0F14' },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#F0F4F8', textAlign: 'center', marginBottom: 12 },
  subtitle: { fontSize: 15, color: '#8BA4B8', textAlign: 'center', lineHeight: 22, marginBottom: 20 },
  errorText: {
    fontSize: 12, color: '#FF6B6B', textAlign: 'center', marginBottom: 24,
    fontFamily: 'monospace', paddingHorizontal: 12,
  },
  button: {
    backgroundColor: '#00D9A6', paddingVertical: 14, paddingHorizontal: 40,
    borderRadius: 14, marginTop: 8,
  },
  buttonText: { color: '#04231C', fontSize: 16, fontWeight: '700' },
});
