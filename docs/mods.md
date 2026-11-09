# Mods

What each mod in `mods/` shows, what it reads and runs, and the props it takes, then how the `jig` layout is put
together. Back to the [Herdr app overview](../README.md); [How it works](how-it-works.md) explains a mod and the link to
the agent's machine first.

All of them are trusted code that runs inside the Herdr app, so this page says what each reaches. `jig-work` and `jig-prs`
reach the network through `gh`, and `jig-git` fetches, pulls and pushes with git (after a confirm), on the machine where the folders are.
Three mods write with git: `jig-git` and `jig-review` with [the git actions](#the-git-actions), and `jig-worktrees`
with its `Remove`. Each is a `main.js` with the helper files named below; the pure parts are in `lib.js` files, which the
tests load.

## jig-work: the Work panel

The Pi session in focus, from the status files the `jig-session` Pi plugin writes ([the format](https://github.com/ClawdBuilder/jig/blob/main/plugins/jig-session/README.md#the-status-file)). A pinned 42 px header with the folder's
name at the left and `working` or `idle`, the `N sessions` picker and a Refresh at the right; a pinned second line
carries the model, thinking level, context, cost and terminal. Then four sections, Outputs and Recent folded by their
headers:

- **Ticket:** the key (opens the Jira page when one is known) and title, and the workflow's stages as a line, the current one
  filled with the accent colour, the ones before it ticked.
- **Pull requests:** the ones the workflow observed; with none, what `gh search prs <KEY>` finds in the `prOwners` of
  `config.json`, else among the pull requests that involve you (never all of GitHub). For up to four, `gh pr view`
  adds the review state and the checks. Failing ones first, with the names of their failing checks. A click opens it.
- **Outputs:** the files the session created (`A`) or changed (`M`) outside any git repository, such as ticket notes, plans
  and reports, newest first (`No ticket files yet` when none), each with its short folder (the last two segments; full path
  on hover). A click opens a `jig-file-view` tab, or selects the one already open. Files inside repositories are not listed:
  under the list a dim line, `N files changed in repositories → Git`, shows the side panel on the Git section. The
  status file's `repo` field says which is which; a session of an older `jig-session` has none, so all its outputs are
  listed, with the diff button on those that have changes in a repository.
- **Recent:** the last 15 tool calls: time, tool and its short target, the outcome (`ok`, `error`, `blocked`, `running`) and,
  only when it is not jig-core's default allow, the decision (`asked · allowed`, `denied`, `declined`) in its colour. The
  full tool, target, decision and outcome are in the row's tooltip. Five rows show, with `Show all N`.

- **Which session:** the one whose terminal is focused (`focused().terminal`, `<machine>/t7` on another machine), or the agent
  shown; else the one picked; else the one updated last. A Pi whose process ended is never shown.
- **When it reads:** a first read on mount, then events — the panel being shown (or shown again), the focused session
  changing, the window regaining focus, the followed terminal's Herdr status changing (working ↔ idle/done), its own
  actions and the Refresh. While the followed session works, every 3 s one tiny `sh` prints only the status files'
  mtimes and sizes, and only the files that moved are read; while it is idle, nothing but events and the `refreshSeconds`
  backstop (60 s by default, never under 15). Reads pass a 20 s timeout, network calls 60 s, and Herdr's deadline is 5 s later (up to 600 s on 0.1.14+). On the machine (config `machine`, else the shown space's machine); for listed outputs of an older
  status file one `git rev-parse`/`git status` script when the list changes and every 30 s; pull requests through `gh`,
  cached 5 minutes per ticket in `localStorage`. Background runs are silent; a clicked refresh shows its busy state only
  after 400 ms and queues one more click instead of blocking.
- **Opens:** links with this computer's browser (`explorer.exe`, `open` or `xdg-open`); files with `tab.new` and `jig-file-view`;
  diffs with `tab.new` and `jig-review`. A missing `jig-file-view` gives a notification; a missing `jig-review` hides the button.
- **Sets** `shared("jig-file-view.tabs")`, the map of `<machine>|<path>` to the tab that shows it, so a second click selects it.
- **Props:** none. Settings in `config.json`: `{ machine, stateDir, prOwners, refreshSeconds }`.

## jig-context: the Context panel

What fills the context of the Pi session in focus, like a coding agent's context view, from the same status files
([how it is counted](https://github.com/ClawdBuilder/jig/blob/main/plugins/jig-session/docs/context.md)). The session is chosen as in Work (the focused terminal's,
else the one picked, else the last active) and the same `N sessions` picker switches it. A pinned 42 px header holds the
folder, picker, `Reload` and refresh; a second line carries the model, thinking, terminal and `last active`.

- **The bar:** `62% used · 124k / 200k`, one bar split by share of the window, and a legend with a coloured square, the
  tokens and the percentage of each part: Messages, Tools, System prompt, Skills, Context files, Compaction buffer, Free
  space. Counted parts carry `≈` (characters / 4).
- **The lists,** folded until clicked and remembered **per session**: `TOOLS N of M on` and `SKILLS N`, each row with its size
  and a switch (whose tooltip says what it does); `CONTEXT FILES N` with each file's size, read only. A skill Pi never lists
  says `command only`. The count note is one short line, with the full explanation in its tooltip.
- **Switches and Reload** write one request file next to the session's status file
  ([the contract](https://github.com/ClawdBuilder/jig/blob/main/plugins/jig-session/README.md#requests)), with one `sh` on the machine:
  `printf %s "$2" > "$1.tmp" && mv "$1.tmp" "$1"`, the path and the JSON as arguments. A request carries every switch not
  answered yet. The answer (`lastRequest`) shows under the legend; a switch is drawn dimmed until it comes.
- **What it never does:** approve a call, change jig-core's rules, or write anything else. A tool switched on is declared to
  the model; jig-core still decides each call.
- **When it reads:** the same reader and events as Work (a first read on mount, shown/shown again, focus/session change,
  window focus, the followed terminal's status, its own actions, a manual read), the same 3 s mtime-only check while the
  session works and the same `refreshSeconds` backstop from `mods/jig-work/config.json`. `Reload` says `Reload when idle` while the
  agent works.
- **Props:** none. **Files:** `main.js`, `lib.js` (a copy of Work's session finding, the bar, the request).

## jig-tabs: the tab bar

Herdr's shipped `tabs` mod (Apache-2.0; the file says so at its top), with the Files and Git buttons replaced by two:

- **`Panel`** shows or hides the side panel (`layout.show` or `layout.hide` on `panel`); the stack keeps its last section.
- **`Jig`** selects the `jig-work` child of `panel-body` and shows the panel; a second click hides it. Lit while it shows.
- **Props:** `{ panel, stack, jig }`, the ids of the panel row, its stack and the Jig child; default `panel`, `panel-body`,
  `jig-work`. The side panel is remembered per space, as in Herdr's bar.
- **The sun** at its right is [Keep awake](#jig-keep-awake-the-jig-keep-awake-control): lit while the computer is held awake, a
  click turns it on or off, a right-click opens its three modes.

## jig-keep-awake: the Keep awake control

A key and, in the Jig tab bar, a sun: cycles Off, On and While agents work. Full detail: [Keep awake recipe](../gallery/jig-keep-awake/RECIPE.md).

## jig-file-view: a file in a tab

A read-only view of one file in a **tab** (it has no panel form: open it from Files or Work), with syntax colours, a line
count, `Copy path`, `Refresh` and a soft-wrap toggle. Its props come from `tab.new`: `{ on, path }`. A 42 px header holds
the name and folder (full path on hover) with the controls at the right; below 420 px the folder and line count give way so
all the controls fit. It reads with `readTextFile` (`on` for another machine) on mount, when the tab comes back or regains focus, on its
backstop and on Refresh — no 5 s loop; a click during a read queues one more; hidden tabs read nothing, not even their
config. A binary or missing file says so, and a tab without props says to open one from Files or Work. `wrap` starts on for Markdown and text and is remembered in `localStorage`; `config.json` has
`refreshSeconds`.

A Markdown file (`.md`, `.markdown`, `.mdx`) opens rendered: headings, lists, tables, code blocks and links. `Source` in
the header shows its text with syntax colours, and `Preview` goes back.

## jig-git: the Git panel

Checkouts, changed files, branches, fetch/pull/push and commit. Full detail: [Git recipe](../gallery/jig-git/RECIPE.md).

## jig-review: the Review tab

A read-only diff with stage, unstage and discard. Full detail: [Review recipe](../gallery/jig-review/RECIPE.md).

## jig-history: the History panel

A repository picker and a commit graph. Full detail: [History recipe](../gallery/jig-history/RECIPE.md).

## jig-prs: the PR & CI panel

Pull requests and checks through `gh`. Full detail: [PR & CI recipe](../gallery/jig-prs/RECIPE.md).

## jig-worktrees: the Worktrees panel

Linked worktrees, readiness and safe removal. Full detail: [Worktrees recipe](../gallery/jig-worktrees/RECIPE.md).

## jig-files: the Files panel

Herdr's shipped `files` mod (Apache-2.0; the file says so at its top), changed so that a click on a file opens it in a
`jig-file-view` tab, as `jig-work` does, and a second click selects that tab. Folders open in place and files with uncommitted
changes carry a letter. A filter runs one bounded `find` per change (500 ms after typing) and per refresh, never once per
tick; watcher events go through the refresh scheduler, so they debounce and a read in progress queues one more. It reads
the folder on the space's machine through one listing function, with the filter's `find` bounded to 10 s where coreutils
`timeout` exists, and writes nothing. Its icons are Herdr's own, from
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
status bar: `jig-theme-sync` and `jig-keep-awake` sit in 0 px blocks at the bottom of the sidebar, above its footer, unseen;
the first follows Pi's palette and the second holds the awake request. The theme is `jig-lime`, and the follower changes it.

| Panel (stack child)                                          | Mod             | Icon                         |
| ------------------------------------------------------------ | --------------- | ---------------------------- |
| `jig-work` (open first)                                      | `jig-work`      | `jig.svg`, ours              |
| `jig-context` (a line under its button closes the Jig group) | `jig-context`   | `context.svg`, a gauge, ours |
| `changes`                                                    | `jig-git`       | `git-compare.svg`, Herdr's   |
| `history`                                                    | `jig-history`   | `clock.svg`, Herdr's         |
| `pr`                                                         | `jig-prs`       | `pr.svg`, ours               |
| `worktrees`                                                  | `jig-worktrees` | `worktree.svg`, ours         |
| `files`                                                      | `jig-files`     | `files.svg`, Herdr's         |

The id `jig-work` is the one the tab bar's `Jig` button opens. To use a panel of your own, add a child to the stack with its
`title` and `content.props.activity.icon`.
