from dataclasses import dataclass
from decimal import Decimal
from math import ceil

from decimal import ROUND_HALF_UP

def money(value):
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class ZonePricingResult:
    fuel_usd: Decimal
    accessorials: dict[str, Decimal]
    total_price_usd: Decimal


def calculate_zone_price(
    *,
    base_price_usd: Decimal,
    address_type: str,
    origin: str | None = None,
    zone: int | None = None,
    requires_liftgate: bool = False,
    requires_pallet_jack: bool = False,
    requires_appointment: bool = False,
    detention_minutes: int = 0,
    config: dict,
) -> ZonePricingResult:
    pricing_config = config
    fuel_percent = Decimal(pricing_config["fuel_percent"])
    fuel_usd = money(base_price_usd * fuel_percent / Decimal("100"))
    accessorials: dict[str, Decimal] = {}

    if address_type in {"residential", "private", "rural_residential"}:
        accessorials["residential_fee_usd"] = Decimal(pricing_config["residential"])
    if requires_liftgate:
        accessorials["liftgate_fee_usd"] = Decimal(pricing_config["liftgate"])
    if requires_pallet_jack:
        accessorials["pallet_jack_fee_usd"] = Decimal(pricing_config["pallet_jack"])
    if requires_appointment:
        accessorials["appointment_fee_usd"] = Decimal(pricing_config["appointment"])

    billable_detention_minutes = max(0, detention_minutes - pricing_config["detention_free_minutes"])
    if billable_detention_minutes:
        half_hours = ceil(Decimal(billable_detention_minutes) / Decimal("30"))
        accessorials["detention_fee_usd"] = money(Decimal(pricing_config["detention_half_hour"]) * half_hours)

    total = money(base_price_usd + fuel_usd + sum(accessorials.values(), Decimal("0")))
    return ZonePricingResult(
        fuel_usd=fuel_usd,
        accessorials={key: money(value) for key, value in accessorials.items()},
        total_price_usd=total,
    )
