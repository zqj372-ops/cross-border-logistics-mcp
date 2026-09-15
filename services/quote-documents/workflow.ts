import Decimal from 'decimal.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {PortalError,type PortalContext} from '../access-gateway/portal/contracts';
import type {PortalService} from '../access-gateway/portal/service';
import type {DocumentService,DocumentStore} from './service';
import {renderHtml} from './engine';
import {renderPdf} from './renderer';
import {
  DRAFT_VERSION,
  FEE_TEMPLATE_VERSION,
  configSaveWorkflowSchema,
  draftDocumentSchema,
  exportWorkflowSchema,
  getWorkflowSchema,
  listWorkflowSchema,
  nativePrepareWorkflowSchema,
  previewWorkflowSchema,
  rejectWorkflowSchema,
  reviewWorkflowSchema,
  saveWorkflowSchema,
  approveWorkflowSchema,
  type DraftDocument,
  type DraftFee,
  type NativeBindingV3,
  type WorkflowDocumentView,
} from './workflow-contracts';
import type {z} from 'zod';
import {INQUIRY_QUOTE_LINK_VERSION} from './contracts';

const parse=<T>(schema:z.ZodType<T>,input:unknown,code='document_input_invalid'):T=>{
  const parsed=schema.safeParse(input);
  if(parsed.success!==true)throw new PortalError(code);
  return parsed.data;
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sortValue=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(sortValue);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sortValue(item)]));
  return value;
};
const canonicalHash=(value:unknown)=>hash(sortValue(value));
const safeText=(value:unknown)=>typeof value==='string'?value:'';
const today=()=>new Date().toISOString().slice(0,10);

