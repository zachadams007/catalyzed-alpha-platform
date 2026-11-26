"""Fetch most-active / top-gainer / top-loser stocks as normalized JSON.

Primary source: Yahoo Finance public screener JSON API (no key required; same
endpoint their web app calls). Automatically handles the cookie + crumb session
Yahoo requires for authenticated screener access.

Fallback: Finviz HTML screener (stdlib html.parser).

Responsible usage: one request at a time, 0.25 s between calls, honest User-Agent.
"""

import argparse
import datetime
import gzip
import http.cookiejar
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser


# Browser-like headers required by Yahoo Finance / Finviz (not SEC EDGAR).
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)
_YAHOO_HEADERS = {
    "User-Agent": _BROWSER_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://finance.yahoo.com",
    "Referer": "https://finance.yahoo.com/",
}
_FINVIZ_HEADERS = {
    "User-Agent": _BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finviz.com/",
}

REQUEST_INTERVAL_SECONDS = 0.25
_last_request_at = 0.0

# Per-process Yahoo Finance session state.
_yahoo_crumb = None
_yahoo_jar = None

SCREENER_TYPES = ("most-active", "gainers", "losers")
_YAHOO_SCR_IDS = {
    "most-active": "most_actives",
    "gainers": "day_gainers",
    "losers": "day_losers",
}
_FINVIZ_SCR_IDS = {
    "most-active": "ta_mostactive",
    "gainers": "ta_topgainers",
    "losers": "ta_toplosers",
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _throttle():
    global _last_request_at
    wait = REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def _fetch_raw(url, headers, jar=None):
    """Low-level fetch; returns decompressed bytes."""
    _throttle()
    req = urllib.request.Request(url, headers=headers)
    if jar is not None:
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        ctx = opener.open(req, timeout=30)
    else:
        ctx = urllib.request.urlopen(req, timeout=30)
    with ctx as response:
        body = response.read()
        encoding = response.headers.get("Content-Encoding", "").lower()
    if "gzip" in encoding:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            return gz.read()
    return body


# ---------------------------------------------------------------------------
# Yahoo Finance - session + screener
# ---------------------------------------------------------------------------

def _ensure_yahoo_session():
    """Establish Yahoo Finance cookie session and crumb (once per process)."""
    global _yahoo_crumb, _yahoo_jar
    if _yahoo_crumb:
        return

    _yahoo_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_yahoo_jar))

    # Step 1: seed cookies from the Yahoo Finance homepage.
    _throttle()
    try:
        with opener.open(
            urllib.request.Request("https://finance.yahoo.com/", headers=_YAHOO_HEADERS),
            timeout=20,
        ):
            pass
    except Exception:
        pass  # redirects or errors still set cookies

    # Step 2: retrieve the crumb token.
    _throttle()
    with opener.open(
        urllib.request.Request(
            "https://query2.finance.yahoo.com/v1/test/getcrumb",
            headers=_YAHOO_HEADERS,
        ),
        timeout=20,
    ) as resp:
        _yahoo_crumb = resp.read().decode("utf-8").strip()


def _mine_yahoo(screener_type, limit):
    """Return mover records from Yahoo Finance screener JSON."""
    scr_id = _YAHOO_SCR_IDS[screener_type]
    base = (
        "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved"
        f"?scrIds={scr_id}&count={limit}&formatted=false&lang=en-US&region=US"
    )

    # Attempt without crumb first; on 401/403 retry with crumb.
    try:
        raw = _fetch_raw(base, _YAHOO_HEADERS)
    except urllib.error.HTTPError as err:
        if err.code not in (401, 403):
            raise
        _ensure_yahoo_session()
        crumb_url = base + "&crumb=" + urllib.parse.quote(_yahoo_crumb, safe="")
        raw = _fetch_raw(crumb_url, _YAHOO_HEADERS, jar=_yahoo_jar)

    data = json.loads(raw.decode("utf-8"))
    results = (data.get("finance") or {}).get("result") or []
    if not results:
        return []
    quotes = results[0].get("quotes") or []

    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    source_url = f"https://finance.yahoo.com/{screener_type.replace('most-active', 'most-active')}"
    records = []
    for rank, q in enumerate(quotes, start=1):
        records.append({
            "rank": rank,
            "ticker": q.get("symbol", ""),
            "companyName": q.get("shortName") or q.get("longName") or "",
            "price": q.get("regularMarketPrice"),
            "changeAbs": q.get("regularMarketChange"),
            "changePct": q.get("regularMarketChangePercent"),
            "volume": q.get("regularMarketVolume"),
            "avgVolume30d": q.get("averageDailyVolume3Month"),
            "marketCapRaw": q.get("marketCap"),
            "screenerType": screener_type,
            "fetchedAt": now_iso,
            "source": "yahoo_finance",
            "sourceUrl": source_url,
        })
    return records


