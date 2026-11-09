# Worktrees

The linked worktrees of the space's folder, marked **Ready to remove** or **In progress**, with a safe prune of merged
ones. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![Worktrees](preview.png)

**What you see:**

A header whose title is the worktree count (`15 worktrees`, `1 worktree`, or `Worktrees` before the first read; the full
repo · count is the tooltip), **Prune merged (N)** when N ready rows exist; repository groups, each with worktree rows:
name, branch, head, base, last commit, status, and a **Ready to remove** / **In progress** label plus the reason (`merged
into base`, `remote branch deleted`, uncommitted changes, locked, an agent working). The main checkout is labelled. A row's
`⋯` menu offers Remove, and Remove asks inline first; the prune banner asks once for all ready rows. Empty and no-git
states are one line.

**How it behaves:**

Click a row to open the space at that worktree, or a new tab there. **Remove** runs only on a ready row, rechecks the live
worktree list, uncommitted/ignored files, base count, upstream, creation and terminals at the path before removing; git runs
`worktree remove` without `--force`, then `branch -d` (never `-D`). `Prune merged (N)` confirms, removes the ready entries in
order, refuses if the folder/machine changes mid-chain, and reports any busy removal. Refresh on mount/shown/focus/
a terminal in the panel's folder finishing a command, and on the backstop (default 60 s). A user action shows busy after 400 ms; automatic reads
are silent. A refusal is one line; nothing is forced.

**Built from:**

`main.js` + `lib.js` + `refresh.js`; no props. Herdr: `focused`, `panes`, `spaces`, `exec`, `run`, `appHome`,
`readTextFile`, `shared`/`setShared`, `theme`, `layout`, `openOverlay`. Shared keys `badge.jig-worktrees` and the prune
state. Config `${appHome()}/mods/jig-worktrees/config.json` (refresh settings).

Programs: `git worktree list`, `git status`, `git rev-list`, `git reflog`, `git for-each-ref`, `git worktree remove`,
`git branch -d`, `sh` for the script, `timeout`/`gtimeout` when present (20 s). Network: none. Files read: the repository's
`.git` metadata and the worktree folders; the only write is the explicit Remove.

**Header:** all git panels use one 42 px shared header: title, optional Terminal/Space switch, and a refresh icon whose
tooltip says `Refresh · read N ago` (`Refresh` before the first read, `Reading…` while busy). Git, History, PR & CI and
Worktrees show the switch; Review has title and Refresh only. An error line sits under the header, above the kept rows.

**Watch out:**

Herdr's 30 s cap; `git` and POSIX `sh` are required, so Windows-local without WSL is unsupported. Readiness is
conservative: an unmerged branch, uncommitted data, a lock, a terminal or an agent keeps a row in progress. **Every ignored
path is refused, except a top-level `node_modules/`, `dist/`, `build/` or `target/` directory; `.env*` is always refused.**
The main checkout is never offered. There is no configured root: a row opens the space at that path (or a new tab) wherever
the worktree is. The standalone listing has `"place": "none"`, so a layout block with `content.mod = "jig-worktrees"` is
required. The panel has the **Terminal / Space** switch (per space): Terminal follows the focused terminal's folder, Space
uses the space's folder.

**Done when:**

`herdr-app check mods/jig-worktrees` passes; a demo repo with a merged worktree and a dirty worktree shows one ready and one
in progress; Remove asks and then removes the ready one (its git refusals still work); Prune removes two in order; a dirty,
locked or terminal-cwd worktree refuses in one line; no-git and empty states render.
