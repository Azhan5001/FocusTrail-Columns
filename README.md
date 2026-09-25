# FocusTrail Columns

A keyboard-driven file browser in the GNOME top bar, with side-by-side Miller columns, file operations, previews, and a visible focus trail. The active row gets a gray background and border. This repository packages the **Folders Column Browser Advanced V10.11 Focus Repair**, internal version **24**, retaining its original UUID `bookmarks-only@azhan` for upgrades.

## Drag files into WhatsApp and other apps

1. Open the destination app or website and its file drop area.
2. Open Folders, focus a local file, or select several files with Ctrl/Shift.
3. Press **Ctrl + Shift + D**, or right-click → **Drag to Another App…**.
4. Folders closes and **FocusTrail Drag** opens. Wait for **Ready**.
5. Press and hold on the file card in that window, drag onto the destination, then release. Check its attachment preview before sending.

This is a **two-step native drag workaround**. It does not transfer the original mouse press directly from a Shell row into the app. The GTK window creates a real OS drag, providing native file data and a URI list rather than pasting a filename. It offers COPY, so it does not move or delete the originals. The window closes automatically after the destination finishes reading a successful drag. Cancelled/rejected drops keep it open. Tick **Keep open after a successful drop** when you want to drag the same files repeatedly.

**Local files are supported.** Copy SFTP/phone-only files into Downloads first. Folders can be offered but only destinations that accept directories can use them; for WhatsApp, choose individual supported files. A destination still controls accepted formats, sizes, sandbox access, and the drop area. No universal acceptance guarantee is possible.

The **Open local drop test** button opens `drop-test.html`. Drop onto its blue box: it reports real browser File objects and attempts to read the first 16 bytes. It makes no network requests. If it passes but a website rejects a file, check the destination's supported formats/drop area.

If the drag window ends up behind WhatsApp, press **Super + F**, focus the file(s), then **Ctrl + Shift + D** again. The existing window is brought forward. If you selected different files, an idle window is replaced with the new selection; an active drag is never interrupted. The Keep open choice is retained when replacing an idle window, and defaults to off on a fresh launch.

The helper requires **GJS and GTK 4.8 or later** (GNOME 45-era GTK meets this API minimum). On Fedora, if missing:

```bash
sudo dnf install gjs gtk4
```

The installer checks actual GTK content-provider APIs before updating the extension. Read [the research and test report](docs/DRAG-DESIGN.md) for the approach, limits, and verification status.

## Essential shortcuts

**Super + F** and **Super + Shift + T** work globally. The other shortcuts require a focused row in the open Folders menu.

| Shortcut | Action |
| --- | --- |
| **Super + F** | Open Folders (customizable) |
| **Ctrl + Shift + D** | Open a native drag window for the focused file or multi-selection |
| **Up / Down** | Move between items |
| **Right / Enter** | Open a folder and focus the new column; Enter opens a file with its default app |
| **Left / Backspace** | Navigate back |
| **Shift + F10** or Menu key | Open the focused item's right-click menu |
| **Ctrl + C / X / V** | Copy / cut / paste files or folders |
| **Delete / Shift + Delete** | Move to Trash / permanently delete a child item |
| **Ctrl + Z / Ctrl + Shift + Z** | Undo / redo a supported file operation (Ctrl + Y also redoes) |
| **Ctrl + L** | Copy path or URI |
| **Shift + Enter** | Open the item in the system file manager |
| **Super + Shift + T** | Open Trash globally (customizable) |

Enter extracts an archive into the current folder. The context menu can instead extract it into a new folder. Bookmark roots are protected from Shift + Delete.

### Selection and other keys

| Shortcut | Action |
| --- | --- |
| Ctrl + click / Ctrl + Space | Toggle one selected item |
| Shift + click / Shift + Up / Down | Select a range |
| Ctrl + A | Select every item in the current real folder column |
| Escape | Clear multi-selection; with none selected, let GNOME close the menu |
| Ctrl + arrow | Move focus without clearing selection |
| Shift + Right | Move into an already-open next column |
| Ctrl + Shift + T | Open Trash when a row is focused |
| Ctrl + Shift + I / K | Inspect / clear preview cache |

Plain arrows and clicks on empty browser space clear multi-selection. Reopening the menu restores the deepest open path, focused row, and horizontal position.

## File explorer features

