#!/usr/bin/env python3
"""Fetch keyless Yahoo Finance data into the requested research-data JSON shape."""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import yfinance as yf


FUNDAMENTAL_KEYS = (
    "peRatio",
    "pbRatio",
    "psRatio",
    "evEbitda",
    "grossMargin",
    "netMargin",
    "operatingMargin",
    "revenueGrowthYoy",
    "epsGrowthYoy",
    "debtToEquity",
    "currentRatio",
    "returnOnEquity",
    "returnOnAssets",
    "freeCashFlowYield",
    "dividendYield",
)

SECTOR_MAP = {
    "Technology": "Technology",
    "Health Care": "Healthcare",
    "Healthcare": "Healthcare",
    "Financial Services": "Financials",
    "Financials": "Financials",
    "Energy": "Energy",
    "Consumer Cyclical": "Consumer",
    "Consumer Defensive": "Consumer",
    "Consumer": "Consumer",
    "Industrials": "Industrials",
    "Communication Services": "Communications",
    "Communications": "Communications",
    "Basic Materials": "Materials",
    "Materials": "Materials",
    "Utilities": "Utilities",
    "Real Estate": "Real Estate",
}

RATING_RANK = {
    "strong sell": 0,
    "sell": 1,
    "underperform": 1,
    "underweight": 1,
    "reduce": 1,
    "hold": 2,
    "neutral": 2,
    "market perform": 2,
    "equal-weight": 2,
    "peer perform": 2,
    "buy": 3,
    "outperform": 3,
    "overweight": 3,
    "accumulate": 3,
    "strong buy": 4,
}


def warn(message: str) -> None:
    print(f"Warning: {message}", file=sys.stderr)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def safe_float(value: Any, default: float = 0.0) -> float:
    """Convert provider values without allowing NaN or infinity into JSON."""
    if value is None or isinstance(value, bool):
        return default
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return default
    return converted if math.isfinite(converted) else default


def optional_float(value: Any) -> float | None:
    """Return JSON null only for fields whose requested schema permits null."""
    if value is None or isinstance(value, bool):
        return None
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return None
    return converted if math.isfinite(converted) else None


def has_real_value(value: Any) -> bool:
    converted = optional_float(value)
    return converted is not None and converted != 0


