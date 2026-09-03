import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { build } from "esbuild";

export type T0ModuleId = "cargo" | "container" | "agent-access";
export type ReadPreviewModuleId = T0ModuleId |
  "canada-final-mile-quote" |
  "riskcustoms-ca" |
  "freightcom-ltl";
export type Sha256Digest = `sha256:${string}`;

interface ModuleArtifactSpec {
  readonly entryPoint: string;
  readonly canonicalJsonFiles: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const artifactSpecs: Readonly<Record<ReadPreviewModuleId, ModuleArtifactSpec>> = Object.freeze({
  cargo: Object.freeze({
    entryPoint: "src/logistics_mcp/modules/cargo/module.ts",
    canonicalJsonFiles: Object.freeze([
      "docs/contracts/schemas/common.schema.json",
      "docs/contracts/schemas/cargo-line.schema.json",
      "docs/contracts/schemas/cargo-metrics.schema.json",
      "docs/contracts/schemas/chargeable-weight.schema.json",
      "docs/contracts/schemas/cargo-result.schema.json",
    ]),
  }),
  container: Object.freeze({
    entryPoint: "src/logistics_mcp/modules/container/module.ts",
    canonicalJsonFiles: Object.freeze([]),
  }),
  "agent-access": Object.freeze({
    entryPoint: "src/logistics_mcp/modules/agent-access/module.ts",
    canonicalJsonFiles: Object.freeze([]),
  }),
  "canada-final-mile-quote": Object.freeze({
    entryPoint: "src/logistics_mcp/modules/canada-final-mile-quote/module.ts",
    canonicalJsonFiles: Object.freeze([]),
  }),
  "riskcustoms-ca": Object.freeze({
    entryPoint: "src/logistics_mcp/modules/riskcustoms-ca/module.ts",
    canonicalJsonFiles: Object.freeze([]),
  }),
  "freightcom-ltl": Object.freeze({
    entryPoint: "src/logistics_mcp/modules/freightcom-ltl/module.ts",
    canonicalJsonFiles: Object.freeze([]),
  }),
});

const t0ModuleIds: readonly T0ModuleId[] = Object.freeze([
  "cargo",
  "container",
  "agent-access",
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("Canonical JSON contains an unsupported value.");
}

function artifactDigest(
  moduleId: ReadPreviewModuleId,
  chunks: readonly { readonly label: string; readonly bytes: Uint8Array }[],
): Sha256Digest {
  const hash = createHash("sha256");
  hash.update("logistics-mcp.t0-module-artifact.v1\0", "utf8");
  hash.update(moduleId, "utf8");
  hash.update("\0", "utf8");
  for (const chunk of chunks) {
    hash.update(chunk.label, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(chunk.bytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(chunk.bytes);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function computeModuleArtifactDigest(
  moduleId: ReadPreviewModuleId,
  spec: ModuleArtifactSpec,
): Promise<Sha256Digest> {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [spec.entryPoint],
    outfile: "t0-module-artifact.mjs",
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const bundle = result.outputFiles[0];
  if (bundle === undefined) {
    throw new Error(`No artifact bytes were emitted for T0 module ${moduleId}.`);
  }

  const schemaChunks = await Promise.all(spec.canonicalJsonFiles.map(async (relativePath) => {
    const source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
    const parsed = JSON.parse(source) as unknown;
    return {
      label: `canonical-json:${relativePath}`,
      bytes: Buffer.from(canonicalJson(parsed), "utf8"),
    };
  }));

  return artifactDigest(moduleId, [
    { label: `esbuild:${spec.entryPoint}`, bytes: bundle.contents },
    ...schemaChunks,
  ]);
}

export async function computeT0ModuleArtifactDigests(): Promise<
  Readonly<Record<T0ModuleId, Sha256Digest>>
> {
  const entries = await Promise.all(
    t0ModuleIds.map(async (moduleId) => [
      moduleId,
      await computeModuleArtifactDigest(moduleId, artifactSpecs[moduleId]),
    ] as const),
  );
  return Object.freeze(Object.fromEntries(entries) as Record<T0ModuleId, Sha256Digest>);
}

export async function computeReadPreviewModuleArtifactDigests(): Promise<
  Readonly<Record<ReadPreviewModuleId, Sha256Digest>>
> {
  const entries = await Promise.all(
    (Object.entries(artifactSpecs) as readonly [ReadPreviewModuleId, ModuleArtifactSpec][])
      .map(async ([moduleId, spec]) => [
        moduleId,
        await computeModuleArtifactDigest(moduleId, spec),
      ] as const),
  );
  return Object.freeze(
    Object.fromEntries(entries) as Record<ReadPreviewModuleId, Sha256Digest>,
  );
}

export async function assertT0ModuleArtifactDigests(
  descriptors: readonly {
    readonly module_id: string;
    readonly artifact_digest: Sha256Digest;
  }[],
): Promise<void> {
  const actual = await computeT0ModuleArtifactDigests();
  const reviewedIds = descriptors.map(({ module_id }) => module_id).sort();
  const actualIds = Object.keys(actual).sort();
  if (JSON.stringify(reviewedIds) !== JSON.stringify(actualIds)) {
    throw new Error("The reviewed T0 module set does not match the reproducible artifact set.");
  }
  for (const descriptor of descriptors) {
    const actualDigest = actual[descriptor.module_id as T0ModuleId];
    if (actualDigest !== descriptor.artifact_digest) {
      throw new Error(
        `T0 module ${descriptor.module_id} implementation, validator, or schema bytes do not match the reviewed artifact digest.`,
      );
    }
  }
}

export async function assertReadPreviewModuleArtifactDigests(
  descriptors: readonly {
    readonly module_id: string;
    readonly artifact_digest: Sha256Digest;
  }[],
): Promise<void> {
  const actual = await computeReadPreviewModuleArtifactDigests();
  const reviewedIds = descriptors.map(({ module_id }) => module_id).sort();
  const actualIds = Object.keys(actual).sort();
  if (JSON.stringify(reviewedIds) !== JSON.stringify(actualIds)) {
    throw new Error("The reviewed read-preview module set does not match the reproducible artifact set.");
  }
  for (const descriptor of descriptors) {
    const actualDigest = actual[descriptor.module_id as ReadPreviewModuleId];
    if (actualDigest !== descriptor.artifact_digest) {
      throw new Error(
        `Read-preview module ${descriptor.module_id} implementation, validator, or schema bytes do not match the reviewed artifact digest.`,
      );
    }
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { READ_PREVIEW_MODULE_DESCRIPTORS, T0_MODULE_DESCRIPTORS } = await import("./production");
  await assertT0ModuleArtifactDigests(T0_MODULE_DESCRIPTORS);
  await assertReadPreviewModuleArtifactDigests(READ_PREVIEW_MODULE_DESCRIPTORS);
  process.stdout.write("T0 and read-preview module artifact attestation passed.\n");
}
