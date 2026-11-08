# Review

A full-tab, read-only review of one repository: changed files on the left, the selected diff on the right, with copy and
stage/unstage actions. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![Review](preview.png)

**What you see:**

A header with the repository name, the mode switch **working** / **branch**, **Copy file**, **Copy path**, a **Diff | File |
Patch** switch and Refresh. A draggable divider (width remembered in the mod's localStorage) separates the file list from
the right side: tinted diff rows with line numbers, or the whole file / raw patch in a read-only code editor. The file list
shows status letters and names; the footer says how many lines are selected. A click selects a line, Shift-click extends,
Escape clears, `Ctrl+C`/`Cmd+C` copies the selected lines, and **Copy N lines** copies them.

**How it behaves:**

Click a file to show its diff; click a line to select it; Shift-click extends; Escape clears; `Ctrl+C`/`Cmd+C` copies.
**Diff** shows tinted rows, **File** the whole file, **Patch** the raw diff; the choice is remembered. **working** uses
`git diff HEAD` (uncommitted), **branch** uses the merge base (committed plus uncommitted) and is read-only. **Copy file**
and **Copy path** copy the selected file's text/path. The diff header's Stage/Unstage acts on the file; Discard asks inline
and is never silent. `jig-repos` opens the tab with props `{ on, repo, name, file?, mode? }` or `tab.new`; a second request
for the same repo selects the existing tab via `jig-review.open`. Refresh on mount/shown/focus and a 60 s backstop; a busy
state appears only after a user action longer than 400 ms.

**Built from:**

`main.js` + `lib.js` + `refresh.js`; props `{ on, repo, name, file?, mode? }`. Herdr: `exec`, `run`, `openOverlay`,
`appHome`, `readTextFile`, `shared`/`setShared`, `theme`, `layout`, `panes`, `spaces`, `Editor`/`TextView` from
`gpui-base`. Shared key `jig-review.open`; localStorage stores the divider width, pane choice and wrap. Config
`${appHome()}/mods/jig-review/config.json` (refresh settings).

Programs: `git diff`, `git show`, `git status`, `git rev-parse`, `git add`/`reset`/`checkout` for stage/unstage/discard;
`sh` for the script; `timeout`/`gtimeout` when present (20 s). Network: none. Files read: the repository's `.git` and working
tree; the only writes are the explicit stage/unstage/discard actions. No commit, fetch or push.

**Watch out:**

Herdr's 30 s cap; `git` and POSIX `sh` are required. Branch mode needs a base branch (`origin/HEAD`, `origin/main`,
`origin/master`, `origin/develop`); if none is known it says so. Very large diffs are capped and say when cut. Binary files
show a notice, not content. Copy needs a selection; the mod is read-only otherwise. The header's controls are the only
write path.

**Done when:**

`herdr-app check mods/jig-review` passes; a demo repo with one modified and one new file shows both; clicking a line and
`Ctrl+C` copies it; Diff/File/Patch switches and is remembered; branch mode shows committed plus uncommitted; Stage then
Unstage works and is reflected in Repos; Discard asks; a binary file and a missing base branch each show a line.
