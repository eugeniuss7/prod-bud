'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage, nativeTheme, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store, emptyState } = require('./store');
const { ObsidianLogger } = require('./obsidian');
const { findConfig, loadConfig } = require('./config');
const { Exercises } = require('./exercises');
const { askClaude } = require('./claude');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const WIDGET_WIDTH = 272;
const CARD_SIZE = { width: 224, height: 176 };
const CELEBRATE_MS = 1800;

let config;
let store;
let logger;
let widget;
let tray;
let statePath;
let quitting = false;
let exercises;
const cards = new Map(); // task id -> BrowserWindow
const exerciseWindows = new Map(); // exercise id -> BrowserWindow

// ---- persistence ---------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[prodbud] State unreadable, starting fresh: ${err.message}`);
      try {
        fs.copyFileSync(statePath, `${statePath}.corrupt-${Date.now()}`);
      } catch {}
    }
    return emptyState();
  }
}

// Atomic write so a crash mid-write never loses a running timer.
function saveState() {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store.state, null, 2));
  fs.renameSync(tmp, statePath);
}

// ---- windows -------------------------------------------------------------------

function windowOptions(extra) {
  return {
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...extra,
  };
}

function createWidget() {
  const { workArea } = screen.getPrimaryDisplay();
  const height = 380;
  widget = new BrowserWindow(
    windowOptions({
      width: WIDGET_WIDTH,
      height,
      x: workArea.x + workArea.width - WIDGET_WIDTH - 12,
      y: workArea.y + workArea.height - height - 12,
    }),
  );
  widget.setAlwaysOnTop(true, 'floating');
  widget.loadFile(path.join(RENDERER, 'widget.html'));
  widget.once('ready-to-show', () => widget.show());
  widget.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      widget.hide();
    }
  });
}

function showWidget(focusInput = false) {
  if (!widget) return;
  widget.show();
  widget.focus();
  if (focusInput) widget.webContents.send('focus-input');
}

// Keep the widget's bottom edge anchored when its content grows or shrinks.
function resizeWidget(height) {
  const h = Math.max(120, Math.min(Math.round(height), 900));
  const [x, y] = widget.getPosition();
  const [, oldH] = widget.getSize();
  const { workArea } = screen.getDisplayMatching(widget.getBounds());
  const newY = Math.max(workArea.y, Math.min(y + oldH - h, workArea.y + workArea.height - h));
  widget.setBounds({ x, y: newY, width: WIDGET_WIDTH, height: h });
}

function isOnScreen(pos) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    pos.x >= a.x - 40 && pos.y >= a.y - 20 && pos.x < a.x + a.width - 60 && pos.y < a.y + a.height - 60,
  );
}

function openCard(task) {
  if (cards.has(task.id)) return;
  const { workArea } = screen.getPrimaryDisplay();
  const i = cards.size % 8;
  const pos = task.pos && isOnScreen(task.pos) ? task.pos : { x: workArea.x + 40 + i * 28, y: workArea.y + 40 + i * 28 };
  const win = new BrowserWindow(windowOptions({ ...CARD_SIZE, ...pos }));
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(RENDERER, 'card.html'), { query: { id: task.id } });
  win.once('ready-to-show', () => win.showInactive());
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    store.setPos(task.id, { x, y });
  });
  // Alt+F4 on a card counts as closing it without finishing.
  win.on('close', () => {
    if (!quitting) store.closeCard(task.id);
  });
  win.on('closed', () => cards.delete(task.id));
  cards.set(task.id, win);
}

function syncCards() {
  const active = new Map(store.byStatus('running', 'paused').map((t) => [t.id, t]));
  for (const task of active.values()) openCard(task);
  for (const [id, win] of cards) {
    if (active.has(id) || win.closing) continue;
    win.closing = true;
    // Finished cards celebrate briefly; interrupted/closed ones vanish right away, and so do
    // midnight splits, whose continuation opens a new card in the same spot.
    const task = store.get(id);
    const delay = task?.status === 'done' && task.reason !== 'midnight' ? CELEBRATE_MS : 0;
    setTimeout(() => {
      cards.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }, delay);
  }
}

function snapshot() {
  return {
    ...store.snapshot(),
    presets: config.presets,
    nudgeAfterMin: config.nudgeAfterMin,
    vault: logger.status,
  };
}

function broadcast() {
  const snap = snapshot();
  for (const win of [widget, ...cards.values()]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', snap);
  }
  // Exercise windows show their task's state (running/paused/done).
  for (const exId of exerciseWindows.keys()) sendExercise(exId);
  updateTray(snap);
}

// ---- coding exercises ------------------------------------------------------------------

function exerciseTask(exId) {
  return store.byStatus('running', 'paused', 'unfinished').find((t) => t.exerciseId === exId);
}

