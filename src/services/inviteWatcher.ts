// src/services/inviteWatcher.ts
// Surveillance en arrière-plan des invitations en attente
//
// Interroge le serveur pour TOUS les tags d'invitations pendantes.
// Quand un message ghostr_accept_pq est détecté, finalise la session
// automatiquement via sessionService.finalizeSession().

import { pendingInviteStore, PendingInvite } from './pendingInvites';
import { sessionService, StoredSession } from './tripleRatchet';
import { secureRpc } from './relayTransport';

const POLL_INTERVAL_ACTIVE = 3000;  // 3s quand il y a des invitations
const POLL_INTERVAL_IDLE = 30000;   // 30s quand aucune invitation
const BATCH_SIZE = 20;              // Max tags par requête

export type InviteAcceptedCallback = (
  session: StoredSession,
  invite: PendingInvite
) => void;

class InviteWatcher {
  private running = false;
  private timeoutId: NodeJS.Timeout | null = null;
  private processedIds: Set<string> = new Set();
  private callbacks: Set<InviteAcceptedCallback> = new Set();
  private pollCount = 0;

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async start(): Promise<void> {
    if (this.running) {
      __DEV__ && console.log('[InviteWatcher] Already running, skipping start');
      return;
    }
    this.running = true;
    this.pollCount = 0;
    try {
      await pendingInviteStore.load();
      const pendingCount = pendingInviteStore.getPending().length;
      __DEV__ && console.log(`[InviteWatcher] ✅ Started (${pendingCount} pending invitations)`);
    } catch (e) {
      console.error('[InviteWatcher] ⚠️ Load error during start:', e);
    }
    this.schedulePoll(500); // Premier poll rapide
  }

