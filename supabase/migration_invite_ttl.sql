-- ============================================================================
-- GHOSTR — MIGRATION DELTA : TTL DIFFÉRENCIÉ HANDSHAKE / TRAFIC
-- ============================================================================
--
-- À exécuter dans le SQL Editor de Supabase Dashboard.
--
-- LE PROBLÈME :
--   Le bundle d'invitation PQXDH est uploadé sur le serveur (le QR ne contient
--   QUE le tag, cf. sessionService.createInvite / fetchInviteFromServer) : il
--   vit dans `messages`, purgée par `cleanup_old_data`. La durée de vie RÉELLE
--   d'une invitation est donc ce TTL serveur — 48h. Or le client annonce
--   30 jours (pendingInvites.DEFAULT_EXPIRY_MS) : il ment pendant 28 jours.
--   C'est la cause du rejet Apple 2.1(a) du 4 juin 2026.
--
--   Allonger `p_messages_days` à 30 jours corrigerait l'affichage, mais ce
--   paramètre gouverne TOUTE la table : il n'existe aucune suppression après
--   lecture (get_messages_by_tags est un SELECT pur), et les decoys écrivent
--   une ligne de ~17 KB toutes les ~90s par client actif. On multiplierait la
--   rétention de tout le trafic par 15.
--
-- LA SOLUTION :
--   Séparer les deux durées. Le gateway dé-scelle l'enveloppe sealed sender
--   avant de transmettre à Supabase (ohttp-gateway/server.js:1435 →
--   `p_sealed_content: inner.innerPayload`), donc `sealed_payload` est du JSON
--   dont le champ `type` est lisible côté serveur. Le CONTENU reste chiffré
--   E2EE — seul le type d'enveloppe est visible, et il l'était déjà.
--
--     • handshake (ghostr_invite_pq + ghostr_accept_pq) → 30 jours
--     • trafic de conversation (messages réels + decoys) → 48h
--
--   Les accepts DOIVENT suivre les invitations : sans ça, quelqu'un scanne une
--   invitation de 20 jours, envoie son accept, et si l'émetteur n'ouvre pas
--   l'app sous 48h l'accept est purgé — le joiner croit la connexion établie,
--   l'émetteur ne voit rien, et l'OTPK a été consommée.
--
--   `invite_ttl_exempt` reste disponible pour une invitation de démo qui doit
--   survivre au-delà de 30 jours (App Review). Table vide = aucun effet.
--
-- ⚠️ EFFET IMMÉDIAT : au prochain passage du cron (≤ 15 min), tout le trafic
--    de plus de 48h et tout handshake de plus de 30 jours est supprimé d'un
--    coup.
--
-- Idempotent : peut être ré-exécuté sans dommage.
-- ============================================================================


-- ── 1. Table d'exemption ───────────────────────────────────────────────────
-- Un tag listé ici échappe à TOUTE purge. Usage prévu : le tag de
-- l'invitation de démo fournie à App Review. Invisible pour les utilisateurs.
CREATE TABLE IF NOT EXISTS public.invite_ttl_exempt (
    tag        TEXT        PRIMARY KEY,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Même contrainte que public.messages.tag
    CONSTRAINT invite_ttl_exempt_tag_length CHECK (length(tag) BETWEEN 8 AND 128)
);

COMMENT ON TABLE public.invite_ttl_exempt IS
    'Tags exemptés de toute purge TTL (invitation de démo App Review). À vider après approbation.';
COMMENT ON COLUMN public.invite_ttl_exempt.note IS
    'Pourquoi ce tag est exempté (ex. « demo App Review 1.0.1 ») — pour pouvoir nettoyer plus tard.';

ALTER TABLE public.invite_ttl_exempt ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invite_ttl_exempt_deny_direct ON public.invite_ttl_exempt;
CREATE POLICY invite_ttl_exempt_deny_direct
    ON public.invite_ttl_exempt
    TO anon, authenticated
    USING (false) WITH CHECK (false);

