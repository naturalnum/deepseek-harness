#!/usr/bin/env python3
"""检查 tech-report-writer 的本地运行环境，不执行安装。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
import os
import subprocess
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent.parent
REQUIRED_MODULES = {
    "bs4": "beautifulsoup4",
    "json_repair": "json-repair",
    "lxml": "lxml",
    "PIL": "Pillow",
    "docx": "python-docx",
    "requests": "requests",
}
REQUIRED_FILES = (
    "SKILL.md",
    "requirements.txt",
    "assets/report.docx",
    "references/technical-report-format.md",
    "references/guide.md",
)


def collect_status() -> dict:
    missing_packages = [
        package
        for module, package in REQUIRED_MODULES.items()
        if importlib.util.find_spec(module) is None
    ]
    missing_files = [
        relative_path
        for relative_path in REQUIRED_FILES
        if not (SKILL_DIR / relative_path).is_file()
    ]
    python_ok = sys.version_info >= (3, 10)
    missing_tools = []
    if sys.platform.startswith("linux"):
        for tool in ("libreoffice", "pdftotext", "pdftoppm"):
            if not shutil.which(tool):
                missing_tools.append(tool)
        try:
            probe = subprocess.run(["/usr/bin/python3", "-c", "import uno"], capture_output=True, timeout=5)
            if probe.returncode:
                missing_tools.append("Debian python3-uno (/usr/bin/python3)")
        except (OSError, subprocess.TimeoutExpired):
            missing_tools.append("Debian python3-uno (/usr/bin/python3)")
    return {
        "ok": python_ok and not missing_packages and not missing_files and not missing_tools,
        "python": {
            "version": ".".join(map(str, sys.version_info[:3])),
            "minimum": "3.10",
            "ok": python_ok,
        },
        "missing_packages": missing_packages,
        "missing_files": missing_files,
        "missing_tools": missing_tools,
        "optional_tools": {
            "pandoc": shutil.which("pandoc"),
            "libreoffice": shutil.which("libreoffice") or shutil.which("soffice"),
            "pdftoppm": shutil.which("pdftoppm"),
            "microsoft_word_automation": (
                "Windows COM / PowerShell"
                if os.name == "nt"
                else None
            ),
        },
    }


def print_human(status: dict) -> None:
    python = status["python"]
    marker = "通过" if python["ok"] else "不通过"
    print(f"Python {python['version']}（最低 {python['minimum']}）：{marker}")

    if status["missing_packages"]:
        print("缺少 Python 依赖：" + "、".join(status["missing_packages"]))
        print(f"经用户许可后安装：python3 -m pip install -r {SKILL_DIR / 'requirements.txt'}")
    else:
        print("Python 依赖：通过")

    if status["missing_files"]:
        print("缺少 Skill 文件：" + "、".join(status["missing_files"]))
    else:
        print("Skill 文件：通过")

    optional_tools = status["optional_tools"]
    if status["missing_tools"]:
        print("缺少目录分页/验收工具：" + "、".join(status["missing_tools"]))
    print("可选工具：")
    print(f"  pandoc（公式标记转换）：{optional_tools['pandoc'] or '未检测到'}")
    print(
        "  LibreOffice（DOCX 转 PDF）："
        f"{optional_tools['libreoffice'] or '未检测到，可使用 Word/WPS'}"
    )
    print(f"  pdftoppm（逐页渲染）：{optional_tools['pdftoppm'] or '未检测到'}")
    print(
        "  Microsoft Word 自动更新目录域："
        f"{optional_tools['microsoft_word_automation'] or '使用 Linux LibreOffice UNO 生成可见目录缓存'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="以 JSON 输出检查结果")
    args = parser.parse_args()

    status = collect_status()
    if args.json:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    else:
        print_human(status)
    return 0 if status["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
