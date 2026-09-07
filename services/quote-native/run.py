"""Bounded stdin/stdout bridge. No files, database, credentials, or network access."""
import json
import sys
from decimal import Decimal
from upstream.pallet_calculator import calculate_billing_pallets
from mixed_pallets import calculate_mixed_pallets
from upstream.zone_pricing import calculate_zone_price


def calculate(data):
    config, request = data['config'], data['request']
    quote_valid_days = config.get('extensions', {}).get('quote_valid_days_v1')
    postal = request['postal_code'].replace(' ', '').replace('-', '').upper()
    profiles = [dict(origin=config['origin'], zones=config['zones'], rates=config['rates'], zone_controls_v1=config.get('extensions', {}).get('zone_controls_v1', []))] + config.get('extensions', {}).get('origins_v1', [])
    requested_origin = request.get('extensions', {}).get('origin_v1')
    candidates = [(p, z) for p in profiles for z in p['zones'] if postal.startswith(z['postal_prefix']) and (not requested_origin or p['origin'] == requested_origin)]
    if candidates:
        longest_prefix = max(len(z['postal_prefix']) for _, z in candidates)
        origins = {p['origin'] for p, z in candidates if len(z['postal_prefix']) == longest_prefix}
        if len(origins) != 1:
            return {'status': 'needs_input', 'reason_codes': ['quote_origin_required'], 'data': None}
        selected = next(p for p, _ in candidates if p['origin'] in origins)
        config = dict(config, origin=selected['origin'], zones=selected['zones'], rates=selected['rates'], extensions={'zone_controls_v1': selected['zone_controls_v1']})
    elif requested_origin:
        return {'status': 'manual_review', 'reason_codes': ['origin_postal_not_covered'], 'data': None}
    matches = [z for z in config['zones'] if postal.startswith(z['postal_prefix'])]
    if not matches:
        return {'status': 'manual_review', 'reason_codes': ['postal_not_covered'], 'data': None}
    longest = max(len(z['postal_prefix']) for z in matches)
    matches = [z for z in matches if len(z['postal_prefix']) == longest]
    if len(matches) != 1:
        return {'status': 'manual_review', 'reason_codes': ['postal_zone_conflict'], 'data': None}
    zone = matches[0]
    controls = [c for c in config.get('extensions', {}).get('zone_controls_v1', []) if c['zone'] == zone['zone']]
    if len(controls) > 1:
        return {'status': 'manual_review', 'reason_codes': ['zone_control_conflict'], 'data': None}
    control = controls[0] if controls else None
    if control and not control['enabled']:
        return {'status': 'manual_review', 'reason_codes': ['zone_disabled'], 'data': None}
    fees = dict(config['fees'])
    if control and control['fuel_percent'] is not None:
        fees['fuel_percent'] = control['fuel_percent']
    cbm, weight = Decimal(request['cbm']), Decimal(request['weight_kg'])
    length = Decimal(request['longest_side_cm']) if request.get('longest_side_cm') else None
    if cbm <= 0 or weight <= 0 or length is None or length <= 0:
        return {'status': 'needs_input', 'reason_codes': ['cargo_measurements_required'], 'data': None}
    if any(config['billing'][key] is not None and value > Decimal(config['billing'][key]) for key, value in [('max_cbm', cbm), ('max_weight_kg', weight), ('max_length_cm', length)]):
        return {'status': 'manual_review', 'reason_codes': ['cargo_outside_published_limits'], 'data': None}
    if request.get('province') and request['province'].upper() != zone['province']:
        return {'status': 'manual_review', 'reason_codes': ['postal_province_conflict'], 'data': None}
    rows = request.get('extensions', {}).get('cargo_lines_v1')
    if not rows and request['piece_count'] > 1 and length >= Decimal(config['billing']['long_piece_threshold_cm']):
        return {'status': 'needs_input', 'reason_codes': ['cargo_item_details_required'], 'data': None}
    pallets = calculate_mixed_pallets(config['billing'], request, rows) if rows else calculate_billing_pallets(config=config['billing'], cbm=cbm, weight_kg=weight, piece_count=request['piece_count'], packaging_type=request['packaging_type'], longest_side_cm=length, explicit_pallet_count=request['explicit_pallet_count'], is_stackable=request['is_stackable'])
    if pallets.manual_review_required:
        return {'status': 'manual_review', 'reason_codes': list(pallets.risk_tags), 'data': None}
    rates = [r for r in config['rates'] if r['zone'] == zone['zone'] and r['pallets'] == pallets.billing_pallets]
    if len(rates) != 1:
        return {'status': 'manual_review', 'reason_codes': ['pallet_rate_not_configured'], 'data': None}
    base = Decimal(rates[0]['amount'])
    price = calculate_zone_price(config=fees, base_price_usd=base, address_type=request['address_type'], requires_liftgate=request['requires_liftgate'], requires_pallet_jack=request['requires_pallet_jack'], requires_appointment=request['requires_appointment'], detention_minutes=request['detention_minutes'])
    return {'status': 'success', 'reason_codes': [], 'data': {
        'currency': 'USD', 'source_type': 'zone_matrix', 'confidence': 100,
        'postal_code': postal, 'postal_prefix': zone['postal_prefix'], 'preferred_city': zone['city'], 'city': zone['city'], 'province': zone['province'], 'origin': config['origin'], 'zone': zone['zone'], 'billing_pallets': pallets.billing_pallets, 'pallet_breakdown': pallets.components,
        'base_price': format(base, '.2f'), 'fuel': format(price.fuel_usd, '.2f'), 'accessorials': {k: format(v, '.2f') for k, v in price.accessorials.items()}, 'total_price': format(price.total_price_usd, '.2f'), 'risk_tags': [], 'manual_review_required': False,
        'matched_rule': config['label'], 'matched_by': 'published_postal_prefix', 'candidate_count': 1,
        'match_trace': {'evidence_ref': config['evidence_ref'], 'evidence_version': config['evidence_version'], 'valid_from': config['valid_from'], 'valid_until': config['valid_until'], 'quote_valid_days': quote_valid_days, 'postal_match': zone['postal_prefix'], 'billing': config['billing'], 'cargo_lines': rows, 'calculation_version': 'native-mixed-cargo-v1', 'fees': fees, 'zone_control': control}, 'sales_note': config['customer_terms']}}


if __name__ == '__main__':
    try:
        payload = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
        if len(payload) > 16 * 1024 * 1024:
            raise ValueError('input too large')
        print(json.dumps(calculate(json.loads(payload)), ensure_ascii=False))
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason_codes': ['native_quote_failed'], 'data': None}))
