#!/usr/bin/env -S gjs -m
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import System from 'system';
import {parseDragRequest, serializeUriList} from './drag-payload.js';

function createProvider(files) {
    // FileList lets GTK supply its native/portal formats. URI-list covers browsers
    // and older receivers. Do not offer plain text (which can turn a drop into text).
    const value = new GObject.Value();
    value.init(Gdk.FileList.$gtype);
    value.set_boxed(Gdk.FileList.new_from_array(files));
    const native = Gdk.ContentProvider.new_for_value(value);
    const uriList = Gdk.ContentProvider.new_for_bytes('text/uri-list',
        new GLib.Bytes(new TextEncoder().encode(serializeUriList(files.map(file => file.get_uri())))));
    return Gdk.ContentProvider.new_union([native, uriList]);
}

function queryInfo(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async('standard::type,standard::display-name,access::can-read',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                try { resolve(source.query_info_finish(result)); }
                catch (error) { reject(error); }
            });
    });
}

function makeLabel(text, options = {}) {
    return new Gtk.Label({label: text, wrap: true, xalign: 0, ...options});
}

function openWindow(app, uris, keepOpenInitially = false) {
    const window = new Gtk.ApplicationWindow({
        application: app, title: 'FocusTrail Drag', default_width: 400,
        default_height: 300, resizable: true,
    });
    window.set_titlebar(new Gtk.HeaderBar());
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
        margin_top: 16, margin_bottom: 16, margin_start: 18, margin_end: 18});
    window.set_child(box);
    box.append(makeLabel('Drag files into your app', {css_classes: ['title-2']}));
    box.append(makeLabel('Drag the card below onto the destination’s file drop area. Move this window by its title bar if it covers the target.'));

    const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        height_request: 112, hexpand: true, css_classes: ['card']});
    card.set_cursor_from_name('grab');
    const icon = new Gtk.Image({icon_name: uris.length === 1 ? 'text-x-generic-symbolic' : 'folder-documents-symbolic',
        pixel_size: 36, margin_top: 12});
    card.append(icon);
    const cardTitle = makeLabel('Checking files…', {xalign: 0.5,
        margin_start: 12, margin_end: 12, margin_bottom: 12});
    card.append(cardTitle);
    box.append(new Gtk.Frame({child: card}));

    const names = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
    const scroll = new Gtk.ScrolledWindow({child: names, min_content_height: 36,
        max_content_height: 140, propagate_natural_height: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER});
    box.append(scroll);
    const status = makeLabel('Preparing the selection…', {selectable: true});
    box.append(status);
    const keepOpen = new Gtk.CheckButton({label: 'Keep open after a successful drop',
        active: keepOpenInitially});
    box.append(keepOpen);
    const testButton = new Gtk.Button({label: 'Open local drop test'});
    box.append(testButton);

    let provider = null;
    let active = false;
    let cancelled = false;
    let closed = false;
    let transferFinished = false;
    let closeIdle = 0;
    function cancelAutoClose() {
        if (closeIdle) {
            GLib.source_remove(closeIdle);
            closeIdle = 0;
        }
    }
    function maybeClose() {
        if (closed || active || cancelled || !transferFinished || keepOpen.get_active() || closeIdle)
            return;
        // Leave the signal stack first; never close on mouse release alone.
        closeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            closeIdle = 0;
            if (!closed && !active && !cancelled && transferFinished && !keepOpen.get_active())
                window.close();
            return GLib.SOURCE_REMOVE;
        });
    }
    const cancellable = new Gio.Cancellable();
    const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.COPY});
    dragSource.connect('prepare', () => provider);
    dragSource.connect('drag-begin', (source, drag) => {
        cancelAutoClose();
        active = true;
        cancelled = false;
        transferFinished = false;
        drag.connect('dnd-finished', () => {
            transferFinished = true;
            maybeClose();
        });
        const paintable = Gtk.WidgetPaintable.new(card);
        source.set_icon(paintable, 24, 24);
        status.set_label('Dragging — release over an app’s file drop area.');
    });
    dragSource.connect('drag-cancel', (_source, _drag, reason) => {
        cancelled = true;
        status.set_label(reason === Gdk.DragCancelReason.USER_CANCELLED
            ? 'Drag cancelled. You can try again.'
            : 'The destination did not accept this drop. Try its upload area or the local drop test.');
        return false;
    });
    dragSource.connect('drag-end', () => {
        active = false;
        if (!cancelled)
            status.set_label('Drag finished. Check the destination’s attachment preview. You can drag again.');
        maybeClose();
    });
    card.add_controller(dragSource);

    window.connect('close-request', () => {
        if (active) {
            status.set_label('Finish or cancel the drag before closing this window.');
            return true;
        }
        closed = true;
        cancelAutoClose();
        cancellable.cancel();
        return false;
    });
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_controller, key) => {
        if (key === Gdk.KEY_Escape && !active) {
            window.close();
            return true;
        }
        return false;
    });
    window.add_controller(keys);
    testButton.connect('clicked', () => {
        const test = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('drop-test.html');
        Gio.AppInfo.launch_default_for_uri_async(test.get_uri(), null, null, (_source, result) => {
            try { Gio.AppInfo.launch_default_for_uri_finish(result); }
            catch (error) { status.set_label(`Open drop-test.html in your browser: ${error.message}`); }
        });
    });
    window.present();

    void (async () => {
        try {
            const files = uris.map(uri => Gio.File.new_for_uri(uri));
            let directories = false;
            for (const file of files) {
                const info = await queryInfo(file, cancellable);
                if (closed)
                    return;
                const type = info.get_file_type();
                if (type !== Gio.FileType.REGULAR && type !== Gio.FileType.DIRECTORY)
                    throw new Error(`${file.get_basename()}: only regular files and folders can be dragged.`);
                if (info.has_attribute('access::can-read') && !info.get_attribute_boolean('access::can-read'))
                    throw new Error(`${file.get_basename()}: file is not readable.`);
                directories ||= type === Gio.FileType.DIRECTORY;
                const label = makeLabel(info.get_display_name(), {wrap: false,
                    ellipsize: Pango.EllipsizeMode.MIDDLE});
                label.set_tooltip_text(file.get_path());
                names.append(label);
            }
            provider = createProvider(files);
            cardTitle.set_label(files.length === 1
                ? `Drag ${files[0].get_basename()}` : `Drag all ${files.length} items`);
            status.set_label(directories
                ? 'Ready. Folders require a destination that accepts folders; WhatsApp needs individual files.'
                : 'Ready. Files are copied/shared; the originals stay in place.');
        } catch (error) {
            if (!closed) {
                cardTitle.set_label('Selection unavailable');
                status.set_label(error.message);
            }
        }
    })();
    return {
        window, uris,
        get closed() { return closed; },
        get dragging() { return active; },
        get keepOpen() { return keepOpen.get_active(); },
        present() {
            cancelAutoClose();
            window.present();
        },
    };
}

