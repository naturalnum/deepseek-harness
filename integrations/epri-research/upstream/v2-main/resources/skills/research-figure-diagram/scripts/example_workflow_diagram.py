"""Smoke-test workflow diagram for the research-figure-diagram skill."""

from pathlib import Path

from diagram_helpers import graphviz_pipeline, mermaid_flowchart, render_graphviz, write_text


def main() -> None:
    out_dir = Path("/tmp/research-figure-diagram/examples")
    nodes = [
        ("data", "Raw data"),
        ("qc", "Quality control"),
        ("features", "Feature matrix"),
        ("model", "Model"),
        ("eval", "Evaluation"),
    ]
    edges = [
        ("data", "qc", "filter"),
        ("qc", "features", "encode"),
        ("features", "model", "train"),
        ("model", "eval", "validate"),
    ]
    dot = graphviz_pipeline(nodes, edges, title="Research workflow")
    dot_path = write_text(out_dir / "workflow.dot", dot)
    render_graphviz(dot_path, out_dir / "workflow.svg")
    mmd = mermaid_flowchart(
        [("A", "Raw data"), ("B", "Quality control"), ("C", "Model"), ("D", "Evaluation")],
        [("A", "B", "filter"), ("B", "C", "train"), ("C", "D", "validate")],
    )
    write_text(out_dir / "workflow.mmd", mmd)


if __name__ == "__main__":
    main()
