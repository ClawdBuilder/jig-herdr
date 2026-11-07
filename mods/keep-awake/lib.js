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

/** config.json next to the mod: `{ idleMinutes, display }`. A wrong field keeps its default and is reported. A new install
 * keeps the screen on too (`display: true`), which the popup's switch can turn off. */
const DEFAULTS = { idleMinutes: 5, display: true };

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
export function startCommand(platform, { ownerPid, script, stopFile, display, token, recordFile }) {
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
            "-OwnerName",
            "herdr-app",
            "-Token",
            token ?? "",
            "-RecordFile",
            recordFile ?? "",
        ];
        // Each argument is quoted for the child's command line (Start-Process joins the list with spaces, so an
        // unquoted path with spaces would break -File), then quoted as one PowerShell string.
        const childQuoted = flags
            .map((value) => `"${String(value).replace(/"/g, '\\"')}"`)
            .map(psQuote)
            .join(",");
        return {
            cmd: "powershell",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$q = @(${childQuoted}) -join ' '; $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $q -WindowStyle Hidden -PassThru; $p.Id`,
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
                  "sh",
                  "-c",
                  `while kill -0 ${Math.max(1, Number(ownerPid) || 0)} 2>/dev/null; do sleep 20; done`,
                  "keep-awake",
              ];
    return { cmd: "sh", args: ["-c", `nohup ${program.map(shQuote).join(" ")} >/dev/null 2>&1 & echo $!`] };
}

/** How to find Herdr's own process on this machine (its PID, printed alone). The process this command runs in is a
 * child of the app that started the mod, so its parent is the right one when two windows are open; the name lookup is
 * the fallback. */
export function appPidCommand(platform) {
    return platform === "windows"
        ? {
              cmd: "powershell",
              args: [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  '$me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"; $p = $me.ParentProcessId; ' +
                      '$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; ' +
                      "if ($parent -and $parent.Name -eq 'herdr-app.exe') { $p } else { " +
                      "(Get-Process -Name herdr-app -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).Id }",
              ],
          }
        : {
              cmd: "sh",
              args: [
                  "-c",
                  'if [ "$(ps -p "$PPID" -o comm= 2>/dev/null)" = "herdr-app" ]; then echo "$PPID"; else pgrep -x herdr-app 2>/dev/null | head -n 1; fi',
              ],
          };
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
        ? { cmd: "taskkill", args: ["/PID", String(id), "/F"] }
        : { cmd: "sh", args: ["-c", `kill ${id} 2>/dev/null`] };
}

/** Whether a process's command line names this mod's script (the Windows helper's own marker). */
export function isHelper(commandLine, script) {
    const name = String(script ?? "")
        .split(/[\\/]/)
        .pop();
    return Boolean(name) && String(commandLine ?? "").includes(name);
}

/**
 * Whether a process's command line is this mod's helper on that platform, owned by that Herdr: the PowerShell running
 * `keep-awake.ps1` with `-Owner <owner>`; `caffeinate … -w <owner>`; or the `systemd-inhibit` line whose `--why` is ours
 * (the new owner loop, or the old `sleep infinity` one it replaces).
 */
export function matchesHelper(commandLine, platform, { script, owner } = {}) {
    const said = String(commandLine ?? "");
    if (!said) return false;
    // The owner may be bare or quoted ("13284"), as Windows' child-quoted arguments are.
    const owned =
        owner === undefined || owner === null || new RegExp(`(^|[\\s"'])${Number(owner)}([\\s"']|$)`).test(said);
    if (platform === "windows") return isHelper(said, script) && owned;
    if (platform === "macos")
        return /(^|[\\/\s"])caffeinate(?:\.exe)?(\s|$)/.test(said) && said.includes("-w") && owned;
    if (said.includes("Herdr keep awake") && said.includes("sleep infinity")) return true; // the older helper, ours
    return said.includes("Herdr keep awake") && said.includes("keep-awake") && owned;
}

/**
 * What to do about a recorded helper: "kill" only when it is alive and its command line is ours (with this owner);
 * "drop" when it is gone, its PID now belongs to another process, or the checks themselves failed — never an unverified
 * kill; "none" when there is no record.
 */
export function killDecision({ recorded, alive, commandLine, platform, script, owner }) {
    if (!recorded?.pid) return "none";
    if (alive !== true) return "drop";
    return matchesHelper(commandLine, platform, { script, owner: owner ?? recorded.owner }) ? "kill" : "drop";
}

/**
 * What a recorded helper is, without ever killing: "reuse" when it is alive and its command line is ours; "gone" when it
 * is not alive; "other" when its PID now belongs to a different process; "unknown" when the checks themselves failed or
 * the command line could not be read — the record is kept and another check waits, so a live helper is never duplicated
 * because one reading failed.
 */
export function recordState({ alive, commandLine, platform, script, owner }) {
    if (alive === false) return "gone";
    if (alive !== true) return "unknown";
    if (!commandLine) return "unknown";
    return matchesHelper(commandLine, platform, { script, owner }) ? "reuse" : "other";
}

/** Whether a display change must restart the helper now: it changed, one runs, and no release or start is under way. */
export const displayRestart = ({ previous, next, helperPid, starting, stopping, restarting }) =>
    previous !== next && Boolean(helperPid) && !starting && !stopping && !restarting;

/** What a copy of the mod does when it goes away: a popup copy holds nothing, and only the copy that started the helper
 * releases it (a copy loaded for a check, or one that only found it in shared state, takes nothing with it). */
export const closePlan = (menu, owned) => (menu || !owned ? "none" : "release");

/** The record of a helper that must be released when this copy goes away, or null. */
export const helperToRelease = (menu, recorded, owned) =>
    closePlan(menu, owned) === "none" ? null : (recorded ?? null);

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

/** config.json's text with `display` set, for the popup's switch: the other settings and unknown fields are kept, and an
 * unreadable file starts from the defaults. */
export function setDisplay(text, display) {
    let raw = {};
    try {
        const parsed = JSON.parse(text ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    } catch {
        // an unreadable file is replaced by the defaults below
    }
    const config = parseConfig(text);
    return `${JSON.stringify({ ...raw, idleMinutes: config.idleMinutes, display: Boolean(display) }, null, 4)}\n`;
}

/** The helper's stop file: `${appHome}/keep-awake.stop`, one file for every helper. Its content names the start that
 * wrote it ("run <token>", "stop <token>"), so a "stop" left by an earlier helper can never end a new one and nothing
 * accumulates. */
export const stopFileIn = (appHome) => `${String(appHome).replace(/\/+$/, "")}/keep-awake.stop`;

/** A stop line for a start token: "run <token>" or "stop <token>". */
export const stopLine = (action, token) => `${action}${token ? ` ${token}` : ""}`;

/** Whether a stop file's text ends the helper started with this token (a legacy "stop" ends any of ours). */
export function stopSays(text, token) {
    const said = String(text ?? "").trim();
    return said === "stop" || (Boolean(token) && said === `stop ${token}`);
}

/** Where the claim that one worker is starting a helper lives: `${appHome}/keep-awake.helper.json`. */
export const helperFileIn = (appHome) => `${String(appHome).replace(/\/+$/, "")}/keep-awake.helper.json`;

/** How long a start claim holds before another worker may take over. */
export const CLAIM_MS = 30000;

/** "held" while a fresh start claim is in this helper file, else "free" (empty, another phase, malformed or stale). */
export function claimState(text, now = Date.now(), ttl = CLAIM_MS) {
    let raw;
    try {
        raw = JSON.parse(text ?? "null");
    } catch {
        return "free";
    }
    if (!raw || typeof raw !== "object" || raw.phase !== "claim") return "free";
    const at = Number(raw.at);
    return Number.isFinite(at) && now - at >= 0 && now - at < ttl ? "held" : "free";
}

/** The text of a start claim, for the helper file. */
export const claimText = (token, now = Date.now()) => `${JSON.stringify({ phase: "claim", token, at: now })}\n`;

/**
 * The display setting to use: the file wins on the first read of a session (an edit made while Herdr was closed) and
 * whenever a later read shows a different value the person wrote; otherwise the session's shared value stands.
 */
export function displaySource({ firstRead, edited, fileDisplay, sharedDisplay }) {
    if (firstRead) return fileDisplay;
    if (edited) return fileDisplay;
    return typeof sharedDisplay === "boolean" ? sharedDisplay : fileDisplay;
}

/** The helper's script in this mod's folder, named for the platform. */
export const helperScriptIn = (appHome) => `${String(appHome).replace(/\/+$/, "")}/mods/keep-awake/keep-awake.ps1`;

/** How long "While agents work" stays on after the last busy agent, in milliseconds. */
export const idleMsOf = (config) => Math.max(0, Number(config?.idleMinutes) || 0) * 60000;
