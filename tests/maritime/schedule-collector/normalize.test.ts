import { describe, expect, it } from "vitest";

import {
  defaultDateWindow,
  decimalMinutesToHours,
  eventFromCompactTimes,
  parseCompactDateTime,
  routingFromLegs,
} from "../../../services/maritime/schedule-collector/normalize";

describe("schedule collector normalization", () => {
  it("converts minute values without treating base-60 remainders as decimal digits", () => {
    expect(decimalMinutesToHours(90)).toBe("1.5");
    expect(decimalMinutesToHours(75)).toBe("1.25");
    expect(decimalMinutesToHours(1)).toBe("0.016667");
    expect(decimalMinutesToHours(null)).toBeNull();
  });

  it("derives the default inclusive window in an explicit timezone", () => {
    const window = defaultDateWindow(
      { now: () => new Date("2026-09-16T16:30:00Z") },
      "Asia/Shanghai",
      42,
    );
    expect(window).toEqual({
      from: "2026-09-17",
      until: "2026-10-28",
    });
  });

  it("keeps local and source-UTC values without inventing an offset", () => {
    expect(parseCompactDateTime("20260230033000.000")).toBeNull();
    expect(
      eventFromCompactTimes({
        eventType: "departure",
        rawText: "20260918033000.000",
        localValue: "20260918033000.000",
        utcValue: "20260917193000.000",
        timezone: "Asia/Shanghai",
        eventKind: "estimated",
        timezoneSource: "oocl_leg_timezone",
      }),
    ).toMatchObject({
      local_date: "2026-09-18",
      local_datetime: "2026-09-18T03:30:00.000",
      utc_datetime: "2026-09-17T19:30:00.000Z",
      offset: null,
      precision: "local_datetime",
    });
    expect(
      eventFromCompactTimes({
        eventType: "arrival",
        rawText: "source",
        localValue: null,
        utcValue: "20260917193000.000",
        timezone: null,
        eventKind: "estimated",
        timezoneSource: "oocl_gmt_datetime",
      }),
    ).toMatchObject({
      local_date: null,
      local_datetime: null,
      utc_datetime: "2026-09-17T19:30:00.000Z",
      precision: "utc_datetime",
    });
  });

  it("does not infer direction from leg count alone", () => {
    expect(routingFromLegs(undefined, [{ mode: "ocean" }, { mode: "rail" }])).toBe(
      "unknown",
    );
    expect(routingFromLegs("direct", [{ mode: "ocean" }])).toBe("direct");
    expect(
      routingFromLegs("transshipment", [{ mode: "ocean" }, { mode: "ocean" }]),
    ).toBe("transshipment");
  });
});
