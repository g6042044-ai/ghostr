// cloudflare-relay/sfu-worker.js
// Whisper Anonymous Voice SFU - Cloudflare Worker + Durable Objects
// Version 9.0 - P0-A6: 1-TO-1 ONLY (group calls = dead code)
//   - v9.0: MAX_PARTICIPANTS=2 strict (1-to-1 uniquement)
//   - v9.0: Suppression des broadcast loops inutiles (avec 2 peers, 1 seul "autre")
//   - v9.0: Surface d'attaque réduite (pas de 3ème participant possible)
//   - v8.0: Gestion robuste des messages non-JSON et binaires
//   - v8.0: Validation stricte des messages entrants
//   - v8.0: Logging sécurisé (sans données sensibles)
//
// ARCHITECTURE 1-to-1:
// - WebSocket pour chaque participant (max 2)
// - Durable Object par room (tag anonyme)
// - Forward des paquets audio sans déchiffrement (E2E préservé)
// - Aucune métadonnée stockée
// - SÉCURITÉ: Avec MAX_PARTICIPANTS=2, un attaquant ayant volé un token de room
//   ne peut PAS rejoindre comme 3ème "écouteur silencieux" — la room est full.

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // P0-A6: 1-to-1 ONLY. Les appels de groupe sont du code mort dans Ghostr.
  // Cette limite stricte ferme la fenêtre d'attaque "écouteur silencieux"
  // (un attaquant avec le token de room ne peut plus rejoindre).
  MAX_PARTICIPANTS: 2,
  // Timeout d'inactivité avant fermeture de la room (ms)
  INACTIVITY_TIMEOUT_MS: 3 * 60 * 1000,
  // Intervalle de ping/pong (ms)
  PING_INTERVAL_MS: 15000,
  // Taille maximale d'un paquet audio (bytes) - données base64
  MAX_PACKET_SIZE: 8192,
  // Taille maximale d'un message JSON complet
  MAX_MESSAGE_SIZE: 16384,
  // Durée de validité d'un token d'auth (ms)
  AUTH_TOKEN_VALIDITY_MS: 60 * 1000,
  // Version du protocole
  VERSION: '9.0',
};

// ============================================
// UTILITAIRES DE VALIDATION
// ============================================

/**
 * Vérifie si une chaîne est du JSON valide
 */
