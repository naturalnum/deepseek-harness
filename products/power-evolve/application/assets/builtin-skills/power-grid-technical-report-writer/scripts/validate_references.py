#!/usr/bin/env python3
"""Validate verified reference registry.

Usage:
    python validate_references.py reference-registry.json [--source-root /authorized/workspace]
"""
from __future__ import annotations
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def placeholder_url(value: str) -> bool:
    """Reject explicit placeholder hosts; this does not perform online verification."""
    try:
        host = (urlparse(value).hostname or "").lower().rstrip(".")
        return (host in {"localhost", "example.com", "example.net", "example.org"}
                or any(host.endswith("." + suffix) or host == suffix
                       for suffix in ("invalid", "test", "localhost", "example", "example.com", "example.net", "example.org")))
    except (TypeError, ValueError):
        return False


def valid_url(value: str) -> bool:
    try:
        p = urlparse(value)
        return (isinstance(value, str) and p.scheme in {"http", "https"}
                and bool(p.hostname) and not placeholder_url(value))
    except Exception:
        return False


def placeholder_http_issues(value: Any) -> list[str]:
    """Inspect citation/verification text, including legacy registry shapes."""
    if isinstance(value, str):
        return ["placeholder HTTP URL is not verification evidence"] if any(
            placeholder_url(url.rstrip(".,;，。；)】]"))
            for url in re.findall(r"https?://[^\s<>\"']+", value, flags=re.I)) else []
    if isinstance(value, dict):
        return [issue for child in value.values() for issue in placeholder_http_issues(child)]
    if isinstance(value, list):
        return [issue for child in value for issue in placeholder_http_issues(child)]
    return []


def has_local_file_evidence(value: Any) -> bool:
    """Never treat local fields or file URIs as an old external-only registry."""
    if isinstance(value, dict):
        if (any(key in value for key in ("local_file_evidence", "relative_path", "sha256", "byte_size", "source_root"))
                or ("source_kind" in value and value["source_kind"] != "external")):
            return True
        return any(has_local_file_evidence(child) for child in value.values())
    if isinstance(value, list):
        return any(has_local_file_evidence(child) for child in value)
    return isinstance(value, str) and value.strip().lower().startswith(("file:", "local-file:"))


def has_local_evidence_metadata(value: Any) -> bool:
    """Find reserved evidence fields outside items, without interpreting ordinary prose."""
    if isinstance(value, dict):
        identifier = value.get("doi_or_identifier")
        if (any(key in value for key in ("local_file_evidence", "relative_path", "sha256", "byte_size", "source_root"))
                or ("source_kind" in value and value["source_kind"] != "external")
                or (isinstance(identifier, str) and identifier.strip().lower().startswith(("file:", "local-file:")))):
            return True
        return any(has_local_evidence_metadata(child) for child in value.values())
    if isinstance(value, list):
        return any(has_local_evidence_metadata(child) for child in value)
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
    errors.extend(placeholder_http_issues(text))
    return errors


def _file_identity(value: os.stat_result) -> tuple:
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)


