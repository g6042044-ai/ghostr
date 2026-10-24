-- ============================================================================
-- GHOSTR — MIGRATION DELTA : FERMER LE BUCKET PUBLIC whisper-media (tâche 0.4)
-- ============================================================================
--
-- À exécuter dans le SQL Editor de Supabase Dashboard, fichier ENTIER, en une
-- fois. Idempotente. Tout se fait dans une seule transaction (BEGIN … COMMIT) :
-- au moindre contrôle en échec, RIEN n'est appliqué.
--
-- Conçue contre l'inventaire Storage RÉEL de production du 2026-10-24
-- (PostgreSQL 17.6, tables storage.* possédées par supabase_storage_admin),
-- rejouée sur une réplique supabase/postgres:17.6.1.178 aux droits identiques.
--
-- LE PROBLÈME (constaté en production) :
--   Le bucket whisper-media, vestige d'avant la v27 (médias via OHTTP), est
--   PUBLIC et deux policies sur storage.objects ouvrent au rôle public (donc à
--   anon, c'est-à-dire à quiconque possède la clé anon compilée dans l'app) :
--     • whisper_media_insert  — INSERT  WITH CHECK (bucket_id = 'whisper-media')
--     • whisper_media_select  — SELECT  USING      (bucket_id = 'whisper-media')
--   N'importe qui peut donc y déposer et y lire des fichiers : hébergement
--   gratuit anonyme, contenu illicite possible. 82 objets, le plus récent du
--   2026-01-13, 8 Mo.
--
-- CE QUE FAIT CE FICHIER :
--   1. supprime les deux policies ;
--   2. passe le bucket en privé (public = false).
--   Les 82 objets restent en place : leur sort est une décision à part, et
--   leur suppression doit passer par l'API Storage ou le Dashboard, pas par
--   SQL (un DELETE direct est d'ailleurs bloqué par le trigger protect_delete
--   de Storage, et laisserait les fichiers sur le disque).
--
-- POURQUOI C'EST SANS RISQUE POUR LA VERSION PUBLIÉE :
--   • l'app (commit publié 792ff5a6) ne contient aucune référence à
--     whisper-media ; ses médias passent par le bucket ghostr-blobs, via le
--     gateway OHTTP (upload_blob / download_blob) avec la clé de service, qui
--     ignore les policies ;
--   • la seule lecture serveur de whisper-media (download_legacy_media du
--     gateway) est inatteignable : absente de ALLOWED_RPCS, gateway et client ;
--   • rien n'est touché dans le schéma public : ni fonction, ni droit, ni
--     table. Le contrôle 3c le prouve quand même.
--
-- POURQUOI postgres PEUT SUPPRIMER CES POLICIES SANS ÊTRE PROPRIÉTAIRE :
--   l'image Supabase charge supautils avec « policy_grants » : postgres est
--   autorisé à gérer les policies de storage.objects et storage.buckets
--   (vérifié sur la réplique : SHOW supautils.policy_grants). postgres a par
--   ailleurs UPDATE sur storage.buckets (inventaire), et les triggers de
--   Storage sur buckets ne gardent que les colonnes de cycle de vie.
--
-- RÉSULTAT ATTENDU DANS LE SQL EDITOR : le récapitulatif final (section 5),
-- soit 3 lignes « policy ghostr_blobs_* … conservée », 1 ligne
-- « bucket whisper-media … public = false », 1 ligne « bucket ghostr-blobs …
-- public = false », et les compteurs d'objets inchangés (82 et 57).
-- ============================================================================


BEGIN;

-- ── 0. PRÉCONDITIONS ET PHOTOGRAPHIE ─────────────────────────────────────