function showFiles(app, current, files) {
    const uris = parseDragRequest(JSON.stringify({version: 1,
        uris: files.map(file => file.get_uri())}));
    if (current && !current.closed) {
        if (current.dragging || JSON.stringify(current.uris) === JSON.stringify(uris)) {
            current.present();
            return current;
        }
        // Add the replacement window before closing the old one so GtkApplication
        // never drops to zero windows midway through handling a reopen request.
        const replacement = openWindow(app, uris, current.keepOpen);
        current.window.close();
        return replacement;
    }
    return openWindow(app, uris);
}

try {
    if (ARGV.includes('--check')) {
        // No display required. Exercise actual GI boxing and all provider APIs.
        const provider = createProvider([Gio.File.new_for_path('/tmp/focustrail-check.txt')]);
        if (!provider.ref_formats().contain_mime_type('text/uri-list'))
            throw new Error('GTK did not expose text/uri-list.');
        print(`FocusTrail drag dependencies OK: GTK ${Gtk.get_major_version()}.${Gtk.get_minor_version()}`);
    } else {
        const [ok, bytes] = GLib.file_get_contents('/dev/stdin');
        if (!ok)
            throw new Error('Could not read the drag request.');
        const uris = parseDragRequest(new TextDecoder().decode(bytes));
        const app = new Gtk.Application({application_id: 'io.github.focustrail.Drag',
            flags: Gio.ApplicationFlags.HANDLES_OPEN});
        let current = null;
        // GApplication forwards repeated launches to the primary process over
        // the session bus. File payloads are supplied by the open signal.
        app.connect('open', (_app, files) => {
            current = showFiles(app, current, files);
        });
        app.connect('activate', () => current?.present());
        await app.runAsync(['focustrail-drag', ...uris]);
    }
} catch (error) {
    printerr(`FocusTrail Drag: ${error.message}`);
    System.exit(1);
}
