"""
Pure logic functions for urgency, days-since, and effective last done.

These functions have no side effects and no database access.
All date math lives here so it can be tested independently.
"""
from math import exp
from datetime import date
from typing import Optional


def calculate_effective_last_done(
    created_at: date,
    latest_completion: Optional[date] = None,
    manual_override: Optional[date] = None,
) -> date:
    """
    Return the most recent of: created_at, latest_completion, manual_override.

    Priority rule from PRD:
        effective_last_done = max(manual_override, latest_completion, created_at)

    created_at is the final fallback so never-done tasks always have a baseline.
    """
    candidates = [created_at]
    if latest_completion is not None:
        candidates.append(latest_completion)
    if manual_override is not None:
        candidates.append(manual_override)
    return max(candidates)


def calculate_days_since(effective_last_done: date, today: Optional[date] = None) -> int:
    """
    Return the number of whole days between effective_last_done and today.

    Returns 0 if effective_last_done is today or in the future (never negative).
    """
    if today is None:
        today = date.today()
    delta = today - effective_last_done
    return max(0, delta.days)


def calculate_urgency(
    priority: int,
    days_since: int,
    interval_days: int,
    is_paused: bool = False,
) -> float:
    """
    Pressure Scoring V2 (P4.0B). Urgency on a 0–10 scale with useful spread.

    The V1 model (asymptotic exp with k=2) saturated almost every due/overdue
    task toward 10, so the grid read as a wall of red. V2 uses a gentler logistic
    on the overdue ratio, tilted by priority, so tasks differentiate across the
    low → noticeable → high → critical bands instead of all pinning at the top.

    Model:
        ratio  = days_since / interval_days        (overdue ratio; interval ≥ 1)
        p_norm = (priority - 1) / 9                 (0 at P1 … 1 at P10)
        overdue     = 10 / (1 + exp(-1.4 * (ratio - 1.5)))   # 0..10, centred at 1.5×
        prio_factor = 0.75 + 0.4 * p_norm                    # 0.75 (P1) .. 1.15 (P10)
        urgency     = min(overdue * prio_factor, 10)

    Behaviour (default priority 5): not-due → ~1 (low); at due (ratio 1) → ~3
    (low); 1 interval overdue (ratio 2) → ~6 (noticeable); 2 intervals (ratio 3)
    → ~8 (high). Critical (≥9.5) is reserved for high-priority-overdue or severe
    neglect. Frequency falls out of the ratio: a daily task builds pressure far
    faster in elapsed days than a monthly one.

    Paused tasks always return 0.0 — they accumulate no pressure. Callers also
    force 0 for Finished/scheduled tasks (see main._enrich_task).
    interval_days is clamped to 1 minimum to guard against division by zero.
    """
    if is_paused:
        return 0.0

    i = max(1, interval_days)
    ratio = days_since / i
    p_norm = (priority - 1) / 9

    overdue = 10 / (1 + exp(-1.4 * (ratio - 1.5)))
    prio_factor = 0.75 + 0.4 * p_norm
    urgency = overdue * prio_factor

    return round(min(urgency, 10.0), 1)
