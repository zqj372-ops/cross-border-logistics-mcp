/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Browser ESM helpers are intentionally untyped for runtime bundling. */
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
// @ts-expect-error Browser ESM module intentionally has no TypeScript declaration.
import {assembleFclQuoteRowAdjustments,buildFclQuoteInputDraft,canEditFclQuote,canViewFclDocuments,selectWorkspaceQuoteRef,nextDocumentOperation,nextQuoteOperation,quoteDraftFromView,verifyPdfOutput} from '../../apps/console/fcl.js';
import {FCL_DOCUMENT_WORKFLOW_VERSION,buildFclCostSellSnapshot} from '../../services/quote-native/fcl';

describe('FCL workspace state transitions and PDF verification',()=>{
  it('uses create only before a current quote or document exists',()=>{
    expect(nextQuoteOperation(null)).toBe('create');
    expect(nextQuoteOperation({quote_ref:'quote-1'})).toBe('update');
    expect(nextDocumentOperation(null)).toBe('create');
    expect(nextDocumentOperation({state:'draft'})).toBe('refresh');
    expect(nextDocumentOperation({state:'rejected'})).toBe('resubmit');
    expect(nextDocumentOperation({state:'approved'})).toBe('re_quote');
  });

  it('enables quote editing only for a current quote in an open, reviewed case',()=>{
    const quote={currentness:{valid_now:true}},detail={case_status:'in_review',review_context:{review_required:false}};
    expect(canEditFclQuote(detail,quote)).toBe(true);
    expect(canEditFclQuote({...detail,case_status:'closed'},quote)).toBe(false);
    expect(canEditFclQuote({...detail,review_context:{review_required:true}},quote)).toBe(false);
    expect(canEditFclQuote(detail,{currentness:{valid_now:false}})).toBe(false);
  });

  it('keeps historical documents reachable when a quote is invalid or its case is closed',()=>{
    expect(canViewFclDocuments({currentness:{valid_now:true}},null,null)).toBe(true);
    expect(canViewFclDocuments({currentness:{valid_now:false}},{document_id:'doc-1'},null)).toBe(true);
    expect(canViewFclDocuments({currentness:{valid_now:false}},null,{items:[{document_id:'doc-1'}]})).toBe(true);
    expect(canViewFclDocuments({currentness:{valid_now:false}},null,{items:[]})).toBe(false);
    expect(canViewFclDocuments({currentness:{valid_now:false}},{document_id:'doc-1'},null,true)).toBe(false);
  });

  it('opens the explicitly selected quote even when same-time list order or pagination differs',()=>{
    const earlier='00000000-0000-4000-8000-000000000099',selected='00000000-0000-4000-8000-000000000001';
    expect(selectWorkspaceQuoteRef([{quote_ref:earlier}],selected)).toBe(selected);
    expect(selectWorkspaceQuoteRef([{quote_ref:earlier}],null)).toBe(earlier);
    expect(()=>{selectWorkspaceQuoteRef([], 'invalid-ref');}).toThrow();
  });

  it('reconstructs source sell prices, manual fees and only explicit service scopes',()=>{
    const view={
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
    };
    const draft=quoteDraftFromView(view);
    expect(draft.source_sell_prices).toEqual([{row_key:'ocean_freight:40HQ',sell_price:'3500',customer_note:'Source note'}]);
    expect(draft.manual_fees[0]).toMatchObject({id:'00000000-0000-4000-8000-000000000001',name:'Manual fee',cost_price:'25',sell_price:'40'});
    expect(draft.service_scopes).toEqual([{service:'delivery',disposition:'included',note:'Included in door delivery',included_row_refs:['manual:00000000-0000-4000-8000-000000000001']}]);
    expect(draft.exchange_rates).toEqual({USD:'7.2',CAD:null});
  });

  it('round-trips only writable extensions and drops stale removed-manual adjustments',()=>{
    const estimate={estimate_id:'00000000-0000-4000-8000-000000000099',version:2,content_digest:'a'.repeat(64),valid_from:'2026-10-01',valid_until:'2026-10-31'};
    const view={
      cost_rows:[
        {row_key:'ocean_freight:40HQ',source_kind:'ocean_freight',sell_price:'3500',customer_note:null},
        {row_key:'manual:00000000-0000-4000-8000-000000000001',source_kind:'manual',template_ref:null,name:'Manual fee',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'25',sell_price:'40',currency:'CAD',internal_note:null,customer_note:null,evidence_ref:'fixture:manual',evidence_version:'v1',quantity_conditions:null},
      ],
      service_coverage:[
        {service:'ocean_freight',disposition:'priced',note:null,included_row_refs:['ocean_freight:40HQ']},
        {service:'delivery',disposition:'priced',note:null,included_row_refs:['manual:00000000-0000-4000-8000-000000000001']},
      ],
      exchange_rates:{USD:'7.2',CAD:null},
      remark:null,
      extensions:{
        fcl_estimate_v1:estimate,
        fcl_row_adjustments_v1:{changes:[
          {row_key:'ocean_freight:20GP',operation:'remove',reason:'Source row remains a reconstructable removal'},
          {row_key:'manual:00000000-0000-4000-8000-000000000001',operation:'override',cost_price:'25',reason:'Keep the present manual override'},
          {row_key:'manual:00000000-0000-4000-8000-000000000002',operation:'remove',reason:'This manual row is already absent'},
        ]},
        fcl_row_adjustment_audit_v1:{changes:[{row_key:'manual:00000000-0000-4000-8000-000000000002',operation:'remove',reason:'This manual row is already absent',original:{quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'10',sell_price:'20'},effective:null,actor:'receiver',created_at:'2026-10-08T12:00:00.000Z'}]},
      },
    };
    const draft=quoteDraftFromView(view);
    expect(draft.extensions).toEqual({
      fcl_estimate_v1:estimate,
      fcl_row_adjustments_v1:{changes:[
        {row_key:'ocean_freight:20GP',operation:'remove',reason:'Source row remains a reconstructable removal'},
        {row_key:'manual:00000000-0000-4000-8000-000000000001',operation:'override',cost_price:'25',reason:'Keep the present manual override'},
      ]},
    });
    expect(draft.extensions).not.toHaveProperty('fcl_row_adjustment_audit_v1');
    draft.extensions.fcl_estimate_v1.version=99;draft.extensions.fcl_row_adjustments_v1.changes[0].reason='mutated';
    expect(view.extensions?.fcl_estimate_v1?.version).toBe(2);
    expect(view.extensions?.fcl_row_adjustments_v1?.changes[0]?.reason).toBe('Source row remains a reconstructable removal');
  });

  it('audits existing template-fee overrides from the baseline and does not revive a saved manual removal',()=>{
    const rowKey='manual:00000000-0000-4000-8000-000000000010';
    const base={row_key:rowKey,source_kind:'manual',id:'00000000-0000-4000-8000-000000000010',template_ref:null,name:'目的港操作费',group:'C',service:'delivery',quantity:'2',unit:'CNTR',container_type:'40HQ',cost_price:'200',sell_price:'220',currency:'CAD',internal_note:null,customer_note:null,evidence_ref:'fcl-estimate:fixture',evidence_version:'1',quantity_conditions:null,cost_amount:'400.00',sell_amount:'440.00',fully_priced:true};
    const effective={...base,cost_price:'260',sell_price:'300',currency:'USD'};
    const changes=assembleFclQuoteRowAdjustments({rows:[effective],manualBases:new Map([[rowKey,base]]),touchedKeys:new Set([rowKey]),reason:'Supplier increased the ticket fee'});
    expect(changes).toEqual([{row_key:rowKey,operation:'override',reason:'Supplier increased the ticket fee',cost_price:'260',sell_price:'300'}]);
    const input=buildFclQuoteInputDraft({draft:{source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null},rows:[effective],manualBases:new Map([[rowKey,base]]),changes});
    expect(input.manual_fees[0]).toMatchObject({cost_price:'200',sell_price:'220',currency:'CAD'});
    const newFee={...effective,row_key:'manual:00000000-0000-4000-8000-000000000015',id:'00000000-0000-4000-8000-000000000015',name:'新增人工费',evidence_ref:null,evidence_version:null};
    const newInput=buildFclQuoteInputDraft({draft:{source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null},rows:[newFee],manualBases:new Map()});
    expect(newInput.manual_fees[0]).toMatchObject({evidence_ref:null,evidence_version:null});
    const caseView={case_id:'00000000-0000-4000-8000-000000000011',case_status:'in_review',case_version:1,current_input:{pol:'Shanghai',pod:'Vancouver',containers:[{type:'40HQ',quantity:2}],selected_services:['delivery'],incoterm:'EXW'},review_context:{latest_customer_supplement_ref:null,last_confirmed_case_version:1,last_confirmed_customer_supplement_ref:null,review_required:false}};
    const selected={rate_id:'00000000-0000-4000-8000-000000000012',release_id:'00000000-0000-4000-8000-000000000013',release_version:1,dataset_digest:'a'.repeat(64),source_ref:'fixture:rate',source_version:'1',valid_from:'2026-10-01',valid_until:'2026-10-31',rate:{rate_id:'00000000-0000-4000-8000-000000000012',supplier_label:'Fixture',pol:'Shanghai',pod:'Vancouver',valid_from:'2026-10-01',valid_until:'2026-10-31',source_ref:'fixture:rate',source_version:'1',note:null,items:[{container_type:'40HQ',ocean_freight:'1',currency:'USD'}],additional_fees:[]},selected_at:'2026-10-08T12:00:00.000Z',case_ref:caseView.case_id,case_version:1,latest_customer_supplement_ref:null};
    type BuildInput=Parameters<typeof buildFclCostSellSnapshot>[0]['input'];
    const build=(inputData:BuildInput)=>buildFclCostSellSnapshot({contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,quote_ref:'00000000-0000-4000-8000-000000000014',version:1,actor:'receiver',created_at:'2026-10-08T12:00:00.000Z',caseView:caseView as never,selected:selected as never,input:inputData});
    const asInput=(value:unknown)=>value as BuildInput;
    const snapshot=build(asInput(input));
    expect(snapshot.extensions?.fcl_row_adjustment_audit_v1?.changes[0]).toMatchObject({original:{cost_price:'200',sell_price:'220'},effective:{cost_price:'260',sell_price:'300'}});
    const auditOriginal=snapshot.extensions?.fcl_row_adjustment_audit_v1?.changes[0]?.original,reloadedBase={...snapshot.cost_rows[0],cost_price:auditOriginal?.cost_price,sell_price:auditOriginal?.sell_price,unit:auditOriginal?.unit,container_type:auditOriginal?.container_type,quantity:auditOriginal?.quantity};
    const reloadedEffective={...snapshot.cost_rows[0],cost_price:'280',sell_price:'320'};
    const reloadedChanges=assembleFclQuoteRowAdjustments({existingChanges:snapshot.extensions?.fcl_row_adjustments_v1?.changes||[],rows:[reloadedEffective as never],manualBases:new Map([[rowKey,reloadedBase]]),touchedKeys:new Set([rowKey]),reason:'Second ticket edit after reload'});
    const reloadedInput=buildFclQuoteInputDraft({draft:quoteDraftFromView(snapshot),rows:[reloadedEffective as never],manualBases:new Map([[rowKey,reloadedBase]]),changes:reloadedChanges});
    const reloadedSnapshot=build(asInput(reloadedInput));
    expect(reloadedSnapshot.extensions?.fcl_row_adjustment_audit_v1?.changes[0]).toMatchObject({row_key:rowKey,original:{cost_price:'200',sell_price:'220'},effective:{cost_price:'280',sell_price:'320'}});
    const removed=assembleFclQuoteRowAdjustments({rows:[],manualBases:new Map([[rowKey,base]]),manualRemovals:new Set([rowKey]),reason:'Remove the ticket fee'});
    const removedInput=buildFclQuoteInputDraft({draft:{source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null},rows:[],manualBases:new Map([[rowKey,base]]),removedManualKeys:new Set([rowKey]),changes:removed});
    const removedSnapshot=build(asInput({...removedInput,service_scopes:[{service:'delivery',disposition:'free',note:'Removed from this ticket',included_row_refs:[]}]}));
    expect(removedSnapshot.cost_rows).toHaveLength(0);
    expect(removedSnapshot.extensions?.fcl_row_adjustment_audit_v1?.changes[0]).toMatchObject({row_key:rowKey,operation:'remove',effective:null});
    const nextDraft=quoteDraftFromView(removedSnapshot);
    const nextInput=buildFclQuoteInputDraft({draft:nextDraft,rows:[],manualBases:new Map()});
    const nextSnapshot=build(asInput({...nextInput,service_scopes:[{service:'delivery',disposition:'free',note:'Removed from this ticket',included_row_refs:[]}]}));
    expect(nextSnapshot.cost_rows).toHaveLength(0);
    expect(nextSnapshot.extensions?.fcl_row_adjustment_audit_v1).toBeUndefined();
  });

  it('preserves editable metadata on an existing manual fee without promoting adjusted values into its audit base',()=>{
    const rowKey='manual:00000000-0000-4000-8000-000000000030';
    const base={row_key:rowKey,source_kind:'manual',id:'00000000-0000-4000-8000-000000000030',template_ref:null,name:'Original name',group:'C',service:'delivery',quantity:'2',unit:'CNTR',container_type:'40HQ',cost_price:'200',sell_price:'220',currency:'CAD',internal_note:'Original internal',customer_note:'Original customer',evidence_ref:'fixture:original',evidence_version:'v1',quantity_conditions:'Original conditions',cost_amount:'400.00',sell_amount:'440.00',fully_priced:true};
    const effective={...base,name:'Updated name',cost_price:'260',sell_price:'300',unit:'SHIPMENT',container_type:null,quantity:'1',internal_note:'Updated internal',customer_note:'Updated customer',evidence_ref:'fixture:updated',evidence_version:'v2',quantity_conditions:'Updated conditions'};
    const changes=[{row_key:rowKey,operation:'override' as const,reason:'Correct the saved fee',cost_price:'260',sell_price:'300',unit:'SHIPMENT' as const,container_type:null}];
    const input=buildFclQuoteInputDraft({draft:{source_sell_prices:[],manual_fees:[],service_scopes:[],exchange_rates:{USD:null,CAD:null},remark:null},rows:[effective],manualBases:new Map([[rowKey,base]]),changes});
    expect(input.manual_fees[0]).toMatchObject({
      name:'Updated name',
      evidence_ref:'fixture:updated',
      evidence_version:'v2',
      quantity_conditions:'Updated conditions',
      customer_note:'Updated customer',
      internal_note:'Updated internal',
      cost_price:'200',
      sell_price:'220',
      unit:'CNTR',
      container_type:'40HQ',
      quantity:'2',
      group:'C',
      service:'delivery',
      currency:'CAD',
    });
    expect(input.extensions?.fcl_row_adjustments_v1?.changes).toEqual(changes);
  });

  it('retains manual-fee metadata after reload while preserving the original A1 adjustment baseline',()=>{
    const rowKey='manual:00000000-0000-4000-8000-000000000031';
    const original={row_key:rowKey,source_kind:'manual',id:'00000000-0000-4000-8000-000000000031',template_ref:null,name:'Saved fee',group:'C',service:'delivery',quantity:'2',unit:'CNTR',container_type:'40HQ',cost_price:'100',sell_price:'120',currency:'CAD',internal_note:'Old internal',customer_note:'Old customer',evidence_ref:'fixture:old',evidence_version:'v1',quantity_conditions:'Old conditions',cost_amount:'200.00',sell_amount:'240.00',fully_priced:true};
    const effective={...original,name:'Reloaded fee',cost_price:'150',sell_price:'180',internal_note:'Reloaded internal',customer_note:'Reloaded customer',evidence_ref:'fixture:reloaded',evidence_version:'v2',quantity_conditions:'Reloaded conditions'};
    const changes=[{row_key:rowKey,operation:'override' as const,reason:'Keep original baseline',cost_price:'150',sell_price:'180'}];
    const draft=quoteDraftFromView({
      cost_rows:[effective],
      service_coverage:[],
      exchange_rates:{USD:null,CAD:null},
      remark:null,
      extensions:{
        fcl_row_adjustments_v1:{changes},
        fcl_row_adjustment_audit_v1:{changes:[{row_key:rowKey,operation:'override',reason:'Keep original baseline',original:{quantity:'2',unit:'CNTR',container_type:'40HQ',cost_price:'100',sell_price:'120'},effective:{quantity:'2',unit:'CNTR',container_type:'40HQ',cost_price:'150',sell_price:'180'},actor:'receiver',created_at:'2026-10-08T12:00:00.000Z'}]},
      },
    });
    const input=buildFclQuoteInputDraft({draft,rows:[effective],manualBases:new Map([[rowKey,original]]),changes});
    expect(input.manual_fees[0]).toMatchObject({
      name:'Reloaded fee',
      evidence_ref:'fixture:reloaded',
      evidence_version:'v2',
      quantity_conditions:'Reloaded conditions',
      customer_note:'Reloaded customer',
      internal_note:'Reloaded internal',
      cost_price:'100',
      sell_price:'120',
      quantity:'2',
      unit:'CNTR',
      container_type:'40HQ',
    });
    expect(input.extensions?.fcl_row_adjustments_v1?.changes).toEqual(changes);
  });

  it('requires an audited reason before removing a saved manual fee from this ticket',()=>{
    const rowKey='manual:00000000-0000-4000-8000-000000000020';
    const base={row_key:rowKey,source_kind:'manual',id:'00000000-0000-4000-8000-000000000020',template_ref:null,name:'Saved ticket fee',group:'C',service:'delivery',quantity:'1',unit:'SHIPMENT',container_type:null,cost_price:'10',sell_price:'20',currency:'CAD',internal_note:null,customer_note:null,evidence_ref:'fixture:saved-fee',evidence_version:'v1',quantity_conditions:null,cost_amount:'10.00',sell_amount:'20.00',fully_priced:true};
    expect(()=>{assembleFclQuoteRowAdjustments({rows:[],manualBases:new Map([[rowKey,base]]),manualRemovals:new Set([rowKey])});}).toThrow('移除费用时请填写本票修改说明。');
    expect(assembleFclQuoteRowAdjustments({rows:[],manualBases:new Map([[rowKey,base]]),manualRemovals:new Set([rowKey]),reason:'Remove this ticket fee'})).toEqual([{row_key:rowKey,operation:'remove',reason:'Remove this ticket fee'}]);
  });

  it('verifies PDF bytes and sha256 before exposing the formal export reference',async()=>{
    const bytes=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
    const output={filename:'fcl-00000000-0000-4000-8000-000000000001-v1.pdf',byte_length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content_base64:bytes.toString('base64')};
    await expect(verifyPdfOutput(output)).resolves.toEqual(Uint8Array.from(bytes));
    await expect(verifyPdfOutput({...output,sha256:'0'.repeat(64)})).rejects.toMatchObject({code:'fcl_pdf_hash_mismatch'});
    await expect(verifyPdfOutput({...output,filename:'../escape.pdf'})).rejects.toMatchObject({code:'fcl_pdf_filename_invalid'});
  });
});
