-- ============================================================================
-- GHOSTR — PLANIFICATION DES PURGES (tâche 0.3bis)
-- ============================================================================
--
-- PRÉREQUIS, DANS CET ORDRE :
--   1. supabase/migration_retention.sql appliquée ;
--   2. supabase/purge_initiale_0_3bis.sql exécutée (au minimum le bloc 1 :
--      vider les 21 millions de compteurs) ;
--   3. extension pg_cron activée : Dashboard → Database → Extensions →
--      rechercher « pg_cron » → Enable.
--
-- Puis exécuter ce fichier ENTIER. Idempotent : relancé, il remplace les deux
-- tâches par elles-mêmes.
--
-- Les tâches tournent en tant que postgres, propriétaire des fonctions : la
-- fermeture des fonctions internes à anon (tâche 0.3) ne les gêne pas.
-- ============================================================================

BEGIN;

DO $prerequis$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE EXCEPTION 'pg_cron n''est pas activée : Dashboard → Database → Extensions → pg_cron → Enable, puis relancer. Rien n''a été fait.';
    END IF;
    IF to_regprocedure('public.cleanup_old_data(integer, integer, integer, integer)') IS NULL THEN
        RAISE EXCEPTION 'migration_retention.sql n''est pas appliquée. Rien n''a été fait.';
    END IF;
    -- Plus bloquant depuis la purge par lots : un arriéré se résorbe seul,
    -- p_lot messages par passage. Seul garde-fou gardé : le TRUNCATE initial.
    IF (SELECT count(*) FROM public.rate_limits) > 1000000 THEN
        RAISE EXCEPTION 'rate_limits contient encore plus d''un million de lignes : lancer d''abord le bloc 1 de purge_initiale_0_3bis.sql. Rien n''a été fait.';
    END IF;
END $prerequis$;

-- Remplacer proprement d'éventuelles tâches homonymes.
SELECT cron.unschedule(jobid) FROM cron.job
WHERE  jobname IN ('cleanup-ghostr', 'cleanup-ghostr-blobs');

SELECT cron.schedule('cleanup-ghostr',       '*/15 * * * *', 'SELECT public.cleanup_old_data()');
-- PAS de tâche pour les blobs : cleanup_expired_blobs() échoue à chaque appel
-- (SET ROLE interdit en SECURITY DEFINER). La purge des blobs passe par l'API
-- Storage, tâche à part. Une éventuelle tâche homonyme est retirée ci-dessus.

DO $verif$
BEGIN
    IF (SELECT count(*) FROM cron.job
        WHERE jobname = 'cleanup-ghostr' AND schedule = '*/15 * * * *'
          AND command = 'SELECT public.cleanup_old_data()' AND active) <> 1
       OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-ghostr-blobs') THEN
        RAISE EXCEPTION 'ÉCHEC : la tâche planifiée cleanup-ghostr n''est pas en place comme attendu.';
    END IF;
END $verif$;

COMMIT;

SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobname;

-- Attendu : exactement 1 ligne active, cleanup-ghostr.
--
-- CONTRÔLE 20 MINUTES PLUS TARD (lecture pure) — chaque passage doit être
-- « succeeded » :
--
-- SELECT j.jobname, d.status, d.return_message, d.start_time
-- FROM   cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
-- ORDER  BY d.start_time DESC LIMIT 10;
--
-- CONTRÔLE DURABLE (à relancer de temps en temps) — doit rester sous 49 h :
--
-- SELECT now() - min(created_at) AS age_plus_ancien_message
-- FROM   public.messages WHERE NOT public.is_handshake_payload(sealed_payload);
--
-- ANNULATION :
--   SELECT cron.unschedule('cleanup-ghostr');
-- ============================================================================