DO $preconditions$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'whisper-media') THEN
        RAISE EXCEPTION E'PRÉCONDITION NON REMPLIE — rien n''a été modifié.\n'
            'Le bucket whisper-media n''existe pas. Cette base ne ressemble pas à '
            'la production Ghostr : ne pas forcer, comparer d''abord avec l''inventaire.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'ghostr-blobs' AND NOT public) THEN
        RAISE EXCEPTION 'PRÉCONDITION NON REMPLIE — le bucket ghostr-blobs (privé) est introuvable.';
    END IF;

    -- Les trois policies du bucket vivant doivent être là : c'est elles que
    -- l'on jure de ne pas toucher, il faut pouvoir le vérifier.
    IF (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname IN ('ghostr_blobs_upload', 'ghostr_blobs_download', 'ghostr_blobs_delete')) <> 3 THEN
        RAISE EXCEPTION 'PRÉCONDITION NON REMPLIE — les trois policies ghostr_blobs_* ne sont pas toutes présentes.';
    END IF;

    IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
        RAISE EXCEPTION 'PRÉCONDITION NON REMPLIE — rôles anon / authenticated / service_role introuvables.';
    END IF;

    -- Idempotence : déjà appliquée = bucket privé ET policies absentes. On
    -- l'annonce, et la suite ne fera rien (IF EXISTS / WHERE public).
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'whisper-media' AND public)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage'
                       AND tablename = 'objects' AND policyname LIKE 'whisper\_media\_%') THEN
        RAISE NOTICE 'Déjà appliquée : whisper-media est privé et sans policy. Les contrôles tournent quand même.';
    END IF;
END $preconditions$;

-- Photographie AVANT : toutes les policies de storage.objects, tous les
-- buckets, le nombre d'objets par bucket, les droits sur les fonctions de
-- public. Tout cela doit être retrouvé à l'identique après, sauf ce qui est
-- visé.
CREATE TEMP TABLE _policies_avant ON COMMIT DROP AS
SELECT policyname, cmd, permissive, roles::TEXT AS roles, qual, with_check
FROM   pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

CREATE TEMP TABLE _buckets_avant ON COMMIT DROP AS
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets;

CREATE TEMP TABLE _objets_avant ON COMMIT DROP AS
SELECT bucket_id, count(*) AS nb FROM storage.objects GROUP BY bucket_id;

CREATE TEMP TABLE _acl_avant ON COMMIT DROP AS
SELECT p.oid AS foid, a.grantee AS beneficiaire, a.privilege_type AS droit
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
CROSS  JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
WHERE  n.nspname = 'public';


-- ── 1. SUPPRIMER LES DEUX POLICIES OUVERTES ──────────────────────────────

DROP POLICY IF EXISTS "whisper_media_insert" ON storage.objects;
DROP POLICY IF EXISTS "whisper_media_select" ON storage.objects;


-- ── 2. PASSER LE BUCKET EN PRIVÉ ─────────────────────────────────────────
-- L'URL « /storage/v1/object/public/whisper-media/… » répondra désormais
-- 400/404 à tout le monde, clé anon comprise.

UPDATE storage.buckets SET public = false WHERE id = 'whisper-media' AND public;


-- ── 3a. L'ÉTAT VISÉ EST ATTEINT ──────────────────────────────────────────

DO $verif_cible$
DECLARE
    v_restantes TEXT;
BEGIN
    SELECT string_agg(policyname, ', ') INTO v_restantes
    FROM   pg_policies
    WHERE  schemaname = 'storage' AND tablename = 'objects'
      AND  (policyname LIKE 'whisper\_media\_%'
            OR coalesce(qual, '') LIKE '%whisper-media%'
            OR coalesce(with_check, '') LIKE '%whisper-media%');
    IF v_restantes IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3a : des policies ouvrent encore whisper-media : %', v_restantes;
    END IF;

    IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'whisper-media' AND public) THEN
        RAISE EXCEPTION 'ÉCHEC 3a : le bucket whisper-media est toujours public.';
    END IF;
END $verif_cible$;


-- ── 3b. RIEN D'AUTRE N'A BOUGÉ ───────────────────────────────────────────
-- Policies : exactement celles d'avant moins les deux visées, définitions
-- identiques. Buckets : ghostr-blobs strictement inchangé, aucun bucket
-- apparu ou disparu. Objets : mêmes compteurs par bucket (rien supprimé).

DO $non_regression$
DECLARE
    v_diff TEXT;
