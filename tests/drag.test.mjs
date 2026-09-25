import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {parseDragRequest, serializeUriList, MAX_DRAG_FILES} from '../drag-payload.js';

const request = uris => JSON.stringify({version: 1, uris});
test('Multiple file URIs preserve spaces, Unicode, quotes and special characters', () => {
    const uris = ['/tmp/a b.png', '/tmp/اردو #1%.txt', '/tmp/$(touch nope)\n.txt']
        .map(path => pathToFileURL(path).href);
    assert.deepEqual(parseDragRequest(request(uris)), uris);
    assert.equal(serializeUriList(uris), uris.join('\r\n') + '\r\n');
    assert.deepEqual(parseDragRequest(request([uris[0], uris[0]])), [uris[0]]);
});
test('Reject invalid, remote, empty, oversized, and line-injected requests', () => {
    for (const data of ['oops', '{}', request([]), request([null]), request(['sftp://phone/photo.png']),
        request(['file://remote/share/a']), request(['file:///tmp/a\nfile:///etc/passwd']),
        request(['file:///tmp/a b']), request(Array(MAX_DRAG_FILES + 1).fill('file:///tmp/a')),
        ' '.repeat(1024 * 1024 + 1)])
        assert.throws(() => parseDragRequest(data));
});

function bridgeHarness() {
    const children = [];
    const reports = [];
    const context = {
        parseDragRequest,
        Gio: {
            File: {new_for_path: path => ({get_uri: () => pathToFileURL(path).href})},
            SubprocessFlags: {STDIN_PIPE: 1, STDOUT_PIPE: 2, STDERR_PIPE: 4},
            Subprocess: {new: (argv, flags) => {
                const child = {argv, flags, success: true, stderr: '', killed: false,
                    communicate_utf8_async(input, _cancel, callback) {this.input = input; this.callback = callback;},
                    communicate_utf8_finish() {return [true, '', this.stderr];},
                    get_successful() {return this.success;}, force_exit() {this.killed = true;},
                    finish() {this.callback(this, {});}};
                children.push(child);
                return child;
            }},
        },
        GLib: {build_filenamev: parts => parts.join('/'), find_program_in_path: () => '/usr/bin/gjs',
            FileTest: {IS_REGULAR: 1}, file_test: () => true},
    };
    const source = fs.readFileSync(new URL('../drag-bridge.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class DragBridge', 'class DragBridge');
    vm.runInNewContext(source + '\nglobalThis.Bridge = DragBridge;', context);
    return {bridge: new context.Bridge('/tmp/folder with spaces', value => reports.push(value)),
        children, reports, context};
}
test('Bridge sends selection via stdin and forwards repeated launches without killing the primary', () => {
    const {bridge, children} = bridgeHarness();
    const paths = ['/tmp/a b.jpg', '/tmp/$(touch injected).pdf'];
    bridge.open(paths.map(path => ({get_path: () => path})));
    assert.deepEqual(Array.from(children[0].argv), ['/usr/bin/gjs', '-m', '/tmp/folder with spaces/drag-helper.js']);
    assert.deepEqual(parseDragRequest(children[0].input), paths.map(path => pathToFileURL(path).href));
    bridge.open([{get_path: () => '/tmp/other'}]);
    assert.equal(children[0].killed, false);
    children[1].finish();
    assert.equal(bridge._processes.has(children[0]), true);
    assert.equal(children.length, 2);
});
test('Remote paths and missing helper do not spawn a child', () => {
    const {bridge, children, context} = bridgeHarness();
    assert.throws(() => bridge.open([{get_path: () => null}]), /remote/);
    context.GLib.file_test = () => false;
    assert.throws(() => bridge.open([{get_path: () => '/tmp/a'}]), /missing/);
    assert.equal(children.length, 0);
});
test('Child errors are surfaced; disabling cancels owned process without late notifications', () => {
    const {bridge, children, reports} = bridgeHarness();
    bridge.open([{get_path: () => '/tmp/a'}]);
    children[0].success = false;
    children[0].stderr = 'GTK failed';
    children[0].finish();
    assert.deepEqual(reports, ['GTK failed']);
    bridge.open([{get_path: () => '/tmp/b'}]);
    bridge.destroy();
    assert.equal(children[1].killed, true);
    children[1].success = false;
    children[1].finish();
    assert.equal(reports.length, 1);
    assert.throws(() => bridge.open([]), /disabled/);
});

test('Menu snapshots selected files before closing; launch failure leaves menu usable', () => {
    const source = fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('    _openDragWindow(row) {'),
        source.indexOf('    _selectionFilesForRow(row) {'));
    const errors = [];
    const context = {Main: {notifyError: (...args) => errors.push(args)}, global: {get_window_actors: () => []}};
    vm.runInNewContext(`class Menu {${method}}; globalThis.Menu = Menu;`, context);
    const menu = new context.Menu();
    const selected = [1, 2];
    let received;
    menu._selectionFilesForRow = () => selected.slice();
    menu._dragBridge = {open: files => {received = files;}};
    menu._closeContextMenu = () => {};
    menu.menu = {close: () => {selected.length = 0;}};
    menu._openDragWindow({});
    assert.deepEqual(received, [1, 2]);
    assert.equal(selected.length, 0);
    selected.push(3);
    menu._dragBridge.open = () => {throw new Error('missing helper');};
    menu._openDragWindow({});
    assert.deepEqual(selected, [3]);
    assert.match(errors[0][1], /missing helper/);
});

test('Offline drop page recognizes readable Files and rejects a path-only drop', async () => {
    const elements = Object.fromEntries(['zone', 'result'].map(id => [id, {
        textContent: '', handlers: {}, classList: {add() {}, remove() {}},
        addEventListener(name, handler) {this.handlers[name] = handler;},
    }]));
    const html = fs.readFileSync(new URL('../drop-test.html', import.meta.url), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(script, {document: {getElementById: id => elements[id]},
        window: {addEventListener() {}}});
    let prevented = false;
    await elements.zone.handlers.drop({preventDefault() {prevented = true;},
        dataTransfer: {files: [new File(['hello'], 'a b.txt', {type: 'text/plain'})], types: ['Files']}});
    assert.equal(prevented, true);
    assert.match(elements.result.textContent, /PASS — a b.txt \(5 bytes; text\/plain\): readable/);
    await elements.zone.handlers.drop({preventDefault() {},
        dataTransfer: {files: [], types: ['text/plain']}});
    assert.match(elements.result.textContent, /No files received/);
});
