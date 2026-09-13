// ════════════════════════════════════════════════════════════════════════════
// apiGroups.ts — Couche réseau & fiabilité des conversations de groupe (3B, v2)
// ════════════════════════════════════════════════════════════════════════════
//
// RÉALIGNÉ sur le modèle CORRIGÉ (CONCEPTION-GROUPES-V2.md) :
//   • AJOUT : l'epoch NE change PAS ; on transmet au nouveau les Sender Keys au
//     gen COURANT (exportMySenderKeyAtCurrentGen / exportHeldSenderKeys).
//     → aucun message en vol invalidé.
//   • RETRAIT : rotation (epoch++) + redistribution → PCS.
//   • ROSTER VERSIONNÉ : rosterVersion ; l'admin est source de vérité.
//   • RÉCONCILIATION : au retour en ligne, un membre demande l'état courant à un
//     admin (group_roster_sync_request → group_roster_state) → comble toute
//     notif manquée, même expirée côté serveur (rétention 48h).
//
// TRANSPORT : un message de groupe vers le membre X = un message 1:1 normal vers
// X (padding → Triple Ratchet → Sealed Sender → trafic constant). Le serveur
// reste aveugle. L'admin n'est PAS un relais de contenu (les messages restent
// pair-à-pair) — il n'est autorité que pour le roster/les clés.
//
// PAS DE CYCLE : apiGroups importe api1to1 ; api1to1 importe apiGroups
// DYNAMIQUEMENT (import('./apiGroups')) dans ses switchs de réception.
//
// FIABILITÉ DES CLÉS : pas via l'outbox 1:1 (le resend handler ne sait pas
// reconstruire un envelope de groupe). Robustesse assurée par :
//   (a) group_key_request réactif (trou intra-epoch, session existante),
//   (b) RÉCONCILIATION au retour (cross-roster / cross-epoch, via l'admin).
// ════════════════════════════════════════════════════════════════════════════

import {
  sendInnerPayload,
  saveLocalMessage1to1,
  getLocalMessages1to1,
  type InnerPayload,
  type Message1to1,
} from './api1to1';
import { sessionService } from './tripleRatchet';
import * as groups from './groupService';
import { getSecureRandomBytes, bytesToHex } from './tripleRatchet/primitives';
import type { GroupCiphertext, GroupMember, SenderKeyShare, RosterStateMember } from './groupService';
import { GroupError } from './errorMessages';

declare const __DEV__: boolean;

// ────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ────────────────────────────────────────────────────────────────────────────

function genId(): string {
  return bytesToHex(getSecureRandomBytes(16));
}

// ────────────────────────────────────────────────────────────────────────────
// PARALLÉLISME BORNÉ (correctif perf fan-out)
// ────────────────────────────────────────────────────────────────────────────
//
// PROBLÈME : les boucles de fan-out étaient strictement séquentielles
//   (`for (const m of recipients) { await ensureSessionToMember(); await send(); }`).
//   Chaque itération enchaîne un chiffrement Triple Ratchet (parfois un braid
//   ML-KEM), une enveloppe sealed sender, puis un aller-retour HTTPS
//   client → relais CF → gateway → Supabase. À ~400 ms par destinataire, un
//   groupe de 20 membres mettait ~8 s à publier UN message, pendant lesquelles
//   l'UI restait en « envoi… ».
//
// SOLUTION : exécuter les envois par vagues de FANOUT_CONCURRENCY.
//   20 membres à 4 en parallèle → 5 vagues → ~2 s au lieu de 8.
//
// POURQUOI PAS UN Promise.all() COMPLET :
//   • le pipeline sealed sender partage un certificat à quota ; une rafale de
//     50 requêtes simultanées risque de déclencher le rate-limit du Worker CF
//     (30/min) et de faire échouer des envois qui auraient réussi ;
//   • la mémoire : chaque envoi matérialise un ciphertext paddé ;
//   • un mobile sur réseau lent gère mal plus de quelques sockets TLS.
//   4 est volontairement conservateur. Ne pas monter sans mesurer le taux
//   d'échec côté gateway.
//
// SÛRETÉ DE LA CONCURRENCE :
//   Chaque itération vise une session 1:1 DIFFÉRENTE. `sessionService` sérialise
//   déjà les opérations crypto par sessionId (`cryptoLocks`), donc deux envois
//   vers deux pairs distincts ne peuvent pas corrompre un état de ratchet
//   partagé. Les mutations du roster (`setMemberSession`) sont synchrones sur
//   une Map en mémoire : en JavaScript mono-thread, aucune interleaving
//   possible à l'intérieur d'un bloc synchrone.

/** Nombre d'envois simultanés lors d'un fan-out de groupe. */
const FANOUT_CONCURRENCY = 4;

/** Issue d'une tâche du fan-out. */
interface SettledResult<R> {
  ok: boolean;
  value?: R;
  error?: unknown;
}

/**
 * Applique `fn` à chaque élément avec au plus `limit` exécutions simultanées.
 * Ne rejette JAMAIS : chaque résultat est encapsulé, à l'image de
 * `Promise.allSettled`. Un destinataire injoignable ne doit pas annuler
 * les envois vers les autres.
 *
 * NOTE DE TYPAGE — on utilise volontairement une forme plate
 * (`{ ok, value?, error? }`) plutôt qu'une union discriminée
 * (`{ok:true,value} | {ok:false,error}`). Le projet ne fournit pas de
 * tsconfig.json, donc la strictness effective est inconnue : sans
 * `strictNullChecks`, TypeScript ne réduit pas fiablement une union
 * discriminée par un booléen, et `res.error` échoue à la compilation.
 * Cette forme fonctionne quel que soit le réglage.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<SettledResult<R>>> {
  const results: Array<SettledResult<R>> = new Array(items.length);

  if (items.length === 0) return results;

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function myProfile(): { fingerprint: string; displayName: string; avatarBase64?: string } {
  const p = sessionService.getMyProfile();
  const fp = sessionService.getMyShortFingerprint();
  return { fingerprint: fp, displayName: p.displayName, avatarBase64: p.avatarBase64 };
}

/**
 * Construit un InnerPayload de groupe (type group_*) avec contenu JSON et
 * l'envoie via le pipeline 1:1 (padding → Triple Ratchet → Sealed Sender →
 * trafic constant).
 */
