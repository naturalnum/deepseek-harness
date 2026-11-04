#!/usr/bin/env python3
"""Build a minimal model context bundle for one generator action."""
from __future__ import annotations
import argparse, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "references" / "runtime-pack-manifest.json"
TYPE_MAP = {
    "algorithm": "type-algorithm",
    "data-knowledge-construction": "type-data-knowledge-construction",
    "engineering-integration": "type-engineering-integration",
    "optimization-module": "type-optimization-module",
    "system-design": "type-system-design",
    "theory-and-mechanism": "type-theory-and-mechanism",
}
ADDON_MAP = {
    "foundation": "addon-foundation",
    "technical": "addon-technical",
    "result-analysis": "addon-result-analysis",
    "citation": "addon-citation",
    "figure-table": "addon-figure-table",
    "experiment-reference": "addon-experiment-reference",
}

def resolve(action: str, chapter_type: str | None, addons: list[str]) -> list[str]:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    raw = data["action_load_map"].get(action)
    if raw is None:
        raise SystemExit(f"unknown action: {action}")
    names: list[str] = []
    for item in raw:
        if item == "<one-type-pack>":
            if chapter_type:
                names.append(TYPE_MAP[chapter_type])
        elif item == "<affected-type-packs>":
            if chapter_type:
                names.append(TYPE_MAP[chapter_type])
        elif item == "<conditional-addons>":
            names.extend(ADDON_MAP[a] for a in addons)
        else:
            names.append(item)
    # stable de-duplication
    return list(dict.fromkeys(names))

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--action", required=True)
    ap.add_argument("--chapter-type", choices=sorted(TYPE_MAP))
    ap.add_argument("--addon", action="append", default=[], choices=sorted(ADDON_MAP))
    ap.add_argument("--payload", help="JSON payload appended after rules")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pack_names = resolve(args.action, args.chapter_type, args.addon)
    sections = [f"# Context Bundle\n\naction: `{args.action}`\n"]
    for name in pack_names:
        spec = manifest["packs"][name]
        sections.append((ROOT / spec["output"]).read_text(encoding="utf-8"))
    if args.payload:
        payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
        sections.append("# Current Structured Payload\n\n```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```")
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n\n---\n\n".join(sections), encoding="utf-8")
    print(json.dumps({
        "action": args.action,
        "packs": pack_names,
        "output": str(out),
        "characters": len(out.read_text(encoding="utf-8"))
    }, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
