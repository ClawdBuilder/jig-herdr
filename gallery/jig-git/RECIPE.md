# Git

Git for every repo in the focused space's folder: stage, commit, push, fetch and pull, branch switching, and each file's diff in Review.

![Git](preview.png)

**What you see:**

A 42 px header with the folder's name (the full path on hover), the **Terminal**/**Space** switch, fold-all (when more than
one repo group exists), fetch-all (when a checkout has a remote) and Refresh; a muted body line under it carries the repo count and changed-file summary. A commit message box with **Commit**
and **Commit & Push**;
**Fetch** and **Pull** buttons; a list of checkouts, each with a fold arrow, name, branch, ahead/behind chips and a count of
changed files; a **↳ <folder>** row for each linked worktree under its main checkout. A file row has a status letter
(`A`, `M`, `D`, `R`, `U`, `??`) in a theme colour (added `ansi2`, deleted/conflict `ansi1`, renamed `ansi5`, modified
`blocked`), a checkbox, a path, and on hover Stage/Unstage or Discard. The branch picker is an overlay with a search field. Before anything is typed it shows local branches only, plus
`Type to search N more on origin` when N origin-only branches exist; typing shows ranked local and origin-only matches:
an exact name, then names that start with the text, then the last path segment, then any substring, locals first. The row Enter would pick has a
2 px `t.accent` left edge (other rows keep their hover background), `↑↓ to choose · Enter to switch` is shown while a row is pickable, and Enter
switches only that row. The push dialog shows the destination git will use. Empty, no-git, detached-HEAD, busy and
problem states each show one short line that says what to do next.

A filter box under the header matches a checkout's name or a file's path. Checkouts are 26 px rows: a fold chevron, the
name (a worktree indented, with its repo prefix dropped), branch chip, ahead/behind chips and changed-file count; its file
rows are 24 px. A clean group folds at the bottom, and a result line under a checkout lasts 12 seconds. Row actions appear
only on hover; a diverged branch labels its pull as rebase-or-merge rather than Sync, and Publish appears when the branch
has no usable upstream.

**How it behaves:**

A checkbox stages or unstages one file. A checkout's hover button stages/unstages all its files. Discard asks inline first
("Discard …?"); it never discards a staged-only file silently. The message box commits; **Commit & Push** pushes after the
commit. `Ctrl+Enter` in the message box commits. Hovering a file shows its actions; clicking its name opens the Review tab
(or selects the existing one). The branch chip opens the picker; **Fetch** and **Pull** run at once; **Push** and **Publish**
open a confirm with the remote and branch. There is no Sync: a diverged branch is labelled and a fast-forward pull refuses.
Only one action per checkout runs at a time. Refresh on mount, when shown, on focus, when a terminal in the panel's folder finishes a command,
and on the backstop (`refreshSeconds`, default 60). A click-started run shows busy after 400 ms; automatic runs do
not. A close of the panel cancels its pending work.

**Built from:**

`main.js` + `lib.js` + `picker.js` + `push.js` + `refresh.js` + `layout.js`; props `{ picker: true }` shows the branch
picker and `{ push: true }` shows the push confirmation instead of the panel. Herdr functions: `focused`, `panes`,
`spaces`, `exec`, `run`, `appHome`, `readTextFile`, `shared`/`setShared`, `openOverlay`, `theme`, `layout`, `window`.
Shared keys: `badge.jig-git`, `jig-git.folded`, `jig-git.running`, `jig-git.done`. Config:
`${appHome()}/mods/jig-git/config.json` with `newBranchPrefix`, `baseBranch`, `remote`, `networkTimeoutSeconds`,
`rowDetail` (`compact`/`full`), `refreshSeconds`; defaults fill gaps and a bad field is reported, not fatal.

Programs: `sh` (one script reads all checkouts without writing), `git`, and `timeout`/`gtimeout` when present for 20 s
network/read caps. Network: `git fetch`, `git pull`, `git push` only on those clicks; no other network. Files read: the
focused/space folder's git metadata and working tree, and its `config.json`; writes: stage/unstage/discard, commit, fetch,
pull and push. Nothing here creates a worktree. It opens `jig-review` with `tab.new` and sets `jig-review.open`; the
standalone listing therefore bundles `jig-review` (see below). Icons come from Herdr's `mods/workspace-chrome/*.svg` and this
mod's own `*.svg`.

**Header:** all git panels use one 42 px shared header: title, optional Terminal/Space switch, and a Refresh whose
tooltip says `Refresh · read N ago` (`Refresh` before the first read, `Reading…` while busy). Git, History, PR & CI and
Worktrees show the switch; Review has title and Refresh only. An error line sits under the header, above the kept rows.

**Watch out:**

Network commands longer than 30 s need Herdr 0.1.14 or newer: the mod passes an `exec` timeout just past its shell
watchdog, so the watchdog reports "Push took too long and was stopped (N s)."; older Herdr still cuts at 30 s. `networkTimeoutSeconds` defaults
to 60, not 20. Assumes `git` on PATH, an `origin` (or configured remote), and a POSIX `sh`;
Windows-local without WSL has no `sh`. The
checkout walk covers three folder levels and skips `node_modules`; a repository deeper than that is not found. Very large
working trees are capped by the read limits. Discard is permanent and never offers an undo. `gh` is not used here. The
standalone listing has `"place": "none"`, so a layout block with `content.mod = "jig-git"` is required. File and branch
clicks need `jig-review`; this listing bundles it. The panel has the **Terminal/Space** switch (per space): Terminal
follows the focused terminal's folder, Space uses the space's folder.

**Done when:**

Make the demo repo with `git init orders-api && git -C orders-api commit --allow-empty -m 'first'`; then
`herdr-app check mods/jig-git` passes; the repo with one modified file shows it; stage/unstage, a commit
with `Ctrl+Enter`, Fetch/Pull/Push confirmation, the branch picker, a linked worktree row, a discard confirm and a no-git
folder all render; a `timeout`-less PATH still works (the fallback `sh` runs); closing the panel during a read leaves no
error.
