'use strict';

// Status page for an OpenWrt rebuilderd instance.
//
// It fetches the currently-published record of each package or image for the
// main tree (grouped release -> component -> status) and shows the latest
// verdict for each — one row per package or image, no rebuild history. The
// history used to come from an unfiltered /api/v1/builds, which is every
// rebuild ever recorded: on a 20GB database that is a multi-hundred-megabyte
// response the page then folded back down to a handful of rows per package.
// Whoever wants the older runs can ask the daemon for them directly.
//
// The daemon does the filtering, via `seen_only`: asking it for every version
// and reducing here meant pulling 3x the rows (15k against 5k for images, 8MB
// of JSON). The flag is only as good as the last sync, though — it is scoped
// per (distribution, release, architecture) with no component, so a target
// syncing on its own can leave the rest marked unseen, and anything unseen is
// simply absent from the page rather than flagged. If images or packages you
// expect are missing, that is the first thing to check.

const API_BASE = (typeof window !== 'undefined' && window.REBUILDERD_API) || '';
// One big page instead of many small ones. The daemon caps nothing, and paging
// is a cursor (`after`), so every page costs a full round-trip before the next
// can start: the images dataset took 16 sequential requests and ~18s at 1000 a
// time, against ~2s for the single request it fits in now.
const PAGE_LIMIT = 50000;

const DOWNLOADS_URL = 'https://downloads.openwrt.org';
const REBUILDER_REPO = 'https://github.com/aparcar/openwrt-rebuilder';

// Daily history written by collect_stats.py, one file per dataset, served next
// to this file rather than by the daemon. Which release each file tracks is set
// there (SERIES) and read back from the file, so it isn't repeated here.
const TRENDS = {
  'openwrt-package': { file: 'stats-packages.json', noun: 'packages' },
  'openwrt-image': { file: 'stats-firmware.json', noun: 'firmware' },
};

const DISTROS = [
  { id: 'openwrt-package', label: 'Packages' },
  { id: 'openwrt-image', label: 'Firmware images' },
];

const STATUS_ORDER = ['BAD', 'FAIL', 'UNKWN', 'GOOD'];
const STATUS_LABEL = { GOOD: 'good', BAD: 'bad', FAIL: 'fail', UNKWN: 'unknown' };

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

// Most recently rebuilt first, keyed on build_id: a build row is created per
// rebuild, so the id tracks when this package was last checked. Not the binary
// record's own id — that one is sync insertion order, which is alphabetical, so
// using it made this sort a reverse-alphabetical one. Rows never rebuilt have no
// build_id and sort last; images share one build per target, so both cases fall
// back to name.
function byLastBuild(a, b) {
  if (a.build_id == null || b.build_id == null) {
    if (a.build_id == null && b.build_id == null) return byName(a, b);
    return a.build_id == null ? 1 : -1;
  }
  return b.build_id - a.build_id || byName(a, b);
}

// Ordering within each leaf status list.
const SORTS = [
  { id: 'name', label: 'Name', cmp: byName },
  { id: 'recent', label: 'Last result', cmp: byLastBuild },
];

// Target/arch groups take the same ordering as the rows inside them. Images are
// why this exists: one run rebuilds a whole target, so every image in a group
// carries that run's build_id and the row sort within a group is all ties — the
// recency signal only shows up between groups.
function sortGroups(groups) {
  if (sort !== 'recent') return groups; // groupBy already ordered them by name
  const newest = (pkgs) => pkgs.reduce((max, p) => (p.build_id > max ? p.build_id : max), -1);
  return [...groups].sort((a, b) => newest(b[1]) - newest(a[1])
    || a[0].localeCompare(b[0], undefined, { numeric: true }));
}

let currentDistro = DISTROS[0].id;
let allPkgs = [];               // newest version of each image (deduped)
let dashboard = null;           // reproducibility + queue stats
const trendStats = new Map();   // stats file -> promise of its contents, fetched once
let search = '';
let sort = SORTS[0].id;

// Identity of an image across versions: everything but the version.
function imageKey(p) {
  return [p.release, p.component, p.name, p.architecture].join('|');
}

