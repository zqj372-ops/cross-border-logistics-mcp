import {z} from 'zod';
import * as c from './fcl-execution-contracts';
const empty=z.object({}).strict();
export const executionRoutes={
  'case-mail-resolve':[c.fclCaseMailResolveSchema,c.fclMailListSchema,true,'登记询报价通知的核实结果'],
  'case-mail-retry':[c.fclCaseMailRetrySchema,c.fclMailListSchema,true,'重试已明确失败的询报价通知'],
  'execution-history':[c.fclExecutionHistoryRequestSchema,c.fclExecutionHistorySchema,false,'分页读取获授权的执行操作记录'],
  'execution-preview':[c.fclExecutionStartSchema,c.fclExecutionPreviewSchema,false,'预览成交与适用节点'],
  'execution-start':[c.fclExecutionStartSchema,c.fclExecutionViewSchema,true,'登记客户确认并转执行'],
  'execution-get':[c.fclExecutionGetSchema,c.fclExecutionViewSchema.nullable(),false,'读取本单授权执行资料'],
  'workspace-list':[c.fclWorkspaceListSchema,c.fclWorkspaceListOutputSchema,false,'查询整柜业务阶段与本人待办'],
  'execution-node-mention':[c.fclExecutionNodeActionSchema,c.fclExecutionViewSchema,true,'明确提醒本节点已配置的责任人'],
  'execution-list':[c.fclExecutionListSchema,c.fclExecutionListOutputSchema,false,'查询本人及参与的执行业务'],
  'execution-shared-save':[c.fclExecutionSharedSaveSchema,c.fclExecutionViewSchema,true,'保存共享运输资料'],
  'execution-node-save':[c.fclExecutionNodeSaveSchema,c.fclExecutionViewSchema,true,'保存节点资料'],
  'execution-node-start':[c.fclExecutionNodeActionSchema,c.fclExecutionViewSchema,true,'启动节点待办'],
  'execution-node-complete':[c.fclExecutionNodeCompleteSchema,c.fclExecutionViewSchema,true,'完成节点并交接'],
  'execution-node-exception':[c.fclExecutionNodeActionSchema,c.fclExecutionViewSchema,true,'登记节点异常'],
  'execution-node-return':[c.fclExecutionNodeActionSchema,c.fclExecutionViewSchema,true,'明确退回补充'],
  'execution-node-assign':[c.fclExecutionNodeAssignSchema,c.fclExecutionViewSchema,true,'改派节点负责人'],
  'execution-node-reopen':[c.fclExecutionNodeActionSchema,c.fclExecutionViewSchema,true,'注明原因重新打开节点'],
  'execution-node-skip':[c.fclExecutionNodeActionSchema,c.fclExecutionViewSchema,true,'注明原因跳过节点'],
  'execution-amend-preview':[c.fclExecutionAmendSchema,c.fclExecutionPreviewSchema,false,'预览新成交依据和服务变更'],
  'execution-amend':[c.fclExecutionAmendSchema,c.fclExecutionViewSchema,true,'追加重新确认的商业变更'],
  'execution-defaults-preview':[c.fclExecutionDefaultsSchema,c.fclExecutionDefaultsPreviewSchema,false,'预览未启动节点的配置差异'],
  'execution-defaults-apply':[c.fclExecutionDefaultsApplySchema,c.fclExecutionViewSchema,true,'应用默认配置到未启动节点'],
  'execution-mail-list':[c.fclMailListRequestSchema,c.fclMailListSchema,false,'读取节点邮件发送结果'],
  'execution-mail-resolve':[c.fclMailResolveSchema,c.fclExecutionViewSchema,true,'登记邮件结果的人工核实'],
  'execution-mail-retry':[c.fclMailRetrySchema,c.fclExecutionViewSchema,true,'重试已明确失败的邮件'],
  'notification-v2-get':[empty,c.fclNotificationV2ViewSchema,false,'读取节点与邮件默认配置'],
  'notification-v2-save':[c.fclNotificationV2SaveSchema,c.fclNotificationV2ViewSchema,true,'保存节点与邮件默认配置'],
  'notification-preview':[c.fclNotificationPreviewRequestSchema,c.fclNotificationPreviewOutputSchema,false,'预览合成节点测试邮件'],
  'notification-test':[c.fclNotificationTestSchema,c.fclNotificationPreviewOutputSchema,true,'明确发送一封合成测试邮件'],
} as const;
export type FclExecutionAction=keyof typeof executionRoutes;
export const FCL_EXECUTION_ACTIONS=Object.keys(executionRoutes) as FclExecutionAction[];
const entries=Object.entries(executionRoutes) as [FclExecutionAction,typeof executionRoutes[FclExecutionAction]][];
export const executionRequests=Object.fromEntries(entries.map(([key,value])=>[key,value[0]])) as unknown as Record<FclExecutionAction,z.ZodType>;
export const executionOutputs=Object.fromEntries(entries.map(([key,value])=>[key,value[1]])) as unknown as Record<FclExecutionAction,z.ZodType>;
export const executionMethods=Object.fromEntries(entries.map(([key])=>[key,'POST'])) as Record<FclExecutionAction,'POST'>;
export const executionBodyLimits=Object.fromEntries(entries.map(([key])=>[key,128*1024])) as Record<FclExecutionAction,number>;
export const executionWrites=entries.filter(([,value])=>value[2]).map(([key])=>key);
export const executionDescriptions=Object.fromEntries(entries.map(([key,value])=>[key,value[3]])) as Record<FclExecutionAction,string>;
