# Jig

A black window with lime highlights for working with coding agents on several git repositories at once. Herdr's spaces and
agents lists stand on the left, terminals are cards in the middle, and a side panel on the right shows, one at a time and
switched by a narrow icon bar: the Work panel of the Pi session in focus (its ticket, workflow stages, pull requests, the
files it changed and its recent tool calls), then the changes, commit history, pull requests and checks, worktrees and files
of every repository under the space's folder. There is no status bar: the agents list on the left shows their states. The
window follows, unseen, the colour palette the Jig plugins give Pi.

![Jig](preview.png)

## What you see

Left to right, top to bottom, in a window with no system title bar (`titlebar: none`, `traffic_lights: [12, 16]`):

- **Sidebar, 300 px (44 to 520), background `chrome`,** not resizable. A 46 px brand row (`workspace-chrome`, drags the window), then
  Herdr's `spaces` and `agents` lists sharing the height equally (each at least 90 px), a 0 px block for `jig-theme-sync`
  (it draws nothing), then a 69 px footer
  (`workspace-chrome` with `footer: true`).
- **Work column.** A 42 px tab bar (`jig-tabs`, drags the window): Herdr's tab pills and `+`, then two 26 px buttons with an
  icon and a label, `Panel` (`panel-right` icon) and `Jig` (a set-square icon), on `selected` while lit. Below it, on 8 px
  padding with an 8 px gap: the terminals, and the side panel.
- **Terminals** as cards: radius 10, 8 px gap, 1 px `border`, a 1 px `accent` border on the focused one, and a 30 px header
  (`pane`) always shown. A single terminal is framed too (`lone: true`).
- **Side panel, 420 px (300 to 900),** a row of a stack and a bar. The stack shows one panel: Jig · Work, Changes, History,
  PR & CI, Worktrees or Files. Work is the one shown first.
- **Icon bar, 40 px,** background `chrome`, a 1 px `border` on its left. One 18 px icon for each panel, 40 px square, with a
  2 px `accent` bar on the left of the active one and the `foreground` colour; the others are `dim`. The Jig icon is first,
  with a 1 px `border` line under it. A round badge (15 px, `blocked` or `accent` colour, the count in the window's background colour, `99+` at most)
  sits at the top right of an icon that has a count.
- **Work panel.** On `chrome`. A header: `π` in `accent`, the folder's name, `·`, the model in `muted`, the thinking level,
  and at the right a 7 px dot and `working` (`working`) or `idle` (`idle`, `dim`); a second line in `dim` with `context N% of
  200k`, the cost, the terminal and `N sessions ▾` when several run. Then sections with a 10.5 px semibold `dim` heading:
  `TICKET` (the key in `accent`, the title; the stages as 20 px pills joined by 1 px lines, done ones ticked with an `accent`
  border, the current one filled `accent` with `accent_foreground` text, later ones `dim`), `PULL REQUESTS` (a branch icon,
  `#N`, the title, `open`/`draft`/`merged`, the review state, `✗N` in `ansi1`, `●N` in `working`, `✓N` in `ansi2`; failing
  check names below in `ansi1`), `OUTPUTS` (`A` in `ansi2` or `M` in `blocked`, the name, the folder dimmed, a diff button,
  the time) and `RECENT` (time, tool and action, the decision, the outcome coloured). Rows are 22 to 26 px.
- **Changes panel.** A 42 px header with the folder's name, `N repos · W worktrees · M changed` and a `Refresh` link; a
  filter box; then a row for each repository with changes (name, the folders above it dimmed, a branch chip with an icon, `↑`
  ahead in `foreground`, `↓` behind in `blocked`, a count in a small outlined box), and under it its linked worktrees as
  `↳ <folder>` rows, indented 18 px, each the same way. Under each, the files: a 14 px checkbox (ticked on `accent` when
  staged, `–` when partly), a letter (`M` in `blocked`, `A` and `??` in `ansi2`, `D` and `U` in `ansi1`, `R` in `ansi5`) and the
  path with its folders dimmed; then, when some are staged, a `Commit message` box and a `Commit N` button. Last, a
  `Clean (N)` group, folded.
- **Review tab.** A 280 px list of the repository's changed files on the left, and on the right a 32 px header (path,
  `+added`, `−removed`, `Stage` or `Unstage`, `Discard…`, `‹` `›`) over the diff: 20 px rows, a hunk header row on `surface` in `ansi6`, a 3 px bar at the left
  edge of each changed line, added lines tinted with `ansi2` at 16 % and removed lines with `ansi1` at 22 %.
