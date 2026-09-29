'use strict';

const api = window.prodbud;
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
let task = null;
let nudgeAfterMs = 10 * 60 * 1000;
let done = false;

const CHEERS = ['Nice one!', 'Done! 🎉', 'You did it!', 'Crushed it!'];

$('finish').innerHTML = ICONS.check;
$('close').innerHTML = ICONS.close;

function pose(now) {
  if (done) return 'celebrate';
  if (task.status === 'running') return 'work';
  if (task.pausedSince && now - task.pausedSince >= nudgeAfterMs) return 'nudge';
  return 'pause';
}

function tick() {
  if (!task) return;
  const now = Date.now();
  if (!done) {
    $('timer').textContent = fmtClock(liveMs(task.baseMs, task.openSince ? [task.openSince] : [], now));
  }
  const p = pose(now);
  setMotivator($('char'), p);
  const bubble = $('bubble');
  bubble.hidden = p !== 'nudge' && p !== 'celebrate';
  if (p === 'nudge') bubble.textContent = 'Back to it?';
}

function render(snap) {
  nudgeAfterMs = snap.nudgeAfterMin * 60 * 1000;
  const next = snap.tasks.find((t) => t.id === id);
  if (!next) {
    // Gone from the active list while this card is still open = just finished.
    if (task && !done) {
      done = true;
      $('bubble').textContent = CHEERS[Math.floor(Math.random() * CHEERS.length)];
      $('root').classList.add('done');
    }
    return tick();
  }
  task = next;
  const root = $('root');
  root.classList.toggle('break', task.kind === 'break');
  root.classList.toggle('paused', task.status === 'paused');
  $('name').textContent = task.name;
  $('name').title = task.name;
  document.title = task.name;
  const running = task.status === 'running';
  $('pause').innerHTML = running ? ICONS.pause : ICONS.play;
  $('pause').title = running ? 'Pause' : 'Resume';
  tick();
}

$('finish').addEventListener('click', () => api.send('finish', { id }));
$('pause').addEventListener('click', () => api.send('toggle', { id }));
$('close').addEventListener('click', () => api.send('close', { id }));

api.onState(render);
api.getState().then(render);
setInterval(tick, 1000);
