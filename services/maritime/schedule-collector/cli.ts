import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createEnvelope } from "../../../src/logistics_mcp/platform/envelope";
import { createSyntheticOoclAdapter } from "./carriers/oocl";
import { normalizeCarrierId } from "./carriers/aliases";
import { listCarrierMetadata } from "./carriers/registry";
import { FileEvidenceStore } from "./evidence";
import {
  syntheticOoclLocationCandidates,
  syntheticOoclScheduleResponse,
} from "./fixtures/synthetic-oocl";
import { addUtcDays, defaultDateWindow } from "./normalize";
import type { CollectorPorts } from "./ports";
import { createCollectorService } from "./service";
import { DEFAULT_TRANSPORT_POLICY } from "./transport/config";
import { createControlledHttpTransport } from "./transport/http";
import { createCoscoLiveTransportPolicy } from "./transport/cosco-live";
import { createHmmLiveTransportPolicy } from "./transport/hmm-live";
import { createOneLiveTransportPolicy } from "./transport/one-live";
import { createNodePinnedConnector } from "./transport/node-connector";

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

class CliUsageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CliUsageError";
  }
}

const DEFAULT_QUERY_TIME_ZONE = "Asia/Shanghai";

function helpRequested(argv: readonly string[]): boolean {
  const commands = ["carriers", "locations", "query"];
  return (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0] ?? "")) ||
    (argv.length === 2 && ((argv[0] === "help" && commands.includes(argv[1] ?? "")) ||
      (commands.includes(argv[0] ?? "") && ["--help", "-h"].includes(argv[1] ?? ""))));
}

function helpText(): string {
  return `Ocean Schedule Collector / 船公司船期查询

Usage:
  node --import tsx/esm services/maritime/schedule-collector/cli.ts <command>
  carriers
  locations --carrier ID --query TEXT [--country CN] [--location-id ID] [--mode live]
  query --carrier ID --origin TEXT --destination TEXT
    [--origin-country CN] [--destination-country CA]
    [--origin-id ID] [--destination-id ID]
    [--from YYYY-MM-DD] [--until YYYY-MM-DD]
    [--routing any|direct|transshipment] [--time-zone Asia/Shanghai] [--mode live]

Live example (defaults to the next 42 days):
  node --import tsx/esm services/maritime/schedule-collector/cli.ts query --carrier ONE --origin Shanghai --origin-country CN --destination Vancouver --destination-country CA --routing any --mode live

Mode defaults to synthetic (offline fixture); use --mode live for real queries.
The bundled synthetic query fixture is OOCL. It always returns manual_review.
Dates filter departure from the first ocean leg; the maximum query window is 90 days.
Ambiguous locations require selecting an official candidate with --origin-id/--destination-id.
Carrier codes are not a promise of route coverage. Consult carriers and README for verified scope.
ONE live requests use CY/CY and GP cargo only. Times retain source precision and timezone limits.
Queries print a JSON envelope. Read status, coverage, warnings and provenance together.

Exit codes: 0 success; 1 internal failure; 2 CLI usage; 3 needs_input;
  4 manual_review; 5 blocked; 6 unavailable.

Carrier registry (implementation/verification state, not current availability):
${listCarrierMetadata().map((carrier) => `  ${carrier.id}: ${carrier.capabilityStatus}`).join("\n")}
`;
}

function parseFlags(
  argv: readonly string[],
  allowed: readonly string[],
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const allowedSet = new Set(allowed);
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new CliUsageError("cli_positional_argument_rejected");
    }
    if (!allowedSet.has(name)) throw new CliUsageError("cli_unknown_flag");
    if (values.has(name)) throw new CliUsageError("cli_duplicate_flag");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError("cli_flag_value_missing");
    }
    values.set(name, value);
    index += 1;
  }
  return values;
}

