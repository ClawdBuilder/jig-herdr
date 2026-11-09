# Changelog

## [Unreleased]

### Changed

- The git panels share one 42 px header: one Terminal/Space switch, one refresh icon with a `Refresh · read N ago`
  tooltip, and one error line under the header. History's Branch/All moves to a second row; Repos' summary and PR & CI's
  summary move to body lines so nothing is lost in a 380 px panel.


### Changed

- The public-facing mods now carry the `jig-` prefix: `repo-changes` → `jig-repos`, `repo-history` → `jig-history`,
  `repo-prs` → `jig-prs`, `repo-worktrees` → `jig-worktrees`, `repo-review` → `jig-review`, `keep-awake` →
  `jig-keep-awake`, and `file-view` → `jig-file-view`. Shared-state keys and `config.json` paths follow. The installer
  copies an old mod's `config.json` to the new name (old values win; an existing new file wins; new defaults fill gaps)
  and leaves the old folder in place, because its `config.json` is the person's. Remembered shared state (badges, folds,
  open file tabs) starts fresh under the new keys.

### Added

- A **Keep awake** sun in the tab bar holds this computer awake: off, on until it is switched off or Herdr closes, or while
  any agent is working or blocked (and `idleMinutes`, 5 by default, after the last one). A hidden PowerShell
  (`SetThreadExecutionState`), `caffeinate` or `systemd-inhibit` holds the request, one at a time, on the computer Herdr
  runs on; it ends with Herdr, changes no setting, and a recorded PID is killed only after it verifies as this mod's helper.
  A `Keep screen on` switch in its popup (on by default) writes `mods/jig-keep-awake/config.json` (`display`), which also carries
  `idleMinutes`, and restarts the helper at once; the sun's tooltip says whether the screen is kept on. `Ctrl+Shift+Alt+K`
  cycles the modes.

### Fixed

- Panels now share one command runner, git read flags, error sentences, refresh-config parser and last-good-data rule.
  Every git/gh read runs under `timeout`/`gtimeout` with `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and a Herdr
  deadline five seconds later; History keeps its rows on a failed read. Visible text uses "repo", "folder" and "Reading…".

- The commit-email guard also runs in CI: the workflow passes the private word list as `JIG_SCAN_WORDS_TEXT`, scoped to
  that step. Forks still get no secret and only see warnings for non-public addresses, never a failure.

- Network actions in Repos get the configured `networkTimeoutSeconds` again on Herdr 0.1.14: both wrappers pass Herdr an
  `exec` timeout five seconds past their shell watchdog, with the shell clamped to 595 seconds at the 600-second edge.
  Older Herdr ignores the option and still stops at 30 seconds. Jig-work's CI reads and the worktree scan also carry
  deadlines that leave their own wrappers time to report first.

- Keep awake can start its Windows helper again: the script is installed as `jig-keep-awake.ps1`, and the mod still
  recognises and stops a helper left running under the old `keep-awake.ps1` name. The installer keeps that old script
  while a helper may still be using it.
- The Work, Context, Files and jig-file-view panels read once when their view mounts, so a Herdr session whose mod timers stall
  no longer leaves them on their loading line; Work and Context read again when their panel is shown after being hidden.
  Every command they run has a 20 s deadline, so a hung `sh`/`git`/`gh` cannot hold the loading state. The status check
  compares mtime and size (a same-second write is seen), keeps the old map until the bodies are read, and records the map
  from the pass whose bodies it read. Herdr already caps every command at 30 s; the filter's `find` has a 10 s timeout where
  coreutils `timeout` exists. The Files listing is one function with the runner passed in (the Step 3 build called a view
  method from a module function and could not list a folder), and the mount read counts as the shown read. Files searches once per filter change (500 ms debounce) and per refresh, not every
  tick, and its watcher events go through the debounced scheduler. A first-only busy flag stops a backstop after an error
  from dimming a panel; jig-file-view queues a click during a read, keeps hidden tabs quiet, and fits its Refresh at 300 px.

### Changed

- The Work, Context, Files and jig-file-view panels share the Changes panel's pinned 42 px header, silent background refreshes
  and the `refreshSeconds` backstop (60 s, never under 15). Work and Context read on events and, while the session works,
  check only mtimes every 3 s, reading just the files that moved (the 2 s full read is gone); Files adds a filter, shows
  deleted files greyed, reads on focus and a backstop (no 10 s timer) and watches local folders; jig-file-view fits its header
  at narrow widths, adds a wrap toggle and reads on events (no 5 s timer). Work's Recent rows show the tool and target with
  the decision only when it is not the default, and the session panels have a pinned header, a session picker and
  per-session folds.

- The Changes panel (`jig-repos`) lists the folder of the focused terminal, not the space's, and has a header toggle to
  follow the terminal or the space for each space. Each checkout shows its ahead and behind and its last commit, one line per
  checkout, with worktrees folded under their repo (remembered) and the last commit only under the focused one. It can
  fetch, pull, push or publish its branch; every send asks first in a dialog that names git's real destination
  (`pushRemote`, `push.default`) and lists the commits, never pushes a branch onto a differently named one, and runs one
  action at a time per checkout. `config.json` gains `remote`, `networkTimeoutSeconds` and `rowDetail`.

- Initial split from Jig's `herdr/` folder, with the layout, mods and themes.
- The Context panel reads `contracts/requests.js` and the theme build reads `contracts/palettes.json` from the published Jig
  package, not relative paths into Jig.
- **TODO:** the dev dependency is a local tarball until `@clawdbuilder/jig@0.5.1` is released with the contracts; then pin
  `0.5.1`.
