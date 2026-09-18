export const syntheticCoscoLocationResponse = {
  code: "200",
  message: "",
  data: {
    content: [
      {
        cityUuid: "synthetic-cosco-shanghai",
        cityLocName: "Shanghai",
        fullFormate: "Shanghai,Shanghai,Shanghai,China",
        country: "China",
        unloCode: "CNSHA",
      },
      {
        cityUuid: "synthetic-cosco-vancouver-ca",
        cityLocName: "Vancouver",
        fullFormate: "Vancouver, ,BC,Canada",
        country: "Canada",
        unloCode: "CAVCR",
      },
      {
        cityUuid: "synthetic-cosco-vancouver-us",
        cityLocName: "Vancouver",
        fullFormate: "Vancouver,Clark,WA,United States",
        country: "United States",
        unloCode: "USVAN",
      },
    ],
  },
} as const;

export const syntheticCoscoScheduleResponse = {
  code: "200",
  message: null,
  data: {
    content: {
      conditions: {
        originCityUuid: "synthetic-cosco-shanghai",
        destinationCityUuid: "synthetic-cosco-vancouver-ca",
        originCity: "Shanghai,Shanghai,Shanghai,China,CNSHA",
        destinationCity: "Vancouver, ,BC,Canada,CAVCR",
      },
      data: [
        {
          id: "1",
          vessel: "XIN SHAN TOU",
          voyage: "225",
          extVoyage: "225N",
          service: "CPV",
          pol: "Shanghai",
          polPortCode: "SHA",
          polFacilityCode: "SHA08",
          pod: "Vancouver",
          podPortCode: "VAN",
          podFacilityCode: "VAN02",
          etd: "2026-09-20 07:00",
          eta: "2026-10-02 12:00",
          atd: null,
          ata: null,
          transitTime: "12",
          dir: "N",
          outboundHaulage: "CY/DOOR",
          inboundHaulage: "CY/DOOR",
          outboundTotalTransportModes: "Truck",
          inboundTotalTransportModes: "Truck",
          cutOff: "2026-09-16 12:00",
          siCutoff: null,
          vgmCutoffDt: null,
          r24Cutoff: null,
          available: "2026-10-05 06:00",
          cargoNature: "GC,RF",
          legSequence: 1,
          deList1: [],
          deList2: [],
        },
      ],
    },
  },
} as const;