// What the exercise window sees: hints only as far as revealed, and its task's state.
function exercisePayload(exId) {
  const record = exercises.get(exId);
  if (!record) return null;
  const task = exerciseTask(exId);
  const exercise = record.exercise && {
    ...record.exercise,
    hints: record.exercise.hints.slice(0, record.hintsShown),
    hintCount: record.exercise.hints.length,
  };
  return { ...record, exercise, task: task ? { id: task.id, status: task.status } : null };
}

function sendExercise(exId) {
  const win = exerciseWindows.get(exId);
  if (win && !win.isDestroyed()) win.webContents.send('exercise', exercisePayload(exId));
}

function openExercise(exId) {
  const existing = exerciseWindows.get(exId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    return existing.focus();
  }
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 520,
    title: 'Python exercise · ProdBud',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1d1b' : '#fffdf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(RENDERER, 'exercise.html'), { query: { id: exId } });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => exerciseWindows.delete(exId));
  exerciseWindows.set(exId, win);
}

async function generateExercise(exId) {
  sendExercise(exId);
  const record = await exercises.generate(exId);
  const task = exerciseTask(exId);
  if (record.status === 'ready' && task) store.update(task.id, { name: record.exercise.title });
  sendExercise(exId);
}

function startExercise(preset) {
  // One exercise at a time: the button brings back the one in progress.
  const current = store.byStatus('running', 'paused', 'unfinished').find((t) => t.exerciseId);
  if (current) {
    if (current.status !== 'running') store.resume(current.id);
    return openExercise(current.exerciseId);
  }
  const exId = `ex_${Date.now().toString(36)}`;
  exercises.start(exId);
  store.start({ name: preset.name, kind: preset.kind, category: preset.category, icon: preset.icon, presetId: preset.id, exerciseId: exId });
  openExercise(exId);
  generateExercise(exId);
}

const exerciseHandlers = {
  'ex:get': ({ id }) => exercisePayload(id),
  'ex:save': ({ id, code }) => {
    exercises.saveCode(id, String(code));
    return true;
  },
  'ex:run': ({ id, code }) => exercises.run(id, String(code)),
  'ex:review': async ({ id, code }) => {
    const record = await exercises.review(id, String(code));
    const task = exerciseTask(id);
    if (task) store.update(task.id, { score: record.reviews[record.reviews.length - 1].score });
    return exercisePayload(id);
  },
  'ex:hint': ({ id }) => {
    exercises.revealHint(id);
    return exercisePayload(id);
  },
  'ex:retry': ({ id }) => {
    exercises.start(id);
    generateExercise(id);
    return exercisePayload(id);
  },
  'ex:finish': ({ id, code }) => {
    exercises.saveCode(id, String(code));
    const task = exerciseTask(id);
    if (task) store.finish(task.id); // the 'log' listener records it in exercise history
    else exercises.complete(id);
    return exercisePayload(id);
  },
};

// ---- commands from renderers ---------------------------------------------------------

function parseTaskName(input) {
  // "Study Rust #study" -> name "Study Rust", category "study"
  const m = String(input).match(/^(.*?)\s+#([\w-]+)\s*$/);
  return m ? { name: m[1], category: m[2] } : { name: String(input), category: 'general' };
}

const commands = {
  start: ({ name }) => store.start({ ...parseTaskName(name), kind: 'work' }),
  preset: ({ id }) => {
    const p = config.presets.find((x) => x.id === id);
    if (!p) return;
    if (p.action === 'exercise') return startExercise(p);
    store.start({ name: p.name, kind: p.kind, category: p.category, icon: p.icon, presetId: p.id });
  },
  openExercise: ({ id }) => {
    const task = store.get(id);
    if (task?.exerciseId) openExercise(task.exerciseId);
  },
  pause: ({ id }) => store.pause(id),
  resume: ({ id }) => store.resume(id),
  toggle: ({ id }) => store.toggle(id),
  finish: ({ id }) => store.finish(id),
  close: ({ id }) => store.closeCard(id),
  discard: ({ id }) => store.discard(id),
  nap: () => store.toggleNap(),
  resumeAll: () => store.resumeAll(),
  dismissResume: () => store.dismissResume(),
  resize: ({ height }, sender) => {
    if (widget && sender === widget.webContents) resizeWidget(height);
  },
  hide: () => widget?.hide(),
};

// ---- tray, hotkey, startup -------------------------------------------------------------

function loginItemOptions(openAtLogin) {
  // Unpackaged (npm start) needs electron.exe pointed at the app folder.
  return app.isPackaged ? { openAtLogin } : { openAtLogin, path: process.execPath, args: [ROOT] };
}

function isLaunchOnStartup() {
  return app.getLoginItemSettings(app.isPackaged ? {} : { path: process.execPath, args: [ROOT] }).openAtLogin;
}

function updateTray(snap = snapshot()) {
  if (!tray) return;
  const running = snap.tasks.filter((t) => t.status === 'running').length;
  tray.setToolTip(snap.nap ? 'ProdBud: napping 💤' : `ProdBud: ${running} running`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show widget', click: () => showWidget() },
      { label: `New task…  (${config.hotkey})`, click: () => showWidget(true) },
      { label: snap.nap ? 'Wake up' : 'Nap (pause everything)', click: () => store.toggleNap() },
      { type: 'separator' },
      { label: 'Open config file', click: () => shell.openPath(config.file) },
      { label: 'Reload config', click: reloadConfig },
      {
        label: 'Open log folder in vault',
        enabled: logger.status === 'ok',
        click: () => {
          fs.mkdirSync(logger.folder, { recursive: true });
          shell.openPath(logger.folder);
        },
      },
      {
        label: 'Launch on startup',
        type: 'checkbox',
        checked: isLaunchOnStartup(),
        enabled: process.platform !== 'linux',
        click: (item) => app.setLoginItemSettings(loginItemOptions(item.checked)),
      },
      { type: 'separator' },
      { label: 'Quit ProdBud', click: () => app.quit() },
    ]),
  );
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!config.hotkey) return;
  try {
    if (!globalShortcut.register(config.hotkey, () => showWidget(true))) {
      console.error(`[prodbud] Hotkey ${config.hotkey} is taken by another app`);
    }
  } catch (err) {
    console.error(`[prodbud] Invalid hotkey ${config.hotkey}: ${err.message}`);
  }
}

