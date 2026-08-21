---
standard_id: implementation-plan
version: 2026-08-21.v0
priority: 40
audience: developer,reviewer
rule_ids: PLAN-TRACE-001
---

# Plan: Module Runtime + Agent Standard Access v0

> **Execution note:** this plan is being executed on the clean `codex/v2` branch after the user-directed design approval. It does not modify `main` or production systems.

## Step 1: Lock the contract boundary

Files:

- `docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md`
- `docs/superpowers/specs/2026-08-21-module-runtime-agent-access-design.md`
- `AGENTS.md`

Actions:

1. Record the new ownership boundary, JSON-native registry decision, compatibility and rollback rules.
2. Add a short bootstrap pointer in `AGENTS.md` without deleting the existing safety rules.
3. Run `git diff --check`.

## Step 2: Establish failing tests for the Standard Registry

Files:

- `tests/agent-context/registry.test.ts`
- `tests/agent-context/resolver.test.ts`
- `tests/agent-context/pack.test.ts`

Actions:

1. Assert valid index/profile loading, unknown IDs, path escape, duplicate rules and same-priority conflicts.
2. Assert deterministic sha256 pack output and no absolute paths or credential literals.
3. Run `npm exec vitest run tests/agent-context --pool=forks --poolOptions.forks.singleFork=true`; confirm the new tests fail because the implementation is absent.

## Step 3: Implement Standard Registry and Agent Context

Files:

- `docs/agent/index.json`
- `docs/agent/profiles/*.json`
- `docs/agent/workstreams/current.json`
- `docs/standards/*.md`
- `schemas/agent/*.schema.json`
- `src/logistics_mcp/agent-context/*.ts`
- `dist/standards/agent-standard-pack.json` (generated, ignored/reproducible)

Actions:

1. Add registry/profile schemas with Draft 2020-12 and `additionalProperties: false`.
2. Implement safe root containment, registry validation, profile resolution, conflict handling and pack generation.
3. Add CLI entrypoints for validation and pack build.
4. Make the implementation read the immutable pack at runtime; source Markdown is development/build input only.
5. Run the three focused test files and the two agent scripts.

## Step 4: Establish and implement Module Runtime v0

Files:

- `tests/module-runtime/*.test.ts`
- `src/logistics_mcp/module-runtime/*.ts`
- `src/logistics_mcp/modules/cargo/module.ts`
- `src/logistics_mcp/modules/container/module.ts`

Actions:

1. Add failing tests for capability injection, duplicate tool IDs, missing dependencies, lease cleanup and mount failure.
2. Implement manifest validation, capability registry, tool catalog, registration lease and static host.
3. Add cargo/container adapters that preserve current domain contracts and handlers.
4. Run focused module-runtime tests and compare catalog names with the legacy registry.

## Step 5: Integrate Agent access into MCP

Files:

- `src/logistics_mcp/platform/rbac.ts`
- `src/logistics_mcp/server/tool-registry.ts`
- `src/logistics_mcp/server/http.ts`
- `src/logistics_mcp/server/composition.ts`
- `tests/platform/agent-context-tool.test.ts`
- `tests/e2e/mcp-resources.test.ts`
- `deploy/clients/*.json`, `deploy/clients/*.toml`, `docs/runbooks/client-onboarding.md`

Actions:

1. Add the read-only tool with an explicit allowlist and response schema.
2. Register only fixed MCP resources whose content comes from the built pack.
3. Preserve tenant/actor injection and audit behavior; do not accept identity fields from tool input.
4. Add Codex/ChatGPT/enterprise adapter notes without adding credentials or tenant IDs.
5. Run focused HTTP/resource tests.

## Step 6: Full verification and handoff

Commands:

- `npm run validate:agent-standards`
- `npm run build:agent-pack`
- `npm run validate:agent-adapters`
- `npm run test:agent-context`
- `npm run test:module-runtime`
- `npm run test:mcp-resources`
- `npm run typecheck`
- `npm run lint`
- `npm test -- --pool=forks --poolOptions.forks.singleFork=true`
- `git diff --check`

Report only commands that return actual output. Any hanging baseline command remains explicitly unverified.
