// Keeps the computer Herdr runs on awake on its idle timer: off, on until switched off or Herdr closes, or while any agent
// is working or blocked (and for idleMinutes after the last one). The helper is a hidden PowerShell calling
// SetThreadExecutionState on Windows, caffeinate on macOS, or systemd-inhibit on Linux — on Herdr's own machine, never on a
// space's. It exits when this mod stops it, when the stop file says "stop", or when Herdr's process is gone, so a crash
// cannot leave a computer awake for ever. No power plan, registry or administrator right is involved, and a closed lid or
// the power button still sleeps the machine.
//
// It shows nothing: the jig layout gives it a block of 0 px. The tab bar's button (jig-tabs) and the keep-awake.cycle key
// drive shared("keep-awake.mode"); shared("keep-awake.active") says whether the request is held now, and
// shared("keep-awake.helper") records the helper's PID so a second copy never starts another one.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
    agents,
    appHome,
    closeOverlay,
    exec,
    layout,
    nextCommand,
    notify,
    props as modProps,
    readTextFile,
    setShared,
    shared,
    theme,
    window,
    writeTextFile,
} from "herdr";
import {
    MODE_LABEL,
    aliveCommand,
    anyBusy,
    appPidCommand,
    commandLineCommand,
    decide,
    helperScriptIn,
    helperFileIn,
    helperToRelease,
    claimState,
    claimText,
    withDeadline,
    isStuck,
    releaseOutcome,
    displayRestart,
    displaySource,
    killDecision,
    recordState,
    idleMsOf,
    modeOf,
    nextMode,
    parseConfig,
    parsePid,
    startCommand,
    setDisplay,
    stopCommand,
    stopFileIn,
    stopLine,
} from "./lib.js";

const MODE = "keep-awake.mode";
const ACTIVE = "keep-awake.active";
const HELPER = "keep-awake.helper";
const DISPLAY = "keep-awake.display";
const EVERY = 1000;
/** No exec may keep a step (and its flag) waiting longer than this; a timeout counts as "could not ask". */
const EXEC_MS = 8000;
/** A flag older than this is cleared and the step retried, whatever happened to its task. */
const STUCK_MS = 20000; // the mode, the agents and the idle timer, every second
const VERIFY_MS = 10000; // how often a running helper is asked whether it is still ours
const CONFIG_MS = 60000; // how long config.json is trusted
const ICON = "mods/keep-awake/keep-awake.svg";
const CHECK = "mods/workspace-chrome/check.svg";

/** A mode row in the popup: the mode, a tick when it is the current one, and what it means. */
function menuRow(t, mode, hint, current) {
    return h_flex()
        .id(`keep-awake-${mode}`)
        .h(30)
        .flex_none()
        .px(9)
        .gap(8)
        .items_center()
        .rounded(7)
        .text_size(12.5)
        .text_color(current ? t.foreground : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => {
            cx.stop_propagation();
            setShared(MODE, mode);
            closeOverlay(modProps().overlay);
        })
        .child(
            div()
                .w(12)
                .flex_none()
                .text_color(t.accent)
                .child(current ? svg(CHECK).size(12) : ""),
        )
        .child(div().flex_none().child(MODE_LABEL[mode]))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(hint));
}

/** A 28×16 switch, as the Context panel draws them. */
function toggle(t, id, on) {
    return div()
        .id(id)
        .flex_none()
        .w(28)
        .h(16)
        .p(2)
        .rounded_full()
        .flex()
        .items_center()
        .border(1)
        .border_color(on ? t.accent : t.border)
        .bg(on ? t.accent : t.background)
        .when(on, (el) => el.justify_end())
        .child(
            div()
                .size(10)
                .rounded_full()
                .bg(on ? t.accent_foreground : t.dim),
        );
}

/** config.json next to the mod. */
const configPath = () => `${appHome()}/mods/keep-awake/config.json`;

/** The popup the tab bar's button opens: the three modes, what is happening now, and what it cannot do. */
class Menu {
    constructor(cx) {
        this.config = parseConfig(null);
        this.display = this.config.display;
        this.failed = null;
        cx.spawn(async (cx) => {
            const text = await readTextFile(configPath()).catch(() => null);
            this.config = parseConfig(text);
            this.display = typeof shared(DISPLAY) === "boolean" ? shared(DISPLAY) : this.config.display;
            cx.notify();
        });
    }

