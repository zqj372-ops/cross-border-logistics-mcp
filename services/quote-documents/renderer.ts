import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
let busy=false;
export async function renderPdf(html:string):Promise<Buffer>{
 const binary=process.env.PORTAL_PDF_BROWSER_EXECUTABLE;
 if(!binary||!isAbsolute(binary))throw new Error('pdf_renderer_not_configured');
 if(busy)throw new Error('pdf_renderer_busy');busy=true;
 let dir:string|undefined;
 try{dir=await mkdtemp(join(tmpdir(),'freightclaw-pdf-'));const input=join(dir,'quote.html'),output=join(dir,'quote.pdf');const fontDirectory=resolve('dist/services/quote-documents/fonts');let css=await readFile(join(fontDirectory,'fonts.css'),'utf8');
 for(const match of [...css.matchAll(/url\("\.\/([a-z0-9-]+\.woff2)"\)/gu)]){const bytes=await readFile(join(fontDirectory,match[1]!));css=css.replace(match[0],`url("data:font/woff2;base64,${bytes.toString('base64')}")`);}html=html.replace('<style>','<style>'+css);await writeFile(input,html,{mode:0o600});
 await exec(binary,['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-pdf-header-footer',`--user-data-dir=${join(dir,'profile')}`,`--print-to-pdf=${output}`,pathToFileURL(input).href],{timeout:10000,killSignal:'SIGKILL',maxBuffer:65536});
 const size=(await stat(output)).size;if(size<100||size>8*1024*1024)throw new Error('pdf_invalid');const bytes=await readFile(output);if(bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('pdf_invalid');return bytes;
 }finally{busy=false;if(dir)await rm(dir,{recursive:true,force:true});}
}
