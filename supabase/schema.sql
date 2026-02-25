-- ============================================================================
-- GHOSTR — SCHÉMA COMPLET v26.0
-- ============================================================================
--
-- Script standalone: supprime tout et recrée from scratch.
-- Exécuter dans le SQL Editor de Supabase Dashboard.
--
-- ARCHITECTURE:
--   • 3 tables publiques: messages, call_signals, rate_limits
--   • 1 table monitoring: blob_cleanup_log
--   • 4 RPCs publiques: send_sealed_message, get_messages_by_tags,
--                        send_call_signal, get_call_signals_by_tags
--   • 2 RPCs internes: check_rate_limit, cleanup_old_data
--   • 1 RPC maintenance: cleanup_expired_blobs
--   • 2 buckets storage: ghostr-blobs (v26.0 médias E2E), whisper-media (legacy)
--   • Cron jobs: cleanup messages/signaux (15min), cleanup blobs (6h)
--
-- PRINCIPES SÉCURITÉ:
--   1. Zero-knowledge: le serveur ne peut lire aucun contenu
--   2. RPC-only: aucun accès direct aux tables (RLS deny-all)
--   3. Rate limiting sur écriture ET lecture (par tag individuel)
--   4. Payload opaque: tag + sealed_payload, rien d'autre
--   5. TTL automatique: messages 48h, signaux 24h, blobs 48h
--   6. statement_timeout sur toutes les fonctions (défense DoS)
--   7. Validation stricte de toutes les entrées
--   8. Sealed sender: aucun identifiant expéditeur (pas de device_id)
--   9. Blob storage: médias chiffrés E2E, UUID aléatoire, IP cachée via relay
-- ============================================================================


-- ============================================================================
-- 0. EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- digest() pour payload_hash


-- ============================================================================
-- 1. RESET — Supprimer tout proprement
-- ============================================================================

