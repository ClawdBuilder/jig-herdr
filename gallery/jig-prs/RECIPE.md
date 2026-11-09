# PR & CI

Pull requests and their checks for the space's folder, read through `gh`. Inside one repository it lists that repository's
PRs; on a folder of many repositories it lists the open PR of each feature branch, and a second tab lists all of yours.
Read-only. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![PR & CI](preview.png)

**What you see:**

A header with the **Open**/**Workspace** and **Mine** tabs on the left where the title would be, plus the Terminal/Space
switch and Refresh; rows with number, title,
branch, author, review state, age, and a check summary (`✓` pass, `×` fail, `•` pending, `–` skip, with counts). Expanding a
PR shows checks grouped by name and the latest run, with a link that opens in the browser. The panel marks a failing check
on the activity bar with a count and `blocked` tone. Empty, no-git, `gh` missing, signed-out and rate-limit states are one
line. Repositories without a PR are folded into one `No PR (N)` section, like `On default branch (N)`; repos with a PR,
failing or pending checks stay at the top.

**How it behaves:**

Click a PR row to expand its checks; click a check/run link to open the GitHub URL in this computer's browser. **Mine**
shows PRs authored by the signed-in `gh` user. Refresh on mount/shown/focus/a terminal in the panel's folder finishing a command, and on the backstop
(default 180 s for this panel, never below 15 s). A user refresh shows busy after 400 ms; automatic refreshes are silent.
Opening a link uses `explorer.exe`, `open` or `xdg-open` and never fetches the page itself. A PR with no
checks says so; a cancelled run is shown as skipped, not failed.

**Built from:**

`main.js` + `lib.js` + `refresh.js`; no props. Herdr: `focused`, `panes`, `spaces`, `exec`, `appHome`, `readTextFile`,
`shared`/`setShared`, `theme`, `layout`, `terminals`; network URLs opened through the workspace opener. Shared keys
`badge.jig-prs` and the tab's own state. Config `${appHome()}/mods/jig-prs/config.json` (refresh settings).

Programs: `gh` (`pr list`, `pr view`, `run list`/`run view`; **Mine** runs `gh search prs --author=@me` across GitHub), `sh` for the script,
`timeout`/`gtimeout` when present (20 s). Network: `gh` to GitHub (read-only API); no `git fetch`. Files read: the repository's git metadata for the workspace listing and `config.json`; nothing is written to the repository.

The standalone listing has `"place": "none"`, so a layout block with `content.mod = "jig-prs"` is required; with no
activity bar there is no badge. The panel has the **Terminal/Space** switch (per space): Terminal follows the focused
terminal's folder, Space uses the space's folder. Built from Herdr's `mods/workspace-chrome/*.svg` icons.

**Header:** all git panels use one 42 px shared header: title, optional Terminal/Space switch, and a Refresh whose
tooltip says `Refresh · read N ago` (`Refresh` before the first read, `Reading…` while busy). Git, History, PR & CI and
Worktrees show the switch; Review has title and Refresh only. An error line sits under the header, above the kept rows.

**Watch out:**

Requires `gh` on PATH and signed in; missing auth/rate limits are reported, not retried. **Mine** searches all of GitHub for
PRs authored by `@me`, not only the demo folder, so the standalone preview is demo data; it makes a network call to GitHub's
search API. Discovery reads pass a 20 s timeout and `gh` calls 60 s; Herdr's deadline is 5 s later (600 s at most on 0.1.14+), while 0.1.13 or older cuts at 30 s default. A slow
GitHub call. No write actions: no comment, approve, merge or rerun. A Windows-local space without WSL has no POSIX `sh`.
The API's own limits apply; a very large PR list is capped and says so. Link opening depends on the desktop opener.

**Done when:**

`herdr-app check mods/jig-prs` passes; make the demo repo with `git init orders-api && git -C orders-api commit --allow-empty -m 'first'`; a folder with a GitHub
remote shows PRs and checks (the repo preview uses recorded demo data); **Mine** switches; the first tab is **Open** in one repository and **Workspace** on many; a
failure count appears on the activity bar; a missing `gh`, signed-out and rate-limit response each show one line; a check
link opens in the browser; refresh twice leaves the rows stable.
