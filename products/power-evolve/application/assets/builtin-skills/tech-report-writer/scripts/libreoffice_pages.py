#!/usr/bin/python3
"""Isolated UNO layout worker. Run with Debian's /usr/bin/python3, not the venv."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

import uno
from com.sun.star.beans import PropertyValue


def property_value(name, value):
    prop = PropertyValue()
    prop.Name, prop.Value = name, value
    return prop


def layout(path: Path, names: list[str], pdf: Path | None = None) -> dict:
    executable = shutil.which("libreoffice") or shutil.which("soffice")
    if not executable:
        raise RuntimeError("LibreOffice is required for Linux catalog pagination")
    with tempfile.TemporaryDirectory(prefix="report-uno-") as profile:
        pipe = "report" + uuid.uuid4().hex
        process = subprocess.Popen([
            executable, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
            "-env:UserInstallation=" + Path(profile).as_uri(),
            "--accept=pipe,name=" + pipe + ";urp;StarOffice.ComponentContext",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        document = desktop = None
        try:
            local = uno.getComponentContext()
            resolver = local.ServiceManager.createInstanceWithContext(
                "com.sun.star.bridge.UnoUrlResolver", local)
            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None:
                    raise RuntimeError("LibreOffice exited before the UNO connection")
                try:
                    context = resolver.resolve(
                        "uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("LibreOffice UNO connection timed out")
                    time.sleep(0.1)
            desktop = context.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", context)
            document = desktop.loadComponentFromURL(path.as_uri(), "_blank", 0, (
                property_value("Hidden", True), property_value("UpdateDocMode", 0),
                property_value("ReadOnly", True),
            ))
            if document is None:
                raise RuntimeError("LibreOffice could not load the pagination copy")
            # Fields in this copy are materialized. Do not let the DOCX importer
            # replace Word's custom TC catalogs with incompatible Writer indexes.
            document.refresh()
            pages = {}
            controller = document.CurrentController
            view = controller.ViewCursor
            for name in names:
                if not document.Bookmarks.hasByName(name):
                    raise RuntimeError("Lost pagination bookmark: " + name)
                anchor = document.Bookmarks.getByName(name).Anchor
                cursor = anchor.Text.createTextCursorByRange(anchor.Start)
                cursor.gotoEndOfParagraph(False)
                cursor.CharHidden = False
                cursor.CharHeight = 1
                field = document.createInstance("com.sun.star.text.TextField.PageNumber")
                # DOCX imports can suppress the Writer page-style numbering
                # while preserving section offsets in explicit PAGE fields.
                # Read the true virtual number, then apply the source DOCX format.
                field.NumberingType = 4  # ARABIC
                anchor.Text.insertTextContent(cursor, field, False)
                view.gotoRange(field.Anchor, False)
                document.TextFields.refresh()
                document.refresh()
                label = field.getPresentation(False).strip()
                pages[name] = {"label": label, "physical": int(view.Page)}
                anchor.Text.removeTextContent(field)
                if not label:
                    raise RuntimeError("Empty page label for bookmark: " + name + " on physical page " + str(pages[name]["physical"]))
            if pdf:
                pdf.parent.mkdir(parents=True, exist_ok=True)
                document.storeToURL(pdf.as_uri(), (
                    property_value("FilterName", "writer_pdf_Export"),
                    property_value("Overwrite", True),
                ))
            return {"pages": pages, "page_count": int(controller.PageCount)}
        finally:
            if document is not None:
                document.close(True)
            if desktop is not None:
                desktop.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))
    def timed_out(_signum, _frame):
        raise RuntimeError("UNO pagination timed out")
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(100)
    try:
        result = layout(Path(request["docx"]).resolve(), request["bookmarks"],
                        Path(request["pdf"]).resolve() if request.get("pdf") else None)
        print(json.dumps({"success": True, **result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