async function sendGroupEnvelope(
  toSessionId: string,
  type: Message1to1['messageType'],
  payloadObj: any,
  sharedMsgId?: string,
  priority: 'normal' | 'urgent' | 'deferred' = 'normal'
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!toSessionId) return { success: false, error: GroupError.NO_SESSION };
  const me = myProfile();
  const messageId = sharedMsgId || genId();
  const inner: InnerPayload = {
    type: type as any,
    content: JSON.stringify(payloadObj),
    senderFingerprint: me.fingerprint,
    displayName: me.displayName,
    timestamp: Date.now(),
    messageId,
  };
  return sendInnerPayload(toSessionId, inner, priority);
}

// ════════════════════════════════════════════════════════════════════════════
// MESH — établissement de session à la demande (lazy mesh + glare resolution)
// ════════════════════════════════════════════════════════════════════════════

/**
 * S'assure qu'une session 1:1 existe vers `member`. Si non, et si j'ai son
 * bundle ET que la règle de glare me désigne initiateur, crée la session via
 * sessionService.createMeshInitiatorSession et renvoie le PQXDHInitialMessage
 * sérialisé (à joindre au premier group_msg pour que le pair finalise sa moitié).
 *
 * Retourne { sessionId, initialMessage } si une session est disponible/créée,
 * ou null si on ne peut pas (pas de bundle, ou c'est au pair d'initier).
 */
const _rosterSyncThrottle = new Map<string, number>();
/** requestRosterSync throttlé (max ~1/8s par groupe) pour l'auto-réparation. */
function maybeRequestRosterSync(groupId: string): void {
  const now = Date.now();
  const last = _rosterSyncThrottle.get(groupId) || 0;
  if (now - last < 8000) return;
  _rosterSyncThrottle.set(groupId, now);
  void requestRosterSync(groupId).catch(() => {});
}

