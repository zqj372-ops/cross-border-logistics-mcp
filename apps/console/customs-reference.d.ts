import type { z } from 'zod';
import type { customsReferenceData } from '../../services/customs-native/reference';
import type { CustomsSourceQueryResponse } from '../../services/access-gateway/portal/business/customs-client';
type Ui = { esc:(value:unknown)=>string; panel:(title:string,subtitle:string,body:string)=>string; note:(message:string,tone?:string)=>string };
type Input = { query?:string; codeCountry?:string; attributes?:{material?:string;use?:string} };
type Result = CustomsSourceQueryResponse['results'][number];
type Brief = Pick<Result,'displayCode'|'status'|'classificationReason'|'legalNames'> & Partial<Pick<Result,'measures'|'documents'|'confirmedTotalPercent'|'hierarchy'|'code'|'chineseExplanation'>> & {
 isDeclarable?:boolean;
 rates?:Array<Pick<Result['rates'][number],'label'|'treatment'|'displayValue'|'confirmed'> & {conditionText?:string|null;scope?:string}>;
};
export function renderCustomsImportBrief(ui:Pick<Ui,'esc'>,result:Brief,input?:Input,reference?:boolean):string;
export function renderCustomsReference(ui:Ui,data:z.infer<typeof customsReferenceData>,options?:{input?:Input;country?:string;code?:string;dirty?:boolean}):string;
