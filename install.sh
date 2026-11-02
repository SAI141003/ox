#!/bin/sh
# Install ox from the latest GitHub release, without Gatekeeper's warning:
#
#   curl -fsSL https://raw.githubusercontent.com/SAI141003/ox/main/install.sh | sh
#
# A browser marks what it downloads as "from the internet" and macOS then
# refuses an app Apple has not notarized. curl adds no such mark, so OX.app
# opens normally. Same files as the release page; nothing else is installed.
set -eu

REPO="SAI141003/ox"
BASE="https://github.com/$REPO/releases/latest/download"
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say() { printf '%s\n' "$*"; }

case "$(uname -s)" in
  Darwin)
    # Where OX.app already is, else /Applications, else ~/Applications.
    apps="/Applications"
    if [ -d "$HOME/Applications/OX.app" ] || [ ! -w "$apps" ]; then apps="$HOME/Applications"; mkdir -p "$apps"; fi
    say "downloading OX.app ($ARCH)…"
    curl -fL --progress-bar "$BASE/ox-mac-$ARCH.zip" -o "$tmp/ox.zip"
    ditto -x -k "$tmp/ox.zip" "$tmp"
    pkill -x OX >/dev/null 2>&1 || true
    rm -rf "$apps/OX.app"
    mv "$tmp/OX.app" "$apps/OX.app"
    # In case the zip was ever fetched another way first.
    xattr -dr com.apple.quarantine "$apps/OX.app" 2>/dev/null || true
    # The `ox` command for the terminal, run by the Node inside the app.
    mkdir -p "$HOME/.local/bin"
    printf '#!/bin/sh\nexec "%s/OX.app/Contents/Resources/node" "%s/OX.app/Contents/Resources/ox/bin/ox.js" "$@"\n' "$apps" "$apps" > "$HOME/.local/bin/ox"
    chmod 755 "$HOME/.local/bin/ox"
    say "✓ OX.app is in $apps"
    open "$apps/OX.app"
    ;;
  Linux)
    [ "$ARCH" = x64 ] || { say "ox has no Linux $ARCH download yet: npm install -g github:$REPO"; exit 1; }
    say "downloading ox for Linux…"
    curl -fL --progress-bar "$BASE/ox-linux-x64.tar.gz" -o "$tmp/ox.tar.gz"
    tar -xzf "$tmp/ox.tar.gz" -C "$tmp"
    sh "$(find "$tmp" -maxdepth 2 -name install.sh | head -1)"
    ;;
  *)
    say "On Windows, in PowerShell:  irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex"
    exit 1
    ;;
esac

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "add ~/.local/bin to your PATH to type  ox  in a terminal" ;;
esac
