import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schemaDirectory=fileURLToPath(new URL("../../schemas/access-gateway/",import.meta.url));
const fixtureDirectory=fileURLToPath(new URL("./fixtures/",import.meta.url));
const schema=(name:string)=>JSON.parse(readFileSync(join(schemaDirectory,name),"utf8")) as object;

describe("Business REST v2 executable contracts",()=>{
  it("accepts each closed request shape and rejects unknown nested input",()=>{
    const validate=new Ajv2020({strict:true,allErrors:true}).compile(schema("business-call-request.schema.json"));
    const inputs=[
      {query:"cotton shirt",ruleDate:"2026-09-05",attributes:{originCountry:"CN"}},
      {lineId:"line-1",ruleDate:"2026-09-05",hsCode:"610910",destinationCountry:"CA",declaredValue:"100.00",currency:"CAD",attributes:{originCountry:"CN"}},
      {ruleDate:"2026-09-05",items:[{lineId:"line-1",attributes:{originCountry:"CN"}}]},
      {postal_code:"M5V3A8",cbm:"1.20",weight_kg:"200",piece_count:2,packaging_type:"carton",address_type:"commercial",requires_liftgate:false,requires_pallet_jack:false,requires_appointment:false,explicit_pallet_count:null,is_stackable:null,detention_minutes:0},
      {customer_message:"Two cartons to Toronto"},
      {details:{origin:{address:{address_line_1:"10 Origin Rd",city:"Toronto",region:"ON",country:"CA",postal_code:"M5V 2T6"}},destination:{address:{address_line_1:"20 Destination Ave",city:"Vancouver",region:"BC",country:"CA",postal_code:"V6B 1A1"},ready_at:{hour:9,minute:0},ready_until:{hour:16,minute:0},signature_requirement:"not-required"},expected_ship_date:{year:2026,month:9,day:8},packaging_type:"pallet",packaging_properties:{pallet_type:"ltl",has_stackable_pallets:false,pallets:[{measurements:{weight:{unit:"lb",value:"500"},cuboid:{unit:"in",l:"48",w:"40",h:"50"}},description:"machine parts",freight_class:"70",num_pieces:1}],pallet_service_details:{}},shipment_classification:"B2B"}},
    ];
    for(const input of inputs)expect(validate({schema_version:"business-call@2026-09-05.v1",input}),JSON.stringify(validate.errors)).toBe(true);
    expect(validate({schema_version:"business-call@2026-09-05.v1",input:{query:"shirt",ruleDate:"2026-09-05",attributes:{originCountry:"CN",tenant_id:"spoof"}}})).toBe(false);
  });

  it("accepts a closed Freightcom evidence result and rejects claims that it was saved or booked",()=>{
    const validate=new Ajv2020({strict:true,allErrors:true}).compile(schema("business-call-response.schema.json"));
    const response={schema_version:"portal-freightcom-rate@2026-09-05.v1",status:"success",data:{provider:"freightcom",api_version:"2.10.0",environment:"production",read_only:true,rate_request_ref:`freightcom-rate:${"a".repeat(64)}`,request_status:{done:true,total:1,complete:1},rates:[{carrier_name:"Carrier",service_name:"LTL",service_id:"ltl",valid_until:"2026-09-08",total:{currency:"CAD",minor_value:"12345",amount:"123.45"},base:{currency:"CAD",minor_value:"10000",amount:"100.00"},surcharges:[{type:"fuel",amount:{currency:"CAD",minor_value:"2000",amount:"20.00"}}],taxes:[{type:"HST",amount:{currency:"CAD",minor_value:"345",amount:"3.45"}}],transit_time_days:4,transit_time_not_available:null,transit_time_hours:null,carrier_cut_off_time:null,estimated_delivery_time:null,truck_details_ftl:null,transit_mode_ftl:null,paperless:false,customs_charge_data:null}],provider_quote_authoritative:true},reason_codes:[],source_refs:[{source_id:`src:freightcom:production:${"b".repeat(64)}`,source_type:"official_source",system:"Freightcom Customer API",locator:`opaque://freightcom/production/rate/${"c".repeat(64)}`,version:"freightcom-api@2.10.0",retrieved_at:"2026-09-05T12:00:00.000Z",authority:"authoritative",content_hash:`sha256:${"d".repeat(64)}`}],request_id:"req_freightcom_contract_1",saved:false,sendable:false,bookable:false};
    expect(validate(response),JSON.stringify(validate.errors)).toBe(true);
    expect(validate({...response,saved:true})).toBe(false);
    expect(validate({...response,bookable:true})).toBe(false);
  });

  it("accepts the complete tax source projection and rejects nested response extras",()=>{
    const validate=new Ajv2020({strict:true,allErrors:true}).compile(schema("business-call-response.schema.json"));
    const data=JSON.parse(readFileSync(join(fixtureDirectory,"riskcustoms-tariff-estimate-success.json"),"utf8")) as Record<string,unknown>;
    const response={schema_version:"portal-tax@2026-09-05.v1",status:"success",data,reason_codes:[],request_id:data.requestId};
    expect(validate(response),JSON.stringify(validate.errors)).toBe(true);
    const polluted=structuredClone(response) as typeof response & {data:Record<string,unknown>};
    polluted.data.delegatedActor={...(polluted.data.delegatedActor as object),api_key:"secret"};
    expect(validate(polluted)).toBe(false);
    expect(validate({schema_version:"portal-business@2026-09-05.v1",status:"unavailable",data:null,reason_codes:["business_client_unconfigured"]})).toBe(true);
  });
});
