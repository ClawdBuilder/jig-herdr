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
        script: "C:/Users/me/.config/herdr-app/mods/keep-awake/keep-awake.ps1",
        stopFile: "C:/Users/me/.config/herdr-app/keep-awake.stop",
        display: false,
    };
    const win = startCommand("windows", where);
    assert.equal(win.cmd, "powershell");
    const line = win.args.join(" ");
    assert.match(line, /Start-Process/);
    assert.match(line, /-WindowStyle Hidden/);
    assert.match(line, /-PassThru/);
    assert.match(line, /\$p\.Id/, "the parent is told the hidden process's PID");
    assert.match(line, /keep-awake\.ps1/);
    assert.match(line, /-Owner','4321/, "the owner PID is passed");
    assert.match(line, /-Display','0/);
    assert.match(line, /keep-awake\.stop/);

    const screen = startCommand("windows", { ...where, display: true });
    assert.match(screen.args.join(" "), /-Display','1/);
    const quoted = startCommand("windows", { ...where, script: "C:/a b's/keep-awake.ps1" });
    assert.match(quoted.args.join(" "), /C:\/a b''s\/keep-awake\.ps1/, "a quote in a path survives PowerShell quoting");

    const mac = startCommand("macos", { ...where, ownerPid: 99 });
    assert.equal(mac.cmd, "sh");
    assert.match(mac.args[1], /nohup 'caffeinate' '-i' '-w' '99' >\/dev\/null 2>&1 & echo \$!/);
    assert.match(startCommand("macos", { ...where, ownerPid: 99, display: true }).args[1], /'-i' '-d' '-w'/);

    const linux = startCommand("linux", { ...where, ownerPid: 99 });
    assert.match(linux.args[1], /systemd-inhibit/);
    assert.match(linux.args[1], /--what=sleep'/);
    assert.match(linux.args[1], /--mode=block/);
    assert.match(linux.args[1], /'sleep' 'infinity'/);
    assert.match(startCommand("linux", { ...where, ownerPid: 99, display: true }).args[1], /--what=sleep:idle'/);
});

test("every process question has one command per platform", async () => {
    const { appPidCommand, aliveCommand, commandLineCommand, stopCommand } = await lib();
    assert.match(appPidCommand("windows").args.join(" "), /Get-Process -Name herdr-app/);
    assert.match(appPidCommand("macos").args[1], /pgrep -x herdr-app/);
    assert.match(aliveCommand("windows", 7).args.join(" "), /Get-Process -Id 7/);
    assert.match(aliveCommand("linux", 7).args[1], /kill -0 7/);
    assert.match(commandLineCommand("windows", 7).args.join(" "), /ProcessId=7/);
    assert.match(commandLineCommand("macos", 7).args[1], /ps -p 7 -o command=/);
    assert.deepEqual(stopCommand("windows", 7).args, ["/PID", "7", "/T", "/F"]);
    assert.match(stopCommand("linux", 7).args[1], /kill 7/);
    // A PID that is not a number cannot become a command of its own.
    assert.match(aliveCommand("linux", "x").args[1], /kill -0 1 /);
    assert.match(stopCommand("windows", -5).args[1], /^1$/);
});

test("a PID is read from the first number, and a recorded helper is reused only while it is ours", async () => {
    const { parsePid, isHelper, helperAction, stopFileIn, helperScriptIn, idleMsOf } = await lib();
    assert.equal(parsePid("4321\n"), 4321);
    assert.equal(parsePid("nothing here"), null);
    assert.equal(parsePid(""), null);
    assert.equal(parsePid(undefined), null);
    assert.equal(parsePid(" 42 "), 42);
    assert.equal(parsePid("7"), null, "a one-digit number is not a PID");

    assert.equal(isHelper("powershell -File C:/x/keep-awake.ps1 -Owner 1", "C:/x/keep-awake.ps1"), true);
    assert.equal(isHelper("powershell -File C:/x/other.ps1", "C:/x/keep-awake.ps1"), false);
    assert.equal(isHelper("", "C:/x/keep-awake.ps1"), false);

    assert.equal(helperAction({ recorded: null }), "start");
    assert.equal(helperAction({ recorded: { pid: 7 }, alive: false }), "start");
    assert.equal(
        helperAction({
            recorded: { pid: 7 },
            alive: true,
            commandLine: "x keep-awake.ps1",
            script: "/a/keep-awake.ps1",
        }),
        "reuse",
    );
    assert.equal(
        helperAction({
            recorded: { pid: 7 },
            alive: true,
            commandLine: "some other process",
            script: "/a/keep-awake.ps1",
        }),
        "stale",
    );

    assert.equal(stopFileIn("/home/me/.config/herdr-app/"), "/home/me/.config/herdr-app/keep-awake.stop");
    assert.equal(helperScriptIn("C:\\Users\\me\\h"), "C:\\Users\\me\\h/mods/keep-awake/keep-awake.ps1");
    assert.equal(idleMsOf({ idleMinutes: 5 }), 300_000);
    assert.equal(idleMsOf({ idleMinutes: 0 }), 0);
    assert.equal(idleMsOf({}), 0);
});
