'use strict';
// Shared renderer helpers: time formatting, preset icons and the motivator character.

const pad = (n) => String(n).padStart(2, '0');

// Live total = closed time from main + time since each open segment started.
function liveMs(baseMs, openStarts, now = Date.now()) {
  return openStarts.reduce((sum, start) => sum + Math.max(0, now - start), baseMs);
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function fmtShort(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const m = min % 60;
  return m ? `${Math.floor(min / 60)}h ${m}m` : `${Math.floor(min / 60)}h`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  dish: svg('<ellipse cx="12" cy="13" rx="9" ry="5"/><ellipse cx="12" cy="12.5" rx="4.5" ry="2.2"/><path d="M8 5c0 1 1 1 1 2M12 4c0 1 1 1 1 2M16 5c0 1 1 1 1 2"/>'),
  shirt: svg('<path d="M8 4 4 7l2 3 2-1v11h8V9l2 1 2-3-4-3c-.5 1.5-2 2.5-4 2.5S8.5 5.5 8 4Z"/>'),
  book: svg('<path d="M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1Z"/><path d="M12 6v14"/>'),
  broom: svg('<path d="M15 3 10 12"/><path d="M7 12h6l2 8H5Z"/><path d="M8.5 16 8 20M11 16v4"/>'),
  code: svg('<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'),
  coffee: svg('<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2M8 3v3M12 3v3"/>'),
  dumbbell: svg('<path d="M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12"/>'),
  controller: svg('<path d="M7 8h10a4 4 0 0 1 4 4l.5 4a2 2 0 0 1-3.5 1.5L16 15H8l-2 2.5A2 2 0 0 1 2.5 16L3 12a4 4 0 0 1 4-4Z"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r=".6"/><circle cx="17.5" cy="13.5" r=".6"/>'),
  tv: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m9 2 3 4 3-4M8 21h8"/>'),
  music: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  pause: svg('<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>'),
  play: svg('<path d="M8 5v14l11-7Z"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
};

function iconFor(name, fallbackText = '?') {
  return ICONS[name] || `<span class="letter">${String(fallbackText).trim().charAt(0).toUpperCase()}</span>`;
}

// ---- motivator ------------------------------------------------------------------
// A stick figure (like the sketch) with poses: idle, work, pause, nudge, celebrate, sleep.

const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

const POSES = {
  idle: `<circle cx="30" cy="14" r="7"/>${line(30, 21, 30, 38)}${line(30, 26, 21, 34)}${line(30, 26, 39, 34)}${line(30, 38, 23, 50)}${line(30, 38, 37, 50)}`,
  // flexing, pumped up
  work: `<circle class="head" cx="30" cy="14" r="7"/>${line(30, 21, 30, 38)}
    <path class="arm-l" d="M30 26 L21 28 L20 20"/><path class="arm-r" d="M30 26 L39 28 L40 20"/>
    ${line(30, 38, 23, 50)}${line(30, 38, 37, 50)}`,
  // sitting, arms resting, thinking dots
  pause: `<circle cx="27" cy="20" r="7"/>${line(27, 27, 27, 41)}${line(27, 31, 34, 38)}${line(27, 31, 20, 38)}
    <path d="M27 41 L38 41 L38 51"/><path d="M27 41 L34 44 L34 51"/>${line(14, 51, 46, 51)}
    <g class="dots" stroke="none" fill="currentColor"><circle cx="40" cy="12" r="1.6"/><circle cx="45" cy="9" r="1.6"/><circle cx="50" cy="6" r="1.6"/></g>`,
  // waving at you
  nudge: `<circle cx="30" cy="14" r="7"/>${line(30, 21, 30, 38)}${line(30, 26, 21, 34)}
    <path class="wave" d="M30 26 L39 22 L43 12"/>${line(30, 38, 23, 50)}${line(30, 38, 37, 50)}
    <text x="46" y="10" class="bang" stroke="none" fill="currentColor">!</text>`,
  // arms up, jumping, confetti
  celebrate: `<g class="jump"><circle cx="30" cy="14" r="7"/>${line(30, 21, 30, 38)}${line(30, 26, 20, 16)}${line(30, 26, 40, 16)}
    ${line(30, 38, 22, 48)}${line(30, 38, 38, 48)}</g>
    <g class="confetti" stroke="none"><rect x="8" y="8" width="3" height="3" fill="#e2574c"/><rect x="50" y="6" width="3" height="3" fill="#3a8fd8"/>
    <rect x="12" y="26" width="3" height="3" fill="#f2b632"/><rect x="47" y="24" width="3" height="3" fill="#2f9e6e"/><rect x="30" y="2" width="3" height="3" fill="#b05ad8"/></g>`,
  // lying in bed, snoring
  sleep: `<path d="M6 36 L6 52 M6 44 L54 44 L54 52" class="bed"/><rect x="8" y="32" width="9" height="6" rx="3" class="pillow"/>
    <circle cx="15" cy="30" r="6"/>${line(21, 32, 42, 38)}${line(30, 34, 36, 30)}${line(42, 38, 52, 38)}${line(42, 38, 51, 34)}
    <g class="zzz" stroke="none" fill="currentColor"><text x="30" y="20">z</text><text x="38" y="13">z</text><text x="46" y="7">Z</text></g>`,
};

function motivatorSVG(pose) {
  return `<svg class="motivator m-${pose}" viewBox="0 0 60 56" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Motivator: ${pose}">${POSES[pose] || POSES.idle}</svg>`;
}

// Only re-render the character when its pose changes so animations don't restart.
function setMotivator(container, pose) {
  if (container.dataset.pose === pose) return;
  container.dataset.pose = pose;
  container.innerHTML = motivatorSVG(pose);
}
