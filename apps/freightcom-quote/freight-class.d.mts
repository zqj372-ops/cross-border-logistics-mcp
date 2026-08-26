export const FREIGHT_CLASS_RULE_VERSION: "nmfta-fcdc-full-density-scale@2025-07-19";

export interface FreightClassMeasurements {
  readonly weightValue: string;
  readonly weightUnit: string;
  readonly length: string;
  readonly width: string;
  readonly height: string;
  readonly dimensionUnit: string;
}

export interface FreightClassSuggestion {
  readonly densityPcf: string;
  readonly suggestedClass: string;
  readonly ruleVersion: typeof FREIGHT_CLASS_RULE_VERSION;
}

export function suggestFreightClass(values: FreightClassMeasurements): FreightClassSuggestion | null;
