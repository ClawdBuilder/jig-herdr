# Repos

A source-control list for the focused space's folder: every git checkout under it, its branch and changed files, what is
ahead or behind, and a message box to commit. Clicks stage, unstage, discard after a confirm, fetch, pull, push, publish,
or open a file's diff in Review. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![Repos](preview.png)

**What you see:**

A header with the branch chip, the folder, and a refresh button; a commit message box with **Commit** and **Commit & Push**;
**Fetch** and **Pull** buttons; a list of checkouts, each with a fold arrow, name, branch, ahead/behind chips and a count of
changed files; a **↳ <folder>** row for each linked worktree under its main checkout. A file row has a status letter
(`A`, `M`, `D`, `R`, `U`, `??`) in a theme colour (added `ansi2`, deleted/conflict `ansi1`, renamed `ansi5`, modified
`blocked`), a checkbox, a path, and on hover Stage/Unstage or Discard. The branch picker is an overlay with a search field,
each branch's name and last commit; the push dialog shows the destination git will use. Empty, no-git, detached-HEAD, busy
and problem lines are one line, never a raw git dump.

**How it behaves:**

A checkbox stages or unstages one file. A checkout's hover button stages/unstages all its files. Discard asks inline first
("Discard …?"); it never discards a staged-only file silently. The message box commits; **Commit & Push** pushes after the
commit. `Ctrl+Enter` in the message box commits. Hovering a file shows its actions; clicking its name opens the Review tab
(or selects the existing one). The branch chip opens the picker; **Fetch** and **Pull** run at once; **Push** and **Publish**
open a confirm with the remote and branch. There is no Sync: a diverged branch is labelled and a fast-forward pull refuses.
Only one action per checkout runs at a time. Refresh on mount, when shown, on focus, when a terminal in the panel's folder finishes a command,
and on the backstop (`refreshSeconds`, default 60, 15–86400). A click-started run shows busy after 400 ms; automatic runs do
not. A close of the panel cancels its pending work.

**Built from:**

`main.js` + `lib.js` + `picker.js` + `push.js` + `refresh.js` + `layout.js`; no props. Herdr functions: `focused`, `panes`,
`spaces`, `exec`, `run`, `appHome`, `readTextFile`, `shared`/`setShared`, `openOverlay`, `theme`, `layout`, `window`.
Shared keys: `badge.jig-repos`, `jig-repos.folded`, `jig-repos.running`, `jig-repos.done`. Config:
`${appHome()}/mods/jig-repos/config.json` with `newBranchPrefix`, `baseBranch`, `remote`, `networkTimeoutSeconds`,
`rowDetail` (`compact`/`full`), `refreshSeconds`; defaults fill gaps and a bad field is reported, not fatal.

Programs: `sh` (one script reads all checkouts without writing), `git`, and `timeout`/`gtimeout` when present for 20 s
network/read caps. Network: `git fetch`, `git pull`, `git push` only on those clicks; no other network. Files read: the
focused/space folder's git metadata and working tree, and its `config.json`; writes: stage/unstage/discard, commit, fetch,
pull, push, and a new worktree only through the normal git actions.

**Watch out:**

The 30 s Herdr `exec` cap can still end a slow network command; the mod reports a stopped command as stopped, not failed.
Assumes `git` on PATH, an `origin` (or configured remote), and a POSIX `sh`; Windows-local without WSL has no `sh`. The
checkout walk covers three folder levels and skips `node_modules`; a repository deeper than that is not found. Very large
working trees are capped by the read limits. Discard is permanent and never offers an undo. `gh` is not used here.

**Done when:**

`herdr-app check mods/jig-repos` passes; a demo repo (`orders-api`) with one modified file shows it; stage/unstage, a commit
with `Ctrl+Enter`, Fetch/Pull/Push confirmation, the branch picker, a linked worktree row, a discard confirm and a no-git
folder all render; a `timeout`-less PATH still works (the fallback `sh` runs); closing the panel during a read leaves no
error.
