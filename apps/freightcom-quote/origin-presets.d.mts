export interface OriginAddressPreset {
  readonly id: string;
  readonly label: string;
  readonly address_line_1: string;
  readonly city: string;
  readonly region: string;
  readonly country: "CA";
  readonly postal_code: string;
}

export const ORIGIN_ADDRESS_PRESETS: readonly OriginAddressPreset[];
export function findOriginAddressPreset(id: string): OriginAddressPreset | null;
