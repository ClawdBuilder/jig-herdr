# jig-herdr

Herdr panels for git work: what changed, the commit history, pull requests and CI, linked worktrees, a review of changed files,
files, and a switch that keeps the computer awake. The generic panels and the **Jig Workbench** layout work without Jig.
The Jig layout adds the Pi session panels.

**No Jig required** for Git, History, PR & CI, Worktrees, Review, Files and Keep awake, or for the Jig Workbench layout.

![The Jig Workbench: sidebar, activity bar, panels and terminal](preview.png)

## With Jig

The full Jig layout adds **Work** (tickets and outputs), **Context** (usage, tools and skills), the Jig tab bar and theme
sync. Those panels read Jig's session files and its published contracts; the generic panels do not.

## Install

From this checkout, into your Herdr config folder:

```bash
node scripts/install.ts [herdr-folder]
```

It copies `layouts/`, `mods/` and `themes/`, merges its key bindings, and leaves your `config.json` values alone.
When an old `repo-changes`/`repo-history`/`repo-prs`/`repo-worktrees`/`repo-review`/`keep-awake`/`file-view` folder is
present, it carries that `config.json` over to the new name once: a value already set in the new config stays, old values
fill what it lacks, and defaults fill the rest. The old folder is kept because the config is yours.

`--dry-run` shows what would happen. `--force` replaces files this script did not write, but never a `config.json`.
`--remove-old` deletes an old renamed mod folder once its config has been fully carried over; it is off by default and
never deletes one with keys still missing.

From **herdr.dev**: coming soon. The listings will be installable there; until then, use the checkout command above.

## What each panel needs

| Panel      | Needs                      | Reads and runs                                                                                                |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Git        | `git`, POSIX `sh`          | The focused folder's git metadata and `config.json`; stages, commits, fetches, pulls and pushes on your click |
| History    | `git`, POSIX `sh`          | Git log, show and status; opens a diff in a terminal; no writes                                               |
| PR & CI    | `gh` signed in, POSIX `sh` | GitHub PRs and checks through `gh`; opens links in your browser; no writes                                    |
| Worktrees  | `git`, POSIX `sh`          | Worktree metadata; removes a ready worktree and its merged branch after a confirm; no network                 |
| Review     | `git`, POSIX `sh`          | A repository's changed files and diffs; stages, unstages or discards a file; no commit                        |
| Files      | POSIX `sh`                 | The focused folder; opens a file in a read-only tab at any path                                               |
| Keep awake | Platform sleep tool        | Runs `powershell`/`taskkill` on Windows, `caffeinate` on macOS, `systemd-inhibit` on Linux; no network        |

`timeout` (Linux) or `gtimeout` (macOS) is used when present for 20-second command caps; without it, the command runs
unbounded up to Herdr's own 30-second cap. Everything runs on the machine the space is on. Linux, WSL and macOS work; a
Windows-local space without WSL has no POSIX `sh` and the git panels will not work.

Network commands longer than 30 seconds need **Herdr 0.1.14 or newer**; older versions ignore the `exec` timeout and
still stop them at 30 seconds.

The panels show what is there: no approval, no merge, no comment, no write except the explicit stage, commit, discard,
worktree-remove and fetch/pull/push actions above.

## Development

```bash
npm ci
npm run check
npm test
```

`npm run check` includes the commit-email guard. It checks author and committer emails against the private word list in
`JIG_SCAN_WORDS` or `~/.config/jig/scan-words.txt`; with no list, as in public CI, it skips.

## Licence

MIT. `jig-files` and `jig-file-view` are derived from Herdr's `files` and `file-view` (Apache-2.0); their headers and the
per-listing `NOTICE` stay.
