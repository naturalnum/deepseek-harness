"""Snapshot bounded local report figures; SVG reads only static, internal references."""
from __future__ import annotations

import base64
from io import BytesIO
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from bs4 import BeautifulSoup
from PIL import Image

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_SVG_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
SVG_NS = "http://www.w3.org/2000/svg"
ElementTree.register_namespace("", SVG_NS)
SVG_TAGS = {"svg", "g", "defs", "marker", "rect", "text", "tspan", "line", "path",
            "circle", "ellipse", "polygon", "polyline", "clipPath", "linearGradient",
            "radialGradient", "stop", "pattern", "use", "title", "desc"}
SVG_ATTRIBUTES = {"id", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry",
                  "width", "height", "viewBox", "preserveAspectRatio", "fill", "fill-opacity",
                  "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
                  "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "opacity",
                  "transform", "d", "points", "font-family", "font-size", "font-weight",
                  "font-style", "text-anchor", "dominant-baseline", "dx", "dy", "style",
                  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight",
                  "refX", "refY", "orient", "markerUnits", "clip-path", "clipPathUnits",
                  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
                  "spreadMethod", "fx", "fy", "patternUnits", "patternContentUnits", "patternTransform"}
FRAGMENT_RE = re.compile(r"#[A-Za-z_][\w.:-]*\Z")


def _read_local(src: str, root: Path) -> bytes:
    path = unquote(src)
    url = urlsplit(path)
    parts = PurePosixPath(path).parts
    if (not parts or url.scheme or url.netloc or url.query or url.fragment
            or path.startswith("/") or "\\" in path or "\x00" in path or ".." in parts):
        raise ValueError("report image must be a relative local path inside the material directory")
    descriptors = []
    try:
        current = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(current)
        for component in parts[:-1]:
            current = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            descriptors.append(current)
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        descriptors.append(descriptor)
        info = os.fstat(descriptor)
        limit = MAX_SVG_BYTES if path.lower().endswith(".svg") else MAX_IMAGE_BYTES
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError("report image is not a bounded regular file")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("report image exceeds the byte limit")
        return data
    except OSError as error:
        raise ValueError("report image is missing, unreadable or uses a symlink") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _raster_format(data: bytes) -> str:
    try:
        with Image.open(BytesIO(data)) as image:
            image_format = image.format
            width, height = image.size
            if image_format not in {"PNG", "JPEG"} or not 0 < width * height <= MAX_IMAGE_PIXELS:
                raise ValueError("report image must be a bounded PNG or JPEG")
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
        return image_format.lower()
    except (OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise ValueError("report image is not a valid PNG or JPEG") from error


def validate_svg(data: bytes) -> tuple[bytes, float, float]:
    """Accept static SVG graphics with finite dimensions and only #fragment references."""
    if len(data) > MAX_SVG_BYTES:
        raise ValueError("report SVG exceeds the byte limit")
    try:
        text = data.decode("utf-8-sig")
        text = re.sub(r"^\s*<\?xml\s[^?]*\?>", "", text, count=1)
        if re.search(r"<!DOCTYPE|<!ENTITY|<\?", text, re.IGNORECASE):
            raise ValueError("report SVG cannot contain a DTD, entity or processing instruction")
        root = ElementTree.fromstring(text)
    except (UnicodeError, ElementTree.ParseError) as error:
        raise ValueError("report SVG must be valid UTF-8 XML") from error
    if root.tag != f"{{{SVG_NS}}}svg":
        raise ValueError("report SVG has an invalid root")
    pending, count, has_graphic = [(root, 0)], 0, False
    while pending:
        node, depth = pending.pop()
        count += 1
        if depth > 64 or count > 10_000 or node.tag not in {f"{{{SVG_NS}}}{tag}" for tag in SVG_TAGS}:
            raise ValueError("report SVG contains unsupported or excessive elements")
        has_graphic = has_graphic or node.tag in {f"{{{SVG_NS}}}{tag}" for tag in
                                               ("rect", "text", "line", "path", "circle", "ellipse", "polygon", "polyline", "use")}
        for name, value in node.attrib.items():
            if name in {"href", "{http://www.w3.org/1999/xlink}href"}:
                if not FRAGMENT_RE.fullmatch(value):
                    raise ValueError("report SVG references must be internal fragments")
            elif name not in SVG_ATTRIBUTES:
                raise ValueError("report SVG contains an unsupported attribute")
            if "\\" in value or "@" in value or "/*" in value:
                raise ValueError("report SVG cannot contain external or escaped CSS references")
            for reference in re.findall(r"url\s*\(([^)]*)\)", value, re.IGNORECASE):
                if not FRAGMENT_RE.fullmatch(reference.strip().strip("\"'")):
                    raise ValueError("report SVG URL references must be internal fragments")
            if "url" in value.lower() and not re.fullmatch(r".*?(?:url\s*\([^)]*\).*?)+", value, re.IGNORECASE):
                raise ValueError("report SVG contains an invalid URL reference")
        pending.extend((child, depth + 1) for child in node)
    if not has_graphic:
        raise ValueError("report SVG does not contain a graphic")
    def dimension(name):
        value = root.get(name, "")
        match = re.fullmatch(r"(\d+(?:\.\d+)?)(?:px)?", value)
        return float(match.group(1)) if match else None
    width, height = dimension("width"), dimension("height")
    if width is None or height is None:
        try:
            _, _, width, height = [float(value) for value in root.get("viewBox", "").replace(",", " ").split()]
        except ValueError as error:
            raise ValueError("report SVG requires finite width and height or viewBox") from error
    if not all(math.isfinite(value) and 0 < value <= 8192 for value in (width, height)) or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("report SVG dimensions exceed the limit")
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True), width, height


