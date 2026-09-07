import assert from 'node:assert/strict';
// Domain-flow tests select fixture roles through the fixture API. The actual
// account/password/captcha form has its own login acceptance coverage.
export async function loginFixture(page,base,label){
 if(new URL(base).protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('loopback_fixture_required');
 const email=label.match(/(?:developer|owner|sales|reviewer|operator)@example\.test/u)?.[0];
 if(!email)throw new Error('fixture_identity_invalid');
 const request=page.context().request;const session=await (await request.get(`${base}/console/api/v1/session`)).json();
 assert.equal(session.mode,'fixtures');
 const result=await request.post(`${base}/console/api/v1/fixture-login`,{headers:{origin:base,'x-csrf-token':session.csrf_token,'idempotency-key':crypto.randomUUID()},data:{identity_id:`fixture-${email.split('@')[0]}`}});assert.equal(result.status(),200);
 await page.goto(`${base}/console/?fixture-login=${crypto.randomUUID()}#home`);await page.locator('.customer-shell').waitFor();
}