- **Colours.** The theme `jig-lime`, from the palette: window `#0A0A0A`, bars `#000000`, text `#E4E8DD`, accent `#C4F36B`.
  Fonts and sizes are Herdr's.

## How it behaves

- **Agent states.** Herdr's agents list shows them: `blocked` in amber, `done` in lime, `working` in cyan. The Work panel's
  header says `working` or `idle` for the Pi session it shows.
- **Keys.** `Ctrl+Shift+R` toggles the side panel (`layout.toggle:panel`).
- **Work.** Every 2 seconds while it is on screen, one `sh` on the machine where Pi runs reads the status files the Pi
  extension writes and checks that each Pi still runs. The session shown is the focused terminal's, else the one picked in
  the list, else the one updated last. A click on the ticket key or a pull request opens the browser; on an output, a file
  tab (`file-view`, selected again if open); on its diff button, the `Review` tab. Pull requests are read with `gh` at most
  every 5 minutes per ticket; `Refresh` reads them now. Nothing in the panel approves or changes anything.
- **Panel and Jig.** `Panel` shows or hides the side panel on its last section; `Jig` shows the Work section, and hides the
  panel when it already shows it. The panel's state is remembered per space.
- **Changes.** The repositories under the space's folder (or the one repository, if the folder is inside one) are read by one
  `sh` script on the space's machine: every 5 seconds while the panel is shown, when it is opened, and at once when any
  terminal changes status. A click on a repository's row folds it; the filter keeps repositories whose name matches (with
  all their files) or whose files match. Hovering a row shows `+` (stage all), `−` (unstage all) and a terminal button;
  hovering a file shows `↺`, which asks inline before discarding (`DELETED` for a new file). A checkbox stages or unstages
  its file; the message box commits the staged files. A click on the branch chip opens a 360×440 popup: a search box, local
  branches (current ticked, one in another worktree greyed `in use by <folder>`), origin-only branches, and `New branch…`
  (name box prefilled from `config.json`). A switch is refused while an agent works in the checkout or files are
  uncommitted. A click on a file opens or retargets the tab `Review · <repository>`.
- **History.** A picker of the repositories (inside one repository, no picker), then the commit graph: 28 px rows with lanes
  14 px apart, a dot per commit (a ring for the checked-out one), the author's initials, branch and tag pills, the pull
  request number, the conventional-commit type, the subject and the age. A click opens the message and files under the
  row; a file or `Open diff` opens `git show` in a terminal beside. `Branch` or `All` chooses the scope; `Load more` adds 100.
- **PR & CI.** The `Workspace` tab: each repository on a feature branch with its pull request, its checks (`×` failed, `•`
  pending, `✓` passed, `–` skipped; a cancelled run is skipped) and review state; repositories on a default branch fold
  into a group. The `Mine` tab: your open pull requests by repository. A click opens the pull request or check in the browser.
- **Worktrees.** Linked worktrees of every repository, grouped, newest first, each `Ready to remove` or `In progress`. Ready
  needs: nobody working there, not locked, no uncommitted change, **no commit on no remote (unpushed commits are never ready)**,
  and the work in the base or the remote branch deleted. `Remove` asks twice and runs `git worktree remove` (no `--force`)
  and `git branch -d` (never `-D`).
- **Files.** A tree of the folder, lazily read; folders open in place, a letter marks files with changes, a click opens the
  file in a `file-view` tab (a second click selects it).
