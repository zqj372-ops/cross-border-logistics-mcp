import {createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes,randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {NativeAdminStore} from './native-admin';
import {PortalError,type PortalContext} from './contracts';
import type {FclMailMessage,FclMailTransport} from './cases';
import {createFclSmtpTransport,parseFclSmtpConfig,type FclSmtpConfig} from './fcl-smtp-transport';

import {smtpSaveSchema,smtpTestSchema,smtpActivateSchema,smtpViewSchema} from './fcl-smtp-settings-contracts';
type State={version:number;active:FclSmtpConfig|null;draft:FclSmtpConfig|null;test_status:z.infer<typeof smtpViewSchema>['test_status'];test_recipient:string|null};
export class FclSmtpSettings implements FclMailTransport{
  readonly #key:Buffer;
  readonly #options: {store:NativeAdminStore;ownerId:string;secret:string;fallback:FclMailTransport;initial?:FclSmtpConfig;transport?:(config:FclSmtpConfig)=>FclMailTransport};
  private readonly scope:string;
  constructor(options:{store:NativeAdminStore;ownerId:string;secret:string;fallback:FclMailTransport;initial?:FclSmtpConfig;transport?:(config:FclSmtpConfig)=>FclMailTransport}){
    this.#options=options;
    if(Buffer.byteLength(options.secret)<32)throw new Error('fcl_smtp_config_invalid');
    this.#key=Buffer.from(hkdfSync('sha256',options.secret,options.ownerId,'freightclaw-smtp-settings-v1',32));this.scope=`fcl-smtp:${options.ownerId}`;
  }
  private authorize(ctx:PortalContext){if(!ctx.identity.emailVerified||ctx.identity.userId!==this.#options.ownerId)throw new PortalError('fcl_not_found');}
  private seal(value:State){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(Buffer.from(this.scope));const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});}
  private read():State{
    const row=this.#options.store.db.prepare("SELECT draft FROM native_configs WHERE scope=? AND kind='smtp-settings'").get(this.scope) as {draft:string}|undefined;
    if(!row)return {version:0,active:null,draft:null,test_status:'not_tested',test_recipient:null};
    try{const sealed=JSON.parse(row.draft) as {iv:string;tag:string;data:string};const cipher=createDecipheriv('aes-256-gcm',this.#key,Buffer.from(sealed.iv,'base64'));cipher.setAAD(Buffer.from(this.scope));cipher.setAuthTag(Buffer.from(sealed.tag,'base64'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.data,'base64')),cipher.final()]).toString()) as State;}catch{throw new PortalError('native_readback_failed');}
  }
  private persist(state:State){this.#options.store.db.prepare("INSERT INTO native_configs(scope,kind,version,draft,active) VALUES(?,'smtp-settings',?,?,NULL) ON CONFLICT(scope,kind) DO UPDATE SET version=excluded.version,draft=excluded.draft").run(this.scope,state.version,this.seal(state));}
  private public(state:State){const safe=(value:FclSmtpConfig|null|undefined)=>value?{host:value.host,port:value.port,secure:value.secure,username:value.username,from:value.from,from_name:value.from_name??'',reply_to:value.reply_to??null}:null;return smtpViewSchema.parse({can_edit:true,version:state.version,active:safe(state.active??this.#options.initial),draft:safe(state.draft),password_present:Boolean(state.draft?.password),test_status:state.test_status,test_recipient:state.test_recipient});}
  get(ctx:PortalContext){this.authorize(ctx);return this.public(this.read());}
  private mutate(ctx:PortalContext,action:string,input:unknown,key:string,change:(state:State)=>void){
    this.authorize(ctx);if(!/^[A-Za-z0-9._:-]{16,128}$/u.test(key))throw new PortalError('idempotency_key_invalid');
    const db=this.#options.store.db,scope=`${this.scope}:${action}`,digest=createHmac('sha256',this.#key).update(JSON.stringify(input)).digest('hex');
    db.exec('BEGIN IMMEDIATE');try{
      const old=db.prepare('SELECT digest FROM native_idempotency WHERE scope=? AND key=?').get(scope,key) as {digest:string}|undefined;
      if(old){if(old.digest!==digest)throw new PortalError('idempotency_conflict');db.exec('COMMIT');return {replay:true,view:this.get(ctx)};}
      const state=this.read();change(state);this.persist(state);const view=this.get(ctx);
      db.prepare('INSERT INTO native_idempotency VALUES(?,?,?,?)').run(scope,key,digest,JSON.stringify(view));
      db.prepare('INSERT INTO native_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(),this.scope,'smtp-settings',ctx.identity.userId,action,digest,new Date().toISOString());db.exec('COMMIT');return {replay:false,view};
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  save(ctx:PortalContext,input:unknown,key:string){const r=smtpSaveSchema.parse(input);return this.mutate(ctx,'save',r,key,s=>{if(s.version!==r.expected_version)throw new PortalError('version_conflict');const same=s.draft&&s.draft.host===r.connection.host&&s.draft.port===r.connection.port&&s.draft.secure===r.connection.secure&&s.draft.username===r.connection.username;const password=r.password??(same?s.draft!.password:null);if(!password)throw new PortalError('fcl_smtp_password_required');s.draft=parseFclSmtpConfig({...r.connection,password});s.version++;s.test_status='not_tested';s.test_recipient=null;}).view;}
  async test(ctx:PortalContext,input:unknown,key:string){
    const r=smtpTestSchema.parse(input);const reserved=this.mutate(ctx,'test',r,key,s=>{if(s.version!==r.expected_version)throw new PortalError('version_conflict');if(!s.draft)throw new PortalError('fcl_smtp_draft_required');if(s.test_status==='pending'||s.test_status==='unknown')throw new PortalError('fcl_smtp_test_unknown');s.test_status='pending';s.test_recipient=r.recipient;});if(reserved.replay)return reserved.view;
    const config=this.read().draft!;let status:State['test_status']='smtp_accepted';
    try{await(this.#options.transport??createFclSmtpTransport)(config).send({to:r.recipient,cc:[],subject:'[FreightClaw] 发信服务测试',body:'这是一封发信配置测试邮件，不涉及真实运输订单。\n收到后可返回邮件设置启用新服务。'});}catch(e){status=e instanceof Error&&e.message==='fcl_smtp_rejected'?'failed':'unknown';}
    const db=this.#options.store.db;db.exec('BEGIN IMMEDIATE');try{const state=this.read();if(state.version===r.expected_version&&state.test_status==='pending'){state.test_status=status;this.persist(state);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return this.get(ctx);
  }
  activate(ctx:PortalContext,input:unknown,key:string){const r=smtpActivateSchema.parse(input);return this.mutate(ctx,'activate',r,key,s=>{if(s.version!==r.expected_version)throw new PortalError('version_conflict');if(!s.draft||s.test_status!=='smtp_accepted')throw new PortalError('fcl_smtp_test_required');s.active=s.draft;s.version++;}).view;}
  async send(message:FclMailMessage){const state=this.read();return(state.active?(this.#options.transport??createFclSmtpTransport)(state.active):this.#options.fallback).send(message);}
}