# ---------------------------------------------------------------------------
# Finviz HTML fallback
# ---------------------------------------------------------------------------

class _FinvizParser(HTMLParser):
    """Extract the stock data table from a Finviz screener HTML page."""

    def __init__(self):
        super().__init__()
        self.headers = []
        self.rows = []
        self._in_tr = False
        self._header_row = False
        self._row = []
        self._cell = []
        self._found_header = False
        self._depth = 0  # nested tag depth inside a td

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)
        if tag == "tr":
            self._in_tr = True
            self._row = []
            cls = attrs_d.get("class", "")
            self._header_row = "table-top" in cls
        elif tag == "td" and self._in_tr:
            self._cell = []
            self._depth = 0
        elif tag in ("a", "span", "b", "small") and self._in_tr:
            self._depth += 1

    def handle_endtag(self, tag):
        if tag == "td" and self._in_tr:
            self._row.append("".join(self._cell).strip())
        elif tag == "tr":
            if self._row:
                if self._header_row and "Ticker" in self._row:
                    self.headers = self._row
                    self._found_header = True
                elif self._found_header and len(self._row) >= max(len(self.headers), 3):
                    self.rows.append(self._row[: len(self.headers)])
            self._in_tr = False
            self._header_row = False
        elif tag in ("a", "span", "b", "small") and self._in_tr:
            self._depth = max(0, self._depth - 1)

    def handle_data(self, data):
        if self._in_tr and self._cell is not None:
            self._cell.append(data)


def _parse_finviz_number(text):
    """Parse strings like '1.45B', '25.50', '-3.25%' into float or None."""
    if not text or text == "-":
        return None
    text = text.strip().rstrip("%").replace(",", "")
    multiplier = 1.0
    if text and text[-1] in "KMBTkmbt":
        suffix = text[-1].upper()
        text = text[:-1]
        multiplier = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[suffix]
    try:
        return float(text) * multiplier
    except ValueError:
        return None


def _mine_finviz(screener_type, limit):
    """Return mover records scraped from the Finviz HTML screener."""
    scr_id = _FINVIZ_SCR_IDS[screener_type]
    url = f"https://finviz.com/screener.ashx?v=111&s={scr_id}&o=-volume"
    raw = _fetch_raw(url, _FINVIZ_HEADERS)
    html = raw.decode("utf-8", errors="ignore")

    parser = _FinvizParser()
    parser.feed(html)

    if not parser.headers or not parser.rows:
        raise RuntimeError("Finviz: could not locate screener table in HTML response")

    # Build column-index lookup (case-insensitive).
    col = {h.lower(): i for i, h in enumerate(parser.headers)}

    def cell(row, name, default=""):
        idx = col.get(name.lower())
        return row[idx] if idx is not None and idx < len(row) else default

    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    records = []
    for row in parser.rows[:limit]:
        ticker = cell(row, "ticker")
        if not ticker or not ticker.replace(".", "").isalnum():
            continue
        records.append({
            "rank": len(records) + 1,
            "ticker": ticker,
            "companyName": cell(row, "company"),
            "price": _parse_finviz_number(cell(row, "price")),
            "changeAbs": None,
            "changePct": _parse_finviz_number(cell(row, "change")),
            "volume": _parse_finviz_number(cell(row, "volume")),
            "avgVolume30d": None,
            "marketCapRaw": _parse_finviz_number(cell(row, "market cap")),
            "screenerType": screener_type,
            "fetchedAt": now_iso,
            "source": "finviz",
            "sourceUrl": url,
        })
    return records


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def mine(screener_type, limit):
    """Return a list of mover records; tries Yahoo Finance then Finviz."""
    try:
        records = _mine_yahoo(screener_type, limit)
        if records:
            return records
        raise RuntimeError("Yahoo Finance returned empty result set")
    except Exception as err:
        msg = str(err).replace("\n", " ")
        print(f"warning: Yahoo Finance screener failed ({msg}); trying Finviz …", file=sys.stderr)

    try:
        return _mine_finviz(screener_type, limit)
    except Exception as err:
        msg = str(err).replace("\n", " ")
        print(f"warning: Finviz screener also failed: {msg}", file=sys.stderr)
        return []


def main():
    parser = argparse.ArgumentParser(
        description="Fetch most-active / top-gainer / top-loser stocks as normalized JSON."
    )
    parser.add_argument(
        "--type",
        dest="screener_type",
        choices=SCREENER_TYPES,
        default="most-active",
        help="screener to run (default: most-active)",
    )
    parser.add_argument(
        "--limit", type=int, default=25,
        help="max number of stocks to return (default 25)",
    )
    parser.add_argument("--out", help="optional file path to also write the JSON")
    args = parser.parse_args()

    records = mine(args.screener_type, max(args.limit, 1))
    output = json.dumps(records, indent=2, ensure_ascii=False)
    print(output)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output)
            f.write("\n")


if __name__ == "__main__":
    main()
