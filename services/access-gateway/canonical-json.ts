import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
    seen.add(value);
    const serialized = `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Canonical JSON accepts only JSON values.");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Canonical JSON accepts only plain objects.");
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, seen)}`);
  seen.delete(value);
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

export function canonicalJsonHash(namespace: string, value: unknown): `sha256:v1:${string}` {
  if (!/^[a-z0-9][a-z0-9./_-]{2,127}$/u.test(namespace)) {
    throw new TypeError("Canonical hash namespace is invalid.");
  }
  const digest = createHash("sha256")
    .update(`${namespace}\u0000${canonicalJson(value)}`, "utf8")
    .digest("hex");
  return `sha256:v1:${digest}`;
}
