import { z } from 'zod';
export const CHANNEL_VERSION='portal-channels@2026-09-07.v1';
const label=z.string().trim().min(1).max(100).regex(/^[^\x00-\x1f\x7f]*$/u); // eslint-disable-line no-control-regex
export const channelInput=z.object({code:z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/u),name:label,warehouse:label,origin_country:z.enum(['CN','CA','US']),destination_country:z.enum(['CN','CA','US']),service:z.enum(['ocean_fcl','ocean_lcl','final_mile']),currency:z.enum(['CNY','CAD','USD']),valid_from:z.iso.date(),valid_until:z.iso.date()}).strict().refine(v=>v.valid_from<=v.valid_until);
export const channelSave=z.object({expected_version:z.number().int().positive(),input:channelInput}).strict();
export const channelPublish=z.object({expected_version:z.number().int().positive(),preview_hash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const channelDisable=z.object({expected_version:z.number().int().positive()}).strict();
export const channelRollback=channelPublish.extend({release_id:z.uuid()});
export type ChannelInput=z.infer<typeof channelInput>;
export const releaseSchema=z.object({release_id:z.uuid(),version:z.number().int().positive(),input:channelInput,published_at:z.iso.datetime()}).strict();
export const channelViewSchema=z.object({channel_id:z.uuid(),version:z.number().int().positive(),input:channelInput,active_release:releaseSchema.nullable(),updated_at:z.iso.datetime(),ready_for_quotes:z.literal(false)}).strict();
export const channelPreviewSchema=z.object({channel_id:z.uuid(),version:z.number().int().positive(),input:channelInput,preview_hash:z.string(),release_id:z.uuid().nullable(),ready_for_quotes:z.literal(false),warnings:z.array(z.string())}).strict();
export const channelListSchema=z.object({items:z.array(channelViewSchema).max(200),can_manage:z.boolean(),scope:z.string()}).strict();
export type ChannelView=z.infer<typeof channelViewSchema>;

export const channelHistorySchema=z.object({releases:z.array(releaseSchema).max(200),audit:z.array(z.object({action:z.enum(["create","save","publish","disable","rollback"]),version:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/u),created:z.iso.datetime()}).strict()).max(200)}).strict();