def first_present(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            if value.strip():
                return value
            continue
        try:
            if bool(pd.isna(value)):
                continue
        except (TypeError, ValueError):
            pass
        return value
    return None


def market_cap_bucket(market_cap: float) -> str:
    if market_cap < 50_000_000:
        return "Nano"
    if market_cap < 300_000_000:
        return "Micro"
    if market_cap < 2_000_000_000:
        return "Small"
    if market_cap < 10_000_000_000:
        return "Mid"
    if market_cap <= 200_000_000_000:
        return "Large"
    return "Mega"


def map_sector(raw_sector: Any) -> str:
    if not isinstance(raw_sector, str):
        return "Technology"
    return SECTOR_MAP.get(raw_sector.strip(), "Technology")


def numeric_series(frame: pd.DataFrame, column: str) -> pd.Series:
    if frame.empty or column not in frame.columns:
        return pd.Series(dtype="float64")
    return pd.to_numeric(frame[column], errors="coerce").dropna().astype(float)


def fractional_change(close: pd.Series, periods: int) -> float:
    if len(close) <= periods:
        return 0.0
    previous = safe_float(close.iloc[-(periods + 1)])
    current = safe_float(close.iloc[-1])
    if previous == 0:
        return 0.0
    return (current - previous) / previous


def wilder_rsi(close: pd.Series, periods: int = 14) -> float:
    if len(close) <= periods:
        return 50.0

    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    average_gain = gains.ewm(alpha=1 / periods, adjust=False, min_periods=periods).mean()
    average_loss = losses.ewm(alpha=1 / periods, adjust=False, min_periods=periods).mean()
    gain = safe_float(average_gain.iloc[-1])
    loss = safe_float(average_loss.iloc[-1])

    if gain == 0 and loss == 0:
        return 50.0
    if loss == 0:
        return 100.0
    if gain == 0:
        return 0.0
    return clamp(100 - (100 / (1 + gain / loss)), 0.0, 100.0)


def calculate_volume_ratio(volume: pd.Series) -> float:
    if len(volume) < 40:
        return 0.0
    current_average = safe_float(volume.iloc[-20:].mean())
    prior_average = safe_float(volume.iloc[-40:-20].mean())
    return current_average / prior_average if prior_average > 0 else 0.0


def calculate_golden_cross(close: pd.Series) -> bool:
    """Detect a 50-day SMA crossing above the 200-day SMA in the last 30 sessions."""
    if len(close) < 230:
        return False
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()
    spread = sma50 - sma200
    recent = spread.iloc[-30:]
    previous = spread.shift(1).iloc[-30:]
    return bool(((recent > 0) & (previous <= 0)).fillna(False).any())


def extract_price_metrics(history: pd.DataFrame, info: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], float]:
    close = numeric_series(history, "Close")
    high = numeric_series(history, "High")
    low = numeric_series(history, "Low")
    volume = numeric_series(history, "Volume")
    current_price = safe_float(close.iloc[-1]) if not close.empty else safe_float(
        first_present(info.get("currentPrice"), info.get("regularMarketPrice"))
    )

    volume_ratio = calculate_volume_ratio(volume)
    market_volume = safe_float(info.get("regularMarketVolume"))
    average_volume = safe_float(first_present(info.get("averageVolume"), info.get("averageVolume10days")))
    interest_ratio = market_volume / average_volume if average_volume > 0 else volume_ratio

    sma50 = safe_float(close.iloc[-50:].mean()) if len(close) >= 50 else safe_float(info.get("fiftyDayAverage"))
    sma200 = safe_float(close.iloc[-200:].mean()) if len(close) >= 200 else safe_float(info.get("twoHundredDayAverage"))

    atr14 = 0.0
    if current_price > 0 and len(high) >= 14 and len(low) >= 14:
        ranges = high.iloc[-14:].reset_index(drop=True) - low.iloc[-14:].reset_index(drop=True)
        atr14 = safe_float(ranges.mean()) / current_price

    year_low = safe_float(info.get("fiftyTwoWeekLow"))
    year_high = safe_float(info.get("fiftyTwoWeekHigh"))
    if year_low <= 0 and not low.empty:
        year_low = safe_float(low.min())
    if year_high <= 0 and not high.empty:
        year_high = safe_float(high.max())

    momentum = {
        "priceChange1d": fractional_change(close, 1),
        "priceChange5d": fractional_change(close, 5),
        "priceChange1m": fractional_change(close, 21),
        "priceChange3m": fractional_change(close, 65),
        "volumeRatio": volume_ratio,
        "rsi14": wilder_rsi(close),
        "beta": safe_float(info.get("beta")),
    }
    technicals = {
        "above50dma": current_price > sma50 if current_price > 0 and sma50 > 0 else False,
        "above200dma": current_price > sma200 if current_price > 0 and sma200 > 0 else False,
        "goldenCross": calculate_golden_cross(close),
        "atr14Pct": max(0.0, atr14),
        "supportDistance": max(0.0, (current_price - year_low) / current_price)
        if current_price > 0 and year_low > 0
        else 0.0,
        "resistanceDistance": max(0.0, (year_high - current_price) / current_price)
        if current_price > 0 and year_high > 0
        else 0.0,
    }
    return momentum, technicals, max(0.0, interest_ratio)


def frame_or_empty(value: Any) -> pd.DataFrame:
    return value.copy() if isinstance(value, pd.DataFrame) else pd.DataFrame()


def naive_timestamp(value: Any) -> pd.Timestamp | None:
    try:
        timestamp = pd.to_datetime(value, errors="coerce", utc=True)
    except (TypeError, ValueError, OverflowError):
        return None
    if isinstance(timestamp, pd.DatetimeIndex) or pd.isna(timestamp):
        return None
    return timestamp.tz_convert(None)


def iter_calendar_values(value: Any) -> Iterable[Any]:
    if isinstance(value, pd.DataFrame):
        for item in value.to_numpy().flat:
            yield item
    elif isinstance(value, pd.Series):
        yield from value.tolist()
    elif isinstance(value, dict):
        for key, item in value.items():
            if "earning" in str(key).lower():
                yield from iter_calendar_values(item)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            yield from iter_calendar_values(item)
    else:
        yield value


def has_upcoming_earnings(calendar: Any) -> bool:
    now = pd.Timestamp.now(tz="UTC").tz_convert(None)
    horizon = now + pd.Timedelta(days=45)
    for raw_value in iter_calendar_values(calendar):
        timestamp = naive_timestamp(raw_value)
        if timestamp is not None and now.normalize() <= timestamp <= horizon:
            return True
    return False


