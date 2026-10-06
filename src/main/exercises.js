'use strict';
// Python coding exercises: Claude writes one tailored to your progress, you solve it in the
// built-in editor, run it against its tests locally, then submit it to Claude for a review.
//
// Everything lives in <userData>/exercises/:
//   history.json                 one line per finished exercise (feeds the next exercise's difficulty)
//   <id>/exercise.json           the exercise, your latest code, and every review

const fs = require('fs');
const path = require('path');
const spawn = require('cross-spawn');

const RUN_TIMEOUT_MS = 15 * 1000;
const MAX_OUTPUT = 20 * 1000;
const HISTORY_IN_PROMPT = 15;
const PASS_MARKER = 'ALL TESTS PASSED';

// The path the exercises walk along, from idiomatic Python to AI engineering.
const CURRICULUM = [
  'Idiomatic Python: comprehensions, unpacking, enumerate/zip, f-strings',
  'Functions: default/keyword args, *args/**kwargs, closures, decorators',
  'Data structures: dict/set patterns, collections (Counter, defaultdict, deque), heapq',
  'Iterators and generators: lazy pipelines, itertools, streaming large data',
  'Classes: dataclasses, properties, dunder methods, composition over inheritance',
  'Type hints: typing, Protocol, TypedDict, generics, writing type-checkable code',
  'Errors and robustness: exceptions, custom errors, retries with backoff, validation',
  'Files and data formats: pathlib, JSON/JSONL, CSV, reading datasets in chunks',
  'Testing: pytest-style tests, edge cases, test-driven thinking',
  'Text processing: tokenization, normalization, regex, n-grams',
  'NumPy: arrays, vectorization, broadcasting, avoiding Python loops',
  'Vectors and similarity: dot product, cosine similarity, top-k search from scratch',
  'Data wrangling: grouping, aggregating and cleaning tabular data (pandas-style, stdlib first)',
  'Concurrency: asyncio, gather, semaphores, rate-limiting many API calls',
  'Calling LLM APIs: request/response shapes, retries, streaming, token budgeting (mocked clients)',
  'Prompt engineering in code: templates, few-shot builders, structured output parsing and validation',
  'RAG: chunking documents, embedding index (mocked), retrieval, context assembly',
  'Tool calling and agents: tool schemas, dispatch loop, stopping conditions (mocked model)',
  'Evaluation: metrics (precision/recall, exact match), golden sets, LLM-as-judge harness',
  'ML fundamentals: train/test split, linear/logistic regression and gradient descent with NumPy',
  'Neural nets from scratch: forward/backward pass, a tiny MLP, softmax and cross-entropy',
  'Production habits: logging, config, caching, packaging a small reusable module',
];

const EXERCISE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    topic: { type: 'string' },
    difficulty: { type: 'integer', description: '1 (easy) to 5 (hard)' },
    estimated_minutes: { type: 'integer' },
    why_it_matters: { type: 'string' },
    instructions: { type: 'string' },
    starter_code: { type: 'string' },
    tests: { type: 'string' },
    hints: { type: 'array', items: { type: 'string' } },
    packages: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'topic', 'difficulty', 'estimated_minutes', 'why_it_matters', 'instructions', 'starter_code', 'tests', 'hints', 'packages'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: '0 to 10' },
    verdict: { type: 'string', enum: ['pass', 'needs_work'] },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer', description: 'line number in the listing, or 0 if not tied to a line' },
          severity: { type: 'string', enum: ['bug', 'design', 'style', 'performance'] },
          message: { type: 'string' },
        },
        required: ['line', 'severity', 'message'],
        additionalProperties: false,
      },
    },
    suggestions: { type: 'string' },
    concept_to_study: { type: 'string' },
    takeaway: { type: 'string' },
  },
  required: ['score', 'verdict', 'summary', 'strengths', 'issues', 'suggestions', 'concept_to_study', 'takeaway'],
  additionalProperties: false,
};

const GENERATE_SYSTEM = `You are a senior AI engineer mentoring a developer who is learning to write Python naturally, without AI autocomplete, on the way to becoming an AI engineer. You design one focused, realistic coding exercise at a time and reply only with the requested JSON.`;

