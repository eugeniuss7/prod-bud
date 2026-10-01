'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { ObsidianLogger, entryLine, fileName, normalize } = require('../src/main/obsidian');

const MIN = 60 * 1000;

function scenario() {
  let t = new Date(2026, 9, 1, 14, 32).getTime();
  const clock = { now: () => t, advance: (min) => (t += min * MIN) };
  const store = new Store({ now: clock.now });
  const logs = [];
  store.on('log', (ev) => logs.push(ev));
  const a = store.start({ name: 'Wash dishes', category: 'chores' });
  clock.advance(19);
  store.pause(a.id);
  clock.advance(14);
  store.resume(a.id);
  clock.advance(12);
  store.finish(a.id);
  clock.advance(3);
  store.start({ name: 'Study Rust', category: 'study' });
  store.start({ name: 'Other', category: 'x' });
  clock.advance(5);
  store.toggleNap();
  clock.advance(25);
  store.toggleNap();
  return { logs, store, clock };
}

function tmpVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'prodbud-vault-'));
  return { vault, logger: new ObsidianLogger({ vaultPath: vault, logFolder: 'ProdBud' }) };
}

test('day files are named prod_data M-D-YYYY', () => {
  assert.equal(fileName(new Date(2026, 9, 1, 9).getTime()), 'prod_data 10-1-2026.md');
  assert.equal(fileName(new Date(2026, 11, 25, 9).getTime()), 'prod_data 12-25-2026.md');
});

test('entry lines', () => {
  const { logs } = scenario();
  assert.equal(entryLine(normalize(logs[0])), '- 14:32–15:17 · **Wash dishes** · #chores · 31m ✅');
});

test('one file per day: finished work tasks are appended; breaks and unfinished tasks are not', () => {
  const { vault, logger } = tmpVault();
  logger.ensureStatsNote();
  const { logs, store, clock } = scenario();
  store.on('log', (ev) => logger.log(ev));
  for (const ev of logs) logger.log(ev);
  const game = store.start({ name: 'Gaming', kind: 'break', category: 'game' });
  clock.advance(30);
  store.finish(game.id);
  assert.equal(logger.status, 'ok');
  assert.deepEqual(fs.readdirSync(path.join(vault, 'ProdBud')), ['prod_data 10-1-2026.md']);
  const day = fs.readFileSync(path.join(vault, 'ProdBud', 'prod_data 10-1-2026.md'), 'utf8');
  assert.equal(
    day,
    [
      '---',
      'type: prodbud-day',
      'date: 2026-10-01',
      'tasks_done: 1',
      'work_min: 31',
      '---',
      '# ProdBud 10/1/2026',
      '- 14:32–15:17 · **Wash dishes** · #chores · 31m ✅',
      '',
    ].join('\n'),
  );
  assert.ok(fs.existsSync(path.join(vault, 'ProdBud Stats.md')));
});

test('at midnight: leftovers are closed into the old day file, running work continues in the new one', () => {
  const { vault, logger } = tmpVault();
  const { store, clock } = scenario(); // ends 15:50 with Study Rust + Other unfinished
  store.on('log', (ev) => logger.log(ev));
  const late = store.start({ name: 'Late night', category: 'study' }); // 15:50, keeps running
  clock.advance(8 * 60 + 10); // 00:00 next day
  store.tick();
  assert.equal(late.status, 'done');
  const next = store.byStatus('running')[0];
  assert.equal(next.name, 'Late night');
  assert.equal(next.continuedFrom, late.id);
  clock.advance(30);
  store.finish(next.id);

  const dir = path.join(vault, 'ProdBud');
  const day1 = fs.readFileSync(path.join(dir, 'prod_data 10-1-2026.md'), 'utf8');
  assert.match(day1, /- 15:20–15:25 · \*\*Study Rust\*\* · #study · 5m ✅ \(auto-closed at midnight\)/);
  assert.match(day1, /- 15:20–15:25 · \*\*Other\*\* · #x · 5m ✅ \(auto-closed at midnight\)/);
  assert.match(day1, /- 15:50–00:00 · \*\*Late night\*\* · #study · 8h 10m ✅ \(auto-closed at midnight\)/);
  assert.match(day1, /tasks_done: 3\nwork_min: 500\n/);
  const day2 = fs.readFileSync(path.join(dir, 'prod_data 10-2-2026.md'), 'utf8');
  assert.match(day2, /date: 2026-10-02\ntasks_done: 1\nwork_min: 30\n/);
  assert.match(day2, /# ProdBud 10\/2\/2026\n- 00:00–00:30 · \*\*Late night\*\* · #study · 30m ✅\n$/);
});

test('finishing just after midnight, before any tick, still splits by date', () => {
  const { vault, logger } = tmpVault();
  let t = new Date(2026, 9, 1, 23, 30).getTime();
  const store = new Store({ now: () => t });
  store.on('log', (ev) => logger.log(ev));
  const task = store.start({ name: 'Essay', category: 'school' });
  t += 40 * 60 * 1000; // 00:10, no tick happened
  store.finish(task.id); // the original was already split; this finishes nothing
  store.finish(store.byStatus('running')[0].id);
  const dir = path.join(vault, 'ProdBud');
  assert.match(fs.readFileSync(path.join(dir, 'prod_data 10-1-2026.md'), 'utf8'), /- 23:30–00:00 · \*\*Essay\*\* · #school · 30m ✅ \(auto-closed at midnight\)/);
  assert.match(fs.readFileSync(path.join(dir, 'prod_data 10-2-2026.md'), 'utf8'), /- 00:00–00:10 · \*\*Essay\*\* · #school · 10m ✅\n/);
});

test('logging is a no-op without a vault, and reports a missing vault', () => {
  const ev = scenario().logs[0];
  const off = new ObsidianLogger({ vaultPath: '' });
  assert.equal(off.log(ev), null);
  assert.equal(off.status, 'unset');
  const missing = new ObsidianLogger({ vaultPath: '/definitely/not/here' });
  missing.log(ev);
  assert.match(missing.status, /Vault not found/);
});
