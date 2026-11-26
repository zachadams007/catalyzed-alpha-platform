"""Mine recent SEC EDGAR Form 4 purchases and sales into normalized JSON."""

import argparse
import datetime
import gzip
import io
import json
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET


HEADERS = {
    "User-Agent": "Catalyzed Alpha research contact@example.com",
    "Accept-Encoding": "gzip, deflate",
}
ATOM_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}
REQUEST_INTERVAL_SECONDS = 0.15
_last_request_at = 0.0


def fetch(url):
    """Fetch a URL while respecting SEC request headers and rate limits."""
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


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def direct_child(node, name):
    if node is None:
        return None
    for child in node:
        if local_name(child.tag) == name:
            return child
    return None


def descendant(node, name):
    if node is None:
        return None
    for child in node.iter():
        if local_name(child.tag) == name:
            return child
    return None


def path_text(node, *names):
    current = node
    for name in names:
        current = direct_child(current, name)
        if current is None:
            return ""
    return (current.text or "").strip()


def parse_number(value):
    if not value:
        return None
    number = float(value.replace(",", ""))
    return int(number) if number.is_integer() else number


def parse_date(value):
    return datetime.date.fromisoformat(value).isoformat()


def is_true(value):
    return value.strip().lower() in {"1", "true", "yes"}


def actor_role(relationship):
    roles = []
    if is_true(path_text(relationship, "isOfficer")):
        title = path_text(relationship, "officerTitle")
        roles.append("Officer: " + title if title else "Officer")
    if is_true(path_text(relationship, "isDirector")):
        roles.append("Director")
    if is_true(path_text(relationship, "isTenPercentOwner")):
        roles.append("10% owner")
    return "; ".join(roles)


def trade_severity(direction, value_usd):
    """Mirror the Terminal wire's simple insider-trade severity buckets."""
    if direction == "buy":
        if isinstance(value_usd, (int, float)) and value_usd >= 1_000_000:
            return "high", "Open-market insider purchase >= $1M"
        if isinstance(value_usd, (int, float)) and value_usd >= 250_000:
            return "elevated", "Open-market insider purchase >= $250k"
        return "watch", "Open-market insider purchase"
    if isinstance(value_usd, (int, float)) and value_usd >= 5_000_000:
        return "elevated", "Large disclosed insider sale"
    return "watch", "Disclosed insider sale"


def value_label(value_usd):
    if not isinstance(value_usd, (int, float)):
        return ""
    return f" (${value_usd:,.0f})"


def share_label(shares):
    if not isinstance(shares, (int, float)) or shares <= 0:
        return ""
    return f"{int(shares):,} sh "


def filing_entries(feed_xml):
    root = ET.fromstring(feed_xml)
    entries = []
    for entry in root.findall("atom:entry", ATOM_NAMESPACE):
        link = entry.find("atom:link", ATOM_NAMESPACE)
        updated = entry.findtext("atom:updated", default="", namespaces=ATOM_NAMESPACE)
        # getcurrent ignores ?type=, so keep only true Form 4 (term="4"),
        # excluding Form 3/5 and the unrelated filings the feed mixes in.
        category = entry.find("atom:category", ATOM_NAMESPACE)
        form_type = category.get("term", "") if category is not None else ""
        if form_type and form_type != "4":
            continue
        if link is not None and link.get("href"):
            entries.append((link.get("href"), updated.strip()))
    return entries


def xml_candidates_from_html(index_url, html_bytes):
    """Extract XML hrefs as a fallback when the directory JSON is unavailable."""
    html = html_bytes.decode("utf-8", errors="ignore")
    candidates = []
    lower = html.lower()
    position = 0
    base_url = index_url.rsplit("/", 1)[0] + "/"

    while True:
        xml_end = lower.find(".xml", position)
        if xml_end == -1:
            break
        quote_start = max(html.rfind('"', 0, xml_end), html.rfind("'", 0, xml_end))
        if quote_start != -1:
            href = html[quote_start + 1 : xml_end + 4]
            if href.startswith("http://") or href.startswith("https://"):
                candidates.append(href)
            elif href.startswith("/"):
                candidates.append("https://www.sec.gov" + href)
            else:
                candidates.append(base_url + href)
        position = xml_end + 4

    return candidates


def ownership_document(index_url):
    folder_url = index_url.rsplit("/", 1)[0]
    candidates = []

    try:
        listing = json.loads(fetch(folder_url + "/index.json").decode("utf-8"))
        for item in listing.get("directory", {}).get("item", []):
            name = item.get("name", "")
            if name.lower().endswith(".xml"):
                candidates.append(folder_url + "/" + name)
    except Exception:
        pass

    if not candidates:
        # Older or unusual filing pages can still expose document links in HTML.
        candidates = xml_candidates_from_html(index_url, fetch(index_url))

    for candidate in candidates:
        try:
            document = fetch(candidate)
            if b"<ownershipDocument" in document:
                return document
        except Exception:
            continue
    raise ValueError("primary ownershipDocument XML not found")


