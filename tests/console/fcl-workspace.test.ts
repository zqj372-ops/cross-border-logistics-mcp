/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Browser ESM helpers are intentionally untyped for runtime bundling. */
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
// @ts-expect-error Browser ESM module intentionally has no TypeScript declaration.
import {selectWorkspaceQuoteRef,nextDocumentOperation,nextQuoteOperation,quoteDraftFromView,verifyPdfOutput} from '../../apps/console/fcl.js';

describe('FCL workspace state transitions and PDF verification',()=>{
  it('uses create only before a current quote or document exists',()=>{
    expect(nextQuoteOperation(null)).toBe('create');
    expect(nextQuoteOperation({quote_ref:'quote-1'})).toBe('update');
    expect(nextDocumentOperation(null)).toBe('create');
    expect(nextDocumentOperation({state:'draft'})).toBe('refresh');
    expect(nextDocumentOperation({state:'rejected'})).toBe('resubmit');
    expect(nextDocumentOperation({state:'approved'})).toBe('re_quote');
  });

  it('opens the explicitly selected quote even when same-time list order or pagination differs',()=>{
    const earlier='00000000-0000-4000-8000-000000000099',selected='00000000-0000-4000-8000-000000000001';
    expect(selectWorkspaceQuoteRef([{quote_ref:earlier}],selected)).toBe(selected);
    expect(selectWorkspaceQuoteRef([{quote_ref:earlier}],null)).toBe(earlier);
    expect(()=>{selectWorkspaceQuoteRef([], 'invalid-ref');}).toThrow();
  });

  it('reconstructs source sell prices, manual fees and only explicit service scopes',()=>{
    const draft=quoteDraftFromView({
      cost_rows:[
        {row_key:'ocean_freight:40HQ',source_kind:'ocean_freight',sell_price:'3500',customer_note:'Source note'},
        {row_key:'manual:00000000-0000-4000-8000-000000000001',source_kind:'manual',template_ref:null,name:'Manual fee',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'25',sell_price:'40',currency:'CAD',internal_note:'internal',customer_note:'customer',evidence_ref:'fixture:manual',evidence_version:'v1',quantity_conditions:null},
      ],
      service_coverage:[
        {service:'ocean_freight',disposition:'priced',note:null,included_row_refs:['ocean_freight:40HQ']},
        {service:'delivery',disposition:'included',note:'Included in door delivery',included_row_refs:['manual:00000000-0000-4000-8000-000000000001']},
      ],
      exchange_rates:{USD:'7.2',CAD:null},
      remark:'Synthetic quote',
    });
    expect(draft.source_sell_prices).toEqual([{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:'Source note'}]);
    expect(draft.manual_fees[0]).toMatchObject({id:'00000000-0000-4000-8000-000000000001',name:'Manual fee',cost_price:'25',sell_price:'40'});
    expect(draft.service_scopes).toEqual([{service:'delivery',disposition:'included',note:'Included in door delivery',included_row_refs:['manual:00000000-0000-4000-8000-000000000001']}]);
    expect(draft.exchange_rates).toEqual({USD:'7.2',CAD:null});
  });

  it('verifies PDF bytes and sha256 before exposing the formal export reference',async()=>{
    const bytes=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
    const output={filename:'fcl-00000000-0000-4000-8000-000000000001-v1.pdf',byte_length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content_base64:bytes.toString('base64')};
    await expect(verifyPdfOutput(output)).resolves.toEqual(Uint8Array.from(bytes));
    await expect(verifyPdfOutput({...output,sha256:'0'.repeat(64)})).rejects.toMatchObject({code:'fcl_pdf_hash_mismatch'});
    await expect(verifyPdfOutput({...output,filename:'../escape.pdf'})).rejects.toMatchObject({code:'fcl_pdf_filename_invalid'});
  });
});