def validate_local_file(evidence: Any, *, source_root: Path | None) -> list[str]:
    """Read only a regular file beneath the caller's explicit root, without following links."""
    if not isinstance(evidence, dict) or set(evidence) != {"relative_path", "sha256", "byte_size"}:
        return ["local_file_evidence requires only relative_path, sha256 and byte_size"]
    relative = evidence["relative_path"]
    digest = evidence["sha256"]
    size = evidence["byte_size"]
    if (not isinstance(relative, str) or not relative or relative.startswith(("/", "~"))
            or any(char in relative for char in ("\x00", "\\", ":"))
            or any(part in {"", ".", ".."} for part in relative.split("/"))):
        return ["local evidence path must be a normalized relative path within source-root"]
    if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
        return ["local evidence sha256 must contain 64 lowercase hexadecimal characters"]
    if type(size) is not int or size < 0:
        return ["local evidence byte_size must be a nonnegative integer"]
    if source_root is None:
        return ["local evidence requires an explicit caller-provided source-root"]
    root = Path(source_root)
    if not root.is_absolute() or ".." in root.parts:
        return ["source-root must be an absolute directory"]
    if (not all(hasattr(os, flag) for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"))
            or os.open not in os.supports_dir_fd or os.stat not in os.supports_dir_fd
            or os.stat not in os.supports_follow_symlinks):
        return ["safe local evidence opening is unavailable on this platform"]
    try:
        with ExitStack() as opened:
            directory_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
            current = os.open(root.anchor, directory_flags)
            opened.callback(os.close, current)
            bindings = []
            # Anchor every root/source directory component; do not resolve through a symlink.
            for component in (*root.parts[1:], *relative.split("/")[:-1]):
                child = os.open(component, directory_flags, dir_fd=current)
                opened.callback(os.close, child)
                identity = os.fstat(child)
                bindings.append((current, component, identity))
                current = child
            name = relative.split("/")[-1]
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
            opened.callback(os.close, fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                return ["local evidence must be a regular file"]
            if before.st_size != size:
                return ["local evidence byte_size does not match the file"]
            actual = hashlib.sha256()
            count = 0
            while True:
                chunk = os.read(fd, min(65536, size - count + 1))
                if not chunk:
                    break
                count += len(chunk)
                if count > size:
                    return ["local evidence changed while reading"]
                actual.update(chunk)
            if _file_identity(before) != _file_identity(os.fstat(fd)):
                return ["local evidence changed while reading"]
            if _file_identity(before) != _file_identity(os.stat(name, dir_fd=current, follow_symlinks=False)):
                return ["local evidence path changed while reading"]
            for parent, component, identity in bindings:
                bound = os.stat(component, dir_fd=parent, follow_symlinks=False)
                if (bound.st_dev, bound.st_ino, bound.st_mode) != (identity.st_dev, identity.st_ino, identity.st_mode):
                    return ["local evidence directory changed while reading"]
            if count != size or actual.hexdigest() != digest:
                return ["local evidence sha256 or byte_size does not match the file"]
    except (OSError, ValueError):
        return ["local evidence could not be safely opened or read"]
    return []


def validate_reference_registry(data: Any, *, source_root: Path | None = None) -> list[str]:
    """Check reference metadata and local bytes, never infer academic truth from a URL."""
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["reference registry must be an object"]
    outside_items = {key: value for key, value in data.items() if key != "items"}
    if has_local_evidence_metadata(outside_items):
        errors.append("local evidence belongs to items; source-root must come from the caller")
    errors.extend(placeholder_http_issues(outside_items))
    if data.get("internet_access") not in ("available", "unavailable", "unknown"):
        errors.append("internet_access is invalid")
    items = data.get("items")
    if not isinstance(items, list):
        return errors + ["items must be an array"]
    identifiers: set[str] = set()
    for i, item in enumerate(items, start=1):
        prefix = f"reference[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix}: entry must be an object")
            continue
        if "source_root" in item:
            errors.append(f"{prefix}: source-root must come from the caller")
        for field in ("id", "title", "reference_type", "verification_status", "gbt7714_entry"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                errors.append(f"{prefix}: missing {field}")
        identifier = item.get("id")
        if isinstance(identifier, str):
            if identifier in identifiers:
                errors.append(f"{prefix}: reference id must be unique")
            identifiers.add(identifier)
        if (not isinstance(item.get("supports"), list) or not item["supports"]
                or not all(isinstance(value, str) and value.strip() for value in item["supports"])):
            errors.append(f"{prefix}: supports must be a nonempty string array")
        if not isinstance(item.get("reference_type"), str) or item["reference_type"] not in REFERENCE_TYPE_MARKERS:
            errors.append(f"{prefix}: reference_type is invalid")
        if item.get("verification_status") != "verified":
            errors.append(f"{prefix}: cited references must be verified")
        kind = item.get("source_kind", "external")
        if kind == "local_file":
            evidence = item.get("local_file_evidence")
            errors.extend(f"{prefix}: {issue}" for issue in validate_local_file(evidence, source_root=source_root))
            if not isinstance(evidence, dict) or item.get("doi_or_identifier") != "sha256:" + str(evidence.get("sha256", "")):
                errors.append(f"{prefix}: local identifier must match the evidence sha256")
            if item.get("reference_type") not in ("report", "official_document", "dataset"):
                errors.append(f"{prefix}: local project evidence must be a report, official document or dataset")
            if (any(field in item for field in ("official_url", "legal_download_url"))
                    or ("verification_sources" in item and item["verification_sources"] != [])):
                errors.append(f"{prefix}: local evidence must not declare HTTP verification sources")
            if "/OL]" in str(item.get("gbt7714_entry", "")):
                errors.append(f"{prefix}: local project evidence must use a non-online document marker")
        elif kind == "external":
            if has_local_file_evidence(item):
                errors.append(f"{prefix}: local evidence cannot use the external source branch")
            if not item.get("doi_or_identifier") and not item.get("official_url"):
                errors.append(f"{prefix}: DOI/stable identifier or official URL required")
            for field in ("official_url", "legal_download_url"):
                value = item.get(field)
                if value and not valid_url(value):
                    errors.append(f"{prefix}: invalid {field}")
            sources = item.get("verification_sources", [])
            if not isinstance(sources, list) or not sources:
                errors.append(f"{prefix}: verification_sources required")
            else:
                for url in sources:
                    if not isinstance(url, str) or not valid_url(url):
                        errors.append(f"{prefix}: invalid verification source URL")
        else:
            errors.append(f"{prefix}: source_kind must be external or local_file")
        for detail in validate_gbt7714_entry(str(item.get("gbt7714_entry") or ""), str(item.get("reference_type") or "")):
            errors.append(f"{prefix}: {detail}")
        errors.extend(f"{prefix}: {detail}" for detail in placeholder_http_issues(item))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate reference metadata and explicitly scoped local file bytes")
    parser.add_argument("registry", type=Path)
    parser.add_argument("--source-root", type=Path, help="Caller-provided authorized workspace; never inferred from CWD")
    args = parser.parse_args()
    data = json.loads(args.registry.read_text(encoding="utf-8"))
    errors = validate_reference_registry(data, source_root=args.source_root)
    if errors:
        print("Reference validation failed:")
        for e in errors:
            print(f"- {e}")
        return 1
    print(f"Reference validation passed: {len(data['items'])} entries; local bytes checked, external URLs are format checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
