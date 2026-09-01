import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { SignJWT } from "jose";

import type { JwksResponse, JwtClaims, SignedJwt } from "./contracts";
import type { JwtSigningProvider, SecretPepperProvider } from "./ports";

const MAX_SECRET_FILE_BYTES = 64 * 1024;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
});
const DUMMY_SALT = new Uint8Array(16).fill(0x5a);
const DUMMY_HASH = new Uint8Array(SCRYPT_KEY_LENGTH).fill(0xa5);
const PEPPER_HISTORY_FORMAT = "access-gateway-credential-pepper-history/v1" as const;
const MAX_RETAINED_PEPPERS = 64;
const KEY_HISTORY_FORMAT = "access-gateway-jwt-key-history/v1" as const;
const MIN_KEY_RETENTION_SECONDS = 900 + 30 + 300;
const MAX_KEY_RETENTION_SECONDS = 7 * 24 * 60 * 60;

function readProtectedFile(path: string, label: string): Buffer {
  if (!isAbsolute(path)) throw new TypeError(`${label} path must be absolute.`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular file.`);
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new TypeError(`${label} permission must deny group and world access.`);
  }
  if (entry.size <= 0 || entry.size > MAX_SECRET_FILE_BYTES) {
    throw new TypeError(`${label} size is invalid.`);
  }
  return readFileSync(path);
}

export function deriveCredentialSecretHash(
  secret: string,
  salt: Uint8Array,
  pepper: Uint8Array,
): Promise<Uint8Array> {
  const combinedSalt = Buffer.concat([Buffer.from(salt), Buffer.from(pepper)]);
  return new Promise((resolve, reject) => {
    scrypt(secret, combinedSalt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, value) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(value));
    });
  });
}

export interface FileSecretPepperProviderOptions {
  readonly pepperPath: string;
  readonly pepperVersion: string;
  readonly historyPath?: string;
}

interface PepperHistoryEntry {
  readonly version: string;
  readonly pepper: Uint8Array;
}

interface PepperHistory {
  readonly format: typeof PEPPER_HISTORY_FORMAT;
  readonly activeVersion: string;
  readonly entries: readonly PepperHistoryEntry[];
}

export function validCredentialPepperVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function readPepperHistory(path: string): PepperHistory | null {
  let bytes: Buffer;
  try {
    bytes = readProtectedFile(path, "Credential pepper history");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new TypeError("Credential pepper history is invalid.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Credential pepper history is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "active_version,format,peppers" ||
    record.format !== PEPPER_HISTORY_FORMAT ||
    !validCredentialPepperVersion(record.active_version) ||
    !Array.isArray(record.peppers) ||
    record.peppers.length < 1 ||
    record.peppers.length > MAX_RETAINED_PEPPERS
  ) {
    throw new TypeError("Credential pepper history is invalid.");
  }
  const entries: PepperHistoryEntry[] = [];
  const versions = new Set<string>();
  for (const candidate of record.peppers) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError("Credential pepper history is invalid.");
    }
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "pepper,version" ||
      !validCredentialPepperVersion(entry.version) ||
      typeof entry.pepper !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.pepper)
    ) {
      throw new TypeError("Credential pepper history is invalid.");
    }
    const pepper = Buffer.from(entry.pepper, "base64");
    if (
      pepper.byteLength < 32 ||
      pepper.byteLength > 256 ||
      pepper.toString("base64") !== entry.pepper ||
      versions.has(entry.version)
    ) {
      throw new TypeError("Credential pepper history is invalid.");
    }
    versions.add(entry.version);
    entries.push(Object.freeze({ version: entry.version, pepper: new Uint8Array(pepper) }));
  }
  if (!versions.has(record.active_version)) {
    throw new TypeError("Credential pepper history is invalid.");
  }
  return Object.freeze({
    format: PEPPER_HISTORY_FORMAT,
    activeVersion: record.active_version,
    entries: Object.freeze(entries),
  });
}

function writePepperHistory(path: string, value: PepperHistory): void {
  if (!isAbsolute(path)) throw new TypeError("Credential pepper history path must be absolute.");
  const parent = resolve(dirname(path));
  const parentEntry = lstatSync(parent);
  if (
    !parentEntry.isDirectory() ||
    parentEntry.isSymbolicLink() ||
    (parentEntry.mode & 0o077) !== 0
  ) {
    throw new TypeError("Credential pepper history parent must be a protected real directory.");
  }
  const temporaryPath = join(parent, `.credential-pepper-history-${randomBytes(12).toString("hex")}.tmp`);
  const serialized = `${JSON.stringify({
    format: value.format,
    active_version: value.activeVersion,
    peppers: value.entries.map((entry) => ({
      version: entry.version,
      pepper: Buffer.from(entry.pepper).toString("base64"),
    })),
  }, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the history write error.
    }
    throw error;
  }
}

function reconcilePepperHistory(
  currentVersion: string,
  currentPepper: Uint8Array,
  previous: PepperHistory | null,
): PepperHistory {
  const entries = previous === null ? [] : [...previous.entries];
  const existing = entries.find((entry) => entry.version === currentVersion);
  if (existing !== undefined) {
    if (!Buffer.from(existing.pepper).equals(Buffer.from(currentPepper))) {
      throw new TypeError("Credential pepper version cannot be reused with different material.");
    }
  } else {
    if (entries.length >= MAX_RETAINED_PEPPERS) {
      throw new TypeError("Credential pepper history retention limit was reached.");
    }
    entries.push(Object.freeze({
      version: currentVersion,
      pepper: new Uint8Array(currentPepper),
    }));
  }
  return Object.freeze({
    format: PEPPER_HISTORY_FORMAT,
    activeVersion: currentVersion,
    entries: Object.freeze(entries),
  });
}

export class FileSecretPepperProvider implements SecretPepperProvider {
  readonly kind = "production" as const;
  readonly pepperVersion: string;
  readonly #pepper: Uint8Array;
  readonly #peppers: ReadonlyMap<string, Uint8Array>;

  constructor(options: FileSecretPepperProviderOptions) {
    if (!validCredentialPepperVersion(options.pepperVersion)) {
      throw new TypeError("Credential pepper version is invalid.");
    }
    const pepper = readProtectedFile(options.pepperPath, "Credential pepper");
    if (pepper.byteLength < 32 || pepper.byteLength > 256) {
      throw new TypeError("Credential pepper must contain 32 through 256 bytes.");
    }
    this.pepperVersion = options.pepperVersion;
    this.#pepper = new Uint8Array(pepper);
    if (options.historyPath === undefined) {
      this.#peppers = new Map([[this.pepperVersion, this.#pepper]]);
      return;
    }
    if (resolve(options.historyPath) === resolve(options.pepperPath)) {
      throw new TypeError("Credential pepper and history paths must be different.");
    }
    const history = reconcilePepperHistory(
      this.pepperVersion,
      this.#pepper,
      readPepperHistory(options.historyPath),
    );
    writePepperHistory(options.historyPath, history);
    this.#peppers = new Map(history.entries.map((entry) => [
      entry.version,
      new Uint8Array(entry.pepper),
    ]));
  }

  supportsPepperVersion(version: string): boolean {
    return this.#peppers.has(version);
  }

  hashCredentialSecret(input: Readonly<{
    secret: string;
    salt: Uint8Array;
    pepperVersion: string;
  }>): Promise<Uint8Array> {
    if (
      input.pepperVersion !== this.pepperVersion ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.secret) ||
      !(input.salt instanceof Uint8Array) ||
      input.salt.byteLength < 16 ||
      input.salt.byteLength > 64
    ) {
      return Promise.reject(new TypeError("Credential derivation input is invalid."));
    }
    return deriveCredentialSecretHash(input.secret, input.salt, this.#pepper);
  }

  async verifyCredentialSecret(input: Readonly<{
    secret: string;
    material: Readonly<{
      salt: Uint8Array;
      expectedHash: Uint8Array;
      pepperVersion: string;
    }> | null;
  }>): Promise<boolean> {
    const material = input.material;
    const selectedPepper = material === null
      ? undefined
      : this.#peppers.get(material.pepperVersion);
    const structurallyValid = material !== null &&
      selectedPepper !== undefined &&
      material.salt instanceof Uint8Array &&
      material.salt.byteLength >= 16 &&
      material.salt.byteLength <= 64 &&
      material.expectedHash instanceof Uint8Array &&
      material.expectedHash.byteLength === SCRYPT_KEY_LENGTH &&
      /^[A-Za-z0-9_-]{43}$/u.test(input.secret);
    const candidate = await deriveCredentialSecretHash(
      /^[A-Za-z0-9_-]{43}$/u.test(input.secret) ? input.secret : "_".repeat(43),
      structurallyValid ? material.salt : DUMMY_SALT,
      structurallyValid && selectedPepper !== undefined ? selectedPepper : this.#pepper,
    );
    const expected = structurallyValid ? material.expectedHash : DUMMY_HASH;
    return structurallyValid && timingSafeEqual(candidate, expected);
  }
}

