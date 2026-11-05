"""Vector-first diagram helpers for Graphviz and Mermaid workflows."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable, Sequence


Node = tuple[str, str]
Edge = tuple[str, str, str]


STYLE = {
    "node_fill": "#F3F6F8",
    "node_stroke": "#5B6570",
    "primary": "#2A9D8F",
    "secondary": "#3B6FB6",
    "accent": "#C95C54",
    "text": "#202427",
}


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def graphviz_pipeline(
    nodes: Sequence[Node],
    edges: Sequence[Edge],
    rankdir: str = "LR",
    title: str | None = None,
) -> str:
    """Return a clean Graphviz DOT pipeline."""
    lines = [
        "digraph G {",
        "  graph [",
        f"    rankdir={_quote(rankdir)},",
        '    bgcolor="white",',
        '    pad="0.18",',
        '    nodesep="0.48",',
        '    ranksep="0.58"',
        "  ];",
        "  node [",
        '    shape="rect",',
        '    style="rounded,filled",',
        f'    fillcolor="{STYLE["node_fill"]}",',
        f'    color="{STYLE["node_stroke"]}",',
        f'    fontcolor="{STYLE["text"]}",',
        '    fontname="Arial",',
        '    fontsize="11",',
        '    penwidth="1.1",',
        '    margin="0.10,0.07"',
        "  ];",
        "  edge [",
        f'    color="{STYLE["secondary"]}",',
        '    fontname="Arial",',
        '    fontsize="9",',
        f'    fontcolor="{STYLE["text"]}",',
        '    arrowsize="0.7",',
        '    penwidth="1.2"',
        "  ];",
    ]
    if title:
        lines.append(f"  label={_quote(title)};")
        lines.append('  labelloc="t";')
        lines.append('  fontsize="12";')
        lines.append('  fontname="Arial";')
    for node_id, label in nodes:
        lines.append(f"  {_quote(node_id)} [label={_quote(label)}];")
    for source, target, label in edges:
        edge_label = f" [label={_quote(label)}]" if label else ""
        lines.append(f"  {_quote(source)} -> {_quote(target)}{edge_label};")
    lines.append("}")
    return "\n".join(lines) + "\n"


def mermaid_flowchart(
    nodes: Sequence[Node],
    edges: Sequence[Edge],
    direction: str = "LR",
) -> str:
    """Return a Mermaid flowchart with stable node IDs."""
    lines = [f"flowchart {direction}"]
    for node_id, label in nodes:
        safe_label = label.replace('"', "'")
        lines.append(f'  {node_id}["{safe_label}"]')
    for source, target, label in edges:
        if label:
            safe_label = label.replace('"', "'")
            lines.append(f'  {source} -->|"{safe_label}"| {target}')
        else:
            lines.append(f"  {source} --> {target}")
    lines.extend(
        [
            "  classDef default fill:#F3F6F8,stroke:#5B6570,color:#202427;",
            "  classDef accent fill:#EAF6F3,stroke:#2A9D8F,color:#202427;",
        ]
    )
    return "\n".join(lines) + "\n"


def write_text(path: str | Path, content: str) -> Path:
    """Write text content, creating parent directories."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8")
    return out


def render_graphviz(dot_path: str | Path, output_path: str | Path, fmt: str = "svg") -> Path | None:
    """Render DOT with Graphviz if the dot executable is available."""
    dot = shutil.which("dot")
    if not dot:
        return None
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([dot, f"-T{fmt}", str(dot_path), "-o", str(out)], check=True)
    return out


def render_mermaid(mmd_path: str | Path, output_path: str | Path) -> Path | None:
    """Render Mermaid if mmdc is available."""
    mmdc = shutil.which("mmdc")
    if not mmdc:
        return None
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([mmdc, "-i", str(mmd_path), "-o", str(out)], check=True)
    return out


__all__ = [
    "STYLE",
    "graphviz_pipeline",
    "mermaid_flowchart",
    "write_text",
    "render_graphviz",
    "render_mermaid",
]
