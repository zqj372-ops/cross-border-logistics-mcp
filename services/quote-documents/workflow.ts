import Decimal from 'decimal.js';
import {readdirSync,statSync} from 'node:fs';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {PortalError,type PortalContext} from '../access-gateway/portal/contracts';
import type {PortalService} from '../access-gateway/portal/service';
import type {CaseService} from '../access-gateway/portal/cases';
import type {NativeAdminService} from '../access-gateway/portal/native-admin';
import type {DocumentFclStoreOptions,DocumentService,DocumentStore} from './service';
import {calculate,renderHtml} from './engine';
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
import {z} from 'zod';
import {INQUIRY_QUOTE_LINK_VERSION,type nativeQuoteBindingSchema} from './contracts';
import {
  FCL_DOCUMENT_WORKFLOW_VERSION,
  fclConfigSaveSchema,
  fclConfigViewSchema,
  fclDocumentGetRequestSchema,
  fclDocumentApproveRequestSchema,
  fclDocumentRejectRequestSchema,
  fclDocumentReviewRequestSchema,
  fclDocumentReviewViewSchema,
  fclDocumentListRequestSchema,
  fclDocumentListSchema,
  fclDocumentPayloadSchema,
  fclDocumentReferenceSchema,
  fclDocumentSaveRequestSchema,
  fclDocumentViewSchema,
  type FclConfigView,
  type FclDocumentPayload,
  type FclDocumentReviewView,
  type FclDocumentView,
} from './fcl-contracts';
import {
  buildFclCostSellSnapshot,
  FCL_QUOTE_WORKFLOW_VERSION,
  fclQuoteGetRequestSchema,
  fclQuoteListSchema,
  fclQuoteListRequestSchema,
  fclQuoteReferenceSchema,
  fclQuoteSaveRequestSchema,
  fclQuoteViewSchema,
  validateFclQuoteSnapshot,
  type FclQuoteCurrentness,
  type FclQuoteService,
  type FclQuoteView,
} from '../quote-native/fcl';
import type {FclRateDataset} from '../quote-native/fcl-contracts';

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
const canonicalJson=(value:unknown)=>JSON.stringify(sortValue(value));
const stableUuid=(value:string)=>{
  const hex=createHash('sha256').update(value).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]='8';
  return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20,32).join('')}`;
};
const safeText=(value:unknown)=>typeof value==='string'?value:'';
const today=()=>new Date().toISOString().slice(0,10);
// Compare inode identities and fail closed when an existing process cannot be inspected.
export function assertNoExternalSqliteHandles(path:string,options:{procRoot?:string;currentPid?:number;onlyPids?:ReadonlySet<number>}={}):void{
  if(process.platform!=='linux')throw new PortalError('document_v3_upgrade_ownership_unverified');
  const procRoot=options.procRoot??'/proc',currentPid=options.currentPid??process.pid;
  const errorCode=(error:unknown)=>error!==null&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:null;
  const identities=(candidate:string):Array<{dev:bigint;ino:bigint}>=>{
    try{
      const stat=statSync(candidate,{bigint:true});
      return [{dev:stat.dev,ino:stat.ino}];
    }catch(error){
      if(errorCode(error)==='ENOENT')return [];
      throw new PortalError('document_v3_upgrade_ownership_unverified');
    }
  };
  const processExists=(pid:string):boolean=>{
    try{
      statSync(`${procRoot}/${pid}`);
      return true;
    }catch(error){
      if(errorCode(error)==='ENOENT')return false;
      throw new PortalError('document_v3_upgrade_ownership_unverified');
    }
  };
  const targets=[path,`${path}-wal`,`${path}-shm`].flatMap(identities);
  let pids:string[];
  try{pids=readdirSync(procRoot);}catch{throw new PortalError('document_v3_upgrade_ownership_unverified');}
  for(const pid of pids){
    const numericPid=Number(pid);
    if(!/^[0-9]+$/u.test(pid)||numericPid===currentPid||(options.onlyPids&&!options.onlyPids.has(numericPid)))continue;
    let fds:string[];
    try{fds=readdirSync(`${procRoot}/${pid}/fd`);}catch(error){if(errorCode(error)==='ENOENT'||!processExists(pid))continue;throw new PortalError('document_v3_upgrade_ownership_unverified');}
    for(const fd of fds){
      let identity:{dev:bigint;ino:bigint};
      try{const stat=statSync(`${procRoot}/${pid}/fd/${fd}`,{bigint:true});identity={dev:stat.dev,ino:stat.ino};}catch(error){if(errorCode(error)==='ENOENT')continue;throw new PortalError('document_v3_upgrade_ownership_unverified');}
      if(targets.some(target=>target.dev===identity.dev&&target.ino===identity.ino))throw new PortalError('document_v3_upgrade_old_writer_open');
    }
  }
}

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

export interface FclDocumentWorkflowOptions{
  readonly receiverUserId:string;
  readonly receiverIsActive:(userId:string)=>boolean;
  readonly now?:()=>string;
}

export interface FclQuoteWorkflowDependencies{
  readonly quoteService:Pick<FclQuoteService,'match'>;
  readonly caseReader:Pick<CaseService,'getFclCase'>;
  readonly caseLock:Pick<CaseService,'withFclReadLock'>;
  readonly rateLock:Pick<NativeAdminService,'withFclReadLock'>;
  readonly rateReader:Pick<NativeAdminService,'get'>;
}

type NormalizedFclDocumentWorkflowOptions={
  receiverUserId:string;
  receiverIsActive:(userId:string)=>boolean;
  now:()=>string;
};

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

function isNativeBindingV3(binding:StoredPayload['native_quote_v1']):binding is NativeBindingV3{
  return binding!==null&&'schema_version' in binding&&'binding_hash' in binding&&'document_fee_digest' in binding;
}

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
type LegacyNativeBinding=z.infer<typeof nativeQuoteBindingSchema>;
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
  native_quote_v1:NativeBindingV3|LegacyNativeBinding|null;
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
  const completeness=completenessOf(input);
  if(completeness.complete)return {partial:false,complete:true,...calculate(renderDocument(input))};
  const sums={USD:new Decimal(0),CAD:new Decimal(0),CNY:new Decimal(0)};
  const rows=input.fee_items.map(fee=>{
    const complete=fee.quantity!==null&&fee.unit_price!==null&&fee.currency!==null&&fee.display!=='hiddenExcluded';
    const amount=complete?new Decimal(fee.quantity!).mul(fee.unit_price!).toFixed(2):null;
    if(amount!==null&&fee.currency!==null)sums[fee.currency]=sums[fee.currency].add(amount);
    return {...fee,amount};
  });
  const partial=completeness.partial;
  const byCurrency={USD:sums.USD.toFixed(2),CAD:sums.CAD.toFixed(2),CNY:sums.CNY.toFixed(2)};
  const cnyParts=(['USD','CAD'] as const).map(currency=>{
    if(sums[currency].isZero())return new Decimal(0);
    const rate=input.exchange_rates[currency];
    return rate===null?null:sums[currency].mul(rate);
  });
  const totalCny=cnyParts.some(value=>value===null)?null:cnyParts.reduce<Decimal>((a,b)=>a.add(b!),sums.CNY).toFixed(2);
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

/** oldWritersStopped is an explicit deployment attestation, not a probing inference. */
type ExpectedColumn={name:string;type:string;notnull:number;pk:boolean};
type ExpectedIndex={name:string;columns:Array<{name:string;desc:boolean}>;unique:boolean};
const v3TableLayouts:Record<string,ExpectedColumn[]>={
  document_configs:[
    {name:'org',type:'TEXT',notnull:0,pk:true},
    {name:'version',type:'INTEGER',notnull:1,pk:false},
    {name:'input',type:'TEXT',notnull:1,pk:false},
  ],
  document_revisions:[
    {name:'revision_id',type:'TEXT',notnull:0,pk:true},
    {name:'document_id',type:'TEXT',notnull:1,pk:false},
    {name:'org',type:'TEXT',notnull:1,pk:false},
    {name:'owner',type:'TEXT',notnull:1,pk:false},
    {name:'version',type:'INTEGER',notnull:1,pk:false},
    {name:'state',type:'TEXT',notnull:1,pk:false},
    {name:'schema_version',type:'INTEGER',notnull:1,pk:false},
    {name:'payload',type:'TEXT',notnull:1,pk:false},
    {name:'input_digest',type:'TEXT',notnull:1,pk:false},
    {name:'template_digest',type:'TEXT',notnull:1,pk:false},
    {name:'source_revision_id',type:'TEXT',notnull:0,pk:false},
    {name:'review_hash',type:'TEXT',notnull:0,pk:false},
    {name:'rejection_reason',type:'TEXT',notnull:0,pk:false},
    {name:'created_by',type:'TEXT',notnull:1,pk:false},
    {name:'created_at',type:'TEXT',notnull:1,pk:false},
  ],
  document_current_revisions:[
    {name:'document_id',type:'TEXT',notnull:0,pk:true},
    {name:'org',type:'TEXT',notnull:1,pk:false},
    {name:'owner',type:'TEXT',notnull:1,pk:false},
    {name:'revision_id',type:'TEXT',notnull:1,pk:false},
    {name:'version',type:'INTEGER',notnull:1,pk:false},
    {name:'schema_version',type:'INTEGER',notnull:1,pk:false},
    {name:'projection_digest',type:'TEXT',notnull:1,pk:false},
    {name:'updated_at',type:'TEXT',notnull:1,pk:false},
  ],
  document_audit:[
    {name:'id',type:'TEXT',notnull:0,pk:true},
    {name:'org',type:'TEXT',notnull:1,pk:false},
    {name:'actor',type:'TEXT',notnull:1,pk:false},
    {name:'action',type:'TEXT',notnull:1,pk:false},
    {name:'digest',type:'TEXT',notnull:1,pk:false},
    {name:'created',type:'TEXT',notnull:1,pk:false},
  ],
};
const v4TableLayouts:Record<string,ExpectedColumn[]>={
  document_configs:[
    {name:'org',type:'TEXT',notnull:0,pk:false},
    {name:'personal_owner_id',type:'TEXT',notnull:0,pk:false},
    {name:'version',type:'INTEGER',notnull:1,pk:false},
    {name:'input',type:'TEXT',notnull:1,pk:false},
  ],
  document_revisions:v3TableLayouts.document_revisions!.flatMap(column=>column.name==='org'?[{...column,notnull:0},{name:'personal_owner_id',type:'TEXT',notnull:0,pk:false}]:[{...column,notnull:column.name==='revision_id'?0:column.notnull}]),
  document_current_revisions:v3TableLayouts.document_current_revisions!.flatMap(column=>column.name==='org'?[{...column,notnull:0}, {name:'personal_owner_id',type:'TEXT',notnull:0,pk:false}]:[{...column,notnull:column.name==='document_id'?0:column.notnull}]),
  document_audit:v3TableLayouts.document_audit!.flatMap(column=>column.name==='org'?[{...column,notnull:0}, {name:'personal_owner_id',type:'TEXT',notnull:0,pk:false}]:[{...column,notnull:column.name==='id'?0:column.notnull}]),
};
const v3Indexes:Record<string,ExpectedIndex[]> = {
  document_revisions:[{name:'document_revisions_document',columns:[{name:'document_id',desc:false},{name:'version',desc:true}],unique:false}],
  document_current_revisions:[{name:'document_current_org',columns:[{name:'org',desc:false},{name:'updated_at',desc:true}],unique:false}],
};
const v4Indexes:Record<string,ExpectedIndex[]> = {
  document_revisions:[...v3Indexes.document_revisions!,{name:'document_revisions_personal',columns:[{name:'personal_owner_id',desc:false},{name:'document_id',desc:false},{name:'version',desc:true}],unique:false}],
  document_current_revisions:[...v3Indexes.document_current_revisions!,{name:'document_current_personal',columns:[{name:'personal_owner_id',desc:false},{name:'updated_at',desc:true}],unique:false}],
  document_audit:[{name:'document_audit_personal',columns:[{name:'personal_owner_id',desc:false},{name:'created',desc:true}],unique:false}],
};
const v5TableLayouts:Record<string,ExpectedColumn[]>={
  ...v4TableLayouts,
  fcl_quote_revisions:[
    {name:'quote_id',type:'TEXT',notnull:1,pk:true},
    {name:'version',type:'INTEGER',notnull:1,pk:true},
    {name:'personal_owner_id',type:'TEXT',notnull:1,pk:false},
    {name:'case_ref',type:'TEXT',notnull:1,pk:false},
    {name:'payload',type:'TEXT',notnull:1,pk:false},
    {name:'content_digest',type:'TEXT',notnull:1,pk:false},
    {name:'actor',type:'TEXT',notnull:1,pk:false},
    {name:'created_at',type:'TEXT',notnull:1,pk:false},
  ],
};
const v5Indexes:Record<string,ExpectedIndex[]>={
  ...v4Indexes,
  fcl_quote_revisions:[
    {name:'fcl_quote_revisions_owner',columns:[{name:'personal_owner_id',desc:false},{name:'created_at',desc:true},{name:'quote_id',desc:true}],unique:false},
    {name:'fcl_quote_revisions_case',columns:[{name:'personal_owner_id',desc:false},{name:'case_ref',desc:false},{name:'quote_id',desc:false},{name:'version',desc:true}],unique:false},
  ],
};
export interface DocumentWorkflowStoreOptions{
  readonly oldWritersStopped?:boolean;
  readonly readOnly?:boolean;
  readonly ownershipMode?:'existing-database'|'fresh-fixture';
  readonly externalHandleProbe?:(path:string)=>void;
  readonly fcl?:DocumentFclStoreOptions;
}
export class DocumentWorkflowStore{
  readonly db;
  readonly signingSecret:string;
  private schemaReady=false;
  private fclReady=false;
  private quoteReady=false;
  private readonly oldWritersStopped:boolean;
  private readonly ownershipMode:'existing-database'|'fresh-fixture';
  private readonly externalHandleProbe:(path:string)=>void;
  private readonly fclStoreOptions:DocumentFclStoreOptions|undefined;
  readonly readOnly:boolean;
  constructor(readonly store:DocumentStore,options:DocumentWorkflowStoreOptions={}){
    this.db=store.db;
    this.oldWritersStopped=options.oldWritersStopped===true;
    this.ownershipMode=options.ownershipMode??'existing-database';
    this.externalHandleProbe=options.externalHandleProbe??assertNoExternalSqliteHandles;
    this.fclStoreOptions=options.fcl;
    this.readOnly=options.readOnly===true;
    const db=this.db;
    const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    const fclRequested=this.fclStoreOptions!==undefined||store.fclEnabled;
    if(fclRequested){
      if(!store.fclEnabled)throw new Error('document_fcl_open_required');
      if(version>5)throw new Error('workflow_schema_incompatible');
      if(version===5){
        this.signingSecret=this.readSigningSecret();
        this.assertV5Schema();
        this.schemaReady=true;
        this.fclReady=true;
        this.quoteReady=true;
        if(this.readOnly)db.exec('PRAGMA query_only=ON;');
        return;
      }
      if(version===4&&(this.readOnly||this.fclStoreOptions?.mode==='reopen')){
        this.signingSecret=this.readSigningSecret();
        this.assertV4Schema();
        this.schemaReady=true;
        this.fclReady=true;
        if(this.readOnly)db.exec('PRAGMA query_only=ON;');
        return;
      }
      if(this.readOnly)throw new Error('workflow_read_only_requires_v4');
      this.signingSecret=version>=3?this.readSigningSecret():randomBytes(32).toString('hex');
      this.migrateToV5(version);
      return;
    }
    if(version>3)throw new Error('workflow_schema_incompatible');
    if(this.readOnly&&version!==3)throw new Error('workflow_read_only_requires_v3');
    if(version===3){
      this.signingSecret=this.readSigningSecret();
      this.schemaReady=true;
      if(this.readOnly)db.exec('PRAGMA query_only=ON;');
    }else{
      this.signingSecret=randomBytes(32).toString('hex');
    }
  }
  static openReadOnly(store:DocumentStore):DocumentWorkflowStore{return new DocumentWorkflowStore(store,{readOnly:true});}
  private readSigningSecret():string{
    const row=this.db.prepare('SELECT value FROM document_store_metadata WHERE key=?').get('workflow_signing_secret') as {value:string}|undefined;
    const revisionTable=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_revisions'").get();
    if(!row?.value||!revisionTable)throw new Error('workflow_metadata_invalid');
    return row.value;
  }
  private indexColumns(indexName:string):Array<{name:string;desc:boolean}>{
    return (this.db.prepare('SELECT name,"desc" AS is_desc FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(indexName) as Array<{name:string;is_desc:number}>).map(column=>({name:column.name,desc:column.is_desc===1}));
  }
  private assertTableLayout(table:string,expected:ExpectedColumn[]):void{
    const columns=this.db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{name:string;type:string;notnull:number;pk:number}>;
    if(columns.length!==expected.length)throw new Error('workflow_schema_unsupported');
    for(const [index,column] of columns.entries()){
      const wanted=expected[index];
      if(!wanted||column.name!==wanted.name||column.type.toUpperCase()!==wanted.type||column.notnull!==wanted.notnull||(column.pk>0)!==wanted.pk)throw new Error('workflow_schema_unsupported');
    }
  }
  private assertIndexDefinition(table:string,expected:ExpectedIndex):void{
    const row=this.db.prepare(`PRAGMA index_list('${table}')`).all().find(index=>(index as {name:string}).name===expected.name) as {name:string;unique:number}|undefined;
    if(!row||(row.unique===1)!==expected.unique)throw new Error('workflow_schema_unsupported');
    const columns=this.indexColumns(expected.name);
    if(columns.length!==expected.columns.length||columns.some((column,index)=>column.name!==expected.columns[index]?.name||column.desc!==expected.columns[index]?.desc))throw new Error('workflow_schema_unsupported');
  }
  private assertUniqueColumns(table:string,columns:string[]):void{
    const indexes=this.db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{name:string;unique:number}>;
    if(!indexes.some(index=>index.unique===1&&this.indexColumns(index.name).every((column,position)=>column.name===columns[position])&&this.indexColumns(index.name).length===columns.length))throw new Error('workflow_schema_unsupported');
  }
  private assertPrimaryColumns(table:string,columns:string[]):void{
    const rows=(this.db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{name:string;pk:number}>).filter(row=>row.pk>0).sort((left,right)=>left.pk-right.pk);
    if(rows.length!==columns.length||rows.some((row,index)=>row.name!==columns[index]))throw new Error('workflow_schema_unsupported');
  }
  private assertKnownSchema(layouts:Record<string,ExpectedColumn[]>,indexes:Record<string,ExpectedIndex[]>):void{
    for(const [table,expected] of Object.entries(layouts)){
      this.assertTableLayout(table,expected);
      const allowed=new Set(indexes[table]?.map(index=>index.name)??[]);
      const existing=this.db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{name:string}>;
      if(existing.some(index=>!index.name.startsWith('sqlite_autoindex_')&&!allowed.has(index.name)))throw new Error('workflow_schema_unsupported');
      const trigger=this.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? LIMIT 1").get(table);
      if(trigger)throw new Error('workflow_schema_unsupported');
    }
    for(const [table,expected] of Object.entries(indexes))for(const index of expected)this.assertIndexDefinition(table,index);
  }
  private assertV4OwnerConstraints():void{
    const tables=['document_configs','document_revisions','document_current_revisions','document_audit'];
    for(const table of tables){
      const row=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string}|undefined;
      const sql=row?.sql.replace(/\s+/gu,'').toLowerCase()??'';
      if(!sql.includes('check((orgisnull)!=(personal_owner_idisnull))'))throw new Error('workflow_schema_unsupported');
    }
    this.assertUniqueColumns('document_configs',['org']);
    this.assertUniqueColumns('document_configs',['personal_owner_id']);
    this.assertUniqueColumns('document_revisions',['document_id','version']);
    this.assertUniqueColumns('document_current_revisions',['revision_id']);
  }
  private assertKnownV3Schema():void{
    this.assertKnownSchema(v3TableLayouts,v3Indexes);
    this.assertUniqueColumns('document_configs',['org']);
    this.assertUniqueColumns('document_revisions',['document_id','version']);
    this.assertUniqueColumns('document_current_revisions',['revision_id']);
  }
  private assertKnownV4Schema():void{
    this.assertKnownSchema(v4TableLayouts,v4Indexes);
    this.assertV4OwnerConstraints();
  }
  private assertV5Schema():void{
    const metadata=this.db.prepare('SELECT value FROM document_store_metadata WHERE key=?').get('schema_version') as {value:string}|undefined;
    if(metadata?.value!=='5')throw new Error('workflow_metadata_invalid');
    this.assertKnownSchema(v5TableLayouts,v5Indexes);
    this.assertV4OwnerConstraints();
    this.assertPrimaryColumns('fcl_quote_revisions',['quote_id','version']);
  }
  private assertV4Schema():void{
    const metadata=this.db.prepare('SELECT value FROM document_store_metadata WHERE key=?').get('schema_version') as {value:string}|undefined;
    if(metadata?.value!=='4')throw new Error('workflow_metadata_invalid');
    this.assertKnownV4Schema();
  }
  private assertFreshFixtureEmpty():void{
    const tables=['document_configs','quote_documents','document_idempotency','document_audit','document_pdfs','document_revisions','document_current_revisions','document_revision_events','document_native_prepare_credentials','fcl_quote_revisions'];
    for(const table of tables){
      const exists=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if(exists&&this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())throw new PortalError('fcl_upgrade_fresh_fixture_not_empty');
    }
  }
  private assertV4UpgradeOwnership():void{
    try{this.store.assertExclusiveOwnership();}catch{throw new PortalError('fcl_upgrade_old_writer_open');}
    const fclOptions=this.fclStoreOptions;
    const mode=fclOptions?.mode??(this.ownershipMode==='fresh-fixture'?'fresh_fixture':'exclusive_verified');
    if(mode==='reopen')throw new PortalError('fcl_schema_not_upgraded');
    if(mode==='fresh_fixture'){
      if(fclOptions&&fclOptions.mode==='fresh_fixture'&&(!fclOptions.authorized||!fclOptions.oldWritersStopped))throw new PortalError('fcl_upgrade_not_authorized');
      if(!fclOptions&&(!this.oldWritersStopped||this.ownershipMode!=='fresh-fixture'))throw new PortalError('fcl_upgrade_not_authorized');
      this.assertFreshFixtureEmpty();
      return;
    }
    if(fclOptions&&fclOptions.mode==='exclusive_verified'&&(!fclOptions.authorized||!fclOptions.oldWritersStopped))throw new PortalError('fcl_upgrade_not_authorized');
    if(!fclOptions&&!this.oldWritersStopped)throw new PortalError('fcl_upgrade_not_authorized');
    if(fclOptions?.mode==='exclusive_verified'&&fclOptions.assertExclusive){
      try{fclOptions.assertExclusive();}catch{throw new PortalError('fcl_upgrade_ownership_unverified');}
    }
    try{this.externalHandleProbe(this.store.path);}catch(error){
      if(error instanceof PortalError&&error.code==='document_v3_upgrade_old_writer_open')throw new PortalError('fcl_upgrade_old_writer_open');
      throw new PortalError('fcl_upgrade_ownership_unverified');
    }
  }
  private createV3Tables():void{
    this.db.exec(`CREATE TABLE IF NOT EXISTS document_store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_revisions(revision_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,org TEXT NOT NULL,owner TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,schema_version INTEGER NOT NULL,payload TEXT NOT NULL,input_digest TEXT NOT NULL,template_digest TEXT NOT NULL,source_revision_id TEXT,review_hash TEXT,rejection_reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version));
