# ProdBud — Project Spec

ProdBud is a lightweight desktop productivity overlay: an always-on-top widget plus floating
task cards with timers. Every task and break is logged as Markdown into an Obsidian vault.

## Open decisions (ask before building if still unset)
- Tech stack: Tauri (preferred: small, transparent always-on-top multi-window), Electron, or Python + PySide6
- Target OS
- Obsidian vault path, and whether the user uses daily notes
- Auto-mark a task unfinished after N minutes paused? (suggested: 30)

## UI

### Widget (main panel, docked to a screen corner)
- Title: "Prod Bud"
- Stats row: **Tasks done** (today, work tasks only) | **Duration** (today's total work time)
- Preset icon buttons: one-click start for predefined tasks (chores, games, ...)
- Task name text field + **Start task** button: starts a custom task (kind: work)
- **Nap button** (sleeping motivator character): interrupts everything (see below)
- Bottom row: **Break time** (today) | **Unfinished** count + ▶ button (opens the resume list)

### Task instance card (floating, draggable, one per running task)
- ✔ finish | motivator character | ⏸ pause/resume
- Task name
- Live timer (HH:MM:SS, excluding paused time)
- Motivator reacts to state: working / paused / celebrating on finish

## Presets (config file)
```yaml
presets:
  - { id: dishes,  name: Wash dishes, icon: dish,       kind: work }
  - { id: laundry, name: Laundry,     icon: shirt,      kind: work }
  - { id: game,    name: Gaming,      icon: controller, kind: break }
```
Custom tasks typed into the field default to `kind: work`.

## Behavior

### Task lifecycle
`idle → running ⇄ paused → done`, plus `unfinished` with reason `paused | interrupted | closed`.
Unfinished tasks can be resumed later via ▶, and they keep accumulating time.

Store time as **segments** (start/stop pairs) so pauses are excluded and resumes add up:
```json
{
  "id": "t_20260929_1432",
  "name": "Wash dishes",
  "category": "chores",
  "kind": "work",
  "status": "done",
  "segments": [["14:32","14:51"], ["15:05","15:17"]],
  "duration_min": 31
}
```

### Nap button (interrupt all)
1. Pause every running card and close its open segment
2. Move those tasks to Unfinished with reason `interrupted`
3. Start a break timer (widget character sleeps, Break time counts up)
4. Tap again to wake: end the break, log it, offer "resume all interrupted" or resume one by one via ▶

### Break-kind tasks (e.g. games)
- Time counts toward **Break time**, not Duration; they don't count toward Tasks done
- Still get a floating card with a timer, pause and finish
- Starting one interrupts running work tasks exactly like the nap button

### Break time
Break time today = nap breaks + break-kind task sessions.

## Persistence
- Local state file (JSON or SQLite) is written on every state change, so a crash never loses a running timer
- On startup, recover running and paused tasks from state

## Obsidian logging
Write Markdown directly into the vault (no plugin needed). Log when a task finishes, becomes
unfinished, or a break ends.

### One file per entry in `ProdBud/` (Dataview-friendly frontmatter)
Work task:
```markdown
---
type: task
task: Wash dishes
category: chores
date: 2026-09-29
start: 14:32
end: 15:17
duration_min: 31
status: done
---
```
Break:
```markdown
---
type: break
source: nap        # nap | game
date: 2026-09-29
start: 15:20
end: 15:45
duration_min: 25
interrupted: [Wash dishes, Study Rust]
---
```

### Daily note summary line (appended under `## ProdBud Log`)
```markdown
- 14:32–15:17 · **Wash dishes** · #chores · 31m ✅
- 15:20–15:45 · 💤 Break · 25m (interrupted 2 tasks)
- 16:00–16:45 · 🎮 Gaming · 45m (break)
```

### Example Dataview query
```dataview
TABLE type, category, duration_min, status FROM "ProdBud"
WHERE date = date(today) SORT start ASC
```

## Extras
- Tray icon
- Global hotkey to open the quick-start panel
- Launch on startup

## Build phases
1. **MVP:** widget, one task at a time, start/pause/finish timer, Obsidian logging
2. **Multi-instance:** multiple floating cards, Unfinished list + resume
3. **Nap button + breaks:** interrupt-all, break timer, Break time stat
4. **Presets:** config-driven preset icons with work/break kinds
5. **Motivator:** character sprite states (sleep/work/pause/celebrate), nudge after long pause
6. **Stats:** weekly summaries via Dataview
