import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
it('packages native Python calculation and sandbox deployment files without runtime state',()=>{
 const result=JSON.parse(execFileSync('python3',['deploy/portal/package-candidate.py'],{encoding:'utf8'})) as {build_id:string};
 const manifest=JSON.parse(readFileSync(`.runtime/production-evidence/portal-${result.build_id.slice(0,12)}.manifest.json`,'utf8')) as {files:{path:string}[]};
 const paths=manifest.files.map(f=>f.path);
 for(const file of ['services/quote-native/run.py','services/quote-native/mixed_pallets.py','services/quote-native/upstream/pallet_calculator.py','deploy/portal/compose.yml','deploy/portal/chromium-seccomp.json','deploy/portal/chromium-seccomp.LICENSE'])expect(paths).toContain(file);
 expect(paths.some(p=>p.startsWith('.runtime/')||p.includes('node_modules/')||p.endsWith('.sqlite')||p.endsWith('.env'))).toBe(false);
},20000);
