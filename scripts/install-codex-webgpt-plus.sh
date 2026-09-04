#!/bin/sh
set -eu

# Install the audited Codex Web GPT launcher that makes ChatGPT Web appear as
# native Codex models. This wrapper intentionally does not copy browser cookies,
# API keys, tunnel credentials, or ChatGPT session state.

REPOSITORY="${CODEX_WEB_GPT_REPOSITORY:-miuuyy/codex-chatgpt-web}"
VERSION="${CODEX_WEB_GPT_VERSION:-5.0.1}"
EXPECTED_PLAN="${CODEX_WEB_GPT_PLAN:-plus}"

case "$EXPECTED_PLAN" in
  plus) ;;
  *)
    echo "This integration wrapper is intentionally pinned to ChatGPT Plus. Set CODEX_WEB_GPT_PLAN=plus." >&2
    exit 2
    ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This wrapper currently targets the user's macOS Codex setup." >&2
  exit 2
fi

case "$REPOSITORY" in
  *[!A-Za-z0-9_.\/-]*|/*|*/../*|../*|*..)
    echo "Invalid GitHub repository: $REPOSITORY" >&2
    exit 2
    ;;
esac

case "$VERSION" in
  *[!A-Za-z0-9._-]*|'')
    echo "Invalid Codex Web GPT version: $VERSION" >&2
    exit 2
    ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gpt-mcp-codex-webgpt.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

INSTALLER="$TMP/install-launcher.sh"
INSTALLER_URL="https://raw.githubusercontent.com/$REPOSITORY/v$VERSION/scripts/install-launcher.sh"

echo "[1/4] Fetching Codex Web GPT launcher installer v$VERSION ..."
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 90 \
  "$INSTALLER_URL" -o "$INSTALLER"

# Fail closed if the upstream installer no longer verifies release assets.
if ! grep -q 'checksums.txt' "$INSTALLER" || ! grep -q 'SHA-256 verification failed' "$INSTALLER"; then
  echo "Upstream installer verification contract changed; refusing to execute it." >&2
  exit 3
fi

chmod 0755 "$INSTALLER"

echo "[2/4] Installing the signed-by-checksum launcher asset ..."
CODEX_WEB_GPT_REPOSITORY="$REPOSITORY" \
CODEX_WEB_GPT_VERSION="$VERSION" \
sh "$INSTALLER"

APP="/Applications/Codex Web GPT.app"
if [ ! -d "$APP" ]; then
  APP="$HOME/Applications/Codex Web GPT.app"
fi
if [ ! -d "$APP" ]; then
  echo "Launcher install returned successfully but the app bundle was not found." >&2
  exit 4
fi

echo "[3/4] Installed: $APP"
echo "[4/4] Plus account policy: expose only ChatGPT Web — Instant / Medium / High."

cat <<'EOF'

One-time account step (cannot be safely automated):
  1. In Codex Web GPT, sign in to the same ChatGPT Plus account.
  2. Run Browser smoke test.
  3. Click Install models, then restart Codex once.
  4. In Codex choose ChatGPT Web — High (or Medium/Instant).

Do not enable or fake Extra High / Pro on Plus. The launcher reads account capabilities and
should keep those rows absent. For local Codex tools, use the Full Harness page and create the
dedicated connector named exactly "Codex Native2"; keep the existing generic MCP tunnels intact.

After setup, run:
  ./scripts/codex-webgpt-status.sh
EOF
