# Changelog

## [Unreleased]

### Added

- A **Keep awake** sun in the tab bar holds this computer awake: off, on until it is switched off or Herdr closes, or while
  any agent is working or blocked (and `idleMinutes`, 5 by default, after the last one). A hidden PowerShell
  (`SetThreadExecutionState`), `caffeinate` or `systemd-inhibit` holds the request, one at a time, on the computer Herdr
  runs on; it ends with Herdr, changes no setting, and a recorded PID is killed only after it verifies as this mod's helper.
  A `Keep screen on` switch in its popup (on by default) writes `mods/keep-awake/config.json` (`display`), which also carries
  `idleMinutes`, and restarts the helper at once; the sun's tooltip says whether the screen is kept on. `Ctrl+Shift+Alt+K`
  cycles the modes.

### Changed

- The Changes panel (`repo-changes`) lists the folder of the focused terminal, not the space's, and has a header toggle to
  follow the terminal or the space for each space. Each checkout shows its ahead and behind and its last commit, one line per
  checkout, with worktrees folded under their repo (remembered) and the last commit only under the focused one. It can
  fetch, pull, push or publish its branch; every send asks first in a dialog that names git's real destination
  (`pushRemote`, `push.default`) and lists the commits, never pushes a branch onto a differently named one, and runs one
  action at a time per checkout. `config.json` gains `remote`, `networkTimeoutSeconds` and `rowDetail`.

- Initial split from Jig's `herdr/` folder, with the layout, mods and themes.
- The Context panel reads `contracts/requests.js` and the theme build reads `contracts/palettes.json` from the published Jig
  package, not relative paths into Jig.
- **TODO:** the dev dependency is a local tarball until `@clawdbuilder/jig@0.5.1` is released with the contracts; then pin
  `0.5.1`.
