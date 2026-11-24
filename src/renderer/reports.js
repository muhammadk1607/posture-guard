// Reports view: summary tiles, charts and tables built from local check history.
/* global Chart */

import { ISSUES } from '../shared/posture.js';
import { DAY, formatDuration, startOfDay, summarize } from '../shared/analytics.js';

const $ = (id) => document.getElementById(id);
const charts = {};
let range = 'today';
let rendering = false;
let queued = false;

try {
  range = localStorage.getItem('pg.range') || 'today';
} catch {
  // ignore
}

// ---------- theme tokens ----------

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    surface: v('--card'),
    text: v('--text'),
    muted: v('--muted'),
    grid: v('--grid'),
    good: v('--status-good'),
    bad: v('--status-critical'),
    series: v('--series-1'),
    seriesWash: v('--series-1-wash'),
  };
}

function rangeBounds() {
  const today = startOfDay(Date.now());
  if (range === 'today') return { from: today, to: today + DAY, bucket: 'hour' };
  const days = Number(range);
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  return { from: from.getTime(), to: today + DAY, bucket: 'day' };
}

const fmtHour = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });
const fmtDay = (t, long = false) =>
  new Date(t).toLocaleDateString([], long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
const fmtHourOfDay = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const hours = (sec) => Math.round((sec / 3600) * 100) / 100;

// ---------- render ----------

export async function renderReports() {
  if (rendering) {
    queued = true;
    return;
  }
  rendering = true;
  try {
    const b = rangeBounds();
    const records = await window.pg.queryHistory(b.from, b.to);
    const sum = summarize(records, b);
    paintToolbar(b);
    const hasData = records.length > 0;
    $('empty').hidden = hasData;
    $('report').hidden = !hasData;
    if (!hasData) return;
    const t = tokens();
    paintTiles(sum);
    paintTime(sum, t);
    paintIssues(sum, t);
    paintScore(sum, t);
    paintHours(sum, t);
    paintWarnings(sum);
  } finally {
    rendering = false;
    if (queued) {
      queued = false;
      renderReports();
    }
  }
}

function paintToolbar(b) {
  for (const btn of $('range').querySelectorAll('button')) {
    const on = btn.dataset.range === range;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on);
  }
  $('range-label').textContent =
    range === 'today' ? fmtDay(b.from, true) : `${fmtDay(b.from)} – ${fmtDay(b.to - 1)}`;
}

function tile(label, value, note) {
  const el = document.createElement('div');
  el.className = 'tile';
  const l = document.createElement('div');
  l.className = 'tile-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'tile-value';
  v.textContent = value;
  el.append(l, v);
  if (note) {
    const n = document.createElement('div');
    n.className = 'tile-note';
    n.textContent = note;
    el.append(n);
  }
  return el;
}

function paintTiles(sum) {
  const t = sum.totals;
  const days = sum.bucket === 'day' ? sum.buckets.filter((b) => b.checks > 0).length : 0;
  const perDay = (sec) => (days > 1 ? `${formatDuration(sec / days)} per active day` : null);
  const top = sum.issues[0];
  $('tiles').replaceChildren(
    tile('Good posture', formatDuration(t.goodSec), perDay(t.goodSec)),
    tile('Poor posture', formatDuration(t.badSec), perDay(t.badSec)),
    tile('Time in good posture', pct(t.goodPct), `${t.checks} checks · away ${formatDuration(t.awaySec)}`),
    tile('Warnings', String(t.warnings), days > 1 ? `${(t.warnings / days).toFixed(1)} per active day` : null),
    tile('Average score', t.avgScore === null ? '—' : `${t.avgScore}/100`, null),
    tile('Longest good streak', formatDuration(sum.longestGoodStreakSec), top ? `Top problem: ${ISSUES[top.code]?.short ?? top.code}` : null),
  );
}

// Shared Chart.js styling: recessive hairline grid, text tokens, no chart-junk.
function baseOptions(t, { yMax, yTicks, xTitle } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.surface,
        titleColor: t.text,
        bodyColor: t.text,
        borderColor: t.grid,
        borderWidth: 1,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: t.grid },
        ticks: { color: t.muted, maxRotation: 0, autoSkipPadding: 12 },
        title: xTitle ? { display: true, text: xTitle, color: t.muted } : undefined,
      },
      y: {
        beginAtZero: true,
        max: yMax,
        grid: { color: t.grid, lineWidth: 1 },
        border: { display: false },
        ticks: { color: t.muted, ...yTicks },
      },
    },
  };
}

function upsert(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), config);
}

