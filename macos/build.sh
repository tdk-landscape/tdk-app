#!/bin/sh
# Builds a lightweight TDK App.app (native WKWebView shell + bundled server sources).
# Requires Xcode Command Line Tools; the app uses Node.js 22.12+ from your PATH.
set -eu
cd "$(dirname "$0")/.."
APP="dist/TDK App.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
swiftc -O -o "$APP/Contents/MacOS/TDKApp" macos/main.swift
cp -R src public package.json "$APP/Contents/Resources/app/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>TDK App</string>
<key>CFBundleIdentifier</key><string>com.tdk-landscape.tdk-app</string>
<key>CFBundleExecutable</key><string>TDKApp</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP ($(du -sh "$APP" | cut -f1))"
