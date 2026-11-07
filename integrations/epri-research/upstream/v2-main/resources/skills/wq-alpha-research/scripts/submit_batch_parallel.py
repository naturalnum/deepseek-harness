"""Parallel simulate, serially submit WQ BRAIN alpha candidates.

This is a throughput-oriented companion to submit_batch.py:

- starts several simulations concurrently
- collects metrics as simulations complete
- sorts passing candidates by Fitness/Sharpe
- applies the same local PnL-correlation gate
- submits and verifies one alpha at a time

Keep submission serial so newly ACTIVE alphas immediately join the correlation
gate before the next candidate is considered.
"""
from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

from load_alpha_candidates import load_candidates
from submit_batch import (
    ALPHAS,
    ALPHA_DB_PATH,
    SKILL_DIR,
    build_payload,
    correlation_gate,
    create_session,
    extract_failed_checks,
    fetch_pnl,
    get_alpha_metrics,
    load_existing_active,
    result_record,
    save_results,
    should_submit,
    submit_if_passed,
    update_alpha_db_pnl,
    API_BASE,
    REQUEST_TIMEOUT,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)


def call_with_retries(idx: int, label: str, func):
    retries = int(os.getenv("WQ_NETWORK_RETRIES", "4"))
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            return func()
        except requests.RequestException as exc:
            last_error = exc
            wait = min(30, 5 * attempt)
            print(f"[{idx}] {label} network error attempt {attempt}/{retries}: {exc}; retrying in {wait}s")
            time.sleep(wait)
    raise last_error


def simulate_candidate(idx: int, alpha: dict) -> dict:
    try:
        session = call_with_retries(idx, "auth", create_session)
    except Exception as exc:
        return result_record(alpha, idx=idx, sim={"status": "ERROR", "error": f"auth_failed: {exc}"})

    payload = build_payload(
        alpha["expression"],
        alpha["decay"],
        alpha["truncation"],
        alpha["neutralization"],
    )
    print(f"\n[{idx}] Parallel sim start: {alpha.get('name', alpha['expression'][:48])}")
    try:
        resp = call_with_retries(
            idx,
            "POST /simulations",
            lambda: session.post(f"{API_BASE}/simulations", json=payload, timeout=REQUEST_TIMEOUT),
        )
    except Exception as exc:
        return result_record(alpha, idx=idx, sim={"status": "ERROR", "error": f"post_failed: {exc}"})
    print(f"[{idx}] POST /simulations -> {resp.status_code}")
    if resp.status_code != 201:
        return result_record(alpha, idx=idx, submit={"status_code": resp.status_code, "text": resp.text[:500]})

    location = resp.headers.get("Location", "")
    sim_id = location.rstrip("/").split("/")[-1]
    start = time.time()
    timeout = int(os.getenv("WQ_SIM_TIMEOUT", "900"))
    warning_timeout = int(os.getenv("WQ_WARNING_TIMEOUT", "240"))
    warning_start = None
    while time.time() - start < timeout:
        try:
            r = call_with_retries(
                idx,
                "GET simulation",
                lambda: session.get(f"{API_BASE}/simulations/{sim_id}", timeout=REQUEST_TIMEOUT),
            )
        except Exception as exc:
            return result_record(
                alpha,
                idx=idx,
                sim={"status": "NETWORK_ERROR", "simulation_id": sim_id, "error": str(exc)},
            )
        if r.status_code != 200:
            print(f"[{idx}] GET simulation -> {r.status_code}")
            time.sleep(8)
            continue
        data = r.json()
        status = data.get("status", "UNKNOWN")
        print(f"[{idx}] Sim status: {status}")
        if status == "WARNING":
            if warning_start is None:
                warning_start = time.time()
            if time.time() - warning_start >= warning_timeout:
                return result_record(
                    alpha,
                    idx=idx,
                    sim={"status": "WARNING_TIMEOUT", "simulation_id": sim_id, "sim_data": data},
                )
        else:
            warning_start = None
        if status == "COMPLETE":
            alpha_id = data.get("alpha")
            try:
                metrics = (
                    call_with_retries(idx, "GET alpha metrics", lambda: get_alpha_metrics(session, alpha_id))
                    if alpha_id
                    else {}
                )
            except Exception as exc:
                return result_record(
                    alpha,
                    idx=idx,
                    sim={"status": "NETWORK_ERROR", "simulation_id": sim_id, "alpha_id": alpha_id, "error": str(exc)},
                )
            return result_record(
                alpha,
                idx=idx,
                sim={"status": "COMPLETE", "alpha_id": alpha_id, "sim_data": data},
                metrics=metrics,
            )
        if status in ("ERROR", "FAILED", "FAIL"):
            return result_record(alpha, idx=idx, sim={"status": "ERROR", "sim_data": data})
        time.sleep(8)
    return result_record(alpha, idx=idx, sim={"status": "TIMEOUT", "simulation_id": sim_id})


def metric_sort_key(record: dict) -> tuple[float, float, float]:
    is_ = record.get("metrics", {}).get("is", {})
    return (
        float(is_.get("fitness") or 0),
        float(is_.get("sharpe") or 0),
        -float(is_.get("turnover") or 1),
    )


