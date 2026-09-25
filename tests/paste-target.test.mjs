import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function browser() {
    const source = fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('    _getPasteTargetForRow(row) {'),
        source.indexOf('    _captureFocusState() {'));
    const context = {};
    vm.runInNewContext(`class Browser {${method}}; globalThis.Browser = Browser;`, context);
    const instance = new context.Browser();
    instance._columnDirectories = [null, {name: 'Downloads'}, {name: 'Other column'}];
    instance.childMode = false;
    instance._settingBoolean = (key, fallback) => {
        assert.equal(key, 'paste-into-focused-folder');
        assert.equal(fallback, false);
        return instance.childMode;
    };
    return instance;
}

test('Default paste stays in focused column when a child folder is highlighted', () => {
    const b = browser();
    const row = {_folderBrowserDepth: 1, _folderBrowserIsDirectory: true,
        _folderBrowserFile: {name: 'Child'}};
    assert.equal(b._getPasteTargetForRow(row), b._columnDirectories[1]);
    b.childMode = true;
    assert.equal(b._getPasteTargetForRow(row), row._folderBrowserFile);
    b.childMode = false;
    assert.equal(b._getPasteTargetForRow(row), b._columnDirectories[1]);
});
test('File rows always use their containing column in both modes', () => {
    const b = browser();
    for (const mode of [false, true]) {
        b.childMode = mode;
        assert.equal(b._getPasteTargetForRow({_folderBrowserDepth: 2,
            _folderBrowserIsDirectory: false, _folderBrowserFile: {name: 'file.txt'}}),
        b._columnDirectories[2]);
    }
});
test('Bookmark roots keep a real folder destination; virtual headings have none', () => {
    const b = browser();
    const row = {_folderBrowserDepth: 0, _folderBrowserIsDirectory: true,
        _folderBrowserFile: {name: 'Pinned folder'}};
    assert.equal(b._getPasteTargetForRow(row), row._folderBrowserFile);
    assert.equal(b._getPasteTargetForRow({_folderBrowserDepth: 0,
        _folderBrowserIsDirectory: true, _folderBrowserFile: null}), null);
    assert.equal(b._getPasteTargetForRow(null), null);
});
