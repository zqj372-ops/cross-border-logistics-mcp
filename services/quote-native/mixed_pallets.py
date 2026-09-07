"""Native mixed-cargo adaptation; frozen upstream formulas remain unchanged."""
from decimal import Decimal
from math import ceil
from upstream.pallet_calculator import PalletCalculationResult


def calculate_mixed_pallets(config, request, rows):
    volume = max(1, ceil(Decimal(request['cbm']) / Decimal(config['cbm_per_pallet'])))
    weight = max(1, ceil(Decimal(request['weight_kg']) / Decimal(config['kg_per_pallet'])))
    long_pallets = 0
    crate_pallets = 0
    short_crates = 0
    bag_count = 0
    for row in rows:
        q = row['quantity']
        length = max(Decimal(row[k]) for k in ['length_cm', 'width_cm', 'height_cm'])
        is_long = length >= Decimal(config['long_piece_threshold_cm'])
        if is_long:
            long_pallets += q * config['long_piece_multiplier']
        if row['packaging_type'] == 'crate':
            crate_pallets += q * (config['long_piece_multiplier'] if is_long else 1)
            if not is_long:
                short_crates += q
        if row['packaging_type'] == 'bag':
            bag_count += q
    explicit = request.get('explicit_pallet_count') or 0
    components = {'volume_pallets': volume, 'weight_pallets': weight,
                  'long_piece_pallets': long_pallets, 'wooden_crate_pallets': crate_pallets,
                  'explicit_pallet_count': explicit, 'special_pallets': long_pallets + short_crates}
    if bag_count >= config['flexible_packaging_threshold'] and request.get('is_stackable'):
        return PalletCalculationResult(None, components, True, ('flat_rate_packaging_required',))
    if long_pallets > max(config['suspicious_min_pallets'], max(volume, weight, explicit) * config['suspicious_multiplier']):
        return PalletCalculationResult(None, components, True, ('long_piece_count_suspicious',))
    return PalletCalculationResult(max(components.values()), components)