async function ensureSessionToMember(
  groupId: string,
  member: GroupMember
): Promise<{ sessionId: string; initialMessage?: string } | null> {
  // Session connue ET toujours vivante ? on l'utilise.
  if (member.sessionId && sessionService.hasSession(member.sessionId)) {
    return { sessionId: member.sessionId };
  }
  // Référence de session PÉRIMÉE (ex. conversation 1:1 supprimée, clés expirées,
  // session remplacée) → nettoyer et tenter un ré-établissement via le bundle.
  // Sans ça, le fan-out enverrait indéfiniment vers une session inexistante
  // (perte de données permanente pour ce membre).
  if (member.sessionId && !sessionService.hasSession(member.sessionId)) {
    __DEV__ && console.log(`[apiGroups] mesh: session périmée pour ${member.fingerprint.slice(0,8)} — ré-établissement`);
    groups.setMemberSession(groupId, member.fingerprint, '');
    member.sessionId = '';
  }

  const g = groups.getGroup(groupId);
  if (!g) return null;

  // Règle de glare : est-ce à MOI d'initier vers ce membre ?
  if (!groups.shouldIInitiateSession(g.myFingerprint, member.fingerprint)) {
    // C'est au pair d'initier → on attend son premier message (qui créera notre
    // session côté répondeur). Rien à faire ici.
    return null;
  }

  // J'ai son bundle ?
  const bundle = groups.getMemberBundle(groupId, member.fingerprint);
  if (!bundle) {
    __DEV__ && console.log(`[apiGroups] mesh: no bundle for ${member.fingerprint.slice(0,8)} — cannot init yet`);
    return null;
  }

  // Créer la session initiateur.
  try {
    const r = await sessionService.createMeshInitiatorSession(bundle, {
      displayName: member.displayName,
      avatarBase64: member.avatarBase64,
    } as any);
    if (!r) return null;
    groups.setMemberSession(groupId, member.fingerprint, r.sessionId);
    // Mesh tardif : une session vient de s'ouvrir vers ce membre → lui re-livrer
    // les messages récents qu'il n'a pas pu recevoir (anti-replay = pas de doublon).
    void flushRecentToMember(groupId, r.sessionId);
    return { sessionId: r.sessionId, initialMessage: r.initialMessageSerialized || undefined };
  } catch (e) {
    __DEV__ && console.warn('[apiGroups] mesh: createMeshInitiatorSession failed:', e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ENVOI — MESSAGE DE CONTENU (fan-out)
// ════════════════════════════════════════════════════════════════════════════

// Phase 2 — câblage (idempotent) du fournisseur d'identité pour la signature
// d'expéditeur de groupe. Appelé en tête des points d'entrée d'envoi/réception
// pour garantir que la signature est disponible dès que l'identité est chargée.
let _groupIdentityWired = false;
function ensureGroupIdentityWired(): void {
  if (_groupIdentityWired) return;
  groups.setGroupIdentityProvider({
    getMySigningSecretKey: () => sessionService.getMySigningSecretKey(),
    getMyIdentityPublicKey: () => sessionService.getMyIdentityPublicKeyBytes(),
  });
  _groupIdentityWired = true;
}

// ── FIABILITÉ MESH : redélivrance bornée ─────────────────────────────────────
// Mémorise les dernières enveloppes de groupe émises pour les RE-livrer à un
// membre dès qu'une session vers lui s'établit (mesh tardif entre membres non 1:1
// au moment de l'envoi). Idempotent : le destinataire rejette tout doublon via
// l'anti-replay du senderKey (même epoch/gen) → aucun message dupliqué, aucune
// perte une fois la session établie.
const RECENT_BUFFER_MAX = 40;
const RECENT_BUFFER_TTL_MS = 10 * 60 * 1000;
const recentGroupEnvelopes = new Map<string, Array<{ msgId: string; envelope: any; ts: number }>>();

function bufferGroupEnvelope(groupId: string, msgId: string, envelope: any): void {
  const now = Date.now();
  let arr = (recentGroupEnvelopes.get(groupId) || []).filter(e => now - e.ts <= RECENT_BUFFER_TTL_MS);
  arr.push({ msgId, envelope, ts: now });
  if (arr.length > RECENT_BUFFER_MAX) arr = arr.slice(arr.length - RECENT_BUFFER_MAX);
  recentGroupEnvelopes.set(groupId, arr);
}

async function flushRecentToMember(groupId: string, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const now = Date.now();
  const arr = (recentGroupEnvelopes.get(groupId) || []).filter(e => now - e.ts <= RECENT_BUFFER_TTL_MS);
  for (const e of arr) {
    try { await sendGroupEnvelope(sessionId, 'group_msg', e.envelope, e.msgId, 'normal'); } catch {}
  }
}

// ── DISTRIBUTION ADMIN : rediffusion débouncée du roster complet ─────────────
// L'admin est le hub de distribution. Dès qu'il apprend un bundle ou une
// senderKey d'un membre, il rediffuse l'état complet (bundles + senderKeys
// détenus) à TOUS les membres — c'est ce qui permet aux membres NON 1:1 entre
// eux d'obtenir mutuellement leurs bundles et donc d'établir le mesh. Débouncé
// pour coalescer les rafales (ex. ajout de plusieurs contacts d'affilée).
const _adminBroadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAdminRosterBroadcast(groupId: string): void {
  if (!groups.amIAdmin(groupId)) return;
  if (_adminBroadcastTimers.has(groupId)) return; // déjà programmé → coalescence
  const timer = setTimeout(() => {
    _adminBroadcastTimers.delete(groupId);
    void adminBroadcastRosterState(groupId);
  }, 1200);
  _adminBroadcastTimers.set(groupId, timer);
}

async function adminBroadcastRosterState(groupId: string): Promise<void> {
  if (!groups.amIAdmin(groupId)) return;
  const state = groups.buildRosterState(groupId);
  const g = groups.getGroup(groupId);
  if (!state || !g) return;
  const payload = {
    groupId,
    rosterVersion: state.rosterVersion,
    epoch: state.epoch,
    name: state.name,
    avatarBase64: state.avatarBase64,
    description: state.description,
    roster: state.roster,
    senderKeys: groups.exportHeldSenderKeys(groupId),
    bundles: groups.exportHeldBundles(groupId),
  };
  for (const m of g.members) {
    if (m.fingerprint === g.myFingerprint || !m.sessionId) continue;
    try { await sendGroupEnvelope(m.sessionId, 'group_roster_state', payload); } catch {}
  }
}

export async function sendGroupTextMessage(
  groupId: string,
  text: string,
  replyTo?: { id: string; content: string; sender: string }
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  ensureGroupIdentityWired();
  const g = groups.getGroup(groupId);
  if (!g) return { success: false, error: GroupError.UNKNOWN_GROUP };

  // 1) Chiffrement senderKey (une fois).
  const ct = groups.encryptGroupMessage(groupId, text);
  if (!ct) return { success: false, error: GroupError.ENCRYPT_FAILED };

  const me = myProfile();
  const messageId = genId();

  // 2) Sauvegarde locale (stockée sous groupId).
  const local: Message1to1 = {
    id: messageId,
    sessionId: groupId,
    content: text,
    timestamp: Date.now(),
    isMine: true,
    displayName: me.displayName,
    senderAvatarBase64: me.avatarBase64,
    senderFingerprint: me.fingerprint,
    status: 'sending',
    messageType: 'group_msg',
    groupId,
    ...(replyTo && { replyToId: replyTo.id, replyToContent: replyTo.content, replyToSender: replyTo.sender }),
  } as Message1to1;
  await saveLocalMessage1to1(groupId, local);

  // 3) Fan-out : une enveloppe par membre (≠ moi), msgId PARTAGÉ + le gen/epoch.
  const recipients = groups.getFanoutRecipients(groupId);
  if (recipients.length === 0) {
    await markGroupMsgStatus(groupId, messageId, 'sent');
    return { success: true, messageId };
  }

  const envelope = { ciphertext: ct, replyTo: replyTo || null, msgId: messageId };

  // Fan-out parallélisé (au plus FANOUT_CONCURRENCY envois simultanés).
  // Sémantique identique à l'ancienne boucle séquentielle : chaque destinataire
  // reçoit la même enveloppe, un échec est isolé, et `anySuccess` reste vrai dès
  // qu'un seul envoi a abouti.
  const fanoutResults = await mapWithConcurrency(
    recipients,
    FANOUT_CONCURRENCY,
    async (m) => {
      // Mesh : s'assurer d'une session (créée à la demande si je suis l'initiateur).
      const sess = await ensureSessionToMember(groupId, m);
      if (!sess) {
        // Pas de session et je ne suis pas l'initiateur (ou bundle manquant) :
        // le pair m'écrira en premier (créant ma session côté répondeur), ou la
        // réconciliation comblera. On ne perd pas le message localement (déjà
        // sauvegardé) ; il sera (re)livré quand la session existera.
        __DEV__ && console.log(`[apiGroups] fan-out: no session yet to ${m.fingerprint.slice(0,8)} — deferred`);
        return false;
      }
      // Joindre le PQXDHInitialMessage au tout premier envoi (création de session).
      const payload = sess.initialMessage
        ? { ...envelope, pqxdhInit: sess.initialMessage }
        : envelope;
      const r = await sendGroupEnvelope(sess.sessionId, 'group_msg', payload, messageId, 'normal');
      return !!r.success;
    }
  );

  let anySuccess = false;
  for (const res of fanoutResults) {
    if (res.ok) {
      if (res.value) anySuccess = true;
    } else {
      __DEV__ && console.warn('[apiGroups] fan-out to member failed:', res.error);
    }
  }

  // Mémoriser pour redélivrance aux membres dont la session s'établira plus tard
  // (mesh tardif). Placé APRÈS le fan-out → ne contient que des messages passés
  // vis-à-vis de tout envoi en cours.
  bufferGroupEnvelope(groupId, messageId, envelope);

  await markGroupMsgStatus(groupId, messageId, anySuccess ? 'sent' : 'failed');
  return { success: anySuccess, messageId };
}

async function markGroupMsgStatus(groupId: string, messageId: string, status: Message1to1['status']): Promise<void> {
  try {
    const msgs = await getLocalMessages1to1(groupId);
    const m = msgs.find((x: Message1to1) => x.id === messageId);
    if (m && m.status !== status) {
      m.status = status;
      await saveLocalMessage1to1(groupId, m);
    }
  } catch {}
}

// ════════════════════════════════════════════════════════════════════════════
// CRÉATION DE GROUPE (côté admin)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Crée un groupe + ajoute des membres initiaux (contacts 1:1 existants).
 * Renvoie le groupId. Chaque membre reçoit un welcome (modèle v2 : roster +
 * toutes les clés détenues + ma clé au gen courant).
 */
export async function createGroup(params: {
  name: string;
  description?: string;
  avatarBase64?: string;
  approvalRequired?: boolean;
  initialMembers?: Array<{ sessionId: string; fingerprint: string; displayName: string; avatarBase64?: string }>;
}): Promise<{ success: boolean; groupId?: string; error?: string }> {
  const me = myProfile();
  if (!me.fingerprint) return { success: false, error: GroupError.NO_IDENTITY };

  const g = groups.createGroupLocal({
    name: params.name,
    myFingerprint: me.fingerprint,
    myDisplayName: me.displayName,
    myAvatarBase64: me.avatarBase64,
    description: params.description,
    approvalRequired: params.approvalRequired ?? true,
  });
  if (params.avatarBase64) groups.updateGroupMeta(g.groupId, { avatarBase64: params.avatarBase64 });

  await appendSystemMessage(g.groupId, 'Vous avez créé le groupe');

  // Ajouter les membres initiaux.
  for (const m of (params.initialMembers || [])) {
    await addMemberBySession(g.groupId, m.sessionId, m.fingerprint, m.displayName, m.avatarBase64);
  }

  return { success: true, groupId: g.groupId };
}

// ════════════════════════════════════════════════════════════════════════════
// AJOUT / RETRAIT / PROMOTION (admin)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Ajoute un contact 1:1 existant comme membre (ADMIN). MODÈLE v2 :
 *   1. addMemberLocal → rosterVersion++ (epoch INCHANGÉE, aucune chaîne touchée)
 *   2. group_welcome au nouveau : roster complet + TOUTES les clés détenues
 *      (l'admin agrège via exportHeldSenderKeys) + ma clé au gen courant
 *   3. group_member_added aux autres (avec rosterVersion) pour mettre à jour
 *      leur roster — best-effort ; la réconciliation comble si manqué.
 */
export async function addMemberBySession(
  groupId: string,
  memberSessionId: string,
  memberFingerprint: string,
  memberDisplayName: string,
  memberAvatarBase64?: string
): Promise<{ success: boolean; error?: string }> {
  const g = groups.getGroup(groupId);
  if (!g) return { success: false, error: GroupError.UNKNOWN_GROUP };
  if (!groups.amIAdmin(groupId)) return { success: false, error: GroupError.NOT_ADMIN };
  if (groups.getMembers(groupId).length >= groups.MAX_GROUP_MEMBERS) {
    return { success: false, error: GroupError.GROUP_FULL };
  }

  const rv = groups.addMemberLocal(groupId, {
    fingerprint: memberFingerprint,
    sessionId: memberSessionId,
    displayName: memberDisplayName,
    avatarBase64: memberAvatarBase64,
    role: 'member',
    joinedAtEpoch: 0, // recalculé par addMemberLocal
  });
  if (rv === null) return { success: false, error: GroupError.ADD_MEMBER_FAILED };

  // 2) Welcome enrichi : roster + toutes les clés que je détiens (gen courant).
  const state = groups.buildRosterState(groupId);
  const heldKeys = groups.exportHeldSenderKeys(groupId); // inclut ma clé au gen courant
  if (!state) return { success: false, error: GroupError.ROSTER_FAILED };

  const updated = groups.getGroup(groupId)!;
  // Mon bundle PQXDH (clés publiques) → permet au nouveau de créer une session
  // vers moi (mesh). Les bundles des autres membres seront fournis par eux via
  // réconciliation / leurs propres messages.
  let myBundle: string | null = null;
  try { myBundle = await sessionService.generateMyBundleForGroup(); } catch {}
  const welcome = {
    groupId,
    groupSeed: updated.groupSeed,
    name: state.name,
    avatarBase64: state.avatarBase64,
    description: state.description,
    epoch: state.epoch,
    rosterVersion: state.rosterVersion,
    approvalRequired: updated.approvalRequired,
    adminFingerprint: updated.myFingerprint,
    roster: state.roster,
    senderKeys: heldKeys,
    // Tous les bundles que je détiens (membres existants) + le mien → le nouveau
    // membre peut établir le mesh vers TOUS, y compris des membres avec qui il
    // n'a pas de session 1:1.
    bundles: [
      ...groups.exportHeldBundles(groupId),
      ...(myBundle ? [{ fingerprint: updated.myFingerprint, bundle: myBundle }] : []),
    ],
  };
  await sendGroupEnvelope(memberSessionId, 'group_welcome', welcome, undefined, 'normal');

  // 3) Notifier les autres membres (roster mis à jour). Best-effort ; la
  //    réconciliation au retour comble si l'un est hors-ligne.
  const others = updated.members.filter(
    (m: GroupMember) => m.fingerprint !== updated.myFingerprint && m.fingerprint !== memberFingerprint
  );
  const addedNotice = {
    groupId,
    rosterVersion: state.rosterVersion,
    epoch: state.epoch,
    member: {
      fingerprint: memberFingerprint,
      displayName: memberDisplayName,
      avatarBase64: memberAvatarBase64,
      role: 'member' as const,
      joinedAtEpoch: updated.epoch,
    },
  };
  for (const m of others) {
    if (m.sessionId) await sendGroupEnvelope(m.sessionId, 'group_member_added', addedNotice);
  }

  await appendSystemMessage(groupId, `${memberDisplayName} a rejoint le groupe`);
  return { success: true };
}

/** Retire un membre (ADMIN). RETRAIT = rotation (epoch++) + redistribution. */
export async function removeMember(groupId: string, fingerprint: string): Promise<{ success: boolean; error?: string }> {
  const g = groups.getGroup(groupId);
  if (!g) return { success: false, error: GroupError.UNKNOWN_GROUP };
  if (!groups.amIAdmin(groupId)) return { success: false, error: GroupError.NOT_ADMIN };

  const removed = groups.getMembers(groupId).find((m: GroupMember) => m.fingerprint === fingerprint);
  const newEpoch = groups.removeMemberLocal(groupId, fingerprint);
  if (newEpoch === null) return { success: false, error: GroupError.REMOVE_MEMBER_FAILED };

  const updated = groups.getGroup(groupId)!;
  // Notifier les restants : nouveau roster + nouvelle epoch → ils rotent aussi.
  const state = groups.buildRosterState(groupId);
  const notice = {
    groupId, fingerprint,
    rosterVersion: updated.rosterVersion,
    epoch: updated.epoch,
    roster: state?.roster || [],
  };
  for (const m of updated.members) {
    if (m.fingerprint !== updated.myFingerprint && m.sessionId) {
      await sendGroupEnvelope(m.sessionId, 'group_member_removed', notice);
    }
  }
  // Je redistribue MA nouvelle senderKey (gen 0 de la nouvelle epoch) aux restants.
  await broadcastMySenderKeyForRotation(groupId);
  await appendSystemMessage(groupId, removed ? `${removed.displayName} a été retiré du groupe` : 'Un membre a été retiré');
  return { success: true };
}

/** Promotion co-admin (ADMIN). */
export async function promoteMember(groupId: string, fingerprint: string): Promise<{ success: boolean; error?: string }> {
  if (!groups.amIAdmin(groupId)) return { success: false, error: GroupError.NOT_ADMIN };
  if (!groups.promoteToAdminLocal(groupId, fingerprint)) return { success: false, error: GroupError.PROMOTE_FAILED };
  const g = groups.getGroup(groupId)!;
  const promoted = g.members.find((m: GroupMember) => m.fingerprint === fingerprint);
  const notice = { groupId, fingerprint, rosterVersion: g.rosterVersion };
  for (const m of g.members) {
    if (m.fingerprint !== g.myFingerprint && m.sessionId) {
      await sendGroupEnvelope(m.sessionId, 'group_member_promoted', notice);
    }
  }
  await appendSystemMessage(groupId, promoted ? `${promoted.displayName} est désormais administrateur` : 'Nouvel administrateur');
  return { success: true };
}

// ── Distribution de clés ─────────────────────────────────────────────────────

/** Diffuse MA senderKey au gen COURANT à tous les autres membres (ajout/refresh). */
async function broadcastMySenderKeyAtCurrentGen(groupId: string): Promise<void> {
  const mySK = groups.exportMySenderKeyAtCurrentGen(groupId);
  if (!mySK) return;
  const payload = { groupId, chainKey: mySK.chainKey, epoch: mySK.epoch, gen: mySK.gen };
  for (const m of groups.getFanoutRecipients(groupId)) {
    if (m.sessionId) await sendGroupEnvelope(m.sessionId, 'group_senderkey', payload);
  }
}

/** Diffuse MA senderKey au gen 0 de la NOUVELLE epoch (après rotation/retrait). */
async function broadcastMySenderKeyForRotation(groupId: string): Promise<void> {
  const mySK = groups.exportMySenderKeyAtCurrentGen(groupId); // après rotation, sendGen=0
  if (!mySK) return;
  const payload = { groupId, chainKey: mySK.chainKey, epoch: mySK.epoch, gen: mySK.gen };
  for (const m of groups.getFanoutRecipients(groupId)) {
    if (m.sessionId) await sendGroupEnvelope(m.sessionId, 'group_senderkey', payload);
  }
}

/** Envoie MA senderKey (gen courant) à UN membre précis (réponse key_request). */
async function sendMySenderKeyTo(groupId: string, sessionId: string): Promise<void> {
  const mySK = groups.exportMySenderKeyAtCurrentGen(groupId);
  if (!mySK || !sessionId) return;
  await sendGroupEnvelope(sessionId, 'group_senderkey',
    { groupId, chainKey: mySK.chainKey, epoch: mySK.epoch, gen: mySK.gen });
}

// ════════════════════════════════════════════════════════════════════════════
// JONCTION (joiner ↔ admin)
// ════════════════════════════════════════════════════════════════════════════

export async function sendJoinRequest(
  adminSessionId: string,
  groupId: string,
  ticketId: string,
  ticketSecret: string
): Promise<{ success: boolean; error?: string }> {
  const me = myProfile();
  const payload = {
    groupId, ticketId, ticketSecret,
    profile: { fingerprint: me.fingerprint, displayName: me.displayName, avatarBase64: me.avatarBase64 },
  };
  const r = await sendGroupEnvelope(adminSessionId, 'group_join_request', payload);
  return { success: r.success, error: r.error };
}

/** Départ volontaire : notifie les membres puis supprime localement. */
export async function leaveGroup(groupId: string): Promise<void> {
  const g = groups.getGroup(groupId);
  if (!g) return;
  const notice = { groupId, fingerprint: g.myFingerprint };
  for (const m of groups.getFanoutRecipients(groupId)) {
    if (m.sessionId) {
      try { await sendGroupEnvelope(m.sessionId, 'group_leave', notice); } catch {}
    }
  }
  groups.deleteGroupLocal(groupId);
}

// ════════════════════════════════════════════════════════════════════════════
// RÉCONCILIATION (v2) — filet anti-divergence
// ════════════════════════════════════════════════════════════════════════════

/**
 * Demande l'état courant du roster à un admin (au retour en ligne). À appeler
 * périodiquement / au foreground pour chaque groupe.
 */
export async function requestRosterSync(groupId: string): Promise<void> {
  const g = groups.getGroup(groupId);
  if (!g) return;
  // Trouver un admin avec qui j'ai une session (autre que moi).
  const admin = g.members.find((m: GroupMember) => m.role === 'admin' && m.fingerprint !== g.myFingerprint && m.sessionId);
  if (!admin) return; // je suis le seul admin, ou pas de session admin → rien à faire
  await sendGroupEnvelope(admin.sessionId, 'group_roster_sync_request',
    { groupId, rosterVersion: g.rosterVersion });
}

// ════════════════════════════════════════════════════════════════════════════
// RÉCEPTION — routeur appelé par api1to1 (dynamic import)
// ════════════════════════════════════════════════════════════════════════════

export async function handleIncomingGroupMessage(fromSessionId: string, msg: Message1to1): Promise<boolean> {
  ensureGroupIdentityWired();
  let payload: any = {};
  try { payload = JSON.parse(msg.content || '{}'); } catch { return false; }
  const senderFp = msg.senderFingerprint || '';

  switch (msg.messageType) {
    case 'group_msg':
      return handleGroupMsg(fromSessionId, payload, senderFp);
    case 'group_welcome':
      return handleWelcome(fromSessionId, payload);
    case 'group_senderkey':
      await handleSenderKey(payload, senderFp);
      return false;
    case 'group_member_added':
      await handleMemberAdded(payload, senderFp);
      return true;
    case 'group_member_removed':
      await handleMemberRemoved(payload, senderFp);
      return true;
    case 'group_member_promoted':
      handleMemberPromoted(payload, senderFp);
      return true;
    case 'group_meta_update':
      handleMetaUpdate(payload, senderFp);
      return true;
    case 'group_join_request':
      await handleJoinRequest(fromSessionId, payload, senderFp);
      return false;
    case 'group_join_response':
      __DEV__ && console.log('[apiGroups] join response:', payload?.approved);
      emitJoinResponseEvent({ groupId: payload?.groupId, approved: !!payload?.approved, reason: payload?.reason });
      return false;
    case 'group_key_request':
      await handleKeyRequest(fromSessionId, payload, senderFp);
      return false;
    case 'group_roster_sync_request':
      await handleRosterSyncRequest(fromSessionId, payload, senderFp);
      return false;
    case 'group_roster_state':
      await handleRosterState(payload, senderFp);
      return true;
    case 'group_leave':
      await handleLeave(payload, senderFp);
      return true;
    default:
      return false;
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleGroupMsg(fromSessionId: string, payload: any, senderFp: string): Promise<boolean> {
  const ct: GroupCiphertext | undefined = payload?.ciphertext;
  if (!ct || !ct.groupId) return false;
  const g = groups.getGroup(ct.groupId);
  if (!g) {
    __DEV__ && console.warn('[apiGroups] group_msg for unknown group');
    return false;
  }
  const member = g.members.find((m: GroupMember) => m.fingerprint === ct.senderFingerprint);
  if (!member) {
    // Expéditeur inconnu de mon roster → j'ai peut-être manqué un ajout.
    // Resynchroniser auprès de l'admin (le message courant est perdu mais les
    // suivants passeront ; l'admin valide l'appartenance).
    maybeRequestRosterSync(ct.groupId);
    return false;
  }

  // J'ai reçu un message d'une epoch SUPÉRIEURE à la mienne → j'ai manqué une
  // rotation (retrait de membre). Resynchroniser pour adopter la nouvelle epoch
  // (sinon je resterais bloqué sur l'ancienne et mes envois seraient rejetés).
  if (typeof ct.epoch === 'number' && ct.epoch > g.epoch) {
    maybeRequestRosterSync(ct.groupId);
  }

  // MESH : si le message porte un PQXDHInitialMessage et que je n'ai pas encore
  // de session avec l'expéditeur, créer ma moitié de session (répondeur) avant
  // tout. (Voir NOTE D'INTÉGRATION dans le README : selon où le déchiffrement
  // 1:1 a lieu, cet appel peut devoir être avancé dans api1to1.)
  if (payload?.pqxdhInit && !member.sessionId) {
    try {
      const sid = await sessionService.createMeshResponderSession(payload.pqxdhInit, {
        displayName: member.displayName,
        avatarBase64: member.avatarBase64,
      } as any);
      if (sid) {
        groups.setMemberSession(ct.groupId, member.fingerprint, sid);
        member.sessionId = sid;
        // Mesh tardif (côté répondeur) : ce membre vient de nous joindre → lui
        // re-livrer nos messages récents qu'il avait pu manquer.
        void flushRecentToMember(ct.groupId, sid);
      }
    } catch (e) {
      __DEV__ && console.warn('[apiGroups] mesh responder session failed:', e);
    }
  }

  // Anti-usurpation : l'expéditeur du payload doit posséder la session d'où
  // vient le message (si on connaît sa session).
  if (member.sessionId && member.sessionId !== fromSessionId) {
    __DEV__ && console.warn('[apiGroups] group_msg sender/session mismatch — rejected');
    return false;
  }
  // Si on ne connaissait pas encore sa session, la mémoriser (mesh à la demande).
  if (!member.sessionId && fromSessionId) {
    member.sessionId = fromSessionId;
    groups.updateGroupMeta(ct.groupId, {});
  }

  const dec = groups.decryptGroupMessage(ct);
  if (!dec) {
    // Trou de clé → demander la senderKey à l'expéditeur (si session connue).
    if (member.sessionId) {
      await sendGroupEnvelope(member.sessionId, 'group_key_request', { groupId: ct.groupId, epoch: ct.epoch });
    }
    return false;
  }

  const local: Message1to1 = {
    id: payload?.msgId || (ct.groupId + ':' + ct.senderFingerprint + ':' + ct.epoch + ':' + ct.gen),
    sessionId: ct.groupId,
    content: dec.plaintext,
    timestamp: Date.now(),
    isMine: false,
    displayName: member.displayName,
    senderAvatarBase64: member.avatarBase64,
    senderFingerprint: ct.senderFingerprint,
    status: 'delivered',
    messageType: 'group_msg',
    groupId: ct.groupId,
    ...(payload?.replyTo && {
      replyToId: payload.replyTo.id,
      replyToContent: payload.replyTo.content,
      replyToSender: payload.replyTo.sender,
    }),
  } as Message1to1;
  await saveLocalMessage1to1(ct.groupId, local);
  return true;
}

async function handleWelcome(fromSessionId: string, payload: any): Promise<boolean> {
  if (!payload?.groupId || !payload?.groupSeed) return false;
  const me = myProfile();

  if (!groups.getGroup(payload.groupId)) {
    groups.adoptGroupFromWelcome({
      groupId: payload.groupId,
      groupSeed: payload.groupSeed,
      name: payload.name || 'Groupe',
      avatarBase64: payload.avatarBase64,
      description: payload.description,
      epoch: payload.epoch ?? 0,
      rosterVersion: payload.rosterVersion ?? 0,
      myFingerprint: me.fingerprint,
      myDisplayName: me.displayName,
      myAvatarBase64: me.avatarBase64,
      approvalRequired: payload.approvalRequired ?? true,
      members: (payload.roster || []).map((m: any) => ({
        fingerprint: m.fingerprint,
        // La session connue : pour l'admin émetteur = fromSessionId ; sinon ''
        sessionId: m.fingerprint === payload.adminFingerprint ? fromSessionId : '',
        displayName: m.displayName,
        avatarBase64: m.avatarBase64,
        role: m.role,
        joinedAtEpoch: m.joinedAtEpoch ?? 0,
      })),
    });
  }
  // Stocker toutes les senderKeys fournies par l'admin (gen courant).
  for (const sk of (payload.senderKeys || [])) {
    groups.setMemberSenderKey(payload.groupId, sk.fingerprint, sk.chainKey, sk.epoch, sk.gen ?? 0);
  }
  // MESH : stocker les bundles fournis (clés publiques) → créer des sessions à
  // la demande vers ces membres.
  for (const b of (payload.bundles || [])) {
    if (b?.fingerprint && b?.bundle) groups.storeMemberBundle(payload.groupId, b.fingerprint, b.bundle);
  }
  // Envoyer MA senderKey (gen courant) à l'admin → relais/réconciliation.
  await sendMySenderKeyTo(payload.groupId, fromSessionId);
  // Envoyer MON bundle à l'admin pour qu'il le diffuse (réconciliation).
  try {
    const myBundle = await sessionService.generateMyBundleForGroup();
    if (myBundle) {
      await sendGroupEnvelope(fromSessionId, 'group_senderkey', {
        groupId: payload.groupId, bundleOnly: true,
        bundle: myBundle, bundleFingerprint: me.fingerprint,
      });
    }
  } catch {}
  // Tirer l'état complet auprès de l'admin (bundles + senderKeys de TOUS les
  // membres) → établir le mesh même avec des membres non 1:1.
  try { await requestRosterSync(payload.groupId); } catch {}
  await appendSystemMessage(payload.groupId, 'Vous avez rejoint le groupe');
  return true;
}

async function handleSenderKey(payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId) return;
  // MESH : message portant uniquement un bundle (clés publiques) à stocker.
  if (payload.bundleOnly && payload.bundle && payload.bundleFingerprint) {
    groups.storeMemberBundle(payload.groupId, payload.bundleFingerprint, payload.bundle);
    // Hub admin : propager ce bundle à tous (les membres non 1:1 entre eux en
    // ont besoin pour s'établir mutuellement).
    scheduleAdminRosterBroadcast(payload.groupId);
    return;
  }
  if (!payload.chainKey || !senderFp) return;
  groups.setMemberSenderKey(payload.groupId, senderFp, payload.chainKey, payload.epoch ?? 0, payload.gen ?? 0);
  // Hub admin : propager la senderKey reçue à tous.
  scheduleAdminRosterBroadcast(payload.groupId);
}

/**
 * MODÈLE v2 : un ajout NE change PAS l'epoch et ne re-chaîne rien. On applique
 * juste le nouveau roster (via la version) et on envoie notre clay (gen courant)
 * au nouveau membre si on a une session (sinon il l'obtiendra via l'admin /
 * réconciliation).
 */
async function handleMemberAdded(payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId || !payload?.member) return;
  const g = groups.getGroup(payload.groupId);
  if (!g) return;
  // Sécurité : seul un admin peut ajouter.
  if (!groups.isAdmin(payload.groupId, senderFp)) {
    __DEV__ && console.warn('[apiGroups] member_added from non-admin — ignored');
    return;
  }
  // Appliquer l'ajout localement (rosterVersion++ ; epoch INCHANGÉE).
  groups.addMemberLocal(payload.groupId, {
    fingerprint: payload.member.fingerprint,
    sessionId: '', // je n'ai pas (encore) de session vers le nouveau
    displayName: payload.member.displayName,
    avatarBase64: payload.member.avatarBase64,
    role: payload.member.role || 'member',
    joinedAtEpoch: 0,
  });
  await appendSystemMessage(payload.groupId, `${payload.member.displayName} a rejoint le groupe`);
  // Tirer l'état complet : obtenir le bundle + la senderKey du nouveau membre
  // (le push admin débouncé comble aussi dès qu'il les détient).
  try { await requestRosterSync(payload.groupId); } catch {}
}

async function handleMemberRemoved(payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId || !payload?.fingerprint) return;
  if (!groups.isAdmin(payload.groupId, senderFp)) {
    __DEV__ && console.warn('[apiGroups] member_removed from non-admin — ignored');
    return;
  }
  const g = groups.getGroup(payload.groupId);
  if (!g) return;
  const removed = g.members.find((m: GroupMember) => m.fingerprint === payload.fingerprint);
  // Si c'est MOI qui suis retiré → supprimer le groupe localement.
  if (payload.fingerprint === g.myFingerprint) {
    groups.deleteGroupLocal(payload.groupId);
    return;
  }
  // Retrait → rotation (epoch++) reflétée. removeMemberLocal régénère MA chaîne.
  groups.removeMemberLocal(payload.groupId, payload.fingerprint);
  await broadcastMySenderKeyForRotation(payload.groupId);
  await appendSystemMessage(payload.groupId, removed ? `${removed.displayName} a quitté le groupe` : 'Un membre a été retiré');
}

function handleMemberPromoted(payload: any, senderFp: string): void {
  if (!payload?.groupId || !payload?.fingerprint) return;
  if (!groups.isAdmin(payload.groupId, senderFp)) return;
  groups.promoteToAdminLocal(payload.groupId, payload.fingerprint);
}

function handleMetaUpdate(payload: any, senderFp: string): void {
  if (!payload?.groupId) return;
  if (!groups.isAdmin(payload.groupId, senderFp)) return;
  groups.updateGroupMeta(payload.groupId, {
    name: payload.name,
    avatarBase64: payload.avatarBase64,
    description: payload.description,
  });
}

async function handleJoinRequest(fromSessionId: string, payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId || !payload?.ticketId || !payload?.ticketSecret) return;
  const g = groups.getGroup(payload.groupId);
  if (!g) return;
  if (!groups.amIAdmin(payload.groupId)) return; // pas admin → ignore

  const valid = groups.validateTicket(payload.groupId, payload.ticketId, payload.ticketSecret);
  if (!valid) {
    await sendGroupEnvelope(fromSessionId, 'group_join_response', { groupId: payload.groupId, approved: false, reason: 'invalid_ticket' });
    return;
  }

  const prof = payload.profile || {};
  if (g.approvalRequired) {
    emitJoinRequestEvent({
      groupId: payload.groupId,
      sessionId: fromSessionId,
      ticketId: payload.ticketId,
      fingerprint: senderFp,
      displayName: prof.displayName || 'Inconnu',
      avatarBase64: prof.avatarBase64,
    });
  } else {
    groups.consumeTicket(payload.groupId, payload.ticketId);
    await addMemberBySession(payload.groupId, fromSessionId, senderFp, prof.displayName || 'Inconnu', prof.avatarBase64);
    // (addMemberBySession envoie déjà le welcome → join_response implicite via welcome.)
    await sendGroupEnvelope(fromSessionId, 'group_join_response', { groupId: payload.groupId, approved: true });
  }
}

/** Appelé par l'UI quand l'admin approuve une demande en attente. */
export async function approveJoinRequest(req: { groupId: string; sessionId: string; ticketId: string; fingerprint: string; displayName: string; avatarBase64?: string }): Promise<{ success: boolean; error?: string }> {
  if (!groups.amIAdmin(req.groupId)) return { success: false, error: GroupError.NOT_ADMIN };
  groups.consumeTicket(req.groupId, req.ticketId);
  const r = await addMemberBySession(req.groupId, req.sessionId, req.fingerprint, req.displayName, req.avatarBase64);
  if (r.success) {
    await sendGroupEnvelope(req.sessionId, 'group_join_response', { groupId: req.groupId, approved: true });
  }
  return r;
}

export async function rejectJoinRequest(req: { groupId: string; sessionId: string }): Promise<void> {
  await sendGroupEnvelope(req.sessionId, 'group_join_response', { groupId: req.groupId, approved: false, reason: 'declined' });
}

async function handleKeyRequest(fromSessionId: string, payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId) return;
  const g = groups.getGroup(payload.groupId);
  if (!g) return;
  if (!g.members.some((m: GroupMember) => m.fingerprint === senderFp)) return; // demandeur doit être membre
  await sendMySenderKeyTo(payload.groupId, fromSessionId);
}

/** ADMIN : répond à une demande de réconciliation avec l'état courant complet. */
async function handleRosterSyncRequest(fromSessionId: string, payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId) return;
  const g = groups.getGroup(payload.groupId);
  if (!g) return;
  if (!groups.amIAdmin(payload.groupId)) return; // seul un admin répond
  if (!g.members.some((m: GroupMember) => m.fingerprint === senderFp)) return; // demandeur membre

  const state = groups.buildRosterState(payload.groupId);
  const heldKeys = groups.exportHeldSenderKeys(payload.groupId);
  const heldBundles = groups.exportHeldBundles(payload.groupId);
  if (!state) return;
  await sendGroupEnvelope(fromSessionId, 'group_roster_state', {
    groupId: payload.groupId,
    rosterVersion: state.rosterVersion,
    epoch: state.epoch,
    name: state.name,
    avatarBase64: state.avatarBase64,
    description: state.description,
    roster: state.roster,
    senderKeys: heldKeys,
    bundles: heldBundles,
  });
}

