// The Keep awake mod's pure parts (mods/keep-awake/lib.js): the mode state machine with its idle timer, the commands
// that hold a computer awake on each platform, the helper's process bookkeeping and config.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HERDR, load } from "./support.ts";

type Lib = Record<string, any>;

const lib = async () => load<Lib>("mods/keep-awake/lib.js");

test("a mode is off unless it is one of the three, and clicks and keys move it where the brief says", async () => {
    const { modeOf, toggleMode, nextMode, tooltip } = await lib();
    for (const mode of ["off", "on", "agents"]) assert.equal(modeOf(mode), mode);
    for (const wrong of [undefined, null, "", "On", "away", 3]) assert.equal(modeOf(wrong), "off", String(wrong));
    assert.equal(toggleMode("off"), "on");
    assert.equal(toggleMode("on"), "off");
    assert.equal(toggleMode("agents"), "off");
    assert.equal(nextMode("off"), "on");
    assert.equal(nextMode("on"), "agents");
    assert.equal(nextMode("agents"), "off");
    assert.equal(nextMode("nonsense"), "on");
    assert.match(tooltip("on", true), /^Keep awake: On — the computer will not sleep/);
    assert.match(tooltip("agents", false), /^Keep awake: While agents work — off/);
    assert.match(tooltip("on", true), /Right-click for the modes/);
});

test("while agents work is the busy ones only, and a flicker does not stop it before the idle time", async () => {
    const { anyBusy, decide } = await lib();
    assert.equal(anyBusy([{ status: "idle" }, { status: "done" }]), false);
    assert.equal(anyBusy([{ status: "working" }]), true);
    assert.equal(anyBusy([{ status: "blocked" }, { status: "idle" }]), true);
    assert.equal(anyBusy([]), false);
    assert.equal(anyBusy(undefined), false);

    const now = 1_000_000;
    assert.deepEqual(decide({ mode: "off", busy: true, now, busyAt: 0, idleMs: 300_000 }), {
        active: false,
        busyAt: 0,
    });
    assert.deepEqual(decide({ mode: "on", busy: false, now, busyAt: 0, idleMs: 300_000 }), { active: true, busyAt: 0 });
    assert.deepEqual(decide({ mode: "agents", busy: true, now, busyAt: 0, idleMs: 300_000 }), {
        active: true,
        busyAt: now,
    });
    // Busy a moment ago, not busy now: still on, and the timer keeps counting from that moment.
    assert.deepEqual(decide({ mode: "agents", busy: false, now: now + 1_000, busyAt: now, idleMs: 300_000 }), {
        active: true,
        busyAt: now,
    });
    // At the edge and past it, off; a mode nobody started yet is off, not "idle since the epoch".
    assert.equal(
        decide({ mode: "agents", busy: false, now: now + 300_000, busyAt: now, idleMs: 300_000 }).active,
        false,
    );
    assert.equal(
        decide({ mode: "agents", busy: false, now: now + 299_000, busyAt: now, idleMs: 300_000 }).active,
        true,
    );
    assert.equal(decide({ mode: "agents", busy: false, now, busyAt: 0, idleMs: 300_000 }).active, false);
    assert.equal(decide({ mode: "agents", busy: false, now, busyAt: now, idleMs: 0 }).active, false);
});

test("config.json keeps the screen on by default, and the popup's switch writes it back", async () => {
    const { parseConfig, setDisplay } = await lib();
    assert.deepEqual(parseConfig(null), { idleMinutes: 5, display: true, problems: [] });
    assert.deepEqual(parseConfig(""), { idleMinutes: 5, display: true, problems: [] });
    assert.deepEqual(parseConfig("{}"), { idleMinutes: 5, display: true, problems: [] });
    assert.deepEqual(parseConfig('{ "idleMinutes": 0.1, "display": false }'), {
        idleMinutes: 0.1,
        display: false,
        problems: [],
    });
    assert.equal(parseConfig('{ "idleMinutes": -1, "display": "yes" }').problems.length, 2);
    assert.equal(parseConfig("{").problems.length, 1);
    assert.match(parseConfig("{").problems[0], /not valid JSON/);
    const shipped = parseConfig(readFileSync(path.join(HERDR, "mods/keep-awake/config.json"), "utf8"));
    assert.deepEqual(shipped, { idleMinutes: 5, display: true, problems: [] });

    // The switch's write: the other settings and fields survive, and the result is valid JSON.
    assert.deepEqual(JSON.parse(setDisplay('{ "idleMinutes": 0.1, "display": true }', false)), {
        idleMinutes: 0.1,
        display: false,
    });
    assert.deepEqual(JSON.parse(setDisplay('{ "display": false, "theme": "x" }', true)), {
        idleMinutes: 5,
        display: true,
        theme: "x",
    });
    assert.deepEqual(JSON.parse(setDisplay("not json", false)), { idleMinutes: 5, display: false });
    assert.deepEqual(JSON.parse(setDisplay(null, true)), { idleMinutes: 5, display: true });
    // What the switch writes is what the next read and the restart use.
    for (const display of [true, false]) {
        const text = setDisplay('{ "idleMinutes": 2 }', display);
        assert.equal(parseConfig(text).display, display);
        assert.equal(parseConfig(text).idleMinutes, 2);
    }
});

