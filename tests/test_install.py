"""Exercise the real installer with mocked desktop commands in temporary homes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UUID = 'bookmarks-only@azhan'


class InstallerTest(unittest.TestCase):
    def exercise(self, dependency_ok):
        with tempfile.TemporaryDirectory(prefix='focustrail test ') as tmp:
            home = Path(tmp) / 'home'
            commands = Path(tmp) / 'bin'
            commands.mkdir()
            dest = home / '.local/share/gnome-shell/extensions' / UUID
            dest.mkdir(parents=True)
            (dest / 'old-file').write_text('working installation')
            scripts = {
                'gjs': '#!/bin/bash\nexit ' + ('0' if dependency_ok else '1') + '\n',
                'gnome-extensions': '#!/bin/bash\nexit 0\n',
                'glib-compile-schemas': '#!/bin/bash\nfor arg; do [[ "$arg" == "--dry-run" ]] && exit 0; done\nprintf compiled > "${!#}/gschemas.compiled"\n',
            }
            for name, script in scripts.items():
                p = commands / name
                p.write_text(script)
                p.chmod(0o755)
            env = dict(os.environ, HOME=str(home), PATH=str(commands) + ':' + os.environ['PATH'])
            result = subprocess.run(['bash', str(ROOT / 'install.sh')], env=env,
                                    text=True, capture_output=True)
            if dependency_ok:
                self.assertEqual(result.returncode, 0, result.stderr)
                for name in ['extension.js', 'drag-helper.js', 'drag-bridge.js', 'drag-payload.js', 'drop-test.html']:
                    self.assertEqual((dest / name).read_bytes(), (ROOT / name).read_bytes())
                backups = list((home / '.local/share/bookmarks-only-backups').glob('*.backup-*'))
                self.assertEqual(len(backups), 1)
                self.assertEqual((backups[0] / 'old-file').read_text(), 'working installation')
                self.assertTrue((dest / 'schemas/gschemas.compiled').exists())
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((dest / 'old-file').read_text(), 'working installation')
                self.assertFalse((dest / 'drag-helper.js').exists())

    def test_successful_upgrade(self):
        self.exercise(True)

    def test_dependency_failure_preserves_install(self):
        self.exercise(False)


if __name__ == '__main__':
    unittest.main()
