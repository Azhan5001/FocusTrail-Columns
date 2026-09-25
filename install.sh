#!/usr/bin/env bash
set -euo pipefail

UUID="bookmarks-only@azhan"
BASE="$HOME/.local/share/gnome-shell/extensions"
DEST="$BASE/$UUID"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
BACKUP_ROOT="$HOME/.local/share/bookmarks-only-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BASE" "$BACKUP_ROOT"

# Move backups created by older installers out of GNOME's extension directory.
# GNOME scans every directory there and complains when metadata UUID != dirname.
shopt -s nullglob
for OLD in "$BASE/${UUID}.backup-"*; do
    mv "$OLD" "$BACKUP_ROOT/$(basename "$OLD")"
done
shopt -u nullglob

if [[ -d "$DEST" ]]; then
    cp -a "$DEST" "$BACKUP_ROOT/${UUID}.backup-${STAMP}"
fi

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$DEST"
mkdir -p "$DEST"

cp "$HERE/extension.js" "$DEST/extension.js"
cp "$HERE/prefs.js" "$DEST/prefs.js"
cp "$HERE/metadata.json" "$DEST/metadata.json"
cp -a "$HERE/schemas" "$DEST/schemas"

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "ERROR: glib-compile-schemas is missing." >&2
    echo "On Fedora, repair/install it with: sudo dnf install glib2" >&2
    exit 1
fi

glib-compile-schemas "$DEST/schemas"

if [[ ! -s "$DEST/schemas/gschemas.compiled" ]]; then
    echo "ERROR: schema compilation did not create $DEST/schemas/gschemas.compiled" >&2
    exit 1
fi

echo "Compiled settings schema: $DEST/schemas/gschemas.compiled"

gnome-extensions enable "$UUID"

echo
printf 'Installed FocusTrail Columns V10.11 focus repair.\n'
printf 'Expected: Version 22, State ACTIVE.\n'
printf 'Run: gnome-extensions info %s\n' "$UUID"
printf 'Settings: gnome-extensions prefs %s\n' "$UUID"
printf 'Backup directory: %s\n' "$BACKUP_ROOT"
