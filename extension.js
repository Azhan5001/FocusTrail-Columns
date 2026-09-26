import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {DragBridge} from './drag-bridge.js';

/*
 * Ensure the extension-local GSettings schema is compiled before GNOME Shell
 * tries to load it. This makes manual installs/copies self-healing instead of
 * leaving the extension in ERROR when gschemas.compiled is missing.
 */
function _ensureCompiledSchema(extensionPath) {
    const schemaDir = GLib.build_filenamev([extensionPath, 'schemas']);
    const schemaXml = GLib.build_filenamev([
        schemaDir,
        'org.gnome.shell.extensions.bookmarks-only.gschema.xml',
    ]);
    const compiled = GLib.build_filenamev([schemaDir, 'gschemas.compiled']);

    if (GLib.file_test(compiled, GLib.FileTest.EXISTS))
        return;

    if (!GLib.file_test(schemaXml, GLib.FileTest.EXISTS))
        throw new Error(`Folders: settings schema XML is missing: ${schemaXml}`);

    const compiler = GLib.find_program_in_path('glib-compile-schemas');
    if (!compiler) {
        throw new Error(
            'Folders: glib-compile-schemas was not found. On Fedora, install/repair the glib2 package.'
        );
    }

    const [spawned, _stdout, stderr, status] = GLib.spawn_sync(
        null,
        [compiler, schemaDir],
        null,
        GLib.SpawnFlags.DEFAULT,
        null
    );

    if (!spawned || status !== 0 ||
        !GLib.file_test(compiled, GLib.FileTest.EXISTS)) {
        let detail = '';
        try {
            detail = new TextDecoder().decode(stderr ?? new Uint8Array()).trim();
        } catch {
            // Keep the simpler error below.
        }
        throw new Error(
            `Folders: failed to compile GSettings schema${detail ? `: ${detail}` : ''}`
        );
    }

    console.log(`Folders settings: compiled schema at ${compiled}`);
}


/*
 * Promise wrappers used by the file-operation shortcuts.
 * Keeping copy/move/trash asynchronous prevents large operations from
 * blocking GNOME Shell's UI thread.
 */
function _safePromisify(prototype, asyncName, finishName = null) {
    try {
        if (typeof prototype?.[asyncName] !== 'function')
            return;

        if (finishName)
            Gio._promisify(prototype, asyncName, finishName);
        else
            Gio._promisify(prototype, asyncName);
    } catch (error) {
        // Some GNOME Shell modules may already have promisified a method.
        console.debug(`Folders: promisify skipped for ${asyncName}: ${error}`);
    }
}

_safePromisify(Gio.File.prototype, 'copy_async');
_safePromisify(Gio.File.prototype, 'delete_async');
_safePromisify(Gio.File.prototype, 'enumerate_children_async');
_safePromisify(Gio.File.prototype, 'load_contents_async');
_safePromisify(Gio.File.prototype, 'make_directory_async');
_safePromisify(Gio.File.prototype, 'move_async');
_safePromisify(Gio.File.prototype, 'query_info_async');
_safePromisify(Gio.File.prototype, 'replace_contents_async');
_safePromisify(Gio.File.prototype, 'trash_async');
_safePromisify(Gio.FileEnumerator.prototype, 'next_files_async');
_safePromisify(Gio.Subprocess.prototype, 'communicate_utf8_async');


/*
 * =========================================================
 * SETTINGS
 * =========================================================
 */

const MAX_BROWSER_WIDTH = 850;
const BROWSER_HEIGHT = 480;
const COLUMN_WIDTH = 250;

/*
 * Experimental preview settings.
 * Preview data is intentionally small and short-lived so this extension does
 * not become an unbounded image/document cache inside GNOME Shell.
 */
const PREVIEW_COLUMN_WIDTH = COLUMN_WIDTH;
const PREVIEW_TEXT_LIMIT = 3500;
const PREVIEW_TEXT_MAX_FILE_BYTES = 1024 * 1024;
const PREVIEW_CACHE_SWEEP_MS = 1_000;
const PREVIEW_PRELOAD_DELAY_MS = 35;
const PREVIEW_CACHE_STATUS_FILENAME = 'bookmarks-only-preview-cache-status.txt';

/* Fallbacks used only if GSettings is temporarily unavailable. */
const DEFAULT_PREVIEW_IMAGE_SIZE = 192;
const DEFAULT_PREVIEW_CACHE_RETENTION_SECONDS = 60;
const DEFAULT_PREVIEW_CACHE_LIMIT_MB = 3.0;
const DEFAULT_FOLDER_PREVIEW_MAX_ITEMS = 14;
const DEFAULT_MOUSE_PREVIEW_CLOSE_DELAY_MS = 200;
const DEFAULT_PREVIEW_OPEN_DURATION_MS = 130;
const DEFAULT_PREVIEW_CLOSE_DURATION_MS = 220;
const DEFAULT_PREVIEW_SWITCH_DURATION_MS = 70;
const DEFAULT_HORIZONTAL_PAN_DURATION_MS = 260;
const COLUMN_OPEN_DURATION_MS = 150;
const COLUMN_CLOSE_DURATION_MS = 140;

/*
 * Used only if USE_MEASURED_COLUMN_WIDTHS = false.
 */
const WIDTH_ALLOWANCE = 14;


/*
 * ---------------------------------------------------------
 * VERTICAL -> HORIZONTAL SCROLL DELAY
 * ---------------------------------------------------------
 *
 * Applies ONLY when:
 *
 * 1. The column genuinely has vertical overflow
 * 2. You reach the top/bottom
 * 3. You continue scrolling in that direction
 *
 * Columns with NO vertical scrolling switch horizontally
 * immediately.
 */
const EDGE_TO_HORIZONTAL_DELAY_MS = 400;


/*
 * ---------------------------------------------------------
 * REVERSIBLE JITTER FIX
 * ---------------------------------------------------------
 *
 * true:
 *   Use the actual preferred width of every rendered column.
 *
 * false:
 *   Restore the older calculated width.
 */
const USE_MEASURED_COLUMN_WIDTHS = true;


const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);


/*
 * Explicit keyboard focus styling.  Do not rely on the current GNOME Shell
 * theme to make :focus visible for our custom St.Button rows.
 */
const DEBUG_FOCUS = false;

const ROW_NORMAL_STYLE = `
    padding: 6px 7px;
    border: 1px solid transparent;
    border-radius: 6px;
`;

const ROW_FOCUS_STYLE = `
    padding: 6px 7px;
    border: 1px solid rgba(210, 210, 210, 0.95);
    border-radius: 6px;
    background-color: rgba(190, 190, 190, 0.18);
`;

const ROW_SELECTED_STYLE = `
    padding: 6px 7px;
    border: 1px solid rgba(80, 145, 220, 0.60);
    border-radius: 6px;
    background-color: rgba(80, 145, 220, 0.22);
`;

const ROW_SELECTED_FOCUS_STYLE = `
    padding: 6px 7px;
    border: 1px solid rgba(100, 165, 240, 0.95);
    border-radius: 6px;
    background-color: rgba(80, 145, 220, 0.34);
`;


/*
 * =========================================================
 * PANEL BUTTON
 * =========================================================
 */