- **Review.** Arrow keys and `j` and `k` move between files; `‹` `›` too. The list is read again every 5 seconds while the
  tab is on screen; an unchanged diff keeps its scroll position.
- **Theme follower.** Every 5 seconds it reads Pi's `theme` setting, makes a Herdr theme from that palette and switches to
  it. Nothing shows it: a problem comes as a notification. Dark palettes keep the black window.
- **Badges.** `repo-changes` sets `shared("badge.repo-changes")` to the number of checkouts with changes. The icon bar
  shows a badge for `shared("badge.<mod>")` on the button of that mod.

## Built from

The layout is `layouts/jig.json`, rewritten from Herdr's shipped `main` layout. Nodes, by `id`:

- `root` (row; theme `jig-lime`, `background: canvas`, `terminal_padding: [14, 12]`, 1 px `border` dividers, `preview:
  layouts/jig.svg`)
  - `sidebar` (column, 300 px, min 44, max 520) with `brand`, `sidebar-lists` (`spaces`, `agents`), `jig-theme` (0 px,
    mod `jig-theme-sync`) and `sidebar-footer`
  - `work` (column) with `tabs` (mod `jig-tabs`) and `work-body`
    - `work-body` (row, padding 8, gap 8): `main` (`{ tab: "active", pane: {...} }`) and `panel` (row, 420 px)
    - `panel`: `panel-body` (stack, active `jig-work`) and `activity` (block, 40 px, not resizable;
      mod `jig-activity`, props `{ stack: "panel-body" }`)

Each child of `panel-body` is a block with a `title` and a mod, and its `content.props.activity` holds `{ icon, end? }`:

| id | title | mod | icon |
|---|---|---|---|
| `jig-work` | Jig · Work | `jig-work` | `mods/jig-activity/icons/jig.svg`, `divider: true` |
| `changes` | Changes | `repo-changes` | `mods/workspace-chrome/git-compare.svg` |
| `history` | History | `repo-history` | `mods/workspace-chrome/clock.svg` |
| `pr` | PR & CI | `repo-prs` | `mods/jig-activity/icons/pr.svg` |
| `worktrees` | Worktrees | `repo-worktrees` | `mods/jig-activity/icons/worktree.svg` |
| `files` | Files | `jig-files` | `mods/workspace-chrome/files.svg` |

The mods, all in `mods/`, each with `mod.json` `{ "place": "none", "title": "..." }`:

- **`jig-work`** (props: none; settings in `config.json`: `{ machine, stateDir, prOwners }`). `exec("sh", ["-c", SCRIPT, "sh", stateDir],
  { on })` for the status files, `exec("sh", ...)` for git on the outputs, `exec("gh", ...)` for pull requests, `exec` of the
  browser opener here, `focused()`, `spaces()`, `panes()`, `layout()`, `run("tab.new" | "tab.select")`, `setShared` of
  `file-view.tabs` and `repo-review.open`, `notify`. Files: `main.js`, `lib.js` (the scripts, the parsing, which session).