export interface FileJwtSigningProviderOptions {
  readonly privateKeyPath: string;
  readonly historyPath: string;
  readonly nowSeconds: () => number;
  readonly retentionSeconds: number;
}

type SigningPublicJwk = ReturnType<typeof publicJwkFor>;

interface KeyHistory {
  readonly format: typeof KEY_HISTORY_FORMAT;
  readonly active: SigningPublicJwk;
  readonly previous: Readonly<{
    readonly key: SigningPublicJwk;
    readonly retireAfter: number;
  }> | null;
}

function publicJwkFromUnknown(value: unknown): SigningPublicJwk {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("JWT key history is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "alg,e,kid,kty,n,use" ||
    record.kty !== "RSA" ||
    record.alg !== "RS256" ||
    record.use !== "sig" ||
    typeof record.kid !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(record.kid) ||
    typeof record.n !== "string" ||
    !/^[A-Za-z0-9_-]{128,1024}$/u.test(record.n) ||
    typeof record.e !== "string" ||
    !/^[A-Za-z0-9_-]{1,16}$/u.test(record.e)
  ) {
    throw new TypeError("JWT key history is invalid.");
  }
  const calculatedKid = createHash("sha256")
    .update(`logistics-mcp-rs256\u0000${record.n}\u0000${record.e}`, "utf8")
    .digest("base64url");
  if (calculatedKid !== record.kid) throw new TypeError("JWT key history is invalid.");
  return Object.freeze({
    kty: "RSA",
    kid: record.kid,
    alg: "RS256",
    use: "sig",
    n: record.n,
    e: record.e,
  });
}

