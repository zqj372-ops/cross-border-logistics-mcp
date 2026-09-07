"""Conservative parsing of tariff-rate expressions.

The parser intentionally returns strings for decimal values.  If any part of an
expression is outside the reviewed grammar, the complete original expression is
returned as a text component with ``parseStatus=review`` rather than guessed.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

_NUMBER = r"(?:\d+(?:\.\d+)?|\.\d+)"
_PERCENT = re.compile(rf"^(?P<percent>[+-]?{_NUMBER})\s*%$", re.IGNORECASE)
_SPECIFIC = re.compile(
    rf"^(?:(?P<amount_first>[+-]?{_NUMBER})\s*(?P<currency_first>[A-Z]{{3}})\s*/\s*(?P<unit_first>[A-Za-z][A-Za-z0-9_-]*)|"
    rf"(?P<currency_last>[A-Z]{{3}})\s*(?P<amount_last>[+-]?{_NUMBER})\s*/\s*(?P<unit_last>[A-Za-z][A-Za-z0-9_-]*))$",
    re.IGNORECASE,
)


def _decimal_string(value: str) -> str | None:
    try:
        decimal = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    if not decimal.is_finite():
        return None
    return value.lstrip("+")


def _parse_component(component: str) -> dict[str, Any] | None:
    text = component.strip()
    percent = _PERCENT.fullmatch(text)
    if percent:
        value = _decimal_string(percent.group("percent"))
        return {"kind": "ad_valorem", "percent": value} if value is not None else None

    specific = _SPECIFIC.fullmatch(text)
    if specific:
        amount = specific.group("amount_first") or specific.group("amount_last")
        currency = specific.group("currency_first") or specific.group("currency_last")
        unit = specific.group("unit_first") or specific.group("unit_last")
        normalized_amount = _decimal_string(amount)
        if normalized_amount is None or currency is None or unit is None:
            return None
        return {
            "kind": "specific",
            "amount": normalized_amount,
            "currency": currency.upper(),
            "perQuantity": "1",
            "unit": unit,
        }
    return None


def parse_rate(expression: str) -> list[dict[str, Any]]:
    """Parse a reviewed subset of free/ad-valorem/specific/compound rates."""

    if not isinstance(expression, str):
        raise TypeError("rate expression must be a string")
    raw = expression.strip()
    if raw.casefold() == "free":
        return [{"kind": "free"}]
    if not raw:
        return [{"kind": "text", "text": expression, "parseStatus": "review"}]

    components = [part.strip() for part in raw.split("+")]
    parsed = [_parse_component(component) for component in components]
    if all(component is not None for component in parsed):
        return [component for component in parsed if component is not None]
    return [{"kind": "text", "text": expression, "parseStatus": "review"}]
