// src/services/pendingInvites.ts
// Stockage des invitations en attente (QR codes pré-générés)
//
// Chaque invitation pré-générée est associée aux IDs des clés
// cryptographiques utilisées lors de sa création (signedPreKeyId,
// pqSignedKeyId, oneTimePreKeyId). Cela permet au SessionService
// de retrouver les bonnes clés (courantes ou archivées) lorsque
// le contact accepte l'invitation des jours/semaines plus tard.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptIfEnabled, decryptIfNeeded, isEncryptionEnabled } from './localCrypto';

const STORAGE_KEY = 'ghostr_pending_invites';
const COUNTER_KEY = 'ghostr_pending_invite_counter';

// Durée de vie max d'une invitation (aligné sur cleanup serveur)
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

export interface PendingInvite {
  // Tag anonyme (identifiant unique sur le serveur)
  tag: string;

  // Données du QR code (base64 pour régénérer le QR)
  inviteString: string;

  // IDs des clés crypto utilisées lors de la création
  // Nécessaires pour que finalizeSession retrouve les bonnes clés
  signedPreKeyId: number;
  pqSignedKeyId: number;
  oneTimePreKeyId?: number;

  // Métadonnées
  label: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'accepted' | 'expired';

  // Rempli quand le contact accepte
  sessionId?: string;
  contactName?: string;
}

type ChangeListener = () => void;

class PendingInviteStore {
  private invites: Map<string, PendingInvite> = new Map();
  private listeners: Set<ChangeListener> = new Set();
  private loaded = false;
  private counter = 0;

  // ==========================================
  // INITIALISATION
  // ==========================================

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        // Si les données sont chiffrées mais la clé n'est pas encore disponible
        // (startup avant unlock), on reporte le chargement
        if (raw.startsWith('enc1:') && !isEncryptionEnabled()) {
          __DEV__ && console.warn('[PendingInvites] Data encrypted, key not yet available — deferring load');
          return; // this.loaded reste false → retry après unlock
        }
        const json = decryptIfNeeded(raw);
        const items: PendingInvite[] = JSON.parse(json);
        for (const inv of items) {
          this.invites.set(inv.tag, inv);
        }
      }
      const rawCounter = await AsyncStorage.getItem(COUNTER_KEY);
      if (rawCounter) {
        if (rawCounter.startsWith('enc1:') && !isEncryptionEnabled()) {
          return; // Même logique, reporter
        }
        const counterStr = decryptIfNeeded(rawCounter);
        this.counter = parseInt(counterStr, 10) || 0;
      }
      this.loaded = true;
      this.cleanupExpired();
    } catch (e) {
      __DEV__ && console.error('[PendingInvites] Load error:', e);
      this.loaded = true;
    }
  }

  private async persist(): Promise<void> {
    try {
      const items = Array.from(this.invites.values());
      await AsyncStorage.setItem(STORAGE_KEY, encryptIfEnabled(JSON.stringify(items)));
      await AsyncStorage.setItem(COUNTER_KEY, encryptIfEnabled(this.counter.toString()));
    } catch (e) {
      __DEV__ && console.error('[PendingInvites] Persist error:', e);
    }
  }

  // ==========================================
  // CRUD
  // ==========================================

  async add(
    tag: string,
    inviteString: string,
    keyIds: { signedPreKeyId: number; pqSignedKeyId: number; oneTimePreKeyId?: number },
    label?: string
  ): Promise<PendingInvite> {
    await this.load();
    this.counter++;
    const invite: PendingInvite = {
      tag,
      inviteString,
      signedPreKeyId: keyIds.signedPreKeyId,
      pqSignedKeyId: keyIds.pqSignedKeyId,
      oneTimePreKeyId: keyIds.oneTimePreKeyId,
      label: label || `Invitation #${this.counter}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_EXPIRY_MS,
      status: 'pending',
    };
    this.invites.set(tag, invite);
    await this.persist();
    this.notify();
    __DEV__ && console.log(`[PendingInvites] Added: ${invite.label} (tag: ${tag.substring(0, 12)}...)`);
    return invite;
  }

  async markAccepted(tag: string, sessionId: string, contactName: string): Promise<void> {
    const inv = this.invites.get(tag);
    if (inv) {
      inv.status = 'accepted';
      inv.sessionId = sessionId;
      inv.contactName = contactName;
      await this.persist();
      this.notify();
      __DEV__ && console.log(`[PendingInvites] Accepted: ${inv.label}`);
    }
  }

  async markExpired(tag: string): Promise<void> {
    const inv = this.invites.get(tag);
    if (inv) {
      inv.status = 'expired';
      await this.persist();
      this.notify();
      __DEV__ && console.log(`[PendingInvites] Expired: ${inv.label}`);
    }
  }

  /**
   * Expire toutes les invitations associées à un sessionId.
   * 
   * CRITIQUE: Appelé quand une session est supprimée intentionnellement.
   * Sans cela, l'InviteWatcher détecte l'invite comme "orpheline"
   * et re-finalise l'ancien accept PQXDH → session zombie avec ratchet périmé.
   */
  async markExpiredBySessionId(sessionId: string): Promise<void> {
    let changed = false;
    for (const inv of this.invites.values()) {
      if (inv.sessionId === sessionId && inv.status === 'accepted') {
        inv.status = 'expired';
        changed = true;
        __DEV__ && console.log(`[PendingInvites] Expired by sessionId: ${inv.label} (tag: ${inv.tag.substring(0, 12)}...)`);
      }
    }
    if (changed) {
      await this.persist();
      this.notify();
    }
  }

  async remove(tag: string): Promise<void> {
    const inv = this.invites.get(tag);
    if (inv) {
      __DEV__ && console.log(`[PendingInvites] Removed: ${inv.label}`);
      this.invites.delete(tag);
      await this.persist();
      this.notify();
    }
  }

  async removeAll(): Promise<void> {
    this.invites.clear();
    await this.persist();
    this.notify();
  }

  // ==========================================
  // QUERIES
  // ==========================================

  getAll(): PendingInvite[] {
    this.cleanupExpired();
    return Array.from(this.invites.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getPending(): PendingInvite[] {
    return this.getAll().filter(i => i.status === 'pending');
  }

  getByTag(tag: string): PendingInvite | undefined {
    return this.invites.get(tag);
  }

  getPendingTags(): string[] {
    return this.getPending().map(i => i.tag);
  }

  getPendingCount(): number {
    return this.getPending().length;
  }

  // ==========================================
  // EXPIRATION
  // ==========================================

  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const inv of this.invites.values()) {
      if (inv.status === 'pending' && now > inv.expiresAt) {
        inv.status = 'expired';
        changed = true;
      }
    }
    if (changed) {
      this.persist().catch(e => __DEV__ && console.error(e));
    }
  }

  // ==========================================
  // LISTENERS
  // ==========================================

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch (e) { __DEV__ && console.error('[PendingInvites] Listener error:', e); }
    }
  }
}

export const pendingInviteStore = new PendingInviteStore();