def latest_earnings_beat(ticker: yf.Ticker) -> bool | None:
    try:
        earnings_history = frame_or_empty(ticker.earnings_history)
    except Exception:
        earnings_history = pd.DataFrame()
    if not earnings_history.empty:
        for _, row in earnings_history.sort_index(ascending=False).iterrows():
            reported = optional_float(row.get("epsActual"))
            estimate = optional_float(row.get("epsEstimate"))
            if reported is not None and estimate is not None:
                return reported > estimate

    try:
        earnings_dates = frame_or_empty(ticker.earnings_dates)
    except Exception:
        earnings_dates = pd.DataFrame()
    reported_column = next(
        (column for column in ("Reported EPS", "ReportedEPS") if column in earnings_dates.columns), None
    )
    estimate_column = next(
        (column for column in ("EPS Estimate", "EPSEstimate") if column in earnings_dates.columns), None
    )
    if not reported_column or not estimate_column:
        return None

    dated = earnings_dates.copy()
    dated["_date"] = [naive_timestamp(value) for value in dated.index]
    now = pd.Timestamp.now(tz="UTC").tz_convert(None)
    dated = dated[dated["_date"].notna() & (dated["_date"] <= now)].sort_values("_date", ascending=False)
    for _, row in dated.iterrows():
        reported = optional_float(row.get(reported_column))
        estimate = optional_float(row.get(estimate_column))
        if reported is not None and estimate is not None:
            return reported > estimate
    return None


def rating_rank(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.lower().replace("_", " ").split())
    return RATING_RANK.get(normalized)


def recommendation_counts(recommendations: Any) -> tuple[int, int]:
    frame = frame_or_empty(recommendations)
    if frame.empty:
        return 0, 0

    date_column = next(
        (column for column in ("Date", "GradeDate", "date", "gradedate") if column in frame.columns),
        None,
    )
    raw_dates = frame[date_column] if date_column else frame.index
    dates = pd.Series([naive_timestamp(value) for value in raw_dates], index=frame.index)
    cutoff = pd.Timestamp.now(tz="UTC").tz_convert(None) - pd.Timedelta(days=90)
    recent = frame[dates.notna() & (dates >= cutoff)]

    upgrades = 0
    downgrades = 0
    for _, row in recent.iterrows():
        action = str(first_present(row.get("Action"), row.get("action"), "")).strip().lower()
        if action.startswith("up"):
            upgrades += 1
            continue
        if action.startswith("down"):
            downgrades += 1
            continue

        from_rank = rating_rank(
            first_present(row.get("From Grade"), row.get("FromGrade"), row.get("fromGrade"))
        )
        to_rank = rating_rank(first_present(row.get("To Grade"), row.get("ToGrade"), row.get("toGrade")))
        if from_rank is not None and to_rank is not None:
            upgrades += int(to_rank > from_rank)
            downgrades += int(to_rank < from_rank)
    return upgrades, downgrades


def analyst_consensus(info: dict[str, Any]) -> str | None:
    recommendation = info.get("recommendationKey")
    if isinstance(recommendation, str):
        normalized = recommendation.lower().replace("_", " ").replace("-", " ").strip()
        direct = {
            "strong buy": "Strong Buy",
            "buy": "Buy",
            "hold": "Hold",
            "underperform": "Sell",
            "sell": "Sell",
            "strong sell": "Strong Sell",
        }
        if normalized in direct:
            return direct[normalized]

    mean = optional_float(info.get("recommendationMean"))
    if mean is None:
        return None
    if mean <= 1.5:
        return "Strong Buy"
    if mean <= 2.5:
        return "Buy"
    if mean <= 3.5:
        return "Hold"
    if mean <= 4.5:
        return "Sell"
    return "Strong Sell"


