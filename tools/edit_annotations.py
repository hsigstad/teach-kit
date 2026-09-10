#!/usr/bin/env python3
"""Edit or delete replies previously posted with post_annotations.py.

Works on the same mapping file format: a JSON list of entries, each with
a `reply_id` set by `post_annotations.py`.

Auth: HYPOTHESIS_API_TOKEN (or HYPOTHESIS_TOKEN). You must own the reply
to PATCH or DELETE it.

Usage:
  python3 edit_annotations.py --mapping replies.json --list
  python3 edit_annotations.py --mapping replies.json --n 7 --text "..."
  python3 edit_annotations.py --mapping replies.json --n 7 --text-file new.txt
  python3 edit_annotations.py --mapping replies.json --n 7 --delete
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


API = "https://api.hypothes.is/api/annotations"


def get_token() -> str:
    return (os.environ.get("HYPOTHESIS_API_TOKEN")
            or os.environ.get("HYPOTHESIS_TOKEN")
            or "")


def api_call(method: str, reply_id: str, token: str,
             body: dict | None = None) -> dict | None:
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(
        f"{API}/{reply_id}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            # DELETE returns no body in some implementations; tolerate empty
            txt = r.read().decode("utf-8")
            return json.loads(txt) if txt else {"ok": True}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {body_text[:300]}", file=sys.stderr)
        return None


def find_entry(entries: list[dict], n: int) -> dict | None:
    for e in entries:
        if e.get("n") == n:
            return e
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mapping", required=True, help="Path to mapping JSON.")
    ap.add_argument("--n", type=int, help="Entry number to edit/delete.")
    ap.add_argument("--text", help="New reply text (inline).")
    ap.add_argument("--text-file", help="New reply text (file).")
    ap.add_argument("--delete", action="store_true", help="Delete the reply.")
    ap.add_argument("--list", action="store_true",
                    help="List all entries with their reply previews.")
    args = ap.parse_args()

    if not os.path.exists(args.mapping):
        print(f"Mapping file not found: {args.mapping}", file=sys.stderr)
        return 2

    with open(args.mapping) as f:
        entries = json.load(f)

    if args.list:
        for e in entries:
            n = e.get("n", "?")
            rid = e.get("reply_id") or "(unposted)"
            preview = (e.get("reply_text") or "")[:70].replace("\n", " ")
            print(f"[{n!s:>3}] reply={rid}  {preview}")
        return 0

    if args.n is None:
        ap.print_help()
        return 2

    token = get_token()
    if not token:
        print("HYPOTHESIS_API_TOKEN (or HYPOTHESIS_TOKEN) not set.",
              file=sys.stderr)
        return 2

    entry = find_entry(entries, args.n)
    if not entry:
        print(f"No entry #{args.n} in {args.mapping}", file=sys.stderr)
        return 1
    reply_id = entry.get("reply_id")
    if not reply_id:
        print(f"Entry #{args.n} has no reply_id (unposted?)", file=sys.stderr)
        return 1

    if args.delete:
        if api_call("DELETE", reply_id, token) is None:
            return 1
        print(f"Deleted reply {reply_id} (entry #{args.n})")
        entry["reply_id"] = None
        entry["reply_text"] = None
    else:
        new_text = args.text
        if args.text_file:
            with open(args.text_file) as f:
                new_text = f.read().strip()
        if not new_text:
            print("Provide --text, --text-file, or --delete.", file=sys.stderr)
            return 2
        result = api_call("PATCH", reply_id, token, {"text": new_text})
        if result is None:
            return 1
        print(f"Edited reply {reply_id} (entry #{args.n})")
        entry["reply_text"] = new_text
        entry["reply_updated"] = result.get("updated", "")

    with open(args.mapping, "w") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
