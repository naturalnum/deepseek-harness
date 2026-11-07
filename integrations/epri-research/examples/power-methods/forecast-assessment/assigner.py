from math import sqrt
from airalogy.assigner import AssignerResult, assigner


@assigner(assigned_fields=["samples.absolute_error"], dependent_fields=["samples.actual", "samples.predicted"], mode="auto")
def error(fields):
    return AssignerResult(assigned_fields={"samples.absolute_error": abs(fields["samples.predicted"] - fields["samples.actual"])})


@assigner(assigned_fields=["count", "mae", "rmse", "qc_pass"], dependent_fields=["samples", "max_mae"], mode="auto")
def assess(fields):
    rows = [r.model_dump() if hasattr(r, "model_dump") else r for r in fields["samples"]]
    if not rows:
        raise ValueError("至少需要一个实际负荷与预测负荷对应的样本")
    times = [r["time"] for r in rows]
    if len(set(times)) != len(times):
        raise ValueError("时刻重复，请先核对数据对应关系")
    errors = [r["predicted"] - r["actual"] for r in rows]
    mae = sum(abs(v) for v in errors) / len(errors)
    return AssignerResult(assigned_fields={"count": len(rows), "mae": mae, "rmse": sqrt(sum(v * v for v in errors) / len(errors)), "qc_pass": mae <= fields["max_mae"]})
