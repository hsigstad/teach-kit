#!/usr/bin/env python3
"""Fetch hypothes.is annotations for a project's site URL prefix.

Usage:
  python3 fetch_annotations.py --url-prefix https://hsigstad.github.io/serasa/ \\
      [--group GROUP_ID] [--since YYYY-MM-DD] [--json]

For private groups, set HYPOTHESIS_TOKEN (from hypothes.is/account/developer).
Public annotations do not require a token.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://hypothes.is/api/search"
PAGE_SIZE = 200


def _request(params, token):
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def _extract_quote(row):
    for target in row.get("target", []):
        for sel in target.get("selector", []):
            if sel.get("type") == "TextQuoteSelector":
                return sel.get("exact", "")
    return ""


def fetch_all(url_prefix, group=None, since=None, token=None):
    # wildcard_uri matches anything under the prefix
    params = {
        "wildcard_uri": url_prefix.rstrip("/") + "/*",
        "limit": str(PAGE_SIZE),
        "sort": "updated",
        "order": "asc",
    }
    if group:
        params["group"] = group

    results = []
    search_after = None
    while True:
        if search_after:
            params["search_after"] = search_after
        page = _request(params, token)
        rows = page.get("rows", [])
        if not rows:
            break
        for row in rows:
            updated = row.get("updated", "")
            if since and updated < since:
                continue
            results.append({
                "id": row.get("id"),
                "url": row.get("uri"),
                "quote": _extract_quote(row),
                "text": row.get("text", ""),
                "user": row.get("user", ""),
                "updated": updated,
                "tags": row.get("tags", []),
                "group": row.get("group", ""),
            })
        if len(rows) < PAGE_SIZE:
            break
        search_after = rows[-1].get("updated")
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url-prefix", required=True,
                    help="Site URL prefix, e.g. https://hsigstad.github.io/serasa/")
    ap.add_argument("--group", default=None,
                    help="Hypothes.is group ID (omit for public annotations)")
    ap.add_argument("--since", default=None,
                    help="ISO datetime filter, e.g. 2026-01-01")
    ap.add_argument("--json", action="store_true",
                    help="Emit JSON instead of human-readable output")
    args = ap.parse_args()

    token = os.environ.get("HYPOTHESIS_TOKEN")
    anns = fetch_all(args.url_prefix, args.group, args.since, token)

    if args.json:
        json.dump(anns, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    for i, a in enumerate(anns, 1):
        print(f"--- [{i}] {a['url']}  ({a['user']}, {a['updated']})")
        if a["quote"]:
            print(f"  QUOTE: {a['quote']!r}")
        if a["text"]:
            print(f"  NOTE:  {a['text']}")
        if a["tags"]:
            print(f"  TAGS:  {a['tags']}")
    print(f"\nTotal: {len(anns)} annotation(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
