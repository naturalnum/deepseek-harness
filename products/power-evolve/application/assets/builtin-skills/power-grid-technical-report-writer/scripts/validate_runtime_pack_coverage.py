#!/usr/bin/env python3
"""Validate that every declared source block is represented in its compiled pack."""
from __future__ import annotations
import hashlib, json, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "references" / "runtime-pack-manifest.json"

def split_blocks(text: str) -> list[str]:
    blocks, current, in_fence = [], [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and not line.strip() and current:
            blocks.append("\n".join(current).rstrip()); current=[]
        elif line.strip() or current:
            current.append(line)
    if current: blocks.append("\n".join(current).rstrip())
    return [b for b in blocks if b.strip()]

def norm(s: str) -> str: return re.sub(r"\s+", " ", s).strip()

def main() -> int:
    data=json.loads(MANIFEST.read_text(encoding="utf-8")); errors=[]; checked=0
    for name,spec in data["packs"].items():
        out=(ROOT/spec["output"]).read_text(encoding="utf-8")
        out_norm=norm(out)
        for rel in spec["sources"]:
            for block in split_blocks((ROOT/rel).read_text(encoding="utf-8")):
                checked+=1
                if norm(block) not in out_norm:
                    errors.append({"pack":name,"source":rel,"block_sha256":hashlib.sha256(norm(block).encode()).hexdigest()})
    result={"checked_source_blocks":checked,"errors":errors,"status":"passed" if not errors else "failed"}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if not errors else 1
if __name__=="__main__": raise SystemExit(main())
