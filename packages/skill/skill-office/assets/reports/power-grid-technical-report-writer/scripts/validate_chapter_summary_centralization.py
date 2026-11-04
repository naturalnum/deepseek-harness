#!/usr/bin/env python3
"""Ensure detailed chapter-summary rules are maintained only in chapter-summary.md."""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "references" / "chapter-summary.md"
EXCLUDE_DIRS = {"compiled-packs", "__pycache__"}

# These are content-level rules that must live in the canonical file, not be restated elsewhere.
REMOVED_CANONICAL_PATTERNS = [
    re.compile(r"###\s+6\.1\s+REAL_PROJECT_EVIDENCE"),
    re.compile(r"###\s+6\.2\s+REFERENCE_EXPERIMENT"),
    re.compile(r"适用边界"),
    re.compile(r"能力边界"),
    re.compile(r"仍需保留的条件、限制或待验证事项"),
]

FORBIDDEN_PATTERNS = [
    re.compile(r"本章小结.{0,50}采用.{0,20}总[—-]分[—-]总"),
    re.compile(r"本章小结.{0,50}(目标|约|控制).{0,20}500[—-]600"),
    re.compile(r"本章小结.{0,80}(?:100[—-]150|约300)"),
    re.compile(r"本章小结.{0,80}传统方法.{0,80}优势"),
    re.compile(r"本章小结.{0,100}自然.{0,40}(?:目标|考核|性能要求)"),
]


def main() -> int:
    if not CANONICAL.exists():
        print("ERROR: missing references/chapter-summary.md")
        return 1
    errors: list[str] = []
    canonical_text = CANONICAL.read_text(encoding="utf-8")
    for pat in REMOVED_CANONICAL_PATTERNS:
        m = pat.search(canonical_text)
        if m:
            errors.append(f"chapter-summary.md: removed defensive rule returned: {m.group(0)}")
    for p in ROOT.rglob("*.md"):
        if p == CANONICAL or p.name == "CHANGELOG.md" or any(part in EXCLUDE_DIRS for part in p.parts):
            continue
        text = p.read_text(encoding="utf-8")
        for pat in FORBIDDEN_PATTERNS:
            m = pat.search(text)
            if m:
                errors.append(f"{p.relative_to(ROOT)}: duplicated chapter-summary rule: {m.group(0)[:120]}")
    # References from the three main runtime stages must exist.
    import json
    manifest = json.loads((ROOT / "references" / "runtime-pack-manifest.json").read_text(encoding="utf-8"))
    for pack in ["20-outline", "30-chapter-planning-core", "40-chapter-writing-core"]:
        if "references/chapter-summary.md" not in manifest["packs"][pack]["sources"]:
            errors.append(f"runtime manifest missing chapter-summary.md for {pack}")
    if errors:
        print("\n".join("ERROR: " + e for e in errors))
        return 1
    print("chapter-summary centralization: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
