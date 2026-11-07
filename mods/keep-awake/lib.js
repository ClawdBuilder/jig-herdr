// Helpers of the Keep awake mod that need no Herdr: the mode and its idle timer, the command that holds the computer
// awake on each platform, the processes it keeps track of, and config.json. They live apart from main.js so the tests
// can load them outside Herdr.
//
// The helper is a process on the machine Herdr runs on: Windows' SetThreadExecutionState, macOS' caffeinate, or
// systemd-inhibit on Linux. It exits when the mod kills it, when the stop file says "stop", or when Herdr's process is
// gone, so a crash cannot leave the computer awake for ever. No power plan, registry or administrator right is used.

/** The three modes, in the order a key press cycles them. */
export const MODES = ["off", "on", "agents"];

/** How the modes are named to a person. */
export const MODE_LABEL = { off: "Off", on: "On", agents: "While agents work" };

/** config.json next to the mod: `{ idleMinutes, display }`. A wrong field keeps its default and is reported. */
const DEFAULTS = { idleMinutes: 5, display: false };

/** The mode value in shared state, "off" when it is anything else. */
export const modeOf = (value) => (MODES.includes(value) ? value : "off");

/** What a left click on the control does: Off becomes On, On and While agents work become Off. */
export const toggleMode = (mode) => (modeOf(mode) === "off" ? "on" : "off");

/** What the cycling key does: Off, On, While agents work, Off. */
export const nextMode = (mode) => {
    const at = MODES.indexOf(modeOf(mode));
    return MODES[(at + 1) % MODES.length];
};

/** The button's tooltip: the mode, and whether the computer is being held awake now. */
export const tooltip = (mode, active) =>
    `Keep awake: ${MODE_LABEL[modeOf(mode)]}${active ? " — the computer will not sleep" : " — off"}\n` +
    "Right-click for the modes";

/** Whether any agent anywhere is working or blocked: what keeps "While agents work" on. */
export function anyBusy(agents) {
    return (agents ?? []).some((a) => a?.status === "working" || a?.status === "blocked");
}

/**
 * The state a mode has at `now`: `{ active, busyAt }`. "On" is always active; "While agents work" is active while an
 * agent is busy and for `idleMs` after the last one stopped (so a status flicker or a quick hand-over never stops and
 * starts the helper), and `busyAt` remembers that last moment.
 */
export function decide({ mode, busy, now, busyAt, idleMs }) {
    const at = Number.isFinite(busyAt) ? busyAt : 0;
    if (mode === "on") return { active: true, busyAt: at };
    if (mode !== "agents") return { active: false, busyAt: at };
    if (busy) return { active: true, busyAt: now };
    return { active: now - at < Math.max(0, idleMs) && at > 0, busyAt: at };
}

/** `value` as one POSIX shell word. */
export function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** A PowerShell single-quoted string, so a path with a quote in it survives. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** The first whole number in some output, or null. */
export function parsePid(text) {
    const said = String(text ?? "").trim();
    const match = /\b(\d{2,10})\b/.exec(said);
    return match ? Number(match[1]) : null;
}

/**
 * The command that starts the helper, as `{ cmd, args }` for Herdr's exec. It prints the helper's PID and returns at
 * once on every platform: Windows starts a hidden PowerShell through Start-Process, macOS and Linux put their program in
 * the background from a shell (`nohup … & echo $!`).
 */
