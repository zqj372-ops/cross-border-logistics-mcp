import {randomUUID} from 'node:crypto';
import type {QuoteDocument,QuoteTemplate} from '../../services/quote-documents/contracts';
export const template:QuoteTemplate={company_name:'测试物流',company_address:'',company_phone:'',company_email:'',terms:'测试条款，以核对结果为准。',fee_items:[]};
export const sample=():QuoteDocument=>({quote_no:'QA-001',customer_name:'测试客户',quote_date:new Date().toISOString().slice(0,10),valid_until:'2099-12-31',origin:'中国',destination:'加拿大',route_name:'',job_no:'',so_no:'',container_no:'',remark:'',exchange_rates:{USD:null,CAD:null},fee_items:[{id:randomUUID(),name:'海运费',description:'',group:'A',quantity:'3',unit:'票',unit_price:'0.1',currency:'USD',display:'detail',merge_name:'',note:''}]});
