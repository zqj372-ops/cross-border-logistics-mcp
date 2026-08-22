export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
export const DESCRIPTOR_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactOwnKeys(
  value: object,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== expectedKeys.length) {
    return false;
  }
  const expected = new Set(expectedKeys);
  return actualKeys.every(
    (key) => typeof key === "string" && expected.has(key),
  );
}