export function startCommand(platform, { ownerPid, script, stopFile, display }) {
    if (platform === "windows") {
        const flags = [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-Owner",
            String(ownerPid),
            "-StopFile",
            stopFile,
            "-Display",
            display ? "1" : "0",
        ];
        const list = flags.map(psQuote).join(",");
        return {
            cmd: "powershell",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${list} -WindowStyle Hidden -PassThru; $p.Id`,
            ],
        };
    }
    const program =
        platform === "macos"
            ? ["caffeinate", "-i", ...(display ? ["-d"] : []), "-w", String(ownerPid)]
            : [
                  "systemd-inhibit",
                  `--what=${display ? "sleep:idle" : "sleep"}`,
                  "--why=Herdr keep awake",
                  "--mode=block",
                  "sleep",
                  "infinity",
              ];
    return { cmd: "sh", args: ["-c", `nohup ${program.map(shQuote).join(" ")} >/dev/null 2>&1 & echo $!`] };
}

/** How to find Herdr's own process on this machine (its PID, printed alone). */
export function appPidCommand(platform) {
    return platform === "windows"
        ? {
              cmd: "powershell",
              args: [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  "(Get-Process -Name herdr-app -ErrorAction SilentlyContinue | Select-Object -First 1).Id",
              ],
          }
        : { cmd: "sh", args: ["-c", "pgrep -x herdr-app 2>/dev/null | head -n 1"] };
}

/** How to ask whether a PID is alive: exit 0 when it is. */
export function aliveCommand(platform, pid) {
    const id = Math.max(1, Number(pid) || 0);
    return platform === "windows"
        ? {
              cmd: "powershell",
              args: [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `if (Get-Process -Id ${id} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
              ],
          }
        : { cmd: "sh", args: ["-c", `kill -0 ${id} 2>/dev/null`] };
}

/** How to read a PID's command line, to tell our helper from a reused PID. */
export function commandLineCommand(platform, pid) {
    const id = Math.max(1, Number(pid) || 0);
    return platform === "windows"
        ? {
              cmd: "powershell",
              args: [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `(Get-CimInstance Win32_Process -Filter 'ProcessId=${id}' -ErrorAction SilentlyContinue).CommandLine`,
              ],
          }
        : { cmd: "sh", args: ["-c", `ps -p ${id} -o command= 2>/dev/null`] };
}

/** How to stop the helper: killed, with any child it started. */
export function stopCommand(platform, pid) {
    const id = Math.max(1, Number(pid) || 0);
    return platform === "windows"
        ? { cmd: "taskkill", args: ["/PID", String(id), "/T", "/F"] }
        : { cmd: "sh", args: ["-c", `kill ${id} 2>/dev/null`] };
}

/** Whether a process's command line is our helper: it names the script's file name. */
export function isHelper(commandLine, script) {
    const name = String(script ?? "")
        .split(/[\\/]/)
        .pop();
    return Boolean(name) && String(commandLine ?? "").includes(name);
}

/** What to do about the recorded helper: keep it, forget a PID that is now someone else's, or start a fresh one. */
export function helperAction({ recorded, alive, commandLine, script }) {
    if (!recorded?.pid) return "start";
    if (!alive) return "start";
    return isHelper(commandLine, script) ? "reuse" : "stale";
}

/** config.json: `idleMinutes` (0 to 1440, fractions allowed for a quick test) and `display` (keep the screen on too). */
export function parseConfig(text) {
    const config = { ...DEFAULTS, problems: [] };
    if (text == null || text.trim() === "") return config;
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        config.problems.push(`config.json is not valid JSON: ${e.message}`);
        return config;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        config.problems.push("config.json must hold an object");
        return config;
    }
    if (raw.idleMinutes != null) {
        const n = Number(raw.idleMinutes);
        if (Number.isFinite(n) && n >= 0 && n <= 1440) config.idleMinutes = n;
        else config.problems.push('"idleMinutes" must be a number from 0 to 1440');
    }
    if (raw.display != null) {
        if (typeof raw.display === "boolean") config.display = raw.display;
        else config.problems.push('"display" must be true or false');
    }
    return config;
}

/** The path of the helper's stop file, next to Herdr's own state: `${appHome}/keep-awake.stop`. */
export const stopFileIn = (appHome) => `${String(appHome).replace(/\/+$/, "")}/keep-awake.stop`;

/** The helper's script in this mod's folder, named for the platform. */
export const helperScriptIn = (appHome) => `${String(appHome).replace(/\/+$/, "")}/mods/keep-awake/keep-awake.ps1`;

/** How long "While agents work" stays on after the last busy agent, in milliseconds. */
export const idleMsOf = (config) => Math.max(0, Number(config?.idleMinutes) || 0) * 60000;
