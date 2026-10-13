#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ORCHESTRATOR_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = ORCHESTRATOR_ROOT.parent
GEN_SCRIPTS = SKILLS_ROOT / "power-grid-technical-report-writer" / "scripts"


def run(cmd: list[str]) -> int:
    print("+", " ".join(cmd))
    return subprocess.run(cmd, check=False).returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="Run generator and deterministic report quality validators")
    ap.add_argument("--outline", type=Path)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--chapter", type=Path)
    ap.add_argument("--chapter-target-words", type=int)
    ap.add_argument("--minimum-chapter-ratio", type=float, default=0.8)
    ap.add_argument("--coverage", type=Path)
    ap.add_argument("--references", type=Path)
    ap.add_argument("--source-root", type=Path, help="Explicit caller-provided authorized root for local reference bytes")
    ap.add_argument("--mode", choices=["chapter", "final"], default="final")
    ap.add_argument("--require-formula-chapters", default="")
    ap.add_argument("--max-title-chars", type=int, default=25, help="Compatibility display only; v3.6.0 validate_outline.py enforces 25 internally")
    ap.add_argument("--allow-title-length-warnings", action="store_true")
    ap.add_argument("--normalize-report", action="store_true")
    ap.add_argument("--dash-style", choices=["hyphen", "em-dash"], default="hyphen")
    args = ap.parse_args()

    if args.chapter and not args.chapter_target_words:
        ap.error("--chapter requires --chapter-target-words")
    codes: list[int] = []
    py = sys.executable

    if args.outline:
        # v3.6.0 validate_outline.py owns the complete fixed-architecture and 25-character checks.
        codes.append(run([py, str(GEN_SCRIPTS / "validate_outline.py"), str(args.outline)]))
    if args.coverage:
        coverage_mode = "final" if args.mode == "final" else "outline"
        codes.append(run([py, str(GEN_SCRIPTS / "validate_research_coverage.py"), str(args.coverage), "--mode", coverage_mode]))
    if args.references:
        cmd = [py, str(GEN_SCRIPTS / "validate_references.py"), str(args.references)]
        if args.source_root is not None:
            cmd.extend(["--source-root", str(args.source_root)])
        codes.append(run(cmd))
    if args.chapter:
        codes.append(run([
            py,
            str(GEN_SCRIPTS / "validate_word_count.py"),
            str(args.chapter),
            "--target",
            str(args.chapter_target_words),
            "--min-ratio",
            str(args.minimum_chapter_ratio),
        ]))
        codes.append(run([py, str(GEN_SCRIPTS / "validate_report_language.py"), str(args.chapter), "--mode", "chapter"]))
    if args.report:
        if args.normalize_report:
            codes.append(run([
                py,
                str(ORCHESTRATOR_ROOT / "scripts" / "normalize_markdown.py"),
                str(args.report),
                "--in-place",
                "--dash-style",
                args.dash_style,
            ]))
        codes.append(run([py, str(GEN_SCRIPTS / "validate_report_language.py"), str(args.report), "--mode", args.mode]))
        cmd = [py, str(GEN_SCRIPTS / "validate_formulas.py"), str(args.report)]
        if args.require_formula_chapters:
            cmd += ["--require-chapters", args.require_formula_chapters]
        codes.append(run(cmd))
    if not codes:
        ap.error("provide at least one of --outline/--report/--chapter/--coverage/--references")
    return 1 if any(c != 0 for c in codes) else 0


if __name__ == "__main__":
    sys.exit(main())