def insider_activity(ticker: yf.Ticker) -> dict[str, Any]:
    try:
        transactions = frame_or_empty(ticker.insider_transactions)
    except Exception:
        transactions = pd.DataFrame()
    if transactions.empty:
        return {"netInsiderBuyPct": 0.0, "recentInsiderBuys": 0, "recentInsiderSells": 0}

    date_column = next(
        (column for column in ("Start Date", "Date", "startDate") if column in transactions.columns),
        None,
    )
    transaction_column = next(
        (column for column in ("Transaction", "Text", "transactionText") if column in transactions.columns),
        None,
    )
    if not date_column or not transaction_column:
        return {"netInsiderBuyPct": 0.0, "recentInsiderBuys": 0, "recentInsiderSells": 0}

    cutoff = pd.Timestamp.now(tz="UTC").tz_convert(None) - pd.Timedelta(days=90)
    dates = transactions[date_column].map(naive_timestamp)
    recent = transactions[dates.notna() & (dates >= cutoff)]
    descriptions = recent[transaction_column].fillna("").astype(str).str.lower()
    buy_mask = descriptions.str.contains(r"\bpurchase|\bbuy|\bacquisition", regex=True)
    sell_mask = descriptions.str.contains(r"\bsale|\bsell|\bdisposition", regex=True)
    buy_count = int(buy_mask.sum())
    sell_count = int(sell_mask.sum())

    shares_column = next(
        (column for column in ("Shares", "shares", "Shares Traded") if column in recent.columns),
        None,
    )
    if shares_column:
        shares = pd.to_numeric(recent[shares_column], errors="coerce").fillna(0).abs()
        buy_amount = safe_float(shares[buy_mask].sum())
        sell_amount = safe_float(shares[sell_mask].sum())
    else:
        buy_amount = float(buy_count)
        sell_amount = float(sell_count)
    total = buy_amount + sell_amount
    net = (buy_amount - sell_amount) / total if total > 0 else 0.0
    return {
        "netInsiderBuyPct": clamp(net, -1.0, 1.0),
        "recentInsiderBuys": buy_count,
        "recentInsiderSells": sell_count,
    }


def fundamental_value(
    info: dict[str, Any],
    info_key: str,
    *,
    nullable: bool = False,
    bounded: bool = False,
) -> tuple[float | None, bool]:
    raw_value = info.get(info_key)
    available = has_real_value(raw_value)
    if nullable:
        return optional_float(raw_value), available
    value = safe_float(raw_value)
    return (clamp(value, 0.0, 1.0) if bounded else value), available


def extract_fundamentals(info: dict[str, Any], market_cap: float) -> tuple[dict[str, Any], dict[str, bool]]:
    fundamentals: dict[str, Any] = {}
    availability: dict[str, bool] = {}
    mappings = (
        ("peRatio", "trailingPE", True, False),
        ("pbRatio", "priceToBook", True, False),
        ("psRatio", "priceToSalesTrailing12Months", True, False),
        ("evEbitda", "enterpriseToEbitda", True, False),
        ("grossMargin", "grossMargins", False, True),
        ("netMargin", "profitMargins", False, True),
        ("operatingMargin", "operatingMargins", False, True),
        ("revenueGrowthYoy", "revenueGrowth", False, False),
        ("epsGrowthYoy", "earningsGrowth", False, False),
        ("debtToEquity", "debtToEquity", False, False),
        ("currentRatio", "currentRatio", False, False),
        ("returnOnEquity", "returnOnEquity", False, True),
        ("returnOnAssets", "returnOnAssets", False, True),
        ("dividendYield", "dividendYield", False, True),
    )
    for output_key, info_key, nullable, bounded in mappings:
        value, is_available = fundamental_value(info, info_key, nullable=nullable, bounded=bounded)
        fundamentals[output_key] = value
        availability[output_key] = is_available

    free_cash_flow = info.get("freeCashflow")
    fcf_available = has_real_value(free_cash_flow) and market_cap > 0
    fcf_yield = safe_float(free_cash_flow) / market_cap if fcf_available else 0.0
    fundamentals["freeCashFlowYield"] = clamp(fcf_yield, 0.0, 1.0)
    availability["freeCashFlowYield"] = fcf_available

    return (
        {key: fundamentals[key] for key in FUNDAMENTAL_KEYS},
        {key: availability[key] for key in FUNDAMENTAL_KEYS},
    )