// ---- helpers ----
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function fetchJSON(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

// A package's verdict: its own artifact status, else FAIL if a rebuild ran but
// produced no artifact (build error), else not built yet.
function statusOf(pkg) {
  if (pkg.status) return pkg.status;
  if (pkg.build_id != null) return 'FAIL';
  return 'UNKWN';
}

function groupBy(list, keyOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    (map.get(key) || map.set(key, []).get(key)).push(item);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function tally(pkgs) {
  const c = { GOOD: 0, BAD: 0, FAIL: 0, UNKWN: 0 };
  for (const p of pkgs) c[statusOf(p)]++;
  return c;
}

function matches(pkg) {
  if (!search) return true;
  const q = search.toLowerCase();
  return [pkg.name, pkg.version, pkg.component, pkg.architecture]
    .some((f) => f && f.toLowerCase().includes(q));
}

// ---- data ----
async function fetchPaged(path, extra = {}) {
  const records = [];
  let after = null;
  for (;;) {
    const params = new URLSearchParams({
      distribution: currentDistro,
      limit: String(PAGE_LIMIT),
      ...extra,
    });
    if (after != null) params.set('after', String(after));
    const page = await fetchJSON(`${path}?${params}`);
    const recs = page.records || [];
    records.push(...recs);
    // Stop on the record count rather than on a short page: should the daemon
    // ever start capping `limit` below what we ask for, every page would come
    // back short and a short-page test would silently truncate the tree.
    if (!recs.length || (page.total != null && records.length >= page.total)) return records;
    after = recs[recs.length - 1].id;
  }
}

// A backstop for `seen_only`: it already returns one row per package or image,
// so this normally passes everything through untouched. Should two versions of
// one thing ever come back as seen, the newest (highest binary id) wins — an
// older row would otherwise show today's verdict as if it were that version's
// own, since a binary row only ever points at the newest build of its target.
function collapseVersions(records) {
  const byKey = new Map();
  for (const r of records) {
    const k = imageKey(r);
    (byKey.get(k) || byKey.set(k, []).get(k)).push(r);
  }
  const latest = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => b.id - a.id); // newest first
    latest.push(list[0]);
  }
  return latest;
}

// Share of rebuilt images that reproduced. Not-yet-built ones are excluded
// rather than counted against the rate — they say nothing either way. Null when
// nothing has been rebuilt yet.
function reproRate(c) {
  const rebuilt = c.GOOD + c.BAD + c.FAIL;
  return rebuilt ? (c.GOOD / rebuilt) * 100 : null;
}

// ---- render ----
function countBar(c, cls) {
  const rate = reproRate(c);
  return el('div', { class: cls }, [
    el('span', { class: 'count good', text: `${c.GOOD} good` }),
    el('span', { class: 'count bad', text: `${c.BAD} bad` }),
    el('span', { class: 'count fail', text: `${c.FAIL} fail` }),
    el('span', { class: 'count unknown', text: `${c.UNKWN} unknown` }),
    rate == null ? null : el('span', { class: 'count repro', text: `${rate.toFixed(1)}%` }),
  ]);
}

function renderOverview() {
  const overview = document.getElementById('overview');
  overview.innerHTML = '';
  const c = tally(allPkgs);
  const total = c.GOOD + c.BAD + c.FAIL + c.UNKWN;
  const rate = reproRate(c);
  const j = (dashboard && dashboard.jobs) || {};
  const queued = (j.running || 0) + (j.available || 0) + (j.pending || 0);

  const items = [
    {
      name: 'Reproducibility',
      big: rate == null ? '–' : `${rate.toFixed(1)}%`,
      sub: `${c.GOOD} good · ${c.BAD} bad · ${c.FAIL} fail · ${c.UNKWN} unknown (${total})`,
    },
    {
      name: 'Build queue',
      big: String(queued),
      sub: `${j.running || 0} running · ${j.available || 0} available · ${j.pending || 0} pending`,
    },
  ];
  for (const it of items) {
    overview.appendChild(el('li', {}, [
      el('span', { class: 'stat-name', text: it.name }),
      el('span', { class: 'stat-percent', text: it.big }),
      el('span', { class: 'stat-breakdown', text: it.sub }),
    ]));
  }
}

