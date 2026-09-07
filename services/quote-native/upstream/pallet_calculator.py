from dataclasses import dataclass
from decimal import Decimal
from math import ceil


FLEXIBLE_PACKAGING = {"编织袋", "柔性包装", "woven bag", "flexible packaging", "bag"}
WOODEN_CRATE = {"木箱", "crate", "wooden crate"}


@dataclass(frozen=True)
class PalletCalculationResult:
    billing_pallets: int | None
    components: dict[str, int]
    manual_review_required: bool = False
    risk_tags: tuple[str, ...] = ()
    internal_note: str | None = None


def calculate_billing_pallets(
    *,
    config: dict,
    cbm: Decimal,
    weight_kg: Decimal,
    piece_count: int,
    packaging_type: str,
    longest_side_cm: Decimal | None = None,
    explicit_pallet_count: int | None = None,
    is_stackable: bool | None = None,
) -> PalletCalculationResult:
    packaging = packaging_type.strip().lower()
    if packaging in FLEXIBLE_PACKAGING and piece_count >= config["flexible_packaging_threshold"] and is_stackable:
        return PalletCalculationResult(
            billing_pallets=None,
            components={},
            manual_review_required=True,
            risk_tags=("flat_rate_packaging_required",),
            internal_note="Flexible packaging flat-rate mode needs configured package pricing.",
        )

    volume_pallets = max(1, ceil(cbm / Decimal(config["cbm_per_pallet"]))) if cbm > 0 else 0
    weight_pallets = max(1, ceil(weight_kg / Decimal(config["kg_per_pallet"]))) if weight_kg > 0 else 0
    is_long_piece = bool(
        longest_side_cm is not None and longest_side_cm >= Decimal(config["long_piece_threshold_cm"])
    )
    long_piece_pallets = piece_count * config["long_piece_multiplier"] if is_long_piece else 0

    wooden_crate_pallets = 0
    if packaging in WOODEN_CRATE:
        wooden_crate_pallets = piece_count * config["long_piece_multiplier"] if is_long_piece else piece_count

    explicit = explicit_pallet_count or 0
    normal_basis_pallets = max(volume_pallets, weight_pallets, explicit)
    components = {
        "volume_pallets": volume_pallets,
        "weight_pallets": weight_pallets,
        "long_piece_pallets": long_piece_pallets,
        "wooden_crate_pallets": wooden_crate_pallets,
        "explicit_pallet_count": explicit,
    }
    if _is_suspicious_long_piece_count(long_piece_pallets, normal_basis_pallets, config):
        components["normal_basis_pallets"] = normal_basis_pallets
        return PalletCalculationResult(
            billing_pallets=None,
            components=components,
            manual_review_required=True,
            risk_tags=("long_piece_count_suspicious",),
            internal_note=(
                f"超长件数量/件数异常：最长边 {longest_side_cm} cm、件数 {piece_count} "
                f"会推导 {long_piece_pallets} 托，需人工确认实际件数或显式托数。"
            ),
        )

    billing_pallets = max(components.values())
    if billing_pallets <= 0:
        return PalletCalculationResult(
            billing_pallets=None,
            components=components,
            manual_review_required=True,
            risk_tags=("missing_billable_pallet_basis",),
            internal_note="CBM, weight, or explicit pallet count is required to calculate billing pallets.",
        )

    return PalletCalculationResult(billing_pallets=billing_pallets, components=components)


def _is_suspicious_long_piece_count(long_piece_pallets: int, normal_basis_pallets: int, config: dict) -> bool:
    if long_piece_pallets <= 0:
        return False
    threshold = max(
        config["suspicious_min_pallets"],
        normal_basis_pallets * config["suspicious_multiplier"],
    )
    return long_piece_pallets > threshold
