-- ============================================================================
-- GHOSTR — MIGRATION DELTA : FERMER LES FONCTIONS INTERNES À anon
-- ============================================================================
--
-- À exécuter dans le SQL Editor de Supabase Dashboard, fichier ENTIER, en une
-- fois. Idempotente. Tout se fait dans une seule transaction (BEGIN … COMMIT) :
-- au moindre contrôle en échec, RIEN n'est appliqué.
--
-- Conçue et testée contre l'inventaire RÉEL de production du 2026-10-23
-- (PostgreSQL 17.6), rejoué sur une réplique supabase/postgres:17.6.1.178 aux
-- droits identiques. Le dépôt ne décrit pas fidèlement la production : la
-- migration ne suppose donc ni signature exacte, ni présence des fonctions
-- facultatives.
--
-- LE PROBLÈME (constaté en production) :
--   L'URL Supabase et la clé anon sont embarquées dans l'app : n'importe qui
--   peut appeler l'API REST PostgREST directement, sans passer par le gateway.
--   Ces fonctions internes sont exécutables par anon :
--
--     • cleanup_expired_blobs()      — via PUBLIC. Scan + DELETE sur
--       storage.objects (60 s de budget) : levier de charge gratuit.
--     • check_rate_limit(...)        — via PUBLIC. Gonfle rate_limits de
--       lignes arbitraires et incrémente n'importe quel compteur.
--     • cleanup_stale_push_tokens()  — via PUBLIC.
--     • lookup_push_token(tag)       — via PUBLIC et anon : lit le jeton push
--       chiffré associé à un tag.
--     • register_push_token(...)     — via PUBLIC et anon : écrase le jeton
--       d'un tag.
--     • unregister_push_token(tag)   — via PUBLIC et anon : supprime le jeton
--       d'un tag.
--
--   Les quatre fonctions push sont des vestiges (avril 2026) créés à la main,
--   absents de tout fichier SQL du dépôt. Aucune version de l'app ne les
--   appelle (vérifié sur 792ff5a6 = build publié et sur 32d8dea3), et le
--   gateway les rejette (absentes de son ALLOWED_RPCS). Les fermer est sans
--   effet sur l'app.
--
--   Cause : `CREATE FUNCTION` accorde EXECUTE à PUBLIC par défaut, et anon est
--   membre de PUBLIC. En production, les privilèges par défaut du schéma public
--   retirent déjà anon/authenticated (entrée postgres/public/f), mais RIEN ne
--   retire PUBLIC : toute fonction créée naît encore ouverte via PUBLIC.
--
-- CE QUE FAIT LA MIGRATION :
--   1. Ferme à PUBLIC, anon et authenticated les fonctions internes listées,
--      QUELLE QUE SOIT leur signature (cleanup_old_data a 2 paramètres en
--      production, 3 dans schema.sql). Les fonctions facultatives absentes
--      sont ignorées.
--   2. Tarit la source : privilèges par défaut du rôle postgres.
--      - global  : REVOKE EXECUTE FROM PUBLIC (manquant en production) ;
--      - public  : REVOKE EXECUTE FROM anon, authenticated (déjà présent en
--        production, rejoué pour qu'une base neuve soit couverte aussi).
--      Les DEUX sont nécessaires sur Supabase : la première ferme PUBLIC, la
--      seconde annule le GRANT à anon que Supabase pose sur le schéma public.
--   3. Contrôles BLOQUANTS, en termes de ce qu'anon PEUT faire
--      (has_function_privilege), pas d'interprétation des ACL :
--      a. aucune fonction interne n'est exécutable par anon / authenticated ;
--      b. une fonction-sonde créée après coup naît fermée à anon (test réel
--         des privilèges par défaut), puis est supprimée ;
--      c. les six RPC publiques restent exécutables par anon ;
--      d. essai RÉEL en tant qu'anon, annulé ensuite : get_app_notice et
--         get_messages_by_tags répondent (cette dernière appelle
--         check_rate_limit en interne : prouve que la fermeture ne casse pas
--         la chaîne SECURITY DEFINER), et un appel direct à check_rate_limit
--         est refusé ;
--      e. aucun droit n'a disparu en dehors de ceux visés.
--
-- CE QUI N'EST PAS TOUCHÉ :
--   Les six RPC publiques (send_sealed_message, get_messages_by_tags,
--   send_call_signal, get_call_signals_by_tags, get_app_notice,
--   submit_report) : droits inchangés. Aucune donnée n'est lue ni modifiée.
--
-- NOTE D'HONNÊTETÉ — ce que la migration NE ferme PAS : qui connaît un tag
--   peut toujours saturer son compteur via send_sealed_message (RPC publique
--   par conception), et faire échouer un poll entier (get_messages_by_tags
--   lève dès le premier tag au-dessus du plafond). Propriété du modèle « le
--   tag est le seul identifiant », pas un défaut de permissions.
-- ============================================================================


-- ============================================================================
-- À LANCER D'ABORD, SEUL : CE QUE CETTE MIGRATION VA CHANGER (lecture pure)
-- ============================================================================
-- Copier le SELECT ci-dessous SANS les « -- » de début de ligne. Attendu en
-- production au 2026-10-23 :
--   6 lignes « SERA FERMEE »  (check_rate_limit, cleanup_expired_blobs,
--                              cleanup_stale_push_tokens, lookup_push_token,
--                              register_push_token, unregister_push_token)
--   1 ligne  « deja fermee »  (cleanup_old_data)
--   6 lignes « RPC publique, inchangee »
--
-- SELECT p.proname AS fonction,
--        pg_get_function_identity_arguments(p.oid) AS args,
--        CASE
--          WHEN p.proname IN ('check_rate_limit','cleanup_expired_blobs','cleanup_old_data',
--                             'is_handshake_payload','cleanup_stale_push_tokens',
--                             'lookup_push_token','register_push_token','unregister_push_token')
--            THEN CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
--                        OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
--                      THEN 'SERA FERMEE' ELSE 'deja fermee' END
--          WHEN p.proname IN ('send_sealed_message','get_messages_by_tags','send_call_signal',
--                             'get_call_signals_by_tags','get_app_notice','submit_report')
--            THEN 'RPC publique, inchangee'
--          ELSE 'INCONNUE - me la signaler'
--        END AS effet
-- FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE  n.nspname = 'public'
-- ORDER  BY 3, 1;
-- ============================================================================


BEGIN;

-- ── 0. PRÉCONDITIONS ET PHOTOGRAPHIE ─────────────────────────────────────

DO $preconditions$
DECLARE
    v_manquantes TEXT;
BEGIN
    -- Obligatoires : présentes en production ET dans schema.sql. Le nom suffit,
    -- la signature est résolue plus bas via pg_proc.
    SELECT string_agg(f.nom, ', ' ORDER BY f.nom)
    INTO   v_manquantes
    FROM  (VALUES ('check_rate_limit'), ('cleanup_expired_blobs'), ('cleanup_old_data')) AS f(nom)
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = f.nom);

    IF v_manquantes IS NOT NULL THEN
        RAISE EXCEPTION E'PRÉCONDITION NON REMPLIE — rien n''a été modifié.\n'
            'Fonctions absentes : %. Cette base ne ressemble pas à la production '
            'Ghostr : ne pas forcer, comparer d''abord avec l''inventaire.', v_manquantes;
    END IF;

    -- Les rôles visés doivent exister, sinon les contrôles has_function_privilege lèveraient.
    IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
        RAISE EXCEPTION 'PRÉCONDITION NON REMPLIE — rôles anon / authenticated / service_role introuvables.';
    END IF;
