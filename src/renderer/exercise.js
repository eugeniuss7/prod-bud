'use strict';

const api = window.prodbud;
const $ = (id) => document.getElementById(id);
const exId = new URLSearchParams(location.search).get('id');

let record = null; // latest payload from main
let editor = null;
let monacoReady = null;
let loadedCode = false; // editor content is set once; after that it's yours
let busy = false;
let saveTimer = null;

const SEVERITY = { bug: 8, design: 4, performance: 4, style: 2 }; // Monaco MarkerSeverity: Error, Warning, Info

// ---- markdown ----------------------------------------------------------------------

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(String(text || '')));
  // Syntax-highlight python code blocks with Monaco's colorizer.
  monacoReady?.then((monaco) => {
    for (const code of el.querySelectorAll('pre code')) {
      const lang = /language-(\w+)/.exec(code.className)?.[1] || 'python';
      monaco.editor.colorize(code.textContent.replace(/\n$/, ''), lang, {}).then((html) => (code.innerHTML = html));
    }
  });
}

// ---- editor ------------------------------------------------------------------------

function isDark() {
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function loadMonaco() {
  monacoReady = new Promise((resolve) => {
    require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], () => resolve(window.monaco));
  });
  monacoReady.then((monaco) => {
    editor = monaco.editor.create($('editor'), {
      language: 'python',
      theme: isDark() ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Cascadia Code", ui-monospace, monospace',
      minimap: { enabled: false },
      tabSize: 4,
      insertSpaces: true,
      rulers: [88],
      scrollBeyondLastLine: false,
      renderWhitespace: 'boundary',
      // You're here to write it yourself: no word-based suggestions.
      wordBasedSuggestions: 'off',
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      parameterHints: { enabled: false },
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
      monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs'),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, submit);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveNow);
    editor.onDidChangeModelContent(() => {
      $('save-state').textContent = 'Unsaved';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 800);
    });
    render();
  });
}

const code = () => (editor ? editor.getValue() : record?.code || '');

function saveNow() {
  clearTimeout(saveTimer);
  if (!record?.exercise) return;
  api.exercise('save', { id: exId, code: code() }).then(() => ($('save-state').textContent = 'Saved'));
}

function markIssues(review) {
  if (!editor) return;
  const markers = (review?.issues || [])
    .filter((i) => i.line > 0 && i.line <= editor.getModel().getLineCount())
    .map((i) => ({
      startLineNumber: i.line,
      endLineNumber: i.line,
      startColumn: 1,
      endColumn: editor.getModel().getLineMaxColumn(i.line),
      severity: SEVERITY[i.severity] || 4,
      message: `${i.severity}: ${i.message}`,
      source: 'Claude review',
    }));
  window.monaco.editor.setModelMarkers(editor.getModel(), 'review', markers);
}

// ---- actions -----------------------------------------------------------------------

function setBusy(on) {
  busy = on;
  for (const id of ['run', 'submit', 'finish', 'reset']) $(id).disabled = on || !record?.exercise || record.status === 'done';
}

async function run() {
  if (busy || !record?.exercise) return;
  setBusy(true);
  $('run-state').textContent = 'Running…';
  $('run-state').className = 'run-state';
  try {
    showRun(await api.exercise('run', { id: exId, code: code() }));
    $('save-state').textContent = 'Saved';
  } catch (err) {
    $('output').textContent = err.message;
  } finally {
    setBusy(false);
  }
}

function showRun(result) {
  if (!result) return;
  $('output').textContent = result.output.trim() || '(no output)';
  $('run-state').textContent = result.passed
    ? `✓ All tests passed · ${result.ms} ms`
    : result.timedOut
      ? '✗ Timed out'
      : `✗ Tests failed (exit ${result.code})`;
  $('run-state').className = `run-state ${result.passed ? 'pass' : 'fail'}`;
}

async function submit() {
  if (busy || !record?.exercise) return;
  setBusy(true);
  selectTab('feedback');
  $('reviewing').hidden = false;
  $('no-feedback').hidden = true;
  setMotivator($('review-char'), 'work');
  try {
    record = await api.exercise('review', { id: exId, code: code() });
    const last = record.runs[record.runs.length - 1];
    showRun(last);
    render();
  } catch (err) {
    $('reviewing').hidden = true;
    $('no-feedback').hidden = false;
    $('no-feedback').textContent = `Review failed: ${cleanError(err)}`;
  } finally {
    $('reviewing').hidden = true;
    setBusy(false);
  }
}

async function finish() {
  if (busy || !record?.exercise) return;
  const reviewed = record.reviews.length > 0;
  if (!reviewed && !confirm("Finish without a review? Claude won't see this one, so it won't shape your next exercise.")) return;
  record = await api.exercise('finish', { id: exId, code: code() });
  render();
}

function reset() {
  if (!editor || !record?.exercise) return;
  if (!confirm('Replace your code with the starter code?')) return;
  editor.setValue(record.exercise.starter_code);
}

// Electron prefixes invoke errors with the channel name; keep only the message.
const cleanError = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- rendering ---------------------------------------------------------------------

