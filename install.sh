#!/bin/sh
# Install ox from a GitHub release, checked before anything is installed:
#
#   curl -fsSL https://raw.githubusercontent.com/SAI141003/ox/main/install.sh | sh
#   OX_VERSION=v0.1.7 sh install.sh        # an exact release instead of the newest
#
# What it does, in order:
#   1. resolves the release to an exact tag (the newest, or OX_VERSION) and says which;
#   2. downloads the file for this machine and its .sha256 from that release, and stops
#      if the checksum does not match;
#   3. when the GitHub CLI (gh) is installed, also checks GitHub's signed build
#      attestation: the file was built by this repository's release workflow;
#   4. only then installs. OX.app is not notarized by Apple (ox has no paid developer
#      account), so macOS would refuse to open it; the installer clears the
#      "downloaded" mark on the copy it just verified, and on nothing else;
#   5. does not open the app: open OX yourself when you are ready.
# Permissions (Accessibility, Screen Recording, Microphone) are never asked here or at
# launch: OX asks the first time you use something that needs one.
set -eu

REPO="SAI141003/ox"
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say() { printf '%s\n' "$*"; }
die() { say "✗ $*"; exit 1; }

# 1. An exact release.
TAG="${OX_VERSION:-}"
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##')"
fi
case "$TAG" in v[0-9]*) ;; *) die "could not find the release (got \"$TAG\"); set OX_VERSION=v…" ;; esac
BASE="https://github.com/$REPO/releases/download/$TAG"
say "ox $TAG"

sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

# 2 and 3. Download, then check, before anything is installed.
fetch_checked() {
  name="$1"
  say "downloading $name…"
  curl -fL --progress-bar "$BASE/$name" -o "$tmp/$name"
  curl -fsSL "$BASE/$name.sha256" -o "$tmp/$name.sha256" || die "$TAG publishes no checksum for $name: not installing an unchecked download (pick a newer release with OX_VERSION)"
  want="$(cut -d' ' -f1 < "$tmp/$name.sha256")"
  have="$(sha256 "$tmp/$name")"
  [ -n "$want" ] && [ "$want" = "$have" ] || die "checksum mismatch for $name: expected $want, got $have. Nothing was installed."
  say "✓ checksum $have"
  # gh gives no verdict until it is signed in, which says nothing about the file.
  if command -v gh >/dev/null 2>&1 && ! gh auth status >/dev/null 2>&1; then
    say "  (the GitHub CLI is not signed in: checked the checksum only. gh auth login adds the check of who built it)"
  elif command -v gh >/dev/null 2>&1; then
    if gh attestation verify "$tmp/$name" --repo "$REPO" >/dev/null 2>&1; then
      say "✓ built by $REPO's release workflow (GitHub attestation)"
    else
      die "GitHub could not confirm $name was built by $REPO's release workflow. Nothing was installed."
    fi
  else
    say "  (install the GitHub CLI, gh, to also check who built it)"
  fi
}

case "$(uname -s)" in
  Darwin)
    apps="/Applications"
    if [ -d "$HOME/Applications/OX.app" ] || [ ! -w "$apps" ]; then apps="$HOME/Applications"; mkdir -p "$apps"; fi
    fetch_checked "ox-mac-$ARCH.zip"
    ditto -x -k "$tmp/ox-mac-$ARCH.zip" "$tmp"
    pkill -x OX >/dev/null 2>&1 || true
    rm -rf "$apps/OX.app"
    mv "$tmp/OX.app" "$apps/OX.app"
    # 4. Only the copy just verified: OX.app is not notarized, so macOS would block it.
    xattr -dr com.apple.quarantine "$apps/OX.app" 2>/dev/null || true
    mkdir -p "$HOME/.local/bin"
    printf '#!/bin/sh\nexec "%s/OX.app/Contents/Resources/node" "%s/OX.app/Contents/Resources/ox/bin/ox.js" "$@"\n' "$apps" "$apps" > "$HOME/.local/bin/ox"
    chmod 755 "$HOME/.local/bin/ox"
    say "✓ OX.app $TAG is in $apps. Open it when you are ready (it asks for permissions only when a feature needs one)."
    ;;
  Linux)
    [ "$ARCH" = x64 ] || die "ox has no Linux $ARCH download yet: npm install -g github:$REPO"
    fetch_checked "ox-linux-x64.tar.gz"
    tar -xzf "$tmp/ox-linux-x64.tar.gz" -C "$tmp"
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