def _run_converter(command: list[str], environment: dict[str, str]) -> None:
    process = subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        process.wait(timeout=30)
        if process.returncode:
            raise ValueError("report SVG conversion failed")
    except subprocess.TimeoutExpired as error:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise ValueError("report SVG conversion timed out") from error


def svg_to_png(data: bytes) -> bytes:
    """Render a checked SVG through the existing offline Draw and Poppler toolchain."""
    checked, width, height = validate_svg(data)
    office, poppler = shutil.which("libreoffice"), shutil.which("pdftoppm")
    if not office or not poppler:
        raise ValueError("local SVG requires LibreOffice Draw and pdftoppm")
    from pypdf import PdfReader
    with tempfile.TemporaryDirectory(prefix="report-image-") as directory:
        root = Path(directory)
        source = root / "figure.svg"
        source.write_bytes(checked)
        environment = os.environ.copy()
        environment.update({"XDG_CACHE_HOME": str(root / "cache"), "XDG_CONFIG_HOME": str(root / "config"),
                            "GSETTINGS_BACKEND": "memory", "SAL_USE_VCLPLUGIN": "svp"})
        _run_converter([office, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
                        "-env:UserInstallation=" + (root / "profile").as_uri(),
                        "--convert-to", "pdf:draw_pdf_Export", "--outdir", str(root), str(source)], environment)
        pdf = root / "figure.pdf"
        if not pdf.is_file() or not 0 < pdf.stat().st_size <= MAX_IMAGE_BYTES:
            raise ValueError("report SVG conversion did not produce a bounded PDF")
        try:
            reader = PdfReader(pdf, strict=True)
            if reader.is_encrypted or len(reader.pages) != 1:
                raise ValueError("report SVG conversion must produce one PDF page")
            page = reader.pages[0]
            pw, ph = float(page.mediabox.width), float(page.mediabox.height)
            if not all(math.isfinite(value) and 0 < value <= 8192 for value in (pw, ph)) or abs(pw / ph / (width / height) - 1) > 0.03:
                raise ValueError("report SVG conversion changed the drawing dimensions")
        except Exception as error:
            raise ValueError("report SVG conversion produced an invalid PDF") from error
        _run_converter([poppler, "-f", "1", "-l", "1", "-singlefile", "-scale-to", "1800", "-png",
                        str(pdf), str(root / "figure")], environment)
        png = root / "figure.png"
        if not png.is_file() or not 0 < png.stat().st_size <= MAX_IMAGE_BYTES:
            raise ValueError("report SVG conversion did not produce a bounded PNG")
        result = png.read_bytes()
        _raster_format(result)
        return result


def local_image_uri(src: str, material_root: Path) -> str:
    """Freeze a local PNG/JPEG or checked SVG into a self-contained Word image source."""
    data = _read_local(src, material_root)
    if unquote(src).lower().endswith(".svg"):
        data = svg_to_png(data)
    image_format = _raster_format(data)
    return f"data:image/{image_format};base64," + base64.b64encode(data).decode("ascii")


def localize_html_images(content: str, material_root: Path) -> str:
    """Apply the same local policy to legacy HTML chapter images before Word parsing."""
    if "<img" not in content.lower():
        return content
    soup = BeautifulSoup(content, "html.parser")
    for image in soup.find_all("img"):
        src = image.get("src", "")
        if not isinstance(src, str):
            raise ValueError("report image has an invalid source")
        if src.startswith("data:"):
            match = re.fullmatch(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)", src)
            if not match or len(src) > 14 * 1024 * 1024:
                raise ValueError("report image has an invalid inline source")
            try:
                data = base64.b64decode(match.group(2), validate=True)
            except ValueError as error:
                raise ValueError("report image has invalid inline bytes") from error
            if len(data) > MAX_IMAGE_BYTES or _raster_format(data) != match.group(1):
                raise ValueError("report image has invalid inline bytes")
        else:
            image["src"] = local_image_uri(src, material_root)
    return str(soup)