- **`jig-tabs`** (props `{ panel, stack, jig }`). Herdr's `tabs` mod (Apache-2.0) with the two buttons; `run("layout.select" |
  "layout.show" | "layout.hide")`; icons `mods/jig-tabs/jig.svg`, `mods/workspace-chrome/panel-right.svg`, and Herdr's
  window buttons from `mods/tabs/`.
- **`file-view`** (props `{ on, path }` from `tab.new`). `readTextFile(path, { on })`, `EditorState` and `Editor` from
  `gpui-base`, read-only.
- **`repo-changes`** (props: none, or `{ picker }` as its own popup; settings in `config.json`: `{ newBranchPrefix,
  baseBranch }`). Reads `spaces()`, `panes()`, `focused()`, `terminals()`, `layout()`; runs `exec("sh", ["-c", SCRIPT, "sh",
  root], { on })` with the space's machine, and `exec("git", ..., { cwd, on })` for the actions; `openOverlay({ mod:
  "repo-changes", kind: "popup", props: { picker } })` for the branch picker; `run("tab.new", ...)` for the Review tab and
  terminals; `setShared` for the badge and `repo-changes.done`. `InputState` and `Input` for the filter, the commit messages
  (made in the timer, never in `render`) and the picker. Icons: `mods/workspace-chrome/` `branch`, `check`, `chevron-down`,
  `chevron-right`, `minus`, `plus`, `terminal`. Files: `main.js`, `picker.js`, `lib.js` (the script, the parsing, the
  grouping and the git actions, each taking `exec` and returning `{ ok, message }`), `layout.js`, `config.json`.
- **`repo-review`** (props `{ on, repo, name, file? }` from `tab.new`; read them with `props()`). `exec("git", ...)` and
  `readTextFile` with `{ on }`; `v_virtual_list` and `Scrollbar` from `gpui-base`. Its `lib.js` copies the stage, unstage
  and discard functions of `repo-changes`.
- **`repo-history`** (props: none). `exec("sh", ["-c", SCRIPT, "sh", root], { on })` for the repositories, `exec("git", ...,
  { cwd, on })` for `log`, `status` and `show`, `run("terminal.open", ...)` for a diff. `InputState` and `Input` from
  `gpui-base` for the filter and the picker. Files: `main.js`, `lib.js`.
- **`repo-prs`** (props: none). `exec("sh", ...)` for the repositories, `exec("gh", ...)` for `pr view`, `pr list` and `search
  prs` (four at a time, cached 5 minutes in `localStorage`), `exec` of the browser opener here, `setShared` for the badge.
  Files: `main.js`, `lib.js`.
- **`repo-worktrees`** (props: none). `exec("sh", ...)` for the worktrees, `spaces()`, `panes()` for who is at a checkout,
  `run("space.select" | "tab.new")`, and for Remove only `exec("git", ["worktree", "remove", path])` and `exec("git",
  ["branch", "-d", branch])`. `setShared` for the badge. Files: `main.js`, `lib.js`.
- **`jig-files`** (props: none). Herdr's `files` mod (Apache-2.0, header kept) with `run("tab.new", { mod: "file-view" })`
  instead of an in-panel preview; icons from `mods/workspace-chrome/`. File: `main.js`.
- **`jig-activity`** (props `{ stack }`; a child's `activity` may have `divider: true`). `layout()`, `shared()`, `readTextFile` of `mods/<mod>/mod.json` to see which mods exist,
  `run("layout.select", { stack, child })`. Icons in `mods/jig-activity/icons/`: 24 px viewBox, stroke `currentColor`, 1.5.
- **`jig-theme-sync`** (props: none; settings in `config.json`: `{ machine, agentDir, themeFolders }`). `exec("sh", ...)`
  once for `$HOME` and `$PI_CODING_AGENT_DIR`, `readTextFile(..., { on })`, `writeTextFile` into `themes/`,
  `run("app.theme")`, `notify`. `convert.js` has `toHerdr(vars, appearance)`. Its `render` returns an empty `div()`.

`themes/jig-*.json` are the six palettes of `jig-theme` as Herdr themes: dark ones with `background #0A0A0A`, `canvas` and
`chrome` `#000000`, `surface` and `popover` `#111111`, `border` `#262626`; the terminal colours and `accent`, `selected`,
`working`, `blocked`, `done`, `idle` from the palette. `keys.json` adds the section `layout:jig` with the three keys above.

The layout uses four mods that are not here, the ones Herdr ships: `workspace-chrome`, `spaces`, `agents` and `pane`. The
Work panel needs Jig's Pi plugin `jig-session` loaded in Pi: it writes the status files.

## Watch out

- **Write `mod.json` before `main.js`** for every new mod folder, with `"place": "none"`. Herdr docks a folder it has never
  seen where its `mod.json` says (or a default place without one), which puts a stray copy into the shown layout.