BEGIN
    SELECT string_agg(policyname, ', ') INTO v_diff
    FROM (
        SELECT policyname FROM _policies_avant
        WHERE policyname NOT IN ('whisper_media_insert', 'whisper_media_select')
        EXCEPT
        SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
    ) d;
    IF v_diff IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3b : policies perdues hors périmètre : %', v_diff;
    END IF;

    SELECT string_agg(policyname, ', ') INTO v_diff
    FROM (
        SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        EXCEPT
        SELECT policyname FROM _policies_avant
    ) d;
    IF v_diff IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3b : policies apparues : %', v_diff;
    END IF;

    SELECT string_agg(av.policyname, ', ') INTO v_diff
    FROM   _policies_avant av
    JOIN   pg_policies ap ON ap.schemaname = 'storage' AND ap.tablename = 'objects'
                         AND ap.policyname = av.policyname
    WHERE  av.policyname NOT IN ('whisper_media_insert', 'whisper_media_select')
      AND  (ap.cmd, ap.permissive, ap.roles::TEXT, coalesce(ap.qual, ''), coalesce(ap.with_check, ''))
           IS DISTINCT FROM
           (av.cmd, av.permissive, av.roles, coalesce(av.qual, ''), coalesce(av.with_check, ''));
    IF v_diff IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3b : définition de policy modifiée hors périmètre : %', v_diff;
    END IF;

    IF EXISTS (
        SELECT 1 FROM _buckets_avant av
        FULL JOIN storage.buckets ap ON ap.id = av.id
        WHERE av.id IS NULL OR ap.id IS NULL
           OR av.file_size_limit IS DISTINCT FROM ap.file_size_limit
           OR av.allowed_mime_types IS DISTINCT FROM ap.allowed_mime_types
           OR (av.id <> 'whisper-media' AND av.public IS DISTINCT FROM ap.public)
    ) THEN
        RAISE EXCEPTION 'ÉCHEC 3b : un bucket autre que whisper-media a changé, ou un bucket est apparu/disparu.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM _objets_avant av
        FULL JOIN (SELECT bucket_id, count(*) AS nb FROM storage.objects GROUP BY bucket_id) ap
               ON ap.bucket_id = av.bucket_id
        WHERE av.nb IS DISTINCT FROM ap.nb
    ) THEN
        RAISE EXCEPTION 'ÉCHEC 3b : le nombre d''objets par bucket a changé. Cette migration ne doit rien supprimer.';
    END IF;
END $non_regression$;


-- ── 3c. LE SCHÉMA public N'A PAS BOUGÉ D'UN DROIT ────────────────────────
-- Cette migration n'y touche pas ; on le prouve, parce que c'est là que vit
-- l'app : les RPC d'ALLOWED_RPCS doivent répondre à anon exactement comme avant.

DO $verif_public$
DECLARE
    v_perdus INT;
    v_cassees TEXT;
BEGIN
    SELECT count(*) INTO v_perdus
    FROM   _acl_avant av
    WHERE  NOT EXISTS (
        SELECT 1 FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = av.foid AND a.grantee = av.beneficiaire AND a.privilege_type = av.droit);
    IF v_perdus > 0 THEN
        RAISE EXCEPTION 'ÉCHEC 3c : % droit(s) sur des fonctions de public ont disparu. Impossible ici : base instable, ne pas valider.', v_perdus;
    END IF;

    SELECT string_agg(f.nom, ', ') INTO v_cassees
    FROM  (VALUES ('send_sealed_message'), ('get_messages_by_tags'),
                  ('get_call_signals_by_tags'), ('get_app_notice')) AS f(nom)
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = f.nom
          AND has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_cassees IS NOT NULL THEN
        RAISE EXCEPTION 'ÉCHEC 3c : RPC publiques plus appelables par anon, l''app serait cassée : %', v_cassees;
    END IF;
END $verif_public$;


-- ── 3d. ESSAI RÉEL EN TANT QU'anon, PUIS ANNULATION ──────────────────────
-- Dans un sous-bloc volontairement mis en échec (code GH001) pour que rien
-- de ce qu'il écrit ne survive et que le rôle soit rétabli.
--   • lecture de whisper-media : DOIT rendre 0 ligne (RLS, plus de policy) ;
--   • dépôt dans whisper-media : DOIT être refusé (42501) ;
--   • lecture de ghostr-blobs : DOIT rendre autant de lignes qu'avant (la
--     policy ghostr_blobs_download est intacte).

