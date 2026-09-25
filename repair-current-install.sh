#!/usr/bin/env bash
set -euo pipefail
UUID="bookmarks-only@azhan"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SCHEMA="$DEST/schemas"

if [[ ! -f "$SCHEMA/org.gnome.shell.extensions.bookmarks-only.gschema.xml" ]]; then
    echo "Schema XML missing from: $SCHEMA" >&2
    exit 1
fi

command -v glib-compile-schemas >/dev/null 2>&1 || {
    echo "glib-compile-schemas is missing. On Fedora: sudo dnf install glib2" >&2
    exit 1
}

glib-compile-schemas "$SCHEMA"
test -s "$SCHEMA/gschemas.compiled"
ls -lh "$SCHEMA/gschemas.compiled"

gnome-extensions disable "$UUID" 2>/dev/null || true
gnome-extensions enable "$UUID"
gnome-extensions info "$UUID"
