<img src="../docs/assets/jig.svg" width="48" alt="Jig logo: a set-square">

# The Herdr app: a layout and mods that work with Jig

**Status: built.** Tested with temporary folders (the install script, the layout, the mods' parsing and their scripts on real
git repositories and status files). Seen working in the Herdr app 0.1.11 on Windows, with Pi in WSL as a Herdr machine. Not
tried: macOS, Linux.

[Herdr](https://herdr.dev) is a desktop app for running coding agents in terminals, side by side. Its screen is a **layout**
of blocks, and each block is drawn by a **mod**: a small JavaScript program that runs inside the app. This folder holds a
`jig` layout and twelve mods, copied into the app's folder by a script. It is not a Pi plugin: Pi never loads it.

The layout is for working on several git repositories at once. Beside the terminals, a side panel shows the **Work** and
**Context** of the Pi session in focus (read from [`jig-session`](../plugins/jig-session/README.md)'s status files), then the
changes, history, pull requests, worktrees and files of every repository under the space's folder. The colours follow Pi's.

![The jig layout: spaces and agents on the left, a terminal in the middle, the Changes panel with an icon bar on the right](preview.png)

*The `jig` layout on a folder of five demo repositories and a linked worktree. The Changes panel lists each with its branch and files; the icon
bar at its right switches to the other panels: the Jig group (Work, Context) at the top, then Changes, History, PR & CI, Worktrees and Files.*

## How it works

The app may run on one computer while Pi runs on another machine, such as WSL added to Herdr as an SSH machine. A mod
reaches that machine through Herdr: `exec(program, args, { on: machine })` runs a program there, and `readTextFile(path, { on })`
reads a file. The Work and Context panels run one `sh` script there every 2 seconds, only while they are on screen.

![On the agent's machine, Pi tells jig-session about its events and jig-session writes sessions/<id>.json by a rename; on your computer, the Herdr app's Work and Context panels run one sh script on that machine through Herdr's exec every 2 seconds while shown](../docs/img/session-file.svg)

*jig-session writes one file per session; the panels read them where Pi runs and draw the session whose terminal has the
focus. Context's switches go back the other way, as a [request file](../plugins/jig-session/docs/how-it-works.md#a-switch-there-and-back).*

The repository panels work the same way: a `sh` script with `git` (or `gh`) on the space's machine, on a timer while shown.
[How it works](docs/how-it-works.md) follows a panel through its code.

## The panels

| Panel (mod) | What you see | What it runs |
|---|---|---|
| Work (`jig-work`) | The focused Pi session: ticket, stages, pull requests, ticket files, recent calls | `sh` on the status files every 2 s; `gh`, cached 5 min |
| Context (`jig-context`) | What fills that session's context; a switch per tool and skill; Reload | The same read; one `sh` that writes a request file |
| Changes (`repo-changes`) | Every checkout under the folder, worktrees nested, `3 commits vs develop` for committed work; stage, commit, switch branch | `git status` every 5 s; git writes when you click |
| History (`repo-history`) | A repository picker (a filter with no commit match offers repos by name or branch), its commit graph and each commit's files | `git log` and `git status` every 10 s; `git show` |
| PR & CI (`repo-prs`) | The pull request and checks of each feature branch, and yours | `gh pr view`, `gh pr list`, `gh search prs`; cached 5 min |
| Worktrees (`repo-worktrees`) | Linked worktrees, ready to remove or in progress | `git worktree list` every 30 s; `git worktree remove` on click |
| Files (`jig-files`) | A file tree of the folder; a click opens a file tab | Lists the folder; writes nothing |
| Review tab (`repo-review`) | One repository's changed files and a diff, or its whole branch against its base (read-only); stage, unstage, discard; a draggable file list; a Diff, File or Patch view (the last two select by dragging); copy lines, file or path | `git status` and `git diff HEAD` (branch: `git diff <merge base>`) every 5 s |
| File tab (`file-view`) | One file, read-only; Markdown rendered, `Source` for its text | `readTextFile` with `on`, every 5 s |
| Tab bar (`jig-tabs`) | Tabs, `+`, then `Panel` (shows or hides the side panel), `Jig` (shows Work) and a sun for Keep awake, lit while the computer is held awake | Herdr's `layout.show`, `layout.hide`, `tab.*`; the keep-awake state |
| Keep awake (`keep-awake`) | A sun in the tab bar: Off, On until switched off or Herdr closes, or While agents work (and 5 minutes after the last one) | A hidden PowerShell (`SetThreadExecutionState`), `caffeinate` or `systemd-inhibit` on this computer, only while it is wanted |
| Icon bar (`jig-activity`) | A button per panel, Jig group on top; counts on Changes, PR & CI, Worktrees | `layout.select`; counts from `shared("badge.<mod>")` |
| Nothing (`jig-theme-sync`) | The window takes the colours of Pi's palette, black when dark | Reads Pi's `settings.json` every 5 s; `app.theme` |

In **Work**, the ticket and each pull request open in the browser, an output opens in a file tab, and a line under the outputs
shows Changes for files changed in repositories.

In **Context**, a tool switch applies from the model's next request and a
skill switch from the next prompt; `Reload` reloads Pi once it is idle. `Ctrl+Shift+R` shows or hides the side panel.
[Mods](docs/mods.md) has every panel in detail.

## Install

1. **Start the Herdr app once,** so its folder exists. When Pi runs on another machine, add it in Herdr's settings
   (Machines), such as `wsl`.
2. **Copy the files** from a clone of Jig:

   ```bash
   node herdr/scripts/install.ts            # into ~/.config/herdr-app
   node herdr/scripts/install.ts /mnt/c/Users/<name>/.config/herdr-app   # the Windows app, from WSL
   ```

3. **Switch to the `jig` layout** with `Ctrl+Shift+L`, or in Herdr's settings. Nothing needs a restart.

The script copies files, never links them, records a hash of each, and never overwrites a file you changed or a
`config.json`. [Install](docs/install.md) says what a second run, `--force` and `--dry-run` do, and how to take it out.

## Requirements

- **The Herdr app and herdr-core.** Mods are written for the app's mod runtime.
- **`sh` and `git` on the machine that holds the folders.** The repository panels run `sh` scripts and `git` there.
- **`gh`, signed in by you, on that machine,** for `PR & CI` and for the pull requests in Work. Without it the panel says so.
- **`jig-session`** among the Pi plugins Pi loads, for Work and Context, as every Jig plugin is.

## Configure

Three files in the Herdr folder. Every field is optional, and later installs never replace them.

| File and field | Default | Meaning |
|---|---|---|
| `mods/jig-work/config.json` `machine` | the shown space's machine | Where Pi runs, as `hc machine ls` names it (Context too) |
| `mods/jig-work/config.json` `stateDir` | `$JIG_STATE_DIR`, else `~/.local/state/jig` there | Jig's state folder where Pi runs (Context too) |
| `mods/jig-work/config.json` `prOwners` | `[]`: pull requests that involve you | GitHub owners to search for the ticket's pull requests |
| `mods/jig-theme-sync/config.json` `machine` | `null`, this computer | The machine where Pi runs |
| `mods/jig-theme-sync/config.json` `agentDir` | `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` | Pi's agent folder there |
| `mods/jig-theme-sync/config.json` `themeFolders` | `[]` | More folders to look for a palette in |
| `mods/keep-awake/config.json` `idleMinutes` | `5` | How long While agents work stays on after the last agent stops |
| `mods/keep-awake/config.json` `display` | `false` | Keep the screen on too, not only the system |
| `mods/repo-changes/config.json` `newBranchPrefix` | `"feature/"` | What a new branch's name starts with |
| `mods/repo-changes/config.json` `baseBranch` | origin's HEAD branch, else `main` | The branch a new branch starts from |

```json
{ "machine": "dev-box", "stateDir": "~/.local/state/jig", "prOwners": ["acme"] }
```

Colours, sizes and panels are changed as for any Herdr layout, in `layouts/jig.json`; [Mods](docs/mods.md#the-layout) lists
its parts and the props each mod reads.

## Rules

- **Git writes only when you click.** `Changes` and `Review` stage, unstage, discard (after a confirm), commit and switch
  branch; `Worktrees` removes a ready worktree. Never `--force`, `-D`, `reset`, `--amend`, `--no-verify` or a push, and no
  branch change while an agent works there or files are uncommitted ([each command](docs/mods.md#the-git-actions)).
- **The panels approve nothing.** Approvals happen in Pi, inside the waiting call. Context's one write is a request file
  that switches a tool or a skill of one session, or reloads it; jig-core's rules still decide every call.
- **Reads write nothing.** The panels read with `git status`, `log`, `show` and `diff` options that write nothing under `.git`.
- **Copied, not linked.** The Windows app cannot follow a link made in WSL.
- **Yours stays yours.** The script replaces a file only if it wrote that file and you did not change it, unless `--force`.
- **Polled while shown.** Work and Context read every 2 seconds, Changes every 5 and Worktrees every 30; pull requests are
  asked of `gh` at most every 5 minutes. Nothing runs while a panel is hidden, except the 0 px palette follower.

## How it fits with the plugins

- **`jig-session`:** Work and Context show its [status files](../plugins/jig-session/README.md#the-status-file), matching a
  session to the focused terminal when `terminalFrom` is `HC_TERMINAL_ID`; Context writes its [request file](../plugins/jig-session/README.md#requests).
- **`jig-core`:** Work's recent calls carry jig-core's decision (`jig:decision`). The panel shows them; nothing in it approves.
- **`jig-memory` and `jig-workflow`:** the ticket and the stages come through `jig-session`'s file.
- **`jig-theme`:** its six palettes are converted to Herdr themes (`themes/`), and a palette of your own when it is in use.

## Built on

The Herdr app's mod runtime, its `gpui-kit` and `gpui-base` elements and its `herdr` module (`exec`, `readTextFile`, `writeTextFile`, `run`, `shared`), and the programs
`sh`, `git` and `gh`. `jig-tabs` and `jig-files` are derived from Herdr's own `tabs` and `files` mods (Apache-2.0). The
full list is in [How it works](docs/how-it-works.md#built-on).

## Company part

None. Nothing here is specific to a company.

## Layout

```text
herdr/
  layouts/    jig.json and the picture the settings screen shows (copied, with mods/ and themes/)
  mods/       jig-work, jig-context, jig-tabs, jig-activity, jig-theme-sync, keep-awake, jig-files, file-view, repo-changes,
              repo-review, repo-history, repo-prs, repo-worktrees
  themes/     one Herdr theme for each Jig palette, made by scripts/build-themes.ts
  keys.json   merged into the Herdr folder's keys.json
  RECIPE.md, preview.png   for sharing the layout
  scripts/    install.ts, build-themes.ts
  test/       the install script, the committed themes, the layout, the mods' parsing and scripts
  docs/       the detail pages below
```

## More detail

- [How it works](docs/how-it-works.md): a mod, the link to the agent's machine, the layout, the installer, the palette follower,
  a reading path through the mods, and what it is built on
- [Mods](docs/mods.md): each mod, what it reads and calls, its props, and how the layout is put together
- [Install](docs/install.md): the script, a second run, `--force`, Windows with WSL, removing it
- [jig-session](../plugins/jig-session/README.md): the status file the Work and Context panels read, and the request file
- [RECIPE](RECIPE.md): the brief another agent can build the layout from, in Herdr's format