- **Column browsing:** Open nested folders side by side, starting with GTK bookmarks. Optional Places and Drives groups provide common locations and mounted volumes.
- **File actions:** Open in the default app, file manager, or terminal; create folders; copy, cut, paste, rename, inspect properties, move to Trash, permanently delete, and undo or redo supported operations. Context actions adapt to the selected row.
- **Multiple selection and sorting:** Operate on several files. Sort by name, type, size, or modification time in ascending or descending order.
- **Pin and unpin:** Right-click a folder and select **Pin Folder** to add it to GTK bookmarks. A pinned folder offers **Change Pinned Display Name…** and **Unpin Folder**. The display name changes the bookmark label; ordinary Rename changes the actual folder name. Unpinning does not delete the directory.
- **Previews:** Hover or keyboard focus can show images, text, PDFs, supported documents, and folder contents. Folder preview item count and decoded image size are adjustable. File coverage depends on format and available handlers.

## Preview cache

Preloading previewable files in open folders helps them appear quickly on subsequent focus or hover. Entries stay available while their folder is open. After a folder or menu closes, unused entries remain **60 seconds by default** (adjustable; zero clears immediately).

The default budget is **3 MB of estimated preview memory**. When full, the cache evicts older **least recently used** entries until the estimate is within the budget, retaining the newest preview where possible. It also removes expired entries. This is an estimated in-memory preview budget, not a disk quota or an exact cap on GNOME Shell process memory. Pinning a folder as a bookmark is separate from keeping its previews cached while open.

Inspect the cache with Ctrl + Shift + I, clear it with Ctrl + Shift + K, or monitor its status file:

```bash
watch -n 1 cat ~/.cache/bookmarks-only-preview-cache-status.txt
```

## Settings

Open preferences with `gnome-extensions prefs bookmarks-only@azhan`.

| Page | Controls |
| --- | --- |
| **Preview** | Master and separate file/folder preview switches; keyboard focus previews; rightmost-only mode; preloading; animation switches; opening, closing, and replacement timings; pointer exit delay; image size; folder item count; cache limit and retention |
| **Browser** | Places, Drives, hidden files, horizontal reveal/pan duration |
| **Shortcuts** | Global Open Folders and Open Trash shortcuts; reset all settings |

The pointer exit delay smooths row transitions; it is not an automatic preview lifetime. The two global bindings are customizable. Leaving the Trash shortcut empty disables that global binding. Other shortcuts in the tables work inside the menu.

## Install

Requires GNOME Shell, GJS, GTK 4.8+, `gnome-extensions`, and `glib-compile-schemas` (provided by `glib2` on Fedora). The metadata declares GNOME Shell 45–51; these declarations do not guarantee testing on each version.

Download and extract this repository or clone it. In the project directory run:

```bash
./install.sh
gnome-extensions info bookmarks-only@azhan
```

The expected internal version is **24**. The installer backs up an existing installation in `~/.local/share/bookmarks-only-backups/`, copies source into `~/.local/share/gnome-shell/extensions/bookmarks-only@azhan`, compiles the schema, and enables the extension. Existing settings under the same schema remain. After upgrading, log out and back in to reload Shell JavaScript modules. Merely disabling and enabling can leave imported modules cached.

If the installed schema is missing, run `./repair-current-install.sh` and check extension info again.

## Project files

| File | Purpose |
| --- | --- |
| `extension.js` | Menu, navigation, previews, cache, file operations |
| `prefs.js` | Settings window |
| `drag-bridge.js` | Launches the separate drag helper from Shell |
| `drag-helper.js` | Native GTK drag window and file providers |
| `drag-payload.js` | Selection validation and URI serialization |
| `drop-test.html` | Offline browser file-drop test |
| `tests/` | Payload, lifecycle, and installer checks |
| `metadata.json` | UUID and declared Shell versions |
| `schemas/` | GSettings schema, compiled during installation |
| `install.sh` | Installation and backup |
| `repair-current-install.sh` | Recompile the installed schema |

## License

No license is asserted in this package. Add one after confirming the rights to all included code.

## Developer checks

```bash
node --test tests/*.test.mjs
python3 tests/test_install.py
gjs -m drag-helper.js --check
```

The first two commands test logic and installation with mocked desktop commands. The third checks real GJS/GTK provider construction; it does not perform a desktop drag. End-to-end validation requires a running GNOME session and a receiving browser/application.

## Updating an existing GitHub repository

Copy this build's source files, helper files, docs, tests and installer into your existing working tree. Keep its `.git` directory and any `LICENSE` you already added. Review `git diff`, then commit and push. Installing the extension and updating your GitHub checkout are separate operations.
