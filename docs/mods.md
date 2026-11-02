# Mods

What each mod in `herdr/mods/` shows, what it reads and runs, and the props it takes, then how the `jig` layout is put
together. Back to the [Herdr app overview](../README.md).

All of them are trusted code that runs inside the Herdr app, so this page says what each reaches. Only `jig-work` reaches
the network, through `gh` on the machine where Pi runs. Each is a `main.js` with the helper files named below; the pure parts
are in `lib.js` files, which the tests load.

## jig-work: the Work panel

The Pi session in focus, from the status files the `jig-session` Pi plugin writes ([the format](../../plugins/jig-session/README.md#the-status-file)). A header with the folder's
name, the model, the thinking level and `working` or `idle`, then the context and cost; a `N sessions` list to pick another
when several run. Then four sections:

- **Ticket:** the key (opens the Jira page when one is known) and title, and the workflow's stages as a line, the current one
  filled with the accent colour, the ones before it ticked.
- **Pull requests:** the ones the workflow observed; with none, what `gh search prs <KEY>` finds in the `prOwners` of
  `config.json`, else among the pull requests that involve you (never all of GitHub). For up to four, `gh pr view`
  adds the review state and the checks. Failing ones first, with the names of their failing checks. A click opens it.
- **Outputs:** the files the session created (`A`) or changed (`M`), newest first. A click opens a `file-view` tab, or selects
  the one already open. A file with changes in a git repository has a diff button that opens it in the `Review` tab.
- **Recent:** the last 15 tool calls: time, tool and action, jig-core's decision (`allowed`, `asked · allowed`, `denied`) and
  the outcome (`ok`, `error`, `blocked`, `running`).

- **Which session:** the one whose terminal is focused (`focused().terminal`, `<machine>/t7` on another machine), or the agent
  shown; else the one picked; else the one updated last. A Pi whose process ended is never shown.
- **What it runs:** on the machine (config `machine`, else the shown space's machine), one `sh` script every 2 seconds while the
  panel is on screen, reading `<state folder>/sessions/*.json` and checking each `pid` with `kill -0`. For outputs, one
  `git rev-parse` and `git status` script when the list changes and every 30 seconds. For pull requests, `gh`, cached 5
  minutes per ticket in the mod's `localStorage`; `Refresh` asks again.
- **Opens:** links with this computer's browser (`explorer.exe`, `open` or `xdg-open`); files with `tab.new` and `file-view`;
  diffs with `tab.new` and `repo-review`. A missing `file-view` gives a notification; a missing `repo-review` hides the button.
- **Sets** `shared("file-view.tabs")`, the map of `<machine>|<path>` to the tab that shows it, so a second click selects it.
- **Props:** none. Settings in `config.json`: `{ machine, stateDir, prOwners }`.

## jig-tabs: the tab bar

Herdr's shipped `tabs` mod (Apache-2.0; the file says so at its top), with the Files and Changes buttons replaced by two:

- **`Panel`** shows or hides the side panel (`layout.show` or `layout.hide` on `panel`); the stack keeps its last section.
- **`Jig`** selects the `jig-work` child of `panel-body` and shows the panel; a second click hides it. Lit while it shows.
- **Props:** `{ panel, stack, jig }`, the ids of the panel row, its stack and the Jig child; default `panel`, `panel-body`,
  `jig-work`. The side panel is remembered per space, as in Herdr's bar.

## file-view: a file in a tab

A read-only view of one file with syntax colours, a line count, `Copy path` and `Refresh`. Its props come from `tab.new`:
`{ on, path }`. It reads the file with `readTextFile` (`on` for another machine) when the tab comes into view and every 5
seconds while shown; a binary or missing file says so.

## repo-changes: the Changes panel

Every git repository under the space's folder, changed ones first, then a `Clean` group; a filter box matches repository
names and file paths. A click on a file opens it in a `Review` tab. A button on a row opens a terminal in that repository.

- **Where it looks:** the space's folder on the space's machine. Inside a repository, only that one is listed. Otherwise
  folders with a `.git` up to three levels down, so `worktrees/PROJ-123/orders-api` is found; `node_modules` is skipped.
- **What it runs:** one `sh -c` script on that machine (`exec` with `on`), reading each repository's `git status` with no
  locks and no fsmonitor, 8 at a time, at most 200 files each.
- **When:** every 5 seconds while the panel is on screen, when you open it, and when an agent or terminal changes state.
- **Sets** `shared("badge.repo-changes")`: the number of repositories with changes, shown on its button.

## repo-review: the Review tab

One repository's changed files on the left and the diff of the chosen file on the right, with added and removed lines
tinted and marked at the edge. The `j`, `k` and arrow keys step through files. It opens as a tab, so its props come from
`tab.new`: `{ on, repo, name, file? }` (the machine, the absolute path, a title and the file to show first).

It runs `git status` and `git diff HEAD` in the repository, and reads an untracked file to show it whole. Re-listing is
every 5 seconds while the tab is shown. A second click on a file of the same repository retargets the open tab.

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

The Jig icon (a carpenter's set square: a jig is a guide) and the icons for Triage's panels are drawn in
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
status bar: `jig-theme-sync` sits in a 0 px block at the bottom of the sidebar, above its footer, unseen. The theme is
`jig-lime`, and the follower changes it.

| Panel (stack child) | Mod | From |
|---|---|---|
| `jig-work` (open first, a line under its button) | `jig-work` | this plugin |
| `changes` | `repo-changes` | this plugin |
| `history` | `triage-history` | Triage |
| `pr` | `triage-pr` | Triage |
| `worktrees` | `triage-worktrees` | Triage |
| `files` | `files` | Herdr |
| `settings` (bottom of the bar) | `triage-launch` | Triage |

The id `jig-work` is the one the tab bar's `Jig` button opens. To use a panel of your own, add a child to the stack with its
`title` and `content.props.activity.icon`.
