# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

Cinnamon panel applet (GJS, no build step, no dependencies) drawing live CPU, RAM and network charts from `/proc`.

## Commands

| Command | What it does |
|---------|--------------|
| `make test` | `gjs -I applet test/stats-test.js`: the only test file; plain asserts, first failure throws |
| `make install` | symlink `applet/` to `~/.local/share/cinnamon/applets/system-monitor@maryayi.github.io` |
| `make reload` | reload the applet in the running Cinnamon via D-Bus (needed after every code change) |

There is no linter and no test runner, so a "single test" means editing `test/stats-test.js`. Runtime errors from the applet show up in Looking Glass (`Alt+F2`, `lg`) or `~/.xsession-errors`; `applet.js` itself cannot run outside Cinnamon.

## Architecture

- **`applet/stats.js` is pure on purpose.** It holds every `/proc` parser and all the math, with no Cinnamon or GI imports, so it runs under plain `gjs`. It is loaded two ways: `require('./stats')` in `applet.js` (Cinnamon's loader) and `imports.stats` in the test (plain gjs, via `-I applet`). Plain gjs only exports top-level `function` declarations, so new exports must be `function`s, never `const`/`let`/`class`. Put new testable logic here, not in `applet.js`.
- **`applet/applet.js`** is UI only: one `St.DrawingArea` per chart inside an `St.BoxLayout`, painted with Cairo by `drawColumns()` (one 1-px column per sample, newest on the right). A 1 s `GLib.timeout_add_seconds` calls `_tick()`, which reads `/proc`, diffs against `this._last`, appends to `this._history` (capped at `MAX_SAMPLES`), sets the tooltip and repaints. The first tick only stores a baseline. Left-click toggles an `AppletPopupMenu` holding bigger copies of the same draw callbacks (`this._popupAreas`, one labelled item per chart, hidden with its chart's setting) plus Settings/About items. `_tick()` errors are caught and logged so the timer keeps running.
- **Details menus**: hovering a popup chart (`this.menu` `active-changed`) opens a plain `PopupMenu` beside it, kept out of `menuManager` so it stays display-only. While one is open, each tick runs its command (`cat /proc/*/stat`, `ps`, `ss -tinpH`) through `Util.spawnCommandLineAsyncIO`, because reading ~400 `/proc` files synchronously blocks Cinnamon for ~20 ms. The text is parsed by the `stats.js` parsers, diffed with `growthByPid`, and the top `DETAILS_ROWS` go into a monospace label.
- **Network chart** draws upload up from the middle line and download down; each half scales to the max of the visible samples, floored at `NET_MIN_SCALE` (16 KiB/s).
- **Settings**: a new option needs three edits: a key in `applet/settings-schema.json`, a `this._settings.bind(key, '_prop', apply)` in the constructor, and its use in `_applySettings()`. When every chart is off, a fallback `St.Icon` is shown so the applet can still be right-clicked.
- **UUID** `system-monitor@maryayi.github.io` appears in both `Makefile` and `applet/metadata.json`; keep them in sync. `max-instances` is 1.
- Sizes go through `global.ui_scale` (HiDPI). `this.panel` is not set inside the constructor, so it uses the `panelHeight` argument.

## Conventions

- Known limits taken deliberately are marked `// shortcut: <limit>, <when to upgrade>` (e.g. `lo`-only exclusion in `parseNet`, fixed 16 px fallback icon). Keep that format when adding one.
- Test fixtures in `test/stats-test.js` are real `/proc` text captured from the dev machine; add new cases the same way.
