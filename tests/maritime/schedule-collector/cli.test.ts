import { describe, expect, it } from "vitest";

import { runCli } from "../../../services/maritime/schedule-collector/cli";

interface CliEnvelope {
  readonly status: string;
  readonly data: unknown;
  readonly blockers: readonly { readonly code: string }[];
}

function envelopeFrom(lines: readonly string[]): CliEnvelope {
  return JSON.parse(lines.join("")) as CliEnvelope;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

describe("schedule collector CLI", () => {
  it("shows help without live requests while keeping malformed arguments invalid", async () => {
    for (const argv of [["--help"], ["help"], ["query", "--help"], ["locations", "--help"], ["carriers", "--help"], ["help", "query"]]) {
      const output = capture();
      expect(await runCli(argv, output.io)).toBe(0);
      expect(output.stdout.join("")).toContain("--mode live");
      expect(output.stdout.join("")).toContain("synthetic");
      expect(output.stdout.join("")).toContain("manual_review");
      expect(output.stdout.join("")).toContain("ONE");
      expect(output.stderr).toEqual([]);
    }
    const invalid = capture();
    expect(await runCli(["query", "--help", "--unknown"], invalid.io)).toBe(2);
    expect(envelopeFrom(invalid.stdout).status).toBe("needs_input");
  });

  it("lists carriers as JSON", async () => {
    const output = capture();
    const code = await runCli(["carriers"], output.io);
    const envelope = envelopeFrom(output.stdout);
    const data = envelope.data as {
      readonly carriers: readonly {
        readonly id: string;
        readonly capability_status: string;
      }[];
    };
    expect(code).toBe(0);
    expect(envelope.status).toBe("success");
    expect(data.carriers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "OOCL",
          capability_status: "implemented_unverified",
        }),
      ]),
    );
    expect(data.carriers.map((carrier) => carrier.id)).toEqual([
      "COSCO",
      "OOCL",
      "EVERGREEN",
      "HMM",
      "WHL",
      "YML",
      "ZIM",
      "HAPAG_LLOYD",
      "ONE",
      "MAERSK",
      "MSC",
      "MATSON",
    ]);
    expect(output.stderr).toEqual([]);
  });

  it("returns official-style candidates for ambiguity without throwing", async () => {
    const output = capture();
    const code = await runCli(
      [
        "locations",
        "--carrier",
        "OOCL",
        "--query",
        "Vancouver",
        "--mode",
        "synthetic",
      ],
      output.io,
    );
    const envelope = envelopeFrom(output.stdout);
    const data = envelope.data as {
      readonly candidates: readonly unknown[];
      readonly resolved: unknown;
    };
    expect(code).toBe(3);
    expect(envelope.status).toBe("needs_input");
    expect(data.candidates).toHaveLength(2);
    expect(data.resolved).toBeNull();
  });

  it("runs the synthetic fixture end to end without network and keeps POD separate", async () => {
    const output = capture();
    const code = await runCli(
      [
        "query",
        "--carrier",
        "OOCL",
        "--origin",
        "Shanghai",
        "--origin-country",
        "CN",
        "--destination",
        "Toronto",
        "--destination-country",
        "CA",
        "--from",
        "2026-09-17",
        "--until",
        "2026-10-28",
        "--mode",
        "synthetic",
      ],
      output.io,
    );
    const envelope = envelopeFrom(output.stdout);
    const data = envelope.data as {
      readonly records: readonly {
        readonly query_destination: string;
        readonly pod: { readonly carrier_location_id: string };
      }[];
    };
    expect(code).toBe(4);
    expect(envelope.status).toBe("manual_review");
    expect(envelope.blockers[0]).toMatchObject({ code: "synthetic_data" });
    expect(data.records[0]).toMatchObject({
      query_destination: "synthetic-oocl-toronto-ca",
      pod: { carrier_location_id: "synthetic-oocl-vancouver-ca" },
    });
    expect(output.stderr).toEqual([]);
  });

  it("defaults to synthetic mode and requires an explicit live flag", async () => {
    const output = capture();
    const code = await runCli(
      [
        "query",
        "--carrier",
        "OOCL",
        "--origin",
        "Shanghai",
        "--origin-country",
        "CN",
        "--destination",
        "Toronto",
        "--destination-country",
        "CA",
        "--from",
        "2026-09-17",
        "--until",
        "2026-10-28",
      ],
      output.io,
    );
    const envelope = envelopeFrom(output.stdout);
    expect(code).toBe(4);
    expect(envelope.status).toBe("manual_review");
    expect(envelope.blockers[0]).toMatchObject({ code: "synthetic_data" });
    expect(output.stderr).toEqual([]);
  });

  it("fails closed for live mode while the target allowlist is empty", async () => {
    const output = capture();
    const code = await runCli(
      [
        "query",
        "--carrier",
        "OOCL",
        "--origin",
        "Shanghai",
        "--origin-country",
        "CN",
        "--destination",
        "Toronto",
        "--destination-country",
        "CA",
        "--from",
        "2026-09-17",
        "--until",
        "2026-10-28",
        "--mode",
        "live",
      ],
      output.io,
    );
    const envelope = envelopeFrom(output.stdout);
    expect(code).toBe(5);
    expect(envelope.status).toBe("blocked");
    expect(envelope.blockers[0]?.code).toBe("auth_required");
  });

  it("resolves CLI carrier aliases and reports missing adapters as unavailable", async () => {
    for (const alias of ["EMC", "MSK", "美森", "HAPAG"]) {
      const locations = capture();
      const locationsCode = await runCli(
        [
          "locations",
          "--carrier",
          alias,
          "--query",
          "Shanghai",
          "--mode",
          "live",
        ],
        locations.io,
      );
      const locationsEnvelope = envelopeFrom(locations.stdout);
      expect(locationsCode).toBe(6);
      expect(locationsEnvelope.status).toBe("unavailable");
      expect(locationsEnvelope.blockers[0]?.code).toBe("not_implemented");

      const query = capture();
      const queryCode = await runCli(
        [
          "query",
          "--carrier",
          alias,
          "--origin",
          "Shanghai",
          "--origin-country",
          "CN",
          "--destination",
          "Vancouver",
          "--destination-country",
          "CA",
          "--from",
          "2026-09-17",
          "--until",
          "2026-10-14",
          "--mode",
          "synthetic",
        ],
        query.io,
      );
      const queryEnvelope = envelopeFrom(query.stdout);
      expect(queryCode).toBe(6);
      expect(queryEnvelope.status).toBe("unavailable");
      expect(queryEnvelope.blockers[0]?.code).toBe("not_implemented");
    }
  });

  it("rejects unknown, duplicate, and conflicting flags with exit code 2", async () => {
    for (const argv of [
      ["carriers", "--unknown", "x"],
      ["carriers", "--mode", "synthetic", "--mode", "live"],
      [
        "query",
        "--carrier",
        "OOCL",
        "--origin",
        "Shanghai",
        "--origin-ref",
        "Shanghai",
        "--destination",
        "Toronto",
      ],
    ]) {
      const output = capture();
      const code = await runCli(argv, output.io);
      const envelope = envelopeFrom(output.stdout);
      expect(code).toBe(2);
      expect(envelope.status).toBe("needs_input");
    }
  });

  it("derives until from an explicit from date and accepts a carrier location id", async () => {
    const output = capture();
    const code = await runCli(
      [
        "query",
        "--carrier",
        "OOCL",
        "--origin",
        "ignored-text",
        "--origin-id",
        "synthetic-oocl-shanghai",
        "--origin-country",
        "CN",
        "--destination",
        "Toronto",
        "--destination-country",
        "CA",
        "--from",
        "2026-09-17",
        "--mode",
        "synthetic",
      ],
      output.io,
    );
    const envelope = envelopeFrom(output.stdout);
    const data = envelope.data as {
      readonly query: {
        readonly query_origin: { readonly carrier_location_id: string };
        readonly departure_from: string;
        readonly departure_until: string;
      };
    };
    expect(code).toBe(4);
    expect(data.query).toMatchObject({
      query_origin: {
        carrier_location_id: "synthetic-oocl-shanghai",
      },
      departure_from: "2026-09-17",
      departure_until: "2026-10-28",
    });
  });
});
