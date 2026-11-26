"""Fetch an earnings / economic calendar as normalized JSON.

Primary source: Nasdaq's public earnings calendar API (no key required).
Fallback: Yahoo Finance earnings calendar API.

Outputs one event per company reporting earnings on the requested date(s).
"""

import argparse
import datetime
import gzip
import io
import json
import sys
import time
import urllib.error
import urllib.request


_NASDAQ_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/market-activity/earnings",
}
_YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
}

REQUEST_INTERVAL_SECONDS = 0.25
_last_request_at = 0.0


def _throttle():
    global _last_request_at
    wait = REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def _fetch(url, headers):
    """Fetch with rate limiting and gzip handling."""
    _throttle()
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read()
        encoding = response.headers.get("Content-Encoding", "").lower()
    if "gzip" in encoding:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            return gz.read()
    return body


# ---------------------------------------------------------------------------
# Nasdaq primary source
# ---------------------------------------------------------------------------

_REPORT_TIME_LABELS = {
    "time_pre_market": "pre-market",
    "time_after_hours": "after-hours",
    "time_not_supplied": "TBA",
    "": "TBA",
}


def _parse_eps(raw):
    """Convert an EPS string like '1.45' or 'N/A' to float or None."""
    if not raw or raw.strip().upper() in ("N/A", "-", ""):
        return None
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def _nasdaq_day(date_str):
    """Fetch earnings for one date (YYYY-MM-DD) from Nasdaq; return list of records."""
    url = f"https://api.nasdaq.com/api/calendar/earnings?date={date_str}"
    raw = _fetch(url, _NASDAQ_HEADERS)
    data = json.loads(raw.decode("utf-8"))

    rows = (data.get("data") or {}).get("rows") or []
    records = []
    for row in rows:
        symbol = (row.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        report_time_raw = (row.get("marketTime") or "").strip()
        records.append({
            "id": f"{symbol}-{date_str}",
            "kind": "earnings",
            "ticker": symbol,
            "companyName": (row.get("name") or "").strip(),
            "reportDate": date_str,
            "reportTime": _REPORT_TIME_LABELS.get(report_time_raw, report_time_raw),
            "fiscalQuarterEnding": (row.get("fiscalQuarterEnding") or "").strip(),
            "epsEstimate": _parse_eps(row.get("epsForecast")),
            "numAnalysts": _safe_int(row.get("noOfEsts")),
            "lastYearEps": _parse_eps(row.get("lastYearEPS")),
            "lastYearReportDate": _normalize_date(row.get("lastYearRptDt")),
            "source": "nasdaq",
            "sourceUrl": "https://www.nasdaq.com/market-activity/earnings",
        })
    return records


def _normalize_date(raw):
    """Try to return an ISO date string from various input formats; else None."""
    if not raw or not raw.strip() or raw.strip().upper() in ("N/A", "-", "TBD", ""):
        return None
    raw = raw.strip()
    # Already ISO
    if len(raw) == 10 and raw[4] == "-":
        return raw
    # M/D/YYYY or MM/DD/YYYY
    parts = raw.split("/")
    if len(parts) == 3:
        try:
            m, d, y = int(parts[0]), int(parts[1]), int(parts[2])
            return datetime.date(y, m, d).isoformat()
        except (ValueError, TypeError):
            pass
    return raw  # return as-is rather than dropping it


def _safe_int(raw):
    if raw is None:
        return None
    try:
        return int(str(raw).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _mine_nasdaq(dates):
    """Fetch earnings for a list of date strings; return combined list."""
    all_records = []
    for d in dates:
        try:
            records = _nasdaq_day(d)
            all_records.extend(records)
        except Exception as err:
            msg = str(err).replace("\n", " ")
            print(f"warning: Nasdaq earnings failed for {d}: {msg}", file=sys.stderr)
    return all_records


# ---------------------------------------------------------------------------
# Yahoo Finance fallback
# ---------------------------------------------------------------------------

def _yahoo_earnings_day(date_str):
    """Fetch Yahoo Finance earnings calendar for one date."""
    url = (
        "https://query1.finance.yahoo.com/v1/finance/earnings-calendar"
        f"?date={date_str}&lang=en-US&region=US&formatted=false"
    )
    raw = _fetch(url, _YAHOO_HEADERS)
    data = json.loads(raw.decode("utf-8"))

    # Yahoo Finance earnings calendar response structure.
    results = (
        (data.get("timeSeries") or {}).get("result")
        or (data.get("finance") or {}).get("result")
        or []
    )
    records = []
    for entry in results:
        symbol = (entry.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        records.append({
            "id": f"{symbol}-{date_str}",
            "kind": "earnings",
            "ticker": symbol,
            "companyName": "",
            "reportDate": date_str,
            "reportTime": "TBA",
            "fiscalQuarterEnding": None,
            "epsEstimate": _parse_eps(entry.get("epsEstimateMean") or entry.get("epsEstimate")),
            "numAnalysts": None,
            "lastYearEps": None,
            "lastYearReportDate": None,
            "source": "yahoo_finance",
            "sourceUrl": f"https://finance.yahoo.com/calendar/earnings?day={date_str}",
        })
    return records


def _mine_yahoo_fallback(dates):
    all_records = []
    for d in dates:
        try:
            records = _yahoo_earnings_day(d)
            all_records.extend(records)
        except Exception as err:
            msg = str(err).replace("\n", " ")
            print(f"warning: Yahoo earnings fallback failed for {d}: {msg}", file=sys.stderr)
    return all_records


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def _date_range(start_date, days):
    """Return a list of YYYY-MM-DD strings for [start_date, start_date + days)."""
    return [
        (start_date + datetime.timedelta(days=i)).isoformat()
        for i in range(days)
    ]


def mine(start_date, days):
    """Return earnings events for the given date range.

    Tries Nasdaq API first; falls back to Yahoo Finance on failure.
    """
    dates = _date_range(start_date, days)
    # Skip weekends - exchanges don't report on weekends.
    weekday_dates = [d for d in dates if datetime.date.fromisoformat(d).weekday() < 5]

    records = _mine_nasdaq(weekday_dates)
    if records:
        records.sort(key=lambda r: (r["reportDate"], r["ticker"]))
        return records

    print("warning: Nasdaq earnings returned no data; trying Yahoo Finance …", file=sys.stderr)
    records = _mine_yahoo_fallback(weekday_dates)
    records.sort(key=lambda r: (r["reportDate"], r["ticker"]))
    return records


def main():
    parser = argparse.ArgumentParser(
        description="Fetch earnings calendar events as normalized JSON."
    )
    date_group = parser.add_mutually_exclusive_group()
    date_group.add_argument(
        "--date",
        help="single date to fetch (YYYY-MM-DD); defaults to today",
    )
    date_group.add_argument(
        "--week",
        action="store_true",
        help="fetch the current calendar week (Mon–Fri)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=1,
        help="number of days to fetch starting from --date (default 1)",
    )
    parser.add_argument("--out", help="optional file path to also write the JSON")
    args = parser.parse_args()

    today = datetime.date.today()
    if args.week:
        start = today - datetime.timedelta(days=today.weekday())  # Monday
        days = 5
    elif args.date:
        try:
            start = datetime.date.fromisoformat(args.date)
        except ValueError:
            parser.error(f"--date must be YYYY-MM-DD, got: {args.date!r}")
        days = max(args.days, 1)
    else:
        start = today
        days = max(args.days, 1)

    records = mine(start, days)
    output = json.dumps(records, indent=2, ensure_ascii=False)
    print(output)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output)
            f.write("\n")


if __name__ == "__main__":
    main()
