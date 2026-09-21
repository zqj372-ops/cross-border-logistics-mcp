import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { FCL_INQUIRY_SCHEMA_ID, fclInquirySchema } from '../../apps/inquiry/fcl-model';
import { caseInputSchema, caseUpdateSchema, caseReplySchema, caseListSchema, caseResponseSchema, caseResponseV2Schema } from '../../services/access-gateway/portal/cases';
import {
  fclCaseErrorEnvelopeSchema,
  fclCaseCustomerSupplementSchema,
  fclCaseConfirmationSchema,
  fclCaseInputSchema,
  fclCaseInternalViewSchema,
  fclCaseListQuerySchema,
  fclCaseListSchema,
  fclCasePublicSummarySchema,
  fclCaseStaffSupplementSchema,
  fclCaseStatusUpdateSchema,
  fclCaseSubmissionSchema,
  fclCaseSuccessEnvelopeSchema,
} from '../../services/access-gateway/portal/case-contracts';
for(const [name,schema] of Object.entries({input:caseInputSchema,update:caseUpdateSchema,reply:caseReplySchema,list:caseListSchema,response:caseResponseSchema,'response-v2':caseResponseV2Schema})) {
 const filename=`portal-cases-${name}.schema.json`;
 writeFileSync(`schemas/access-gateway/${filename}`,JSON.stringify({...z.toJSONSchema(schema,{target:'draft-2020-12'}),$id:`https://freightclaw.local/schemas/${filename}`},null,2)+'\n');
}
const fclFilename='portal-fcl-inquiry-input.schema.json';
writeFileSync(`schemas/access-gateway/${fclFilename}`,JSON.stringify({...z.toJSONSchema(fclInquirySchema,{target:'draft-2020-12'}),$id:FCL_INQUIRY_SCHEMA_ID},null,2)+'\n');
for(const [name,schema] of Object.entries({
  input:fclCaseInputSchema,
  submission:fclCaseSubmissionSchema,
  'internal-view':fclCaseInternalViewSchema,
  'public-summary':fclCasePublicSummarySchema,
  'customer-supplement':fclCaseCustomerSupplementSchema,
  'staff-supplement':fclCaseStaffSupplementSchema,
  confirmation:fclCaseConfirmationSchema,
  'status-update':fclCaseStatusUpdateSchema,
  'list-query':fclCaseListQuerySchema,
  list:fclCaseListSchema,
  success:fclCaseSuccessEnvelopeSchema,
  error:fclCaseErrorEnvelopeSchema,
})) {
 const filename=`portal-fcl-case-${name}.schema.json`;
 writeFileSync(`schemas/access-gateway/${filename}`,JSON.stringify({...z.toJSONSchema(schema,{target:'draft-2020-12'}),$id:`https://freightclaw.local/schemas/${filename}`},null,2)+'\n');
}
