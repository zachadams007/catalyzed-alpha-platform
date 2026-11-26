"""Supabase upsert sink for the Terminal wire writer (stdlib only).

Writes normalized `terminal_events` rows to Supabase via the PostgREST endpoint
using the SERVICE-ROLE key, which bypasses RLS (the table allows public SELECT
only; all writes must be server-side). The service-role key is read from the
environment and must NEVER be committed or shipped in the client bundle.

    Required env:
        SUPABASE_URL                e.g. https://xxxx.supabase.co
        SUPABASE_SERVICE_ROLE_KEY   service_role key (Project Settings → API)

Upsert semantics: POST /rest/v1/terminal_events?on_conflict=id with
`Prefer: resolution=merge-duplicates` so re-running the writer refreshes rows
in place instead of erroring on the primary key.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

UPSERT_BATCH = 200  # rows per request; keeps payloads well under PostgREST limits


def supabase_config():
    """Return (url, service_role_key) or raise a clear error if unset."""
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
            "(service-role key — server-side only, never in the client bundle)."
        )
    return url, key


def is_configured() -> bool:
    return bool(
        os.environ.get("SUPABASE_URL", "").strip()
        and os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    )


def _chunks(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def upsert_rows(rows) -> int:
    """Upsert rows into terminal_events. Returns the number of rows written.

    Raises on a hard transport/HTTP error so a scheduled run surfaces failures
    (the orchestrator decides whether to keep going on the next tick).
    """
    if not rows:
        return 0
    url, key = supabase_config()
    endpoint = f"{url}/rest/v1/terminal_events?on_conflict=id"
    headers = {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": f"Bearer {key}",
        # merge-duplicates = upsert; return=minimal keeps the response tiny.
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

    written = 0
    for batch in _chunks(rows, UPSERT_BATCH):
        body = json.dumps(batch).encode("utf-8")
        req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
                if resp.status not in (200, 201, 204):
                    raise RuntimeError(f"upsert HTTP {resp.status}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="ignore")[:500]
            raise RuntimeError(f"upsert HTTP {e.code}: {detail}") from None
        written += len(batch)
    return written
