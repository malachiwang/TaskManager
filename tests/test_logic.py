"""
Unit tests for pure logic functions: urgency, effective_last_done, days_since.

These tests have no database or network dependencies.
Run with: pytest tests/test_logic.py -v
"""
from datetime import date
from math import exp

import pytest

from backend.logic import (
    calculate_days_since,
    calculate_effective_last_done,
    calculate_urgency,
)


# ---------------------------------------------------------------------------
# effective_last_done
# ---------------------------------------------------------------------------

class TestEffectiveLastDone:
    def test_only_created_at(self):
        created = date(2026, 1, 1)
        assert calculate_effective_last_done(created) == created

    def test_completion_newer_than_created(self):
        created = date(2026, 1, 1)
        completion = date(2026, 3, 1)
        assert calculate_effective_last_done(created, latest_completion=completion) == completion

    def test_manual_override_newest(self):
        created = date(2026, 1, 1)
        completion = date(2026, 3, 1)
        manual = date(2026, 4, 1)
        assert calculate_effective_last_done(created, completion, manual) == manual

    def test_completion_newer_than_manual(self):
        created = date(2026, 1, 1)
        completion = date(2026, 5, 1)
        manual = date(2026, 4, 1)
        assert calculate_effective_last_done(created, completion, manual) == completion

    def test_all_none_falls_back_to_created(self):
        created = date(2026, 2, 15)
        assert calculate_effective_last_done(created, None, None) == created

    def test_manual_none_completion_provided(self):
        created = date(2026, 1, 1)
        completion = date(2026, 2, 1)
        assert calculate_effective_last_done(created, latest_completion=completion, manual_override=None) == completion

    def test_completion_none_manual_provided(self):
        created = date(2026, 1, 1)
        manual = date(2026, 3, 15)
        assert calculate_effective_last_done(created, latest_completion=None, manual_override=manual) == manual


# ---------------------------------------------------------------------------
# days_since
# ---------------------------------------------------------------------------

class TestDaysSince:
    def test_same_day_is_zero(self):
        d = date(2026, 5, 8)
        assert calculate_days_since(d, today=date(2026, 5, 8)) == 0

    def test_yesterday_is_one(self):
        d = date(2026, 5, 7)
        assert calculate_days_since(d, today=date(2026, 5, 8)) == 1

    def test_one_week_ago(self):
        d = date(2026, 5, 1)
        assert calculate_days_since(d, today=date(2026, 5, 8)) == 7

    def test_never_done_uses_created_at(self):
        created = date(2026, 4, 28)
        today = date(2026, 5, 8)
        effective = calculate_effective_last_done(created, None, None)
        assert calculate_days_since(effective, today) == 10

    def test_no_negative_for_future_date(self):
        # Should clamp to 0, never return negative
        future = date(2026, 5, 10)
        assert calculate_days_since(future, today=date(2026, 5, 8)) == 0

    def test_large_gap(self):
        old = date(2025, 1, 1)
        today = date(2026, 5, 8)
        result = calculate_days_since(old, today)
        assert result == (today - old).days


# ---------------------------------------------------------------------------
# urgency
# ---------------------------------------------------------------------------

class TestUrgency:
    def test_paused_always_zero(self):
        assert calculate_urgency(9, 100, 1, is_paused=True) == 0.0

    def test_paused_zero_regardless_of_inputs(self):
        assert calculate_urgency(10, 9999, 1, is_paused=True) == 0.0
        assert calculate_urgency(1, 0, 1, is_paused=True) == 0.0

    def test_fresh_task_low_urgency(self):
        # Just done today, moderate priority
        result = calculate_urgency(priority=5, days_since=0, interval_days=7)
        assert result < 2.0

    def test_overdue_high_priority_high_urgency(self):
        # Double the interval, high priority
        result = calculate_urgency(priority=9, days_since=14, interval_days=7)
        assert result > 8.0

    def test_approaches_ten_never_exceeds(self):
        result = calculate_urgency(priority=10, days_since=99999, interval_days=1)
        assert 9.5 <= result <= 10.0

    def test_never_exceeds_ten(self):
        for p in range(1, 11):
            assert calculate_urgency(p, 99999, 1) <= 10.0

    def test_priority_1_low_floor(self):
        result = calculate_urgency(priority=1, days_since=0, interval_days=7)
        assert result < 1.0

    def test_priority_10_meaningful_floor_at_zero(self):
        # Even at days_since=0, priority 10 has a non-trivial urgency
        result = calculate_urgency(priority=10, days_since=0, interval_days=7)
        assert result > 0.5

    def test_interval_zero_guarded(self):
        # Should not raise ZeroDivisionError
        result = calculate_urgency(priority=5, days_since=5, interval_days=0)
        assert isinstance(result, float)

    def test_at_double_interval_near_max(self):
        # At D=2I, urgency should be well past the midpoint
        result = calculate_urgency(priority=7, days_since=14, interval_days=7)
        assert result > 7.0

    def test_formula_manual_verification(self):
        # Manually compute expected value for P=5, D=7, I=7, k=2
        p, d, i, k = 5, 7, 7, 2.0
        base = 0.35 + 0.15 * (p - 5)   # 0.35
        floor = base / 2                 # 0.175
        growth = 1 - exp(-k * (d / i))  # 1 - exp(-2)
        expected = round(min(10 * (floor + (1 - floor) * growth), 10.0), 1)
        assert calculate_urgency(p, d, i) == expected

    def test_higher_priority_higher_urgency_same_overdue(self):
        low = calculate_urgency(priority=3, days_since=7, interval_days=7)
        high = calculate_urgency(priority=9, days_since=7, interval_days=7)
        assert high > low

    def test_more_overdue_higher_urgency_same_priority(self):
        fresh = calculate_urgency(priority=6, days_since=1, interval_days=7)
        stale = calculate_urgency(priority=6, days_since=30, interval_days=7)
        assert stale > fresh

    def test_result_is_rounded_to_one_decimal(self):
        result = calculate_urgency(priority=5, days_since=3, interval_days=7)
        assert result == round(result, 1)

    # Boundary checks across all priority breakpoints
    def test_priority_boundary_p8(self):
        result = calculate_urgency(priority=8, days_since=0, interval_days=7)
        assert 0.0 <= result <= 10.0

    def test_priority_boundary_p5(self):
        result = calculate_urgency(priority=5, days_since=0, interval_days=7)
        assert 0.0 <= result <= 10.0

    def test_priority_boundary_p4(self):
        result = calculate_urgency(priority=4, days_since=0, interval_days=7)
        assert 0.0 <= result <= 10.0
