"""Validate local report images and copy compile-ready assets into a TeX project."""

from __future__ import annotations

import hashlib
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
import warnings
import xml.etree.ElementTree as ET

MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_SVG_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_ELEMENTS = set("svg g defs rect circle ellipse line polyline polygon path text tspan textPath title desc "
                   "linearGradient radialGradient stop clipPath mask marker use style".split())
LOCAL_FRAGMENT = re.compile(r"#[A-Za-z_][A-Za-z0-9_.:-]*")


def read_local_image(source_directory: Path, reference: str) -> tuple[bytes, str]:
    """Read a regular image under the Markdown directory without following symlinks."""

    reference = unquote(reference)
    parsed = urlsplit(reference)
    path = PurePosixPath(reference)
    if (parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or path.is_absolute()
            or ".." in path.parts or "\\" in reference or not path.parts):
        raise ValueError("Figure image must use a local relative path within the source Markdown directory")
    suffix = path.suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".pdf", ".svg"}:
        raise ValueError("Figure image format must be PNG, JPEG, PDF or static SVG")
    directory = os.open(source_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.parts[:-1]:
            next_directory = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_IMAGE_BYTES:
                raise ValueError("Figure image must be a regular file of at most 32 MiB")
            data = stream.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("Figure image exceeds 32 MiB")
    except OSError as exc:
        raise ValueError(f"Figure image is missing, unreadable or uses a symlink outside its source directory: {reference}") from exc
    finally:
        os.close(directory)
    return data, suffix


def validate_raster(data: bytes, suffix: str) -> None:
    """Decode the supplied PNG/JPEG and reject mismatched formats or oversized images."""

    try:
        from PIL import Image
    except ImportError as exc:
        raise ValueError("Pillow is required to validate PNG and JPEG figure images") from exc
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                expected = "PNG" if suffix == ".png" else "JPEG"
                if image.format != expected:
                    raise ValueError("Figure image format does not match its filename")
                if image.width <= 0 or image.height <= 0 or image.width * image.height > MAX_IMAGE_PIXELS:
                    raise ValueError("Figure image dimensions must be positive and at most 20 million pixels")
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
    except Exception as exc:
        raise ValueError(f"Invalid figure image format or data: {exc}") from exc


def validate_pdf(data: bytes) -> int:
    """Validate PDF figure pages and reject external file references and active content."""

    try:
        from pypdf import PdfReader
        from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, IndirectObject, NullObject, NumberObject
    except ImportError as exc:
        raise ValueError("pypdf is required to validate PDF figure images") from exc
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted or not reader.pages:
            raise ValueError("PDF figure images must contain readable, unencrypted pages")
        visited = set()

        def inspect(value, depth=0):
            if depth > 50:
                raise ValueError("PDF figure image object nesting exceeds the supported depth")
            if isinstance(value, IndirectObject):
                key = (value.idnum, value.generation)
                if key in visited:
                    return
                visited.add(key)
                value = value.get_object()
            if isinstance(value, DictionaryObject):
                if {"/F", "/UF", "/EF", "/URI", "/JS", "/AA", "/EmbeddedFiles", "/XFA"} & value.keys():
                    raise ValueError("PDF figure images cannot reference external files or active content")
                if "/OpenAction" in value:
                    destination = value["/OpenAction"]
                    if (not isinstance(destination, ArrayObject) or len(destination) < 2
                            or not isinstance(destination[0], IndirectObject)
                            or destination[0].get_object().get("/Type") != "/Page"
                            or destination[1] not in {"/XYZ", "/Fit", "/FitH", "/FitV", "/FitR", "/FitB", "/FitBH", "/FitBV"}
                            or not all(isinstance(item, (NumberObject, FloatObject, NullObject)) for item in destination[2:])):
                        raise ValueError("PDF figure images cannot contain active opening actions")
                if value.get("/S") in {"/JavaScript", "/Launch", "/GoToR", "/SubmitForm", "/ImportData"}:
                    raise ValueError("PDF figure images cannot contain external or active actions")
                for item in value.values():
                    inspect(item, depth + 1)
            elif isinstance(value, ArrayObject):
                for item in value:
                    inspect(item, depth + 1)

        inspect(reader.trailer)
        for page in reader.pages:
            if not all(math.isfinite(float(side)) and 0 < float(side) <= 14_400
                       for side in (page.mediabox.width, page.mediabox.height)):
                raise ValueError("PDF figure image page dimensions are invalid")
            page.get_contents()
        return len(reader.pages)
    except Exception as exc:
        raise ValueError(f"Invalid PDF figure image: {exc}") from exc


def validate_svg(data: bytes) -> None:
    """Accept static SVG shapes/text and local fragment references without external resources."""

    if len(data) > MAX_SVG_BYTES:
        raise ValueError("SVG figure images must be at most 2 MiB")
    try:
        text = data.decode("utf-8-sig")
        if re.search(r"<!DOCTYPE|<!ENTITY|<\?(?!xml(?:\s|\?>))", text, re.IGNORECASE):
            raise ValueError("SVG declarations, entities and processing instructions are unsupported")
        root = ET.fromstring(text, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
        if root.tag != "{" + SVG_NAMESPACE + "}svg":
            raise ValueError("SVG figure image requires the SVG namespace and root")
        viewbox = root.get("viewBox", "").replace(",", " ").split()
        units = {"": 1, "px": 1, "pt": 96 / 72, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4}
        dimensions = []
        for index, name in enumerate(("width", "height")):
            value = root.get(name)
            if value is None and len(viewbox) == 4:
                value = viewbox[index + 2]
            match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(px|pt|in|cm|mm)?", value or "")
            if not match:
                raise ValueError("SVG requires explicit positive canvas dimensions or a viewBox")
            dimension = float(match.group(1)) * units[match.group(2) or ""]
            if not math.isfinite(dimension) or not 0 < dimension <= 16_000:
                raise ValueError("SVG canvas dimensions are unsupported")
            dimensions.append(dimension)
        if dimensions[0] * dimensions[1] > MAX_IMAGE_PIXELS:
            raise ValueError("SVG canvas exceeds 20 million pixels")
        for element in root.iter():
            if not isinstance(element.tag, str) or not element.tag.startswith("{" + SVG_NAMESPACE + "}"):
                raise ValueError("SVG foreign elements are unsupported")
            tag = element.tag.split("}", 1)[1]
            if tag not in SVG_ELEMENTS:
                raise ValueError(f"SVG element is unsupported: {tag}")
            values = list(element.attrib.values())
            if tag == "style":
                values.append("".join(element.itertext()))
            for attribute, value in element.attrib.items():
                if attribute.startswith("{") and attribute.split("}", 1)[0][1:] not in {
                    "http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace",
                }:
                    raise ValueError("SVG foreign attributes are unsupported")
                name = attribute.rsplit("}", 1)[-1].lower()
                if name.startswith("on") or name in {"base", "src"}:
                    raise ValueError("SVG event handlers and external resource attributes are unsupported")
                if name == "href" and not LOCAL_FRAGMENT.fullmatch(value.strip()):
                    raise ValueError("SVG references must be local fragments")
            for value in values:
                if "\\" in value or "@" in value or "/*" in value or "*/" in value:
                    raise ValueError("SVG CSS escapes, comments and resource rules are unsupported")
                for reference in re.findall(r"url\s*\((.*?)\)", value, re.IGNORECASE | re.DOTALL):
                    if not LOCAL_FRAGMENT.fullmatch(reference.strip().strip("\"'")):
                        raise ValueError("SVG URL references must be local fragments")
    except (UnicodeError, ET.ParseError, ValueError) as exc:
        raise ValueError(f"Invalid or unsupported SVG figure image: {exc}") from exc


def svg_to_pdf(data: bytes) -> bytes:
    """Convert validated SVG with existing Draw using a private profile and bounded child lifetime."""

    validate_svg(data)
    executable = shutil.which("libreoffice")
    if executable is None:
        raise ValueError("LibreOffice Draw is required to convert SVG figure images to PDF")
    with tempfile.TemporaryDirectory(prefix="latex-svg-") as directory:
        root = Path(directory)
        source = root / "figure.svg"
        source.write_bytes(data)
        for name in ("cache", "config"):
            (root / name).mkdir()
        env = {key: value for key, value in os.environ.items()
               if not any(token in key.upper() for token in ("KEY", "SECRET", "TOKEN", "PASSWORD"))}
        env.update(XDG_CACHE_HOME=str(root / "cache"), XDG_CONFIG_HOME=str(root / "config"),
                   GSETTINGS_BACKEND="memory", SAL_USE_VCLPLUGIN="svp")
        command = [executable, "-env:UserInstallation=" + (root / "profile").as_uri(),
                   "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to",
                   "pdf:draw_pdf_Export", "--outdir", str(root), str(source)]
        process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            output, _ = process.communicate(timeout=30)
        except subprocess.TimeoutExpired as exc:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The group exited between the timeout and cancellation.
            process.communicate()
            raise ValueError("SVG figure image conversion timed out after 30 seconds") from exc
        destination = root / "figure.pdf"
        if process.returncode or not destination.is_file():
            raise ValueError("SVG figure image conversion failed: " + output.decode(errors="replace")[-1500:])
        if destination.stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError("Converted SVG figure image exceeds 32 MiB")
        converted = destination.read_bytes()
        if validate_pdf(converted) != 1:
            raise ValueError("SVG figure image conversion must produce exactly one PDF page")
        return converted


def prepare_image(source_directory: Path, project_directory: Path, reference: str) -> str:
    """Return a safe project-relative filename after validating and copying the referenced image."""

    data, suffix = read_local_image(source_directory, reference)
    if suffix == ".svg":
        data, suffix = svg_to_pdf(data), ".pdf"
    elif suffix == ".pdf":
        validate_pdf(data)
    else:
        validate_raster(data, suffix)
    assets = project_directory / "report-images"
    assets.mkdir(parents=True, exist_ok=True)
    if assets.is_symlink():
        raise ValueError("Figure image asset directory must not be a symlink")
    directory = os.open(assets, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = hashlib.sha256(data).hexdigest() + suffix
    try:
        try:
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
        except FileExistsError:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("Figure image asset must be a regular file")
                if stream.read(MAX_IMAGE_BYTES + 1) != data:
                    raise ValueError("Figure image asset conflicts with the validated source")
        else:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
    except OSError as exc:
        raise ValueError("Figure image asset cannot be safely written") from exc
    finally:
        os.close(directory)
    return "report-images/" + name
