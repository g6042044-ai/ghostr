-- ============================================================================
-- GHOSTR — MIGRATION DELTA : APP_NOTICE (kill-switch)
-- ============================================================================
--
-- À exécuter UNE FOIS dans le SQL Editor de Supabase Dashboard pour ajouter
-- la table `app_notice` et la RPC `get_app_notice` SANS détruire les données
-- existantes (messages, call_signals, etc.).
--
-- Si tu fais un reset complet via le `schema.sql` v26.1 (qui contient déjà
-- ces définitions), tu n'as PAS besoin d'exécuter ce delta — le reset les
-- crée automatiquement.
--
-- Idempotent : peut être ré-exécuté sans dommage.
-- ============================================================================

-- ── 1. Table singleton ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_notice (
    id              SMALLINT    PRIMARY KEY DEFAULT 1,
    signed_payload  TEXT,
    updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL,

    CONSTRAINT app_notice_singleton CHECK (id = 1),
    CONSTRAINT app_notice_size      CHECK (
        signed_payload IS NULL
        OR length(signed_payload) BETWEEN 64 AND 8192
    )
);

INSERT INTO public.app_notice (id, signed_payload) VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.app_notice IS
    'Singleton — avis de dépréciation signé Ed25519. NULL = pas d''avis.';
COMMENT ON COLUMN public.app_notice.signed_payload IS
    'Format: base64(canonical_json).base64(ed25519_sig). Clé pub côté client.';


-- ── 2. RLS deny-all ────────────────────────────────────────────────────────
ALTER TABLE public.app_notice ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_notice_deny_direct ON public.app_notice;
CREATE POLICY app_notice_deny_direct
    ON public.app_notice
    TO anon, authenticated
    USING (false) WITH CHECK (false);


-- ── 3. Permissions ─────────────────────────────────────────────────────────
REVOKE ALL ON public.app_notice FROM anon, authenticated;
GRANT  ALL ON public.app_notice TO service_role;


-- ── 4. RPC publique de lecture ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_app_notice()
RETURNS TABLE (signed_payload TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT signed_payload FROM public.app_notice WHERE id = 1 LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_app_notice() IS
    'Retourne le payload Ed25519-signé de l''avis courant (ou NULL). Vérif client.';

GRANT EXECUTE ON FUNCTION public.get_app_notice() TO anon, authenticated;


-- ── 5. Vérification ────────────────────────────────────────────────────────
DO $$
DECLARE
    v_table_exists BOOLEAN;
    v_func_exists  BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'app_notice'
    ) INTO v_table_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.routines
        WHERE routine_schema = 'public' AND routine_name = 'get_app_notice'
    ) INTO v_func_exists;

    IF v_table_exists AND v_func_exists THEN
        RAISE NOTICE '✅ app_notice delta applied successfully.';
    ELSE
        RAISE WARNING '❌ Delta incomplete — table=% function=%', v_table_exists, v_func_exists;
    END IF;
END $$;


-- ============================================================================
-- USAGE
-- ============================================================================
--
-- Activer un avis (depuis ta machine, sortie de scripts/sign-notice.js) :
--   UPDATE public.app_notice
--   SET signed_payload = 'eyJ2IjoxLC...ABC.XYZ_signature_base64',
--       updated_at = now()
--   WHERE id = 1;
--
-- Désactiver l'avis (révoque l'affichage côté clients dès le prochain fetch) :
--   UPDATE public.app_notice
--   SET signed_payload = NULL,
--       updated_at = now()
--   WHERE id = 1;
--
-- Tester la RPC :
--   SELECT * FROM public.get_app_notice();
-- ============================================================================
