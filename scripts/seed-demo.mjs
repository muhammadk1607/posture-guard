// Writes ~30 days of fake history so the reports page can be previewed without weeks of real use.
// Usage: node scripts/seed-demo.mjs <userDataDir>   (then: PG_USER_DATA=<userDataDir> npm start)
import fs from 'node:fs';
import path from 'node:path';
import { dayKey, DAY, startOfDay } from '../src/shared/analytics.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/seed-demo.mjs <userDataDir>');
fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
const codes = ['slouch', 'slouch', 'slouch', 'lean-in', 'lean-in', 'shoulders', 'head-tilt', 'side-lean', 'recline'];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const today = startOfDay(Date.now());
for (let d = 29; d >= 0; d--) {
  const day = today - d * DAY;
  if (new Date(day).getDay() % 6 === 0 && rnd() < 0.7) continue; // most weekends off
  const lines = [];
  const end = d === 0 ? Math.min(Date.now(), day + 17 * 3600e3) : day + 17.5 * 3600e3;
  for (let t = day + 9 * 3600e3; t < end; t += 120e3) {
    const h = new Date(t).getHours();
    if (h === 12 && rnd() < 0.9) continue; // lunch
    const fatigue = (h - 9) / 10 + d / 90; // worse late in the day, improving over the month
    const r = rnd();
    let rec;
    if (r < 0.06) rec = { t, status: 'away', dur: 120 };
    else if (r < 0.06 + 0.15 + fatigue * 0.35) {
      const issues = [...new Set([codes[Math.floor(rnd() * codes.length)], ...(rnd() < 0.3 ? [codes[Math.floor(rnd() * codes.length)]] : [])])];
      rec = { t, status: 'bad', score: Math.round(45 + rnd() * 35), issues, dur: 120, warned: rnd() < 0.6 };
    } else rec = { t, status: 'good', score: Math.round(88 + rnd() * 12), dur: 120 };
    lines.push(JSON.stringify(rec));
  }
  fs.writeFileSync(path.join(dir, 'history', `${dayKey(day)}.jsonl`), lines.join('\n') + '\n');
}
console.log('seeded', dir);
