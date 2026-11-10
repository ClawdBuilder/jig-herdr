# PR & CI

Pull requests and their checks for the space's folder, read through `gh`. The **Workspace** tab covers the folder's repositories; **Mine** lists your open PRs across GitHub. Read-only, with no merge, approve, comment or rerun. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![PR & CI](preview.png)

Preview: the public ClawdBuilder/jig-herdr repository with a real open pull request.

**Install:** add the listing from herdr.dev, or copy the repository's `mods/jig-prs` into your Herdr config folder's `mods/`. Put a layout block with `content.mod = "jig-prs"` where the panel should sit; without an activity bar there is no badge.

**What you see:**

A 42 px header titled **PR & CI** with Refresh. A 32 px context card under it names the folder, shows **follows the focused terminal** or **uses the space's folder**, and carries the machine pill. A full-width segmented control reads **Workspace n** and **Mine n**; a grey line counts `N repos · N non-default branches · N PRs`.

Workspace groups are **Needs fixing** (`ansi1`), **Waiting** (`ansi3`), **Ready** (`ansi2`), **Merged or closed**
(`muted`), **No PR** (`muted`) and **No remote / not on GitHub** (`muted`). A merged or closed row keeps its title,
`#34`, a `merged`/`closed` chip and its age. A default branch with no PR is a **No PR** row. A foldable group has a 26 px right-aligned **Show**/**Hide** button; a lone group is open. A row is 48 px with a dot in the group colour, the PR title, and `repo · #482 · branch`; chips show `✓/×/•` check counts (or `no checks yet`), the review state and `+41 −12`; an empty chip is never drawn. A row with no PR uses the repo name as its title and just the branch in its detail (`detached` or `no upstream` where they apply). Opening a PR row lists its failing check names, then **Open on GitHub** (primary) and **Copy link** (secondary).

The 40 px footer counts open PRs and failing ones. Empty, no-git, `gh` missing, signed-out and rate-limit states are one line. `↑`/`↓` move the active row, Enter/Space opens it, Esc closes rows. While a new folder or follow mode is read, the list is a four-row skeleton.

**How it behaves:**

**Workspace** finds each repository in the folder and asks for the open PR of its feature branch; **Mine** uses `gh search prs --author=@me` across GitHub, not only this folder. Opening a PR row shows the failing checks; **Open on GitHub** uses `explorer.exe`, `open` or `xdg-open`; **Copy link** writes the URL. No action writes to GitHub. A local-path remote, or one on a known other host (`gitlab.com`, `bitbucket.org`, Azure DevOps), is parked as no remote; a GitHub "Could not resolve to a Repository" answer parks as not on GitHub. Refresh on mount, when shown, on focus, when a terminal in the folder finishes, and on the backstop (default 180 s, never below 15 s). A click-started run shows busy after 400 ms. A same-key refresh keeps rows; a context change drops them and starts the new read at once. An identical read skips the rebuild and its notify.

**Built from:**

`main.js` + `lib.js` + `panel-kit.js` + `panel-header.js` + `refresh.js` + `follow.js`; no props. Herdr: `focused`, `panes`, `spaces`, `exec`, `appHome`, `readTextFile`, `settings`, `shared`/`setShared`, `theme`, `layout`, `terminals`. Shared keys `badge.jig-prs` and the tab state. Config `${appHome()}/mods/jig-prs/config.json` (refresh settings).

Programs: `gh` (`pr list`, `pr view`, `run list`/`run view`; **Mine** runs `gh search prs`), `sh` for the scan, `timeout`/`gtimeout` when present. Network: `gh` to GitHub (read-only). Files read: the folder's git metadata and `config.json`; nothing in the repository is written. Icons come from Herdr's `mods/workspace-chrome/*.svg`.

**Header:** all git panels use one 42 px shared header: title and Refresh, whose tooltip says `Refresh · read N ago`
(`Refresh` before the first read, `Reading…` while busy). Git, History, PR & CI, Worktrees and Review's side panel put
the Terminal/Space switch in a 32 px context card under the header; a Review tab has title and Refresh only. An error
line sits under the header, above the kept rows.

**Watch out:**

Requires `gh` on PATH and signed in. **Mine** searches all of GitHub for `@me`, so its results are broader than the folder. A slow GitHub call can hit the 60 s network budget; Herdr 0.1.13 or older cuts at 30 s. Discovery reads use a 20 s timeout. A Windows-local space without WSL has no POSIX `sh`. It never merges, approves, comments, reruns or writes checks.

**Done when:**

`herdr-app check mods/jig-prs` passes; a folder with a GitHub remote shows Workspace rows and checks; **Mine** switches and counts; a folder with only local or non-GitHub remotes settles on **No remote / not on GitHub** and never stays on “Reading…”; switching terminals shows the skeleton then the new rows within ~2 s; a missing `gh`, signed-out and rate-limit response each show one line.
