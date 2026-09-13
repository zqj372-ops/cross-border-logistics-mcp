import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import caseInput from '../../schemas/access-gateway/portal-cases-input.schema.json';
import caseList from '../../schemas/access-gateway/portal-cases-list.schema.json';
import caseUpdate from '../../schemas/access-gateway/portal-cases-update.schema.json';
import caseReply from '../../schemas/access-gateway/portal-cases-reply.schema.json';
import caseResponse from '../../schemas/access-gateway/portal-cases-response.schema.json';
import caseResponseV2 from '../../schemas/access-gateway/portal-cases-response-v2.schema.json';
import nativePrepareV2Response from '../../schemas/admin-control/quote-documents/native-prepare-v2-response.schema.json';
import saveV2Response from '../../schemas/admin-control/quote-documents/save-v2-response.schema.json';
import getV2Response from '../../schemas/admin-control/quote-documents/get-v2-response.schema.json';
import listV2Response from '../../schemas/admin-control/quote-documents/list-v2-response.schema.json';
import approveV2Response from '../../schemas/admin-control/quote-documents/approve-v2-response.schema.json';
import rejectV2Response from '../../schemas/admin-control/quote-documents/reject-v2-response.schema.json';
import exportV2Response from '../../schemas/admin-control/quote-documents/export-v2-response.schema.json';
import linkedErrorV2Response from '../../schemas/admin-control/quote-documents/linked-error-v2-response.schema.json';
import nativePrepareV2 from '../../schemas/admin-control/quote-documents/native-prepare-v2.schema.json';
import saveV2 from '../../schemas/admin-control/quote-documents/save-v2.schema.json';
import getV2 from '../../schemas/admin-control/quote-documents/get-v2.schema.json';
import listV2 from '../../schemas/admin-control/quote-documents/list-v2.schema.json';
import approveV2 from '../../schemas/admin-control/quote-documents/approve-v2.schema.json';
import rejectV2 from '../../schemas/admin-control/quote-documents/reject-v2.schema.json';
import exportV2 from '../../schemas/admin-control/quote-documents/export-v2.schema.json';
const ajv=new Ajv2020({strict:true,allErrors:true,useDefaults:true});addFormats(ajv);
const linkedAjv=new Ajv2020({strict:true,allErrors:true,useDefaults:false});addFormats(linkedAjv);
export const caseSchemas:Record<string,object>={'cases create':caseInput,'cases list':caseList,'cases update':caseUpdate,'cases reply':caseReply};
const validators=Object.fromEntries(Object.entries(caseSchemas).map(([name,schema])=>[name,ajv.compile(schema)]));
export const validateCaseResponse=ajv.compile(caseResponse);
export const validateCaseResponseV2=linkedAjv.compile(caseResponseV2);
export const linkedDocumentResponseValidators=Object.freeze({
  'native-prepare':linkedAjv.compile(nativePrepareV2Response),
  'save':linkedAjv.compile(saveV2Response),
  'get':linkedAjv.compile(getV2Response),
  'list':linkedAjv.compile(listV2Response),
  'approve':linkedAjv.compile(approveV2Response),
  'reject':linkedAjv.compile(rejectV2Response),
  'export':linkedAjv.compile(exportV2Response),
  'error':linkedAjv.compile(linkedErrorV2Response),
});
export const linkedDocumentInputValidators=Object.freeze({
  'native-prepare':linkedAjv.compile(nativePrepareV2),
  'save':linkedAjv.compile(saveV2),
  'get':linkedAjv.compile(getV2),
  'list':linkedAjv.compile(listV2),
  'approve':linkedAjv.compile(approveV2),
  'reject':linkedAjv.compile(rejectV2),
  'export':linkedAjv.compile(exportV2),
});
export const validCaseInput=(name:string,input:unknown)=>validators[name]?.(input)??true;
