# History

The commit graph of a repository, or a picker of repositories under a folder, with a lane gutter, commit details and a diff opened
beside. Read-only. From Jig (https://github.com/ClawdBuilder/jig). No Jig required.

![History](preview.png)

**What you see:**

A header with the repository or folder name, a scope switch (`branch` or `all` branches/remotes/tags), and Refresh. The
graph lists commit rows with a narrow coloured lane gutter, a short hash, subject, author and age; a type word (`feat`, `fix`, `docs`,
`refactor`, `perf`, `test`, `build`, `ci`, `revert`) gets a hue. A commit opens a detail pane with its message and files;
a file row or **Open diff** opens the diff in a terminal to the right. On a folder with many repositories, a list of
repositories and worktrees comes first, with the chosen one remembered in `jig-history.branch`. Empty and no-git states
are one calm line.

**How it behaves:**

Click a commit to select it and show its message/files; click a file or **Open diff** to open `git show` in a new terminal
placed right; **Refresh** rereads; the scope switch rereads with `--branches --remotes --tags HEAD` for All. The repository
picker searches under the focused folder, remembers the branch/repo by shared key, and reloads when the folder or branch
changes. Refresh on mount/shown/focus/a terminal in the panel's folder finishing a command, and on the backstop (default 60 s). A user-clicked
read shows busy after 400 ms; automatic reads do not. **Load more** reads the next page of commits; the graph is capped
and the panel says when it is cut.

**Built from:**

`main.js` + `lib.js` + `refresh.js`; no props. Herdr: `focused`, `panes`, `spaces`, `exec`, `run`, `appHome`,
`readTextFile`, `shared`/`setShared`, `openOverlay`, `theme`, `layout`. Shared key `jig-history.branch`. Config
`${appHome()}/mods/jig-history/config.json` (refresh settings) with bad fields reported.

Programs: `git log`, `git show`, `git status` on the space's machine; `sh` for the script; `timeout`/`gtimeout` when present
(20 s). Network: none; History never fetches. Files read: the chosen repository's `.git` metadata, its working tree for
status, and its config.

The header's branch control opens the branch picker (`Find a branch`), which filters local and remote branches. The
**Terminal / Space** switch is per space: Terminal follows the focused terminal's folder, Space uses the space's folder.
A layout block with `content.mod = "jig-history"` is required (`"place": "none"`).

**Watch out:**

The 30 s `exec` cap; `git` and a POSIX `sh` are required, so Windows-local without WSL is unsupported. A very large
history is paged, not all loaded; the lane gutter is a compact indication, not a full graph layout engine. Detached HEAD and unborn branches get a plain notice. No writes, no fetch, no network.

**Done when:**

Make the demo repo with `git init orders-api && git -C orders-api commit --allow-empty -m 'first'`, then a second branch and
a commit; `herdr-app check mods/jig-history` passes; the demo with two branches shows the lane gutter and details; the
scope switch changes the rows; a multi-repo folder shows the picker; **Open diff** opens a right terminal; **Load more**
appends; no-git and empty folders show their line; refresh leaves the graph unchanged when git has no new commits.
