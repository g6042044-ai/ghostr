// exit-relay/server.js
// Whisper Exit Relay - Second hop du double-hop anonymisant
// Version 5.0 - SECURITY HARDENING:
//   - v5.0: Logs minimisés (LOG_LEVEL=error en production)
//   - v5.0: Métriques endpoint supprimé
//   - v5.0: Aucun console.log en production (seulement erreurs)
//   - v4.0: Meilleure gestion du cycle de vie WebSocket
//   - v4.0: Proxy transparent sans parsing des messages
//
// ARCHITECTURE DOUBLE-HOP:
// [Entry Relay] ──► [Exit Relay (ce serveur)] ──► [SFU]
//
// SÉCURITÉ:
// - Aucune IP client n'est visible ici (anonymat total)
// - Aucun logging de roomTag, peerId, authToken
// - Les messages sont relayés de façon opaque (E2E préservé)

const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// ============================================
// CONFIGURATION
// ============================================

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_ENABLED = LOG_LEVEL !== 'error' && LOG_LEVEL !== 'none';

/** Log conditionnel - silencieux en production (LOG_LEVEL=error) */
function log(...args) {
  if (LOG_ENABLED) console.log(...args);
}

const CONFIG = {
  port: process.env.PORT || 8080,
  sfuUrl: process.env.SFU_URL || 'wss://whisper-sfu.ghostcrypt.workers.dev',
  
  // Timeouts
  connectionTimeout: 15000,
  handshakeTimeout: 10000,
  inactivityTimeout: 180000, // 3 minutes
  
  // Retry
  maxRetries: 3,
  retryDelay: 1000,
  
  // Limites
  maxMessageSize: 65536,
  maxQueueSize: 100,
  
  // Heartbeat
  pingInterval: 25000,
  pongTimeout: 10000,
  
  // Version
  version: '5.0',
};

// Log de démarrage (seulement si logs actifs)
log('Exit Relay Configuration:');
log('  VERSION:', CONFIG.version);
log('  PORT:', CONFIG.port);
log('  SFU_URL configured:', !!process.env.SFU_URL);
log('  LOG_LEVEL:', LOG_LEVEL);