/** Applique un état de roster reçu d'un admin (réconciliation, idempotent). */
async function handleRosterState(payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId || !Array.isArray(payload.roster)) return;
  if (!groups.isAdmin(payload.groupId, senderFp)) {
    __DEV__ && console.warn('[apiGroups] roster_state from non-admin — ignored');
    return;
  }
  const before = groups.getGroup(payload.groupId);
  const epochBefore = before ? before.epoch : 0;
  groups.applyRosterState({
    groupId: payload.groupId,
    rosterVersion: payload.rosterVersion ?? 0,
    epoch: payload.epoch ?? 0,
    roster: payload.roster as RosterStateMember[],
    senderKeys: payload.senderKeys as SenderKeyShare[] | undefined,
    name: payload.name,
    avatarBase64: payload.avatarBase64,
    description: payload.description,
  });
  // MESH : stocker les bundles fournis dans l'état de roster (clés publiques) →
  // permet de créer des sessions à la demande vers ces membres.
  for (const b of (payload.bundles || [])) {
    if (b?.fingerprint && b?.bundle) groups.storeMemberBundle(payload.groupId, b.fingerprint, b.bundle);
  }
  // Phase 1 : si la réconciliation a fait AVANCER l'epoch, MA chaîne d'émission a
  // été régénérée (aléatoire) → je dois la rediffuser, sinon les autres ne
  // pourront pas me déchiffrer (inutile avec l'ancien modèle déterministe).
  const after = groups.getGroup(payload.groupId);
  if (after && after.epoch > epochBefore) {
    await broadcastMySenderKeyForRotation(payload.groupId);
  }
}

