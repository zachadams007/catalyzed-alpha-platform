"""Wire sources for the Terminal cache writer - faithful Python ports.

Each `fetch_*` returns a list of camelCase TerminalEvent dicts (the exact shape
`src/types/terminal.ts` defines and the desktop client produces) so the cache
rows are indistinguishable from a desktop fetch. Every source degrades to `[]`
on any error - one dead source must never blank the wire.

    Keyless (no server-side secret): SEC 8-K full-text, SEC Form 4 insider.
    Keyed (read from the WRITER's env, never the client bundle):
        FMP congress   → FMP_API_KEY
        Alpaca news    → ALPACA_API_KEY + ALPACA_API_SECRET

Ports of: src/data/terminal/edgar8k.ts, alpacaWire.ts, politicianTrades.ts and
scripts/terminal_miner/form4_miner.py (reused directly for insider).
"""

from __future__ import annotations

import datetime
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

from _wire_normalize import (
    classify_8k_severity,
    classify_news_severity,
    classify_politician_severity,
    classify_trade_severity,
    ITEM_8K_LABELS,
    safe_iso,
)

# Contact UA is required by SEC fair-access and good manners for the others.
SEC_USER_AGENT = os.environ.get(
    "SEC_CONTACT", "Catalyzed Alpha research contact@example.com"
)
_LAST_REQUEST_AT = 0.0
_MIN_INTERVAL = 0.15  # be gentle; SEC fair-access is 10/s, we stay well under


