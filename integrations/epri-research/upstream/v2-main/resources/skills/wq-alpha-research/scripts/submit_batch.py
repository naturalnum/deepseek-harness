"""Batch submit alphas to WorldQuant BRAIN for testing.

Usage:
    cd <skill-dir>
    pyenv exec python scripts/submit_batch.py

Reads credentials from WQ_BRAIN_USERNAME/WQ_BRAIN_PASSWORD or an untracked
credential.txt (JSON array ["username", "password"]).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

from load_alpha_candidates import load_candidates

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CREDENTIAL_PATH = SKILL_DIR / "credential.txt"
API_BASE = "https://api.worldquantbrain.com"
REQUEST_TIMEOUT = (10, 60)
ALPHA_DB_PATH = SKILL_DIR / "alpha_db.json"

HEADERS = {
    "Accept": "application/json;version=2.0",
    "Content-Type": "application/json",
}

MIN_SHARPE = 1.35
MIN_FITNESS = 1.10
MIN_TURNOVER = 0.01
MAX_TURNOVER = 0.25
MAX_DRAWDOWN = 0.15
MAX_CORRELATION = float(os.getenv("WQ_MAX_CORRELATION", "0.68"))
CORRELATED_SHARPE_PREMIUM = 1.10
ALLOW_SUBMIT_WITHOUT_PNL = os.getenv("WQ_ALLOW_SUBMIT_WITHOUT_PNL", "0") == "1"
ALLOW_HIGH_CORR_SHARPE_OVERRIDE = os.getenv("WQ_ALLOW_HIGH_CORR_SHARPE_OVERRIDE", "0") == "1"
BLOCKING_CHECKS = {
    "LOW_SHARPE",
    "LOW_FITNESS",
    "LOW_TURNOVER",
    "HIGH_TURNOVER",
    "CONCENTRATED_WEIGHT",
    "LOW_SUB_UNIVERSE_SHARPE",
}


ALPHAS = [
    {
        "expression": "group_rank(ts_rank(operating_income / equity, 126), subindustry)",
        "decay": 0,
        "truncation": 0.08,
        "neutralization": "SUBINDUSTRY",
    },
    {
        "expression": "group_rank(ts_rank(est_eps / close, 126), industry)",
        "decay": 2,
        "truncation": 0.08,
        "neutralization": "INDUSTRY",
    },
    {
        "expression": "group_rank(ts_rank(free_cash_flow_reported_value / equity, 126), industry)",
        "decay": 0,
        "truncation": 0.08,
        "neutralization": "INDUSTRY",
    },
    {
        "expression": "0.5 * rank(-(close / open - 1)) + 0.5 * rank(ts_rank(operating_income / equity, 126))",
        "decay": 12,
        "truncation": 0.08,
        "neutralization": "INDUSTRY",
    },
]


def load_credentials() -> tuple[str, str]:
    env_user = os.getenv("WQ_BRAIN_USERNAME")
    env_password = os.getenv("WQ_BRAIN_PASSWORD")
    if env_user and env_password:
        return env_user, env_password

    candidates = [
        CREDENTIAL_PATH,
        Path.cwd() / "credential.txt",
    ]
    for p in candidates:
        if p.exists():
            username, password = json.loads(p.read_text(encoding="utf-8"))
            return str(username), str(password)
    raise FileNotFoundError(
        "BRAIN credentials not found. Set WQ_BRAIN_USERNAME/WQ_BRAIN_PASSWORD "
        'or create an untracked credential.txt with ["your_username", "your_password"].'
    )


def create_session() -> requests.Session:
    username, password = load_credentials()
    session = requests.Session()
    session.auth = HTTPBasicAuth(username, password)
    session.headers.update(HEADERS)
    resp = session.post(f"{API_BASE}/authentication", timeout=REQUEST_TIMEOUT)
    if resp.status_code != 201:
        raise RuntimeError(f"Auth failed: {resp.status_code} {resp.text}")
    print(f"Authenticated: {resp.status_code}")
    return session


def build_payload(expr: str, decay: int, truncation: float, neutralization: str) -> dict:
    return {
        "type": "REGULAR",
        "settings": {
            "instrumentType": "EQUITY",
            "region": "USA",
            "universe": "TOP3000",
            "delay": 1,
            "decay": decay,
            "neutralization": neutralization,
            "truncation": truncation,
            "pasteurization": "ON",
            "unitHandling": "VERIFY",
            "nanHandling": "ON",
            "maxTrade": "OFF",
            "maxPosition": "OFF",
            "language": "FASTEXPR",
            "visualization": False,
        },
        "regular": expr,
    }


def submit_alpha(session: requests.Session, idx: int, alpha: dict) -> dict:
    payload = build_payload(
        alpha["expression"],
        alpha["decay"],
        alpha["truncation"],
        alpha["neutralization"],
    )
    print(f"\n[{idx}] Simulating: {alpha['expression'][:60]}...")
    resp = session.post(f"{API_BASE}/simulations", json=payload, timeout=REQUEST_TIMEOUT)
    print(f"    POST /simulations -> {resp.status_code}")
    if resp.status_code != 201:
        print(f"    Error: {resp.text[:300]}")
        return {"error": resp.text[:500], "status_code": resp.status_code}
    location = resp.headers.get("Location", "")
    sim_id = location.rstrip("/").split("/")[-1]
    print(f"    Simulation ID: {sim_id}")
    return {"simulation_id": sim_id}


def poll_simulation(session: requests.Session, sim_id: str, timeout: int = 600) -> dict:
    print(f"    Polling simulation {sim_id}...")
    start = time.time()
    while time.time() - start < timeout:
        resp = session.get(f"{API_BASE}/simulations/{sim_id}", timeout=REQUEST_TIMEOUT)
        if resp.status_code != 200:
            print(f"    GET /simulations/{sim_id} -> {resp.status_code}")
            time.sleep(8)
            continue
        data = resp.json()
        status = data.get("status", "UNKNOWN")
        print(f"    Sim status: {status}")
        if status == "COMPLETE":
            alpha_id = data.get("alpha")
            print(f"    Alpha ID: {alpha_id}")
            return {"status": "COMPLETE", "alpha_id": alpha_id, "sim_data": data}
        if status in ("ERROR", "FAILED", "FAIL"):
            return {"status": "ERROR", "sim_data": data}
        time.sleep(8)
    return {"status": "TIMEOUT", "simulation_id": sim_id}


def submit_if_passed(session: requests.Session, alpha_id: str) -> dict:
    """Submit alpha and poll until ACTIVE or SELF_CORRELATION result known."""
    print(f"    Submitting alpha {alpha_id}...")
    sub = session.post(f"{API_BASE}/alphas/{alpha_id}/submit", timeout=REQUEST_TIMEOUT)
    print(f"    POST /alphas/{alpha_id}/submit -> {sub.status_code}")
    if sub.status_code not in (200, 201):
        return {"submitted": False, "status_code": sub.status_code, "text": sub.text[:300]}

    for _ in range(30):
        time.sleep(10)
        resp = session.get(f"{API_BASE}/alphas/{alpha_id}", timeout=REQUEST_TIMEOUT)
        if resp.status_code != 200:
            continue
        alpha = resp.json()
        status = alpha.get("status")
        print(f"    Alpha status: {status}")
        if status == "ACTIVE":
            return {"submitted": True, "status": "ACTIVE", "alpha": alpha}
        checks = alpha.get("is", {}).get("checks", [])
        sc = next((c for c in checks if c.get("name") == "SELF_CORRELATION"), {})
        if sc.get("result") == "FAIL":
            return {"submitted": True, "status": alpha.get("status"), "self_correlation": "FAIL", "alpha": alpha}
        if status == "UNSUBMITTED" and sc.get("result") == "PASS":
            # sometimes needs more time to become ACTIVE
            continue
    return {"submitted": True, "status": "PENDING", "alpha": alpha}


def get_alpha_metrics(session: requests.Session, alpha_id: str) -> dict:
    resp = session.get(f"{API_BASE}/alphas/{alpha_id}", timeout=REQUEST_TIMEOUT)
    if resp.status_code == 200:
        return resp.json()
    return {}


def fetch_pnl(session: requests.Session, alpha_id: str) -> list[float]:
    data = {}
    for attempt in range(5):
        try:
            resp = session.get(f"{API_BASE}/alphas/{alpha_id}/recordsets/pnl", timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            if attempt < 4:
                time.sleep(5 * (attempt + 1))
                continue
            print(f"    PnL fetch failed for {alpha_id}: {exc}")
            return []
        if resp.status_code == 200 and resp.text.strip():
            try:
                data = resp.json()
                break
            except ValueError:
                return []
        if attempt < 4:
            time.sleep(5 * (attempt + 1))
    if not data:
        return []

    props = data.get("schema", {}).get("properties", [])
    if isinstance(props, list):
        date_idx = next((i for i, p in enumerate(props) if p.get("name", "").lower() == "date"), 0)
        pnl_idx = next(
            (i for i, p in enumerate(props) if p.get("name", "").lower() in ("pnl", "cum_pnl", "returns", "ret")),
            1,
        )
    else:
        date_idx = next((v["index"] for k, v in props.items() if k.lower() == "date"), 0)
        pnl_idx = next(
            (v["index"] for k, v in props.items() if k.lower() in ("pnl", "cum_pnl", "returns", "ret")),
            1,
        )

    records = sorted(data.get("records", []), key=lambda r: r[date_idx])
    out = []
    for row in records:
        rec = row[0] if isinstance(row, list) and len(row) == 1 and isinstance(row[0], list) else row
        try:
            out.append(float(rec[pnl_idx]))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def daily_returns(cum_pnl: list[float]) -> list[float]:
    return [cum_pnl[i + 1] - cum_pnl[i] for i in range(len(cum_pnl) - 1)]


def pearson_corr(a: list[float], b: list[float]) -> float | None:
    common_len = min(len(a), len(b))
    if common_len < 50:
        return None
    if len(a) != len(b):
        a = a[-common_len:]
        b = b[-common_len:]
    mean_a = sum(a) / len(a)
    mean_b = sum(b) / len(b)
    da = [x - mean_a for x in a]
    db = [x - mean_b for x in b]
    denom_a = sum(x * x for x in da)
    denom_b = sum(x * x for x in db)
    if denom_a <= 0 or denom_b <= 0:
        return None
    return sum(x * y for x, y in zip(da, db)) / ((denom_a * denom_b) ** 0.5)


def load_existing_active() -> dict[str, dict]:
    if not ALPHA_DB_PATH.exists():
        return {}
    try:
        db = json.loads(ALPHA_DB_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out = {}
    for alpha_id, alpha in db.get("alphas", {}).items():
        if alpha.get("status") == "ACTIVE" and alpha.get("pnl"):
            out[alpha_id] = {
                "pnl": alpha["pnl"],
                "sharpe": alpha.get("sharpe") or 0,
                "fitness": alpha.get("fitness") or 0,
            }
    return out


def update_alpha_db_pnl(alpha_id: str, alpha: dict, pnl: list[float]) -> None:
    if not pnl:
        return
    if ALPHA_DB_PATH.exists():
        try:
            db = json.loads(ALPHA_DB_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            db = {"alphas": {}, "last_update": None, "version": 1}
    else:
        db = {"alphas": {}, "last_update": None, "version": 1}

    is_ = alpha.get("is", {}) if isinstance(alpha.get("is"), dict) else {}
    expr_obj = alpha.get("regular", alpha.get("expression", {}))
    expr = expr_obj.get("code") if isinstance(expr_obj, dict) else str(expr_obj or "")
    entry = db.setdefault("alphas", {}).setdefault(alpha_id, {})
    entry.update(
        {
            "status": alpha.get("status"),
            "expression": expr,
            "settings": alpha.get("settings", {}),
            "sharpe": is_.get("sharpe"),
            "fitness": is_.get("fitness"),
            "returns": is_.get("returns"),
            "turnover": is_.get("turnover"),
            "drawdown": is_.get("drawdown"),
            "margin": is_.get("margin"),
            "long_count": is_.get("longCount"),
            "short_count": is_.get("shortCount"),
            "pnl": pnl,
        }
    )
    ALPHA_DB_PATH.write_text(json.dumps(db, indent=2, ensure_ascii=False), encoding="utf-8")


def correlation_gate(session: requests.Session, alpha_id: str, alpha: dict, existing_active: dict[str, dict]) -> tuple[bool, str, list[dict]]:
    """Return whether this alpha is sufficiently different from existing ACTIVE alphas."""
    if not existing_active:
        return True, "no_existing_active_pnls", []
    new_pnl = fetch_pnl(session, alpha_id)
    if not new_pnl:
        if ALLOW_SUBMIT_WITHOUT_PNL:
            return True, "pnl_unavailable_allowed_by_env", []
        return False, "pnl_unavailable_for_corr_gate", []
    new_ret = daily_returns(new_pnl)
    is_ = alpha.get("is", {})
    new_sharpe = is_.get("sharpe") or 0
    correlations = []
    for old_id, old in existing_active.items():
        corr = pearson_corr(new_ret, daily_returns(old["pnl"]))
        if corr is None:
            continue
        correlations.append(
            {
                "alpha_id": old_id,
                "corr": corr,
                "old_sharpe": old.get("sharpe") or 0,
                "old_fitness": old.get("fitness") or 0,
            }
        )
    correlations.sort(key=lambda x: abs(x["corr"]), reverse=True)
    if not correlations:
        return True, "no_comparable_pnl", correlations

    top = correlations[0]
    if abs(top["corr"]) >= MAX_CORRELATION:
        if ALLOW_HIGH_CORR_SHARPE_OVERRIDE and new_sharpe >= top["old_sharpe"] * CORRELATED_SHARPE_PREMIUM:
            return (
                True,
                f"high_corr_override_with_{top['alpha_id']}_{top['corr']:+.2f}",
                correlations[:5],
            )
        return (
            False,
            f"high_corr_with_{top['alpha_id']}_{top['corr']:+.2f}",
            correlations[:5],
        )
    return True, f"corr_gate_pass_top_{top['alpha_id']}_{top['corr']:+.2f}", correlations[:5]


def extract_failed_checks(alpha: dict) -> list[str]:
    checks = alpha.get("is", {}).get("checks", [])
    return [
        c.get("name", "UNKNOWN")
        for c in checks
        if c.get("result") == "FAIL"
    ]


def extract_warning_checks(alpha: dict) -> list[str]:
    checks = alpha.get("is", {}).get("checks", [])
    return [
        c.get("name", "UNKNOWN")
        for c in checks
        if c.get("result") == "WARNING"
    ]


def should_submit(alpha: dict) -> tuple[bool, str]:
    is_ = alpha.get("is", {})
    fitness = is_.get("fitness") or 0
    sharpe = is_.get("sharpe") or 0
    turnover = is_.get("turnover") or 1
    drawdown = is_.get("drawdown") or 1
    failed_checks = set(extract_failed_checks(alpha))
    warning_checks = sorted(set(extract_warning_checks(alpha)))
    blocking = sorted(failed_checks & BLOCKING_CHECKS)

    if sharpe < MIN_SHARPE:
        return False, f"sharpe_below_{MIN_SHARPE}"
    if fitness < MIN_FITNESS:
        return False, f"fitness_below_{MIN_FITNESS}"
    if turnover < MIN_TURNOVER:
        return False, f"turnover_below_{MIN_TURNOVER}"
    if turnover > MAX_TURNOVER:
        return False, f"turnover_above_{MAX_TURNOVER}"
    if drawdown > MAX_DRAWDOWN:
        return False, f"drawdown_above_{MAX_DRAWDOWN}"
    if blocking:
        return False, "blocking_checks_" + ",".join(blocking)
    if warning_checks:
        return False, "warning_checks_" + ",".join(warning_checks)
    return True, "passed_auto_submit_gate"


def save_results(results: list[dict]) -> None:
    out_path = SKILL_DIR / "batch_submit_results.json"
    out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")


def result_record(alpha: dict, **kwargs) -> dict:
    return {
        "name": alpha.get("name"),
        "family": alpha.get("family"),
        "expression": alpha["expression"],
        **kwargs,
    }


def main():
    session = create_session()
    results = []
    existing_active = load_existing_active()
    if existing_active:
        print(f"Loaded {len(existing_active)} ACTIVE alpha PnLs for correlation gate")
    alpha_file = os.getenv("WQ_ALPHA_FILE")
    alphas = load_candidates(alpha_file) if alpha_file else ALPHAS
    if alpha_file:
        print(f"Loaded {len(alphas)} candidates from {alpha_file}")
    start_idx = int(os.getenv("WQ_START_INDEX", "1"))
    max_idx_env = os.getenv("WQ_MAX_INDEX")
    max_idx = int(max_idx_env) if max_idx_env else None
    for i, alpha in enumerate(alphas, 1):
        if i < start_idx:
            print(f"\n[{i}] Skipping because WQ_START_INDEX={start_idx}")
            continue
        if max_idx is not None and i > max_idx:
            print(f"\n[{i}] Stopping because WQ_MAX_INDEX={max_idx}")
            break
        try:
            submit_data = submit_alpha(session, i, alpha)
            sim_id = submit_data.get("simulation_id")
            if not sim_id:
                results.append(result_record(alpha, idx=i, submit=submit_data, sim=None))
                save_results(results)
                continue
            sim_result = poll_simulation(session, sim_id)
            alpha_id = sim_result.get("alpha_id")
            if not alpha_id:
                results.append(result_record(alpha, idx=i, sim=sim_result))
                save_results(results)
                continue
            metrics = get_alpha_metrics(session, alpha_id)
            is_ = metrics.get("is", {})
            fitness = is_.get("fitness", 0)
            sharpe = is_.get("sharpe", 0)
            turnover = is_.get("turnover", 1)
            drawdown = is_.get("drawdown", 1)
            failed_checks = extract_failed_checks(metrics)
            print(
                f"    IS metrics: Sharpe={sharpe:.2f}, Fitness={fitness:.2f}, "
                f"TO={turnover*100:.2f}%, DD={drawdown*100:.2f}%"
            )
            if failed_checks:
                print(f"    Failed checks: {', '.join(failed_checks)}")
            submit_ok, submit_reason = should_submit(metrics)
            print(f"    Auto-submit gate: {submit_reason}")
            if submit_ok:
                corr_ok, corr_reason, correlations = correlation_gate(session, alpha_id, metrics, existing_active)
                print(f"    Correlation gate: {corr_reason}")
                if correlations:
                    top_corr = ", ".join(f"{c['alpha_id']}={c['corr']:+.2f}" for c in correlations[:3])
                    print(f"    Top correlations: {top_corr}")
                if corr_ok:
                    sub_result = submit_if_passed(session, alpha_id)
                    if sub_result.get("status") == "ACTIVE":
                        new_pnl = fetch_pnl(session, alpha_id)
                        if new_pnl:
                            existing_active[alpha_id] = {
                                "pnl": new_pnl,
                                "sharpe": sharpe,
                                "fitness": fitness,
                            }
                            active_alpha = sub_result.get("alpha") if isinstance(sub_result.get("alpha"), dict) else metrics
                            update_alpha_db_pnl(alpha_id, active_alpha, new_pnl)
                    results.append(result_record(alpha, idx=i, sim=sim_result, metrics=metrics, correlations=correlations, submission=sub_result))
                else:
                    results.append(result_record(alpha, idx=i, sim=sim_result, metrics=metrics, correlations=correlations, submission={"submitted": False, "reason": corr_reason}))
            else:
                results.append(result_record(alpha, idx=i, sim=sim_result, metrics=metrics, submission={"submitted": False, "reason": submit_reason}))
        except Exception as e:
            print(f"[{i}] Exception: {e}")
            results.append(result_record(alpha, idx=i, error=str(e)))
        finally:
            save_results(results)
        time.sleep(3)

    out_path = SKILL_DIR / "batch_submit_results.json"
    print(f"\nResults saved to: {out_path}")

    # Summary
    print("\n=== Summary ===")
    active = [r for r in results if r.get("submission", {}).get("status") == "ACTIVE"]
    submitted_pending = [r for r in results if r.get("submission", {}).get("submitted") and r.get("submission", {}).get("status") != "ACTIVE"]
    skipped = [r for r in results if r.get("submission", {}).get("submitted") is False]
    sim_errors = [r for r in results if (r.get("sim") or {}).get("status") == "ERROR"]
    request_errors = [r for r in results if "error" in r]
    print(f"ACTIVE: {len(active)}")
    print(f"Submitted but not ACTIVE: {len(submitted_pending)}")
    print(f"Skipped by metrics threshold: {len(skipped)}")
    print(f"Simulation errors: {len(sim_errors)}")
    print(f"Request errors: {len(request_errors)}")

    for r in active:
        m = r.get("metrics", {}).get("is", {})
        print(f"  ACTIVE {r['submission']['alpha'].get('id')}: Sharpe={m.get('sharpe',0):.2f}, Fitness={m.get('fitness',0):.2f}, TO={m.get('turnover',0)*100:.2f}%")


if __name__ == "__main__":
    main()
