// ============================================
// PATCH: gateway-cluster.js
// Wrapper cluster pour le gateway OHTTP
// 
// À utiliser comme point d'entrée AU LIEU de server.js direct:
//   node gateway-cluster.js
//
// POURQUOI: À 10K utilisateurs, le polling génère ~2000 req/s.
// Un seul process Node.js sature un core CPU avec les opérations
// NaCl box.open() + HMAC + forwarding Supabase.
// Le cluster répartit la charge sur tous les cores disponibles.
//
// NOTE: certUsage et recentChallenges sont persistés sur disque
// (patch 01), donc chaque worker lit/écrit le même fichier.
// Pour éviter les race conditions, on utilise un lock simple
// (le pire cas est un double-count qui reset un compteur, 
// acceptable pour du rate limiting).
// ============================================

const cluster = require('cluster');
const os = require('os');

// Nombre de workers: min(CPU cores, 4) pour ne pas surcharger
// un petit VPS. Sur un VPS 2-core, ça donne 2 workers.
const WORKER_COUNT = Math.min(os.cpus().length, parseInt(process.env.GATEWAY_WORKERS || '4', 10));

if (cluster.isPrimary) {
  console.log(`🔧 Gateway cluster: starting ${WORKER_COUNT} workers on ${os.cpus().length} CPUs`);
  
  for (let i = 0; i < WORKER_COUNT; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.error(`⚠️ Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    // Redémarrage automatique avec délai pour éviter une boucle de crash
    setTimeout(() => cluster.fork(), 1000);
  });
  
  // Graceful shutdown: arrêter tous les workers proprement
  process.on('SIGTERM', () => {
    console.log('🛑 Cluster: SIGTERM received, shutting down workers...');
    for (const id in cluster.workers) {
      cluster.workers[id].process.kill('SIGTERM');
    }
  });
  
} else {
  // Worker: charger le serveur gateway normal
  require('./server.js');
  console.log(`✅ Worker ${process.pid} started`);
}