END $preconditions$;

-- Liste unique des fonctions internes, réutilisée par toutes les sections.
CREATE TEMP TABLE _internes (nom TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _internes VALUES
    ('check_rate_limit'), ('cleanup_expired_blobs'), ('cleanup_old_data'),
    ('is_handshake_payload'),                       -- facultative (absente en prod)
    ('cleanup_stale_push_tokens'), ('lookup_push_token'),
    ('register_push_token'), ('unregister_push_token');  -- vestiges push, facultatives

CREATE TEMP TABLE _rpc_publiques (nom TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _rpc_publiques VALUES
    ('send_sealed_message'), ('get_messages_by_tags'), ('send_call_signal'),
    ('get_call_signals_by_tags'), ('get_app_notice'), ('submit_report');

-- Photographie de tous les droits sur les fonctions de public, AVANT modification.
CREATE TEMP TABLE _acl_avant ON COMMIT DROP AS
SELECT p.oid                                        AS foid,
       p.proname                                    AS fonction,
       pg_get_function_identity_arguments(p.oid)    AS args,
       a.grantee                                    AS beneficiaire,
       a.privilege_type                             AS droit
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
CROSS  JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
WHERE  n.nspname = 'public';


-- ── 1. FERMER LES FONCTIONS INTERNES (toutes signatures) ─────────────────

DO $fermer$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM   pg_proc p
        JOIN   pg_namespace n ON n.oid = p.pronamespace
        WHERE  n.nspname = 'public'
          AND  p.proname IN (SELECT nom FROM _internes)
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
        RAISE NOTICE 'Fermée : %', r.sig;
    END LOOP;
END $fermer$;


-- ── 2. TARIR LA SOURCE : PRIVILÈGES PAR DÉFAUT DU RÔLE postgres ──────────
-- Portée de la ligne globale : toute la base, pour les fonctions créées par
-- postgres APRÈS cette migration. Les schémas internes de Supabase (auth,
-- storage, realtime, graphql, extensions) sont peuplés par d'autres rôles
-- (supabase_admin, supabase_auth_admin…) : non concernés. Une future RPC
-- publique devra recevoir son GRANT EXECUTE … TO anon explicite, ce que le
-- projet fait déjà systématiquement.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;


-- ── 3a. AUCUNE FONCTION INTERNE N'EST APPELABLE PAR anon / authenticated ──

DO $verif_internes$
DECLARE
    v_ouvertes TEXT;
BEGIN
    SELECT string_agg(p.oid::regprocedure::TEXT, ', ' ORDER BY p.proname)
    INTO   v_ouvertes
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
      AND  p.proname IN (SELECT nom FROM _internes)
      AND (has_function_privilege('anon',          p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));

    IF v_ouvertes IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3a : fonctions internes encore appelables par anon/authenticated : %', v_ouvertes;
    END IF;
END $verif_internes$;


-- ── 3b. UNE FONCTION CRÉÉE MAINTENANT NAÎT-ELLE FERMÉE ? (test réel) ─────
-- Sonde créée puis supprimée dans la même transaction : rien ne subsiste.

CREATE FUNCTION public._ghostr_sonde_privileges() RETURNS INTEGER
    LANGUAGE sql AS 'SELECT 1';

DO $verif_defaut$
BEGIN
    IF has_function_privilege('anon', 'public._ghostr_sonde_privileges()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public._ghostr_sonde_privileges()', 'EXECUTE') THEN
        RAISE EXCEPTION 'ÉCHEC 3b : une fonction nouvellement créée reste appelable par anon. Les privilèges par défaut n''ont pas pris.';
    END IF;
    IF NOT has_function_privilege('postgres', 'public._ghostr_sonde_privileges()', 'EXECUTE') THEN
        RAISE EXCEPTION 'ÉCHEC 3b : le propriétaire postgres a perdu l''exécution de ses propres fonctions.';
    END IF;
END $verif_defaut$;

DROP FUNCTION public._ghostr_sonde_privileges();


-- ── 3c. LES SIX RPC PUBLIQUES RESTENT APPELABLES PAR anon ────────────────

DO $verif_rpc$
DECLARE
    v_cassees  TEXT;
    v_absentes TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO   v_cassees
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
      AND  p.proname IN (SELECT nom FROM _rpc_publiques)
      AND  NOT has_function_privilege('anon', p.oid, 'EXECUTE');

    IF v_cassees IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3c : RPC publiques plus appelables par anon, l''app serait cassée : %', v_cassees;
    END IF;

    SELECT string_agg(r.nom, ', ' ORDER BY r.nom)
    INTO   v_absentes
    FROM   _rpc_publiques r
    WHERE  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND p.proname = r.nom);
    IF v_absentes IS NOT NULL THEN
        RAISE WARNING 'RPC publiques absentes de cette base (non créées par cette migration) : %', v_absentes;
    END IF;
END $verif_rpc$;


-- ── 3d. ESSAI RÉEL EN TANT QU'anon, PUIS ANNULATION ──────────────────────
-- Tout se passe dans un sous-bloc dont on provoque volontairement l'échec
-- (code GH001) : PostgreSQL annule alors tout ce que le sous-bloc a écrit
-- (la ligne de rate_limits créée par la sonde) et rétablit le rôle.

DO $essai_anon$
DECLARE
    v_refuse BOOLEAN := false;
BEGIN
    BEGIN
        SET LOCAL ROLE anon;

        -- Lecture simple
        PERFORM * FROM public.get_app_notice();

        -- Poll : appelle check_rate_limit en interne. Doit marcher même si
        -- anon ne peut plus appeler check_rate_limit directement.
        PERFORM * FROM public.get_messages_by_tags(ARRAY['ghostr-sonde-migration-0-3']);

        -- Appel direct d'une fonction interne : DOIT être refusé.
        BEGIN
            PERFORM public.cleanup_expired_blobs();
        EXCEPTION WHEN insufficient_privilege THEN
            v_refuse := true;
        END;

        IF NOT v_refuse THEN
            RAISE EXCEPTION 'ÉCHEC 3d : anon peut encore appeler cleanup_expired_blobs() directement.';
        END IF;

        RAISE EXCEPTION USING ERRCODE = 'GH001', MESSAGE = 'sonde terminee';
    EXCEPTION WHEN SQLSTATE 'GH001' THEN
        NULL;  -- annulation voulue des écritures de la sonde
    END;

    IF current_user = 'anon' THEN
        RAISE EXCEPTION 'ÉCHEC 3d : rôle non rétabli après l''essai (current_user = %).', current_user;
    END IF;
END $essai_anon$;


-- ── 3e. AUCUN DROIT RETIRÉ EN DEHORS DE CE QUI EST VISÉ ──────────────────
-- Seuls retraits tolérés : EXECUTE pour PUBLIC (0), anon, authenticated sur
-- les fonctions internes. Les ajouts (GRANT service_role) sont admis.

DO $non_regression$
DECLARE
    v_perdus TEXT;
BEGIN
    SELECT string_agg(
               av.fonction || '(' || av.args || ') → ' ||
               coalesce((SELECT r.rolname FROM pg_roles r WHERE r.oid = av.beneficiaire), 'PUBLIC') ||
               ' / ' || av.droit,
               E'\n  ' ORDER BY av.fonction)
    INTO   v_perdus
    FROM   _acl_avant av
    WHERE  NOT EXISTS (
        SELECT 1
        FROM   pg_proc p
        CROSS  JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE  p.oid = av.foid
          AND  a.grantee = av.beneficiaire
          AND  a.privilege_type = av.droit)
      AND NOT (av.droit = 'EXECUTE'
               AND av.fonction IN (SELECT nom FROM _internes)
               AND (av.beneficiaire = 0
                    OR av.beneficiaire IN (SELECT oid FROM pg_roles
                                           WHERE rolname IN ('anon', 'authenticated'))));

    IF v_perdus IS NOT NULL THEN
        RAISE EXCEPTION E'ÉCHEC 3e : droits retirés hors du périmètre prévu :\n  %', v_perdus;
    END IF;
END $non_regression$;


-- ── 4. CONTRÔLE DE DÉRIVE (avertissement, non bloquant) ──────────────────
-- Toute fonction de public appelable par anon qui n'est pas l'une des six RPC
-- publiques mérite une revue.

DO $derive$
DECLARE
    v_derive TEXT;
BEGIN
    SELECT string_agg(p.oid::regprocedure::TEXT, ', ' ORDER BY p.proname)
    INTO   v_derive
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
      AND  p.proname NOT IN (SELECT nom FROM _rpc_publiques)
      AND  has_function_privilege('anon', p.oid, 'EXECUTE');

    IF v_derive IS NOT NULL THEN
        RAISE WARNING 'DÉRIVE : fonctions de public appelables par anon hors liste blanche : %', v_derive;
    END IF;
END $derive$;


COMMIT;


-- ── 5. RÉCAPITULATIF (c'est la sortie à lire dans le SQL Editor) ─────────
-- Placé APRÈS le COMMIT : le SQL Editor n'affiche que le résultat de la
-- dernière instruction. Lecture pure. Attendu : chaque fonction interne
-- présente → anon_peut_appeler = false ; chaque RPC publique → true ;
-- aucune ligne « autre ».

SELECT p.proname                                           AS fonction,
       pg_get_function_identity_arguments(p.oid)           AS args,
       CASE WHEN p.proname IN ('check_rate_limit','cleanup_expired_blobs','cleanup_old_data',
                               'is_handshake_payload','cleanup_stale_push_tokens',
                               'lookup_push_token','register_push_token','unregister_push_token')
              THEN 'interne'
            WHEN p.proname IN ('send_sealed_message','get_messages_by_tags','send_call_signal',
                               'get_call_signals_by_tags','get_app_notice','submit_report')
              THEN 'RPC publique'
            ELSE 'autre' END                               AS categorie,
       has_function_privilege('anon', p.oid, 'EXECUTE')    AS anon_peut_appeler
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
ORDER  BY 3, 1;


-- ============================================================================
-- ANNULATION — remet EXACTEMENT l'état de production du 2026-10-23
-- ============================================================================
-- À n'utiliser que sur décision explicite : ce bloc ROUVRE la faille.
-- Copier sans les « -- » de début de ligne.
--
-- BEGIN;
-- GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, text, integer)       TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.cleanup_expired_blobs()                     TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.cleanup_stale_push_tokens()                 TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.lookup_push_token(text)                     TO PUBLIC, anon;
-- GRANT EXECUTE ON FUNCTION public.register_push_token(text, text, text)       TO PUBLIC, anon;
-- GRANT EXECUTE ON FUNCTION public.unregister_push_token(text)                 TO PUBLIC, anon;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
-- COMMIT;
--
-- Non annulé, volontairement : cleanup_old_data était déjà fermée, et la ligne
-- « IN SCHEMA public REVOKE … FROM anon, authenticated » était déjà en place
-- en production avant cette migration.
-- ============================================================================