    /** The switch: write config.json, then tell the worker; a failed write leaves both as they were. */
    toggleDisplay(cx) {
        const next = !this.display;
        this.display = next;
        cx.spawn(async (cx) => {
            const text = await readTextFile(configPath()).catch(() => null);
            try {
                await writeTextFile(configPath(), setDisplay(text, next), text);
                this.failed = null;
                setShared(DISPLAY, next);
            } catch {
                this.display = !next;
                this.failed = "Could not write config.json";
            }
            cx.notify();
        });
        cx.notify();
    }

    render() {
        const t = theme(),
            mode = modeOf(shared(MODE)),
            active = shared(ACTIVE) === true,
            idle = this.config.idleMinutes;
        return v_flex()
            .id("keep-awake-menu")
            .w_full()
            .min_h(0)
            .p(8)
            .gap(2)
            .bg(t.popover)
            .text_color(t.foreground)
            .text_size(13)
            .child(
                h_flex()
                    .flex_none()
                    .px(9)
                    .pt(4)
                    .pb(6)
                    .gap(7)
                    .items_center()
                    .child(
                        svg(ICON)
                            .size(14)
                            .flex_none()
                            .text_color(active ? t.accent : t.muted),
                    )
                    .child(div().flex_none().font_semibold().child("Keep awake"))
                    .child(
                        div()
                            .min_w(0)
                            .truncate()
                            .text_size(11)
                            .text_color(active ? t.done : t.dim)
                            .child(active ? "holding off sleep" : "not holding"),
                    ),
            )
            .child(menuRow(t, "off", "no request", mode === "off"))
            .child(menuRow(t, "on", "until you switch it off, or Herdr closes", mode === "on"))
            .child(menuRow(t, "agents", `and ${idle} min after it stops`, mode === "agents"))
            .child(div().flex_none().h(1).mx(9).my(5).bg(t.border))
            .child(
                h_flex()
                    .id("keep-awake-display")
                    .h(30)
                    .flex_none()
                    .px(9)
                    .gap(8)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.selected))
                    .on_click((_e, cx) => {
                        cx.stop_propagation();
                        this.toggleDisplay(cx);
                    })
                    .child(div().flex_1().child("Keep screen on"))
                    .child(
                        div()
                            .flex_none()
                            .text_size(11)
                            .text_color(t.dim)
                            .child(this.display ? "on" : "off"),
                    )
                    .child(toggle(t, "keep-awake-display-switch", this.display)),
            )
            .when(Boolean(this.failed), (el) =>
                el.child(div().flex_none().px(9).pt(2).text_size(11).text_color(t.blocked).child(this.failed)),
            )
            .child(
                div()
                    .flex_none()
                    .px(9)
                    .pt(8)
                    .pb(2)
                    .text_size(11)
                    .text_color(t.dim)
                    .child("A closed lid or the power button still sleeps the computer."),
            );
    }
}

export default class KeepAwake extends View {
    init(_props, cx) {
        const p = modProps() ?? {};
        if (p.menu) {
            // This copy is the popup the tab bar opens, not the worker.
            this.menu = new Menu(cx);
            return;
        }
        // The layout's block can be initialised just before Herdr's window and layout exist (right after a restart), and
        // `herdr-app check` loads a copy that never has them. Wait for both: a check copy exits long before, so it still
        // starts nothing, while a real block begins as soon as the window is there.
        this.inert = true;
        if (window() && layout()) return this.begin(cx);
        cx.timer.every(500, (cx) => {
            if (this.inert === false || !window() || !layout()) return;
            this.begin(cx);
            cx.notify();
        });
    }

