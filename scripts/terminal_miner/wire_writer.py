#!/usr/bin/env python3
"""Terminal wire cache WRITER - fills Supabase `terminal_events` for web/phone.

The desktop app fetches the live wire directly (keys on-device). A production
web/phone bundle ships no keys and no dev proxy, so it reads the same wire from
the `terminal-feed` edge function, which serves the `terminal_events` cache.
THIS script is that cache's writer: it crawls the wire sources ONCE (the
"offload API usage to Python" play - every client then reads the cache cheaply
instead of each hammering the vendors), normalizes to the TerminalEvent
contract, and upserts with the service-role key.

Sources (each degrades to [] independently):
    SEC 8-K full-text   keyless   (always on)
    SEC Form 4 insider  keyless   (always on)
    FMP congress        FMP_API_KEY            (server-side env)
    Alpaca news         ALPACA_API_KEY/_SECRET (server-side env)

Run:
    # one pass (what a cron tick runs) - needs the write env set:
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
    FMP_API_KEY=... ALPACA_API_KEY=... ALPACA_API_SECRET=... \
        python scripts/terminal_miner/wire_writer.py --once

    # verify normalization WITHOUT writing (no service-role key needed):
    python scripts/terminal_miner/wire_writer.py --dry-run --no-congress --no-news

    # long-running fallback scheduler (prefer OS cron/Task Scheduler):
    python scripts/terminal_miner/wire_writer.py --loop 900

Exit code 0 on success (incl. a clean dry-run); non-zero if a write was
requested but the sink/env failed.
"""

from __future__ import annotations

import argparse
import sys
import time

# Event reasons/labels carry ≥ / – / · (kept identical to the TS sources); force
# UTF-8 so dry-run output never dies on a cp1252 Windows console.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older/redirected streams: best-effort only
        pass

import _wire_sink as sink
import _wire_sources as sources
from _wire_normalize import event_to_row


def gather(args):
    """Run every enabled source, returning a flat list of TerminalEvent dicts."""
    events = []
    if not args.no_8k:
        events += sources.fetch_8k(limit=args.limit_8k)
    if not args.no_insider:
        events += sources.fetch_insider(limit=args.limit_insider, min_value=args.min_value)
    if not args.no_congress:
        events += sources.fetch_congress()
    if not args.no_news:
        events += sources.fetch_news(limit=args.limit_news)
    return events


def dedupe(events):
    """Collapse duplicate ids (mirrors terminalFeed.ts dedupe), keeping first."""
    seen = set()
    out = []
    for e in events:
        eid = e.get("id")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        out.append(e)
    return out


def summarize(events):
    counts = {}
    for e in events:
        counts[e["kind"]] = counts.get(e["kind"], 0) + 1
    return counts


def run_once(args) -> int:
    events = dedupe(gather(args))
    counts = summarize(events)
    by_kind = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "(none)"
    print(f"gathered {len(events)} events: {by_kind}", file=sys.stderr)

    if args.dry_run:
        if args.verbose and events:
            import json
            print(json.dumps([event_to_row(e) for e in events[:3]], indent=2, ensure_ascii=False))
        print(f"dry-run: would upsert {len(events)} rows (no write performed)", file=sys.stderr)
        return 0

    if not sink.is_configured():
        print(
            "error: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY not set — cannot write. "
            "Use --dry-run to verify sources without writing.",
            file=sys.stderr,
        )
        return 2

    rows = [event_to_row(e) for e in events]
    try:
        written = sink.upsert_rows(rows)
    except Exception as e:  # noqa: BLE001 - surface write failures to the scheduler
        print(f"error: upsert failed: {e}", file=sys.stderr)
        return 1
    print(f"upserted {written} rows into terminal_events", file=sys.stderr)
    return 0


def build_parser():
    p = argparse.ArgumentParser(description="Fill the Terminal wire cache (terminal_events).")
    p.add_argument("--once", action="store_true", help="run a single pass (default)")
    p.add_argument("--loop", type=int, metavar="SECONDS",
                   help="re-run every N seconds (fallback scheduler; prefer OS cron)")
    p.add_argument("--dry-run", action="store_true",
                   help="gather + normalize but do NOT write (no service-role key needed)")
    p.add_argument("--limit-8k", type=int, default=60, help="max 8-K filings (default 60)")
    p.add_argument("--limit-insider", type=int, default=60, help="Form 4 filings to scan (default 60)")
    p.add_argument("--limit-news", type=int, default=50, help="max news articles (default 50)")
    p.add_argument("--min-value", type=float, default=None, help="drop insider trades below this USD value")
    p.add_argument("--no-8k", action="store_true", help="skip the SEC 8-K source")
    p.add_argument("--no-insider", action="store_true", help="skip the SEC Form 4 source")
    p.add_argument("--no-congress", action="store_true", help="skip the FMP congress source")
    p.add_argument("--no-news", action="store_true", help="skip the Alpaca news source")
    p.add_argument("--verbose", action="store_true", help="print a few sample rows on dry-run")
    return p


def main():
    args = build_parser().parse_args()
    if args.loop:
        interval = max(args.loop, 60)
        print(f"wire_writer loop: every {interval}s (Ctrl-C to stop)", file=sys.stderr)
        while True:
            try:
                run_once(args)
            except Exception as e:  # noqa: BLE001 - a loop must outlive one bad tick
                print(f"error: tick failed: {e}", file=sys.stderr)
            time.sleep(interval)
    else:
        sys.exit(run_once(args))


if __name__ == "__main__":
    main()
