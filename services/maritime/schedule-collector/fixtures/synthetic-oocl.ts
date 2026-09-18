export const syntheticOoclLocationCandidates = {
  origin: [
    {
      name: "Shanghai",
      country_code: "CN",
      type: "city" as const,
      carrier_location_id: "synthetic-oocl-shanghai",
      mapping_source: "synthetic_fixture",
      source_full_name: null,
      unlocode: null,
    },
  ],
  destination: [
    {
      name: "Vancouver",
      country_code: "CA",
      type: "city" as const,
      carrier_location_id: "synthetic-oocl-vancouver-ca",
      mapping_source: "synthetic_fixture",
      source_full_name: null,
      unlocode: null,
    },
    {
      name: "Vancouver",
      country_code: "US",
      type: "city" as const,
      carrier_location_id: "synthetic-oocl-vancouver-us",
      mapping_source: "synthetic_fixture",
      source_full_name: null,
      unlocode: null,
    },
    {
      name: "Toronto",
      country_code: "CA",
      type: "city" as const,
      carrier_location_id: "synthetic-oocl-toronto-ca",
      mapping_source: "synthetic_fixture",
      source_full_name: null,
      unlocode: null,
    },
  ],
} as const;

export const syntheticOoclScheduleResponse = {
  success: true,
  errorInfo: null,
  errorInfoDTO: null,
  data: {
    numberOfRouteReturn: 1,
    nearby: false,
    standardRoutes: [
      {
        RouteId: "9000000001",
        TransitTimeInMinute: 1710,
        Routing: "transshipment",
        CargoCutoffLocalDateTime: {
          dateStr: "20260915120000.000",
        },
        CargoCutoffGmtDateTime: {
          dateStr: "20260915040000.000",
        },
        Legs: [
          {
            Type: "Voyage",
            LegId: "synthetic-leg-1",
            Service: "SYNTHETIC-A",
            LoadingPort: {
              ID: "synthetic-oocl-shanghai",
              Code: "CNSHA",
              Name: "Shanghai",
            },
            DischargePort: {
              ID: "synthetic-oocl-busan",
              Code: "KRPUS",
              Name: "Busan",
            },
            FromETDLocalDateTime: {
              dateStr: "20260918033000.000",
            },
            FromETDGmtDateTime: {
              dateStr: "20260917193000.000",
            },
            ToETALocalDateTime: {
              dateStr: "20260920093000.000",
            },
            ToETAGmtDateTime: {
              dateStr: "20260920003000.000",
            },
            OriginFacilityTimezoneName: "Asia/Shanghai",
            DestinationFacilityTimezoneName: "Asia/Seoul",
            VesselName: "SYNTHETIC VESSEL ONE",
            ExternalVoyageReference: "SYN001E",
          },
          {
            Type: "Voyage",
            LegId: "synthetic-leg-2",
            Service: "SYNTHETIC-B",
            LoadingPort: {
              ID: "synthetic-oocl-busan",
              Code: "KRPUS",
              Name: "Busan",
            },
            DischargePort: {
              ID: "synthetic-oocl-vancouver-ca",
              Code: "CAVAN",
              Name: "Vancouver",
            },
            FromETDLocalDateTime: {
              dateStr: "20260921110000.000",
            },
            FromETDGmtDateTime: {
              dateStr: "20260921020000.000",
            },
            ToETALocalDateTime: {
              dateStr: "20260930060000.000",
            },
            ToETAGmtDateTime: {
              dateStr: "20260930130000.000",
            },
            OriginFacilityTimezoneName: "Asia/Seoul",
            DestinationFacilityTimezoneName: "America/Vancouver",
            VesselName: "SYNTHETIC VESSEL TWO",
            ExternalVoyageReference: "SYN002S",
          },
          {
            Type: "InboundIntermodal",
            LegId: "synthetic-intermodal-1",
            OriginFacilityTimezoneName: "America/Vancouver",
            DestinationFacilityTimezoneName: "America/Toronto",
            LoadingPort: {
              ID: "synthetic-oocl-vancouver-ca",
              Code: "CAVAN",
              Name: "Vancouver",
            },
            DischargePort: {
              ID: "synthetic-oocl-toronto-ca",
              Code: "CATOR",
              Name: "Toronto",
            },
          },
        ],
      },
    ],
  },
} as const;
