import { z, type ZodIssue } from 'zod';

export const FCL_CONTRACT_VERSION = 'fcl-inquiry@2026-09-20.v1' as const;
export const FCL_TRANSPORT_MODE = 'FCL' as const;
export const FCL_INQUIRY_SCHEMA_ID = 'https://freightclaw.local/schemas/portal-fcl-inquiry-input.schema.json';
export const FCL_CONTAINER_TYPES = ['20GP', '40GP', '40HQ', '45HQ'] as const;
export const FCL_CARGO_TYPES = ['general', 'battery', 'liquid_powder', 'wood', 'regulated', 'other'] as const;
export const FCL_INCOTERMS = ['EXW', 'FOB', 'CIF', 'DDU', 'DDP', 'Other'] as const;
export const FCL_SERVICE_IDS = [
  'pickup',
  'export_customs',
  'ocean_freight',
  'canada_customs',
  'devanning_storage',
  'delivery',
] as const;

export type FclInquiryStep = 1 | 2 | 3;
export type FclValidationIssue = {
  path: string[];
  code: string;
  message: string;
};

// eslint-disable-next-line no-control-regex
const SINGLE_LINE_TEXT_PATTERN = /^(?=[\s\S]*\S)[^\u0000-\u001f\u007f]+$/u;
// eslint-disable-next-line no-control-regex
const MULTILINE_NOTES_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const POSITIVE_DECIMAL_PATTERN = /^(?=[\s\S]*[1-9])\d{1,10}(?:\.\d{1,6})?$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const singleLineText = (max: number) => z.string().min(1).max(max).regex(SINGLE_LINE_TEXT_PATTERN);
const nullableSingleLineText = (max: number) => z.union([singleLineText(max), z.null()]);
const emailAddress = () => z.email().max(254);

function isRealCalendarDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const fclContainerSchema = z
  .object({
    type: z.enum(FCL_CONTAINER_TYPES),
    quantity: z.number().int().min(1).max(9999).nullable(),
  })
  .strict();

const fclEstimatedWeightSchema = z
  .object({
    value: z.string().regex(POSITIVE_DECIMAL_PATTERN),
    unit: z.literal('kg'),
  })
  .strict();

const fclContactDraftSchema = z
  .object({
    name: nullableSingleLineText(80),
    company: nullableSingleLineText(200),
    email: z.union([emailAddress(), z.null()]),
    phone: nullableSingleLineText(80),
  })
  .strict();

const fclContactSubmitSchema = fclContactDraftSchema.extend({
  name: singleLineText(80),
  email: emailAddress(),
});

function validateCrossFieldSemantics(
  input: { containers: Array<{ type: string }>; selected_services: string[] },
  context: z.RefinementCtx,
) {
  const seenContainerTypes = new Set<string>();
  input.containers.forEach((container, index) => {
    if (seenContainerTypes.has(container.type)) {
      context.addIssue({
        code: 'custom',
        path: ['containers', index, 'type'],
        message: 'duplicate_container_type',
      });
    }
    seenContainerTypes.add(container.type);
  });

  const seenServices = new Set<string>();
  input.selected_services.forEach((service, index) => {
    if (seenServices.has(service)) {
      context.addIssue({
        code: 'custom',
        path: ['selected_services', index],
        message: 'duplicate_service',
      });
    }
    seenServices.add(service);
  });
}

const fclInquiryDraftObjectSchema = z
  .object({
    contract_version: z.literal(FCL_CONTRACT_VERSION),
    transport_mode: z.literal(FCL_TRANSPORT_MODE),
    origin_city: nullableSingleLineText(200),
    pol: nullableSingleLineText(200),
    pod: nullableSingleLineText(200),
    final_destination: nullableSingleLineText(200),
    cargo_name: nullableSingleLineText(200),
    containers: z.array(fclContainerSchema).max(FCL_CONTAINER_TYPES.length),
    cargo_type: z.union([z.enum(FCL_CARGO_TYPES), z.null()]),
    estimated_weight: z.union([fclEstimatedWeightSchema, z.null()]),
    cargo_ready_date: z.union([
      z
        .string()
        .regex(DATE_PATTERN)
        .refine(isRealCalendarDate, { message: 'invalid_calendar_date' }),
      z.null(),
    ]),
    incoterm: z.union([z.enum(FCL_INCOTERMS), z.null()]),
    incoterm_other: nullableSingleLineText(200),
    selected_services: z.array(z.enum(FCL_SERVICE_IDS)).max(FCL_SERVICE_IDS.length),
    contact: fclContactDraftSchema,
    notes: z.union([z.string().max(4000).regex(MULTILINE_NOTES_PATTERN), z.null()]),
    consent: z.boolean(),
  })
  .strict();

export const fclInquiryDraftSchema = fclInquiryDraftObjectSchema.superRefine(validateCrossFieldSemantics);
export const fclInquirySchema = fclInquiryDraftObjectSchema
  .extend({
    contact: fclContactSubmitSchema,
    consent: z.literal(true),
  })
  .superRefine(validateCrossFieldSemantics);

