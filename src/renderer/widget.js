'use strict';

const api = window.prodbud;
const $ = (id) => document.getElementById(id);
let snap = null;
let presetsKey = '';

const REASONS = { interrupted: 'interrupted', paused: 'paused too long', closed: 'closed' };

function renderPresets() {
  const key = JSON.stringify(snap.presets);
  if (key === presetsKey) return;
  presetsKey = key;
  const box = $('presets');
  box.replaceChildren();
  for (const p of snap.presets) {
    const btn = el('button', {
      title: `${p.name}${p.kind === 'break' ? ' (break)' : ''}`,
      'aria-label': `Start ${p.name}`,
      'data-kind': p.kind,
      onclick: () => api.send('preset', { id: p.id }),
    });
    btn.innerHTML = iconFor(p.icon, p.name);
    box.append(btn);
  }
  box.hidden = snap.presets.length === 0;
}

function renderUnfinished() {
  const list = snap.tasks.filter((t) => t.status === 'unfinished');
  $('unfinished-count').textContent = list.length;
  const ul = $('unfinished-list');
  ul.replaceChildren();
  if (!list.length) ul.append(el('li', {}, el('span', { class: 'empty' }, 'Nothing unfinished 🎉')));
  for (const t of list) {
    const play = el('button', { title: 'Resume', onclick: () => api.send('resume', { id: t.id }) });
    play.innerHTML = ICONS.play;
    const drop = el('button', { title: 'Discard', class: 'ghost', onclick: () => api.send('discard', { id: t.id }) });
    drop.innerHTML = ICONS.close;
    const name = el('span', { class: 'name', title: t.name }, t.name);
    name.append(el('span', { class: 'meta' }, `${fmtShort(t.baseMs)} · ${REASONS[t.reason] || t.reason}`));
    ul.append(el('li', { class: t.kind }, name, play, drop));
  }
}

function renderResumeOffer() {
  const pending = snap.pendingResume;
  $('resume-offer').hidden = !pending.length || !!snap.nap;
  if (!pending.length) return;
  const names = pending.map((t) => t.name);
  $('resume-text').textContent =
    names.length === 1 ? `Resume “${names[0]}”?` : `Resume ${names.length} interrupted tasks? (${names.join(', ')})`;
}

function render() {
  renderPresets();
  renderUnfinished();
  renderResumeOffer();

  const napping = !!snap.nap;
  $('nap').classList.toggle('on', napping);
  $('nap').title = napping
    ? `Wake up${snap.nap.interrupted.length ? ` (interrupted: ${snap.nap.interrupted.join(', ')})` : ''}`
    : 'Nap: interrupts all running tasks';
  setMotivator($('nap-char'), 'sleep');

  const warn = $('vault-warn');
  warn.hidden = snap.vault === 'ok';
  warn.title = snap.vault === 'unset' ? 'Obsidian logging is off: set vaultPath in config.yaml' : snap.vault;
  tick();
}

// Live counters, once per second.
function tick() {
  if (!snap) return;
  const now = Date.now();
  const s = snap.stats;
  $('done').textContent = s.done;
  $('duration').textContent = fmtShort(liveMs(s.workMs, s.workOpen, now));
  $('break').textContent = fmtShort(liveMs(s.breakMs, s.breakOpen, now));
  if (snap.nap) {
    const t = fmtClock(now - snap.nap.since);
    $('nap-label').textContent = `Wake ${t.startsWith('00:') ? t.slice(3) : t.slice(0, 5)}`;
  } else {
    $('nap-label').textContent = 'Nap';
  }
}

$('start-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('task-name');
  const name = input.value.trim();
  if (!name) return input.focus();
  api.send('start', { name });
  input.value = '';
});
$('nap').addEventListener('click', () => api.send('nap'));
$('resume-all').addEventListener('click', () => api.send('resumeAll'));
$('resume-later').addEventListener('click', () => api.send('dismissResume'));
$('hide').addEventListener('click', () => api.send('hide'));
$('toggle-list').innerHTML = ICONS.play;
$('toggle-list').addEventListener('click', () => {
  const list = $('unfinished-list');
  list.hidden = !list.hidden;
  $('toggle-list').setAttribute('aria-expanded', String(!list.hidden));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.send('hide');
});

// Size the window to the panel so the list can expand.
new ResizeObserver(() => {
  api.send('resize', { height: $('root').getBoundingClientRect().height + 16 });
}).observe($('root'));

api.onFocusInput(() => $('task-name').focus());
api.onState((s) => {
  snap = s;
  render();
});
api.getState().then((s) => {
  snap = s;
  render();
});
setInterval(tick, 1000);
