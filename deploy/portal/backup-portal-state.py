"""Back up and restore-check Portal state on its production host.

Briefly stops only the Portal so its stores and key references share a
consistent application boundary. The previous MCP and source services keep
running. Private values are copied to a protected directory and never printed.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone

def container_environment(state):
    environment = {}
    for entry in state.get('Config', {}).get('Env', []) or []:
        name, separator, value = entry.partition('=')
        if separator:
            environment[name] = value
    return environment


def mapped_state_root(root, state, environment):
    configured = environment.get('PORTAL_STATE_ROOT', '')
    container_root = PurePosixPath(posixpath.normpath(configured))
    if not configured or not container_root.is_absolute():
        raise RuntimeError('PORTAL_STATE_ROOT must be an absolute mapped path')
    matches = []
    for mount in state.get('Mounts', []) or []:
        destination = mount.get('Destination')
        source = mount.get('Source')
        if not destination or not source:
            continue
        container_mount = PurePosixPath(posixpath.normpath(destination))
        try:
            relative = container_root.relative_to(container_mount)
        except ValueError:
            continue
        matches.append((len(container_mount.parts), Path(source).joinpath(*relative.parts)))
    if not matches:
        raise RuntimeError('PORTAL_STATE_ROOT is not backed by a host mount')
    host_root = max(matches, key=lambda match: match[0])[1]
    expected = root / 'state'
    if expected.is_symlink() or not expected.is_dir() or host_root.resolve() != expected.resolve():
        raise RuntimeError('PORTAL_STATE_ROOT does not use the managed Portal state mount')
    return container_root, expected


def mapped_database_path(value, container_root, state_root):
    container_path = PurePosixPath(posixpath.normpath(value))
    if not value or not container_path.is_absolute():
        raise RuntimeError('PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH must be absolute')
    try:
        relative = container_path.relative_to(container_root)
    except ValueError as error:
        raise RuntimeError('Quote documents database is outside PORTAL_STATE_ROOT') from error
    if not relative.parts:
        raise RuntimeError('Quote documents database path is invalid')
    return state_root.joinpath(*relative.parts)


def require_regular_state_file(path, state_root, description):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f'Expected a regular {description}')
    try:
        path.resolve(strict=True).relative_to(state_root.resolve(strict=True))
    except ValueError as error:
        raise RuntimeError(f'{description} is outside PORTAL_STATE_ROOT') from error


def build_backup_plan(root, state):
    environment = container_environment(state)
    container_root, state_root = mapped_state_root(root, state, environment)
    databases = [state_root / name for name in ('portal.sqlite', 'sessions.sqlite', 'business-access.sqlite')]
    databases.extend(state_root / name for name in ('calls.sqlite', 'public-quota.sqlite') if (state_root / name).exists())
    if environment.get('PORTAL_CASES_ENABLED') == 'true':
        databases.append(state_root / 'business-cases.sqlite')
    private_state = []
    if environment.get('PORTAL_NATIVE_BUSINESS_ENABLED') == 'true':
        native_database = state_root / 'native-business.sqlite'
        databases.append(native_database)
        private_state.append(Path(str(native_database) + '.encryption-key'))
    quote_path = environment.get('PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH', '')
    if quote_path:
        databases.append(mapped_database_path(quote_path, container_root, state_root))
    resolved = []
    for database in databases:
        require_regular_state_file(database, state_root, 'Portal database')
        canonical = database.resolve(strict=True)
        if canonical in resolved:
            raise RuntimeError('Portal database is configured more than once')
        resolved.append(canonical)
    for private_file in private_state:
        require_regular_state_file(private_file, state_root, 'Portal private state file')
    return {'state_root': state_root, 'databases': databases, 'private_state': private_state}


def protected_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def backup_database(source, state_root, destination):
    relative = source.relative_to(state_root)
    copy = destination / relative
    protected_directory(copy.parent)
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as original:
        with closing(sqlite3.connect(copy)) as target:
            original.backup(target)
    os.chmod(copy, 0o600)
    restored = sqlite3.connect(':memory:')
    try:
        with closing(sqlite3.connect(copy.resolve().as_uri() + '?mode=ro', uri=True)) as snapshot:
            snapshot.backup(restored)
        integrity = restored.execute('PRAGMA integrity_check').fetchall()
        foreign_keys = restored.execute('PRAGMA foreign_key_check').fetchall()
        if integrity != [('ok',)] or foreign_keys:
            raise RuntimeError('Restored Portal database failed integrity validation')
        names = [row[0] for row in restored.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {name: restored.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}
    finally:
        restored.close()
    return {'file': relative.as_posix(), 'sha256': hashlib.sha256(copy.read_bytes()).hexdigest(), 'restore_integrity': 'ok', 'tables': counts}


def copy_private_file(source, target):
    if source.is_symlink() or not source.is_file():
        raise RuntimeError('Unexpected private state entry')
    protected_directory(target.parent)
    shutil.copy2(source, target)
    os.chmod(target, 0o400)


def backup_quiesced_state(root, destination, state, backup_name):
    plan = build_backup_plan(root, state)
    checks = [backup_database(source, plan['state_root'], destination) for source in plan['databases']]
    for directory in ('secrets', 'state'):
        source_directory = root / directory
        if source_directory.is_symlink() or not source_directory.is_dir():
            raise RuntimeError('Unexpected private state directory')
        for source in sorted(source_directory.iterdir()):
            if directory == 'state' and source.suffix != '.json':
                continue
            copy_private_file(source, destination / directory / source.name)
    for source in plan['private_state']:
        copy_private_file(source, destination / 'state' / source.relative_to(plan['state_root']))
    manifest = {'backup': backup_name, 'image': state['Config']['Image'], 'databases': checks, 'private_configuration_backed_up': True, 'cross_store_quiesced': True}
    metadata = destination / 'manifest.json'
    metadata.write_text(json.dumps(manifest, indent=2) + '\n')
    os.chmod(metadata, 0o600)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--name', default=datetime.now(timezone.utc).strftime('portal-state-%Y%m%dT%H%M%SZ'))
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', args.name):
        raise SystemExit('Invalid backup name')
    root = Path('/data/logistics-mcp/portal')
    container = 'logistics-mcp-portal'
    state = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
    if not state['State']['Running']:
        raise SystemExit('Portal must be running before a managed backup')
    build_backup_plan(root, state)
    destination = root / 'backups' / args.name
    destination.mkdir(mode=0o700)
    os.chmod(destination, 0o700)
    subprocess.run(['docker', 'stop', '--time', '20', container], check=True, stdout=subprocess.DEVNULL)
    try:
        manifest = backup_quiesced_state(root, destination, state, args.name)
    finally:
        subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
