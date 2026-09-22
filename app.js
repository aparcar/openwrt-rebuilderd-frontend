'use strict';

// Status page for an OpenWrt rebuilderd instance.
//
// OpenWrt is one rebuilderd distribution, rebuilt a whole target at a time: one
// source package (job) per target and release, whose single build produces all
// of that target's artifacts. Each artifact is a binary package whose
// `architecture` is the target ("x86/64") and whose `component` is its kind:
// firmware, packages or kmods. The page has a tab per kind and shows it as
// release -> target -> status, with the latest verdict of each artifact.
//
// Volume decides how each tab loads. Firmware images and packages number a few
// dozen per target and load for every target at once, filtered server-side by
// component. Kmods are ~93% of everything (~110k rows for SNAPSHOT), so that
// tab lists the targets from their jobs and loads one target's kmods only when
// it is opened.
//
// Rows are the latest verdict only — no rebuild history. The
// history used to come from an unfiltered /api/v1/builds, which is every
// history used to come from an unfiltered /api/v1/builds, which is every
// rebuild ever recorded: on a 20GB database that is a multi-hundred-megabyte
// response the page then folded back down to a handful of rows per package.
// Whoever wants the older runs can ask the daemon for them directly.
//
// The daemon does the filtering, via `seen_only`: asking it for every version
// and reducing here would pull superseded rows as well. The flag is only as
// good as the last sync, though: anything unseen is simply absent from the
// page rather than flagged. If artifacts you expect are missing, that is the
// first thing to check.

const API_BASE = (typeof window !== 'undefined' && window.REBUILDERD_API) || '';
const DISTRIBUTION = 'openwrt';
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
  firmware: { file: 'stats-firmware.json', noun: 'firmware images' },
  packages: { file: 'stats-packages.json', noun: 'packages' },
  kmods: { file: 'stats-kmods.json', noun: 'kmods' },
};

// One tab per component. `lazy` tabs list the targets and fetch a target's rows
// when it is opened; `path` is where that kind is published under a target.
// Filtering on component server-side also keeps out rows still in the old
// layout (target in component, package arch in architecture) until a re-sync
// relabels them.
const VIEWS = [
  { id: 'firmware', label: 'Firmware images', path: '', lazy: false },
  { id: 'packages', label: 'Packages', path: 'packages/', lazy: false },
  { id: 'kmods', label: 'Kmods', path: 'kmods/', lazy: true },
];
const viewConf = () => VIEWS.find((v) => v.id === currentView);

const STATUS_ORDER = ['BAD', 'FAIL', 'UNKWN', 'GOOD'];
const STATUS_LABEL = { GOOD: 'good', BAD: 'bad', FAIL: 'fail', UNKWN: 'unknown' };

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

// Most recently rebuilt first, keyed on build_id: a build row is created per
// rebuild, so the id tracks when this package was last checked. Not the binary
// record's own id — that one is sync insertion order, which is alphabetical, so
// using it made this sort a reverse-alphabetical one. Rows never rebuilt have no
// build_id and sort last; every artifact of a target shares its one build, so
// both cases fall back to name.
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

// Target groups take the same ordering as the rows inside them. This is where
// that ordering shows: one run rebuilds a whole target, so every artifact in a
// group carries that run's build_id and the row sort within a group is all
// ties — the recency signal only shows up between groups.
function sortGroups(groups) {
  if (sort !== 'recent') return groups; // groupBy already ordered them by name
  const newest = (pkgs) => pkgs.reduce((max, p) => (p.build_id > max ? p.build_id : max), -1);
  return [...groups].sort((a, b) => newest(b[1]) - newest(a[1])
    || a[0].localeCompare(b[0], undefined, { numeric: true }));
}

let currentView = VIEWS[0].id;
let allPkgs = [];               // eager tab: its rows, once loaded
let sources = null;             // lazy tab: one job per target and release, once loaded
const viewRows = new Map();     // eager tab id -> promise of its rows
let sourcesLoad = null;         // promise of the jobs, shared by lazy tabs
const targetRows = new Map();   // lazy key -> promise of one target's rows
const loadedTargets = new Map(); // lazy key -> one target's rows, once they are in
let dashboard = null;           // queue stats
let dashboardLoad = null;       // promise of the dashboard, fetched once
let viewReady = false;          // whether the current tab's data is in and drawn
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
      distribution: DISTRIBUTION,
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

