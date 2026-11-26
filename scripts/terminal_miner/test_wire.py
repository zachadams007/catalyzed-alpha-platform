#!/usr/bin/env python3
"""Offline tests for the wire writer's pure logic (no network, no keys).

Run:  python scripts/terminal_miner/test_wire.py
Mirrors the assertions in src/data/terminal/__tests__ + severity expectations so
drift between the TS client and this Python writer fails loudly.
"""

from __future__ import annotations

import sys

# Severity reasons carry ≥ / – (kept byte-identical to severity.ts); force UTF-8
# so printing them never dies on a cp1252 Windows console.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older/redirected streams: best-effort only
        pass

from _wire_normalize import (
    classify_8k_severity,
    classify_news_severity,
    classify_politician_severity,
    classify_trade_severity,
    event_to_row,
    safe_iso,
)
import _wire_sources as src
import form4_miner

_failures = []


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        _failures.append(name)


def test_news_severity():
    sev, reason = classify_news_severity("Trading halted on ACME after FDA approval")
    check("news high keyword", sev == "high" and "Market-moving" in reason)
    sev, _ = classify_news_severity("President endorses GIGA at rally")
    check("news endorsement → high", sev == "high")
    sev, reason = classify_news_severity("Pelosi comments on the widget sector")
    check("news political -> elevated", sev == "elevated" and "Political figure" in reason)
    sev, _ = classify_news_severity("Company announces quarterly dividend")
    check("news elevated keyword", sev == "elevated")
    sev, _ = classify_news_severity("A calm day for the widget sector")
    check("news default → watch", sev == "watch")


def test_trade_severity():
    check("buy ≥1M → high", classify_trade_severity("buy", 2_000_000)[0] == "high")
    check("buy ≥250k → elevated", classify_trade_severity("buy", 300_000)[0] == "elevated")
    check("small buy → watch", classify_trade_severity("buy", 1_000)[0] == "watch")
    check("big sell → elevated", classify_trade_severity("sell", 6_000_000)[0] == "elevated")
    check("small sell → watch", classify_trade_severity("sell", 10_000)[0] == "watch")


def test_8k_severity():
    check("8-K bankruptcy → high", classify_8k_severity(["1.03", "9.01"])[0] == "high")
    check("8-K earnings → elevated", classify_8k_severity(["2.02", "9.01"])[0] == "elevated")
    sev, reason = classify_8k_severity(["9.01"])
    check("8-K exhibits → watch", sev == "watch" and "Financial Statements" in reason)
    check("8-K empty → watch", classify_8k_severity([])[0] == "watch")


def test_politician_severity():
    check("congress ≥250k → high", classify_politician_severity("buy", 300_000)[0] == "high")
    check("congress ≥50k → elevated", classify_politician_severity("sell", 60_000)[0] == "elevated")
    sev, reason = classify_politician_severity("buy", 10_000)
    check("congress small → watch", sev == "watch" and "purchase" in reason)


def test_amount_range():
    lo, hi = src._parse_amount_range("$15,001 - $50,000")
    check("amount range parse", lo == 15001 and hi == 50000)
    lo, hi = src._parse_amount_range(None)
    check("amount range empty", lo is None and hi is None)


def test_actor_role():
    check("senate role", src._actor_role("senate", "RI") == "Senator (RI)")
    check("house role", src._actor_role("house", "NJ05") == "Rep. (NJ-05)")


def test_display_name():
    p = src._parse_display_name("McGraw Hill, Inc.  (MH)  (CIK 0001951070)")
    check("display single ticker", p["ticker"] == "MH" and p["company"] == "McGraw Hill, Inc.")
    p = src._parse_display_name("Cobra Oil (COPL, COPL-UN)  (CIK 0000123456)")
    check("display multi class", p["ticker"] == "COPL" and p["related"] == ["COPL-UN"])


def test_event_to_row():
    ev = {
        "id": "8k-x", "kind": "filing_8k", "severity": "high", "ticker": "ACME",
        "relatedTickers": ["ACME-B"], "companyName": "Acme", "headline": "Acme — Bankruptcy",
        "occurredAt": "2026-06-15T00:00:00+00:00", "surfacedAt": "2026-06-15T00:00:00+00:00",
        "source": {"name": "SEC", "url": "https://x"}, "reason": "8-K: Bankruptcy",
    }
    row = event_to_row(ev)
    check("row snake_case keys", row["related_tickers"] == ["ACME-B"] and row["company_name"] == "Acme")
    check("row required cols", all(k in row for k in ("id", "kind", "severity", "ticker", "headline", "occurred_at", "surfaced_at", "source")))
    check("row drops missing optionals to None", row["actor"] is None and row["trade"] is None)


def test_safe_iso():
    check("safe_iso date-only", safe_iso("2026-06-09").startswith("2026-06-09T00:00:00"))
    check("safe_iso passthrough", "2026-06-09" in safe_iso("2026-06-09T12:30:00Z"))
    check("safe_iso empty → now", "T" in safe_iso(None))


def test_form4_terminal_event_adapter():
    original = form4_miner.mine
    try:
        form4_miner.mine = lambda limit, min_value: [
            {
                "id": "ACME-Jane Doe-2026-06-09-1000",
                "kind": "insider_buy",
                "severity": "elevated",
                "ticker": "ACME",
                "companyName": "Acme Corp",
                "headline": "Jane Doe bought 1,000 sh ACME ($255,000)",
                "actor": {"name": "Jane Doe", "role": "Officer: CEO"},
                "trade": {
                    "direction": "buy",
                    "shares": 1000,
                    "pricePerShare": 255,
                    "valueUsd": 255000,
                    "code": "P",
                },
                "occurredAt": "2026-06-09",
                "surfacedAt": "2026-06-10T12:34:56Z",
                "source": {"name": "SEC Form 4 - EDGAR", "url": "https://www.sec.gov/Archives/x"},
                "reason": "Open-market insider purchase >= $250k",
            }
        ]
        [event] = src.fetch_insider(limit=1)
        check("form4 adapter keeps nested actor", event["actor"]["name"] == "Jane Doe")
        check("form4 adapter keeps nested trade", event["trade"]["pricePerShare"] == 255)
        check("form4 adapter keeps nested source", event["source"]["url"].startswith("https://www.sec.gov/Archives/"))
    finally:
        form4_miner.mine = original


def main():
    for fn in [
        test_news_severity, test_trade_severity, test_8k_severity,
        test_politician_severity, test_amount_range, test_actor_role,
        test_display_name, test_event_to_row, test_safe_iso,
        test_form4_terminal_event_adapter,
    ]:
        print(f"\n{fn.__name__}")
        fn()
    print()
    if _failures:
        print(f"{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("all wire writer tests passed")


if __name__ == "__main__":
    main()
