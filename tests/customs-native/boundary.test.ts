import { expect, it } from 'vitest';
import { NativeCustomsEngine } from '../../services/customs-native/engine';
it('does not call an old service or return fixture rates when no release is published',async()=>{
 const engine=new NativeCustomsEngine({current:()=>null});
 const result=await engine.query({query:'732393',ruleDate:'2026-09-07',codeCountry:'CA',attributes:{originCountry:'CN'}});
 expect(result.status).toBe('unavailable');expect(result.data).toBeNull();expect(result.reason_codes).toEqual(['native_customs_not_published']);
});