function readKeyHistory(path: string): KeyHistory | null {
  let bytes: Buffer;
  try {
    bytes = readProtectedFile(path, "JWT key history");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new TypeError("JWT key history is invalid.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("JWT key history is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "active,format,previous" ||
    record.format !== KEY_HISTORY_FORMAT
  ) {
    throw new TypeError("JWT key history is invalid.");
  }
  const active = publicJwkFromUnknown(record.active);
  if (record.previous === null) {
    return Object.freeze({ format: KEY_HISTORY_FORMAT, active, previous: null });
  }
  if (typeof record.previous !== "object" || Array.isArray(record.previous)) {
    throw new TypeError("JWT key history is invalid.");
  }
  const previous = record.previous as Record<string, unknown>;
  if (
    Object.keys(previous).sort().join(",") !== "key,retire_after" ||
    !Number.isSafeInteger(previous.retire_after) ||
    (previous.retire_after as number) < 0
  ) {
    throw new TypeError("JWT key history is invalid.");
  }
  const previousKey = publicJwkFromUnknown(previous.key);
  if (previousKey.kid === active.kid) throw new TypeError("JWT key history is invalid.");
  return Object.freeze({
    format: KEY_HISTORY_FORMAT,
    active,
    previous: Object.freeze({
      key: previousKey,
      retireAfter: previous.retire_after as number,
    }),
  });
}

function writeKeyHistory(path: string, value: KeyHistory): void {
  if (!isAbsolute(path)) throw new TypeError("JWT key history path must be absolute.");
  const parent = resolve(dirname(path));
  const parentEntry = lstatSync(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new TypeError("JWT key history parent must be a real directory.");
  }
  const temporaryPath = join(parent, `.jwt-key-history-${randomBytes(12).toString("hex")}.tmp`);
  const serialized = `${JSON.stringify({
    format: value.format,
    active: value.active,
    previous: value.previous === null
      ? null
      : { key: value.previous.key, retire_after: value.previous.retireAfter },
  }, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the history write error.
    }
    throw error;
  }
}

function selectKeyHistory(
  current: SigningPublicJwk,
  previousHistory: KeyHistory | null,
  nowSeconds: number,
  retentionSeconds: number,
): KeyHistory {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError("JWT key history clock is invalid.");
  }
  if (
    !Number.isSafeInteger(retentionSeconds) ||
    retentionSeconds < MIN_KEY_RETENTION_SECONDS ||
    retentionSeconds > MAX_KEY_RETENTION_SECONDS
  ) {
    throw new TypeError("JWT key retention window is invalid.");
  }
  if (previousHistory === null) {
    return Object.freeze({ format: KEY_HISTORY_FORMAT, active: current, previous: null });
  }
  const retained = previousHistory.previous?.retireAfter !== undefined &&
    previousHistory.previous.retireAfter > nowSeconds
    ? previousHistory.previous
    : null;
  if (previousHistory.active.kid === current.kid) {
    return Object.freeze({ format: KEY_HISTORY_FORMAT, active: current, previous: retained });
  }
  if (retained?.key.kid === current.kid) {
    return Object.freeze({
      format: KEY_HISTORY_FORMAT,
      active: current,
      previous: Object.freeze({
        key: previousHistory.active,
        retireAfter: Math.max(retained.retireAfter, nowSeconds + retentionSeconds),
      }),
    });
  }
  if (retained !== null) {
    throw new TypeError("JWT signing key cannot rotate again before the retained key expires.");
  }
  return Object.freeze({
    format: KEY_HISTORY_FORMAT,
    active: current,
    previous: Object.freeze({
      key: previousHistory.active,
      retireAfter: nowSeconds + retentionSeconds,
    }),
  });
}

function publicJwkFor(privateKey: KeyObject): Readonly<{
  kty: "RSA";
  kid: string;
  alg: "RS256";
  use: "sig";
  n: string;
  e: string;
}> {
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (
    exported.kty !== "RSA" ||
    typeof exported.n !== "string" ||
    typeof exported.e !== "string"
  ) {
    throw new TypeError("JWT signing key must export a public RSA JWK.");
  }
  const kid = createHash("sha256")
    .update(`logistics-mcp-rs256\u0000${exported.n}\u0000${exported.e}`, "utf8")
    .digest("base64url");
  return Object.freeze({
    kty: "RSA",
    kid,
    alg: "RS256",
    use: "sig",
    n: exported.n,
    e: exported.e,
  });
}

export class FileJwtSigningProvider implements JwtSigningProvider {
  readonly kind = "production" as const;
  readonly #privateKey: KeyObject;
  readonly #jwks: JwksResponse;

  constructor(options: FileJwtSigningProviderOptions) {
    if (!isAbsolute(options.historyPath) || options.historyPath === options.privateKeyPath) {
      throw new TypeError("JWT key history path is invalid.");
    }
    const pem = readProtectedFile(options.privateKeyPath, "JWT signing key");
    const privateKey = createPrivateKey(pem);
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new TypeError("JWT signing key must be RSA with at least 2048 bits.");
    }
    const current = publicJwkFor(privateKey);
    const history = selectKeyHistory(
      current,
      readKeyHistory(options.historyPath),
      options.nowSeconds(),
      options.retentionSeconds,
    );
    writeKeyHistory(options.historyPath, history);
    this.#privateKey = privateKey;
    this.#jwks = Object.freeze({
      keys: Object.freeze([
        history.active,
        ...(history.previous === null ? [] : [history.previous.key]),
      ]),
    });
  }

  async sign(claims: JwtClaims): Promise<SignedJwt> {
    const key = this.#jwks.keys[0];
    if (key === undefined) throw new Error("JWT public key is unavailable.");
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
      .sign(this.#privateKey);
    return Object.freeze({ token, kid: key.kid });
  }

  getJwks(): Promise<JwksResponse> {
    return Promise.resolve(this.#jwks);
  }
}
