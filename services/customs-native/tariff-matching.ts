import type { TariffRuleRow } from './upstream/worker/repositories/customs';

export function tariffCodeMatches(row: TariffRuleRow, code: string): boolean {
 return row.code === code || (row.code_match_type === 'prefix' && row.code.length > 0 && code.startsWith(row.code));
}

// CBSA assigns duty at the eight-digit tariff item; the last two digits are
// statistical suffixes. CADEx may repeat an identical rate on a suffix row.
// Keep conflicting conditions/rates and separate releases for the rules engine
// to review. Never silently choose between different source evidence.
export function distinctCanadianTariffs(rows: TariffRuleRow[], code: string): TariffRuleRow[] {
 const sameFields = ['release_id','measure_type','treatment','origin_country','rate_expression_raw','rate_components_json','parse_status','condition_text_raw','conditions_json','interaction_json','effective_from','effective_to','priority'] as const;
 return rows.filter(parent => !(parent.country === 'CA' && parent.measure_type === 'customs_duty' && parent.code_match_type === 'prefix' && parent.code.length === 8 && code.length === 10 && rows.some(exact => exact.code === code && sameFields.every(field => exact[field] === parent[field]))));
}
