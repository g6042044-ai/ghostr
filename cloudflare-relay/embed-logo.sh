#!/usr/bin/env bash
# embed-logo.sh
# Encode l'icône Ghostr en base64 et l'injecte dans invite-worker.js
#
# Usage :
#   cd cloudflare-relay
#   ./embed-logo.sh
#
# Prérequis : base64 (présent par défaut sur Linux et macOS).
# Optionnel  : ImageMagick (`convert`) pour redimensionner — sinon on prend
#              le PNG tel quel (ça marche, juste un peu plus lourd).

set -euo pipefail

# ─── Chemins (par rapport à cloudflare-relay/) ────────────────────────────────
WORKER_FILE="$(dirname "$0")/invite-worker.js"
LOGO_SOURCE="$(dirname "$0")/../assets/icon_nobg.png"
PLACEHOLDER="__LOGO_BASE64__"

# ─── Vérifications ────────────────────────────────────────────────────────────
if [ ! -f "$WORKER_FILE" ]; then
  echo "❌ Worker introuvable : $WORKER_FILE" >&2
  exit 1
fi

if [ ! -f "$LOGO_SOURCE" ]; then
  # Fallback sur icon.png si icon_nobg.png n'existe pas
  LOGO_SOURCE="$(dirname "$0")/../assets/icon.png"
  if [ ! -f "$LOGO_SOURCE" ]; then
    echo "❌ Logo introuvable. Cherché :"
    echo "   - $(dirname "$0")/../assets/icon_nobg.png"
    echo "   - $(dirname "$0")/../assets/icon.png"
    exit 1
  fi
  echo "⚠️  icon_nobg.png introuvable, utilisation de icon.png (avec fond)"
fi

echo "📷 Logo source  : $LOGO_SOURCE"
echo "📄 Worker cible : $WORKER_FILE"

# ─── Optionnel : redimensionner pour alléger ──────────────────────────────────
TMP_LOGO=""
if command -v convert >/dev/null 2>&1; then
  TMP_LOGO="$(mktemp -t ghostr-logo-XXXXXX.png)"
  trap 'rm -f "$TMP_LOGO"' EXIT
  # 240x240 suffit largement pour un affichage 120x120 en HiDPI (2x = 240)
  if convert "$LOGO_SOURCE" -resize 240x240 -strip "$TMP_LOGO" 2>/dev/null && [ -s "$TMP_LOGO" ]; then
    LOGO_TO_ENCODE="$TMP_LOGO"
    ORIG_SIZE=$(wc -c < "$LOGO_SOURCE")
    NEW_SIZE=$(wc -c < "$TMP_LOGO")
    echo "✂️  Redimensionné : $ORIG_SIZE → $NEW_SIZE octets"
  else
    echo "⚠️  Redimensionnement échoué — utilisation du logo original"
    LOGO_TO_ENCODE="$LOGO_SOURCE"
  fi
else
  LOGO_TO_ENCODE="$LOGO_SOURCE"
  echo "ℹ️  ImageMagick non installé — encodage du logo tel quel"
  echo "   (pour réduire la taille : brew install imagemagick / apt install imagemagick)"
fi

# ─── Encoder en base64 (sans newlines) ────────────────────────────────────────
if base64 --help 2>&1 | grep -q "\-w"; then
  # GNU base64 (Linux)
  LOGO_B64=$(base64 -w 0 "$LOGO_TO_ENCODE")
else
  # BSD base64 (macOS)
  LOGO_B64=$(base64 < "$LOGO_TO_ENCODE" | tr -d '\n')
fi

B64_SIZE=${#LOGO_B64}
echo "🔢 Base64 généré : $B64_SIZE caractères"

# ─── Injecter dans le worker ──────────────────────────────────────────────────
# On utilise un délimiteur exotique pour sed afin de ne pas être confus
# par les / et + qui peuvent apparaître dans le base64.
# Note : on remplace systématiquement, qu'il y ait déjà une valeur ou le placeholder.

# Détecter si le worker a déjà été patché auparavant (pas de placeholder)
if ! grep -q "$PLACEHOLDER" "$WORKER_FILE"; then
  # Le worker contient déjà un base64 → on le remplace
  # On capture la ligne `const LOGO_BASE64 = "..."` et on la remplace entièrement
  # Utilisation de python pour éviter les pièges de sed avec les longs strings
  python3 - <<PYEOF
import re
import pathlib
worker_path = pathlib.Path("$WORKER_FILE")
content = worker_path.read_text()
new_content = re.sub(
    r'const LOGO_BASE64 = "[^"]*";',
    'const LOGO_BASE64 = "$LOGO_B64";',
    content,
    count=1,
)
if new_content == content:
    print("❌ Pas de remplacement effectué — vérifie le format de invite-worker.js")
    exit(1)
worker_path.write_text(new_content)
PYEOF
  echo "✅ Logo mis à jour dans $WORKER_FILE"
else
  # Premier run : on remplace le placeholder
  python3 - <<PYEOF
import pathlib
worker_path = pathlib.Path("$WORKER_FILE")
content = worker_path.read_text()
new_content = content.replace("$PLACEHOLDER", "$LOGO_B64", 1)
if new_content == content:
    print("❌ Placeholder __LOGO_BASE64__ introuvable dans $WORKER_FILE")
    exit(1)
worker_path.write_text(new_content)
PYEOF
  echo "✅ Logo injecté dans $WORKER_FILE"
fi

echo ""
echo "🚀 Étape suivante :"
echo "   wrangler deploy -c wrangler-invite.toml"
