-- ============================================================================
-- GHOSTR — MIGRATION DELTA : RÈGLE DE RÉTENTION À DEUX DURÉES (tâche 0.3bis)
-- ============================================================================
--
-- À exécuter dans le SQL Editor de Supabase Dashboard, fichier ENTIER.
-- Idempotente. Une seule transaction : au moindre contrôle en échec, rien
-- n'est appliqué. AUCUNE DONNÉE N'EST LUE NI SUPPRIMÉE PAR CE FICHIER : il
-- remplace seulement la fonction de purge. La purge elle-même est l'étape
-- suivante (supabase/purge_initiale_0_3bis.sql), puis la planification
-- (supabase/migration_cron_retention.sql).
--
-- DÉCISION DU PORTEUR (2026-10-23) :
--   • trafic de conversation (messages réels et leurres) : 48 h ;
--   • invitations et acceptations d'invitation : 30 jours ;
--   • signaux d'appel : 24 h ; compteurs anti-abus : 2 min.
--
-- POURQUOI 30 JOURS POUR LES INVITATIONS : le QR ne contient que le tag, le
--   bundle d'invitation vit dans `messages`. Sa durée de vie EST la rétention
--   serveur. L'app (version publiée comprise) affiche « expire dans 30 jours »
--   (pendingInvites.DEFAULT_EXPIRY_MS). Les acceptations suivent : sinon une
--   invitation scannée au 20e jour verrait son acceptation purgée si
--   l'émetteur n'ouvre pas l'app sous 48 h — connexion perdue.
--
-- CONTREPARTIE ASSUMÉE : le champ `data` d'une invitation est du base64 de
--   JSON en clair (nom affiché, avatar, clés publiques) — inévitable, le
--   scanneur est inconnu à la création. Le serveur en garde donc une copie
--   lisible 30 jours au lieu de 48 h.
--
-- COMMENT LE TRI EST FAIT : le gateway dé-scelle l'enveloppe avant Supabase
--   (ohttp-gateway/server.js, `p_sealed_content: inner.innerPayload`). La
--   version publiée (792ff5a6, sessionService.ts) écrit
--   JSON.stringify({ type: 'ghostr_invite_pq', ... }) — donc la chaîne exacte
--   `"type":"ghostr_invite_pq"`, sans espace. Idem pour ghostr_accept_pq.
--   LIKE et non un cast jsonb : une ligne au JSON malformé ferait échouer
--   toute la purge, en silence.
--
-- ÉCART AVEC LE DÉPÔT RÉSORBÉ : la prod avait cleanup_old_data(int, int), sans
--   distinction des invitations, et pas d'is_handshake_payload
--   (migration_invite_ttl.sql jamais appliquée en entier). Après ce fichier,
--   la prod et schema.sql ont la même fonction.
-- ============================================================================


-- ============================================================================
-- À LANCER D'ABORD, SEUL : CE QUE LA NOUVELLE RÈGLE SUPPRIMERA (lecture pure)
-- ============================================================================
-- Copier sans les « -- » de début de ligne. Ne supprime rien : compte ce que
-- la purge initiale supprimera, et vérifie deux prérequis.
--
-- SELECT json_build_object(
--   'messages_total',              (SELECT count(*) FROM public.messages),
--   'invitations_gardees_30j',     (SELECT count(*) FROM public.messages
--                                   WHERE sealed_payload LIKE '%"type":"ghostr_invite_pq"%'
--                                     AND created_at >= now() - interval '30 days'),
--   'acceptations_gardees_30j',    (SELECT count(*) FROM public.messages
--                                   WHERE sealed_payload LIKE '%"type":"ghostr_accept_pq"%'
--                                     AND created_at >= now() - interval '30 days'),
--   'invitations_supprimees',      (SELECT count(*) FROM public.messages
--                                   WHERE (sealed_payload LIKE '%"type":"ghostr_invite_pq"%'
--                                       OR sealed_payload LIKE '%"type":"ghostr_accept_pq"%')
--                                     AND created_at < now() - interval '30 days'),
--   'autres_messages_gardes_48h',  (SELECT count(*) FROM public.messages
--                                   WHERE sealed_payload NOT LIKE '%"type":"ghostr_invite_pq"%'
--                                     AND sealed_payload NOT LIKE '%"type":"ghostr_accept_pq"%'
--                                     AND created_at >= now() - interval '48 hours'),
--   'autres_messages_supprimes',   (SELECT count(*) FROM public.messages
--                                   WHERE sealed_payload NOT LIKE '%"type":"ghostr_invite_pq"%'
--                                     AND sealed_payload NOT LIKE '%"type":"ghostr_accept_pq"%'
--                                     AND created_at < now() - interval '48 hours'),
--   'postgres_peut_purger_storage', pg_has_role('postgres', 'supabase_storage_admin', 'MEMBER'),
--   'pg_cron_disponible',          EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
-- ) AS apercu_purge;
-- ============================================================================


