'use strict';
// Writes ProdBud entries into an Obsidian vault as plain Markdown (no plugin needed).
//   <vault>/<logFolder>/<date> <HHmm> <name>.md   one Dataview-friendly note per task/break
//   <vault>/<dailyNotes.folder>/<YYYY-MM-DD>.md   one summary line under "## ProdBud Log"

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

function fmtMin(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Task';
}

// Quote YAML scalars unless they are obviously safe plain words.
const yaml = (s) => (/^[A-Za-z][\w .'-]*$/.test(s) ? s : JSON.stringify(s));
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
      interrupted: ev.interruptedNames || [],
      segments: [[ev.start, ev.end]],
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
    segments: closed,
  };
}

function fileName(e) {
  return `${ymd(e.start)} ${hm(e.start).replace(':', '')} ${safeFileName(e.name)}.md`;
}

function renderNote(e) {
  const fm = ['---', `type: ${e.type}`];
  if (e.type === 'task') {
    fm.push(`task: ${yaml(e.name)}`, `category: ${yaml(e.category)}`);
  } else {
    fm.push(`source: ${yaml(e.source)}`);
    if (e.source !== 'nap') fm.push(`task: ${yaml(e.name)}`);
  }
  fm.push(
    `date: ${ymd(e.start)}`,
    `start: "${hm(e.start)}"`,
    `end: "${hm(e.end)}"`,
    `duration_min: ${e.minutes}`,
  );
  if (e.type === 'task' || e.source !== 'nap') fm.push(`status: ${e.status}`);
  if (e.reason) fm.push(`reason: ${e.reason}`);
  if (e.type === 'break') fm.push(`interrupted: ${JSON.stringify(e.interrupted)}`);
  fm.push(`sessions: ${e.segments.length}`, '---', '');

  const body = [`# ${e.type === 'break' && e.source === 'nap' ? '💤 Nap' : e.name}`, ''];
  for (const [s, en] of e.segments) {
    const a = Date.parse(s);
    const b = Date.parse(en);
    body.push(`- ${hm(a)}–${hm(b)} (${fmtMin(Math.round((b - a) / 60000))})`);
  }
  return [...fm, ...body, ''].join('\n');
}

function dailyLine(e) {
  const span = `${hm(e.start)}–${hm(e.end)}`;
  const state = e.status === 'done' ? '' : ` ⏸ unfinished (${e.reason})`;
  if (e.type === 'break' && e.source === 'nap') {
    const n = e.interrupted.length;
    const note = n ? ` (interrupted ${n} task${n === 1 ? '' : 's'})` : '';
    return `- ${span} · 💤 Break · ${fmtMin(e.minutes)}${note}`;
  }
  if (e.type === 'break') return `- ${span} · 🎮 ${e.name} · ${fmtMin(e.minutes)} (break)${state}`;
  return `- ${span} · **${e.name}** · ${tag(e.category)} · ${fmtMin(e.minutes)}${e.status === 'done' ? ' ✅' : state}`;
}

// Append `line` at the end of the section under `heading` (creating the heading if missing).
function appendUnderHeading(content, heading, line) {
  const lines = content.split('\n');
  const h = lines.findIndex((l) => l.trim() === heading);
  if (h === -1) {
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${trimmed ? '\n\n' : ''}${heading}\n${line}\n`;
  }
  const level = (heading.match(/^#+/) || ['##'])[0].length;
  const nextHeading = new RegExp(`^#{1,${level}}\\s`);
  let end = h + 1;
  while (end < lines.length && !nextHeading.test(lines[end])) end++;
  let at = end;
  while (at > h + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

const STATS_NOTE = `# ProdBud Stats

## Today
\`\`\`dataview
TABLE type, category, duration_min, status FROM "{{folder}}"
WHERE date = date(today) SORT start ASC
\`\`\`

## This week: work per day
\`\`\`dataview
TABLE WITHOUT ID key AS Day, sum(rows.duration_min) AS "Work (min)", length(rows) AS "Tasks done"
FROM "{{folder}}"
WHERE type = "task" AND status = "done" AND date >= date(today) - dur(6 days)
GROUP BY date SORT key DESC
\`\`\`

## This week: breaks per day
\`\`\`dataview
TABLE WITHOUT ID key AS Day, sum(rows.duration_min) AS "Break (min)", length(rows) AS Breaks
FROM "{{folder}}"
WHERE type = "break" AND date >= date(today) - dur(6 days)
GROUP BY date SORT key DESC
\`\`\`

## This week: time by category
\`\`\`dataview
TABLE WITHOUT ID key AS Category, sum(rows.duration_min) AS "Minutes"
FROM "{{folder}}"
WHERE type = "task" AND date >= date(today) - dur(6 days)
GROUP BY category SORT sum(rows.duration_min) DESC
\`\`\`

## Unfinished
\`\`\`dataview
TABLE date, reason, duration_min FROM "{{folder}}"
WHERE status = "unfinished" SORT date DESC
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

  // Returns the written note path, or null when logging is off/failed (see this.status).
  log(ev) {
    if (!this._checkVault()) return null;
    try {
      const e = normalize(ev);
      fs.mkdirSync(this.folder, { recursive: true });
      const note = path.join(this.folder, fileName(e));
      fs.writeFileSync(note, renderNote(e));

      const daily = this.config.dailyNotes || {};
      if (daily.enabled) {
        const dir = path.join(this.vault, daily.folder || '');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${ymd(e.end)}.md`);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        fs.writeFileSync(file, appendUnderHeading(current, daily.heading || '## ProdBud Log', dailyLine(e)));
      }
      this.status = 'ok';
      return note;
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
      fs.mkdirSync(this.folder, { recursive: true });
      const folder = (this.config.logFolder || 'ProdBud').replace(/\\/g, '/');
      fs.writeFileSync(file, STATS_NOTE.replaceAll('{{folder}}', folder));
    } catch (err) {
      this.status = `Obsidian write failed: ${err.message}`;
    }
  }
}

module.exports = { ObsidianLogger, normalize, renderNote, dailyLine, appendUnderHeading, fileName, fmtMin };