// Each is fetched once and kept for the page's lifetime; a failed fetch is
// forgotten so the next attempt retries it.
function cached(map, key, fetcher) {
  if (!map.has(key)) {
    map.set(key, fetcher().catch((err) => { map.delete(key); throw err; }));
  }
  return map.get(key);
}

// Every target's artifacts of one kind.
function loadViewRows(view) {
  return cached(viewRows, view, async () => collapseVersions(
    await fetchPaged('/api/v1/packages/binary', { component: view, seen_only: 'true' })));
}

// One job per target and release: the list a lazy tab is built from.
function loadSources() {
  if (!sourcesLoad) {
    sourcesLoad = fetchPaged('/api/v1/packages/source', { seen_only: 'true' })
      .catch((err) => { sourcesLoad = null; throw err; });
  }
  return sourcesLoad;
}

const targetKey = (view, job) => `${view}|${job.release}|${job.name}`;

// One target's artifacts of one kind; a job's name is its target.
function loadTarget(view, job) {
  const key = targetKey(view, job);
  return cached(targetRows, key, async () => {
    const rows = collapseVersions(await fetchPaged('/api/v1/packages/binary', {
      component: view, release: job.release, architecture: job.name, seen_only: 'true',
    }));
    loadedTargets.set(key, rows);
    return rows;
  });
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
  const j = (dashboard && dashboard.jobs) || {};
  const queued = (j.running || 0) + (j.available || 0) + (j.pending || 0);

  let first;
  if (viewConf().lazy) {
    // Counting a lazy tab's artifacts would mean loading all of them, which is
    // what it exists to avoid; its targets' builds are the cheap summary.
    const c = tally(sources || []);
    first = {
      name: 'Target builds',
      big: String((sources || []).length),
      sub: `${c.GOOD} good · ${c.BAD} bad · ${c.FAIL} fail · ${c.UNKWN} not built yet`,
    };
  } else {
    const c = tally(allPkgs);
    const total = c.GOOD + c.BAD + c.FAIL + c.UNKWN;
    const rate = reproRate(c);
    first = {
      name: 'Reproducibility',
      big: rate == null ? '–' : `${rate.toFixed(1)}%`,
      sub: `${c.GOOD} good · ${c.BAD} bad · ${c.FAIL} fail · ${c.UNKWN} unknown (${total})`,
    };
  }

  const items = [
    first,
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
function renderTrend(view, stats) {
  const section = document.getElementById('trend');
  if (!section || view !== currentView) return;
  section.innerHTML = '';
  const conf = TRENDS[view];
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

// What it takes to recreate this group's files. Every kind comes out of the
// same whole-target build, so the command is the target's either way; only
// where to compare against differs.
function rebuildInfo(target, release) {
  if (!target || !release) return null;
  const conf = viewConf();
  const published = `${DOWNLOADS_URL}/${releasePath(release)}/targets/${target}/${conf.path}`;
  return {
    note: 'Rebuilds the whole target from source the way the buildbots do: openwrt.git at the '
      + 'published commit, feeds and .config restored from the target\'s buildinfo. One run '
      + 'produces its firmware images, packages and kmods alike.',
    cmd: `git clone ${REBUILDER_REPO}\ncd openwrt-rebuilder\n` + shellLines(
      'uv run openwrt-rebuilder firmware',
      `--target ${target}`,
      `--release ${releaseArg(release)}`,
      '--output ./out',
    ),
    published,
    publishedLabel: `the published ${conf.label.toLowerCase()} of ${target}`,
  };
}

function renderRebuild(target, release) {
  const info = rebuildInfo(target, release);
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

// A release's collapsible panel; the first one starts open.
function renderSuite(release, i, counts) {
  const suite = el('details', { class: 'suite', id: `release-${release}` });
  if (i === 0 || search) suite.setAttribute('open', '');
  suite.appendChild(el('summary', { class: 'suite-header' }, [el('h2', { class: 'suite-title', text: release }), counts]));
  return suite;
}

// The inside of an opened target: how to rebuild it, then its status lists.
function renderTargetBody(target, release, pkgs) {
  const body = el('div', { class: 'subgroup-body' });
  const rebuild = renderRebuild(target, release);
  if (rebuild) body.appendChild(rebuild);
  for (const group of renderStatusGroups(pkgs)) body.appendChild(group);
  return body;
}

function render() {
  if (viewConf().lazy) renderLazy();
  else renderEager();
}

function renderEager() {
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
    const suite = renderSuite(release, i, countBar(tally(relPkgs), 'suite-counts'));
    const body = el('div', { class: 'suite-body' });
    for (const [target, targetPkgs] of sortGroups(groupBy(relPkgs, (p) => p.architecture || '(none)'))) {
      const c = tally(targetPkgs);
      const sub = el('details', { class: 'subgroup' });
      if (search || c.BAD) sub.setAttribute('open', '');
      sub.appendChild(el('summary', { class: 'subgroup-title' }, [
        el('span', { class: 'subgroup-name', text: target }),
        countBar(c, 'subgroup-counts'),
      ]));
      sub.appendChild(renderTargetBody(target, release, targetPkgs));
      body.appendChild(sub);
    }
    suite.appendChild(body);
    content.appendChild(suite);
  });
}

// Targets come from their jobs, and each one's rows only once it is opened.
// A search can only look inside targets already loaded, so an unloaded target
// stays listed while its own name matches, and the count says how many were
// searched.
function lazyListed(view) {
  const q = search.toLowerCase();
  return (sources || []).filter((job) => {
    if (!search || job.name.toLowerCase().includes(q)) return true;
    const rows = loadedTargets.get(targetKey(view, job));
    return rows && rows.some(matches);
  });
}

function renderLazyCount(view) {
  const jobs = sources || [];
  const loaded = jobs.filter((job) => loadedTargets.has(targetKey(view, job))).length;
  document.getElementById('search-count').textContent = search
    ? `${lazyListed(view).length} of ${jobs.length} targets (${loaded} loaded and searched)`
    : `${jobs.length} targets`;
}

function renderLazy() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  const view = currentView;
  const listed = lazyListed(view);
  renderLazyCount(view);

  if (!listed.length) {
    content.appendChild(el('p', { class: 'loading', text: search ? `No matches for "${search}".` : 'No targets yet.' }));
    return;
  }

  groupBy(listed, (job) => job.release || '(no release)').forEach(([release, relJobs], i) => {
    const suite = renderSuite(release, i, el('div', { class: 'suite-counts' }, [
      el('span', { class: 'count', text: `${relJobs.length} targets` }),
    ]));
    const body = el('div', { class: 'suite-body' });
    const cmp = (SORTS.find((s) => s.id === sort) || SORTS[0]).cmp;
    for (const job of [...relJobs].sort(cmp)) body.appendChild(renderLazyTarget(view, job));
    suite.appendChild(body);
    content.appendChild(suite);
  });
}

// Before loading, a target's header carries its job's build status; after, the
// same counts an eager tab shows. Opening it the first time fetches the rows
// and swaps in the loaded version, left open.
function renderLazyTarget(view, job) {
  const rows = loadedTargets.get(targetKey(view, job));
  const sub = el('details', { class: 'subgroup' });
  const st = statusOf(job);
  const summary = rows
    ? countBar(tally(rows), 'subgroup-counts')
    : el('div', { class: 'subgroup-counts' }, [
      el('span', { class: `count ${STATUS_LABEL[st]}`, text: `build ${st === 'UNKWN' ? 'pending' : STATUS_LABEL[st]}` }),
      el('span', { class: 'count', text: 'open to load' }),
    ]);
  sub.appendChild(el('summary', { class: 'subgroup-title' }, [el('span', { class: 'subgroup-name', text: job.name }), summary]));

  if (rows) {
    const shown = rows.filter(matches);
    if (search && shown.length) sub.setAttribute('open', '');
    sub.appendChild(renderTargetBody(job.name, job.release, shown));
    return sub;
  }

  const body = el('div', { class: 'subgroup-body' }, [el('p', { class: 'loading', text: 'Loading…' })]);
  sub.appendChild(body);
  sub.addEventListener('toggle', () => {
    if (!sub.open) return;
    loadTarget(view, job).then(() => {
      if (view !== currentView) return;
      const fresh = renderLazyTarget(view, job);
      fresh.setAttribute('open', '');
      sub.replaceWith(fresh);
      renderLazyCount(view);
    }).catch((err) => {
      console.error(err);
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'error', text: `Failed to load: ${err.message} — close and reopen to retry.` }));
    });
  });
  return sub;
}

