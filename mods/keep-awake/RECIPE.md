# Keep awake

A sun in Herdr's tab bar that keeps this computer from going to sleep on its idle timer: off, on until switched off or
Herdr closes, or while any agent anywhere is working or blocked. A tiny helper process holds the request, so nothing
about the power plan, the registry or the display is changed, and no administrator right is needed.
![Keep awake](preview.png)

## What you see

- **In the tab bar**, beside `Panel` and `Jig`, a 26 px sun. Off it is dim; while the request is held it takes the accent
  colour and a selected background. Its tooltip names the mode and whether the computer will sleep, and says a right click
  opens the modes.
- **The popup** (330×196, at the pointer): `Keep awake` and `holding off sleep` or `not holding`, then three rows — `Off`,
  `On` ("until you switch it off, or Herdr closes"), `While agents work` ("and 5 min after it stops") — the current one
  ticked, and a line saying the display may still turn off and that a closed lid or the power button still sleeps the
  computer.
- Nothing else: the worker has no panel of its own. In the layout it sits in a 0 px block of the sidebar, unseen.

## How it behaves

- **A left click** on the sun turns `On` when the mode is `Off`, and `Off` for either working mode (the brief's Off ↔ On).
  **A right click** opens the popup; picking a row sets that mode and closes it. `Ctrl+Shift+Alt+K` cycles Off → On →
  While agents work → Off through `keep-awake.cycle`.
- **Off** holds no request. **On** holds it until the mode changes or Herdr exits. **While agents work** holds it while any
  agent in any space, tab or machine is `working` or `blocked`, and for `idleMinutes` (5 by default) after the last one
  stops, so a status flicker or a quick hand-over never stops and starts the helper.
- **The display may still turn off**: only the system is kept awake, unless `display: true`, which also keeps the screen on.
  A closed lid or the power button still sleeps the computer.
- **One helper only.** Its PID lives in `shared("keep-awake.helper")`; a second copy, a reload or a restart reuses it while
  it is alive and its command line still names this mod's script, and starts one otherwise. A PID that now belongs to
  another process is forgotten, never killed.
- **It ends with Herdr.** The helper watches Herdr's process and exits within about 20 seconds when it is gone; the mod
  also writes `stop` to its stop file and kills it on close. Its OS request is tied to its own process, so a crash cannot
  leave the computer awake for ever.
- **Failures** (no Herdr process found, a helper that would not start) post one warning notification and leave the mode as
  it was.

## Built from

- `main.js`: the worker (`init`, a 1 s timer, `nextCommand()` for `cycle`/`on`/`off`/`agents`, `close`) and the popup
  (`{ menu: true }`). It reads `agents()`, `window().platform`, `appHome()`, `shared("keep-awake.mode")`, writes
  `shared("keep-awake.active")` and `shared("keep-awake.helper")`, reads and writes `keep-awake.stop` in the app folder,
  and runs `exec` on Herdr's own computer (never on a space's) for the helper, `appPidCommand`, `aliveCommand`,
  `commandLineCommand` and `stopCommand`.
- `lib.js`: the pure parts — `modeOf`, `toggleMode`, `nextMode`, `tooltip`, `anyBusy`, `decide` (the idle timer),
  `parseConfig`, `parsePid`, `isHelper`, `helperAction`, and the commands for each platform:
  - **Windows:** `powershell -NoProfile -Command "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList … -WindowStyle
    Hidden -PassThru; $p.Id"`, which returns at once and prints the hidden process's PID. It runs `keep-awake.ps1`, which
    calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED])` and repeats it every 20 s.
  - **macOS:** `caffeinate -i [-d] -w <herdr pid>` in the background (`sh -c 'nohup … & echo $!'`).
  - **Linux:** `systemd-inhibit --what=sleep[:idle] --why="Herdr keep awake" --mode=block sleep infinity` the same way.
- `keep-awake.ps1`: the Windows helper. It exits on the stop file (`stop`), when the owner PID is gone, or when killed, and
  clears the request on the way out.
- `keep-awake.svg`: the sun, a one-colour glyph drawn in the text colour.
- `config.json`: `{ "idleMinutes": 5, "display": false }`, read at start and every minute.
- **herdr functions used:** `agents`, `appHome`, `closeOverlay`, `exec`, `nextCommand`, `notify`, `props`, `readTextFile`,
  `setShared`, `shared`, `theme`, `window`, `writeTextFile`. The tab bar (`jig-tabs`) only writes
  `shared("keep-awake.mode")` and opens the popup; every layout reaches the same worker through that shared state.

## Watch out

- **Only Windows was tried on a real computer** here. macOS and Linux build the right command (tested), but caffeinate and
  systemd-inhibit were not run: try them on those systems.
- **A lid or the power button still sleeps the computer.** No software can prevent that without changing the power plan,
  and this mod changes no setting.
- **`powercfg /requests` needs an elevated prompt** to show the request; without it the tool refuses, which is not a sign
  that nothing is held.
- **Herdr's own PID is found by process name** (`herdr-app`); with two windows of two installs, the first is watched.
- **A helper started while no Herdr process is found is not started at all** (one warning), rather than a request no
  process would ever end.
- **The stop file is `keep-awake.stop` in the app folder**, next to `shared.json`; a helper restarted by hand must use the
  same script path or the mod will not recognise it as its own.
- **The tab bar is `jig-tabs`**, which this repository owns; the popup is `openOverlay({ mod: "keep-awake", kind: "popup",
  props: { menu: true } })`.

## Done when

- `herdr-app check mods/keep-awake` passes, and the sun appears in the tab bar of the `jig` layout, dim.
- Turning it On shows a lit sun, exactly one hidden `powershell.exe` whose command line runs `keep-awake.ps1` with Herdr's
  PID, and `shared("keep-awake.active")` becomes `true`; Off ends that process and clears both values.
- Reloading the mod reuses the same PID; killing the helper makes the mod start one new helper within ~10 seconds.
- With a terminal reporting `working` (an agent), While agents work holds the request, and `idleMinutes` after the last
  agent stops it releases it — `active` goes `false` and the helper is gone.
- The helper exits when its owner process does, and when the stop file says `stop`.
- `herdr/test` passes, and `npm run check` and `npm test` pass.
