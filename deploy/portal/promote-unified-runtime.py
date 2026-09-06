"""Promote only the MCP runtime while preserving its existing compose inputs."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('build_id')
args = parser.parse_args()
if not re.fullmatch(r'[a-f0-9]{64}', args.build_id):
    raise SystemExit('Invalid build identity')
root = Path('/data/logistics-mcp/portal')
container = 'logistics-mcp-runtime'
image = 'freightclaw-portal:' + args.build_id[:12]
subprocess.run(['docker', 'image', 'inspect', image], check=True, stdout=subprocess.DEVNULL)
current = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
labels = current['Config']['Labels']
files = labels['com.docker.compose.project.config_files'].split(',')
environment = Path(labels['com.docker.compose.project.environment_file'])
project = labels['com.docker.compose.project']
if not environment.is_file() or not all(Path(name).is_file() for name in files):
    raise SystemExit('Existing runtime deployment inputs are unavailable')
backup = root / 'backups' / datetime.now(timezone.utc).strftime('runtime-unified-%Y%m%dT%H%M%SZ')
backup.mkdir(mode=0o700)
shutil.copy2(environment, backup / 'runtime.env')
os.chmod(backup / 'runtime.env', 0o600)
override = root / 'runtime-unified-key.override.json'
old_override = override.read_bytes() if override.exists() else None
if old_override is not None:
    (backup / 'override.json').write_bytes(old_override)
    os.chmod(backup / 'override.json', 0o600)
base_files = [name for name in files if name != str(override)]
compose = ['docker', 'compose', '--project-name', project, '--env-file', str(environment)]
for name in base_files:
    compose += ['-f', name]
command = compose + ['-f', str(override), 'up', '-d', '--no-deps', 'logistics-mcp']
volume = next(mount for mount in current['Mounts'] if mount['Destination'] == '/var/lib/logistics-mcp')
source = Path(volume['Source']) / 'platform.sqlite'
if not source.is_file() or source.is_symlink():
    raise SystemExit('Runtime database not found')
subprocess.run(['docker', 'stop', '--time', '20', container], check=True, stdout=subprocess.DEVNULL)
try:
    # Copy only while the runtime is stopped, then restore-check using its SQLite version.
    raw = backup / 'raw-state'
    raw.mkdir(mode=0o700)
    for suffix in ('', '-wal', '-shm'):
        candidate = Path(str(source) + suffix)
        if candidate.is_file():
            shutil.copy2(candidate, raw / ('platform.sqlite' + suffix))
            os.chmod(raw / ('platform.sqlite' + suffix), 0o600)
    snapshot_script = """import { DatabaseSync } from 'node:sqlite';
const snapshot=new DatabaseSync('/tmp/platform.sqlite');
const integrity=snapshot.prepare('PRAGMA integrity_check').all();
const foreignKeys=snapshot.prepare('PRAGMA foreign_key_check').all();
if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok'||foreignKeys.length)process.exit(1);
snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');snapshot.close();"""
    checker = subprocess.check_output(['docker', 'create', '--network', 'none', '--user', '0:0',
                    '--entrypoint', 'node', current['Config']['Image'],
                    '--input-type=module', '-e', snapshot_script], text=True).strip()
    try:
        subprocess.run(['docker', 'cp', str(raw) + '/.', checker + ':/tmp/'], check=True)
        subprocess.run(['docker', 'start', '--attach', checker], check=True)
        checked = json.loads(subprocess.check_output(['docker', 'inspect', checker]))[0]
        if checked['State']['ExitCode'] != 0:
            raise RuntimeError('Runtime snapshot failed restore validation')
        subprocess.run(['docker', 'cp', checker + ':/tmp/platform.sqlite', str(backup / 'platform.sqlite')], check=True)
    finally:
        subprocess.run(['docker', 'rm', '--force', checker], check=True, stdout=subprocess.DEVNULL)
    os.chmod(backup / 'platform.sqlite', 0o600)
finally:
    subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
settings = {'services': {'logistics-mcp': {'image': image, 'environment': {
    'MCP_APPLICATION_AUTHORITY_URL': 'https://www.freightclaw.net/access/v2/application/token/authority',
    'MCP_APPLICATION_AUTHORITY_ALLOWED_HOSTS': 'www.freightclaw.net',
}}}}
probe = """import http from 'node:http';
const q=http.get('http://127.0.0.1:8080/readyz',{headers:{host:'www.freightclaw.net'}},r=>{
let b='';r.on('data',c=>b+=c);r.on('end',()=>{if(r.statusCode!==200)process.exit(1);process.stdout.write(b)});});
q.setTimeout(10000,()=>q.destroy());q.on('error',()=>process.exit(1));"""
try:
    override.write_text(json.dumps(settings, indent=2) + '\n')
    os.chmod(override, 0o600)
    subprocess.run(command, check=True)
    ready = None
    for _ in range(15):
        check = subprocess.run(['docker', 'exec', container, 'node', '--input-type=module', '-e', probe], capture_output=True, text=True, timeout=15)
        if check.returncode == 0:
            ready = json.loads(check.stdout)
            break
        time.sleep(2)
    promoted = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
    if ready is None or ready.get('status') != 'ready' or ready.get('reasons') != [] or promoted['Config']['Image'] != image or not promoted['State']['Running']:
        raise RuntimeError('Runtime readiness or image did not match')
    result = {'promoted': True, 'image': image, 'previous_image': current['Config']['Image'], 'backup': str(backup), 'database_integrity': 'ok', 'readiness': ready}
    (backup / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
except Exception:
    if old_override is not None:
        override.write_bytes(old_override)
        subprocess.run(command, check=True)
    else:
        rollback = {'services': {'logistics-mcp': {'image': current['Config']['Image']}}}
        override.write_text(json.dumps(rollback) + '\n')
        subprocess.run(command, check=True)
    raise
