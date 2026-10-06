'use strict';
// Loads config.yaml. Lookup order:
//   1. $PRODBUD_CONFIG
//   2. <userData>/config.yaml   (e.g. %APPDATA%\ProdBud\config.yaml on Windows)
//   3. <app folder>/config.yaml (the one in this repo)

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULTS = {
  vaultPath: '',
  logFolder: 'ProdBud',
  autoUnfinishMin: 30,
  nudgeAfterMin: 10,
  hotkey: 'Control+Alt+P',
  claude: { command: 'claude', model: '' },
  python: { command: process.platform === 'win32' ? 'python' : 'python3' },
  learning: {
    level: 'intermediate',
    goal: 'Write Python naturally (without AI autocomplete) and become an AI engineer',
  },
  presets: [],
};

function findConfig(userDataDir, appDir) {
  const candidates = [process.env.PRODBUD_CONFIG, path.join(userDataDir, 'config.yaml'), path.join(appDir, 'config.yaml')];
  return candidates.find((p) => p && fs.existsSync(p)) || path.join(appDir, 'config.yaml');
}

function loadConfig(file) {
  let raw = {};
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    console.error(`[prodbud] Could not read ${file}: ${err.message}`);
  }
  const config = { ...DEFAULTS, ...raw };
  for (const key of ['claude', 'python', 'learning']) config[key] = { ...DEFAULTS[key], ...(raw[key] || {}) };
  config.presets = (Array.isArray(config.presets) ? config.presets : [])
    .filter((p) => p && p.id && p.name)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      icon: p.icon ? String(p.icon) : null,
      kind: p.kind === 'break' ? 'break' : 'work',
      category: String(p.category || (p.kind === 'break' ? 'game' : 'general')),
      action: p.action === 'exercise' ? 'exercise' : null,
    }));
  config.file = file;
  return config;
}

module.exports = { findConfig, loadConfig, DEFAULTS };
