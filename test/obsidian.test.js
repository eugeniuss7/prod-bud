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
  assert.equal(entryLine(normalize(logs.at(-1))), '- 15:25–15:50 · 💤 Break · 25m (interrupted 2 tasks)');
});

test('one file per day: finished tasks and breaks are appended, unfinished ones are not', () => {
  const { vault, logger } = tmpVault();
  logger.ensureStatsNote();
  const { logs } = scenario();
  for (const ev of logs) logger.log(ev);
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
      'break_min: 25',
      '---',
      '# ProdBud 10/1/2026',
      '- 14:32–15:17 · **Wash dishes** · #chores · 31m ✅',
      '- 15:25–15:50 · 💤 Break · 25m (interrupted 2 tasks)',
      '',
    ].join('\n'),
  );
  assert.ok(fs.existsSync(path.join(vault, 'ProdBud Stats.md')));
});

test('at midnight, unfinished tasks are marked done and logged into the previous day', () => {
  const { vault, logger } = tmpVault();
  const { store, clock } = scenario(); // ends 15:50 with Study Rust + Other unfinished
  store.on('log', (ev) => logger.log(ev));
  const late = store.start({ name: 'Late night', category: 'study' }); // 15:50, keeps running
  clock.advance(8 * 60 + 15); // 00:05 next day
  store.tick();
  assert.equal(late.status, 'done');
  assert.equal(store.get(late.id).segments[0][1], new Date(2026, 9, 2).toISOString());
  const day = fs.readFileSync(path.join(vault, 'ProdBud', 'prod_data 10-1-2026.md'), 'utf8');
  assert.match(day, /- 15:20–15:25 · \*\*Study Rust\*\* · #study · 5m ✅ \(auto-closed at midnight\)/);
  assert.match(day, /- 15:20–15:25 · \*\*Other\*\* · #x · 5m ✅ \(auto-closed at midnight\)/);
  assert.match(day, /- 15:50–00:00 · \*\*Late night\*\* · #study · 8h 10m ✅ \(auto-closed at midnight\)/);
  assert.match(day, /tasks_done: 3/);
  assert.ok(!fs.existsSync(path.join(vault, 'ProdBud', 'prod_data 10-2-2026.md')));
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