function table(containerId, headers, rows) {
  const tbl = document.createElement('table');
  const thead = tbl.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.append(th);
  }
  const tb = tbl.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of r) tr.insertCell().textContent = c;
  }
  $(containerId).replaceChildren(tbl);
}

function bucketLabel(sum, start) {
  return sum.bucket === 'hour' ? fmtHour(start) : fmtDay(start);
}

function paintTime(sum, t) {
  const labels = sum.buckets.map((b) => bucketLabel(sum, b.start));
  const good = sum.buckets.map((b) => hours(b.goodSec));
  const bad = sum.buckets.map((b) => hours(b.badSec));
  const unit = sum.bucket === 'hour' ? 'minutes' : 'hours';
  const scale = sum.bucket === 'hour' ? 60 : 1; // show minutes per hour when looking at a single day
  $('time-sub').textContent =
    sum.bucket === 'hour'
      ? 'Minutes per hour, measured while you were at your desk'
      : 'Hours per day, measured while you were at your desk';

  // Round only the top-most visible segment; 2px surface gap between stacked segments.
  const topRadius = (isTop) => (isTop ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0);
  const fmt = (v) => (unit === 'minutes' ? `${Math.round(v)} min` : formatDuration(v * 3600));
  upsert('chart-time', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Good posture',
          data: good.map((h) => h * scale),
          backgroundColor: t.good,
          maxBarThickness: 24,
          borderSkipped: 'start',
          borderRadius: (c) => topRadius(bad[c.dataIndex] === 0),
        },
        {
          label: 'Poor posture',
          data: bad.map((h) => h * scale),
          backgroundColor: t.bad,
          maxBarThickness: 24,
          borderColor: t.surface,
          borderWidth: (c) => (good[c.dataIndex] > 0 ? { bottom: 2, top: 0, left: 0, right: 0 } : 0),
          borderSkipped: false,
          borderRadius: () => topRadius(true),
        },
      ],
    },
    options: (() => {
      const o = baseOptions(t, { yMax: sum.bucket === 'hour' ? 60 : undefined });
      o.scales.x.stacked = true;
      o.scales.y.stacked = true;
      o.scales.y.ticks.callback = (v) => (unit === 'minutes' ? `${v} min` : `${v} h`);
      o.plugins.tooltip.callbacks = { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` };
      return o;
    })(),
  });

  table(
    'table-time',
    [sum.bucket === 'hour' ? 'Hour' : 'Day', 'Good posture', 'Poor posture', 'Away', 'Warnings', 'Avg score'],
    sum.buckets
      .filter((b) => b.checks || b.awaySec)
      .map((b) => [
        bucketLabel(sum, b.start),
        formatDuration(b.goodSec),
        formatDuration(b.badSec),
        formatDuration(b.awaySec),
        b.warnings,
        b.avgScore ?? '—',
      ]),
  );
}

function paintIssues(sum, t) {
  const has = sum.issues.length > 0;
  $('issues-empty').hidden = has;
  $('issues-box').hidden = !has;
  $('issues-box').style.height = `${Math.max(140, sum.issues.length * 44 + 40)}px`;
  if (has) {
    upsert('chart-issues', {
      type: 'bar',
      data: {
        labels: sum.issues.map((i) => ISSUES[i.code]?.short ?? i.code),
        datasets: [
          {
            label: 'Seen in poor-posture checks',
            data: sum.issues.map((i) => Math.round(i.pct * 100)),
            backgroundColor: t.series,
            maxBarThickness: 24,
            borderRadius: { topRight: 4, bottomRight: 4, topLeft: 0, bottomLeft: 0 },
            borderSkipped: 'start',
          },
        ],
      },
      options: (() => {
        const o = baseOptions(t, { yTicks: {} });
        o.indexAxis = 'y';
        o.interaction = { mode: 'nearest', axis: 'y', intersect: false };
        // swap axis roles for horizontal bars
        o.scales = {
          x: { beginAtZero: true, max: 100, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, callback: (v) => `${v}%` } },
          y: { grid: { display: false }, border: { color: t.grid }, ticks: { color: t.text } },
        };
        o.plugins.tooltip.callbacks = {
          label: (c) => {
            const i = sum.issues[c.dataIndex];
            return ` ${c.parsed.x}% of poor-posture checks (${i.count} time${i.count === 1 ? '' : 's'})`;
          },
        };
        return o;
      })(),
    });
  } else {
    charts['chart-issues']?.destroy();
    delete charts['chart-issues'];
  }
  table(
    'table-issues',
    ['Problem', 'Times seen', 'Share of poor-posture checks'],
    sum.issues.map((i) => [ISSUES[i.code]?.short ?? i.code, i.count, pct(i.pct)]),
  );

  const fixes = $('fixes');
  fixes.replaceChildren();
  if (!has) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing to fix in this period. Keep it up.';
    fixes.append(li);
  }
  for (const i of sum.issues.slice(0, 3)) {
    const meta = ISSUES[i.code];
    if (!meta) continue;
    const li = document.createElement('li');
    const h = document.createElement('b');
    h.textContent = meta.short;
    const n = document.createElement('span');
    n.className = 'muted';
    n.textContent = ` · ${i.count} time${i.count === 1 ? '' : 's'}`;
    const p = document.createElement('p');
    p.textContent = meta.fix;
    li.append(h, n, p);
    fixes.append(li);
  }
}

function paintScore(sum, t) {
  const pts = sum.buckets.map((b) => b.avgScore);
  $('score-sub').textContent = `0–100, higher is better · average per ${sum.bucket}`;
  upsert('chart-score', {
    type: 'line',
    data: {
      labels: sum.buckets.map((b) => bucketLabel(sum, b.start)),
      datasets: [
        {
          label: 'Average score',
          data: pts,
          borderColor: t.series,
          backgroundColor: t.seriesWash,
          fill: 'origin',
          borderWidth: 2,
          borderCapStyle: 'round',
          borderJoinStyle: 'round',
          tension: 0.25,
          spanGaps: true,
          pointRadius: pts.filter((p) => p !== null).length <= 1 ? 4 : 0,
          pointHoverRadius: 5,
          pointBackgroundColor: t.series,
          pointBorderColor: t.surface,
          pointBorderWidth: 2,
        },
      ],
    },
    options: (() => {
      const o = baseOptions(t, { yMax: 100, yTicks: { stepSize: 25 } });
      o.plugins.tooltip.callbacks = { label: (c) => ` Average score: ${c.parsed.y}/100` };
      return o;
    })(),
  });
  table(
    'table-score',
    [sum.bucket === 'hour' ? 'Hour' : 'Day', 'Average score', 'Checks'],
    sum.buckets.filter((b) => b.checks).map((b) => [bucketLabel(sum, b.start), b.avgScore, b.checks]),
  );
}

function paintHours(sum, t) {
  const data = sum.byHour.map((h) => (h.badPct === null ? null : Math.round(h.badPct * 100)));
  upsert('chart-hours', {
    type: 'bar',
    data: {
      labels: sum.byHour.map((h) => fmtHourOfDay(h.hour)),
      datasets: [
        {
          label: 'Poor posture',
          data,
          backgroundColor: t.series,
          maxBarThickness: 24,
          borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
          borderSkipped: 'start',
        },
      ],
    },
    options: (() => {
      const o = baseOptions(t, { yMax: 100, yTicks: { stepSize: 25, callback: (v) => `${v}%` } });
      o.plugins.tooltip.callbacks = {
        label: (c) => {
          const h = sum.byHour[c.dataIndex];
          return ` ${c.parsed.y}% poor (${h.bad} of ${h.checks} checks)`;
        },
      };
      return o;
    })(),
  });
  table(
    'table-hours',
    ['Hour', 'Checks', 'Poor posture', 'Share poor'],
    sum.byHour.filter((h) => h.checks).map((h) => [fmtHourOfDay(h.hour), h.checks, h.bad, pct(h.badPct)]),
  );
}

function paintWarnings(sum) {
  const box = $('warnings');
  if (!sum.recentWarnings.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No warnings in this period.';
    box.replaceChildren(p);
    return;
  }
  const tbl = document.createElement('table');
  tbl.className = 'list';
  const head = tbl.createTHead().insertRow();
  for (const h of ['When', 'Score', 'Problems']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const tb = tbl.createTBody();
  for (const r of sum.recentWarnings) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = new Date(r.t).toLocaleString([], {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      ...(range === 'today' ? {} : { month: 'short', day: 'numeric' }),
    });
    tr.insertCell().textContent = `${r.score}/100`;
    tr.insertCell().textContent = (r.issues ?? []).map((c) => ISSUES[c]?.short ?? c).join(', ');
  }
  box.replaceChildren(tbl);
}

// ---------- controls ----------

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  range = btn.dataset.range;
  try {
    localStorage.setItem('pg.range', range);
  } catch {
    // ignore
  }
  renderReports();
});

$('export').onclick = () => window.pg.exportHistory();
$('clear').onclick = async () => {
  if (await window.pg.clearHistory()) renderReports();
};

// Repaint charts with the right colors when the OS theme flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!$('view-reports').hidden) renderReports();
});
