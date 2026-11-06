"""Smoke-test data figure for the research-figure-diagram skill."""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

from pubfig import PALETTE, add_panel_label, apply_style, despine, save_figure


def main() -> None:
    apply_style()
    rng = np.random.default_rng(7)
    x = np.arange(6)
    control = np.array([0.22, 0.28, 0.33, 0.43, 0.55, 0.64])
    treatment = np.array([0.20, 0.36, 0.50, 0.62, 0.76, 0.88])
    control_err = rng.uniform(0.015, 0.035, size=x.size)
    treatment_err = rng.uniform(0.015, 0.035, size=x.size)

    fig, ax = plt.subplots(figsize=(3.35, 2.25))
    ax.errorbar(x, control, yerr=control_err, marker="o", lw=1.2, label="Control")
    ax.errorbar(
        x,
        treatment,
        yerr=treatment_err,
        marker="o",
        lw=1.2,
        color=PALETTE["teal"],
        label="Treatment",
    )
    ax.set_xlabel("Time (h)")
    ax.set_ylabel("Normalized response")
    ax.set_ylim(0, 1.0)
    ax.legend(loc="upper left")
    despine(ax)
    add_panel_label(ax, "a")
    save_figure(fig, Path("/tmp/research-figure-diagram/examples/data_figure"))


if __name__ == "__main__":
    main()
