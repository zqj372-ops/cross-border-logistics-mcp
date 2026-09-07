import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {calculate,renderHtml} from '../../services/quote-documents/engine';
import {sample,template} from './fixtures';
import {documentSchema} from '../../services/quote-documents/contracts';
describe('native quote documents',()=>{
 it('uses exact decimal totals and does not invent exchange rates',()=>{const d=sample(),v=calculate(d);expect(v.by_currency.USD).toBe('0.30');expect(v.total_cny).toBeNull();expect(v.total_usd).toBe('0.30');});
 it('honors hidden/merged visibility without leaking internal descriptions',()=>{const d=sample();d.fee_items.push({...d.fee_items[0]!,id:randomUUID(),name:'INTERNAL_SECRET',note:'PRIVATE_NOTE',display:'hiddenIncluded'},{...d.fee_items[0]!,id:randomUUID(),display:'hiddenExcluded'},{...d.fee_items[0]!,id:randomUUID(),name:'PRIVATE_MERGED',display:'merged',merge_name:'综合费用'});const v=calculate(d);expect(v.by_currency.USD).toBe('0.90');const html=renderHtml(d,template,false);expect(html).not.toContain('INTERNAL_SECRET');expect(html).not.toContain('PRIVATE_NOTE');expect(html).not.toContain('PRIVATE_MERGED');expect(html).toContain('综合费用');expect(html).toContain('DRAFT');});
 it('escapes text and rejects float money, missing merge names, duplicate IDs and invalid dates',()=>{const d=sample();d.customer_name='<script>alert(1)</script>';expect(renderHtml(d,template,false)).toContain('&lt;script&gt;');expect(documentSchema.safeParse({...d,valid_until:'2026-02-30'}).success).toBe(false);expect(documentSchema.safeParse({...d,fee_items:[{...d.fee_items[0],unit_price:0.1}]}).success).toBe(false);expect(documentSchema.safeParse({...d,fee_items:[d.fee_items[0],d.fee_items[0]]}).success).toBe(false);});
});
