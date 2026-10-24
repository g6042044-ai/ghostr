-- ============================================================================
-- GHOSTR — PURGE INITIALE (tâche 0.3bis) — OPÉRATION PONCTUELLE, IRRÉVERSIBLE
-- ============================================================================
--
-- NE PAS EXÉCUTER CE FICHIER EN ENTIER. Il contient trois blocs, à lancer
-- l'un après l'autre, chacun SEUL dans le SQL Editor, dans l'ordre :
--
--   BLOC 1 — vider les compteurs anti-abus (rate_limits)
--   BLOC 2 — purger messages et signaux, par lots (2a à relancer, puis 2b)
--   BLOC 3 — rendre l'espace disque (VACUUM FULL)
--
-- PRÉREQUIS : supabase/migration_retention.sql appliquée (fonction de purge à
-- deux durées). Le bloc 2 le vérifie et s'arrête sinon.
--
-- POURQUOI DES BLOCS SÉPARÉS : chaque exécution du SQL Editor est une
-- transaction ; un verrou pris au début n'est rendu qu'à la fin. Séparer
-- garantit que le verrou exclusif du TRUNCATE (bloc 1) dure quelques
-- millisecondes, au lieu de toute la purge. Et VACUUM ne peut pas tourner dans
-- une transaction : il doit être seul.
--
-- EFFET SUR L'APP (version publiée comprise) : aucune interruption attendue.
-- Mesuré sur réplique aux volumes de prod (6,4 Go) pendant qu'un client envoyait
-- et relevait des messages en continu (journal de plan_actions.md, 0.3bis).
--
-- CE QUI EST SUPPRIMÉ, DÉFINITIVEMENT :
--   • tous les compteurs anti-abus (ils ne servent que sur 60 s) ;
--   • les messages de plus de 48 h, sauf invitations et acceptations ;
--   • les invitations et acceptations de plus de 30 jours ;
--   • les signaux d'appel de plus de 24 h ;
--   • la table demo_invite_backup (sauvegarde manuelle de l'invitation de
--     démo Apple, devenue inutile : app validée, décision du 2026-10-23).
-- ============================================================================


-- ============================================================================
-- BLOC 1 — VIDER LES COMPTEURS ANTI-ABUS
-- ============================================================================
-- TRUNCATE plutôt que DELETE : rend les ~5,7 Go immédiatement. Un DELETE
-- laisserait l'espace occupé jusqu'à un VACUUM FULL, qui verrouillerait la
-- table pendant toute la réécriture.
-- Effet : les compteurs repartent à zéro. Au pire, un tag peut envoyer 15
-- messages de plus dans la minute en cours. Aucun effet sur les messages.
-- lock_timeout : si une requête de l'app tient la table, on abandonne au bout
-- de 5 s au lieu de faire attendre l'app derrière nous. Relancer suffit.

SET lock_timeout = '5s';
TRUNCATE public.rate_limits;
SELECT count(*) AS rate_limits_restantes,
       pg_size_pretty(pg_total_relation_size('public.rate_limits')) AS taille_rate_limits
FROM   public.rate_limits;

-- Attendu : rate_limits_restantes = 0 (ou quelques lignes si l'app a écrit
-- entre-temps), taille de quelques dizaines de ko.
-- Erreur « canceling statement due to lock timeout » : rien n'a été fait,
-- relancer le bloc.


-- ============================================================================
-- BLOC 2 — PURGER MESSAGES ET SIGNAUX, PAR LOTS (à relancer jusqu'à la fin)
-- ============================================================================
-- Les blobs ne sont PAS purgés ici : cleanup_expired_blobs() n'a jamais pu
-- fonctionner (SET ROLE interdit dans une fonction SECURITY DEFINER, et
-- postgres n'est pas membre de supabase_storage_admin en prod). Leur purge
-- passe par l'API Storage : tâche à part (plan_actions.md, 0.3bis).
--
-- Historique : la première version de ce bloc purgeait tout en une requête.
-- En prod (2026-10-24), elle a dépassé le délai du SQL Editor (« upstream
-- timeout ») et a été annulée sans rien supprimer. Chaque appel traite
-- désormais au plus 5 000 messages et rend la main.
--
-- 2a. Lancer cette requête SEULE, puis la RELANCER tant que
--     "reste_a_purger" vaut true. Chaque passage est une transaction
--     complète : s'il est interrompu, rien de ce passage n'est perdu à
--     moitié, et le suivant reprend où on en était.

SELECT public.cleanup_old_data() AS passage;

-- Attendu au premier passage : deleted_messages_plus_de_30j = 5000,
-- reste_a_purger = true, duree_ms de quelques secondes. Au dernier :
-- reste_a_purger = false. Avec ~34 700 messages : 7 à 8 passages.
-- Si un passage dépasse le délai (erreur « upstream timeout ») : rien n'est
-- perdu, relancer avec un lot plus petit :
--     SELECT public.cleanup_old_data(2, 1, 30, 1000) AS passage;
--
-- 2b. Une fois "reste_a_purger" à false, lancer SEUL :

DROP TABLE IF EXISTS public.demo_invite_backup;
SELECT json_build_object(
    'messages_restants',        (SELECT count(*) FROM public.messages),
    'plus_ancien_hors_invit',   (SELECT min(created_at) FROM public.messages
                                 WHERE NOT public.is_handshake_payload(sealed_payload)),
    'plus_ancienne_invitation', (SELECT min(created_at) FROM public.messages
                                 WHERE public.is_handshake_payload(sealed_payload)),
    'demo_invite_backup',       to_regclass('public.demo_invite_backup') IS NOT NULL
) AS etat_apres;

-- Attendu : plus_ancien_hors_invit vide ou < 48 h, plus_ancienne_invitation
-- < 30 jours, demo_invite_backup = false.


-- ============================================================================
-- BLOC 3 — RENDRE L'ESPACE DISQUE
-- ============================================================================
-- Après un DELETE, PostgreSQL garde l'espace pour le réutiliser ; seul
-- VACUUM FULL le rend. Il réécrit la table avec ses seules lignes vivantes
-- (quelques centaines après le bloc 2) et la verrouille pendant ce temps :
-- mesuré à moins d'une seconde sur réplique au même volume. Lancer cette
-- ligne SEULE (VACUUM refuse de tourner dans une transaction).

VACUUM FULL public.messages;

-- Puis, pour constater le résultat (lecture pure) :
--
-- SELECT pg_size_pretty(pg_database_size(current_database()))          AS taille_base,
--        pg_size_pretty(pg_total_relation_size('public.messages'))     AS messages,
--        pg_size_pretty(pg_total_relation_size('public.rate_limits'))  AS rate_limits;
--
-- Attendu : base de l'ordre de quelques dizaines de Mo.
-- ============================================================================
