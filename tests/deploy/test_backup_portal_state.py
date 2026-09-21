import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing


SCRIPT = Path(__file__).resolve().parents[2] / 'deploy' / 'portal' / 'backup-portal-state.py'
SPEC = importlib.util.spec_from_file_location('backup_portal_state', SCRIPT)
BACKUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKUP)


class BackupPortalStateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='portal-backup-test-')
        self.root = Path(self.temporary.name) / 'portal'
        (self.root / 'state').mkdir(parents=True, mode=0o700)
        (self.root / 'secrets').mkdir(mode=0o700)
        (self.root / 'secrets' / 'portal.env').write_text('PRIVATE=fixture-only\n')

    def tearDown(self):
        self.temporary.cleanup()

    def database(self, relative):
        path = self.root / 'state' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as database:
            database.execute('CREATE TABLE fixture_records(id TEXT PRIMARY KEY, value TEXT NOT NULL)')
            database.execute('INSERT INTO fixture_records VALUES(?, ?)', (str(relative), 'preserved'))
            database.commit()
        return path

    def inspect_state(self, quote_path='/var/lib/freightclaw-portal/quotes/quote-documents.sqlite'):
        environment = [
            'PORTAL_STATE_ROOT=/var/lib/freightclaw-portal',
            'PORTAL_CASES_ENABLED=true',
            'PORTAL_NATIVE_BUSINESS_ENABLED=true',
            f'PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH={quote_path}',
        ]
        return {'Config': {'Env': environment, 'Image': 'freightclaw-mcp:test'}, 'Mounts': [{'Source': str(self.root / 'state'), 'Destination': '/var/lib/freightclaw-portal'}]}

    def enabled_files(self, include_quote=True, include_key=True):
        for name in ('portal.sqlite', 'sessions.sqlite', 'business-access.sqlite', 'calls.sqlite', 'business-cases.sqlite', 'native-business.sqlite'):
            self.database(name)
        if include_quote:
            self.database('quotes/quote-documents.sqlite')
        if include_key:
            (self.root / 'state' / 'native-business.sqlite.encryption-key').write_bytes(b'k' * 32)

    def test_backs_up_enabled_business_databases_and_native_key(self):
        self.enabled_files()
        destination = self.root / 'backups' / 'offline-test'
        destination.mkdir(parents=True, mode=0o700)
        manifest = BACKUP.backup_quiesced_state(self.root, destination, self.inspect_state(), 'offline-test')
        files = {entry['file'] for entry in manifest['databases']}
        self.assertEqual(files, {'portal.sqlite', 'sessions.sqlite', 'business-access.sqlite', 'calls.sqlite', 'business-cases.sqlite', 'native-business.sqlite', 'quotes/quote-documents.sqlite'})
        for entry in manifest['databases']:
            self.assertEqual(entry['restore_integrity'], 'ok')
            self.assertEqual(entry['tables']['fixture_records'], 1)
        key_copy = destination / 'state' / 'native-business.sqlite.encryption-key'
        self.assertEqual(key_copy.read_bytes(), b'k' * 32)
        self.assertEqual(key_copy.stat().st_mode & 0o777, 0o400)
        self.assertNotIn('k' * 32, json.dumps(manifest))

    def test_personal_fcl_includes_case_and_native_stores_without_enterprise_flags(self):
        self.enabled_files()
        state = self.inspect_state()
        state['Config']['Env'] = [value for value in state['Config']['Env'] if not value.startswith(('PORTAL_CASES_ENABLED=', 'PORTAL_NATIVE_BUSINESS_ENABLED='))] + ['PORTAL_FCL_ENABLED=true']
        plan = BACKUP.build_backup_plan(self.root, state)
        self.assertIn(self.root / 'state' / 'business-cases.sqlite', plan['databases'])
        self.assertIn(self.root / 'state' / 'native-business.sqlite', plan['databases'])
        self.assertIn(self.root / 'state' / 'native-business.sqlite.encryption-key', plan['private_state'])

    def test_personal_fcl_without_freightcom_does_not_require_a_nonexistent_key(self):
        self.enabled_files(include_key=False)
        state = self.inspect_state()
        state['Config']['Env'] = [value for value in state['Config']['Env'] if not value.startswith(('PORTAL_CASES_ENABLED=', 'PORTAL_NATIVE_BUSINESS_ENABLED='))] + ['PORTAL_FCL_ENABLED=true']
        plan = BACKUP.build_backup_plan(self.root, state)
        self.assertEqual(len(plan['databases']), 7)
        self.assertEqual(plan['private_state'], [])

    def test_rejects_quote_database_outside_or_missing_from_the_state_mount(self):
        self.enabled_files(include_quote=False)
        with self.assertRaisesRegex(RuntimeError, 'outside PORTAL_STATE_ROOT'):
            BACKUP.build_backup_plan(self.root, self.inspect_state('/tmp/quote-documents.sqlite'))
        with self.assertRaisesRegex(RuntimeError, 'Expected a regular Portal database'):
            BACKUP.build_backup_plan(self.root, self.inspect_state())

    def test_rejects_missing_native_encryption_key(self):
        self.enabled_files(include_key=False)
        with self.assertRaisesRegex(RuntimeError, 'Expected a regular Portal private state file'):
            BACKUP.build_backup_plan(self.root, self.inspect_state())


if __name__ == '__main__':
    unittest.main()
