/** Isolated deployment check. Never loads customer records or approves quotes. */
import {writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {renderPdf} from '../../services/quote-documents/renderer';

const output=process.argv[2];
if(!output||!isAbsolute(output))throw new Error('absolute_new_output_path_required');
const pdf=await renderPdf('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:"><style>body{font-family:"Noto Sans SC",sans-serif;font-size:20px}</style><h1>FreightClaw 部署验收样张</h1><p>仅验证中文字体与 PDF 导出，不是业务报价。</p><p>USD 123.45 · Toronto / Calgary</p></html>');
await writeFile(output,pdf,{mode:0o600,flag:'wx'});
console.log(JSON.stringify({status:'success',synthetic:true,bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')}));
