"""Convert an operator-exported live config snapshot; never connect or publish."""
import argparse,json,hashlib,decimal,datetime
from pathlib import Path
def require(condition,message):
 if not condition: raise ValueError(message)
def money(value):
 number=decimal.Decimal(str(value))
 require(number.is_finite() and number>=0 and number==number.quantize(decimal.Decimal('0.01')), 'Source money must be nonnegative exact cents')
 return format(number,'.2f')
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--directory',type=Path,required=True);parser.add_argument('--valid-from',required=True);parser.add_argument('--valid-until',required=True);args=parser.parse_args();start=datetime.date.fromisoformat(args.valid_from);end=datetime.date.fromisoformat(args.valid_until);require(start<=end, 'Invalid effective date range')
root=args.directory;raw=json.loads((root/'online-quote-config-source.json').read_text());effective=json.loads((root/'online-quote-effective.json').read_text());pricing=effective['config']['zone_pricing'];template=effective['config']['copy_template']
require(effective['pallet_source_sha256']==json.loads((Path(__file__).resolve().parents[2]/'services/quote-native/provenance.json').read_text())['files'][0]['source_sha256'], 'Source pallet rules differ; review before importing')
profiles=[];notes=[]
for origin in sorted({r['origin'] for r in raw['data']['zone_price_matrix']}):
 rates=[{'zone':r['zone'],'pallets':r['billing_pallets'],'amount':money(r['base_price_usd'])} for r in raw['data']['zone_price_matrix'] if r['origin']==origin]
 zones=[];by_city={}
 for r in raw['data']['zone_lookup_rules']:
  if r['origin']!=origin or not r['active']:continue
  city=' '.join((r['canonical_city'] or r['city']).split()).upper()
  zones.append({'postal_prefix':r['postal_prefix'],'city':city,'province':r['province'],'zone':r['zone']})
  by_city.setdefault((r['postal_prefix'],city,r['province']),set()).add(r['zone'])
 for (prefix,city,province),values in by_city.items():
  if len(values)>1:notes.append({'origin':origin,'postal_prefix':prefix,'city':city,'province':province,'zones':sorted(values),'behavior':'manual_review'})
 controls=[]
 for zone in sorted({r['zone'] for r in rates}|{r['zone'] for r in zones}):
  key=f'{origin}|{zone}';enabled=pricing['zone_price_enabled'] and pricing['zone_price_enabled_by_zone'].get(key,pricing['max_auto_quote_zone'] is None or zone<=pricing['max_auto_quote_zone']);fuel=pricing['fuel_percent_by_zone'].get(key)
  controls.append({'zone':zone,'enabled':enabled,'fuel_percent':str(fuel) if fuel is not None else None})
 profiles.append({'origin':origin,'zones':zones,'rates':rates,'zone_controls_v1':controls})
primary=next(p for p in profiles if p['origin']=='toronto');other=[p for p in profiles if p is not primary]
terms='包含：'+ '；'.join(template['included_items'])+'。不含：'+'；'.join(template['excluded_items'])+'。'+template['remark']
config={'label':'线上私人地址运价迁移 · Toronto / Calgary','currency':'USD','origin':primary['origin'],'valid_from':start.isoformat(),'valid_until':end.isoformat(),'evidence_ref':raw['source'],'evidence_version':hashlib.sha256((root/'online-quote-config-source.json').read_bytes()).hexdigest(),'customer_terms':terms,'zones':primary['zones'],'rates':primary['rates'],'extensions':{'postal_city_v1':True,'zone_controls_v1':primary['zone_controls_v1'],'origins_v1':other,'quote_valid_days_v1':template['valid_days']},'billing':{'cbm_per_pallet':'2','kg_per_pallet':'500','long_piece_threshold_cm':'240','long_piece_multiplier':2,'flexible_packaging_threshold':50,'suspicious_min_pallets':50,'suspicious_multiplier':10,'max_weight_kg':None,'max_cbm':None,'max_length_cm':None},'fees':{'fuel_percent':str(pricing['fuel_percent']),'residential':money(pricing['residential_fee_usd']),'liftgate':money(pricing['liftgate_fee_usd']),'pallet_jack':money(pricing['pallet_jack_fee_usd']),'appointment':money(pricing['appointment_fee_usd']),'detention_free_minutes':pricing['detention_free_minutes'],'detention_half_hour':money(pricing['detention_half_hour_fee_usd'])}}
require(not json.loads((root/'online-city-aliases.json').read_text()), 'City aliases require explicit review')
require(not raw['data']['postal_zone_overrides'], 'Postal overrides require explicit review')
require(sum(len(p['zones']) for p in profiles)==sum(bool(r['active']) for r in raw['data']['zone_lookup_rules']), 'Active rules were omitted')
(root/'online-residential-save.json').write_text(json.dumps({'expected_version':0,'input':config},ensure_ascii=False,indent=2));(root/'online-residential-save.json').chmod(0o600)
summary={'sources':[{k:p[k] for k in ['origin']}|{'rates':len(p['rates']),'postal_city_rows':len(p['zones']),'unique_postal_prefixes':len({z['postal_prefix'] for z in p['zones']})} for p in profiles],'quote_valid_days':template['valid_days'],'valid_until':config['valid_until'],'same_city_conflicts_preserved':notes,'active_source_rows':sum(bool(r['active']) for r in raw['data']['zone_lookup_rules']),'inactive_source_rows':sum(not r['active'] for r in raw['data']['zone_lookup_rules']),'snapshot_sha256':config['evidence_version'],'source_read_only':True,'production_published':False}
(root/'online-rate-migration-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary,ensure_ascii=False))
