import { describe, expect, it } from "vitest";

import { suggestFreightClass } from "../../../apps/freightcom-quote/freight-class.mjs";

describe("Freightcom LTL density freight class suggestion", () => {
  it("calculates the official density example without floating-point arithmetic", () => {
    expect(suggestFreightClass({
      weightValue: "450",
      weightUnit: "lb",
      length: "48",
      width: "40",
      height: "45",
      dimensionUnit: "in",
    })).toEqual({
      densityPcf: "9.00",
      suggestedClass: "100",
      ruleVersion: "nmfta-fcdc-full-density-scale@2025-07-19",
    });
  });

  it("supports metric pallet measurements", () => {
    expect(suggestFreightClass({
      weightValue: "100",
      weightUnit: "kg",
      length: "120",
      width: "100",
      height: "130",
      dimensionUnit: "cm",
    })).toEqual({
      densityPcf: "4.00",
      suggestedClass: "175",
      ruleVersion: "nmfta-fcdc-full-density-scale@2025-07-19",
    });
  });

  it.each([
    ["0.99", "400"], ["1", "300"], ["2", "250"], ["4", "175"],
    ["6", "125"], ["8", "100"], ["10", "92.5"], ["12", "85"],
    ["15", "70"], ["22.5", "65"], ["30", "60"], ["35", "55"], ["50", "50"],
  ])("maps %s pcf to class %s", (density, expectedClass) => {
    expect(suggestFreightClass({
      weightValue: density,
      weightUnit: "lb",
      length: "12",
      width: "12",
      height: "12",
      dimensionUnit: "in",
    })?.suggestedClass).toBe(expectedClass);
  });

  it("does not guess when a measurement is missing or invalid", () => {
    expect(suggestFreightClass({
      weightValue: "",
      weightUnit: "kg",
      length: "120",
      width: "100",
      height: "130",
      dimensionUnit: "cm",
    })).toBeNull();
    expect(suggestFreightClass({
      weightValue: "100",
      weightUnit: "stone",
      length: "120",
      width: "100",
      height: "130",
      dimensionUnit: "cm",
    })).toBeNull();
  });
});
