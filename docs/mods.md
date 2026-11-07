# Mods

What each mod in `herdr/mods/` shows, what it reads and runs, and the props it takes, then how the `jig` layout is put
together. Back to the [Herdr app overview](../README.md); [How it works](how-it-works.md) explains a mod and the link to
the agent's machine first.

All of them are trusted code that runs inside the Herdr app, so this page says what each reaches. `jig-work` and `repo-prs`
reach the network through `gh`, and a new branch in `repo-changes` runs `git fetch`, on the machine where the folders are.
Three mods write with git: `repo-changes` and `repo-review` with [the git actions](#the-git-actions), and `repo-worktrees`
with its `Remove`. Each is a `main.js` with the helper files named below; the pure parts are in `lib.js` files, which the
tests load.

## jig-work: the Work panel

The Pi session in focus, from the status files the `jig-session` Pi plugin writes ([the format](../../plugins/jig-session/README.md#the-status-file)). A header with the folder's
name, the model, the thinking level and `working` or `idle`, then the context and cost; a `N sessions` list to pick another
when several run. Then four sections:

- **Ticket:** the key (opens the Jira page when one is known) and title, and the workflow's stages as a line, the current one
  filled with the accent colour, the ones before it ticked.
- **Pull requests:** the ones the workflow observed; with none, what `gh search prs <KEY>` finds in the `prOwners` of
  `config.json`, else among the pull requests that involve you (never all of GitHub). For up to four, `gh pr view`
  adds the review state and the checks. Failing ones first, with the names of their failing checks. A click opens it.
- **Outputs:** the files the session created (`A`) or changed (`M`) outside any git repository, such as ticket notes, plans
  and reports, newest first (`No ticket files yet` when none). A click opens a `file-view` tab, or selects the one already
  open. Files inside repositories are not listed: under the list a dim line, `N files changed in repositories → Changes`,
  shows the side panel on the Changes section. The status file's `repo` field says which is which; a session of an older
  `jig-session` has none, so all its outputs are listed, with the diff button on those that have changes in a repository.
- **Recent:** the last 15 tool calls: time, tool and action, jig-core's decision (`allowed`, `asked · allowed`, `denied`) and
  the outcome (`ok`, `error`, `blocked`, `running`).

- **Which session:** the one whose terminal is focused (`focused().terminal`, `<machine>/t7` on another machine), or the agent
  shown; else the one picked; else the one updated last. A Pi whose process ended is never shown.
- **What it runs:** on the machine (config `machine`, else the shown space's machine), one `sh` script every 2 seconds while the
  panel is on screen, reading `<state folder>/sessions/*.json` and checking each `pid` with `kill -0`. For listed outputs of an older status file, one
  `git rev-parse` and `git status` script when the list changes and every 30 seconds. For pull requests, `gh`, cached 5
  minutes per ticket in the mod's `localStorage`; `Refresh` asks again.
- **Opens:** links with this computer's browser (`explorer.exe`, `open` or `xdg-open`); files with `tab.new` and `file-view`;
  diffs with `tab.new` and `repo-review`. A missing `file-view` gives a notification; a missing `repo-review` hides the button.
- **Sets** `shared("file-view.tabs")`, the map of `<machine>|<path>` to the tab that shows it, so a second click selects it.
- **Props:** none. Settings in `config.json`: `{ machine, stateDir, prOwners }`.

## jig-context: the Context panel

What fills the context of the Pi session in focus, like a coding agent's context view, from the same status files
([how it is counted](../../plugins/jig-session/docs/context.md)). The session is chosen as in Work: the focused terminal's,
else the one updated last.

- **The bar:** `62% used · 124k / 200k`, one bar split by share of the window, and a legend with a coloured square, the
  tokens and the percentage of each part: Messages, Tools, System prompt, Skills, Context files, Compaction buffer, Free
  space. Counted parts carry `≈` (characters / 4).
- **The lists,** folded until clicked, remembered in the mod's `localStorage`: `TOOLS N of M on` and `SKILLS N`, each row
  with its size and a switch; `CONTEXT FILES N` with each file's size, read only. A skill Pi never lists says `command only`.
- **Switches and Reload** write one request file next to the session's status file
  ([the contract](../../plugins/jig-session/README.md#requests)), with one `sh` on the machine:
  `printf %s "$2" > "$1.tmp" && mv "$1.tmp" "$1"`, the path and the JSON as arguments. A request carries every switch not
  answered yet. The answer (`lastRequest`) shows under the legend; a switch is drawn dimmed until it comes.
- **What it never does:** approve a call, change jig-core's rules, or write anything else. A tool switched on is declared to
  the model; jig-core still decides each call.
- **What it runs:** the Work panel's script every 2 seconds while the panel is on screen, on the Work panel's `machine`,
  reading its `stateDir` (`mods/jig-work/config.json`).
- **Props:** none. **Files:** `main.js`, `lib.js` (a copy of Work's session finding, the bar, the request).

## jig-tabs: the tab bar

Herdr's shipped `tabs` mod (Apache-2.0; the file says so at its top), with the Files and Changes buttons replaced by two:

- **`Panel`** shows or hides the side panel (`layout.show` or `layout.hide` on `panel`); the stack keeps its last section.
- **`Jig`** selects the `jig-work` child of `panel-body` and shows the panel; a second click hides it. Lit while it shows.
- **Props:** `{ panel, stack, jig }`, the ids of the panel row, its stack and the Jig child; default `panel`, `panel-body`,
  `jig-work`. The side panel is remembered per space, as in Herdr's bar.
- **The sun** at its right is [Keep awake](#keep-awake-the-keep-awake-control): lit while the computer is held awake, a
  click turns it on or off, a right-click opens its three modes.

## keep-awake: the Keep awake control

A sun in the tab bar that keeps the computer Herdr runs on from going to sleep on its idle timer, like a presentation mode:
for a long build, or an agent working overnight. The request is held by a small helper process; nothing about the power
plan, the registry or the display is changed, and it needs no administrator right.

- **Off** (the default), **On** (until switched off or Herdr closes), and **While agents work** (on while any agent in any
  space, tab or machine is `working` or `blocked`, and `idleMinutes` after the last one stops). A click on the sun turns
  Off ↔ On; a right-click opens a popup with the three modes, `Keep screen on` (on by default), what is held now, and what it
  cannot do. `Ctrl+Shift+Alt+K` cycles the modes; the sun's tooltip says whether the screen is kept on too.
- **Every machine counts**: "While agents work" holds for agents in any space, tab or machine, and `blocked` ones (a
  permission question) count as busy, so one blocked agent anywhere keeps the computer awake.
- **The screen is kept on** by default (`display: true`), not only the system; the popup's switch writes `config.json` and
  restarts a running helper at once with the new flag, so the screen follows without waiting for it to die. A closed lid or
  the power button still sleeps the computer; the popup says so.
- **One helper, never two.** Its PID is in `shared("keep-awake.helper")`, and a claim in `keep-awake.helper.json` in the app
  folder lets only one worker start one (two Herdr windows share that folder). A second copy, a reload or a restart reuses
  it while it is alive and its command line is ours — the PowerShell with `-Owner <herdr pid>`, `caffeinate -w <herdr pid>`,
  or the `systemd-inhibit` line whose `--why` is ours — and starts a new one otherwise.
- **A recorded PID is verified before every kill.** If the record is gone, cannot be checked, or its PID now belongs to
  another process, the record is dropped without touching anything; `taskkill` runs without `/T`, because the helper has no
  tree of its own. A copy loaded by `herdr-app check` has no window or layout and does nothing at all; only the copy that
  started a helper releases it when Herdr quits; otherwise the owner check ends it within about 5 seconds. The helper's
  stop file, `keep-awake.stop` in the app folder, names the start that wrote it (`stop <token>`), so an old stop cannot end
  a new helper.
- **It ends when Herdr does.** The helper checks its stop file and Herdr's own process every 5 seconds; on close the mod
  only writes `stop` (fast), so the helper is gone within about 5 seconds, and a crash cannot leave a computer awake for ever.
  A started helper whose liveness cannot be read keeps its record and is retried, and every command the worker runs has a
  deadline, so a step cannot stay stuck after a restart. Its request is tied to its own
  lifetime, so nothing can outlive it.
- **What it runs, on Herdr's computer** (`exec` without `on`, never on a space's machine):
  - **Windows:** a hidden, detached PowerShell (`Start-Process -WindowStyle Hidden`, every argument quoted for the child)
    running `keep-awake.ps1`, which calls
    `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED])`, repeats it every 5 seconds, and
    exits when its owner is gone, is no longer `herdr-app`, or the stop file names its own start.
  - **macOS:** `caffeinate -i [-d] -w <herdr pid>`, in the background.
  - **Linux:** `systemd-inhibit --what=sleep[:idle] --why="Herdr keep awake" --mode=block sh -c 'while kill -0 <herdr pid>;
    do sleep 20; done' keep-awake`, in the background: the helper watches Herdr itself, so it cannot outlive it, and its
    command line carries the marker and owner the mod recognises.
- **Shared state:** `shared("keep-awake.mode")` (`"off"`, `"on"` or `"agents"`), `shared("keep-awake.display")` (the screen
  setting for this session), `shared("keep-awake.active")` (whether the request is held now) and
  `shared("keep-awake.helper")` (`{ pid, owner, at }`), so the tab bar, other layouts and the key all drive the same worker.
- **Props:** none for the worker; `{ menu: true }` draws the mode popup. **Files:** `main.js`, `lib.js` (the mode decision
  and idle timer, the commands for each platform, the PID bookkeeping and `config.json`), `keep-awake.ps1`,
  `keep-awake.svg`, `config.json`. The Windows helper also checks that its owner process is still `herdr-app`, so a reused
  PID cannot keep the computer awake. **Settings:** `idleMinutes` (5 by default; 0 stops as soon as the last agent does) and
  `display` (true by default: keep the screen on too; a hand edit made while Herdr was closed wins at the next start).

## file-view: a file in a tab

A read-only view of one file with syntax colours, a line count, `Copy path` and `Refresh`. Its props come from `tab.new`:
`{ on, path }`. It reads the file with `readTextFile` (`on` for another machine) when the tab comes into view and every 5
seconds while shown; a binary or missing file says so.

A Markdown file (`.md`, `.markdown`, `.mdx`) opens rendered: headings, lists, tables, code blocks and links. `Source` in
the header shows its text with syntax colours, and `Preview` goes back.

## repo-changes: the Changes panel

Every git checkout under the space's folder, changed ones first, then a `Clean (N)` group; a filter box matches checkout
names and file paths. A click on a file opens it in a `Review` tab. A checkout with commits its base branch lacks, such as a
ticket branch with its work committed, shows a `3 commits vs develop` chip; a click on the chip, or on the row of a checkout
with no uncommitted file, opens `Review` on the whole branch. The branch chip, the file checkboxes and the buttons that
appear on hover run [the git actions](#the-git-actions).

- **Worktrees nest.** Checkouts are grouped by their git common folder: a main checkout shows its linked worktrees under it
  as `↳ <folder>` rows, each with its own branch, ahead and behind, and files. A worktree whose main checkout is not listed
  stands as a row of its own. A main checkout that is clean, with every worktree clean, folds into `Clean (N)`.
- **The base branch:** the closest of `origin/develop`, origin's HEAD branch, `origin/main`, `origin/master`, `develop`,
  `main` and `master` that exist: the one with the fewest commits after `git merge-base <base> HEAD` (`develop` first, then the order above, on a
  tie), so work that landed on the base later is not counted and a branch cut from `develop` is not measured against an older
  `master`. A local branch equal to its `origin/` twin counts once. A checkout on `develop`, `main`, `master` or origin's HEAD
  branch has no chip. No fetch: it uses the refs the clone has.
- **Where it looks:** the space's folder on the space's machine. Inside a repository, only that checkout, and its linked
  worktrees when it is the main one. Otherwise folders with a `.git` up to three levels down, so
  `worktrees/PROJ-123/orders-api` is found, plus the linked worktrees of every main checkout found; `node_modules` is skipped.
- **What it runs:** one `sh -c` script on that machine (`exec` with `on`), reading each checkout's `git status` with no
  locks and no fsmonitor, 8 at a time, at most 200 files each, and `git worktree list` of each main checkout.
- **When:** every 5 seconds while the panel is on screen, when you open it, when an agent or terminal changes state, and at
  once after an action.
- **Sets** `shared("badge.repo-changes")`: the number of checkouts (main or worktree) with changes, each counted once; and
  `shared("repo-changes.done")` after a branch switch, so the panel says so and reads again.
- **Files:** `main.js` (the panel), `picker.js` (the branch picker), `lib.js` (the script, the parsing, the grouping and the
  git actions), `layout.js`, `config.json`.

### The git actions

Each action is a function in `lib.js` that takes `exec(cmd, args, { cwd })` and returns `{ ok, message }`; the panel passes
Herdr's `exec` with the space's machine. A result shows under its checkout for 12 seconds, and the list is read again at once.
None of them uses `--force`, `-D`, `reset`, `--discard-changes`, `--amend`, `--no-verify` or `push`. File names are passed with
`--literal-pathspecs`, so a file called `*.ts` means that file only.

| Action | Where | Git command |
|---|---|---|
| Switch branch | The branch chip opens a picker | `git switch <branch>` |
| Switch to a branch only origin has | Picker, under `ON ORIGIN ONLY` | `git switch --track origin/<branch>` |
| New branch | Picker, `New branch…` | `git fetch origin <base>`, then `git switch --no-track -c <name> origin/<base>` |
| Stage a file | Its checkbox | `git add -- <file>` |
| Unstage a file | Its ticked checkbox | `git restore --staged -- <file>`; before the first commit `git rm --cached -- <file>` |
| Stage all, unstage all | `+` and `−` on the checkout's row | `git add -A`; `git restore --staged -- .` (or `git rm -r --cached -- .`) |
| Discard a tracked file | `↺` on the file, then `Discard` | `git restore --worktree --staged -- <file>` |
| Delete an untracked file | `↺` on the file, then `Delete file` | `git clean -f -- <file>` |
| Commit | Message box under a checkout with staged files | `git commit -m <message>` |

A checkbox is ticked when the file is staged (`X` of porcelain's `XY`), shows `–` when only part of it is, and is empty
otherwise. `--no-track` keeps a new branch from pushing to its base by mistake; it gets its own upstream on its first push.

**The picker** is a popup of the same mod (`openOverlay` with `props.picker`). It has a search box, the local branches with
the current one ticked, a branch checked out in another worktree greyed `in use by <folder>` and not pickable, then origin's
branches that have no local branch. A refusal or git's error shows in the popup; a switch closes it.

**Refusals.** Each is checked right before the command, and a refused action runs no git write:

- **A switch or a new branch** is refused while an agent is `working` or `blocked` in a pane whose folder is inside that
  checkout (a worktree nested inside it is its own), and while the checkout has uncommitted changes, naming how many files.
  It is also refused for a branch another worktree has, the current branch, and a branch neither here nor on origin.
- **A new branch** is refused for a name `git check-ref-format --branch` rejects, or one that starts with `-` or `+`, holds
  `@{` or is `HEAD`; for a branch that exists already; when the fetch fails; and when origin has no such base.
- **A discard** reads the file's status again first. It is refused for a folder, a path that is not one changed file, and
  a file that changed since the confirm (the confirm says `DELETED` for an untracked or newly added file). There is no
  "discard all".
- **A commit** is refused with an empty message or nothing staged. It commits staged files only, runs the hooks, and says
  the short hash or git's first line of error.

**Settings** in `config.json` next to the mod, yours to edit (the install script never replaces it):

| Field | Default | Meaning |
|---|---|---|
| `newBranchPrefix` | `"feature/"` | What the new branch's name box starts with |
| `baseBranch` | `null`: origin's HEAD branch, else `main` or `master` on origin, else `main` | The branch a new branch starts from |

## repo-review: the Review tab

One repository's changed files on the left and the diff of the chosen file on the right, with added and removed lines
tinted and marked at the edge. The `j`, `k` and arrow keys step through files. It opens as a tab, so its props come from
`tab.new`: `{ on, repo, name, file?, mode? }` (the machine, the absolute path, a title, the file to show first and `"working"`
or `"branch"`, working by default).

It runs `git status` and `git diff HEAD` in the repository, and reads an untracked file to show it whole. Re-listing is
every 5 seconds while the tab is shown. A second click on a file of the same repository retargets the open tab; its
shared message `repo-review.open` is `{ repo, file, mode?, at }`, and one without `mode` means working changes.

In **branch mode** the tab shows `git diff <merge base>`: the commits ahead of the base branch plus anything uncommitted, with
untracked files added. The sidebar says `<branch> vs <base>`, the commit count and the latest commits, and the files carry
`A`, `M` or `D` from `git diff --name-status`. It is read-only: no stage, unstage or discard. When a checkout has both working
changes and commits, a switch at the top of the sidebar, `Working changes` and `Branch vs <base>`, changes between them; the
one that was clicked shows first.

**Width.** The divider between the file list and the diff drags (160 to 720 px, 280 by default). The width is kept in the
mod's `localStorage`, so a new Review tab and a restart open at it.

**Views.** A switch in the diff header, `Diff | File | Patch`, picks what the right side shows, and the choice is kept in the
mod's `localStorage` (every Review tab, and a restart). `Diff` is the tinted rows below. `File` is the file's current text
(a deleted file's last version) and `Patch` the diff's text, each in a read-only code editor with line numbers and syntax
colours (`Patch` as `diff`), where the mouse drags a selection and `Ctrl+C` copies it. Text over 400,000 characters is cut
with a note. Switching file or view releases the old editor. Arrow keys and `j`/`k` step through files until the editor is clicked.

**Copying code in Diff.** The rows are not text the mouse can select (use `File` or `Patch` for that), so lines are picked by clicking:

- **Select:** click a code line to select it, shift-click another to extend the range (a click takes the keyboard first so Shift is seen), click the only selected line again or
  press `Escape` to clear. Hunk headers cannot be selected. The selection is tinted blue (the theme's ANSI blue), so it never reads as an added or deleted line.
- **Copy:** `Ctrl+C`, or `Copy N lines` in the header while a selection exists. The text is the code alone, with no `+` or `-`
  marker and no line number, joined by newlines. Context and added lines are the new side of the file, so a range that mixes
  them with deleted lines leaves the deleted ones out; a range of only deleted lines copies those.
- **Copy file:** the file's whole current text from disk, in branch mode too; a deleted file copies its last version
  (`git show HEAD:<path>`, or from the merge base in branch mode). A binary or very large file is refused.
- **Copy path:** the repository-relative path. Each copy shows `Copied ...` under the header for two seconds.

The diff's header has `Stage` or `Unstage` and `Discard…` for the shown file, with the same commands, confirm and refusals as
[the git actions](#the-git-actions). Its `lib.js` holds a copy of those three functions, since mods cannot import each other;
a test runs both copies.

## repo-history: the History panel

A picker of the repositories under the space's folder and the commit graph of the chosen one, with lanes, branch and tag
labels, the author's initials and the age. A click on a commit opens its message and files; a file, or `Open diff`, shows the
diff in a terminal beside (`terminal.open` with `git show`). A filter box matches message, author, hash and branch names.
When it matches no commit and the space has several repositories, the empty list also offers `Look in another repo`: the
repositories and worktrees whose folder name or branch holds the typed text, such as a ticket number. A click shows that one.

- **Where it looks:** the space's folder on the space's machine; inside a repository, only that one. Otherwise folders with a
  `.git` up to three levels down, skipping `node_modules`. The picker lists them with their branch and a dot for uncommitted
  changes, and the choice is remembered per folder in the mod's `localStorage`.
- **What it runs:** one `sh -c` script every 60 seconds for the repository list; `git log` (100 commits at a time, `Load
  more` for the next page, `Branch` or `All` for the scope) and `git status --porcelain` every 10 seconds while shown; `git
  show --numstat` for an opened commit. All with `--no-optional-locks`.
- **Props:** none. **Shared state:** none.
- **Files:** `main.js`, `lib.js` (the script, the log parsing, the lane layout, the subject and numstat readers).

## repo-prs: the PR & CI panel

The `Workspace` tab lists the repositories that are on a feature branch with the pull request of that branch, its review
state and its checks, failing ones first; repositories on `main`, `master`, `develop` or the remote's default branch fold
into a group. The `Mine` tab lists your open pull requests by repository. Inside one repository the tabs are `Open` and `Mine`.
A click on a pull request or a check opens it in the browser; the summary row opens the full check list.

- **What it runs:** one `sh -c` script (branch, remote url and default branch of each repository, no network), then `gh pr
  view`, `gh pr list` and `gh search prs`, four at a time, on the space's machine. Results are cached for 5 minutes in the
  mod's `localStorage`; `Refresh` asks again. Nothing else is called, so nothing can change a pull request.
- **Checks:** `FAILURE`, `ERROR`, `TIMED_OUT`, `ACTION_REQUIRED` and `STARTUP_FAILURE` are failed; `CANCELLED`, `SKIPPED`,
  `NEUTRAL` and `STALE` are skipped (a cancelled run is usually one that a newer push replaced); no result yet is pending.
- **Sign-in:** `gh` is signed in by you. When it is not, or the network is down, the panel says so once and stops asking.
- **Sets** `shared("badge.repo-prs")`: the number of open pull requests with a failing check, shown on its button.
- **Props:** none. **Files:** `main.js`, `lib.js`.

## repo-worktrees: the Worktrees panel

The linked worktrees of every repository under the space's folder, grouped by repository, newest commit first. A row shows
the branch, ahead and behind, uncommitted changes, unpushed commits, whether the remote branch is gone and the age. A click
opens the space at that folder or a new tab there.

- **Ready to remove** means all of these hold: nobody is working there, it is not locked, no uncommitted change, no commit
  that exists on no remote branch, a base to compare with, and its work is already in the base (`origin/HEAD`, else
  `origin/main`, `master` or `develop`) or its remote branch was deleted. An unknown (git failed) is never ready, and
  **unpushed commits are never ready**. Anything else is `In progress`.
- **Remove** appears on a ready row and asks once more. It then checks again (no changes, no unpushed commits, nobody working
  there), runs `git worktree remove` **without `--force`**, and `git branch -d` **never `-D`**, so git refuses to lose a
  branch that is not merged and the panel says so. It never deletes a remote branch and never fetches.
- **What it runs:** one `sh -c` script every 30 seconds while shown, reading each repository once (`git worktree list
  --porcelain`, `rev-list`, `for-each-ref`, `status`), eight at a time.
- **Sets** `shared("badge.repo-worktrees")`: the number of ready worktrees, shown on its button.
- **Props:** none. **Files:** `main.js`, `lib.js`.

## jig-files: the Files panel

Herdr's shipped `files` mod (Apache-2.0; the file says so at its top), changed so that a click on a file opens it in a
`file-view` tab, as `jig-work` does, and a second click selects that tab. Folders open in place and files with uncommitted
changes carry a letter. It reads the folder on the space's machine and writes nothing. Its icons are Herdr's own, from
`mods/workspace-chrome/`.

## jig-activity: the icon bar

A 40 px column of buttons that switches the children of a stack, like an editor's activity bar. The layout says what to
draw; the mod holds no list of panels.

- **Props:** `{ "stack": "<id of the stack>" }`, default `panel-body`.
- **Each child of the stack** gives its tooltip in `title`, and in `content.props.activity` an `icon` (a path of an SVG under
  the Herdr folder, drawn in the text colour), optionally `"end": true` to sit at the bottom and `"divider": true` for a line
  after its button. Herdr drops fields of a node that it does not know, but keeps a mod's props whole, which is why these
  are in the props.
- **A badge** on a button comes from `shared("badge.<mod>")`, as `{ count, tone }` with `tone` a theme colour name.
- **A missing mod** (no `mods/<name>/mod.json`, looked for every 30 seconds) has no button.

The Jig icon (a carpenter's set square: a jig is a guide), the Context gauge and the icons of `PR & CI` and `Worktrees` are drawn in
`mods/jig-activity/icons/`; the others are Herdr's own, from `mods/workspace-chrome/`.

## jig-theme-sync: the palette follower

Nothing on screen: the layout gives its block 0 px and it draws an empty `div()`, but a mod in a 0 px block still starts and
its timer runs. Every 5 seconds it reads the `theme` of Pi's
`settings.json`, and when that names a palette it makes the Herdr theme and switches to it.

1. It reads `config.json` (see [Configure](../README.md#configure)) and finds the machine's home and Pi's agent folder.
2. It looks for `<name>.json` in `<agentDir>/themes/`, then in `themeFolders`. Such a file is a Pi theme with `vars`.
3. A palette whose named colours are all `#rrggbb` is converted by `convert.js`, the same function that made the six
   shipped themes, and written to `themes/<name>.json` if the text changed.
4. With no palette file it uses an installed theme of that name, so the six built-in palettes need no folder to look in.
5. `app.theme` switches the window. Pi's own `dark` and `light` have no palette and are left alone; the label then says so.

Dark palettes keep a black window and only the highlights (accent, selection, the states, the terminal colours) come from
the palette. A light palette uses its own backgrounds. A wrong `config.json` field is ignored and reported once as a
notification. On this computer without `sh` (Windows), it uses the home folder and Pi's default folder.

## The layout

`layouts/jig.json` is written from Herdr's shipped `main` layout (Apache-2.0), with the right panel opened and our blocks
added. The root has Herdr's `workspace-chrome`, `spaces` and `agents`, the `jig-tabs` bar and the terminals as cards
(`pane`, the header always shown), and a `panel` row holding the `panel-body` stack and the `activity` bar. There is no
status bar: `jig-theme-sync` and `keep-awake` sit in 0 px blocks at the bottom of the sidebar, above its footer, unseen;
the first follows Pi's palette and the second holds the awake request. The theme is `jig-lime`, and the follower changes it.

| Panel (stack child) | Mod | Icon |
|---|---|---|
| `jig-work` (open first) | `jig-work` | `jig.svg`, ours |
| `jig-context` (a line under its button closes the Jig group) | `jig-context` | `context.svg`, a gauge, ours |
| `changes` | `repo-changes` | `git-compare.svg`, Herdr's |
| `history` | `repo-history` | `clock.svg`, Herdr's |
| `pr` | `repo-prs` | `pr.svg`, ours |
| `worktrees` | `repo-worktrees` | `worktree.svg`, ours |
| `files` | `jig-files` | `files.svg`, Herdr's |

The id `jig-work` is the one the tab bar's `Jig` button opens. To use a panel of your own, add a child to the stack with its
`title` and `content.props.activity.icon`.
