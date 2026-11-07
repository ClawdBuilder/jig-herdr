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
    helperAction,
    helperScriptIn,
    idleMsOf,
    modeOf,
    nextMode,
    parseConfig,
    parsePid,
    startCommand,
    stopCommand,
    stopFileIn,
} from "./lib.js";

const MODE = "keep-awake.mode";
const ACTIVE = "keep-awake.active";
const HELPER = "keep-awake.helper";
const EVERY = 1000; // the mode, the agents and the idle timer, every second
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

/** The popup the tab bar's button opens: the three modes, what is happening now, and what it cannot do. */
class Menu {
    constructor(cx) {
        this.config = parseConfig(null);
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/keep-awake/config.json`).catch(() => null);
            this.config = parseConfig(text);
            cx.notify();
        });
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
            .child(
                div()
                    .flex_none()
                    .px(9)
                    .pt(8)
                    .pb(2)
                    .text_size(11)
                    .text_color(t.dim)
                    .child(
                        "The display may still turn off. A closed lid or the power button still sleeps the computer.",
                    ),
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
        this.platform = window()?.platform ?? "linux";
        this.config = parseConfig(null);
        this.configAt = 0;
        this.busyAt = 0; // when an agent was last working or blocked
        this.helper = shared(HELPER) ?? null; // { pid, owner, at }
        this.verifiedAt = 0; // when the helper was last seen alive and ours
        this.starting = false;
        this.warned = new Set();
        // The defaults exist before anything is rendered, so the button and a key have a value to read.
        if (shared(MODE) === undefined) setShared(MODE, "off");
        if (shared(ACTIVE) === undefined) setShared(ACTIVE, false);
        this.loadConfig(cx);
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
            const text = await readTextFile(`${appHome()}/mods/keep-awake/config.json`).catch(() => null);
            this.config = parseConfig(text);
            cx.notify();
        });
    }

    /** One second of the mode: decide, publish it, and let the helper follow. */
    tick(cx) {
        this.loadConfig(cx);
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

    /** Starts the helper when one is needed and none of ours is running; never a second one. */
    ensure(cx) {
        if (this.starting) return;
        const recorded = this.helper;
        if (recorded?.pid && Date.now() - this.verifiedAt < VERIFY_MS) return;
        this.starting = true;
        cx.spawn(async (cx) => {
            try {
                const action = recorded?.pid ? await this.verify(recorded.pid) : "start";
                if (action === "reuse") {
                    this.verifiedAt = Date.now();
                    return;
                }
                if (action === "stale") {
                    // The PID was reused by something else: forget it, never kill it.
                    this.helper = null;
                    setShared(HELPER, null);
                } else if (recorded?.pid) await this.forget(recorded.pid);
                await this.start();
            } finally {
                this.starting = false;
            }
            cx.notify();
        });
    }

    /** Whether a recorded PID is still our helper: alive, and its command line names this mod's script. */
    async verify(pid) {
        const alive = aliveCommand(this.platform, pid);
        const running = await exec(alive.cmd, alive.args).catch(() => null);
        if (!running || running.code !== 0) return "start";
        const line = commandLineCommand(this.platform, pid);
        const said = await exec(line.cmd, line.args).catch(() => null);
        return helperAction({
            recorded: { pid },
            alive: true,
            commandLine: said?.stdout ?? "",
            script: helperScriptIn(appHome()),
        });
    }

    async start() {
        const find = appPidCommand(this.platform);
        const app = await exec(find.cmd, find.args).catch(() => null),
            owner = parsePid(app?.stdout);
        if (!owner) {
            this.warn("Herdr's own process was not found; nothing can be kept awake.");
            return;
        }
        await this.stopFile("run");
        const command = startCommand(this.platform, {
            ownerPid: owner,
            script: helperScriptIn(appHome()),
            stopFile: stopFileIn(appHome()),
            display: this.config.display,
        });
        const r = await exec(command.cmd, command.args).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
        const pid = parsePid(r.stdout);
        if (r.code !== 0 || !pid) {
            this.warn(
                `The keep-awake helper did not start: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || r.code}`,
            );
            return;
        }
        this.helper = { pid, owner, at: Date.now() };
        this.verifiedAt = Date.now();
        setShared(HELPER, this.helper);
    }

    /** Stops the helper: the stop file first (it can read it), then the process itself. */
    stop(cx) {
        if (this.stopping) return;
        const recorded = this.helper ?? shared(HELPER);
        if (!recorded?.pid) return;
        this.stopping = true;
        cx.spawn(async (cx) => {
            await this.stopFile("stop");
            await this.forget(recorded.pid);
            this.stopping = false;
            cx.notify();
        });
    }

    /** Asks the helper to stop on its next check, and clears the record. */
    async forget(pid) {
        const command = stopCommand(this.platform, pid);
        await exec(command.cmd, command.args).catch(() => null);
        this.helper = null;
        this.verifiedAt = 0;
        setShared(HELPER, null);
    }

    /** The stop file: "run" before a start (so an old stop cannot kill the new helper), "stop" to end it. */
    async stopFile(text) {
        const file = stopFileIn(appHome());
        const before = await readTextFile(file).catch(() => null);
        await writeTextFile(file, text, before).catch(() => null);
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

    /** Herdr is quitting: end the request now, while exec and the file writes still go out. */
    async close(cx) {
        const recorded = this.helper ?? shared(HELPER);
        if (!recorded?.pid) return;
        const file = stopFileIn(appHome());
        const before = await readTextFile(file).catch(() => null);
        await writeTextFile(file, "stop", before).catch(() => null);
        const command = stopCommand(this.platform, recorded.pid);
        await exec(command.cmd, command.args).catch(() => null);
        setShared(HELPER, null);
    }
}
