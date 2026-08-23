#!/bin/bash
# Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

# Packages the renderer + main process into a double-clickable .app.
#
#   scripts/build-app.sh              # the real app, plus a dmg to hand out
#   scripts/build-app.sh --dev        # "Caden Dev", a separate install, no dmg
#   scripts/build-app.sh --dev --dmg  # ... with the dmg as well
#
# No electron-builder: the app has no runtime dependencies at all -- main.js
# needs `electron` (which the runtime provides) and server.js needs nothing but
# Node built-ins -- so packaging is copying Electron's own bundle, dropping the
# source into Contents/Resources/app, and rewriting the bundle identity.
#
# The two flavors are separate applications, not one app with a switch: a
# different bundle identifier, a different icon, and -- through the flavor.json
# written into the bundle below -- a different config directory, keychain
# service, local port range and daemon home. See app/flavor.js. A source
# checkout carries no flavor.json, so `npm start` is the development install
# too; only a build says otherwise, and only this script writes one.
set -euo pipefail
cd "$(dirname "$0")/.."

FLAVOR="prod"
MAKE_DMG=1
DMG_SET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dev)   FLAVOR="dev"; shift ;;
    --prod)  FLAVOR="prod"; shift ;;
    --dmg)   MAKE_DMG=1; DMG_SET=1; shift ;;
    --no-dmg) MAKE_DMG=0; DMG_SET=1; shift ;;
    *) echo "build-app.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$FLAVOR" = "dev" ]; then
  LABEL="Caden Dev"
  EXEC="CadenDev"
  BUNDLE_ID="app.caden.dev"
  ICON_SRC="app/icon-dev.png"
  # Not `Caden-Dev-`: the release workflow uploads `dist/Caden-*.dmg`, and a
  # development image sitting in dist/ would match that glob. Nothing after
  # `Caden` but a hyphen belongs to the real app.
  DMG_STEM="CadenDev"
  # A development build is for the machine that made it; the dmg is the slow
  # part of this script (Finder layout, then zlib-9 over ~100MB) and there is
  # nobody to hand it to. Ask for it with --dmg when there is.
  [ "$DMG_SET" -eq 1 ] || MAKE_DMG=0
else
  LABEL="Caden"
  EXEC="Caden"
  # Deliberately still `caden`: the bundle identity is what macOS files the app
  # under, and changing it makes this a different application to the system --
  # new permissions, and anything the OS remembered about the old one lost. The
  # name people read is CFBundleName below.
  BUNDLE_ID="app.caden.desktop"
  ICON_SRC="app/icon.png"
  DMG_STEM="Caden"
fi

APP="dist/$LABEL.app"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
SHELL_APP="node_modules/electron/dist/Electron.app"
VERSION=$(node -p "require('./package.json').version")

[ -d "$SHELL_APP" ] || { echo "run 'npm install' first — $SHELL_APP is missing" >&2; exit 1; }
[ -f "$ICON_SRC" ] || { echo "$ICON_SRC is missing — the $FLAVOR build needs it" >&2; exit 1; }

echo "==> building the $FLAVOR flavor: $LABEL ($BUNDLE_ID)"
if [ "$FLAVOR" = "prod" ]; then
  echo "    config ~/Library/Application Support/Caden, daemon home ~/.caden"
else
  echo "    config ~/Library/Application Support/Caden Dev, daemon home ~/.caden-dev"
fi

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
# What tells the packaged app which install it is. Written here rather than
# committed, so the repository has no flavor and a source checkout falls back
# to development.
printf '{"id":"%s"}\n' "$FLAVOR" > "$RES/app/flavor.json"
# The daemon source ships with the app: provisioning reads it out of the bundle
# and pipes it to the server over ssh.
cp -R server "$RES/server"

echo "==> building the icon"
# iconutil wants every size as its own file, so the flavor's 1024 source (with
# the transparent corners already cut) is the one input and the .icns is
# derived.
ICONSET=$(mktemp -d)/$EXEC.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size*2)) $((size*2)) "$ICON_SRC" \
       --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/$EXEC.icns"
rm -rf "$APP/Contents/Resources/electron.icns" "${ICONSET%/*}"

echo "==> rewriting the bundle identity"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$EXEC"
plist="$APP/Contents/Info.plist"
set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"
}
set_key CFBundleName "$LABEL"
set_key CFBundleDisplayName "$LABEL"
set_key CFBundleExecutable "$EXEC"
set_key CFBundleIdentifier "$BUNDLE_ID"
set_key CFBundleIconFile "$EXEC"
set_key CFBundleShortVersionString "$VERSION"
set_key CFBundleVersion "$VERSION"

# Modifying a signed bundle invalidates its signature, and macOS refuses to
# launch one on Apple silicon. Ad-hoc re-signing is enough for local use and
# for the "Open Anyway" distribution path; replace with a real Developer ID
# identity before notarizing.
echo "==> re-signing (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "   (codesign skipped)"

# Tell LaunchServices the bundle is new.
#
# Its icon record is keyed by bundle identifier, not by path, and it outlives
# any single build: a freshly built app inherited whatever icon was registered
# under `app.caden.desktop` the first time -- Electron's own -- and no amount of
# rebuilding shifted it. Finder showed a generic icon for a bundle that had a
# perfectly good .icns inside it.
[ -x "$LSR" ] && "$LSR" -f "$APP" >/dev/null 2>&1 || true

ARCH=$(uname -m)

if [ "$MAKE_DMG" -eq 0 ]; then
  echo "==> built $APP ($VERSION, $ARCH)"
  exit 0
fi

# A distributable image: drag-to-Applications, named with the version and the
# arch it was built on (the bundle is the local Electron, so a build on Apple
# silicon is arm64-only). No notarization, so first launch on another machine
# is the Privacy & Security "Open Anyway" dance -- README walks through it.
DMG="dist/$DMG_STEM-$VERSION-$ARCH.dmg"
STAGE=$(mktemp -d)/$EXEC
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
hdiutil create -volname "$LABEL" -srcfolder "$STAGE" -fs HFS+ -format UDRW \
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
osascript - "$VOL" "$(basename "$APP")" >/dev/null 2>&1 <<'APPLESCRIPT' &
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
      set position of item (item 2 of argv) to {150, 190}
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