DO $essai_anon$
DECLARE
    v_avant_blobs BIGINT := (SELECT coalesce(nb, 0) FROM _objets_avant WHERE bucket_id = 'ghostr-blobs');
    v_vu BIGINT;
    v_refuse BOOLEAN := false;
BEGIN
    BEGIN
        SET LOCAL ROLE anon;

        SELECT count(*) INTO v_vu FROM storage.objects WHERE bucket_id = 'whisper-media';
        IF v_vu <> 0 THEN
            RAISE EXCEPTION 'ÉCHEC 3d : anon lit encore % objet(s) de whisper-media.', v_vu;
        END IF;

        -- Attendu : 42501 (violation RLS). Tout autre refus est aussi un
        -- refus (l'objet n'est pas entré) : on le note sans échouer.
        BEGIN
            INSERT INTO storage.objects (bucket_id, name) VALUES ('whisper-media', 'sonde-0-4/doit-echouer.enc');
        EXCEPTION
            WHEN insufficient_privilege THEN
                v_refuse := true;
            WHEN OTHERS THEN
                v_refuse := true;
                RAISE NOTICE 'Sonde 3d : dépôt refusé pour une autre raison que la RLS (SQLSTATE %, %).', SQLSTATE, SQLERRM;
        END;
        IF NOT v_refuse THEN
            RAISE EXCEPTION 'ÉCHEC 3d : anon peut encore déposer dans whisper-media.';
        END IF;

        SELECT count(*) INTO v_vu FROM storage.objects WHERE bucket_id = 'ghostr-blobs';
        IF v_vu <> v_avant_blobs THEN
            RAISE EXCEPTION 'ÉCHEC 3d : anon voit % objet(s) de ghostr-blobs au lieu de %. La policy de lecture du bucket vivant a été touchée.', v_vu, v_avant_blobs;
        END IF;

        RAISE EXCEPTION USING ERRCODE = 'GH001', MESSAGE = 'sonde terminee';
    EXCEPTION WHEN SQLSTATE 'GH001' THEN
        NULL;  -- annulation voulue des écritures de la sonde
    END;

    IF current_user = 'anon' THEN
        RAISE EXCEPTION 'ÉCHEC 3d : rôle non rétabli après l''essai (current_user = %).', current_user;
    END IF;
END $essai_anon$;


COMMIT;


-- ── 5. RÉCAPITULATIF (c'est la sortie à lire dans le SQL Editor) ─────────
-- Placé APRÈS le COMMIT : le SQL Editor n'affiche que le résultat de la
-- dernière instruction. Lecture pure.
-- Attendu : 3 policies ghostr_blobs_* « conservée », aucune policy
-- whisper_media_*, les deux buckets « public = false », 82 et 57 objets.

SELECT 'policy'                                  AS type,
       policyname                                AS nom,
       'conservée — ' || cmd || ' pour ' || roles::TEXT AS etat
FROM   pg_policies
WHERE  schemaname = 'storage' AND tablename = 'objects'
UNION ALL
SELECT 'bucket', b.id,
       'public = ' || b.public::TEXT || ' — ' ||
       coalesce((SELECT count(*) FROM storage.objects o WHERE o.bucket_id = b.id), 0)::TEXT || ' objet(s)'
FROM   storage.buckets b
ORDER  BY 1, 2;


-- ============================================================================
-- ANNULATION — remet EXACTEMENT l'état de production du 2026-10-24
-- ============================================================================
-- À n'utiliser que sur décision explicite : ce bloc ROUVRE le bucket à tous.
-- Copier sans les « -- » de début de ligne.
--
-- BEGIN;
-- CREATE POLICY "whisper_media_insert" ON storage.objects FOR INSERT TO public
--     WITH CHECK (bucket_id = 'whisper-media');
-- CREATE POLICY "whisper_media_select" ON storage.objects FOR SELECT TO public
--     USING (bucket_id = 'whisper-media');
-- UPDATE storage.buckets SET public = true WHERE id = 'whisper-media';
-- COMMIT;
-- ============================================================================
