'use strict';

// ============================================
// BALAYAGE DES BLOBS EXPIRÉS (tâche 0.3bis, sous-tâche blobs)
// ============================================
// Le bucket Storage `ghostr-blobs` porte les médias chiffrés de bout en bout.
// La promesse de l'app est « plus rien sur le serveur après 48 h ». Rien ne la
// tenait pour les blobs : la fonction SQL cleanup_expired_blobs() n'a jamais
// pu fonctionner (SET ROLE interdit en SECURITY DEFINER) et, de toute façon,
// un DELETE SQL sur storage.objects laisse le fichier orphelin sur le disque.
// La doc Supabase impose l'API Storage pour supprimer des objets.
//
// Le gateway est le seul client de ce bucket et y accède avec la clé anon,
// dont les policies autorisent lister, lire et supprimer. Ce module liste le
// bucket par date de création croissante et supprime, par lots de 1 000 au
// plus (plafond de l'API), tout ce qui a plus de BLOB_TTL_MS.
//
// Journalisation : règle de la tâche 0.5. Jamais un nom de blob, jamais une
// taille individuelle, jamais un message d'erreur relayé par Supabase. Seuls
// des comptes agrégés sortent de ce module.

const BUCKET = 'ghostr-blobs';
const BLOB_TTL_MS = 48 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;          // objets par page de listing
const DELETE_BATCH_SIZE = 1000;  // plafond de l'API Storage par appel DELETE
const MAX_PAGES = 100;           // garde-fou : 100 000 objets par passage
// Même forme que la policy ghostr_blobs_upload et que la validation des RPC
// blob du gateway : on ne supprime que ce que le gateway a pu écrire.
const BLOB_NAME_RE = /^[A-Za-z0-9_-]+\.bin$/;

function storageHeaders(anonKey) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${anonKey}`,
    'apikey': anonKey,
  };
}

async function listPage({ fetchImpl, supabaseUrl, anonKey, offset }) {
  const resp = await fetchImpl(`${supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: storageHeaders(anonKey),
    body: JSON.stringify({
      prefix: '',
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: 'created_at', order: 'asc' },
    }),
  });
  if (!resp.ok) throw new Error(`blob sweep: list HTTP ${resp.status}`);
  const items = await resp.json();
  if (!Array.isArray(items)) throw new Error('blob sweep: list response is not an array');
  return items;
}

async function deleteBatch({ fetchImpl, supabaseUrl, anonKey, names }) {
  const resp = await fetchImpl(`${supabaseUrl}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: storageHeaders(anonKey),
    body: JSON.stringify({ prefixes: names }),
  });
  if (!resp.ok) throw new Error(`blob sweep: delete HTTP ${resp.status}`);
  const results = await resp.json();
  // L'API renvoie la liste des objets effectivement supprimés. Un objet déjà
  // parti entre le listing et la suppression n'y figure pas : ce n'est pas
  // une erreur.
  return Array.isArray(results) ? results.length : 0;
}

/**
 * Un passage de balayage. Liste le bucket par created_at croissant, collecte
 * les objets plus vieux que ttlMs, s'arrête à la première page qui contient
 * un objet encore valide (tout ce qui suit l'est aussi), puis supprime par
 * lots. En dryRun, liste seulement.
 *
 * @returns {{ listed:number, expired:number, deleted:number, skipped:number,
 *             pages:number, dryRun:boolean }}
 *   skipped = entrées ignorées (dossier, nom hors forme, created_at illisible)
 */
async function sweepExpiredBlobs(options) {
  const {
    supabaseUrl,
    anonKey,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    ttlMs = BLOB_TTL_MS,
    dryRun = false,
  } = options || {};

  if (!supabaseUrl || !anonKey) throw new Error('blob sweep: SUPABASE_URL and SUPABASE_ANON_KEY are required');
  if (typeof fetchImpl !== 'function') throw new Error('blob sweep: no fetch implementation');

  const cutoff = now() - ttlMs;
  const expiredNames = [];
  let listed = 0;
  let skipped = 0;
  let pages = 0;
  let reachedLiveObject = false;

  // 1. Collecte. Rien n'est supprimé pendant le listing : supprimer en cours
  //    de pagination décalerait les offsets et ferait sauter des objets.
  while (!reachedLiveObject && pages < MAX_PAGES) {
    const items = await listPage({ fetchImpl, supabaseUrl, anonKey, offset: pages * PAGE_SIZE });
    pages++;
    listed += items.length;

    for (const item of items) {
      // Un dossier (placeholder) a un id null ; un nom hors forme n'a pas pu
      // être écrit par le gateway. Dans les deux cas on ne touche pas.
      if (!item || typeof item.name !== 'string' || !BLOB_NAME_RE.test(item.name) || item.id == null) {
        skipped++;
        continue;
      }
      const createdAt = Date.parse(item.created_at);
      if (!Number.isFinite(createdAt)) {
        // Date illisible : on ne supprime jamais sur un doute.
        skipped++;
        continue;
      }
      if (createdAt < cutoff) {
        expiredNames.push(item.name);
      } else {
        // Tri croissant garanti par la requête : le reste est plus récent.
        reachedLiveObject = true;
      }
    }

    if (items.length < PAGE_SIZE) break; // dernière page
  }

  // 2. Suppression par lots.
  let deleted = 0;
  if (!dryRun) {
    for (let i = 0; i < expiredNames.length; i += DELETE_BATCH_SIZE) {
      const batch = expiredNames.slice(i, i + DELETE_BATCH_SIZE);
      deleted += await deleteBatch({ fetchImpl, supabaseUrl, anonKey, names: batch });
    }
  }

  return { listed, expired: expiredNames.length, deleted, skipped, pages, dryRun };
}

/**
 * Planifie le balayage : un premier passage après `initialDelayMs`, puis
 * toutes les `intervalMs`. Les erreurs sont absorbées et comptées, jamais
 * propagées : le balayage ne doit jamais faire tomber le gateway.
 *
 * onResult(result) et onError() reçoivent uniquement des comptes.
 */
function startBlobSweep(options) {
  const {
    intervalMs = 6 * 60 * 60 * 1000,
    initialDelayMs = 60 * 1000,
    onResult = () => {},
    onError = () => {},
    setTimeoutImpl = setTimeout,
    setIntervalImpl = setInterval,
    ...sweepOptions
  } = options || {};

  let running = false;
  async function runOnce() {
    if (running) return; // un passage à la fois, même si l'intervalle rattrape
    running = true;
    try {
      const result = await sweepExpiredBlobs(sweepOptions);
      onResult(result);
    } catch (_e) {
      // Pas de message d'erreur relayé : il peut contenir une réponse Supabase.
      onError();
    } finally {
      running = false;
    }
  }

  setTimeoutImpl(() => {
    runOnce();
    setIntervalImpl(runOnce, intervalMs);
  }, initialDelayMs);

  return { runOnce };
}

module.exports = {
  BUCKET,
  BLOB_TTL_MS,
  PAGE_SIZE,
  DELETE_BATCH_SIZE,
  sweepExpiredBlobs,
  startBlobSweep,
};