CREATE TABLE IF NOT EXISTS document_current_revisions(document_id TEXT PRIMARY KEY,org TEXT NOT NULL,owner TEXT NOT NULL,revision_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,schema_version INTEGER NOT NULL,projection_digest TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_revision_events(audit_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_native_prepare_credentials(binding_hash TEXT PRIMARY KEY,org TEXT NOT NULL,actor TEXT NOT NULL,document_kind TEXT NOT NULL,case_ref TEXT,binding_digest TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_revisions_document ON document_revisions(document_id,version DESC);
CREATE INDEX IF NOT EXISTS document_current_org ON document_current_revisions(org,updated_at DESC);`);
  }
  private migrateV4Tables():void{
    this.db.exec(`CREATE TABLE document_configs_v4(org TEXT UNIQUE,personal_owner_id TEXT UNIQUE,version INTEGER NOT NULL,input TEXT NOT NULL,CHECK((org IS NULL)!=(personal_owner_id IS NULL)));
INSERT INTO document_configs_v4(org,personal_owner_id,version,input) SELECT org,NULL,version,input FROM document_configs;
CREATE TABLE document_revisions_v4(revision_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,org TEXT,personal_owner_id TEXT,owner TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,schema_version INTEGER NOT NULL,payload TEXT NOT NULL,input_digest TEXT NOT NULL,template_digest TEXT NOT NULL,source_revision_id TEXT,review_hash TEXT,rejection_reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version),CHECK((org IS NULL)!=(personal_owner_id IS NULL)));
INSERT INTO document_revisions_v4(revision_id,document_id,org,personal_owner_id,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at) SELECT revision_id,document_id,org,NULL,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at FROM document_revisions;
CREATE TABLE document_current_revisions_v4(document_id TEXT PRIMARY KEY,org TEXT,personal_owner_id TEXT,owner TEXT NOT NULL,revision_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,schema_version INTEGER NOT NULL,projection_digest TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK((org IS NULL)!=(personal_owner_id IS NULL)));
INSERT INTO document_current_revisions_v4(document_id,org,personal_owner_id,owner,revision_id,version,schema_version,projection_digest,updated_at) SELECT document_id,org,NULL,owner,revision_id,version,schema_version,projection_digest,updated_at FROM document_current_revisions;
CREATE TABLE document_audit_v4(id TEXT PRIMARY KEY,org TEXT,personal_owner_id TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,created TEXT NOT NULL,CHECK((org IS NULL)!=(personal_owner_id IS NULL)));
INSERT INTO document_audit_v4(id,org,personal_owner_id,actor,action,digest,created) SELECT id,org,NULL,actor,action,digest,created FROM document_audit;
DROP TABLE document_configs;
DROP TABLE document_revisions;
DROP TABLE document_current_revisions;
DROP TABLE document_audit;
ALTER TABLE document_configs_v4 RENAME TO document_configs;
ALTER TABLE document_revisions_v4 RENAME TO document_revisions;
ALTER TABLE document_current_revisions_v4 RENAME TO document_current_revisions;
ALTER TABLE document_audit_v4 RENAME TO document_audit;
CREATE INDEX document_revisions_document ON document_revisions(document_id,version DESC);
CREATE INDEX document_revisions_personal ON document_revisions(personal_owner_id,document_id,version DESC);
CREATE INDEX document_current_org ON document_current_revisions(org,updated_at DESC);
CREATE INDEX document_current_personal ON document_current_revisions(personal_owner_id,updated_at DESC);
CREATE INDEX document_audit_personal ON document_audit(personal_owner_id,created DESC);`);
  }
  private createV5Tables():void{
    this.db.exec(`CREATE TABLE fcl_quote_revisions(quote_id TEXT NOT NULL,version INTEGER NOT NULL,personal_owner_id TEXT NOT NULL,case_ref TEXT NOT NULL,payload TEXT NOT NULL,content_digest TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(quote_id,version));
CREATE INDEX fcl_quote_revisions_owner ON fcl_quote_revisions(personal_owner_id,created_at DESC,quote_id DESC);
CREATE INDEX fcl_quote_revisions_case ON fcl_quote_revisions(personal_owner_id,case_ref,quote_id,version DESC);`);
  }
  private migrateToV5(initialVersion:number):void{
    this.assertV4UpgradeOwnership();
    const db=this.db;
    db.exec('BEGIN EXCLUSIVE');
    try{
      const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      if(version!==initialVersion)throw new Error('workflow_upgrade_ownership_conflict');
      if(version>5)throw new Error('workflow_schema_incompatible');
      if(version===5)throw new Error('workflow_upgrade_ownership_conflict');
      if(version<3){
        this.createV3Tables();
        db.prepare('INSERT INTO document_store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version','3');
        db.prepare('INSERT INTO document_store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('workflow_signing_secret',this.signingSecret);
        db.exec('PRAGMA user_version=3;');
      }else{
        const existing=db.prepare('SELECT value FROM document_store_metadata WHERE key=?').get('workflow_signing_secret') as {value:string}|undefined;
        if(!existing||existing.value!==this.signingSecret)throw new Error('workflow_upgrade_ownership_conflict');
      }
      if(version<4){
        this.assertKnownV3Schema();
        this.migrateV4Tables();
        db.prepare('INSERT INTO document_store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version','4');
        db.exec('PRAGMA user_version=4;');
        this.assertV4Schema();
      }else{
        this.assertV4Schema();
      }
      this.createV5Tables();
      db.prepare('INSERT INTO document_store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version','5');
      db.prepare('INSERT INTO document_store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('workflow_signing_secret',this.signingSecret);
      db.exec('PRAGMA user_version=5;');
      this.assertV5Schema();
      db.exec('COMMIT');
      this.schemaReady=true;
      this.fclReady=true;
      this.quoteReady=true;
    }catch(error){
      db.exec('ROLLBACK');
      throw error;
    }
  }
  private ensureCredentialTable(){this.db.exec('CREATE TABLE IF NOT EXISTS document_native_prepare_credentials(binding_hash TEXT PRIMARY KEY,org TEXT NOT NULL,actor TEXT NOT NULL,document_kind TEXT NOT NULL,case_ref TEXT,binding_digest TEXT NOT NULL,created_at TEXT NOT NULL);');}
  rememberPrepareCredential(input:{bindingHash:string;org:string;actor:string;documentKind:StoredPayload['document_kind'];caseRef:string|null;bindingDigest:string}){
    this.ensureWritable();
    this.db.prepare('INSERT INTO document_native_prepare_credentials VALUES(?,?,?,?,?,?,?) ON CONFLICT(binding_hash) DO UPDATE SET org=excluded.org,actor=excluded.actor,document_kind=excluded.document_kind,case_ref=excluded.case_ref,binding_digest=excluded.binding_digest,created_at=excluded.created_at').run(input.bindingHash,input.org,input.actor,input.documentKind,input.caseRef,input.bindingDigest,new Date().toISOString());
  }
  nativePrepareCredential(bindingHash:string){if(!this.schemaReady||!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_native_prepare_credentials'").get())return null;return this.db.prepare('SELECT org,actor,document_kind,case_ref,binding_digest FROM document_native_prepare_credentials WHERE binding_hash=?').get(bindingHash) as {org:string;actor:string;document_kind:StoredPayload['document_kind'];case_ref:string|null;binding_digest:string}|undefined??null;}
  private upgrade():void{
    if(this.schemaReady){if(!this.fclReady)this.ensureCredentialTable();return;}
    if(this.readOnly)throw new PortalError('document_v3_rollback_read_only');
    if(!this.oldWritersStopped)throw new PortalError('document_v3_upgrade_ownership_required');
    try{this.store.assertExclusiveOwnership();}catch{throw new PortalError('document_v3_upgrade_old_writer_open');}
    if(this.ownershipMode==='fresh-fixture'){
      const existingTables=['document_configs','quote_documents','document_idempotency','document_audit','document_pdfs'];
      if(existingTables.some(table=>this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))throw new PortalError('document_v3_upgrade_ownership_unverified');
    }else{
      this.externalHandleProbe(this.store.path);
    }
    const db=this.db;
    db.exec('BEGIN EXCLUSIVE');
    try{
      const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      if(version>3)throw new Error('workflow_schema_incompatible');
      if(version===3){
        const existing=db.prepare('SELECT value FROM document_store_metadata WHERE key=?').get('workflow_signing_secret') as {value:string}|undefined;
        if(!existing||existing.value!==this.signingSecret)throw new Error('workflow_upgrade_ownership_conflict');
        this.schemaReady=true;
        db.exec('COMMIT');
        return;
      }
      db.exec(`CREATE TABLE IF NOT EXISTS document_store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_revisions(revision_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,org TEXT NOT NULL,owner TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,schema_version INTEGER NOT NULL,payload TEXT NOT NULL,input_digest TEXT NOT NULL,template_digest TEXT NOT NULL,source_revision_id TEXT,review_hash TEXT,rejection_reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version));
CREATE TABLE IF NOT EXISTS document_current_revisions(document_id TEXT PRIMARY KEY,org TEXT NOT NULL,owner TEXT NOT NULL,revision_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,schema_version INTEGER NOT NULL,projection_digest TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_revision_events(audit_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,revision_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_native_prepare_credentials(binding_hash TEXT PRIMARY KEY,org TEXT NOT NULL,actor TEXT NOT NULL,document_kind TEXT NOT NULL,case_ref TEXT,binding_digest TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_revisions_document ON document_revisions(document_id,version DESC);
CREATE INDEX IF NOT EXISTS document_current_org ON document_current_revisions(org,updated_at DESC);`);
      db.prepare('INSERT INTO document_store_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version','3');
      db.prepare('INSERT INTO document_store_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('workflow_signing_secret',this.signingSecret);
      db.exec('PRAGMA user_version=3; COMMIT');
      this.schemaReady=true;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  close(){void this.store;}
  isV3(){return this.schemaReady;}
  isV4(){return this.fclReady;}
  isV5(){return this.quoteReady;}
  ensureWritable(){if(this.readOnly)throw new PortalError('document_v3_rollback_read_only');this.upgrade();}
  health(){try{const version=Number((this.store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);if(version<=2)return true;this.store.db.prepare('SELECT revision_id FROM document_revisions LIMIT 1').get();return true;}catch{return false;}}
}

export class DocumentWorkflowService{
  private readonly secret;
  private readonly reviews=new Map<string,{kind:'enterprise';id:string;version:number;revision_id:string|null;content_digest:string;expires:number;actor:string}|{kind:'fcl';id:string;version:number;revision_id:string;content_digest:string;expires:number;reviewed_at:string;review_expires_at:string;actor:string}>();
  private readonly fcl:NormalizedFclDocumentWorkflowOptions|null;
  private readonly fclQuote:FclQuoteWorkflowDependencies|null;
  constructor(
    readonly store:DocumentWorkflowStore,
    private readonly legacy:DocumentService,
    private readonly portal:Pick<PortalService,'getState'>,
    private readonly renderer:(html:string)=>Promise<Buffer>=renderPdf,
    fclOptions?:FclDocumentWorkflowOptions,
    fclQuote?:FclQuoteWorkflowDependencies,
  ){
    this.secret=store.signingSecret;
    this.fcl=fclOptions?this.normalizeFclOptions(fclOptions):null;
    if(this.fcl)this.assertFclStartup(this.fcl);
    this.fclQuote=fclQuote??null;
    if(this.fclQuote&&!this.store.isV5())throw new Error('fcl_quote_upgrade_not_authorized');
  }

  private normalizeFclOptions(options:FclDocumentWorkflowOptions):NormalizedFclDocumentWorkflowOptions{
    if(!this.store.isV4())throw new Error('fcl_upgrade_not_authorized');
    if(!options.receiverUserId.trim())throw new Error('fcl_receiver_configuration_invalid');
    const now=options.now??(()=>new Date().toISOString());
    let initialNow:string;
    try{initialNow=now();}catch{throw new Error('fcl_clock_invalid');}
    if(!z.iso.datetime().safeParse(initialNow).success)throw new Error('fcl_clock_invalid');
    return {receiverUserId:options.receiverUserId,receiverIsActive:options.receiverIsActive,now};
  }
  private fclTimestamp(options:NormalizedFclDocumentWorkflowOptions):string{
    let value:string;
    try{value=options.now();}catch{throw new PortalError('fcl_clock_invalid');}
    if(!z.iso.datetime().safeParse(value).success)throw new PortalError('fcl_clock_invalid');
    return value;
  }
  private assertFclStartup(options:NormalizedFclDocumentWorkflowOptions):void{
    let active:boolean;
    try{active=options.receiverIsActive(options.receiverUserId);}catch{active=false;}
    if(!active)throw new Error('fcl_receiver_unavailable');
    const owners=this.store.db.prepare(`SELECT personal_owner_id AS owner_id FROM document_configs WHERE personal_owner_id IS NOT NULL
      UNION SELECT personal_owner_id FROM document_revisions WHERE personal_owner_id IS NOT NULL
      UNION SELECT personal_owner_id FROM document_current_revisions WHERE personal_owner_id IS NOT NULL
      UNION SELECT personal_owner_id FROM document_audit WHERE personal_owner_id IS NOT NULL${this.store.isV5()?' UNION SELECT personal_owner_id FROM fcl_quote_revisions WHERE personal_owner_id IS NOT NULL':''}`).all() as Array<{owner_id:string}>;
    if(owners.some(row=>row.owner_id!==options.receiverUserId))throw new Error('fcl_receiver_configuration_mismatch');
  }
  private fclOptions():NormalizedFclDocumentWorkflowOptions{
    if(!this.fcl)throw new PortalError('fcl_unavailable');
    return this.fcl;
  }
  private requireFclReceiver(ctx:PortalContext):NormalizedFclDocumentWorkflowOptions{
    const options=this.fclOptions();
    if(!ctx.identity.emailVerified||ctx.organizationId!==null||ctx.identity.userId!==options.receiverUserId)throw new PortalError('fcl_not_found');
    let active:boolean;
    try{active=options.receiverIsActive(options.receiverUserId);}catch{active=false;}
    if(!active)throw new PortalError('fcl_unavailable');
    return options;
  }
  private fclConfigRaw(personalOwnerId:string):FclConfigView{
    const row=this.store.db.prepare('SELECT version,input FROM document_configs WHERE org IS NULL AND personal_owner_id=?').get(personalOwnerId) as {version:number;input:string}|undefined;
    let input:unknown=null;
    if(row){
      try{input=JSON.parse(row.input);}catch{throw new PortalError('document_readback_failed');}
    }
    const parsed=fclConfigViewSchema.safeParse({contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,version:row?.version??0,input,catalog:standardFeeTemplate});
    if(!parsed.success)throw new PortalError('document_readback_failed');
    return parsed.data;
  }
  fclConfig(ctx:PortalContext):FclConfigView{
    const options=this.requireFclReceiver(ctx);
    return this.fclConfigRaw(options.receiverUserId);
  }
  private assertFclCommitted(input:{personalOwnerId:string;version:number;input:unknown;auditId:string;partition:string;key:string;digest:string;created:string}):void{
    const readback=this.fclConfigRaw(input.personalOwnerId);
    if(readback.version!==input.version||canonicalHash(readback.input)!==canonicalHash(input.input))throw new PortalError('document_readback_failed');
    const audit=this.store.db.prepare('SELECT org,personal_owner_id,actor,action,digest,created FROM document_audit WHERE id=?').get(input.auditId) as {org:string|null;personal_owner_id:string|null;actor:string;action:string;digest:string;created:string}|undefined;
    if(!audit||audit.org!==null||audit.personal_owner_id!==input.personalOwnerId||audit.actor!==input.personalOwnerId||audit.action!=='fcl-config-save'||audit.digest!==input.digest||audit.created!==input.created)throw new PortalError('document_readback_failed');
    const idempotency=this.store.db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(input.partition,input.key) as {digest:string;result:string}|undefined;
    if(!idempotency||idempotency.digest!==input.digest)throw new PortalError('document_readback_failed');
    let persisted:FclConfigView;
    try{persisted=fclConfigViewSchema.parse(JSON.parse(idempotency.result));}catch{throw new PortalError('document_readback_failed');}
    if(canonicalHash(persisted)!==canonicalHash(readback))throw new PortalError('document_readback_failed');
  }
  saveFclConfig(ctx:PortalContext,input:unknown,key:string):FclConfigView{
    const options=this.requireFclReceiver(ctx);
    const data=parse(fclConfigSaveSchema,input);
    const createdAt=this.fclTimestamp(options);
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    this.store.ensureWritable();
    const partition=JSON.stringify(['v4-personal',options.receiverUserId,ctx.identity.userId,'fcl-config-save']),digest=canonicalHash(data),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    let committed=false;
    try{
      const old=db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){
        if(old.digest!==digest)throw new PortalError('idempotency_conflict');
        this.requireFclReceiver(ctx);
        db.exec('COMMIT');
        committed=true;
        return this.fclConfigRaw(options.receiverUserId);
      }
      const current=this.fclConfigRaw(options.receiverUserId);
      if(current.version!==data.expected_version)throw new PortalError('version_conflict');
      const nextVersion=data.expected_version+1;
      const committedView:FclConfigView=fclConfigViewSchema.parse({
        contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,
        version:nextVersion,
        input:data.input,
        catalog:standardFeeTemplate,
      });
      db.prepare('INSERT INTO document_configs(org,personal_owner_id,version,input) VALUES(?,?,?,?) ON CONFLICT(personal_owner_id) DO UPDATE SET version=excluded.version,input=excluded.input').run(null,options.receiverUserId,nextVersion,JSON.stringify(data.input));
      const auditId=randomUUID();
      db.prepare('INSERT INTO document_audit(id,org,personal_owner_id,actor,action,digest,created) VALUES(?,?,?,?,?,?,?)').run(auditId,null,options.receiverUserId,ctx.identity.userId,'fcl-config-save',digest,createdAt);
      db.prepare('INSERT INTO document_idempotency(scope,key,digest,result) VALUES(?,?,?,?)').run(partition,key,digest,JSON.stringify(committedView));
      this.assertFclCommitted({personalOwnerId:options.receiverUserId,version:nextVersion,input:data.input,auditId,partition,key,digest,created:createdAt});
      this.requireFclReceiver(ctx);
      db.exec('COMMIT');
      committed=true;
      this.assertFclCommitted({personalOwnerId:options.receiverUserId,version:nextVersion,input:data.input,auditId,partition,key,digest,created:createdAt});
      return this.fclConfigRaw(options.receiverUserId);
    }catch(error){
      if(!committed)db.exec('ROLLBACK');
      if(committed&&!(error instanceof PortalError))throw new PortalError('document_readback_failed');
      throw error;
    }
  }
  private fclQuoteDependencies():FclQuoteWorkflowDependencies{
    if(!this.fclQuote||!this.store.isV5())throw new PortalError('fcl_quote_unavailable');
    return this.fclQuote;
  }
  private readFclQuote(personalOwnerId:string,quoteRef:string,requestedVersion:number|null):{snapshot:ReturnType<typeof validateFclQuoteSnapshot>;currentVersion:number}{
    const current=this.store.db.prepare('SELECT MAX(version) AS version FROM fcl_quote_revisions WHERE personal_owner_id=? AND quote_id=?').get(personalOwnerId,quoteRef) as {version:number|null}|undefined;
    if(!current?.version)throw new PortalError('fcl_quote_not_found');
    const version=requestedVersion??current.version;
    const row=this.store.db.prepare('SELECT quote_id,version,personal_owner_id,case_ref,payload,content_digest,actor,created_at FROM fcl_quote_revisions WHERE personal_owner_id=? AND quote_id=? AND version=?').get(personalOwnerId,quoteRef,version) as {quote_id:string;version:number;personal_owner_id:string;case_ref:string;payload:string;content_digest:string;actor:string;created_at:string}|undefined;
    if(!row)throw new PortalError('fcl_quote_not_found');
    let snapshot:ReturnType<typeof validateFclQuoteSnapshot>;
    try{snapshot=validateFclQuoteSnapshot(JSON.parse(row.payload));}catch{throw new PortalError('fcl_quote_readback_failed');}
    if(snapshot.quote_ref!==row.quote_id||snapshot.version!==row.version||row.quote_id!==quoteRef||row.version!==version||row.personal_owner_id!==personalOwnerId||row.case_ref!==snapshot.case_binding.case_ref||row.content_digest!==snapshot.content_digest||row.actor!==snapshot.actor||row.created_at!==snapshot.created_at)throw new PortalError('fcl_quote_readback_failed');
    return {snapshot,currentVersion:current.version};
  }
  private fclQuoteCurrentness(ctx:PortalContext,snapshot:ReturnType<typeof validateFclQuoteSnapshot>,currentVersion:number,options:NormalizedFclDocumentWorkflowOptions):FclQuoteCurrentness{
    const reasons=new Set<string>();
    const dependencies=this.fclQuoteDependencies();
    if(snapshot.version<currentVersion)reasons.add('fcl_quote_not_current_version');
    try{
      const caseView=dependencies.caseReader.getFclCase(ctx,snapshot.case_binding.case_ref);
      if(caseView.case_version!==snapshot.case_binding.case_version)reasons.add('fcl_quote_case_version_changed');
      if(caseView.review_context.latest_customer_supplement_ref!==snapshot.case_binding.latest_customer_supplement_ref)reasons.add('fcl_quote_case_supplement_changed');
      if(caseView.case_status==='closed'||caseView.case_status==='cancelled')reasons.add('fcl_quote_case_closed');
      if(caseView.case_status==='submitted'||caseView.case_status==='needs_input'||caseView.review_context.review_required)reasons.add('fcl_quote_case_review_required');
    }catch{reasons.add('fcl_quote_case_unavailable');}
    try{
      const release=dependencies.rateReader.get(ctx,'fcl').active_release;
      if(!release)reasons.add('fcl_quote_source_unavailable');
      else if(release.release_id!==snapshot.source_snapshot.release_id||release.version!==snapshot.source_snapshot.release_version||release.digest!==snapshot.source_snapshot.dataset_digest)reasons.add('fcl_quote_source_release_changed');
      else{
        const rate=(release.input as FclRateDataset).rates.find(candidate=>candidate.rate_id===snapshot.source_snapshot.rate_id);
        if(!rate||canonicalHash(rate)!==canonicalHash(snapshot.source_snapshot.rate))reasons.add('fcl_quote_source_rate_changed');
      }
    }catch{reasons.add('fcl_quote_source_unavailable');}
    const today=this.fclTimestamp(options).slice(0,10);
    if(today<snapshot.source_snapshot.valid_from||today>snapshot.source_snapshot.valid_until)reasons.add('fcl_quote_source_expired');
    return {valid_now:reasons.size===0,reason_codes:[...reasons]};
  }
  private fclQuoteView(snapshot:ReturnType<typeof validateFclQuoteSnapshot>,currentVersion:number,replay:{replayed:boolean;submittedVersion:number|null},currentness:FclQuoteCurrentness):FclQuoteView{
    return fclQuoteViewSchema.parse({
      ...snapshot,
      current_version:currentVersion,
      historical:snapshot.version<currentVersion,
      currentness,
      replay:{replayed:replay.replayed,submitted_version:replay.submittedVersion,current:snapshot.version===currentVersion},
    });
  }
  private assertFclQuoteMatch(
    status:'success'|'needs_input'|'manual_review'|'blocked'|'unavailable',
    selected:{rate_id:string;release_id:string;release_version:number;dataset_digest:string}|null,
    expected:{selected_rate_id:string;expected_release_id:string;expected_release_version:number;expected_dataset_digest:string},
  ):void{
    if(status!=='success'||!selected){
      if(status==='blocked')throw new PortalError('fcl_quote_binding_conflict');
      if(status==='needs_input')throw new PortalError('fcl_quote_case_incomplete');
      throw new PortalError('fcl_quote_source_unavailable');
    }
    if(selected.rate_id!==expected.selected_rate_id||selected.release_id!==expected.expected_release_id||selected.release_version!==expected.expected_release_version||selected.dataset_digest!==expected.expected_dataset_digest)throw new PortalError('fcl_quote_source_changed');
  }
  private assertFclQuoteCommitted(input:{personalOwnerId:string;quoteRef:string;version:number;contentDigest:string;actor:string;createdAt:string;auditId:string;partition:string;key:string;requestDigest:string}):void{
    const read=this.readFclQuote(input.personalOwnerId,input.quoteRef,input.version);
    const snapshot=read.snapshot;
    if(snapshot.content_digest!==input.contentDigest||snapshot.actor!==input.actor||snapshot.created_at!==input.createdAt)throw new PortalError('fcl_quote_readback_failed');
    const audit=this.store.db.prepare('SELECT org,personal_owner_id,actor,action,digest,created FROM document_audit WHERE id=?').get(input.auditId) as {org:string|null;personal_owner_id:string|null;actor:string;action:string;digest:string;created:string}|undefined;
    if(!audit||audit.org!==null||audit.personal_owner_id!==input.personalOwnerId||audit.actor!==input.actor||audit.action!==`fcl-quote-${snapshot.version===1?'create':'update'}`||audit.digest!==input.requestDigest||audit.created!==input.createdAt)throw new PortalError('fcl_quote_readback_failed');
    const idempotency=this.store.db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(input.partition,input.key) as {digest:string;result:string}|undefined;
    if(!idempotency||idempotency.digest!==input.requestDigest)throw new PortalError('fcl_quote_readback_failed');
    try{
      const result=fclQuoteReferenceSchema.parse(JSON.parse(idempotency.result));
      if(result.quote_ref!==input.quoteRef||result.version!==input.version)throw new Error('mismatch');
    }catch{throw new PortalError('fcl_quote_readback_failed');}
  }
  private saveFclQuoteLocked(ctx:PortalContext,options:NormalizedFclDocumentWorkflowOptions,input:unknown,key:string):FclQuoteView{
    const request=parse(fclQuoteSaveRequestSchema,input,'fcl_quote_input_invalid');
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    const dependencies=this.fclQuoteDependencies();
    const action=`fcl-quote-${request.operation}`;
    const target=request.operation==='update'?request.quote_ref:'create';
    const partition=JSON.stringify(['v5-personal',options.receiverUserId,ctx.identity.userId,action,target]);
    const requestDigest=canonicalHash(request),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    let committed=false;
    try{
      const old=db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){
        if(old.digest!==requestDigest)throw new PortalError('idempotency_conflict');
        let submitted:{quote_ref:string;version:number};
        try{submitted=fclQuoteReferenceSchema.parse(JSON.parse(old.result));}catch{throw new PortalError('fcl_quote_readback_failed');}
        this.requireFclReceiver(ctx);
        db.exec('COMMIT');
        committed=true;
        const read=this.readFclQuote(options.receiverUserId,submitted.quote_ref,submitted.version);
        dependencies.caseReader.getFclCase(ctx,read.snapshot.case_binding.case_ref);
        return this.fclQuoteView(read.snapshot,read.currentVersion,{replayed:true,submittedVersion:submitted.version},this.fclQuoteCurrentness(ctx,read.snapshot,read.currentVersion,options));
      }
      let quoteRef:string,version:number,selected;
      let caseBinding,caseProjection,caseView;
      if(request.operation==='create'){
        quoteRef=randomUUID();version=1;
        caseView=dependencies.caseReader.getFclCase(ctx,request.case_ref);
        if(caseView.case_status==='closed'||caseView.case_status==='cancelled')throw new PortalError('fcl_quote_case_closed');
        const match=dependencies.quoteService.match(ctx,{contract_version:FCL_QUOTE_WORKFLOW_VERSION,case_ref:request.case_ref,expected_case_version:request.expected_case_version,expected_customer_supplement_ref:request.expected_customer_supplement_ref,selected_rate_id:request.selected_rate_id});
        this.assertFclQuoteMatch(match.status,match.data.selected,request);
        selected=match.data.selected!;
        caseBinding={case_ref:request.case_ref,case_version:request.expected_case_version,latest_customer_supplement_ref:request.expected_customer_supplement_ref};
      }else{
        const existing=this.readFclQuote(options.receiverUserId,request.quote_ref,null);
        if(existing.snapshot.version!==request.expected_version)throw new PortalError('version_conflict');
        const caseRef=existing.snapshot.case_binding.case_ref;
        caseView=dependencies.caseReader.getFclCase(ctx,caseRef);
        if(caseView.case_status==='closed'||caseView.case_status==='cancelled')throw new PortalError('fcl_quote_case_closed');
        quoteRef=request.quote_ref;version=request.expected_version+1;
        if(request.source_binding.mode==='retain'){
          selected=existing.snapshot.source_snapshot;
          caseBinding=existing.snapshot.case_binding;
          caseProjection=existing.snapshot.case_projection;
        }else{
          const match=dependencies.quoteService.match(ctx,{contract_version:FCL_QUOTE_WORKFLOW_VERSION,case_ref:caseRef,expected_case_version:request.source_binding.expected_case_version,expected_customer_supplement_ref:request.source_binding.expected_customer_supplement_ref,selected_rate_id:request.source_binding.selected_rate_id});
          this.assertFclQuoteMatch(match.status,match.data.selected,request.source_binding);
          selected=match.data.selected!;
          caseBinding={case_ref:caseRef,case_version:request.source_binding.expected_case_version,latest_customer_supplement_ref:request.source_binding.expected_customer_supplement_ref};
        }
      }
      const createdAt=this.fclTimestamp(options);
      const snapshot=buildFclCostSellSnapshot({contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:quoteRef,version,actor:ctx.identity.userId,created_at:createdAt,caseView,selected,input:request.input,...(caseBinding===undefined?{}:{case_binding:caseBinding}),...(caseProjection===undefined?{}:{case_projection:caseProjection})});
      db.prepare('INSERT INTO fcl_quote_revisions(quote_id,version,personal_owner_id,case_ref,payload,content_digest,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').run(quoteRef,version,options.receiverUserId,snapshot.case_binding.case_ref,JSON.stringify(snapshot),snapshot.content_digest,ctx.identity.userId,createdAt);
      const auditId=randomUUID();
      db.prepare('INSERT INTO document_audit(id,org,personal_owner_id,actor,action,digest,created) VALUES(?,?,?,?,?,?,?)').run(auditId,null,options.receiverUserId,ctx.identity.userId,`fcl-quote-${request.operation}`,requestDigest,createdAt);
      db.prepare('INSERT INTO document_idempotency(scope,key,digest,result) VALUES(?,?,?,?)').run(partition,key,requestDigest,JSON.stringify({quote_ref:quoteRef,version}));
      this.assertFclQuoteCommitted({personalOwnerId:options.receiverUserId,quoteRef,version,contentDigest:snapshot.content_digest,actor:ctx.identity.userId,createdAt,auditId,partition,key,requestDigest});
      this.requireFclReceiver(ctx);
      db.exec('COMMIT');
      committed=true;
      this.assertFclQuoteCommitted({personalOwnerId:options.receiverUserId,quoteRef,version,contentDigest:snapshot.content_digest,actor:ctx.identity.userId,createdAt,auditId,partition,key,requestDigest});
      const read=this.readFclQuote(options.receiverUserId,quoteRef,version);
      return this.fclQuoteView(read.snapshot,read.currentVersion,{replayed:false,submittedVersion:null},this.fclQuoteCurrentness(ctx,read.snapshot,read.currentVersion,options));
    }catch(error){
      if(!committed)db.exec('ROLLBACK');
      if(committed&&!(error instanceof PortalError))throw new PortalError('fcl_quote_readback_failed');
      throw error;
    }
  }
  saveFclQuote(ctx:PortalContext,input:unknown,key:string):FclQuoteView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies();
    this.store.ensureWritable();
    return dependencies.caseLock.withFclReadLock(ctx,()=>dependencies.rateLock.withFclReadLock(ctx,()=>this.saveFclQuoteLocked(ctx,options,input,key)));
  }
  getFclQuote(ctx:PortalContext,input:unknown):FclQuoteView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclQuoteGetRequestSchema,input,'fcl_quote_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>{
      const read=this.readFclQuote(options.receiverUserId,request.quote_ref,request.version);
      dependencies.caseReader.getFclCase(ctx,read.snapshot.case_binding.case_ref);
      return this.fclQuoteView(read.snapshot,read.currentVersion,{replayed:false,submittedVersion:null},this.fclQuoteCurrentness(ctx,read.snapshot,read.currentVersion,options));
    });
  }
  listFclQuotes(ctx:PortalContext,input:unknown){
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclQuoteListRequestSchema,input,'fcl_quote_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>{
      dependencies.caseReader.getFclCase(ctx,request.case_ref);
      let cursor:{case_ref:string;at:string;quote_ref:string}|null=null;
      if(request.cursor){
        try{
          cursor=z.object({case_ref:z.string().uuid(),at:z.iso.datetime(),quote_ref:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8')));
        }catch{throw new PortalError('fcl_quote_input_invalid');}
        if(cursor.case_ref!==request.case_ref)throw new PortalError('fcl_quote_input_invalid');
      }
      const rows=this.store.db.prepare(`SELECT q.quote_id,q.version,q.created_at FROM fcl_quote_revisions q WHERE q.personal_owner_id=? AND q.case_ref=? AND q.version=(SELECT MAX(m.version) FROM fcl_quote_revisions m WHERE m.quote_id=q.quote_id AND m.personal_owner_id=q.personal_owner_id) AND (? IS NULL OR q.created_at<? OR (q.created_at=? AND q.quote_id<?)) ORDER BY q.created_at DESC,q.quote_id DESC LIMIT ?`).all(options.receiverUserId,request.case_ref,cursor?.at??null,cursor?.at??'',cursor?.at??'',cursor?.quote_ref??'',request.limit+1) as Array<{quote_id:string;version:number;created_at:string}>;
      const page=rows.slice(0,request.limit);
      return fclQuoteListSchema.parse({
        items:page.map(row=>{
          const read=this.readFclQuote(options.receiverUserId,row.quote_id,row.version);
          return {
            quote_ref:row.quote_id,
            version:row.version,
            current_version:read.currentVersion,
            case_ref:request.case_ref,
            case_version:read.snapshot.case_binding.case_version,
            rate_id:read.snapshot.source_snapshot.rate_id,
            release_id:read.snapshot.source_snapshot.release_id,
            complete:read.snapshot.completeness.complete,
            by_currency:read.snapshot.calculation.by_currency,
            currentness:this.fclQuoteCurrentness(ctx,read.snapshot,read.currentVersion,options),
            created_at:row.created_at,
          };
        }),
        next_cursor:rows.length>request.limit&&page.at(-1)?Buffer.from(JSON.stringify({case_ref:request.case_ref,at:page.at(-1)!.created_at,quote_ref:page.at(-1)!.quote_id})).toString('base64url'):null,
      });
    });
  }
  private fclDocumentSignature(payload:Omit<FclDocumentPayload,'content_digest'|'signature'>):{content_digest:string;signature:string}{
    const content_digest=canonicalHash(payload);
    return {content_digest,signature:createHmac('sha256',this.secret).update(canonicalJson({domain:'fcl-linked-document',payload:{...payload,content_digest}})).digest('hex')};
  }
  private readFclDocument(personalOwnerId:string,documentId:string,requestedVersion:number|null):{payload:FclDocumentPayload;currentVersion:number}{
    const latest=this.store.db.prepare('SELECT MAX(version) AS version FROM document_revisions WHERE personal_owner_id=? AND document_id=?').get(personalOwnerId,documentId) as {version:number|null}|undefined;
    if(!latest?.version)throw new PortalError('fcl_document_not_found');
    const version=requestedVersion??latest.version;
    const row=this.store.db.prepare('SELECT revision_id,document_id,org,personal_owner_id,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at FROM document_revisions WHERE personal_owner_id=? AND document_id=? AND version=?').get(personalOwnerId,documentId,version) as {revision_id:string;document_id:string;org:string|null;personal_owner_id:string|null;owner:string;version:number;state:string;schema_version:number;payload:string;input_digest:string;template_digest:string;source_revision_id:string|null;review_hash:string|null;rejection_reason:string|null;created_by:string;created_at:string}|undefined;
    if(!row)throw new PortalError('fcl_document_not_found');
    let payload:FclDocumentPayload;
    try{payload=fclDocumentPayloadSchema.parse(JSON.parse(row.payload));}catch{throw new PortalError('fcl_document_readback_failed');}
    const expected=this.fclDocumentSignature(Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='content_digest'&&key!=='signature')) as unknown as Omit<FclDocumentPayload,'content_digest'|'signature'>);
    const prior=version>1?this.store.db.prepare('SELECT revision_id,payload FROM document_revisions WHERE personal_owner_id=? AND document_id=? AND version=?').get(personalOwnerId,documentId,version-1) as {revision_id:string;payload:string}|undefined:undefined;
    let priorPayload:FclDocumentPayload|undefined;
    try{priorPayload=prior?fclDocumentPayloadSchema.parse(JSON.parse(prior.payload)):undefined;}catch{throw new PortalError('fcl_document_readback_failed');}
    const priorExpected=priorPayload?this.fclDocumentSignature(Object.fromEntries(Object.entries(priorPayload).filter(([key])=>key!=='content_digest'&&key!=='signature')) as unknown as Omit<FclDocumentPayload,'content_digest'|'signature'>):null;
    const priorIntegrityValid=priorPayload!==undefined&&priorExpected!==null&&priorPayload.document_id===documentId&&priorPayload.personal_owner_id===personalOwnerId&&priorPayload.revision_id===prior?.revision_id&&priorPayload.version===version-1&&priorPayload.content_digest===priorExpected.content_digest&&priorPayload.signature===priorExpected.signature;
    const latestRow=this.store.db.prepare('SELECT revision_id,payload FROM document_revisions WHERE personal_owner_id=? AND document_id=? AND version=?').get(personalOwnerId,documentId,latest.version) as {revision_id:string;payload:string}|undefined;
    let latestPayload:FclDocumentPayload;
    try{latestPayload=fclDocumentPayloadSchema.parse(JSON.parse(latestRow?.payload??''));}catch{throw new PortalError('fcl_document_readback_failed');}
    const latestExpected=this.fclDocumentSignature(Object.fromEntries(Object.entries(latestPayload).filter(([key])=>key!=='content_digest'&&key!=='signature')) as unknown as Omit<FclDocumentPayload,'content_digest'|'signature'>);
    const event=this.store.db.prepare('SELECT audit_id,action FROM document_revision_events WHERE document_id=? AND revision_id=? AND version=?').get(documentId,row.revision_id,version) as {audit_id:string;action:string}|undefined;
    const audit=event?this.store.db.prepare('SELECT org,personal_owner_id,actor,action,created FROM document_audit WHERE id=?').get(event.audit_id) as {org:string|null;personal_owner_id:string|null;actor:string;action:string;created:string}|undefined:undefined;
    const currentRow=this.store.db.prepare('SELECT revision_id,org,personal_owner_id,owner,version,schema_version,projection_digest,updated_at FROM document_current_revisions WHERE document_id=?').get(documentId) as {revision_id:string;org:string|null;personal_owner_id:string|null;owner:string;version:number;schema_version:number;projection_digest:string;updated_at:string}|undefined;
    const decision=payload.decision??null;
    const expectedAction=payload.state==='draft'
      ?version===1?'fcl-document-create':priorPayload?.state==='rejected'?'fcl-document-resubmit':priorPayload?.state==='approved'?'fcl-document-re-quote':'fcl-document-refresh'
      :payload.state==='approved'?'fcl-document-approve':'fcl-document-reject';
    const reviewHash=payload.state==='approved'?decision?.review_hash??null:null;
    const rejectionReason=payload.state==='rejected'?decision?.reason??null:null;
    const decisionTimesValid=decision!==null&&decision.actor===payload.actor&&decision.at===payload.created_at&&(decision.kind!=='approved'||(decision.reviewed_at!==null&&decision.review_expires_at!==null&&Date.parse(decision.reviewed_at)<=Date.parse(decision.at)&&Date.parse(decision.at)<Date.parse(decision.review_expires_at)&&Date.parse(decision.review_expires_at)-Date.parse(decision.reviewed_at)<=600000));
    const decisionValid=payload.state==='draft'
      ?decision===null
      :decision!==null&&priorIntegrityValid&&priorPayload?.state==='draft'&&decisionTimesValid&&decision.kind===payload.state&&decision.source_revision_id===prior?.revision_id&&decision.source_version===version-1&&decision.source_content_digest===priorPayload?.content_digest&&(payload.state==='approved'?decision.approved_revision_id===row.revision_id&&decision.approved_version===version:true);
    if(!decisionValid||(version>1&&!priorIntegrityValid)||payload.content_digest!==expected.content_digest||payload.signature!==expected.signature||payload.document_kind!=='fcl_linked'||payload.personal_owner_id!==personalOwnerId||payload.document_id!==row.document_id||payload.revision_id!==row.revision_id||payload.version!==row.version||payload.version!==version||row.org!==null||row.personal_owner_id!==personalOwnerId||row.owner!==personalOwnerId||row.schema_version!==5||row.created_by!==payload.actor||row.created_at!==payload.created_at||row.input_digest!==canonicalHash(payload.customer_input)||row.template_digest!==canonicalHash(payload.template)||row.source_revision_id!==(decision?.source_revision_id??prior?.revision_id??null)||row.review_hash!==reviewHash||row.rejection_reason!==rejectionReason||row.state!==payload.state)throw new PortalError('fcl_document_readback_failed');
    if(version>1&&!prior)throw new PortalError('fcl_document_readback_failed');
    if(latestPayload.content_digest!==latestExpected.content_digest||latestPayload.signature!==latestExpected.signature||!currentRow||currentRow.version!==latest.version||currentRow.revision_id!==latestRow?.revision_id||currentRow.org!==null||currentRow.personal_owner_id!==personalOwnerId||currentRow.owner!==personalOwnerId||currentRow.schema_version!==5||currentRow.projection_digest!==latestPayload.content_digest||currentRow.updated_at!==latestPayload.updated_at)throw new PortalError('fcl_document_readback_failed');
    if(!event||event.action!==expectedAction||!audit||audit.org!==null||audit.personal_owner_id!==personalOwnerId||audit.actor!==payload.actor||audit.action!==expectedAction||audit.created!==payload.created_at)throw new PortalError('fcl_document_readback_failed');
    try{
      const quoted=this.readFclQuote(personalOwnerId,payload.quote_binding.quote_ref,payload.quote_binding.quote_version);
      if(quoted.snapshot.content_digest!==payload.quote_binding.quote_digest||canonicalHash(quoted.snapshot.case_binding)!==canonicalHash(payload.case_binding)||quoted.snapshot.source_snapshot.rate_id!==payload.source_binding.rate_id||quoted.snapshot.source_snapshot.release_id!==payload.source_binding.release_id||quoted.snapshot.source_snapshot.dataset_digest!==payload.source_binding.dataset_digest||canonicalHash(quoted.snapshot.source_snapshot.rate)!==payload.source_binding.rate_digest)throw new PortalError('fcl_document_readback_failed');
    }catch{throw new PortalError('fcl_document_readback_failed');}
    return {payload,currentVersion:latest.version};
  }
  private fclDocumentCurrentness(ctx:PortalContext,payload:FclDocumentPayload,currentVersion:number,options:NormalizedFclDocumentWorkflowOptions):FclQuoteCurrentness{
    const reasons=new Set<string>();
    if(payload.version<currentVersion)reasons.add('fcl_document_not_current_version');
    try{
      const quote=this.readFclQuote(options.receiverUserId,payload.quote_binding.quote_ref,payload.quote_binding.quote_version);
      const quoteCurrentness=this.fclQuoteCurrentness(ctx,quote.snapshot,quote.currentVersion,options);
      quoteCurrentness.reason_codes.forEach(reason=>reasons.add(reason));
      if(quote.currentVersion!==payload.quote_binding.quote_version)reasons.add('fcl_document_quote_changed');
    }catch{reasons.add('fcl_document_quote_unavailable');}
    try{
      const config=this.fclConfigRaw(options.receiverUserId);
      if(!config.input)reasons.add('fcl_document_template_unavailable');
      else if(config.version!==payload.template_version)reasons.add('fcl_document_template_changed');
    }catch{reasons.add('fcl_document_template_unavailable');}
    const today=this.fclTimestamp(options).slice(0,10);
    const quoteDate=payload.customer_input.quote_date,validUntil=payload.customer_input.valid_until;
    if(quoteDate===null||validUntil===null||quoteDate>today||today>validUntil)reasons.add('fcl_document_expired');
    return {valid_now:reasons.size===0,reason_codes:[...reasons]};
  }
  private fclDocumentView(payload:FclDocumentPayload,currentVersion:number,currentness:FclQuoteCurrentness,replay:{replayed:boolean;submitted_version:number|null;current:boolean}={replayed:false,submitted_version:null,current:payload.version===currentVersion}):FclDocumentView{
    return fclDocumentViewSchema.parse({...payload,current_version:currentVersion,historical:payload.version<currentVersion,currentness,replay});
  }
  private buildFclDocumentPayload(input:{
    documentId:string;revisionId:string;version:number;state:FclDocumentPayload['state'];actor:string;createdAt:string;updatedAt:string;
    quote:ReturnType<typeof validateFclQuoteSnapshot>;caseView:ReturnType<CaseService['getFclCase']>;config:FclConfigView;
    display:{quote_no:string;quote_date:string;valid_until:string;remark:string|null};
  }):FclDocumentPayload{
    if(!input.config.input)throw new PortalError('fcl_document_config_required');
    const quote=input.quote;
    const fees=input.quote.cost_rows.flatMap(row=>{
      if(row.sell_price===null)throw new PortalError('fcl_document_quote_incomplete');
      return [{
        id:stableUuid(`${input.documentId}:${row.row_key}`),
        source_kind:'manual' as const,
        template_ref:null,
        name:row.name,
        description:null,
        group:row.group,
        quantity:row.quantity,
        unit:row.unit,
        unit_price:row.sell_price,
        currency:row.currency,
        display:'detail' as const,
        merge_name:null,
        note:row.customer_note,
      }];
    });
    if(fees.length===0)throw new PortalError('fcl_document_no_quoted_service');
    const contact=input.caseView.current_input.contact;
    const customer_name=contact.company?.trim()?contact.company:contact.name;
    if(!customer_name)throw new PortalError('fcl_document_customer_missing');
    const caseProjection={
      origin_city:input.caseView.current_input.origin_city,
      pol:input.caseView.current_input.pol,
      pod:input.caseView.current_input.pod,
      final_destination:input.caseView.current_input.final_destination,
      containers:input.caseView.current_input.containers.flatMap(container=>container.quantity===null?[]:[{type:container.type,quantity:String(container.quantity)}]),
      services:[...input.caseView.current_input.selected_services],
      incoterm:input.caseView.current_input.incoterm,
      incoterm_other:input.caseView.current_input.incoterm_other,
      customer_name,
    };
    const customerInput=draftDocumentSchema.parse({
      schema_version:DRAFT_VERSION,
      quote_no:input.display.quote_no,
      customer_name,
      quote_date:input.display.quote_date,
      valid_until:input.display.valid_until,
      origin:input.caseView.current_input.origin_city??input.caseView.current_input.pol??'',
      destination:input.caseView.current_input.final_destination??input.caseView.current_input.pod??'',
      route_name:`${input.caseView.current_input.pol??''} → ${input.caseView.current_input.pod??''}`,
      job_no:null,
      so_no:null,
      container_no:null,
      remark:input.display.remark,
      exchange_rates:quote.exchange_rates,
      fee_items:fees,
    });
    const customerTotals=Object.fromEntries((['USD','CAD','CNY'] as const).map(currency=>{
      const revenue=input.quote.calculation.by_currency[currency].revenue_subtotal;
      if(revenue===null)throw new PortalError('fcl_document_quote_incomplete');
      return [currency,revenue];
    })) as {USD:string;CAD:string;CNY:string};
    const unsigned={
      contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,
      schema_version:'fcl-linked-document@2026-09-20.v1' as const,
      document_id:input.documentId,
      revision_id:input.revisionId,
      document_kind:'fcl_linked' as const,
      personal_owner_id:input.actor,
      version:input.version,
      state:input.state,
      case_binding:quote.case_binding,
      quote_binding:{quote_ref:quote.quote_ref,quote_version:quote.version,quote_digest:quote.content_digest},
      source_binding:{
        rate_id:quote.source_snapshot.rate_id,
        release_id:quote.source_snapshot.release_id,
        release_version:quote.source_snapshot.release_version,
        dataset_digest:quote.source_snapshot.dataset_digest,
        source_ref:quote.source_snapshot.source_ref,
        source_version:quote.source_snapshot.source_version,
        valid_from:quote.source_snapshot.valid_from,
        valid_until:quote.source_snapshot.valid_until,
        rate_digest:canonicalHash(quote.source_snapshot.rate),
      },
      case_projection:caseProjection,
      customer_input:customerInput,
      customer_scope:quote.service_coverage.map(item=>({service:item.service,disposition:item.disposition,note:item.note,included_row_refs:item.included_row_refs})),
      customer_totals:{by_currency:customerTotals},
      template:{company_name:input.config.input.issuer_name,company_address:input.config.input.issuer_address,company_phone:input.config.input.issuer_phone,company_email:input.config.input.issuer_email,terms:input.config.input.terms},
      template_version:input.config.version,
      actor:input.actor,
      created_at:input.createdAt,
      updated_at:input.updatedAt,
    };
    return fclDocumentPayloadSchema.parse({...unsigned,...this.fclDocumentSignature(unsigned)});
  }
  private assertFclDocumentCommitted(input:{personalOwnerId:string;documentId:string;revisionId:string;version:number;contentDigest:string;signature:string;actor:string;createdAt:string;auditId:string;partition:string;key:string;requestDigest:string;action:string}):void{
    const read=this.readFclDocument(input.personalOwnerId,input.documentId,input.version);
    if(read.payload.revision_id!==input.revisionId||read.payload.content_digest!==input.contentDigest||read.payload.signature!==input.signature||read.payload.actor!==input.actor||read.payload.created_at!==input.createdAt)throw new PortalError('fcl_document_readback_failed');
    const audit=this.store.db.prepare('SELECT org,personal_owner_id,actor,action,digest,created FROM document_audit WHERE id=?').get(input.auditId) as {org:string|null;personal_owner_id:string|null;actor:string;action:string;digest:string;created:string}|undefined;
    if(!audit||audit.org!==null||audit.personal_owner_id!==input.personalOwnerId||audit.actor!==input.actor||audit.digest!==input.requestDigest||audit.created!==input.createdAt||audit.action!==input.action)throw new PortalError('fcl_document_readback_failed');
    const current=this.store.db.prepare('SELECT revision_id,version,org,personal_owner_id,owner FROM document_current_revisions WHERE document_id=?').get(input.documentId) as {revision_id:string;version:number;org:string|null;personal_owner_id:string|null;owner:string}|undefined;
    if(!current||current.revision_id!==input.revisionId||current.version!==input.version||current.org!==null||current.personal_owner_id!==input.personalOwnerId||current.owner!==input.personalOwnerId)throw new PortalError('fcl_document_readback_failed');
    const event=this.store.db.prepare('SELECT action FROM document_revision_events WHERE audit_id=? AND document_id=? AND revision_id=? AND version=?').get(input.auditId,input.documentId,input.revisionId,input.version) as {action:string}|undefined;
    if(!event||event.action!==input.action)throw new PortalError('fcl_document_readback_failed');
    const idem=this.store.db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(input.partition,input.key) as {digest:string;result:string}|undefined;
    if(!idem||idem.digest!==input.requestDigest)throw new PortalError('fcl_document_readback_failed');
    try{const result=fclDocumentReferenceSchema.parse(JSON.parse(idem.result));if(result.document_id!==input.documentId||result.version!==input.version||result.audit_id!==input.auditId)throw new Error('mismatch');}catch{throw new PortalError('fcl_document_readback_failed');}
  }
  private persistFclDocumentRevision(input:{personalOwnerId:string;payload:FclDocumentPayload;sourceRevisionId:string|null;action:string;auditId:string;partition:string;key:string;requestDigest:string}):void{
    const db=this.store.db,payload=input.payload;
    db.prepare('INSERT INTO document_revisions(revision_id,document_id,org,personal_owner_id,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(payload.revision_id,payload.document_id,null,input.personalOwnerId,input.personalOwnerId,payload.version,payload.state,5,JSON.stringify(payload),canonicalHash(payload.customer_input),canonicalHash(payload.template),input.sourceRevisionId,payload.state==='approved'?payload.decision?.review_hash??null:null,payload.state==='rejected'?payload.decision?.reason??null:null,payload.actor,payload.created_at);
    db.prepare('INSERT INTO document_current_revisions(document_id,org,personal_owner_id,owner,revision_id,version,schema_version,projection_digest,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET org=excluded.org,personal_owner_id=excluded.personal_owner_id,owner=excluded.owner,revision_id=excluded.revision_id,version=excluded.version,schema_version=excluded.schema_version,projection_digest=excluded.projection_digest,updated_at=excluded.updated_at').run(payload.document_id,null,input.personalOwnerId,input.personalOwnerId,payload.revision_id,payload.version,5,payload.content_digest,payload.updated_at);
    db.prepare('INSERT INTO document_audit(id,org,personal_owner_id,actor,action,digest,created) VALUES(?,?,?,?,?,?,?)').run(input.auditId,null,input.personalOwnerId,payload.actor,input.action,input.requestDigest,payload.created_at);
    db.prepare('INSERT INTO document_revision_events(audit_id,document_id,revision_id,version,action) VALUES(?,?,?,?,?)').run(input.auditId,payload.document_id,payload.revision_id,payload.version,input.action);
    db.prepare('INSERT INTO document_idempotency(scope,key,digest,result) VALUES(?,?,?,?)').run(input.partition,input.key,input.requestDigest,JSON.stringify({document_id:payload.document_id,version:payload.version,audit_id:input.auditId}));
    this.assertFclDocumentCommitted({personalOwnerId:input.personalOwnerId,documentId:payload.document_id,revisionId:payload.revision_id,version:payload.version,contentDigest:payload.content_digest,signature:payload.signature,actor:payload.actor,createdAt:payload.created_at,auditId:input.auditId,partition:input.partition,key:input.key,requestDigest:input.requestDigest,action:input.action});
  }
  private saveFclDocumentLocked(ctx:PortalContext,options:NormalizedFclDocumentWorkflowOptions,input:unknown,key:string):FclDocumentView{
    const request=parse(fclDocumentSaveRequestSchema,input,'fcl_document_input_invalid');
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    const dependencies=this.fclQuoteDependencies(),action=request.operation==='re_quote'?'fcl-document-re-quote':`fcl-document-${request.operation}`,target=request.operation==='create'?'create':request.document_id;
    const partition=JSON.stringify(['v5-doc-personal',options.receiverUserId,ctx.identity.userId,action,target]),requestDigest=canonicalHash(request),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    let committed=false;
    try{
      const old=db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){
        if(old.digest!==requestDigest)throw new PortalError('idempotency_conflict');
        let submitted:{document_id:string;version:number;audit_id:string};
        try{submitted=fclDocumentReferenceSchema.parse(JSON.parse(old.result));}catch{throw new PortalError('fcl_document_readback_failed');}
        const event=db.prepare('SELECT revision_id,action FROM document_revision_events WHERE audit_id=? AND document_id=? AND version=?').get(submitted.audit_id,submitted.document_id,submitted.version) as {revision_id:string;action:string}|undefined;
        const audit=db.prepare('SELECT personal_owner_id,actor,action,digest,created FROM document_audit WHERE id=?').get(submitted.audit_id) as {personal_owner_id:string|null;actor:string;action:string;digest:string;created:string}|undefined;
        if(!event||event.action!==action||!audit||audit.personal_owner_id!==options.receiverUserId||audit.actor!==ctx.identity.userId||audit.action!==action||audit.digest!==requestDigest)throw new PortalError('fcl_document_readback_failed');
        db.exec('COMMIT');committed=true;
        const read=this.readFclDocument(options.receiverUserId,submitted.document_id,submitted.version);
        if(read.payload.revision_id!==event.revision_id)throw new PortalError('fcl_document_readback_failed');
        dependencies.caseReader.getFclCase(ctx,read.payload.case_binding.case_ref);
        return this.fclDocumentView(read.payload,read.currentVersion,this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options),{replayed:true,submitted_version:submitted.version,current:read.payload.version===read.currentVersion});
      }
      const documentId=request.operation==='create'?randomUUID():request.document_id;
      let version=1,sourceRevisionId:string|null=null;
      let existingPayload:FclDocumentPayload|null=null;
      if(request.operation!=='create'){
        const current=this.readFclDocument(options.receiverUserId,documentId,null);
        if(current.payload.version!==request.expected_document_version)throw new PortalError('version_conflict');
        const expectedState=request.operation==='refresh'?'draft':request.operation==='resubmit'?'rejected':'approved';
        if(current.payload.state!==expectedState)throw new PortalError('fcl_document_state_not_editable');
        version=current.payload.version+1;sourceRevisionId=current.payload.revision_id;existingPayload=current.payload;
      }
      const quote=this.readFclQuote(options.receiverUserId,request.quote_ref,request.expected_quote_version);
      if(existingPayload&&existingPayload.case_binding.case_ref!==quote.snapshot.case_binding.case_ref)throw new PortalError('fcl_document_case_mismatch');
      if(quote.snapshot.version!==request.expected_quote_version||quote.snapshot.content_digest!==request.expected_quote_digest||quote.currentVersion!==request.expected_quote_version)throw new PortalError('fcl_document_quote_stale');
      if(request.operation==='re_quote'&&existingPayload){
        const quoteChanged=existingPayload.quote_binding.quote_ref!==quote.snapshot.quote_ref||existingPayload.quote_binding.quote_version!==quote.snapshot.version;
        if(!quoteChanged&&this.fclConfigRaw(options.receiverUserId).version===existingPayload.template_version)throw new PortalError('fcl_document_re_quote_required');
      }
      const quoteCurrentness=this.fclQuoteCurrentness(ctx,quote.snapshot,quote.currentVersion,options);
      if(!quoteCurrentness.valid_now)throw new PortalError('fcl_document_quote_not_current');
      if(!quote.snapshot.completeness.complete||!quote.snapshot.calculation.complete)throw new PortalError('fcl_document_quote_incomplete');
      const caseRef=quote.snapshot.case_binding.case_ref;
      const caseView=dependencies.caseReader.getFclCase(ctx,caseRef);
      if(caseView.case_status==='closed'||caseView.case_status==='cancelled')throw new PortalError('fcl_document_case_closed');
      if(caseView.case_version!==request.expected_case_version||caseView.review_context.latest_customer_supplement_ref!==request.expected_customer_supplement_ref)throw new PortalError('fcl_document_case_stale');
      const config=this.fclConfigRaw(options.receiverUserId);
      if(config.version!==request.expected_config_version||!config.input)throw new PortalError('fcl_document_config_stale');
      const today=this.fclTimestamp(options).slice(0,10);
      if(request.quote_date>request.valid_until||request.quote_date>today||today>request.valid_until||request.quote_date<quote.snapshot.source_snapshot.valid_from||request.valid_until>quote.snapshot.source_snapshot.valid_until)throw new PortalError('fcl_document_date_invalid');
      const createdAt=this.fclTimestamp(options),revisionId=randomUUID();
      const payload=this.buildFclDocumentPayload({documentId,revisionId,version,state:'draft',actor:ctx.identity.userId,createdAt,updatedAt:createdAt,quote:quote.snapshot,caseView,config,display:{quote_no:request.quote_no,quote_date:request.quote_date,valid_until:request.valid_until,remark:request.remark}});
      db.prepare('INSERT INTO document_revisions(revision_id,document_id,org,personal_owner_id,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId,documentId,null,options.receiverUserId,options.receiverUserId,version,'draft',5,JSON.stringify(payload),canonicalHash(payload.customer_input),canonicalHash(payload.template),sourceRevisionId,null,null,ctx.identity.userId,createdAt);
      db.prepare('INSERT INTO document_current_revisions(document_id,org,personal_owner_id,owner,revision_id,version,schema_version,projection_digest,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET org=excluded.org,personal_owner_id=excluded.personal_owner_id,owner=excluded.owner,revision_id=excluded.revision_id,version=excluded.version,schema_version=excluded.schema_version,projection_digest=excluded.projection_digest,updated_at=excluded.updated_at').run(documentId,null,options.receiverUserId,options.receiverUserId,revisionId,version,5,payload.content_digest,createdAt);
      const auditId=randomUUID();
      db.prepare('INSERT INTO document_audit(id,org,personal_owner_id,actor,action,digest,created) VALUES(?,?,?,?,?,?,?)').run(auditId,null,options.receiverUserId,ctx.identity.userId,action,requestDigest,createdAt);
      db.prepare('INSERT INTO document_revision_events(audit_id,document_id,revision_id,version,action) VALUES(?,?,?,?,?)').run(auditId,documentId,revisionId,version,action);
      db.prepare('INSERT INTO document_idempotency(scope,key,digest,result) VALUES(?,?,?,?)').run(partition,key,requestDigest,JSON.stringify({document_id:documentId,version,audit_id:auditId}));
      this.assertFclDocumentCommitted({personalOwnerId:options.receiverUserId,documentId,revisionId,version,contentDigest:payload.content_digest,signature:payload.signature,actor:ctx.identity.userId,createdAt,auditId,partition,key,requestDigest,action});
      this.requireFclReceiver(ctx);
      db.exec('COMMIT');committed=true;
      this.assertFclDocumentCommitted({personalOwnerId:options.receiverUserId,documentId,revisionId,version,contentDigest:payload.content_digest,signature:payload.signature,actor:ctx.identity.userId,createdAt,auditId,partition,key,requestDigest,action});
      const read=this.readFclDocument(options.receiverUserId,documentId,version);
      return this.fclDocumentView(read.payload,read.currentVersion,this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options));
    }catch(error){
      if(!committed)db.exec('ROLLBACK');
      if(committed&&!(error instanceof PortalError))throw new PortalError('fcl_document_readback_failed');
      throw error;
    }
  }
  saveFclDocument(ctx:PortalContext,input:unknown,key:string):FclDocumentView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies();this.store.ensureWritable();
    return dependencies.caseLock.withFclReadLock(ctx,()=>dependencies.rateLock.withFclReadLock(ctx,()=>this.saveFclDocumentLocked(ctx,options,input,key)));
  }
  getFclDocument(ctx:PortalContext,input:unknown):FclDocumentView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclDocumentGetRequestSchema,input,'fcl_document_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>{
      const read=this.readFclDocument(options.receiverUserId,request.document_id,request.version);
      dependencies.caseReader.getFclCase(ctx,read.payload.case_binding.case_ref);
      return this.fclDocumentView(read.payload,read.currentVersion,this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options));
    });
  }
  listFclDocuments(ctx:PortalContext,input:unknown){
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclDocumentListRequestSchema,input,'fcl_document_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>{
      dependencies.caseReader.getFclCase(ctx,request.case_ref);
      let cursor:{case_ref:string;updated_at:string;document_id:string}|null=null;
      if(request.cursor){
        try{cursor=z.object({case_ref:z.string().uuid(),updated_at:z.iso.datetime(),document_id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8')));}catch{throw new PortalError('fcl_document_input_invalid');}
        if(cursor.case_ref!==request.case_ref)throw new PortalError('fcl_document_input_invalid');
      }
      const rows=this.store.db.prepare(`SELECT c.document_id,c.version,c.updated_at FROM document_current_revisions c JOIN document_revisions r ON r.revision_id=c.revision_id WHERE c.org IS NULL AND c.personal_owner_id=? AND json_extract(r.payload,'$.case_binding.case_ref')=? AND (? IS NULL OR c.updated_at<? OR (c.updated_at=? AND c.document_id<?)) ORDER BY c.updated_at DESC,c.document_id DESC LIMIT ?`).all(options.receiverUserId,request.case_ref,cursor?.updated_at??null,cursor?.updated_at??'',cursor?.updated_at??'',cursor?.document_id??'',request.limit+1) as Array<{document_id:string;version:number;updated_at:string}>;
      const page=rows.slice(0,request.limit);
      return fclDocumentListSchema.parse({items:page.map(row=>{const read=this.readFclDocument(options.receiverUserId,row.document_id,row.version);return {document_id:row.document_id,version:row.version,current_version:read.currentVersion,state:read.payload.state,case_ref:read.payload.case_binding.case_ref,quote_ref:read.payload.quote_binding.quote_ref,quote_version:read.payload.quote_binding.quote_version,source_release_id:read.payload.source_binding.release_id,customer_name:read.payload.case_projection.customer_name,quote_no:read.payload.customer_input.quote_no!,quote_date:read.payload.customer_input.quote_date!,valid_until:read.payload.customer_input.valid_until!,currentness:this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options),created_at:row.updated_at};}),next_cursor:rows.length>request.limit&&page.at(-1)?Buffer.from(JSON.stringify({case_ref:request.case_ref,updated_at:page.at(-1)!.updated_at,document_id:page.at(-1)!.document_id})).toString('base64url'):null});
    });
  }
  private fclDocumentReviewHash(input:{personalOwnerId:string;actor:string;documentId:string;revisionId:string;version:number;contentDigest:string;payload:FclDocumentPayload;expiresAt:string}):string{
    return createHmac('sha256',this.secret).update(canonicalJson({
      domain:'fcl-document-review',
      personal_owner_id:input.personalOwnerId,
      actor:input.actor,
      document_id:input.documentId,
      revision_id:input.revisionId,
      version:input.version,
      content_digest:input.contentDigest,
      case_binding:input.payload.case_binding,
      quote_binding:input.payload.quote_binding,
      source_binding:input.payload.source_binding,
      template_version:input.payload.template_version,
      quote_date:input.payload.customer_input.quote_date,
      valid_until:input.payload.customer_input.valid_until,
      review_expires_at:input.expiresAt,
    })).digest('hex');
  }
  reviewFclDocument(ctx:PortalContext,input:unknown):FclDocumentReviewView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclDocumentReviewRequestSchema,input,'fcl_document_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>dependencies.rateLock.withFclReadLock(ctx,()=>{
      const read=this.readFclDocument(options.receiverUserId,request.document_id,null);
      if(read.payload.version!==request.expected_version||read.payload.state!=='draft')throw new PortalError('version_conflict');
      dependencies.caseReader.getFclCase(ctx,read.payload.case_binding.case_ref);
      const quote=this.readFclQuote(options.receiverUserId,read.payload.quote_binding.quote_ref,read.payload.quote_binding.quote_version);
      if(!quote.snapshot.completeness.complete||!quote.snapshot.calculation.complete)throw new PortalError('fcl_document_quote_incomplete');
      const currentness=this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options);
      if(!currentness.valid_now)throw new PortalError('fcl_document_quote_not_current');
      const reviewedAt=this.fclTimestamp(options),expiresAt=new Date(Date.parse(reviewedAt)+600000).toISOString();
      const reviewHash=this.fclDocumentReviewHash({personalOwnerId:options.receiverUserId,actor:ctx.identity.userId,documentId:read.payload.document_id,revisionId:read.payload.revision_id,version:read.payload.version,contentDigest:read.payload.content_digest,payload:read.payload,expiresAt});
      this.reviews.set(reviewHash,{kind:'fcl',id:read.payload.document_id,version:read.payload.version,revision_id:read.payload.revision_id,content_digest:read.payload.content_digest,expires:Date.parse(expiresAt),reviewed_at:reviewedAt,review_expires_at:expiresAt,actor:ctx.identity.userId});
      return fclDocumentReviewViewSchema.parse({contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,document_id:read.payload.document_id,revision_id:read.payload.revision_id,version:read.payload.version,review_hash:reviewHash,review_expires_at:expiresAt,quote:quote.snapshot,document:this.fclDocumentView(read.payload,read.currentVersion,currentness)});
    }));
  }
  private fclDocumentDecisionPayload(current:FclDocumentPayload,input:{state:'approved'|'rejected';actor:string;at:string;reviewHash:string|null;reviewedAt:string|null;reviewExpiresAt:string|null;reason:string|null;newRevisionId:string}):FclDocumentPayload{
    const {content_digest:_content,signature:_signature,decision:_decision,...base}=current;
    void _content;void _signature;void _decision;
    const unsigned={
      ...base,
      revision_id:input.newRevisionId,
      version:current.version+1,
      state:input.state,
      actor:input.actor,
      created_at:input.at,
      updated_at:input.at,
      decision:{
        kind:input.state,
        source_revision_id:current.revision_id,
        source_version:current.version,
        source_content_digest:current.content_digest,
        review_hash:input.reviewHash,
        approved_revision_id:input.state==='approved'?input.newRevisionId:null,
        approved_version:input.state==='approved'?current.version+1:null,
        reviewed_at:input.reviewedAt,
        review_expires_at:input.reviewExpiresAt,
        reason:input.reason,
        actor:input.actor,
        at:input.at,
      },
    };
    return fclDocumentPayloadSchema.parse({...unsigned,...this.fclDocumentSignature(unsigned)});
  }
  private idempotentFclDocumentDecision(ctx:PortalContext,options:NormalizedFclDocumentWorkflowOptions,request:{document_id:string},key:string,action:string,write:()=>FclDocumentPayload):FclDocumentView{
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    this.store.ensureWritable();
    const partition=JSON.stringify(['v5-doc-personal',options.receiverUserId,ctx.identity.userId,action,request.document_id]),requestDigest=canonicalHash(request),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    let committed=false;
    try{
      const old=db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){
        if(old.digest!==requestDigest)throw new PortalError('idempotency_conflict');
        let submitted:{document_id:string;version:number;audit_id:string};
        try{submitted=fclDocumentReferenceSchema.parse(JSON.parse(old.result));}catch{throw new PortalError('fcl_document_readback_failed');}
        const event=db.prepare('SELECT revision_id,action FROM document_revision_events WHERE audit_id=? AND document_id=? AND version=?').get(submitted.audit_id,submitted.document_id,submitted.version) as {revision_id:string;action:string}|undefined;
        const audit=db.prepare('SELECT personal_owner_id,actor,action,digest,created FROM document_audit WHERE id=?').get(submitted.audit_id) as {personal_owner_id:string|null;actor:string;action:string;digest:string;created:string}|undefined;
        if(!event||!audit||event.action!==action||audit.personal_owner_id!==options.receiverUserId||audit.actor!==ctx.identity.userId||audit.action!==action||audit.digest!==requestDigest)throw new PortalError('fcl_document_readback_failed');
        db.exec('COMMIT');committed=true;
        const read=this.readFclDocument(options.receiverUserId,submitted.document_id,submitted.version);
        if(read.payload.revision_id!==event.revision_id)throw new PortalError('fcl_document_readback_failed');
        return this.fclDocumentView(read.payload,read.currentVersion,this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options),{replayed:true,submitted_version:submitted.version,current:read.payload.version===read.currentVersion});
      }
      const payload=write(),auditId=randomUUID();
      this.persistFclDocumentRevision({personalOwnerId:options.receiverUserId,payload,sourceRevisionId:payload.decision?.source_revision_id??null,action,auditId,partition,key,requestDigest});
      this.requireFclReceiver(ctx);
      db.exec('COMMIT');committed=true;
      this.assertFclDocumentCommitted({personalOwnerId:options.receiverUserId,documentId:payload.document_id,revisionId:payload.revision_id,version:payload.version,contentDigest:payload.content_digest,signature:payload.signature,actor:payload.actor,createdAt:payload.created_at,auditId,partition,key,requestDigest,action});
      const read=this.readFclDocument(options.receiverUserId,payload.document_id,payload.version);
      return this.fclDocumentView(read.payload,read.currentVersion,this.fclDocumentCurrentness(ctx,read.payload,read.currentVersion,options));
    }catch(error){
      if(!committed)db.exec('ROLLBACK');
      if(committed&&!(error instanceof PortalError))throw new PortalError('fcl_document_readback_failed');
      throw error;
    }
  }
  approveFclDocument(ctx:PortalContext,input:unknown,key:string):FclDocumentView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclDocumentApproveRequestSchema,input,'fcl_document_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>dependencies.rateLock.withFclReadLock(ctx,()=>this.idempotentFclDocumentDecision(ctx,options,request,key,'fcl-document-approve',()=>{
      const current=this.readFclDocument(options.receiverUserId,request.document_id,null);
      if(current.payload.version!==request.expected_version||current.payload.state!=='draft')throw new PortalError('version_conflict');
      const review=this.reviews.get(request.review_hash);
      if(!review||review.kind!=='fcl'||review.id!==current.payload.document_id||review.version!==current.payload.version||review.revision_id!==current.payload.revision_id||review.content_digest!==current.payload.content_digest||review.actor!==ctx.identity.userId||review.expires<=Date.parse(this.fclTimestamp(options)))throw new PortalError('fcl_document_review_stale');
      dependencies.caseReader.getFclCase(ctx,current.payload.case_binding.case_ref);
      const quote=this.readFclQuote(options.receiverUserId,current.payload.quote_binding.quote_ref,current.payload.quote_binding.quote_version);
      if(!quote.snapshot.completeness.complete||!quote.snapshot.calculation.complete)throw new PortalError('fcl_document_quote_incomplete');
      const currentness=this.fclDocumentCurrentness(ctx,current.payload,current.currentVersion,options);
      if(!currentness.valid_now)throw new PortalError('fcl_document_quote_not_current');
      const at=this.fclTimestamp(options);
      return this.fclDocumentDecisionPayload(current.payload,{state:'approved',actor:ctx.identity.userId,at,reviewHash:request.review_hash,reviewedAt:review.reviewed_at,reviewExpiresAt:review.review_expires_at,reason:null,newRevisionId:randomUUID()});
    })));
  }
  rejectFclDocument(ctx:PortalContext,input:unknown,key:string):FclDocumentView{
    const options=this.requireFclReceiver(ctx),dependencies=this.fclQuoteDependencies(),request=parse(fclDocumentRejectRequestSchema,input,'fcl_document_input_invalid');
    return dependencies.caseLock.withFclReadLock(ctx,()=>this.idempotentFclDocumentDecision(ctx,options,request,key,'fcl-document-reject',()=>{
      const current=this.readFclDocument(options.receiverUserId,request.document_id,null);
      if(current.payload.version!==request.expected_version||current.payload.state!=='draft')throw new PortalError('version_conflict');
      dependencies.caseReader.getFclCase(ctx,current.payload.case_binding.case_ref);
      const at=this.fclTimestamp(options);
      return this.fclDocumentDecisionPayload(current.payload,{state:'rejected',actor:ctx.identity.userId,at,reviewHash:null,reviewedAt:null,reviewExpiresAt:null,reason:request.reason,newRevisionId:randomUUID()});
    }));
  }
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
  private expectedBindingHash(scope:Scope,ownerId:string,documentKind:StoredPayload['document_kind'],caseRef:string|null,binding:NativeBindingV3){
    return hash([this.secret,scope.org,ownerId,documentKind,caseRef,nativeBindingPayload(binding)]);
  }
  private previewHash(scope:Scope,documentKind:StoredPayload['document_kind'],caseRef:string|null,bindingHash:string,expires:number){
    return hash([this.secret,scope.org,scope.user,'native_prepare',documentKind,caseRef,bindingHash,expires]);
  }
  private assertSignedPreview(scope:Scope,documentKind:StoredPayload['document_kind'],caseRef:string|null,bindingHash:string,previewHash:string,expires:number){
    if(expires<Date.now()||previewHash!==this.previewHash(scope,documentKind,caseRef,bindingHash,expires))throw new PortalError('document_preview_stale');
  }
  private assertSignedNative(scope:Scope,ownerId:string,payload:Pick<StoredPayload,'document_kind'|'input'|'native_quote_v1'|'inquiry_case_link_v1'>){
    const binding=payload.native_quote_v1;
    if(!isNativeBindingV3(binding))throw new PortalError('native_quote_rebind_required');
    if(binding.provenance!=='v3_server_signed')throw new PortalError('native_quote_rebind_required');
    const caseRef=payload.inquiry_case_link_v1?.case_ref??null;
    if(caseRef!==null&&payload.document_kind!=='linked')throw new PortalError('inquiry_quote_link_forgery');
    if(binding.source_refs_digest!==canonicalHash(binding.source_refs)||binding.request_hash!==hash(binding.request)||binding.document_fee_digest!==nativeFeeDigest(payload.input.fee_items))throw new PortalError('inquiry_quote_link_forgery');
    const ownerProof=this.expectedBindingHash(scope,ownerId,payload.document_kind,caseRef,binding);
    const actorProof=this.expectedBindingHash(scope,scope.user,payload.document_kind,caseRef,binding);
    if(binding.binding_hash!==ownerProof&&binding.binding_hash!==actorProof){
      const credential=this.store.nativePrepareCredential(binding.binding_hash);
      if(!credential||credential.org!==scope.org||credential.document_kind!==payload.document_kind||credential.case_ref!==caseRef||credential.binding_digest!==canonicalHash(nativeBindingPayload(binding)))throw new PortalError('inquiry_quote_link_forgery');
    }
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
      this.legacy.assertNativeCurrent(ctx,payload.native_quote_v1,payload.document_kind==='linked',payload.input);
    }
    if(requireValidity)this.assertValidity(payload.input);
    return payload;
  }
  private assertSignedNativeForRead(ctx:PortalContext,payload:StoredPayload){
    if(payload.native_quote_v1&&!isNativeBindingV3(payload.native_quote_v1))return;
    this.assertSignedNative(this.scope(ctx),payload.owner_id,payload);
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
      this.store.store.db.prepare('INSERT INTO document_configs(org,version,input) VALUES(?,?,?) ON CONFLICT(org) DO UPDATE SET version=excluded.version,input=excluded.input').run(scope.org,current.version+1,JSON.stringify(merged));
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
    if(!this.store.isV3())return null;
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
    this.store.rememberPrepareCredential({bindingHash,org:scope.org,actor:scope.user,documentKind:data.document_kind,caseRef,bindingDigest:canonicalHash(withoutHash)});
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
    this.store.store.db.prepare('INSERT INTO document_revisions(revision_id,document_id,org,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId,stored.id,scope.org,stored.owner_id,version,state,3,JSON.stringify(stored),inputDigest,templateDigest,sourceRevision,reviewHash,rejectionReason,scope.user,created);
    this.store.store.db.prepare('INSERT INTO document_current_revisions(document_id,org,owner,revision_id,version,schema_version,projection_digest,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET org=excluded.org,owner=excluded.owner,revision_id=excluded.revision_id,version=excluded.version,schema_version=excluded.schema_version,projection_digest=excluded.projection_digest,updated_at=excluded.updated_at').run(stored.id,scope.org,stored.owner_id,revisionId,version,3,inputDigest,created);
    const auditId=randomUUID();this.store.store.db.prepare('INSERT INTO document_audit(id,org,actor,action,digest,created) VALUES(?,?,?,?,?,?)').run(auditId,scope.org,scope.user,action,inputDigest,created);
    this.store.store.db.prepare('INSERT INTO document_revision_events VALUES(?,?,?,?,?)').run(auditId,stored.id,revisionId,version,action);
    return stored;
  }
  private append(scope:Scope,current:StoredPayload,changes:Partial<StoredPayload>,action:string,sourceRevision:string|null,reviewHash:string|null=null){
    const next={...current,...changes,owner_id:current.owner_id,document_kind:current.document_kind,revision_id:randomUUID()};
    if(next.approval)next.approval={...next.approval,approved_revision_id:next.revision_id,approved_version:current.version+1};
    return this.insertRevision(scope,next,current.version+1,next.state,action,sourceRevision,reviewHash,next.rejection?.reason??null);
  }
  private replayAvailable(ctx:PortalContext,scope:Scope,action:string,current:StoredPayload):boolean{
    try{
      this.assertPayloadGates(ctx,current,action==='save'||action==='approve'||action==='reject',action==='approve'||action==='reject');
      return true;
    }catch(error){
      if(error instanceof PortalError&&['native_quote_source_changed','native_quote_release_expired','native_quote_validity_invalid','document_expired','inquiry_quote_case_closed','inquiry_quote_case_review_required'].includes(error.code))return false;
      throw error;
    }
  }
  private historicalReplay(current:StoredPayload,committed:{version:number;revision_id?:unknown}){
    return {replay:true as const,committed:true as const,current:false as const,historical:true as const,valid_now:false as const,id:current.id,version:committed.version,revision_id:typeof committed.revision_id==='string'?committed.revision_id:null,current_version:current.version,current_revision_id:current.revision_id??null,current_state:current.state};
  }
  private readbackResult(ctx:PortalContext,scope:Scope,action:string,result:unknown):unknown{
    if(action==='config-save'){
      const config=this.configFromScope(scope);
      if(canonicalHash(config)!==canonicalHash(result))throw new PortalError('document_readback_failed');
      return config;
    }
    const candidate=result as Partial<WorkflowDocumentView>;
    if(typeof candidate.id!=='string'||typeof candidate.version!=='number'||typeof candidate.revision_id!=='string')throw new PortalError('document_readback_failed');
    const row=this.store.store.db.prepare('SELECT * FROM document_revisions WHERE revision_id=? AND document_id=? AND org=? AND version=?').get(candidate.revision_id,candidate.id,scope.org,candidate.version) as RevisionRow|undefined;
    if(!row)throw new PortalError('document_readback_failed');
    let payload:StoredPayload;
    let expected:WorkflowDocumentView;
    try{
      payload=JSON.parse(row.payload) as StoredPayload;
      expected=this.view(payload);
    }catch{
      throw new PortalError('document_readback_failed');
    }
    const approval=payload.approval;
    const prior=row.version>1?this.store.store.db.prepare('SELECT revision_id FROM document_revisions WHERE document_id=? AND org=? AND version=?').get(row.document_id,scope.org,row.version-1) as {revision_id:string}|undefined:undefined;
    const approvalSource=action==='approve'&&typeof approval?.source_revision_id==='string'?approval.source_revision_id:null;
    const expectedSource=action==='approve'?approvalSource:row.version>1?prior?.revision_id??null:null;
    const approvalReviewHash=action==='approve'&&typeof approval?.review_hash==='string'?approval.review_hash:null;
    const expectedRejection=action==='reject'?payload.rejection?.reason??null:null;
    const invalidSource=action==='approve'?(!approvalSource||!approvalReviewHash||prior?.revision_id!==approvalSource):action!=='create'&&row.version>1&&!prior;
    if(
      invalidSource||
      row.document_id!==payload.id||
      row.revision_id!==payload.revision_id||
      row.org!==payload.org||row.org!==scope.org||
      row.owner!==payload.owner_id||
      row.version!==payload.version||
      row.state!==payload.state||
      row.schema_version!==3||
      row.created_by!==scope.user||
      row.input_digest!==canonicalHash(payload.input)||
      row.template_digest!==canonicalHash(payload.template)||
      row.source_revision_id!==expectedSource||
      row.review_hash!==approvalReviewHash||
      row.rejection_reason!==expectedRejection||
      candidate.id!==row.document_id||
      candidate.revision_id!==row.revision_id||
      candidate.version!==row.version||
      candidate.organization_id!==row.org||
      candidate.owner_id!==row.owner||
      candidate.state!==row.state||
      candidate.document_kind!==payload.document_kind||
      canonicalHash(candidate)!==canonicalHash(expected)
    )throw new PortalError('document_readback_failed');
    if(payload.owner_id!==scope.user&&!scope.manager)throw new PortalError('document_not_found');
    this.assertContextLinked(ctx,payload,action==='save'||action==='approve'||action==='reject');
    if(action==='approve'){
      try{this.assertApprovalPayload(payload);}catch{throw new PortalError('document_readback_failed');}
    }
    return expected;
  }
  private configFromScope(scope:Scope){const config=this.configRaw(scope);return {...config,standard_fee_template_v1:config.input?.standard_fee_template_v1??null,catalog:standardFeeTemplate};}
  private idempotent<T>(ctx:PortalContext,scope:Scope,action:string,target:string,key:string,input:unknown,fn:()=>T):T{
    if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    this.store.ensureWritable();
    const partition=JSON.stringify(['v3',scope.org,scope.user,action,target]),digest=canonicalHash(input),db=this.store.store.db;
    db.exec('BEGIN IMMEDIATE');
    let committed=false;
    try{
      const old=db.prepare('SELECT digest,result FROM document_idempotency WHERE scope=? AND key=?').get(partition,key) as {digest:string;result:string}|undefined;
      if(old){
        if(old.digest!==digest)throw new PortalError('idempotency_conflict');
        const persisted=JSON.parse(old.result) as T;
        const candidate=persisted as unknown as {id?:unknown;version?:unknown;revision_id?:unknown;state?:unknown};
        const currentScope=this.scope(ctx,action==='config-save'||action==='approve'||action==='reject');
        if(typeof candidate.id==='string'&&typeof candidate.version==='number'){
          const committedResult=this.readbackResult(ctx,currentScope,action,persisted) as WorkflowDocumentView;
          const current=this.read(currentScope,candidate.id);
          this.assertContextLinked(ctx,current,action==='save'||action==='approve'||action==='reject');
          if(current.version!==committedResult.version||current.state!==committedResult.state||current.revision_id!==committedResult.revision_id||!this.replayAvailable(ctx,currentScope,action,current)){
            db.exec('COMMIT');
            committed=true;
            return this.historicalReplay(current,committedResult) as T;
          }
          db.exec('COMMIT');
          committed=true;
          return committedResult as T;
        }
        db.exec('COMMIT');
        committed=true;
        return this.readbackResult(ctx,currentScope,action,persisted) as T;
      }
      const result=fn();
      db.prepare('INSERT INTO document_idempotency VALUES(?,?,?,?)').run(partition,key,digest,JSON.stringify(result));
      db.exec('COMMIT');
      committed=true;
      return this.readbackResult(ctx,scope,action,result) as T;
    }catch(error){
      if(!committed)db.exec('ROLLBACK');
      if(committed&&!(error instanceof PortalError))throw new PortalError('document_readback_failed');
      throw error;
    }
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
          this.assertSignedNative(scope,payload.owner_id,payload);
          if(!isNativeBindingV3(payload.native_quote_v1))throw new PortalError('native_quote_rebind_required');
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
        if(bindingUpdate.mode==='retain'&&(!isNativeBindingV3(current.native_quote_v1)||current.native_quote_v1.provenance!=='v3_server_signed'||digest!==current.native_quote_v1.document_fee_digest))throw new PortalError('native_quote_rebind_required');
        if(bindingUpdate.mode==='replace'){
          const caseRef=current.inquiry_case_link_v1?.case_ref??null;
          if(bindingUpdate.native_quote_v1.document_fee_digest!==digest)throw new PortalError('native_quote_rebind_required');
          if(data.document_kind==='linked'&&bindingUpdate.inquiry_case_link_v1?.case_ref!==caseRef)throw new PortalError('inquiry_quote_link_forgery');
          if(data.document_kind==='native_unlinked'&&bindingUpdate.inquiry_case_link_v1)throw new PortalError('inquiry_quote_link_forgery');
          const candidate:StoredPayload={...current,input:data.input,native_quote_v1:bindingUpdate.native_quote_v1,inquiry_case_link_v1:data.document_kind==='linked'?(bindingUpdate.inquiry_case_link_v1??current.inquiry_case_link_v1):null};
          this.assertSignedNative(scope,current.owner_id,candidate);
          this.assertSignedPreview(scope,data.document_kind,caseRef,bindingUpdate.native_quote_v1.binding_hash,bindingUpdate.preview_hash,bindingUpdate.preview_expires_at);
          this.assertPayloadGates(ctx,candidate,data.document_kind==='linked');
        }else{
          const candidate:StoredPayload={...current,input:data.input};
          this.assertSignedNativeForRead(ctx,candidate);
          this.assertPayloadGates(ctx,candidate,data.document_kind==='linked');
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
    const claimed=this.store.isV3()?this.store.store.db.prepare('SELECT document_id FROM document_current_revisions WHERE org=? AND (?=1 OR owner=?) ORDER BY updated_at DESC').all(scope.org,scope.manager?1:0,scope.user) as Array<{document_id:string}>:[];
    for(const row of claimed){const item=this.readClaimed(scope,row.document_id)!;try{this.assertContextLinked(ctx,item,false);items.push(this.view(item));}catch(error){if(error instanceof PortalError&&error.code==='document_not_found')continue;throw error;}}
    const unclaimed=this.store.isV3()?'id NOT IN (SELECT document_id FROM document_current_revisions)':'1=1';
    const legacy=this.store.store.db.prepare(`SELECT id FROM quote_documents WHERE org=? AND (?=1 OR owner=?) AND ${unclaimed} ORDER BY rowid DESC`).all(scope.org,scope.manager?1:0,scope.user) as Array<{id:string}>;
    for(const row of legacy){const item=this.readLegacy(scope,row.id);try{this.assertContextLinked(ctx,item,false);items.push(this.view(item,'legacy_unclaimed'));}catch(error){if(error instanceof PortalError&&error.code==='document_not_found')continue;throw error;}}
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
    this.reviews.set(reviewHash,{kind:'enterprise',id:payload.id,version:payload.version,revision_id:payload.revision_id??null,content_digest:digest,expires,actor:scope.user});
    return {kind:'success' as const,data:{document_id:payload.id,revision_id:payload.revision_id??null,reviewed_version:payload.version,state:payload.state,input:payload.input,completeness,totals,warnings:totals.warnings,blockers:[],requirements:{complete:true,case_current:true,native_source_current:true,validity_ok:true},can_approve:true,available_export_modes:payload.document_kind==='linked'?[]:['draft'],review_hash:reviewHash,review_expires_at:expires}};
  }
  review(ctx:PortalContext,input:unknown){const scope=this.scope(ctx),data=parse(reviewWorkflowSchema,input),payload=this.read(scope,data.id);if(payload.version!==data.expected_version)throw new PortalError('version_conflict');if(payload.state!=='draft')throw new PortalError('document_state_not_editable');const result=this.reviewPayload(scope,payload);if(result.kind==='needs_input')return {status:'needs_input' as const,...result};this.assertPayloadGates(ctx,payload,true,true);return {status:'success' as const,...result.data};}
  approve(ctx:PortalContext,input:unknown,key:string){const scope=this.scope(ctx,true),data=parse(approveWorkflowSchema,input);return this.idempotent(ctx,scope,'approve',data.id,key,data,()=>{const current=this.read(scope,data.id);if(current.version!==data.expected_version)throw new PortalError('version_conflict');if(current.state!=='draft')throw new PortalError('version_conflict');this.assertPayloadGates(ctx,current,true,true);const review=this.reviews.get(data.review_hash);if(!review||review.kind!=='enterprise'||review.actor!==scope.user||review.id!==current.id||review.version!==current.version||review.expires<Date.now()||review.content_digest!==this.contentDigest(current))throw new PortalError('document_review_stale');const claimed=current.revision_id?current:this.claimIfNeeded(scope,current).payload;if(review.revision_id!==null&&review.revision_id!==claimed.revision_id)throw new PortalError('document_review_stale');const sourceDigest=this.contentDigest(claimed),stored=this.append(scope,claimed,{state:'approved',approval:{...data,source_revision_id:claimed.revision_id,source_version:claimed.version,source_content_digest:sourceDigest,approved_revision_id:'',approved_version:claimed.version+1,review_expires_at:review.expires,actor:scope.user,at:new Date().toISOString()},approval_provenance:null},'approve',claimed.revision_id,data.review_hash);return this.view(stored);});}
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
    return error instanceof PortalError&&['document_expired','native_quote_release_expired','native_quote_source_changed','native_quote_validity_invalid','inquiry_quote_case_closed','inquiry_quote_case_review_required','document_review_stale','document_not_approved'].includes(error.code);
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
    if(data.mode==='draft'&&current.state==='approved')throw new PortalError('document_export_mode_invalid');
    if(data.mode==='draft'&&!completenessOf(current.input).complete)throw new PortalError('document_incomplete');
    if(data.mode==='formal'){
      if(current.state!=='approved')throw new PortalError('document_not_approved');
      this.assertApprovalPayload(current);
    }
    this.assertPayloadGates(ctx,current,current.document_kind==='linked',data.mode==='formal');
    const cached=this.store.store.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=?').get(data.id,current.version) as {sha256:string;bytes:Uint8Array}|undefined;
    if(cached)return this.exportView(current,current.version,current.revision_id,data.id,cached.sha256,this.validatePdf(cached),data.mode==='draft',false,current.version);
    this.store.ensureWritable();
    const html=renderHtml(renderDocument(current.input),current.template as never,data.mode==='formal');
    let bytes:Buffer;
    try{bytes=await this.renderer(html);}catch{throw new PortalError('document_renderer_unavailable');}
    const latestScope=this.scope(ctx,current.document_kind==='linked'),latest=this.read(latestScope,data.id);
    if(latest.version!==current.version||latest.revision_id!==current.revision_id)throw new PortalError('version_conflict');
    this.assertPayloadGates(ctx,latest,latest.document_kind==='linked',data.mode==='formal');
    if(data.mode==='formal')this.assertApprovalPayload(latest);
    if(data.mode==='draft'&&latest.state==='approved')throw new PortalError('document_export_mode_invalid');
    if(bytes.length<100||bytes.length>8388608||bytes.subarray(0,5).toString()!=='%PDF-')throw new PortalError('document_pdf_invalid');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    this.store.store.db.prepare('INSERT OR IGNORE INTO document_pdfs VALUES(?,?,?,?)').run(current.id,current.version,sha256,bytes);
    const readback=this.store.store.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=?').get(current.id,current.version) as {sha256:string;bytes:Uint8Array}|undefined;
    if(!readback)throw new PortalError('document_readback_failed');
    return this.exportView(latest,current.version,current.revision_id,data.id,readback.sha256,this.validatePdf(readback),data.mode==='draft',false,current.version);
  }
  private readVersion(scope:Scope,id:string,version:number):StoredPayload|null{if(this.store.isV3()){const row=this.store.store.db.prepare('SELECT payload FROM document_revisions WHERE document_id=? AND org=? AND version=?').get(id,scope.org,version) as {payload:string}|undefined;if(row)return JSON.parse(row.payload) as StoredPayload;}const legacy=this.readLegacy(scope,id);if(legacy.version===version)return legacy;return null;}
  private exportView(payload:StoredPayload|null,version:number,revisionId:string|null,id:string,sha256:string,bytes:Buffer,draft:boolean,historical:boolean,currentVersion:number){return {id,version,revision_id:revisionId,current_version:currentVersion,mode:historical?'history':draft?'draft':'formal',draft,historical,valid_now:!historical,target_version:version,filename:`quotation-${id}-v${version}.pdf`,sha256,byte_length:bytes.length,content_base64:bytes.toString('base64'),totals:payload?totalsOf(payload.input):null};}
}
