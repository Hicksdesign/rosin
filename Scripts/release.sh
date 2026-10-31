#!/bin/zsh
# Packages an exported, notarized Rosin.app for Sparkle:
#   1. Checks it's signed with Developer ID, notarized and stapled.
#   2. Zips it into the releases folder as Rosin-<version>.zip (ditto, which
#      keeps the signature intact).
#   3. Runs Sparkle's generate_appcast over the folder, which signs the zip,
#      makes deltas from the older zips and updates appcast.xml.
#   4. Lists the files to upload to rosin.hicks.design.
#
# Usage: Scripts/release.sh [path/to/Rosin.app]
#   Default app: Rosin.app in the releases folder (where Xcode's export put it).
#   Release notes: put Rosin-<version>.html in the releases folder first.
#   SPARKLE_ACCOUNT=<name> signs with a keychain key other than the default.
#
# Keep every zip in the releases folder: generate_appcast needs the old ones
# to keep them in the appcast and to make deltas.

set -euo pipefail

RELEASES=${ROSIN_RELEASES:-~/Herd/rosin/releases}
DOWNLOAD_PREFIX=https://rosin.hicks.design/
BUNDLE_ID=design.hicks.Rosin
APP=${1:-$RELEASES/Rosin.app}

fail() { print -u2 "✘ $1"; exit 1; }
step() { print "\n▸ $1"; }

[[ -d $APP ]] || fail "No app at $APP. Export it from Xcode's Organizer first."
plist=$APP/Contents/Info.plist
read_plist() { /usr/libexec/PlistBuddy -c "Print $1" "$plist" 2>/dev/null || true; }

# Sparkle's tools come with the package, in whichever DerivedData folder has it.
SPARKLE_BIN=(~/Library/Developer/Xcode/DerivedData/Rosin-*/SourcePackages/artifacts/sparkle/Sparkle/bin(N))
[[ -n ${SPARKLE_BIN[1]:-} ]] || fail "Sparkle's tools not found. Build Rosin in Xcode once so the package downloads."
SPARKLE_BIN=${SPARKLE_BIN[1]}

# MARK: 1. Check

step "Checking $APP"
[[ $(read_plist CFBundleIdentifier) == $BUNDLE_ID ]] || fail "Bundle ID isn't $BUNDLE_ID."
[[ -n $(read_plist SUFeedURL) && -n $(read_plist SUPublicEDKey) ]] \
  || fail "SUFeedURL or SUPublicEDKey is empty, so this build couldn't update itself."
codesign --verify --deep --strict "$APP" || fail "Code signature is invalid."
spctl --assess --type execute -vv "$APP" 2>&1 | grep -q "source=Notarized Developer ID" \
  || fail "Gatekeeper doesn't accept it as notarized. Use Distribute App ▸ Direct Distribution, then Export."
xcrun stapler validate -q "$APP" || fail "No stapled notarization ticket. Export again once Xcode says Ready to distribute."

VERSION=$(read_plist CFBundleShortVersionString)
BUILD=$(read_plist CFBundleVersion)
print "  Rosin $VERSION (build $BUILD): signed, notarized, stapled"

# MARK: 2. Zip

ZIP=$RELEASES/Rosin-$VERSION.zip
NOTES=$RELEASES/Rosin-$VERSION.html
step "Zipping to $ZIP"
if [[ -e $ZIP ]]; then
  # Replacing a zip testers may already have downloaded would break its
  # signature in the appcast, so only do it on purpose.
  read -q "?  $ZIP:t already exists. Replace it? Only if it isn't uploaded yet. [y/N] " || { print; fail "Stopped; nothing changed."; }
  print
  rm "$ZIP"
fi
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
[[ -e $NOTES ]] || print "  No $NOTES:t, so the update window will have no release notes."

# MARK: 3. Appcast

step "Generating appcast.xml"
marker=$(mktemp)
trap 'rm -f "$marker"' EXIT
"$SPARKLE_BIN/generate_appcast" ${SPARKLE_ACCOUNT:+--account "$SPARKLE_ACCOUNT"} \
  --download-url-prefix "$DOWNLOAD_PREFIX" "$RELEASES"

# MARK: 4. Upload list

step "Upload these to $DOWNLOAD_PREFIX"
uploads=("$RELEASES/appcast.xml" "$ZIP")
[[ -e $NOTES ]] && uploads+=("$NOTES")
uploads+=("$RELEASES"/*.delta(N))
for file in $uploads; do
  # Deltas from earlier releases are already up; only list new ones.
  [[ $file == *.delta && ! $file -nt $marker ]] && continue
  print "  $file:t"
done
