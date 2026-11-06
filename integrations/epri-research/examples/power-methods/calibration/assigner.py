from airalogy.assigner import AssignerResult, assigner


@assigner(assigned_fields=["points.error"], dependent_fields=["points.reference", "points.measured"], mode="auto")
def error(fields):
    return AssignerResult(assigned_fields={"points.error": fields["points.measured"] - fields["points.reference"]})


@assigner(assigned_fields=["slope", "intercept", "r2", "residual", "qc_pass"], dependent_fields=["points", "max_residual"], mode="auto")
def fit(fields):
    rows = [r.model_dump() if hasattr(r, "model_dump") else r for r in fields["points"]]
    if len(rows) < 3:
        raise ValueError("线性标定至少需要 3 个有效测量点")
    x = [r["reference"] for r in rows]
    y = [r["measured"] for r in rows]
    mx, my = sum(x) / len(x), sum(y) / len(y)
    xx = sum((v - mx) ** 2 for v in x)
    if xx <= 0:
        raise ValueError("标准值必须覆盖非零范围")
    slope = sum((a - mx) * (b - my) for a, b in zip(x, y)) / xx
    intercept = my - slope * mx
    errors = [b - (slope * a + intercept) for a, b in zip(x, y)]
    total = sum((v - my) ** 2 for v in y)
    if total <= 0:
        raise ValueError("测量值没有变化，不能评价线性拟合优度")
    residual = max(abs(v) for v in errors)
    return AssignerResult(assigned_fields={"slope": slope, "intercept": intercept, "r2": 1 - sum(v * v for v in errors) / total, "residual": residual, "qc_pass": residual <= fields["max_residual"]})
