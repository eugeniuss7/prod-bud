'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, totalMs } = require('../src/main/store');

const MIN = 60 * 1000;

function setup(opts = {}) {
  let t = new Date(2026, 8, 29, 14, 32).getTime();
  const clock = { now: () => t, advance: (min) => (t += min * MIN) };
  const store = new Store({ now: clock.now, ...opts });
  const logs = [];
  store.on('log', (ev) => logs.push(ev));
  return { store, clock, logs };
}

test('pauses are excluded and resumes add up', () => {
  const { store, clock, logs } = setup();
  const task = store.start({ name: 'Wash dishes', category: 'chores' });
  clock.advance(19);
  store.pause(task.id);
  clock.advance(14);
  store.resume(task.id);
  clock.advance(12);
  store.finish(task.id);
  assert.equal(task.status, 'done');
  assert.equal(task.segments.length, 2);
  assert.equal(totalMs(task, clock.now()), 31 * MIN);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].task.status, 'done');
  const snap = store.snapshot();
  assert.equal(snap.stats.done, 1);
  assert.equal(snap.stats.workMs, 31 * MIN);
});

test('nap interrupts running tasks, logs a break, and offers resume', () => {
  const { store, clock, logs } = setup();
  const a = store.start({ name: 'Wash dishes' });
  const b = store.start({ name: 'Study Rust' });
  const paused = store.start({ name: 'Paused one' });
  store.pause(paused.id);
  clock.advance(10);
  store.toggleNap();
  assert.equal(a.status, 'unfinished');
  assert.equal(a.reason, 'interrupted');
  assert.equal(b.status, 'unfinished');
  assert.equal(paused.status, 'paused', 'paused cards are left alone');
  assert.equal(logs.length, 2);

  clock.advance(25);
  let snap = store.snapshot();
  assert.equal(snap.stats.breakOpen.length, 1);
  store.toggleNap();
  const brk = logs.at(-1);
  assert.equal(brk.kind, 'break');
  assert.deepEqual(brk.interruptedNames, ['Wash dishes', 'Study Rust']);
  snap = store.snapshot();
  assert.equal(snap.stats.breakMs, 25 * MIN);
  assert.deepEqual(snap.pendingResume.map((t) => t.name), ['Wash dishes', 'Study Rust']);

  store.resumeAll();
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  assert.equal(totalMs(a, clock.now()), 10 * MIN);
});

test('break-kind tasks interrupt work and count toward break time', () => {
  const { store, clock } = setup();
  const work = store.start({ name: 'Laundry' });
  clock.advance(5);
  const game = store.start({ name: 'Gaming', kind: 'break', category: 'game' });
  assert.equal(work.status, 'unfinished');
  assert.deepEqual(game.interrupted, [work.id]);
  clock.advance(45);
  let snap = store.snapshot();
  assert.equal(snap.stats.workMs, 5 * MIN);
  assert.equal(snap.stats.breakOpen.length, 1);
  store.finish(game.id);
  snap = store.snapshot();
  assert.equal(snap.stats.done, 0, 'breaks never count as tasks done');
  assert.equal(snap.stats.breakMs, 45 * MIN);
  assert.deepEqual(snap.pendingResume.map((t) => t.id), [work.id]);
});

test('starting work during a nap wakes up', () => {
  const { store, clock, logs } = setup();
  store.toggleNap();
  clock.advance(3);
  store.start({ name: 'Emails' });
  assert.equal(store.state.nap, null);
  assert.equal(logs.at(-1).kind, 'break');
});

test('paused tasks become unfinished after autoUnfinishMin', () => {
  const { store, clock } = setup({ autoUnfinishMin: 30 });
  const task = store.start({ name: 'Read' });
  store.pause(task.id);
  clock.advance(29);
  assert.equal(store.tick(), false);
  clock.advance(1);
  assert.equal(store.tick(), true);
  assert.equal(task.status, 'unfinished');
  assert.equal(task.reason, 'paused');
});

test('closing a card keeps the task as unfinished; discard removes it', () => {
  const { store } = setup();
  const task = store.start({ name: 'Taxes' });
  store.closeCard(task.id);
  assert.equal(task.status, 'unfinished');
  assert.equal(task.reason, 'closed');
  store.discard(task.id);
  assert.equal(store.get(task.id), undefined);
});

test('state survives a round-trip through JSON (crash recovery)', () => {
  const { store, clock } = setup();
  store.start({ name: 'Long task' });
  clock.advance(20);
  const revived = new Store({ state: JSON.parse(JSON.stringify(store.state)), now: clock.now });
  clock.advance(10);
  const [t] = revived.snapshot().tasks;
  assert.equal(t.status, 'running');
  assert.equal(clock.now() - t.openSince, 30 * MIN);
});

test('rejects empty names', () => {
  const { store } = setup();
  assert.throws(() => store.start({ name: '   ' }));
});
