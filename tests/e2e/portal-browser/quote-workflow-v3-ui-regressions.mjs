import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
const moduleSource=readFileSync(resolve('apps/console/quote-documents.js'),'utf8').replace('export function createQuoteDocuments','function createQuoteDocuments');

const config={
  version:1,
  input:{company_name:'Synthetic',company_address:'',company_phone:'',company_email:'',terms:'Synthetic terms.',fee_items:[]},
  standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]},
  catalog:{schema_version:'quote-fee-template@2026-09-15.v1',template_id:'freightclaw-standard-v1',template_version:1,source:'platform',groups:[]},
};

function manualView(id='approved-doc',state='approved'){
  return {
    id,
    revision_id:`revision-${id}`,
    version:3,
    state,
    document_kind:'manual',
    organization_id:'org',
    owner_id:'user',
    quote_no:'Q-1',
    customer_name:'Synthetic',
    created_at:'2026-09-15T00:00:00.000Z',
    updated_at:'2026-09-15T00:05:00.000Z',
    complete:true,
    claim_state:'claimed_v3',
    input:{
      schema_version:'quote-document-draft@2026-09-15.v1',quote_no:'Q-1',customer_name:'Synthetic',quote_date:'2026-09-15',valid_until:'2099-12-31',origin:null,destination:null,route_name:null,job_no:null,so_no:null,container_no:null,remark:null,exchange_rates:{USD:null,CAD:null},
      fee_items:[{id:'fee-1',source_kind:'template',template_ref:{template_id:'freightclaw-standard-v1',template_version:1,item_key:'origin_pickup'},name:'Origin pickup',description:null,group:'A',quantity:'1',unit:'shipment',unit_price:'10',currency:'USD',display:'detail',merge_name:null,note:null}],
    },
    template:config.input,
    template_version:1,
    native_quote_v1:null,
    inquiry_case_link_v1:null,
    approval:{},
    approval_provenance:null,
    rejection:null,
  };
}

function nativeView(id='native-doc'){
  const view=manualView(id,'draft');
  view.document_kind='native_unlinked';
  view.native_quote_v1={
    schema_version:'native-quote-binding@2026-09-15.v1',
    request:{request:'native'},
    preview:{total_price:'10.00'},
    source_refs:[{system:'freightclaw-native-quote',source_id:'release-1',content_hash:'sha256:'+'a'.repeat(64)}],
    source_refs_digest:'b'.repeat(64),
    release_id:'release-1',
    release_digest:'a'.repeat(64),
    request_hash:'c'.repeat(64),
    document_fee_digest:'d'.repeat(64),
    document_fee_digest_format:'canonical-json-sha256-v1',
    binding_hash:'e'.repeat(64),
    provenance:'v3_server_signed',
  };
  view.input.fee_items=[{id:'native-fee',source_kind:'native',template_ref:null,name:'Freight',description:null,group:'B',quantity:'1',unit:'shipment',unit_price:'10',currency:'USD',display:'detail',merge_name:null,note:null}];
  return view;
}

