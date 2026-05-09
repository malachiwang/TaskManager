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
    k: float = 2.0,
) -> float:
    """
    Asymptotic urgency model. Urgency approaches 10 but never exceeds it.

    Formula (from PRD):
        base  = f(priority)        — sets the urgency floor
        floor = base / 2
        growth = 1 - exp(-k * D/I)
        urgency = 10 * (floor + (1 - floor) * growth)

    At D = 2I (double the interval), growth ≈ 0.9817, so urgency is ~98% of
    the way from floor to 10.

    Paused tasks always return 0.0 — they accumulate no pressure.
    interval_days is clamped to 1 minimum to guard against division by zero.
    """
    if is_paused:
        return 0.0

    # Guard: interval must be at least 1 day
    i = max(1, interval_days)

    # Priority base mapping
    if priority >= 8:
        base = 0.8 + 0.05 * (priority - 8)
    elif priority >= 5:
        base = 0.35 + 0.15 * (priority - 5)
    else:
        base = 0.05 + 0.1 * (priority - 1)

    floor = base / 2
    growth = 1 - exp(-k * (days_since / i))
    urgency = 10 * (floor + (1 - floor) * growth)

    return round(min(urgency, 10.0), 1)
