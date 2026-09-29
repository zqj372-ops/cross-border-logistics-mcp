import {z} from 'zod';
const id=z.string().trim().min(1).max(256);
export const userGroupSchema=z.enum(['customer','sales','operations','administrator']);
export const groupSelfSchema=z.object({group:userGroupSchema,can_manage:z.boolean()}).strict();
export const groupRecordSchema=z.object({user_id:id,name:z.string().max(200),email:z.email(),group:z.enum(['customer','sales','operations']).nullable(),legacy_group:z.enum(['customer','sales','operations']),version:z.number().int().nonnegative()}).strict();
export const groupListInput=z.object({query:z.string().trim().max(200).default(''),before:z.number().int().positive().nullable().default(null)}).strict();
export const groupListOutput=z.object({items:z.array(groupRecordSchema.extend({group:userGroupSchema,source:z.enum(['administrator','explicit','existing','default'])})).max(50),next_before:z.number().int().positive().nullable()}).strict();
export const groupSaveInput=z.object({user_id:id,group:z.enum(['customer','sales','operations']),expected_version:z.number().int().nonnegative(),confirmed:z.literal(true)}).strict();
export const groupSaveOutput=z.object({user_id:id,group:z.enum(['customer','sales','operations']),version:z.number().int().nonnegative()}).strict();
export const userGroupRoutes={
 'group-self':[z.object({}).strict(),groupSelfSchema,false,'读取本人用户组'],
 'group-list':[groupListInput,groupListOutput,false,'查询已登录人员用户组'],
 'group-save':[groupSaveInput,groupSaveOutput,true,'调整个人客户、业务员或操作员用户组'],
} as const;
