import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseDragRequest} from './drag-payload.js';

// GTK must run outside GNOME Shell. Pass file identifiers over stdin, never a shell.
export class DragBridge {
    constructor(extensionPath, reportError) {
        this._path = GLib.build_filenamev([extensionPath, 'drag-helper.js']);
        this._reportError = reportError;
        this._processes = new Set();
        this._disposed = false;
    }

    open(files) {
        if (this._disposed)
            throw new Error('The extension is disabled.');
        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs || !GLib.file_test(this._path, GLib.FileTest.IS_REGULAR))
            throw new Error('Drag helper is missing. Reinstall this build; on Fedora it needs gjs and gtk4.');

        const uris = files.map(file => {
            const path = file.get_path();
            if (!path)
                throw new Error('Copy remote/phone files to a local folder first, then drag those copies.');
            return Gio.File.new_for_path(path).get_uri();
        });
        const request = JSON.stringify({version: 1, uris});
        parseDragRequest(request);
        const process = Gio.Subprocess.new([gjs, '-m', this._path],
            Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE);
        this._processes.add(process);
        process.communicate_utf8_async(request, null, (child, result) => {
            try {
                const [, , stderr] = child.communicate_utf8_finish(result);
                if (!this._disposed && !child.get_successful())
                    this._reportError((stderr || 'The drag helper exited unexpectedly.').trim().slice(-1600));
            } catch (error) {
                if (!this._disposed)
                    this._reportError(error.message);
            } finally {
                this._processes.delete(child);
            }
        });
    }

    ownsPid(pid) {
        return [...this._processes].some(child => Number(child.get_identifier()) === pid);
    }

    destroy() {
        this._disposed = true;
        for (const child of this._processes)
            child.force_exit();
        this._processes.clear();
    }
}