function renderLinks(pkg) {
  if (!pkg.build_id) return null;
  const links = el('span', { class: 'pkg-links' });
  const add = (path, title, text) => links.appendChild(
    el('a', { href: `${API_BASE}${path}`, target: '_blank', rel: 'noreferrer', title, text })
  );
  add(`/api/v1/builds/${pkg.build_id}/log`, 'build log', 'log');
  if (pkg.artifact_id && pkg.diffoscope_log_id != null)
    add(`/api/v1/builds/${pkg.build_id}/artifacts/${pkg.artifact_id}/diffoscope`, 'diffoscope', 'diff');
  if (pkg.artifact_id && pkg.attestation_log_id != null)
    add(`/api/v1/builds/${pkg.build_id}/artifacts/${pkg.artifact_id}/attestation`, 'attestation', 'attest');
  return links;
}

function renderPkg(pkg) {
  const row = el('div', { class: 'pkg-row' }, [
    el('span', { class: `dot ${STATUS_LABEL[statusOf(pkg)]}` }),
    el('span', { class: 'pkg-name', text: pkg.name }),
    el('span', { class: 'pkg-version', text: pkg.version }),
    el('span', { class: 'pkg-arch', text: pkg.architecture }),
  ]);
  const links = renderLinks(pkg);
  if (links) row.appendChild(links);

  return el('li', {}, [row]);
}

// ---- results over time ----
// A stacked area of the verdict counts per day, so the height is everything
// tracked and each band is how much of it stands where. Good sits on the
// baseline, where its growth reads straight off the axis; unknown, the
// not-yet-rebuilt remainder, goes on top. That order also keeps green and red
// adjacent only where they separate under deuteranopia (checked, ΔE 9.5).

const SVG_NS = 'http://www.w3.org/2000/svg';
const TREND_W = 1000;
const TREND_H = 240;
const TREND_PAD = { top: 14, right: 118, bottom: 26, left: 56 };
const TREND_STACK = ['GOOD', 'BAD', 'FAIL', 'UNKWN']; // baseline up
// Bands thinner than this (viewBox units) get no end label, which would only
// collide with its neighbours; the legend, tooltip and table still carry it.
const TREND_LABEL_MIN = 15;

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

