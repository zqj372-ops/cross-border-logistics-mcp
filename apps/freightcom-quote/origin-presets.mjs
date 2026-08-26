export const ORIGIN_ADDRESS_PRESETS = Object.freeze([
  Object.freeze({
    id: "calgary-t2e6m9",
    label: "Calgary · 1155 40 Ave NE",
    address_line_1: "1155 40 Ave NE",
    city: "Calgary",
    region: "AB",
    country: "CA",
    postal_code: "T2E 6M9",
  }),
  Object.freeze({
    id: "markham-l3r3j7",
    label: "Markham · 331 Amber St",
    address_line_1: "331 Amber St",
    city: "Markham",
    region: "ON",
    country: "CA",
    postal_code: "L3R 3J7",
  }),
]);

export function findOriginAddressPreset(id) {
  return ORIGIN_ADDRESS_PRESETS.find((preset) => preset.id === id) ?? null;
}