// ---- url state ----
// The selected view and the search term live in the query string, so a
// filtered view can be bookmarked or shared. Defaults are left out to keep the
// bare URL clean.
function readState() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  currentView = VIEWS.some((v) => v.id === view) ? view : VIEWS[0].id;
  const s = params.get('sort');
  if (SORTS.some((o) => o.id === s)) sort = s;
  search = (params.get('q') || '').trim();
}

// Switching view is a navigation (pushState); typing only rewrites the
// current entry, otherwise every keystroke would land in the history.
function writeState({ push = false } = {}) {
  const params = new URLSearchParams();
  if (currentView !== VIEWS[0].id) params.set('view', currentView);
  if (sort !== SORTS[0].id) params.set('sort', sort);
  if (search) params.set('q', search);
  const qs = params.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  if (url === location.pathname + location.search) return;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function onPopState() {
  const prev = currentView;
  readState();
  const input = document.getElementById('search');
  if (input) input.value = search;
  renderViewButtons();
  renderSortButtons();
  if (currentView !== prev) showView();
  else if (viewReady) render();
}

// ---- controls ----
function renderViewButtons() {
  const group = document.getElementById('distro-buttons');
  group.innerHTML = '';
  for (const v of VIEWS) {
    const btn = el('button', {
      class: `distro-btn${v.id === currentView ? ' active' : ''}`,
      type: 'button',
      text: v.label,
    });
    btn.addEventListener('click', () => {
      if (currentView === v.id) return;
      currentView = v.id;
      writeState({ push: true });
      renderViewButtons();
      showView();
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
      if (viewReady) render();
    });
    group.appendChild(btn);
  }
}

// Loads what the current tab needs (each tab's data is fetched once and kept)
// and draws it. The chart is fetched on its own and may land first. Whatever
// arrives after the reader has moved to another tab is left alone rather than
// drawn over it.
function showView() {
  // The previous tab's chart goes right away, not when this one's arrives.
  const trendSection = document.getElementById('trend');
  if (trendSection) trendSection.hidden = true;
  const view = currentView;
  const trend = TRENDS[view];
  if (trend) loadTrendStats(trend.file).then((s) => renderTrend(view, s));

  const conf = viewConf();
  viewReady = false;
  document.getElementById('overview').innerHTML = '<li class="loading">Loading…</li>';
  const content = document.getElementById('content');
  content.innerHTML = '<p class="loading">Loading…</p>';
  document.getElementById('search-count').textContent = '';

  const data = conf.lazy ? loadSources() : loadViewRows(view);
  Promise.all([data, dashboardLoad]).then(([d, dash]) => {
    if (view !== currentView) return;
    if (conf.lazy) sources = d;
    else allPkgs = d;
    dashboard = dash;
    viewReady = true;
    renderOverview();
    render();
  }).catch((err) => {
    console.error(err);
    if (view !== currentView) return;
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'error', text: `Failed to load: ${err.message}` }));
  });
}

function load() {
  // Not fatal on its own: without the dashboard we lose the queue stats and the
  // tree still stands. It covers the whole distribution, every kind together,
  // since the daemon has no finer scope for it.
  dashboardLoad = fetchJSON(`/api/v1/dashboard?distribution=${encodeURIComponent(DISTRIBUTION)}`)
    .catch((err) => { console.error(err); return null; });
  showView();
}

function main() {
  readState();
  renderViewButtons();
  renderSortButtons();
  const input = document.getElementById('search');
  if (input) {
    input.value = search;
    input.addEventListener('input', (e) => {
      search = (e.target.value || '').trim();
      writeState();
      if (viewReady) render();
    });
  }
  window.addEventListener('popstate', onPopState);
  load();
}

main();
