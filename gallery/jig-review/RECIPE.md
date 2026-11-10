# Review

A review of one repository: changed files on the left, the selected diff or file on the right, with copy, stage, unstage
and discard actions. Opened by Git or Work it is a tab; dropped into the side panel with no `repo` prop it follows the
focused terminal's repository, or the space's folder, with a repository chooser when several exist. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![Review](preview.png)

**What you see:**

A 42 px header with the repository name, the Terminal/Space switch (side panel only) and Refresh. A draggable divider
(width remembered in the mod's localStorage) separates the file list from the right side; below 640 px the list stacks
above the diff instead, keeping both usable in a 380 px panel. The right side's own row carries the file path, the
**Diff | File | Patch** switch, **Copy file** and **Copy path**. The left side has two mode
buttons, **Working changes** and **Branch vs <base>**, shown when both have something to show. The right side is tinted diff
rows, the whole file, or the raw patch in a read-only code editor; the footer says how many lines are selected.

**How it behaves:**

Click a file to show its diff, click a line to select it, Shift-click to extend, Escape to clear. `Ctrl+C`/`Cmd+C` or **Copy
N lines** copies the selected lines; **Copy file** and **Copy path** copy the selected file. **Working changes** uses
`git diff HEAD`; **Branch vs <base>** uses the merge base. The file list re-reads every 5 s while the tab is shown; the base
branch is looked up at most every 60 s, or sooner when HEAD moves. A user-started read shows busy after 400 ms. The side
panel looks for repositories under the followed folder every 5 s. Stage,
Unstage and Discard are per file; Discard asks inline. A second request for the same repository selects the existing tab.

**Built from:**

`main.js` + `lib.js` + `refresh.js` (the shared runner and `GIT_READ`) + `panel-header.js` (the shared header and error line) + `follow.js`/`follow-state.js` (the Terminal/Space choice); no `config.json`. Props: `{ on, repo, name, file?, mode? }`; without `repo` it follows the folder. Herdr: `exec`, `run`,
`tab.new`, `shared`/`setShared`, `appHome`, `readTextFile`, `theme`, `layout`, `panes`, `spaces`, `Editor`/`TextView` from
`gpui-base`. Shared key `jig-review.open`; localStorage stores divider width, pane choice and wrap. Base candidates, in order:
`origin/develop`, the remote HEAD branch, `origin/main`, `origin/master`, `develop`, `main`, `master`.

Programs: `git` — `diff`, `show`, `status`, `rev-parse`, `add`, `restore --staged`, `rm --cached`,
`restore --worktree --staged`, `clean -f`; `sh` for the script; `timeout`/`gtimeout` when present. Network: none. Files read:
the repository's `.git` and working tree. Writes: stage, unstage, discard. No commit, fetch or push.

**Header:** all git panels use one 42 px shared header: title and Refresh, whose tooltip says `Refresh · read N ago`
(`Refresh` before the first read, `Reading…` while busy). Git, Worktrees and Review's side panel put the Terminal/Space
switch in a 32 px context card under the header; a Review tab has title and Refresh only. History and PR & CI keep the
switch in the header until their follow-up. An error line sits under the header, above the kept rows.

**Watch out:**

Reads pass a 20 s timeout; Herdr's deadline is 25 s, and Herdr 0.1.13 or older cuts at its own 30 s default. `git` and POSIX `sh` are required, so Windows-local without WSL is unsupported. The mode is **not**
read-only: stage, unstage and discard write. Branch mode needs one of the base candidates above; without one it says so.
Very large diffs are capped and say when cut. Binary files show a notice, not content. This mod is opened by `jig-git` via
`tab.new`; the standalone listing has `"place": "none"`, so a layout block with `content.mod = "jig-review"` (or the tab
opened by jig-git) is required. It needs a layout block for the file list; a tab is the normal host. Stage/Unstage and Discard are
the only write controls; Copy needs a selection.

**Done when:**

`herdr-app check mods/jig-review` passes; a demo repo with one modified and one new file shows both; clicking a line and
`Ctrl+C` copies it; Diff/File/Patch switches and is remembered; **Working changes** and **Branch vs <base>** switch; Stage
then Unstage changes the file list; Discard asks; a binary file and a repository without a base candidate each show a line.