const REVIEW_SYSTEM = `You are a senior AI engineer doing a code review for a developer learning to write Python naturally on the way to becoming an AI engineer. Be specific, honest and encouraging, like a good mentor in a pull request review. Reply only with the requested JSON.`;

function buildGeneratePrompt({ level, goal, history }) {
  const recent = history.slice(-HISTORY_IN_PROMPT);
  const past = recent.length
    ? recent
        .map((h) => `- ${h.date} · ${h.title} [${h.topic}, difficulty ${h.difficulty}] score ${h.score ?? 'n/a'}/10 — ${h.takeaway || ''}`)
        .join('\n')
    : '(none yet: this is the first exercise, so make it a gentle placement exercise for the stated level)';
  return `Create the next Python exercise for me.

## Learner
- Level: ${level}
- Goal: ${goal}
- I write the code myself in a plain editor, so the exercise should build real fluency, not trivia.

## Curriculum (roughly in order; revisit weak areas)
${CURRICULUM.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## My recent exercises (oldest first)
${past}

## How to choose
- Pick the topic that best moves me forward: continue where I left off, step back to a weak area if recent scores were low (< 6), or step up difficulty if they were high (≥ 8).
- Do not repeat a recent exercise. Frame it as a small, realistic AI-engineering task when the topic allows (e.g. cleaning a dataset, batching API calls, ranking documents).
- Solvable in 20–45 minutes.

## Fields
- instructions: Markdown. The task, the exact function/class signatures to implement, input/output examples, and constraints. No solution.
- starter_code: The file I start from: imports, signatures with docstrings and \`...\` bodies, and TODO comments. It is saved as solution.py.
- tests: A standalone Python script that does \`from solution import ...\`, checks behaviour (including edge cases) with plain assert statements that have helpful messages, and finally prints exactly "${PASS_MARKER}". No pytest.
- hints: 3 progressive hints, from a gentle nudge to nearly the approach (never the full code).
- packages: non-standard-library packages required (prefer none; numpy only when the topic needs it).
- why_it_matters: one or two sentences on where this shows up in real AI engineering work.`;
}

function buildReviewPrompt({ exercise, code, run, attempt }) {
  const runText = run
    ? `Exit code ${run.code}${run.timedOut ? ' (timed out)' : ''}, tests ${run.passed ? 'PASSED' : 'did not pass'}.\n\`\`\`\n${run.output.slice(-4000)}\n\`\`\``
    : 'I did not run the tests before submitting.';
  return `Review my solution to this exercise. This is attempt #${attempt}.

## Exercise: ${exercise.title} (${exercise.topic}, difficulty ${exercise.difficulty}/5)
${exercise.instructions}

## Tests the solution is checked against
\`\`\`python
${exercise.tests}
\`\`\`

## My solution (solution.py)
\`\`\`python
${numbered(code)}
\`\`\`

## Latest local test run
${runText}

## How to review
- score 0–10: correctness first (does it meet the spec and pass the tests?), then readability and idiomatic Python, then design and efficiency. 8+ means production-ready for its size.
- verdict: "pass" if it is correct and reasonably clean, otherwise "needs_work".
- issues: concrete problems, each with the line number from the listing above (0 if it isn't about one line).
- suggestions: Markdown. Explain how to improve, with small code snippets showing the idea. If the verdict is needs_work, guide me to fix it myself rather than giving the full solution.
- Point out where the code could be more Pythonic, and connect the lesson to AI engineering practice where it fits.
- concept_to_study: one concept worth reading up on next.
- takeaway: one short sentence summarising what I should remember (used to plan my next exercise).`;
}

function numbered(code) {
  return code
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
    .join('\n');
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Run solution.py against the exercise's tests with the local Python.
function runPython({ dir, code, tests, python = 'python', timeoutMs = RUN_TIMEOUT_MS }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'solution.py'), code);
  fs.writeFileSync(path.join(dir, 'test_solution.py'), tests);
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    const append = (d) => {
      if (output.length < MAX_OUTPUT) output += d;
    };
    const child = spawn(python, ['-X', 'utf8', '-u', 'test_solution.py'], {
      cwd: dir,
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timer);
      const msg =
        err.code === 'ENOENT'
          ? `Python not found ("${python}"). Install Python 3 or set python.command in config.yaml (e.g. 'py').`
          : err.message;
      resolve({ code: -1, output: msg, passed: false, timedOut: false, ms: 0, at: new Date().toISOString() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) output += `\n[stopped after ${timeoutMs / 1000}s: infinite loop?]`;
      resolve({
        code,
        output,
        passed: code === 0 && output.includes(PASS_MARKER),
        timedOut,
        ms: Date.now() - started,
        at: new Date().toISOString(),
      });
    });
  });
}

