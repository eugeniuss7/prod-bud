'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { ObsidianLogger, appendUnderHeading, dailyLine, normalize, renderNote } = require('../src/main/obsidian');

const MIN = 60 * 1000;

function scenario() {
  let t = new Date(2026, 8, 29, 14, 32).getTime();
  const store = new Store({ now: () => t });
  const logs = [];
  store.on('log', (ev) => logs.push(ev));
  const a = store.start({ name: 'Wash dishes', category: 'chores' });
  t += 19 * MIN;
  store.pause(a.id);
  t += 14 * MIN;
  store.resume(a.id);
  t += 12 * MIN;
  store.finish(a.id);
  t += 3 * MIN;
  store.start({ name: 'Study Rust', category: 'study' });
  store.start({ name: 'Other', category: 'x' });
  t += 5 * MIN;
  store.toggleNap();
  t += 25 * MIN;
  store.toggleNap();
  return logs;
}

test('renders task and break notes with Dataview frontmatter', () => {
  const logs = scenario();
  const task = normalize(logs[0]);
  const note = renderNote(task);
  assert.match(note, /^---\ntype: task\ntask: Wash dishes\ncategory: chores\ndate: 2026-09-29\nstart: "14:32"\nend: "15:17"\nduration_min: 31\nstatus: done\n/);
  assert.equal(dailyLine(task), '- 14:32–15:17 · **Wash dishes** · #chores · 31m ✅');

  const brk = normalize(logs.at(-1));
  assert.match(renderNote(brk), /type: break\nsource: nap\n/);
  assert.match(renderNote(brk), /interrupted: \["Study Rust","Other"\]/);
  assert.equal(dailyLine(brk), '- 15:25–15:50 · 💤 Break · 25m (interrupted 2 tasks)');

  const interrupted = normalize(logs[1]);
  assert.equal(dailyLine(interrupted), '- 15:20–15:25 · **Study Rust** · #study · 5m ⏸ unfinished (interrupted)');
});

test('appendUnderHeading inserts at the end of the right section', () => {
  const doc = '# Day\n\n## ProdBud Log\n- one\n\n## Journal\ntext\n';
  assert.equal(
    appendUnderHeading(doc, '## ProdBud Log', '- two'),
    '# Day\n\n## ProdBud Log\n- one\n- two\n\n## Journal\ntext\n',
  );
  assert.equal(appendUnderHeading('', '## ProdBud Log', '- a'), '## ProdBud Log\n- a\n');
  assert.equal(appendUnderHeading('notes\n', '## ProdBud Log', '- a'), 'notes\n\n## ProdBud Log\n- a\n');
});

test('writes entry notes, daily note and stats note into the vault', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'prodbud-vault-'));
  const logger = new ObsidianLogger({
    vaultPath: vault,
    logFolder: 'ProdBud',
    dailyNotes: { enabled: true, folder: 'Daily', heading: '## ProdBud Log' },
  });
  logger.ensureStatsNote();
  for (const ev of scenario()) logger.log(ev);
  assert.equal(logger.status, 'ok');
  const files = fs.readdirSync(path.join(vault, 'ProdBud')).sort();
  assert.deepEqual(files, [
    '2026-09-29 1432 Wash dishes.md',
    '2026-09-29 1520 Other.md',
    '2026-09-29 1520 Study Rust.md',
    '2026-09-29 1525 Nap.md',
  ]);
  const daily = fs.readFileSync(path.join(vault, 'Daily', '2026-09-29.md'), 'utf8');
  assert.equal(daily.split('\n').filter((l) => l.startsWith('- ')).length, 4);
  assert.ok(fs.existsSync(path.join(vault, 'ProdBud Stats.md')));
});

test('logging is a no-op without a vault, and reports a missing vault', () => {
  const off = new ObsidianLogger({ vaultPath: '' });
  assert.equal(off.log(scenario()[0]), null);
  assert.equal(off.status, 'unset');
  const missing = new ObsidianLogger({ vaultPath: '/definitely/not/here' });
  missing.log(scenario()[0]);
  assert.match(missing.status, /Vault not found/);
});