export type FclInquiryDraft = z.infer<typeof fclInquiryDraftSchema>;
export type FclInquiryInput = z.infer<typeof fclInquirySchema>;

const fclInquiryFieldChangeSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('origin_city'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('pol'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('pod'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('final_destination'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('containers'), value: z.array(fclContainerSchema).max(FCL_CONTAINER_TYPES.length) }).strict(),
  z.object({ field: z.literal('cargo_name'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('cargo_type'), value: z.union([z.enum(FCL_CARGO_TYPES), z.null()]) }).strict(),
  z.object({ field: z.literal('estimated_weight'), value: z.union([fclEstimatedWeightSchema, z.null()]) }).strict(),
  z.object({ field: z.literal('cargo_ready_date'), value: z.union([
    z.string().regex(DATE_PATTERN).refine(isRealCalendarDate, { message: 'invalid_calendar_date' }),
    z.null(),
  ]) }).strict(),
  z.object({ field: z.literal('incoterm'), value: z.union([z.enum(FCL_INCOTERMS), z.null()]) }).strict(),
  z.object({ field: z.literal('incoterm_other'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('selected_services'), value: z.array(z.enum(FCL_SERVICE_IDS)).max(FCL_SERVICE_IDS.length) }).strict(),
  z.object({ field: z.literal('contact.name'), value: nullableSingleLineText(80) }).strict(),
  z.object({ field: z.literal('contact.company'), value: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('contact.email'), value: z.union([emailAddress(), z.null()]) }).strict(),
  z.object({ field: z.literal('contact.phone'), value: nullableSingleLineText(80) }).strict(),
  z.object({ field: z.literal('notes'), value: z.union([z.string().max(4000).regex(MULTILINE_NOTES_PATTERN), z.null()]) }).strict(),
]);

export const fclInquiryPatchSchema = z
  .object({ changes: z.array(fclInquiryFieldChangeSchema).max(17) })
  .strict()
  .superRefine((patch, context) => {
    const seen = new Set<string>();
    patch.changes.forEach((change, index) => {
      if (seen.has(change.field)) {
        context.addIssue({ code: 'custom', path: ['changes', index, 'field'], message: 'duplicate_field' });
      }
      seen.add(change.field);
    });
  });

export type FclInquiryPatch = z.infer<typeof fclInquiryPatchSchema>;

export const fclInquiryFieldDiffSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('origin_city'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('pol'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('pod'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('final_destination'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('containers'), before: z.array(fclContainerSchema).max(FCL_CONTAINER_TYPES.length), after: z.array(fclContainerSchema).max(FCL_CONTAINER_TYPES.length) }).strict(),
  z.object({ field: z.literal('cargo_name'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('cargo_type'), before: z.union([z.enum(FCL_CARGO_TYPES), z.null()]), after: z.union([z.enum(FCL_CARGO_TYPES), z.null()]) }).strict(),
  z.object({ field: z.literal('estimated_weight'), before: z.union([fclEstimatedWeightSchema, z.null()]), after: z.union([fclEstimatedWeightSchema, z.null()]) }).strict(),
  z.object({ field: z.literal('cargo_ready_date'), before: z.union([
    z.string().regex(DATE_PATTERN).refine(isRealCalendarDate, { message: 'invalid_calendar_date' }),
    z.null(),
  ]), after: z.union([
    z.string().regex(DATE_PATTERN).refine(isRealCalendarDate, { message: 'invalid_calendar_date' }),
    z.null(),
  ]) }).strict(),
  z.object({ field: z.literal('incoterm'), before: z.union([z.enum(FCL_INCOTERMS), z.null()]), after: z.union([z.enum(FCL_INCOTERMS), z.null()]) }).strict(),
  z.object({ field: z.literal('incoterm_other'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('selected_services'), before: z.array(z.enum(FCL_SERVICE_IDS)).max(FCL_SERVICE_IDS.length), after: z.array(z.enum(FCL_SERVICE_IDS)).max(FCL_SERVICE_IDS.length) }).strict(),
  z.object({ field: z.literal('contact.name'), before: nullableSingleLineText(80), after: nullableSingleLineText(80) }).strict(),
  z.object({ field: z.literal('contact.company'), before: nullableSingleLineText(200), after: nullableSingleLineText(200) }).strict(),
  z.object({ field: z.literal('contact.email'), before: z.union([emailAddress(), z.null()]), after: z.union([emailAddress(), z.null()]) }).strict(),
  z.object({ field: z.literal('contact.phone'), before: nullableSingleLineText(80), after: nullableSingleLineText(80) }).strict(),
  z.object({ field: z.literal('notes'), before: z.union([z.string().max(4000).regex(MULTILINE_NOTES_PATTERN), z.null()]), after: z.union([z.string().max(4000).regex(MULTILINE_NOTES_PATTERN), z.null()]) }).strict(),
]);

export function isFclInquiryComplete(input: FclInquiryDraft): boolean {
  return Boolean(
    input.pol && input.pod && input.cargo_name &&
    input.containers.length > 0 && input.containers.every((container) => container.quantity !== null) &&
    input.cargo_type && input.estimated_weight && input.cargo_ready_date && input.incoterm &&
    input.selected_services.length > 0 && (input.incoterm !== 'Other' || Boolean(input.incoterm_other)),
  );
}

export type FclInquirySummary = {
  state: 'draft';
  route: {
    origin_city: FclInquiryDraft['origin_city'];
    pol: FclInquiryDraft['pol'];
    pod: FclInquiryDraft['pod'];
    final_destination: FclInquiryDraft['final_destination'];
  };
  containers: FclInquiryDraft['containers'];
  cargo: {
    cargo_name: FclInquiryDraft['cargo_name'];
    cargo_type: FclInquiryDraft['cargo_type'];
    estimated_weight: FclInquiryDraft['estimated_weight'];
    cargo_ready_date: FclInquiryDraft['cargo_ready_date'];
    incoterm: FclInquiryDraft['incoterm'];
    incoterm_other: FclInquiryDraft['incoterm_other'];
  };
  selected_services: FclInquiryDraft['selected_services'];
  contact: FclInquiryDraft['contact'];
  notes: FclInquiryDraft['notes'];
  consent: FclInquiryDraft['consent'];
};

const STEP_FIELDS: Record<FclInquiryStep, ReadonlySet<string>> = {
  1: new Set(['origin_city', 'pol', 'pod', 'final_destination', 'containers', 'cargo_ready_date', 'incoterm', 'incoterm_other']),
  2: new Set(['cargo_name', 'cargo_type', 'estimated_weight', 'selected_services', 'notes']),
  3: new Set(['contact', 'consent']),
};
const ROOT_FIELDS = new Set([...STEP_FIELDS[1], ...STEP_FIELDS[2], ...STEP_FIELDS[3]]);

function normalizeIssues(issues: readonly ZodIssue[], prefix: readonly string[] = []): FclValidationIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path.map(String)];
    if (issue.code === 'invalid_union') {
      return issue.errors.flatMap((branch) => normalizeIssues(branch, path));
    }
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: [...path, key],
        code: 'unrecognized_key',
        message: `unknown_field:${key}`,
      }));
    }
    return [{
      path,
      code: issue.code,
      message: issue.message,
    }];
  });
}

