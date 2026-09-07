#!/usr/bin/env python3
"""Export only regulatory tables from a read-only RiskCustoms database.
No accounts, history, tokens, audit payloads or business records are copied.
The source's release status and publication gates are preserved verbatim.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import uuid
from pathlib import Path

TABLES = ('source_release', 'source_artifact', 'nomenclature', 'hs_concept',
          'nomenclature_concept', 'translation', 'legal_note', 'tariff_rule',
          'trade_measure', 'regulatory_requirement', 'publication_snapshot',
          'nomenclature_search')


def _export(source, destination):
    source, destination = Path(source).resolve(), Path(destination).absolute()
    if source == destination or destination.exists():
        raise ValueError('destination_must_be_new')
    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    counts = {}
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
        src.execute('PRAGMA query_only=ON')
        src.execute('BEGIN')
        with sqlite3.connect(destination) as out:
            out.execute('BEGIN')
            for table in TABLES:
                columns = list(src.execute('PRAGMA table_info(' + table + ')'))
                if not columns:
                    continue
                if any(not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', col[1]) or
                       col[2].upper() not in ('TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC')
                       for col in columns):
                    raise ValueError('source_schema_unsupported')
                definitions = [f'"{col[1]}" {col[2]}' for col in columns]
                primary = sorted((col[5], col[1]) for col in columns if col[5])
                if primary:
                    definitions.append('PRIMARY KEY (' + ','.join('"' + key + '"' for _, key in primary) + ')')
                out.execute('CREATE TABLE ' + table + '(' + ','.join(definitions) + ')')
                reader = src.execute('SELECT * FROM ' + table)
                count = 0
                while rows := reader.fetchmany(2000):
                    out.executemany('INSERT INTO ' + table + ' VALUES(' + ','.join('?' for _ in columns) + ')', rows)
                    count += len(rows)
                counts[table] = count
            for table, columns in [('nomenclature', 'country,code,release_id'),
                                   ('tariff_rule', 'country,code,release_id'),
                                   ('trade_measure', 'country,code_hint,release_id'),
                                   ('regulatory_requirement', 'country,release_id'),
                                   ('publication_snapshot', 'rule_date,evaluated_at')]:
                if table in counts and set(columns.split(',')) <= {row[1] for row in out.execute('PRAGMA table_info(' + table + ')')}:
                    out.execute(f'CREATE INDEX export_{table}_lookup ON {table}({columns})')
            if 'nomenclature_search' in counts:
                out.execute("CREATE VIRTUAL TABLE nomenclature_fts USING fts5(code,description_original,search_terms,content='nomenclature_search',content_rowid='row_id',tokenize='unicode61 remove_diacritics 2')")
                out.execute("INSERT INTO nomenclature_fts(nomenclature_fts) VALUES('rebuild')")
            out.commit()
            if out.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('snapshot_integrity_failed')
        src.rollback()
    digest = hashlib.sha256()
    with destination.open('rb') as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return {'filename': destination.name, 'sha256': digest.hexdigest(), 'bytes': destination.stat().st_size,
            'counts': counts, 'source_read_only': True, 'publication_status_preserved': True}


def export(source, destination):
    destination = Path(destination).absolute()
    if destination.exists():
        raise ValueError('destination_must_be_new')
    temporary = destination.with_name('.' + destination.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        result = _export(source, temporary)
        os.link(temporary, destination)  # Atomic publication without replacing an existing file.
        result['filename'] = destination.name
        return result
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(export(args.source, args.output), ensure_ascii=False))