const BookmarksIndicator = GObject.registerClass(
class BookmarksIndicator extends PanelMenu.Button {
    _init(settings = null, extensionPath = '') {
        super._init(
            0.0,
            'Folders Column Browser',
            false
        );

        this._panelLabel = new St.Label({
            text: 'Folders',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(
            this._panelLabel
        );

        this._settings = settings;
        this._settingsChangedIds = [];
        this._dragBridge = new DragBridge(extensionPath, message =>
            Main.notifyError('FocusTrail Drag', message));


        /*
         * Stores the start time of the edge delay
         * independently for each vertical column.
         */
        this._edgeScrollState =
            new WeakMap();


        /*
         * Keyboard/file-operation state.
         */
        this._columnRows = [];
        this._columnScrolls = [];
        this._lastFocusedRows = new Map();
        this._columnDirectories = [];
        this._columnLists = [];
        this._clipboardFiles = [];
        this._clipboardMode = null;
        this._clipboardRow = null;
        this._undoStack = [];
        this._redoStack = [];
        this._fileOperationBusy = false;
        this._statusTimeoutId = 0;
        this._contextMenuManager = new PopupMenu.PopupMenuManager(this);
        this._contextMenu = null;
        this._sortSettings = new Map();
        this._stageContextShortcutId = 0;

        /* Multi-selection is intentionally scoped to one real folder column. */
        this._multiSelectedUris = new Set();
        this._multiSelectionDepth = null;
        this._selectionAnchorByDepth = new Map();

        /*
         * Pointer-vs-keyboard arbitration. Any keyboard action temporarily
         * suppresses hover side effects. Hover becomes active again only
         * after real pointer motion, so a stationary pointer cannot steal
         * focus when the inspector preview changes.
         */
        this._mouseHoverSuppressed = false;
        this._folderHoverTimeoutId = 0;
        this._folderHoverRow = null;

        /* Smooth horizontal viewport animation state. */
        this._horizontalPanSourceId = 0;
        this._suppressKeyboardPreviewOnce = false;
        this._suppressColumnRevealOnce = false;

        /* Preview/cache state. */
        this._previewColumn = null;
        this._previewBox = null;
        this._previewSourceDepth = null;
        this._previewSourceRow = null;
        this._previewSourceMode = null;
        // A preview opened from the rightmost real Miller column is sticky:
        // it remains visible after pointer leave until another preview replaces
        // it or its source column is closed.
        this._previewStickyRightmost = false;
        this._previewCurrentKey = null;
        this._previewHideTimeoutId = 0;
        this._previewFadingActor = null;
        this._previewToken = 0;
        this._previewCache = new Map();
        this._previewCacheSweepId = 0;
        this._previewPreloadSourceId = 0;
        this._previewPreloadQueue = [];
        this._previewPreloadQueuedKeys = new Set();
        this._previewDisposed = false;
        this._menuIsOpen = false;
        // Keep our own keyboard-focus pointer instead of depending only on
        // GNOME Shell theme pseudo-classes/signals for the visible highlight.
        this._explicitFocusedRow = null;
        this._previewStatusPath = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            PREVIEW_CACHE_STATUS_FILENAME,
        ]);


        this._connectSettings();
        this._buildBrowser();


        /*
         * Shift+F10 / Menu are also captured at stage level while our menu is
         * open. Some Shell/theme combinations consume these keys before the
         * focused St.Button receives key-press-event.
         */
        try {
            this._stageContextShortcutId = global.stage.connect(
                'captured-event',
                (_stage, event) => this._handleGlobalContextShortcut(event)
            );
        } catch (error) {
            console.error(`Folders: context shortcut capture failed: ${error}`);
        }


        this.menu.connect(
            'open-state-changed',
            (_menu, isOpen) => {
                this._menuIsOpen = isOpen;

                if (!isOpen) {
                    this._closeContextMenu();
                    this._cancelFolderHoverOpen();
                    this._cancelPreviewHideDelay();
                    this._mouseHoverSuppressed = false;
                    this._previewToken++;
                    this._hidePreview(false);
                    // Keep the entire Miller-column path intact while the
                    // topbar menu is closed. Reopening restores the viewport
                    // to the deepest open folder instead of destroying it.
                    this._clearMultiSelection();
                    this._cancelPreviewPreloadQueue();
                    this._syncPreviewCachePins('menu closed');
                    this._writePreviewCacheStatus();
                    return;
                }

                this._syncPreviewCachePins('menu opened');
                this._queueOpenFolderPreviewPreloads();
                this._writePreviewCacheStatus();

                this._debugFocus('menu opened; restoring deepest column focus');

                GLib.idle_add(
                    GLib.PRIORITY_DEFAULT_IDLE,
                    () => {
                        this._focusRightmostOpenRow();
                        this._scrollToRightmostFolderSmooth();
                        return GLib.SOURCE_REMOVE;
                    }
                );

                // A short second pass handles the allocation change that can
                // happen while the popup finishes opening.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
                    if (this._menuIsOpen)
                        this._scrollToRightmostFolderSmooth();
                    return GLib.SOURCE_REMOVE;
                });
            }
        );

        this.connect('destroy', () => {
            this._dragBridge.destroy();
            this._disconnectSettings();
            this._closeContextMenu();
            this._cancelFolderHoverOpen();
            this._cancelPreviewHideDelay();
            this._cancelHorizontalPan();

            if (this._stageContextShortcutId) {
                try {
                    global.stage.disconnect(this._stageContextShortcutId);
                } catch {
                    // Ignore.
                }
                this._stageContextShortcutId = 0;
            }

            if (this._statusTimeoutId) {
                GLib.source_remove(this._statusTimeoutId);
                this._statusTimeoutId = 0;
            }

            this._disposePreviewCache();
        });
    }


    /*
     * =====================================================
     * SETTINGS HELPERS
     * =====================================================
     */

    _settingBoolean(key, fallback) {
        try {
            return this._settings?.get_boolean(key) ?? fallback;
        } catch {
            return fallback;
        }
    }


    _settingInt(key, fallback) {
        try {
            return this._settings?.get_int(key) ?? fallback;
        } catch {
            return fallback;
        }
    }


    _settingDouble(key, fallback) {
        try {
            return this._settings?.get_double(key) ?? fallback;
        } catch {
            return fallback;
        }
    }


    _previewsEnabled() {
        return this._settingBoolean('preview-enabled', true);
    }


    _filePreviewsEnabled() {
        return this._previewsEnabled() &&
            this._settingBoolean('file-preview-enabled', true);
    }


    _folderPreviewsEnabled() {
        return this._previewsEnabled() &&
            this._settingBoolean('folder-preview-enabled', true);
    }


    _keyboardPreviewsEnabled() {
        return this._previewsEnabled() &&
            this._settingBoolean('keyboard-preview-enabled', true);
    }


    _previewRightmostOnly() {
        return this._settingBoolean('preview-rightmost-only', false);
    }


    _mousePreviewCloseDelayMs() {
        return Math.max(
            0,
            this._settingInt(
                'mouse-preview-close-delay-ms',
                DEFAULT_MOUSE_PREVIEW_CLOSE_DELAY_MS
            )
        );
    }

    _previewAnimationsEnabled() {
        return this._settingBoolean('preview-animations-enabled', true);
    }


    _animateIntermediatePreviews() {
        return this._settingBoolean('animate-intermediate-previews', true);
    }


    _previewOpenDurationMs() {
        return Math.max(0, this._settingInt(
            'preview-open-duration-ms', DEFAULT_PREVIEW_OPEN_DURATION_MS
        ));
    }


    _previewCloseDurationMs() {
        return Math.max(0, this._settingInt(
            'preview-close-duration-ms', DEFAULT_PREVIEW_CLOSE_DURATION_MS
        ));
    }


    _previewSwitchDurationMs() {
        return Math.max(0, this._settingInt(
            'preview-switch-duration-ms', DEFAULT_PREVIEW_SWITCH_DURATION_MS
        ));
    }


    _horizontalPanDurationMs() {
        return Math.max(0, this._settingInt(
            'horizontal-pan-duration-ms', DEFAULT_HORIZONTAL_PAN_DURATION_MS
        ));
    }


    _shouldAnimatePreview(stickyRightmost = false) {
        return this._previewAnimationsEnabled() &&
            (stickyRightmost || this._animateIntermediatePreviews());
    }


    _rowAllowedByPreviewScope(row) {
        if (!row || !this._previewRightmostOnly())
            return true;

        const rightmostDepth = Math.max(0, this._columns.length - 1);
        return row._folderBrowserDepth === rightmostDepth;
    }


    _rowIsInRightmostFolderColumn(row) {
        if (!row || this._columns.length === 0)
            return false;

        // Preview actors are inserted into _columnsBox but are deliberately
        // not stored in _columns, so this is the rightmost real Miller column.
        const rightmostDepth = this._columns.length - 1;
        return row._folderBrowserDepth === rightmostDepth;
    }


    _previewPreloadingEnabled() {
        return this._filePreviewsEnabled() &&
            this._settingBoolean('preload-previews', true);
    }


    _previewCacheRetentionMs() {
        return Math.max(
            0,
            this._settingInt(
                'cache-retention-seconds',
                DEFAULT_PREVIEW_CACHE_RETENTION_SECONDS
            )
        ) * 1000;
    }


    _previewCacheLimitBytes() {
        return Math.max(
            0.5,
            this._settingDouble(
                'cache-limit-mb',
                DEFAULT_PREVIEW_CACHE_LIMIT_MB
            )
        ) * 1024 * 1024;
    }


    _previewImageSize() {
        return Math.max(
            64,
            this._settingInt('preview-image-size', DEFAULT_PREVIEW_IMAGE_SIZE)
        );
    }


    _folderPreviewMaxItems() {
        return Math.max(
            1,
            this._settingInt(
                'folder-preview-max-items',
                DEFAULT_FOLDER_PREVIEW_MAX_ITEMS
            )
        );
    }


    _showHiddenFiles() {
        return this._settingBoolean('show-hidden-files', false);
    }


    _connectSettings() {
        if (!this._settings)
            return;

        const connect = (key, callback) => {
            try {
                const id = this._settings.connect(`changed::${key}`, callback);
                this._settingsChangedIds.push(id);
            } catch (error) {
                console.debug(`Folders settings: could not watch ${key}: ${error}`);
            }
        };

        for (const key of [
            'preview-enabled',
            'folder-preview-enabled',
            'file-preview-enabled',
            'keyboard-preview-enabled',
            'preview-rightmost-only',
        ]) {
            connect(key, () => {
                this._previewToken++;
                this._hidePreview();
                this._cancelPreviewPreloadQueue();

                if (!this._filePreviewsEnabled())
                    this._clearPreviewCache('file previews disabled');
                else if (this._previewPreloadingEnabled() && this._menuIsOpen)
                    this._queueOpenFolderPreviewPreloads();

                this._writePreviewCacheStatus();
            });
        }

        connect('mouse-preview-close-delay-ms', () => {
            this._cancelPreviewHideDelay();
        });

        for (const key of [
            'preview-animations-enabled',
            'animate-intermediate-previews',
            'preview-open-duration-ms',
            'preview-close-duration-ms',
            'preview-switch-duration-ms',
        ]) {
            connect(key, () => {
                // Finish any in-flight fade cleanly when animation settings change.
                this._destroyFadingPreviewActor();
            });
        }

        connect('preload-previews', () => {
            this._cancelPreviewPreloadQueue();
            if (this._previewPreloadingEnabled() && this._menuIsOpen)
                this._queueOpenFolderPreviewPreloads();
            this._writePreviewCacheStatus();
        });

        connect('cache-retention-seconds', () => {
            const now = this._cacheNow();
            const retention = this._previewCacheRetentionMs();
            for (const entry of this._previewCache.values()) {
                if (!entry.pinned)
                    entry.expiresAt = now + retention;
            }
            this._prunePreviewCache();
            this._writePreviewCacheStatus();
        });

        connect('cache-limit-mb', () => {
            this._enforcePreviewCacheLimit(this._previewCurrentKey);
            this._writePreviewCacheStatus();
        });

        connect('preview-image-size', () => {
            this._previewToken++;
            this._hidePreview();
            this._clearPreviewCache('preview image size changed');
            if (this._previewPreloadingEnabled() && this._menuIsOpen)
                this._queueOpenFolderPreviewPreloads();
        });

        connect('folder-preview-max-items', () => {
            if (this._previewSourceRow?._folderBrowserIsDirectory) {
                this._previewToken++;
                this._hidePreview();
            }
        });

        for (const key of ['show-places', 'show-drives', 'show-hidden-files']) {
            connect(key, () => {
                this._previewToken++;
                this._hidePreview();
                this._cancelPreviewPreloadQueue();
                this._buildBrowser();
                if (this._menuIsOpen) {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._focusInitialRow();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        }
    }


    _disconnectSettings() {
        if (!this._settings)
            return;

        for (const id of this._settingsChangedIds.splice(0)) {
            try {
                this._settings.disconnect(id);
            } catch {
                // Ignore stale settings handlers.
            }
        }
    }


    /*
     * =====================================================
     * BUILD MAIN BROWSER
     * =====================================================
     */

    _buildBrowser() {
        this.menu.removeAll();

        this._columns = [];
        this._columnRows = [];
        this._columnScrolls = [];
        this._lastFocusedRows = new Map();
        this._columnDirectories = [];
        this._columnLists = [];
        this._selectedRows = new Map();
        this._clearMultiSelection(false);


        this._horizontalScroll =
            new St.ScrollView({
                reactive: true,

                x_expand: false,
                y_expand: true,

                style: `
                    height: ${BROWSER_HEIGHT}px;
                `,
            });


        this._horizontalScroll.set_policy(
            St.PolicyType.AUTOMATIC,
            St.PolicyType.NEVER
        );


        /*
         * We handle wheel input ourselves.
         */
        this._horizontalScroll.set_mouse_scrolling(
            false
        );


        /*
         * Mouse wheel over headers / unused browser
         * space becomes horizontal scrolling.
         */
        this._horizontalScroll.connect(
            'scroll-event',

            (_actor, event) => {
                return this._handleHorizontalScrollEvent(
                    event
                );
            }
        );

        /*
         * Clicking empty browser/column space behaves like a normal file
         * manager: any multi-selection is cleared. Row Ctrl/Shift clicks stop
         * propagation before reaching this handler, so real multi-selection
         * gestures remain untouched.
         */
        this._horizontalScroll.connect(
            'button-press-event',
            (_actor, event) => {
                try {
                    if (event.get_button() === 1 && this._multiSelectedUris.size > 0)
                        this._clearMultiSelection();
                } catch {
                    // Ignore unusual pointer events.
                }
                return Clutter.EVENT_PROPAGATE;
            }
        );


        /*
         * All columns live side by side here.
         */
        this._columnsBox =
            new St.BoxLayout({
                vertical: false,
                x_expand: true,

                style: `
                    spacing: 0px;
                `,
            });


        this._horizontalScroll.set_child(
            this._columnsBox
        );


        this._browserSection =
            new PopupMenu.PopupMenuSection();


        const sectionActor =
            this._browserSection.actor ??
            this._browserSection;


        sectionActor.add_child(
            this._horizontalScroll
        );


        this.menu.addMenuItem(
            this._browserSection
        );


        /*
         * First column = GTK bookmarks.
         */
        const bookmarkList =
            this._createColumn(
                'Bookmarks',
                null
            );


        const bookmarks =
            this._getBookmarks();


        if (this._settingBoolean('show-places', true)) {
            this._addVirtualRootRow(
                bookmarkList,
                'Places',
                'folder-home-symbolic',
                'places'
            );
        }

        if (this._settingBoolean('show-drives', true)) {
            this._addVirtualRootRow(
                bookmarkList,
                'Drives',
                'drive-harddisk-symbolic',
                'drives'
            );
        }


        for (const bookmark of bookmarks) {
            let row;


            row = this._createEntryRow({
                name: bookmark.name,

                icon:
                    new St.Icon({
                        icon_name:
                            'folder-symbolic',

                        icon_size: 16,
                    }),

                isDirectory: true,
                file: bookmark.file,
                depth: 0,

                onActivate: () => {
                    this._toggleDirectoryColumn(
                        bookmark.file,
                        0,
                        row
                    );
                },
            });


            bookmarkList.add_child(
                row
            );
        }


        this._scheduleBrowserWidthUpdate();
    }


    _addVirtualRootRow(list, name, iconName, groupId) {
        let row;

        row = this._createEntryRow({
            name,
            icon: new St.Icon({
                icon_name: iconName,
                icon_size: 16,
            }),
            isDirectory: true,
            file: null,
            depth: 0,
            virtualGroup: groupId,
            onActivate: () => {
                this._toggleVirtualGroupColumn(groupId, 0, row);
            },
        });

        list.add_child(row);
    }


    _toggleVirtualGroupColumn(groupId, currentDepth, selectedRow) {
        const currentlySelected = this._selectedRows.get(currentDepth);
        const childColumnIsOpen = this._columns.length > currentDepth + 1;

        if (currentlySelected === selectedRow && childColumnIsOpen) {
            try {
                selectedRow.remove_style_pseudo_class('active');
            } catch {
                // Ignore.
            }

            this._selectedRows.delete(currentDepth);
            this._removeColumnsAfter(currentDepth + 1);
            return;
        }

        this._setSelectedRow(currentDepth, selectedRow);

        const openReplacementGroup = () => {
            const title = groupId === 'drives' ? 'Drives' : 'Places';
            const list = this._createColumn(title, null);
            const depth = currentDepth + 1;
            const items = groupId === 'drives'
                ? this._getDriveGroupItems()
                : this._getPlacesGroupItems();

            if (items.length === 0) {
                this._addMessage(
                    list,
                    groupId === 'drives' ? 'No mounted drives' : 'No places found'
                );
            }

            for (const item of items) {
                let childRow;
                childRow = this._createEntryRow({
                    name: item.name,
                    icon: item.icon instanceof Gio.Icon
                        ? new St.Icon({gicon: item.icon, icon_size: 16})
                        : new St.Icon({
                            icon_name: item.iconName ?? 'folder-symbolic',
                            icon_size: 16,
                        }),
                    isDirectory: true,
                    file: item.file,
                    depth,
                    onActivate: () => {
                        this._toggleDirectoryColumn(item.file, depth, childRow);
                    },
                });
                list.add_child(childRow);
            }

            this._animateColumnIn(this._columns[depth]);
            this._scheduleBrowserWidthUpdate();
        };

        // When replacing a branch, let the old descendants visibly leave
        // before inserting the new child. This keeps branch changes from
        // snapping even when several columns were open to the right.
        this._removeColumnsAfter(
            currentDepth + 1,
            true,
            openReplacementGroup,
            true
        );
    }


    _getPlacesGroupItems() {
        const result = [];
        const seen = new Set();

        const addPath = (name, path, iconName) => {
            if (!path)
                return;

            const file = Gio.File.new_for_path(path);
            const uri = file.get_uri();
            if (seen.has(uri) || !file.query_exists(null))
                return;

            seen.add(uri);
            result.push({name, file, iconName});
        };

        addPath('Home', GLib.get_home_dir(), 'user-home-symbolic');

        const special = [
            ['Desktop', GLib.UserDirectory.DIRECTORY_DESKTOP, 'user-desktop-symbolic'],
            ['Documents', GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'folder-documents-symbolic'],
            ['Downloads', GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'folder-download-symbolic'],
            ['Music', GLib.UserDirectory.DIRECTORY_MUSIC, 'folder-music-symbolic'],
            ['Pictures', GLib.UserDirectory.DIRECTORY_PICTURES, 'folder-pictures-symbolic'],
            ['Videos', GLib.UserDirectory.DIRECTORY_VIDEOS, 'folder-videos-symbolic'],
            ['Public', GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE, 'folder-publicshare-symbolic'],
            ['Templates', GLib.UserDirectory.DIRECTORY_TEMPLATES, 'folder-templates-symbolic'],
        ];

        for (const [name, enumValue, iconName] of special) {
            try {
                addPath(name, GLib.get_user_special_dir(enumValue), iconName);
            } catch {
                // Some older GLib builds may not expose every special dir.
            }
        }

        return result;
    }


    _getDriveGroupItems() {
        const result = [];
        const seen = new Set();

        try {
            const monitor = Gio.VolumeMonitor.get();
            for (const mount of monitor.get_mounts()) {
                const root = mount.get_root();
                const uri = root?.get_uri?.();
                if (!root || !uri || seen.has(uri))
                    continue;

                seen.add(uri);
                result.push({
                    name: mount.get_name() ?? this._getDisplayName(root),
                    file: root,
                    icon: mount.get_icon(),
                });
            }
        } catch (error) {
            console.error(`Folders: could not enumerate drives: ${error}`);
        }

        result.sort((a, b) => a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: 'base',
        }));

        return result;
    }


    /*
     * =====================================================
     * DYNAMIC BROWSER WIDTH
     * =====================================================
     */

    _updateBrowserWidth() {
        if (
            !this._horizontalScroll
        ) {
            return;
        }


        let requestedWidth;


        /*
         * Preferred behaviour:
         *
         * Measure the real width of every column so
         * padding / borders / scrollbar allocation do
         * not produce artificial horizontal overflow.
         */
        if (
            USE_MEASURED_COLUMN_WIDTHS
        ) {
            requestedWidth = 0;


            for (
                const column
                of this._columns
            ) {
                try {
                    const [
                        minimumWidth,
                        naturalWidth,
                    ] =
                        column.get_preferred_width(
                            -1
                        );


                    requestedWidth +=
                        Math.max(
                            minimumWidth,
                            naturalWidth
                        );
                } catch {
                    requestedWidth +=
                        COLUMN_WIDTH;
                }
            }


            if (this._previewColumn) {
                try {
                    const [previewMin, previewNatural] =
                        this._previewColumn.get_preferred_width(-1);
                    requestedWidth += Math.max(previewMin, previewNatural);
                } catch {
                    requestedWidth += PREVIEW_COLUMN_WIDTH;
                }
            }

            requestedWidth += 2;
        } else {
            /*
             * Older behaviour.
             *
             * To revert the jitter fix, set
             * USE_MEASURED_COLUMN_WIDTHS = false.
             */
            const columnCount =
                Math.max(
                    1,
                    this._columns.length
                );


            requestedWidth =
                (
                    columnCount *
                    COLUMN_WIDTH
                ) +
                (this._previewColumn ? PREVIEW_COLUMN_WIDTH : 0) +
                WIDTH_ALLOWANCE;
        }


        const finalWidth =
            Math.min(
                MAX_BROWSER_WIDTH,
                requestedWidth
            );


        this._horizontalScroll.set_width(
            finalWidth
        );
    }


    _scheduleBrowserWidthUpdate() {
        GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,

            () => {
                if (
                    !this._horizontalScroll
                ) {
                    return GLib.SOURCE_REMOVE;
                }


                this._updateBrowserWidth();

                this._clampHorizontalPosition();


                return GLib.SOURCE_REMOVE;
            }
        );
    }


    /*
     * =====================================================
     * CREATE COLUMN
     * =====================================================
     */

    _createColumn(
        title,
        directory
    ) {
        const column =
            new St.BoxLayout({
                vertical: true,

                style: `
                    width: ${COLUMN_WIDTH}px;
                    height: ${BROWSER_HEIGHT - 16}px;

                    padding: 6px;

                    border-right: 1px solid
                        rgba(128, 128, 128, 0.28);
                `,
            });


        /*
         * Header
         */
        const header =
            new St.BoxLayout({
                vertical: false,
                x_expand: true,

                style: `
                    spacing: 6px;
                    padding: 6px 8px 9px 8px;
                `,
            });


        const titleLabel =
            new St.Label({
                text: title,

                x_expand: true,

                y_align:
                    Clutter.ActorAlign.CENTER,

                style: `
                    font-weight: bold;
                `,
            });


        titleLabel.clutter_text.ellipsize =
            Pango.EllipsizeMode.END;


        header.add_child(
            titleLabel
        );


        /*
         * Open current folder in external file manager.
         */
        if (
            directory !== null
        ) {
            const openButton =
                new St.Button({
                    reactive: true,
                    can_focus: true,
                    track_hover: true,

                    style: `
                        padding: 4px 6px;
                    `,
                });


            openButton.set_child(
                new St.Icon({
                    icon_name:
                        'document-open-symbolic',

                    icon_size: 14,
                })
            );


            openButton.connect(
                'clicked',

                () => {
                    this._launchFile(
                        directory
                    );
                }
            );


            header.add_child(
                openButton
            );
        }


        column.add_child(
            header
        );


        /*
         * Vertical scrolling section of this column.
         */
        const verticalScroll =
            new St.ScrollView({
                reactive: true,

                x_expand: true,
                y_expand: true,
            });


        verticalScroll.set_policy(
            St.PolicyType.NEVER,
            St.PolicyType.AUTOMATIC
        );


        /*
         * Disable built-in wheel handling because
         * we route wheel events ourselves.
         */
        verticalScroll.set_mouse_scrolling(
            false
        );


        verticalScroll.connect(
            'scroll-event',

            (_actor, event) => {
                return this._handleColumnScrollEvent(
                    verticalScroll,
                    event
                );
            }
        );

        // Ensure clicks in empty space below/around rows clear selection even
        // if the ScrollView consumes the pointer event before it can bubble to
        // the outer horizontal scroller.
        verticalScroll.connect(
            'button-press-event',
            (_actor, event) => {
                try {
                    if (event.get_button() === 1 && this._multiSelectedUris.size > 0)
                        this._clearMultiSelection();
                } catch {
                    // Ignore unusual pointer events.
                }
                return Clutter.EVENT_PROPAGATE;
            }
        );


        const list =
            new St.BoxLayout({
                vertical: true,
                x_expand: true,

                style: `
                    spacing: 1px;
                `,
            });


        const depth =
            this._columns.length;


        this._columnRows[depth] = [];
        this._columnScrolls[depth] = verticalScroll;
        this._columnLists[depth] = list;
        this._lastFocusedRows.delete(depth);
        this._columnDirectories[depth] = directory;


        verticalScroll.set_child(
            list
        );


        column.add_child(
            verticalScroll
        );


        this._columnsBox.add_child(
            column
        );


        this._columns.push(
            column
        );


        this._scheduleBrowserWidthUpdate();


        return list;
    }


    /*
     * =====================================================
     * CLICK FOLDER TO OPEN / CLICK AGAIN TO CLOSE
     * =====================================================
     */

    _toggleDirectoryColumn(
        directory,
        currentDepth,
        selectedRow
    ) {
        const currentlySelected =
            this._selectedRows.get(
                currentDepth
            );


        const childColumnIsOpen =
            this._columns.length >
            currentDepth + 1;


        /*
         * Same folder clicked again:
         * collapse the child column(s).
         */
        if (
            currentlySelected === selectedRow &&
            childColumnIsOpen
        ) {
            try {
                selectedRow
                    .remove_style_pseudo_class(
                        'active'
                    );
            } catch {
                // Ignore.
            }


            this._selectedRows.delete(
                currentDepth
            );


            for (
                const depth
                of [...this._selectedRows.keys()]
            ) {
                if (
                    depth >
                    currentDepth
                ) {
                    this._selectedRows.delete(
                        depth
                    );
                }
            }


            this._removeColumnsAfter(
                currentDepth + 1
            );


            return;
        }


        this._openDirectoryColumn(
            directory,
            currentDepth,
            selectedRow
        );
    }


    /*
     * =====================================================
     * OPEN DIRECTORY
     * =====================================================
     */

    _openDirectoryColumn(
        directory,
        currentDepth,
        selectedRow
    ) {
        // A preview is an inspector for the current row, not a permanent
        // Miller column. Opening a folder always dismisses it first so a
        // sticky rightmost preview can never become stranded between the
        // source column and the newly opened child column.
        if (this._previewColumn) {
            this._previewToken++;
            this._hidePreview();
        }

        this._setSelectedRow(
            currentDepth,
            selectedRow
        );


        const openReplacementColumn = () => {
            const folderName =
                this._getDisplayName(
                    directory
                );


            const list =
                this._createColumn(
                    folderName,
                    directory
                );


            this._populateDirectoryColumn(
                list,
                directory,
                currentDepth + 1
            );


            this._animateColumnIn(this._columns[currentDepth + 1]);
            this._scheduleBrowserWidthUpdate();
        };


        // Branch replacement is a two-part transition: first animate every
        // descendant column out, then build and animate the replacement child
        // in. Previously this path passed `false` here, which destroyed the old
        // branch in one frame and made switching folders from an earlier column
        // feel much harsher than normal opening/closing.
        this._removeColumnsAfter(
            currentDepth + 1,
            true,
            openReplacementColumn,
            true
        );
    }


    /*
     * =====================================================
     * POPULATE / REFRESH DIRECTORY COLUMN
     * =====================================================
     */

    _populateDirectoryColumn(
        list,
        directory,
        depth
    ) {
        for (const child of list.get_children())
            child.destroy();

        this._columnRows[depth] = [];
        this._lastFocusedRows.delete(depth);

        let entries;

        try {
            entries = this._readDirectory(directory);
        } catch (error) {
            console.error(
                `Folders: failed reading ${directory.get_uri()}: ${error}`
            );
            this._addMessage(list, 'Unable to open folder');
            return;
        }

        if (entries.length === 0) {
            this._addMessage(list, 'Empty folder');
            return;
        }

        for (const entry of entries) {
            const childFile = directory.get_child(entry.name);
            let row;

            row = this._createEntryRow({
                name: entry.displayName,
                icon: this._createFileIcon(entry),
                isDirectory: entry.isDirectory,
                file: childFile,
                depth,
                previewSeed: this._makePreviewSeedFromEntry(entry),
                onActivate: () => {
                    if (entry.isDirectory) {
                        this._toggleDirectoryColumn(
                            childFile,
                            depth,
                            row
                        );
                        return;
                    }

                    this._launchFileInDefaultApplication(childFile);
                },
            });

            list.add_child(row);
        }

        /* Start a bounded, serial background preload for previewable files. */
        this._queueFolderPreviewPreload(directory, entries);
    }


    _refreshDirectoryColumn(depth) {
        if (depth <= 0 || depth >= this._columns.length)
            return;

        const directory = this._columnDirectories[depth];
        const column = this._columns[depth];

        if (!directory || !column)
            return;

        const list = this._columnLists[depth] ?? null;

        if (!list)
            return;

        if (
            this._previewSourceDepth !== null &&
            this._previewSourceDepth >= depth
        ) {
            this._previewToken++;
            this._hidePreview();
        }

        for (const existingDepth of [...this._selectedRows.keys()]) {
            if (existingDepth >= depth)
                this._selectedRows.delete(existingDepth);
        }

        this._removeColumnsAfter(depth + 1, false);
        this._populateDirectoryColumn(list, directory, depth);
        this._scheduleBrowserWidthUpdate();
    }


    _refreshDirectoryColumnPreservingView(depth) {
        if (depth <= 0 || depth >= this._columns.length)
            return;

        const directory = this._columnDirectories[depth];
        const list = this._columnLists[depth] ?? null;
        if (!directory || !list)
            return;

        const rowUri = row => row?._folderBrowserFile?.get_uri?.() ?? null;
        const selectedUri = rowUri(this._selectedRows.get(depth));
        const lastFocusedUri = rowUri(this._lastFocusedRows.get(depth));
        const explicitFocusedUri =
            this._explicitFocusedRow?._folderBrowserDepth === depth
                ? rowUri(this._explicitFocusedRow)
                : null;
        const previewUri =
            this._previewSourceDepth === depth
                ? rowUri(this._previewSourceRow)
                : null;

        // Rebuild only this column's rows. Unlike the normal navigation
        // refresh, do NOT close the preview or discard deeper Miller columns.
        this._populateDirectoryColumn(list, directory, depth);

        const rows = this._columnRows[depth] ?? [];
        const findByUri = uri =>
            uri ? (rows.find(row => rowUri(row) === uri) ?? null) : null;

        const selectedRow = findByUri(selectedUri);
        if (selectedRow) {
            this._selectedRows.set(depth, selectedRow);
            try {
                selectedRow.add_style_pseudo_class('active');
            } catch {
                // Ignore actor styling failures.
            }
        } else {
            this._selectedRows.delete(depth);
        }

        const lastFocusedRow = findByUri(lastFocusedUri);
        if (lastFocusedRow)
            this._lastFocusedRows.set(depth, lastFocusedRow);

        if (previewUri) {
            const previewRow = findByUri(previewUri);
            if (previewRow)
                this._previewSourceRow = previewRow;
        }

        if (explicitFocusedUri) {
            const focusedRow = findByUri(explicitFocusedUri);
            if (focusedRow)
                this._explicitFocusedRow = focusedRow;
        }

        // Clipboard visuals belong to row actors and must be re-applied after
        // rebuilding the list. This keeps cut/copy feedback stable too.
        for (const row of rows)
            this._applyClipboardVisual(row);

        this._scheduleBrowserWidthUpdate();
    }


    _refreshDirectoryPreservingView(directory) {
        if (!directory)
            return;

        for (let depth = 1; depth < this._columnDirectories.length; depth++) {
            const openDirectory = this._columnDirectories[depth];
            if (openDirectory?.equal?.(directory)) {
                this._refreshDirectoryColumnPreservingView(depth);
                return;
            }
        }
    }


    _refreshDirectory(directory) {
        if (!directory)
            return;

        for (let depth = 1; depth < this._columnDirectories.length; depth++) {
            const openDirectory = this._columnDirectories[depth];

            if (openDirectory?.equal?.(directory)) {
                this._refreshDirectoryColumn(depth);
                return;
            }
        }
    }



    /*
     * =====================================================
     * EXPLICIT KEYBOARD NAVIGATION / FOCUS
     * =====================================================
     */

    _handleGlobalContextShortcut(event) {
        if (!this._menuIsOpen || this._contextMenu)
            return Clutter.EVENT_PROPAGATE;

        let key;
        let state;

        try {
            key = event.get_key_symbol();
            state = event.get_state();
        } catch {
            return Clutter.EVENT_PROPAGATE;
        }

        const shiftHeld =
            (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (
            key !== Clutter.KEY_Menu &&
            !(shiftHeld && key === Clutter.KEY_F10)
        ) {
            return Clutter.EVENT_PROPAGATE;
        }

        let actor = null;
        try {
            actor = global.stage.get_key_focus();
        } catch {
            actor = null;
        }

        while (actor && actor._folderBrowserDepth === undefined) {
            try {
                actor = actor.get_parent();
            } catch {
                actor = null;
            }
        }

        if (!actor)
            return Clutter.EVENT_PROPAGATE;

        this._suppressMouseHoverUntilMotion('keyboard context menu');
        this._showContextMenu(actor);
        return Clutter.EVENT_STOP;
    }


    _handleRowKeyPress(row, event) {
        this._suppressMouseHoverUntilMotion('keyboard input');

        const key = event.get_key_symbol();
        const state = event.get_state();
        const shiftHeld =
            (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const ctrlHeld =
            (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const depth = row._folderBrowserDepth;

        this._debugFocus(
            `key=${key} depth=${depth} name=${row._folderBrowserName}`
        );

        if (
            key === Clutter.KEY_Menu ||
            (shiftHeld && key === Clutter.KEY_F10)
        ) {
            this._showContextMenu(row);
            return Clutter.EVENT_STOP;
        }

        // Escape is the explicit/manual deselect shortcut. If nothing is
        // selected, let the event propagate so GNOME can use Escape normally
        // (for example, to close the popup).
        if (key === Clutter.KEY_Escape && this._multiSelectedUris.size > 0) {
            this._clearMultiSelection();
            this._showStatus('Selection cleared');
            return Clutter.EVENT_STOP;
        }

        if (ctrlHeld && shiftHeld) {
            if (key === Clutter.KEY_d || key === Clutter.KEY_D) {
                this._openDragWindow(row);
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_t || key === Clutter.KEY_T) {
                this._openTrash();
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_i || key === Clutter.KEY_I) {
                this._reportPreviewCache();
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_k || key === Clutter.KEY_K) {
                this._clearPreviewCache('manual clear');
                this._showStatus('Preview cache cleared');
                Main.notify('Folders preview cache', 'Cache cleared');
                return Clutter.EVENT_STOP;
            }
        }

        if (ctrlHeld) {
            if (key === Clutter.KEY_space) {
                this._toggleRowSelection(row);
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_a || key === Clutter.KEY_A) {
                this._selectAllRows(depth);
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_l || key === Clutter.KEY_L) {
                this._copyRowPathToClipboard(row);
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_c || key === Clutter.KEY_C) {
                this._setClipboardRow(row, 'copy');
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_x || key === Clutter.KEY_X) {
                this._setClipboardRow(row, 'cut');
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_v || key === Clutter.KEY_V) {
                void this._pasteIntoRowColumn(row);
                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_z || key === Clutter.KEY_Z) {
                if (shiftHeld)
                    void this._redoLastFileOperation();
                else
                    void this._undoLastFileOperation();

                return Clutter.EVENT_STOP;
            }

            if (key === Clutter.KEY_y || key === Clutter.KEY_Y) {
                void this._redoLastFileOperation();
                return Clutter.EVENT_STOP;
            }
        }

        /*
         * Shift+Delete permanently removes a real child item.  Bookmark rows
         * are deliberately protected so a shortcut on the first column can
         * never recursively erase the bookmarked root directory.
         */
        if (key === Clutter.KEY_Delete || key === Clutter.KEY_KP_Delete) {
            if (shiftHeld)
                void this._permanentlyDeleteRow(row);
            else
                void this._trashRow(row);

            return Clutter.EVENT_STOP;
        }

        /*
         * Backspace behaves like a browser/file-manager Back button:
         * close the current column and every column to its right, then put
         * focus back on the parent row that opened it.
         */
        if (key === Clutter.KEY_BackSpace) {
            this._goBackFromDepth(depth);
            return Clutter.EVENT_STOP;
        }

        switch (key) {
        case Clutter.KEY_Up:
            if (shiftHeld) {
                this._extendSelectionByKeyboard(depth, row, -1);
            } else {
                // Plain arrow navigation collapses a multi-selection. Ctrl+↑/↓
                // deliberately preserves it, matching common file managers.
                if (!ctrlHeld)
                    this._clearMultiSelection();
                this._focusRelativeRow(depth, row, -1);
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
            if (shiftHeld) {
                this._extendSelectionByKeyboard(depth, row, 1);
            } else {
                if (!ctrlHeld)
                    this._clearMultiSelection();
                this._focusRelativeRow(depth, row, 1);
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Left:
            if (!ctrlHeld && !shiftHeld)
                this._clearMultiSelection();
            this._focusPreviousColumn(depth);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Right:
            if (shiftHeld) {
                this._focusNextOpenColumn(depth);
            } else {
                if (!ctrlHeld)
                    this._clearMultiSelection();

                /*
                 * A preview is an inspector, not a Miller-column navigation
                 * stop. If a normal file is focused while a real child column
                 * is already open, Right Arrow skips the preview and enters
                 * that child column. Directories keep the normal open/enter
                 * behaviour.
                 */
                if (row._folderBrowserIsDirectory)
                    this._openFocusedDirectoryAndEnter(row);
                else
                    this._focusNextOpenColumn(depth);
            }

            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (shiftHeld) {
                this._openRowInFileManager(row);
            } else if (row._folderBrowserIsDirectory) {
                this._openFocusedDirectoryAndEnter(row);
            } else if (this._isArchiveRow(row)) {
                void this._extractArchiveRow(row, false);
            } else {
                // Normal files always launch through their registered default
                // application. The external file manager is reserved for
                // Shift+Enter, the column header button, or the context menu.
                row._folderBrowserActivate();
            }

            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }


    _suppressMouseHoverUntilMotion(_reason = '') {
        this._mouseHoverSuppressed = true;
        this._cancelFolderHoverOpen();
    }


    _reactivateMouseHoverFromMotion() {
        if (!this._mouseHoverSuppressed)
            return false;

        this._mouseHoverSuppressed = false;
        return true;
    }


    _cancelFolderHoverOpen(row = null) {
        if (row && this._folderHoverRow !== row)
            return;

        if (this._folderHoverTimeoutId) {
            GLib.source_remove(this._folderHoverTimeoutId);
            this._folderHoverTimeoutId = 0;
        }

        this._folderHoverRow = null;
    }



    _cancelPreviewHideDelay() {
        if (this._previewHideTimeoutId) {
            GLib.source_remove(this._previewHideTimeoutId);
            this._previewHideTimeoutId = 0;
        }
    }


    _scheduleMousePreviewHide(row) {
        if (
            !row ||
            this._previewSourceRow !== row ||
            this._previewSourceMode !== 'mouse' ||
            this._previewStickyRightmost
        ) {
            return;
        }

        this._cancelPreviewHideDelay();

        const delay = this._mousePreviewCloseDelayMs();
        if (delay <= 0) {
            this._suppressMouseHoverUntilMotion('preview pointer leave');
            this._previewToken++;
            this._hidePreview(true);
            return;
        }

        this._previewHideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._previewHideTimeoutId = 0;

                if (
                    this._previewSourceRow === row &&
                    this._previewSourceMode === 'mouse'
                ) {
                    // The preview is actually collapsing now. Ignore any
                    // synthetic enter event caused by columns shifting under
                    // a stationary pointer until real mouse motion resumes.
                    this._suppressMouseHoverUntilMotion('delayed preview pointer leave');
                    this._previewToken++;
                    this._hidePreview(true);
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }


    _isRowOpenDirectory(row) {
        if (
            !row ||
            !(row._folderBrowserIsDirectory || row._folderBrowserVirtualGroup)
        )
            return false;

        const depth = row._folderBrowserDepth;
        return (
            this._selectedRows.get(depth) === row &&
            this._columns.length > depth + 1
        );
    }


    _handlePointerEnter(row) {
        if (
            !row ||
            this._mouseHoverSuppressed ||
            !this._menuIsOpen ||
            !this._previewsEnabled()
        ) {
            return;
        }


        this._cancelFolderHoverOpen();

        const isFolder = Boolean(
            row._folderBrowserIsDirectory || row._folderBrowserVirtualGroup
        );

        // A sticky preview from the rightmost column survives ordinary pointer
        // leave, but it must not survive moving onto another folder. This is
        // especially important for an already-open folder, which deliberately
        // has no folder preview of its own.
        if (
            isFolder &&
            this._previewColumn &&
            this._previewStickyRightmost &&
            this._previewSourceRow !== row
        ) {
            this._previewToken++;
            this._hidePreview(true);
        }

        const allowedByScope = this._rowAllowedByPreviewScope(row);
        const isOpenFolder = isFolder && this._isRowOpenDirectory(row);
        const kindEnabled = isFolder
            ? this._folderPreviewsEnabled()
            : this._filePreviewsEnabled();

        if (!allowedByScope || isOpenFolder || !kindEnabled) {
            // Preserve the leave-event grace period if we just came from a
            // mouse preview. This avoids flashing the deeper folder column
            // while crossing a non-previewable row. A keyboard preview is
            // focus-owned, so once real mouse movement takes over, close it.
            if (
                this._previewColumn &&
                this._previewSourceMode === 'keyboard' &&
                !this._previewStickyRightmost
            ) {
                this._previewToken++;
                this._hidePreview();
            } else if (
                this._previewColumn &&
                this._previewSourceMode === 'mouse' &&
                !this._previewStickyRightmost &&
                !this._previewHideTimeoutId
            ) {
                this._scheduleMousePreviewHide(this._previewSourceRow);
            }
            return;
        }

        // A valid next preview replaces the previous preview directly, so the
        // old column never needs to disappear for a frame in between.
        this._cancelPreviewHideDelay();

        if (
            this._previewSourceRow === row &&
            this._previewSourceMode === 'mouse' &&
            this._previewColumn
        ) {
            return;
        }

        void this._showPreviewForRow(row, 'mouse');
    }



    _goBackFromDepth(depth) {
        if (depth <= 0) {
            this._showStatus('Already at bookmarks');
            return;
        }

        const parentDepth = depth - 1;
        const parentRow =
            this._selectedRows.get(parentDepth) ??
            this._lastFocusedRows.get(parentDepth) ??
            this._columnRows[parentDepth]?.[0] ??
            null;

        /* Closing the child also means the parent is no longer "open". */
        const selectedParent = this._selectedRows.get(parentDepth);
        try {
            selectedParent?.remove_style_pseudo_class('active');
        } catch {
            // Ignore destroyed rows.
        }

        for (const selectedDepth of [...this._selectedRows.keys()]) {
            if (selectedDepth >= parentDepth)
                this._selectedRows.delete(selectedDepth);
        }

        /* keepCount === depth removes the column we are currently inside. */
        this._removeColumnsAfter(depth);

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (parentRow) {
                this._focusRowExplicitly(parentRow);
                this._ensureRowVisible(parentDepth, parentRow);
                this._ensureColumnVisible(parentDepth);
            }

            return GLib.SOURCE_REMOVE;
        });
    }


    _focusRowExplicitly(row) {
        if (!row)
            return;

        const previous = this._explicitFocusedRow;
        if (previous && previous !== row) {
            try {
                this._refreshRowVisual(previous, false);
            } catch {
                // The previous actor may already have been destroyed.
            }
        }

        this._explicitFocusedRow = row;
        this._refreshRowVisual(row, true);

        // Paint first, then ask Clutter to move real keyboard focus.  This
        // makes the highlight deterministic even if key-focus-in is delayed
        // or a Shell/theme combination does not visibly style :focus.
        row.grab_key_focus();
    }


    _focusInitialRow() {
        const rows = this._columnRows[0] ?? [];

        if (rows.length === 0) {
            this._debugFocus(
                'initial focus failed: bookmark column has no rows'
            );
            return;
        }

        this._debugFocus(
            `grabbing initial focus: ${rows[0]._folderBrowserName}`
        );

        this._focusRowExplicitly(rows[0]);
    }


    _focusRightmostOpenRow() {
        const depth = Math.max(0, this._columns.length - 1);
        const rows = this._columnRows[depth] ?? [];
        const target = this._lastFocusedRows.get(depth) ?? rows[0] ?? null;

        if (!target) {
            this._focusInitialRow();
            return;
        }

        // Restoring focus after reopening the topbar menu should not itself
        // spawn a preview or snap the viewport before the smooth reveal runs.
        this._suppressKeyboardPreviewOnce = true;
        this._suppressColumnRevealOnce = true;
        this._focusRowExplicitly(target);
    }


    _rowSelectionUri(row) {
        if (!row || row._folderBrowserDepth <= 0 || !row._folderBrowserFile)
            return null;
        return row._folderBrowserFile.get_uri?.() ?? null;
    }


    _isRowMultiSelected(row) {
        const uri = this._rowSelectionUri(row);
        return Boolean(uri && this._multiSelectedUris.has(uri));
    }


    _refreshRowVisual(row, focusedOverride = null, hoveredOverride = null) {
        if (!row)
            return;

        /*
         * key-focus-out is emitted while global.stage may still report the
         * actor that is in the process of losing focus.  If we query the
         * stage from inside that signal, the old row can keep ROW_FOCUS_STYLE
         * and every arrow press leaves another apparently-selected row behind.
         *
         * Focus signal handlers therefore pass an explicit true/false value.
         * Pointer hover is tracked separately: it gets the same navigation
         * marker as keyboard focus without becoming the active/open folder.
         */
        let focused = focusedOverride;
        if (focused === null) {
            try {
                focused = global.stage.get_key_focus() === row ||
                    this._explicitFocusedRow === row;
            } catch {
                focused = this._explicitFocusedRow === row;
            }
        }

        const hovered = hoveredOverride === null
            ? Boolean(row._folderBrowserPointerHover)
            : hoveredOverride;
        const navigationFocus = focused || hovered;

        const selected = this._isRowMultiSelected(row);
        row.set_style(
            selected
                ? (navigationFocus ? ROW_SELECTED_FOCUS_STYLE : ROW_SELECTED_STYLE)
                : (navigationFocus ? ROW_FOCUS_STYLE : ROW_NORMAL_STYLE)
        );

        try {
            if (selected)
                row.add_style_pseudo_class('checked');
            else
                row.remove_style_pseudo_class('checked');
        } catch {
            // Ignore theme pseudo-class failures.
        }
    }


    _refreshSelectionVisuals(depth = null) {
        const depths = depth === null
            ? this._columnRows.map((_rows, index) => index)
            : [depth];

        for (const currentDepth of depths) {
            for (const row of this._columnRows[currentDepth] ?? [])
                this._refreshRowVisual(row);
        }
    }


    _clearMultiSelection(refresh = true) {
        const oldDepth = this._multiSelectionDepth;
        this._multiSelectedUris?.clear?.();
        this._multiSelectionDepth = null;
        this._selectionAnchorByDepth?.clear?.();

        if (refresh && oldDepth !== null)
            this._refreshSelectionVisuals(oldDepth);
    }


    _prepareSelectionDepth(depth) {
        if (depth <= 0)
            return false;

        if (this._multiSelectionDepth !== null && this._multiSelectionDepth !== depth)
            this._clearMultiSelection();

        this._multiSelectionDepth = depth;
        return true;
    }


    _setRangeSelection(depth, anchorRow, targetRow, additive = false) {
        if (!this._prepareSelectionDepth(depth))
            return;

        const rows = this._columnRows[depth] ?? [];
        const anchorIndex = rows.indexOf(anchorRow);
        const targetIndex = rows.indexOf(targetRow);
        if (anchorIndex < 0 || targetIndex < 0)
            return;

        if (!additive)
            this._multiSelectedUris.clear();

        const first = Math.min(anchorIndex, targetIndex);
        const last = Math.max(anchorIndex, targetIndex);
        for (let index = first; index <= last; index++) {
            const uri = this._rowSelectionUri(rows[index]);
            if (uri)
                this._multiSelectedUris.add(uri);
        }

        this._refreshSelectionVisuals(depth);
        this._showStatus(`${this._multiSelectedUris.size} selected`);
    }


    _toggleRowSelection(row) {
        const depth = row?._folderBrowserDepth;
        const uri = this._rowSelectionUri(row);
        if (!uri || !this._prepareSelectionDepth(depth)) {
            this._showStatus('Open a folder first to select items');
            return;
        }

        if (this._multiSelectedUris.has(uri))
            this._multiSelectedUris.delete(uri);
        else
            this._multiSelectedUris.add(uri);

        if (this._multiSelectedUris.size === 0) {
            this._multiSelectionDepth = null;
            this._selectionAnchorByDepth.delete(depth);
        } else {
            this._selectionAnchorByDepth.set(depth, row);
        }

        this._refreshSelectionVisuals(depth);
        this._showStatus(`${this._multiSelectedUris.size} selected`);
    }


    _selectAllRows(depth) {
        if (!this._prepareSelectionDepth(depth))
            return;

        this._multiSelectedUris.clear();
        const rows = this._columnRows[depth] ?? [];
        for (const row of rows) {
            const uri = this._rowSelectionUri(row);
            if (uri)
                this._multiSelectedUris.add(uri);
        }
        if (rows.length)
            this._selectionAnchorByDepth.set(depth, rows[0]);
        this._refreshSelectionVisuals(depth);
        this._showStatus(`${this._multiSelectedUris.size} selected`);
    }


    _extendSelectionByKeyboard(depth, currentRow, offset) {
        if (depth <= 0) {
            this._focusRelativeRow(depth, currentRow, offset);
            return;
        }

        const rows = this._columnRows[depth] ?? [];
        const index = rows.indexOf(currentRow);
        if (index < 0 || rows.length === 0)
            return;

        const nextIndex = Math.max(0, Math.min(rows.length - 1, index + offset));
        const target = rows[nextIndex];
        let anchor = this._selectionAnchorByDepth.get(depth);

        if (!anchor || !rows.includes(anchor)) {
            anchor = currentRow;
            this._selectionAnchorByDepth.set(depth, anchor);
        }

        this._setRangeSelection(depth, anchor, target, false);
        this._focusRowExplicitly(target);
    }


    _openDragWindow(row) {
        const files = this._selectionFilesForRow(row);
        if (!files.length || row?._folderBrowserVirtualGroup) {
            this._showStatus('Choose a file or folder first');
            return;
        }
        try {
            // Snapshot selection before menu.close() clears multi-selection.
            this._dragBridge.open(files);
            this._closeContextMenu();
            this.menu.close();
            // A user-requested raise from Shell also works when Wayland focus
            // protection would leave an existing GTK window behind the target app.
            for (const actor of global.get_window_actors()) {
                const window = actor.meta_window;
                if (window && this._dragBridge.ownsPid(window.get_pid())) {
                    window.activate(global.get_current_time());
                    break;
                }
            }
        } catch (error) {
            Main.notifyError('FocusTrail Drag', error.message);
        }
    }

    _selectionFilesForRow(row) {
        if (!row || !this._isRowMultiSelected(row)) {
            const file = row?._folderBrowserFile;
            return file ? [file] : [];
        }

        const depth = row._folderBrowserDepth;
        const result = [];
        for (const candidate of this._columnRows[depth] ?? []) {
            if (!this._isRowMultiSelected(candidate) || !candidate._folderBrowserFile)
                continue;
            result.push(candidate._folderBrowserFile);
        }
        return result;
    }


    _focusRelativeRow(depth, currentRow, offset) {
        const rows = this._columnRows[depth] ?? [];
        const index = rows.indexOf(currentRow);

        if (index < 0 || rows.length === 0)
            return;

        const nextIndex = Math.max(
            0,
            Math.min(rows.length - 1, index + offset)
        );

        this._focusRowExplicitly(rows[nextIndex]);
    }


    _focusPreviousColumn(depth) {
        if (depth <= 0)
            return;

        const previousDepth = depth - 1;
        const selected = this._selectedRows.get(previousDepth);
        const remembered = this._lastFocusedRows.get(previousDepth);
        const fallback = this._columnRows[previousDepth]?.[0];
        const target = selected ?? remembered ?? fallback;

        this._focusRowExplicitly(target);
    }


    _focusNextOpenColumn(depth) {
        const nextDepth = depth + 1;

        if (nextDepth >= this._columns.length)
            return;

        const remembered = this._lastFocusedRows.get(nextDepth);
        const fallback = this._columnRows[nextDepth]?.[0];
        const target = remembered ?? fallback;

        this._focusRowExplicitly(target);
    }


    _openFocusedDirectoryAndEnter(row) {
        if (!row._folderBrowserIsDirectory)
            return;

        const depth = row._folderBrowserDepth;
        const nextDepth = depth + 1;
        const sameFolderAlreadyOpen =
            this._selectedRows.get(depth) === row &&
            this._columns.length > nextDepth;

        /* Right Arrow enters an already-open child instead of collapsing it. */
        if (!sameFolderAlreadyOpen)
            row._folderBrowserActivate();

        GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                if (nextDepth < this._columns.length) {
                    const remembered =
                        this._lastFocusedRows.get(nextDepth);
                    const first = this._columnRows[nextDepth]?.[0];
                    const target = remembered ?? first;

                    if (target) {
                        this._debugFocus(
                            `entering column ${nextDepth}: ${target._folderBrowserName}`
                        );
                        this._focusRowExplicitly(target);
                    }
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }


    _ensureRowVisible(depth, row) {
        const scroll = this._columnScrolls[depth];

        if (!scroll)
            return;

        try {
            const adjustment = scroll.get_vadjustment();
            const rowTop = row.get_y();
            const rowBottom = rowTop + row.get_height();
            const value = adjustment.get_value();
            const pageSize = adjustment.get_page_size();

            if (rowTop < value) {
                adjustment.set_value(rowTop);
            } else if (rowBottom > value + pageSize) {
                adjustment.set_value(
                    Math.max(
                        adjustment.get_lower(),
                        rowBottom - pageSize
                    )
                );
            }
        } catch (error) {
            this._debugFocus(`row scroll error: ${error}`);
        }
    }


    _ensureColumnVisible(depth) {
        const column = this._columns[depth];

        if (!column || !this._horizontalScroll)
            return;

        try {
            const adjustment =
                this._horizontalScroll.get_hadjustment();
            const columnLeft = column.get_x();
            const columnRight = columnLeft + column.get_width();
            const value = adjustment.get_value();
            const pageSize = adjustment.get_page_size();

            if (columnLeft < value) {
                this._animateHorizontalAdjustmentTo(columnLeft);
            } else if (columnRight > value + pageSize) {
                this._animateHorizontalAdjustmentTo(
                    Math.max(
                        adjustment.get_lower(),
                        columnRight - pageSize
                    )
                );
            }
        } catch (error) {
            this._debugFocus(`column scroll error: ${error}`);
        }
    }


    _debugFocus(message) {
        if (DEBUG_FOCUS)
            console.log(`Folders focus: ${message}`);
    }

    _clearClipboardVisual() {
        /*
         * Scan the live rows instead of relying only on _clipboardRow. A folder
         * refresh can recreate a row while the clipboard selection is still
         * active, so the old actor reference may no longer be the visible one.
         */
        for (const rows of this._columnRows) {
            for (const candidate of rows ?? []) {
                try {
                    candidate.set_opacity(255);
                    candidate._folderBrowserClipboardMarker?.hide();
                } catch {
                    // Ignore destroyed rows.
                }
            }
        }

        this._clipboardRow = null;
    }


    _applyClipboardVisual(row) {
        if (!row)
            return;

        const file = row._folderBrowserFile;
        const marker = row._folderBrowserClipboardMarker;
        const isClipboardFile = Boolean(
            file && this._clipboardFiles.some(item => item?.equal?.(file))
        );

        if (!isClipboardFile) {
            row.set_opacity(255);
            marker?.hide();
            return;
        }

        if (this._clipboardMode === 'cut') {
            row.set_opacity(110);
            if (marker) {
                marker.icon_name = 'edit-cut-symbolic';
                marker.show();
            }
        } else {
            row.set_opacity(255);
            if (marker) {
                marker.icon_name = 'edit-copy-symbolic';
                marker.show();
            }
        }
    }


    _setClipboardRow(row, mode) {
        const files = this._selectionFilesForRow(row);
        if (files.length === 0)
            return;

        this._clearClipboardVisual();

        this._clipboardFiles = files;
        this._clipboardMode = mode;
        this._clipboardRow = row;

        for (const rows of this._columnRows) {
            for (const candidate of rows ?? [])
                this._applyClipboardVisual(candidate);
        }

        const verb = mode === 'cut' ? 'Cut' : 'Copied';
        this._showStatus(files.length === 1 ? verb : `${verb} ${files.length} items`);
    }


    _clearClipboardState() {
        this._clearClipboardVisual();
        this._clipboardFiles = [];
        this._clipboardMode = null;
    }


    _showStatus(text, timeoutMs = 1200) {
        if (!this._panelLabel)
            return;

        if (this._statusTimeoutId) {
            GLib.source_remove(this._statusTimeoutId);
            this._statusTimeoutId = 0;
        }

        this._panelLabel.set_text(text);

        this._statusTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            timeoutMs,
            () => {
                this._panelLabel?.set_text('Folders');
                this._statusTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );
    }


    _closeContextMenu() {
        const menu = this._contextMenu;
        this._contextMenu = null;

        if (!menu)
            return;

        try {
            menu.close(false);
        } catch {
            // Ignore.
        }

        try {
            menu.destroy();
        } catch {
            // Ignore.
        }
    }


    _showContextMenu(row) {
        if (!row)
            return;

        this._closeContextMenu();

        const menu = new PopupMenu.PopupMenu(row, 0.25, St.Side.TOP);
        this._contextMenu = menu;

        try {
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            this._contextMenuManager.addMenu(menu);
        } catch (error) {
            console.error(`Folders: context menu setup failed: ${error}`);
            try {
                menu.destroy();
            } catch {
                // Ignore.
            }
            this._contextMenu = null;
            return;
        }

        const virtual = Boolean(row._folderBrowserVirtualGroup);
        const file = row._folderBrowserFile;
        const depth = row._folderBrowserDepth;

        const archive = this._isArchiveRow(row);
        menu.addAction(archive ? 'Extract Here' : 'Open', () => {
            if (archive)
                void this._extractArchiveRow(row, false);
            else
                row._folderBrowserActivate?.();
        }, archive ? 'package-x-generic-symbolic' : 'document-open-symbolic');

        if (!virtual && file) {
            menu.addAction('Drag to Another App…   Ctrl+Shift+D', () => {
                this._openDragWindow(row);
            }, 'document-send-symbolic');

            const fileManagerName = this._getDefaultFileManagerName();
            menu.addAction(`Open in ${fileManagerName}`, () => {
                this._openRowInFileManager(row);
            }, 'system-file-manager-symbolic');

            const terminalItem = menu.addAction('Open in Terminal', () => {
                this._openRowInTerminal(row);
            }, 'utilities-terminal-symbolic');
            terminalItem.sensitive = Boolean(
                (row._folderBrowserIsDirectory ? file : file.get_parent())?.get_path?.()
            );

            if (row._folderBrowserIsDirectory) {
                const bookmarkRecord = this._getGtkBookmarkRecord(file);
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                if (bookmarkRecord) {
                    menu.addAction('Change Pinned Display Name…', () => {
                        this._promptPinnedDisplayName(row);
                    }, 'document-edit-symbolic');

                    menu.addAction('Unpin Folder', () => {
                        void this._removeBookmarkRow(row);
                    }, 'starred-symbolic');
                } else {
                    menu.addAction('Pin Folder', () => {
                        void this._pinFolderRow(row);
                    }, 'starred-symbolic');
                }
            }

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const selectedCount = this._selectionFilesForRow(row).length;
            const selectionSuffix = selectedCount > 1 ? ` ${selectedCount} Items` : '';

            menu.addAction(`Copy${selectionSuffix}`, () => {
                this._setClipboardRow(row, 'copy');
            }, 'edit-copy-symbolic');

            menu.addAction(`Cut${selectionSuffix}`, () => {
                this._setClipboardRow(row, 'cut');
            }, 'edit-cut-symbolic');

            const pasteItem = menu.addAction('Paste Here', () => {
                void this._pasteIntoRowColumn(row);
            }, 'edit-paste-symbolic');
            pasteItem.sensitive = this._clipboardFiles.length > 0 &&
                Boolean(this._getPasteTargetForRow(row));

            menu.addAction('Copy Path / URI   Ctrl+L', () => {
                this._copyRowPathToClipboard(row);
            }, 'edit-copy-symbolic');

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const newFolderItem = menu.addAction('New Folder…', () => {
                this._promptNewFolder(row);
            }, 'folder-new-symbolic');
            newFolderItem.sensitive = Boolean(this._getContextTargetDirectory(row));

            if (depth > 0) {
                menu.addAction('Rename…', () => {
                    this._promptRename(row);
                }, 'document-edit-symbolic');
            }

            if (this._isArchiveRow(row)) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                menu.addAction(
                    `Extract to “${this._archiveFolderName(row._folderBrowserName)}”`,
                    () => {
                        void this._extractArchiveRow(row, true);
                    },
                    'folder-new-symbolic'
                );
            }

            menu.addAction('Properties', () => {
                void this._showRowProperties(row);
            }, 'dialog-information-symbolic');

            const sortDirectory = this._getSortDirectoryForRow(row);
            if (sortDirectory) {
                const currentSort = this._getSortSetting(sortDirectory);
                const metricNames = {
                    name: 'Name',
                    type: 'Type',
                    size: 'Size',
                    modified: 'Modified',
                };

                const sortMenu = new PopupMenu.PopupSubMenuMenuItem(
                    `Sort: ${metricNames[currentSort.metric]} ${currentSort.ascending ? '↑' : '↓'}`
                );
                menu.addMenuItem(sortMenu);

                for (const [metric, label] of Object.entries(metricNames)) {
                    sortMenu.menu.addAction(
                        `${currentSort.metric === metric ? '✓ ' : ''}${label}`,
                        () => this._setSortForRow(row, metric, null)
                    );
                }

                sortMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                sortMenu.menu.addAction(
                    `${currentSort.ascending ? '✓ ' : ''}Ascending`,
                    () => this._setSortForRow(row, null, true)
                );
                sortMenu.menu.addAction(
                    `${!currentSort.ascending ? '✓ ' : ''}Descending`,
                    () => this._setSortForRow(row, null, false)
                );
            }

            if (depth > 0) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                const deleteCount = this._selectionFilesForRow(row).length;
                menu.addAction(
                    deleteCount > 1 ? `Move ${deleteCount} Items to Trash` : 'Move to Trash',
                    () => { void this._trashRow(row); },
                    'user-trash-symbolic'
                );

                menu.addAction(
                    deleteCount > 1 ? `Delete ${deleteCount} Items Permanently` : 'Delete Permanently',
                    () => { void this._permanentlyDeleteRow(row); },
                    'edit-delete-symbolic'
                );
            }
        }

        menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                return;

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._contextMenu === menu) {
                    this._contextMenu = null;
                    try {
                        menu.destroy();
                    } catch {
                        // Ignore.
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        menu.open(true);
    }


    _getContextTargetDirectory(row) {
        if (!row || row._folderBrowserVirtualGroup)
            return null;

        if (row._folderBrowserIsDirectory && row._folderBrowserFile)
            return row._folderBrowserFile;

        const depth = row._folderBrowserDepth;
        if (depth <= 0)
            return null;

        return this._columnDirectories[depth] ?? row._folderBrowserFile?.get_parent?.() ?? null;
    }


    _promptForText(title, initialText, acceptLabel, callback) {
        this._closeContextMenu();

        const dialog = new ModalDialog.ModalDialog({
            destroyOnClose: true,
        });

        const titleLabel = new St.Label({
            text: title,
            style: 'font-weight: bold; font-size: 1.1em;',
        });
        dialog.contentLayout.add_child(titleLabel);

        const entry = new St.Entry({
            text: initialText ?? '',
            can_focus: true,
            x_expand: true,
            style: 'min-width: 360px; padding: 8px;',
        });
        dialog.contentLayout.add_child(entry);

        dialog.setButtons([
            {
                label: 'Cancel',
                key: Clutter.KEY_Escape,
                action: () => dialog.close(global.get_current_time()),
            },
            {
                label: acceptLabel,
                isDefault: true,
                action: () => {
                    const value = entry.get_text().trim();
                    dialog.close(global.get_current_time());
                    if (!value)
                        return;

                    void Promise.resolve(callback(value)).catch(error => {
                        console.error(`Folders: ${title} failed: ${error}`);
                        Main.notifyError(title, error?.message ?? String(error));
                    });
                },
            },
        ]);

        dialog.setInitialKeyFocus(entry);
        dialog.open(global.get_current_time());
    }


    _promptRename(row) {
        if (!row || row._folderBrowserDepth <= 0 || row._folderBrowserVirtualGroup)
            return;

        this._promptForText(
            'Rename',
            row._folderBrowserFile?.get_basename?.() ?? row._folderBrowserName ?? '',
            'Rename',
            newName => this._renameRowTo(row, newName)
        );
    }


    async _renameRowTo(row, newName) {
        if (!newName || newName.includes('/'))
            throw new Error('Name cannot contain “/”.');

        const file = row._folderBrowserFile;
        const parent = file?.get_parent?.();
        if (!file || !parent)
            return;

        const destination = parent.get_child(newName);
        if (destination.query_exists(null))
            throw new Error('An item with that name already exists.');

        this._fileOperationBusy = true;
        this._showStatus('Renaming…', 60_000);
        try {
            if (this._clipboardFiles.some(item => item.equal(file)))
                this._clearClipboardState();

            await this._moveFileAsync(file, destination);
            this._refreshDirectory(parent);
            this._showStatus('Renamed');
        } finally {
            this._fileOperationBusy = false;
        }
    }


    _promptNewFolder(row) {
        const target = this._getContextTargetDirectory(row);
        if (!target)
            return;

        this._promptForText(
            'New Folder',
            'New Folder',
            'Create',
            name => this._createFolderIn(target, name)
        );
    }


    async _createFolderIn(directory, name) {
        if (!name || name.includes('/'))
            throw new Error('Folder name cannot contain “/”.');

        const child = directory.get_child(name);
        if (child.query_exists(null))
            throw new Error('An item with that name already exists.');

        this._fileOperationBusy = true;
        this._showStatus('Creating folder…', 60_000);
        try {
            await child.make_directory_async(GLib.PRIORITY_DEFAULT, null);
            this._refreshDirectory(directory);
            this._showStatus('Folder created');
        } finally {
            this._fileOperationBusy = false;
        }
    }


    _copyRowPathToClipboard(row) {
        const file = row?._folderBrowserFile;
        if (!file)
            return;

        const text = file.get_path?.() ?? file.get_uri?.() ?? '';
        if (!text)
            return;

        St.Clipboard.get_default().set_text(
            St.ClipboardType.CLIPBOARD,
            text
        );
        this._showStatus('Path copied');
    }


    _getSortDirectoryForRow(row) {
        const depth = row?._folderBrowserDepth;
        if (depth === undefined || depth <= 0)
            return null;

        return this._columnDirectories[depth] ?? null;
    }


    _getSortSetting(directory) {
        const key = directory?.get_uri?.();
        if (!key)
            return {metric: 'name', ascending: true};

        return this._sortSettings.get(key) ?? {
            metric: 'name',
            ascending: true,
        };
    }


    _setSortForRow(row, metric = null, ascending = null) {
        const depth = row?._folderBrowserDepth;
        const directory = depth !== undefined
            ? (this._columnDirectories[depth] ?? null)
            : null;

        if (!directory || depth === undefined || depth <= 0) {
            this._showStatus('Open a folder before sorting');
            return;
        }

        const old = this._getSortSetting(directory);
        const next = {
            metric: metric ?? old.metric,
            ascending: ascending ?? old.ascending,
        };

        this._sortSettings.set(directory.get_uri(), next);
        const focusState = this._captureFocusState();
        const selectedUris = new Set(this._multiSelectedUris);
        const selectionDepth = this._multiSelectionDepth;

        this._refreshDirectoryColumn(depth);

        if (selectionDepth === depth) {
            this._multiSelectedUris = selectedUris;
            this._multiSelectionDepth = depth;
            this._refreshSelectionVisuals(depth);
        }

        this._restoreFocusState(focusState);

        const names = {
            name: 'Name',
            type: 'Type',
            size: 'Size',
            modified: 'Modified',
        };
        this._showStatus(
            `Sorted by ${names[next.metric]} ${next.ascending ? 'ascending' : 'descending'}`
        );
    }


    _sortEntries(directory, entries) {
        const setting = this._getSortSetting(directory);
        const direction = setting.ascending ? 1 : -1;

        const compareText = (a, b) =>
            String(a ?? '').localeCompare(String(b ?? ''), undefined, {
                numeric: true,
                sensitivity: 'base',
            });

        const modifiedUnix = entry => {
            try {
                return entry.modified?.to_unix?.() ?? 0;
            } catch {
                return 0;
            }
        };

        const compareMetric = (a, b) => {
            let result = 0;

            switch (setting.metric) {
            case 'type':
                result = compareText(
                    a.contentType ?? (a.isDirectory ? 'inode/directory' : ''),
                    b.contentType ?? (b.isDirectory ? 'inode/directory' : '')
                );
                break;

            case 'size':
                result = Number(a.size ?? 0) - Number(b.size ?? 0);
                break;

            case 'modified':
                result = modifiedUnix(a) - modifiedUnix(b);
                break;

            case 'name':
            default:
                result = compareText(a.displayName, b.displayName);
                break;
            }

            if (result === 0)
                result = compareText(a.displayName, b.displayName);

            return result * direction;
        };

        entries.sort((a, b) => {
            // Keep directories grouped first, like a normal file manager.
            if (a.isDirectory !== b.isDirectory)
                return a.isDirectory ? -1 : 1;

            return compareMetric(a, b);
        });

        return entries;
    }


    _isArchiveName(name) {
        const lower = String(name ?? '').toLowerCase();
        return [
            '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst',
            '.tgz', '.tbz2', '.txz', '.tzst',
            '.zip', '.rar', '.7z', '.tar',
        ].some(ext => lower.endsWith(ext));
    }


    _isArchiveRow(row) {
        return Boolean(
            row &&
            !row._folderBrowserIsDirectory &&
            row._folderBrowserFile?.get_path?.() &&
            this._isArchiveName(row._folderBrowserName)
        );
    }


    _archiveFolderName(name) {
        let result = String(name ?? 'archive');
        const lower = result.toLowerCase();
        const extensions = [
            '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst',
            '.tgz', '.tbz2', '.txz', '.tzst',
            '.zip', '.rar', '.7z', '.tar',
        ];

        for (const ext of extensions) {
            if (lower.endsWith(ext)) {
                result = result.slice(0, -ext.length);
                break;
            }
        }

        return result || 'archive';
    }


    _archiveExtractCommand(archivePath, destinationPath, name) {
        const lower = String(name ?? '').toLowerCase();
        const find = program => GLib.find_program_in_path(program);

        if (lower.endsWith('.rar')) {
            const unrar = find('unrar');
            if (unrar)
                return [unrar, 'x', '-o+', '--', archivePath, `${destinationPath}/`];

            const seven = find('7z') ?? find('7zz');
            if (seven)
                return [seven, 'x', '-y', '-aoa', `-o${destinationPath}`, archivePath];

            const bsdtar = find('bsdtar');
            if (bsdtar)
                return [bsdtar, '-xf', archivePath, '-C', destinationPath];

            return null;
        }

        if (lower.endsWith('.7z')) {
            const seven = find('7z') ?? find('7zz');
            if (seven)
                return [seven, 'x', '-y', '-aoa', `-o${destinationPath}`, archivePath];

            const bsdtar = find('bsdtar');
            if (bsdtar)
                return [bsdtar, '-xf', archivePath, '-C', destinationPath];

            return null;
        }

        if (lower.endsWith('.zip')) {
            const bsdtar = find('bsdtar');
            if (bsdtar)
                return [bsdtar, '-xf', archivePath, '-C', destinationPath];

            const unzip = find('unzip');
            if (unzip)
                return [unzip, '-o', archivePath, '-d', destinationPath];

            const seven = find('7z') ?? find('7zz');
            if (seven)
                return [seven, 'x', '-y', '-aoa', `-o${destinationPath}`, archivePath];

            return null;
        }

        const tar = find('tar');
        if (tar)
            return [tar, '-xf', archivePath, '-C', destinationPath];

        const bsdtar = find('bsdtar');
        if (bsdtar)
            return [bsdtar, '-xf', archivePath, '-C', destinationPath];

        const seven = find('7z') ?? find('7zz');
        if (seven)
            return [seven, 'x', '-y', '-aoa', `-o${destinationPath}`, archivePath];

        return null;
    }


    async _extractArchiveRow(row, ownFolder = false) {
        if (this._fileOperationBusy || !this._isArchiveRow(row))
            return;

        const file = row._folderBrowserFile;
        const archivePath = file.get_path();
        const parent = file.get_parent();
        const parentPath = parent?.get_path?.();

        if (!archivePath || !parent || !parentPath) {
            this._showStatus('Extraction requires a local archive');
            return;
        }

        let destination = parent;

        if (ownFolder) {
            destination = this._makeUniqueDestination(
                parent,
                this._archiveFolderName(row._folderBrowserName)
            );
        }

        const destinationPath = destination.get_path();
        if (!destinationPath)
            return;

        const command = this._archiveExtractCommand(
            archivePath,
            destinationPath,
            row._folderBrowserName
        );

        if (!command) {
            this._showStatus('No archive extractor found');
            Main.notify(
                'Folders',
                'Install bsdtar, 7zip/7z, unrar, unzip, or tar to extract this archive.'
            );
            return;
        }

        this._fileOperationBusy = true;
        this._showStatus(
            ownFolder ? 'Extracting to folder…' : 'Extracting here…',
            60_000
        );

        try {
            if (ownFolder) {
                const mkdir = GLib.find_program_in_path('mkdir');
                if (mkdir) {
                    await this._runLocalCommand([mkdir, '-p', '--', destinationPath]);
                } else {
                    GLib.mkdir_with_parents(destinationPath, 0o755);
                }
            }

            await this._runLocalCommand(command);
            this._refreshDirectory(parent);

            if (ownFolder)
                this._refreshDirectory(destination);

            this._showStatus('Extracted');
        } catch (error) {
            console.error(`Folders: archive extraction failed: ${error}`);
            this._showStatus('Extraction failed');
            Main.notifyError(
                'Folders: Extraction failed',
                error?.message ?? String(error)
            );
        } finally {
            this._fileOperationBusy = false;
        }
    }


    _openRowInTerminal(row) {
        const file = row?._folderBrowserFile;
        const directory = row?._folderBrowserIsDirectory
            ? file
            : file?.get_parent?.();
        const path = directory?.get_path?.();

        if (!path) {
            this._showStatus('Terminal requires a local folder');
            return;
        }

        /*
         * Kitty + tmux needs special handling.  --directory correctly sets
         * Kitty's cwd, but a shell that auto-attaches an existing tmux session
         * can immediately replace it with that session's old working
         * directory.  If tmux already has a session, create a new tmux window
         * at the requested path and attach the new Kitty window to that
         * session.  With no existing session, the user's normal shell starts
         * in the requested directory (and any tmux autostart inherits it).
         */
        const kitty = GLib.find_program_in_path('kitty');
        if (kitty) {
            const script = [
                'target="$1"',
                'cd -- "$target" || exit 1',
                'if command -v tmux >/dev/null 2>&1; then',
                '  session="$(tmux list-sessions -F \'#{session_name}\' 2>/dev/null | head -n 1)"',
                '  if [ -n "$session" ]; then',
                '    if tmux new-window -t "$session:" -c "$target" >/dev/null 2>&1; then',
                '      exec tmux attach-session -t "$session"',
                '    fi',
                '  fi',
                'fi',
                'exec "${SHELL:-/bin/bash}" -l',
            ].join('\n');

            try {
                Gio.Subprocess.new(
                    [
                        kitty,
                        '--directory',
                        path,
                        '/bin/sh',
                        '-lc',
                        script,
                        'folders-open-terminal',
                        path,
                    ],
                    Gio.SubprocessFlags.NONE
                );
                this._showStatus('Opened Kitty here');
                return;
            } catch (error) {
                console.debug(`Folders: terminal kitty failed: ${error}`);
            }
        }

        const candidates = [
            ['ptyxis', ['--working-directory', path]],
            ['kgx', ['--working-directory', path]],
            ['gnome-terminal', [`--working-directory=${path}`]],
        ];

        for (const [name, args] of candidates) {
            const program = GLib.find_program_in_path(name);
            if (!program)
                continue;

            try {
                Gio.Subprocess.new(
                    [program, ...args],
                    Gio.SubprocessFlags.NONE
                );
                this._showStatus(`Opened ${name} here`);
                return;
            } catch (error) {
                console.debug(`Folders: terminal ${name} failed: ${error}`);
            }
        }

        this._showStatus('No supported terminal found');
    }

    async _showRowProperties(row) {
        const file = row?._folderBrowserFile;
        if (!file)
            return;

        try {
            const info = await file.query_info_async(
                'standard::display-name,standard::content-type,standard::size,standard::type,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                null
            );

            let modified = 'Unknown';
            try {
                const dt = info.get_modification_date_time();
                if (dt)
                    modified = dt.format('%Y-%m-%d %H:%M');
            } catch {
                // Ignore.
            }

            const location = file.get_path?.() ?? file.get_uri?.() ?? '';
            const type = info.get_file_type() === Gio.FileType.DIRECTORY
                ? 'Folder'
                : (info.get_content_type() ?? 'File');

            Main.notify(
                info.get_display_name() ?? row._folderBrowserName,
                `Type: ${type}\n` +
                `Size: ${this._formatFileSize(Number(info.get_size()))}\n` +
                `Modified: ${modified}\n` +
                `Location: ${location}`
            );
        } catch (error) {
            Main.notifyError('Properties', error?.message ?? String(error));
        }
    }


    _getPasteTargetForRow(row) {
        if (!row)
            return null;
        const columnDirectory = this._columnDirectories[row._folderBrowserDepth] ?? null;

        // Default: the folder whose contents are displayed in this column.
        // Read the setting on each paste so preference changes apply immediately.
        if (!this._settingBoolean('paste-into-focused-folder', false) && columnDirectory)
            return columnDirectory;

        // Bookmarks and virtual location lists have no containing directory.
        // A real folder row there remains a usable destination in either mode.
        if (row._folderBrowserIsDirectory && row._folderBrowserFile)
            return row._folderBrowserFile;
        return columnDirectory;
    }


    _captureFocusState() {
        try {
            const focused = global.stage.get_key_focus();

            if (
                focused &&
                Number.isInteger(focused._folderBrowserDepth)
            ) {
                return {
                    depth: focused._folderBrowserDepth,
                    uri: focused._folderBrowserFile?.get_uri?.() ?? null,
                };
            }
        } catch {
            // Ignore.
        }

        return null;
    }


    _restoreFocusState(state) {
        if (!state)
            return;

        GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                const rows = this._columnRows[state.depth] ?? [];

                if (rows.length === 0)
                    return GLib.SOURCE_REMOVE;

                let target = null;

                if (state.uri) {
                    target = rows.find(candidate =>
                        candidate._folderBrowserFile?.get_uri?.() === state.uri
                    ) ?? null;
                }

                this._focusRowExplicitly(target ?? rows[0]);
                this._ensureColumnVisible(state.depth);

                return GLib.SOURCE_REMOVE;
            }
        );
    }


    async _pasteIntoRowColumn(row) {
        if (this._clipboardFiles.length === 0)
            return;

        if (this._fileOperationBusy) {
            this._showStatus('Busy…');
            return;
        }

        const targetDirectory = this._getPasteTargetForRow(row);

        if (!targetDirectory)
            return;

        const mode = this._clipboardMode ?? 'copy';
        const focusState = this._captureFocusState();
        const items = [];
        const sourceParents = [];

        this._fileOperationBusy = true;
        this._showStatus(mode === 'cut' ? 'Moving…' : 'Pasting…', 60_000);

        try {
            for (const source of this._clipboardFiles) {
                if (this._wouldCopyIntoSelf(source, targetDirectory)) {
                    console.warn(
                        `Folders: refusing to ${mode} ${source.get_uri()} into itself`
                    );
                    continue;
                }

                const destination = this._makeUniqueDestination(
                    targetDirectory,
                    source.get_basename() ?? 'copy'
                );

                const sourceParent = source.get_parent();
                if (sourceParent)
                    sourceParents.push(sourceParent);

                if (mode === 'cut') {
                    await this._moveFileAsync(source, destination);
                } else {
                    await this._copyFileSmartAsync(source, destination);
                }

                items.push({source, destination});
            }

            if (items.length === 0) {
                this._showStatus('Nothing pasted');
                return;
            }

            this._undoStack.push({
                type: mode === 'cut' ? 'move' : 'paste',
                items,
                directory: targetDirectory,
            });
            this._redoStack = [];

            if (mode === 'cut')
                this._clearClipboardState();

            /*
             * Refresh only after I/O completes, and restore whichever row had
             * keyboard focus before the refresh.  This avoids the "focus died
             * after paste" behaviour of the previous build.
             */
            this._refreshDirectoryPreservingView(targetDirectory);

            if (mode === 'cut') {
                for (const parent of sourceParents) {
                    if (!parent.equal(targetDirectory))
                        this._refreshDirectoryPreservingView(parent);
                }
            }

            this._restoreFocusState(focusState);
            this._showStatus(mode === 'cut' ? 'Moved' : 'Pasted');
        } catch (error) {
            console.error(`Folders: paste failed: ${error}`);
            this._showStatus('Paste failed');
        } finally {
            this._fileOperationBusy = false;
        }
    }


    async _trashRow(row) {
        if (this._fileOperationBusy)
            return;

        if (row?._folderBrowserVirtualGroup) {
            this._showStatus('Virtual group cannot be deleted');
            return;
        }

        if (row._folderBrowserDepth === 0) {
            await this._removeBookmarkRow(row);
            return;
        }

        const files = this._selectionFilesForRow(row);
        if (files.length === 0)
            return;

        const parent = files[0]?.get_parent?.();
        if (!parent)
            return;

        const focusState = this._captureFocusState();
        this._fileOperationBusy = true;
        this._showStatus(files.length > 1 ? `Moving ${files.length} items to Trash…` : 'Moving to Trash…', 60_000);

        try {
            if (this._clipboardFiles.some(item => files.some(file => item.equal(file))))
                this._clearClipboardState();

            for (const file of files)
                await this._trashFileAsync(file);

            this._clearMultiSelection();
            this._refreshDirectory(parent);
            this._restoreFocusState(focusState);
            this._showStatus(files.length > 1 ? `${files.length} items moved to Trash` : 'Moved to Trash');
        } catch (error) {
            console.error(`Folders: trash failed: ${error}`);
            this._showStatus('Trash failed');
            Main.notifyError('Folders: Trash failed', error?.message ?? String(error));
        } finally {
            this._fileOperationBusy = false;
        }
    }


    async _permanentlyDeleteRow(row) {
        if (this._fileOperationBusy)
            return;

        if (row?._folderBrowserVirtualGroup) {
            this._showStatus('Virtual group cannot be deleted');
            return;
        }

        if (row._folderBrowserDepth === 0) {
            this._showStatus('Open it first to permanently delete items');
            return;
        }

        const files = this._selectionFilesForRow(row);
        if (files.length === 0)
            return;

        const parent = files[0]?.get_parent?.();
        if (!parent)
            return;

        const focusState = this._captureFocusState();
        this._fileOperationBusy = true;
        this._showStatus(files.length > 1 ? `Deleting ${files.length} items permanently…` : 'Deleting permanently…', 60_000);

        try {
            if (this._clipboardFiles.some(item => files.some(file => item.equal(file))))
                this._clearClipboardState();

            for (const file of files) {
                const path = file.get_path?.();
                const rm = path ? GLib.find_program_in_path('rm') : null;
                if (path && rm) {
                    await this._runLocalCommand([rm, '-rf', '--', path]);
                } else {
                    await this._deleteFileRecursiveAsync(file);
                }
            }

            this._clearMultiSelection();
            this._refreshDirectory(parent);
            this._restoreFocusState(focusState);
            this._showStatus(files.length > 1 ? `${files.length} items permanently deleted` : 'Permanently deleted');
        } catch (error) {
            console.error(`Folders: permanent delete failed: ${error}`);
            this._showStatus('Permanent delete failed');
            Main.notifyError('Folders: Permanent delete failed', error?.message ?? String(error));
        } finally {
            this._fileOperationBusy = false;
        }
    }


    _getGtkBookmarkRecord(file) {
        const uri = file?.get_uri?.();
        if (!uri)
            return null;

        const bookmarkPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'gtk-3.0',
            'bookmarks',
        ]);
        const bookmarkFile = Gio.File.new_for_path(bookmarkPath);

        try {
            if (!bookmarkFile.query_exists(null))
                return null;

            const [success, contents] = bookmarkFile.load_contents(null);
            if (!success)
                return null;

            const text = new TextDecoder().decode(contents);
            for (const rawLine of text.split('\n')) {
                const line = rawLine.trim();
                if (!line)
                    continue;

                const firstSpace = line.indexOf(' ');
                const lineUri = firstSpace === -1
                    ? line
                    : line.substring(0, firstSpace);

                if (lineUri !== uri)
                    continue;

                return {
                    uri: lineUri,
                    label: firstSpace === -1
                        ? ''
                        : line.substring(firstSpace + 1).trim(),
                };
            }
        } catch (error) {
            console.debug(`Folders: bookmark lookup failed: ${error}`);
        }

        return null;
    }


    async _readGtkBookmarkLines(bookmarkFile) {
        try {
            if (!bookmarkFile.query_exists(null))
                return [];

            const [contents] = await bookmarkFile.load_contents_async(null);
            return new TextDecoder().decode(contents).split('\n');
        } catch (error) {
            console.debug(`Folders: bookmark read failed: ${error}`);
            return [];
        }
    }


    async _writeGtkBookmarkLines(bookmarkFile, lines) {
        const configDir = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'gtk-3.0',
        ]);
        GLib.mkdir_with_parents(configDir, 0o700);

        const cleaned = lines
            .map(line => String(line ?? '').trim())
            .filter(Boolean);
        const text = cleaned.length > 0
            ? `${cleaned.join('\n')}\n`
            : '';

        await bookmarkFile.replace_contents_async(
            new TextEncoder().encode(text),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    }


    async _pinFolderRow(row) {
        if (
            this._fileOperationBusy ||
            !row?._folderBrowserIsDirectory ||
            row?._folderBrowserVirtualGroup
        ) {
            return;
        }

        const file = row._folderBrowserFile;
        const uri = file?.get_uri?.();
        if (!file || !uri)
            return;

        if (this._getGtkBookmarkRecord(file)) {
            this._showStatus('Folder is already pinned');
            return;
        }

        const bookmarkPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'gtk-3.0',
            'bookmarks',
        ]);
        const bookmarkFile = Gio.File.new_for_path(bookmarkPath);

        this._fileOperationBusy = true;
        this._showStatus('Pinning folder…', 60_000);

        try {
            const lines = await this._readGtkBookmarkLines(bookmarkFile);
            lines.push(uri);
            await this._writeGtkBookmarkLines(bookmarkFile, lines);
            this._buildBrowser();
            this._showStatus('Folder pinned');
        } catch (error) {
            console.error(`Folders: pin folder failed: ${error}`);
            this._showStatus('Pin folder failed');
            Main.notifyError(
                'Folders: Pin folder failed',
                error?.message ?? String(error)
            );
        } finally {
            this._fileOperationBusy = false;
        }
    }


    _promptPinnedDisplayName(row) {
        const file = row?._folderBrowserFile;
        const record = this._getGtkBookmarkRecord(file);
        if (!file || !record) {
            this._showStatus('Pin this folder first');
            return;
        }

        const initialName = record.label ||
            row._folderBrowserName ||
            this._getDisplayName(file);

        this._promptForText(
            'Pinned Display Name',
            initialName,
            'Save',
            newName => this._setPinnedDisplayName(file, newName)
        );
    }


    async _setPinnedDisplayName(file, newName) {
        const uri = file?.get_uri?.();
        if (!uri || !newName)
            return;

        const bookmarkPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'gtk-3.0',
            'bookmarks',
        ]);
        const bookmarkFile = Gio.File.new_for_path(bookmarkPath);

        this._fileOperationBusy = true;
        this._showStatus('Updating pinned name…', 60_000);

        try {
            const lines = await this._readGtkBookmarkLines(bookmarkFile);
            let changed = false;

            const updated = lines.map(rawLine => {
                const line = String(rawLine ?? '').trim();
                if (!line)
                    return '';

                const firstSpace = line.indexOf(' ');
                const lineUri = firstSpace === -1
                    ? line
                    : line.substring(0, firstSpace);

                if (!changed && lineUri === uri) {
                    changed = true;
                    return `${uri} ${newName}`;
                }

                return line;
            });

            if (!changed)
                throw new Error('Pinned folder was not found.');

            await this._writeGtkBookmarkLines(bookmarkFile, updated);
            this._buildBrowser();
            this._showStatus('Pinned display name updated');
        } catch (error) {
            console.error(`Folders: pinned display name failed: ${error}`);
            this._showStatus('Pinned name update failed');
            Main.notifyError(
                'Folders: Pinned name update failed',
                error?.message ?? String(error)
            );
        } finally {
            this._fileOperationBusy = false;
        }
    }


    async _removeBookmarkRow(row) {
        const file = row?._folderBrowserFile;
        const uri = file?.get_uri?.();

        if (!uri)
            return;

        const bookmarkPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'gtk-3.0',
            'bookmarks',
        ]);
        const bookmarkFile = Gio.File.new_for_path(bookmarkPath);

        this._fileOperationBusy = true;
        this._showStatus('Removing bookmark…', 60_000);

        try {
            const [contents] = await bookmarkFile.load_contents_async(null);
            const text = new TextDecoder().decode(contents);
            const lines = text.split('\n');
            let removed = false;

            const kept = lines.filter(rawLine => {
                const line = rawLine.trim();
                if (!line)
                    return true;

                const firstSpace = line.indexOf(' ');
                const lineUri = firstSpace === -1
                    ? line
                    : line.substring(0, firstSpace);

                if (!removed && lineUri === uri) {
                    removed = true;
                    return false;
                }

                return true;
            });

            if (!removed) {
                this._showStatus('Bookmark not found');
                return;
            }

            let updated = kept.join('\n');
            if (updated && !updated.endsWith('\n'))
                updated += '\n';

            await bookmarkFile.replace_contents_async(
                new TextEncoder().encode(updated),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            this._buildBrowser();
            this._showStatus('Bookmark removed');

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._focusInitialRow();
                return GLib.SOURCE_REMOVE;
            });
        } catch (error) {
            console.error(`Folders: bookmark delete failed: ${error}`);
            this._showStatus('Bookmark delete failed');
            Main.notifyError(
                'Folders: Bookmark delete failed',
                error?.message ?? String(error)
            );
        } finally {
            this._fileOperationBusy = false;
        }
    }



    async _undoLastFileOperation() {
        if (this._fileOperationBusy)
            return;

        const action = this._undoStack.pop();

        if (!action)
            return;

        const focusState = this._captureFocusState();
        this._fileOperationBusy = true;
        this._showStatus('Undoing…', 60_000);

        try {
            if (action.type === 'paste') {
                for (const item of [...action.items].reverse())
                    await this._deleteFileRecursiveAsync(item.destination);
            } else if (action.type === 'move') {
                for (const item of [...action.items].reverse()) {
                    if (!item.destination.query_exists(null))
                        continue;

                    let restoreTarget = item.source;

                    if (restoreTarget.query_exists(null)) {
                        const parent = restoreTarget.get_parent();
                        if (parent) {
                            restoreTarget = this._makeUniqueDestination(
                                parent,
                                restoreTarget.get_basename() ?? 'restored'
                            );
                            item.source = restoreTarget;
                        }
                    }

                    await this._moveFileAsync(
                        item.destination,
                        restoreTarget
                    );
                }
            }

            this._redoStack.push(action);
            this._refreshDirectory(action.directory);

            for (const item of action.items) {
                const parent = item.source.get_parent();
                if (parent && !parent.equal(action.directory))
                    this._refreshDirectory(parent);
            }

            this._restoreFocusState(focusState);
            this._showStatus('Undone');
        } catch (error) {
            console.error(`Folders: undo failed: ${error}`);
            this._undoStack.push(action);
            this._showStatus('Undo failed');
        } finally {
            this._fileOperationBusy = false;
        }
    }


    async _redoLastFileOperation() {
        if (this._fileOperationBusy)
            return;

        const action = this._redoStack.pop();

        if (!action)
            return;

        const focusState = this._captureFocusState();
        this._fileOperationBusy = true;
        this._showStatus('Redoing…', 60_000);

        try {
            if (action.type === 'paste') {
                for (const item of action.items) {
                    let destination = item.destination;

                    if (destination.query_exists(null)) {
                        destination = this._makeUniqueDestination(
                            action.directory,
                            item.source.get_basename() ?? 'copy'
                        );
                        item.destination = destination;
                    }

                    await this._copyFileSmartAsync(
                        item.source,
                        destination
                    );
                }
            } else if (action.type === 'move') {
                for (const item of action.items) {
                    if (!item.source.query_exists(null))
                        continue;

                    let destination = item.destination;

                    if (destination.query_exists(null)) {
                        destination = this._makeUniqueDestination(
                            action.directory,
                            item.source.get_basename() ?? 'moved'
                        );
                        item.destination = destination;
                    }

                    await this._moveFileAsync(
                        item.source,
                        destination
                    );
                }
            }

            this._undoStack.push(action);
            this._refreshDirectory(action.directory);

            for (const item of action.items) {
                const parent = item.source.get_parent();
                if (parent && !parent.equal(action.directory))
                    this._refreshDirectory(parent);
            }

            this._restoreFocusState(focusState);
            this._showStatus('Redone');
        } catch (error) {
            console.error(`Folders: redo failed: ${error}`);
            this._redoStack.push(action);
            this._showStatus('Redo failed');
        } finally {
            this._fileOperationBusy = false;
        }
    }


    _wouldCopyIntoSelf(source, targetDirectory) {
        const sourceUri = source.get_uri().replace(/\/$/, '');
        const targetUri = targetDirectory.get_uri().replace(/\/$/, '');

        return (
            targetUri === sourceUri ||
            targetUri.startsWith(`${sourceUri}/`)
        );
    }


    _makeUniqueDestination(targetDirectory, basename) {
        let destination = targetDirectory.get_child(basename);

        if (!destination.query_exists(null))
            return destination;

        let counter = 1;

        while (true) {
            const suffix = counter === 1
                ? ' (copy)'
                : ` (copy ${counter})`;

            destination = targetDirectory.get_child(`${basename}${suffix}`);

            if (!destination.query_exists(null))
                return destination;

            counter++;
        }
    }


    async _runLocalCommand(argv) {
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE
        );

        const [stdout, stderr] = await proc.communicate_utf8_async(
            null,
            null
        );

        if (!proc.get_successful()) {
            const detail = stderr?.trim() || stdout?.trim() ||
                `exit status ${proc.get_exit_status()}`;
            throw new Error(detail);
        }

        return stdout ?? '';
    }


    async _moveFileAsync(source, destination) {
        const sourcePath = source?.get_path?.();
        const destinationPath = destination?.get_path?.();

        if (sourcePath && destinationPath) {
            const mv = GLib.find_program_in_path('mv');
            if (mv) {
                await this._runLocalCommand([
                    mv,
                    '--',
                    sourcePath,
                    destinationPath,
                ]);
                return;
            }
        }

        await source.move_async(
            destination,
            Gio.FileCopyFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null
        );
    }


    async _copyFileSmartAsync(source, destination) {
        const sourcePath = source?.get_path?.();
        const destinationPath = destination?.get_path?.();

        if (sourcePath && destinationPath) {
            const cp = GLib.find_program_in_path('cp');
            if (cp) {
                await this._runLocalCommand([
                    cp,
                    '-a',
                    '--reflink=auto',
                    '--sparse=always',
                    '--',
                    sourcePath,
                    destinationPath,
                ]);
                return;
            }
        }

        await this._copyFileRecursiveAsync(source, destination);
    }


    async _trashFileAsync(file) {
        const path = file?.get_path?.();

        if (path) {
            const gio = GLib.find_program_in_path('gio');
            if (gio) {
                await this._runLocalCommand([
                    gio,
                    'trash',
                    path,
                ]);
                return;
            }
        }

        await file.trash_async(
            GLib.PRIORITY_DEFAULT,
            null
        );
    }


    async _copyFileRecursiveAsync(source, destination) {
        const info = await source.query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            null
        );

        if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
            await source.copy_async(
                destination,
                Gio.FileCopyFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                null
            );
            return;
        }

        await destination.make_directory_async(
            GLib.PRIORITY_DEFAULT,
            null
        );

        const enumerator = await source.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            null
        );

        try {
            while (true) {
                const infos = await enumerator.next_files_async(
                    24,
                    GLib.PRIORITY_DEFAULT,
                    null
                );

                if (infos.length === 0)
                    break;

                for (const childInfo of infos) {
                    const name = childInfo.get_name();
                    await this._copyFileRecursiveAsync(
                        source.get_child(name),
                        destination.get_child(name)
                    );
                }
            }
        } finally {
            try {
                enumerator.close(null);
            } catch {
                // Ignore.
            }
        }
    }


    async _deleteFileRecursiveAsync(file) {
        const info = await file.query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            null
        );

        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const enumerator = await file.enumerate_children_async(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                null
            );

            try {
                while (true) {
                    const infos = await enumerator.next_files_async(
                        24,
                        GLib.PRIORITY_DEFAULT,
                        null
                    );

                    if (infos.length === 0)
                        break;

                    for (const childInfo of infos) {
                        await this._deleteFileRecursiveAsync(
                            file.get_child(childInfo.get_name())
                        );
                    }
                }
            } finally {
                try {
                    enumerator.close(null);
                } catch {
                    // Ignore.
                }
            }
        }

        await file.delete_async(
            GLib.PRIORITY_DEFAULT,
            null
        );
    }


    /*
     * =====================================================
     * SMART WHEEL HANDLING
     * =====================================================
     *
     * NEW FINAL BEHAVIOUR:
     *
     * COLUMN HAS NO VERTICAL OVERFLOW
     * --------------------------------
     * Wheel immediately controls horizontal scrolling.
     *
     * COLUMN HAS VERTICAL OVERFLOW
     * ----------------------------
     * Wheel controls vertical scrolling.
     *
     * AT TOP / BOTTOM OF VERTICAL COLUMN
     * ----------------------------------
     * Wait EDGE_TO_HORIZONTAL_DELAY_MS before switching
     * to horizontal.
     *
     * SHIFT + WHEEL / HORIZONTAL TRACKPAD
     * -----------------------------------
     * Horizontal immediately.
     */

    _handleColumnScrollEvent(
        verticalScroll,
        event
    ) {
        const [
            deltaX,
            deltaY,
        ] =
            this._getScrollDeltas(
                event
            );


        const state =
            event.get_state();


        const shiftHeld =
            (
                state &
                Clutter.ModifierType.SHIFT_MASK
            ) !== 0;


        /*
         * Explicit horizontal input always wins.
         */
        if (
            shiftHeld ||
            Math.abs(deltaX) >
            Math.abs(deltaY)
        ) {
            this._resetEdgeDelay(
                verticalScroll
            );


            const horizontalDelta =
                Math.abs(deltaX) > 0.001
                    ? deltaX
                    : deltaY;


            this._scrollHorizontal(
                horizontalDelta
            );


            return Clutter.EVENT_STOP;
        }


        const verticalDelta =
            deltaY;


        if (
            Math.abs(verticalDelta) <
            0.001
        ) {
            return Clutter.EVENT_PROPAGATE;
        }


        const adjustment =
            verticalScroll
                .get_vadjustment();


        /*
         * =================================================
         * FINAL FIX
         * =================================================
         *
         * First determine whether this column actually has
         * ANY vertical overflow at all.
         *
         * If it doesn't, there is no reason to start an
         * edge-delay timer.
         *
         * The wheel becomes horizontal immediately.
         */

        if (
            !this._hasVerticalOverflow(
                adjustment
            )
        ) {
            this._resetEdgeDelay(
                verticalScroll
            );


            this._scrollHorizontal(
                verticalDelta
            );


            return Clutter.EVENT_STOP;
        }


        /*
         * =================================================
         * COLUMN REALLY IS VERTICALLY SCROLLABLE
         * =================================================
         *
         * If there is still room in the requested
         * direction, scroll vertically normally.
         */

        if (
            this._canScrollAdjustment(
                adjustment,
                verticalDelta
            )
        ) {
            this._resetEdgeDelay(
                verticalScroll
            );


            adjustment
                .adjust_for_scroll_event(
                    verticalDelta
                );


            return Clutter.EVENT_STOP;
        }


        /*
         * =================================================
         * WE ARE AT THE TOP/BOTTOM OF A REAL VERTICAL LIST
         * =================================================
         *
         * Apply the 1.4-second delay before horizontal
         * scrolling begins.
         */

        const now =
            GLib.get_monotonic_time();


        const direction =
            verticalDelta > 0
                ? 1
                : -1;


        let edgeState =
            this._edgeScrollState.get(
                verticalScroll
            );


        /*
         * First wheel event at this edge,
         * or the wheel direction changed.
         */
        if (
            !edgeState ||
            edgeState.direction !== direction
        ) {
            this._edgeScrollState.set(
                verticalScroll,

                {
                    direction,
                    startedAt: now,
                }
            );


            return Clutter.EVENT_STOP;
        }


        const elapsedMilliseconds =
            (
                now -
                edgeState.startedAt
            ) /
            1000;


        /*
         * Still waiting at vertical edge.
         */
        if (
            elapsedMilliseconds <
            EDGE_TO_HORIZONTAL_DELAY_MS
        ) {
            return Clutter.EVENT_STOP;
        }


        /*
         * Delay finished:
         * continued wheel movement becomes horizontal.
         */
        this._scrollHorizontal(
            verticalDelta
        );


        return Clutter.EVENT_STOP;
    }


    /*
     * =====================================================
     * DOES THIS COLUMN HAVE VERTICAL OVERFLOW AT ALL?
     * =====================================================
     *
     * This is the final fix.
     *
     * upper - pageSize tells us the maximum scrollable
     * position.
     *
     * If that maximum is effectively equal to the lower
     * bound, the whole list already fits inside the column.
     */

    _hasVerticalOverflow(
        adjustment
    ) {
        const lower =
            adjustment.get_lower();


        const upper =
            adjustment.get_upper();


        const pageSize =
            adjustment.get_page_size();


        const maximum =
            Math.max(
                lower,
                upper - pageSize
            );


        return (
            maximum >
            lower + 0.5
        );
    }


    /*
     * =====================================================
     * RESET EDGE DELAY
     * =====================================================
     */

    _resetEdgeDelay(
        verticalScroll
    ) {
        this._edgeScrollState.delete(
            verticalScroll
        );
    }


    /*
     * =====================================================
     * SCROLL OVER HEADER / EMPTY AREA
     * =====================================================
     */

    _handleHorizontalScrollEvent(
        event
    ) {
        const [
            deltaX,
            deltaY,
        ] =
            this._getScrollDeltas(
                event
            );


        let delta;


        if (
            Math.abs(deltaX) >
            Math.abs(deltaY)
        ) {
            delta =
                deltaX;
        } else {
            delta =
                deltaY;
        }


        if (
            Math.abs(delta) <
            0.001
        ) {
            return Clutter.EVENT_PROPAGATE;
        }


        this._scrollHorizontal(
            delta
        );


        return Clutter.EVENT_STOP;
    }


    /*
     * =====================================================
     * NORMALIZE SCROLL EVENT
     * =====================================================
     */

    _getScrollDeltas(
        event
    ) {
        const direction =
            event.get_scroll_direction();


        switch (direction) {
        case Clutter.ScrollDirection.UP:
            return [0, -1];


        case Clutter.ScrollDirection.DOWN:
            return [0, 1];


        case Clutter.ScrollDirection.LEFT:
            return [-1, 0];


        case Clutter.ScrollDirection.RIGHT:
            return [1, 0];


        case Clutter.ScrollDirection.SMOOTH:
            try {
                const [
                    dx,
                    dy,
                ] =
                    event.get_scroll_delta();


                return [
                    dx ?? 0,
                    dy ?? 0,
                ];
            } catch {
                return [0, 0];
            }


        default:
            return [0, 0];
        }
    }


    /*
     * =====================================================
     * CAN THIS COLUMN STILL SCROLL VERTICALLY
     * IN THE REQUESTED DIRECTION?
     * =====================================================
     */

    _canScrollAdjustment(
        adjustment,
        delta
    ) {
        const lower =
            adjustment.get_lower();


        const upper =
            adjustment.get_upper();


        const pageSize =
            adjustment.get_page_size();


        const value =
            adjustment.get_value();


        const maximum =
            Math.max(
                lower,
                upper - pageSize
            );


        if (
            maximum <=
            lower + 0.5
        ) {
            return false;
        }


        /*
         * Up.
         */
        if (
            delta < 0
        ) {
            return (
                value >
                lower + 0.5
            );
        }


        /*
         * Down.
         */
        if (
            delta > 0
        ) {
            return (
                value <
                maximum - 0.5
            );
        }


        return false;
    }


    _cancelHorizontalPan() {
        if (!this._horizontalPanSourceId)
            return;

        try {
            GLib.source_remove(this._horizontalPanSourceId);
        } catch {
            // Ignore stale source ids.
        }
        this._horizontalPanSourceId = 0;
    }


    _animateHorizontalAdjustmentTo(target, durationMs = null) {
        if (!this._horizontalScroll)
            return;

        let adjustment;
        try {
            adjustment = this._horizontalScroll.get_hadjustment();
        } catch {
            return;
        }

        const lower = adjustment.get_lower();
        const maximum = Math.max(
            lower,
            adjustment.get_upper() - adjustment.get_page_size()
        );
        const destination = Math.min(maximum, Math.max(lower, Number(target) || 0));
        const start = adjustment.get_value();
        const duration = durationMs ?? this._horizontalPanDurationMs();

        this._cancelHorizontalPan();

        if (duration <= 0 || Math.abs(destination - start) < 1) {
            adjustment.set_value(destination);
            return;
        }

        const startedAt = GLib.get_monotonic_time();
        this._horizontalPanSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            16,
            () => {
                const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
                const progress = Math.min(1, elapsedMs / duration);
                // Ease-out quadratic: quick enough to feel responsive while
                // avoiding the jarring hard snap to the far-right edge.
                const eased = 1 - (1 - progress) * (1 - progress);
                adjustment.set_value(start + (destination - start) * eased);

                if (progress >= 1) {
                    this._horizontalPanSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
    }


    _scrollToRightmostFolderSmooth() {
        if (!this._horizontalScroll || !this._columns?.length)
            return;

        try {
            this._updateBrowserWidth();
            const adjustment = this._horizontalScroll.get_hadjustment();
            const lower = adjustment.get_lower();
            const maximum = Math.max(
                lower,
                adjustment.get_upper() - adjustment.get_page_size()
            );
            this._animateHorizontalAdjustmentTo(maximum);
        } catch {
            // Ignore layout races while the popup is opening.
        }
    }


    /*
     * =====================================================
     * HORIZONTAL SCROLL
     * =====================================================
     */

    _scrollHorizontal(
        delta
    ) {
        if (
            Math.abs(delta) <
            0.001
        ) {
            return;
        }


        this._cancelHorizontalPan();

        const adjustment =
            this._horizontalScroll
                .get_hadjustment();


        adjustment
            .adjust_for_scroll_event(
                delta
            );
    }


    /*
     * =====================================================
     * READ DIRECTORY
     * =====================================================
     */

    _readDirectory(
        directory
    ) {
        const attributes = [
            'standard::name',
            'standard::display-name',
            'standard::type',
            'standard::icon',
            'standard::is-hidden',
            'standard::content-type',
            'standard::size',
            'time::modified',
        ].join(',');


        const enumerator =
            directory.enumerate_children(
                attributes,
                Gio.FileQueryInfoFlags.NONE,
                null
            );


        const entries = [];


        try {
            let info;


            while (
                (
                    info =
                        enumerator.next_file(
                            null
                        )
                ) !== null
            ) {
                const name =
                    info.get_name();


                const hidden =
                    info.get_attribute_boolean(
                        'standard::is-hidden'
                    ) ||
                    name.startsWith('.');


                if (
                    hidden &&
                    !this._showHiddenFiles()
                ) {
                    continue;
                }


                const isDirectory =
                    info.get_file_type() ===
                    Gio.FileType.DIRECTORY;


                entries.push({
                    name,

                    displayName:
                        info.get_display_name()
                        ?? name,

                    icon:
                        info.get_icon(),

                    contentType:
                        info.get_content_type(),

                    size:
                        info.get_size(),

                    modified:
                        info.get_modification_date_time(),

                    isDirectory,
                });
            }
        } finally {
            try {
                enumerator.close(
                    null
                );
            } catch {
                // Ignore.
            }
        }


        this._sortEntries(directory, entries);


        return entries;
    }


    /*
     * =====================================================
     * CREATE FILE / FOLDER ROW
     * =====================================================
     */

    _createEntryRow({
        name,
        icon,
        isDirectory,
        file,
        depth,
        previewSeed = null,
        virtualGroup = null,
        onActivate,
    }) {
        const button =
            new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,

                x_expand: true,

                style_class:
                    'popup-menu-item',

                style: ROW_NORMAL_STYLE,
            });


        const content =
            new St.BoxLayout({
                vertical: false,
                x_expand: true,

                style: `
                    spacing: 8px;
                `,
            });


        content.add_child(
            icon
        );


        const label =
            new St.Label({
                text: name,

                x_expand: true,

                y_align:
                    Clutter.ActorAlign.CENTER,
            });


        label.clutter_text.ellipsize =
            Pango.EllipsizeMode.END;


        content.add_child(
            label
        );


        const clipboardMarker =
            new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: 12,
                visible: false,
            });

        content.add_child(
            clipboardMarker
        );


        if (
            isDirectory
        ) {
            content.add_child(
                new St.Icon({
                    icon_name:
                        'go-next-symbolic',

                    icon_size: 12,
                })
            );
        } else {
            content.add_child(
                new St.Widget({
                    width: 12,
                })
            );
        }


        button.set_child(
            content
        );


        button._folderBrowserName = name;
        button._folderBrowserDepth = depth;
        button._folderBrowserFile = file;
        button._folderBrowserIsDirectory = isDirectory;
        button._folderBrowserPreviewSeed = previewSeed;
        button._folderBrowserVirtualGroup = virtualGroup;
        button._folderBrowserActivate = onActivate;
        button._folderBrowserClipboardMarker = clipboardMarker;
        button._folderBrowserPointerHover = false;


        if (!this._columnRows[depth])
            this._columnRows[depth] = [];

        this._columnRows[depth].push(button);



        this._applyClipboardVisual(button);
        this._refreshRowVisual(button);


        /*
         * Clicking and hovering explicitly establish keyboard focus.  This is
         * the behaviour from the standalone focus-fix build that was tested
         * successfully.
         */
        button.connect(
            'clicked',
            () => {
                this._focusRowExplicitly(button);

                // Keep mouse activation consistent with Enter: folders open
                // inside the Miller browser, normal files launch directly, and
                // supported archives extract in place instead of being handed
                // to an external file manager/archive browser.
                if (!isDirectory && this._isArchiveRow(button))
                    void this._extractArchiveRow(button, false);
                else
                    onActivate();
            }
        );


        button.connect(
            'key-focus-in',
            () => {
                this._explicitFocusedRow = button;
                button.add_style_pseudo_class('focus');
                this._refreshRowVisual(button, true);

                this._lastFocusedRows.set(depth, button);
                this._ensureRowVisible(depth, button);

                if (this._suppressColumnRevealOnce)
                    this._suppressColumnRevealOnce = false;
                else
                    this._ensureColumnVisible(depth);

                this._debugFocus(
                    `focus in: depth=${depth} name=${name}`
                );

                if (this._suppressKeyboardPreviewOnce) {
                    this._suppressKeyboardPreviewOnce = false;
                } else if (this._keyboardPreviewsEnabled()) {
                    try {
                        void this._showPreviewForRow(button, 'keyboard');
                    } catch (error) {
                        console.error(`Folders preview: focus preview failed: ${error}`);
                    }
                }
            }
        );


        button.connect(
            'key-focus-out',
            () => {
                if (this._explicitFocusedRow === button)
                    this._explicitFocusedRow = null;
                button.remove_style_pseudo_class('focus');
                this._refreshRowVisual(button, false);

                this._debugFocus(
                    `focus out: depth=${depth} name=${name}`
                );
            }
        );


        button.connect(
            'enter-event',
            () => {
                // Pointer hover is a navigation cue, not an open/active state.
                // Give it the same slim marker as keyboard focus without
                // stealing keyboard focus or changing Miller selection.
                button._folderBrowserPointerHover = true;
                this._refreshRowVisual(button, null, true);

                // Do not move keyboard focus just because the pointer happens
                // to be over a row.  This is what prevents keyboard navigation
                // from snapping back after preview/column layout changes.
                this._handlePointerEnter(button);
                return Clutter.EVENT_PROPAGATE;
            }
        );


        button.connect(
            'motion-event',
            () => {
                // A real mouse movement hands interaction back to hover mode.
                if (this._reactivateMouseHoverFromMotion())
                    this._handlePointerEnter(button);

                return Clutter.EVENT_PROPAGATE;
            }
        );


        button.connect(
            'leave-event',
            () => {
                button._folderBrowserPointerHover = false;
                this._refreshRowVisual(button, null, false);
                this._cancelFolderHoverOpen(button);

                // Mouse previews get a short grace period. Moving directly
                // into another row cancels this timeout, preventing a one-frame
                // flash of the deeper Miller column between previews. Keyboard
                // previews are focus-driven and are never closed by pointer leave.
                if (
                    this._previewSourceRow === button &&
                    this._previewSourceMode === 'mouse' &&
                    !this._previewStickyRightmost
                ) {
                    this._scheduleMousePreviewHide(button);
                }

                return Clutter.EVENT_PROPAGATE;
            }
        );


        button.connect(
            'button-press-event',
            (_actor, event) => {
                try {
                    const mouseButton = event.get_button();
                    const state = event.get_state();
                    const ctrlHeld = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
                    const shiftHeld = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

                    if (mouseButton === 1 && ctrlHeld) {
                        this._focusRowExplicitly(button);
                        this._toggleRowSelection(button);
                        return Clutter.EVENT_STOP;
                    }

                    if (mouseButton === 1 && shiftHeld && depth > 0) {
                        const rows = this._columnRows[depth] ?? [];
                        const previouslyFocused = this._lastFocusedRows.get(depth) ?? null;
                        let anchor = this._selectionAnchorByDepth.get(depth);
                        if (!anchor || !rows.includes(anchor))
                            anchor = (previouslyFocused && rows.includes(previouslyFocused))
                                ? previouslyFocused
                                : button;
                        this._selectionAnchorByDepth.set(depth, anchor);
                        this._focusRowExplicitly(button);
                        this._setRangeSelection(depth, anchor, button, false);
                        return Clutter.EVENT_STOP;
                    }

                    if (mouseButton === 1 && !ctrlHeld && !shiftHeld)
                        this._clearMultiSelection();

                    if (mouseButton === 3) {
                        this._cancelFolderHoverOpen();
                        if (this._multiSelectedUris.size > 0 && !this._isRowMultiSelected(button))
                            this._clearMultiSelection();
                        this._focusRowExplicitly(button);
                        this._showContextMenu(button);
                        return Clutter.EVENT_STOP;
                    }
                } catch {
                    // Ignore unusual pointer events.
                }

                return Clutter.EVENT_PROPAGATE;
            }
        );


        button.connect(
            'key-press-event',
            (_actor, event) =>
                this._handleRowKeyPress(button, event)
        );


        return button;
    }


    /*
     * =====================================================
     * EXPERIMENTAL PREVIEW CACHE + PREVIEW COLUMN
     * =====================================================
     *
     * Design goals:
     * - Preview errors never take down the panel indicator.
     * - Image decoding is asynchronous and scaled to 192x192.
     * - Folder-open preloading is serial.
     * - Entries stay pinned while their folder/menu is open.
     * - Closed-folder entries expire after the configurable retention window.
     */

    startPreviewCache() {
        try {
            this._previewDisposed = false;
            this._startPreviewCacheSweeper();
            this._writePreviewCacheStatus();
            console.log(
                `Folders preview cache: started; status file ${this._previewStatusPath}`
            );
        } catch (error) {
            console.error(`Folders preview cache: failed to start: ${error}`);
            Main.notifyError(
                'Folders preview disabled',
                error?.message ?? String(error)
            );
        }
    }


    _startPreviewCacheSweeper() {
        if (this._previewCacheSweepId || this._previewDisposed)
            return;

        this._previewCacheSweepId = GLib.timeout_add(
            GLib.PRIORITY_LOW,
            PREVIEW_CACHE_SWEEP_MS,
            () => {
                if (this._previewDisposed) {
                    this._previewCacheSweepId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                this._syncPreviewCachePins('sweep');
                this._prunePreviewCache();
                this._writePreviewCacheStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }


    _disposePreviewCache() {
        if (this._previewDisposed)
            return;

        this._previewDisposed = true;
        this._previewToken++;

        try {
            this._hidePreview();
        } catch {
            // Never let cleanup break extension disable.
        }

        if (this._previewCacheSweepId) {
            GLib.source_remove(this._previewCacheSweepId);
            this._previewCacheSweepId = 0;
        }

        this._cancelPreviewPreloadQueue();
        this._clearPreviewCache('extension disabled');
        this._writePreviewCacheStatus(true);
    }


    _cacheNow() {
        return Date.now();
    }


    _previewCacheKey(file) {
        return file?.get_uri?.() ?? null;
    }


    _parentPreviewUri(file) {
        try {
            return file?.get_parent?.()?.get_uri?.() ?? null;
        } catch {
            return null;
        }
    }


    _openPreviewDirectoryUris() {
        const uris = new Set();

        for (const directory of this._columnDirectories ?? []) {
            try {
                const uri = directory?.get_uri?.();
                if (uri)
                    uris.add(uri);
            } catch {
                // Ignore invalid/stale directory objects.
            }
        }

        return uris;
    }


    _isPreviewEntryPinned(entry, openUris = null) {
        if (!entry || !this._menuIsOpen || !this._filePreviewsEnabled())
            return false;

        const uris = openUris ?? this._openPreviewDirectoryUris();
        return Boolean(entry.parentUri && uris.has(entry.parentUri));
    }


    _syncPreviewCachePins(reason = 'state changed') {
        const now = this._cacheNow();
        const openUris = this._openPreviewDirectoryUris();
        let changed = false;

        for (const entry of this._previewCache.values()) {
            const shouldPin = this._isPreviewEntryPinned(entry, openUris);

            if (shouldPin) {
                if (!entry.pinned || Number.isFinite(entry.expiresAt))
                    changed = true;

                entry.pinned = true;
                entry.expiresAt = Infinity;
                continue;
            }

            if (entry.pinned || !Number.isFinite(entry.expiresAt)) {
                entry.pinned = false;
                entry.expiresAt = now + this._previewCacheRetentionMs();
                changed = true;
            }
        }

        if (changed) {
            console.log(
                `Folders preview cache: pin state updated (${reason}); ` +
                `${this._previewCache.size} item(s)`
            );
        }
    }


    _touchPreviewCacheEntry(entry) {
        if (!entry)
            return;

        entry.lastAccess = this._cacheNow();

        if (this._isPreviewEntryPinned(entry)) {
            entry.pinned = true;
            entry.expiresAt = Infinity;
        }
    }


    _isTextPreviewType(contentType) {
        if (!contentType)
            return false;

        return (
            contentType.startsWith('text/') ||
            contentType === 'application/json' ||
            contentType === 'application/xml' ||
            contentType === 'application/javascript' ||
            contentType === 'application/x-javascript'
        );
    }


    _isDocumentPreviewType(contentType) {
        if (!contentType)
            return false;

        return (
            contentType === 'application/pdf' ||
            contentType === 'application/rtf' ||
            contentType.includes('msword') ||
            contentType.includes('officedocument') ||
            contentType.includes('opendocument') ||
            contentType.includes('ms-excel') ||
            contentType.includes('ms-powerpoint')
        );
    }


    _isPreviewableType(contentType) {
        return Boolean(
            contentType?.startsWith('image/') ||
            this._isTextPreviewType(contentType) ||
            this._isDocumentPreviewType(contentType)
        );
    }


    _makePreviewSeedFromEntry(entry) {
        return {
            name: entry.displayName ?? entry.name,
            contentType: entry.contentType ?? null,
            size: Number(entry.size ?? 0),
            icon: entry.icon ?? null,
            modified: entry.modified ?? null,
        };
    }


    async _queryPreviewSeed(file) {
        const info = await file.query_info_async(
            'standard::display-name,standard::content-type,standard::size,standard::icon,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null
        );

        return {
            name: info.get_display_name() ?? this._getDisplayName(file),
            contentType: info.get_content_type() ?? 'application/octet-stream',
            size: Number(info.get_size()),
            icon: info.get_icon(),
            modified: info.get_modification_date_time(),
        };
    }


    _queueFolderPreviewPreload(directory, entries) {
        if (
            this._previewDisposed ||
            !directory ||
            !entries ||
            !this._menuIsOpen ||
            !this._previewPreloadingEnabled()
        )
            return;

        for (const entry of entries) {
            if (entry.isDirectory)
                continue;

            const seed = this._makePreviewSeedFromEntry(entry);
            if (!this._isPreviewableType(seed.contentType))
                continue;

            const file = directory.get_child(entry.name);
            this._queueOnePreviewPreload(file, seed);
        }

        this._scheduleNextPreviewPreload(PREVIEW_PRELOAD_DELAY_MS);
    }


    _queueOpenFolderPreviewPreloads() {
        if (
            this._previewDisposed ||
            !this._menuIsOpen ||
            !this._previewPreloadingEnabled()
        )
            return;

        for (let depth = 1; depth < this._columnRows.length; depth++) {
            for (const row of this._columnRows[depth] ?? []) {
                if (!row || row._folderBrowserIsDirectory)
                    continue;

                const seed = row._folderBrowserPreviewSeed;
                if (!seed || !this._isPreviewableType(seed.contentType))
                    continue;

                this._queueOnePreviewPreload(row._folderBrowserFile, seed);
            }
        }

        this._scheduleNextPreviewPreload(PREVIEW_PRELOAD_DELAY_MS);
    }


    _queueOnePreviewPreload(file, seed) {
        const key = this._previewCacheKey(file);
        if (!key || this._previewCache.has(key) || this._previewPreloadQueuedKeys.has(key))
            return;

        this._previewPreloadQueuedKeys.add(key);
        this._previewPreloadQueue.push({file, seed, key});
    }


    _cancelPreviewPreloadQueue() {
        if (this._previewPreloadSourceId) {
            GLib.source_remove(this._previewPreloadSourceId);
            this._previewPreloadSourceId = 0;
        }

        this._previewPreloadQueue = [];
        this._previewPreloadQueuedKeys.clear();
    }


    _scheduleNextPreviewPreload(delayMs = PREVIEW_PRELOAD_DELAY_MS) {
        if (
            this._previewDisposed ||
            !this._menuIsOpen ||
            this._previewPreloadSourceId ||
            this._previewPreloadQueue.length === 0
        ) {
            return;
        }

        this._previewPreloadSourceId = GLib.timeout_add(
            GLib.PRIORITY_LOW,
            delayMs,
            () => {
                this._previewPreloadSourceId = 0;

                if (this._previewDisposed || !this._menuIsOpen)
                    return GLib.SOURCE_REMOVE;

                const next = this._previewPreloadQueue.shift();
                if (!next)
                    return GLib.SOURCE_REMOVE;

                this._previewPreloadQueuedKeys.delete(next.key);

                void this._ensurePreviewCached(next.file, next.seed, false)
                    .catch(error => {
                        console.debug(
                            `Folders preview cache: preload skipped ` +
                            `${next.seed?.name ?? 'file'}: ${error}`
                        );
                    })
                    .finally(() => {
                        this._writePreviewCacheStatus();
                        this._scheduleNextPreviewPreload(PREVIEW_PRELOAD_DELAY_MS);
                    });

                return GLib.SOURCE_REMOVE;
            }
        );
    }


    async _ensurePreviewCached(file, seed = null, touch = true) {
        if (this._previewDisposed)
            return null;

        const key = this._previewCacheKey(file);
        if (!key)
            return null;

        const now = this._cacheNow();
        let entry = this._previewCache.get(key) ?? null;

        if (entry && !entry.pinned && Number.isFinite(entry.expiresAt) && entry.expiresAt <= now) {
            this._evictPreviewCacheEntry(key, 'retention expired');
            entry = null;
        }

        if (entry) {
            if (entry.loadingPromise) {
                try {
                    await entry.loadingPromise;
                } catch {
                    // The entry still contains safe metadata/icon fallback.
                }
            }

            if (touch)
                this._touchPreviewCacheEntry(entry);

            return entry;
        }

        const metadata = seed ?? await this._queryPreviewSeed(file);
        this._prunePreviewCache();

        entry = {
            key,
            parentUri: this._parentPreviewUri(file),
            file,
            name: metadata.name ?? this._getDisplayName(file),
            contentType: metadata.contentType ?? 'application/octet-stream',
            size: Number(metadata.size ?? 0),
            icon: metadata.icon ?? null,
            modified: metadata.modified ?? null,
            imageContent: null,
            imageWidth: 0,
            imageHeight: 0,
            snippet: null,
            kind: 'details',
            createdAt: now,
            lastAccess: now,
            pinned: false,
            expiresAt: now + this._previewCacheRetentionMs(),
            loadingPromise: null,
        };

        if (this._isPreviewEntryPinned(entry)) {
            entry.pinned = true;
            entry.expiresAt = Infinity;
        }

        this._previewCache.set(key, entry);
        this._writePreviewCacheStatus();

        entry.loadingPromise = this._loadPreviewEntry(entry, file)
            .catch(error => {
                console.debug(
                    `Folders preview cache: could not load ${entry.name}: ${error}`
                );
            })
            .finally(() => {
                entry.loadingPromise = null;
                this._syncPreviewCachePins('load complete');
                this._writePreviewCacheStatus();
            });

        await entry.loadingPromise;

        if (touch)
            this._touchPreviewCacheEntry(entry);

        // Newest preview wins. Evict only as many older entries as needed.
        this._enforcePreviewCacheLimit(entry.key);

        return entry;
    }


    async _loadPreviewEntry(entry, file) {
        if (entry.contentType.startsWith('image/')) {
            entry.kind = 'image';
            const image = await this._createPreviewImageContent(file);

            if (image) {
                entry.imageContent = image.content;
                entry.imageWidth = image.width;
                entry.imageHeight = image.height;
            }
            return;
        }

        const thumbnailPath = this._findCachedThumbnail(file);

        if (thumbnailPath) {
            entry.kind = 'thumbnail';
            const image = await this._createPreviewImageContent(
                Gio.File.new_for_path(thumbnailPath)
            );

            if (image) {
                entry.imageContent = image.content;
                entry.imageWidth = image.width;
                entry.imageHeight = image.height;
            }
        } else if (this._isTextPreviewType(entry.contentType)) {
            entry.kind = 'text';
        } else if (this._isDocumentPreviewType(entry.contentType)) {
            entry.kind = 'document';
        }

        if (
            this._isTextPreviewType(entry.contentType) &&
            entry.size <= PREVIEW_TEXT_MAX_FILE_BYTES
        ) {
            const [contents] = await file.load_contents_async(null);
            entry.snippet = new TextDecoder()
                .decode(contents)
                .slice(0, PREVIEW_TEXT_LIMIT)
                .trim();
        }
    }


    _openFileReadStreamAsync(file) {
        return new Promise((resolve, reject) => {
            try {
                file.read_async(
                    GLib.PRIORITY_LOW,
                    null,
                    (source, result) => {
                        try {
                            resolve(source.read_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            } catch (error) {
                reject(error);
            }
        });
    }


    _loadScaledPixbufAsync(stream) {
        return new Promise((resolve, reject) => {
            try {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                    stream,
                    this._previewImageSize(),
                    this._previewImageSize(),
                    true,
                    null,
                    (_source, result) => {
                        try {
                            resolve(
                                GdkPixbuf.Pixbuf.new_from_stream_finish(result)
                            );
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            } catch (error) {
                reject(error);
            }
        });
    }


    async _createPreviewImageContent(file) {
        let stream = null;

        try {
            stream = await this._openFileReadStreamAsync(file);
            const pixbuf = await this._loadScaledPixbufAsync(stream);

            const width = pixbuf.get_width();
            const height = pixbuf.get_height();

            if (width <= 0 || height <= 0)
                return null;

            const content = St.ImageContent.new_with_preferred_size(
                width,
                height
            );

            const format = pixbuf.get_has_alpha()
                ? Cogl.PixelFormat.RGBA_8888
                : Cogl.PixelFormat.RGB_888;

            if (SHELL_MAJOR >= 48) {
                content.set_data(
                    global.stage.context.get_backend().get_cogl_context(),
                    pixbuf.get_pixels(),
                    format,
                    width,
                    height,
                    pixbuf.get_rowstride()
                );
            } else {
                content.set_data(
                    pixbuf.get_pixels(),
                    format,
                    width,
                    height,
                    pixbuf.get_rowstride()
                );
            }

            return {content, width, height};
        } finally {
            if (stream) {
                try {
                    stream.close(null);
                } catch {
                    // Ignore stream-close failures.
                }
            }
        }
    }


    _prunePreviewCache() {
        const now = this._cacheNow();
        let removed = 0;

        for (const [key, entry] of [...this._previewCache]) {
            if (
                !entry.pinned &&
                Number.isFinite(entry.expiresAt) &&
                entry.expiresAt <= now
            ) {
                if (this._evictPreviewCacheEntry(key, 'retention expired'))
                    removed++;
            }
        }

        if (removed > 0) {
            console.log(
                `Folders preview cache: cleanup removed ${removed}; ` +
                `${this._previewCache.size} item(s) remain`
            );
        }
    }


    _evictPreviewCacheEntry(key, reason = 'evicted') {
        const entry = this._previewCache.get(key);
        if (!entry)
            return false;

        entry.imageContent = null;
        entry.imageWidth = 0;
        entry.imageHeight = 0;
        entry.snippet = null;
        entry.icon = null;
        entry.file = null;

        this._previewCache.delete(key);

        console.log(
            `Folders preview cache: removed ${entry.name} (${reason}); ` +
            `${this._previewCache.size} item(s) remain`
        );

        this._writePreviewCacheStatus();
        return true;
    }


    _clearPreviewCache(reason = 'manual') {
        for (const key of [...this._previewCache.keys()])
            this._evictPreviewCacheEntry(key, reason);

        console.log(
            `Folders preview cache: clear complete; ` +
            `${this._previewCache.size} item(s) remain`
        );
        this._writePreviewCacheStatus();
    }



    _estimatePreviewEntryBytes(entry) {
        if (!entry)
            return 0;

        let bytes = 0;

        if (entry.imageContent) {
            bytes +=
                Math.max(1, entry.imageWidth) *
                Math.max(1, entry.imageHeight) *
                4;
        }

        if (entry.snippet)
            bytes += entry.snippet.length * 2;

        return bytes;
    }


    _enforcePreviewCacheLimit(protectedKey = null) {
        const limit = this._previewCacheLimitBytes();
        let total = this._estimatePreviewCacheBytes();

        if (total <= limit)
            return;

        const candidates = [...this._previewCache.values()]
            .filter(entry =>
                entry &&
                entry.key !== protectedKey &&
                !entry.loadingPromise
            )
            .sort((a, b) =>
                (a.lastAccess ?? a.createdAt ?? 0) -
                (b.lastAccess ?? b.createdAt ?? 0)
            );

        for (const entry of candidates) {
            if (total <= limit)
                break;

            const entryBytes = this._estimatePreviewEntryBytes(entry);
            if (this._evictPreviewCacheEntry(entry.key, 'LRU cache limit'))
                total = Math.max(0, total - entryBytes);
        }

        this._writePreviewCacheStatus();
    }

    _estimatePreviewCacheBytes() {
        let bytes = 0;

        for (const entry of this._previewCache.values())
            bytes += this._estimatePreviewEntryBytes(entry);

        return bytes;
    }


    _previewEntryStatus(entry, now = this._cacheNow()) {
        if (entry.pinned)
            return 'PINNED (folder open)';

        if (!Number.isFinite(entry.expiresAt))
            return 'PINNED';

        const seconds = Math.max(
            0,
            Math.ceil((entry.expiresAt - now) / 1000)
        );
        return `expires in ${seconds}s`;
    }


    _writePreviewCacheStatus(disabled = false) {
        if (!this._previewStatusPath)
            return;

        try {
            const now = this._cacheNow();
            const entries = [...this._previewCache.values()];
            const lines = [
                'Folders Column Browser — preview cache status',
                `Updated: ${new Date(now).toISOString()}`,
                `Extension: ${disabled ? 'disabled' : 'enabled'}`,
                `Menu: ${this._menuIsOpen ? 'OPEN' : 'closed'}`,
                `Cached items: ${entries.length}`,
                `Queued preloads: ${this._previewPreloadQueue.length}`,
                `Estimated preview RAM: ${this._formatFileSize(this._estimatePreviewCacheBytes())}`,
                `Cache limit: ${this._formatFileSize(this._previewCacheLimitBytes())}`,
                `Closed-folder retention: ${Math.round(this._previewCacheRetentionMs() / 1000)} seconds`,
                `Open folder columns: ${this._openPreviewDirectoryUris().size}`,
                '',
            ];

            const ordered = entries.sort((a, b) =>
                String(a.name).localeCompare(String(b.name))
            );

            for (const entry of ordered) {
                lines.push(
                    `${this._previewEntryStatus(entry, now)} | ${entry.kind} | ` +
                    `${this._formatFileSize(this._estimatePreviewEntryBytes(entry))} cache | ` +
                    `${this._formatFileSize(entry.size)} source | ${entry.name}`
                );
            }

            GLib.file_set_contents(
                this._previewStatusPath,
                `${lines.join('\n')}\n`
            );
        } catch (error) {
            console.debug(`Folders preview cache: status-file update failed: ${error}`);
        }
    }


    _reportPreviewCache() {
        this._syncPreviewCachePins('manual report');
        this._prunePreviewCache();
        this._writePreviewCacheStatus();

        const entries = [...this._previewCache.values()];
        const pinned = entries.filter(entry => entry.pinned).length;
        const estimated = this._formatFileSize(
            this._estimatePreviewCacheBytes()
        );

        const message =
            `${entries.length} item(s), ${pinned} pinned, ` +
            `~${estimated} / ${this._formatFileSize(this._previewCacheLimitBytes())} preview RAM. ` +
            `Status: ${this._previewStatusPath}`;

        this._showStatus(`Cache: ${entries.length} (${pinned} pinned)`, 2200);
        Main.notify('Folders preview cache', message);
        console.log(`Folders preview cache: ${message}`);

        for (const entry of entries) {
            console.log(
                `Folders preview cache: ${entry.name} | ` +
                `${entry.kind} | ${this._previewEntryStatus(entry)}`
            );
        }
    }


    _destroyFadingPreviewActor() {
        const actor = this._previewFadingActor;
        this._previewFadingActor = null;
        if (!actor)
            return;

        try {
            actor.remove_all_transitions?.();
            actor.destroy();
        } catch {
            // Ignore stale animation actors.
        }
    }


    _animatePreviewIn(column, switching = false, stickyRightmost = false) {
        if (!column)
            return;

        const duration = switching
            ? this._previewSwitchDurationMs()
            : this._previewOpenDurationMs();

        if (!this._shouldAnimatePreview(stickyRightmost) || duration <= 0) {
            column.set_opacity(255);
            column.translation_x = 0;
            return;
        }

        try {
            column.remove_all_transitions?.();
            column.set_opacity(0);
            column.translation_x = 7;
            if (!switching)
                column.set_width(1);

            column.ease({
                opacity: 255,
                translation_x: 0,
                width: PREVIEW_COLUMN_WIDTH,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    try {
                        column.set_width(PREVIEW_COLUMN_WIDTH);
                        this._scheduleBrowserWidthUpdate();
                    } catch {
                        // Actor may already have been replaced.
                    }
                },
            });
        } catch {
            column.set_opacity(255);
            column.translation_x = 0;
        }
    }


    _hidePreview(animate = false) {
        this._previewCurrentKey = null;
        this._cancelPreviewHideDelay();

        const actor = this._previewColumn;
        const stickyRightmost = this._previewStickyRightmost;

        this._previewColumn = null;
        this._previewBox = null;
        this._previewSourceDepth = null;
        this._previewSourceRow = null;
        this._previewSourceMode = null;
        this._previewStickyRightmost = false;

        if (!actor) {
            this._scheduleBrowserWidthUpdate();
            return;
        }

        this._destroyFadingPreviewActor();

        const duration = this._previewCloseDurationMs();
        if (!animate || !this._shouldAnimatePreview(stickyRightmost) || duration <= 0) {
            try {
                actor.destroy();
            } catch {
                // Ignore preview actor cleanup failures.
            }
            this._scheduleBrowserWidthUpdate();
            return;
        }

        this._previewFadingActor = actor;
        try {
            actor.remove_all_transitions?.();
            actor.ease({
                opacity: 0,
                translation_x: 7,
                width: 1,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._previewFadingActor === actor)
                        this._previewFadingActor = null;
                    try {
                        actor.destroy();
                    } catch {
                        // Ignore.
                    }
                    this._scheduleBrowserWidthUpdate();
                },
            });
        } catch {
            this._previewFadingActor = null;
            try {
                actor.destroy();
            } catch {
                // Ignore.
            }
            this._scheduleBrowserWidthUpdate();
        }
    }


    async _readFolderPreviewEntries(directory, maxItems = null) {
        maxItems = maxItems ?? this._folderPreviewMaxItems();

        const attributes = [
            'standard::name',
            'standard::display-name',
            'standard::type',
            'standard::icon',
            'standard::is-hidden',
            'standard::content-type',
            'standard::size',
            'time::modified',
        ].join(',');

        const enumerator = await directory.enumerate_children_async(
            attributes,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null
        );

        const entries = [];

        try {
            while (entries.length < maxItems) {
                const infos = await enumerator.next_files_async(
                    Math.min(32, maxItems - entries.length),
                    GLib.PRIORITY_DEFAULT,
                    null
                );

                if (!infos || infos.length === 0)
                    break;

                for (const info of infos) {
                    const name = info.get_name();
                    const hidden =
                        info.get_attribute_boolean('standard::is-hidden') ||
                        name.startsWith('.');

                    if (hidden && !this._showHiddenFiles())
                        continue;

                    entries.push({
                        name,
                        displayName: info.get_display_name() ?? name,
                        icon: info.get_icon(),
                        contentType: info.get_content_type(),
                        size: info.get_size(),
                        modified: info.get_modification_date_time(),
                        isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
                    });

                    if (entries.length >= maxItems)
                        break;
                }
            }
        } finally {
            try {
                enumerator.close(null);
            } catch {
                // Ignore.
            }
        }

        return this._sortEntries(directory, entries);
    }


    _addFolderPreviewItem(previewBox, item) {
        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style: 'spacing: 7px; padding: 2px 0;',
        });

        row.add_child(
            item.icon
                ? new St.Icon({gicon: item.icon, icon_size: 16})
                : new St.Icon({
                    icon_name: item.isDirectory
                        ? 'folder-symbolic'
                        : 'text-x-generic-symbolic',
                    icon_size: 16,
                })
        );

        const label = new St.Label({
            text: item.displayName ?? item.name ?? '',
            x_expand: true,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(label);
        previewBox.add_child(row);
    }


    async _showFolderPreviewForRow(row, source = 'mouse') {
        const switchingPreview = Boolean(this._previewColumn || this._previewFadingActor);
        const requestToken = ++this._previewToken;
        this._hidePreview(false);
        this._previewSourceRow = row;
        this._previewSourceMode = source;
        this._previewStickyRightmost = this._rowIsInRightmostFolderColumn(row);

        const column = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            y_expand: true,
            width: PREVIEW_COLUMN_WIDTH,
            clip_to_allocation: true,
            style: `
                height: ${BROWSER_HEIGHT - 16}px;
                padding: 6px;
                spacing: 10px;
                border-right: 1px solid rgba(128, 128, 128, 0.28);
            `,
        });

        const title = new St.Label({
            text: row._folderBrowserName ?? 'Folder',
            x_expand: true,
            style: 'font-weight: bold;',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        column.add_child(title);

        const previewBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'padding: 4px; spacing: 4px;',
        });
        column.add_child(previewBox);

        previewBox.add_child(new St.Icon({
            icon_name: row._folderBrowserVirtualGroup === 'drives'
                ? 'drive-harddisk-symbolic'
                : 'folder-symbolic',
            icon_size: 72,
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const detailsLabel = new St.Label({
            text: 'Loading folder preview…',
            x_expand: true,
            style: 'opacity: 0.72;',
        });
        detailsLabel.clutter_text.line_wrap = true;
        column.add_child(detailsLabel);

        this._previewColumn = column;
        this._previewBox = previewBox;
        this._previewSourceDepth = row._folderBrowserDepth;

        this._columnsBox.insert_child_at_index(
            column,
            Math.max(0, row._folderBrowserDepth + 1)
        );
        this._scheduleBrowserWidthUpdate();
        this._animatePreviewIn(column, switchingPreview, this._previewStickyRightmost);
        this._scrollPreviewIntoView(row._folderBrowserDepth, source);

        try {
            let entries = [];
            let sourceDescription = '';

            if (row._folderBrowserVirtualGroup === 'places') {
                entries = this._getPlacesGroupItems().slice(0, this._folderPreviewMaxItems()).map(item => ({
                    name: item.name,
                    displayName: item.name,
                    icon: item.icon ?? null,
                    isDirectory: true,
                }));
                sourceDescription = 'Virtual group • Places';
            } else if (row._folderBrowserVirtualGroup === 'drives') {
                entries = this._getDriveGroupItems().slice(0, this._folderPreviewMaxItems()).map(item => ({
                    name: item.name,
                    displayName: item.name,
                    icon: item.icon ?? null,
                    isDirectory: true,
                }));
                sourceDescription = 'Virtual group • Mounted drives';
            } else if (row._folderBrowserFile) {
                entries = await this._readFolderPreviewEntries(
                    row._folderBrowserFile,
                    this._folderPreviewMaxItems()
                );
                sourceDescription = row._folderBrowserFile.get_uri();
            }

            if (
                requestToken !== this._previewToken ||
                !this._previewColumn ||
                this._previewSourceRow !== row
            ) {
                return;
            }

            if (entries.length === 0) {
                previewBox.add_child(new St.Label({
                    text: 'Empty folder',
                    style: 'opacity: 0.65; padding-top: 8px;',
                }));
            } else {
                for (const item of entries)
                    this._addFolderPreviewItem(previewBox, item);
            }

            detailsLabel.set_text(
                `${sourceDescription}\n` +
                `Previewing up to ${this._folderPreviewMaxItems()} items • ` +
                'Enter/Right Arrow opens folder'
            );

        } catch (error) {
            console.error(`Folders folder preview: ${error}`);

            if (
                requestToken === this._previewToken &&
                this._previewColumn
            ) {
                detailsLabel.set_text(
                    `Folder preview unavailable\n${error?.message ?? String(error)}`
                );
            }
        }
    }


    async _showPreviewForRow(row, source = 'mouse') {
        if (this._previewDisposed || !row || !this._previewsEnabled())
            return;

        this._cancelPreviewHideDelay();

        if (source === 'keyboard' && !this._keyboardPreviewsEnabled())
            return;

        if (!this._rowAllowedByPreviewScope(row)) {
            if (this._previewColumn && !this._previewStickyRightmost) {
                this._previewToken++;
                this._hidePreview();
            }
            return;
        }

        if (row._folderBrowserIsDirectory || row._folderBrowserVirtualGroup) {
            if (!this._folderPreviewsEnabled() || this._isRowOpenDirectory(row)) {
                if (this._previewColumn && !this._previewStickyRightmost) {
                    this._previewToken++;
                    this._hidePreview();
                }
                return;
            }
            await this._showFolderPreviewForRow(row, source);
            return;
        }

        if (!this._filePreviewsEnabled()) {
            if (this._previewColumn && !this._previewStickyRightmost) {
                this._previewToken++;
                this._hidePreview();
            }
            return;
        }

        const file = row._folderBrowserFile;
        if (!file)
            return;

        const switchingPreview = Boolean(this._previewColumn || this._previewFadingActor);
        const requestToken = ++this._previewToken;
        this._hidePreview(false);
        this._previewSourceRow = row;
        this._previewSourceMode = source;
        this._previewStickyRightmost = this._rowIsInRightmostFolderColumn(row);

        const column = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            y_expand: true,
            width: PREVIEW_COLUMN_WIDTH,
            clip_to_allocation: true,
            style: `
                height: ${BROWSER_HEIGHT - 16}px;
                padding: 6px;
                spacing: 10px;
                border-right: 1px solid rgba(128, 128, 128, 0.28);
            `,
        });

        const title = new St.Label({
            text: row._folderBrowserName ?? this._getDisplayName(file),
            x_expand: true,
            style: 'font-weight: bold;',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        column.add_child(title);

        const previewBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'padding: 4px; spacing: 8px;',
        });
        column.add_child(previewBox);

        const detailsLabel = new St.Label({
            text: 'Loading preview…',
            x_expand: true,
            style: 'opacity: 0.78;',
        });
        detailsLabel.clutter_text.line_wrap = true;
        column.add_child(detailsLabel);

        const cacheLabel = new St.Label({
            text: '',
            x_expand: true,
            style: 'opacity: 0.55; font-size: 0.82em;',
        });
        cacheLabel.clutter_text.line_wrap = true;
        column.add_child(cacheLabel);

        this._previewColumn = column;
        this._previewBox = previewBox;
        this._previewSourceDepth = row._folderBrowserDepth;

        // Insert the preview directly after its source folder column.  Existing
        // deeper Miller columns remain open and simply shift to the right.
        this._columnsBox.insert_child_at_index(
            column,
            Math.max(0, row._folderBrowserDepth + 1)
        );
        this._scheduleBrowserWidthUpdate();
        this._animatePreviewIn(column, switchingPreview, this._previewStickyRightmost);
        this._scrollPreviewIntoView(row._folderBrowserDepth, source);

        try {
            const entry = await this._ensurePreviewCached(
                file,
                row._folderBrowserPreviewSeed ?? null,
                true
            );

            if (
                requestToken !== this._previewToken ||
                !this._previewColumn ||
                !entry
            ) {
                return;
            }

            this._previewCurrentKey = entry.key;
            this._touchPreviewCacheEntry(entry);

            if (entry.imageContent) {
                const imageActor = new Clutter.Actor({
                    content: entry.imageContent,
                    width: entry.imageWidth,
                    height: entry.imageHeight,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                previewBox.add_child(imageActor);
            } else if (entry.icon) {
                previewBox.add_child(
                    new St.Icon({
                        gicon: entry.icon,
                        icon_size: 112,
                        x_align: Clutter.ActorAlign.CENTER,
                    })
                );
            }

            if (entry.snippet) {
                const snippetLabel = new St.Label({
                    text: entry.snippet,
                    x_expand: true,
                    style: `
                        font-family: monospace;
                        font-size: 0.85em;
                        opacity: 0.88;
                        padding-top: 4px;
                    `,
                });
                snippetLabel.clutter_text.line_wrap = true;
                snippetLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                previewBox.add_child(snippetLabel);
            }

            let modifiedText = 'Unknown';
            try {
                if (entry.modified)
                    modifiedText = entry.modified.format('%Y-%m-%d %H:%M');
            } catch {
                // Ignore formatting failures.
            }

            detailsLabel.set_text(
                `Type: ${entry.contentType}\n` +
                `Size: ${this._formatFileSize(entry.size)}\n` +
                `Modified: ${modifiedText}`
            );

            cacheLabel.set_text(
                entry.pinned
                    ? 'Cache: pinned while this folder is open\n' +
                      'Ctrl+Shift+I: inspect • Ctrl+Shift+K: clear'
                    : `Cache: ${this._previewEntryStatus(entry)}\n` +
                      'Ctrl+Shift+I: inspect • Ctrl+Shift+K: clear'
            );

            this._writePreviewCacheStatus();
        } catch (error) {
            console.error(`Folders preview: ${error}`);

            if (
                requestToken === this._previewToken &&
                this._previewColumn
            ) {
                detailsLabel.set_text(
                    `Preview unavailable\n${error?.message ?? String(error)}`
                );
            }
        }
    }



    _findCachedThumbnail(file) {
        try {
            const uri = file.get_uri();
            const checksum = GLib.compute_checksum_for_string(
                GLib.ChecksumType.MD5,
                uri,
                -1
            );

            for (const size of ['x-large', 'large', 'normal']) {
                const candidate = GLib.build_filenamev([
                    GLib.get_user_cache_dir(),
                    'thumbnails',
                    size,
                    `${checksum}.png`,
                ]);

                if (GLib.file_test(candidate, GLib.FileTest.EXISTS))
                    return candidate;
            }
        } catch {
            // Ignore thumbnail-cache lookup failures.
        }

        return null;
    }


    _formatFileSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Math.max(0, Number(bytes) || 0);
        let unit = 0;

        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }

        const digits = unit === 0 || value >= 10 ? 0 : 1;
        return `${value.toFixed(digits)} ${units[unit]}`;
    }


    _scrollPreviewIntoView(sourceDepth = null, source = 'keyboard') {
        // Keyboard navigation can always pan because focus remains attached to
        // the row. A mouse preview normally leaves the viewport stable. A
        // sticky preview from the rightmost real folder is different: it is
        // allowed to pan and must remain visible even after reopening the menu.
        if (source === 'mouse' && !this._previewStickyRightmost)
            return;

        const previewActor = this._previewColumn;
        const previewToken = this._previewToken;

        const reveal = () => {
            if (
                !previewActor ||
                this._previewColumn !== previewActor ||
                this._previewToken !== previewToken ||
                !this._horizontalScroll
            ) {
                return false;
            }

            try {
                // Recompute the scroller width before reading the adjustment.
                // This fixes the stale upper/page-size values that can remain
                // after the topbar menu has been closed and reopened.
                this._updateBrowserWidth();

                const adjustment = this._horizontalScroll.get_hadjustment();
                const lower = adjustment.get_lower();
                const maximum = Math.max(
                    lower,
                    adjustment.get_upper() - adjustment.get_page_size()
                );

                if (this._previewStickyRightmost) {
                    // The preview is the last visual actor. Reveal it with a
                    // short ease-out pan instead of snapping the viewport.
                    this._animateHorizontalAdjustmentTo(maximum);
                    return true;
                }

                const value = adjustment.get_value();
                const pageSize = adjustment.get_page_size();
                const allocation = previewActor.get_allocation_box();
                const left = allocation.x1;
                const right = allocation.x2;
                let target = value;

                if (right > value + pageSize)
                    target = right - pageSize + 8;
                else if (left < value)
                    target = left - 8;

                adjustment.set_value(
                    Math.min(maximum, Math.max(lower, target))
                );
                return true;
            } catch {
                return false;
            }
        };

        // First pass runs after normal layout work. A second short retry is
        // intentional: GNOME Shell menu reopen animation can leave the
        // horizontal adjustment stale for one allocation cycle.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            reveal();
            return GLib.SOURCE_REMOVE;
        });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            reveal();
            return GLib.SOURCE_REMOVE;
        });

        // The preview can still be growing from width=1 to its full width when
        // the early passes above run. Do one final reveal after the configured
        // open/switch animation has completed so the adjustment's upper bound
        // includes the preview's final allocation. This fixes the rightmost
        // preview stopping around 70-75% of the way across.
        const finalRevealDelay = Math.max(
            110,
            this._previewOpenDurationMs() + 40,
            this._previewSwitchDurationMs() + 40
        );
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, finalRevealDelay, () => {
            reveal();
            return GLib.SOURCE_REMOVE;
        });
    }


    /*
     * =====================================================
     * FILE ICON
     * =====================================================
     */

    _createFileIcon(
        entry
    ) {
        if (
            entry.icon !== null
        ) {
            return new St.Icon({
                gicon:
                    entry.icon,

                icon_size: 16,
            });
        }


        return new St.Icon({
            icon_name:
                entry.isDirectory
                    ? 'folder-symbolic'
                    : 'text-x-generic-symbolic',

            icon_size: 16,
        });
    }


    /*
     * =====================================================
     * SELECTED ROW
     * =====================================================
     */

    _setSelectedRow(
        depth,
        row
    ) {
        const oldRow =
            this._selectedRows.get(
                depth
            );


        if (
            oldRow !== undefined &&
            oldRow !== row
        ) {
            try {
                oldRow
                    .remove_style_pseudo_class(
                        'active'
                    );
            } catch {
                // Ignore.
            }
        }


        row.add_style_pseudo_class(
            'active'
        );

        if (this._previewSourceRow === row) {
            this._previewToken++;
            this._hidePreview();
        }


        this._selectedRows.set(
            depth,
            row
        );


        for (
            const existingDepth
            of [...this._selectedRows.keys()]
        ) {
            if (
                existingDepth >
                depth
            ) {
                this._selectedRows.delete(
                    existingDepth
                );
            }
        }
    }


    _animateColumnIn(column) {
        if (!column)
            return;

        try {
            column.remove_all_transitions?.();
            column.set_opacity(0);
            column.translation_x = 12;
            column.ease({
                opacity: 255,
                translation_x: 0,
                duration: COLUMN_OPEN_DURATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } catch {
            try {
                column.set_opacity(255);
                column.translation_x = 0;
            } catch {
                // Ignore stale actors.
            }
        }
    }


    _animateColumnOut(column, onComplete) {
        if (!column) {
            onComplete?.();
            return;
        }

        let completed = false;
        const finish = () => {
            if (completed)
                return;
            completed = true;
            try {
                column.destroy();
            } catch {
                // Ignore stale actors.
            }
            onComplete?.();
        };

        try {
            column.remove_all_transitions?.();
            column.ease({
                opacity: 0,
                translation_x: 12,
                duration: COLUMN_CLOSE_DURATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: finish,
            });
        } catch {
            finish();
        }
    }


    /*
     * =====================================================
     * REMOVE COLUMNS TO RIGHT
     * =====================================================
     */

    _removeColumnsAfter(
        keepCount,
        animate = true,
        onComplete = null,
        revealNewestAfter = false
    ) {
        if (
            this._previewSourceDepth !== null &&
            this._previewSourceDepth >= keepCount
        ) {
            this._previewToken++;
            this._hidePreview();
        }

        const removedColumns = [];

        while (
            this._columns.length >
            keepCount
        ) {
            const column =
                this._columns.pop();


            const removedDepth = this._columns.length;

            removedColumns.push(column);
            this._columnRows.pop();
            this._columnScrolls.pop();
            this._columnLists.pop();
            this._columnDirectories.pop();
            this._lastFocusedRows.delete(removedDepth);

            if (this._multiSelectionDepth !== null && this._multiSelectionDepth >= removedDepth)
                this._clearMultiSelection(false);
        }

        const finishRemoval = () => {
            // For branch replacement, create the incoming child before the
            // post-removal width/clamp pass. That way the browser never has a
            // one-frame "short" layout that would snap the viewport left.
            try {
                onComplete?.();
            } catch (error) {
                logError(error, 'FocusTrail: column-removal completion failed');
            }

            this._scheduleBrowserWidthUpdate();
            this._clampHorizontalPosition();

            // Branch opening/replacement must end with the reveal, not with a
            // clamp. v25.4 started the reveal inside onComplete(), which meant
            // the width/clamp work below could cancel that animation and leave
            // freshly opened columns off-screen. Queue the reveal only after
            // all post-removal layout/clamp work has been scheduled, making it
            // the authoritative final viewport operation for this transition.
            if (revealNewestAfter)
                this._scrollToNewestColumn();
        };

        if (animate && removedColumns.length > 0) {
            let remaining = removedColumns.length;
            const finishOne = () => {
                remaining--;
                if (remaining > 0)
                    return;

                finishRemoval();
            };

            for (const column of removedColumns)
                this._animateColumnOut(column, finishOne);
        } else {
            for (const column of removedColumns) {
                try {
                    column.destroy();
                } catch {
                    // Ignore stale actors.
                }
            }
            finishRemoval();
        }


        this._syncPreviewCachePins('folder columns changed');
        this._writePreviewCacheStatus();
    }


    /*
     * =====================================================
     * AUTO-SCROLL TO NEWEST COLUMN
     * =====================================================
     */

    _scrollToNewestColumn() {
        /*
         * Opening a column also queues _scheduleBrowserWidthUpdate(), and that
         * update queues _clampHorizontalPosition() on the following idle turn.
         * If we start the pan on the first idle turn, that clamp cancels the
         * animation and leaves the new column outside the viewport until some
         * later pointer/scroll event happens.
         *
         * Wait through both layout idle turns, then make the reveal the final
         * viewport operation.  Refresh the browser width once more here so the
         * adjustment's upper bound definitely includes the newly allocated
         * column before calculating the destination.
         */
        GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                GLib.idle_add(
                    GLib.PRIORITY_DEFAULT_IDLE,
                    () => {
                        if (!this._horizontalScroll)
                            return GLib.SOURCE_REMOVE;

                        try {
                            this._updateBrowserWidth();

                            const adjustment =
                                this._horizontalScroll.get_hadjustment();
                            const lower = adjustment.get_lower();
                            const maximum = Math.max(
                                lower,
                                adjustment.get_upper() - adjustment.get_page_size()
                            );

                            if (maximum > lower + 1)
                                this._animateHorizontalAdjustmentTo(maximum);
                        } catch {
                            // Ignore layout races while a column is being built.
                        }

                        return GLib.SOURCE_REMOVE;
                    }
                );

                return GLib.SOURCE_REMOVE;
            }
        );
    }


    /*
     * =====================================================
     * CLAMP AFTER COLUMNS CLOSE
     * =====================================================
     */

    _clampHorizontalPosition() {
        GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,

            () => {
                if (
                    !this._horizontalScroll
                ) {
                    return GLib.SOURCE_REMOVE;
                }


                try {
                    const adjustment =
                        this._horizontalScroll
                            .get_hadjustment();


                    const lower =
                        adjustment.get_lower();


                    const maximum =
                        Math.max(
                            lower,

                            adjustment.get_upper() -
                            adjustment.get_page_size()
                        );


                    this._animateHorizontalAdjustmentTo(
                        Math.min(
                            Math.max(
                                adjustment.get_value(),
                                lower
                            ),

                            maximum
                        )
                    );
                } catch {
                    // Ignore.
                }


                return GLib.SOURCE_REMOVE;
            }
        );
    }


    /*
     * =====================================================
     * OPEN EXTERNALLY
     * =====================================================
     */

    _getDefaultFileManagerApp() {
        try {
            return Gio.AppInfo.get_default_for_type('inode/directory', true) ??
                Gio.AppInfo.get_default_for_type('inode/directory', false);
        } catch (error) {
            console.error(`Folders: cannot resolve default file manager: ${error}`);
            return null;
        }
    }


    _getDefaultFileManagerName() {
        const app = this._getDefaultFileManagerApp();

        try {
            return app?.get_display_name?.() ?? app?.get_name?.() ?? 'File Manager';
        } catch {
            return 'File Manager';
        }
    }


    _openTrash() {
        try {
            Gio.AppInfo.launch_default_for_uri('trash:///', null);
            this._showStatus?.('Opened Trash');
        } catch (error) {
            console.error(`Folders: failed to open Trash: ${error}`);
            Main.notifyError('Folders: Unable to open Trash', error?.message ?? String(error));
        }
    }


    _openRowInFileManager(row) {
        const file = row?._folderBrowserFile;
        if (!file)
            return;

        const target = row._folderBrowserIsDirectory
            ? file
            : (file.get_parent?.() ?? file);

        const app = this._getDefaultFileManagerApp();

        try {
            if (app) {
                app.launch(
                    [target],
                    global.create_app_launch_context(0, -1)
                );
                this.menu.close();
                return;
            }
        } catch (error) {
            console.error(`Folders: default file manager launch failed: ${error}`);
        }

        // Fallback to the URI default handler if inode/directory has no
        // registered application.
        this._launchFile(target);
    }


    _launchFileInDefaultApplication(file) {
        if (!file)
            return;

        try {
            const info = file.query_info(
                'standard::content-type,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                // Directories are never treated as normal files here.
                this._launchFile(file);
                return;
            }

            const contentType = info.get_content_type();
            const launchContext = global.create_app_launch_context(0, -1);
            let app = contentType
                ? Gio.AppInfo.get_default_for_type(contentType, false)
                : null;

            // Some setups register the file manager as the generic file://
            // handler. Never deliberately pick that application for an actual
            // non-directory file if another recommended MIME handler exists.
            const fileManager = this._getDefaultFileManagerApp();
            const sameApp = (a, b) => {
                if (!a || !b)
                    return false;

                try {
                    const aId = a.get_id?.();
                    const bId = b.get_id?.();
                    if (aId && bId)
                        return aId === bId;
                } catch {
                    // Fall back to display name comparison below.
                }

                try {
                    return (a.get_display_name?.() ?? a.get_name?.()) ===
                        (b.get_display_name?.() ?? b.get_name?.());
                } catch {
                    return false;
                }
            };

            if ((!app || sameApp(app, fileManager)) && contentType) {
                try {
                    const recommended = Gio.AppInfo.get_recommended_for_type(contentType) ?? [];
                    const alternative = recommended.find(candidate =>
                        candidate && !sameApp(candidate, fileManager)
                    );
                    if (alternative)
                        app = alternative;
                } catch (error) {
                    console.debug(`Folders: recommended-app lookup failed: ${error}`);
                }
            }

            if (!app) {
                this._showStatus(`No default application for ${contentType ?? 'this file type'}`);
                console.error(
                    `Folders: no MIME application for ${file.get_uri()} ` +
                    `(content type ${contentType ?? 'unknown'})`
                );
                return;
            }

            console.log(
                `Folders: opening ${file.get_uri()} as ${contentType ?? 'unknown'} ` +
                `with ${app.get_display_name?.() ?? app.get_name?.() ?? 'default application'}`
            );

            app.launch([file], launchContext);
            this.menu.close();
        } catch (error) {
            // Do not fall back to the generic file:// URI handler here. On
            // systems where a file manager owns file:// (as Strata does on the
            // user's setup), that would recreate the exact bug this path is
            // designed to avoid. Keep the menu open and report the failure.
            console.error(`Folders: cannot launch file in default application: ${error}`);
            this._showStatus('Could not open file with its default application');
        }
    }


    _launchFile(
        file
    ) {
        try {
            Gio.AppInfo
                .launch_default_for_uri(
                    file.get_uri(),

                    global
                        .create_app_launch_context(
                            0,
                            -1
                        )
                );


            this.menu.close();
        } catch (error) {
            console.error(
                `Folders: cannot open ${file.get_uri()}: ${error}`
            );
        }
    }


    /*
     * =====================================================
     * DISPLAY NAME
     * =====================================================
     */

    _getDisplayName(
        file
    ) {
        let name =
            file.get_basename();


        if (
            name === null ||
            name === ''
        ) {
            return file.get_uri();
        }


        try {
            name =
                decodeURIComponent(
                    name
                );
        } catch {
            // Keep original.
        }


        return name;
    }


    /*
     * =====================================================
     * MESSAGE
     * =====================================================
     */

    _addMessage(
        list,
        text
    ) {
        list.add_child(
            new St.Label({
                text,

                style: `
                    padding: 12px;
                    opacity: 0.65;
                `,
            })
        );
    }


    /*
     * =====================================================
     * GTK BOOKMARK LOADER
     * =====================================================
     *
     * This is intentionally unchanged because it
     * correctly finds:
     *
     * PocoX7Pro
     * share
     */

    _getBookmarks() {
        const bookmarkPath =
            GLib.build_filenamev([
                GLib.get_home_dir(),
                '.config',
                'gtk-3.0',
                'bookmarks',
            ]);


        const bookmarkFile =
            Gio.File.new_for_path(
                bookmarkPath
            );


        let contents;


        try {
            const [
                success,
                loadedContents,
            ] =
                bookmarkFile.load_contents(
                    null
                );


            if (
                !success
            ) {
                return [];
            }


            contents =
                loadedContents;
        } catch (error) {
            console.error(
                `Folders: cannot read GTK bookmarks: ${error}`
            );


            return [];
        }


        const text =
            new TextDecoder()
                .decode(
                    contents
                );


        const home =
            GLib.get_home_dir();


        /*
         * Standard folders to hide.
         */
        const excludedPaths = [
            home,
            `${home}/Desktop`,
            `${home}/Documents`,
            `${home}/Downloads`,
            `${home}/Music`,
            `${home}/Pictures`,
            `${home}/Public`,
            `${home}/Templates`,
            `${home}/Videos`,
        ];


        const excludedUris =
            new Set(
                excludedPaths.map(
                    path =>
                        Gio.File
                            .new_for_path(
                                path
                            )
                            .get_uri()
                )
            );


        const bookmarks = [];


        for (
            const rawLine
            of text.split('\n')
        ) {
            const line =
                rawLine.trim();


            if (
                !line
            ) {
                continue;
            }


            const firstSpace =
                line.indexOf(' ');


            let uri;
            let customName = '';


            if (
                firstSpace === -1
            ) {
                uri =
                    line;
            } else {
                uri =
                    line.substring(
                        0,
                        firstSpace
                    );


                customName =
                    line.substring(
                        firstSpace + 1
                    ).trim();
            }


            if (
                excludedUris.has(
                    uri
                )
            ) {
                continue;
            }


            let file;


            try {
                file =
                    Gio.File.new_for_uri(
                        uri
                    );
            } catch (error) {
                console.error(
                    `Folders: invalid bookmark URI ${uri}: ${error}`
                );


                continue;
            }


            let name =
                customName;


            if (
                !name
            ) {
                name =
                    this._getDisplayName(
                        file
                    );
            }


            bookmarks.push({
                file,
                name,
            });
        }


        return bookmarks;
    }
});


