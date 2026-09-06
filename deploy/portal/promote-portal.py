"""Promote a built Portal image on Oracle; retain state and restore on failure."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
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
environment = root / 'secrets/portal.env'
release = root / 'release.env'
image = 'freightclaw-portal:' + args.build_id[:12]
subprocess.run(['docker', 'image', 'inspect', image], check=True,
               stdout=subprocess.DEVNULL)
old_image = subprocess.check_output(
    ['docker', 'inspect', '--format', '{{.Config.Image}}', 'logistics-mcp-portal'],
    text=True).strip()
backup = root / 'backups' / datetime.now(timezone.utc).strftime('portal-promotion-%Y%m%dT%H%M%SZ')
backup.mkdir(mode=0o700)
for source in [environment, release]:
    shutil.copy2(source, backup / source.name)
    os.chmod(backup / source.name, 0o600)

compose = ['docker', 'compose', '--env-file', str(release), '-f', str(root / 'compose.yml'), 'up', '-d', 'portal']
probe = """import http from 'node:http';
const q=http.get('http://127.0.0.1:8082/console/readyz',
{headers:{host:'www.freightclaw.net'}},r=>{let b='';r.on('data',c=>b+=c);
r.on('end',()=>{if(r.statusCode!==200)process.exit(1);process.stdout.write(b)});});
q.setTimeout(15000,()=>q.destroy());q.on('error',()=>process.exit(1));"""

try:
    lines = environment.read_text().splitlines()
    assert sum(line.startswith('PORTAL_BUILD_ID=') for line in lines) == 1
    environment.write_text('\n'.join(
        'PORTAL_BUILD_ID=' + args.build_id if line.startswith('PORTAL_BUILD_ID=') else line
        for line in lines) + '\n')
    release.write_text('PORTAL_IMAGE=' + image + '\n')
    subprocess.run(compose, check=True)
    ready = None
    for _ in range(15):
        check = subprocess.run(['docker', 'exec', 'logistics-mcp-portal', 'node',
                                '--input-type=module', '-e', probe],
                               capture_output=True, text=True, timeout=20)
        if check.returncode == 0:
            ready = json.loads(check.stdout)
            break
        time.sleep(2)
    data = ready.get('data', {}) if ready else {}
    if (not ready or ready.get('status') != 'success'
            or data.get('ready') is not True
            or data.get('build_id') != args.build_id
            or not data.get('checks')
            or not all(value is True for value in data['checks'].values())):
        raise RuntimeError('Candidate readiness or build identity did not match')
    result = {'promoted': True, 'image': image, 'previous_image': old_image,
              'config_backup': str(backup), 'readiness': ready}
    (backup / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
except Exception:
    for target in [environment, release]:
        # Preserve the original file's ownership and private permission bits.
        target.write_bytes((backup / target.name).read_bytes())
    subprocess.run(compose, check=True)
    raise