def build_company(symbol: str) -> dict[str, Any]:
    ticker = yf.Ticker(symbol)
    info = ticker.info or {}
    if not isinstance(info, dict):
        info = {}
    history = frame_or_empty(ticker.history(period="6mo"))

    market_cap = max(0.0, safe_float(info.get("marketCap")))
    fundamentals, fundamentals_availability = extract_fundamentals(info, market_cap)
    momentum, technicals, interest_ratio = extract_price_metrics(history, info)

    try:
        calendar = ticker.calendar
    except Exception:
        calendar = None
    try:
        recommendations = ticker.recommendations
    except Exception:
        recommendations = None
    upgrades, downgrades = recommendation_counts(recommendations)
    if upgrades == 0 and downgrades == 0:
        try:
            upgrades, downgrades = recommendation_counts(ticker.upgrades_downgrades)
        except Exception:
            pass

    current_price = safe_float(first_present(info.get("currentPrice"), info.get("regularMarketPrice")))
    if current_price <= 0:
        close = numeric_series(history, "Close")
        current_price = safe_float(close.iloc[-1]) if not close.empty else 0.0
    target_price = optional_float(info.get("targetMeanPrice"))
    target_upside = (
        (target_price - current_price) / current_price
        if target_price is not None and current_price > 0
        else None
    )

    short_interest = clamp(safe_float(info.get("shortPercentOfFloat")), 0.0, 1.0)
    recommendation_activity = min(upgrades + downgrades, 10) / 10

    # Yahoo exposes no direct social/news score. These transparent 0-100
    # estimates use unusual volume, short interest, and recent analyst activity.
    social_score = clamp(35 + min(interest_ratio, 3.0) * 18 + short_interest * 30, 0.0, 100.0)
    news_score = clamp(30 + min(interest_ratio, 3.0) * 15 + recommendation_activity * 25, 0.0, 100.0)

    return {
        "ticker": symbol,
        "name": str(first_present(info.get("longName"), info.get("shortName"), symbol)),
        "sector": map_sector(info.get("sector")),
        "marketCap": market_cap,
        "marketCapBucket": market_cap_bucket(market_cap),
        "fundamentals": fundamentals,
        "fundamentalsAvailability": fundamentals_availability,
        "momentum": momentum,
        "catalysts": {
            "upcomingEarnings": has_upcoming_earnings(calendar),
            "recentEarningsBeat": latest_earnings_beat(ticker),
            "analystUpgrades": upgrades,
            "analystDowngrades": downgrades,
            "priceTarget": target_price,
            "priceTargetUpside": target_upside,
        },
        "sentiment": {
            "socialScore": social_score,
            "newsScore": news_score,
            "analystConsensus": analyst_consensus(info),
            "shortInterestPct": short_interest,
        },
        "insider": insider_activity(ticker),
        "technicals": technicals,
        # Congressional records stay zero here. The app's live Terminal feed
        # enriches this separately through its configured FMP integration.
        "congressional": {
            "recentBuys": 0,
            "recentSells": 0,
            "netSentiment": 0.0,
        },
    }


def print_coverage(companies: list[dict[str, Any]], requested_count: int) -> None:
    print(f"Fetched {len(companies)} of {requested_count} requested ticker(s).")
    if not companies:
        print("No field coverage available.")
        return

    total_fields = len(companies) * len(FUNDAMENTAL_KEYS)
    covered_fields = sum(
        int(company["fundamentalsAvailability"][key])
        for company in companies
        for key in FUNDAMENTAL_KEYS
    )
    print(f"Fundamentals coverage: {covered_fields}/{total_fields} ({covered_fields / total_fields:.1%})")
    for key in FUNDAMENTAL_KEYS:
        covered = sum(int(company["fundamentalsAvailability"][key]) for company in companies)
        print(f"  {key}: {covered}/{len(companies)} ({covered / len(companies):.1%})")

    nullable_fields = (
        ("recentEarningsBeat", lambda company: company["catalysts"]["recentEarningsBeat"]),
        ("priceTarget", lambda company: company["catalysts"]["priceTarget"]),
        ("priceTargetUpside", lambda company: company["catalysts"]["priceTargetUpside"]),
        ("analystConsensus", lambda company: company["sentiment"]["analystConsensus"]),
    )
    print("Optional field coverage:")
    for label, getter in nullable_fields:
        covered = sum(getter(company) is not None for company in companies)
        print(f"  {label}: {covered}/{len(companies)} ({covered / len(companies):.1%})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch free Yahoo Finance data into Catalyzed Alpha research JSON."
    )
    parser.add_argument("--tickers", nargs="+", required=True, help="Ticker symbols to fetch.")
    parser.add_argument(
        "--output",
        default="src/data/realSignals.json",
        help="Destination JSON path (default: src/data/realSignals.json).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print coverage statistics without writing a file.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    symbols = list(dict.fromkeys(symbol.strip().upper() for symbol in args.tickers if symbol.strip()))
    if not symbols:
        warn("No non-empty ticker symbols were supplied.")
        return 2

    companies: list[dict[str, Any]] = []
    for index, symbol in enumerate(symbols):
        try:
            companies.append(build_company(symbol))
            print(f"Fetched {symbol}", file=sys.stderr)
        except Exception as error:
            warn(f"skipping {symbol}: {error}")
        if index < len(symbols) - 1:
            time.sleep(1.5)

    if args.dry_run:
        print_coverage(companies, len(symbols))
        return 0 if companies else 1

    output_path = Path(args.output).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(companies, indent=2, ensure_ascii=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(companies)} ticker(s) to {output_path}")
    return 0 if companies else 1


if __name__ == "__main__":
    raise SystemExit(main())