- **A layout node keeps only the fields Herdr knows.** An `icon` or `end` on a stack child is dropped by `layout()`; they live in
  `content.props.activity`, which is kept whole.
- **Never call `cx.notify()` from `render`.** Both polling mods check what changed in a one-second timer and start their work
  from there.
- **Every `exec` and `readTextFile` on project files needs `{ on: machine }`.** Without it the call runs on this computer.
  Tab mods get their props from `props()`; `init`'s argument is empty.
- **Herdr watches folders only on this computer,** so spaces on another machine are polled.
- **A new space may start with the side panel hidden;** it is remembered for each space. Show it with the tab bar's
  `Panel` or `Jig` button, or `Ctrl+Shift+R`.
- **A terminal's address has its machine in front** in the app (`dev-box/t7`), but herdr-core sets only `t7` in the terminal
  (`HC_TERMINAL_ID`). Put the machine in front before comparing with `focused().terminal`.
- **`tab.new` does not give a mod the new tab's id.** Find it as the tab that was not there before, and keep the map in
  `shared("file-view.tabs")` so a second click selects it.
- **A block of 0 px still runs its mod.** Its timers run, so `jig-theme-sync` syncs without taking a line of the sidebar.
- **Pane headers stay `"reveal": "always"`.** On hover the header is drawn over the terminal and hides its prompt line.
- **Poll only while shown.** A mod's timers run while its block is hidden; check `layout()` (no hidden node, every stack on
  the way showing it) before reading.
- **A block whose mod is missing** shows `<mod> did not load` and adds an error to `herdr-app status`; the rest still works.
  `jig-activity` leaves out that panel's button.
- **Mods cannot import each other,** so `lib.js` of `repo-review` is a cut-down copy of `repo-changes`'s, and every panel
  has its own check that its block is on screen.
- **Every git write is a click, with git's own safety.** No `--force`, `-D`, `reset`, `--amend`, `--no-verify` or push;
  file names go with `--literal-pathspecs`; a discard and a branch switch read the checkout again right before.
- **No sign-in.** The mods run `git`, `sh` and `gh` and read files; the one fetch is `git fetch origin <base>` for a new
  branch. `gh` is signed in by you, or the Work
  panel says it is not.

## Done when

- `herdr-app check mods/<name>` passes for each of the eleven mods, and `herdr-app status` shows no `errors` after
  `layout.switch {"name":"jig"}`.
- The sidebar shows Herdr's spaces and agents lists, the terminals are cards, and the right panel shows the icon bar with the
  Changes icon active and a badge equal to the number of checkouts with changes.
- With a space whose folder holds several git repositories, the Changes panel lists all of them, changed ones first, with
  branch and counts; editing a file in one shows it within 5 seconds.
- A linked worktree shows as a `↳` row under its repository. Ticking a file's checkbox stages it within a second, the
  commit box commits it and says the short hash, and the branch chip's popup switches branch; with a file changed, the
  switch is refused and says how many files.
- Clicking a changed file opens a `Review · <repository>` tab with the file's diff, red and lime tinted rows; clicking another
  file of the same repository changes that tab instead of opening a second one.
- The History, PR & CI, Worktrees and Files icons each open their panel: History shows the commit graph of the chosen
  repository, PR & CI lists the pull requests of repositories on a feature branch, Worktrees marks a clean, merged worktree
  `Ready to remove` (and a worktree with an unpushed commit `In progress`), and Files opens a file in a tab.
- Setting `theme` to `jig-signal` in Pi's `settings.json` makes the window take the cyan palette within 5 seconds.
- `Ctrl+Shift+R` hides and shows the side panel, and switching to another layout and back keeps everything working.
- With Pi and the Jig plugins running in a terminal of the window, `/ticket PROJ-123` and a file written by the agent: the
  `Jig` button shows that session's ticket, its stages, the file under `OUTPUTS` and the `write` call under `RECENT`, within
  2 seconds; a click on the file opens it in a tab.