// ============================================
// SERVEUR HTTP
// ============================================

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      status: 'ok',
      type: 'exit-relay',
      version: CONFIG.version,
      timestamp: Date.now(),
      connections: activeConnections,
    }));
    return;
  }

  // 404
  res.writeHead(404, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ============================================
// SERVEUR WEBSOCKET
// ============================================

const wss = new WebSocket.Server({
  server,
  maxPayload: CONFIG.maxMessageSize,
  verifyClient: () => true,
});

let activeConnections = 0;

/**
 * Classe pour gérer une connexion relayée
 * Gère le cycle de vie complet Entry ↔ SFU
 */
class RelayConnection {
  constructor(entrySocket, roomTag, peerId, authToken) {
    this.entrySocket = entrySocket;
    this.sfuSocket = null;
    this.roomTag = roomTag;
    this.peerId = peerId;
    this.authToken = authToken;
    
    // État
    this.sfuConnected = false;
    this.sfuConnecting = false;
    this.isClosed = false;
    this.retryCount = 0;
    
    // File d'attente pour les messages pendant la connexion SFU
    this.messageQueue = [];
    
    // Timers
    this.connectionTimeout = null;
    this.inactivityTimeout = null;
    this.pingInterval = null;
    this.pongTimeout = null;
    
    // Stats
    this.lastActivity = Date.now();
    this.messagesRelayed = 0;
    
    // Configurer les handlers Entry
    this.setupEntryHandlers();
    
    // Démarrer la connexion SFU
    this.connectToSfu();
    
    // Démarrer le timer d'inactivité
    this.resetInactivityTimeout();
  }

  /**
   * Configure les handlers pour la connexion Entry Relay
   */
  setupEntryHandlers() {
    this.entrySocket.on('message', (data, isBinary) => {
      this.handleEntryMessage(data, isBinary);
    });

    this.entrySocket.on('close', (code, reason) => {
      this.close(code, reason?.toString() || 'Entry closed');
    });

    this.entrySocket.on('error', () => {
      this.close(1011, 'Entry error');
    });

    this.entrySocket.on('pong', () => {
      this.clearPongTimeout();
    });
  }

  /**
   * Connecte au SFU avec retry logic
   */
  async connectToSfu() {
    if (this.sfuConnecting || this.sfuConnected || this.isClosed) {
      return;
    }

    this.sfuConnecting = true;

    // Construire l'URL SFU
    let sfuUrl = `${CONFIG.sfuUrl}/room/${this.roomTag}?peerId=${encodeURIComponent(this.peerId)}`;
    if (this.authToken) {
      sfuUrl += `&authToken=${encodeURIComponent(this.authToken)}`;
    }

    // Timeout de connexion
    this.connectionTimeout = setTimeout(() => {
      if (!this.sfuConnected && !this.isClosed) {
        this.handleSfuConnectionFailed('Connection timeout');
      }
    }, CONFIG.connectionTimeout);

    try {
      this.sfuSocket = new WebSocket(sfuUrl, {
        handshakeTimeout: CONFIG.handshakeTimeout,
        maxPayload: CONFIG.maxMessageSize,
      });

      this.sfuSocket.on('open', () => {
        this.handleSfuConnected();
      });

      this.sfuSocket.on('message', (data, isBinary) => {
        this.handleSfuMessage(data, isBinary);
      });

      this.sfuSocket.on('close', (code, reason) => {
        if (!this.isClosed) {
          this.close(code, reason?.toString() || 'SFU closed');
        }
      });

      this.sfuSocket.on('error', () => {
        this.handleSfuConnectionFailed('Connection error');
      });

      this.sfuSocket.on('pong', () => {
        // SFU répond au ping
      });

    } catch (error) {
      this.handleSfuConnectionFailed('Exception during connection');
    }
  }

  /**
   * Gère une connexion SFU réussie
   */
  handleSfuConnected() {
    this.clearConnectionTimeout();
    this.sfuConnected = true;
    this.sfuConnecting = false;
    this.retryCount = 0;

    // Vider la file d'attente
    this.flushMessageQueue();

    // Démarrer le ping
    this.startPingInterval();

    log('[Exit] SFU connected');
  }

  /**
   * Gère un échec de connexion SFU
   */
  handleSfuConnectionFailed(reason) {
    this.clearConnectionTimeout();
    this.sfuConnecting = false;

    // Nettoyer la socket SFU si elle existe
    if (this.sfuSocket) {
      try {
        this.sfuSocket.terminate();
      } catch (e) {}
      this.sfuSocket = null;
    }

    // Retry si possible
    if (this.retryCount < CONFIG.maxRetries && !this.isClosed) {
      this.retryCount++;
      log(`[Exit] SFU connection failed, retry ${this.retryCount}/${CONFIG.maxRetries}`);
      
      setTimeout(() => {
        if (!this.isClosed) {
          this.connectToSfu();
        }
      }, CONFIG.retryDelay * this.retryCount);
    } else {
      // Échec définitif
      this.close(1011, 'SFU connection failed');
    }
  }

  /**
   * Gère un message de l'Entry Relay
   * v4.0: Proxy transparent - pas de parsing, juste forward
   */
  handleEntryMessage(data, isBinary) {
    if (this.isClosed) return;

    this.lastActivity = Date.now();
    this.resetInactivityTimeout();

    // Si connecté au SFU, forward immédiatement
    if (this.sfuConnected && this.sfuSocket && this.sfuSocket.readyState === WebSocket.OPEN) {
      // D'abord vider la queue
      this.flushMessageQueue();
      
      // Puis envoyer le message (conserver le format binaire/texte)
      try {
        this.sfuSocket.send(data, { binary: isBinary });
        this.messagesRelayed++;
      } catch (e) {
        this.close(1011, 'SFU send failed');
      }
    } else {
      // Mettre en file d'attente (stocker avec l'info binaire)
      if (this.messageQueue.length < CONFIG.maxQueueSize) {
        this.messageQueue.push({ data, isBinary });
      } else {
        // Queue pleine
        this.close(1008, 'Message queue overflow');
      }
    }
  }

  /**
   * Gère un message du SFU
   * v4.0: Proxy transparent - pas de parsing, juste forward
   */
  handleSfuMessage(data, isBinary) {
    if (this.isClosed) return;

    this.lastActivity = Date.now();
    this.resetInactivityTimeout();

    // Forward vers l'Entry Relay (conserver le format)
    if (this.entrySocket && this.entrySocket.readyState === WebSocket.OPEN) {
      try {
        this.entrySocket.send(data, { binary: isBinary });
        this.messagesRelayed++;
      } catch (e) {
        this.close(1011, 'Entry send failed');
      }
    }
  }

  /**
   * Vide la file d'attente vers le SFU
   */
  flushMessageQueue() {
    if (!this.sfuSocket || !this.sfuConnected) return;

    while (this.messageQueue.length > 0) {
      const { data, isBinary } = this.messageQueue.shift();
      try {
        this.sfuSocket.send(data, { binary: isBinary });
        this.messagesRelayed++;
      } catch (e) {
        // Remettre en queue en cas d'erreur
        this.messageQueue.unshift({ data, isBinary });
        break;
      }
    }
  }

  /**
   * Démarre l'intervalle de ping
   */
  startPingInterval() {
    this.stopPingInterval();

    this.pingInterval = setInterval(() => {
      if (this.isClosed) {
        this.stopPingInterval();
        return;
      }

      // Ping Entry
      if (this.entrySocket && this.entrySocket.readyState === WebSocket.OPEN) {
        try {
          this.entrySocket.ping();
          this.setPongTimeout();
        } catch (e) {}
      }

      // Ping SFU
      if (this.sfuSocket && this.sfuSocket.readyState === WebSocket.OPEN) {
        try {
          this.sfuSocket.ping();
        } catch (e) {}
      }
    }, CONFIG.pingInterval);
  }

  /**
   * Arrête l'intervalle de ping
   */
  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clearPongTimeout();
  }

  /**
   * Configure le timeout de réponse pong
   */
  setPongTimeout() {
    this.clearPongTimeout();
    this.pongTimeout = setTimeout(() => {
      if (!this.isClosed) {
        log('[Exit] Pong timeout');
        this.close(1011, 'Pong timeout');
      }
    }, CONFIG.pongTimeout);
  }

  /**
   * Annule le timeout pong
   */
  clearPongTimeout() {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /**
   * Reset le timer d'inactivité
   */
  resetInactivityTimeout() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    this.inactivityTimeout = setTimeout(() => {
      if (!this.isClosed) {
        this.close(1000, 'Inactivity timeout');
      }
    }, CONFIG.inactivityTimeout);
  }

  /**
   * Annule le timeout de connexion
   */
  clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  /**
   * Ferme toutes les connexions proprement
   */
  close(code, reason) {
    if (this.isClosed) return;
    this.isClosed = true;

    // Arrêter tous les timers
    this.stopPingInterval();
    this.clearConnectionTimeout();
    
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }

    // Fermer la connexion Entry
    if (this.entrySocket) {
      try {
        if (this.entrySocket.readyState === WebSocket.OPEN) {
          this.entrySocket.close(code, reason);
        } else {
          this.entrySocket.terminate();
        }
      } catch (e) {}
      this.entrySocket = null;
    }

    // Fermer la connexion SFU
    if (this.sfuSocket) {
      try {
        if (this.sfuSocket.readyState === WebSocket.OPEN) {
          this.sfuSocket.close(code, reason);
        } else {
          this.sfuSocket.terminate();
        }
      } catch (e) {}
      this.sfuSocket = null;
    }

    // Vider la queue
    this.messageQueue = [];

    activeConnections--;
    log(`[Exit] Connection closed (active: ${activeConnections})`);
  }
}

