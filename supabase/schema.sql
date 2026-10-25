-- ============================================================================
-- GHOSTR — SCHÉMA COMPLET v26.0
-- ============================================================================
--
-- Script standalone: supprime tout et recrée from scratch.
-- Exécuter dans le SQL Editor de Supabase Dashboard.
--
-- ARCHITECTURE:
--   • 3 tables publiques: messages, call_signals, rate_limits
--   • 4 RPCs publiques: send_sealed_message, get_messages_by_tags,
--                        send_call_signal, get_call_signals_by_tags
--   • 3 RPCs internes: check_rate_limit, cleanup_old_data,
--                        is_handshake_payload
--   • 2 buckets storage: ghostr-blobs (v26.0 médias E2E), whisper-media (legacy)
--   • Cron job: cleanup messages/signaux (15min)
--   • Blobs > 48 h : purgés par le gateway OHTTP via l'API Storage
--     (ohttp-gateway/blobSweep.js, toutes les 6 h), PAS par SQL — voir § 12
--
-- PRINCIPES SÉCURITÉ:
--   1. Zero-knowledge: le serveur ne peut lire aucun contenu
--   2. RPC-only: aucun accès direct aux tables (RLS deny-all)
--   3. Rate limiting sur écriture ET lecture (par tag individuel)
--   4. Payload opaque: tag + sealed_payload, rien d'autre
--   5. TTL automatique: trafic 48h, handshake 30j (invitations + accepts),
--      signaux 24h, blobs 48h
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
DROP FUNCTION IF EXISTS public.get_app_notice() CASCADE;

