import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR, formatDuration, longestGoodStreak, startOfDay, summarize, toCsv } from '../src/shared/analytics.js';
import { evaluate, ISSUES } from '../src/shared/posture.js';

const day0 = startOfDay(new Date(2026, 10, 20).getTime()); // local midnight
const at = (h, m = 0) => day0 + h * HOUR + m * 60_000;

const rec = (t, status, extra = {}) => ({ t, status, dur: 120, ...extra });

test('summarize totals time, warnings and score', () => {
  const rows = [
    rec(at(9, 0), 'good', { score: 100 }),
    rec(at(9, 2), 'good', { score: 90 }),
    rec(at(9, 4), 'bad', { score: 60, issues: ['slouch', 'lean-in'], warned: true }),
    rec(at(9, 6), 'away'),
    rec(at(10, 0), 'bad', { score: 70, issues: ['slouch'], warned: true }),
    rec(at(10, 1), 'good', { score: 95, dur: 0, manual: true }),
  ];
  const s = summarize(rows, { from: day0, to: day0 + DAY });
  assert.equal(s.bucket, 'hour');
  assert.equal(s.buckets.length, 24);
  assert.equal(s.totals.goodSec, 240);
  assert.equal(s.totals.badSec, 240);
  assert.equal(s.totals.awaySec, 120);
  assert.equal(s.totals.warnings, 2);
  assert.equal(s.totals.checks, 5);
  assert.equal(s.totals.avgScore, Math.round((100 + 90 + 60 + 70 + 95) / 5));
  assert.equal(s.totals.goodPct, 0.5);
  assert.equal(s.buckets[9].goodSec, 240);
  assert.equal(s.buckets[10].badSec, 120);
  assert.deepEqual(
    s.issues.map((i) => [i.code, i.count, i.pct]),
    [['slouch', 2, 1], ['lean-in', 1, 0.5]],
  );
  assert.equal(s.byHour[9].checks, 3);
  assert.equal(s.byHour[9].bad, 1);
  assert.equal(s.recentWarnings[0].t, at(10, 0)); // newest first
});

test('summarize buckets by day for multi-day ranges and ignores out-of-range rows', () => {
  const rows = [rec(day0 - 1, 'good', { score: 100 }), rec(at(12), 'good', { score: 100 }), rec(at(36), 'bad', { score: 50, issues: ['recline'] })];
  const s = summarize(rows, { from: day0, to: day0 + 7 * DAY });
  assert.equal(s.bucket, 'day');
  assert.equal(s.buckets.length, 7);
  assert.equal(s.buckets[0].goodSec, 120);
  assert.equal(s.buckets[1].badSec, 120);
  assert.equal(s.totals.checks, 2);
});

test('goodPct falls back to check counts when only manual checks exist', () => {
  const rows = [rec(at(9), 'good', { dur: 0, score: 100 }), rec(at(9, 1), 'bad', { dur: 0, score: 50 })];
  assert.equal(summarize(rows, { from: day0, to: day0 + DAY }).totals.goodPct, 0.5);
});

test('longest good streak breaks on bad checks and long gaps', () => {
  const rows = [
    rec(at(9, 0), 'good'),
    rec(at(9, 2), 'good'),
    rec(at(9, 4), 'good'),
    rec(at(9, 6), 'bad'),
    rec(at(9, 8), 'good'),
    rec(at(11, 0), 'good'), // 2h gap: new streak
    rec(at(11, 2), 'good', { manual: true, dur: 0 }), // manual checks are ignored
  ];
  assert.equal(longestGoodStreak(rows), 360);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(45 * 60), '45 min');
  assert.equal(formatDuration(3600), '1 h');
  assert.equal(formatDuration(8100), '2 h 15 min');
  assert.equal(formatDuration(118 * 3600 + 28 * 60), '118 h');
});

test('toCsv escapes and names issues', () => {
  const csv = toCsv([rec(at(9), 'bad', { score: 40, issues: ['slouch', 'shoulders'], warned: true })], {
    slouch: 'Slouching',
    shoulders: 'Uneven, shoulders',
  });
  const [header, row] = csv.trim().split('\n');
  assert.equal(header, 'time,status,score,issues,seconds_counted,warned,manual');
  assert.match(row, /,bad,40,"Slouching; Uneven, shoulders",120,1,0$/);
});

test('evaluate reports known issue codes with titles', () => {
  const base = { neckRatio: 1, shoulderWidth: 0.3, shoulderTilt: 0, headTilt: 0, headOffset: 0 };
  const ok = evaluate(base, base);
  assert.equal(ok.ok, true);
  assert.equal(ok.score, 100);
  const bad = evaluate({ ...base, neckRatio: 0.6, shoulderTilt: 15 }, base);
  assert.deepEqual(bad.issues.map((i) => i.code), ['slouch', 'shoulders']);
  for (const i of bad.issues) assert.equal(i.title, ISSUES[i.code].title);
});
