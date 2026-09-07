"""Bounded stdin/stdout bridge. No files, database, credentials, or network access."""
import json
import sys
from decimal import Decimal
from upstream.pallet_calculator import calculate_billing_pallets
from upstream.zone_pricing import calculate_zone_price


def calculate(data):
    config, request = data['config'], data['request']
    postal = request['postal_code'].replace(' ', '').replace('-', '').upper()
    matches = [z for z in config['zones'] if postal.startswith(z['postal_prefix'])]
    if not matches:
        return {'status': 'manual_review', 'reason_codes': ['postal_not_covered'], 'data': None}
    longest = max(len(z['postal_prefix']) for z in matches)
    matches = [z for z in matches if len(z['postal_prefix']) == longest]
    if len(matches) != 1:
        return {'status': 'manual_review', 'reason_codes': ['postal_zone_conflict'], 'data': None}
    zone = matches[0]
    cbm, weight = Decimal(request['cbm']), Decimal(request['weight_kg'])
    length = Decimal(request['longest_side_cm']) if request.get('longest_side_cm') else None
    if cbm <= 0 or weight <= 0 or length is None or length <= 0:
        return {'status': 'needs_input', 'reason_codes': ['cargo_measurements_required'], 'data': None}
    if cbm > Decimal(config['billing']['max_cbm']) or weight > Decimal(config['billing']['max_weight_kg']) or length > Decimal(config['billing']['max_length_cm']):
        return {'status': 'manual_review', 'reason_codes': ['cargo_outside_published_limits'], 'data': None}
    if request.get('province') and request['province'].upper() != zone['province']:
        return {'status': 'manual_review', 'reason_codes': ['postal_province_conflict'], 'data': None}
    pallets = calculate_billing_pallets(config=config['billing'], cbm=cbm, weight_kg=weight, piece_count=request['piece_count'], packaging_type=request['packaging_type'], longest_side_cm=length, explicit_pallet_count=request['explicit_pallet_count'], is_stackable=request['is_stackable'])
    if pallets.manual_review_required:
        return {'status': 'manual_review', 'reason_codes': list(pallets.risk_tags), 'data': None}
    rates = [r for r in config['rates'] if r['zone'] == zone['zone'] and r['pallets'] == pallets.billing_pallets]
    if len(rates) != 1:
        return {'status': 'manual_review', 'reason_codes': ['pallet_rate_not_configured'], 'data': None}
    base = Decimal(rates[0]['amount'])
    price = calculate_zone_price(config=config['fees'], base_price_usd=base, address_type=request['address_type'], requires_liftgate=request['requires_liftgate'], requires_pallet_jack=request['requires_pallet_jack'], requires_appointment=request['requires_appointment'], detention_minutes=request['detention_minutes'])
    return {'status': 'success', 'reason_codes': [], 'data': {
        'currency': 'USD', 'source_type': 'zone_matrix', 'confidence': 100,
        'postal_code': postal, 'postal_prefix': zone['postal_prefix'], 'preferred_city': zone['city'], 'city': zone['city'], 'province': zone['province'], 'origin': config['origin'], 'zone': zone['zone'], 'billing_pallets': pallets.billing_pallets, 'pallet_breakdown': pallets.components,
        'base_price': format(base, '.2f'), 'fuel': format(price.fuel_usd, '.2f'), 'accessorials': {k: format(v, '.2f') for k, v in price.accessorials.items()}, 'total_price': format(price.total_price_usd, '.2f'), 'risk_tags': [], 'manual_review_required': False,
        'matched_rule': config['label'], 'matched_by': 'published_postal_prefix', 'candidate_count': 1,
        'match_trace': {'evidence_ref': config['evidence_ref'], 'evidence_version': config['evidence_version'], 'valid_from': config['valid_from'], 'valid_until': config['valid_until'], 'postal_match': zone['postal_prefix'], 'billing': config['billing'], 'fees': config['fees']}, 'sales_note': config['customer_terms']}}


if __name__ == '__main__':
    try:
        payload = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
        if len(payload) > 16 * 1024 * 1024:
            raise ValueError('input too large')
        print(json.dumps(calculate(json.loads(payload)), ensure_ascii=False))
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason_codes': ['native_quote_failed'], 'data': None}))
