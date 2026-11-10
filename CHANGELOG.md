# Changelog

## [Unreleased]

### Fixed

- Review keeps the branch visible on the row under the context card when the repository chooser is hidden, and splits its
  diff toolbar below 640 px so no action is clipped at side-panel widths or zoom 1.2.


### Changed

- Worktrees and Review use the kit context card and chooser row; a folder/mode switch shows the skeleton, cancels the old
  read and starts the new one at once. Added the strict context-switch test.


### Fixed

- Worktrees and Review now key reads by machine, folder and follow mode: a switch cancels the old read, shows the kit
  skeleton, and starts the new one at once, while a same-context refresh keeps its rows.


### Changed

- Git shows a four-row skeleton while a new machine/folder/follow mode is read, and keeps last-good rows only for a
  same-key refresh. A read that lands for an older context key is discarded.

- Git caches its groups, state split, main lookup and summary once per read/filter mode. Closed rows build no file
  details; the Clean Show/Hide toggle only maps the cached view. A 30-repo render bench drops from ~9.29 ms to ~1.5–1.9 ms
  per render.

- Git lists main checkouts only in Space mode; linked worktrees belong to the Worktrees panel. In Terminal mode a focused
  linked worktree is shown alone with `worktree of <repo>`, so its active branch still works. A refresh of the demo folder
  drops from 96 `git` calls to 58 (six checkouts to four), including four `git worktree list` calls removed.

- Review uses the shared panel kit for its buttons, status line and empty state, with the kit's type scale; its narrow
  two-row toolbar and stacked file list remain.
- The demo repository script now builds richer, deterministic history: ages relative to the run, several authors, fifteen
  orders-api commits with two merged features and a tag, and a clean merged worktree that Worktrees marks ready.
- Added a loose render bench for Worktrees, Review, History, PR & CI and Keep awake, and a gotcha: compute grouping,
  sorting, summaries and closed-row details when data arrives, not in render.


### Fixed

- Review fits a 380 px side panel: the file list keeps its 240 px band when stacked, and below 480 px the diff toolbar
  splits into two rows so counts, copy and stage actions are not clipped.


### Added

- Review comments on selected diff lines, kept per repository and scope and sent as one message to the focused or
  last-focused agent when it is idle; the app never uses `--force` and keeps a failed review.


### Fixed

- PR & CI now awaits its read before clearing the busy state, so Workspace and Mine settle independently; the panel settles
  at once on local-path remotes. PR & CI and History title themselves in the header instead of leaving it empty or showing
  the branch; History keeps its branch in the context card.

- PR & CI no longer asks GitHub about local-path remotes or known non-GitHub hosts: those repositories are parked as
  "no remote". A GraphQL "Could not resolve to a Repository" answer parks as "not on GitHub" instead of the red error line.
- Review in the side panel now follows the focused terminal's repository, offers the Terminal/Space switch in its context
  card and a repository
  chooser, says where to start when no repository exists, and stacks the file list over the diff below 640 px.

- Listing recipes now match the built panels: Review's header is title and Refresh (Copy and Diff/File/Patch are body
  controls), History's title is the chosen branch under its repository chooser, and keep-awake separates its shared
  `jig-keep-awake.helper` key from the `jig-keep-awake.helper.json` file.


### Changed

- PR & CI now uses the kit's segmented Workspace/Mine switch, groups by Needs fixing, Waiting, Ready, No PR and
  No remote/not on GitHub, with two-line PR rows, failing-check details and a footer. History uses Branch/All segmented
  counts, a context card with its repository chooser, and commit details on `raised` with full hash, parents, message
  and changed files. Both recipes describe the kit anatomy.

- A shared `panel-kit.js` now gives Git, Worktrees and Review's side panel one type scale, status dot, buttons, pills, segmented controls,
  group headers, rows, context cards, footer and status line. Git groups checkouts as Needs you, Changed, Ahead or
  behind and Clean; Worktrees groups Ready, In progress and Main checkout. The Terminal/Space switch moves to a context
  card for these two panels. Patterns adapted from runkids/skillshare (MIT); see NOTICE and LICENSE-SKILLSHARE.

- The mod-folder `RECIPE.md` and `preview.png` of `jig-git` and `jig-keep-awake` are no longer installed; the installer
  removes files from earlier versions.
- The root `RECIPE.md` now describes the current Jig layout, including the shared header and the Git and Keep awake recipes.
- Docs use one header/body/error/Refresh vocabulary, current timing budgets and working links, with a test that checks
  every relative Markdown link; the recipes share a byte-identical Header paragraph.
- Listing titles now match what the layout shows: `Files`, `File view` and `Activity bar` for the generic mods;
  `Jig work` and `Jig theme sync` for the Jig-only ones. The package description lists the full panel set.


### Fixed

- The Git and History branch pickers draw local branches first and keep origin-only rows behind the search field, with a
  `Type to search N more on origin` line. Both lists now have their own height and scroll; the Git picker no longer
  collapses to zero rows in its popup.


### Fixed

- When both `repo-changes` and the newer `jig-repos` config exist, `jig-repos` now wins: the installer lists the newest
  old name first, and a `--dry-run` reports the same migrations as a real run.


### Fixed

- The Repos and History branch pickers rank matches (exact, prefix, last path segment, substring) and highlight the row
  Enter will pick; `↑`/`↓` move it, Enter acts only on it, and a dim `↑↓ to choose · Enter to switch` hint appears while a
  row is pickable.


### Changed

- The main git panel is now **Git** everywhere: module id and folder `jig-git`, title **Git**, shared keys
  `badge.jig-git`, `jig-git.done`, `jig-git.folded` and `jig-git.running`, config path
  `mods/jig-git/config.json`, listing `gallery/jig-git`, and the Review references. The installer carries a
  `repo-changes` or `jig-repos` config and any old action binding to `jig-git` once, never overwriting a new file.

- Worktrees' header title is its count (`15 worktrees`, `1 worktree`, `Worktrees` before the first read), with the full
  repo · count in the tooltip. PR & CI puts its tabs in the shared header's lead slot, and folds repositories without a PR
  into one `No PR (N)` group. Biome ignores Herdr's generated `gpui-kit.d.ts` and `jsconfig.json`.

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