    /** The worker proper: only once Herdr's window and layout exist. */
    begin(cx) {
        this.inert = false;
        this.platform = window()?.platform ?? "linux";
        this.config = parseConfig(null);
        this.configAt = 0;
        this.busyAt = 0; // when an agent was last working or blocked
        this.helper = shared(HELPER) ?? null; // { pid, owner, at }
        this.verifiedAt = 0; // when the helper was last seen alive and ours
        this.starting = false;
        this.restarting = false;
        this.stopping = false;
        this.settling = false;
        this.settlingAt = 0;
        this.startingAt = 0;
        this.stoppingAt = 0;
        this.restartingAt = 0;
        this.configText = undefined; // the config.json text last read
        this.warned = new Set();
        this.owns = false; // true only for the copy that started the helper it holds
        // The defaults exist before anything is rendered, so the button and a key have a value to read.
        if (shared(MODE) === undefined) setShared(MODE, "off");
        if (shared(ACTIVE) === undefined) setShared(ACTIVE, false);
        this.loadConfig(cx);
        this.settle(cx);
        this.tick(cx);
        cx.timer.every(EVERY, (cx) => this.tick(cx));
        cx.spawn(async (cx) => {
            for (;;) {
                const command = await nextCommand();
                if (command === "cycle") setShared(MODE, nextMode(modeOf(shared(MODE))));
                else if (command === "on" || command === "off" || command === "agents") setShared(MODE, command);
                cx.notify();
            }
        });
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < CONFIG_MS) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await this.readIn(cx, configPath());
            if (text === this.configText) return;
            const firstRead = this.configText === undefined,
                previous = this.config.display,
                read = parseConfig(text),
                edited = !firstRead && read.display !== previous,
                next = displaySource({ firstRead, edited, fileDisplay: read.display, sharedDisplay: shared(DISPLAY) });
            this.configText = text;
            this.config = read;
            if (shared(DISPLAY) !== next) setShared(DISPLAY, next);
            // The file already carries the new value, so the shared comparison cannot catch this one: restart here.
            if (
                !firstRead &&
                displayRestart({
                    previous,
                    next: read.display,
                    helperPid: this.helper?.pid,
                    starting: this.starting,
                    stopping: this.stopping,
                    restarting: this.restarting,
                })
            )
                this.restartHelper(cx);
            cx.notify();
        });
    }

    /** One command, with a deadline: a command that never returns must not leave a step, or a record, stuck. */
    async execIn(cx, command) {
        if (!command) return null;
        const run = exec(command.cmd, command.args).catch(() => null);
        if (!cx?.timer) return run;
        return withDeadline(run, (ms, fn) => cx.timer.after(ms, fn), EXEC_MS, null);
    }

    async readIn(cx, path) {
        const read = readTextFile(path).catch(() => null);
        if (!cx?.timer) return read;
        return withDeadline(read, (ms, fn) => cx.timer.after(ms, fn), 4000, null);
    }

    async writeIn(cx, path, text, before) {
        const write = writeTextFile(path, text, before).then(
            () => true,
            () => false,
        );
        if (!cx?.timer) return write;
        return withDeadline(write, (ms, fn) => cx.timer.after(ms, fn), 4000, false);
    }

    /** Clears a step flag whose task never came back, so the next tick can try again. */
    clearStuck() {
        const now = Date.now();
        for (const name of ["settling", "starting", "stopping", "restarting"]) {
            if (this[name] && isStuck(this[`${name}At`], now, STUCK_MS)) {
                this[name] = false;
                this[`${name}At`] = 0;
                this.warn(`The ${name} step stalled; trying again.`);
            }
        }
    }

    /** The record in shared.json outlives a crash: forget it when it is not our helper any more, without killing. */
    settle(cx) {
        const recorded = this.helper;
        if (!recorded?.pid) return;
        this.settling = true;
        cx.spawn(async (cx) => {
            const state = await this.helperState(recorded);
            if (state === "gone" || state === "other") this.dropRecord();
            // "unknown" keeps the record; a later check decides, and cannot kill an unverified PID either way.
            this.settling = false;
        this.settlingAt = 0;
        this.startingAt = 0;
        this.stoppingAt = 0;
        this.restartingAt = 0;
            cx.notify();
        });
    }

    /** One second of the mode: decide, publish it, and let the helper follow. */
    tick(cx) {
        this.clearStuck();
        this.loadConfig(cx);
        // The popup's switch (or another copy) changed the setting: apply it now, not when the helper next dies.
        const display = shared(DISPLAY);
        if (typeof display === "boolean" && display !== this.config.display) this.applyDisplay(cx, display);
        const now = Date.now(),
            mode = modeOf(shared(MODE)),
            result = decide({
                mode,
                busy: anyBusy(agents()),
                now,
                busyAt: this.busyAt,
                idleMs: idleMsOf(this.config),
            });
        this.busyAt = result.busyAt;
        if (Boolean(shared(ACTIVE)) !== result.active) setShared(ACTIVE, result.active);
        if (result.active) this.ensure(cx);
        else this.stop(cx);
    }

    /** A live `display` change (the popup's switch): restart a running helper with the new flag at once. */
    applyDisplay(cx, display) {
        if (this.config.display === display) return;
        const previous = this.config.display;
        this.config = { ...this.config, display };
        if (
            displayRestart({
                previous,
                next: display,
                helperPid: this.helper?.pid,
                starting: this.starting,
                stopping: this.stopping,
                restarting: this.restarting,
            })
        )
            this.restartHelper(cx);
    }

    /** Releases the running helper and starts one with the current settings; never two at once. */
    restartHelper(cx) {
        if (!this.helper?.pid || this.restarting || this.stopping) return;
        const recorded = this.helper;
        this.restarting = true;
        this.restartingAt = Date.now();
        cx.spawn(async (cx) => {
            const released = await this.release(recorded, cx);
            if (released && shared(ACTIVE) === true) await this.start(cx);
            this.restarting = false;
            this.restartingAt = 0;
            cx.notify();
        });
    }

    /** Starts the helper when one is needed and none of ours is running; never a second one. */
    ensure(cx) {
        if (this.starting || this.restarting || this.stopping || this.settling) return;
        const recorded = this.helper;
        if (recorded?.pid && Date.now() - this.verifiedAt < VERIFY_MS) return;
        this.starting = true;
        this.startingAt = Date.now();
        cx.spawn(async (cx) => {
            try {
                const recorded = this.helper;
                if (recorded?.pid) {
                    const action = await this.helperState(recorded, cx);
                    if (action === "reuse") {
                        this.verifiedAt = Date.now();
                        return;
                    }
                    // A failed check keeps the record for the next one: starting now could duplicate a helper we could not read.
                    if (action === "unknown") return;
                    // Gone, or its PID now belongs to another process: forget it, never kill it.
                    this.dropRecord();
                }
                // Another copy (a reload, a second window) may already run one: take that over, never a second.
                if (await this.adoptRecord(cx)) return;
                await this.start(cx);
            } finally {
                this.starting = false;
                this.startingAt = 0;
            }
            cx.notify();
        });
    }

    /** What a PID looks like now: alive (true, false, or null when the check itself failed) and its command line. */
    async inspect(pid, cx) {
        const alive = aliveCommand(this.platform, pid);
        const running = await this.execIn(cx, alive);
        if (!running) return { alive: null, commandLine: "" }; // could not ask (or timed out): never kill on this
        if (running.code !== 0) return { alive: false, commandLine: "" };
        const line = commandLineCommand(this.platform, pid);
        const said = await this.execIn(cx, line);
        if (said?.code !== 0) return { alive: true, commandLine: "" }; // alive, but not verified
        return { alive: true, commandLine: said.stdout };
    }

    /** "reuse", "gone", "other" or "unknown" for the recorded PID; it never kills. */
    async helperState(recorded, cx) {
        const seen = await this.inspect(recorded.pid, cx);
        return recordState({
            alive: seen.alive,
            commandLine: seen.commandLine,
            platform: this.platform,
            script: helperScriptIn(appHome()),
            owner: recorded.owner,
        });
    }

    /** Forgets the recorded helper without touching any process. */
    dropRecord() {
        this.helper = null;
        this.verifiedAt = 0;
        this.owns = false;
        setShared(HELPER, null);
    }

    /** Claims the one start slot (two windows share the app folder); false when another worker holds it. */
    async claim(cx) {
        const file = helperFileIn(appHome());
        const before = await this.readIn(cx, file);
        if (claimState(before) === "held") return null;
        const token = Math.random().toString(36).slice(2, 10);
        const text = claimText(token);
        if (!(await this.writeIn(cx, file, text, before))) return null;
        return { token, text, file, before };
    }

    /** Ends a claim that did not become a helper, so the next attempt can take it. */
    async clearClaim(claim, cx) {
        await this.writeIn(cx, claim.file, `${JSON.stringify({ phase: "idle" })}\n`, claim.text);
    }

    /** Records the started helper in the claim file, so another window can see it. False when another worker got there
     * first: the helper this copy started is then stopped, never left unrecorded. */
    async recordHelper(claim, helper, cx) {
        const text = `${JSON.stringify({ phase: "helper", ...helper })}\n`;
        return this.writeIn(cx, claim.file, text, claim.text);
    }

    /** Herdr's own PID: the parent of this command when it is the app, else the running app with the earliest start. */
    async ownerPid(cx) {
        const find = appPidCommand(this.platform);
        const app = await this.execIn(cx, find);
        return parsePid(app?.stdout);
    }

    /** Writes a stop file and says whether it stuck: a start must not proceed on a stop it cannot replace. */
    async writeStopFile(file, text, cx) {
        const before = await this.readIn(cx, file);
        return this.writeIn(cx, file, text, before);
    }

    /** Takes over the helper another copy recorded, instead of starting a second one. */
    async adoptRecord(cx) {
        const text = await this.readIn(cx, helperFileIn(appHome()));
        if (!text) return false;
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            return false;
        }
        if (raw?.phase !== "helper" || !raw.pid || raw.pid === this.helper?.pid) return false;
        if ((await this.helperState(raw, cx)) !== "reuse") return false;
        this.helper = { pid: raw.pid, owner: raw.owner, at: raw.at, stopFile: stopFileIn(appHome()), token: raw.token };
        this.verifiedAt = Date.now();
        this.owns = false;
        setShared(HELPER, this.helper);
        return true;
    }

    async start(cx) {
        const claim = await this.claim(cx);
        if (!claim) return; // another window is starting, or already did
        const owner = await this.ownerPid(cx);
        if (!owner) {
            await this.clearClaim(claim, cx);
            this.warn("Herdr's own process was not found; nothing can be kept awake.");
            return;
        }
        // A fresh stop file per helper: a "stop" left by an earlier one can never end this one, and a failure to create
        // it stops the start rather than risking a helper that would read an old stop.
        const stopFile = stopFileIn(appHome());
        if (!(await this.writeStopFile(stopFile, stopLine("run", claim.token), cx))) {
            await this.clearClaim(claim, cx);
            this.warn("The stop file could not be written; the helper was not started.");
            return;
        }
        const command = startCommand(this.platform, {
            ownerPid: owner,
            script: helperScriptIn(appHome()),
            stopFile,
            display: this.config.display,
            token: claim.token,
            recordFile: helperFileIn(appHome()),
        });
        const r = await this.execIn(cx, command);
        const pid = parsePid(r?.stdout);
        if (!r || r.code !== 0 || !pid) {
            await this.clearClaim(claim, cx);
            this.warn(
                `The keep-awake helper did not start: ${(r?.stderr || r?.stdout || "no answer").trim().split("\n")[0]}`,
            );
            return;
        }
        this.helper = { pid, owner, at: Date.now(), stopFile, token: claim.token };
        this.verifiedAt = Date.now();
        this.owns = true;
        setShared(HELPER, this.helper);
        if (await this.recordHelper(claim, this.helper, cx)) return;
        // Another worker recorded its own between our claim and this write: ours is the duplicate.
        this.warn("Another window started a keep-awake helper first; this one was stopped.");
        await this.release(this.helper, cx);
        this.helper = shared(HELPER) ?? null;
        this.verifiedAt = 0;
    }

    /** Stops the helper: its stop file first, then a kill only after it verifies as ours. False when the helper could
     * not be checked, in which case its record stays so the next tick retries instead of forgetting a live one. */
    async release(recorded, cx) {
        await this.writeStopFile(stopFileIn(appHome()), stopLine("stop", recorded.token), cx);
        const seen = await this.inspect(recorded.pid, cx);
        const decision = killDecision({
            recorded,
            alive: seen.alive,
            commandLine: seen.commandLine,
            platform: this.platform,
            script: helperScriptIn(appHome()),
            owner: recorded.owner,
        });
        if (decision === "kill") {
            const command = stopCommand(this.platform, recorded.pid);
            await this.execIn(cx, command);
        }
        if (releaseOutcome({ known: seen.alive !== null, decision }) === "keep") return false;
        this.dropRecord();
        return true;
    }

    /** Stops the helper when the mode no longer needs it. */
    stop(cx) {
        if (this.stopping || this.restarting) return;
        const recorded = this.helper ?? shared(HELPER);
        if (!recorded?.pid) return;
        this.stopping = true;
        this.stoppingAt = Date.now();
        cx.spawn(async (cx) => {
            const released = await this.release(recorded, cx);
            if (!released) this.warn("The keep-awake helper could not be checked; trying again next tick.");
            this.stopping = false;
            this.stoppingAt = 0;
            cx.notify();
        });
    }

    warn(message) {
        if (this.warned.has(message)) return;
        this.warned.add(message);
        console.log(message);
        notify({ title: "Keep awake", body: message, level: "warning" });
    }

    render() {
        if (this.menu) return this.menu.render();
        // A 0 px block in the layout: the worker draws nothing.
        return div();
    }

    /** Herdr is quitting: a fast stop-file write, no process checks; the helper's 5-second poll ends it. A popup copy
     * holds nothing, and a release cannot leave the button lit. */
    async close(cx) {
        if (this.inert) return;
        const recorded = helperToRelease(this.menu, this.helper, this.owns);
        if (!recorded?.pid) return;
        await this.writeStopFile(stopFileIn(appHome()), stopLine("stop", recorded.token), cx);
        this.dropRecord();
        setShared(ACTIVE, false);
    }
}