def parse_filing(document_xml, surfaced_at, source_url):
    root = ET.fromstring(document_xml)
    issuer = descendant(root, "issuer")
    owner = descendant(root, "reportingOwner")
    relationship = descendant(owner, "reportingOwnerRelationship")

    ticker = path_text(issuer, "issuerTradingSymbol").upper()
    company_name = path_text(issuer, "issuerName")
    actor_name = path_text(descendant(owner, "reportingOwnerId"), "rptOwnerName")
    role = actor_role(relationship)
    events = []

    for transaction in root.iter():
        if local_name(transaction.tag) != "nonDerivativeTransaction":
            continue

        code = path_text(transaction, "transactionCoding", "transactionCode").upper()
        if code not in {"P", "S"}:
            continue

        occurred_at = parse_date(path_text(transaction, "transactionDate", "value"))
        shares = parse_number(path_text(transaction, "transactionAmounts", "transactionShares", "value"))
        price = parse_number(
            path_text(transaction, "transactionAmounts", "transactionPricePerShare", "value")
        )
        # Parse this Form 4 field even though P/S determines the normalized direction.
        _acquired_disposed = path_text(
            transaction,
            "transactionAmounts",
            "transactionAcquiredDisposedCode",
            "value",
        ).upper()
        direction = "buy" if code == "P" else "sell"

        value_usd = shares * price if shares is not None and price is not None else None
        severity, reason = trade_severity(direction, value_usd)
        verb = "bought" if direction == "buy" else "sold"
        actor = {"name": actor_name or "Insider"}
        if role:
            actor["role"] = role
        event = {
            "id": f"{ticker}-{actor_name}-{occurred_at}-{shares}",
            "kind": "insider_buy" if code == "P" else "insider_sell",
            "severity": severity,
            "ticker": ticker,
            "companyName": company_name,
            "headline": (
                f"{actor_name or 'Insider'} {verb} "
                f"{share_label(shares)}{ticker}{value_label(value_usd)}"
            ).strip(),
            "actor": actor,
            "trade": {
                "direction": direction,
                "shares": shares,
                "pricePerShare": price,
                "valueUsd": value_usd,
                "code": code,
            },
            "occurredAt": occurred_at,
            "surfacedAt": surfaced_at,
            "source": {"name": "SEC Form 4 - EDGAR", "url": source_url},
            "reason": reason,
        }
        if role:
            event["summary"] = role
        events.append(event)

    return events


def mine(limit, minimum_value):
    feed_url = (
        "https://www.sec.gov/cgi-bin/browse-edgar"
        f"?action=getcurrent&type=4&owner=only&count={limit}&output=atom"
    )
    try:
        entries = filing_entries(fetch(feed_url))
    except Exception as error:
        warning = str(error).replace("\r", " ").replace("\n", " ")
        print(f"warning: could not fetch SEC Form 4 feed: {warning}", file=sys.stderr)
        return []

    events = []
    for index_url, surfaced_at in entries:
        try:
            filing_events = parse_filing(
                ownership_document(index_url),
                surfaced_at,
                index_url,
            )
            for event in filing_events:
                if (
                    minimum_value is None
                    or event["valueUsd"] is None
                    or event["valueUsd"] >= minimum_value
                ):
                    events.append(event)
        except Exception as error:
            warning = str(error).replace("\r", " ").replace("\n", " ")
            print(f"warning: skipped {index_url}: {warning}", file=sys.stderr)

    events.sort(key=lambda event: event["surfacedAt"], reverse=True)
    deduped = []
    seen = set()
    for event in events:
        if event["id"] in seen:
            continue
        seen.add(event["id"])
        deduped.append(event)
    return deduped


def main():
    parser = argparse.ArgumentParser(
        description="Mine recent SEC Form 4 purchases and sales as normalized JSON."
    )
    parser.add_argument("--limit", type=int, default=80, help="number of filings to scan")
    parser.add_argument("--out", help="optional path to also write the JSON")
    parser.add_argument(
        "--min-value",
        type=float,
        help="drop transactions with a known USD value below this amount",
    )
    args = parser.parse_args()

    events = mine(max(args.limit, 0), args.min_value)
    output = json.dumps(events, indent=2, ensure_ascii=False)
    print(output)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as output_file:
            output_file.write(output)
            output_file.write("\n")


if __name__ == "__main__":
    main()
