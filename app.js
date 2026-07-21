'use strict';

// Status page for an OpenWrt rebuilderd instance.
//
// It fetches every tracked record, collapses each image to its newest version
// for the main tree (grouped release -> component -> status), and keeps the
// older versions as an inline per-image history. We dedupe client-side rather
// than relying on the daemon's `seen_only` flag: that flag is scoped per
// (distribution, release, architecture) with no component, so syncing one
// firmware target (they share the x86_64 build-host arch) wrongly marks the
// others unseen and they'd vanish from the page.

const API_BASE = (typeof window !== 'undefined' && window.REBUILDERD_API) || '';
const PAGE_LIMIT = 1000;

const DISTROS = [
  { id: 'openwrt-package', label: 'Packages' },
  { id: 'openwrt-image', label: 'Firmware images' },
];

const STATUS_ORDER = ['BAD', 'FAIL', 'UNKWN', 'GOOD'];
const STATUS_LABEL = { GOOD: 'good', BAD: 'bad', FAIL: 'fail', UNKWN: 'unknown' };

let currentDistro = DISTROS[0].id;
let allPkgs = [];              // newest version of each image (deduped)
let historyByKey = new Map();  // imageKey -> [records, newest first]
let dashboard = null;          // reproducibility + queue stats
let search = '';

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
async function fetchAll() {
  const records = [];
  let after = null;
  for (;;) {
    const params = new URLSearchParams({
      distribution: currentDistro,
      limit: String(PAGE_LIMIT),
    });
    if (after != null) params.set('after', String(after));
    const page = await fetchJSON(`/api/v1/packages/binary?${params}`);
    const recs = page.records || [];
    records.push(...recs);
    if (recs.length < PAGE_LIMIT) return records;
    after = recs[recs.length - 1].id;
  }
}

// Group every record by image; the newest version of each (highest binary id)
// is what the tree shows, the full list becomes that image's history.
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
  historyByKey = byKey;
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

  const li = el('li', {}, [row]);
  const history = historyByKey.get(imageKey(pkg)) || [];
  if (history.length > 1) li.appendChild(renderHistory(history));
  return li;
}

// Collapsed timeline of every version of one image, newest first — so you can
// see when it started or stopped reproducing. Built from the fetched records,
// no extra request.
function renderHistory(records) {
  const details = el('details', { class: 'history' });
  details.appendChild(el('summary', { class: 'history-title', text: `history (${records.length})` }));
  const list = el('ul', { class: 'history-list' });
  for (const r of records) {
    const st = statusOf(r);
    const li = el('li', {}, [
      el('span', { class: `dot ${STATUS_LABEL[st]}` }),
      el('span', { class: 'history-status', text: STATUS_LABEL[st] }),
      el('span', { class: 'history-version', text: r.version || '' }),
    ]);
    const links = renderLinks(r);
    if (links) li.appendChild(links);
    list.appendChild(li);
  }
  details.appendChild(list);
  return details;
}

// good/bad/fail/unknown lists. Bad opens by default (the actionable bucket);
// the rest stay collapsed unless a search is active.
function renderStatusGroups(pkgs) {
  const buckets = { GOOD: [], BAD: [], FAIL: [], UNKWN: [] };
  for (const p of pkgs) buckets[statusOf(p)].push(p);
  const out = [];
  for (const status of STATUS_ORDER) {
    const list = buckets[status];
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
    for (const [component, compPkgs] of groupBy(relPkgs, (p) => p.component || p.architecture || '(none)')) {
      const c = tally(compPkgs);
      const sub = el('details', { class: 'subgroup' });
      if (search || c.BAD) sub.setAttribute('open', '');
      sub.appendChild(el('summary', { class: 'subgroup-title' }, [
        el('span', { class: 'subgroup-name', text: component }),
        countBar(c, 'subgroup-counts'),
      ]));
      const subBody = el('div', { class: 'subgroup-body' });
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
  search = (params.get('q') || '').trim();
}

// Switching dataset is a navigation (pushState); typing only rewrites the
// current entry, otherwise every keystroke would land in the history.
function writeState({ push = false } = {}) {
  const params = new URLSearchParams();
  if (currentDistro !== DISTROS[0].id) params.set('distro', currentDistro);
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

async function load() {
  const overview = document.getElementById('overview');
  const content = document.getElementById('content');
  overview.innerHTML = '<li class="loading">Loading…</li>';
  content.innerHTML = '<p class="loading">Loading…</p>';
  allPkgs = [];
  dashboard = null;

  try {
    dashboard = await fetchJSON(`/api/v1/dashboard?distribution=${encodeURIComponent(currentDistro)}`);
  } catch (err) {
    console.error(err);
  }

  try {
    allPkgs = collapseVersions(await fetchAll());
  } catch (err) {
    console.error(err);
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'error', text: `Failed to load: ${err.message}` }));
    return;
  }

  renderOverview();
  render();
}

function main() {
  readState();
  renderDistroButtons();
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
