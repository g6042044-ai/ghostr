// src/services/callHeartbeat.ts
// État et listeners pour les appels actifs (affichage CallIndicator).
//
// Rôle : exposer l'info "il y a un appel en cours" au CallIndicator UI.
// Le système actif (call1to1Service) gère ses propres appels et notifie ce
// service via les listeners exportés ci-dessous.

// ============================================
// TYPES
// ============================================

export interface ActiveCallInfo {
  callId: string;
  conversationId: string;
  lastHeartbeat: number;
  participantTokens: Set<string>;
  startedAt: number;
}

// ============================================
// STATE
// ============================================

type CallEventCallback = (conversationId: string, callInfo: ActiveCallInfo | null) => void;

interface HeartbeatState {
  activeCallsByConversation: Map<string, ActiveCallInfo>;
  checkInterval: ReturnType<typeof setInterval> | null;
  stateChangeListeners: Set<CallEventCallback>;
}

const state: HeartbeatState = {
  activeCallsByConversation: new Map(),
  checkInterval: null,
  stateChangeListeners: new Set(),
};

// ============================================
// LISTENERS
// ============================================

export function addCallStateListener(callback: CallEventCallback): () => void {
  state.stateChangeListeners.add(callback);
  return () => state.stateChangeListeners.delete(callback);
}

function notifyStateChange(conversationId: string, callInfo: ActiveCallInfo | null): void {
  state.stateChangeListeners.forEach(listener => {
    try {
      listener(conversationId, callInfo);
    } catch (error) {
      __DEV__ && console.error('💓 Listener error:', error);
    }
  });
}

// ============================================
// QUERIES
// ============================================

export function getActiveCall(conversationId: string): ActiveCallInfo | null {
  return state.activeCallsByConversation.get(conversationId) || null;
}

export function hasActiveCall(conversationId: string): boolean {
  return state.activeCallsByConversation.has(conversationId);
}

export function forceRefreshActiveCall(conversationId: string): void {
  const callInfo = state.activeCallsByConversation.get(conversationId) || null;
  notifyStateChange(conversationId, callInfo);
}

// ============================================
// SERVICE LIFECYCLE
// ============================================

const HEARTBEAT_CHECK_INTERVAL_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 22000;

function checkActiveCallsTimeout(): void {
  const now = Date.now();
  
  for (const [conversationId, callInfo] of state.activeCallsByConversation) {
    if (now - callInfo.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      state.activeCallsByConversation.delete(conversationId);
      notifyStateChange(conversationId, null);
    }
  }
}

export async function startHeartbeatService(): Promise<void> {
  if (state.checkInterval) return;
  
  state.checkInterval = setInterval(() => {
    checkActiveCallsTimeout();
  }, HEARTBEAT_CHECK_INTERVAL_MS);
  
  __DEV__ && console.log('💓 Heartbeat service started');
}

export function stopHeartbeatService(): void {
  if (state.checkInterval) {
    clearInterval(state.checkInterval);
    state.checkInterval = null;
  }
  
  state.activeCallsByConversation.clear();
  state.stateChangeListeners.clear();
  
  __DEV__ && console.log('💓 Heartbeat service stopped');
}