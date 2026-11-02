# How it works

How the files in `herdr/` work inside the Herdr app: what a mod is, how a panel reaches the machine where Pi runs, how the
layout puts the panels together, what the install script and the palette follower do, a reading path through the mods, and
what they are built on. It is written for a reader new to Herdr and to TypeScript. Back to the [Herdr app overview](../README.md).

## The words used here

- **Herdr app** is the desktop app. **herdr-core** (`hc`) runs the terminals and agents on each machine.
- **A machine** is where terminals run: this computer, or another one Herdr reaches over SSH, such as `wsl` or `dev-box`
  (`hc machine ls` lists them). A **space** is a place to work on one machine, with a folder.
- **A layout** is a JSON tree of rows, columns, stacks and blocks (`layouts/jig.json`). A **stack** shows one child at a time.
- **A mod** is a folder under `mods/` with a `mod.json` and a `main.js`. Its `main.js` exports a class that draws a block.
- **The state dir** is Jig's state folder on the machine where Pi runs; `jig-session` writes its status files there.

## A mod, in short

A mod's `main.js` default-exports a class that extends `View` (from `gpui-kit`). Herdr calls `init` once and `render` again
after each `cx.notify()` and whenever its own data changes (spaces, agents, focus, the theme). `render` returns elements such
as `div()`, `h_flex()` and `v_flex()`: there is no DOM and no HTML; the script describes and the app draws.

- **Slow work** goes in `cx.spawn(async (cx) => …)`, which awaits `exec` or `readTextFile` and then calls `cx.notify()`.
- **Timers** are `cx.timer.every(ms, …)`. Most Jig mods tick once a second and load only when their period has passed and
  `isShown(layout(), "<mod>")` says the block is on screen: no hidden ancestor, and every stack on the way shows it.
- **Pure parts** (scripts as strings, parsing, layout maths) are in each mod's `lib.js`, which the tests in `herdr/test/` import
  directly. Mods cannot import each other, so a few helpers are copied, and a test runs both copies.

## Reaching the agent's machine

