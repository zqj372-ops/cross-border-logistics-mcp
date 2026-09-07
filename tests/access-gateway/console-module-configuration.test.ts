import {it,expect} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
it('uses only market modules for configuration and preserves legacy destinations',async()=>{
 const m=await import(pathToFileURL(resolve('apps/console/service-catalog.js')).href) as {marketServices:Array<{configuration?:unknown}>;configurationRoute:(hash:string)=>{kind?:string;service?:unknown};legacyConfigurationRoute:(id:string)=>string};
 expect(m.marketServices).toHaveLength(8);
 expect(m.configurationRoute('#configure/quote.zone_preview/pricing').kind).toBe('residential-rates');
 expect(m.configurationRoute('#configure/customs.query/tariffs').kind).toBe(m.configurationRoute('#configure/customs.tax.estimate/tariffs').kind);
 expect(m.configurationRoute('#configure/quote.freightcom_ltl.preview').kind).toBe('freightcom');
 expect(m.configurationRoute('#configure/cargo.calculate').kind).toBeUndefined();
 expect(m.configurationRoute('#configure/unknown').service).toBeUndefined();
 expect(m.legacyConfigurationRoute('residential-rates/pricing')).toBe('configure/quote.zone_preview/pricing');
 expect(m.legacyConfigurationRoute('')).toBe('market/configure');
 expect(m.marketServices.every((s:{configuration?:unknown})=>s.configuration)).toBe(true);
});
