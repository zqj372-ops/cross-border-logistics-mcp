import { describe, expect, it } from "vitest";

import { buildFreightcomRequest, formatDisplayMoney, type QuoteFormValues } from "../../../apps/freightcom-quote/form-model.mjs";
import { freightcomRateRequestSchema } from "../../../src/logistics_mcp/adapters/quote/freightcom-rate-adapter";

function validForm(): QuoteFormValues {
  return {
    services: "apex.standard, fedex.freight",
    excludedServices: "",
    expectedShipDate: "2026-08-27",
    origin: {
      name: "JHT Warehouse",
      address_line_1: "100 Origin Street",
      address_line_2: "Dock 2",
      unit_number: "A",
      city: "Toronto",
      region: "ON",
      country: "CA",
      postal_code: "M1M 1M1",
      residential: false,
      tailgate_required: true,
      instructions: "Call before arrival",
      contact_name: "Origin Contact",
      phone_number: "4165550100",
      phone_extension: "12",
      email_addresses: "origin@example.com",
      receives_email_updates: true,
    },
    destination: {
      name: "Customer Dock",
      address_line_1: "200 Destination Avenue",
      address_line_2: "",
      unit_number: "",
      city: "Chicago",
      region: "IL",
      country: "US",
      postal_code: "60601",
      residential: false,
      tailgate_required: false,
      instructions: "Deliver to receiving",
      contact_name: "Destination Contact",
      phone_number: "3125550100",
      phone_extension: "",
      email_addresses: "destination@example.com",
      receives_email_updates: true,
      readyAt: "09:00",
      readyUntil: "17:30",
      signatureRequirement: "required",
    },
    pallet: {
      hasStackablePallets: true,
      dangerousGoods: "fully-regulated",
      dangerousGoodsDetails: {
        packaging_group: "III",
        goods_class: "3",
        description: "Regulated liquid",
        united_nations_number: "UN1993",
        emergency_contact_name: "Safety Contact",
        emergency_contact_number: "4165550199",
        emergency_contact_extension: "8",
      },
      limitedAccessDeliveryType: "other",
      limitedAccessDeliveryOtherName: "Private terminal",
      inBond: true,
      inBondType: "transportation-and-exportation",
      inBondName: "Bond Warehouse",
      inBondAddress: "300 Bond Road, Chicago, IL",
      inBondContactMethod: "phone-number",
      inBondContactPhone: "3125550198",
      inBondContactExtension: "9",
      appointmentDelivery: true,
      protectFromFreeze: true,
      thresholdPickup: false,
      thresholdDelivery: true,
      amazonOrFbaDelivery: true,
      fbaNumber: "FBA123456",
      orderId: "ORDER-123",
      pallets: [
        {
          weightValue: "100",
          weightUnit: "lb",
          length: "48.125",
          width: "40",
          height: "52",
          dimensionUnit: "in",
          description: "Industrial parts",
          freightClass: "70",
          nmfc: "12345",
          contentsType: "machinery",
          numPieces: "4",
        },
      ],
    },
    advanced: {
      insuranceType: "carrier",
      insuranceValue: "125.50",
      insuranceCurrency: "USD",
      referenceCodes: "PO-123\nREF-456",
      shipmentClassification: "B2B",
    },
  };
}

describe("Freightcom quote form model", () => {
  it("maps the complete documented LTL pallet form into the closed request schema", () => {
    const result = buildFreightcomRequest(validForm());

    expect(result.errors).toEqual([]);
    expect(freightcomRateRequestSchema.safeParse(result.request).success).toBe(true);
    expect(result.request).toMatchObject({
      services: ["apex.standard", "fedex.freight"],
      details: {
        expected_ship_date: { year: 2026, month: 8, day: 27 },
        packaging_type: "pallet",
        packaging_properties: {
          pallet_type: "ltl",
          pallets: [{
            measurements: {
              weight: { unit: "lb", value: "100" },
              cuboid: { unit: "in", l: "48.125", w: "40", h: "52" },
            },
          }],
          dangerous_goods: "fully-regulated",
          dangerous_goods_details: {
            united_nations_number: "UN1993",
          },
          pallet_service_details: {
            limited_access_delivery_type: "other",
            limited_access_delivery_other_name: "Private terminal",
            in_bond_details: {
              contact_method: "phone-number",
            },
            amazon_or_fba_delivery_details: {
              fba_number: "FBA123456",
            },
          },
        },
        insurance: {
          type: "carrier",
          total_cost: { value: "12550", currency: "USD" },
        },
        reference_codes: ["PO-123", "REF-456"],
        shipment_classification: "B2B",
      },
    });
  });

  it("requires conditional dangerous-goods and service details", () => {
    const form = validForm();
    form.pallet.dangerousGoodsDetails = undefined;
    form.pallet.inBondName = "";
    const result = buildFreightcomRequest(form);

    expect(result.request).toBeNull();
    expect(result.errors.map((error: { field: string }) => error.field)).toEqual([
      "pallet.dangerousGoodsDetails",
      "pallet.inBondName",
    ]);
  });

  it("does not silently drop child fields when their parent option is disabled", () => {
    const form = validForm();
    form.pallet.inBond = false;
    form.pallet.inBondName = "Bond Warehouse";
    form.pallet.amazonOrFbaDelivery = false;
    form.pallet.fbaNumber = "FBA123456";
    const result = buildFreightcomRequest(form);

    expect(result.request).toBeNull();
    expect(result.errors.map((error: { field: string }) => error.field)).toEqual([
      "pallet.inBond",
      "pallet.amazonOrFbaDelivery",
    ]);
  });

  it("relabels CAD as USD without changing the numeric amount or applying FX", () => {
    expect(formatDisplayMoney({ value: "17936", currency: "CAD" })).toEqual({
      amount: "179.36",
      displayCurrency: "USD",
      sourceCurrency: "CAD",
      conversionApplied: false,
      relabelApplied: true,
      available: true,
    });
    expect(formatDisplayMoney({ value: "21939", currency: "USD" })).toEqual({
      amount: "219.39",
      displayCurrency: "USD",
      sourceCurrency: "USD",
      conversionApplied: false,
      relabelApplied: false,
      available: true,
    });
  });

  it("does not relabel unsupported source currencies as USD", () => {
    expect(formatDisplayMoney({ value: "10000", currency: "EUR" })).toEqual({
      amount: "—",
      displayCurrency: "USD",
      sourceCurrency: "EUR",
      conversionApplied: false,
      relabelApplied: false,
      available: false,
    });
  });

  it("maps the four portal location types to the external API address flags", () => {
    const form = validForm();
    form.origin.locationType = "commercial-no-tailgate";
    form.destination.locationType = "residential-tailgate";

    const result = buildFreightcomRequest(form);

    expect(result.errors).toEqual([]);
    expect(result.request).toMatchObject({
      details: {
        origin: { residential: false, tailgate_required: false },
        destination: { residential: true, tailgate_required: true },
      },
    });
  });

  it("rejects an unknown location type instead of guessing accessorial flags", () => {
    const form = validForm();
    form.destination.locationType = "warehouse";

    const result = buildFreightcomRequest(form);

    expect(result.request).toBeNull();
    expect(result.errors).toContainEqual({
      field: "destination.locationType",
      message: "请选择有效的地点类型。",
    });
  });
});
