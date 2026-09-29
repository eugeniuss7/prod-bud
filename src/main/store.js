'use strict';
// Task/break state machine. Pure logic: no Electron, no filesystem.
// Time is stored as segments of ISO timestamps so pauses are excluded and resumes add up.

const { EventEmitter } = require('events');
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString();

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function makeId(ms) {
  const d = new Date(ms);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `t_${date}_${time}_${crypto.randomBytes(2).toString('hex')}`;
}

// Milliseconds of a [start, end|null] segment, optionally clipped to [from, to).
function segmentMs(seg, now, from = -Infinity, to = Infinity) {
  const start = Math.max(Date.parse(seg[0]), from);
  const end = Math.min(seg[1] ? Date.parse(seg[1]) : now, to);
  return Math.max(0, end - start);
}

function totalMs(task, now) {
  return task.segments.reduce((sum, seg) => sum + segmentMs(seg, now), 0);
}

function emptyState() {
  return { version: 1, tasks: [], nap: null, breaks: [], pendingResume: [] };
}

class Store extends EventEmitter {
  constructor({ state = null, now = Date.now, autoUnfinishMin = 30 } = {}) {
    super();
    this.now = now;
    this.autoUnfinishMin = autoUnfinishMin;
    this.state = { ...emptyState(), ...(state || {}) };
  }

  get(id) {
    return this.state.tasks.find((t) => t.id === id);
  }

  byStatus(...statuses) {
    return this.state.tasks.filter((t) => statuses.includes(t.status));
  }

  // ---- commands -------------------------------------------------------------

  start({ name, kind = 'work', category = 'general', icon = null, presetId = null }) {
    name = String(name || '').trim();
    if (!name) throw new Error('Task name is required');
    const now = this.now();
    const task = {
      id: makeId(now),
      name,
      kind: kind === 'break' ? 'break' : 'work',
      category: category || 'general',
      icon,
      presetId,
      status: 'idle',
      reason: null,
      segments: [],
      createdAt: iso(now),
      pausedAt: null,
      finishedAt: null,
      interrupted: [],
      pos: null,
    };
    this.state.tasks.push(task);
    this._activate(task);
    this._changed();
    return task;
  }

  pause(id) {
    const task = this.get(id);
    if (!task || task.status !== 'running') return;
    this._close(task);
    task.status = 'paused';
    task.pausedAt = iso(this.now());
    this._changed();
  }

  resume(id) {
    const task = this.get(id);
    if (!task || !['paused', 'unfinished'].includes(task.status)) return;
    this._activate(task);
    this._changed();
  }

  toggle(id) {
    const task = this.get(id);
    if (task?.status === 'running') this.pause(id);
    else this.resume(id);
  }

  finish(id) {
    const task = this.get(id);
    if (!task || !['running', 'paused', 'unfinished'].includes(task.status)) return;
    this._close(task);
    task.status = 'done';
    task.reason = null;
    task.pausedAt = null;
    task.finishedAt = iso(this.now());
    this._log(task);
    if (task.kind === 'break') {
      // Game over: offer to resume the work it interrupted.
      this.state.pendingResume = task.interrupted.filter((tid) => this.get(tid)?.status === 'unfinished');
    }
    this._changed();
  }

  // Card closed without finishing.
  closeCard(id) {
    const task = this.get(id);
    if (!task || !['running', 'paused'].includes(task.status)) return;
    this._unfinish(task, 'closed');
    this._changed();
  }

  discard(id) {
    const task = this.get(id);
    if (!task || task.status !== 'unfinished') return;
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    this.state.pendingResume = this.state.pendingResume.filter((tid) => tid !== id);
    this._changed();
  }

  toggleNap() {
    if (this.state.nap) {
      this._endNap();
    } else {
      const interrupted = this._interruptRunning();
      this.state.nap = { start: iso(this.now()), interrupted: interrupted.map((t) => t.id) };
      this.state.pendingResume = [];
    }
    this._changed();
  }

  resumeAll() {
    const ids = this.state.pendingResume;
    this.state.pendingResume = [];
    for (const id of ids) {
      const task = this.get(id);
      // Break-kind tasks would interrupt the others again, so only work resumes in bulk.
      if (task?.status === 'unfinished' && task.kind === 'work') this._activate(task);
    }
    this._changed();
  }

  dismissResume() {
    this.state.pendingResume = [];
    this._changed();
  }

  setPos(id, pos) {
    const task = this.get(id);
    if (!task) return;
    task.pos = pos;
    this.emit('change', { quiet: true });
  }

