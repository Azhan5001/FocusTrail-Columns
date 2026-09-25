import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseDragRequest} from '../drag-payload.js';

// Exercise the actual helper's event handlers with a fake widget layer. This
// tests ordering/ownership, not GTK rendering or the desktop DND protocol.
function harness() {
    const widgets = [], idles = new Map();
    let nextId = 1;
    class Widget {
        constructor(props = {}) {Object.assign(this, props); this.signals = {}; widgets.push(this);}
        connect(name, callback) {this.signals[name] = callback;}
        emit(name, ...args) {return this.signals[name]?.(this, ...args);}
        append() {} set_child() {} set_titlebar() {} set_cursor_from_name() {}
        set_icon() {} add_controller() {} set_tooltip_text() {}
        set_label(value) {this.label = value;}
        get_active() {return this.active;}
        present() {this.presented = (this.presented || 0) + 1;}
        close() {if (!this.emit('close-request')) this.destroyed = true;}
    }
    const Gtk = {Orientation: {VERTICAL: 1}, PolicyType: {NEVER: 1},
        WidgetPaintable: {new: () => ({})}};
    for (const type of ['ApplicationWindow', 'HeaderBar', 'Box', 'Label', 'Image', 'Frame',
        'ScrolledWindow', 'CheckButton', 'Button', 'DragSource', 'EventControllerKey'])
        Gtk[type] = class extends Widget {};
    const context = {Gtk, Gdk: {DragAction: {COPY: 1}, DragCancelReason: {USER_CANCELLED: 1}},
        Gio: {Cancellable: class {cancel() {}}, File: {new_for_uri: uri => ({get_uri: () => uri})}},
        GLib: {PRIORITY_DEFAULT_IDLE: 1, SOURCE_REMOVE: false,
            idle_add(_priority, callback) {const id = nextId++; idles.set(id, callback); return id;},
            source_remove(id) {idles.delete(id);}},
        Pango: {}, queryInfo: () => new Promise(() => {}), parseDragRequest,
    };
    const source = fs.readFileSync(new URL('../drag-helper.js', import.meta.url), 'utf8');
    const functions = source.slice(source.indexOf('function makeLabel'), source.indexOf('\ntry {\n    if (ARGV'))
        .replaceAll('import.meta.url', "'file:///tmp/drag-helper.js'");
    vm.runInNewContext(functions + '\nglobalThis.api = {openWindow, showFiles};', context);
    const app = {};
    const current = context.api.openWindow(app, ['file:///tmp/a']);
    const sourceWidget = widgets.find(w => w instanceof Gtk.DragSource);
    return {context, current, app, Gtk, widgets, sourceWidget,
        begin() {const drag = new Widget(); sourceWidget.emit('drag-begin', drag); return drag;},
        flush() {for (const [id, cb] of [...idles]) {idles.delete(id); cb();}},
    };
}

test('Auto-close waits for both transfer completion and drag-end, regardless of signal order', () => {
    for (const finishedFirst of [false, true]) {
        const h = harness(), drag = h.begin();
        if (finishedFirst) drag.emit('dnd-finished');
        else h.sourceWidget.emit('drag-end');
        h.flush();
        assert.equal(h.current.closed, false);
        if (finishedFirst) h.sourceWidget.emit('drag-end');
        else drag.emit('dnd-finished');
        h.flush();
        assert.equal(h.current.closed, true);
    }
});
test('Cancelled or rejected drops leave the window open', () => {
    for (const reason of [0, 1, 2]) {
        const h = harness(), drag = h.begin();
        h.sourceWidget.emit('drag-cancel', drag, reason);
        h.sourceWidget.emit('drag-end');
        drag.emit('dnd-finished');
        h.flush();
        assert.equal(h.current.closed, false);
    }
});
test('Keep-open checkbox prevents auto-close after success', () => {
    const h = harness(), drag = h.begin();
    h.widgets.find(w => w instanceof h.Gtk.CheckButton).active = true;
    drag.emit('dnd-finished');
    h.sourceWidget.emit('drag-end');
    h.flush();
    assert.equal(h.current.closed, false);
});
test('Repeated request presents the existing selection and cancels pending auto-close', () => {
    const h = harness(), drag = h.begin();
    drag.emit('dnd-finished'); h.sourceWidget.emit('drag-end');
    const again = h.context.api.showFiles(h.app, h.current, [{get_uri: () => 'file:///tmp/a'}]);
    h.flush();
    assert.equal(again, h.current);
    assert.equal(h.current.closed, false);
    assert.equal(h.current.window.presented, 2);
});
test('New selection replaces an idle window, but never interrupts an active drag', () => {
    const h = harness(), drag = h.begin();
    const files = [{get_uri: () => 'file:///tmp/b'}];
    const during = h.context.api.showFiles(h.app, h.current, files);
    assert.equal(during, h.current);
    assert.equal(h.current.closed, false);
    h.sourceWidget.emit('drag-cancel', drag, 1);
    h.sourceWidget.emit('drag-end');
    const after = h.context.api.showFiles(h.app, h.current, files);
    assert.notEqual(after, h.current);
    assert.equal(h.current.closed, true);
    assert.equal(after.uris[0], 'file:///tmp/b');
});
