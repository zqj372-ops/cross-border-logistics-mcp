import {fclNodeFields,type FclExecution,type FclNode,type FclNotificationRow} from './fcl-execution-contracts';
import type {FclMailMessage} from './cases';

// Pure rendering is shared by the worker and the authorized node preview.
export const FCL_NODE_LABELS={booking:'订舱 / 放 SO',pickup:'中国提货 / 装柜',export_customs:'出口报关',shipping_documents:'补料 / 提单',canada_customs:'加拿大清关',devanning_storage:'拆柜 / 仓储交接',delivery:'派送 / 签收 / 还柜',intake:'询价接收',quote:'报价处理',customer_followup:'客户确认跟进'} as const;
export const FCL_MAIL_FIELD_LABELS={carrier:'船公司',vessel_voyage:'船名航次',booking_so:'Booking / SO',etd:'ETD',eta:'ETA',cutoff:'截单时间',pickup_location:'提柜地点',appointment:'预约时间',declaration_ref:'申报参考',release_evidence:'放行依据',warehouse:'仓库',handover_at:'交接时间',delivery_address:'派送地址',signed_at:'签收时间',empty_return_at:'还柜时间'} as const;
export function fclMailFields(nodeId:FclNotificationRow['node_id']){
  const shape=nodeId in fclNodeFields?fclNodeFields[nodeId as FclNode['node_id']].shape:null;
  return (Object.keys(FCL_MAIL_FIELD_LABELS) as (keyof typeof FCL_MAIL_FIELD_LABELS)[]).filter(key=>shape&&(key==='eta'||key in shape));
}
export function formatFclMailDate(value:string|null){
  if(!value)return '未设置';
  const parts=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  return parts?`${parts[1]} ${parts[2]} UTC${parts[3]==='Z'?'+00:00':parts[3]}`:value;
}
const dateFields=new Set(['etd','eta','cutoff','appointment','handover_at','signed_at','empty_return_at']);
function extras(config:FclNotificationRow,fields:Record<string,unknown>,eta:string|null){
  return fclMailFields(config.node_id).filter(key=>config.visible_fields.includes(key)).flatMap(key=>{
    const value=key==='eta'?eta:fields[key];
    return typeof value!=='string'||!value?[]:[`${FCL_MAIL_FIELD_LABELS[key]}：${dateFields.has(key)?formatFclMailDate(value):value}`];
  });
}
export function renderExecutionMail(progress:Pick<FclExecution,'inquiry_no'|'customer_name'|'case_ref'|'shared'>,node:FclNode,audience:'internal'|'external',origin=''):FclMailMessage{
  const internal=audience==='internal',config=node.notification;
  const lines=[`业务单号：${progress.inquiry_no}`,`客户：${progress.customer_name}`,`环节：${FCL_NODE_LABELS[node.node_id]}`,`待办：${node.status==='completed'?'已登记完成，请核对交接结果':node.status==='exception'?'资料或异常需要处理':'请处理本环节资料及交接'}`,`截止时间（登记时区）：${formatFclMailDate(node.deadline)}`,...extras(config,node.fields,progress.shared.eta)];
  if(internal)lines.push(`负责人：${node.assignment.responsible_id??'待配置'}`,`详情（需登录）：${origin}/console/#fcl/case/${progress.case_ref}`);
  return {to:(internal?node.assignment.to:config.external_to)??'',cc:[...(internal?node.assignment.cc:config.external_cc)],subject:`${progress.inquiry_no} · ${FCL_NODE_LABELS[node.node_id]}`,body:lines.join('\n')};
}
export function renderNotificationTestBody(row:FclNotificationRow,audience:'internal'|'external'){
  const time='2026-01-02T09:00:00-08:00';
  const samples={carrier:'TEST-CARRIER',vessel_voyage:'TEST-VOYAGE',booking_so:'TEST-SO',etd:time,cutoff:time,pickup_location:'合成提柜地点',appointment:time,declaration_ref:'TEST-DECLARATION',release_evidence:'synthetic:release',warehouse:'合成仓库',handover_at:time,delivery_address:'合成派送地址',signed_at:time,empty_return_at:time};
  return ['这是一封用户主动触发的合成测试邮件。','业务单号：TEST-FCL','客户：合成测试客户',`环节：${FCL_NODE_LABELS[row.node_id]}`,'待办：核对发信通道，不执行真实业务。','截止时间（登记时区）：2026-01-01 12:00 UTC+08:00',...extras(row,samples,time),audience==='internal'?'正式内部通知的详情入口需要个人账号登录。':'这是外部作业通知模板，不含内部单据或价格。'].join('\n');
}
