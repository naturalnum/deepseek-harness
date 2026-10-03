#!/usr/bin/env python3
"""Validate verified reference registry.

Usage:
    python validate_references.py reference-registry.json
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def valid_url(value: str) -> bool:
    try:
        p = urlparse(value)
        return p.scheme in {"http", "https"} and bool(p.netloc)
    except Exception:
        return False


GB_TYPE_RE = re.compile(r"\[(J|M|C|D|R|S|P|N|DB|CP|EB|DS(?=\]|/OL\]))(?:/(OL|DK|CD|MT))?\]")
ONLINE_DATE_RE = re.compile(r"\[\d{4}-\d{2}-\d{2}\]")
REFERENCE_TYPE_MARKERS = {
    "journal_article": {"J"},
    "conference_paper": {"C"},
    "standard": {"S"},
    "official_document": {"R", "EB/OL"},
    "dataset": {"DB", "DB/OL", "DS", "DS/OL"},
    "book": {"M"},
    "thesis": {"D"},
    "report": {"R"},
}


def validate_gbt7714_entry(entry: str, reference_type: str) -> list[str]:
    errors: list[str] = []
    text = re.sub(r"\s+", " ", (entry or "").strip())
    if not text:
        return ["missing gbt7714_entry"]
    if re.match(r"^\[\d+\]", text):
        errors.append("gbt7714_entry must not contain the final [n] sequence number")
    marker_match = GB_TYPE_RE.search(text)
    if not marker_match:
        errors.append("gbt7714_entry must contain a GB/T 7714 document type marker such as [J], [M], [S] or [EB/OL]")
    else:
        marker = marker_match.group(1) + (f"/{marker_match.group(2)}" if marker_match.group(2) else "")
        allowed = REFERENCE_TYPE_MARKERS.get(reference_type)
        if allowed and marker not in allowed:
            errors.append(f"document type marker [{marker}] is inconsistent with reference_type={reference_type}")
        if marker.endswith("/OL"):
            if not ONLINE_DATE_RE.search(text):
                errors.append("online reference must include a citation date [YYYY-MM-DD]")
            if not re.search(r"https?://\S+", text):
                errors.append("online reference must include an http(s) URL")
    if not text.endswith("."):
        errors.append("gbt7714_entry must end with an ASCII period '.'")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python validate_references.py reference-registry.json", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    if data.get("internet_access") not in {"available", "unavailable", "unknown"}:
        errors.append("internet_access is invalid")
    items = data.get("items", [])
    for i, item in enumerate(items, start=1):
        prefix = f"reference[{i}]"
        for field in ("id", "title", "reference_type", "verification_status", "supports", "gbt7714_entry"):
            if not item.get(field):
                errors.append(f"{prefix}: missing {field}")
        if item.get("verification_status") != "verified":
            errors.append(f"{prefix}: cited references must be verified")
        if not item.get("doi_or_identifier") and not item.get("official_url"):
            errors.append(f"{prefix}: DOI/stable identifier or official URL required")
        for field in ("official_url", "legal_download_url"):
            value = item.get(field)
            if value and not valid_url(value):
                errors.append(f"{prefix}: invalid {field}")
        sources = item.get("verification_sources", [])
        if not sources:
            errors.append(f"{prefix}: verification_sources required")
        for url in sources:
            if not valid_url(url):
                errors.append(f"{prefix}: invalid verification source URL")
        for detail in validate_gbt7714_entry(str(item.get("gbt7714_entry") or ""), str(item.get("reference_type") or "")):
            errors.append(f"{prefix}: {detail}")
    if errors:
        print("Reference validation failed:")
        for e in errors:
            print(f"- {e}")
        return 1
    print(f"Reference validation passed: {len(items)} verified entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
