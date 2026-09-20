import {z} from 'zod';
import {feeTemplateSchema,feeTemplateSelectionSchema} from './workflow-contracts';

export const FCL_DOCUMENT_WORKFLOW_VERSION='fcl-document-workflow@2026-09-20.v1' as const;

const issuerText=(max:number)=>z.string().trim().max(max);

export const fclConfigSchema=z.object({
  issuer_name:issuerText(200).min(1),
  issuer_address:issuerText(500),
  issuer_phone:issuerText(50),
  issuer_email:z.union([z.literal(''),z.email().max(254)]),
  terms:issuerText(4000).min(1),
  standard_fee_template_v1:feeTemplateSelectionSchema.nullable(),
}).strict();

export const fclConfigSaveSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  expected_version:z.number().int().nonnegative(),
  input:fclConfigSchema,
  confirmed:z.literal(true),
}).strict();

export const fclConfigViewSchema=z.object({
  contract_version:z.literal(FCL_DOCUMENT_WORKFLOW_VERSION),
  version:z.number().int().nonnegative(),
  input:fclConfigSchema.nullable(),
  catalog:feeTemplateSchema,
}).strict();

export const fclDocumentSchemas:Record<string,z.ZodType>={
  'config-request':fclConfigSaveSchema,
  'config-output':fclConfigViewSchema,
};

export type FclConfig=z.infer<typeof fclConfigSchema>;
export type FclConfigSave=z.infer<typeof fclConfigSaveSchema>;
export type FclConfigView=z.infer<typeof fclConfigViewSchema>;