  // Periodic housekeeping. Returns true if state changed.
  tick() {
    const now = this.now();
    let changed = false;
    const limit = this.autoUnfinishMin * MIN_MS;
    if (limit > 0) {
      for (const task of this.byStatus('paused')) {
        if (now - Date.parse(task.pausedAt) >= limit) {
          this._unfinish(task, 'paused');
          changed = true;
        }
      }
    }
    const cutoff = startOfDay(now) - DAY_MS;
    const tasks = this.state.tasks.filter((t) => !(t.status === 'done' && Date.parse(t.finishedAt) < cutoff));
    const breaks = this.state.breaks.filter((b) => Date.parse(b.end) >= cutoff);
    if (tasks.length !== this.state.tasks.length || breaks.length !== this.state.breaks.length) {
      this.state.tasks = tasks;
      this.state.breaks = breaks;
      changed = true;
    }
    if (changed) this._changed();
    return changed;
  }

  // ---- view model ------------------------------------------------------------

  snapshot() {
    const now = this.now();
    const today = startOfDay(now);
    const tomorrow = today + DAY_MS;
    const openStart = (seg) => Math.max(Date.parse(seg[0]), today);

    const stats = { done: 0, workMs: 0, workOpen: [], breakMs: 0, breakOpen: [] };
    for (const task of this.state.tasks) {
      const isWork = task.kind === 'work';
      if (isWork && task.status === 'done' && Date.parse(task.finishedAt) >= today) stats.done++;
      for (const seg of task.segments) {
        if (seg[1]) stats[isWork ? 'workMs' : 'breakMs'] += segmentMs(seg, now, today, tomorrow);
        else stats[isWork ? 'workOpen' : 'breakOpen'].push(openStart(seg));
      }
    }
    for (const b of this.state.breaks) stats.breakMs += segmentMs([b.start, b.end], now, today, tomorrow);
    if (this.state.nap) stats.breakOpen.push(openStart([this.state.nap.start, null]));

    const name = (id) => this.get(id)?.name;
    return {
      now,
      stats,
      nap: this.state.nap && {
        since: Date.parse(this.state.nap.start),
        interrupted: this.state.nap.interrupted.map(name).filter(Boolean),
      },
      pendingResume: this.state.pendingResume.map((id) => ({ id, name: name(id) })).filter((t) => t.name),
      tasks: this.byStatus('running', 'paused', 'unfinished').map((t) => {
        const open = t.segments.find((seg) => !seg[1]);
        return {
          id: t.id,
          name: t.name,
          kind: t.kind,
          category: t.category,
          icon: t.icon,
          status: t.status,
          reason: t.reason,
          baseMs: t.segments.filter((seg) => seg[1]).reduce((sum, seg) => sum + segmentMs(seg, now), 0),
          openSince: open ? Date.parse(open[0]) : null,
          pausedSince: t.pausedAt ? Date.parse(t.pausedAt) : null,
        };
      }),
    };
  }

  // ---- internals ---------------------------------------------------------------

  _activate(task) {
    this._endNap();
    if (task.kind === 'break') {
      // A break-kind task interrupts running work exactly like the nap button.
      const interrupted = this._interruptRunning(task.id).map((t) => t.id);
      task.interrupted = [...new Set([...task.interrupted, ...this.state.pendingResume, ...interrupted])];
      this.state.pendingResume = [];
    }
    this.state.pendingResume = this.state.pendingResume.filter((id) => id !== task.id);
    task.segments.push([iso(this.now()), null]);
    task.status = 'running';
    task.reason = null;
    task.pausedAt = null;
  }

  _close(task) {
    const last = task.segments[task.segments.length - 1];
    if (last && !last[1]) last[1] = iso(this.now());
  }

  _unfinish(task, reason) {
    this._close(task);
    task.status = 'unfinished';
    task.reason = reason;
    task.pausedAt = null;
    this._log(task);
  }

  _interruptRunning(exceptId = null) {
    const list = this.byStatus('running').filter((t) => t.id !== exceptId);
    for (const task of list) this._unfinish(task, 'interrupted');
    return list;
  }

  _endNap() {
    const nap = this.state.nap;
    if (!nap) return;
    const entry = { source: 'nap', start: nap.start, end: iso(this.now()), interrupted: nap.interrupted };
    this.state.breaks.push(entry);
    this.state.nap = null;
    this.state.pendingResume = nap.interrupted.filter((id) => this.get(id)?.status === 'unfinished');
    this.emit('log', {
      kind: 'break',
      ...entry,
      interruptedNames: nap.interrupted.map((id) => this.get(id)?.name).filter(Boolean),
    });
  }

  _log(task) {
    this.emit('log', {
      kind: 'task',
      task: structuredClone(task),
      interruptedNames: task.interrupted.map((id) => this.get(id)?.name).filter(Boolean),
    });
  }

  _changed() {
    this.emit('change', { quiet: false });
  }
}

module.exports = { Store, emptyState, totalMs, segmentMs, startOfDay, DAY_MS, MIN_MS };
