from airalogy.assigner import AssignerResult, assigner


@assigner(assigned_fields=["measurements.missing_rate"],
          dependent_fields=["measurements.expected", "measurements.valid"], mode="auto")
def calculate_row(dependent_fields):
    expected = dependent_fields["measurements.expected"]
    valid = dependent_fields["measurements.valid"]
    if expected <= 0 or valid < 0 or valid > expected:
        raise ValueError("有效采样点必须在 0 到应有采样点之间，应有采样点必须大于 0")
    return AssignerResult(assigned_fields={"measurements.missing_rate": round((expected - valid) / expected * 100, 4)})


@assigner(assigned_fields=["expected_total", "valid_total", "missing_rate"],
          dependent_fields=["measurements"], mode="auto")
def summarize(dependent_fields):
    rows = [row.model_dump() if hasattr(row, "model_dump") else row for row in dependent_fields["measurements"]]
    expected = sum(row["expected"] for row in rows)
    valid = sum(row["valid"] for row in rows)
    if expected <= 0 or any(row["valid"] > row["expected"] for row in rows):
        raise ValueError("请核对采样数量")
    return AssignerResult(assigned_fields={"expected_total": expected, "valid_total": valid,
                                         "missing_rate": round((expected - valid) / expected * 100, 4)})
