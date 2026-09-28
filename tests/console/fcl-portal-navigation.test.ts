import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';

it('does not create a return redirect while the portal session is still loading',()=>{
 const source=readFileSync('apps/console/app.js','utf8');
 const body=source.slice(source.indexOf('function renderLogin() {'),source.indexOf('function ensureShell()'));
 const saved=new Map<string,string>();
 const context={model:{session:null as null|{authenticated:boolean}},portalMode:'ops',sessionStorage:{setItem:(k:string,v:string)=>saved.set(k,v)},location:{hash:'#fcl'},peekLoginDestination:()=>true,loginStorage:()=>null,document:{title:''},app:{className:'',innerHTML:''},brand:()=>'',icon:()=>'',authRecoveryNotice:()=>''};
 runInNewContext(body+'renderLogin();',context);
 expect(saved.has('freightclaw.portal-return')).toBe(false);
 context.model.session={authenticated:false};runInNewContext(body+'renderLogin();',context);
 expect(JSON.parse(saved.get('freightclaw.portal-return')!)).toMatchObject({path:'/ops/'});
});

it('carries the saved inquiry link after the exchanged credential was removed from the address bar',()=>{
 const source=readFileSync('apps/inquiry/fcl-inquiry.js','utf8');
 const start=source.indexOf("if(button.dataset.action==='fcl-open-customer'){");
 const body=source.slice(start,source.indexOf("if (button.dataset.action === 'fcl-copy-link'",start));
 const saved=new Map<string,string>();let destination='';
 runInNewContext('(function(){'+body+'})()',{button:{dataset:{action:'fcl-open-customer'}},accessLink:'https://fixture.test/inquiry/#fcl-ticket/fixture-id/fixture-credential',location:{hash:'',assign:(path:string)=>{destination=path;}},URL,sessionStorage:{setItem:(k:string,v:string)=>saved.set(k,v)},render:()=>{}});
 expect(JSON.parse(saved.get('freightclaw.pending-claim')||'null')).toMatchObject({inquiry_id:'fixture-id',credential:'fixture-credential'});
 expect(destination).toBe('/customer/');
});