export const standardFeeTemplate={
  schema_version:FEE_TEMPLATE_VERSION,
  template_id:'freightclaw-standard-v1',
  template_version:1,
  source:'platform',
  groups:[
    {group:'A',label:'起运段',items:[
      {item_key:'origin_pickup',name:'起运提货',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'export_customs',name:'报关',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'origin_port_handling',name:'起运港操作',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'documentation',name:'文件',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
    ]},
    {group:'B',label:'干线运输',items:[
      {item_key:'ocean_freight',name:'海运费',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'insurance',name:'保险',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
    ]},
    {group:'C',label:'目的段',items:[
      {item_key:'destination_port_handling',name:'目的港操作',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'destination_customs_clearance',name:'清关服务',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'devanning_sorting',name:'拆柜/分拣',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'storage',name:'仓储',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'final_mile_delivery',name:'尾程派送',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'appointment',name:'预约',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'liftgate',name:'尾板',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
      {item_key:'waiting',name:'等待',description:null,unit_suggestion:null,quantity_suggestion:'1',display:'detail'},
    ]},
  ],
} as const;

export function nativeFeeDigest(fees:DraftFee[]):string{
  const rows=fees.map(fee=>({
    id:fee.id,
    source_kind:fee.source_kind,
    quantity:fee.quantity,
    unit:fee.unit,
    unit_price:fee.unit_price,
    currency:fee.currency,
    display:fee.display,
  }));
  return canonicalHash(rows);
}

const nativeBindingPayload=(binding:NativeBindingV3)=>{
  const {binding_hash:_bindingHash,...payload}=binding;
  void _bindingHash;
  return payload;
};

function encodeCursor(value:{updated_at:string;id:string;filter_digest:string}):string{
  return Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
}

function decodeCursor(value:string):{updated_at:string;id:string;filter_digest:string}{
  try{
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Record<string,unknown>;
    if(typeof parsed.updated_at!=='string'||typeof parsed.id!=='string'||typeof parsed.filter_digest!=='string')throw new Error('cursor_invalid');
    return {updated_at:parsed.updated_at,id:parsed.id,filter_digest:parsed.filter_digest};
  }catch{
    throw new PortalError('document_input_invalid');
  }
}

type Scope={org:string;user:string;manager:boolean};
type RevisionRow={
  revision_id:string;
  document_id:string;
  org:string;
  owner:string;
  version:number;
  state:'draft'|'approved'|'rejected';
  schema_version:number;
  payload:string;
  input_digest:string;
  template_digest:string;
  source_revision_id:string|null;
  review_hash:string|null;
  rejection_reason:string|null;
  created_by:string;
  created_at:string;
};
type CurrentRow={document_id:string;org:string;owner:string;revision_id:string;version:number;schema_version:number;updated_at:string};
type StoredPayload={
  id:string;
  org:string;
  revision_id:string|null;
  version:number;
  state:'draft'|'approved'|'rejected';
  document_kind:'manual'|'native_unlinked'|'linked';
  input:DraftDocument;
  template:Record<string,unknown>;
  template_version:number;
  native_quote_v1:NativeBindingV3|null;
  inquiry_case_link_v1:{case_ref:string;reviewed_customer_event_ref:string|null}|null;
  owner_id:string;
  created_at:string;
  updated_at:string;
  approval:Record<string,unknown>|null;
  approval_provenance:Record<string,unknown>|null;
  rejection:{reason:string;actor:string;at:string}|null;
};

function legacyInput(input:Record<string,unknown>):DraftDocument{
  const feeItems=Array.isArray(input.fee_items)?input.fee_items as Array<Record<string,unknown>>:[];
  return draftDocumentSchema.parse({
    schema_version:DRAFT_VERSION,
    quote_no:input.quote_no??null,
    customer_name:input.customer_name??null,
    quote_date:input.quote_date??null,
    valid_until:input.valid_until??null,
    origin:input.origin??null,
    destination:input.destination??null,
    route_name:input.route_name??null,
    job_no:input.job_no??null,
    so_no:input.so_no??null,
    container_no:input.container_no??null,
    remark:input.remark??null,
    exchange_rates:input.exchange_rates??{USD:null,CAD:null},
    fee_items:feeItems.map(fee=>({
      id:fee.id,
      source_kind:'manual',
      template_ref:null,
      name:fee.name??null,
      description:fee.description??null,
      group:fee.group??null,
      quantity:fee.quantity??null,
      unit:fee.unit??null,
      unit_price:fee.unit_price??null,
      currency:fee.currency??null,
      display:fee.display??null,
      merge_name:fee.merge_name??null,
      note:fee.note??null,
    })),
  });
}

export function completenessOf(input:DraftDocument){
  const missing:string[]=[];
  const required=(pointer:string,value:unknown)=>{
    if(value===null||value===undefined||value==='')missing.push(pointer);
  };
  required('/quote_no',input.quote_no);
  required('/customer_name',input.customer_name);
  required('/quote_date',input.quote_date);
  required('/valid_until',input.valid_until);
  if(input.quote_date!==null&&input.valid_until!==null&&input.valid_until<input.quote_date)missing.push('/valid_until');
  if(input.fee_items.length===0)missing.push('/fee_items');
  input.fee_items.forEach((fee,index)=>{
    const base=`/fee_items/${index}`;
    required(`${base}/name`,fee.name);
    required(`${base}/quantity`,fee.quantity);
    required(`${base}/unit`,fee.unit);
    required(`${base}/unit_price`,fee.unit_price);
    required(`${base}/currency`,fee.currency);
    required(`${base}/group`,fee.group);
    required(`${base}/display`,fee.display);
    if(fee.display==='merged'&&!fee.merge_name)missing.push(`${base}/merge_name`);
    if(fee.quantity!==null&&new Decimal(fee.quantity).lte(0))missing.push(`${base}/quantity`);
  });
  return {complete:missing.length===0,missing_fields:missing,blocking_reasons:[],can_review:missing.length===0,partial:missing.length>0};
}

function totalsOf(input:DraftDocument){
  const sums={USD:new Decimal(0),CAD:new Decimal(0),CNY:new Decimal(0)};
  const rows=input.fee_items.map(fee=>{
    const complete=fee.quantity!==null&&fee.unit_price!==null&&fee.currency!==null&&fee.display!=='hiddenExcluded';
    const amount=complete?new Decimal(fee.quantity!).mul(fee.unit_price!).toFixed(2):null;
    if(amount!==null&&fee.currency!==null)sums[fee.currency]=sums[fee.currency].add(amount);
    return {...fee,amount};
  });
  const partial=completenessOf(input).partial;
  const byCurrency={USD:sums.USD.toFixed(2),CAD:sums.CAD.toFixed(2),CNY:sums.CNY.toFixed(2)};
  const cnyParts=(['USD','CAD'] as const).map(currency=>{
    if(sums[currency].isZero())return new Decimal(0);
    const rate=input.exchange_rates[currency];
    return rate===null?null:sums[currency].mul(rate);
  });
  const totalCny=cnyParts.some(value=>value===null)?null:cnyParts.reduce<Decimal>((a,b)=>a.add(b!).add(sums.CNY),new Decimal(0)).toFixed(2);
  const totalUsd=sums.CAD.isZero()&&sums.CNY.isZero()?sums.USD.toFixed(2):input.exchange_rates.USD!==null&&totalCny!==null?new Decimal(totalCny).div(input.exchange_rates.USD).toFixed(2):null;
  return {partial,complete:!partial,rows,by_currency:byCurrency,total_cny:totalCny,total_usd:totalUsd,warnings:input.fee_items.some(fee=>fee.display==='hiddenIncluded')?['合计包含隐藏计入费用，请核对客户展示。']:[],calculation_version:'quote-documents-decimal-v1' as const};
}

function renderDocument(input:DraftDocument){
  return {
    quote_no:input.quote_no??'',
    customer_name:input.customer_name??'',
    quote_date:input.quote_date??'',
    valid_until:input.valid_until??'',
    origin:input.origin??'',
    destination:input.destination??'',
    route_name:input.route_name??'',
    job_no:input.job_no??'',
    so_no:input.so_no??'',
    container_no:input.container_no??'',
    remark:input.remark??'',
    exchange_rates:input.exchange_rates,
    fee_items:input.fee_items.map(fee=>({
      id:fee.id,
      name:fee.name??'',
      description:fee.description??'',
      group:fee.group??'A',
      quantity:fee.quantity??'0',
      unit:fee.unit??'',
      unit_price:fee.unit_price??'0',
      currency:fee.currency??'USD',
      display:fee.display??'detail',
      merge_name:fee.merge_name??'',
      note:fee.note??'',
    })),
  };
}

export class DocumentWorkflowStore{
  readonly db;
  readonly signingSecret:string;
  constructor(readonly store:DocumentStore){
    this.db=store.db;
    const db=this.db;
    db.exec('BEGIN EXCLUSIVE');
    try{
      const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      if(version>3)throw new Error('workflow_schema_incompatible');
      db.exec(`CREATE TABLE IF NOT EXISTS document_store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_revisions(revision_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,org TEXT NOT NULL,owner TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,schema_version INTEGER NOT NULL,payload TEXT NOT NULL,input_digest TEXT NOT NULL,template_digest TEXT NOT NULL,source_revision_id TEXT,review_hash TEXT,rejection_reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version));
CREATE TABLE IF NOT EXISTS document_current_revisions(document_id TEXT PRIMARY KEY,org TEXT NOT NULL,owner TEXT NOT NULL,revision_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,schema_version INTEGER NOT NULL,projection_digest TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_revision_events(audit_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_revisions_document ON document_revisions(document_id,version DESC);
CREATE INDEX IF NOT EXISTS document_current_org ON document_current_revisions(org,updated_at DESC);`);
      db.prepare('INSERT INTO document_store_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version','3');
      const existingSecret=db.prepare('SELECT value FROM document_store_metadata WHERE key=?').get('workflow_signing_secret') as {value:string}|undefined;
      this.signingSecret=existingSecret?.value??randomBytes(32).toString('hex');
      db.prepare('INSERT INTO document_store_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('workflow_signing_secret',this.signingSecret);
      db.exec('PRAGMA user_version=3; COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  close(){void this.store;}
  health(){try{this.store.db.prepare('SELECT revision_id FROM document_revisions LIMIT 1').get();return true;}catch{return false;}}
}

export class DocumentWorkflowService{
  private readonly secret;
  private readonly reviews=new Map<string,{id:string;version:number;revision_id:string|null;content_digest:string;expires:number}>();
  constructor(readonly store:DocumentWorkflowStore,private readonly legacy:DocumentService,private readonly portal:Pick<PortalService,'getState'>,private readonly renderer:(html:string)=>Promise<Buffer>=renderPdf){this.secret=store.signingSecret;}

  private scope(ctx:PortalContext,manage=false):Scope{
    if(!ctx.identity.emailVerified||!ctx.organizationId)throw new PortalError('document_organization_required');
    const state=this.portal.getState(ctx).data;
    const membership=state?.memberships.find(item=>item.userId===ctx.identity.userId&&item.organizationId===ctx.organizationId&&item.status==='active');
    if(!membership||state?.current_organization?.status!=='active')throw new PortalError('document_not_found');
    const manager=['owner','admin'].includes(membership.role);
    if(manage&&!manager)throw new PortalError('document_management_denied');
    return {org:ctx.organizationId,user:ctx.identity.userId,manager};
  }
  private contentDigest(payload:StoredPayload){return canonicalHash({input:payload.input,template:payload.template,native_quote_v1:payload.native_quote_v1,inquiry_case_link_v1:payload.inquiry_case_link_v1});}
  private expectedBindingHash(scope:Scope,documentKind:StoredPayload['document_kind'],caseRef:string|null,binding:NativeBindingV3){
    return hash([this.secret,scope.org,scope.user,documentKind,caseRef,nativeBindingPayload(binding)]);
  }
  private previewHash(scope:Scope,documentKind:StoredPayload['document_kind'],caseRef:string|null,bindingHash:string,expires:number){
    return hash([this.secret,scope.org,scope.user,'native_prepare',documentKind,caseRef,bindingHash,expires]);
  }
  private assertSignedPreview(scope:Scope,documentKind:StoredPayload['document_kind'],caseRef:string|null,bindingHash:string,previewHash:string,expires:number){
    if(expires<Date.now()||previewHash!==this.previewHash(scope,documentKind,caseRef,bindingHash,expires))throw new PortalError('document_preview_stale');
  }
  private assertSignedNative(scope:Scope,payload:Pick<StoredPayload,'document_kind'|'input'|'native_quote_v1'|'inquiry_case_link_v1'>){
    const binding=payload.native_quote_v1;
    if(!binding)throw new PortalError('native_quote_rebind_required');
    if(binding.provenance!=='v3_server_signed')throw new PortalError('native_quote_rebind_required');
    const caseRef=payload.inquiry_case_link_v1?.case_ref??null;
    if(caseRef!==null&&payload.document_kind!=='linked')throw new PortalError('inquiry_quote_link_forgery');
    if(binding.source_refs_digest!==canonicalHash(binding.source_refs)||binding.request_hash!==hash(binding.request)||binding.document_fee_digest!==nativeFeeDigest(payload.input.fee_items))throw new PortalError('inquiry_quote_link_forgery');
    if(binding.binding_hash!==this.expectedBindingHash(scope,payload.document_kind,caseRef,binding))throw new PortalError('inquiry_quote_link_forgery');
  }
  private assertNativeRows(input:DraftDocument){
    if(input.fee_items.some(fee=>fee.source_kind!=='native'))throw new PortalError('native_quote_rebind_required');
  }
  private assertManualRows(input:DraftDocument){
    if(input.fee_items.some(fee=>fee.source_kind==='native'))throw new PortalError('document_input_invalid');
  }
  private assertValidity(input:DraftDocument){
    if(input.quote_date===null||input.valid_until===null||input.quote_date>today()||today()>input.valid_until)throw new PortalError('document_expired');
  }
  private assertKind(documentKind:StoredPayload['document_kind'],current:StoredPayload,bindingUpdate?:Record<string,unknown>){
    if(current.document_kind!==documentKind)throw new PortalError('document_input_invalid');
    if(current.native_quote_v1&&!bindingUpdate)throw new PortalError('native_quote_rebind_required');
    if(!current.native_quote_v1&&current.document_kind!=='manual')throw new PortalError('document_service_unavailable');
    if(current.document_kind==='linked'&&current.inquiry_case_link_v1===null)throw new PortalError('inquiry_quote_link_forgery');
    if(current.document_kind!=='linked'&&current.inquiry_case_link_v1)throw new PortalError('inquiry_quote_link_forgery');
  }
  private assertApprovalPayload(payload:StoredPayload){
    const approval=payload.approval as {
      source_revision_id?:unknown;
      source_version?:unknown;
      source_content_digest?:unknown;
      approved_revision_id?:unknown;
      approved_version?:unknown;
    }|null;
    if(!approval)throw new PortalError('document_not_approved');
    if(payload.approval_provenance?.kind==='legacy_v1_v2')return;
    if(typeof approval.source_revision_id!=='string'||typeof approval.source_version!=='number'||typeof approval.source_content_digest!=='string'||approval.approved_revision_id!==payload.revision_id||approval.approved_version!==payload.version)throw new PortalError('document_review_stale');
    const row=this.store.store.db.prepare('SELECT payload FROM document_revisions WHERE revision_id=? AND document_id=? AND version=?').get(approval.source_revision_id,payload.id,approval.source_version) as {payload:string}|undefined;
    if(!row)throw new PortalError('document_review_stale');
    const source=JSON.parse(row.payload) as StoredPayload;
    if(source.revision_id!==approval.source_revision_id||this.contentDigest(source)!==approval.source_content_digest)throw new PortalError('document_review_stale');
  }
  private assertPayloadGates(ctx:PortalContext,payload:StoredPayload,manage=false,requireValidity=false){
    this.assertContextLinked(ctx,payload,manage);
    if(payload.native_quote_v1){
      this.assertSignedNativeForRead(ctx,payload);
      this.legacy.assertNativeCurrent(ctx,payload.native_quote_v1,payload.document_kind==='linked');
    }
    if(requireValidity)this.assertValidity(payload.input);
    return payload;
  }
  private assertSignedNativeForRead(ctx:PortalContext,payload:StoredPayload){
    if(payload.native_quote_v1?.provenance==='legacy_v1_v2')return;
    this.assertSignedNative(this.scope(ctx),payload);
  }
  private configRaw(scope:Scope):{version:number;input:Record<string,unknown>|null}{
    const row=this.store.store.db.prepare('SELECT version,input FROM document_configs WHERE org=?').get(scope.org) as {version:number;input:string}|undefined;
    return {version:row?.version??0,input:row?JSON.parse(row.input) as Record<string,unknown>:null};
  }
  config(ctx:PortalContext){const scope=this.scope(ctx);const config=this.configRaw(scope);return {...config,standard_fee_template_v1:config.input?.standard_fee_template_v1??null,catalog:standardFeeTemplate};}
  saveConfig(ctx:PortalContext,input:unknown,key:string){
    const scope=this.scope(ctx,true),data=parse(configSaveWorkflowSchema,input);
    return this.idempotent(ctx,scope,'config-save','config',key,data,()=>{
      const current=this.configRaw(scope);
      if(current.version!==data.expected_version)throw new PortalError('version_conflict');
      const merged={...current.input,...data.input};
      this.store.store.db.prepare('INSERT INTO document_configs VALUES(?,?,?) ON CONFLICT(org) DO UPDATE SET version=excluded.version,input=excluded.input').run(scope.org,current.version+1,JSON.stringify(merged));
      return this.config(ctx);
    });
  }
  private templateFor(scope:Scope,mode:'current'|'retain'|'refresh_current',current?:Record<string,unknown>){
    if(mode==='retain'&&current)return {template:current.template as Record<string,unknown>,version:Number(current.template_version)};
    const config=this.configRaw(scope);
    if(!config.input)throw new PortalError('document_template_missing');
    return {template:config.input,version:config.version};
  }
  private readLegacy(scope:Scope,id:string):StoredPayload{
    const row=this.store.store.db.prepare('SELECT owner,payload FROM quote_documents WHERE id=? AND org=?').get(id,scope.org) as {owner:string;payload:string}|undefined;
    if(!row||(row.owner!==scope.user&&!scope.manager))throw new PortalError('document_not_found');
    const payload=JSON.parse(row.payload) as Record<string,unknown>;
    const input=legacyInput(payload.input as Record<string,unknown>);
    if(payload.native_quote_v1)input.fee_items=input.fee_items.map(fee=>({...fee,source_kind:'native' as const,template_ref:null}));
    return {
      id,
      org:scope.org,
      revision_id:null,
      version:Number(payload.version),
      state:payload.state as StoredPayload['state'],
      document_kind:payload.inquiry_case_link_v1?'linked':payload.native_quote_v1?'native_unlinked':'manual',
      input,
      template:(payload.template??{}) as Record<string,unknown>,
      template_version:Number(payload.template_version),
      native_quote_v1:(payload.native_quote_v1??null) as NativeBindingV3|null,
      inquiry_case_link_v1:(payload.inquiry_case_link_v1??null) as StoredPayload['inquiry_case_link_v1'],
      owner_id:String(payload.owner_id),
      created_at:String(payload.created_at),
      updated_at:String(payload.created_at),
      approval:(payload.approval??null) as Record<string,unknown>|null,
      approval_provenance:payload.approval?{kind:'legacy_v1_v2',legacy_version:payload.version,legacy_approval_digest:canonicalHash(payload.approval),verified_by_rule:'legacy_approval_v1_v2',v3_review_hash:null,v3_source_revision_id:null}:null,
      rejection:(payload.rejection??null) as StoredPayload['rejection'],
    };
  }
  private readClaimed(scope:Scope,id:string):StoredPayload|null{
    const current=this.store.store.db.prepare('SELECT * FROM document_current_revisions WHERE document_id=? AND org=?').get(id,scope.org) as CurrentRow|undefined;
    if(!current)return null;
    if(current.owner!==scope.user&&!scope.manager)throw new PortalError('document_not_found');
    const revision=this.store.store.db.prepare('SELECT * FROM document_revisions WHERE revision_id=?').get(current.revision_id) as RevisionRow|undefined;
    if(!revision)throw new PortalError('document_service_unavailable');
    return JSON.parse(revision.payload) as StoredPayload;
  }
  private read(scope:Scope,id:string):StoredPayload{
    return this.readClaimed(scope,id)??this.readLegacy(scope,id);
  }
  private assertContextLinked(ctx:PortalContext,payload:StoredPayload,manage=false){
    if(!payload.inquiry_case_link_v1)return;
    if(!payload.native_quote_v1)throw new PortalError('inquiry_quote_link_forgery');
    const current=this.legacy.linkedCaseRead(ctx,payload.inquiry_case_link_v1,manage);
    if(!manage)return current;
    if(current.status==='closed'||current.status==='cancelled')throw new PortalError('inquiry_quote_case_closed');
    if(current.latest_customer_supplement_ref!==payload.inquiry_case_link_v1.reviewed_customer_event_ref)throw new PortalError('inquiry_quote_case_review_required');
    return current;
  }
  private view(payload:StoredPayload,claim:'legacy_unclaimed'|'claimed_v3'='claimed_v3'):WorkflowDocumentView{
    return {
      id:payload.id,
      revision_id:payload.revision_id??null,
      version:payload.version,
      state:payload.state,
      document_kind:payload.document_kind,
      organization_id:payload.org,
      owner_id:payload.owner_id,
      quote_no:payload.input.quote_no,
      customer_name:payload.input.customer_name,
      created_at:payload.created_at,
      updated_at:payload.updated_at,
      complete:completenessOf(payload.input).complete,
      claim_state:claim,
      input:payload.input,
      completeness:completenessOf(payload.input),
      template:{company_name:safeText(payload.template.company_name),company_address:safeText(payload.template.company_address),company_phone:safeText(payload.template.company_phone),company_email:safeText(payload.template.company_email),terms:safeText(payload.template.terms)},
      template_version:payload.template_version,
      native_quote_v1:payload.native_quote_v1,
      inquiry_case_link_v1:payload.inquiry_case_link_v1,
      approval:payload.approval as WorkflowDocumentView['approval'],
      approval_provenance:payload.approval_provenance as WorkflowDocumentView['approval_provenance'],
      rejection:payload.rejection,
    };
  }
  private summary(view:WorkflowDocumentView){
    return {id:view.id,revision_id:view.revision_id,version:view.version,state:view.state,document_kind:view.document_kind,organization_id:view.organization_id,owner_id:view.owner_id,quote_no:view.quote_no,customer_name:view.customer_name,created_at:view.created_at,updated_at:view.updated_at,complete:view.complete,claim_state:view.claim_state,inquiry_case_link_v1:view.inquiry_case_link_v1};
  }
  get(ctx:PortalContext,input:unknown){const scope=this.scope(ctx),data=parse(getWorkflowSchema,input);const claimed=this.readClaimed(scope,data.id);const payload=claimed??this.readLegacy(scope,data.id);this.assertContextLinked(ctx,payload,false);return this.view(payload,claimed?'claimed_v3':'legacy_unclaimed');}
  preview(ctx:PortalContext,input:unknown){this.scope(ctx);const data=parse(previewWorkflowSchema,input);return {document_id:null,version:null,completeness:completenessOf(data.input),totals:totalsOf(data.input)};}
  async prepareNative(ctx:PortalContext,input:unknown){
    const scope=this.scope(ctx),data=parse(nativePrepareWorkflowSchema,input,'document_input_invalid');
    const prepared=data.document_kind==='linked'
      ? await this.legacy.prepareLinked(ctx,{contract_version:INQUIRY_QUOTE_LINK_VERSION,case_ref:data.case_ref,expected_customer_event_ref:data.expected_customer_event_ref,request:data.request,customer:data.customer})
      : await this.legacy.prepareNative(ctx,{request:data.request,customer:data.customer});
    const legacyBinding=prepared.native_quote_v1;
    if(!legacyBinding)throw new PortalError('native_quote_unavailable');
    const draftInput=legacyInput(prepared.input);
    draftInput.fee_items=draftInput.fee_items.map(fee=>({...fee,source_kind:'native' as const,template_ref:null}));
    const withoutHash={schema_version:'native-quote-binding@2026-09-15.v1' as const,request:legacyBinding.request,preview:legacyBinding.preview,source_refs:legacyBinding.source_refs,source_refs_digest:canonicalHash(legacyBinding.source_refs),release_id:legacyBinding.release_id,release_digest:legacyBinding.release_digest,request_hash:legacyBinding.request_hash,document_fee_digest:nativeFeeDigest(draftInput.fee_items),document_fee_digest_format:'canonical-json-sha256-v1' as const,provenance:'v3_server_signed' as const};
    const caseRef=data.document_kind==='linked'?data.case_ref:null;
    const bindingHash=hash([this.secret,scope.org,scope.user,data.document_kind,caseRef,withoutHash]);
    const nativeQuote={...withoutHash,binding_hash:bindingHash};
    const link=data.document_kind==='linked'?prepared.inquiry_case_link_v1??null:null;
    const previewExpiresAt=Date.now()+600000;
    return {document_kind:data.document_kind,input:draftInput,template_version:prepared.template_version,native_quote_v1:nativeQuote,inquiry_case_link_v1:link,preview_hash:this.previewHash(scope,data.document_kind,caseRef,bindingHash,previewExpiresAt),preview_expires_at:previewExpiresAt,totals:totalsOf(draftInput)};
  }

  private claimIfNeeded(scope:Scope,payload:StoredPayload):{payload:StoredPayload;claimed:boolean}{
    const existing=this.readClaimed(scope,payload.id);
    if(existing)return {payload:existing,claimed:true};
    const claimed={...payload,revision_id:randomUUID(),updated_at:new Date().toISOString()};
    this.insertRevision(scope,claimed,payload.version,payload.state,'legacy_claim',payload.revision_id,null,null);
    return {payload:claimed,claimed:true};
  }
  private insertRevision(scope:Scope,payload:StoredPayload,version:number,state:StoredPayload['state'],action:string,sourceRevision:string|null,reviewHash:string|null,rejectionReason:string|null){
    const revisionId=payload.revision_id??randomUUID();
    const stored={...payload,revision_id:revisionId,version,state,updated_at:new Date().toISOString()};
    const inputDigest=canonicalHash(stored.input),templateDigest=canonicalHash(stored.template),created=new Date().toISOString();
    this.store.store.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId,stored.id,scope.org,stored.owner_id,version,state,3,JSON.stringify(stored),inputDigest,templateDigest,sourceRevision,reviewHash,rejectionReason,scope.user,created);
    this.store.store.db.prepare('INSERT INTO document_current_revisions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET org=excluded.org,owner=excluded.owner,revision_id=excluded.revision_id,version=excluded.version,schema_version=excluded.schema_version,projection_digest=excluded.projection_digest,updated_at=excluded.updated_at').run(stored.id,scope.org,stored.owner_id,revisionId,version,3,inputDigest,created);
    const auditId=randomUUID();this.store.store.db.prepare('INSERT INTO document_audit VALUES(?,?,?,?,?,?)').run(auditId,scope.org,scope.user,action,inputDigest,created);
    this.store.store.db.prepare('INSERT INTO document_revision_events VALUES(?,?,?,?,?)').run(auditId,stored.id,revisionId,version,action);
    return stored;
  }
  private append(scope:Scope,current:StoredPayload,changes:Partial<StoredPayload>,action:string,sourceRevision:string|null,reviewHash:string|null=null){
    const next={...current,...changes,owner_id:current.owner_id,document_kind:current.document_kind,revision_id:randomUUID()};
    if(next.approval)next.approval={...next.approval,approved_revision_id:next.revision_id,approved_version:current.version+1};
    return this.insertRevision(scope,next,current.version+1,next.state,action,sourceRevision,reviewHash,next.rejection?.reason??null);
  }
  private idempotent<T>(ctx:PortalContext,scope:Scope,action:string,target:string,key:string,input:unknown,fn:()=>T):T{
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    const partition=JSON.stringify(['v3',scope.org,scope.user,action,target]),digest=canonicalHash(input),db=this.store.store.db;
    db.exec('BEGIN IMMEDIATE');
    try{
      const old=db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){
        if(old.digest!==digest)throw new PortalError('idempotency_conflict');
        const committed=JSON.parse(old.result) as T;
        const candidate=committed as unknown as {id?:unknown;version?:unknown;revision_id?:unknown;state?:unknown};
        if(typeof candidate.id==='string'&&typeof candidate.version==='number'){
          const current=this.read(scope,candidate.id);
          this.assertContextLinked(ctx,current,action==='save'||action==='approve'||action==='reject');
          if(current.version!==candidate.version||current.state!==candidate.state){
            db.exec('COMMIT');
            return {replay:true,committed:true,current:false,historical:true,id:current.id,version:candidate.version,revision_id:typeof candidate.revision_id==='string'?candidate.revision_id:null,current_version:current.version,current_revision_id:current.revision_id??null,current_state:current.state} as T;
          }
        }
        db.exec('COMMIT');return committed;
      }
      const result=fn();
      db.prepare('INSERT INTO document_idempotency VALUES(?,?,?,?)').run(partition,key,digest,JSON.stringify(result));
      db.exec('COMMIT');
      return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  save(ctx:PortalContext,input:unknown,key:string){
    const scope=this.scope(ctx),data=parse(saveWorkflowSchema,input);
    if(data.operation==='create'){
      return this.idempotent(ctx,scope,'save','create',key,data,()=>{
        const generated=this.templateFor(scope,data.template_selection.mode);
        const now=new Date().toISOString();
        const payload:StoredPayload={id:randomUUID(),org:scope.org,revision_id:randomUUID(),version:1,state:'draft',document_kind:data.document_kind,input:data.input,template:generated.template,template_version:generated.version,native_quote_v1:'native_quote_v1' in data?data.native_quote_v1:null,inquiry_case_link_v1:'inquiry_case_link_v1' in data?(data.inquiry_case_link_v1??null):null,owner_id:scope.user,created_at:now,updated_at:now,approval:null,approval_provenance:null,rejection:null};
        if(payload.native_quote_v1&&!['native_unlinked','linked'].includes(payload.document_kind))throw new PortalError('document_input_invalid');
        if(payload.document_kind==='linked'&&!payload.inquiry_case_link_v1)throw new PortalError('inquiry_quote_link_input_invalid');
        if(payload.document_kind==='manual'){
          if(payload.native_quote_v1||payload.inquiry_case_link_v1)throw new PortalError('document_input_invalid');
          this.assertManualRows(payload.input);
        }else{
          if(!('native_quote_v1' in data))throw new PortalError('native_quote_rebind_required');
          if(!payload.native_quote_v1)throw new PortalError('native_quote_rebind_required');
          if(payload.document_kind==='linked'&&!payload.inquiry_case_link_v1)throw new PortalError('inquiry_quote_link_input_invalid');
          if(payload.document_kind==='native_unlinked'&&payload.inquiry_case_link_v1)throw new PortalError('inquiry_quote_link_forgery');
          this.assertNativeRows(payload.input);
          this.assertSignedNative(scope,payload);
          this.assertSignedPreview(scope,payload.document_kind,payload.inquiry_case_link_v1?.case_ref??null,payload.native_quote_v1.binding_hash,data.preview_hash,data.preview_expires_at);
        }
        this.assertPayloadGates(ctx,payload,payload.document_kind==='linked');
        const stored=this.insertRevision(scope,payload,1,'draft','create',null,null,null);
        return this.view(stored);
      });
    }
    return this.idempotent(ctx,scope,'save',data.id,key,data,()=>{
      const current=this.read(scope,data.id);
      if(current.version!==data.expected_version)throw new PortalError('version_conflict');
      if(current.state==='approved')throw new PortalError('document_state_not_editable');
      const bindingUpdate='binding_update' in data?data.binding_update:{mode:'retain' as const};
      this.assertKind(data.document_kind,current,current.native_quote_v1?bindingUpdate:undefined);
      if(current.native_quote_v1){
        this.assertNativeRows(data.input);
        const digest=nativeFeeDigest(data.input.fee_items);
        if(bindingUpdate.mode==='retain'&&(current.native_quote_v1.provenance!=='v3_server_signed'||digest!==current.native_quote_v1.document_fee_digest))throw new PortalError('native_quote_rebind_required');
        if(bindingUpdate.mode==='replace'){
          const caseRef=current.inquiry_case_link_v1?.case_ref??null;
          if(bindingUpdate.native_quote_v1.document_fee_digest!==digest)throw new PortalError('native_quote_rebind_required');
          if(data.document_kind==='linked'&&bindingUpdate.inquiry_case_link_v1?.case_ref!==caseRef)throw new PortalError('inquiry_quote_link_forgery');
          if(data.document_kind==='native_unlinked'&&bindingUpdate.inquiry_case_link_v1)throw new PortalError('inquiry_quote_link_forgery');
          const candidate:StoredPayload={...current,input:data.input,native_quote_v1:bindingUpdate.native_quote_v1,inquiry_case_link_v1:data.document_kind==='linked'?(bindingUpdate.inquiry_case_link_v1??current.inquiry_case_link_v1):null};
          this.assertSignedNative(scope,candidate);
          this.assertSignedPreview(scope,data.document_kind,caseRef,bindingUpdate.native_quote_v1.binding_hash,bindingUpdate.preview_hash,bindingUpdate.preview_expires_at);
          this.assertPayloadGates(ctx,candidate,data.document_kind==='linked');
        }else{
          this.assertSignedNativeForRead(ctx,current);
          this.assertPayloadGates(ctx,current,data.document_kind==='linked');
        }
      }else{
        if(data.document_kind!=='manual'||bindingUpdate.mode!=='retain')throw new PortalError('document_input_invalid');
        this.assertManualRows(data.input);
        this.assertPayloadGates(ctx,current,false);
      }
      const {claimed}=current.revision_id?{claimed:true}:this.claimIfNeeded(scope,current);
      const base=claimed?this.read(scope,data.id):current;
      const generated=this.templateFor(scope,data.template_selection.mode,base);
      const nextBinding=bindingUpdate.mode==='replace'?bindingUpdate.native_quote_v1:base.native_quote_v1;
      const nextLink=bindingUpdate.mode==='replace'?(bindingUpdate.inquiry_case_link_v1??base.inquiry_case_link_v1):base.inquiry_case_link_v1;
      const stored=this.append(scope,base,{state:'draft',input:data.input,template:generated.template,template_version:generated.version,native_quote_v1:nextBinding,inquiry_case_link_v1:nextLink,approval:null,approval_provenance:null,rejection:null},'update',base.revision_id??null);
      return this.view(stored);
    });
  }
  list(ctx:PortalContext,input:unknown){
    const scope=this.scope(ctx),data=parse(listWorkflowSchema,input);
    const items:WorkflowDocumentView[]=[];
    const claimed=this.store.store.db.prepare('SELECT document_id FROM document_current_revisions WHERE org=? AND (?=1 OR owner=?) ORDER BY updated_at DESC').all(scope.org,scope.manager?1:0,scope.user) as Array<{document_id:string}>;
    for(const row of claimed){const item=this.readClaimed(scope,row.document_id)!;try{this.assertPayloadGates(ctx,item,false);items.push(this.view(item));}catch(error){if(error instanceof PortalError&&error.code==='document_not_found')continue;throw error;}}
    const legacy=this.store.store.db.prepare('SELECT id FROM quote_documents WHERE org=? AND (?=1 OR owner=?) AND id NOT IN (SELECT document_id FROM document_current_revisions) ORDER BY rowid DESC').all(scope.org,scope.manager?1:0,scope.user) as Array<{id:string}>;
    for(const row of legacy){const item=this.readLegacy(scope,row.id);try{this.assertPayloadGates(ctx,item,false);items.push(this.view(item,'legacy_unclaimed'));}catch(error){if(error instanceof PortalError&&error.code==='document_not_found')continue;throw error;}}
    const filterDigest=canonicalHash(data.filters),cursor=data.cursor?decodeCursor(data.cursor):null;
    if(cursor&&cursor.filter_digest!==filterDigest)throw new PortalError('document_input_invalid');
    const visible=items.filter(item=>(data.filters.state==='all'||item.state===data.filters.state)&&(data.filters.quote_no===null||item.quote_no?.includes(data.filters.quote_no))&&(data.filters.customer_name===null||item.customer_name?.includes(data.filters.customer_name))).sort((left,right)=>left.updated_at===right.updated_at?right.id.localeCompare(left.id):right.updated_at.localeCompare(left.updated_at));
    const remaining=cursor?visible.filter(item=>item.updated_at<cursor.updated_at||(item.updated_at===cursor.updated_at&&item.id<cursor.id)):visible;
    const page=remaining.slice(0,data.limit);
    const next=remaining.length>data.limit?page.at(-1):undefined;
    return {items:page.map(item=>this.summary(item)),next_cursor:next?encodeCursor({updated_at:next.updated_at,id:next.id,filter_digest:filterDigest}):null};
  }
  private reviewPayload(scope:Scope,payload:StoredPayload){
    const completeness=completenessOf(payload.input),totals=totalsOf(payload.input);
    if(!completeness.complete)return {kind:'needs_input' as const,document_id:payload.id,version:payload.version,completeness,totals};
    const expires=Date.now()+600000,digest=this.contentDigest(payload);
    const reviewHash=hash([this.secret,scope.org,scope.user,payload.id,payload.version,payload.revision_id,digest,expires]);
    this.reviews.set(reviewHash,{id:payload.id,version:payload.version,revision_id:payload.revision_id??null,content_digest:digest,expires});
    return {kind:'success' as const,data:{document_id:payload.id,revision_id:payload.revision_id??null,reviewed_version:payload.version,state:payload.state,input:payload.input,completeness,totals,warnings:totals.warnings,blockers:[],requirements:{complete:true,case_current:true,native_source_current:true,validity_ok:true},can_approve:true,available_export_modes:payload.document_kind==='linked'?[]:['draft'],review_hash:reviewHash,review_expires_at:expires}};
  }
  review(ctx:PortalContext,input:unknown){const scope=this.scope(ctx),data=parse(reviewWorkflowSchema,input),payload=this.read(scope,data.id);if(payload.version!==data.expected_version)throw new PortalError('version_conflict');if(payload.state!=='draft')throw new PortalError('document_state_not_editable');const result=this.reviewPayload(scope,payload);if(result.kind==='needs_input')return {status:'needs_input' as const,...result};this.assertPayloadGates(ctx,payload,true,true);return {status:'success' as const,...result.data};}
  approve(ctx:PortalContext,input:unknown,key:string){const scope=this.scope(ctx,true),data=parse(approveWorkflowSchema,input);return this.idempotent(ctx,scope,'approve',data.id,key,data,()=>{const current=this.read(scope,data.id);if(current.version!==data.expected_version)throw new PortalError('version_conflict');if(current.state!=='draft')throw new PortalError('version_conflict');this.assertPayloadGates(ctx,current,true,true);const review=this.reviews.get(data.review_hash);if(!review||review.id!==current.id||review.version!==current.version||review.expires<Date.now()||review.content_digest!==this.contentDigest(current))throw new PortalError('document_review_stale');const claimed=current.revision_id?current:this.claimIfNeeded(scope,current).payload;if(review.revision_id!==null&&review.revision_id!==claimed.revision_id)throw new PortalError('document_review_stale');const sourceDigest=this.contentDigest(claimed),stored=this.append(scope,claimed,{state:'approved',approval:{...data,source_revision_id:claimed.revision_id,source_version:claimed.version,source_content_digest:sourceDigest,approved_revision_id:'',approved_version:claimed.version+1,review_expires_at:review.expires,actor:scope.user,at:new Date().toISOString()},approval_provenance:null},'approve',claimed.revision_id,data.review_hash);return this.view(stored);});}
  reject(ctx:PortalContext,input:unknown,key:string){const scope=this.scope(ctx,true),data=parse(rejectWorkflowSchema,input);return this.idempotent(ctx,scope,'reject',data.id,key,data,()=>{const current=this.read(scope,data.id);if(current.version!==data.expected_version||current.state!=='draft')throw new PortalError('version_conflict');this.assertPayloadGates(ctx,current,true);const claimed=current.revision_id?current:this.claimIfNeeded(scope,current).payload,stored=this.append(scope,claimed,{state:'rejected',rejection:{reason:data.reason,actor:scope.user,at:new Date().toISOString()}},'reject',claimed.revision_id);return this.view(stored);});}
  private validatePdf(cached:{sha256:string;bytes:Uint8Array}|undefined):Buffer{
    if(!cached)throw new PortalError('inquiry_quote_history_bytes_missing');
    const bytes=Buffer.from(cached.bytes);
    if(bytes.length<100||bytes.length>8388608||bytes.subarray(0,5).toString()!=='%PDF-'||createHash('sha256').update(bytes).digest('hex')!==cached.sha256)throw new PortalError('document_pdf_invalid');
    return bytes;
  }
  private currentModeUsable(ctx:PortalContext,payload:StoredPayload,mode:'draft'|'formal'){
    if(mode==='draft'){
      if(payload.document_kind==='linked'||!completenessOf(payload.input).complete)return false;
      this.assertPayloadGates(ctx,payload,false);
      return true;
    }
    if(payload.state!=='approved')return false;
    this.assertApprovalPayload(payload);
    this.assertPayloadGates(ctx,payload,payload.document_kind==='linked',true);
    return true;
  }
  private isHistoricalOnlyReason(error:unknown){
    return error instanceof PortalError&&['document_expired','native_quote_release_expired','native_quote_source_changed','inquiry_quote_case_closed','inquiry_quote_case_review_required','document_review_stale','document_not_approved'].includes(error.code);
  }
  async export(ctx:PortalContext,input:unknown){
    const scope=this.scope(ctx),data=parse(exportWorkflowSchema,input),current=this.read(scope,data.id);
    if(data.mode==='history'){
      if(current.version!==data.expected_current_version)throw new PortalError('version_conflict');
      this.assertContextLinked(ctx,current,false);
      const cached=this.store.store.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=?').get(data.id,data.target_version) as {sha256:string;bytes:Uint8Array}|undefined;
      const bytes=this.validatePdf(cached);
      const target=this.readVersion(scope,data.id,data.target_version);
      if(target&&target.version===current.version){
        let currentUsable=false;
        try{currentUsable=this.currentModeUsable(ctx,current,current.state==='approved'?'formal':'draft');}catch(error){if(!this.isHistoricalOnlyReason(error))throw error;}
        if(currentUsable)throw new PortalError('document_export_mode_invalid');
      }
      return this.exportView(target,data.target_version,target?.revision_id??null,data.id,cached!.sha256,bytes,current.state!=='approved',true,current.version);
    }
    if(current.version!==data.expected_version)throw new PortalError('version_conflict');
    if(current.document_kind==='linked'&&data.mode==='draft')throw new PortalError('document_export_mode_invalid');
    if(data.mode==='draft'&&!completenessOf(current.input).complete)throw new PortalError('document_incomplete');
    if(data.mode==='formal'){
      if(current.state!=='approved')throw new PortalError('document_not_approved');
      this.assertApprovalPayload(current);
    }
    this.assertPayloadGates(ctx,current,current.document_kind==='linked',data.mode==='formal');
    const cached=this.store.store.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=?').get(data.id,current.version) as {sha256:string;bytes:Uint8Array}|undefined;
    if(cached)return this.exportView(current,current.version,current.revision_id,data.id,cached.sha256,this.validatePdf(cached),data.mode==='draft',false,current.version);
    const html=renderHtml(renderDocument(current.input),current.template as never,current.state==='approved');
    let bytes:Buffer;
    try{bytes=await this.renderer(html);}catch{throw new PortalError('document_renderer_unavailable');}
    const latest=this.read(scope,data.id);
    if(latest.version!==current.version||latest.revision_id!==current.revision_id)throw new PortalError('version_conflict');
    this.assertPayloadGates(ctx,latest,latest.document_kind==='linked',data.mode==='formal');
    if(data.mode==='formal')this.assertApprovalPayload(latest);
    if(bytes.length<100||bytes.length>8388608||bytes.subarray(0,5).toString()!=='%PDF-')throw new PortalError('document_pdf_invalid');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    this.store.store.db.prepare('INSERT OR IGNORE INTO document_pdfs VALUES(?,?,?,?)').run(current.id,current.version,sha256,bytes);
    const readback=this.store.store.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=?').get(current.id,current.version) as {sha256:string;bytes:Uint8Array}|undefined;
    return this.exportView(latest,current.version,current.revision_id,data.id,sha256,this.validatePdf(readback),data.mode==='draft',false,current.version);
  }
  private readVersion(scope:Scope,id:string,version:number):StoredPayload|null{const row=this.store.store.db.prepare('SELECT payload FROM document_revisions WHERE document_id=? AND org=? AND version=?').get(id,scope.org,version) as {payload:string}|undefined;if(row)return JSON.parse(row.payload) as StoredPayload;const legacy=this.readLegacy(scope,id);if(legacy.version===version)return legacy;return null;}
  private exportView(payload:StoredPayload|null,version:number,revisionId:string|null,id:string,sha256:string,bytes:Buffer,draft:boolean,historical:boolean,currentVersion:number){return {id,version,revision_id:revisionId,current_version:currentVersion,mode:historical?'history':draft?'draft':'formal',draft,historical,valid_now:!historical,target_version:version,filename:`quotation-${id}-v${version}.pdf`,sha256,byte_length:bytes.length,content_base64:bytes.toString('base64'),totals:payload?totalsOf(payload.input):null};}
}