class Exercises {
  constructor({ dir, getConfig, ask }) {
    this.dir = dir;
    this.getConfig = getConfig;
    this.ask = ask; // (prompt, system, schema) => Promise<object>
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(id) {
    return path.join(this.dir, id, 'exercise.json');
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  _save(record) {
    fs.mkdirSync(path.dirname(this._file(record.id)), { recursive: true });
    const tmp = `${this._file(record.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, this._file(record.id));
    return record;
  }

  history() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'history.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  // Creates the record right away (status "generating") so the editor can open while Claude works.
  start(id) {
    const existing = this.get(id);
    if (existing && existing.status !== 'error') return existing;
    return this._save({ id, status: 'generating', createdAt: new Date().toISOString(), exercise: null, code: '', runs: [], reviews: [], hintsShown: 0 });
  }

  async generate(id) {
    const { learning } = this.getConfig();
    const record = this.get(id) || this.start(id);
    try {
      const exercise = await this.ask(buildGeneratePrompt({ ...learning, history: this.history() }), GENERATE_SYSTEM, EXERCISE_SCHEMA);
      Object.assign(record, { status: 'ready', exercise, code: exercise.starter_code, error: null });
    } catch (err) {
      Object.assign(record, { status: 'error', error: err.message });
    }
    return this._save(record);
  }

  saveCode(id, code) {
    const record = this.get(id);
    if (!record) return null;
    record.code = code;
    return this._save(record);
  }

  revealHint(id) {
    const record = this.get(id);
    if (!record?.exercise) return null;
    record.hintsShown = Math.min(record.hintsShown + 1, record.exercise.hints.length);
    return this._save(record);
  }

  async run(id, code) {
    const record = this.saveCode(id, code);
    if (!record?.exercise) throw new Error('Exercise is not ready yet');
    const result = {
      ...(await runPython({
        dir: path.join(this.dir, id, 'workspace'),
        code,
        tests: record.exercise.tests,
        python: this.getConfig().python.command,
      })),
      codeSnapshot: code,
    };
    record.runs = [...record.runs.slice(-9), result];
    this._save(record);
    return result;
  }

  async review(id, code) {
    let record = this.saveCode(id, code);
    if (!record?.exercise) throw new Error('Exercise is not ready yet');
    const lastRun = record.runs[record.runs.length - 1];
    // Re-run if the code changed since the last run, so Claude sees current results.
    const run = lastRun && lastRun.codeSnapshot === code ? lastRun : await this.run(id, code);
    record = this.get(id);
    const review = await this.ask(
      buildReviewPrompt({ exercise: record.exercise, code, run, attempt: record.reviews.length + 1 }),
      REVIEW_SYSTEM,
      REVIEW_SCHEMA,
    );
    record.reviews.push({ ...review, at: new Date().toISOString(), code, testsPassed: run.passed });
    this._save(record);
    return record;
  }

  // Called when the exercise task is finished: records it in history for the next exercise.
  complete(id) {
    const record = this.get(id);
    if (!record?.exercise || record.status === 'done') return record;
    const last = record.reviews[record.reviews.length - 1];
    const history = this.history();
    history.push({
      id,
      date: today(),
      title: record.exercise.title,
      topic: record.exercise.topic,
      difficulty: record.exercise.difficulty,
      score: last ? last.score : null,
      attempts: record.reviews.length,
      takeaway: last ? last.takeaway : 'Not reviewed.',
    });
    fs.writeFileSync(path.join(this.dir, 'history.json'), JSON.stringify(history.slice(-200), null, 2));
    record.status = 'done';
    return this._save(record);
  }
}

module.exports = {
  Exercises,
  runPython,
  buildGeneratePrompt,
  buildReviewPrompt,
  EXERCISE_SCHEMA,
  REVIEW_SCHEMA,
  GENERATE_SYSTEM,
  REVIEW_SYSTEM,
  CURRICULUM,
  PASS_MARKER,
};
