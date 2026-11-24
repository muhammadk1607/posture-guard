// Pure aggregation of check history into report data. Shared by the main process (tray summary)
// and the reports page. No I/O here, so it is easy to test.
//
// A history record looks like:
//   { t, status: 'good'|'bad'|'away'|'error', score?, issues?: [code], dur, warned?, manual? }
// `dur` is the number of seconds the check stands for: the scheduled interval for automatic
// checks, 0 for manual ones (so a manual check never inflates the time totals).

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfHour(t) {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** Local calendar date as YYYY-MM-DD (used for history file names and bucket keys). */
export function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Bucket boundaries from `from` up to `to`, stepping by local hour or local day (DST-safe). */
export function bucketStarts(from, to, bucket) {
  const out = [];
  const d = new Date(bucket === 'hour' ? startOfHour(from) : startOfDay(from));
  while (d.getTime() < to) {
    out.push(d.getTime());
    if (bucket === 'hour') d.setHours(d.getHours() + 1);
    else d.setDate(d.getDate() + 1);
  }
  return out;
}

const measured = (r) => r.status === 'good' || r.status === 'bad';

function emptyBucket(start) {
  return { start, goodSec: 0, badSec: 0, awaySec: 0, checks: 0, good: 0, bad: 0, warnings: 0, scoreSum: 0, avgScore: null };
}

function add(b, r) {
  const dur = r.dur || 0;
  if (r.status === 'good') {
    b.goodSec += dur;
    b.good++;
  } else if (r.status === 'bad') {
    b.badSec += dur;
    b.bad++;
  } else {
    b.awaySec += dur;
  }
  if (measured(r)) {
    b.checks++;
    b.scoreSum += r.score ?? 0;
  }
  if (r.warned) b.warnings++;
}

function finish(b) {
  b.avgScore = b.checks ? Math.round(b.scoreSum / b.checks) : null;
  const tracked = b.goodSec + b.badSec;
  // Share of time in good posture; fall back to check counts when only manual checks exist.
  b.goodPct = tracked > 0 ? b.goodSec / tracked : b.checks ? b.good / b.checks : null;
  delete b.scoreSum;
  return b;
}

/**
 * @param {object[]} records  history records (any order)
 * @param {{from:number,to:number,bucket?:'hour'|'day'}} range  epoch ms, `to` exclusive
 */
export function summarize(records, { from, to, bucket }) {
  bucket ??= to - from <= DAY + HOUR ? 'hour' : 'day';
  const rows = records.filter((r) => r.t >= from && r.t < to).sort((a, b) => a.t - b.t);

  const starts = bucketStarts(from, to, bucket);
  const buckets = starts.map(emptyBucket);
  const totals = emptyBucket(from);
  const issueCounts = {};
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, checks: 0, bad: 0, badPct: null }));

  let bi = 0;
  for (const r of rows) {
    while (bi + 1 < starts.length && r.t >= starts[bi + 1]) bi++;
    if (buckets[bi]) add(buckets[bi], r);
    add(totals, r);
    if (measured(r)) {
      const h = byHour[new Date(r.t).getHours()];
      h.checks++;
      if (r.status === 'bad') h.bad++;
    }
    if (r.status === 'bad') for (const code of r.issues ?? []) issueCounts[code] = (issueCounts[code] ?? 0) + 1;
  }
  for (const h of byHour) h.badPct = h.checks ? h.bad / h.checks : null;

  const issues = Object.entries(issueCounts)
    .map(([code, count]) => ({ code, count, pct: totals.bad ? count / totals.bad : 0 }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return {
    from,
    to,
    bucket,
    totals: finish(totals),
    buckets: buckets.map(finish),
    issues,
    byHour,
    longestGoodStreakSec: longestGoodStreak(rows),
    recentWarnings: rows.filter((r) => r.warned).slice(-25).reverse(),
  };
}

/**
 * Longest run of consecutive automatic good checks, in seconds. A bad or away check ends the
 * run, and so does a gap (sleep, pause, app closed) longer than twice the check interval.
 */
export function longestGoodStreak(sortedRows) {
  let best = 0;
  let cur = 0;
  let lastT = null;
  for (const r of sortedRows) {
    if (r.manual) continue;
    const gapTooLong = lastT !== null && r.t - lastT > 2 * (r.dur || 0) * 1000;
    if (r.status === 'good' && !gapTooLong) {
      cur += r.dur || 0;
    } else if (r.status === 'good') {
      cur = r.dur || 0;
    } else {
      cur = 0;
    }
    best = Math.max(best, cur);
    lastT = r.t;
  }
  return best;
}

/** "2 h 15 min", "45 min", "0 min"; whole hours only from 10 h up ("118 h") to stay short. */
export function formatDuration(sec) {
  if (sec >= 10 * 3600) return `${Math.round(sec / 3600)} h`;
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

/** CSV export of raw history, one row per check. */
export function toCsv(records, issueNames = {}) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['time', 'status', 'score', 'issues', 'seconds_counted', 'warned', 'manual'].join(',')];
  for (const r of [...records].sort((a, b) => a.t - b.t)) {
    lines.push(
      [
        new Date(r.t).toISOString(),
        r.status,
        r.score ?? '',
        (r.issues ?? []).map((c) => issueNames[c] ?? c).join('; '),
        r.dur ?? 0,
        r.warned ? 1 : 0,
        r.manual ? 1 : 0,
      ]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
