"""Severity heuristics + row mapping for the Terminal wire cache writer.

This is a FAITHFUL Python port of `src/data/terminal/severity.ts` plus the
camelCase→snake_case mapping the `terminal-feed` edge function reverses
(`rowToEvent`). The desktop client and this server-side writer must describe an
event identically, so the thresholds, keyword tiers, item labels, and reason
strings here are kept byte-for-byte in sync with the TypeScript.

    Keep in sync with:  src/data/terminal/severity.ts
                        supabase/functions/terminal-feed/index.ts (rowToEvent)
                        supabase/migrations/0005_terminal_events.sql (columns)

Pure module: no network, no env, no I/O - unit-tested in test_wire.py.
"""

from __future__ import annotations

import datetime

# ── News keyword tiers (mirror HIGH_NEWS / ELEVATED_NEWS / POLITICAL_FIGURES) ──

HIGH_NEWS = [
    "halt", "halted", "fda approv", "fda clear", "acquir", "acquisition",
    "merger", "buyout", "takeover", "bankrupt", "chapter 11", "delist",
    "fraud", "sec charges", "investigation", "subpoena", "recall",
    "guidance cut", "slashes guidance", "endorse", "endorsement",
    "executive order", "tariff", "ban on", "short seller", "short-seller",
    "going private",
]

ELEVATED_NEWS = [
    "earnings", "beats", "misses", "tops estimates", "upgrade", "downgrade",
    "initiates", "price target", "partnership", "contract", "awarded",
    "lawsuit", "guidance", "secondary offering", "stock split", "buyback",
    "dividend", "layoff", "ceo", "resign",
]

POLITICAL_FIGURES = [
    "trump", "biden", "harris", "powell", "yellen", "musk", "white house",
    "congress", "senate", "pelosi",
]

# Human-readable labels for SEC 8-K item codes (mirror severity.ts ITEM_8K_LABELS).
ITEM_8K_LABELS = {
    "1.01": "Entry into Material Agreement",
    "1.02": "Termination of Material Agreement",
    "1.03": "Bankruptcy or Receivership",
    "2.01": "Acquisition or Disposition of Assets",
    "2.02": "Results of Operations / Financial Condition",
    "2.03": "Creation of Direct Financial Obligation",
    "2.04": "Triggering Events for Financial Obligations",
    "2.05": "Exit Activity Costs",
    "2.06": "Material Impairments",
    "3.01": "Notice of Delisting",
    "3.02": "Unregistered Sale of Equity Securities",
    "3.03": "Modification of Security Holder Rights",
    "4.01": "Change in Certifying Accountant",
    "4.02": "Non-Reliance on Prior Financial Statements",
    "5.01": "Change in Control",
    "5.02": "Departure / Election of Directors or Officers",
    "5.03": "Amendment to Articles / Bylaws",
    "5.07": "Submission to Security Holder Vote",
    "7.01": "Regulation FD Disclosure",
    "8.01": "Other Events",
    "9.01": "Financial Statements and Exhibits",
}

HIGH_8K_ITEMS = {"1.03", "2.01", "3.01", "4.02", "5.01"}
ELEVATED_8K_ITEMS = {"1.01", "1.02", "2.02", "2.05", "2.06", "3.02", "5.02"}


def _matches(haystack: str, needles):
    for n in needles:
        if n in haystack:
            return n
    return None


def classify_news_severity(headline: str, summary: str = ""):
    """Mirror classifyNewsSeverity(): keyword tiers + political-figure bump."""
    text = f"{headline} {summary or ''}".lower()
    political = _matches(text, POLITICAL_FIGURES)
    high = _matches(text, HIGH_NEWS)
    if high:
        reason = (
            f'Market-moving language ("{high}") + political figure ({political})'
            if political
            else f'Market-moving language: "{high}"'
        )
        return "high", reason
    elevated = _matches(text, ELEVATED_NEWS)
    if political:
        return "elevated", f"Political figure mentioned: {political}"
    if elevated:
        return "elevated", f'Notable catalyst language: "{elevated}"'
    return "watch", "General coverage"


def classify_trade_severity(direction: str, value_usd):
    """Mirror classifyTradeSeverity(): buys weighted above sells."""
    v = value_usd or 0
    if direction == "buy":
        if v >= 1_000_000:
            return "high", "Insider buy ≥ $1M"
        if v >= 250_000:
            return "elevated", "Insider buy ≥ $250K"
        return "watch", "Open-market insider buy"
    if v >= 5_000_000:
        return "elevated", "Large insider sale ≥ $5M"
    return "watch", "Insider sale"


def classify_8k_severity(items):
    """Mirror classify8kSeverity(): surface the most material item code."""
    for i in items:
        if i in HIGH_8K_ITEMS:
            return "high", f"8-K: {ITEM_8K_LABELS.get(i, f'Item {i}')}"
    for i in items:
        if i in ELEVATED_8K_ITEMS:
            return "elevated", f"8-K: {ITEM_8K_LABELS.get(i, f'Item {i}')}"
    first = items[0] if items else ""
    if first:
        return "watch", f"8-K: {ITEM_8K_LABELS.get(first, f'Item {first}')}"
    return "watch", "8-K material-event filing"


def classify_politician_severity(direction: str, upper_amount_usd):
    """Mirror classifyPoliticianSeverity(): threshold on the disclosed upper bound."""
    v = upper_amount_usd or 0
    side = "purchase" if direction == "buy" else "sale"
    if v >= 250_000:
        return "high", f"Congressional {side} up to ≥ $250K"
    if v >= 50_000:
        return "elevated", f"Congressional {side} up to ≥ $50K"
    return "watch", f"Congressional {side}"


# ── ISO helpers ───────────────────────────────────────────────────────────────

def safe_iso(value) -> str:
    """Coerce an input date/datetime string to an ISO-8601 string; now() on failure.

    Mirrors the `safeIso()` used across the TS sources so cache rows carry the
    same timestamp shape the UI's `new Date(...)` expects.
    """
    if not value:
        return _now_iso()
    s = str(value).strip()
    # Date-only ("2026-06-09") → midnight UTC, matching new Date("YYYY-MM-DD").
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.datetime.strptime(s.replace("Z", "+0000"), fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return dt.astimezone(datetime.timezone.utc).isoformat()
        except ValueError:
            continue
    return _now_iso()


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ── TerminalEvent (camelCase) → terminal_events row (snake_case) ──────────────

def event_to_row(ev: dict) -> dict:
    """Map a camelCase TerminalEvent dict to the snake_case DB column shape.

    Inverse of the edge function's `rowToEvent`. Drops None-valued optionals so
    the upsert relies on the column defaults where appropriate.
    """
    row = {
        "id": ev["id"],
        "kind": ev["kind"],
        "severity": ev["severity"],
        "ticker": ev.get("ticker", "") or "",
        "related_tickers": ev.get("relatedTickers") or [],
        "company_name": ev.get("companyName"),
        "headline": ev["headline"],
        "summary": ev.get("summary"),
        "actor": ev.get("actor"),
        "trade": ev.get("trade"),
        "occurred_at": ev["occurredAt"],
        "surfaced_at": ev["surfacedAt"],
        "source": ev["source"],
        "reason": ev.get("reason"),
    }
    return row
