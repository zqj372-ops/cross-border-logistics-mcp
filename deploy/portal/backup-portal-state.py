"""Back up and restore-check Portal state on its production host.

Briefly stops only the Portal so its three stores and key references share a
consistent application boundary. The previous MCP and source services keep
running. Private values are copied to a protected directory and never printed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--name', default=datetime.now(timezone.utc).strftime('portal-state-%Y%m%dT%H%M%SZ'))
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', args.name):
    raise SystemExit('Invalid backup name')
root = Path('/data/logistics-mcp/portal')
destination = root / 'backups' / args.name
destination.mkdir(mode=0o700)
os.chmod(destination, 0o700)
container = 'logistics-mcp-portal'
state = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
if not state['State']['Running']:
    raise SystemExit('Portal must be running before a managed backup')
subprocess.run(['docker', 'stop', '--time', '20', container], check=True, stdout=subprocess.DEVNULL)
checks = []
try:
    for name in ('portal.sqlite', 'sessions.sqlite', 'business-access.sqlite'):
        source = root / 'state' / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Expected a regular Portal database')
        copy = destination / name
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
            with sqlite3.connect(copy) as target:
                original.backup(target)
        os.chmod(copy, 0o600)
        restored = sqlite3.connect(':memory:')
        with sqlite3.connect(copy.as_uri() + '?mode=ro', uri=True) as snapshot:
            snapshot.backup(restored)
        integrity = restored.execute('PRAGMA integrity_check').fetchall()
        foreign_keys = restored.execute('PRAGMA foreign_key_check').fetchall()
        if integrity != [('ok',)] or foreign_keys:
            raise RuntimeError('Restored Portal database failed integrity validation')
        names = [row[0] for row in restored.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {name: restored.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}
        restored.close()
        checks.append({'file': name, 'sha256': hashlib.sha256(copy.read_bytes()).hexdigest(), 'restore_integrity': 'ok', 'tables': counts})
    for directory in ('secrets', 'state'):
        for source in sorted((root / directory).iterdir()):
            if directory == 'state' and source.suffix != '.json':
                continue
            if source.is_symlink() or not source.is_file():
                raise RuntimeError('Unexpected private state entry')
            target_directory = destination / directory
            target_directory.mkdir(mode=0o700, exist_ok=True)
            target = target_directory / source.name
            shutil.copy2(source, target)
            os.chmod(target, 0o400)
    manifest = {'backup': args.name, 'image': state['Config']['Image'], 'databases': checks, 'private_configuration_backed_up': True, 'cross_store_quiesced': True}
    metadata = destination / 'manifest.json'
    metadata.write_text(json.dumps(manifest, indent=2) + '\n')
    os.chmod(metadata, 0o600)
finally:
    subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
print(json.dumps(manifest))