-- Fonctions internes
DROP FUNCTION IF EXISTS public.check_rate_limit(TEXT, TEXT, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.cleanup_old_data(INTEGER, INTEGER, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.is_handshake_payload(TEXT) CASCADE;

-- Anciennes signatures (compat drop)
DROP FUNCTION IF EXISTS public.cleanup_old_data(INTEGER, INTEGER) CASCADE;
-- cleanup_expired_blobs() : retirée le 2026-10-25 (0.3bis). Elle n'a jamais pu
-- fonctionner (SET ROLE interdit en SECURITY DEFINER) et un DELETE SQL sur
-- storage.objects laisse le fichier orphelin. Le gateway purge via l'API.
DROP FUNCTION IF EXISTS public.cleanup_expired_blobs() CASCADE;
DROP FUNCTION IF EXISTS public.send_message(TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.send_call_signal(TEXT, TEXT, TEXT) CASCADE;

-- Tables
DROP TABLE IF EXISTS public.app_notice CASCADE;
DROP TABLE IF EXISTS public.blob_cleanup_log CASCADE; -- legacy (0.3bis), n'est plus recréée
DROP TABLE IF EXISTS public.rate_limits CASCADE;
DROP TABLE IF EXISTS public.call_signals CASCADE;
DROP TABLE IF EXISTS public.messages CASCADE;

-- Storage policies (ghostr-blobs)
DROP POLICY IF EXISTS "ghostr_blobs_upload"   ON storage.objects;
DROP POLICY IF EXISTS "ghostr_blobs_download" ON storage.objects;
DROP POLICY IF EXISTS "ghostr_blobs_delete"   ON storage.objects;
DROP POLICY IF EXISTS "blob_anon_upload"       ON storage.objects;
DROP POLICY IF EXISTS "blob_anon_download"     ON storage.objects;

-- Storage policies (whisper-media). Noms RÉELS de la prod (inventaire du
-- 2026-10-24) : whisper_media_insert / whisper_media_select, fermées par
-- migration_close_whisper_media.sql (tâche 0.4). Les trois autres noms sont
-- ceux d'anciennes versions du dépôt, gardés par prudence.
DROP POLICY IF EXISTS "whisper_media_insert"   ON storage.objects;
DROP POLICY IF EXISTS "whisper_media_select"   ON storage.objects;
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
  PERFORM cron.unschedule('cleanup-ghostr-blobs'); -- legacy (0.3bis), n'est plus replanifiée
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
-- R-14: La déduplication par SHA-256(sealed_payload) n'expose PAS de corrélation entre
-- messages identiques en clair, car la SealedSenderEnvelope intègre un nonce aléatoire
-- de 24 bytes (nacl.box) → chaque envoi produit un ciphertext UNIQUE même pour le même
-- plaintext. L'index UNIQUE sert uniquement à rejeter les replay attacks (rejeu d'un
-- même ciphertext capturé → rejeté avec DO NOTHING).
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
    -- R-09: Fenêtre glissante réelle — stocke le timestamp de la PREMIÈRE requête
    -- dans la fenêtre actuelle (pas date_trunc). Cela évite le bypass classique:
    -- N requêtes à HH:MM:59 + N requêtes à HH:MM+1:00 = 2N requêtes en 1 seconde.
    window_start  TIMESTAMPTZ DEFAULT now() NOT NULL,

    PRIMARY KEY (identifier, limit_type),

    CONSTRAINT rate_limits_identifier_length CHECK (length(identifier) <= 140),
    CONSTRAINT rate_limits_type_length       CHECK (length(limit_type) <= 32)
);

COMMENT ON TABLE public.rate_limits IS 'Compteurs rate limiting — fenêtre glissante vraie (sliding window, R-09)';


-- ── App notice (kill-switch / deprecation banner) ──
--
-- Table singleton (id=1 forcé par CHECK) contenant un blob de texte SIGNÉ
-- Ed25519 dont la clé publique est embarquée dans le client. Le serveur
-- est non-confiance pour ce contenu — toute modification non signée par
-- la clé hors-ligne du développeur est REJETÉE par le client.
--
-- État nominal: signed_payload IS NULL → aucun avis n'est affiché.
-- Activation:   UPDATE app_notice SET signed_payload = '<base64.signature>'
--               WHERE id = 1;
-- Désactivation: UPDATE app_notice SET signed_payload = NULL WHERE id = 1;
--
-- Format du payload: voir src/services/appNotice.ts (header du fichier).
CREATE TABLE public.app_notice (
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

-- ── Signalements (Guideline App Store 1.2) ──
--
-- Le serveur ne peut PAS lire les messages (E2EE, sealed sender). Un
-- signalement est un acte VOLONTAIRE du destinataire : le contenu arrive ici
-- uniquement parce que le signaleur a choisi de le transmettre, via le tunnel
-- OHTTP (pas d'IP). Modération manuelle sous 24h (engagement guideline 1.2) :
--   SELECT * FROM reports WHERE handled = false ORDER BY created_at;
--   UPDATE reports SET handled = true, handled_at = now() WHERE id = '<uuid>';
CREATE TABLE public.reports (
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


-- ── Exemption du TTL (invitation de démo App Review) ──
--
-- Le bundle d'invitation PQXDH vit dans `messages` (le QR ne contient que le
-- tag, cf. sessionService.fetchInviteFromServer) : une invitation meurt donc
-- avec la purge 48h. C'est la cause du rejet Apple 2.1(a) du 4 juin 2026.
-- Plutôt que d'allonger le TTL GLOBAL à chaque soumission (ce qui allongerait
-- aussi la rétention des messages non délivrés, contrairement à ce qui est
-- déclaré à Apple), on exempte le seul tag de l'invitation de démo.
-- Table vide par défaut → comportement strictement identique à 48h partout.
CREATE TABLE public.invite_ttl_exempt (
    tag        TEXT        PRIMARY KEY,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Même contrainte que public.messages.tag
    CONSTRAINT invite_ttl_exempt_tag_length CHECK (length(tag) BETWEEN 8 AND 128)
);

COMMENT ON TABLE public.invite_ttl_exempt IS
    'Tags exemptés de la purge TTL de messages (invitation de démo App Review). À vider après approbation.';
COMMENT ON COLUMN public.invite_ttl_exempt.note IS
    'Pourquoi ce tag est exempté (ex. « demo App Review 1.0.1 ») — pour pouvoir nettoyer plus tard.';


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

CREATE INDEX idx_reports_unhandled
    ON public.reports (created_at) WHERE handled = false;


-- ============================================================================
-- 4. FONCTIONS INTERNES
-- ============================================================================

-- ── Rate limiter (fenêtre GLISSANTE vraie — R-09) ──
--
-- R-09: L'ancienne implémentation utilisait date_trunc('minute', now()) — une FENÊTRE FIXE.
-- Bypass classique: envoyer p_max requêtes à HH:MM:59 puis p_max à HH:MM+1:00
-- = 2×p_max requêtes en 2 secondes, soit une explosion DB (ex: 6 000 queries/s).
--
-- NOUVELLE IMPLÉMENTATION — Fenêtre glissante (Sliding Window):
-- window_start stocke le timestamp de la première requête dans la fenêtre courante.
-- Si now() > window_start + 60s → la fenêtre a expiré → reset count=1 + window_start=now().
-- Si now() ≤ window_start + 60s → on est dans la même fenêtre → incrémenter count.
-- Résultat: exactement p_max_per_minute requêtes autorisées par fenêtre de 60 secondes
-- GLISSANTE, sans possibilité de doubler la limite à la frontière de fenêtre.
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
    v_count     INTEGER;
    v_now       TIMESTAMPTZ;
    v_window_ms INTERVAL;
BEGIN
    v_now        := clock_timestamp();  -- Précision sub-seconde
    v_window_ms  := INTERVAL '60 seconds';

    INSERT INTO public.rate_limits (identifier, limit_type, request_count, window_start)
    VALUES (left(p_identifier, 140), left(p_limit_type, 32), 1, v_now)
    ON CONFLICT (identifier, limit_type)
    DO UPDATE SET
        -- Si la fenêtre de 60s a expiré depuis window_start → nouveau cycle (reset)
        -- Sinon → incrémenter dans la même fenêtre glissante
        request_count = CASE
            WHEN v_now - rate_limits.window_start >= v_window_ms THEN 1
            ELSE rate_limits.request_count + 1
        END,
        window_start = CASE
            WHEN v_now - rate_limits.window_start >= v_window_ms THEN v_now
            ELSE rate_limits.window_start
        END
    RETURNING request_count INTO v_count;

    RETURN v_count <= p_max_per_minute;
END;
$$;

COMMENT ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER)
    IS 'R-09: Rate limiter fenêtre glissante vraie (sliding window 60s). Résiste au bypass fixed-window. SECURITY DEFINER.';


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
-- ── Prédicat « ceci est un handshake » ──
-- Le gateway dé-scelle l'enveloppe sealed sender avant de transmettre à
-- Supabase (ohttp-gateway/server.js:1435 → `p_sealed_content:
-- inner.innerPayload`), donc `sealed_payload` est du JSON dont le champ
-- `type` est lisible ici. Le CONTENU reste chiffré E2EE — seul le type
-- d'enveloppe est visible, et il l'était déjà.
--
-- LIKE et non `::jsonb->>'type'` DÉLIBÉRÉMENT : une seule ligne au JSON
-- malformé ferait échouer le cast, donc la purge entière, donc la table
-- grossirait sans limite — en silence. Un LIKE ne peut pas échouer.
-- Pas de faux positif : les champs `data` et `_p` n'utilisent que l'alphabet
-- base64 (sealedSender.ts:728), sans guillemet ni deux-points.
CREATE OR REPLACE FUNCTION public.is_handshake_payload(p_payload TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT p_payload LIKE '%"type":"ghostr_invite_pq"%'
        OR p_payload LIKE '%"type":"ghostr_accept_pq"%';
$$;

COMMENT ON FUNCTION public.is_handshake_payload(TEXT) IS
    'Vrai si le payload est un bundle d''invitation ou un accusé d''acceptation (TTL long). Le contenu reste chiffré E2EE — seul le type d''enveloppe est lu.';


-- ── Cleanup messages/signaux/rate_limits — DEUX TTL ──
-- Le bundle d'invitation vit dans `messages` (le QR ne contient que le tag),
-- donc la durée de vie réelle d'une invitation EST ce TTL. Le client annonce
-- 30 jours (pendingInvites.DEFAULT_EXPIRY_MS) : on aligne le serveur sur les
-- handshakes seuls, sans allonger la rétention du trafic — il n'y a aucune
-- suppression après lecture, et les decoys écrivent ~17 KB toutes les ~90s
-- par client actif.
-- Les accepts suivent les invitations : sinon quelqu'un scanne une invitation
-- de 20 jours, envoie son accept, et si l'émetteur n'ouvre pas l'app sous 48h
-- l'accept est purgé — connexion perdue, OTPK consommée.
CREATE OR REPLACE FUNCTION public.cleanup_old_data(
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


-- ── Blobs expirés : PAS de fonction SQL ──
-- L'ancienne cleanup_expired_blobs() (SET LOCAL ROLE supabase_storage_admin
-- puis DELETE sur storage.objects) n'a jamais pu s'exécuter : « cannot set
-- parameter "role" within security-definer function » (PostgreSQL 17.6), et
-- postgres n'est pas membre de supabase_storage_admin en prod. Un DELETE SQL
-- laisserait de toute façon le fichier orphelin sur le disque. La purge des
-- blobs > 48 h est faite par le gateway via l'API Storage (§ 12).


-- ── get_app_notice ──
-- RPC publique appelée au boot par chaque client. Retourne le payload signé
-- de l'avis courant, ou NULL s'il n'y a pas d'avis. Coût: SELECT sur une
-- ligne unique avec PK. Pas de rate limiting nécessaire (lecture cheap).
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


-- ── submit_report ──
-- Guideline 1.2 : dépôt d'un signalement volontaire par le destinataire.
-- Le rate-limit s'appuie sur un tag aléatoire local du signaleur (aucun lien
-- avec son identité crypto) — 5 signalements/min max.
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

-- ── whisper-media: SUPPRIMÉ (P0-A2) ──
-- Tout le trafic média passe désormais par ghostr-blobs via OHTTP relay.


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


-- ── whisper-media: policies SUPPRIMÉES (P0-A2) ──


-- ============================================================================
-- 10. ROW LEVEL SECURITY — DENY ALL DIRECT ACCESS
-- ============================================================================

ALTER TABLE public.messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notice   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_ttl_exempt ENABLE ROW LEVEL SECURITY;

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


-- app_notice: aucun accès direct, lecture uniquement via la RPC SECURITY DEFINER.
CREATE POLICY app_notice_deny_direct
    ON public.app_notice
    TO anon, authenticated
    USING (false) WITH CHECK (false);

-- reports: aucun accès direct, écriture uniquement via submit_report,
-- lecture uniquement par le modérateur (service_role / dashboard).
CREATE POLICY reports_deny_direct
    ON public.reports
    TO anon, authenticated
    USING (false) WITH CHECK (false);

-- invite_ttl_exempt: aucun accès client, gestion manuelle via le dashboard.
CREATE POLICY invite_ttl_exempt_deny_direct
    ON public.invite_ttl_exempt
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
REVOKE ALL ON public.app_notice        FROM anon, authenticated;
REVOKE ALL ON public.reports           FROM anon, authenticated;
REVOKE ALL ON public.invite_ttl_exempt FROM anon, authenticated;

GRANT ALL ON public.messages          TO service_role;
GRANT ALL ON public.call_signals      TO service_role;
GRANT ALL ON public.rate_limits       TO service_role;
GRANT ALL ON public.app_notice        TO service_role;
GRANT ALL ON public.reports           TO service_role;
GRANT ALL ON public.invite_ttl_exempt TO service_role;

-- RPCs publiques: accessibles par anon/authenticated
GRANT EXECUTE ON FUNCTION public.send_sealed_message(TEXT, TEXT, INTEGER)               TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_messages_by_tags(TEXT[], TIMESTAMPTZ, INTEGER)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_call_signal(TEXT, TEXT)                           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_signals_by_tags(TEXT[], TIMESTAMPTZ, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_app_notice()                                       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_report(TEXT, TEXT, TEXT, TEXT)                  TO anon, authenticated;

-- RPCs internes: service_role uniquement
--
-- PUBLIC D'ABORD, ET POUR LES TROIS. `CREATE FUNCTION` accorde EXECUTE à
-- PUBLIC par défaut, et `anon` est membre de PUBLIC : un REVOKE ciblé sur
-- anon/authenticated ne retire donc RIEN tant que PUBLIC garde le droit.
-- Sans ces lignes, un porteur de la clé anon — elle est embarquée dans le
-- binaire de l'app — appelle cleanup_old_data(0, 0, 0) → purge totale.
-- Contrôle : deux pièges rendent le test à l'œil faux. Un proacl NULL signifie
-- « droits par défaut », donc PUBLIC A EXECUTE ; et chercher la chaîne « =X/ »
-- attrape aussi l'entrée d'un rôle nommé (« postgres=X/postgres »). Seul le
-- grantee 0 désigne PUBLIC. La requête de contrôle juste, par aclexplode(), est
-- dans supabase/migration_grants_public.sql.
--
-- check_rate_limit est appelé depuis les SECURITY DEFINER RPCs (qui tournent
-- en tant que postgres owner) donc n'a pas besoin d'être accessible par anon.
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER)       FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER)FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER)FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_handshake_payload(TEXT)                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_handshake_payload(TEXT)                  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INTEGER)       TO service_role;
GRANT  EXECUTE ON FUNCTION public.cleanup_old_data(INTEGER, INTEGER, INTEGER, INTEGER)TO service_role;
GRANT  EXECUTE ON FUNCTION public.is_handshake_payload(TEXT)                  TO service_role;

