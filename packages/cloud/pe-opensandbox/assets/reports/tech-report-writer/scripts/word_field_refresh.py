#!/usr/bin/env python3
"""Refresh Word fields/TOCs automatically when desktop Microsoft Word is available.

The report writer always leaves TOC fields dirty and sets w:updateFields=true. On
Windows this helper additionally opens the DOCX in Microsoft Word, updates all
fields (including the main TOC and the custom-TC figure/table TOCs), and saves the
refreshed cached results so the document opens with populated catalogs.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


def _refresh_with_pywin32(path: Path) -> dict:
    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
    except Exception as exc:
        return {"success": False, "available": False, "method": "pywin32", "error": str(exc)}

    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        document = word.Documents.Open(
            str(path),
            ConfirmConversions=False,
            ReadOnly=False,
            AddToRecentFiles=False,
        )
        # Repaginate first so TOC page numbers are based on the final layout.
        # Updating Fields catches ordinary fields; updating every TablesOfContents
        # explicitly covers the main TOC plus the custom \f F / \f T catalogs.
        document.Repaginate()
        document.Fields.Update()
        toc_count = int(document.TablesOfContents.Count)
        if toc_count < 3:
            raise RuntimeError(
                f"expected main/figure/table TOCs, but Word exposed only {toc_count}"
            )
        for index in range(1, toc_count + 1):
            document.TablesOfContents(index).Update()
        document.Repaginate()
        document.Fields.Update()
        for index in range(1, toc_count + 1):
            document.TablesOfContents(index).Update()
        document.Save()
        return {
            "success": True,
            "available": True,
            "method": "word-com-pywin32",
            "tables_of_contents": toc_count,
        }
    except Exception as exc:
        return {"success": False, "available": True, "method": "word-com-pywin32", "error": str(exc)}
    finally:
        try:
            if document is not None:
                document.Close(SaveChanges=False)
        except Exception:
            pass
        try:
            if word is not None:
                word.Quit()
        except Exception:
            pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def _refresh_with_powershell(path: Path) -> dict:
    executable = shutil.which("powershell") or shutil.which("pwsh")
    if not executable:
        return {"success": False, "available": False, "method": "word-com-powershell", "error": "PowerShell not found"}
    escaped = str(path).replace("'", "''")
    script = rf"""
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {{
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open('{escaped}', $false, $false, $false)
  $doc.Repaginate()
  $null = $doc.Fields.Update()
  $count = $doc.TablesOfContents.Count
  if ($count -lt 3) {{ throw "Expected main/figure/table TOCs, but Word exposed only $count" }}
  for ($i = 1; $i -le $count; $i++) {{
    $doc.TablesOfContents.Item($i).Update()
  }}
  $doc.Repaginate()
  $null = $doc.Fields.Update()
  for ($i = 1; $i -le $count; $i++) {{
    $doc.TablesOfContents.Item($i).Update()
  }}
  $doc.Save()
  Write-Output "TOC_COUNT=$count"
}} finally {{
  if ($doc -ne $null) {{ $doc.Close($false) }}
  if ($word -ne $null) {{ $word.Quit() }}
}}
"""
    try:
        proc = subprocess.run(
            [executable, "-NoProfile", "-NonInteractive", "-Command", script],
            text=True,
            capture_output=True,
            timeout=120,
        )
    except Exception as exc:
        return {"success": False, "available": True, "method": "word-com-powershell", "error": str(exc)}
    if proc.returncode != 0:
        return {
            "success": False,
            "available": True,
            "method": "word-com-powershell",
            "error": (proc.stderr or proc.stdout).strip(),
        }
    count = None
    for line in proc.stdout.splitlines():
        if line.startswith("TOC_COUNT="):
            try:
                count = int(line.split("=", 1)[1])
            except ValueError:
                pass
    return {
        "success": True,
        "available": True,
        "method": "word-com-powershell",
        "tables_of_contents": count,
    }


def refresh_word_fields(path: str | os.PathLike[str]) -> dict:
    """Update and save all Word fields when Microsoft Word automation is usable.

    Non-Windows runtimes return ``available=False`` instead of attempting to use
    LibreOffice: LibreOffice does not preserve/refresh Word's custom TC/TOC \f
    catalogs reliably.  The DOCX still carries dirty fields and updateFields=true
    so a later Word open can refresh them.
    """
    path = Path(path).resolve()
    if not path.is_file():
        return {"success": False, "available": False, "method": None, "error": f"file not found: {path}"}
    if os.name != "nt":
        return {
            "success": False,
            "available": False,
            "method": None,
            "error": "Microsoft Word COM automation is only available on Windows",
        }

    first = _refresh_with_pywin32(path)
    if first.get("success"):
        return first
    second = _refresh_with_powershell(path)
    if second.get("success"):
        return second
    return {
        "success": False,
        "available": bool(first.get("available") or second.get("available")),
        "method": second.get("method") if second.get("available") else first.get("method"),
        "error": f"pywin32: {first.get('error', '')}; PowerShell: {second.get('error', '')}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("--require-word", action="store_true", help="Word 不可用或更新失败时返回非零状态")
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()
    result = refresh_word_fields(args.docx)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")
    if result.get("success"):
        return 0
    if args.require_word:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
