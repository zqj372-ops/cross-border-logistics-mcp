"""Normalize reviewed UTF-8 CADEx exports without importing Access."""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any, Mapping

from .rate_parser import parse_rate

DEFAULT_RELEASE_ID = "ca-cbsa-customs-tariff-2026-r0-en"
DEFAULT_ARTIFACT_ID = "cadex-accdb"
DEFAULT_CONFIG = Path(__file__).resolve().parent / "config" / "cbsa-2026-t2026-2-en.json"
_DIGITS = re.compile(r"\d+")


def _compact_code(value: Any) -> str:
    return "".join(_DIGITS.findall(str(value or "")))


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return sha256(encoded).hexdigest()


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _field(config: Mapping[str, Any], name: str, default: str) -> str:
    fields = config.get("columns", {})
    value = fields.get(name, default) if isinstance(fields, Mapping) else default
    return str(value)


def _field_names(config: Mapping[str, Any], name: str, default: str) -> list[str]:
    fields = config.get("columns", {})
    value = fields.get(name, default) if isinstance(fields, Mapping) else default
    if isinstance(value, list):
        names = [str(item) for item in value if str(item).strip()]
        if not names:
            raise ValueError(f"CBSA config column list {name} must not be empty")
        return names
    return [str(value)]


def _description(row: Mapping[str, Any], columns: Mapping[str, Any]) -> str:
    return " ".join(_text(row.get(name)) for name in _field_names(columns, "description", "Description") if _text(row.get(name)))


def _treatments(table_config: Mapping[str, Any]) -> list[tuple[str, str, int]]:
    configured = table_config.get("treatments")
    if configured is None:
        return [("MFN", _field(table_config, "general", "GeneralRate"), 10), ("other", _field(table_config, "other", "OtherRate"), 20)]
    if not isinstance(configured, list) or not configured:
        raise ValueError("CBSA config treatments must be a non-empty array")
    result: list[tuple[str, str, int]] = []
    for index, item in enumerate(configured):
        if not isinstance(item, Mapping):
            raise ValueError("CBSA config treatment must be an object")
        name = _text(item.get("name"))
        column = _text(item.get("column"))
        priority = item.get("priority", (index + 1) * 10)
        if not name or not column or not isinstance(priority, int) or isinstance(priority, bool):
            raise ValueError("CBSA config treatment name, column, or priority is invalid")
        result.append((name, column, priority))
    if len({name for name, _column, _priority in result}) != len(result):
        raise ValueError("CBSA config treatment names must be unique")
    return result


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
            handle.write("\n")