  stop(): void {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    __DEV__ && console.log('[InviteWatcher] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start only if not already running (safe to call multiple times)
   */
  ensureRunning(): void {
    if (!this.running) {
      __DEV__ && console.log('[InviteWatcher] ensureRunning: was NOT running, starting now...');
      this.start().catch(e => console.error('[InviteWatcher] ensureRunning error:', e));
    }
  }

  // ==========================================
  // ÉVÉNEMENTS
  // ==========================================

  onAccepted(cb: InviteAcceptedCallback): () => void {
    this.callbacks.add(cb);
    __DEV__ && console.log(`[InviteWatcher] Callback registered (total: ${this.callbacks.size})`);
    return () => { this.callbacks.delete(cb); };
  }

  private notifyAccepted(session: StoredSession, invite: PendingInvite): void {
    __DEV__ && console.log(`[InviteWatcher] 📣 Notifying ${this.callbacks.size} listeners`);
    for (const cb of this.callbacks) {
      try { cb(session, invite); }
      catch (e) { console.error('[InviteWatcher] Callback error:', e); }
    }
  }

  // ==========================================
  // POLLING
  // ==========================================

  private schedulePoll(delay: number): void {
    if (!this.running) return;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this.timeoutId = setTimeout(() => this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    this.pollCount++;
    
    // [Bug #3] Récupérer les tags pending + les tags accepted-mais-session-supprimée
    const pendingTags = pendingInviteStore.getPendingTags();
    const orphanTags = this.getOrphanAcceptedTags();
    const tags = [...pendingTags, ...orphanTags];

    if (tags.length === 0) {
      if (this.pollCount % 10 === 1) {
        __DEV__ && console.log('[InviteWatcher] 💤 No pending invites, idle polling');
      }
      this.schedulePoll(POLL_INTERVAL_IDLE);
      return;
    }

    // Log premiers polls, puis toutes les 10 itérations
    if (this.pollCount <= 3 || this.pollCount % 10 === 0) {
      __DEV__ && console.log(`[InviteWatcher] 🔍 Poll #${this.pollCount}: checking ${tags.length} tag(s): ${tags.map(t => t.substring(0, 8) + '...').join(', ')}`);
    }

    try {
      for (let i = 0; i < tags.length; i += BATCH_SIZE) {
        if (!this.running) return;
        
        const batch = tags.slice(i, i + BATCH_SIZE);

        // P14 fix: Use secureRpc (OHTTP relay) instead of direct supabase.rpc()
        // Direct Supabase calls go through CF Worker legacy proxy which is now
        // restricted to /storage/* routes only.
        const { data, error } = await secureRpc('get_messages_by_tags', {
          p_tags: batch,
          p_since: null,
          p_limit: 200,
        });

        if (error) {
          console.warn('[InviteWatcher] ❌ Poll error:', error.message);
          continue;
        }

        if (data && data.length > 0) {
          if (this.pollCount <= 5 || this.pollCount % 10 === 0) {
            __DEV__ && console.log(`[InviteWatcher] 📨 Got ${data.length} message(s) for ${batch.length} tag(s)`);
          }
          // Trier par timestamp DESC — traiter les accepts les plus récents d'abord
          // Critique pour la re-finalisation (Bug #3) : après un restart,
          // si plusieurs accepts existent sur un tag, le plus récent doit être
          // finalisé en premier (clés éphémères correctes). Les plus anciens
          // seront ensuite ignorés par la dédup état (session existe déjà).
          const sorted = [...data].sort((a: any, b: any) => {
            const tsA = a.created_at ? new Date(a.created_at).getTime() : 0;
            const tsB = b.created_at ? new Date(b.created_at).getTime() : 0;
            return tsB - tsA; // DESC
          });
          for (const msg of sorted) {
            await this.processMessage(msg);
          }
        }
      }
    } catch (e: any) {
      console.warn('[InviteWatcher] ❌ Poll failed:', e.message || e);
    }

    if (this.running) {
      this.schedulePoll(POLL_INTERVAL_ACTIVE);
    }
  }

  // ==========================================
  // TRAITEMENT DES MESSAGES
  // ==========================================

  private async processMessage(msg: any): Promise<void> {
    // [Bug #4] processedIds reste un cache rapide in-memory,
    // mais n'est plus la seule source de dédup.
    // La logique d'état (invite.status + hasSession) est la vraie protection.
    if (this.processedIds.has(msg.id)) return;

    try {
      let payload: any;
      try {
        payload = typeof msg.sealed_payload === 'string'
          ? JSON.parse(msg.sealed_payload)
          : msg.sealed_payload;
      } catch (parseErr) {
        console.warn('[InviteWatcher] Could not parse sealed_payload for msg', msg.id);
        this.processedIds.add(msg.id);
        return;
      }

      // On ne s'intéresse qu'aux réponses d'acceptation PQ
      if (payload.type !== 'ghostr_accept_pq') {
        this.processedIds.add(msg.id);
        return;
      }

      if (payload.version !== 2) {
        console.warn(`[InviteWatcher] Unsupported accept version: ${payload.version}`);
        this.processedIds.add(msg.id);
        return;
      }

      // Vérifier que ce tag correspond à une invitation connue
      const invite = pendingInviteStore.getByTag(msg.tag);
      if (!invite) {
        __DEV__ && console.log(`[InviteWatcher] Accept for unknown tag ${msg.tag?.substring(0, 12)}..., skipping`);
        this.processedIds.add(msg.id);
        return;
      }
      
      // [Bug #4] Dédup par état : si l'invite est 'accepted' ET la session existe → déjà traité
      if (invite.status === 'accepted' && invite.sessionId) {
        await sessionService.initialize();
        const sessionExists = sessionService.hasSession(invite.sessionId);
        if (sessionExists) {
          // Session OK, tout est cohérent → skip
          this.processedIds.add(msg.id);
          return;
        }
        
        // [Bug #3] L'invite est 'accepted' MAIS la session n'existe plus (supprimée par l'utilisateur)
        // → Autoriser la re-finalisation pour permettre la reconnexion
        __DEV__ && console.log(`[InviteWatcher] 🔄 Session ${invite.sessionId} was deleted but accept exists — re-finalizing...`);
        
        // Vérification de sécurité : l'identity key du nouvel accept doit matcher
        // (empêche un attaquant d'écraser la session avec une fausse identity key)
        // Note: cette vérification se fait implicitement dans finalizeSession via
        // generateSessionId — si l'identity key diffère, le sessionId sera différent
      }
      
      if (invite.status !== 'pending' && invite.status !== 'accepted') {
        // Status 'expired' → ne pas traiter
        this.processedIds.add(msg.id);
        return;
      }

      __DEV__ && console.log(`[InviteWatcher] 🎉 Accept detected for ${invite.label} on tag ${msg.tag.substring(0, 12)}...`);
      __DEV__ && console.log(`[InviteWatcher]   payload.data length: ${payload.data?.length || 0}`);

      if (!payload.data) {
        console.error('[InviteWatcher] ❌ Accept message has no data field!');
        this.processedIds.add(msg.id);
        return;
      }

      // Finaliser la session
      __DEV__ && console.log('[InviteWatcher] 🔐 Finalizing session...');
      await sessionService.initialize();
      const result = await sessionService.finalizeSession(payload.data);

      const contactName = result.session.theirProfile.displayName || 'Contact';

      // Marquer l'invitation comme acceptée (atomique avec finalizeSession)
      await pendingInviteStore.markAccepted(
        msg.tag,
        result.session.id,
        contactName
      );

      this.processedIds.add(msg.id);
      __DEV__ && console.log(`[InviteWatcher] ✅ Session created: ${result.session.id} with ${contactName}`);

      // Notifier les listeners (UI)
      this.notifyAccepted(result.session, invite);

    } catch (e: any) {
      console.error(`[InviteWatcher] ❌ Failed to process accept:`, e.message);
      this.processedIds.add(msg.id);

      if (e.message?.includes('not found') || e.message?.includes('expired')) {
        try {
          const invite = pendingInviteStore.getByTag(msg.tag);
          if (invite && invite.status === 'pending') {
            await pendingInviteStore.markExpired(msg.tag);
            sessionService.unreserveOtpk(invite.oneTimePreKeyId); // [Bug #1] Libérer l'OTPK
            console.warn(`[InviteWatcher] Invite ${invite.label} marked expired (keys not found)`);
          }
        } catch (markErr) {
          console.error('[InviteWatcher] Failed to mark expired:', markErr);
        }
      }
    }
  }

  // ==========================================
  // MAINTENANCE
  // ==========================================

  /**
   * [Bug #3] Retrouve les invitations 'accepted' dont la session a été supprimée.
   * Ces tags doivent être re-pollés pour permettre la re-finalisation.
   */
  private getOrphanAcceptedTags(): string[] {
    const accepted = pendingInviteStore.getAll().filter(i => i.status === 'accepted' && i.sessionId);
    const orphans: string[] = [];
    for (const inv of accepted) {
      if (!sessionService.hasSession(inv.sessionId!)) {
        orphans.push(inv.tag);
      }
    }
    if (orphans.length > 0) {
      __DEV__ && console.log(`[InviteWatcher] 🔍 Found ${orphans.length} orphan accepted invite(s) (session deleted)`);
    }
    return orphans;
  }

  forcePoll(): void {
    if (!this.running) {
      __DEV__ && console.log('[InviteWatcher] forcePoll: not running, starting first...');
      this.start().catch(e => console.error('[InviteWatcher] forcePoll start error:', e));
      return;
    }
    __DEV__ && console.log('[InviteWatcher] ⚡ Force poll');
    this.schedulePoll(100);
  }

  clearProcessedCache(): void {
    const count = this.processedIds.size;
    this.processedIds.clear();
    if (count > 0) {
      __DEV__ && console.log(`[InviteWatcher] Cleared ${count} processed IDs`);
    }
  }
}

export const inviteWatcher = new InviteWatcher();