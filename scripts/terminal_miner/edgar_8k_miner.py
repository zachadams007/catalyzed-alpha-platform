"""Mine recent SEC EDGAR 8-K (material event) filings by ticker into normalized JSON.

Uses two EDGAR public APIs (no key required):
  1. https://www.sec.gov/files/company_tickers.json  – ticker → CIK lookup
  2. https://data.sec.gov/submissions/CIK{cik}.json  – per-company filing index

SEC usage policy: https://www.sec.gov/developer
"""

import argparse
import datetime
import gzip
import io
import json
import sys
import time
import urllib.request


HEADERS = {
    "User-Agent": "Catalyzed Alpha research contact@example.com",
    "Accept-Encoding": "gzip, deflate",
}
REQUEST_INTERVAL_SECONDS = 0.15
_last_request_at = 0.0

_ticker_map = None  # cached once per process


def fetch(url):
    """Fetch a URL with SEC-compliant headers and rate limiting."""
    global _last_request_at
    wait = REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            encoding = response.headers.get("Content-Encoding", "").lower()
    finally:
        _last_request_at = time.monotonic()
    if "gzip" in encoding:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
            return compressed.read()
    return body


def _load_ticker_map():
    """Download and cache EDGAR's public ticker → CIK registry (~1.7 MB, once per process)."""
    global _ticker_map
    if _ticker_map is None:
        raw = fetch("https://www.sec.gov/files/company_tickers.json")
        data = json.loads(raw.decode("utf-8"))
        _ticker_map = {
            entry["ticker"].upper(): (str(entry["cik_str"]).zfill(10), entry["title"])
            for entry in data.values()
        }
    return _ticker_map


def resolve_cik(ticker):
    """Return (zero-padded-10-digit CIK, company name) for the given ticker symbol."""
    mapping = _load_ticker_map()
    key = ticker.strip().upper()
    if key not in mapping:
        raise ValueError(f"ticker '{ticker}' not found in EDGAR company registry")
    return mapping[key]


def fetch_submissions(cik_padded):
    """Fetch the EDGAR company submissions JSON for a 10-digit CIK."""
    url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    return json.loads(fetch(url).decode("utf-8"))


_ITEM_LABELS = {
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
    "5.02": "Departure or Election of Directors/Officers",
    "5.03": "Amendment to Articles of Incorporation",
    "5.04": "Suspension of Trading Under Benefit Plan",
    "5.05": "Amendment to Code of Ethics",
    "5.06": "Change in Shell Company Status",
    "5.07": "Submission to Security Holder Vote",
    "5.08": "Shareholder Nominations",
    "7.01": "Regulation FD Disclosure",
    "8.01": "Other Events",
    "9.01": "Financial Statements and Exhibits",
}


def _parse_items(raw):
    """Split EDGAR items string ('2.02,9.01') into a list of code strings."""
    if not raw:
        return []
    return [p.strip() for p in raw.replace(";", ",").split(",") if p.strip()]


def _source_url(cik_int, accession_no):
    folder = accession_no.replace("-", "")
    return (
        f"https://www.sec.gov/Archives/edgar/data/{cik_int}"
        f"/{folder}/{accession_no}-index.htm"
    )


def mine(tickers, limit, days):
    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    all_events = []

    for ticker in tickers:
        try:
            cik_padded, company_name = resolve_cik(ticker)
        except Exception as err:
            print(f"warning: {err}", file=sys.stderr)
            continue

        try:
            data = fetch_submissions(cik_padded)
        except Exception as err:
            msg = str(err).replace("\n", " ")
            print(f"warning: could not fetch EDGAR submissions for {ticker}: {msg}", file=sys.stderr)
            continue

        recent = data.get("filings", {}).get("recent", {})
        forms = recent.get("form", [])
        dates = recent.get("filingDate", [])
        accessions = recent.get("accessionNumber", [])
        raw_items = recent.get("items", [])
        cik_int = int(cik_padded)
        ticker_upper = ticker.strip().upper()
        count = 0

        for i, form in enumerate(forms):
            if form not in {"8-K", "8-K/A"}:
                continue
            filed_at = dates[i] if i < len(dates) else ""
            if filed_at < cutoff:
                # Submissions JSON is newest-first; safe to stop here.
                break
            try:
                acc = accessions[i] if i < len(accessions) else ""
                items_str = raw_items[i] if i < len(raw_items) else ""
                items = _parse_items(items_str)
                item_labels = [
                    f"Item {code}: {_ITEM_LABELS.get(code, 'Unknown')}"
                    for code in items
                ]
                all_events.append({
                    "id": f"{ticker_upper}-{acc}",
                    "kind": "8k_filing",
                    "ticker": ticker_upper,
                    "companyName": company_name,
                    "cik": cik_padded.lstrip("0") or "0",
                    "filedAt": filed_at,
                    "accessionNo": acc,
                    "formType": form,
                    "items": items,
                    "itemDescriptions": item_labels,
                    "sourceUrl": _source_url(cik_int, acc) if acc else "",
                })
                count += 1
                if count >= limit:
                    break
            except Exception as err:
                msg = str(err).replace("\n", " ")
                print(f"warning: skipped entry {i} for {ticker}: {msg}", file=sys.stderr)

    all_events.sort(key=lambda e: e["filedAt"], reverse=True)
    return all_events


def main():
    parser = argparse.ArgumentParser(
        description="Mine recent SEC EDGAR 8-K material event filings by ticker."
    )
    parser.add_argument("tickers", nargs="+", help="one or more stock tickers (e.g. AAPL MSFT)")
    parser.add_argument(
        "--limit", type=int, default=20,
        help="max 8-K filings to return per ticker (default 20)",
    )
    parser.add_argument(
        "--days", type=int, default=90,
        help="look-back window in days (default 90)",
    )
    parser.add_argument("--out", help="optional file path to also write the JSON")
    args = parser.parse_args()

    events = mine(args.tickers, max(args.limit, 1), max(args.days, 1))
    output = json.dumps(events, indent=2, ensure_ascii=False)
    print(output)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output)
            f.write("\n")


if __name__ == "__main__":
    main()
