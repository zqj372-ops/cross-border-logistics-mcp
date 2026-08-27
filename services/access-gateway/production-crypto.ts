import {
  createHash,
  createPrivateKey,
  createPublicKey,
  scrypt,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

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

function derive(secret: string, salt: Uint8Array, pepper: Uint8Array): Promise<Uint8Array> {
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
}

export class FileSecretPepperProvider implements SecretPepperProvider {
  readonly kind = "production" as const;
  readonly pepperVersion: string;
  readonly #pepper: Uint8Array;

  constructor(options: FileSecretPepperProviderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(options.pepperVersion)) {
      throw new TypeError("Credential pepper version is invalid.");
    }
    const pepper = readProtectedFile(options.pepperPath, "Credential pepper");
    if (pepper.byteLength < 32 || pepper.byteLength > 256) {
      throw new TypeError("Credential pepper must contain 32 through 256 bytes.");
    }
    this.pepperVersion = options.pepperVersion;
    this.#pepper = new Uint8Array(pepper);
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
    return derive(input.secret, input.salt, this.#pepper);
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
    const structurallyValid = material !== null &&
      material.pepperVersion === this.pepperVersion &&
      material.salt instanceof Uint8Array &&
      material.salt.byteLength >= 16 &&
      material.salt.byteLength <= 64 &&
      material.expectedHash instanceof Uint8Array &&
      material.expectedHash.byteLength === SCRYPT_KEY_LENGTH &&
      /^[A-Za-z0-9_-]{43}$/u.test(input.secret);
    const candidate = await derive(
      /^[A-Za-z0-9_-]{43}$/u.test(input.secret) ? input.secret : "_".repeat(43),
      structurallyValid ? material.salt : DUMMY_SALT,
      this.#pepper,
    );
    const expected = structurallyValid ? material.expectedHash : DUMMY_HASH;
    return structurallyValid && timingSafeEqual(candidate, expected);
  }
}

export interface FileJwtSigningProviderOptions {
  readonly privateKeyPath: string;
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
    const pem = readProtectedFile(options.privateKeyPath, "JWT signing key");
    const privateKey = createPrivateKey(pem);
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new TypeError("JWT signing key must be RSA with at least 2048 bits.");
    }
    this.#privateKey = privateKey;
    this.#jwks = Object.freeze({ keys: Object.freeze([publicJwkFor(privateKey)]) });
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
