#!/usr/bin/env bash
# Klyppr installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/muzafferkadir/klyppr-desktop/main/install.sh | bash
# Downloads the latest .dmg from GitHub Releases, installs Klyppr.app into
# /Applications, and clears the quarantine flag (the app is ad-hoc signed).
# FFmpeg is downloaded by the app itself on first launch.
set -euo pipefail

REPO="muzafferkadir/klyppr-desktop"
APP="Klyppr.app"

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS. On Windows use install.ps1 (see the README)." >&2
  exit 1
fi

echo "Fetching the latest Klyppr release…"
API="https://api.github.com/repos/$REPO/releases/latest"
ASSETS="$(curl -fsSL "$API" | grep -o 'https://[^"]*\.dmg')"
# Universal .dmg runs on both Apple Silicon and Intel; fall back to an
# arch-specific build if only those are published.
case "$(uname -m)" in
  arm64) ARCH_PAT="aarch64.dmg" ;;
  x86_64) ARCH_PAT="x64.dmg" ;;
  *) ARCH_PAT="aarch64.dmg" ;;
esac
URL="$(echo "$ASSETS" | grep 'universal.dmg' | head -n1)"
[ -z "$URL" ] && URL="$(echo "$ASSETS" | grep "$ARCH_PAT" | head -n1)"
if [ -z "$URL" ]; then
  echo "No macOS .dmg found in the latest release." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DMG="$TMP/klyppr.dmg"

echo "Downloading $(basename "$URL")…"
curl -fSL --progress-bar "$URL" -o "$DMG"

echo "Mounting…"
MNT="$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | head -n1)"
trap 'hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

echo "Installing to /Applications…"
rm -rf "/Applications/$APP"
cp -R "$MNT/$APP" /Applications/

hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
trap 'rm -rf "$TMP"' EXIT

echo "Clearing quarantine…"
xattr -dr com.apple.quarantine "/Applications/$APP" 2>/dev/null || true

echo "✅ Klyppr installed. Launch it from Applications (or: open -a Klyppr)."