// ============================================
// HANDLER DE CONNEXION WEBSOCKET
// ============================================

wss.on('connection', (entrySocket, req) => {
  activeConnections++;
  log(`[Exit] New connection (active: ${activeConnections})`);

  const parsedUrl = url.parse(req.url, true);

  // Valider le path: /room/:roomTag (32 caractères hex)
  const roomMatch = parsedUrl.pathname.match(/^\/room\/([a-f0-9]{32})$/);

  if (!roomMatch) {
    entrySocket.close(4000, 'Invalid room path');
    activeConnections--;
    return;
  }

  const roomTag = roomMatch[1];
  const peerId = parsedUrl.query.peerId;
  const authToken = parsedUrl.query.authToken;

  if (!peerId) {
    entrySocket.close(4001, 'Missing peerId');
    activeConnections--;
    return;
  }

  // Créer la connexion relayée
  // Note: roomTag et peerId ne sont pas loggés pour préserver l'anonymat
  new RelayConnection(entrySocket, roomTag, peerId, authToken);
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

server.listen(CONFIG.port, '0.0.0.0', () => {
  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log(`║           WHISPER EXIT RELAY v${CONFIG.version} - STARTED                  ║`);
  log('╠══════════════════════════════════════════════════════════════╣');
  log(`║  Port: ${CONFIG.port}                                                  ║`);
  log('║                                                              ║');
  log('║  🔒 PRIVACY GUARANTEES:                                      ║');
  log('║    • NO client IP logging                                    ║');
  log('║    • NO roomTag/peerId/authToken logging                     ║');
  log('║    • Messages relayed opaquely (E2E preserved)               ║');
  log('║    • Only aggregate stats (connection count)                 ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log('');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

function gracefulShutdown() {
  log('[Exit] Shutting down...');
  
  // Fermer toutes les connexions
  wss.clients.forEach((client) => {
    try {
      client.close(1001, 'Server shutting down');
    } catch (e) {}
  });

  // Fermer le serveur
  server.close(() => {
    log('[Exit] Server closed');
    process.exit(0);
  });

  // Force exit après 10 secondes
  setTimeout(() => {
    log('[Exit] Force exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Gestion des erreurs non capturées (sans exposer de détails)
process.on('uncaughtException', (error) => {
  console.error('[Exit] Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  console.error('[Exit] Unhandled rejection');
});