def metric_value(is_metrics: dict, key: str, default: float = 0.0) -> float:
    value = is_metrics.get(key)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def merge_save_results(final_results: list[dict], completed: list[dict], all_results: list[dict]) -> None:
    """Persist gated records plus untouched simulation records during serial submit."""
    seen = {id(record) for record in final_results}
    untouched_completed = [record for record in completed if id(record) not in seen]
    non_complete = [record for record in all_results if (record.get("sim") or {}).get("status") != "COMPLETE"]
    save_results(final_results + untouched_completed + non_complete)


def main() -> int:
    alpha_file = os.getenv("WQ_ALPHA_FILE")
    alphas = load_candidates(alpha_file) if alpha_file else ALPHAS
    start_idx = int(os.getenv("WQ_START_INDEX", "1"))
    max_idx_env = os.getenv("WQ_MAX_INDEX")
    max_idx = int(max_idx_env) if max_idx_env else None
    workers = int(os.getenv("WQ_PARALLEL_WORKERS", "3"))

    selected = [
        (i, alpha)
        for i, alpha in enumerate(alphas, 1)
        if i >= start_idx and (max_idx is None or i <= max_idx)
    ]
    if not selected:
        print("No candidates selected.")
        return 0

    print(f"Loaded {len(selected)} candidates for parallel simulation; workers={workers}")
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(simulate_candidate, idx, alpha): (idx, alpha)
            for idx, alpha in selected
        }
        for fut in as_completed(futures):
            idx, alpha = futures[fut]
            try:
                record = fut.result()
            except Exception as exc:
                record = result_record(alpha, idx=idx, sim={"status": "ERROR", "error": f"worker_exception: {exc}"})
            results.append(record)
            save_results(results)

    session = call_with_retries(0, "serial auth", create_session)
    existing_active = load_existing_active()
    print(f"\nLoaded {len(existing_active)} ACTIVE alpha PnLs for serial submission gate")

    completed = [r for r in results if (r.get("sim") or {}).get("status") == "COMPLETE"]
    completed.sort(key=metric_sort_key, reverse=True)

    final_results = []
    for record in completed:
        alpha_id = (record.get("sim") or {}).get("alpha_id")
        metrics = record.get("metrics") or {}
        is_ = metrics.get("is", {})
        print(
            f"\n[{record.get('idx')}] Gate: {record.get('name')} {alpha_id} "
            f"Sharpe={metric_value(is_, 'sharpe'):.2f}, Fitness={metric_value(is_, 'fitness'):.2f}, "
            f"TO={metric_value(is_, 'turnover') * 100:.2f}%"
        )
        failed_checks = extract_failed_checks(metrics)
        if failed_checks:
            print(f"    Failed checks: {', '.join(failed_checks)}")
        submit_ok, submit_reason = should_submit(metrics)
        print(f"    Auto-submit gate: {submit_reason}")
        if not submit_ok or not alpha_id:
            record["submission"] = {"submitted": False, "reason": submit_reason}
            final_results.append(record)
            merge_save_results(final_results, completed, results)
            continue

        corr_ok, corr_reason, correlations = correlation_gate(session, alpha_id, metrics, existing_active)
        print(f"    Correlation gate: {corr_reason}")
        if correlations:
            print("    Top correlations: " + ", ".join(f"{c['alpha_id']}={c['corr']:+.2f}" for c in correlations[:3]))
        record["correlations"] = correlations
        if not corr_ok:
            record["submission"] = {"submitted": False, "reason": corr_reason}
            final_results.append(record)
            merge_save_results(final_results, completed, results)
            continue

        sub_result = submit_if_passed(session, alpha_id)
        record["submission"] = sub_result
        if sub_result.get("status") == "ACTIVE":
            new_pnl = fetch_pnl(session, alpha_id)
            if new_pnl:
                existing_active[alpha_id] = {
                    "pnl": new_pnl,
                    "sharpe": is_.get("sharpe") or 0,
                    "fitness": is_.get("fitness") or 0,
                }
                active_alpha = sub_result.get("alpha") if isinstance(sub_result.get("alpha"), dict) else metrics
                update_alpha_db_pnl(alpha_id, active_alpha, new_pnl)
        final_results.append(record)
        merge_save_results(final_results, completed, results)
        time.sleep(3)

    non_complete = [r for r in results if (r.get("sim") or {}).get("status") != "COMPLETE"]
    all_results = final_results + non_complete
    out_path = SKILL_DIR / "batch_submit_results.json"
    out_path.write_text(json.dumps(all_results, indent=2, ensure_ascii=False), encoding="utf-8")

    active = [r for r in all_results if r.get("submission", {}).get("status") == "ACTIVE"]
    pending = [r for r in all_results if r.get("submission", {}).get("submitted") and r.get("submission", {}).get("status") != "ACTIVE"]
    skipped = [r for r in all_results if r.get("submission", {}).get("submitted") is False]
    errors = [r for r in all_results if (r.get("sim") or {}).get("status") == "ERROR"]
    print("\n=== Parallel Summary ===")
    print(f"ACTIVE: {len(active)}")
    print(f"Submitted but not ACTIVE: {len(pending)}")
    print(f"Skipped: {len(skipped)}")
    print(f"Simulation errors: {len(errors)}")
    print(f"Results saved to: {out_path}")
    print(f"Alpha DB: {ALPHA_DB_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
