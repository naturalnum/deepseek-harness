#!/usr/bin/env python3
"""Compile stage-specific runtime rule packs without rewriting source rules.

Unique source blocks are copied verbatim. Only byte-equivalent/whitespace-equivalent
repeated blocks inside the same pack are omitted. Source files remain authoritative.
"""
from __future__ import annotations
import argparse, hashlib, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "references" / "runtime-pack-manifest.json"


def split_blocks(text: str) -> list[str]:
    # Preserve fenced code blocks while splitting ordinary Markdown on blank lines.
    blocks, current = [], []
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and not line.strip() and current:
            blocks.append("\n".join(current).rstrip())
            current = []
        elif line.strip() or current:
            current.append(line)
    if current:
        blocks.append("\n".join(current).rstrip())
    return [b for b in blocks if b.strip()]


def norm(block: str) -> str:
    return re.sub(r"\s+", " ", block).strip()


def compile_pack(name: str, spec: dict) -> dict:
    seen: set[str] = set()
    output_blocks: list[str] = []
    source_stats = []
    duplicate_count = 0
    for rel in spec["sources"]:
        path = ROOT / rel
        text = path.read_text(encoding="utf-8")
        kept = 0
        total = 0
        output_blocks.append(f"<!-- SOURCE_BEGIN: {rel} -->")
        for block in split_blocks(text):
            total += 1
            key = hashlib.sha256(norm(block).encode("utf-8")).hexdigest()
            if key in seen:
                duplicate_count += 1
                continue
            seen.add(key)
            output_blocks.append(block)
            kept += 1
        output_blocks.append(f"<!-- SOURCE_END: {rel} -->")
        source_stats.append({"source": rel, "blocks": total, "kept": kept})
    out = ROOT / spec["output"]
    out.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"# Runtime Rule Pack: {name}\n\n"
        "> 自动编译文件。维护时修改原阶段/专题规则文件，不要直接编辑本文件。\n"
        "> 本包不改写规则，只在包内删除完全重复的规则块。源文件继续作为权威维护来源。\n\n"
    )
    out.write_text(header + "\n\n".join(output_blocks) + "\n", encoding="utf-8")
    return {
        "name": name, "output": spec["output"], "sources": source_stats,
        "unique_blocks": len(seen), "deduplicated_blocks": duplicate_count,
        "characters": len(out.read_text(encoding="utf-8"))
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default=str(ROOT / "compiled-packs" / "compile-report.json"))
    args = ap.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    results = [compile_pack(name, spec) for name, spec in manifest["packs"].items()]
    report = {
        "manifest": str(MANIFEST.relative_to(ROOT)),
        "policy": manifest["policy"],
        "packs": results,
        "total_deduplicated_blocks": sum(r["deduplicated_blocks"] for r in results)
    }
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