-- Fonctions publiques
DROP FUNCTION IF EXISTS public.send_sealed_message(TEXT, TEXT, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.get_messages_by_tags(TEXT[], TIMESTAMPTZ, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.send_call_signal(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.get_call_signals_by_tags(TEXT[], TIMESTAMPTZ, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.download_blob(TEXT) CASCADE;

-- Fonctions internes
DROP FUNCTION IF EXISTS public.check_rate_limit(TEXT, TEXT, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.cleanup_old_data(INTEGER, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.cleanup_expired_blobs() CASCADE;

-- Anciennes signatures (compat drop)
DROP FUNCTION IF EXISTS public.send_message(TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.send_call_signal(TEXT, TEXT, TEXT) CASCADE;

-- Tables
DROP TABLE IF EXISTS public.blob_cleanup_log CASCADE;
DROP TABLE IF EXISTS public.rate_limits CASCADE;
DROP TABLE IF EXISTS public.call_signals CASCADE;
DROP TABLE IF EXISTS public.messages CASCADE;

-- Storage policies (ghostr-blobs)
DROP POLICY IF EXISTS "ghostr_blobs_upload"   ON storage.objects;
DROP POLICY IF EXISTS "ghostr_blobs_download" ON storage.objects;
DROP POLICY IF EXISTS "ghostr_blobs_delete"   ON storage.objects;
DROP POLICY IF EXISTS "blob_anon_upload"       ON storage.objects;
DROP POLICY IF EXISTS "blob_anon_download"     ON storage.objects;

-- Storage policies (whisper-media)
DROP POLICY IF EXISTS "whisper_media_upload"   ON storage.objects;
DROP POLICY IF EXISTS "whisper_media_download" ON storage.objects;
DROP POLICY IF EXISTS "whisper_media_delete"   ON storage.objects;

-- Buckets: vider et supprimer. Si ça échoue, ON CONFLICT sur l'INSERT plus bas.
DO $$
BEGIN
  PERFORM storage.empty_bucket('ghostr-blobs');
  DELETE FROM storage.buckets WHERE id = 'ghostr-blobs';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM storage.empty_bucket('whisper-media');
  DELETE FROM storage.buckets WHERE id = 'whisper-media';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Cron jobs (si pg_cron est activé)
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-ghostr');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-ghostr-blobs');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;


-- ============================================================================
-- 2. TABLES
-- ============================================================================

-- ── Messages E2E chiffrés ──
CREATE TABLE public.messages (
    id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    tag            TEXT        NOT NULL,
    sealed_payload TEXT        NOT NULL,
    payload_hash   TEXT        GENERATED ALWAYS AS (
                     encode(digest(sealed_payload, 'sha256'), 'hex')
                   ) STORED,
    created_at     TIMESTAMPTZ DEFAULT now() NOT NULL,

    CONSTRAINT messages_tag_length    CHECK (length(tag) BETWEEN 8 AND 128),
    CONSTRAINT messages_payload_size  CHECK (length(sealed_payload) BETWEEN 10 AND 262144)
);

-- Anti-replay: rejet des doublons au niveau INSERT
CREATE UNIQUE INDEX idx_messages_payload_hash
    ON public.messages (payload_hash);

COMMENT ON TABLE  public.messages IS 'Messages chiffrés E2E — le serveur ne peut pas lire le contenu';
COMMENT ON COLUMN public.messages.tag IS 'Tag opaque de routage (epoch tag HKDF, rotation 5min)';
COMMENT ON COLUMN public.messages.payload_hash IS 'SHA-256 du payload — empêche les replay attacks';
COMMENT ON COLUMN public.messages.sealed_payload IS 'Payload chiffré Triple Ratchet (NaCl sealed box)';


-- ── Signaux d'appel chiffrés ──
CREATE TABLE public.call_signals (
    id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    tag            TEXT        NOT NULL,
    sealed_payload TEXT        NOT NULL,
    created_at     TIMESTAMPTZ DEFAULT now() NOT NULL,

    CONSTRAINT call_signals_tag_length    CHECK (length(tag) BETWEEN 8 AND 128),
    CONSTRAINT call_signals_payload_size  CHECK (length(sealed_payload) BETWEEN 10 AND 262144)
);

COMMENT ON TABLE public.call_signals IS 'Signaux d''appel chiffrés — signal_type et call_id dans sealed_payload';


-- ── Rate limiting ──
CREATE TABLE public.rate_limits (
    identifier    TEXT        NOT NULL,
    limit_type    TEXT        DEFAULT 'default' NOT NULL,
    request_count INTEGER     DEFAULT 1 NOT NULL,
    window_start  TIMESTAMPTZ DEFAULT date_trunc('minute', now()) NOT NULL,

    PRIMARY KEY (identifier, limit_type),

    CONSTRAINT rate_limits_identifier_length CHECK (length(identifier) <= 140),
    CONSTRAINT rate_limits_type_length       CHECK (length(limit_type) <= 32)
);

COMMENT ON TABLE public.rate_limits IS 'Compteurs rate limiting — fenêtre glissante par minute';


-- ── Monitoring blob cleanup ──
CREATE TABLE public.blob_cleanup_log (
    id            BIGSERIAL   PRIMARY KEY,
    cleaned_at    TIMESTAMPTZ DEFAULT now(),
    blobs_deleted INTEGER     DEFAULT 0,
    bytes_freed   BIGINT      DEFAULT 0
);

COMMENT ON TABLE public.blob_cleanup_log IS 'Log du nettoyage automatique des blobs expirés';


-- ============================================================================
-- 3. INDEX
-- ============================================================================

CREATE INDEX idx_messages_tag_created
    ON public.messages (tag, created_at ASC);

CREATE INDEX idx_messages_created_at
    ON public.messages (created_at);

CREATE INDEX idx_call_signals_tag_created
    ON public.call_signals (tag, created_at ASC);

CREATE INDEX idx_rate_limits_window
    ON public.rate_limits (window_start);


-- ============================================================================
-- 4. FONCTIONS INTERNES
-- ============================================================================

-- ── Rate limiter (fenêtre glissante par minute) ──
CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_identifier     TEXT,
    p_limit_type     TEXT,
    p_max_per_minute INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '3s'
AS $$
DECLARE
    v_count  INTEGER;
    v_window TIMESTAMPTZ;
BEGIN
    v_window := date_trunc('minute', now());

    INSERT INTO public.rate_limits (identifier, limit_type, request_count, window_start)
    VALUES (left(p_identifier, 140), left(p_limit_type, 32), 1, v_window)
    ON CONFLICT (identifier, limit_type)
    DO UPDATE SET
        request_count = CASE
            WHEN rate_limits.window_start < v_window THEN 1
            ELSE rate_limits.request_count + 1
        END,
        window_start = CASE
            WHEN rate_limits.window_start < v_window THEN v_window
            ELSE rate_limits.window_start
        END
    RETURNING request_count INTO v_count;

    RETURN v_count <= p_max_per_minute;
END;
$$;

COMMENT ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER)
    IS 'Rate limiter interne — fenêtre glissante par minute. SECURITY DEFINER, pas d''accès direct.';


-- ============================================================================
-- 5. RPCs PUBLIQUES — ÉCRITURE
-- ============================================================================

-- ── Envoyer un message sealed sender ──
CREATE OR REPLACE FUNCTION public.send_sealed_message(
    p_tag            TEXT,
    p_sealed_content TEXT,
    p_version        INTEGER DEFAULT 1
) RETURNS TABLE(id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
BEGIN
    -- Validation
    IF p_tag IS NULL OR length(p_tag) < 8 OR length(p_tag) > 128 THEN
        RAISE EXCEPTION 'Invalid tag';
    END IF;
    IF p_sealed_content IS NULL OR length(p_sealed_content) < 10 THEN
        RAISE EXCEPTION 'Invalid sealed content';
    END IF;

    -- Rate limit: 15 msg/min par tag
    IF NOT check_rate_limit(p_tag, 'send_msg', 15) THEN
        RAISE EXCEPTION 'Rate limit exceeded';
    END IF;

    RETURN QUERY
    INSERT INTO public.messages (tag, sealed_payload)
    VALUES (p_tag, p_sealed_content)
    ON CONFLICT (payload_hash) DO NOTHING  -- Rejet silencieux des replays
    RETURNING messages.id;
END;
$$;

COMMENT ON FUNCTION public.send_sealed_message(TEXT, TEXT, INTEGER)
    IS 'Envoyer un message chiffré sealed sender. Pas de device_id, anonymat total.';


-- ── Envoyer un signal d'appel ──
CREATE OR REPLACE FUNCTION public.send_call_signal(
    p_tag            TEXT,
    p_sealed_payload TEXT
) RETURNS TABLE(id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
BEGIN
    -- Validation
    IF p_tag IS NULL OR length(p_tag) < 8 OR length(p_tag) > 128 THEN
        RAISE EXCEPTION 'Invalid tag';
    END IF;
    IF p_sealed_payload IS NULL OR length(p_sealed_payload) < 10 THEN
        RAISE EXCEPTION 'Invalid payload';
    END IF;

    -- Rate limit: 30 signaux/min par tag
    IF NOT check_rate_limit(p_tag, 'send_sig', 30) THEN
        RAISE EXCEPTION 'Rate limit exceeded';
    END IF;

    RETURN QUERY
    INSERT INTO public.call_signals (tag, sealed_payload)
    VALUES (p_tag, p_sealed_payload)
    RETURNING call_signals.id;
END;
$$;


-- ============================================================================
-- 6. RPCs PUBLIQUES — LECTURE
-- ============================================================================

-- ── Lire les messages par tags ──
-- Rate limiting par tag individuel: chaque tag du tableau est vérifié.
CREATE OR REPLACE FUNCTION public.get_messages_by_tags(
    p_tags  TEXT[],
    p_since TIMESTAMPTZ DEFAULT NULL,
    p_limit INTEGER     DEFAULT 100
) RETURNS TABLE(id UUID, tag TEXT, sealed_payload TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
DECLARE
    i INTEGER;
BEGIN
    IF p_tags IS NULL OR array_length(p_tags, 1) IS NULL THEN
        RETURN;
    END IF;
    IF array_length(p_tags, 1) > 50 THEN
        RAISE EXCEPTION 'Too many tags (max 50)';
    END IF;
    IF p_limit > 500 THEN
        p_limit := 500;
    END IF;

    -- CRITICAL: Trier les tags pour garantir un ordre de verrouillage cohérent.
    -- Sans tri, deux appels concurrents avec ['tagA','tagB'] et ['tagB','tagA']
    -- prennent les locks dans un ordre opposé → DEADLOCK (40P01).
    p_tags := ARRAY(SELECT unnest(p_tags) ORDER BY 1);

    -- Valider et rate-limiter chaque tag individuellement
    FOR i IN 1..array_length(p_tags, 1) LOOP
        IF p_tags[i] IS NULL OR length(p_tags[i]) < 8 OR length(p_tags[i]) > 128 THEN
            RAISE EXCEPTION 'Invalid tag at position %', i;
        END IF;
        IF NOT check_rate_limit(p_tags[i], 'read_msg', 60) THEN
            RAISE EXCEPTION 'Rate limit exceeded';
        END IF;
    END LOOP;

    RETURN QUERY
    SELECT m.id, m.tag, m.sealed_payload, m.created_at
    FROM public.messages m
    WHERE m.tag = ANY(p_tags)
      AND (p_since IS NULL OR m.created_at > p_since)
    ORDER BY m.created_at ASC
    LIMIT p_limit;
END;
$$;


-- ── Lire les signaux d'appel par tags ──
CREATE OR REPLACE FUNCTION public.get_call_signals_by_tags(
    p_tags  TEXT[],
    p_since TIMESTAMPTZ DEFAULT NULL,
    p_limit INTEGER     DEFAULT 100
) RETURNS TABLE(id UUID, tag TEXT, sealed_payload TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
DECLARE
    i INTEGER;
BEGIN
    IF p_tags IS NULL OR array_length(p_tags, 1) IS NULL THEN
        RETURN;
    END IF;
    IF array_length(p_tags, 1) > 50 THEN
        RAISE EXCEPTION 'Too many tags (max 50)';
    END IF;
    IF p_limit > 500 THEN
        p_limit := 500;
    END IF;

    -- CRITICAL: Trier les tags (même raison que get_messages_by_tags — anti-deadlock)
    p_tags := ARRAY(SELECT unnest(p_tags) ORDER BY 1);

    FOR i IN 1..array_length(p_tags, 1) LOOP
        IF p_tags[i] IS NULL OR length(p_tags[i]) < 8 OR length(p_tags[i]) > 128 THEN
            RAISE EXCEPTION 'Invalid tag at position %', i;
        END IF;
        IF NOT check_rate_limit(p_tags[i], 'read_sig', 60) THEN
            RAISE EXCEPTION 'Rate limit exceeded';
        END IF;
    END LOOP;

    RETURN QUERY
    SELECT s.id, s.tag, s.sealed_payload, s.created_at
    FROM public.call_signals s
    WHERE s.tag = ANY(p_tags)
      AND (p_since IS NULL OR s.created_at > p_since)
    ORDER BY s.created_at ASC
    LIMIT p_limit;
END;
$$;


-- ============================================================================
-- 7. MAINTENANCE
-- ============================================================================

-- ── Cleanup messages/signaux/rate_limits (cron toutes les 15min) ──
CREATE OR REPLACE FUNCTION public.cleanup_old_data(
    p_messages_days INTEGER DEFAULT 2,
    p_signals_days  INTEGER DEFAULT 1
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
    deleted_messages INTEGER;
    deleted_signals  INTEGER;
    deleted_rates    INTEGER;
BEGIN
    -- Messages > 48h
    WITH d AS (
        DELETE FROM public.messages
        WHERE created_at < now() - (p_messages_days || ' days')::INTERVAL
        RETURNING 1
    ) SELECT count(*) INTO deleted_messages FROM d;

    -- Signaux > 24h
    WITH d AS (
        DELETE FROM public.call_signals
        WHERE created_at < now() - (p_signals_days || ' days')::INTERVAL
        RETURNING 1
    ) SELECT count(*) INTO deleted_signals FROM d;

    -- Rate limits > 5min (fenêtres expirées)
    WITH d AS (
        DELETE FROM public.rate_limits
        WHERE window_start < now() - INTERVAL '5 minutes'
        RETURNING 1
    ) SELECT count(*) INTO deleted_rates FROM d;

    RETURN json_build_object(
        'deleted_messages',    deleted_messages,
        'deleted_signals',     deleted_signals,
        'deleted_rate_limits', deleted_rates,
        'executed_at',         now()
    );
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER)
    IS 'TTL cleanup: 48h messages, 24h signaux, 5min rate limits. Cron: */15 * * * *';


-- ── Cleanup blobs expirés (cron toutes les 6h) ──
-- Supabase protège storage.objects via un trigger (protect_delete) appartenant
-- à supabase_storage_admin. On assume ce rôle temporairement pour supprimer.
CREATE OR REPLACE FUNCTION public.cleanup_expired_blobs()
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, storage
SET statement_timeout = '60s'
AS $$
DECLARE
    v_count INTEGER := 0;
    v_bytes BIGINT := 0;
    v_name  TEXT;
BEGIN
    -- Compter les blobs expirés
    SELECT count(*), coalesce(sum((metadata->>'size')::bigint), 0)
    INTO v_count, v_bytes
    FROM storage.objects
    WHERE bucket_id = 'ghostr-blobs'
      AND created_at < now() - INTERVAL '48 hours';

    IF v_count > 0 THEN
        -- Supprimer via le rôle storage admin (propriétaire du trigger)
        SET LOCAL ROLE supabase_storage_admin;

        DELETE FROM storage.objects
        WHERE bucket_id = 'ghostr-blobs'
          AND created_at < now() - INTERVAL '48 hours';

        RESET ROLE;

        INSERT INTO public.blob_cleanup_log (blobs_deleted, bytes_freed)
        VALUES (v_count, v_bytes);
    END IF;

    RETURN json_build_object(
        'blobs_deleted', v_count,
        'bytes_freed',   v_bytes,
        'executed_at',   now()
    );
EXCEPTION WHEN OTHERS THEN
    -- Toujours restaurer le rôle en cas d'erreur
    RESET ROLE;
    RETURN json_build_object(
        'blobs_deleted', 0,
        'error',         SQLERRM,
        'executed_at',   now()
    );
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_blobs()
    IS 'Supprime les blobs chiffrés > 48h du bucket ghostr-blobs. Cron: 0 */6 * * *';


-- ============================================================================
-- 8. STORAGE — BUCKETS
-- ============================================================================

-- ── ghostr-blobs: Médias chiffrés E2E (v26.0) ──
-- Blobs opaques: chiffrés XSalsa20-Poly1305, paddés à tiers fixes,
-- UUID aléatoire, upload/download via relay CF.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'ghostr-blobs',
    'ghostr-blobs',
    false,                               -- Pas public: download via auth anon key
    20971520,                            -- 20 MB max (tier max padded = 16MB)
    ARRAY['application/octet-stream']    -- Blobs binaires uniquement
)
ON CONFLICT (id) DO UPDATE SET
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── whisper-media: Legacy médias serveur ──
-- Utilisé par mediaService.ts et voiceMessageService.ts pour les médias
-- chiffrés uploadés via l'ancien système.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'whisper-media',
    'whisper-media',
    false,
    20971520,                            -- 20 MB max
    ARRAY['application/octet-stream']    -- Blobs chiffrés uniquement
)
ON CONFLICT (id) DO UPDATE SET
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ============================================================================
-- 9. STORAGE — POLICIES
-- ============================================================================

-- ── ghostr-blobs ──

-- Upload: tout client avec anon key peut uploader
CREATE POLICY "ghostr_blobs_upload"
    ON storage.objects FOR INSERT
    TO anon, authenticated
    WITH CHECK (
        bucket_id = 'ghostr-blobs'
        AND name ~ '^[A-Za-z0-9_-]+\.bin$'
    );

-- Download: tout client avec anon key + blobId peut télécharger
CREATE POLICY "ghostr_blobs_download"
    ON storage.objects FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'ghostr-blobs');

-- Delete: cleanup client best-effort
CREATE POLICY "ghostr_blobs_delete"
    ON storage.objects FOR DELETE
    TO anon, authenticated
    USING (bucket_id = 'ghostr-blobs');


-- ── whisper-media ──

CREATE POLICY "whisper_media_upload"
    ON storage.objects FOR INSERT
    TO anon, authenticated
    WITH CHECK (bucket_id = 'whisper-media');

CREATE POLICY "whisper_media_download"
    ON storage.objects FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'whisper-media');

CREATE POLICY "whisper_media_delete"
    ON storage.objects FOR DELETE
    TO anon, authenticated
    USING (bucket_id = 'whisper-media');


-- ============================================================================
-- 10. ROW LEVEL SECURITY — DENY ALL DIRECT ACCESS
-- ============================================================================

ALTER TABLE public.messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blob_cleanup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_deny_direct
    ON public.messages
    TO anon, authenticated
    USING (false) WITH CHECK (false);

CREATE POLICY call_signals_deny_direct
    ON public.call_signals
    TO anon, authenticated
    USING (false) WITH CHECK (false);

CREATE POLICY rate_limits_deny_direct
    ON public.rate_limits
    TO anon, authenticated
    USING (false) WITH CHECK (false);

CREATE POLICY blob_cleanup_log_deny_direct
    ON public.blob_cleanup_log
    TO anon, authenticated
    USING (false) WITH CHECK (false);


-- ============================================================================
-- 11. PERMISSIONS — LEAST PRIVILEGE
-- ============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Tables: aucun accès direct pour anon/authenticated
REVOKE ALL ON public.messages          FROM anon, authenticated;
REVOKE ALL ON public.call_signals      FROM anon, authenticated;
REVOKE ALL ON public.rate_limits       FROM anon, authenticated;
REVOKE ALL ON public.blob_cleanup_log  FROM anon, authenticated;

GRANT ALL ON public.messages          TO service_role;
GRANT ALL ON public.call_signals      TO service_role;
GRANT ALL ON public.rate_limits       TO service_role;
GRANT ALL ON public.blob_cleanup_log  TO service_role;

-- Séquence
GRANT USAGE, SELECT ON SEQUENCE public.blob_cleanup_log_id_seq TO service_role;

-- RPCs publiques: accessibles par anon/authenticated
GRANT EXECUTE ON FUNCTION public.send_sealed_message(TEXT, TEXT, INTEGER)               TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_messages_by_tags(TEXT[], TIMESTAMPTZ, INTEGER)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_call_signal(TEXT, TEXT)                           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_signals_by_tags(TEXT[], TIMESTAMPTZ, INTEGER) TO anon, authenticated;

-- RPCs internes: service_role uniquement
-- check_rate_limit est appelé depuis les SECURITY DEFINER RPCs (qui tournent
-- en tant que postgres owner) donc n'a pas besoin d'être accessible par anon.
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER)   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_blobs()              FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER) TO service_role;
GRANT  EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER)   TO service_role;
GRANT  EXECUTE ON FUNCTION public.cleanup_expired_blobs()              TO service_role;

-- Verrouiller les DEFAULT PRIVILEGES Supabase
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM anon, authenticated;


-- ============================================================================
-- 12. CRON JOBS (pg_cron)
-- ============================================================================
-- pg_cron doit être activé dans: Dashboard → Database → Extensions → pg_cron
-- Si pas activé, ces blocs échouent silencieusement avec un NOTICE.

DO $cron_block_1$
BEGIN
    PERFORM cron.schedule(
        'cleanup-ghostr',
        '*/15 * * * *',
        'SELECT public.cleanup_old_data()'
    );
    RAISE NOTICE 'pg_cron: cleanup-ghostr scheduled (every 15min)';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron: extension not available. Activate it in Dashboard, then run:';
    RAISE NOTICE '  SELECT cron.schedule(''cleanup-ghostr'', ''*/15 * * * *'', ''SELECT public.cleanup_old_data()'');';
END $cron_block_1$;

DO $cron_block_2$
BEGIN
    PERFORM cron.schedule(
        'cleanup-ghostr-blobs',
        '0 */6 * * *',
        'SELECT public.cleanup_expired_blobs()'
    );
    RAISE NOTICE 'pg_cron: cleanup-ghostr-blobs scheduled (every 6h)';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron: extension not available. Activate it in Dashboard, then run:';
    RAISE NOTICE '  SELECT cron.schedule(''cleanup-ghostr-blobs'', ''0 */6 * * *'', ''SELECT public.cleanup_expired_blobs()'');';
END $cron_block_2$;


-- ============================================================================
-- 13. INDEX STORAGE (après création du bucket)
-- ============================================================================
-- Accélère le cleanup DELETE WHERE created_at < NOW() - 48h

DO $$
BEGIN
    CREATE INDEX IF NOT EXISTS idx_ghostr_blobs_created_at
        ON storage.objects (created_at)
        WHERE bucket_id = 'ghostr-blobs';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Could not create index on storage.objects (owned by supabase_storage_admin). Cleanup will still work, just slower on large datasets.';
END $$;


-- ============================================================================
-- 14. VÉRIFICATION FINALE
-- ============================================================================

DO $$
DECLARE
    v_tables    INTEGER;
    v_functions INTEGER;
    v_buckets   INTEGER;
    v_policies  INTEGER;
    v_indexes   INTEGER;
BEGIN
    SELECT count(*) INTO v_tables
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('messages', 'call_signals', 'rate_limits', 'blob_cleanup_log');

    SELECT count(*) INTO v_functions
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'send_sealed_message', 'get_messages_by_tags',
        'send_call_signal', 'get_call_signals_by_tags',
        'check_rate_limit', 'cleanup_old_data', 'cleanup_expired_blobs'
      );

    SELECT count(*) INTO v_buckets
    FROM storage.buckets
    WHERE id IN ('ghostr-blobs', 'whisper-media');

    SELECT count(*) INTO v_policies
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (policyname LIKE 'ghostr_%' OR policyname LIKE 'whisper_%');

    SELECT count(*) INTO v_indexes
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('messages', 'call_signals', 'rate_limits');

    RAISE NOTICE '';
    RAISE NOTICE '════════════════════════════════════════════════';
    RAISE NOTICE '  GHOSTR SCHEMA v26.0 — DEPLOYMENT COMPLETE';
    RAISE NOTICE '════════════════════════════════════════════════';
    RAISE NOTICE '  Tables:             % / 4 expected', v_tables;
    RAISE NOTICE '  Functions (RPCs):   % / 7 expected', v_functions;
    RAISE NOTICE '  Storage buckets:    % / 2 expected', v_buckets;
    RAISE NOTICE '  Storage policies:   % / 6 expected', v_policies;
    RAISE NOTICE '  Public indexes:     % / 4 expected', v_indexes;
    RAISE NOTICE '════════════════════════════════════════════════';

    IF v_tables    = 4 AND v_functions = 7 AND v_buckets = 2 AND v_policies >= 6 THEN
        RAISE NOTICE '  ✅ ALL CHECKS PASSED';
    ELSE
        RAISE WARNING '  ⚠️  SOME CHECKS FAILED — review above counts';
    END IF;
    RAISE NOTICE '';
END $$;


-- ============================================================================
-- QUERIES UTILES (monitoring)
-- ============================================================================
--
-- Messages actifs:
--   SELECT count(*), min(created_at), max(created_at) FROM messages;
--
-- Blobs actifs:
--   SELECT count(*), pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0))
--   FROM storage.objects WHERE bucket_id = 'ghostr-blobs';
--
-- Dernier cleanup:
--   SELECT * FROM blob_cleanup_log ORDER BY cleaned_at DESC LIMIT 5;
--
-- Rate limits actifs:
--   SELECT * FROM rate_limits ORDER BY window_start DESC LIMIT 20;
--
-- Tester les RPCs:
--   SELECT * FROM send_sealed_message('test12345678', repeat('x', 100));
--   SELECT * FROM get_messages_by_tags(ARRAY['test12345678']);
--
-- Cleanup manuel:
--   SELECT cleanup_old_data();
--   SELECT cleanup_expired_blobs();
--
-- Cron jobs actifs (si pg_cron):
--   SELECT * FROM cron.job;
-- ============================================================================