test("the helper starts hidden and detached on Windows, and in the background on macOS and Linux", async () => {
    const { startCommand } = await lib();
    const where = {
        ownerPid: 4321,
        script: "C:/Users/Jane Doe/it's/keep-awake.ps1",
        stopFile: "C:/Users/Jane Doe/it's/keep-awake.stop",
        display: false,
        token: "abc123",
        recordFile: "C:/Users/Jane Doe/it's/keep-awake.helper.json",
    };
    const win = startCommand("windows", where);
    assert.equal(win.cmd, "powershell");
    const line = win.args.join(" ");
    assert.match(line, /Start-Process/);
    assert.match(line, /-WindowStyle Hidden/);
    assert.match(line, /-PassThru/);
    assert.match(line, /\$p\.Id/, "the launcher is told the hidden process's PID");
    assert.match(line, /-ArgumentList \$q/, "one properly quoted argument string, not a joined list");
    assert.match(line, /-join ' '/);
    assert.match(line, /keep-awake\.ps1/);
    assert.match(line, /-Owner/);
    assert.match(line, /4321/);
    assert.match(line, /-OwnerName/, "the helper checks the owner's process name too");
    assert.match(line, /-Display/);
    // Each argument is quoted for the child command line, so a folder with a space (and a quote for PowerShell) works.
    assert.match(line, /"C:\/Users\/Jane Doe\/it''s\/keep-awake\.ps1"/);
    assert.match(line, /"C:\/Users\/Jane Doe\/it''s\/keep-awake\.stop"/);
    assert.match(line, /"0"/, "the display flag is a quoted word of its own");
    assert.match(line, /-Token/, "and the stop token, so a stale stop cannot end it");
    assert.match(line, /-RecordFile/, "and the record file, so an extra helper exits when another is recorded");
    assert.match(line, /"C:\/Users\/Jane Doe\/it''s\/keep-awake\.helper\.json"/);
    assert.match(startCommand("windows", { ...where, display: true }).args.join(" "), /"1"/);

    const mac = startCommand("macos", { ...where, ownerPid: 99 });
    assert.equal(mac.cmd, "sh");
    assert.match(mac.args[1], /nohup 'caffeinate' '-i' '-w' '99' >\/dev\/null 2>&1 & echo \$!/);
    assert.match(startCommand("macos", { ...where, ownerPid: 99, display: true }).args[1], /'-i' '-d' '-w'/);

    const linux = startCommand("linux", { ...where, ownerPid: 99 });
    assert.match(linux.args[1], /systemd-inhibit/);
    assert.match(linux.args[1], /--what=sleep'/);
    assert.match(linux.args[1], /--mode=block/);
    assert.match(linux.args[1], /while kill -0 99/, "the helper watches its owner itself");
    assert.match(linux.args[1], /'keep-awake'/, "and carries a marker the mod can recognise");
    assert.match(startCommand("linux", { ...where, ownerPid: 99, display: true }).args[1], /--what=sleep:idle'/);
});

test("every process question has one command per platform", async () => {
    const { appPidCommand, aliveCommand, commandLineCommand, stopCommand } = await lib();
    assert.match(appPidCommand("windows").args.join(" "), /ParentProcessId/, "the mod's own app first");
    assert.match(appPidCommand("windows").args.join(" "), /Get-Process -Name herdr-app/);
    assert.match(appPidCommand("macos").args[1], /\$PPID/, "the mod's own app first");
    assert.match(appPidCommand("macos").args[1], /pgrep -x herdr-app/);
    assert.match(aliveCommand("windows", 7).args.join(" "), /Get-Process -Id 7/);
    assert.match(aliveCommand("linux", 7).args[1], /kill -0 7/);
    assert.match(commandLineCommand("windows", 7).args.join(" "), /ProcessId=7/);
    assert.match(commandLineCommand("macos", 7).args[1], /ps -p 7 -o command=/);
    assert.deepEqual(stopCommand("windows", 7).args, ["/PID", "7", "/F"], "no /T: the helper has no tree to take");
    assert.match(stopCommand("linux", 7).args[1], /kill 7/);
    // A PID that is not a number cannot become a command of its own.
    assert.match(aliveCommand("linux", "x").args[1], /kill -0 1 /);
    assert.match(stopCommand("windows", -5).args[1], /^1$/);
});

test("a recorded helper is ours only per platform and owner, and is never killed unverified", async () => {
    const {
        parsePid,
        isHelper,
        matchesHelper,
        recordState,
        killDecision,
        closePlan,
        helperToRelease,
        stopFileIn,
        stopLine,
        stopSays,
        helperScriptIn,
        idleMsOf,
    } = await lib();
    assert.equal(parsePid("4321\n"), 4321);
    assert.equal(parsePid("nothing here"), null);
    assert.equal(parsePid(""), null);
    assert.equal(parsePid(undefined), null);
    assert.equal(parsePid(" 42 "), 42);
    assert.equal(parsePid("7"), null, "a one-digit number is not a PID");

    assert.equal(isHelper("powershell -File C:/x/keep-awake.ps1 -Owner 1", "C:/x/keep-awake.ps1"), true);
    assert.equal(isHelper("powershell -File C:/x/other.ps1", "C:/x/keep-awake.ps1"), false);
    assert.equal(isHelper("", "C:/x/keep-awake.ps1"), false);

    const script = "C:/x/keep-awake.ps1";
    const win = "powershell -File C:/x/keep-awake.ps1 -Owner 4321 -StopFile C:/x/s.123 -Display 1 -OwnerName herdr-app";
    const quotedWin =
        '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" "-NoProfile" "-File" "C:/x/keep-awake.ps1" "-Owner" "4321" "-Token" "abc"';
    assert.equal(matchesHelper(quotedWin, "windows", { script, owner: 4321 }), true, "quoted arguments count");
    assert.equal(matchesHelper(win, "windows", { script, owner: 4321 }), true);
    assert.equal(matchesHelper(win, "windows", { script, owner: 9999 }), false, "another Herdr's helper");
    assert.equal(
        matchesHelper("powershell -File C:/x/other.ps1 -Owner 4321", "windows", { script, owner: 4321 }),
        false,
    );

    const mac = "/usr/bin/caffeinate -i -d -w 4321";
    assert.equal(matchesHelper(mac, "macos", { owner: 4321 }), true);
    assert.equal(matchesHelper(mac, "macos", { owner: 9999 }), false);
    assert.equal(matchesHelper("caffeinate -u -t 600", "macos", { owner: 4321 }), false, "not ours to hold");

    const linux =
        "systemd-inhibit --what=sleep --why=Herdr keep awake --mode=block sh -c while kill -0 4321 2>/dev/null; do sleep 20; done keep-awake";
    assert.equal(matchesHelper(linux, "linux", { owner: 4321 }), true);
    assert.equal(matchesHelper(linux, "linux", { owner: 9999 }), false);
    assert.equal(
        matchesHelper("systemd-inhibit --what=sleep --why=Herdr keep awake --mode=block sleep infinity", "linux", {
            owner: 4321,
        }),
        true,
        "the older helper is recognised by its --why, so it can be released",
    );
    assert.equal(matchesHelper("systemd-inhibit --what=sleep --why=Other --mode=block sleep infinity", "linux"), false);
    assert.equal(matchesHelper("", "windows"), false);

    // The state of a record: rerun ours, forget what is gone or another process's, and wait when a check failed.
    assert.equal(recordState({ alive: false, commandLine: "", platform: "windows", script }), "gone");
    assert.equal(recordState({ alive: null, commandLine: "", platform: "windows", script }), "unknown");
    assert.equal(recordState({ alive: true, commandLine: "", platform: "windows", script }), "unknown");
    assert.equal(recordState({ alive: true, commandLine: "some other process", platform: "windows", script }), "other");
    assert.equal(recordState({ alive: true, commandLine: win, platform: "windows", script, owner: 4321 }), "reuse");

    // Only "kill" is alive, ours and verified; anything else drops the record without touching a process.
    assert.equal(killDecision({ recorded: null }), "none");
    assert.equal(killDecision({ recorded: { pid: 7 }, alive: false, platform: "windows", script }), "drop");
    assert.equal(
        killDecision({ recorded: { pid: 7 }, alive: null, platform: "windows", script }),
        "drop",
        "the check failed",
    );
    assert.equal(
        killDecision({
            recorded: { pid: 7, owner: 1 },
            alive: true,
            commandLine: "some other process",
            platform: "windows",
            script,
        }),
        "drop",
        "a reused PID",
    );
    assert.equal(
        killDecision({ recorded: { pid: 7, owner: 1 }, alive: true, commandLine: win, platform: "windows", script }),
        "kill",
    );

    assert.equal(closePlan(true, true), "none", "a popup copy holds nothing");
    assert.equal(closePlan(false, true), "release");
    assert.equal(closePlan(false, false), "none", "only the copy that started the helper releases it");
    assert.equal(helperToRelease(true, { pid: 7 }, true), null);
    assert.deepEqual(helperToRelease(false, { pid: 7 }, true), { pid: 7 });
    assert.equal(helperToRelease(false, { pid: 7 }, false), null);
    assert.equal(helperToRelease(false, null, true), null);

    assert.equal(stopFileIn("/home/me/.config/herdr-app/"), "/home/me/.config/herdr-app/keep-awake.stop");
    assert.equal(stopLine("run", "abc"), "run abc");
    assert.equal(stopLine("stop", "abc"), "stop abc");
    assert.equal(stopLine("stop", ""), "stop", "an older record without a token");
    assert.equal(stopSays("stop abc", "abc"), true);
    assert.equal(stopSays("stop abc\n", "abc"), true);
    assert.equal(stopSays("stop def", "abc"), false, "a stop for another start does not end this helper");
    assert.equal(stopSays("run abc", "abc"), false);
    assert.equal(stopSays("stop", "abc"), true, "an older helper's plain stop still says stop");
    assert.equal(stopSays("", "abc"), false);
    assert.equal(helperScriptIn("C:\\Users\\me\\h"), "C:\\Users\\me\\h/mods/keep-awake/keep-awake.ps1");
    assert.equal(idleMsOf({ idleMinutes: 5 }), 300_000);
    assert.equal(idleMsOf({ idleMinutes: 0 }), 0);
    assert.equal(idleMsOf({}), 0);
});

test("one start claim, and a config edit on start wins over the session value", async () => {
    const { claimState, claimText, displaySource, displayRestart, CLAIM_MS } = await lib();
    const now = 1_000_000;
    assert.equal(claimState(null, now), "free");
    assert.equal(claimState("", now), "free");
    assert.equal(claimState("not json", now), "free");
    assert.equal(claimState(`{"phase":"helper","pid":7,"at":${now}}`, now), "free");
    const text = claimText("token", now);
    assert.equal(JSON.parse(text).phase, "claim");
    assert.equal(claimState(text, now + 1), "held");
    assert.equal(claimState(text, now), "held");
    assert.equal(claimState(text, now - 1), "free", "a claim from the future is not one");
    assert.equal(claimState(text, now + CLAIM_MS), "free");
    assert.equal(claimState(text, now + CLAIM_MS - 1), "held");

    assert.equal(
        displaySource({ firstRead: true, edited: false, fileDisplay: false, sharedDisplay: true }),
        false,
        "the file wins on start",
    );
    assert.equal(displaySource({ firstRead: false, edited: true, fileDisplay: true, sharedDisplay: false }), true);
    assert.equal(
        displaySource({ firstRead: false, edited: false, fileDisplay: true, sharedDisplay: false }),
        false,
        "the session value stands",
    );
    assert.equal(displaySource({ firstRead: false, edited: false, fileDisplay: true, sharedDisplay: undefined }), true);
    // A change restarts a running helper unless a release/start is already under way.
    const idle = { starting: false, stopping: false, restarting: false };
    assert.equal(displayRestart({ previous: true, next: false, helperPid: 7, ...idle }), true);
    assert.equal(displayRestart({ previous: false, next: false, helperPid: 7, ...idle }), false);
    assert.equal(
        displayRestart({ previous: true, next: false, helperPid: null, ...idle }),
        false,
        "nothing to restart",
    );
    assert.equal(displayRestart({ previous: true, next: false, helperPid: 7, ...idle, restarting: true }), false);
    assert.equal(displayRestart({ previous: true, next: false, helperPid: 7, ...idle, stopping: true }), false);
});