BEGIN;

-- ── 0. PRÉCONDITIONS ─────────────────────────────────────────────────────

DO $preconditions$
DECLARE
    v_manquantes TEXT;
BEGIN
    SELECT string_agg(t.nom, ', ' ORDER BY t.nom)
    INTO   v_manquantes
    FROM  (VALUES ('messages'), ('call_signals'), ('rate_limits'), ('invite_ttl_exempt')) AS t(nom)
    WHERE  to_regclass('public.' || t.nom) IS NULL;

    IF v_manquantes IS NOT NULL THEN
        RAISE EXCEPTION 'PRÉCONDITION NON REMPLIE — rien n''a été modifié. Tables absentes : %', v_manquantes;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = 'cleanup_old_data') THEN
        RAISE EXCEPTION 'PRÉCONDITION NON REMPLIE — cleanup_old_data absente : cette base ne ressemble pas à la production.';
    END IF;
END $preconditions$;


-- ── 1. PRÉDICAT « CECI EST UNE INVITATION OU UNE ACCEPTATION » ────────────

CREATE OR REPLACE FUNCTION public.is_handshake_payload(p_payload TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT p_payload LIKE '%"type":"ghostr_invite_pq"%'
        OR p_payload LIKE '%"type":"ghostr_accept_pq"%';
$$;

COMMENT ON FUNCTION public.is_handshake_payload(TEXT) IS
    'Vrai si le payload est un bundle d''invitation ou un accusé d''acceptation (TTL long). Le contenu reste chiffré E2EE — seul le type d''enveloppe est lu.';


-- ── 2. FONCTION DE PURGE À DEUX DURÉES, PAR LOTS ─────────────────────────
-- Par lots depuis le 2026-10-24 : la première version (tout en une requête)
-- a dépassé le délai du SQL Editor en prod sur 700 Mo d'arriéré — requête
-- annulée, rien de perdu. Chaque appel traite désormais au plus p_lot
-- messages ; tout ce qui a plus de 30 jours part sans lecture du contenu.
-- Toutes les surcharges existantes sont supprimées avant : la signature change
-- (2, 3 ou 4 paramètres selon l'état de la base), et un CREATE OR REPLACE créerait une SURCHARGE de plus,
-- rendant l'appel sans argument (celui du cron) ambigu.
-- Rien n'appelle cleanup_old_data en production tant que le cron n'est pas
-- planifié : la supprimer un instant, dans la transaction, ne gêne rien.

DO $drop_surcharges$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'cleanup_old_data'
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
    END LOOP;
END $drop_surcharges$;

CREATE FUNCTION public.cleanup_old_data(
    p_messages_days  INTEGER DEFAULT 2,
    p_signals_days   INTEGER DEFAULT 1,
    p_handshake_days INTEGER DEFAULT 30,
    p_lot            INTEGER DEFAULT 5000
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
    v_debut            TIMESTAMPTZ := clock_timestamp();
    deleted_anciens    INTEGER;
    deleted_trafic     INTEGER;
    deleted_signals    INTEGER;
    deleted_rates      INTEGER;
BEGIN
    -- Travail BORNÉ par appel : au plus p_lot messages, p_lot signaux et
    -- 10 × p_lot compteurs. Un retard (première purge, panne du cron) se
    -- résorbe en plusieurs passages au lieu de faire échouer chacun d'eux.
    IF p_lot IS NULL OR p_lot < 1 OR p_handshake_days < p_messages_days THEN
        RAISE EXCEPTION 'cleanup_old_data : paramètres invalides (p_lot >= 1, p_handshake_days >= p_messages_days).';
    END IF;

    -- 1. Plus vieux que la durée longue (30 j) : TOUT part, invitation ou non.
    --    Aucun tri nécessaire, donc aucune lecture du contenu : rapide même sur
    --    un gros arriéré. Sélection par l'index sur created_at, plus anciens d'abord.
    WITH cible AS (
        SELECT m.id
        FROM   public.messages m
        WHERE  m.created_at < now() - (p_handshake_days || ' days')::INTERVAL
          AND  NOT EXISTS (SELECT 1 FROM public.invite_ttl_exempt e WHERE e.tag = m.tag)
        ORDER  BY m.created_at
        LIMIT  p_lot
    ), d AS (
        DELETE FROM public.messages m USING cible WHERE m.id = cible.id RETURNING 1
    ) SELECT count(*) INTO deleted_anciens FROM d;

    -- 2. Entre 48 h et 30 j : seul le trafic de conversation (messages réels
    --    et leurres) part ; invitations et acceptations restent. Il faut lire
    --    le type, d'où le budget restant seulement.
    WITH cible AS (
        SELECT m.id
        FROM   public.messages m
        WHERE  m.created_at <  now() - (p_messages_days  || ' days')::INTERVAL
          AND  m.created_at >= now() - (p_handshake_days || ' days')::INTERVAL
          AND  NOT public.is_handshake_payload(m.sealed_payload)
          AND  NOT EXISTS (SELECT 1 FROM public.invite_ttl_exempt e WHERE e.tag = m.tag)
        ORDER  BY m.created_at
        LIMIT  greatest(p_lot - deleted_anciens, 0)
    ), d AS (
        DELETE FROM public.messages m USING cible WHERE m.id = cible.id RETURNING 1
    ) SELECT count(*) INTO deleted_trafic FROM d;

    -- 3. Signaux d'appel > 24 h
    WITH cible AS (
        SELECT s.id FROM public.call_signals s
        WHERE  s.created_at < now() - (p_signals_days || ' days')::INTERVAL
        LIMIT  p_lot
    ), d AS (
        DELETE FROM public.call_signals s USING cible WHERE s.id = cible.id RETURNING 1
    ) SELECT count(*) INTO deleted_signals FROM d;

    -- 4. Compteurs anti-abus : fenêtre de 60 s + 60 s de marge
    WITH cible AS (
        SELECT r.identifier, r.limit_type FROM public.rate_limits r
        WHERE  r.window_start < now() - INTERVAL '2 minutes'
        LIMIT  p_lot * 10
    ), d AS (
        DELETE FROM public.rate_limits r USING cible
        WHERE  r.identifier = cible.identifier AND r.limit_type = cible.limit_type
        RETURNING 1
    ) SELECT count(*) INTO deleted_rates FROM d;

    RETURN json_build_object(
        'deleted_messages_plus_de_30j', deleted_anciens,
        'deleted_trafic_48h_30j',       deleted_trafic,
        'deleted_signals',              deleted_signals,
        'deleted_rate_limits',          deleted_rates,
        'reste_a_purger',               deleted_anciens + deleted_trafic >= p_lot
                                        OR deleted_signals >= p_lot
                                        OR deleted_rates >= p_lot * 10,
        'duree_ms',                     round(extract(epoch FROM clock_timestamp() - v_debut) * 1000),
        'executed_at',                  now()
    );
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER)
    IS 'TTL cleanup par lots: 48h trafic, 30j handshake (hors invite_ttl_exempt), 24h signaux, 2min rate limits; au plus p_lot messages par appel. Cron: */15 * * * *';


-- ── 3. DROITS : FONCTIONS INTERNES, FERMÉES À anon (cf. tâche 0.3) ───────

REVOKE EXECUTE ON FUNCTION public.is_handshake_payload(TEXT)                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_handshake_payload(TEXT)                  TO service_role;
GRANT  EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;


-- ── 4. CONTRÔLES BLOQUANTS ───────────────────────────────────────────────

DO $verif$
DECLARE
    v_nb INTEGER;
BEGIN
    -- 4a. Le prédicat reconnaît exactement ce qu'écrit la version publiée.
    IF NOT public.is_handshake_payload('{"type":"ghostr_invite_pq","version":2,"data":"QUJD","timestamp":1}')
       OR NOT public.is_handshake_payload('{"type":"ghostr_accept_pq","version":2,"data":"QUJD","timestamp":1}')
       OR public.is_handshake_payload('{"_p":"QUJDREVG","v":1}')
       OR public.is_handshake_payload('pas du json du tout') THEN
        RAISE EXCEPTION 'ÉCHEC 4a : is_handshake_payload ne trie pas correctement.';
    END IF;

    -- 4b. Une seule version de cleanup_old_data, à quatre paramètres.
    SELECT count(*) INTO v_nb
    FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public' AND p.proname = 'cleanup_old_data';
    IF v_nb <> 1 OR to_regprocedure('public.cleanup_old_data(integer, integer, integer, integer)') IS NULL THEN
        RAISE EXCEPTION 'ÉCHEC 4b : % version(s) de cleanup_old_data, attendu : une seule à 4 paramètres.', v_nb;
    END IF;

    -- 4c. Fermées à anon / authenticated, ouvertes au propriétaire et à service_role.
    IF has_function_privilege('anon',          'public.cleanup_old_data(integer, integer, integer, integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.cleanup_old_data(integer, integer, integer, integer)', 'EXECUTE')
       OR has_function_privilege('anon',          'public.is_handshake_payload(text)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.cleanup_old_data(integer, integer, integer, integer)', 'EXECUTE')
       OR NOT has_function_privilege('postgres',     'public.cleanup_old_data(integer, integer, integer, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'ÉCHEC 4c : droits incorrects sur cleanup_old_data / is_handshake_payload.';
    END IF;

    -- 4d. Les RPC de l'app restent appelables par anon.
    IF NOT has_function_privilege('anon', 'public.send_sealed_message(text, text, integer)', 'EXECUTE')
       OR NOT has_function_privilege('anon', 'public.get_messages_by_tags(text[], timestamptz, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'ÉCHEC 4d : une RPC de l''app n''est plus appelable par anon.';
    END IF;

    -- 4e. Appel RÉEL avec un lot d'une ligne, puis annulation : prouve que la
    --     fonction s'exécute sur cette base (colonnes, index, prédicat), sans
    --     rien supprimer.
    BEGIN
        PERFORM public.cleanup_old_data(2, 1, 30, 1);
        RAISE EXCEPTION USING ERRCODE = 'GH002', MESSAGE = 'essai annule';
    EXCEPTION WHEN SQLSTATE 'GH002' THEN
        NULL;
    END;
END $verif$;

COMMIT;


-- ── 5. RÉCAPITULATIF (sortie à lire) ─────────────────────────────────────
-- Attendu : 2 lignes, anon_peut_appeler = false sur les deux.

SELECT p.oid::regprocedure::TEXT                         AS fonction,
       has_function_privilege('anon', p.oid, 'EXECUTE')  AS anon_peut_appeler
FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public' AND p.proname IN ('cleanup_old_data', 'is_handshake_payload')
ORDER  BY 1;


-- ============================================================================
-- ANNULATION — remet la fonction de production du 2026-10-23 (une seule durée)
-- ============================================================================
-- Copier sans les « -- ». Ne restaure aucune donnée (ce fichier n'en supprime
-- aucune).
--
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.cleanup_old_data(integer, integer, integer, integer);
-- DROP FUNCTION IF EXISTS public.cleanup_old_data(integer, integer, integer);
-- CREATE FUNCTION public.cleanup_old_data(p_messages_days integer DEFAULT 2, p_signals_days integer DEFAULT 1)
--  RETURNS json LANGUAGE plpgsql SECURITY DEFINER
--  SET search_path TO 'public' SET statement_timeout TO '30s'
-- AS $function$
-- DECLARE deleted_messages INTEGER; deleted_signals INTEGER; deleted_rates INTEGER;
-- BEGIN
--     WITH d AS (DELETE FROM public.messages m
--                WHERE m.created_at < now() - (p_messages_days || ' days')::INTERVAL
--                  AND NOT EXISTS (SELECT 1 FROM public.invite_ttl_exempt e WHERE e.tag = m.tag)
--                RETURNING 1) SELECT count(*) INTO deleted_messages FROM d;
--     WITH d AS (DELETE FROM public.call_signals
--                WHERE created_at < now() - (p_signals_days || ' days')::INTERVAL
--                RETURNING 1) SELECT count(*) INTO deleted_signals FROM d;
--     WITH d AS (DELETE FROM public.rate_limits WHERE window_start < now() - INTERVAL '2 minutes'
--                RETURNING 1) SELECT count(*) INTO deleted_rates FROM d;
--     RETURN json_build_object('deleted_messages', deleted_messages, 'deleted_signals', deleted_signals,
--                              'deleted_rate_limits', deleted_rates, 'executed_at', now());
-- END;
-- $function$;
-- REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(integer, integer) FROM PUBLIC, anon, authenticated;
-- GRANT  EXECUTE ON FUNCTION public.cleanup_old_data(integer, integer) TO service_role;
-- DROP FUNCTION IF EXISTS public.is_handshake_payload(text);
-- COMMIT;
-- ============================================================================