// A stats file is missing until collect_stats.py has recorded that dataset
// once; that just means no chart, so failures resolve to null.
function loadTrendStats(file) {
  if (!trendStats.has(file)) {
    trendStats.set(file, fetch(file, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .catch((err) => { console.error(err); return null; }));
  }
  return trendStats.get(file);
}

// Collector entries use lowercase keys; reproRate wants the status names.
function trendPoint(e) {
  const c = { GOOD: e.good || 0, BAD: e.bad || 0, FAIL: e.fail || 0, UNKWN: e.unknown || 0 };
  return {
    date: e.date, counts: c, total: c.GOOD + c.BAD + c.FAIL + c.UNKWN,
    rate: reproRate(c), t: Date.parse(`${e.date}T00:00:00Z`),
  };
}

const fmtCount = (n) => n.toLocaleString('en');

// A round axis top at or above max: 1, 2 or 5 times a power of ten per step,
// about four steps.
function niceScale(max) {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  return { top: Math.ceil(max / step) * step, step };
}

// Formatted in UTC: the collector dates its entries in UTC, and a local-time
// Date would put a day's point under the previous day west of Greenwich.
function shortDate(t) {
  return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function renderTrendTooltip(tip, p) {
  tip.innerHTML = '';
  tip.appendChild(el('div', { class: 'trend-tip-date', text: p.date }));
  tip.appendChild(el('div', {}, [el('strong', { text: fmtCount(p.total) }), ' total']));
  // top of the stack first, so the rows read in the order the bands sit
  for (const s of [...TREND_STACK].reverse()) {
    tip.appendChild(el('div', { class: 'trend-tip-row' }, [
      el('span', { class: `trend-key ${STATUS_LABEL[s]}` }),
      el('strong', { text: fmtCount(p.counts[s]) }), ` ${STATUS_LABEL[s]}`,
    ]));
  }
  if (p.rate != null) tip.appendChild(el('div', { class: 'trend-tip-rate' }, [
    el('strong', { text: `${p.rate.toFixed(1)}%` }), ' of rebuilt reproducible',
  ]));
}

function renderTrendChart(points) {
  const x0 = TREND_PAD.left;
  const x1 = TREND_W - TREND_PAD.right;
  const y0 = TREND_H - TREND_PAD.bottom;
  const y1 = TREND_PAD.top;
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  // a lone day sits mid-plot instead of dividing by a zero-length range
  const xOf = (t) => (tMax === tMin ? (x0 + x1) / 2 : x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0));
  const scale = niceScale(Math.max(...points.map((p) => p.total)));
  const yOf = (n) => y0 - (n / scale.top) * (y0 - y1);

  const chart = svg('svg', {
    class: 'trend-svg', viewBox: `0 0 ${TREND_W} ${TREND_H}`, role: 'img', tabindex: '0',
    'aria-label': `Results per day by verdict, stacked, ${points[0].date} to ${points[points.length - 1].date}. `
      + 'Use the arrow keys to step through days; the table below lists every value.',
  });

  for (let v = 0; v <= scale.top; v += scale.step) {
    const y = yOf(v);
    chart.appendChild(svg('line', { class: 'trend-grid', x1: x0, x2: x1, y1: y, y2: y }));
    chart.appendChild(svg('text', { class: 'trend-axis', x: x0 - 8, y: y + 4, 'text-anchor': 'end', text: fmtCount(v) }));
  }

  // At most ~6 date ticks, picked from the recorded days so each sits on a point.
  const step = Math.max(1, Math.ceil(points.length / 6));
  for (let i = 0; i < points.length; i += step) {
    chart.appendChild(svg('text', {
      class: 'trend-axis', x: xOf(points[i].t), y: y0 + 18, 'text-anchor': 'middle', text: shortDate(points[i].t),
    }));
  }

  // An area needs two x positions, so a lone day becomes a 24-unit column.
  const mid = xOf(points[0].t);
  const cols = points.length > 1
    ? points.map((p) => ({ x: xOf(p.t), p }))
    : [{ x: mid - 12, p: points[0] }, { x: mid + 12, p: points[0] }];
  const f = (n) => n.toFixed(1);

  let below = cols.map(() => 0);
  const ends = [];
  for (const s of TREND_STACK) {
    const above = cols.map((c, i) => below[i] + c.p.counts[s]);
    if (cols.some((c) => c.p.counts[s] > 0)) {
      const top = cols.map((c, i) => `${f(c.x)},${f(yOf(above[i]))}`);
      const bottom = cols.map((c, i) => `${f(c.x)},${f(yOf(below[i]))}`).reverse();
      chart.appendChild(svg('path', {
        class: `trend-band ${STATUS_LABEL[s]}`, d: `M${top.join('L')}L${bottom.join('L')}Z`,
      }));
      const n = cols.length - 1;
      ends.push({ s, yTop: yOf(above[n]), yBottom: yOf(below[n]), count: cols[n].p.counts[s] });
    }
    below = above;
  }

  // Latest count of each band, beside where the band ends.
  for (const e of ends) {
    if (e.yBottom - e.yTop < TREND_LABEL_MIN) continue;
    chart.appendChild(svg('text', {
      class: 'trend-end', x: x1 + 8, y: (e.yTop + e.yBottom) / 2 + 4,
      text: `${fmtCount(e.count)} ${STATUS_LABEL[e.s]}`,
    }));
  }

  const cross = svg('line', { class: 'trend-cross', y1: y1, y2: y0, visibility: 'hidden' });
  chart.appendChild(cross);

  const wrap = el('div', { class: 'trend-chart' }, [chart]);
  const tip = el('div', { class: 'trend-tip', hidden: '' });
  wrap.appendChild(tip);

  let active = -1;
  const show = (i) => {
    active = i;
    const p = points[i];
    const x = xOf(p.t);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    renderTrendTooltip(tip, p);
    tip.hidden = false;
    // viewBox units -> CSS pixels; flip to the left past the middle so the
    // tooltip never hangs off the right edge
    const width = chart.getBoundingClientRect().width;
    const left = x * (width / TREND_W);
    tip.style.left = x > TREND_W / 2 ? '' : `${left + 12}px`;
    tip.style.right = x > TREND_W / 2 ? `${width - left + 12}px` : '';
  };
  const hide = () => {
    active = -1;
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };

  // The crosshair snaps to the nearest recorded day, so the pointer never has
  // to land on the 2px line itself.
  chart.addEventListener('pointermove', (e) => {
    const rect = chart.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * TREND_W;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(xOf(points[i].t) - x) < Math.abs(xOf(points[best].t) - x)) best = i;
    }
    if (best !== active) show(best);
  });
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('blur', hide);
  chart.addEventListener('focus', () => show(points.length - 1));
  chart.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const from = active < 0 ? points.length - 1 : active;
    show(Math.min(points.length - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1))));
  });

  return wrap;
}

