'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Exercises, runPython, buildGeneratePrompt, buildReviewPrompt, PASS_MARKER } = require('../src/main/exercises');
const { parseCliOutput, cliArgs } = require('../src/main/claude');

const PY = process.platform === 'win32' ? 'python' : 'python3';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prodbud-ex-'));

const EXERCISE = {
  title: 'Top-k words',
  topic: 'Counter',
  difficulty: 2,
  estimated_minutes: 25,
  why_it_matters: 'Token counts.',
  instructions: 'Implement top_words.',
  starter_code: 'def top_words(text, k):\n    ...\n',
  tests: `from solution import top_words\nassert top_words("a b a", 1) == [("a", 2)], "basic"\nprint("${PASS_MARKER}")\n`,
  hints: ['one', 'two', 'three'],
  packages: [],
};
const GOOD = 'from collections import Counter\n\ndef top_words(text, k):\n    return Counter(text.split()).most_common(k)\n';

test('runPython reports passing, failing and runaway code', async () => {
  const dir = tmp();
  const pass = await runPython({ dir, code: GOOD, tests: EXERCISE.tests, python: PY });
  assert.equal(pass.passed, true, pass.output);
  const fail = await runPython({ dir, code: 'def top_words(text, k):\n    return []\n', tests: EXERCISE.tests, python: PY });
  assert.equal(fail.passed, false);
  assert.match(fail.output, /AssertionError: basic/);
  const loop = await runPython({ dir, code: 'while True: pass\n', tests: EXERCISE.tests, python: PY, timeoutMs: 500 });
  assert.equal(loop.timedOut, true);
  const missing = await runPython({ dir, code: GOOD, tests: EXERCISE.tests, python: 'no-such-python' });
  assert.match(missing.output, /Python not found/);
});

test('exercise lifecycle: generate, hint, run, review, complete → history', async () => {
  const calls = [];
  const ask = async (prompt, system, schema) => {
    calls.push({ prompt, schema });
    if (prompt.startsWith('Review my solution')) {
      return { score: 9, verdict: 'pass', summary: 'Great', strengths: [], issues: [], suggestions: '', concept_to_study: 'heapq', takeaway: 'Use Counter.' };
    }
    return EXERCISE;
  };
  const ex = new Exercises({ dir: tmp(), ask, getConfig: () => ({ learning: { level: 'intermediate', goal: 'AI engineer' }, python: { command: PY } }) });
  ex.start('ex1');
  assert.equal(ex.get('ex1').status, 'generating');
  const ready = await ex.generate('ex1');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.code, EXERCISE.starter_code);
  assert.match(calls[0].prompt, /first exercise/);

  assert.equal(ex.revealHint('ex1').hintsShown, 1);
  const record = await ex.review('ex1', GOOD);
  assert.equal(record.runs.length, 1, 'review runs the tests first');
  assert.equal(record.reviews[0].testsPassed, true);
  assert.match(calls[1].prompt, /attempt #1/);
  assert.match(calls[1].prompt, /  3\| def top_words/);
  assert.match(calls[1].prompt, /tests PASSED/);

  ex.complete('ex1');
  const [h] = ex.history();
  assert.equal(h.title, 'Top-k words');
  assert.equal(h.score, 9);
  ex.complete('ex1');
  assert.equal(ex.history().length, 1, 'completing twice records once');

  // The next exercise is planned from that history.
  assert.match(buildGeneratePrompt({ level: 'intermediate', goal: 'x', history: ex.history() }), /Top-k words \[Counter, difficulty 2\] score 9\/10 — Use Counter\./);
});

test('generation errors are kept so the window can offer a retry', async () => {
  const ex = new Exercises({ dir: tmp(), ask: async () => { throw new Error('Claude Code is not logged in.'); }, getConfig: () => ({ learning: {}, python: { command: PY } }) });
  ex.start('e');
  const r = await ex.generate('e');
  assert.equal(r.status, 'error');
  assert.match(r.error, /not logged in/);
  assert.equal(ex.start('e').status, 'generating', 'retry resets it');
});

test('review prompt includes the run output when tests fail', () => {
  const p = buildReviewPrompt({ exercise: EXERCISE, code: 'x = 1', run: { code: 1, output: 'AssertionError: basic', passed: false }, attempt: 2 });
  assert.match(p, /attempt #2/);
  assert.match(p, /did not pass/);
  assert.match(p, /AssertionError: basic/);
});

test('Claude CLI output parsing', () => {
  assert.deepEqual(parseCliOutput(JSON.stringify({ is_error: false, structured_output: { a: 1 }, result: '' })), { a: 1 });
  assert.deepEqual(parseCliOutput(JSON.stringify({ is_error: false, result: 'Here:\n{"a": 2}\n' })), { a: 2 });
  assert.throws(() => parseCliOutput(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' })), /run `claude`, and log in/);
  assert.throws(() => parseCliOutput('garbage'), /Unexpected output/);
});

test('CLI args are single-line and disable tools', () => {
  const args = cliArgs({ system: 'line one\n  line two', schema: { type: 'object' }, model: 'opus' });
  assert.ok(args.every((a) => !a.includes('\n')));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(args.slice(-2), ['--model', 'opus']);
});
