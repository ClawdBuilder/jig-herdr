# Keep awake

A tiny, invisible mod that keeps the computer Herdr runs on awake: off, on until switched off or Herdr closes, or while any
agent is working or blocked. It is controlled by a key, not a panel. From Jig (https://github.com/ClawdBuilder/jig). No Jig
required.

![Keep awake](preview.png)

**What you see:**

**The standalone mod draws nothing at all.** Its only control is the key `Ctrl+Shift+Alt+K`, which cycles **Off**, **On**
and **While agents work**. In the Jig layout the sun in the tab bar is the visible control; the standalone mod has no tab
bar and no panel. The state is in Herdr's shared state (`jig-keep-awake.mode` and `jig-keep-awake.active`); the helper also owns the files
`${appHome()}/jig-keep-awake.stop` and `${appHome()}/jig-keep-awake.helper.json`. `Keep screen
on` is a config value (`display: true`), not a separate window.

**How it behaves:**

**It draws no panel**, so `Ctrl+Shift+Alt+K` is the whole standalone interface (the Jig layout's tab-bar sun is the same
control). The key cycles Off → On → While agents work → Off. `on` keeps the request until turned off or Herdr closes;
`agents` keeps it while any agent anywhere is working or blocked, plus `idleMinutes` (default 5) after the last one;
`off` stops it. Starting a helper writes `jig-keep-awake.helper` with its PID and owner; a second copy never starts
another. A stop file or a dead Herdr process ends the helper, so a crash cannot leave the machine awake indefinitely. The
mod checks the mode, agents and idle timer every second, verifies a running helper every 10 s, and trusts `config.json` for
60 s. No JavaScript timers: Herdr's `cx.timer` drives it.

**Built from:**

`main.js` + `lib.js`; no panel. Herdr: `agents`, `appHome`, `exec`, `run`, `shared`/`setShared`, `theme`, `layout`,
`openOverlay`/`closeOverlay`. Shared keys `jig-keep-awake.mode`, `.active`, `.helper`, `.display`, and the `cycle` command used by a tab bar;
`${appHome()}/jig-keep-awake.helper.json` is the helper's claim file, not a shared key. Config `${appHome()}/mods/jig-keep-awake/config.json`: `idleMinutes` (0–1440) and
`display` (keep the screen on too); defaults 5 and `true`.

Programs: on Windows `powershell`/`powershell.exe` (hidden `SetThreadExecutionState` child) and `taskkill`; on macOS
`caffeinate -i [-d] -w <owner>`; on Linux `systemd-inhibit` wrapped by `sh`, with `ps`, `pgrep`, `pkill` and `kill` for
ownership and stopping. Network: none. Files read/written: `${appHome()}/mods/jig-keep-awake/config.json`, the stop file and
the helper's state; the helper runs on Herdr's own machine, never a space's machine.

**Watch out:**

Herdr's 30 s `exec` cap is above the 8 s helper command limit; a failed start is reported and leaves the previous mode.
The helper depends on the platform tools above; a system without `caffeinate` or `systemd-inhibit` cannot hold the
request. The standalone mod has `"place": "none"` and no panel; a layout needs a 0 px block with
`content.mod = "jig-keep-awake"` (and the Jig layout's sun is in `jig-tabs`). A laptop lid close or power button still sleeps it. Windows-local without WSL is supported for this mod (it uses
PowerShell, not `sh`). The standalone mod has no visible confirmation of its own; use the key and check the shared state, or
the Jig layout's tab-bar sun. A stale helper is killed only after it verifies as this mod's own.

**Done when:**

`herdr-app check mods/jig-keep-awake` passes; `Ctrl+Shift+Alt+K` changes `jig-keep-awake.mode` through the three values;
with **On**, `jig-keep-awake.active` is true and a platform helper exists; switching Off removes it; closing Herdr leaves no
helper; with **While agents work**, a demo agent start/stop changes the state after `idleMinutes`; a second instance does not
start a second helper.
