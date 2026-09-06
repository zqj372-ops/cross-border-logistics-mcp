"""Start the protected quote API alongside the original production service.

Run as root on Oracle, after building the image and applying its migrations.
Configuration values stay in process memory and Docker's existing private state.
An existing container with a different image is never replaced automatically.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
args = parser.parse_args()
if not re.fullmatch(r'freightclaw-quote-api:[a-f0-9]{12,64}', args.image):
    raise SystemExit('Invalid quote release image')

name = 'freightclaw-quote-api'
private = Path('/data/logistics-mcp/portal/secrets')
existing = subprocess.run(['docker', 'inspect', name], capture_output=True)
if existing.returncode == 0:
    state = json.loads(existing.stdout)[0]
    if state['Config']['Image'] != args.image:
        raise SystemExit('Existing candidate differs; use a reviewed rollout before replacing it')
else:
    public_key = (private / 'source-quote.public.pem').read_text()
    subprocess.run([
        'docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped',
        '--network', 'canada_quote_oracle_default',
        '--env-file', str(private / 'quote.env'),
        '--env', 'QUOTE_DELEGATION_PUBLIC_KEY_PEM=' + public_key,
        '--publish', '127.0.0.1:28001:8000',
        '--volume', '/home/opc/canada-final-mile-auto-quote/outputs:/app/outputs',
        args.image,
    ], check=True, stdout=subprocess.DEVNULL)
    state = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
if 'freightclaw-net' not in state['NetworkSettings']['Networks']:
    subprocess.run(['docker', 'network', 'connect', 'freightclaw-net', name], check=True)
print(json.dumps({'container': name, 'image': args.image, 'shared_network_connected': True}))
