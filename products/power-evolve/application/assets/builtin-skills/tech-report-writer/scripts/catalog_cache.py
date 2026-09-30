"""Populate Word TOC caches using actual LibreOffice section page labels.

Only document.xml changes; Word's TC instructions, styles and section properties
are retained. A disposable copy materializes catalog fields for UNO pagination.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import subprocess
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED

from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NS = {"w": W[1:-1]}


def _text(paragraph):
    return "".join(
        node.text or "" for node in paragraph.iter(W + "t"))


def _instruction(paragraph):
    return "".join(node.text or "" for node in paragraph.iter(W + "instrText"))


def _load(path):
    with ZipFile(path) as archive:
        files = {item.filename: (item, archive.read(item.filename)) for item in archive.infolist()}
    return files, etree.fromstring(files["word/document.xml"][1])


def _save(path, files, root):
    xml = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name, (info, data) in files.items():
            archive.writestr(info, xml if name == "word/document.xml" else data)


def _ranges(root):
    body = root.find(W + "body")
    children = list(body)
    result = {}
    for index, paragraph in enumerate(children):
        instruction = _instruction(paragraph)
        if not re.search(r"\bTOC\b", instruction):
            continue
        marker = re.search(r"\\f\s+([FT])(?:\s|$)", instruction)
        key = marker.group(1) if marker else "C"
        nodes = []
        depth = 0
        opened = False
        for node in children[index:]:
            nodes.append(node)
            for field in node.iter(W + "fldChar"):
                kind = field.get(W + "fldCharType")
                if kind == "begin":
                    depth += 1
                    opened = True
                elif kind == "end":
                    depth -= 1
            if opened and depth == 0:
                break
        else:
            raise ValueError("Unterminated TOC field: " + key)
        if key in result:
            raise ValueError("Duplicate TOC field: " + key)
        result[key] = (instruction, nodes)
    if set(result) != {"C", "F", "T"}:
        raise ValueError("Expected main, figure and table TOC fields")
    return result


def _bookmark(paragraph, name, identifier, at_end=False):
    old = next((b for b in paragraph.iter(W + "bookmarkStart") if b.get(W + "name") == name), None)
    if old is not None:
        return
    start = etree.Element(W + "bookmarkStart", {W + "id": str(identifier), W + "name": name})
    end = etree.Element(W + "bookmarkEnd", {W + "id": str(identifier)})
    if at_end:
        # Writer drops zero-width bookmarks at paragraph ends. Anchor the end
        # range to the final visible cache run (the page label) instead.
        visible = next((node for node in reversed(list(paragraph))
                        if any((text.text or "").strip() for text in node.iter(W + "t"))), None)
        if visible is None:
            raise ValueError("Cannot anchor an empty catalog end")
        position = paragraph.index(visible)
        paragraph.insert(position, start)
        paragraph.insert(position + 2, end)
        return
    position = 1 if paragraph.find(W + "pPr") is not None else 0
    paragraph.insert(position, start)
    paragraph.insert(position + 1, end)


def _entries(files, root):
    # Rebuild only our anchors so insertion/deletion of headings cannot leave
    # duplicate names or bind a later refresh to an obsolete paragraph.
    owned = [node for node in root.iter(W + "bookmarkStart")
             if re.fullmatch(r"PEEntry\d+|PECatalog[CFT](?:Start|End)", node.get(W + "name", ""))]
    owned_ids = {node.get(W + "id") for node in owned}
    for node in owned + [node for node in root.iter(W + "bookmarkEnd") if node.get(W + "id") in owned_ids]:
        node.getparent().remove(node)
    ranges = _ranges(root)
    excluded = {id(node) for _, nodes in ranges.values() for node in nodes}
    styles = etree.fromstring(files["word/styles.xml"][1])
    levels = {}
    for style in styles.findall(W + "style"):
        level = style.find("w:pPr/w:outlineLvl", NS)
        if level is not None:
            levels[style.get(W + "styleId")] = int(level.get(W + "val")) + 1
    identifier = max([int(b.get(W + "id", "0")) for b in root.iter(W + "bookmarkStart")] + [0]) + 1
    entries = {"C": [], "F": [], "T": []}
    children = list(root.find(W + "body"))
    for index, paragraph in enumerate(children):
        if paragraph.tag != W + "p" or id(paragraph) in excluded:
            continue
        tc = re.search(r'TC\s+"([^"]+)"\s+\\f\s+([CFT])', _instruction(paragraph))
        own = paragraph.find("w:pPr/w:outlineLvl", NS)
        style = paragraph.find("w:pPr/w:pStyle", NS)
        level = int(own.get(W + "val")) + 1 if own is not None else levels.get(
            style.get(W + "val") if style is not None else None, 0)
        if tc:
            key, title, level = tc.group(2), tc.group(1), 1
        elif 1 <= level <= 3 and _text(paragraph).strip():
            key, title = "C", _text(paragraph).strip()
        else:
            continue
        name = "PEEntry" + str(sum(map(len, entries.values())))
        _bookmark(paragraph, name, identifier)
        identifier += 1
        section = next((s for node in children[index:] for s in (
            [node] if node.tag == W + "sectPr" else node.findall("w:pPr/w:sectPr", NS))), None)
        numbering = section.find(W + "pgNumType") if section is not None else None
        number_format = numbering.get(W + "fmt", "decimal") if numbering is not None else "decimal"
        entries[key].append({"title": title, "level": level, "bookmark": name, "format": number_format})
    if not any(e["title"] not in {"内容摘要", "ABSTRACT"} for e in entries["C"]):
        raise ValueError("Main TOC has no body headings")
    for key, (_, nodes) in ranges.items():
        if not any(_text(node).strip() for node in nodes):
            continue
        _bookmark(nodes[0], "PECatalog" + key + "Start", identifier)
        _bookmark(nodes[-1], "PECatalog" + key + "End", identifier + 1, at_end=True)
        identifier += 2
    return entries


def _run(kind, value=""):
    run = etree.Element(W + "r")
    if kind == "text":
        etree.SubElement(run, W + "t").text = value
    elif kind == "instr":
        node = etree.SubElement(run, W + "instrText")
        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        node.text = value
    elif kind == "tab":
        etree.SubElement(run, W + "tab")
    else:
        etree.SubElement(run, W + "fldChar", {W + "fldCharType": kind, W + "dirty": "false"})
    return run


def _populate(root, entries, pages, style_ids):
    body = root.find(W + "body")
    for key, (instruction, originals) in _ranges(root).items():
        section = next((copy.deepcopy(s) for node in originals
                        for s in node.findall("w:pPr/w:sectPr", NS)), None)
        replacement = []
        for entry in entries[key]:
            paragraph = etree.Element(W + "p")
            properties = etree.SubElement(paragraph, W + "pPr")
            etree.SubElement(properties, W + "pStyle", {W + "val": style_ids[entry["level"]]})
            tabs = etree.SubElement(properties, W + "tabs")
            etree.SubElement(tabs, W + "tab", {W + "val": "right", W + "leader": "dot", W + "pos": "9072"})
            etree.SubElement(properties, W + "spacing", {W + "before": "0", W + "after": "0", W + "line": "240", W + "lineRule": "auto"})
            paragraph.append(_run("text", entry["title"]))
            paragraph.append(_run("tab"))
            paragraph.append(_run("text", pages.get(entry["bookmark"], {}).get("label", "1")))
            replacement.append(paragraph)
        if not replacement:
            replacement = [etree.Element(W + "p")]
        first = replacement[0]
        offset = 1 if first.find(W + "pPr") is not None else 0
        for run in reversed([_run("begin"), _run("instr", instruction), _run("separate")]):
            first.insert(offset, run)
        replacement[-1].append(_run("end"))
        if section is not None:
            properties = replacement[-1].find(W + "pPr")
            if properties is None:
                properties = etree.Element(W + "pPr")
                replacement[-1].insert(0, properties)
            properties.append(section)
        position = body.index(originals[0])
        for node in originals:
            body.remove(node)
        for i, node in enumerate(replacement):
            body.insert(position + i, node)


def _materialize(root):
    # The Linux importer loses empty/custom Word catalogs. Render cached entries
    # as ordinary paragraphs in a disposable copy, retaining pagination anchors.
    for _, nodes in _ranges(root).values():
        for paragraph in nodes:
            for run in list(paragraph):
                if run.tag == W + "r" and any(child.tag in {W + "instrText", W + "fldChar"} for child in run):
                    paragraph.remove(run)


def paginate(path, pdf=None):
    files, root = _load(path)
    entries = _entries(files, root)
    catalog_bookmarks = ["PECatalog" + key + boundary for key, (_, nodes) in _ranges(root).items()
                         if any(_text(node).strip() for node in nodes) for boundary in ("Start", "End")]
    with tempfile.TemporaryDirectory(prefix="report-pagination-") as directory:
        directory = Path(directory)
        copy_path = directory / "layout.docx"
        _materialize(root)
        _save(copy_path, files, root)
        request = directory / "request.json"
        request.write_text(json.dumps({"docx": str(copy_path), "bookmarks": [
            e["bookmark"] for group in entries.values() for e in group] + catalog_bookmarks,
                "pdf": str(pdf) if pdf else None}), encoding="utf-8")
        process = subprocess.run(["/usr/bin/python3", str(Path(__file__).with_name("libreoffice_pages.py")), str(request)],
                                 text=True, capture_output=True, timeout=120)
        try:
            result = json.loads(process.stdout)
        except ValueError:
            raise RuntimeError("UNO pagination failed: " + (process.stderr or process.stdout).strip())
        if process.returncode or not result.get("success"):
            raise RuntimeError("UNO pagination failed: " + result.get("error", process.stderr))
        for group in entries.values():
            for entry in group:
                if entry["format"] in {"lowerRoman", "upperRoman"}:
                    label = _roman(int(result["pages"][entry["bookmark"]]["label"]))
                    result["pages"][entry["bookmark"]]["label"] = label.lower() if entry["format"] == "lowerRoman" else label
        return {**result, "entries": entries}


def _roman(number):
    if number < 1:
        raise ValueError("Invalid front matter page number")
    text = ""
    for value, symbol in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
                          (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
                          (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        count, number = divmod(number, value)
        text += symbol * count
    return text


def refresh_catalogs(path):
    path = Path(path).resolve()
    files, root = _load(path)
    entries = _entries(files, root)
    styles = etree.fromstring(files["word/styles.xml"][1])
    style_ids = {}
    for style in styles.findall(W + "style"):
        name = style.find(W + "name")
        match = re.fullmatch(r"toc ([1-3])", name.get(W + "val", ""), re.I) if name is not None else None
        if match:
            style_ids[int(match.group(1))] = style.get(W + "styleId")
    if set(style_ids) != {1, 2, 3}:
        raise ValueError("Missing TOC 1/2/3 styles")
    previous = {}
    # Work on a disposable candidate: failed convergence must not publish a
    # partially populated document or replace the caller's input.
    with tempfile.TemporaryDirectory(prefix="report-catalog-") as directory:
        candidate = Path(directory) / "candidate.docx"
        for iteration in range(1, 7):
            _populate(root, entries, previous, style_ids)
            _save(candidate, files, root)
            result = paginate(candidate)
            if result["pages"] == previous:
                _save(path, files, root)
                return {"success": True, "available": True, "method": "libreoffice-uno-cache",
                        "tables_of_contents": 3, "iterations": iteration,
                        "page_count": result["page_count"]}
            previous = result["pages"]
    raise RuntimeError("Catalog page labels did not converge after six layout passes")
