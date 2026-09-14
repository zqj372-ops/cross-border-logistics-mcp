import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {renderPdf} from '../../services/quote-documents/renderer';

it('isolates browser HOME and XDG paths for every render without disabling the sandbox',async()=>{
 const root=await mkdtemp(join(tmpdir(),'quote-renderer-test-')),workspace=join(root,'workspace'),binary=join(root,'fake-browser.mjs'),previousCwd=process.cwd(),previousBrowser=process.env.PORTAL_PDF_BROWSER_EXECUTABLE,previousCapture=process.env.RENDERER_CAPTURE_PATH;
 try{
  await mkdir(join(workspace,'dist/services/quote-documents/fonts'),{recursive:true});
  await writeFile(join(workspace,'dist/services/quote-documents/fonts/fonts.css'),'');
  await writeFile(binary,`#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2),output=args.find(value=>value.startsWith('--print-to-pdf='))?.slice('--print-to-pdf='.length);\nif(!output||!process.env.RENDERER_CAPTURE_PATH)process.exit(2);\nwriteFileSync(process.env.RENDERER_CAPTURE_PATH,JSON.stringify({home:process.env.HOME,homeExists:existsSync(process.env.HOME),xdgConfig:process.env.XDG_CONFIG_HOME,xdgCache:process.env.XDG_CACHE_HOME,args}));\nwriteFileSync(output,Buffer.from('%PDF-1.7\\n'+'.'.repeat(120)));\n`);
  await chmod(binary,0o700);process.chdir(workspace);process.env.PORTAL_PDF_BROWSER_EXECUTABLE=binary;
  const invoke=async(name:string)=>{const capture=join(root,`${name}.json`);process.env.RENDERER_CAPTURE_PATH=capture;const pdf=await renderPdf('<!doctype html><style></style><p>fixture</p>');return {pdf,environment:JSON.parse(await readFile(capture,'utf8')) as {home:string;homeExists:boolean;xdgConfig:string;xdgCache:string;args:string[]}};};
  const first=await invoke('first'),second=await invoke('second');
  for(const result of [first,second]){
   expect(result.pdf.subarray(0,5).toString()).toBe('%PDF-');expect(result.pdf.length).toBeGreaterThan(100);
   expect(result.environment.homeExists).toBe(true);
   expect(result.environment.xdgConfig).toBe(join(result.environment.home,'config'));
   expect(result.environment.xdgCache).toBe(join(result.environment.home,'cache'));
   expect(result.environment.args).toContain(`--user-data-dir=${join(result.environment.home,'profile')}`);
   expect(result.environment.args.some(value=>value.startsWith('--no-sandbox'))).toBe(false);
   expect(result.environment.args.at(-1)).toMatch(/^file:/u);
  }
  expect(first.environment.home).not.toBe(second.environment.home);
 }finally{
  process.chdir(previousCwd);
  if(previousBrowser===undefined)delete process.env.PORTAL_PDF_BROWSER_EXECUTABLE;else process.env.PORTAL_PDF_BROWSER_EXECUTABLE=previousBrowser;
  if(previousCapture===undefined)delete process.env.RENDERER_CAPTURE_PATH;else process.env.RENDERER_CAPTURE_PATH=previousCapture;
  await rm(root,{recursive:true,force:true});
 }
});