// Every value the chart shows, reachable without hovering. Newest first.
function renderTrendTable(points) {
  const head = el('tr', {}, ['Date', 'Total', 'Good', 'Bad', 'Fail', 'Unknown', 'Reproducible']
    .map((h) => el('th', { text: h })));
  const rows = [...points].reverse().map((p) => el('tr', {}, [
    el('td', { text: p.date }),
    el('td', { text: fmtCount(p.total) }),
    ...TREND_STACK.map((s) => el('td', { text: fmtCount(p.counts[s]) })),
    el('td', { text: p.rate == null ? '–' : `${p.rate.toFixed(1)}%` }),
  ]));
  return el('details', { class: 'trend-table' }, [
    el('summary', { text: 'Show as table' }),
    el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)]),
  ]);
}

// Each dataset has its own file, so a slow one can land after the reader has
// switched away; it's dropped then rather than drawn under the wrong dataset.
function renderTrend(distro, stats) {
  const section = document.getElementById('trend');
  if (!section || distro !== currentDistro) return;
  section.innerHTML = '';
  const conf = TRENDS[distro];
  // Only the release the file currently tracks: after a release bump the older
  // entries stay in the file, but they're a different package set.
  const release = stats && stats.release;
  const entries = ((stats && stats.points) || []).filter((e) => !e.release || e.release === release);
  const points = entries.map(trendPoint).filter((p) => p.total > 0 && !Number.isNaN(p.t));
  if (!conf || !points.length) { section.hidden = true; return; }

  section.appendChild(el('div', { class: 'trend-header' }, [
    el('h2', { class: 'trend-title', text: `Results over time · ${release ? `${release} ` : ''}${conf.noun}` }),
    el('span', {
      class: 'trend-sub',
      text: `recorded daily · ${points.length} day${points.length === 1 ? '' : 's'}`,
    }),
  ]));
  // Swatches mirror the bands, in stack order; the names stay in ink.
  const legend = el('ul', { class: 'trend-legend' }, TREND_STACK.map((s) => el('li', {}, [
    el('span', { class: `trend-swatch ${STATUS_LABEL[s]}` }), STATUS_LABEL[s],
  ])));
  const body = el('div', { class: 'trend-body' }, [legend, renderTrendChart(points), renderTrendTable(points)]);
  section.appendChild(body);
  section.hidden = false;
}

// ---- rebuild instructions ----
// openwrt-rebuilder writes its artifacts to --output and compares nothing
// itself, so anyone can redo a rebuild here without running a rebuilderd
// instance and diff the result against downloads.openwrt.org.

// The release ids come from rebuilderd's sync config, which names them after
// the git ref ("main", "openwrt-24.10", "v24.10.0"); --release wants the
// OpenWrt version behind it ("SNAPSHOT", "24.10-SNAPSHOT", "24.10.0").
function releaseArg(release) {
  if (!release || release === 'SNAPSHOT' || release === 'main') return 'SNAPSHOT';
  if (release.startsWith('openwrt-')) return `${release.slice('openwrt-'.length)}-SNAPSHOT`;
  return release.replace(/^v/, '');
}

// …and the directory that release publishes under, same mapping upstream's
// importer uses to build the URLs it syncs from.
function releasePath(release) {
  const version = releaseArg(release);
  return version === 'SNAPSHOT' ? 'snapshots' : `releases/${version}`;
}

function shellLines(...lines) {
  return lines.join(' \\\n    ');
}

// What it takes to recreate this group's files: images are rebuilt a whole
// target at a time and packages one apk at a time. A package command therefore
// needs one concrete file, so it quotes the first of the group and leaves
// swapping it to the reader.
function rebuildInfo(pkgs) {
  const first = pkgs[0];
  const release = first && first.release;
  if (!release) return null;
  const clone = `git clone ${REBUILDER_REPO}\ncd openwrt-rebuilder\n`;

  if (currentDistro === 'openwrt-image') {
    const target = first.component || first.architecture;
    if (!target) return null;
    return {
      note: 'Rebuilds every image of this target from source the way the buildbots do: '
        + 'openwrt.git at the published commit, feeds and .config restored from the target\'s buildinfo.',
      cmd: clone + shellLines(
        'uv run openwrt-rebuilder firmware',
        `--target ${target}`,
        `--release ${releaseArg(release)}`,
        '--output ./out',
      ),
      published: `${DOWNLOADS_URL}/${releasePath(release)}/targets/${target}/`,
      publishedLabel: `the published images of ${target}`,
    };
  }

  const sample = [...pkgs].sort(SORTS[0].cmp)[0];
  const file = `${sample.name}-${sample.version}.apk`;
  const feed = `${releasePath(release)}/packages/${sample.architecture}/${sample.component || 'base'}`;
  return {
    note: 'Rebuilds a single apk with the matching OpenWrt SDK. This is the first package of '
      + 'the list; swap --package and --arch for any other row.',
    cmd: clone + shellLines(
      'uv run openwrt-rebuilder package',
      `--package ${file}`,
      `--arch ${sample.architecture}`,
      `--release ${releaseArg(release)}`,
      '--output ./out',
    ),
    published: `${DOWNLOADS_URL}/${feed}/${file}`,
    publishedLabel: file,
  };
}

