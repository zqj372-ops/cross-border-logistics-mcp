import {lstat,mkdir,mkdtemp,readFile,rename,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {afterEach,describe,expect,it} from 'vitest';
import {runCli} from '../../deploy/cli/cli';
import {FCL_HTTP_VERSION,fclHttpActions} from '../../services/access-gateway/portal/fcl-http-contracts';
import {createFclCliFixture,fclCliInquiry,fclCliRates} from './fcl-cli-fixture';

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

async function invoke(args:string[],options:{env?:NodeJS.ProcessEnv;stdin?:string;fetch?:typeof fetch}={}){
  let stdout='',stderr='';
  const code=await runCli(args,{env:options.env??{},...(options.stdin===undefined?{}:{stdin:Readable.from([options.stdin])}),stdout:value=>{stdout+=value;},stderr:value=>{stderr+=value;},...(options.fetch?{fetch:options.fetch}:{})});
  return {code,stdout,stderr};
}

async function privateJson(filename:string,value:unknown){await writeFile(filename,JSON.stringify(value),{mode:0o600});}

describe('FCL CLI parity',()=>{
  it('publishes every canonical staff action and the public inquiry commands with explicit identity types',async()=>{
    const listed=await invoke(['workspace','commands','--json']);
    expect(listed.code).toBe(0);
    const commands=JSON.parse(listed.stdout) as {command:string;auth:string;scope?:string}[];
    for(const action of fclHttpActions){
      const staff=commands.find(entry=>entry.command===`workspace fcl ${action}`);
      expect(staff,action).toMatchObject({auth:'person_session',scope:'fcl_personal'});
    }
    for(const action of ['session','submit','exchange','get','supplement','logout']){
      const inquiry=commands.find(entry=>entry.command===`workspace fcl inquiry ${action}`);
      expect(inquiry,action).toMatchObject({auth:'public_inquiry_session',scope:'public_inquiry_ticket'});
    }
    expect(commands.filter(entry=>entry.command.startsWith('workspace fcl ')&&!entry.command.startsWith('workspace fcl inquiry '))).toHaveLength(28);
    expect(commands.filter(entry=>entry.command.startsWith('workspace fcl inquiry '))).toHaveLength(6);
  });

  it('runs the staff FCL chain through the canonical HTTP actions and writes a verified PDF',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-staff-')),f=await createFclCliFixture();directories.push(root);
    try{
      const staff=join(root,'staff.json');await f.staffSessionFile(staff);
      const writeInput=async(name:string,value:unknown)=>{const path=join(root,name);await privateJson(path,value);return path;};
      const run=(args:string[])=>invoke(['workspace',...args,'--session-file',staff,'--endpoint',f.origin,'--json']);
      const caseList=await run(['fcl','case-list']);expect(caseList.code,caseList.stderr).toBe(0);
      const rates=await writeInput('rates.json',{expected_version:0,input:fclCliRates()});
      const rateSave=await run(['fcl','rate-save','--input',rates,'--idempotency-key','fcl-cli-rate-save-0001']);expect(rateSave.code,rateSave.stderr).toBe(0);
      const preview=await run(['fcl','rate-preview']);
      expect(preview.code).toBe(0);const previewBody=JSON.parse(preview.stdout) as {data:{preview_hash:string}};
      const publish=await writeInput('publish.json',{expected_version:1,preview_hash:previewBody.data.preview_hash,confirmation:'reviewed_sources_and_conditions'});
      const ratePublish=await run(['fcl','rate-publish','--input',publish,'--idempotency-key','fcl-cli-rate-publish-01']);expect(ratePublish.code,ratePublish.stderr).toBe(0);
      const config=await writeInput('config.json',{contract_version:'fcl-document-workflow@2026-09-20.v1',expected_version:0,input:{issuer_name:'Issuer',issuer_address:'Address',issuer_phone:'',issuer_email:'',terms:'Terms',standard_fee_template_v1:null},confirmed:true});
      const configSave=await run(['fcl','issuer-config-save','--input',config,'--idempotency-key','fcl-cli-config-save-001']);expect(configSave.code,configSave.stderr).toBe(0);
      const submission=await f.caseService.submitFclInquiry('fcl-cli-staff-submit-session','fcl-cli-staff-submit-key-01',fclCliInquiry());
      const confirm=await writeInput('confirm.json',{case_id:submission.case_id,expected_version:submission.case_version,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'Confirmed'});
      const confirmed=await run(['fcl','case-confirm','--input',confirm,'--idempotency-key','fcl-cli-case-confirm-01']);expect(confirmed.code,confirmed.stderr).toBe(0);const confirmedVersion=(JSON.parse(confirmed.stdout) as {data:{case_version:number}}).data.case_version;
      const matchInput=await writeInput('match.json',{contract_version:'fcl-quote-workflow@2026-09-20.v1',case_ref:submission.case_id,expected_case_version:confirmedVersion,expected_customer_supplement_ref:null,selected_rate_id:fclCliRates().rates[0]!.rate_id});
      const match=await run(['fcl','quote-match','--input',matchInput]);expect(match.code,match.stderr).toBe(0);const matchData=(JSON.parse(match.stdout) as {data:{selected:{rate_id:string}}}).data;
      const rateGet=await run(['fcl','rate-get']);expect(rateGet.code).toBe(0);const active=(JSON.parse(rateGet.stdout) as {data:{active_release:{release_id:string;version:number;digest:string}}}).data.active_release;
      const quoteInput=await writeInput('quote.json',{contract_version:'fcl-document-workflow@2026-09-20.v1',operation:'create',case_ref:submission.case_id,expected_case_version:confirmedVersion,expected_customer_supplement_ref:null,selected_rate_id:matchData.selected.rate_id,expected_release_id:active.release_id,expected_release_version:active.version,expected_dataset_digest:active.digest,input:{source_sell_prices:[{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:null}],manual_fees:[],service_scopes:[],exchange_rates:{USD:'7.2',CAD:null},remark:null}});
      const quote=await run(['fcl','quote-save','--input',quoteInput,'--idempotency-key','fcl-cli-quote-save-0001']);expect(quote.code).toBe(0);const quoteData=(JSON.parse(quote.stdout) as {data:{quote_ref:string;version:number;content_digest:string}}).data;
      const documentInput=await writeInput('document.json',{contract_version:'fcl-document-workflow@2026-09-20.v1',operation:'create',quote_ref:quoteData.quote_ref,expected_quote_version:quoteData.version,expected_quote_digest:quoteData.content_digest,expected_case_version:confirmedVersion,expected_customer_supplement_ref:null,expected_config_version:1,quote_no:'FCL-CLI-001',quote_date:'2026-10-08',valid_until:'2026-10-15',remark:null});
      const document=await run(['fcl','document-save','--input',documentInput,'--idempotency-key','fcl-cli-document-save-01']);expect(document.code).toBe(0);const documentData=(JSON.parse(document.stdout) as {data:{document_id:string;version:number}}).data;
      const reviewInput=await writeInput('review.json',{contract_version:'fcl-document-workflow@2026-09-20.v1',document_id:documentData.document_id,expected_version:documentData.version});
      const review=await run(['fcl','document-review','--input',reviewInput]);expect(review.code).toBe(0);const reviewData=(JSON.parse(review.stdout) as {data:{review_hash:string}}).data;
      const approveInput=await writeInput('approve.json',{contract_version:'fcl-document-workflow@2026-09-20.v1',document_id:documentData.document_id,expected_version:documentData.version,review_hash:reviewData.review_hash,confirmed:true});
      const approved=await run(['fcl','document-approve','--input',approveInput,'--idempotency-key','fcl-cli-document-approve']);expect(approved.code).toBe(0);const approvedVersion=(JSON.parse(approved.stdout) as {data:{version:number}}).data.version;
      const exportInput=await writeInput('export.json',{contract_version:'fcl-document-workflow@2026-09-20.v1',mode:'formal',document_id:documentData.document_id,expected_version:approvedVersion});
      const pdf=join(root,'quote.pdf');const exported=await run(['fcl','document-export','--input',exportInput,'--file',pdf,'--idempotency-key','fcl-cli-document-export']);expect(exported.code).toBe(0);expect(exported.stdout).not.toContain('content_base64');expect((await readFile(pdf)).subarray(0,5).toString()).toBe('%PDF-');expect((await stat(pdf)).mode&0o777).toBe(0o600);const exportedData=(JSON.parse(exported.stdout) as {data:{sha256:string;file:string}}).data;
      const handoffInput=await writeInput('handoff.json',{contract_version:'fcl-handoff@2026-09-21.v1',case_ref:submission.case_id,expected_case_version:confirmedVersion,expected_customer_supplement_ref:null,quote_ref:quoteData.quote_ref,expected_quote_version:quoteData.version,expected_quote_digest:quoteData.content_digest,document_id:documentData.document_id,expected_document_version:approvedVersion,expected_pdf_sha256:exportedData.sha256,confirmed:true,note:'CLI handoff'});
      const handoff=await run(['fcl','handoff-save','--input',handoffInput,'--idempotency-key','fcl-cli-handoff-save-01']);expect(handoff.code).toBe(0);expect((JSON.parse(handoff.stdout) as {data:{status:string}}).data.status).toBe('handed_off');
      expect(exportedData.file).toBe(pdf);
    }finally{directories.push(f.root);await f.close();}
  },30_000);

  it('restores a web-issued ticket from a restricted inquiry_id and credential file without a prior staff session',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-recovery-')),f=await createFclCliFixture();directories.push(root);
    try{
      const submitted=await f.caseService.submitFclInquiry('fcl-cli-recovery-session','fcl-cli-recovery-key-01',fclCliInquiry());
      const recovery=join(root,'recovery.json'),sessionFile=join(root,'inquiry.json');await privateJson(recovery,{inquiry_id:submitted.inquiry_id,credential:submitted.credential});
      const exchange=await invoke(['workspace','fcl','inquiry','exchange','--inquiry-session-file',sessionFile,'--credential-file',recovery,'--endpoint',f.origin,'--idempotency-key','fcl-cli-recovery-exchange','--json']);
      expect(exchange.code).toBe(0);expect(exchange.stdout).not.toContain(submitted.credential);
      const stored=JSON.parse(await readFile(sessionFile,'utf8')) as {ticket:{inquiry_id:string;credential:string|null}};
      expect(stored.ticket).toMatchObject({inquiry_id:submitted.inquiry_id,credential:null});
      const got=await invoke(['workspace','fcl','inquiry','get','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);expect(got.code).toBe(0);expect((JSON.parse(got.stdout) as {data:{inquiry_id:string}}).data.inquiry_id).toBe(submitted.inquiry_id);
    }finally{directories.push(f.root);await f.close();}
  });

  it('fails closed on existing invalid or symlinked session files and bounds concurrent public mutations with a private lock',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-lock-')),f=await createFclCliFixture();directories.push(root);
    try{
      const target=join(root,'target.json'),link=join(root,'link.json');await privateJson(target,{not:'a session'});await symlink(target,link);
      const symlinked=await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',link,'--endpoint',f.origin,'--json']);
      expect(symlinked.code).toBe(2);expect(symlinked.stderr).toContain('inquiry_session_file_invalid');
      const invalid=join(root,'invalid.json');await privateJson(invalid,{version:1,unexpected:true});
      const invalidResult=await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',invalid,'--endpoint',f.origin,'--json']);
      expect(invalidResult.code).toBe(2);expect(invalidResult.stderr).toContain('inquiry_session_file_invalid');
      expect(JSON.parse(await readFile(invalid,'utf8'))).toEqual({version:1,unexpected:true});

      const sessionFile=join(root,'concurrent.json'),inquiryFile=join(root,'inquiry.json');await privateJson(inquiryFile,fclCliInquiry());
      await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);
      let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
      const delayedFetch=(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{await gate;return fetch(input,init);}) as typeof fetch;
      const first=invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-concurrent-submit-1','--json'],{fetch:delayedFetch});
      await new Promise(resolve=>setTimeout(resolve,25));
      const second=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-concurrent-submit-1','--json']);
      release();
      expect(second.code).toBe(2);expect(second.stderr).toContain('inquiry_session_locked');
      expect((await first).code).toBe(0);
      await expect(lstat(join(root,`.${'concurrent.json'}.lock`))).rejects.toThrow();
    }finally{directories.push(f.root);await f.close();}
  });

  it('uses a bounded longer wait only for the renderer-backed PDF export',async()=>{
    const {fclActionTimeoutMs}=await import('../../deploy/cli/fcl-workspace');
    expect(fclActionTimeoutMs('document-export')).toBe(120_000);
    expect(fclActionTimeoutMs('rate-save')).toBe(15_000);
  });

  it('keeps public inquiry identity, pending keys and ticket recovery in one private file across retries',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-public-')),f=await createFclCliFixture();directories.push(root);
    try{
      const inquiryFile=join(root,'inquiry.json'),sessionFile=join(root,'inquiry-session.json'),inquiry=fclCliInquiry();await privateJson(inquiryFile,inquiry);
      const session=await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);
      expect(session.code).toBe(0);expect(JSON.parse(session.stdout)).toMatchObject({data:{auth:'public_inquiry_session'}});expect((await stat(sessionFile)).mode&0o777).toBe(0o600);
      const sessionIdentity=(JSON.parse(await readFile(sessionFile,'utf8')) as {session_id:string}).session_id;
      const refreshed=await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);expect(refreshed.code,refreshed.stderr).toBe(0);expect((JSON.parse(await readFile(sessionFile,'utf8')) as {session_id:string}).session_id).toBe(sessionIdentity);
      const failed=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-public-submit-01','--json'],{fetch:()=>Promise.reject(new Error('synthetic unknown result'))});
      expect(failed.code).toBe(1);const pending=JSON.parse(await readFile(sessionFile,'utf8')) as {pending:{key:string}};expect(pending.pending.key).toBe('fcl-cli-public-submit-01');
      const submitted=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-public-submit-01','--json']);
      expect(submitted.code).toBe(0);const submitBody=JSON.parse(submitted.stdout) as {data:{inquiry_id:string;case_id:string;credential?:string}};const storedAfterSubmit=JSON.parse(await readFile(sessionFile,'utf8')) as {ticket:{credential:string}};expect(submitBody.data).not.toHaveProperty('credential');expect(submitted.stdout).not.toContain(storedAfterSubmit.ticket.credential);
      let replayCalls=0;const replay=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-public-submit-01','--json'],{fetch:async(...args:Parameters<typeof fetch>)=>{replayCalls++;return await fetch(...args);}});expect(replay.code).toBe(0);expect(JSON.parse(replay.stdout)).toMatchObject({data:{inquiry_id:submitBody.data.inquiry_id,replay:true}});expect(replayCalls).toBe(1);
      expect(f.caseService.listFclCases(f.receiver,{limit:10,status:null,cursor:null}).items).toHaveLength(1);
      const exchanged=await invoke(['workspace','fcl','inquiry','exchange','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--idempotency-key','fcl-cli-public-exchange-1','--json']);expect(exchanged.code).toBe(0);expect(exchanged.stdout).not.toContain(storedAfterSubmit.ticket.credential);
      const exchangedReplay=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-public-submit-01','--json']);expect(exchangedReplay.code,exchangedReplay.stderr).toBe(0);expect((JSON.parse(exchangedReplay.stdout) as {data:{inquiry_id:string}}).data.inquiry_id).toBe(submitBody.data.inquiry_id);
      const got=await invoke(['workspace','fcl','inquiry','get','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);expect(got.code).toBe(0);expect((JSON.parse(got.stdout) as {data:{inquiry_id:string}}).data.inquiry_id).toBe(submitBody.data.inquiry_id);
      const version=(JSON.parse(got.stdout) as {data:{case_version:number}}).data.case_version;
      f.caseService.updateFclCaseStatus(f.receiver,submitBody.data.case_id,{expected_version:version,status:'needs_input',public_note:'Need input',internal_note:''},'fcl-cli-public-case-status-01');
      const supplementInput=await (async()=>{const path=join(root,'supplement.json');await privateJson(path,{inquiry_id:submitBody.data.inquiry_id,expected_version:version+1,fields:{changes:[]},message:'CLI supplement'});return path;})();
      const supplemented=await invoke(['workspace','fcl','inquiry','supplement','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',supplementInput,'--idempotency-key','fcl-cli-public-supplement-1','--json']);expect(supplemented.code,supplemented.stderr).toBe(0);
      const cross=await invoke(['workspace','fcl','inquiry','supplement','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',await (async()=>{const path=join(root,'cross.json');await privateJson(path,{...JSON.parse(await readFile(supplementInput,'utf8')) as object,inquiry_id:'00000000-0000-4000-8000-000000000999'});return path;})(),'--idempotency-key','fcl-cli-public-supplement-2','--json']);expect(cross.code).toBe(2);expect(cross.stderr).toContain('inquiry_ticket_mismatch');
      const loggedOut=await invoke(['workspace','fcl','inquiry','logout','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--idempotency-key','fcl-cli-public-logout-01','--json']);expect(loggedOut.code).toBe(0);
      const afterLogout=await invoke(['workspace','fcl','inquiry','get','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);expect(afterLogout.code).toBe(5);expect(afterLogout.stderr).toContain('inquiry_session_logged_out');
    }finally{directories.push(f.root);await f.close();}
  },30_000);

  it('retries an uncertain external exchange from the persisted pending body after restart',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-pending-exchange-')),f=await createFclCliFixture();directories.push(root);
    try{
      const submitted=await f.caseService.submitFclInquiry('fcl-cli-pending-exchange-session','fcl-cli-pending-exchange-key',fclCliInquiry());
      const recovery=join(root,'recovery.json'),sessionFile=join(root,'inquiry.json');await privateJson(recovery,{inquiry_id:submitted.inquiry_id,credential:submitted.credential});
      await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);
      const lost=await invoke(['workspace','fcl','inquiry','exchange','--inquiry-session-file',sessionFile,'--credential-file',recovery,'--endpoint',f.origin,'--idempotency-key','fcl-cli-pending-exchange-1','--json'],{fetch:()=>Promise.reject(new Error('synthetic lost exchange response'))});
      expect(lost.code).toBe(1);const stored=JSON.parse(await readFile(sessionFile,'utf8')) as {ticket:null;pending:{action:string;body:{inquiry_id:string;credential:string}}};expect(stored.ticket).toBeNull();expect(stored.pending).toMatchObject({action:'exchange',body:{inquiry_id:submitted.inquiry_id,credential:submitted.credential}});
      const retried=await invoke(['workspace','fcl','inquiry','exchange','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--idempotency-key','fcl-cli-pending-exchange-1','--json']);expect(retried.code,retried.stderr).toBe(0);
      const got=await invoke(['workspace','fcl','inquiry','get','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);expect(got.code).toBe(0);expect((JSON.parse(got.stdout) as {data:{inquiry_id:string}}).data.inquiry_id).toBe(submitted.inquiry_id);
    }finally{directories.push(f.root);await f.close();}
  });

  it('keeps a committed submit recoverable when final session persistence fails and rejects expired files without bootstrap',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-persist-failure-')),f=await createFclCliFixture();directories.push(root);
    try{
      const sessionFile=join(root,'inquiry.json'),inquiryFile=join(root,'inquiry-input.json'),backup=join(root,'inquiry.backup.json');await privateJson(inquiryFile,fclCliInquiry());
      await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json']);
      const trap=async(...args:Parameters<typeof fetch>)=>{const response=await fetch(...args);await rename(sessionFile,backup);await mkdir(sessionFile);return response;};
      const failed=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-persist-failure-1','--json'],{fetch:trap});
      expect(failed.code).toBe(2);expect(failed.stderr).toMatch(/inquiry_session_(?:persist_failed|file_permissions)/u);expect(JSON.parse(await readFile(backup,'utf8')) as {pending:{key:string}}).toMatchObject({pending:{key:'fcl-cli-persist-failure-1'}});
      await rm(sessionFile,{recursive:true,force:true});await rename(backup,sessionFile);
      const recovered=await invoke(['workspace','fcl','inquiry','submit','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--input',inquiryFile,'--idempotency-key','fcl-cli-persist-failure-1','--json']);expect(recovered.code,recovered.stderr).toBe(0);
      expect(f.caseService.listFclCases(f.receiver,{limit:10,status:null,cursor:null}).items).toHaveLength(1);
      const expired=JSON.parse(await readFile(sessionFile,'utf8')) as {expires_at:number};expired.expires_at=Date.now()-1;await privateJson(sessionFile,expired);
      let calls=0;const refused=await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',sessionFile,'--endpoint',f.origin,'--json'],{fetch:async(...args:Parameters<typeof fetch>)=>{calls++;return await fetch(...args);}});expect(refused.code).toBe(5);expect(refused.stderr).toContain('inquiry_session_expired');expect(calls).toBe(0);
    }finally{directories.push(f.root);await f.close();}
  });

  it('validates PDF bytes, hashes, history flags and never overwrites an existing local file',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-pdf-')),session=join(root,'staff.json'),input=join(root,'export.json'),output=join(root,'quote.pdf');
    const pdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(120)),sha256=(await import('node:crypto')).createHash('sha256').update(pdf).digest('hex');
    await privateJson(session,{origin:'http://127.0.0.1:8908',session_token:'a'.repeat(43),csrf_token:'b'.repeat(43),expires_at:Date.now()+60_000});
    const request={contract_version:'fcl-document-workflow@2026-09-20.v1',mode:'formal',document_id:'00000000-0000-4000-8000-000000000101',expected_version:1};
    await privateJson(input,request);
    const envelope={schema_version:FCL_HTTP_VERSION,status:'success',data:{contract_version:'fcl-document-workflow@2026-09-20.v1',document_id:request.document_id,version:1,revision_id:'00000000-0000-4000-8000-000000000102',current_version:1,mode:'formal',historical:false,valid_now:true,filename:'fcl-00000000-0000-4000-8000-000000000101-v1.pdf',sha256,byte_length:pdf.byteLength,content_base64:pdf.toString('base64'),customer_totals:{by_currency:{USD:'7000',CAD:'180',CNY:'0'}},trace_refs:['synthetic:trace'],replay:{replayed:false,submitted_version:null,current:true}},reason_codes:[]};
    const run=(body:unknown,file=output)=>invoke(['workspace','fcl','document-export','--session-file',session,'--endpoint','http://127.0.0.1:8908','--input',input,'--file',file,'--idempotency-key','fcl-cli-pdf-export-01','--json'],{fetch:()=>Promise.resolve(Response.json(body))});
    const exported=await run(envelope);expect(exported.code,exported.stderr).toBe(0);expect(exported.stdout).not.toContain('content_base64');expect(exported.stdout).not.toContain(pdf.toString('base64'));expect((await readFile(output)).equals(pdf)).toBe(true);
    const existing=await run(structuredClone(envelope),output);expect(existing.code).toBe(2);expect(existing.stderr).toContain('pdf_file_exists');expect((await readFile(output)).equals(pdf)).toBe(true);
    const tampered=structuredClone(envelope);tampered.data.sha256='0'.repeat(64);const tamperedFile=join(root,'tampered.pdf');const rejected=await run(tampered,tamperedFile);expect(rejected.code).toBe(1);expect(rejected.stderr).toContain('pdf_integrity_failed');await expect(lstat(tamperedFile)).rejects.toThrow();
    const historical=structuredClone(envelope);historical.data.mode='history';historical.data.historical=true;historical.data.valid_now=true;const historyFile=join(root,'history.pdf');const history=await run(historical,historyFile);expect(history.code).toBe(1);expect(history.stderr).toContain('pdf_history_metadata_invalid');await expect(lstat(historyFile)).rejects.toThrow();
  });

  it('preserves four non-success business statuses and their process exit semantics from valid HTTP envelopes',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-status-')),session=join(root,'staff.json'),input=join(root,'get.json');
    await privateJson(session,{origin:'http://127.0.0.1:8908',session_token:'a'.repeat(43),csrf_token:'b'.repeat(43),expires_at:Date.now()+60_000});
    await privateJson(input,{contract_version:'fcl-document-workflow@2026-09-20.v1',document_id:'00000000-0000-4000-8000-000000000101',version:1});
    for(const [status,exit] of [['needs_input',3],['manual_review',4],['blocked',5],['unavailable',6]] as const){
      const http=status==='blocked'?403:status==='unavailable'?503:200,body={schema_version:FCL_HTTP_VERSION,status,data:null,reason_codes:[`synthetic_${status}`]};
      const result=await invoke(['workspace','fcl','document-get','--session-file',session,'--endpoint','http://127.0.0.1:8908','--input',input,'--json'],{fetch:()=>Promise.resolve(Response.json(body,{status:http}))});
      expect(result.code,result.stderr).toBe(exit);expect(JSON.parse(result.stdout)).toEqual(body);
    }
  });

  it('rejects cross-session files, extra fields, duplicate options and missing explicit keys before dispatch',async()=>{
    const root=await mkdtemp(join(tmpdir(),'fcl-cli-reject-')),f=await createFclCliFixture();directories.push(root);
    try{
      const staff=join(root,'staff.json'),publicFile=join(root,'public.json');await f.staffSessionFile(staff);
      await invoke(['workspace','fcl','inquiry','session','--inquiry-session-file',publicFile,'--endpoint',f.origin,'--json']);
      expect((await invoke(['workspace','fcl','case-list','--session-file',publicFile,'--endpoint',f.origin,'--json'])).code).toBe(2);
      expect((await invoke(['workspace','fcl','inquiry','get','--inquiry-session-file',staff,'--endpoint',f.origin,'--json'])).code).toBe(2);
      expect((await invoke(['workspace','fcl','rate-save','--session-file',staff,'--endpoint',f.origin,'--input','-','--idempotency-key','fcl-cli-rate-save-0001','--json'],{stdin:JSON.stringify({expected_version:0,input:fclCliRates(),extra:true})})).code).toBe(2);
      expect((await invoke(['workspace','fcl','case-list','--session-file',staff,'--endpoint',f.origin,'--file','unused','--json'])).code).toBe(2);
      expect((await invoke(['workspace','fcl','case-list','--session-file',staff,'--session-file',staff,'--endpoint',f.origin,'--json'])).code).toBe(2);
      expect((await invoke(['workspace','fcl','case-list','--session-file',staff,'--endpoint',f.origin,'--api-key','synthetic','--json'])).code).toBe(2);
      const noKey=await invoke(['workspace','fcl','notification-save','--session-file',staff,'--endpoint',f.origin,'--input','-','--json'],{stdin:JSON.stringify({contract_version:'fcl-notification@2026-09-21.v1',expected_version:0,input:{enabled:false,recipient:null,cc:[]},confirmed:true})});
      expect(noKey.code).toBe(2);expect(noKey.stderr).toContain('idempotency_key_required');
    }finally{directories.push(f.root);await f.close();}
  });
});
