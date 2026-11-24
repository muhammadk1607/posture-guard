// Local persistence: settings in one JSON file, check history as one JSON-lines file per day.
// Everything lives in the app's userData folder and never leaves the machine.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/posture.js';
import { DAY, dayKey, startOfDay } from '../shared/analytics.js';

export class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.isFirstRun = !fs.existsSync(this.file);
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // missing or corrupt: start from defaults
    }
    this.data = { ...DEFAULT_SETTINGS, ...stored };
  }

  get() {
    return { ...this.data };
  }

  set(patch) {
    const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS));
    this.data = { ...this.data, ...allowed };
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    return this.get();
  }
}

export class HistoryStore {
  constructor(dir) {
    this.dir = path.join(dir, 'history');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  fileFor(t) {
    return path.join(this.dir, `${dayKey(t)}.jsonl`);
  }

  append(record) {
    fs.appendFileSync(this.fileFor(record.t), JSON.stringify(record) + '\n');
  }

  /** All records with from <= t < to. Reads only the day files that overlap the range. */
  async query(from, to) {
    const out = [];
    const d = new Date(startOfDay(from));
    while (d.getTime() < to) {
      const file = this.fileFor(d.getTime());
      let text = '';
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        // no checks that day
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r.t >= from && r.t < to) out.push(r);
        } catch {
          // skip a torn line (e.g. power loss mid-write)
        }
      }
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  /** Earliest day with data, or null. */
  async firstDay() {
    const files = (await fsp.readdir(this.dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    if (!files.length) return null;
    const [y, m, dd] = files[0].slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, dd).getTime();
  }

  async clear() {
    for (const f of await fsp.readdir(this.dir)) {
      if (f.endsWith('.jsonl')) await fsp.rm(path.join(this.dir, f));
    }
  }

  /** Delete day files older than `days` days. */
  async prune(days) {
    const cutoff = dayKey(startOfDay(Date.now()) - days * DAY);
    for (const f of await fsp.readdir(this.dir)) {
      if (f.endsWith('.jsonl') && f.slice(0, 10) < cutoff) await fsp.rm(path.join(this.dir, f));
    }
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
