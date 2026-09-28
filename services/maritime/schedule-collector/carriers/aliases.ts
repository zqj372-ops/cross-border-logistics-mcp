export const CARRIER_IDS = [
  "COSCO",
  "OOCL",
  "EVERGREEN",
  "HMM",
  "WHL",
  "YML",
  "ZIM",
  "HAPAG_LLOYD",
  "ONE",
  "MAERSK",
  "MSC",
  "MATSON",
  "SML",
] as const;

export type CanonicalCarrierId = (typeof CARRIER_IDS)[number];

const CARRIER_ALIASES: Readonly<Record<string, CanonicalCarrierId>> = {
  COSCO: "COSCO",
  OOCL: "OOCL",
  EMC: "EVERGREEN",
  EVERGREEN: "EVERGREEN",
  EVERGREEN_LINE: "EVERGREEN",
  HMM: "HMM",
  WHL: "WHL",
  WAN_HAI: "WHL",
  WANHAI: "WHL",
  YML: "YML",
  YANG_MING: "YML",
  YANGMING: "YML",
  ZIM: "ZIM",
  HAPAG_LLOYD: "HAPAG_LLOYD",
  HAPAG: "HAPAG_LLOYD",
  HPL: "HAPAG_LLOYD",
  SML: "SML",
  SM_LINE: "SML",
  SMLINE: "SML",
  ONE: "ONE",
  OCEAN_NETWORK_EXPRESS: "ONE",
  MSK: "MAERSK",
  MAERSK: "MAERSK",
  MSC: "MSC",
  MATSON: "MATSON",
  "美森": "MATSON",
};

export function normalizeCarrierId(value: string): CanonicalCarrierId | null {
  const key = value.trim().toUpperCase();
  return CARRIER_ALIASES[key] ?? null;
}
