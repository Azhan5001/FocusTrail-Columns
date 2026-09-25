#!/usr/bin/env bash
set -euo pipefail

UUID="bookmarks-only@azhan"
BASE="$HOME/.local/share/gnome-shell/extensions"
DEST="$BASE/$UUID"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
BACKUP_ROOT="$HOME/.local/share/bookmarks-only-backups"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"

# Check the complete payload before changing the working installation.
for program in gjs glib-compile-schemas gnome-extensions; do
    if ! command -v "$program" >/dev/null 2>&1; then
        printf 'Missing required command: %s\n' "$program" >&2
        printf 'On Fedora: sudo dnf install gjs gtk4 glib2 gnome-shell\n' >&2
        exit 1
    fi
done
for file in extension.js prefs.js metadata.json drag-bridge.js drag-helper.js drag-payload.js drop-test.html; do
    test -s "$HERE/$file" || { printf 'Missing file: %s\n' "$file" >&2; exit 1; }
done
if ! gjs -m "$HERE/drag-helper.js" --check; then
    printf 'Drag helper dependency check failed. On Fedora: sudo dnf install gjs gtk4\n' >&2
    exit 1
fi
glib-compile-schemas --strict --dry-run "$HERE/schemas"

mkdir -p "$BASE" "$BACKUP_ROOT"
STAGING="$(mktemp -d "$BACKUP_ROOT/install-$STAMP-XXXXXX")"
for file in extension.js prefs.js metadata.json drag-bridge.js drag-helper.js drag-payload.js drop-test.html; do
    cp "$HERE/$file" "$STAGING/$file"
done
cp -a "$HERE/schemas" "$STAGING/schemas"
glib-compile-schemas --strict "$STAGING/schemas"
test -s "$STAGING/schemas/gschemas.compiled"

shopt -s nullglob
for OLD in "$BASE/${UUID}.backup-"*; do
    mv "$OLD" "$BACKUP_ROOT/$(basename "$OLD")-$STAMP"
done
shopt -u nullglob

gnome-extensions disable "$UUID" 2>/dev/null || true
BACKUP="$BACKUP_ROOT/${UUID}.backup-$STAMP"
if [[ -e "$DEST" ]]; then
    mv "$DEST" "$BACKUP"
fi
if ! mv "$STAGING" "$DEST"; then
    if [[ -d "$BACKUP" ]]; then
        mv "$BACKUP" "$DEST"
        gnome-extensions enable "$UUID" 2>/dev/null || true
    fi
    printf 'Install failed; the previous files have been restored where available.\n' >&2
    exit 1
fi
if ! gnome-extensions enable "$UUID"; then
    printf 'Files installed. Log out and back in, then enable %s.\n' "$UUID"
fi
printf '\nInstalled FocusTrail Columns Drag, internal version 25.\n'
printf 'Select files in Folders, press Ctrl+Shift+D, then drag from the new window.\n'
printf 'After an upgrade, log out and back in so Shell reloads imported modules.\n'
printf 'Check: gnome-extensions info %s\n' "$UUID"
printf 'Previous installation (if present): %s\n' "$BACKUP"