async function installPage(options){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.setContent('<div id="app"></div>');
  await page.addScriptTag({type:'module',content:`${moduleSource}\nwindow.__createQuoteDocumentsForTest=createQuoteDocuments;`});
  await page.waitForFunction(()=>typeof window.__createQuoteDocumentsForTest==='function');
  await page.evaluate(async input=>{
    if(typeof crypto.randomUUID!=='function'){let sequence=0;Object.defineProperty(crypto,'randomUUID',{value:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`});}
    const escapeText=value=>String(value??'').replace(/[&<>"']/gu,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
    const requests=[];let modelState={sessionGeneration:1,session:{organization_id:'org',identity:{user_id:'user'}}};let controller;
    const saveResponses=[...input.saveResponses];
    const api=async(path,requestOptions={})=>{
      requests.push({kind:'api',path,body:requestOptions.body??null});
      const clean=path.split('?')[0];
      if(clean.endsWith('/config'))return {status:'success',data:input.config};
      if(clean.endsWith('/list'))return {status:'success',data:{items:input.listItems??[],next_cursor:null}};
      if(clean.endsWith('/get'))return {status:'success',data:input.getDocs[requestOptions.body?.id]};
      if(clean.endsWith('/native-prepare'))return {status:'success',data:input.nativePrepared};
      if(clean.endsWith('/review'))return input.reviewResponse;
      return {status:'success',data:null};
    };
    const mutate=async(path,_method,body)=>{
      requests.push({kind:'mutate',path,body});
      const response=saveResponses.shift();
      if(!response)throw new Error('missing_save_response');
      return response;
    };
    const rerender=()=>{document.querySelector('#app').innerHTML=controller.page();};
    controller=window.__createQuoteDocumentsForTest({api,mutate,model:()=>modelState,esc:escapeText,head:(title,subtitle)=>`<h1>${escapeText(title)}</h1><p>${escapeText(subtitle)}</p>`,icon:()=>'',rerender,canConfigure:()=>true});
    window.confirm=()=>true;
    window.__h={
      controller,
      requests,
      setOrganization:organization=>{modelState={sessionGeneration:modelState.sessionGeneration+1,session:{organization_id:organization,identity:{user_id:'user'}}};},
      button:(action,id='')=>{const button=document.createElement('button');button.dataset.action=`qdoc-${action}`;button.dataset.id=id;return button;},
      render:()=>{document.querySelector('#app').innerHTML=controller.page();},
    };
    window.__h.render();
    await new Promise(resolve=>setTimeout(resolve,20));
  },options);
  return page;
}

try{
  {
    const page=await installPage({
      config,
      getDocs:{},
      nativePrepared:{document_kind:'native_unlinked',input:{...manualView().input,origin:'CA TOR',destination:'Vancouver BC V5K 0A1',quote_no:'NATIVE-NEW',fee_items:[{...manualView().input.fee_items[0],id:'prepared-fee',source_kind:'native',template_ref:null}]},native_quote_v1:nativeView().native_quote_v1,preview_hash:'f'.repeat(64),preview_expires_at:Date.now()+600000},
      reviewResponse:{status:'success',data:{document_id:'native-new',review_hash:'1'.repeat(64),reviewed_version:1,totals:{by_currency:{USD:'0.00',CAD:'0.00',CNY:'0.00'},total_cny:'0.00',total_usd:'0.00',partial:false},can_approve:true}},
      saveResponses:[{status:'success',data:{...manualView('native-new','draft'),document_kind:'native_unlinked',input:{...manualView().input,origin:'CA TOR',destination:'Vancouver BC V5K 0A1',quote_no:'NATIVE-NEW'},native_quote_v1:nativeView().native_quote_v1}}],
    });
    const result=await page.evaluate(async()=>{
      const quote={data:{origin:'CA TOR',city:'Vancouver',province:'BC',postal_code:'V5K 0A1',match_trace:{valid_until:'2099-12-31'}}};
      window.__h.controller.fromQuote(quote,{request:'native'},null);
      window.__h.controller.fromQuote(quote,{request:'native'},null);
      window.__h.render();
      const origin=document.querySelector('[name="origin"]')?.value,destination=document.querySelector('[name="destination"]')?.value,dirty=window.__h.controller.isDirty();
      await window.__h.controller.action(window.__h.button('review'));
      const nativePrepare=window.__h.requests.findIndex(request=>request.path.endsWith('/native-prepare'));
      const save=window.__h.requests.find(request=>request.kind==='mutate'&&request.path.endsWith('/save'));
      return {origin,destination,dirty,nativePrepare,save};
    });
    assert.equal(result.origin,'CA TOR');
    assert.equal(result.destination,'Vancouver BC V5K 0A1');
    assert.equal(result.dirty,true);
    assert.notEqual(result.nativePrepare,-1);
    assert.equal(result.save?.body?.document_kind,'native_unlinked');
    await page.close();
  }

  {
    const native=nativeView();
    const page=await installPage({config,getDocs:{[native.id]:native},nativePrepared:null,reviewResponse:{status:'success',data:{document_id:native.id,review_hash:'2'.repeat(64),reviewed_version:native.version,totals:{by_currency:{USD:'0.00',CAD:'0.00',CNY:'0.00'},total_cny:'0.00',total_usd:'0.00',partial:false},can_approve:true}},saveResponses:[]});
    const requests=await page.evaluate(async()=>{
      await window.__h.controller.action(window.__h.button('open','native-doc'));
      await window.__h.controller.action(window.__h.button('review'));
      return window.__h.requests;
    }).catch(error=>{throw error;});
    assert.equal(requests.some(request=>request.path.endsWith('/native-prepare')),false);
    assert.equal(requests.some(request=>request.kind==='mutate'),false);
    await page.close();
  }

  {
    const native=nativeView();
    const prepared={document_kind:'native_unlinked',input:{...native.input,quote_no:'CHANGED',fee_items:[{...native.input.fee_items[0],id:'replacement-fee'}]},native_quote_v1:{...native.native_quote_v1,binding_hash:'9'.repeat(64)},preview_hash:'8'.repeat(64),preview_expires_at:Date.now()+600000};
    const page=await installPage({
      config,
      getDocs:{[native.id]:native},
      nativePrepared:prepared,
      reviewResponse:{status:'success',data:{document_id:native.id,review_hash:'3'.repeat(64),reviewed_version:2,totals:{by_currency:{USD:'0.00',CAD:'0.00',CNY:'0.00'},total_cny:'0.00',total_usd:'0.00',partial:false},can_approve:true}},
      saveResponses:[{status:'blocked',reason_codes:['native_quote_rebind_required']},{status:'success',data:{...native,version:2,input:prepared.input,native_quote_v1:prepared.native_quote_v1}}],
    });
    const result=await page.evaluate(async()=>{
      await window.__h.controller.action(window.__h.button('open','native-doc'));
      const quoteNo=document.querySelector('[name="quote_no"]');quoteNo.value='CHANGED';window.__h.controller.input({target:quoteNo});
      await window.__h.controller.action(window.__h.button('review'));
      const saves=window.__h.requests.filter(request=>request.kind==='mutate'&&request.path.endsWith('/save'));
      return {saves,prepare:window.__h.requests.some(request=>request.path.endsWith('/native-prepare'))};
    });
    assert.equal(result.prepare,true);
    assert.equal(result.saves.length,2);
    assert.equal(result.saves[1].body.id,native.id);
    assert.equal(result.saves[1].body.binding_update.mode,'replace');
    assert.equal(result.saves[1].body.binding_update.native_quote_v1.binding_hash,'9'.repeat(64));
    await page.close();
  }

  {
    const source=manualView();
    const page=await installPage({config,getDocs:{[source.id]:source},nativePrepared:null,reviewResponse:{status:'success',data:{}},saveResponses:[{status:'success',data:{...source,id:'copied-doc',state:'draft',quote_no:null}}]});
    const result=await page.evaluate(async()=>{
      await window.__h.controller.action(window.__h.button('open','approved-doc'));
      const copy=document.querySelector('[data-action="qdoc-copy"]');
      const dataId=copy.dataset.id,getCount=window.__h.requests.filter(request=>request.path.endsWith('/get')).length;
      const emptyCopy=window.__h.button('copy');await window.__h.controller.action(emptyCopy);
      await window.__h.controller.action(window.__h.button('save'));
      const save=window.__h.requests.find(request=>request.kind==='mutate'&&request.path.endsWith('/save'));
      return {dataId,getCount,save};
    });
    assert.equal(result.dataId,source.id);
    assert.equal(result.getCount,1);
    assert.equal(result.save.body.input.fee_items[0].source_kind,'template');
    assert.notEqual(result.save.body.input.fee_items[0].template_ref,null);
    await page.close();
  }

  {
    const source=manualView('native-copy-source','approved');
    source.document_kind='native_unlinked';
    source.native_quote_v1=nativeView('native-copy-source').native_quote_v1;
    source.input.fee_items=[{...nativeView('native-copy-source').input.fee_items[0],id:'native-copy-fee'}];
    const prepared={document_kind:'native_unlinked',input:{...source.input,quote_no:'NATIVE-COPY'},native_quote_v1:{...source.native_quote_v1,binding_hash:'7'.repeat(64)},preview_hash:'6'.repeat(64),preview_expires_at:Date.now()+600000};
    const page=await installPage({
      config,
      getDocs:{[source.id]:source},
      listItems:[{id:source.id,quote_no:source.quote_no,customer_name:source.customer_name,updated_at:source.updated_at,state:source.state,version:source.version,inquiry_case_link_v1:null}],
      nativePrepared:prepared,
      reviewResponse:{status:'success',data:{document_id:'native-copy',review_hash:'5'.repeat(64),reviewed_version:1,totals:{by_currency:{USD:'0.00',CAD:'0.00',CNY:'0.00'},total_cny:'0.00',total_usd:'0.00',partial:false},can_approve:true}},
      saveResponses:[{status:'success',data:{...manualView('native-copy','draft'),document_kind:'native_unlinked',input:prepared.input,native_quote_v1:prepared.native_quote_v1}}],
    });
    const result=await page.evaluate(async()=>{
      await window.__h.controller.action(window.__h.button('records'));
      const copy=document.querySelector(`[data-action="qdoc-copy"][data-id="native-copy-source"]`);
      await window.__h.controller.action(copy);
      await window.__h.controller.action(window.__h.button('review'));
      const prepareIndex=window.__h.requests.findIndex(request=>request.path.endsWith('/native-prepare'));
      const saveIndex=window.__h.requests.findIndex(request=>request.kind==='mutate'&&request.path.endsWith('/save'));
      return {copyId:copy.dataset.id,prepareIndex,saveIndex,save:window.__h.requests[saveIndex]};
    });
    assert.equal(result.copyId,source.id);
    assert.notEqual(result.prepareIndex,-1);
    assert.ok(result.prepareIndex<result.saveIndex);
    assert.equal(result.save.body.document_kind,'native_unlinked');
    await page.close();
  }

  console.log(JSON.stringify({checks:['fromQuote_same_org_state','new_native_prepares_before_save','existing_native_review_does_not_reprepare','native_rebind_uses_replace','editor_copy_uses_current_id','template_copy_preserves_ref','list_copy_native_prepares_before_save']}));
}finally{
  await browser.close();
}