/*
 * =========================================================
 * EXTENSION
 * =========================================================
 */

export default class BookmarksColumnBrowserExtension
extends Extension {
    enable() {
        _ensureCompiledSchema(this.path);
        this._settings = this.getSettings();
        this._shortcutAction = Meta.KeyBindingAction.NONE;
        this._shortcutName = null;
        this._shortcutAccelerator = null;
        this._acceleratorSignalId = 0;
        this._shortcutSettingId = 0;
        this._trashShortcutAction = Meta.KeyBindingAction.NONE;
        this._trashShortcutName = null;
        this._trashShortcutAccelerator = null;
        this._trashShortcutSettingId = 0;

        this._indicator = new BookmarksIndicator(this._settings, this.path);

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            1,
            'left'
        );

        /* Preview startup is fail-safe and happens after the panel button exists. */
        try {
            this._indicator.startPreviewCache();
        } catch (error) {
            console.error(`Folders: preview startup failed: ${error}`);
        }

        this._acceleratorSignalId = global.display.connect(
            'accelerator-activated',
            (_display, activatedAction) => {
                if (activatedAction === this._shortcutAction) {
                    console.log(
                        `Folders shortcut: ${this._shortcutAccelerator ?? 'configured shortcut'} activated`
                    );
                    this._toggleFoldersMenu();
                    return;
                }

                if (activatedAction === this._trashShortcutAction) {
                    console.log(
                        `Folders Trash shortcut: ${this._trashShortcutAccelerator ?? 'configured shortcut'} activated`
                    );
                    this._openTrash();
                }
            }
        );

        this._registerMenuShortcut(
            this._settings.get_string('menu-shortcut') || '<Super>f'
        );

        this._shortcutSettingId = this._settings.connect(
            'changed::menu-shortcut',
            () => {
                const accelerator =
                    this._settings.get_string('menu-shortcut') || '<Super>f';
                this._registerMenuShortcut(accelerator);
            }
        );

        this._registerTrashShortcut(
            this._settings.get_string('trash-shortcut') || '<Super><Shift>t'
        );

        this._trashShortcutSettingId = this._settings.connect(
            'changed::trash-shortcut',
            () => {
                const accelerator =
                    this._settings.get_string('trash-shortcut').trim();
                this._registerTrashShortcut(accelerator);
            }
        );
    }


    _releaseMenuShortcut(action = this._shortcutAction, name = this._shortcutName) {
        if (action !== Meta.KeyBindingAction.NONE) {
            try {
                global.display.ungrab_accelerator(action);
            } catch {
                // Ignore.
            }
        }

        if (name) {
            try {
                Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
            } catch {
                // Ignore.
            }
        }
    }


    _registerMenuShortcut(accelerator) {
        accelerator = String(accelerator ?? '').trim();
        if (!accelerator)
            accelerator = '<Super>f';

        if (
            accelerator === this._shortcutAccelerator &&
            this._shortcutAction !== Meta.KeyBindingAction.NONE
        ) {
            return;
        }

        try {
            const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
            const newAction = global.display.grab_accelerator(
                accelerator,
                flags
            );

            if (newAction === Meta.KeyBindingAction.NONE) {
                console.error(
                    `Folders shortcut: FAILED to grab ${accelerator} ` +
                    '(invalid or already in use?)'
                );
                Main.notifyError(
                    'Folders shortcut unavailable',
                    `${accelerator} could not be grabbed. The previous shortcut remains active.`
                );
                return;
            }

            const newName = Meta.external_binding_name_for_action(newAction);

            Main.wm.allowKeybinding(
                newName,
                Shell.ActionMode.NORMAL |
                Shell.ActionMode.OVERVIEW |
                Shell.ActionMode.POPUP
            );

            const oldAction = this._shortcutAction;
            const oldName = this._shortcutName;

            this._shortcutAction = newAction;
            this._shortcutName = newName;
            this._shortcutAccelerator = accelerator;

            this._releaseMenuShortcut(oldAction, oldName);

            console.log(
                `Folders shortcut: grabbed ${accelerator} ` +
                `action=${newAction} name=${newName}`
            );
        } catch (error) {
            console.error(
                `Folders shortcut: registration failed for ${accelerator}: ${error}`
            );
            Main.notifyError(
                'Folders shortcut unavailable',
                `${accelerator} is invalid or could not be registered.`
            );
        }
    }


    _releaseTrashShortcut(
        action = this._trashShortcutAction,
        name = this._trashShortcutName
    ) {
        if (action !== Meta.KeyBindingAction.NONE) {
            try {
                global.display.ungrab_accelerator(action);
            } catch {
                // Ignore.
            }
        }

        if (name) {
            try {
                Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
            } catch {
                // Ignore.
            }
        }
    }


    _registerTrashShortcut(accelerator) {
        accelerator = String(accelerator ?? '').trim();

        // An empty value intentionally disables the global Trash shortcut.
        if (!accelerator) {
            this._releaseTrashShortcut();
            this._trashShortcutAction = Meta.KeyBindingAction.NONE;
            this._trashShortcutName = null;
            this._trashShortcutAccelerator = null;
            return;
        }

        if (
            accelerator === this._trashShortcutAccelerator &&
            this._trashShortcutAction !== Meta.KeyBindingAction.NONE
        ) {
            return;
        }

        try {
            const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
            const newAction = global.display.grab_accelerator(accelerator, flags);

            if (newAction === Meta.KeyBindingAction.NONE) {
                console.error(`Folders Trash shortcut: FAILED to grab ${accelerator}`);
                Main.notifyError(
                    'Folders Trash shortcut unavailable',
                    `${accelerator} could not be grabbed. The previous shortcut remains active.`
                );
                return;
            }

            const newName = Meta.external_binding_name_for_action(newAction);
            Main.wm.allowKeybinding(
                newName,
                Shell.ActionMode.NORMAL |
                Shell.ActionMode.OVERVIEW |
                Shell.ActionMode.POPUP
            );

            const oldAction = this._trashShortcutAction;
            const oldName = this._trashShortcutName;

            this._trashShortcutAction = newAction;
            this._trashShortcutName = newName;
            this._trashShortcutAccelerator = accelerator;
            this._releaseTrashShortcut(oldAction, oldName);

            console.log(
                `Folders Trash shortcut: grabbed ${accelerator} ` +
                `action=${newAction} name=${newName}`
            );
        } catch (error) {
            console.error(`Folders Trash shortcut: registration failed: ${error}`);
            Main.notifyError(
                'Folders Trash shortcut unavailable',
                `${accelerator} is invalid or could not be registered.`
            );
        }
    }


    _openTrash() {
        try {
            Gio.AppInfo.launch_default_for_uri('trash:///', null);
        } catch (error) {
            console.error(`Folders: failed to open Trash: ${error}`);
            Main.notifyError('Folders: Unable to open Trash', error?.message ?? String(error));
        }
    }


    _toggleFoldersMenu() {
        if (!this._indicator)
            return;

        this._indicator.menu.toggle();
    }


    disable() {
        if (this._shortcutSettingId && this._settings) {
            try {
                this._settings.disconnect(this._shortcutSettingId);
            } catch {
                // Ignore.
            }
            this._shortcutSettingId = 0;
        }

        if (this._trashShortcutSettingId && this._settings) {
            try {
                this._settings.disconnect(this._trashShortcutSettingId);
            } catch {
                // Ignore.
            }
            this._trashShortcutSettingId = 0;
        }

        if (this._acceleratorSignalId) {
            try {
                global.display.disconnect(this._acceleratorSignalId);
            } catch {
                // Ignore.
            }
            this._acceleratorSignalId = 0;
        }

        this._releaseMenuShortcut();
        this._shortcutAction = Meta.KeyBindingAction.NONE;
        this._shortcutName = null;
        this._shortcutAccelerator = null;

        this._releaseTrashShortcut();
        this._trashShortcutAction = Meta.KeyBindingAction.NONE;
        this._trashShortcutName = null;
        this._trashShortcutAccelerator = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
