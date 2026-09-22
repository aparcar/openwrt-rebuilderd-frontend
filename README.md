# rebuilderd-frontend

Status page for an OpenWrt [rebuilderd](https://github.com/kpcyrd/rebuilderd)
instance: verification rebuilds of OpenWrt apk packages and firmware images.
Plain HTML, CSS and JavaScript — no build step, no dependencies.

Based on [rebuilderd-website](https://gitlab.archlinux.org/archlinux/rebuilderd-website).

## What it shows

- **Overview**: reproducibility and build-queue stats, from `/api/v1/dashboard`.
- **Results tree**: release → target/feed → status (bad, fail, unknown, good),
  one row per package or image with its latest verdict and links to the build
  log, diffoscope output and in-toto attestation. Sortable by name or last
  result, searchable, and a local rebuild command per target or feed.
- **Results over time**: a daily stacked chart of good/bad/fail/unknown counts,
  one per dataset, drawn from the files `collect_stats.py` writes.

The dataset (Packages / Firmware images), sort and search live in the query
string, so any view can be bookmarked.

## Files

| File | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css`, `bg.jpg` | the page |
| `collect_stats.py` | daily collector for the charts |
| `Caddyfile` | server config |

## Running

The `Caddyfile` serves the directory and reverse-proxies `/api/*` to the daemon,
so the page and the API share an origin. It works as is with `caddy run`, which
serves http://localhost:8882 against a daemon on `127.0.0.1:8484`. Override it
through the environment:

| Variable | Default | Meaning |
|---|---|---|
| `SITE_ADDRESS` | `http://localhost:8882` | address to listen on |
| `REBUILDERD_UPSTREAM` | `127.0.0.1:8484` | rebuilderd daemon |
| `SITE_ROOT` | `.` | directory holding the page and the stats files |

To point the page at an API on another origin instead, set
`window.REBUILDERD_API` before `app.js` loads. The daemon then needs to allow
cross-origin requests.

## Charts over time

`collect_stats.py` records one entry per day. Run it daily, shortly after the
daemon's sync, writing into the directory the page is served from:

```cron
30 1 * * *  /path/to/collect_stats.py --output-dir /srv
```

Options: `--api` (default `http://127.0.0.1:8484`) and `--output-dir` (default:
the script's own directory). It needs Python 3 and nothing else.

Tracked series are set in `SERIES` at the top of the script:

| Dataset | Release | File |
|---|---|---|
| `openwrt-package` | `25.12.5` | `stats-packages.json` |
| `openwrt-image` | `SNAPSHOT` | `stats-firmware.json` |

`SERIES` is the only place a release is set. The page reads it back from the
file, so moving packages to a new release is a one-line change there. Older
entries stay in the file, and the chart starts fresh on the new release.

Notes:

- Re-running on the same UTC day replaces that day's entry.
- A series with no rows is skipped for the day rather than recorded as zero,
  and the script exits 1 so cron reports it.
- Files are written atomically and world-readable, since they're served live.
- The stats files are server data and are gitignored. The history lives only
  there — back them up if it matters, because a daemon database reset doesn't
  touch them, but losing the files loses the history.
- The page hides a chart whose file is missing. That's the normal state until
  the collector has run once.

## Things to know

- **`seen_only`.** Both the page and the collector ask the daemon for
  `seen_only` rows, so each package or image appears once, at its published
  version. The flag is only as good as the last sync. It's scoped per
  distribution, release and architecture, not per target, so a target syncing
  on its own can leave others marked unseen. Unseen rows simply don't appear. If
  packages or images you expect are missing, check that first.
- **Latest result only.** The page doesn't fetch `/api/v1/builds`. On a large
  database that endpoint returns every rebuild ever recorded, tens of MB, so
  older runs are left to the API.
- **Status.** Where a row has no artifact status of its own, a rebuild that ran
  counts as *fail* and one that hasn't run yet as *unknown*. The page and the
  collector apply the same rule, so the chart and the tree agree.