def normalize_cbsa_directory(
    input_dir: str | Path,
    *,
    output_dir: str | Path | None = None,
    config_path: str | Path | None = None,
    release_id: str = DEFAULT_RELEASE_ID,
    artifact_id: str = DEFAULT_ARTIFACT_ID,
    effective_from: str = "2026-01-01",
    effective_to: str | None = None,
    source_locator_prefix: str | None = None,
    language: str = "en",
    include_tariff_rules: bool = True,
) -> dict[str, Any]:
    """Normalize fixture/export CSVs and explain every non-business row."""

    source_dir = Path(input_dir)
    if not source_dir.is_dir():
        raise FileNotFoundError(f"CADEx export directory does not exist: {source_dir}")
    config_file = Path(config_path) if config_path else DEFAULT_CONFIG
    config = json.loads(config_file.read_text(encoding="utf-8")) if config_file.exists() else {}
    if language not in {"en", "fr"}:
        raise ValueError("CBSA legal-name language must be en or fr")
    if not isinstance(include_tariff_rules, bool):
        raise ValueError("CBSA include_tariff_rules must be boolean")
    business_tables = config.get("businessTables", [])
    if not isinstance(business_tables, list):
        raise ValueError("CBSA config businessTables must be an array")
    by_file = {str(entry.get("file")): entry for entry in business_tables if isinstance(entry, Mapping)}

    nomenclature: list[dict[str, Any]] = []
    tariff_rules: list[dict[str, Any]] = []
    exclusions: list[dict[str, Any]] = []
    omissions: list[dict[str, Any]] = []
    source_row_count = 0
    non_business = config.get("nonBusinessTables", {})
    all_csv = sorted(source_dir.glob("*.csv"))
    used_files: set[str] = set()
    seen_codes: set[str] = set()
    seen_business_rows: dict[str, str] = {}
    code_identities: dict[str, str] = {}
    for filename in by_file:
        if not (source_dir / filename).is_file():
            exclusions.append({"source_locator": filename, "reason": "missing_business_table"})

    for csv_path in all_csv:
        table_config = by_file.get(csv_path.name)
        used_files.add(csv_path.name)
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                exclusions.append({"source_locator": f"{csv_path.name}#header", "reason": "missing_csv_header"})
                continue
            metadata = non_business.get(csv_path.name)
            if table_config is None:
                if not isinstance(metadata, dict) or reader.fieldnames != metadata.get("columns") or not metadata.get("evidence"):
                    exclusions.append({"source_locator": f"{csv_path.name}#header", "reason": "unmapped_or_changed_source_table"})
            else:
                required = set(_field_names(table_config, "description", "Description")) | {_field(table_config, "code", "HTSCode")}
                required.update(column for _, column, _ in _treatments(table_config) if include_tariff_rules)
                configured_columns = table_config.get("columns", {})
                required.update(configured_columns[name] for name in ("unit", "footnote") if name in configured_columns)
                if len(set(reader.fieldnames)) != len(reader.fieldnames) or not required <= set(reader.fieldnames):
                    exclusions.append({"source_locator": f"{csv_path.name}#header", "reason": "missing_or_duplicate_business_column"})
            for row_number, raw in enumerate(reader, start=1):
                source_row_count += 1
                row = {str(key): value for key, value in raw.items()}
                source_locator = f"{csv_path.name}#row[{row_number}]"
                if source_locator_prefix:
                    source_locator = f"{source_locator_prefix}#{source_locator}"
                if None in raw or any(value is None for value in raw.values()):
                    exclusions.append({"source_locator": source_locator, "reason": "csv_row_shape_invalid"})
                    continue
                if table_config is None:
                    if isinstance(metadata, dict) and reader.fieldnames == metadata.get("columns") and metadata.get("evidence"):
                        omissions.append({"source_locator": source_locator, "reason": metadata["reason"], "evidence": metadata["evidence"], "raw_row_hash": _canonical_hash({"table": csv_path.name, "row": row})})
                    else:
                        exclusions.append({"source_locator": source_locator, "reason": "unmapped_source_table"})
                    continue
                columns = table_config
                code = _compact_code(row.get(_field(columns, "code", "HTSCode")))
                status = _text(row.get(_field(columns, "status", "RowStatus"))).casefold()
                if status and status not in {"used", "active", "declarable"}:
                    exclusions.append({"source_locator": source_locator, "reason": f"source_row_status:{status}"})
                    continue
                if not code:
                    exclusions.append({"source_locator": source_locator, "reason": "missing_code"})
                    continue
                parent = _compact_code(row.get(_field(columns, "parent", "ParentCode"))) or None
                if parent is None and table_config.get("parentStrategy") == "source_prefix":
                    parent = next((code[:length] for length in range(len(code) - 1, 0, -1) if code[:length] in seen_codes), None)
                source_description = _description(row, columns)
                description = source_description or code
                if not source_description:
                    exclusions.append({"source_locator": source_locator, "code": code, "reason": "missing_legal_description"})
                level = _text(row.get(_field(columns, "level", "Level"))) or str(len(code))
                unit = _text(row.get(_field(columns, "unit", "Unit")))
                raw_hash = _canonical_hash({"table": csv_path.name, "row": row})
                footnote = _text(row.get(_field(columns, "footnote", "Footnote"))) or None
                treatments = _treatments(table_config) if include_tariff_rules else []
                technical_columns = table_config.get("technicalColumns", [])
                if not isinstance(technical_columns, list) or any(column != "row_id" for column in technical_columns):
                    raise ValueError("Only the CADEx row_id may be omitted from exact duplicate identity")
                business_identity = _canonical_hash({"table": csv_path.name, "row": {key: value for key, value in row.items() if key not in technical_columns}})
                if business_identity in seen_business_rows:
                    omissions.append({"source_locator": source_locator, "reason": "exact_duplicate_business_row", "duplicate_of": seen_business_rows[business_identity], "raw_row_hash": raw_hash})
                    continue
                seen_business_rows[business_identity] = source_locator
                if code in code_identities and code_identities[code] != business_identity:
                    exclusions.append({"source_locator": source_locator, "reason": "conflicting_business_code"})
                code_identities[code] = business_identity
                declarable_digits = table_config.get("declarableDigits")
                if declarable_digits is not None:
                    if not isinstance(declarable_digits, list) or any(not isinstance(item, int) or isinstance(item, bool) for item in declarable_digits):
                        raise ValueError("CBSA config declarableDigits must be an integer array")
                    is_declarable = len(code) in declarable_digits
                else:
                    is_declarable = len(code) >= 8
                nomenclature.append(
                    {
                        "release_id": release_id,
                        "artifact_id": artifact_id,
                        "country": "CA",
                        "code": code,
                        "display_code": _text(row.get(_field(columns, "code", "HTSCode"))) or code,
                        "code_digits": str(len(code)),
                        "level": level,
                        "parent_code": parent,
                        "is_declarable": is_declarable and bool(source_description),
                        "description_original": description,
                        "language": language,
                        "statistical_unit_json": {"unit": unit} if unit else None,
                        "effective_from": effective_from,
                        "effective_to": effective_to,
                        "source_locator": source_locator,
                        "raw_row_hash": raw_hash,
                    }
                )
                seen_codes.add(code)
                if not include_tariff_rules:
                    continue
                for treatment, column_name, priority in treatments:
                    raw_rate = _text(row.get(column_name))
                    if not raw_rate:
                        continue
                    components = parse_rate(raw_rate)
                    parse_status = "review" if any(item.get("parseStatus") == "review" for item in components) else "confirmed"
                    tariff_rules.append(
                        {
                            "release_id": release_id,
                            "artifact_id": artifact_id,
                            "rule_id": f"{release_id}:{code}:{treatment}:{row_number}",
                            "country": "CA",
                            "code": code,
                            "code_match_type": "prefix" if len(code) == 8 else "exact",
                            "measure_type": "customs_duty",
                            "treatment": treatment,
                            "origin_country": None,
                            "rate_expression_raw": raw_rate,
                            "rate_components_json": components,
                            "parse_status": parse_status,
                            "condition_text_raw": footnote,
                            "conditions_json": {"footnote": footnote} if footnote else {},
                            "interaction_json": {},
                            "effective_from": effective_from,
                            "effective_to": effective_to,
                            "priority": priority,
                            "source_locator": source_locator,
                            "raw_row_hash": raw_hash,
                        }
                    )

    for csv_path in all_csv:
        if csv_path.name not in used_files:
            exclusions.append({"source_locator": csv_path.name, "reason": "unmapped_source_table"})

    if not nomenclature:
        exclusions.append({"source_locator": "business_tables", "reason": "no_business_rows"})

    result = {
        "release_id": release_id,
        "artifact_id": artifact_id,
        "nomenclature": nomenclature,
        "tariff_rules": tariff_rules,
        "exclusions": exclusions,
        "omissions": omissions,
        "source_row_count": source_row_count,
        "status": "review" if exclusions else "pass",
    }
    if output_dir is not None:
        target = Path(output_dir)
        target.mkdir(parents=True, exist_ok=True)
        _write_jsonl(target / "nomenclature.jsonl", nomenclature)
        _write_jsonl(target / "tariff_rules.jsonl", tariff_rules)
        quality = {
            "release_id": result["release_id"],
            "schema_version": "1.0.0",
            "status": result["status"],
            "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "checks": [
                {"name": "nomenclature", "count": len(nomenclature)},
                {"name": "tariff_rules", "count": len(tariff_rules)},
                {"name": "exclusions", "count": len(exclusions)},
                {"name": "audited_omissions", "count": len(omissions), "evidence": omissions},
                {"name": "language", "value": language},
                {"name": "includes_tariff_rules", "value": include_tariff_rules},
            ],
            "reasons": exclusions,
        }
        (target / "quality-report.json").write_text(json.dumps(quality, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return result


def normalize_cbsa(input_dir: str | Path, **kwargs: Any) -> dict[str, Any]:
    return normalize_cbsa_directory(input_dir, **kwargs)
