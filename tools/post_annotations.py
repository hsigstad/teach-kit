#!/usr/bin/env python3
"""Post replies to hypothes.is annotations.

Reads a mapping file (JSON) listing the annotations to reply to. The file
is a list of entries; each entry must have `parent_id` (the annotation
being replied to) and `reply_text`. Optional: `parent_url` and `group` if
not the same across all entries (otherwise pass via flags).

Each posted reply's id is written back into the mapping file under
`reply_id`, so re-running is a no-op for already-posted entries. Pass
`--force` to repost (creates a new reply each time; old one stays).

Auth: HYPOTHESIS_API_TOKEN (or HYPOTHESIS_TOKEN) env var. Get one at
https://hypothes.is/account/developer.

Usage:
  python3 post_annotations.py --mapping replies.json
  python3 post_annotations.py --mapping replies.json --url URL --group __world__
  python3 post_annotations.py --mapping replies.json --dry-run

Mapping file format (the fields the script reads/writes):
  [
    {"n": 1, "parent_id": "DbW5...", "reply_text": "Confirmed.",
     "parent_url": "https://.../paper.html", "group": "__world__",
     "reply_id": null}
  ]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


API = "https://api.hypothes.is/api/annotations"


def get_token() -> str:
    return (os.environ.get("HYPOTHESIS_API_TOKEN")
            or os.environ.get("HYPOTHESIS_TOKEN")
            or "")


def post_reply(parent_id: str, parent_url: str, reply_text: str,
               group: str, token: str) -> dict | None:
    # IMPORTANT: explicitly set permissions.read to the group, otherwise
    # hypothes.is API inherits the account-level default visibility, which
    # is "Only Me" on some accounts. Result: silent invisible replies that
    # the author can see but coauthors and public viewers cannot. Don't
    # rely on the account default.
    read_perm = group if group.startswith("group:") else f"group:{group}"
    payload = {
        "uri": parent_url,
        "text": reply_text,
        "references": [parent_id],
        "group": group,
        "permissions": {"read": [read_perm]},
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  HTTP {e.code}: {body[:200]}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"  URLError: {e}", file=sys.stderr)
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mapping", required=True,
                    help="Path to JSON mapping file (list of entries).")
    ap.add_argument("--url", default=None,
                    help="Default parent URL if entries lack `parent_url`.")
    ap.add_argument("--group", default="__world__",
                    help="Default group if entries lack `group` (default: __world__).")
    ap.add_argument("--force", action="store_true",
                    help="Repost even if reply_id is already set.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would be posted, don't hit the API.")
    ap.add_argument("--rate-ms", type=int, default=400,
                    help="Milliseconds to sleep between posts (default: 400).")
    args = ap.parse_args()

    if not os.path.exists(args.mapping):
        print(f"Mapping file not found: {args.mapping}", file=sys.stderr)
        return 2

    with open(args.mapping) as f:
        entries = json.load(f)

    token = "" if args.dry_run else get_token()
    if not args.dry_run and not token:
        print("HYPOTHESIS_API_TOKEN (or HYPOTHESIS_TOKEN) not set. Export it "
              "or run with --dry-run.", file=sys.stderr)
        return 2

    ok = fail = skipped = 0
    posted_any = False
    for i, e in enumerate(entries):
        label = f"#{e.get('n', i)}"
        if e.get("reply_id") and not args.force:
            skipped += 1
            print(f"[{label}] already posted ({e['reply_id']}), skipping")
            continue

        text = e.get("reply_text") or ""
        parent_id = e.get("parent_id")
        if not parent_id or not text:
            print(f"[{label}] missing parent_id or reply_text, skipping")
            skipped += 1
            continue

        parent_url = e.get("parent_url") or args.url
        if not parent_url:
            print(f"[{label}] no parent_url and no --url default", file=sys.stderr)
            fail += 1
            continue
        group = e.get("group") or args.group

        if args.dry_run:
            print(f"[{label}] DRY: parent={parent_id} group={group} text={text[:70]}...")
            ok += 1
            continue

        result = post_reply(parent_id, parent_url, text, group, token)
        if result and result.get("id"):
            e["reply_id"] = result["id"]
            e["reply_posted"] = result.get("updated", "")
            ok += 1
            posted_any = True
            print(f"[{label}] posted {result['id']}")
            time.sleep(args.rate_ms / 1000.0)
        else:
            fail += 1
            print(f"[{label}] FAILED")

    if posted_any and not args.dry_run:
        with open(args.mapping, "w") as f:
            json.dump(entries, f, indent=2, ensure_ascii=False)
        print(f"\nMapping updated: {args.mapping}")

    print(f"Done. ok={ok}, fail={fail}, skipped={skipped}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