function selectTab(name) {
  for (const t of ['task', 'feedback']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
}

function renderOverlay() {
  const overlay = $('overlay');
  const status = record?.status;
  overlay.hidden = status === 'ready' || status === 'done';
  if (overlay.hidden) return;
  const failed = status === 'error';
  setMotivator($('overlay-char'), failed ? 'pause' : 'work');
  $('overlay-title').textContent = failed ? "Couldn't get an exercise from Claude" : 'Claude is writing your next exercise…';
  $('overlay-text').textContent = failed
    ? record.error
    : 'Picked for your level and recent progress. This takes a little while.';
  $('retry').hidden = !failed;
}

function renderTask() {
  const ex = record.exercise;
  if (!ex) return;
  document.title = `${ex.title} · ProdBud`;
  $('title').textContent = ex.title;
  const dots = '●'.repeat(ex.difficulty) + '○'.repeat(Math.max(0, 5 - ex.difficulty));
  $('meta').innerHTML = '';
  $('meta').append(
    el('span', {}, ex.topic),
    el('span', { class: 'dots', title: `Difficulty ${ex.difficulty}/5` }, dots),
    el('span', {}, `~${ex.estimated_minutes} min`),
  );
  $('why').hidden = !ex.why_it_matters;
  $('why').textContent = ex.why_it_matters;
  if ($('instructions').dataset.for !== record.id) {
    $('instructions').dataset.for = record.id;
    renderMarkdown($('instructions'), ex.instructions);
    $('tests').textContent = ex.tests;
    monacoReady?.then((monaco) => monaco.editor.colorize(ex.tests.replace(/\n$/, ''), 'python', {}).then((h) => ($('tests').innerHTML = h)));
  }
  $('hint-list').replaceChildren(...ex.hints.map((h) => el('li', {}, h)));
  $('hint-btn').hidden = ex.hints.length >= ex.hintCount;
  $('hint-btn').textContent = `Show a hint (${ex.hints.length + 1}/${ex.hintCount})`;
  $('packages').hidden = !ex.packages?.length;
  $('packages').textContent = `Needs: ${(ex.packages || []).join(', ')} (pip install ${(ex.packages || []).join(' ')})`;

  if (editor && !loadedCode) {
    loadedCode = true;
    editor.setValue(record.code || ex.starter_code);
    $('save-state').textContent = 'Saved';
    showRun(record.runs[record.runs.length - 1]);
  }
}

function renderTaskState() {
  const st = $('task-state');
  if (record.status === 'done') {
    st.textContent = 'Finished ✓. Pick a new one from the </> button.';
    st.className = 'task-state';
  } else if (!record.task) {
    st.textContent = '';
  } else {
    const paused = record.task.status !== 'running';
    st.textContent = paused ? 'Timer paused. Resume it from the task card.' : 'Timer running';
    st.className = `task-state ${paused ? 'paused' : ''}`;
  }
}

function renderReview() {
  const reviews = record.reviews || [];
  $('feedback-count').hidden = !reviews.length;
  $('feedback-count').textContent = reviews.length;
  $('no-feedback').hidden = reviews.length > 0 || busy;
  const review = reviews[reviews.length - 1];
  $('review').hidden = !review;
  if (!review) return;

  if ($('review').dataset.at !== review.at) {
    $('review').dataset.at = review.at;
    const score = $('score');
    score.textContent = review.score;
    score.className = `score ${review.score >= 8 ? 'good' : review.score >= 5 ? 'mid' : 'low'}`;
    $('verdict').textContent = review.verdict === 'pass' ? 'Pass 🎉' : 'Needs work';
    $('attempt').textContent = `Attempt ${reviews.length} · tests ${review.testsPassed ? 'passed' : 'not passing'}`;
    $('summary').textContent = review.summary;
    $('strengths').replaceChildren(...review.strengths.map((s) => el('li', {}, s)));
    $('issues').replaceChildren(
      ...(review.issues.length ? review.issues : [{ line: 0, severity: 'style', message: 'No issues found.' }]).map((i) => {
        const li = el(
          'li',
          { class: i.line > 0 ? 'clickable' : '', title: i.line > 0 ? 'Jump to line' : '' },
          el('span', { class: `sev ${i.severity}` }, i.severity),
          el('span', {}, i.message, i.line > 0 ? el('span', { class: 'line-ref' }, `  line ${i.line}`) : ''),
        );
        if (i.line > 0) {
          li.addEventListener('click', () => {
            if (!editor) return;
            editor.revealLineInCenter(i.line);
            editor.setPosition({ lineNumber: i.line, column: 1 });
            editor.focus();
          });
        }
        return li;
      }),
    );
    renderMarkdown($('suggestions'), review.suggestions);
    $('concept').textContent = review.concept_to_study;
    markIssues(review);
  }
  $('history').replaceChildren(
    ...(reviews.length > 1
      ? [el('span', {}, 'Earlier attempts: '), ...reviews.slice(0, -1).map((r, i) => el('span', { class: 'chip' }, `#${i + 1} → ${r.score}/10  `))]
      : []),
  );
}

function render() {
  if (!record) return;
  renderOverlay();
  renderTask();
  renderTaskState();
  renderReview();
  setBusy(busy);
}

// ---- wiring ------------------------------------------------------------------------

$('tab-task').addEventListener('click', () => selectTab('task'));
$('tab-feedback').addEventListener('click', () => selectTab('feedback'));
$('run').addEventListener('click', run);
$('submit').addEventListener('click', submit);
$('finish').addEventListener('click', finish);
$('reset').addEventListener('click', reset);
$('hint-btn').addEventListener('click', async () => {
  record = await api.exercise('hint', { id: exId });
  render();
});
$('retry').addEventListener('click', async () => {
  record = await api.exercise('retry', { id: exId });
  render();
});
window.addEventListener('beforeunload', saveNow);

api.onExercise((payload) => {
  if (!payload) return;
  record = payload;
  render();
});
api.exercise('get', { id: exId }).then((payload) => {
  record = payload;
  render();
});
loadMonaco();
