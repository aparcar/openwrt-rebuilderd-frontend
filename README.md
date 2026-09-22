# rebuilderd-frontend

Status page for an OpenWrt [rebuilderd](https://github.com/kpcyrd/rebuilderd)
instance: verification rebuilds of OpenWrt targets, built from source, and
everything they produce — firmware images, packages and kmods.
Plain HTML, CSS and JavaScript — no build step, no dependencies.

Based on [rebuilderd-website](https://gitlab.archlinux.org/archlinux/rebuilderd-website).

## What it shows

One tab per kind of artifact: **Firmware images**, **Packages** and **Kmods**.
Each shows:

- **Overview**: reproducibility of the tab's artifacts and the build queue.
- **Results tree**: release → target → status (bad, fail, unknown, good), one
  row per artifact with its latest verdict and links to the build log,
  diffoscope output and in-toto attestation. Sortable by name or last result,
  searchable, and a local rebuild command per target.
- **Results over time**: a daily stacked chart of good/bad/fail/unknown counts,
  drawn from the files `collect_stats.py` writes.

The tab, sort and search live in the query string, so any view can be
bookmarked.

Kmods are ~93% of all artifacts, so that tab works differently. It lists the
targets with their build status, loads a target's kmods only when you open it,
and its overview counts target builds instead of kmods. Search there covers
target names and the targets already opened.

## Files

| File | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css`, `bg.jpg` | the page |
| `collect_stats.py` | daily collector for the charts |
| `serve.py` | development server with an API proxy |
| `Caddyfile` | server config |

## Running

For development, `serve.py` serves this directory and proxies `/api/*` to a
daemon, so the page and the API share an origin:

```sh
./serve.py                                                    # daemon on 127.0.0.1:8484
./serve.py --upstream https://rebuilder-01.infra.openwrt.org  # a remote daemon
./serve.py --port 9000
```

It then serves http://127.0.0.1:8882. Python 3, no dependencies.

### In production

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

| Component | Release | File |
|---|---|---|
| `firmware` | `SNAPSHOT` | `stats-firmware.json` |
| `packages` | `SNAPSHOT` | `stats-packages.json` |
| `kmods` | `SNAPSHOT` | `stats-kmods.json` |

`SERIES` is the only place a release is set. The page reads it back from the
file, so moving a series to a new release is a one-line change there. Older
entries stay in the file, and the chart starts fresh on the new release.

Counting kmods means paging through every one of them, about 110k rows for
SNAPSHOT. That's fine once a day next to the daemon, and it's exactly what the
page avoids doing in the browser.

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

## The API it uses

Everything is under `/api/v1` on the rebuilderd daemon. Responses are
`{ "total": n, "records": [...] }`; paging is a cursor, `limit` plus
`after=<last id>`, which both the page and the collector follow until they have
`total` records.

| Request | Used for |
|---|---|
| `GET /dashboard?distribution=openwrt` | the build-queue box |
| `GET /packages/source?distribution=openwrt&seen_only=true` | the target list and each target's build status (Kmods tab) |
| `GET /packages/binary?distribution=openwrt&component=<kind>&seen_only=true` | a tab's artifacts across all targets (Firmware images, Packages) |
| `GET /packages/binary?…&component=kmods&release=<r>&architecture=<target>` | one target's artifacts, when it is opened (Kmods tab) |
| `GET /builds/<id>/log` | the per-row build log link |
| `GET /builds/<id>/artifacts/<artifact_id>/diffoscope` | the per-row diff link, when `diffoscope_log_id` is set |
| `GET /builds/<id>/artifacts/<artifact_id>/attestation` | the per-row attestation link, when `attestation_log_id` is set |

`architecture` is a target, so its `/` must be URL-encoded (`x86%2F64`);
`URLSearchParams` does that.

Fields this page relies on: `name`, `version`, `release`, `component`,
`architecture`, `url`, `status`, `build_id`, `artifact_id`,
`diffoscope_log_id`, `attestation_log_id` and `id` (the paging cursor).
Artifact `status` is `GOOD`, `BAD` or `null`.

`GET /meta/distributions/openwrt/releases` and `…/releases/<release>/architectures`
list releases and targets. The page doesn't use them: releases and targets both
fall out of the rows it already fetches.

## Things to know

- **Data model.** Everything is in the rebuilderd distribution `openwrt`. There
  is one job (source package) per target and release. Its single build produces
  all of the target's artifacts, so they share one build and one build log.
  Each artifact's `architecture` is its target (`x86/64`) and its `component`
  is its kind (`firmware`, `packages` or `kmods`). The page and the collector
  filter on `component` server-side, which also keeps out rows still in the old
  layout (target in `component`) until a re-sync relabels them. The
  build-queue numbers come from the daemon's dashboard, which covers the whole
  distribution.
- **`seen_only`.** Both the page and the collector ask the daemon for
  `seen_only` rows, so each artifact appears once, at its published version.
  The flag is only as good as the last sync. Unseen rows simply don't appear, so
  if artifacts you expect are missing, check that first.
- **Latest result only.** The page doesn't fetch `/api/v1/builds`. On a large
  database that endpoint returns every rebuild ever recorded, tens of MB, so
  older runs are left to the API.
- **Status.** Where a row has no artifact status of its own, a rebuild that ran
  counts as *fail* and one that hasn't run yet as *unknown*. The page and the
  collector apply the same rule, so the chart and the tree agree.