function oneOf(
  values: ReadonlyMap<string, string>,
  names: readonly string[],
  required: boolean,
): string | null {
  const present = names.filter((name) => values.has(name));
  if (present.length > 1) throw new CliUsageError("cli_alias_conflict");
  const value = present[0] === undefined ? null : values.get(present[0]) ?? null;
  if (required && value === null) {
    throw new CliUsageError("cli_required_flag_missing");
  }
  return value;
}

function modeValue(values: ReadonlyMap<string, string>): "live" | "synthetic" {
  const value = values.get("--mode") ?? "synthetic";
  if (value !== "live" && value !== "synthetic") {
    throw new CliUsageError("cli_mode_invalid");
  }
  return value;
}

function requestIds(): { readonly requestId: string; readonly auditId: string } {
  const id = randomUUID().replaceAll("-", "");
  return {
    requestId: `schedule-cli-request-${id}`,
    auditId: `schedule-cli-audit-${id}`,
  };
}

function createPorts(
  mode: "live" | "synthetic",
  carrier?: string,
): CollectorPorts {
  const policy =
    mode === "live"
      ? carrier === "HMM"
        ? createHmmLiveTransportPolicy()
        : carrier === "ONE"
          ? createOneLiveTransportPolicy()
          : createCoscoLiveTransportPolicy()
      : DEFAULT_TRANSPORT_POLICY;
  return {
    clock: { now: () => new Date() },
    context: {
      ...requestIds(),
      localFixture: mode === "synthetic",
    },
    audit: { record: () => Promise.resolve() },
    evidence: new FileEvidenceStore({
      root: resolve(
        process.cwd(),
        ".runtime",
        "schedule-collector",
        "evidence",
      ),
    }),
    http: createControlledHttpTransport({
      policy,
      connector:
        mode === "live"
          ? createNodePinnedConnector({
              maxResponseBytes: policy.maxResponseBytes,
              timeoutMs: policy.timeoutMs,
            })
          : null,
    }),
  };
}

function createService(mode: "live" | "synthetic", ports: CollectorPorts) {
  return createCollectorService({
    ports,
    adapters:
      mode === "synthetic"
        ? [
            createSyntheticOoclAdapter({
              origin: syntheticOoclLocationCandidates.origin,
              destination: syntheticOoclLocationCandidates.destination,
              response: syntheticOoclScheduleResponse,
              observedAt: ports.clock.now().toISOString(),
            }),
          ]
        : [],
  });
}

function exitCodeFor(status: string): number {
  switch (status) {
    case "success":
      return 0;
    case "needs_input":
      return 3;
    case "manual_review":
      return 4;
    case "blocked":
      return 5;
    case "unavailable":
      return 6;
    default:
      return 1;
  }
}

function printEnvelope(io: CliIo, value: unknown): number {
  io.stdout(`${JSON.stringify(value)}\n`);
  const status =
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string"
      ? value.status
      : "unavailable";
  return exitCodeFor(status);
}

function failureEnvelope(
  status: "needs_input" | "unavailable",
  code: string,
  message: string,
): unknown {
  const ids = requestIds();
  return createEnvelope({
    requestId: ids.requestId,
    auditId: ids.auditId,
    status,
    data: null,
    blockers: [{ code, message, severity: "error" }],
    reviewStatus: status === "needs_input" ? "pending" : "not_required",
  });
}

