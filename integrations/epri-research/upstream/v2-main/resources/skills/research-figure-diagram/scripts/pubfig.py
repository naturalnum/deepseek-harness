"""Publication figure helpers for the research-figure-diagram skill."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Sequence

import matplotlib as mpl
import matplotlib.pyplot as plt


PALETTE = {
    "text": "#202427",
    "neutral": "#6B7280",
    "light_neutral": "#D1D5DB",
    "blue": "#3B6FB6",
    "teal": "#2A9D8F",
    "orange": "#E9A441",
    "red": "#C95C54",
    "violet": "#8E6BBE",
}

COLOR_CYCLE = [
    PALETTE["blue"],
    PALETTE["teal"],
    PALETTE["orange"],
    PALETTE["red"],
    PALETTE["violet"],
    PALETTE["neutral"],
]


def apply_style(font_size: float = 7.0, font_family: str = "Arial") -> None:
    """Apply a restrained manuscript-style matplotlib configuration."""
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": [font_family, "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": font_size,
            "axes.labelsize": font_size,
            "axes.titlesize": font_size,
            "xtick.labelsize": max(font_size - 1, 5),
            "ytick.labelsize": max(font_size - 1, 5),
            "legend.fontsize": max(font_size - 1, 5),
            "axes.linewidth": 0.7,
            "axes.edgecolor": PALETTE["text"],
            "axes.labelcolor": PALETTE["text"],
            "xtick.color": PALETTE["text"],
            "ytick.color": PALETTE["text"],
            "xtick.major.width": 0.6,
            "ytick.major.width": 0.6,
            "xtick.major.size": 2.4,
            "ytick.major.size": 2.4,
            "legend.frameon": False,
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "savefig.facecolor": "white",
            "savefig.bbox": "tight",
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "axes.prop_cycle": mpl.cycler(color=COLOR_CYCLE),
        }
    )


def despine(ax: mpl.axes.Axes, top: bool = True, right: bool = True) -> None:
    """Remove top/right spines and keep remaining spines subtle."""
    if top:
        ax.spines["top"].set_visible(False)
    if right:
        ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(0.7)
    ax.spines["bottom"].set_linewidth(0.7)


def add_panel_label(
    ax: mpl.axes.Axes,
    label: str,
    x: float = -0.16,
    y: float = 1.06,
    size: float = 8.0,
) -> None:
    """Place a small bold manuscript panel label near an axes."""
    ax.text(
        x,
        y,
        label,
        transform=ax.transAxes,
        ha="left",
        va="bottom",
        fontsize=size,
        fontweight="bold",
        color=PALETTE["text"],
    )


def save_figure(
    fig: mpl.figure.Figure,
    path: str | Path,
    formats: Sequence[str] = ("svg", "pdf", "png"),
    dpi: int = 600,
) -> list[Path]:
    """Save a figure in multiple manuscript-friendly formats."""
    base = Path(path)
    base.parent.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for fmt in formats:
        suffix = fmt.lower().lstrip(".")
        out = base.with_suffix(f".{suffix}")
        kwargs = {"bbox_inches": "tight"}
        if suffix in {"png", "tif", "tiff"}:
            kwargs["dpi"] = dpi
        fig.savefig(out, **kwargs)
        written.append(out)
    return written


def set_shared_labels(
    fig: mpl.figure.Figure,
    xlabel: str | None = None,
    ylabel: str | None = None,
    x: float = 0.5,
    y: float = 0.5,
) -> None:
    """Add shared figure-level axis labels."""
    if xlabel:
        fig.supxlabel(xlabel, x=x, fontsize=mpl.rcParams["axes.labelsize"])
    if ylabel:
        fig.supylabel(ylabel, y=y, fontsize=mpl.rcParams["axes.labelsize"])


def figure_size(width: str = "single", height: float | None = None) -> tuple[float, float]:
    """Return common manuscript figure sizes in inches."""
    widths = {
        "single": 3.35,
        "one-half": 5.0,
        "double": 7.2,
    }
    w = widths.get(width, float(width))
    h = height if height is not None else w * 0.68
    return w, h


def label_axes(axes: Iterable[mpl.axes.Axes], labels: Iterable[str] | None = None) -> None:
    """Apply sequential panel labels to axes."""
    if labels is None:
        labels = "abcdefghijklmnopqrstuvwxyz"
    for ax, label in zip(axes, labels):
        add_panel_label(ax, label)


__all__ = [
    "PALETTE",
    "COLOR_CYCLE",
    "apply_style",
    "despine",
    "add_panel_label",
    "save_figure",
    "set_shared_labels",
    "figure_size",
    "label_axes",
]