async function handleLeave(payload: any, senderFp: string): Promise<void> {
  if (!payload?.groupId) return;
  const g = groups.getGroup(payload.groupId);
  if (!g) return;
  const m = g.members.find((x: GroupMember) => x.fingerprint === senderFp);
  // Un départ volontaire impose une rotation (le partant détient les clés).
  groups.removeMemberLocal(payload.groupId, senderFp);
  await broadcastMySenderKeyForRotation(payload.groupId);
  await appendSystemMessage(payload.groupId, m ? `${m.displayName} a quitté le groupe` : 'Un membre a quitté le groupe');
}

// ────────────────────────────────────────────────────────────────────────────
// Bandeaux système (messages locaux, isSystem)
// ────────────────────────────────────────────────────────────────────────────

async function appendSystemMessage(groupId: string, text: string): Promise<void> {
  try {
    const local: Message1to1 = {
      id: 'sys:' + groupId + ':' + Date.now() + ':' + bytesToHex(getSecureRandomBytes(4)),
      sessionId: groupId,
      content: text,
      timestamp: Date.now(),
      isMine: false,
      displayName: '',
      senderFingerprint: '',
      status: 'delivered',
      messageType: 'group_msg',
      groupId,
      isSystem: true,
    } as any;
    await saveLocalMessage1to1(groupId, local);
  } catch {}
}

