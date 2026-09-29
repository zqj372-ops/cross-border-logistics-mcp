import {z} from 'zod';
const connection=z.object({host:z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/u),port:z.union([z.literal(465),z.literal(587),z.literal(2525)]),secure:z.boolean(),username:z.string().min(1).max(320),from:z.email().max(254),from_name:z.string().trim().max(100).regex(/^[^\r\n]*$/u).optional(),reply_to:z.email().max(254).nullable()}).strict();
const expected=z.object({expected_version:z.number().int().nonnegative(),confirmed:z.literal(true)}).strict();
export const smtpSaveSchema=expected.extend({connection,password:z.string().min(1).max(4096).nullable()});
export const smtpTestSchema=expected.extend({recipient:z.email().max(254)});
export const smtpActivateSchema=expected;
export const smtpViewSchema=z.object({can_edit:z.boolean(),version:z.number().int().nonnegative(),active:connection.nullable(),draft:connection.nullable(),password_present:z.boolean(),test_status:z.enum(['not_tested','pending','smtp_accepted','failed','unknown']),test_recipient:z.email().nullable()}).strict();
