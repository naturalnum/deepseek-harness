#!/usr/bin/env python3
"""Advisory grayscale and accessibility checks for an SVG visual."""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)")
HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def is_gray_hex(value: str) -> bool:
    match = HEX_RE.match(value)
    if not match:
        return False
    digits = match.group(1)
    if len(digits) == 3:
        red, green, blue = (int(channel * 2, 16) for channel in digits[:3])
    else:
        red, green, blue = (int(digits[index : index + 2], 16) for index in (0, 2, 4))
    return max(red, green, blue) - min(red, green, blue) <= 8


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def inspect_svg(path: Path, allowed_accents: int) -> dict[str, object]:
    findings: list[dict[str, str]] = []
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        return {"file": str(path), "valid": False, "advisory": True, "error": str(error), "findings": []}

    if local_name(root.tag) != "svg":
        findings.append({"code": "root_not_svg", "message": "Root element is not <svg>."})
    if not root.get("viewBox"):
        findings.append({"code": "missing_viewbox", "message": "Add a stable viewBox for responsive rendering."})

    child_names = {local_name(child.tag) for child in root}
    if "title" not in child_names:
        findings.append({"code": "missing_title", "message": "Add a concise accessible <title>."})
    if "desc" not in child_names:
        findings.append({"code": "missing_description", "message": "Add an accessible <desc> explaining the visual."})

    gradients = 0
    filters = 0
    colors: set[str] = set()
    for element in root.iter():
        name = local_name(element.tag)
        gradients += int(name in {"linearGradient", "radialGradient"})
        filters += int(name == "filter")
        values = list(element.attrib.values())
        if element.text:
            values.append(element.text)
        for value in values:
            colors.update(match.group(0).lower() for match in COLOR_RE.finditer(value))

    if gradients:
        findings.append({"code": "gradient", "message": f"Found {gradients} gradient definition(s); prefer flat vector fills."})
    if filters:
        findings.append({"code": "filter", "message": f"Found {filters} SVG filter(s); check for decorative glow or shadow."})

    non_gray = sorted(color for color in colors if color.startswith("#") and not is_gray_hex(color))
    if len(non_gray) > allowed_accents:
        findings.append(
            {
                "code": "accent_count",
                "message": f"Found {len(non_gray)} non-gray hex colors ({', '.join(non_gray)}); recommended allowance is {allowed_accents}.",
            }
        )

    return {
        "file": str(path),
        "valid": True,
        "advisory": True,
        "colors": sorted(colors),
        "nonGrayHexColors": non_gray,
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("svg", type=Path)
    parser.add_argument("--allow-accents", type=int, default=1)
    args = parser.parse_args()
    result = inspect_svg(args.svg, max(0, args.allow_accents))
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0 if result.get("valid") else 2


if __name__ == "__main__":
    sys.exit(main())
