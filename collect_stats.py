#!/usr/bin/env python3
"""Record today's rebuild verdicts into stats.json, for the frontend's history chart.

Run once a day. Each run tallies the currently-published rows of every series in
SERIES and upserts one entry per UTC date, so re-running on the same day replaces
that day's entry rather than adding a second one.

Usage:
    ./collect_stats.py                                  # daemon on 127.0.0.1:8484
    ./collect_stats.py --api https://rebuilderd.n.aparcar.org
    ./collect_stats.py --output /srv/stats.json         # write where Caddy serves it

Cron, shortly after the daily sync:
    30 1 * * *  /path/to/collect_stats.py --output /srv/stats.json
"""
import argparse
import datetime
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

# (distribution, release) pairs to track, one chart each in the frontend (see
# TRENDS in app.js). Firmware is tracked on SNAPSHOT, whose images change daily;
# packages on the release being rebuilt, whose verdicts move as the rebuild
# works through it. Bump the package release here and in app.js together.
SERIES = [
    ("openwrt-package", "25.12.5"),
    ("openwrt-image", "SNAPSHOT"),
]

PAGE_LIMIT = 50000


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=300) as resp:
        return json.load(resp)


def fetch_rows(api, distribution):
    """Every seen row of a distribution, following the `after` cursor."""
    rows, after = [], None
    while True:
        params = {"distribution": distribution, "limit": PAGE_LIMIT, "seen_only": "true"}
        if after is not None:
            params["after"] = after
        page = fetch_json(f"{api}/api/v1/packages/binary?{urllib.parse.urlencode(params)}")
        recs = page.get("records") or []
        rows.extend(recs)
        total = page.get("total")
        if not recs or (total is not None and len(rows) >= total):
            return rows
        after = recs[-1]["id"]


def status_of(row):
    # Same rule as statusOf() in app.js, so the chart and the tree agree.
    if row.get("status"):
        return row["status"]
    if row.get("build_id") is not None:
        return "FAIL"
    return "UNKWN"


def tally(rows):
    c = {"good": 0, "bad": 0, "fail": 0, "unknown": 0}
    key = {"GOOD": "good", "BAD": "bad", "FAIL": "fail", "UNKWN": "unknown"}
    for r in rows:
        c[key.get(status_of(r), "unknown")] += 1
    return c


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"series": {}}


def save(path, data):
    # Write-then-rename: the file is served live, and a reader must never see
    # it half-written. mkstemp creates it 0600, which the web server couldn't
    # read, hence the chmod.
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".stats-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=1)
            f.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--api", default="http://127.0.0.1:8484")
    p.add_argument("--output", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "stats.json"))
    args = p.parse_args()
    api = args.api.rstrip("/")

    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    data = load(args.output)
    series = data.setdefault("series", {})
    missing = []

    by_distro = {}
    for distribution, release in SERIES:
        if distribution not in by_distro:
            by_distro[distribution] = fetch_rows(api, distribution)
        rows = [r for r in by_distro[distribution] if r.get("release") == release]
        name = f"{distribution}/{release}"
        # No rows means the daemon has nothing seen for this release (a sync gap
        # or the release not being tracked) — not that everything regressed.
        # Recording it would draw a cliff to 0%, so skip the day instead.
        if not rows:
            print(f"{name}: no seen rows, not recording {today}", file=sys.stderr)
            missing.append(name)
            continue
        entry = {"date": today, **tally(rows)}
        points = [e for e in series.get(name, []) if e.get("date") != today]
        points.append(entry)
        points.sort(key=lambda e: e["date"])
        series[name] = points
        print(f"{name}: {entry}")

    data["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    save(args.output, data)
    # Non-zero so cron mails someone when a series went unrecorded.
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