export class FclInquiryValidationError extends Error {
  constructor(readonly issues: readonly FclValidationIssue[]) {
    super('fcl_inquiry_invalid');
    this.name = 'FclInquiryValidationError';
  }
}

export function createFclInquiryDraft(): FclInquiryDraft {
  return {
    contract_version: FCL_CONTRACT_VERSION,
    transport_mode: FCL_TRANSPORT_MODE,
    origin_city: null,
    pol: null,
    pod: null,
    final_destination: null,
    cargo_name: null,
    containers: [],
    cargo_type: null,
    estimated_weight: null,
    cargo_ready_date: null,
    incoterm: null,
    incoterm_other: null,
    selected_services: [],
    contact: {
      name: null,
      company: null,
      email: null,
      phone: null,
    },
    notes: null,
    consent: false,
  };
}

export function validateFclInquiryDraft(input: unknown): FclValidationIssue[] {
  const result = fclInquiryDraftSchema.safeParse(input);
  return result.success ? [] : normalizeIssues(result.error.issues);
}

export function validateFclInquiry(input: unknown): FclValidationIssue[] {
  const result = fclInquirySchema.safeParse(input);
  return result.success ? [] : normalizeIssues(result.error.issues);
}

export function validateFclInquiryStep(input: unknown, step: FclInquiryStep): FclValidationIssue[] {
  const fields = STEP_FIELDS[step];
  const issues = step === 3 ? validateFclInquiryForSubmit(input) : validateFclInquiryDraft(input);
  return issues.filter((issue) => {
    const root = issue.path[0];
    return root === undefined || !ROOT_FIELDS.has(root) || fields.has(root);
  });
}

export function validateFclInquiryForSubmit(input: unknown): FclValidationIssue[] {
  return validateFclInquiry(input);
}

export function parseFclInquiry(input: unknown): FclInquiryInput {
  const result = fclInquirySchema.safeParse(input);
  if (!result.success) throw new FclInquiryValidationError(normalizeIssues(result.error.issues));
  return result.data;
}

export function buildFclInquirySummary(input: FclInquiryDraft): FclInquirySummary {
  return {
    state: 'draft',
    route: {
      origin_city: input.origin_city,
      pol: input.pol,
      pod: input.pod,
      final_destination: input.final_destination,
    },
    containers: input.containers.map((container) => ({ ...container })),
    cargo: {
      cargo_name: input.cargo_name,
      cargo_type: input.cargo_type,
      estimated_weight: input.estimated_weight === null ? null : { ...input.estimated_weight },
      cargo_ready_date: input.cargo_ready_date,
      incoterm: input.incoterm,
      incoterm_other: input.incoterm_other,
    },
    selected_services: [...input.selected_services],
    contact: { ...input.contact },
    notes: input.notes,
    consent: input.consent,
  };
}