function renderRebuild(pkgs) {
  const info = rebuildInfo(pkgs);
  if (!info) return null;
  return el('details', { class: 'rebuild' }, [
    el('summary', { class: 'rebuild-title', text: 'Rebuild locally' }),
    el('div', { class: 'rebuild-body' }, [
      el('p', { class: 'rebuild-note', text: info.note }),
      el('pre', { class: 'rebuild-cmd' }, [el('code', { text: info.cmd })]),
      el('p', { class: 'rebuild-note' }, [
        'Needs ',
        el('a', { href: 'https://docs.astral.sh/uv/', target: '_blank', rel: 'noreferrer', text: 'uv' }),
        ' and the usual OpenWrt build dependencies. The result lands in ',
        el('code', { text: './out' }),
        ' — compare it against ',
        el('a', { href: info.published, target: '_blank', rel: 'noreferrer', text: info.publishedLabel }),
        ' with ',
        el('code', { text: 'diffoscope' }),
        '.',
      ]),
    ]),
  ]);
}

// good/bad/fail/unknown lists. Bad opens by default (the actionable bucket);
// the rest stay collapsed unless a search is active.
function renderStatusGroups(pkgs) {
  const cmp = (SORTS.find((s) => s.id === sort) || SORTS[0]).cmp;
  const buckets = { GOOD: [], BAD: [], FAIL: [], UNKWN: [] };
  for (const p of pkgs) buckets[statusOf(p)].push(p);
  const out = [];
  for (const status of STATUS_ORDER) {
    const list = buckets[status].sort(cmp);
    if (!list.length) continue;
    const cls = STATUS_LABEL[status];
    const attrs = { class: `status-group ${cls}` };
    if (search || status === 'BAD') attrs.open = '';
    out.push(el('details', attrs, [
      el('summary', { class: `status-group-title ${cls}`, text: `${cls} (${list.length})` }),
      el('ul', { class: 'pkg-list' }, list.map(renderPkg)),
    ]));
  }
  return out;
}

function render() {
  const content = document.getElementById('content');
  const count = document.getElementById('search-count');
  content.innerHTML = '';

  const shown = allPkgs.filter(matches);
  count.textContent = search ? `${shown.length} of ${allPkgs.length}` : `${allPkgs.length} results`;

  if (!shown.length) {
    content.appendChild(el('p', { class: 'loading', text: search ? `No matches for "${search}".` : 'No results yet.' }));
    return;
  }

  groupBy(shown, (p) => p.release || '(no release)').forEach(([release, relPkgs], i) => {
    const suite = el('details', { class: 'suite', id: `release-${release}` });
    if (i === 0 || search) suite.setAttribute('open', '');
    suite.appendChild(el('summary', { class: 'suite-header' }, [
      el('h2', { class: 'suite-title', text: release }),
      countBar(tally(relPkgs), 'suite-counts'),
    ]));

    const body = el('div', { class: 'suite-body' });
    for (const [component, compPkgs] of sortGroups(groupBy(relPkgs, (p) => p.component || p.architecture || '(none)'))) {
      const c = tally(compPkgs);
      const sub = el('details', { class: 'subgroup' });
      if (search || c.BAD) sub.setAttribute('open', '');
      sub.appendChild(el('summary', { class: 'subgroup-title' }, [
        el('span', { class: 'subgroup-name', text: component }),
        countBar(c, 'subgroup-counts'),
      ]));
      const subBody = el('div', { class: 'subgroup-body' });
      const rebuild = renderRebuild(compPkgs);
      if (rebuild) subBody.appendChild(rebuild);
      for (const group of renderStatusGroups(compPkgs)) subBody.appendChild(group);
      sub.appendChild(subBody);
      body.appendChild(sub);
    }
    suite.appendChild(body);
    content.appendChild(suite);
  });
}

