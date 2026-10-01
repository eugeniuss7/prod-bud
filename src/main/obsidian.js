'use strict';
// Writes ProdBud's log into an Obsidian vault as plain Markdown (no plugin needed).
// One file per day: <vault>/<logFolder>/prod_data M-D-YYYY.md
// Each finished task (and each break) is appended as one line; the frontmatter keeps
// running day totals for Dataview.

const fs = require('fs');
const path = require('path');
const { segmentMs } = require('./store');

const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// "10/1/2026" style, as in the file name ("/" is not allowed in file names, so "-" there).
const mdy = (ms, sep = '/') => {
  const d = new Date(ms);
  return [d.getMonth() + 1, d.getDate(), d.getFullYear()].join(sep);
};

function fmtMin(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const tag = (s) => `#${String(s).trim().replace(/\s+/g, '-')}`;

// Turn a store 'log' event into a flat entry.
function normalize(ev) {
  if (ev.kind === 'break') {
    const start = Date.parse(ev.start);
    const end = Date.parse(ev.end);
    return {
      type: 'break',
      source: 'nap',
      name: 'Nap',
      start,
      end,
      minutes: Math.round((end - start) / 60000),
      status: 'done',
      reason: null,
      interrupted: ev.interruptedNames || [],
    };
  }
  const t = ev.task;
  const closed = t.segments.filter((seg) => seg[1]);
  const start = Date.parse(t.segments[0][0]);
  const end = closed.length ? Date.parse(closed[closed.length - 1][1]) : start;
  const ms = closed.reduce((sum, seg) => sum + segmentMs(seg, end), 0);
  return {
    type: t.kind === 'break' ? 'break' : 'task',
    source: t.category,
    name: t.name,
    category: t.category,
    start,
    end,
    minutes: Math.round(ms / 60000),
    status: t.status,
    reason: t.reason,
    interrupted: ev.interruptedNames || [],
  };
}

// The day an entry belongs to. Midnight-closed entries end exactly at 00:00, which is still the previous day.
const entryDay = (e) => Math.max(e.start, e.end - 1);

function fileName(ms) {
  return `prod_data ${mdy(ms, '-')}.md`;
}

function entryLine(e) {
  const span = `${hm(e.start)}–${hm(e.end)}`;
  const midnight = e.reason === 'midnight' ? ' (auto-closed at midnight)' : '';
  if (e.type === 'break' && e.source === 'nap') {
    const n = e.interrupted.length;
    const note = n ? ` (interrupted ${n} task${n === 1 ? '' : 's'})` : '';
    return `- ${span} · 💤 Break · ${fmtMin(e.minutes)}${note}${midnight}`;
  }
  if (e.type === 'break') return `- ${span} · 🎮 ${e.name} · ${fmtMin(e.minutes)} (break)${midnight}`;
  return `- ${span} · **${e.name}** · ${tag(e.category)} · ${fmtMin(e.minutes)} ✅${midnight}`;
}

const TOTALS = ['tasks_done', 'work_min', 'break_min'];

function newDayFile(day) {
  return [
    '---',
    'type: prodbud-day',
    `date: ${ymd(day)}`,
    ...TOTALS.map((k) => `${k}: 0`),
    '---',
    `# ProdBud ${mdy(day)}`,
    '',
  ].join('\n');
}

// Add the entry's line at the end of the day file and bump the frontmatter totals.
function addEntry(content, e) {
  const add = e.type === 'task' ? { tasks_done: 1, work_min: e.minutes } : { break_min: e.minutes };
  let out = content;
  for (const [key, inc] of Object.entries(add)) {
    const re = new RegExp(`^${key}: (\\d+)$`, 'm');
    out = re.test(out)
      ? out.replace(re, (_, n) => `${key}: ${Number(n) + inc}`)
      : out.replace(/^---\n/, `---\n${key}: ${inc}\n`);
  }
  return `${out.replace(/\s+$/, '')}\n${entryLine(e)}\n`;
}

const STATS_NOTE = `# ProdBud Stats

## Last 7 days
\`\`\`dataview
TABLE WITHOUT ID file.link AS Day, tasks_done AS "Tasks done", work_min AS "Work (min)", break_min AS "Break (min)"
FROM "{{folder}}"
WHERE type = "prodbud-day" AND date >= date(today) - dur(6 days)
SORT date DESC
\`\`\`

## Last 30 days
\`\`\`dataview
TABLE WITHOUT ID file.link AS Day, tasks_done AS "Tasks done", work_min AS "Work (min)", break_min AS "Break (min)"
FROM "{{folder}}"
WHERE type = "prodbud-day" AND date >= date(today) - dur(29 days)
SORT date DESC
\`\`\`
`;

class ObsidianLogger {
  constructor(config) {
    this.setConfig(config);
  }

  setConfig(config) {
    this.config = config;
    this.status = this.vault ? 'ok' : 'unset';
  }

  get vault() {
    return String(this.config.vaultPath || '').trim();
  }

  get folder() {
    return path.join(this.vault, this.config.logFolder || 'ProdBud');
  }

  _checkVault() {
    if (!this.vault) {
      this.status = 'unset';
      return false;
    }
    if (!fs.existsSync(this.vault)) {
      this.status = `Vault not found: ${this.vault}`;
      return false;
    }
    return true;
  }

  // Only finished tasks and ended breaks are logged; unfinished tasks are logged once they're done
  // (at the latest at midnight). Returns the day file path, or null (see this.status).
  log(ev) {
    if (ev.kind === 'task' && ev.task.status !== 'done') return null;
    if (!this._checkVault()) return null;
    try {
      const e = normalize(ev);
      const day = entryDay(e);
      fs.mkdirSync(this.folder, { recursive: true });
      const file = path.join(this.folder, fileName(day));
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : newDayFile(day);
      fs.writeFileSync(file, addEntry(current, e));
      this.status = 'ok';
      return file;
    } catch (err) {
      this.status = `Obsidian write failed: ${err.message}`;
      return null;
    }
  }

  ensureStatsNote() {
    if (!this._checkVault()) return;
    try {
      // Lives outside the log folder so it doesn't show up in its own queries.
      const file = path.join(this.vault, 'ProdBud Stats.md');
      if (fs.existsSync(file)) return;
      const folder = (this.config.logFolder || 'ProdBud').replace(/\\/g, '/');
      fs.writeFileSync(file, STATS_NOTE.replaceAll('{{folder}}', folder));
    } catch (err) {
      this.status = `Obsidian write failed: ${err.message}`;
    }
  }
}

module.exports = { ObsidianLogger, normalize, entryLine, addEntry, newDayFile, fileName, fmtMin };