// ────────────────────────────────────────────────────────────────────────────
// Stockage des messages de groupe (réutilise les helpers d'api1to1 via groupId)
// ────────────────────────────────────────────────────────────────────────────

export async function getGroupMessages(groupId: string): Promise<Message1to1[]> {
  return getLocalMessages1to1(groupId);
}

// ────────────────────────────────────────────────────────────────────────────
// Événements UI
// ────────────────────────────────────────────────────────────────────────────

export interface PendingJoinRequest {
  groupId: string;
  sessionId: string;
  ticketId: string;
  fingerprint: string;
  displayName: string;
  avatarBase64?: string;
}

type JoinReqListener = (req: PendingJoinRequest) => void;
const joinReqListeners = new Set<JoinReqListener>();
export function onJoinRequest(cb: JoinReqListener): () => void {
  joinReqListeners.add(cb);
  return () => { joinReqListeners.delete(cb); };
}
function emitJoinRequestEvent(req: PendingJoinRequest): void {
  for (const cb of joinReqListeners) { try { cb(req); } catch {} }
}

export interface JoinResponseEvent { groupId: string; approved: boolean; reason?: string; }
type JoinRespListener = (e: JoinResponseEvent) => void;
const joinRespListeners = new Set<JoinRespListener>();
export function onJoinResponse(cb: JoinRespListener): () => void {
  joinRespListeners.add(cb);
  return () => { joinRespListeners.delete(cb); };
}
function emitJoinResponseEvent(e: JoinResponseEvent): void {
  for (const cb of joinRespListeners) { try { cb(e); } catch {} }
}