// ---- url state ----
// The selected dataset and the search term live in the query string, so a
// filtered view can be bookmarked or shared. Defaults are left out to keep the
// bare URL clean.
function readState() {
  const params = new URLSearchParams(location.search);
  const distro = params.get('distro');
  if (DISTROS.some((d) => d.id === distro)) currentDistro = distro;
  const s = params.get('sort');
  if (SORTS.some((o) => o.id === s)) sort = s;
  search = (params.get('q') || '').trim();
}

// Switching dataset is a navigation (pushState); typing only rewrites the
// current entry, otherwise every keystroke would land in the history.
function writeState({ push = false } = {}) {
  const params = new URLSearchParams();
  if (currentDistro !== DISTROS[0].id) params.set('distro', currentDistro);
  if (sort !== SORTS[0].id) params.set('sort', sort);
  if (search) params.set('q', search);
  const qs = params.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function onPopState() {
  const prev = currentDistro;
  readState();
  const input = document.getElementById('search');
  if (input) input.value = search;
  renderDistroButtons();
  renderSortButtons();
  if (currentDistro !== prev) load();
  else render();
}

// ---- controls ----
function renderDistroButtons() {
  const group = document.getElementById('distro-buttons');
  group.innerHTML = '';
  for (const d of DISTROS) {
    const btn = el('button', {
      class: `distro-btn${d.id === currentDistro ? ' active' : ''}`,
      type: 'button',
      text: d.label,
    });
    btn.addEventListener('click', () => {
      if (currentDistro === d.id) return;
      currentDistro = d.id;
      writeState({ push: true });
      renderDistroButtons();
      load();
    });
    group.appendChild(btn);
  }
}

// Sorting only reorders the already-rendered leaf lists, so it re-renders in
// place — no refetch, and the URL is rewritten (not pushed) like the search.
function renderSortButtons() {
  const group = document.getElementById('sort-buttons');
  if (!group) return;
  group.innerHTML = '';
  for (const s of SORTS) {
    const btn = el('button', {
      class: `sort-btn${s.id === sort ? ' active' : ''}`,
      type: 'button',
      text: s.label,
    });
    btn.addEventListener('click', () => {
      if (sort === s.id) return;
      sort = s.id;
      writeState();
      renderSortButtons();
      render();
    });
    group.appendChild(btn);
  }
}

async function load() {
  const overview = document.getElementById('overview');
  const content = document.getElementById('content');
  overview.innerHTML = '<li class="loading">Loading…</li>';
  content.innerHTML = '<p class="loading">Loading…</p>';
  allPkgs = [];
  dashboard = null;

  // Not fatal on its own: without the dashboard we lose the queue stats and the
  // tree still stands.
  const stats = fetchJSON(`/api/v1/dashboard?distribution=${encodeURIComponent(currentDistro)}`)
    .catch((err) => { console.error(err); return null; });
  // Independent of the daemon and tiny, so it draws as soon as it lands rather
  // than waiting on the tree. The previous dataset's chart goes right away, not
  // when this one arrives.
  const trendSection = document.getElementById('trend');
  if (trendSection) trendSection.hidden = true;
  const distro = currentDistro;
  const trend = TRENDS[distro];
  if (trend) loadTrendStats(trend.file).then((s) => renderTrend(distro, s));

  try {
    // seen_only leaves the daemon to pick the published version of each row, so
    // this is the only bulk request the page makes: one row per package or
    // image, superseded rebuilds left in the database where they belong.
    allPkgs = collapseVersions(await fetchPaged('/api/v1/packages/binary', { seen_only: 'true' }));
  } catch (err) {
    console.error(err);
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'error', text: `Failed to load: ${err.message}` }));
    return;
  }

  dashboard = await stats;

  renderOverview();
  render();
}

function main() {
  readState();
  renderDistroButtons();
  renderSortButtons();
  const input = document.getElementById('search');
  if (input) {
    input.value = search;
    input.addEventListener('input', (e) => {
      search = (e.target.value || '').trim();
      writeState();
      render();
    });
  }
  window.addEventListener('popstate', onPopState);
  load();
}

main();
