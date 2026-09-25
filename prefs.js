import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
}

export default class FoldersPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        _ensureCompiledSchema(this.path);
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 720);
        window.search_enabled = true;

        // Separate native preference pages give GNOME/libadwaita a page
        // switcher (rendered as tabs/switcher depending available width)
        // without introducing a custom fragile navigation widget.
        const previewPage = new Adw.PreferencesPage({
            title: 'Preview',
            icon_name: 'image-x-generic-symbolic',
        });
        const browserPage = new Adw.PreferencesPage({
            title: 'Browser',
            icon_name: 'folder-symbolic',
        });
        const shortcutPage = new Adw.PreferencesPage({
            title: 'Shortcuts',
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        window.add(previewPage);
        window.add(browserPage);
        window.add(shortcutPage);

        const previewGroup = new Adw.PreferencesGroup({
            title: 'Preview',
            description: 'Control the inspector used by both mouse hover and keyboard focus.',
        });
        previewPage.add(previewGroup);

        this._addSwitch(settings, previewGroup, 'preview-enabled',
            'Enable previews',
            'Master switch for the inspector preview column.');
        this._addSwitch(settings, previewGroup, 'file-preview-enabled',
            'File previews',
            'Preview images, text, PDFs and supported documents.');
        this._addSwitch(settings, previewGroup, 'folder-preview-enabled',
            'Folder previews',
            'Show a lightweight list of folder contents while hovering a closed folder.');
        this._addSwitch(settings, previewGroup, 'keyboard-preview-enabled',
            'Keyboard-focus previews',
            'On by default. Arrow-key focus previews files and closed folders just like mouse hover.');
        this._addSwitch(settings, previewGroup, 'preview-rightmost-only',
            'Preview only the rightmost column',
            'When on, older left-hand columns never open an inspector. When off, previews may be inserted between already-open columns.');
        this._addSwitch(settings, previewGroup, 'preload-previews',
            'Preload previews',
            'Cache previewable files from folders that are currently open.');
        this._addSwitch(settings, previewGroup, 'preview-animations-enabled',
            'Smooth preview transitions',
            'Fade previews in and out instead of changing instantly.');
        this._addSwitch(settings, previewGroup, 'animate-intermediate-previews',
            'Animate in-between previews',
            'Also animate previews inserted between already-open Miller columns. Turn this off if you prefer only rightmost previews to animate.');

        const openDurationRow = this._makeSpinRow(
            'Preview opening transition',
            'Fade-in duration in milliseconds. Default: 130 ms.',
            0, 600, 10, 0,
            settings.get_int('preview-open-duration-ms')
        );
        previewGroup.add(openDurationRow);
        this._bindIntSpin(settings, 'preview-open-duration-ms', openDurationRow);

        const closeDurationRow = this._makeSpinRow(
            'Preview closing transition',
            'Fade-out duration in milliseconds. Default: 220 ms.',
            0, 800, 10, 0,
            settings.get_int('preview-close-duration-ms')
        );
        previewGroup.add(closeDurationRow);
        this._bindIntSpin(settings, 'preview-close-duration-ms', closeDurationRow);

        const switchDurationRow = this._makeSpinRow(
            'Between-preview transition',
            'Fade-in duration when one preview immediately replaces another. Default: 70 ms.',
            0, 400, 10, 0,
            settings.get_int('preview-switch-duration-ms')
        );
        previewGroup.add(switchDurationRow);
        this._bindIntSpin(settings, 'preview-switch-duration-ms', switchDurationRow);

        const closeDelayRow = this._makeSpinRow(
            'Mouse transition debounce',
            'Applied only after a real pointer exit to smooth row-to-row transitions. It is not a preview lifetime timer. Default: 200 ms.',
            0, 1000, 25, 0,
            settings.get_int('mouse-preview-close-delay-ms')
        );
        previewGroup.add(closeDelayRow);
        this._bindIntSpin(settings, 'mouse-preview-close-delay-ms', closeDelayRow);

        const folderItemsRow = this._makeSpinRow(
            'Folder preview items',
            'Maximum number of child items shown in a folder preview.',
            4, 50, 1, 0,
            settings.get_int('folder-preview-max-items')
        );
        previewGroup.add(folderItemsRow);
        this._bindIntSpin(settings, 'folder-preview-max-items', folderItemsRow);

        const imageSizeRow = this._makeSpinRow(
            'Image preview size',
            'Maximum decoded width/height in pixels. Smaller values use less RAM.',
            96, 512, 16, 0,
            settings.get_int('preview-image-size')
        );
        previewGroup.add(imageSizeRow);
        this._bindIntSpin(settings, 'preview-image-size', imageSizeRow);

        const cacheGroup = new Adw.PreferencesGroup({
            title: 'Preview cache',
            description: 'The cache uses LRU eviction. The newest preview is kept and only enough old entries are removed to return under the limit.',
        });
        previewPage.add(cacheGroup);

        const cacheLimitRow = this._makeSpinRow(
            'Cache limit',
            'Estimated preview-memory limit in MB. Default: 3 MB.',
            0.5, 256, 0.5, 1,
            settings.get_double('cache-limit-mb')
        );
        cacheGroup.add(cacheLimitRow);
        this._bindDoubleSpin(settings, 'cache-limit-mb', cacheLimitRow);

        const retentionRow = this._makeSpinRow(
            'Retention after close',
            'Seconds to keep an unpinned preview after its folder/menu closes. 0 clears immediately.',
            0, 3600, 5, 0,
            settings.get_int('cache-retention-seconds')
        );
        cacheGroup.add(retentionRow);
        this._bindIntSpin(settings, 'cache-retention-seconds', retentionRow);

        const monitorRow = new Adw.ActionRow({
            title: 'Terminal cache monitor',
            subtitle: 'watch -n 1 cat ~/.cache/bookmarks-only-preview-cache-status.txt',
            subtitle_selectable: true,
        });
        monitorRow.add_css_class('property');
        cacheGroup.add(monitorRow);

        const contentGroup = new Adw.PreferencesGroup({
            title: 'Folders and locations',
            description: 'Choose which virtual roots and filesystem entries are visible.',
        });
        browserPage.add(contentGroup);

        this._addSwitch(settings, contentGroup, 'show-places',
            'Show Places',
            'Virtual folder containing Home, Desktop, Documents, Downloads and other XDG locations.');
        this._addSwitch(settings, contentGroup, 'show-drives',
            'Show Drives',
            'Virtual folder containing currently mounted volumes and filesystems.');
        this._addSwitch(settings, contentGroup, 'show-hidden-files',
            'Show hidden files',
            'Show dotfiles and entries marked hidden. Changing this rebuilds the browser.');

        const navigationGroup = new Adw.PreferencesGroup({
            title: 'Navigation',
            description: 'Viewport and Miller-column movement.',
        });
        browserPage.add(navigationGroup);

        this._addSwitch(settings, navigationGroup, 'paste-into-focused-folder',
            'Paste into focused child folder',
            'Off by default: Ctrl+V and Paste Here use the current column’s folder. Turn on to paste into its focused child folder instead.');

        const horizontalPanRow = this._makeSpinRow(
            'Horizontal reveal transition',
            'Milliseconds used when reopening the menu or revealing a rightmost preview. 0 disables the animation. Default: 260 ms.',
            0, 1000, 20, 0,
            settings.get_int('horizontal-pan-duration-ms')
        );
        navigationGroup.add(horizontalPanRow);
        this._bindIntSpin(settings, 'horizontal-pan-duration-ms', horizontalPanRow);

        const selectionInfoRow = new Adw.ActionRow({
            title: 'Selection behavior',
            subtitle: 'Esc or a plain arrow move clears multi-selection. Clicking empty browser space also deselects everything.',
        });
        selectionInfoRow.add_css_class('property');
        navigationGroup.add(selectionInfoRow);

        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard',
            description: 'The menu shortcut updates live. Shift+F10 and the Menu key open the row context menu.',
        });
        shortcutPage.add(shortcutGroup);

        const shortcutRow = new Adw.EntryRow({
            title: 'Open Folders shortcut',
            text: settings.get_string('menu-shortcut'),
        });
        shortcutRow.set_show_apply_button(true);
        shortcutGroup.add(shortcutRow);

        shortcutRow.connect('apply', () => {
            const text = shortcutRow.get_text().trim();
            settings.set_string('menu-shortcut', text || '<Super>f');
        });

        settings.connect('changed::menu-shortcut', () => {
            const value = settings.get_string('menu-shortcut');
            if (shortcutRow.get_text() !== value)
                shortcutRow.set_text(value);
        });

        const trashShortcutRow = new Adw.EntryRow({
            title: 'Open Trash shortcut',
            text: settings.get_string('trash-shortcut'),
        });
        trashShortcutRow.set_show_apply_button(true);
        shortcutGroup.add(trashShortcutRow);

        trashShortcutRow.connect('apply', () => {
            // Empty intentionally disables the global shortcut.
            settings.set_string('trash-shortcut', trashShortcutRow.get_text().trim());
        });

        settings.connect('changed::trash-shortcut', () => {
            const value = settings.get_string('trash-shortcut');
            if (trashShortcutRow.get_text() !== value)
                trashShortcutRow.set_text(value);
        });

        const contextRow = new Adw.ActionRow({
            title: 'Context menu & selection shortcuts',
            subtitle: 'Ctrl+Shift+D: drag to another app • Esc: deselect • Shift+F10/Menu: context menu • Shift+↑/↓: range select • Ctrl+Space: toggle • Ctrl+A: select all • Ctrl+Shift+T: Trash while Folders is open',
        });
        contextRow.add_css_class('property');
        shortcutGroup.add(contextRow);

        const resetRow = new Adw.ActionRow({
            title: 'Reset all settings',
            subtitle: 'Restore extension defaults.',
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('destructive-action');
        resetButton.connect('clicked', () => {
            const keys = [
                'preview-enabled',
                'file-preview-enabled',
                'folder-preview-enabled',
                'keyboard-preview-enabled',
                'preview-rightmost-only',
                'mouse-preview-close-delay-ms',
                'preview-animations-enabled',
                'animate-intermediate-previews',
                'preview-open-duration-ms',
                'preview-close-duration-ms',
                'preview-switch-duration-ms',
                'horizontal-pan-duration-ms',
                'paste-into-focused-folder',
                'preload-previews',
                'cache-retention-seconds',
                'cache-limit-mb',
                'preview-image-size',
                'folder-preview-max-items',
                'show-places',
                'show-drives',
                'show-hidden-files',
                'menu-shortcut',
                'trash-shortcut',
            ];
            for (const key of keys)
                settings.reset(key);
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        shortcutGroup.add(resetRow);
    }

    _addSwitch(settings, group, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    _makeSpinRow(title, subtitle, lower, upper, step, digits, value) {
        const adjustment = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 10,
            value,
        });

        return new Adw.SpinRow({
            title,
            subtitle,
            adjustment,
            digits,
            numeric: true,
        });
    }

    _bindIntSpin(settings, key, row) {
        let updating = false;

        row.connect('notify::value', () => {
            if (updating)
                return;
            settings.set_int(key, Math.round(row.get_value()));
        });

        settings.connect(`changed::${key}`, () => {
            updating = true;
            row.set_value(settings.get_int(key));
            updating = false;
        });
    }

    _bindDoubleSpin(settings, key, row) {
        let updating = false;

        row.connect('notify::value', () => {
            if (updating)
                return;
            settings.set_double(key, row.get_value());
        });

        settings.connect(`changed::${key}`, () => {
            updating = true;
            row.set_value(settings.get_double(key));
            updating = false;
        });
    }
}