// Packaged builds can't edit the bundled config, so seed a user copy on first run.
function configPath() {
  const userCopy = path.join(app.getPath('userData'), 'config.yaml');
  if (app.isPackaged && !fs.existsSync(userCopy)) {
    fs.mkdirSync(path.dirname(userCopy), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'config.yaml'), userCopy);
  }
  return findConfig(app.getPath('userData'), ROOT);
}

function reloadConfig() {
  config = loadConfig(configPath());
  store.autoUnfinishMin = config.autoUnfinishMin;
  logger.setConfig(config);
  logger.ensureStatsNote();
  registerHotkey();
  broadcast();
}

// ---- app lifecycle -------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWidget());
  app.setAppUserModelId('com.prodbud.app');

  app.whenReady().then(() => {
    config = loadConfig(configPath());
    statePath = path.join(app.getPath('userData'), 'state.json');
    store = new Store({ state: loadState(), autoUnfinishMin: config.autoUnfinishMin });
    logger = new ObsidianLogger(config);
    logger.ensureStatsNote();
    const exercisesDir = path.join(app.getPath('userData'), 'exercises');
    exercises = new Exercises({
      dir: exercisesDir,
      getConfig: () => config,
      ask: (prompt, system, schema) =>
        askClaude({ prompt, system, schema, command: config.claude.command, model: config.claude.model, cwd: exercisesDir }),
    });

    store.on('log', (ev) => {
      // A finished exercise (not a midnight split) goes into the exercise history.
      if (ev.kind === 'task' && ev.task.exerciseId && ev.task.status === 'done' && ev.task.reason !== 'midnight') {
        exercises.complete(ev.task.exerciseId);
        setImmediate(() => sendExercise(ev.task.exerciseId));
      }
      logger.log(ev);
      if (logger.status !== 'ok' && logger.status !== 'unset') console.error(`[prodbud] ${logger.status}`);
    });
    store.on('change', ({ quiet }) => {
      saveState();
      if (quiet) return;
      syncCards();
      broadcast();
    });

    ipcMain.handle('state:get', () => snapshot());
    for (const [channel, handler] of Object.entries(exerciseHandlers)) {
      ipcMain.handle(channel, (_e, args = {}) => handler(args));
    }
    ipcMain.on('cmd', (e, { action, ...args } = {}) => {
      const fn = commands[action];
      if (!fn) return;
      try {
        fn(args, e.sender);
      } catch (err) {
        console.error(`[prodbud] ${action} failed: ${err.message}`);
      }
    });

    createWidget();
    store.tick(); // recover: auto-unfinish tasks that sat paused while the app was closed
    syncCards();
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', () => showWidget());
    updateTray();
    registerHotkey();

    // Housekeeping + a periodic refresh, plus a tick right at midnight for the day rollover.
    const tick = () => {
      if (!store.tick()) broadcast();
    };
    setInterval(tick, 30 * 1000);
    const scheduleMidnight = () => {
      const next = new Date();
      next.setHours(24, 0, 1, 0);
      setTimeout(() => {
        tick();
        scheduleMidnight();
      }, next - Date.now());
    };
    scheduleMidnight();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (store) saveState();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Tray app: closing windows never quits.
  app.on('window-all-closed', () => {});
}
