#!/bin/sh
# Builds TDK App and installs it so it shows up in Launchpad, Spotlight and Finder > Applications.
# Installs to /Applications when writable, otherwise ~/Applications. Never uses sudo.
set -eu
cd "$(dirname "$0")/.."
./macos/build.sh
SRC="dist/TDK App.app"

if [ -w /Applications ]; then DEST_DIR=/Applications; else DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
DEST="$DEST_DIR/TDK App.app"

# Quit a running copy so it can be replaced.
osascript -e 'tell application "TDK App" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
touch "$DEST"
echo "Installed $DEST"
echo "Open it from Launchpad or Spotlight, or run: open -a \"TDK App\""