REVOKE ALL ON public.invite_ttl_exempt FROM anon, authenticated;
GRANT  ALL ON public.invite_ttl_exempt TO service_role;


-- ── 2. Prédicat « ceci est un handshake » ──────────────────────────────────
-- LIKE et non `::jsonb->>'type'` DÉLIBÉRÉMENT : une seule ligne au JSON
-- malformé ferait échouer le cast, donc la purge entière, donc la table
-- grossirait sans limite — en silence. Un LIKE ne peut pas échouer.
-- Pas de faux positif possible : les champs `data` et `_p` n'utilisent que
-- l'alphabet base64 (sealedSender.ts:728), sans guillemet ni deux-points.
CREATE OR REPLACE FUNCTION public.is_handshake_payload(p_payload TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT p_payload LIKE '%"type":"ghostr_invite_pq"%'
        OR p_payload LIKE '%"type":"ghostr_accept_pq"%';
$$;

COMMENT ON FUNCTION public.is_handshake_payload(TEXT) IS
    'Vrai si le payload est un bundle d''invitation ou un accusé d''acceptation (TTL long). Le contenu reste chiffré E2EE — seul le type d''enveloppe est lu.';


-- ── 3. cleanup_old_data — deux TTL au lieu d'un ────────────────────────────
-- On DROP toutes les surcharges existantes avant de recréer : la signature
-- change (3 paramètres), et un simple CREATE OR REPLACE créerait une
-- SURCHARGE de plus — l'appel sans argument deviendrait ambigu.
DO $drop_overloads$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure::text AS sig
        FROM   pg_proc p
        JOIN   pg_namespace n ON n.oid = p.pronamespace
        WHERE  n.nspname = 'public' AND p.proname = 'cleanup_old_data'
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
        RAISE NOTICE 'Dropped %', r.sig;
    END LOOP;
END $drop_overloads$;

CREATE FUNCTION public.cleanup_old_data(
    p_messages_days  INTEGER DEFAULT 2,
    p_signals_days   INTEGER DEFAULT 1,
    p_handshake_days INTEGER DEFAULT 30
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
    deleted_messages   INTEGER;
    deleted_handshakes INTEGER;
    deleted_signals    INTEGER;
    deleted_rates      INTEGER;
BEGIN
    -- Handshake > 30j (hors tags exemptés).
    -- Volume négligeable : une invitation + un accept par connexion. Ces
    -- lignes restent candidates à chaque passage du cron tant qu'elles
    -- vivent ; c'est le prix du TTL long, et il est borné par ce volume.
    WITH d AS (
        DELETE FROM public.messages m
        WHERE m.created_at < now() - (p_handshake_days || ' days')::INTERVAL
          AND public.is_handshake_payload(m.sealed_payload)
          AND NOT EXISTS (
              SELECT 1 FROM public.invite_ttl_exempt e WHERE e.tag = m.tag
          )
        RETURNING 1
    ) SELECT count(*) INTO deleted_handshakes FROM d;

    -- Trafic de conversation (messages réels ET decoys) > 48h.
    WITH d AS (
        DELETE FROM public.messages m
        WHERE m.created_at < now() - (p_messages_days || ' days')::INTERVAL
          AND NOT public.is_handshake_payload(m.sealed_payload)
          AND NOT EXISTS (
              SELECT 1 FROM public.invite_ttl_exempt e WHERE e.tag = m.tag
          )
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
        WHERE window_start < now() - INTERVAL '2 minutes'  -- R-09: sliding window 60s + marge 60s
        RETURNING 1
    ) SELECT count(*) INTO deleted_rates FROM d;

    RETURN json_build_object(
        'deleted_messages',    deleted_messages,
        'deleted_handshakes',  deleted_handshakes,
        'deleted_signals',     deleted_signals,
        'deleted_rate_limits', deleted_rates,
        'executed_at',         now()
    );
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER)
    IS 'TTL cleanup: 48h trafic, 30j handshake (hors invite_ttl_exempt), 24h signaux, 5min rate limits. Cron: */15 * * * *';


-- ── 4. Grants (le DROP les avait effacés) ──────────────────────────────────
-- ⚠️ Le REVOKE sur PUBLIC est INDISPENSABLE : `CREATE FUNCTION` accorde
-- EXECUTE à PUBLIC par défaut, et un REVOKE ciblé sur anon/authenticated ne
-- le retire pas (le droit passe par PUBLIC). Sans lui, n'importe quel porteur
-- de la clé anon pourrait appeler cleanup_old_data(0, 0, 0) → purge totale.
-- Vérifier après coup que proacl ne contient PAS d'entrée « =X/ » :
--   SELECT proacl FROM pg_proc WHERE proname = 'cleanup_old_data';
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_handshake_payload(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_handshake_payload(TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_handshake_payload(TEXT) TO service_role;


-- ── 5. Job cron — supprimer tout job non canonique, replanter le bon ───────
-- Indispensable : si un TTL rallongé vit dans la COMMANDE du job (ex.
-- 'SELECT public.cleanup_old_data(30)'), réécrire la fonction ne suffit pas,
-- l'argument explicite l'emporte sur le DEFAULT.
DO $cron_fix$
DECLARE
    j RECORD;
BEGIN
    FOR j IN
        SELECT jobid, jobname, command
        FROM   cron.job
        WHERE  command ILIKE '%cleanup_old_data%'
    LOOP
        PERFORM cron.unschedule(j.jobid);
        RAISE NOTICE 'Unscheduled job % (%): %', j.jobid, j.jobname, j.command;
    END LOOP;

    PERFORM cron.schedule(
        'cleanup-ghostr',
        '*/15 * * * *',
        'SELECT public.cleanup_old_data()'
    );
    RAISE NOTICE 'pg_cron: cleanup-ghostr replanté (toutes les 15min, sans argument → 48h / 30j)';
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pg_cron indisponible ou erreur: %. Replanter à la main:', SQLERRM;
    RAISE WARNING '  SELECT cron.schedule(''cleanup-ghostr'', ''*/15 * * * *'', ''SELECT public.cleanup_old_data()'');';
END $cron_fix$;


-- ── 6. Vérification ───────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_default TEXT;
    v_jobs    INTEGER;
    v_cmd     TEXT;
BEGIN
    SELECT pg_get_expr(p.proargdefaults, 0) INTO v_default
    FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public' AND p.proname = 'cleanup_old_data';

    SELECT count(*), min(command) INTO v_jobs, v_cmd
    FROM   cron.job WHERE command ILIKE '%cleanup_old_data%';

    RAISE NOTICE '--- Vérification ---';
    RAISE NOTICE 'DEFAULTs de cleanup_old_data : %  (attendu: 2, 1, 30)', v_default;
    RAISE NOTICE 'Jobs cron cleanup_old_data   : %  (attendu: 1)', v_jobs;
    RAISE NOTICE 'Commande du job              : %  (attendu: sans argument)', v_cmd;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Vérification partielle (pg_cron ?): %', SQLERRM;
END $verify$;


-- ============================================================================
-- MODE D'EMPLOI — invitation de démo pour une soumission App Review
-- ============================================================================
--
--   Avec le TTL handshake à 30 jours, une invitation générée le jour de la
--   soumission survit largement à la review : l'exemption n'est utile que
--   pour une invitation permanente (ré-soumissions successives).
--
--   1. Générer l'invitation dans l'app, récupérer le lien partagé.
--      Le tag est dans le lien : https://theghostr.com/i#<base64>
--      → base64 décodé = {"v":2,"t":"<TAG>","n":"<nom>"}
--
--   2. Exempter ce tag (optionnel) :
--        INSERT INTO public.invite_ttl_exempt (tag, note)
--        VALUES ('<TAG>', 'demo App Review <version>')
--        ON CONFLICT (tag) DO NOTHING;
--
--   3. Après approbation, refermer la porte :
--        DELETE FROM public.invite_ttl_exempt WHERE tag = '<TAG>';
--
--   Contrôle : SELECT * FROM public.invite_ttl_exempt;
-- ============================================================================
