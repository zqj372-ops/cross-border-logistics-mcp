// Adapted from quote-pdf-builder 0b6e439: A4 layout and fee visibility semantics.
// Monetary arithmetic, explicit rates, draft state and server contracts are FreightClaw-owned.
import Decimal from 'decimal.js';
import {documentSchema,type QuoteDocument,type QuoteTemplate} from './contracts';
const D=Decimal.clone({precision:48,rounding:Decimal.ROUND_HALF_UP});
export const escapeHtml=(v:string|number|null|undefined)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const currencies=['USD','CAD','CNY'] as const;
export function calculate(input:QuoteDocument){
 const d=documentSchema.parse(input),sums={USD:new D(0),CAD:new D(0),CNY:new D(0)};
 const rows=d.fee_items.map(f=>({...f,amount:new D(f.quantity).mul(f.unit_price).toFixed(2)}));
 for(const f of rows)if(f.display!=='hiddenExcluded')sums[f.currency]=sums[f.currency].add(f.amount);
 const by_currency={USD:sums.USD.toFixed(2),CAD:sums.CAD.toFixed(2),CNY:sums.CNY.toFixed(2)};
 const cnyParts=currencies.map(c=>c==='CNY'?sums[c]:sums[c].isZero()?new D(0):d.exchange_rates[c]?sums[c].mul(d.exchange_rates[c]):null);
 const total_cny=cnyParts.some(p=>p===null)?null:cnyParts.reduce<Decimal>((a,b)=>a.add(b!),new D(0)).toFixed(2);
 const total_usd=sums.CAD.isZero()&&sums.CNY.isZero()?sums.USD.toFixed(2):total_cny!==null&&d.exchange_rates.USD?new D(total_cny).div(d.exchange_rates.USD).toFixed(2):null;
 return {rows,by_currency,total_cny,total_usd,warnings:rows.some(f=>f.display==='hiddenIncluded')?['合计包含隐藏计入费用，请核对客户展示。']:[],calculation_version:'quote-documents-decimal-v1'};
}
export function renderHtml(d:QuoteDocument,t:QuoteTemplate,approved:boolean){
 const result=calculate(d),e=escapeHtml,visible=result.rows.filter(f=>f.display==='detail');
 const merged=new Map<string,{name:string;currency:string;amount:Decimal}>();
 for(const f of result.rows.filter(f=>f.display==='merged')){const key=JSON.stringify([f.merge_name,f.currency]),prior=merged.get(key);merged.set(key,{name:f.merge_name,currency:f.currency,amount:(prior?.amount??new D(0)).add(f.amount)});}
 const rows=visible.map(f=>`<tr><td>${e(f.group)} · ${e(f.name)}</td><td>${e(f.description)}</td><td class="num">${e(f.quantity)}</td><td>${e(f.unit)}</td><td class="num">${e(f.unit_price)}</td><td>${f.currency}</td><td class="num strong">${f.amount}</td><td>${e(f.note)}</td></tr>`).join('')+[...merged.values()].map(f=>`<tr><td colspan="5">${e(f.name)}</td><td>${f.currency}</td><td class="num strong">${f.amount.toFixed(2)}</td><td></td></tr>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><title>${e(d.quote_no)}</title><style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #0f172a; font-family: "Noto Sans SC", "Manrope", sans-serif, sans-serif; font-size: 11.5px; line-height: 1.55; }
  .header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #2D3D7B; padding-bottom: 14px; margin-bottom: 18px; }
  .brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
  .logo { max-width: 168px; max-height: 54px; object-fit: contain; }
  .brand-name { font-size: 20px; font-weight: 700; color: #2D3D7B; }
  .brand-meta { color: #64748b; font-size: 10.5px; margin-top: 2px; }
  .doc-title { text-align: right; color: #334155; }
  .doc-title strong { display: block; color: #0f172a; font-size: 20px; letter-spacing: 0; }
  .info { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 18px; margin-bottom: 16px; }
  .info div { min-width: 0; }
  .label { color: #64748b; display: inline-block; min-width: 76px; }
  .value { color: #111827; font-weight: 600; }
  h2 { font-size: 13px; color: #2D3D7B; margin: 16px 0 7px; padding-left: 8px; border-left: 4px solid #C81E2E; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { background: #f8fafc; color: #475569; text-align: left; border-bottom: 1px solid #cbd5e1; padding: 6px 6px; font-size: 10.5px; }
  td { border-bottom: 1px solid #e2e8f0; padding: 6px 6px; vertical-align: top; word-break: break-word; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .strong { font-weight: 700; color: #111827; }
  .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 12px; }
  .total-card { border: 1px solid #d8e0ea; background: #f8fafc; border-radius: 6px; padding: 9px 10px; }
  .total-card h3 { margin: 0 0 6px; font-size: 11px; color: #334155; }
  .total-line { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; color: #334155; }
  .grand { margin-top: 6px; padding-top: 6px; border-top: 1px solid #cbd5e1; font-size: 12px; font-weight: 700; color: #2D3D7B; }
  .remark, .terms { white-space: pre-wrap; border-left: 3px solid #d1d5db; background: #f9fafb; padding: 8px 10px; color: #475569; }
  .terms ul { margin: 0; padding-left: 18px; }
  tr { break-inside: avoid; } thead { display: table-header-group; }
  body { overflow-wrap:anywhere; } .num { white-space:normal; } .draft { color:#9a3412; border:1px solid #fed7aa; padding:8px; margin-bottom:16px; } h2 { break-after:avoid; } .totals { break-inside:avoid; }
</style></head><body>
 ${approved?'':'<div class="draft">草稿 · 待核对 / DRAFT - NOT A FORMAL QUOTE</div>'}
 <div class="header"><div class="brand"><div><div class="brand-name">${e(t.company_name)}</div><div class="brand-meta">${e(t.company_address)}</div><div class="brand-meta">${e(t.company_phone)} ${e(t.company_email)}</div></div></div><div class="doc-title"><strong>报价单 / Quotation</strong><div>${e(d.quote_no)}</div><div>报价日期 ${d.quote_date}</div><div>有效期 ${d.valid_until}</div></div></div>
 <h2>客户与运输信息</h2><div class="info">${[['客户',d.customer_name],['线路',d.route_name],['起运地',d.origin],['目的地',d.destination],['单号',d.job_no],['SO 号',d.so_no],['柜号',d.container_no]].map(([k,v])=>`<div><span class="label">${k}</span><span class="value">${e(v||'—')}</span></div>`).join('')}</div>
 <h2>费用明细</h2><table><thead><tr><th style="width:17%">费用项目</th><th style="width:16%">说明</th><th>数量</th><th>单位</th><th style="width:12%">单价</th><th>币种</th><th style="width:13%">小计</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table>
 <h2>费用合计 / Summary</h2><div class="totals"><div class="total-card"><h3>原币种合计</h3>${currencies.map(c=>`<div class="total-line"><span>${c}</span><strong>${result.by_currency[c]}</strong></div>`).join('')}</div><div class="total-card"><h3>折算人民币</h3><strong>${result.total_cny===null?'未填写完整汇率':result.total_cny+' CNY'}</strong></div><div class="total-card"><h3>折算美元</h3><strong>${result.total_usd===null?'未填写完整汇率':result.total_usd+' USD'}</strong></div></div>
 <p>填写汇率：1 USD = ${e(d.exchange_rates.USD??'未填写')} CNY；1 CAD = ${e(d.exchange_rates.CAD??'未填写')} CNY</p>
 ${d.remark?`<h2>备注</h2><div class="remark">${e(d.remark)}</div>`:''}<h2>报价条款</h2><div class="terms">${e(t.terms)}</div></body></html>`;
}
