import {existsSync,readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {generatePortalOpenApi} from '../../deploy/scripts/generate-portal-openapi';
import {FCL_HTTP_BODY_LIMITS,FCL_HTTP_MAX_RESPONSE_BYTES,FCL_HTTP_RESPONSE_LIMITS,FCL_HTTP_VERSION,FCL_PUBLIC_BODY_LIMITS,FCL_STAFF_ACTION_METHODS,fclHttpActions,FCL_PUBLIC_ROUTES} from '../../services/access-gateway/portal/fcl-http-contracts';

it('documents the exact FCL staff and public HTTP contracts without widening machine credentials',()=>{
  const document=generatePortalOpenApi(),paths=document.paths as Record<string,Record<string,Record<string,unknown>>>;
  const staffWrites=new Set(['case-status','case-staff-supplement','case-confirm','rate-save','rate-publish','rate-disable','rate-rollback','quote-save','issuer-config-save','document-save','document-approve','document-reject','document-export','handoff-save','notification-save']);
  for(const action of fclHttpActions){
    const operation=paths[`/console/api/v1/fcl/${action}`]![FCL_STAFF_ACTION_METHODS[action].toLowerCase()]!;
    expect(operation.security,action).toEqual([{PortalSession:[]}]);
    expect(operation['x-freightclaw-max-request-bytes'],action).toBe(FCL_HTTP_BODY_LIMITS[action]);
    expect(operation['x-freightclaw-max-response-bytes'],action).toBe(FCL_HTTP_RESPONSE_LIMITS[action]);
    expect(JSON.stringify(operation)).toContain(FCL_HTTP_VERSION);
    if(FCL_STAFF_ACTION_METHODS[action]==='POST')expect(operation.parameters,action).toEqual(expect.arrayContaining([expect.objectContaining({name:'X-CSRF-Token',required:true})]));
    if(staffWrites.has(action))expect(operation.parameters,action).toEqual(expect.arrayContaining([expect.objectContaining({name:'Idempotency-Key',required:true})]));
  }
  const ratePreview=paths['/console/api/v1/fcl/rate-preview']!.get!;
  expect(ratePreview.parameters).toEqual(expect.arrayContaining([expect.objectContaining({name:'release_id',in:'query',required:false})]));
  const caseList=paths['/console/api/v1/fcl/case-list']!.get!;
  expect(caseList.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({name:'limit',in:'query'}),
    expect.objectContaining({name:'status',in:'query'}),
    expect.objectContaining({name:'cursor',in:'query'}),
  ]));
  for(const action of ['session','submit','exchange','get','supplement','logout'] as const){
    const route=FCL_PUBLIC_ROUTES[action],operation=paths[route.path]![route.method.toLowerCase()]!;
    if(action==='session')expect(operation.security,action).toEqual([]);
    else expect(operation.security,action).toEqual([{InquirySession:[]}]);
    if(route.method==='POST'&&action!=='session')expect(operation.parameters,action).toEqual(expect.arrayContaining([expect.objectContaining({name:'X-CSRF-Token',required:true}),expect.objectContaining({name:'Idempotency-Key',required:true})]));
    if(action in FCL_PUBLIC_BODY_LIMITS)expect(operation['x-freightclaw-max-request-bytes'],action).toBe(FCL_PUBLIC_BODY_LIMITS[action as keyof typeof FCL_PUBLIC_BODY_LIMITS]);
    expect(operation['x-freightclaw-max-response-bytes'],action).toBe(FCL_HTTP_MAX_RESPONSE_BYTES);
    if(route.method==='POST')expect(operation.requestBody,action).toBeDefined();
  }
  const components=(document as {components:{schemas:Record<string,unknown>;securitySchemes:Record<string,unknown>}}).components;
  const publicSubmit=components.schemas.FclPublicSubmitRequest as {properties:Record<string,unknown>};
  expect(publicSubmit.properties).not.toHaveProperty('credential');
  expect(JSON.stringify(paths['/inquiry/api/v1/fcl/credential/exchange'])).not.toContain('"example"');
  for(const path of Object.keys(paths).filter(path=>path.startsWith('/console/api/v1/fcl/')||path.startsWith('/inquiry/api/v1')))expect(JSON.stringify(paths[path])).not.toMatch(/ApplicationKey|BearerToken/u);
  for(const path of Object.keys(paths).filter(path=>path.startsWith('/console/api/v1/fcl/')||path.startsWith('/inquiry/api/v1')))expect(path.startsWith('/console/api/v1/fcl/')?JSON.stringify(paths[path]).includes('PortalSession'):true).toBe(true);
  const security=(components.securitySchemes as Record<string,{name?:string;in?:string}>);
  expect(security.InquirySession).toMatchObject({name:'fc_fcl_public',in:'cookie'});
  const schemas=components.schemas;
  expect(schemas.FclDocumentExportResponse).toBeDefined();
  expect(JSON.stringify(schemas.FclDocumentExportResponse)).toContain('content_base64');
  expect(JSON.stringify(schemas.FclRatePreviewRequest)).toContain('release_id');
  expect(JSON.stringify(schemas.FclPublicSubmitRequest)).toContain('additionalProperties');
});

it('restores the implementation-time FCL audit and proposal without treating the proposal as runtime authority',()=>{
  expect(existsSync('docs/product/2026-09-20-fcl-main-loop-audit.md')).toBe(true);
  expect(existsSync('docs/rfcs/2026-09-20-fcl-main-loop.schema.json')).toBe(true);
  expect(readFileSync('docs/product/2026-09-20-fcl-main-loop-audit.md','utf8')).toContain('实施前快照');
  expect(readFileSync('docs/rfcs/2026-09-20-fcl-main-loop.schema.json','utf8')).toContain('"$schema"');
  expect(readFileSync('docs/rfcs/2026-09-20-fcl-inquiry-quote-loop-v1.md','utf8')).toContain('FCL.13c');
});