-- Verrouiller les DEFAULT PRIVILEGES Supabase
-- Une fonction créée par postgres dans public reçoit EXECUTE par DEUX voies,
-- qu'il faut fermer toutes les deux (vérifié sur supabase/postgres:17.6.1.178,
-- même version que la production) :
--   1. Supabase pose « IN SCHEMA public GRANT … TO anon, authenticated » sur
--      les privilèges par défaut de postgres. Les deux premières lignes
--      ci-dessous l'annulent (un REVOKE par schéma défait un GRANT par schéma).
--   2. PostgreSQL accorde EXECUTE à PUBLIC (dont anon est membre) au niveau
--      GLOBAL. Seule la troisième ligne, SANS « IN SCHEMA », le retire : la doc
--      (ALTER DEFAULT PRIVILEGES, Notes) précise qu'un REVOKE par schéma ne peut
--      pas retrancher un droit accordé globalement.
-- Sans l'une ou l'autre, toute nouvelle fonction naît appelable par anon. Les
-- RPC publiques reçoivent leur GRANT explicite plus haut : elles ne dépendent
-- pas de ces droits par défaut.
-- Portée de la ligne globale : toute la base, pour les fonctions créées par
-- postgres après elle. Les schémas internes de Supabase sont peuplés par
-- d'autres rôles (supabase_admin, supabase_auth_admin…) : non concernés.
-- Contrôle : migration_grants_public.sql, sections 3a et 3b.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Objets présents en PRODUCTION mais créés hors de ce fichier (inventaire du
-- 2026-10-23) : table notification_tokens et fonctions register_push_token,
-- unregister_push_token, lookup_push_token, cleanup_stale_push_tokens
-- (vestiges push d'avril 2026, appelés par aucune version de l'app), table
-- demo_invite_backup, bucket public whisper-media. Ce script ne les crée ni ne
-- les supprime ; migration_grants_public.sql ferme les quatre fonctions.


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

