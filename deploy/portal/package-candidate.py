"""Package the current build inputs without runtime files or credentials."""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
output = root / '.runtime/production-evidence'
output.mkdir(parents=True, exist_ok=True)
directories = ['src', 'services', 'apps/admin', 'apps/access-console', 'apps/console', 'apps/inquiry',
               'docs/contracts', 'docs/agent', 'docs/standards', 'docs/rfcs',
               'docs/superpowers/plans', 'deploy/scripts', 'schemas']
files = {'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
         'deploy/Dockerfile', 'deploy/portal/inquiry-navigation.css', 'deploy/portal/compose.yml',
         'deploy/portal/chromium-seccomp.json', 'deploy/portal/chromium-seccomp.LICENSE', '.dockerignore'}
for directory in directories:
    for path in (root / directory).rglob('*'):
        if path.is_file() and not path.is_symlink() and path.suffix in {
                '.ts', '.js', '.mjs', '.json', '.md', '.css', '.html', '.svg', '.woff2', '.py', '.sql'}:
            if 'node_modules' not in path.parts and '__pycache__' not in path.parts:
                files.add(str(path.relative_to(root)))
contents = {name: (root / name).read_bytes() for name in sorted(files)}
manifest = [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            for name, data in contents.items()]
if any((root / name).read_bytes() != data for name, data in contents.items()):
    raise RuntimeError('Build inputs changed while packaging; retry after the edit completes.')
build_id = hashlib.sha256(json.dumps(manifest, separators=(',', ':')).encode()).hexdigest()
archive = output / f'portal-{build_id[:12]}.tar.gz'
with tarfile.open(archive, 'w:gz') as target:
    for name, data in contents.items():
        info = tarfile.TarInfo(name)
        info.size, info.mode, info.mtime = len(data), 0o644, 0
        target.addfile(info, io.BytesIO(data))
metadata = {
    'build_id': build_id,
    'source_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'source_is_working_tree': True,
    'archive': str(archive),
    'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'files': manifest,
}
(output / f'portal-{build_id[:12]}.manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({key: value for key, value in metadata.items() if key != 'files'}))
