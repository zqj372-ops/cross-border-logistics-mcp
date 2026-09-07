import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildInquiry() {
  const output = resolve('dist/inquiry');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(resolve(output, 'assets'), { recursive: true });
  const result = await build({ entryPoints: ['apps/inquiry/app.js'], bundle: true, minify: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false, legalComments: 'none' });
  const css = await build({entryPoints:['apps/inquiry/styles.css'], outfile:resolve(output,'assets/styles.css'), bundle:true, minify:true, write:false, loader:{'.woff2':'file'}, assetNames:'fonts/[name]-[hash]', publicPath:'/inquiry/assets'});
  for(const file of css.outputFiles.filter(file=>!file.path.endsWith('.css'))) { mkdirSync(dirname(file.path),{recursive:true}); writeFileSync(file.path,file.contents); }
  const assets = { JS: ['app', 'js', result.outputFiles[0].contents], CSS: ['styles', 'css', css.outputFiles.find(file=>file.path.endsWith('.css')).contents] };
  let html = readFileSync('apps/inquiry/index.html', 'utf8');
  for (const [token, [name, extension, content]] of Object.entries(assets)) {
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const filename = `${name}-${digest}.${extension}`;
    writeFileSync(resolve(output, 'assets', filename), content);
    html = html.replace(`__INQUIRY_${token}__`, `/inquiry/assets/${filename}`);
  }
  writeFileSync(resolve(output, 'index.html'), html);
  mkdirSync(resolve(output, 'details'), { recursive: true });
  cpSync('apps/inquiry/details.html', resolve(output, 'details/index.html'));
  cpSync('apps/console/asset-licenses.md', resolve(output, 'asset-licenses.md'));
  cpSync('deploy/portal/inquiry-navigation.css', resolve(output, 'navigation.css'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildInquiry();