-- PAS de tâche cron pour les blobs (0.3bis, 2026-10-25). La suppression
-- d'objets Storage doit passer par l'API Storage, jamais par SQL : un DELETE
-- sur storage.objects laisse le fichier orphelin (doc Supabase), et le
-- trigger protect_delete le bloque de toute façon. Le gateway OHTTP, seul
-- client du bucket, liste et supprime les blobs > 48 h toutes les 6 h avec
-- la clé anon (policies ghostr_blobs_download / ghostr_blobs_delete) :
-- ohttp-gateway/blobSweep.js, compteurs blob_sweep_* dans /metrics.


-- ============================================================================
-- 13. VÉRIFICATION FINALE
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
      AND table_name IN ('messages', 'call_signals', 'rate_limits', 'app_notice');

    SELECT count(*) INTO v_functions
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'send_sealed_message', 'get_messages_by_tags',
        'send_call_signal', 'get_call_signals_by_tags',
        'check_rate_limit', 'cleanup_old_data',
        'get_app_notice'
      );

    -- whisper-media n'est plus créé par ce script (P0-A2) : un seul bucket
    -- attendu, trois policies ghostr_blobs_*.
    SELECT count(*) INTO v_buckets
    FROM storage.buckets
    WHERE id = 'ghostr-blobs';

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
    RAISE NOTICE '  Storage buckets:    % / 1 expected', v_buckets;
    RAISE NOTICE '  Storage policies:   % / 3 expected', v_policies;
    RAISE NOTICE '  Public indexes:     % / 4 expected', v_indexes;
    RAISE NOTICE '════════════════════════════════════════════════';

    IF v_tables    = 4 AND v_functions = 7 AND v_buckets = 1 AND v_policies >= 3 THEN
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
-- Blobs actifs (doivent tous avoir < 48 h, le gateway balaie toutes les 6 h) :
--   SELECT count(*), now() - min(created_at) AS age_plus_ancien,
--          pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0))
--   FROM storage.objects WHERE bucket_id = 'ghostr-blobs';
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
--
-- Cron jobs actifs (si pg_cron):
--   SELECT * FROM cron.job;
-- ============================================================================