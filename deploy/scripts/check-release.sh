#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "${1:-}" != "--fixture-only" ]]; then
  echo "usage: $0 --fixture-only" >&2
  echo "fixture-only mode performs local read-only checks; network is disabled" >&2
  exit 2
fi

test -s "$ROOT_DIR/package-lock.json"
test -s "$ROOT_DIR/deploy/Dockerfile"
test -s "$ROOT_DIR/deploy/compose.yml"
test -s "$ROOT_DIR/deploy/env.example"
test -s "$ROOT_DIR/docs/runbooks/release.md"
test -s "$ROOT_DIR/docs/runbooks/rollback.md"
test -s "$ROOT_DIR/docs/rfcs/2026-08-27-t0-production-profile-v1.md"
test -s "$ROOT_DIR/docs/rfcs/2026-08-27-credential-exchange-v1.md"
test -s "$ROOT_DIR/docs/runbooks/t0-release.md"
test -s "$ROOT_DIR/docs/runbooks/t0-rollback.md"
test -s "$ROOT_DIR/docs/runbooks/t0-single-region-evidence.template.md"

node docs/contracts/quote-v2-contract.test.mjs

ROOT_DIR="$ROOT_DIR" node --import tsx/esm --input-type=module -e '
  import { validateContractSchemas } from "./src/logistics_mcp/platform/validate-contracts.ts";
  const report = validateContractSchemas(process.env.ROOT_DIR);
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(failure);
    process.exit(1);
  }
  console.log(`fixture-only: validated ${report.schemaCount} schemas and ${report.exampleCount} examples; network disabled`);
'