function isValidJson(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Parse un message JSON de manière sécurisée
 */
function safeJsonParse(data) {
  try {
    if (typeof data !== 'string') {
      // Tenter de convertir un ArrayBuffer en string
      if (data instanceof ArrayBuffer) {
        data = new TextDecoder().decode(data);
      } else {
        return { success: false, error: 'Invalid data type' };
      }
    }

    const trimmed = data.trim();
    
    // Ignorer les messages non-JSON (pings textuels, etc.)
    if (!isValidJson(trimmed)) {
      return { success: false, error: 'Not JSON', isIgnorable: true };
    }

    const parsed = JSON.parse(trimmed);
    return { success: true, data: parsed };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Valide la structure d'un message SFU
 */
function validateMessage(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'Message must be an object' };
  }

  if (!message.type || typeof message.type !== 'string') {
    return { valid: false, error: 'Missing or invalid message type' };
  }

  const validTypes = ['join', 'leave', 'audio', 'mute', 'room-info', 'ping'];
  if (!validTypes.includes(message.type)) {
    return { valid: false, error: `Unknown message type: ${message.type}` };
  }

  // Validation spécifique par type
  switch (message.type) {
    case 'join':
      if (!message.senderToken || typeof message.senderToken !== 'string') {
        return { valid: false, error: 'Join message requires senderToken' };
      }
      break;
    case 'audio':
      if (!message.data || typeof message.data !== 'string') {
        return { valid: false, error: 'Audio message requires data' };
      }
      if (message.data.length > CONFIG.MAX_PACKET_SIZE * 1.4) {
        return { valid: false, error: 'Audio packet too large' };
      }
      break;
  }

  return { valid: true };
}

// ============================================
// DURABLE OBJECT: VOICE ROOM
// ============================================

export class VoiceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    // Map des connexions: peerId -> { socket, senderTokenHash, joinedAt, lastActivity, isMuted }
    this.peers = new Map();
    
    // Tag de la room (pour logging uniquement - premiers 8 caractères)
    this.roomTag = null;
    
    // Token d'authentification de la room
    this.roomAuthToken = null;
    
    // Statistiques anonymisées
    this.stats = {
      totalPackets: 0,
      peakPeers: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    
    // Timer d'inactivité
    this.inactivityTimer = null;
  }

  async fetch(request) {
    try {
      // Vérifier que c'est un upgrade WebSocket
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      // Extraire les paramètres
      const url = new URL(request.url);
      const peerId = url.searchParams.get('peerId');
      const authToken = url.searchParams.get('authToken');
      
      if (!peerId) {
        return new Response(JSON.stringify({ 
          error: 'Missing peerId',
          code: 'MISSING_PEER_ID',
        }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Vérifier l'authentification
      if (!authToken) {
        return new Response(JSON.stringify({ 
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
        }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Vérifier la limite de participants
      if (this.peers.size >= CONFIG.MAX_PARTICIPANTS) {
        return new Response(JSON.stringify({ 
          error: 'Room full',
          code: 'ROOM_FULL',
          maxParticipants: CONFIG.MAX_PARTICIPANTS,
        }), { 
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Valider le token d'authentification
      const authResult = this.validateAuthToken(authToken);
      if (!authResult.valid) {
        return new Response(JSON.stringify({ 
          error: authResult.error,
          code: 'AUTH_FAILED',
        }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Créer la paire WebSocket
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Gérer la connexion
      this.handleConnection(server, peerId);
      
      // Réinitialiser le timer d'inactivité
      this.resetInactivityTimer();

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
      
    } catch (error) {
      console.error('[VoiceRoom] Fetch error:', error.message);
      return new Response(JSON.stringify({ 
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Valide le token d'authentification
   */
  validateAuthToken(providedToken) {
    if (!providedToken || providedToken.length < 32) {
      return { valid: false, error: 'Invalid auth token format' };
    }
    
    // Premier participant - définir le token de la room
    if (this.roomAuthToken === null) {
      this.roomAuthToken = providedToken;
      return { valid: true };
    }
    
    // Participants suivants - vérifier le token (comparaison temps constant)
    if (!this.constantTimeCompare(providedToken, this.roomAuthToken)) {
      return { valid: false, error: 'Invalid auth token' };
    }
    
    return { valid: true };
  }
  
  /**
   * Comparaison en temps constant pour éviter les timing attacks
   */
  constantTimeCompare(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  handleConnection(socket, peerId) {
    // Accepter le WebSocket
    socket.accept();

    // Gérer les messages
    socket.addEventListener('message', async (event) => {
      try {
        // Vérifier la taille du message
        const messageSize = typeof event.data === 'string' 
          ? event.data.length 
          : event.data.byteLength || 0;
          
        if (messageSize > CONFIG.MAX_MESSAGE_SIZE) {
          this.sendError(socket, 'Message too large');
          return;
        }
        
        // Parser le message de manière sécurisée
        const parseResult = safeJsonParse(event.data);
        
        if (!parseResult.success) {
          // Les messages non-JSON ignorables (pings textuels) sont silencieusement ignorés
          if (parseResult.isIgnorable) {
            return;
          }
          // Les autres erreurs de parsing sont signalées
          this.sendError(socket, 'Invalid message format');
          return;
        }
        
        const message = parseResult.data;
        
        // Valider la structure du message
        const validation = validateMessage(message);
        if (!validation.valid) {
          this.sendError(socket, validation.error);
          return;
        }
        
        // Traiter le message
        await this.handleMessage(socket, peerId, message);
        
        // Mettre à jour l'activité
        const peer = this.peers.get(peerId);
        if (peer) {
          peer.lastActivity = Date.now();
        }
        this.stats.lastActivity = Date.now();
        this.resetInactivityTimer();
        
      } catch (error) {
        // Pas de error.message : un échec de JSON.parse y recopie le message reçu.
        console.error('[VoiceRoom] Message handling error');
        // Ne pas envoyer d'erreur au client pour éviter les fuites d'information
      }
    });

    // Gérer la fermeture
    socket.addEventListener('close', () => {
      this.handleDisconnect(peerId);
    });

    // Gérer les erreurs
    socket.addEventListener('error', () => {
      this.handleDisconnect(peerId);
    });
  }
  
  resetInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    
    this.inactivityTimer = setTimeout(() => {
      if (Date.now() - this.stats.lastActivity > CONFIG.INACTIVITY_TIMEOUT_MS) {
        // Fermer toutes les connexions
        for (const [_, peer] of this.peers) {
          try {
            peer.socket.close(1000, 'Room inactive');
          } catch (e) {}
        }
        this.peers.clear();
        this.roomAuthToken = null;
      }
    }, CONFIG.INACTIVITY_TIMEOUT_MS);
  }

  async handleMessage(socket, peerId, message) {
    switch (message.type) {
      case 'join':
        await this.handleJoin(socket, peerId, message);
        break;
        
      case 'leave':
        this.handleDisconnect(peerId);
        break;
        
      case 'audio':
        this.handleAudio(peerId, message);
        break;
        
      case 'mute':
        this.handleMute(peerId, message);
        break;
        
      case 'room-info':
        this.sendRoomInfo(socket);
        break;
        
      case 'ping':
        this.safeSend(socket, { type: 'pong', timestamp: Date.now() });
        break;
    }
  }

  async handleJoin(socket, peerId, message) {
    const { roomTag, senderToken } = message;
    
    // Vérifier si le peer n'est pas déjà connecté
    if (this.peers.has(peerId)) {
      this.sendError(socket, 'Already connected');
      return;
    }
    
    // P0-A6: Limite stricte 2 participants (1-to-1 only)
    if (this.peers.size >= CONFIG.MAX_PARTICIPANTS) {
      this.sendError(socket, 'Room full');
      socket.close(1013, 'Room full');
      return;
    }
    
    // Stocker le tag de la room (pour logging uniquement)
    if (!this.roomTag && roomTag) {
      this.roomTag = roomTag.slice(0, 8);
    }
    
    // P0-A6: Avec 1-to-1, il y a au plus 1 autre peer existant.
    // Pas besoin de boucle — accès direct via .values().next().
    const existingPeer = this.peers.size > 0 ? this.peers.values().next().value : null;
    const existingPeerId = this.peers.size > 0 ? this.peers.keys().next().value : null;

    if (existingPeer && existingPeerId) {
      // Notifier le nouveau peer du peer existant
      this.safeSend(socket, {
        type: 'peer-joined',
        peerId: existingPeerId,
        senderToken: existingPeer.senderTokenHash,
        isMuted: existingPeer.isMuted || false,
        timestamp: Date.now(),
      });

      // Notifier le peer existant du nouveau
      this.safeSend(existingPeer.socket, {
        type: 'peer-joined',
        peerId: peerId,
        senderToken: senderToken,
        isMuted: false,
        timestamp: Date.now(),
      });
    }
    
    // Ajouter le nouveau peer
    this.peers.set(peerId, {
      socket,
      senderTokenHash: senderToken,
      joinedAt: Date.now(),
      lastActivity: Date.now(),
      isMuted: false,
    });
    
    // Mettre à jour les stats
    if (this.peers.size > this.stats.peakPeers) {
      this.stats.peakPeers = this.peers.size;
    }
    
    // Envoyer les infos de la room
    this.sendRoomInfo(socket);
  }
  
  handleMute(peerId, message) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    peer.isMuted = message.muted || false;
    
    // P0-A6: Notifier l'autre peer (au plus 1 en 1-to-1).
    for (const [otherPeerId, otherPeer] of this.peers) {
      if (otherPeerId !== peerId) {
        this.safeSend(otherPeer.socket, {
          type: 'peer-mute',
          peerId: peerId,
          muted: peer.isMuted,
          timestamp: Date.now(),
        });
        break; // Avec 2 peers max, 1 seul "autre" possible
      }
    }
  }
  
  sendRoomInfo(socket) {
    const peerList = [];
    for (const [peerId, peer] of this.peers) {
      peerList.push({
        peerId,
        senderToken: peer.senderTokenHash,
        isMuted: peer.isMuted,
        joinedAt: peer.joinedAt,
      });
    }
    
    this.safeSend(socket, {
      type: 'room-info',
      participants: peerList.length,
      maxParticipants: CONFIG.MAX_PARTICIPANTS,
      peers: peerList,
      timestamp: Date.now(),
      authRequired: true,
      version: CONFIG.VERSION,
    });
  }

  handleDisconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    // Sauvegarder le senderToken AVANT de supprimer
    const senderToken = peer.senderTokenHash;
    
    // Supprimer le peer
    this.peers.delete(peerId);
    
    // P0-A6: Notifier l'autre peer (au plus 1 en 1-to-1).
    // Pas besoin de boucle — on break dès le premier.
    for (const [_, otherPeer] of this.peers) {
      this.safeSend(otherPeer.socket, {
        type: 'peer-left',
        peerId: peerId,
        senderToken: senderToken,
        timestamp: Date.now(),
      });
      break;
    }
    
    // Si la room est vide, nettoyer
    if (this.peers.size === 0) {
      if (this.inactivityTimer) {
        clearTimeout(this.inactivityTimer);
        this.inactivityTimer = null;
      }
      this.roomAuthToken = null;
    }
  }

  handleAudio(fromPeerId, message) {
    const fromPeer = this.peers.get(fromPeerId);
    if (!fromPeer) return;
    
    // Ne pas forward si le peer est muté
    if (fromPeer.isMuted) return;
    
    this.stats.totalPackets++;
    
    // Forward le paquet à l'autre peer
    // Le serveur ne regarde PAS le contenu - juste forward (E2E préservé)
    const forwardMessage = {
      type: 'audio',
      peerId: fromPeerId,
      senderToken: fromPeer.senderTokenHash,
      data: message.data,
      timestamp: message.timestamp || Date.now(),
    };
    
    // P0-A6: 1-to-1 → un seul "autre peer" possible.
    // Break dès le premier match au lieu de boucler inutilement.
    // Sur 50 paquets/s, ça économise des comparaisons en hot path.
    for (const [peerId, peer] of this.peers) {
      if (peerId !== fromPeerId) {
        this.safeSend(peer.socket, forwardMessage);
        break;
      }
    }
  }

  /**
   * Envoi sécurisé d'un message (avec gestion des erreurs)
   */
  safeSend(socket, message) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    } catch (error) {
      // Socket déjà fermé, ignorer silencieusement
    }
  }

  sendError(socket, error) {
    this.safeSend(socket, {
      type: 'error',
      error: error,
      timestamp: Date.now(),
    });
  }
}

// ============================================
// WORKER PRINCIPAL
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Headers de sécurité
    const securityHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'X-Content-Type-Options': 'nosniff',
    };
    
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...securityHeaders,
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    
    // Route: /room/:roomTag
    const roomMatch = url.pathname.match(/^\/room\/([a-f0-9]{32})$/);
    
    if (roomMatch) {
      const roomTag = roomMatch[1];
      
      // Vérifier que c'est un upgrade WebSocket
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return jsonResponse({ 
          error: 'WebSocket upgrade required',
          code: 'UPGRADE_REQUIRED',
        }, 426, securityHeaders);
      }
      
      // Récupérer ou créer le Durable Object pour cette room
      const id = env.VOICE_ROOM.idFromName(roomTag);
      const room = env.VOICE_ROOM.get(id);
      
      // Forward la requête au Durable Object
      return room.fetch(request);
    }
    
    // Route: /health
    if (url.pathname === '/health') {
      return jsonResponse({ 
        status: 'ok', 
        timestamp: Date.now(),
        version: CONFIG.VERSION,
        config: {
          maxParticipants: CONFIG.MAX_PARTICIPANTS,
          inactivityTimeoutMs: CONFIG.INACTIVITY_TIMEOUT_MS,
          authRequired: true,
        }
      }, 200, securityHeaders);
    }
    
    // Route: /stats
    if (url.pathname === '/stats') {
      return jsonResponse({
        status: 'ok',
        timestamp: Date.now(),
        version: CONFIG.VERSION,
        // Pas de stats détaillées pour préserver l'anonymat
      }, 200, securityHeaders);
    }
    
    // Route: /config
    if (url.pathname === '/config') {
      return jsonResponse({
        maxParticipants: CONFIG.MAX_PARTICIPANTS,
        maxPacketSize: CONFIG.MAX_PACKET_SIZE,
        pingInterval: CONFIG.PING_INTERVAL_MS,
        authRequired: true,
        version: CONFIG.VERSION,
      }, 200, securityHeaders);
    }
    
    // 404
    return jsonResponse({ 
      error: 'Not found',
      code: 'NOT_FOUND',
    }, 404, securityHeaders);
  },
};

// ============================================
// HELPERS
// ============================================

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}