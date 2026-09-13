-- ============================================================================
-- GHOSTR — MIGRATION DELTA : REPORTS (Guideline App Store 1.2)
-- ============================================================================
--
-- À exécuter UNE FOIS dans le SQL Editor de Supabase Dashboard pour ajouter
-- la table `reports` et la RPC `submit_report` SANS détruire les données
-- existantes.
--
-- POURQUOI CETTE TABLE EXISTE :
--   Apple (guideline 1.2) exige que le blocage/signalement « notify the
--   developer of the inappropriate content » et qu'une action soit prise
--   sous 24h. Le serveur ne pouvant PAS lire les messages (E2EE, sealed
--   sender), le signalement est un acte VOLONTAIRE du destinataire : le
--   contenu arrive ici uniquement parce que le signaleur a choisi de le
--   transmettre, via le tunnel OHTTP (pas d'IP).
--
-- MODÉRATION (engagement 24h) :
--   Consulter :   SELECT * FROM public.reports WHERE handled = false
--                 ORDER BY created_at;
--   Traiter :     UPDATE public.reports SET handled = true, handled_at = now()
--                 WHERE id = '<uuid>';
--
-- Si tu fais un reset complet via le `schema.sql` (qui contient déjà ces
-- définitions), tu n'as PAS besoin d'exécuter ce delta.
--
-- Idempotent : peut être ré-exécuté sans dommage.
-- ============================================================================

-- ── 1. Table ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reports (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    category      TEXT        NOT NULL,
    content       TEXT        NOT NULL,
    context       TEXT        NOT NULL DEFAULT 'message',
    reporter_tag  TEXT,
    handled       BOOLEAN     NOT NULL DEFAULT false,
    handled_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Aligné avec ReportCategory / ReportContext (src/services/reportService.ts)
    CONSTRAINT reports_category_valid CHECK (
        category IN ('spam', 'harassment', 'illegal', 'other')
    ),
    CONSTRAINT reports_context_valid CHECK (
        context IN ('message', 'contact')
    ),
    CONSTRAINT reports_content_size CHECK (
        length(content) BETWEEN 1 AND 4000
    ),
    CONSTRAINT reports_reporter_tag_size CHECK (
        reporter_tag IS NULL OR length(reporter_tag) <= 64
    )
);

COMMENT ON TABLE public.reports IS
    'Signalements volontaires (guideline 1.2). Contenu transmis par le signaleur, jamais lu par le serveur. Modération manuelle sous 24h.';
COMMENT ON COLUMN public.reports.reporter_tag IS
    'Tag aléatoire local du signaleur — sert uniquement au rate-limit, aucun lien avec son identité.';

CREATE INDEX IF NOT EXISTS idx_reports_unhandled
    ON public.reports (created_at) WHERE handled = false;


-- ── 2. RLS deny-all ────────────────────────────────────────────────────────
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reports_deny_direct ON public.reports;
CREATE POLICY reports_deny_direct
    ON public.reports
    TO anon, authenticated
    USING (false) WITH CHECK (false);


-- ── 3. Permissions ─────────────────────────────────────────────────────────
REVOKE ALL ON public.reports FROM anon, authenticated;
GRANT  ALL ON public.reports TO service_role;


-- ── 4. RPC publique d'écriture ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_report(
    p_category     TEXT,
    p_content      TEXT,
    p_context      TEXT DEFAULT 'message',
    p_reporter_tag TEXT DEFAULT NULL
) RETURNS TABLE(id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
BEGIN
    -- Validation
    IF p_category IS NULL OR p_category NOT IN ('spam', 'harassment', 'illegal', 'other') THEN
        RAISE EXCEPTION 'Invalid category';
    END IF;
    IF p_context IS NULL OR p_context NOT IN ('message', 'contact') THEN
        RAISE EXCEPTION 'Invalid context';
    END IF;
    IF p_content IS NULL OR length(p_content) < 1 OR length(p_content) > 4000 THEN
        RAISE EXCEPTION 'Invalid content';
    END IF;

    -- Rate limit: 5 signalements/min par reporter_tag (anti-spam de reports)
    IF p_reporter_tag IS NOT NULL AND length(p_reporter_tag) BETWEEN 8 AND 64 THEN
        IF NOT check_rate_limit(p_reporter_tag, 'report', 5) THEN
            RAISE EXCEPTION 'Rate limit exceeded';
        END IF;
    END IF;

    RETURN QUERY
    INSERT INTO public.reports (category, content, context, reporter_tag)
    VALUES (p_category, p_content, p_context, left(p_reporter_tag, 64))
    RETURNING reports.id;
END;
$$;

COMMENT ON FUNCTION public.submit_report(TEXT, TEXT, TEXT, TEXT)
    IS 'Guideline 1.2 : dépôt d''un signalement volontaire par le destinataire. Rate-limité par reporter_tag.';

GRANT EXECUTE ON FUNCTION public.submit_report(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;


-- ── 5. Vérification ────────────────────────────────────────────────────────
DO $$
DECLARE
    v_table_exists BOOLEAN;
    v_func_exists  BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'reports'
    ) INTO v_table_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.routines
        WHERE routine_schema = 'public' AND routine_name = 'submit_report'
    ) INTO v_func_exists;

    IF v_table_exists AND v_func_exists THEN
        RAISE NOTICE '✅ reports delta applied successfully.';
    ELSE
        RAISE WARNING '❌ Delta incomplete — table=% function=%', v_table_exists, v_func_exists;
    END IF;
END $$;