def _get(url: str, headers=None, timeout=20) -> bytes:
    """Rate-limited GET with gzip handling. Raises on HTTP/network error."""
    global _LAST_REQUEST_AT
    wait = _MIN_INTERVAL - (time.monotonic() - _LAST_REQUEST_AT)
    if wait > 0:
        time.sleep(wait)
    h = {"User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            encoding = resp.headers.get("Content-Encoding", "").lower()
    finally:
        _LAST_REQUEST_AT = time.monotonic()
    if "gzip" in encoding:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            return gz.read()
    return body


def _get_json(url: str, headers=None, timeout=20):
    return json.loads(_get(url, headers=headers, timeout=timeout).decode("utf-8"))


def _warn(msg: str) -> None:
    print(f"warning: {msg}".replace("\r", " ").replace("\n", " "), file=sys.stderr)


# ── SEC 8-K (market-wide, keyless) - port of edgar8k.ts ───────────────────────

_CIK_TAIL = re.compile(r"\(CIK\s+\d+\)\s*$", re.IGNORECASE)
_TICKER_TAIL = re.compile(r"\(([A-Za-z0-9.\-]{1,10}(?:\s*,\s*[A-Za-z0-9.\-]{1,10})*)\)\s*$")


def _parse_display_name(dn: str):
    """McGraw Hill, Inc.  (MH)  (CIK 0001951070) → company/ticker/related."""
    m = _CIK_TAIL.search(dn)
    head = (dn[: m.start()] if m else dn).strip()
    tk = _TICKER_TAIL.search(head)
    if tk:
        tickers = [t.strip().upper() for t in tk.group(1).split(",") if t.strip()]
        return {
            "company": head[: tk.start()].strip(),
            "ticker": tickers[0] if tickers else "",
            "related": tickers[1:],
        }
    return {"company": head, "ticker": "", "related": []}


def _index_url(cik_padded, accession: str) -> str:
    cik_int = str(int(cik_padded or "0") or 0)
    folder = accession.replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{folder}/{accession}-index.htm"


def fetch_8k(limit=60, lookback_days=7):
    """Recent market-wide 8-K material-event filings via EDGAR full-text search."""
    today = datetime.date.today()
    start = today - datetime.timedelta(days=lookback_days)
    url = (
        "https://efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom"
        f"&startdt={start.isoformat()}&enddt={today.isoformat()}"
    )
    try:
        res = _get_json(url, timeout=15)
    except Exception as e:  # noqa: BLE001 - one dead source never blanks the wire
        _warn(f"SEC 8-K feed unavailable: {e}")
        return []

    hits = (res.get("hits") or {}).get("hits")
    if not isinstance(hits, list):
        return []

    by_accession = {}
    for hit in hits:
        s = hit.get("_source")
        if not s:
            continue
        accession = s.get("adsh") or (hit.get("_id") or "").split(":")[0]
        if not accession or accession in by_accession:
            continue
        form = (s.get("file_type") or s.get("form") or "8-K").upper()
        if not form.startswith("8-K"):
            continue

        items = [i.strip() for i in (s.get("items") or []) if i and i.strip()]
        severity, reason = classify_8k_severity(items)
        names = s.get("display_names") or []
        parsed = _parse_display_name(names[0] if names else "")
        primary_label = reason[5:] if reason.startswith("8-K: ") else "Material event"
        who = parsed["company"] or parsed["ticker"] or "SEC filer"
        summary = (
            " · ".join(f"Item {i}: {ITEM_8K_LABELS.get(i, 'Other')}" for i in items)
            if len(items) > 1
            else None
        )
        occurred = safe_iso(s.get("file_date"))
        ciks = s.get("ciks") or []
        by_accession[accession] = {
            "id": f"8k-{accession}",
            "kind": "filing_8k",
            "severity": severity,
            "ticker": parsed["ticker"],
            "relatedTickers": parsed["related"] or None,
            "companyName": parsed["company"] or None,
            "headline": f"{who} — {primary_label}",
            "summary": summary,
            "occurredAt": occurred,
            "surfacedAt": occurred,
            "source": {
                "name": "SEC 8-K/A · EDGAR" if form == "8-K/A" else "SEC 8-K · EDGAR",
                "url": _index_url(ciks[0] if ciks else None, accession),
            },
            "reason": reason,
        }
        if len(by_accession) >= limit:
            break
    return list(by_accession.values())


# ── SEC Form 4 insider (market-wide, keyless) - reuse form4_miner ─────────────

def fetch_insider(limit=60, min_value=None):
    """Recent open-market insider buys/sells from SEC Form 4 (via form4_miner)."""
    try:
        import form4_miner
    except Exception as e:  # noqa: BLE001
        _warn(f"form4_miner import failed: {e}")
        return []
    try:
        raw = form4_miner.mine(max(limit, 0), min_value)
    except Exception as e:  # noqa: BLE001
        _warn(f"Form 4 mine failed: {e}")
        return []

    out = []
    for r in raw:
        trade = r.get("trade") if isinstance(r.get("trade"), dict) else {}
        actor = r.get("actor") if isinstance(r.get("actor"), dict) else {}
        source = r.get("source") if isinstance(r.get("source"), dict) else {}
        code = trade.get("code") or r.get("transactionCode")
        direction = trade.get("direction") or r.get("direction") or ("buy" if code == "P" else "sell")
        value_usd = trade.get("valueUsd", r.get("valueUsd"))
        severity, reason = classify_trade_severity(direction, value_usd)
        ticker = (r.get("ticker") or "").upper()
        actor_name = actor.get("name") or r.get("actorName") or "Insider"
        role = actor.get("role") or r.get("actorRole") or ""
        verb = "bought" if direction == "buy" else "sold"
        shares = trade.get("shares", r.get("shares"))
        qty = f"{int(shares):,} sh " if isinstance(shares, (int, float)) and shares else ""
        value_label = (
            f" (${value_usd:,.0f})" if isinstance(value_usd, (int, float)) and value_usd else ""
        )
        out.append({
            "id": f"insider-{r.get('id')}",
            "kind": "insider_buy" if direction == "buy" else "insider_sell",
            "severity": severity,
            "ticker": ticker,
            "companyName": r.get("companyName") or None,
            "headline": f"{actor_name} {verb} {qty}{ticker}{value_label}".strip(),
            "summary": role or None,
            "actor": {"name": actor_name, "role": role} if role else {"name": actor_name},
            "trade": {
                "direction": direction,
                "valueUsd": value_usd,
                "shares": shares,
                "pricePerShare": trade.get("pricePerShare", r.get("pricePerShare")),
                "code": code,
            },
            "occurredAt": safe_iso(r.get("occurredAt")),
            "surfacedAt": safe_iso(r.get("surfacedAt")),
            "source": {
                "name": source.get("name") or "SEC Form 4 - EDGAR",
                "url": source.get("url") or r.get("sourceUrl") or "https://www.sec.gov",
            },
            "reason": reason,
        })
    return out


# ── FMP congress (keyed) - port of politicianTrades.ts ────────────────────────

FMP_STABLE = "https://financialmodelingprep.com/stable"


def _parse_amount_range(amount):
    if not amount:
        return None, None
    nums = [int(n.replace(",", "")) for n in re.findall(r"[\d,]+", amount)]
    nums = [n for n in nums if n > 0]
    if not nums:
        return None, None
    return min(nums), max(nums)


def _direction_of(t):
    t = (t or "").lower()
    if "purchase" in t:
        return "buy"
    if "sale" in t:
        return "sell"
    return None


def _actor_role(chamber, district):
    d = (district or "").strip().upper()
    if chamber == "senate":
        return f"Senator ({d})" if d else "Senator"
    m = re.match(r"^([A-Z]{2})(\d{1,2})$", d)
    pretty = f"{m.group(1)}-{m.group(2).zfill(2)}" if m else d
    return f"Rep. ({pretty})" if pretty else "Representative"


def _range_label(lower, upper):
    if lower and upper:
        return f"${lower:,}–${upper:,}"
    if upper:
        return f"up to ${upper:,}"
    return "amount undisclosed"


def _normalize_congress(rows, chamber):
    out = []
    for row in rows or []:
        symbol = row.get("symbol")
        if not symbol:
            continue
        asset_type = row.get("assetType")
        if asset_type and "stock" not in asset_type.lower():
            continue
        direction = _direction_of(row.get("type"))
        if not direction:
            continue
        ticker = symbol.upper()
        name = " ".join(p for p in [row.get("firstName"), row.get("lastName")] if p).strip() or "Member of Congress"
        role = _actor_role(chamber, row.get("district"))
        lower, upper = _parse_amount_range(row.get("amount"))
        severity, reason = classify_politician_severity(direction, upper)
        verb = "bought" if direction == "buy" else "sold"
        desc = row.get("assetDescription")
        out.append({
            "id": f"congress-{chamber}-{ticker}-{row.get('lastName') or '?'}-"
                  f"{row.get('transactionDate') or row.get('disclosureDate')}-{row.get('type') or ''}",
            "kind": "politician_trade",
            "severity": severity,
            "ticker": ticker,
            "companyName": desc or None,
            "headline": f"{name} {verb} {ticker} ({_range_label(lower, upper)})",
            "summary": f"{role} · {desc}" if desc else role,
            "actor": {"name": name, "role": role},
            "trade": {"direction": direction, "valueUsd": upper},
            "occurredAt": safe_iso(row.get("transactionDate")),
            "surfacedAt": safe_iso(row.get("disclosureDate")),
            "source": {
                "name": "Senate disclosure · FMP" if chamber == "senate" else "House disclosure · FMP",
                "url": row.get("link") or "https://efdsearch.senate.gov/search/",
            },
            "reason": reason,
        })
    return out


def fetch_congress():
    """House + Senate periodic transaction reports via FMP (needs FMP_API_KEY)."""
    key = os.environ.get("FMP_API_KEY", "").strip()
    if not key:
        return []
    out = []
    for chamber, path in (("senate", "senate-latest"), ("house", "house-latest")):
        try:
            rows = _get_json(f"{FMP_STABLE}/{path}?page=0&apikey={key}", timeout=12)
            out.extend(_normalize_congress(rows if isinstance(rows, list) else [], chamber))
        except Exception as e:  # noqa: BLE001
            _warn(f"FMP {chamber} feed failed: {e}")
    return out


# ── Alpaca news (keyed) - port of alpacaWire.ts ───────────────────────────────

ALPACA_NEWS = "https://data.alpaca.markets/v1beta1/news"


def _pretty_source(source):
    s = (source or "").strip()
    if not s:
        return "Alpaca"
    return s[0].upper() + s[1:]


def fetch_news(limit=50):
    """Market-wide catalyst wire via Alpaca (needs ALPACA_API_KEY + _SECRET)."""
    key_id = os.environ.get("ALPACA_API_KEY", "").strip()
    secret = os.environ.get("ALPACA_API_SECRET", "").strip()
    if not key_id or not secret:
        return []
    n = min(max(limit, 1), 50)
    url = f"{ALPACA_NEWS}?limit={n}&sort=desc&exclude_contentless=true"
    try:
        res = _get_json(url, headers={"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}, timeout=12)
    except Exception as e:  # noqa: BLE001
        _warn(f"Alpaca news failed: {e}")
        return []

    rows = res.get("news")
    if not isinstance(rows, list):
        return []
    out = []
    for r in rows:
        headline = (r.get("headline") or "").strip()
        link = r.get("url")
        if not headline or not link:
            continue
        symbols = [s.upper() for s in (r.get("symbols") or [])]
        severity, reason = classify_news_severity(headline, r.get("summary") or "")
        occurred = safe_iso(r.get("created_at"))
        out.append({
            "id": f"news-{r.get('id') or link}",
            "kind": "catalyst_news",
            "severity": severity,
            "ticker": symbols[0] if symbols else "",
            "relatedTickers": symbols[1:6] or None,
            "headline": headline,
            "summary": (r.get("summary") or "").strip() or None,
            "occurredAt": occurred,
            "surfacedAt": occurred,
            "source": {"name": _pretty_source(r.get("source")), "url": link},
            "reason": reason,
        })
    return out
