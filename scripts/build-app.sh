#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Packages the renderer + main process into a double-clickable dist/Caden.app.
#
#   scripts/build-app.sh
#
# No electron-builder: the app has no runtime dependencies at all -- main.js
# needs `electron` (which the runtime provides) and server.js needs nothing but
# Node built-ins -- so packaging is copying Electron's own bundle, dropping the
# source into Contents/Resources/app, and rewriting the bundle identity.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/Caden.app"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
SHELL_APP="node_modules/electron/dist/Electron.app"
VERSION=$(node -p "require('./package.json').version")

[ -d "$SHELL_APP" ] || { echo "run 'npm install' first — $SHELL_APP is missing" >&2; exit 1; }

echo "==> copying the Electron shell"
rm -rf "$APP"; mkdir -p dist
cp -R "$SHELL_APP" "$APP"

echo "==> adding the app payload"
RES="$APP/Contents/Resources/app"
mkdir -p "$RES"
cp package.json "$RES/"
cp -R app "$RES/app"
rm -rf "$RES/app/verify"          # DOM-parity tooling, not part of the product
find "$RES" -name .DS_Store -delete
# The daemon source ships with the app: provisioning reads it out of the bundle
# and pipes it to the server over ssh.
cp -R server "$RES/server"

echo "==> building the icon"
# iconutil wants every size as its own file, so app/icon.png (1024, with the
# transparent corners already cut) is the one source and the .icns is derived.
ICONSET=$(mktemp -d)/Caden.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size app/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size*2)) $((size*2)) app/icon.png \
       --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Caden.icns"
rm -rf "$APP/Contents/Resources/electron.icns" "${ICONSET%/*}"

echo "==> rewriting the bundle identity"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Caden"
plist="$APP/Contents/Info.plist"
set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"
}
set_key CFBundleName Caden
set_key CFBundleDisplayName Caden
set_key CFBundleExecutable Caden
# Deliberately still `caden`: the bundle identity is what macOS files the app
# under, and changing it makes this a different application to the system --
# new permissions, and anything the OS remembered about the old one lost. The
# name people read is CFBundleName above.
set_key CFBundleIdentifier app.caden.desktop
set_key CFBundleIconFile Caden
set_key CFBundleShortVersionString "$VERSION"
set_key CFBundleVersion "$VERSION"

# Modifying a signed bundle invalidates its signature, and macOS refuses to
# launch one on Apple silicon. Ad-hoc re-signing is enough for local use and
# for the "Open Anyway" distribution path; replace with a real Developer ID
# identity before notarizing.
echo "==> re-signing (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "   (codesign skipped)"

# A distributable image: drag-to-Applications, named with the version and the
# arch it was built on (the bundle is the local Electron, so a build on Apple
# silicon is arm64-only). No notarization, so first launch on another machine
# is the Privacy & Security "Open Anyway" dance -- README walks through it.
# Tell LaunchServices the bundle is new.
#
# Its icon record is keyed by bundle identifier, not by path, and it outlives
# any single build: a freshly built app inherited whatever icon was registered
# under `app.caden.desktop` the first time -- Electron's own -- and no amount of
# rebuilding shifted it. Finder showed a generic icon for a bundle that had a
# perfectly good .icns inside it.
[ -x "$LSR" ] && "$LSR" -f "$APP" >/dev/null 2>&1 || true

ARCH=$(uname -m)
DMG="dist/Caden-$VERSION-$ARCH.dmg"
STAGE=$(mktemp -d)/Caden
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
echo "==> building $DMG"
# hdiutil refuses to write over an image that is already there, so a second
# build of the same version used to fail on its last step with "File exists" --
# after the bundle had already been replaced, leaving dist/ half a version ahead
# of its own dmg. Built beside the real name and moved into place instead of
# clearing it first: hdiutil also fails with a transient "Resource busy" when
# something else is still holding the freshly signed bundle, and deleting the
# old image up front turns that retryable hiccup into no dmg at all.
# The staging name ends in .dmg too: hdiutil appends the extension itself when
# the path it is given does not have it, and would leave the image somewhere
# other than where the move looks for it.
STAGED="dist/.$(basename "$DMG" .dmg).staging.dmg"
RW="dist/.$(basename "$DMG" .dmg).rw.dmg"
rm -f "$STAGED" "$RW"

# Built writable first so the window can be laid out, then compressed.
#
# An image made straight from a folder carries no window settings at all, so
# Finder falls back to its defaults: a window sized to the screen, the two
# items auto-arranged alphabetically -- Applications first, which is the wrong
# way round for something you drag left to right -- and a sea of empty space
# under them. The layout below is what turns that into an instruction.
hdiutil create -volname "Caden" -srcfolder "$STAGE" -fs HFS+ -format UDRW \
               "$RW" >/dev/null

# Mounted where Finder can see it: it addresses a volume by name, and an
# image attached at a path of our choosing is not a disk as far as it is
# concerned. The name comes back from hdiutil rather than being assumed --
# a leftover /Volumes/Caden would push this one to "Caden 1".
MOUNT=$(hdiutil attach "$RW" -readwrite -noverify -noautoopen | grep -o '/Volumes/.*' | tail -1)
VOL=$(basename "$MOUNT")

# Finder can be slow or wedged, and this is a nicety: never let it hold the
# build. It runs on a leash, and an image that misses out on its layout is
# still a perfectly good image -- just the default one, with the two items
# auto-arranged alphabetically and a window the size of the screen.
osascript - "$VOL" >/dev/null 2>&1 <<'APPLESCRIPT' &
on run argv
  tell application "Finder"
    tell disk (item 1 of argv)
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 160, 800, 580}
      set opts to the icon view options of container window
      set arrangement of opts to not arranged
      set icon size of opts to 104
      set text size of opts to 13
      -- left to right, in the order the gesture goes
      set position of item "Caden.app" to {150, 190}
      set position of item "Applications" to {450, 190}
      update without registering applications
      delay 1
      close
    end tell
  end tell
end run
APPLESCRIPT
LAYOUT=$!
for _ in $(seq 1 30); do kill -0 "$LAYOUT" 2>/dev/null || break; sleep 1; done
kill -9 "$LAYOUT" 2>/dev/null || true
wait "$LAYOUT" 2>/dev/null || true
[ -s "$MOUNT/.DS_Store" ] || echo "   (window layout skipped -- Finder would not play)"

# Take the mounted copy back out of the LaunchServices database before the
# volume goes away.
#
# macOS registers every app it sees on a mounted volume, and the record
# outlives the mount: after a few builds the identifier `app.caden.desktop`
# had seven bundles claiming it, six of them on volumes that no longer
# existed. LaunchServices picks one of those as the canonical bundle, and
# picking a dead one is why Finder drew a generic icon for an app whose .icns
# was sitting right there.
[ -x "$LSR" ] && "$LSR" -u "$MOUNT/$(basename "$APP")" >/dev/null 2>&1 || true

sync
hdiutil detach "$MOUNT" -quiet || hdiutil detach "$MOUNT" -force -quiet || true

hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$STAGED" >/dev/null
rm -f "$RW"
mv -f "$STAGED" "$DMG"
rm -rf "$(dirname "$STAGE")"

echo "==> built $APP ($VERSION, $ARCH)"
echo "    $DMG"