function queryArgs(argv: readonly string[]): {
  readonly carrier: string;
  readonly origin: string;
  readonly destination: string;
  readonly originId: string | null;
  readonly destinationId: string | null;
  readonly originCountry: string | null;
  readonly destinationCountry: string | null;
  readonly from: string;
  readonly until: string;
  readonly routing: "any" | "direct" | "transshipment";
  readonly mode: "live" | "synthetic";
} {
  const values = parseFlags(argv, [
    "--carrier",
    "--origin",
    "--origin-ref",
    "--origin-id",
    "--origin-country",
    "--destination",
    "--destination-ref",
    "--destination-id",
    "--destination-country",
    "--from",
    "--until",
    "--routing",
    "--time-zone",
    "--mode",
  ]);
  const rawCarrier = oneOf(values, ["--carrier"], true);
  const carrier = rawCarrier === null ? null : normalizeCarrierId(rawCarrier);
  const origin = oneOf(values, ["--origin", "--origin-ref"], true);
  const destination = oneOf(
    values,
    ["--destination", "--destination-ref"],
    true,
  );
  if (carrier === null || origin === null || destination === null) {
    throw new CliUsageError("cli_required_flag_missing");
  }
  const routingValue = values.get("--routing") ?? "any";
  if (
    routingValue !== "any" &&
    routingValue !== "direct" &&
    routingValue !== "transshipment"
  ) {
    throw new CliUsageError("cli_routing_invalid");
  }
  const mode = modeValue(values);
  const selectedFrom = values.get("--from") ?? null;
  const selectedUntil = values.get("--until") ?? null;
  if (selectedUntil !== null && selectedFrom === null) {
    throw new CliUsageError("cli_date_range_incomplete");
  }
  const fallback = defaultDateWindow(
    { now: () => new Date() },
    values.get("--time-zone") ?? DEFAULT_QUERY_TIME_ZONE,
    42,
  );
  return {
    carrier,
    origin,
    destination,
    originId: values.get("--origin-id") ?? null,
    destinationId: values.get("--destination-id") ?? null,
    originCountry: values.get("--origin-country") ?? null,
    destinationCountry: values.get("--destination-country") ?? null,
    from: selectedFrom ?? fallback.from,
    until:
      selectedUntil ??
      (selectedFrom === null ? fallback.until : addUtcDays(selectedFrom, 41)),
    routing: routingValue,
    mode,
  };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  if (helpRequested(argv)) {
    io.stdout(helpText());
    return 0;
  }
  const command = argv[0];
  try {
    if (command === "carriers") {
      const values = parseFlags(argv, ["--mode"]);
      const mode = modeValue(values);
      return printEnvelope(
        io,
        createService(mode, createPorts(mode)).carriers().envelope,
      );
    }
    if (command === "locations") {
      const values = parseFlags(argv, [
        "--carrier",
        "--query",
        "--country",
        "--location-id",
        "--mode",
      ]);
      const rawCarrier = oneOf(values, ["--carrier"], true);
      const carrier =
        rawCarrier === null ? null : normalizeCarrierId(rawCarrier);
      const query = oneOf(values, ["--query"], true);
      if (carrier === null || query === null) {
        throw new CliUsageError("cli_required_flag_missing");
      }
      const mode = modeValue(values);
      const result = await createService(
        mode,
        createPorts(mode, carrier),
      ).resolveLocations({
        carrier,
        text: query,
        countryCode: values.get("--country") ?? null,
        locationId: values.get("--location-id") ?? null,
      });
      return printEnvelope(io, result.envelope);
    }
    if (command === "query") {
      const args = queryArgs(argv);
      const result = await createService(
        args.mode,
        createPorts(args.mode, args.carrier),
      ).query({
        carrier: args.carrier,
        origin: {
          text: args.origin,
          country_code: args.originCountry,
          carrier_location_id: args.originId,
        },
        destination: {
          text: args.destination,
          country_code: args.destinationCountry,
          carrier_location_id: args.destinationId,
        },
        from: args.from,
        until: args.until,
        routing: args.routing,
      });
      return printEnvelope(io, result.envelope);
    }
    throw new CliUsageError("cli_unknown_command");
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      io.stdout(
        `${JSON.stringify(
          failureEnvelope(
            "needs_input",
            "validation_error",
            "CLI usage or argument validation failed.",
          ),
        )}\n`,
      );
      return 2;
    }
    io.stderr("collector_cli_internal_error\n");
    io.stdout(
      `${JSON.stringify(
        failureEnvelope(
          "unavailable",
          "unexpected_error",
          "The collector CLI failed unexpectedly.",
        ),
      )}\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  });
  process.exitCode = code;
}

const launchedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === launchedPath) {
  await main();
}
