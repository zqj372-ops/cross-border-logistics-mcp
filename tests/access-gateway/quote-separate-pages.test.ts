import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// The rendered HTML is checked here; real form submission is covered in browser QA.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
let createBusinessWorkspace: (ui: unknown) => {quotePage:(kind:string)=>string;reset:()=>void};
let marketServices: {id:string;online?:string}[];
beforeAll(async()=>{({createBusinessWorkspace}=await import(pathToFileURL(resolve('apps/console/business.js')).href) as {createBusinessWorkspace:typeof createBusinessWorkspace});({marketServices}=await import(pathToFileURL(resolve('apps/console/service-catalog.js')).href) as {marketServices:typeof marketServices});});
const esc = (s: string | number | null | undefined) => String(s ?? '');
const ui = { esc, head: (title: string, description: string, action = '') => `<h1>${title}</h1>${description}${action}`, panel: (title: string, description: string, body: string) => title + description + body, field: (label: string, _id: string, body: string) => label + body, input: (name: string, attrs = '') => `<input name="${name}" ${attrs}>`, actions: esc, formError: '', note: esc, icon: esc };
describe('independent residential quote pages', () => {
  beforeEach(() => vi.stubGlobal('window', { queueMicrotask: () => {} }));
  afterEach(() => vi.unstubAllGlobals());
  it('selects the quote by URL, with separate market and configuration entrances', () => {
    const business = createBusinessWorkspace(ui);
    const carrier = business.quotePage('freightcom');
    expect(carrier).toContain('data-form="business-freightcom"');
    expect(carrier).not.toContain('data-form="business-quote"');
    expect(carrier).not.toContain('business-quote-mode');
    expect(carrier).not.toContain('business-shared-cargo');
    const own = business.quotePage('private');
    expect(own).toContain('data-form="business-quote"');
    expect(own).not.toContain('data-form="business-freightcom"');
    expect(own).not.toContain('business-quote-mode');
    expect(marketServices.find(x => x.id === 'quote.zone_preview')?.online).toBe('quote/private');
    expect(marketServices.find(x => x.id === 'quote.freightcom_ltl.preview')?.online).toBe('quote/freightcom');
    business.reset();
    expect(business.quotePage('freightcom')).toContain('data-form="business-freightcom"');
  });
  it('submits each physical pallet with its own weight and dimensions', async () => {
    const {createFreightcomForm}=await import(pathToFileURL(resolve('apps/console/freightcom-form.js')).href) as {createFreightcomForm:(ui:unknown)=>{read:(data:FormData)=>unknown}};
    const data=new FormData();
    for(const [key,value] of Object.entries({'fc-pallet-count':'2','fc-weight':'321','fc-weight-1':'654','fc-length':'40','fc-length-1':'60','fc-width':'30','fc-width-1':'35','fc-height':'25','fc-height-1':'28','fc-pieces':'2','fc-pieces-1':'4','fc-class':'70','fc-class-1':'85','fc-ship-date':'2026-09-10','fc-ready-at':'09:00','fc-ready-until':'16:00','fc-unload':'no','fc-appointment':'yes','fc-stackable':'no'}))data.set(key,value);
    expect(createFreightcomForm(ui).read(data)).toMatchObject({details:{destination:{residential:true,tailgate_required:false},packaging_properties:{has_stackable_pallets:false,pallets:[{measurements:{weight:{unit:'lb',value:'321'},cuboid:{unit:'in',l:'40'}},freight_class:'70',num_pieces:2},{measurements:{weight:{unit:'lb',value:'654'},cuboid:{unit:'in',l:'60'}},freight_class:'85',num_pieces:4}],pallet_service_details:{appointment_delivery:true}}}});
    data.set('fc-pallet-count','0');expect(()=>createFreightcomForm(ui).read(data)).toThrow('carrier_pallet_count_invalid');
  });
});