![On the agent's machine, Pi tells jig-session about its events and jig-session writes sessions/<id>.json by a rename; on your computer, the Herdr app's Work and Context panels run one sh script on that machine through Herdr's exec every 2 seconds while shown](../../docs/img/session-file.svg)

*The app and Pi may run on different machines. The panels run their scripts where the files are.*

The app can run on Windows while Pi runs in WSL. A mod never reads the other machine's files directly: it asks Herdr, which
runs the call there through herdr-core.

1. **`exec(program, args, { on, cwd })`** runs a program on machine `on` (`null` is this computer) and returns
   `{ code, stdout, stderr }`. The Jig mods mostly run `sh -c '<script>' sh <arguments>`: the script is a fixed string from
   `lib.js`, and every path or value is an argument, never pasted into the script.
2. **`readTextFile(path, { on })`** reads one text file there, or gives `null` when it is missing. `file-view` uses it.
3. **Work's read.** Every 2 seconds while shown, `jig-work` runs `SCRIPT` from its `lib.js`: it finds the state dir, lists
   `sessions/*.json`, checks each `pid` with `kill -0` and prints each file after a `@@file` line. `parseSessions` reads that.
4. **Which session.** `pickSession` takes the one whose `terminal` matches `focused().terminal` (`<machine>/t7` on another
   machine), else the one you picked, else the one updated last. A session whose Pi has stopped is never shown.
5. **Context's write.** A switch runs `printf %s "$2" > "$1.tmp" && mv "$1.tmp" "$1"` with the request file's path and the
   JSON. The switch is drawn dimmed until the status file's `lastRequest.id` is the id sent; after 10 seconds the panel says
   the session does not answer. The round trip is in [jig-session's How it works](../../plugins/jig-session/docs/how-it-works.md#a-switch-there-and-back).

The repository panels do the same with `git` and `gh` on the space's machine: `repo-changes` runs one script that reads
every checkout's `git status`, and `repo-prs` asks `gh` and caches the answer for 5 minutes in its `localStorage`.

## The layout

`layouts/jig.json` is written from Herdr's shipped `main` layout (Apache-2.0). Its tree, with the mod in each block:

```text
root (row)
├─ sidebar (column, 300 px)
│   ├─ brand ............ workspace-chrome   (Herdr's)
│   ├─ spaces, agents ... spaces, agents     (Herdr's)
│   ├─ jig-theme (0 px) . jig-theme-sync     (draws nothing; its timer runs)
│   └─ footer ........... workspace-chrome   (Herdr's)
└─ work (column)
    ├─ tabs (42 px) ..... jig-tabs           (tabs, +, Panel, Jig)
    └─ work-body (row)
        ├─ main ......... the terminals, as cards with a pane header (Herdr's pane)
        └─ panel (row, 420 px)
            ├─ panel-body (stack: one child shows)
            │   ├─ jig-work ....... Jig · Work      ┐ the Jig group, a line under it
            │   ├─ jig-context .... Jig · Context   ┘
            │   ├─ changes ........ repo-changes
            │   ├─ history ........ repo-history
            │   ├─ pr ............. repo-prs
            │   ├─ worktrees ...... repo-worktrees
            │   └─ files .......... jig-files
            └─ activity (40 px) ... jig-activity: one button per child of panel-body
```

- **The icon bar holds no list.** `jig-activity` reads the stack's children from `layout()`: each child's `title` is the
  tooltip, and `content.props.activity` gives its icon, `divider` or `end`. A click runs `layout.select`.
- **Counts** come from shared values: `repo-changes`, `repo-prs` and `repo-worktrees` call `setShared("badge.<mod>", { count,
  tone })`, and the icon bar draws them.
- **The tab bar's `Jig` button** runs `layout.select` on `jig-work` and `layout.show` on `panel`; `Panel` shows or hides it.
- **A panel of your own** is one more child of `panel-body` with a `title` and `content.props.activity.icon`.

## The install script

`scripts/install.ts` is a Node.js script run from a clone of Jig. It copies `layouts/`, `mods/` and `themes/` into the Herdr
folder and merges `keys.json`.

1. **Order.** Each mod's `mod.json` is written first: Herdr places a new mod folder where its `mod.json` says.
2. **The record.** It keeps `.jig-herdr-install.json` in the Herdr folder: a SHA-256 hash of each file it wrote.
3. **Each file.** Missing: written. Same as the record and unchanged on disk: updated. Changed by you, or not from the
   script: left alone and reported (`--force` replaces it). A `config.json` is written once and never again.
4. **`keys.json`.** Only the `layout:jig` section is added; a key you bound to something else is kept and listed.
5. **Clean-up.** A file an earlier version wrote that is no longer shipped, and that you did not change, is removed.

Files are copied, never linked, because the Windows app cannot follow a link made in WSL. [Install](install.md) has the
table of cases and how to take it out.

## The palette follower

`jig-theme-sync` sits in a 0 px block, so it draws nothing, but its timer runs every 5 seconds even so.

1. **Read Pi's choice.** It reads `theme` from Pi's `settings.json` on the configured machine (`readTextFile` with `on`).
2. **Find the palette.** It looks for `<name>.json` in Pi's `themes/` folder, then in `themeFolders`.
3. **Convert.** `convert.js` turns the palette's named colours into a Herdr theme, the same function that built the six
   committed `themes/jig-*.json`. It writes `themes/<name>.json` only when the text changed (`writeTextFile`).
4. **Switch.** `run("app.theme", { name })` changes the window. Pi's own `dark` and `light` are left alone.

## Reading the mods

Start with `jig-work`; the others follow the same pattern. In each, `main.js` is the view and `lib.js` the tested pure part.

| Mod | What it does | Who uses it |
|---|---|---|
| `jig-work` | Reads the status files, picks the session, draws ticket, PRs, outputs, recent calls | the stack's `jig-work` child |
| `jig-context` | Same read; draws the context bar and lists; writes the request file | the stack's `jig-context` child |
| `jig-activity` | The icon bar: buttons from the stack's children, badges from shared values | the `activity` block |
| `jig-tabs` | Herdr's tab bar with `Panel` and `Jig` buttons | the `tabs` block |
| `jig-theme-sync` | Follows Pi's palette | the 0 px `jig-theme` block |
| `repo-changes` | Checkouts and their files; `picker.js` the branch picker; `lib.js` the git actions | the stack's `changes` child |
| `repo-review` | A repository's changed files and a diff, in a tab; stage, unstage, discard | `tab.new` from Changes and Work |
| `repo-history` | Repository picker and commit graph | the stack's `history` child |
| `repo-prs` | Pull requests and checks through `gh` | the stack's `pr` child |
| `repo-worktrees` | Linked worktrees, ready or in progress, and their removal | the stack's `worktrees` child |
| `jig-files` | The file tree; a click opens `file-view` | the stack's `files` child |
| `file-view` | One file, read-only; Markdown rendered with a `Source` button | `tab.new` from Work and Files |

**One click followed through.** A click on an output in Work:

1. `jig-work` runs `run("tab.new", { mod: "file-view", props: { on, path } })`, and Herdr opens a tab with `file-view`.
2. When the tab is shown, `file-view` reads the file on the agent's machine with `readTextFile(path, { on })`.
3. Its `render` draws `TextView.markdown` for a `.md` file, else an `Editor` with syntax colours.
4. `jig-work` records the tab in `shared("file-view.tabs")`, so a second click selects it.

## Built on

- **The Herdr app's mod runtime:** ES modules in the app, with no DOM; `localStorage` per mod, and `fetch`, which no Jig mod uses.
- **`gpui-kit` and `gpui-base`:** `View`, `div`, `svg`, `image`, `h_flex`, `v_flex`, `Input` and `InputState`,
  `TextView.markdown` (rendered Markdown), `Editor` and `EditorState` (code with colours), `v_virtual_list`, `Scrollbar`.
- **The `herdr` module:** `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `run` (commands such as `tab.new`,
  `tab.select`, `layout.show`, `layout.select`, `terminal.open`, `app.theme`), `shared` and `setShared`, `focused`, `spaces`,
  `panes`, `layout`, `theme`, `props`, `notify`, `openOverlay`, `appHome`, `home`.
- **Programs on the machine:** `sh`, with `kill`, `sed` and `head`; `git`; `gh`, signed in by you. On this computer, the browser
  opener (`explorer.exe`, `open` or `xdg-open`) and, for Files on Windows, `powershell`.
- **The install script:** Node.js 22.19 or later, with `node:fs`, `node:crypto`, `node:path` and `node:os`; no npm package.
- **Licences:** `jig-tabs` and `jig-files` are derived from Herdr's `tabs` and `files` mods (Apache-2.0), and say so at their
  top; the layout is written from Herdr's `main` layout (Apache-2.0). The other mods are Jig's own.

[Back to the overview](../README.md)
