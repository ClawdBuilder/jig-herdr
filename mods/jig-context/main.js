// The Jig Context panel: what fills the context of the Pi session in focus, from the status file the jig-session Pi plugin
// writes for each session (its format: https://github.com/ClawdBuilder/jig/blob/main/plugins/jig-session/README.md). A bar and a legend (messages, tools, system
// prompt, skills, context files, the compaction buffer, free space), then the tools and skills with a switch each, and the
// context files.
//
// While the panel is on screen it reads the status files every 2 seconds with one `sh` on the machine where Pi runs (the
// Work panel's config.json: `machine`, else the shown space's machine). A switch or Reload writes one request file next to
// the session's status file, by a temporary file and a rename; the session applies it and answers in its status file
// (`lastRequest`). A request can only switch a tool or a skill for that session, or reload it when idle: it approves
// nothing, and jig-core's rules still decide every call of a tool switched on.

import { h_flex, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { appHome, exec, focused, layout, readTextFile, spaces, terminals, theme, window } from "herdr";

import {
    addressOf,
    addSwitch,
    changedSince,
    folderName,
    headline,
    MTIMES,
    mergeSessions,
    parseConfig,
    parseMtimes,
    parseSessions,
    percent,
    pickSession,
    READ,
    requestJson,
    requestPath,
    SCRIPT,
    segments,
    short,
    shownAgain,
    shownOn,
    splitPath,
    terminalStateChanged,
    WRITE,
} from "./lib.js";
import { focusRegained, RefreshScheduler, RefreshState, refreshSeconds } from "./refresh.js";

const MTIME_MS = 3000; // while the followed session works: a cheap mtime check
const ANSWER_MS = 10000; // how long a request may wait before the panel says the session does not answer

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const OWN = (name) => `mods/jig-context/${name}.svg`;

function iconButton(t, id, icon, tip, onClick, busy = false) {
    return div()
        .id(id)
        .flex_none()
        .w(22)
        .h(20)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(busy ? t.dim : t.muted)
        .when(busy, (el) => el.opacity(0.6))
        .cursor_pointer()
        .hover((s) => s.bg(t.raised).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
        })
        .tooltip(tip)
        .child(svg(icon).size(13));
}

// Which lists are open, remembered per session: { <session id>: { tools, skills, files } }.
function readOpen() {
    try {
        return {
            default: { tools: false, skills: false, files: false },
            ...JSON.parse(localStorage.getItem("openBySession") ?? "{}"),
        };
    } catch {
        return { default: { tools: false, skills: false, files: false } };
    }
}

// "12:04:31" in this computer's time.
function clock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export default class JigContext extends View {
    init(_props, cx) {
        this.config = parseConfig(null);
        this.sessions = [];
        this.raw = null;
        this.dir = null;
        this.error = null;
        this.loading = false;
        this.loadedAt = 0;
        this.loaded = false;
        this.home = null;
        this.openBySession = readOpen();
        this.open = { ...this.openBySession.default };
        this.picked = null;
        this.pickedFocus = null;
        this.pickerOpen = false;
        this.mtimes = {};
        this.mtimeAt = 0;
        this.checking = false;
        this.refreshState = new RefreshState();
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config) });
        this.lastTerminals = terminals();
        this.windowActive = window()?.active === true;
        this.selectedId = undefined;
        this.started = false;
        this.wasSeen = false;
        this.readGeneration = 0;
        this.width = 0;
        this.pending = null; // switches sent and not answered yet: { tools, skills, reload }
        this.pendingFor = null; // the session they were sent to
        this.sentId = null;
        this.sentAt = 0;
        this.sendError = null;
        this.seq = 0;
        cx.timer.every(1000, (cx) => this.tick(cx));
        this.readAll(cx, false);
        this.wasSeen = true; // the mount read is the shown read; the first tick must not read again
    }

    machine() {
        return this.config.machine ?? spaces().find((s) => s.active)?.machine ?? null;
    }

    current() {
        const f = focused(),
            focus = f?.terminal ?? null;
        return pickSession(this.sessions, {
            machine: this.machine(),
            focused: this.picked && focus === this.pickedFocus ? null : focus,
            agent: this.picked && focus === this.pickedFocus ? null : (f?.agent ?? null),
            picked: this.picked,
        });
    }

    // Once a second: focus/session change, window focus and the followed terminal's status trigger a read; the backstop
    // covers the rest; while the session works, a cheap mtime check every 3 s reads only the files that moved.
    tick(cx) {
        this.refreshState.tick(Date.now(), () => cx.notify());
        const seen = Boolean(this.lastRenderAt) && Date.now() - this.lastRenderAt <= 2500;
        if (!seen) {
            this.wasSeen = false;
            if (this.current().session?.status.state === "busy" || this.refreshScheduler.due()) cx.notify();
            return;
        }
        if (shownAgain(this.wasSeen, seen)) this.refreshScheduler.trigger();
        this.wasSeen = true;
        const current = this.current(),
            id = current.session?.status.session ?? null;
        if (id !== this.selectedId) {
            this.selectedId = id;
            this.open = { ...this.openBySession.default, ...(this.openBySession[id] ?? {}) };
            if (id) this.refreshScheduler.trigger();
            cx.notify();
        }
        if (!this.started && !this.loading) this.refreshScheduler.trigger();
        const active = window()?.active === true;
        if (focusRegained(this.windowActive, active)) this.refreshScheduler.trigger();
        this.windowActive = active;
        const currentTerminals = terminals(),
            address = current.session ? addressOf(current.session.status, this.machine()) : null;
        if (terminalStateChanged(this.lastTerminals, currentTerminals, address)) this.refreshScheduler.trigger();
        this.lastTerminals = currentTerminals;
        if (this.sentId && Date.now() - this.sentAt > ANSWER_MS) cx.notify(); // the "no answer" line
        if (!this.loading && this.refreshScheduler.due()) this.readAll(cx, false);
        if (current.session) this.checkMtimes(cx, current.session);
    }

    readAll(cx, user = false) {
        if (!this.refreshState.start({ user, first: !this.started })) return;
        this.started = true;
        this.refreshScheduler.sweep();
        this.loading = true;
        const run = ++this.readGeneration;
        cx.spawn(async (cx) => {
            let timedOut = false;
            try {
                const text = await readTextFile(`${appHome()}/mods/jig-work/config.json`, { on: null });
                if (run !== this.readGeneration) return;
                this.config = parseConfig(text);
                this.refreshScheduler.setSeconds(refreshSeconds(this.config));
                const on = this.machine(); // after the config: a first read with no config must not run `sh` locally
                const before = await this.readMtimes();
                if (run !== this.readGeneration) return;
                const r = await exec("sh", ["-c", SCRIPT, "sh", this.config.stateDir ?? ""], { on });
                if (run !== this.readGeneration) return;
                if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().split("\n")[0]);
                this.raw = r.stdout;
                this.dir = /^@@dir (.*)$/m.exec(r.stdout)?.[1] ?? null;
                this.sessions = parseSessions(r.stdout);
                this.error = null;
                this.loaded = true;
                this.mtimes = before; // the mtimes from the pass whose bodies were just read
                if (this.home === null) {
                    const h = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
                    this.home = h?.stdout ?? "";
                }
            } catch (e) {
                if (run !== this.readGeneration) return;
                timedOut = String(e?.message ?? e).includes("Reading timed out");
                if (timedOut) this.readGeneration++;
                else this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                if (run === this.readGeneration || timedOut) {
                    this.loading = false;
                    const again = this.refreshState.finish();
                    if (again) this.refreshScheduler.trigger();
                    this.loadedAt = Date.now();
                    cx.notify();
                }
            }
        });
    }

    async readMtimes() {
        const r = await exec("sh", ["-c", MTIMES, "sh", this.config.stateDir ?? ""], {
            on: this.machine(),
        }).catch(() => null);
        return r?.code === 0 ? parseMtimes(r.stdout) : {};
    }

    checkMtimes(cx, session) {
        if (this.loading || this.checking || session?.status.state !== "busy") return;
        const now = Date.now();
        if (now - this.mtimeAt < MTIME_MS) return;
        this.mtimeAt = now;
        this.checking = true;
        const run = this.readGeneration;
        const on = this.machine();
        cx.spawn(async (cx) => {
            try {
                const r = await exec("sh", ["-c", MTIMES, "sh", this.config.stateDir ?? ""], { on }).catch(() => null);
                if (r?.code !== 0) return;
                const next = parseMtimes(r.stdout),
                    files = changedSince(this.mtimes, next);
                if (files.length === 0) return;
                const read = await exec("sh", ["-c", READ, "sh", ...files], { on }).catch(() => null);
                if (read?.code !== 0 || run !== this.readGeneration) return;
                this.mtimes = next; // only the pass whose bodies were read, and only if no full read took over
                this.sessions = mergeSessions(this.sessions, parseSessions(read.stdout), Object.keys(next));
                this.error = null;
                cx.notify();
            } finally {
                this.checking = false;
            }
        });
    }

    // The session answered the request last sent: what was pending is now its state.
    settle() {
        if (!this.sentId) return;
        const s = this.sessions.find((x) => x.status.session === this.pendingFor);
        if (!s || s.status.lastRequest?.id === this.sentId) {
            this.pending = null;
            this.sentId = null;
        }
    }

    // One switch (or Reload) for the session shown: one request file holding every switch not answered yet.
    send(cx, session, kind, name, on) {
        const file = requestPath(session.file);
        if (!file) return;
        if (this.pendingFor !== session.status.session) this.pending = null;
        this.pending = addSwitch(this.pending, kind, name, on);
        this.pendingFor = session.status.session;
        this.seq += 1;
        const id = `ctx-${Date.now().toString(36)}-${this.seq}`;
        this.sentId = id;
        this.sentAt = Date.now();
        this.sendError = null;
        const json = requestJson(id, this.pending);
        const machine = this.machine();
        cx.spawn(async (cx) => {
            try {
                const r = await exec("sh", ["-c", WRITE, "sh", file, json], { on: machine });
                if (r.code !== 0) this.sendError = (r.stderr || "could not write the request").trim().split("\n")[0];
            } catch (e) {
                this.sendError = String(e?.message ?? e);
            }
            this.refreshScheduler.trigger(); // read the answer soon
            cx.notify();
        });
        cx.notify();
    }

    // ---- drawing ---------------------------------------------------------------------------------------------------

    toggle(t, id, on, waiting, onClick, tip = "") {
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
            .when(waiting, (el) => el.opacity(0.55))
            .cursor_pointer()
            .when(Boolean(tip), (el) => el.tooltip(tip))
            .on_click(onClick)
            .child(
                div()
                    .size(10)
                    .rounded_full()
                    .bg(on ? t.accent_foreground : t.dim),
            );
    }

    // The pinned 42 px header: title left; session picker, Reload and refresh right.
    topBar(t, _cx, session, _by) {
        const st = session.status,
            live = this.sessions.filter((s) => s.alive),
            busy = st.state === "busy",
            reloading = this.pending?.reload || st.lastRequest?.reload === "waiting",
            narrow = this.width > 0 && this.width < 380;
        return h_flex()
            .h(42)
            .flex_none()
            .px(12)
            .gap(7)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(div().flex_none().text_color(t.accent).font_semibold().child("π"))
            .child(
                div().flex_1().min_w(0).truncate().font_semibold().tooltip(st.cwd).child(folderName(st.cwd, this.home)),
            )
            .when(live.length > 1, (el) =>
                el.child(
                    div()
                        .id("jc-picker")
                        .flex_none()
                        .h(22)
                        .px(7)
                        .flex()
                        .items_center()
                        .gap(4)
                        .rounded(5)
                        .border(1)
                        .border_color(t.border)
                        .text_size(11)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover((x) => x.bg(t.hover).text_color(t.foreground))
                        .tooltip("Choose the session shown")
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.pickerOpen = !this.pickerOpen;
                            cx.notify();
                        })
                        .child(narrow ? String(live.length) : `${live.length} sessions`)
                        .child(svg(ICON("chevron-down")).size(10)),
                ),
            )
            .child(
                div()
                    .id("jc-reload")
                    .flex_none()
                    .h(22)
                    .px(8)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .border(1)
                    .border_color(t.border)
                    .text_size(11.5)
                    .text_color(reloading ? t.working : t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("Reload Pi's extensions, skills, prompts and context files once the agent is idle")
                    .on_click((_e, cx) => this.send(cx, session, "reload"))
                    .child(narrow ? "Reload" : reloading ? "Reloading…" : busy ? "Reload when idle" : "Reload"),
            )
            .child(
                iconButton(
                    t,
                    "jc-refresh",
                    OWN("refresh"),
                    this.refreshState.busy ? "Reading the sessions…" : "Read the sessions again",
                    (cx) => this.readAll(cx, true),
                    this.refreshState.busy,
                ),
            );
    }

    infoBar(t, session, by) {
        const st = session.status,
            model = st.model?.name ?? st.model?.id ?? "no model";
        return h_flex()
            .h(26)
            .flex_none()
            .px(14)
            .gap(10)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(div().min_w(0).truncate().child(model))
            .when(Boolean(st.thinking) && st.thinking !== "off", (el) => el.child(div().flex_none().child(st.thinking)))
            .when(Boolean(st.terminal), (el) => el.child(div().flex_none().child(st.terminal)))
            .when(by !== "focus", (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_color(t.muted)
                        .child(by === "picked" ? "picked" : "last active"),
                ),
            );
    }

    picker(t, live, current) {
        return v_flex()
            .mx(10)
            .my(6)
            .p(4)
            .rounded(6)
            .border(1)
            .border_color(t.border)
            .bg(t.surface)
            .children(
                live.map((x) =>
                    h_flex()
                        .id(`jc-pick-${x.status.session}`)
                        .h(26)
                        .px(8)
                        .gap(8)
                        .items_center()
                        .rounded(4)
                        .text_size(12)
                        .cursor_pointer()
                        .bg(x === current ? t.selected : t.surface)
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => {
                            this.picked = x.status.session;
                            this.pickedFocus = focused()?.terminal ?? null;
                            this.pickerOpen = false;
                            cx.notify();
                        })
                        .child(div().text_color(t.foreground).child(folderName(x.status.cwd, this.home)))
                        .child(
                            div()
                                .text_color(t.accent)
                                .child(x.status.ticket?.key ?? ""),
                        )
                        .child(div().flex_1())
                        .child(
                            div()
                                .text_color(t.dim)
                                .child(addressOf(x.status, this.machine()) ?? ""),
                        ),
                ),
            );
    }

    summary(t, detail) {
        const parts = segments(detail);
        const shown = parts.filter((p) => p.share > 0);
        const rest = Math.max(0, 1 - shown.reduce((n, p) => n + p.share, 0));
        return v_flex()
            .px(14)
            .pt(12)
            .gap(8)
            .child(div().text_size(15).font_semibold().text_color(t.foreground).child(headline(detail)))
            .child(
                h_flex()
                    .id("jc-bar")
                    .h(10)
                    .w_full()
                    .gap(1)
                    .rounded(3)
                    .overflow_hidden()
                    .bg(t.background)
                    .children(
                        shown.map((p) =>
                            div()
                                .h_full()
                                .min_w(2)
                                .flex_grow(Math.max(1, Math.round(p.share * 1000)))
                                .bg(t[p.color] ?? t.border)
                                .when(p.key === "free", (el) => el.bg(t.raised)),
                        ),
                    )
                    .when(rest > 0.001, (el) =>
                        el.child(
                            div()
                                .h_full()
                                .flex_grow(Math.round(rest * 1000)),
                        ),
                    ),
            )
            .child(
                v_flex()
                    .pt(2)
                    .children(
                        parts.map((p) =>
                            h_flex()
                                .h(22)
                                .gap(8)
                                .items_center()
                                .text_size(12)
                                .child(
                                    div()
                                        .flex_none()
                                        .size(10)
                                        .rounded(2)
                                        .bg(p.key === "free" ? t.raised : (t[p.color] ?? t.border))
                                        .when(p.key === "free", (el) => el.border(1).border_color(t.border)),
                                )
                                .child(div().text_color(t.foreground).child(p.label))
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .flex_none()
                                        .text_color(t.muted)
                                        .child(p.tokens === null ? "?" : `${p.estimate ? "≈" : ""}${short(p.tokens)}`),
                                )
                                .child(
                                    div()
                                        .w(46)
                                        .flex_none()
                                        .flex()
                                        .justify_end()
                                        .text_color(t.dim)
                                        .child(p.tokens === null ? "" : percent(p.tokens, detail.window)),
                                ),
                        ),
                    ),
            )
            .child(
                div()
                    .text_size(11)
                    .text_color(t.dim)
                    .tooltip(
                        detail.usedFrom === "parts"
                            ? "≈ counted as characters / 4. No reply yet: the total adds up the parts."
                            : "≈ counted as characters / 4. Messages: Pi's total less the other parts, when Pi reports one.",
                    )
                    .child("≈ counted as characters / 4"),
            );
    }

    answer(t, st) {
        const last = st.lastRequest;
        let tone = t.dim;
        let text = null;
        if (this.sendError) {
            tone = t.blocked;
            text = `Could not send: ${this.sendError}`;
        } else if (this.sentId && this.pendingFor === st.session) {
            const late = Date.now() - this.sentAt > ANSWER_MS;
            tone = late ? t.blocked : t.working;
            text = late
                ? "No answer from the session. Its jig-session may be older than requests; /reload in Pi."
                : "Asking the session…";
        } else if (last && typeof last === "object") {
            tone = last.ok ? t.done : t.blocked;
            text = `${last.ok ? "✓" : "✗"} ${last.message ?? ""}`;
        }
        if (text === null) return null;
        return h_flex()
            .px(14)
            .pt(8)
            .gap(8)
            .items_center()
            .text_size(11.5)
            .child(div().min_w(0).truncate().text_color(tone).tooltip(text).child(text))
            .child(div().flex_1())
            .when(!this.sentId && Boolean(last?.at), (el) =>
                el.child(div().flex_none().text_size(11).text_color(t.dim).child(clock(last.at))),
            );
    }

    section(t, key, label, count) {
        const open = this.open[key];
        return h_flex()
            .id(`jc-sec-${key}`)
            .h(28)
            .px(14)
            .mt(8)
            .gap(8)
            .items_center()
            .text_size(10.5)
            .font_semibold()
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
                this.open[key] = !this.open[key];
                const id = this.current().session?.status.session ?? "default";
                this.openBySession[id] = { ...this.open };
                try {
                    localStorage.setItem("openBySession", JSON.stringify(this.openBySession));
                } catch {}
                cx.notify();
            })
            .child(
                div()
                    .w(10)
                    .child(open ? "▾" : "▸"),
            )
            .child(label)
            .child(div().font_normal().child(count));
    }

    tools(t, session, detail) {
        const list = [...(detail.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
        const on = list.filter((x) => shownOn(this.pending, "tools", x.name, x.on)).length;
        return v_flex()
            .child(this.section(t, "tools", "TOOLS", `${on} of ${list.length} on`))
            .when(this.open.tools, (el) =>
                el
                    .child(
                        div()
                            .px(14)
                            .pb(4)
                            .text_size(11)
                            .text_color(t.dim)
                            .child("From the next turn. jig-core's rules still decide every call."),
                    )
                    .children(
                        list.map((x, i) => {
                            const shown = shownOn(this.pending, "tools", x.name, x.on);
                            const waiting = shown !== x.on;
                            return h_flex()
                                .h(24)
                                .px(14)
                                .gap(8)
                                .items_center()
                                .text_size(12)
                                .child(
                                    div()
                                        .min_w(0)
                                        .truncate()
                                        .text_color(shown ? t.foreground : t.dim)
                                        .child(x.name),
                                )
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .flex_none()
                                        .text_size(11)
                                        .text_color(t.dim)
                                        .child(`≈${short(x.tokens)}`),
                                )
                                .child(
                                    this.toggle(
                                        t,
                                        `jc-tool-${i}`,
                                        shown,
                                        waiting,
                                        (_e, cx) => this.send(cx, session, "tools", x.name, !shown),
                                        `Turn ${x.name} ${shown ? "off" : "on"} for this session's next turn`,
                                    ),
                                );
                        }),
                    ),
            );
    }

    skills(t, session, detail) {
        const list = [...(detail.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name));
        return v_flex()
            .child(this.section(t, "skills", "SKILLS", String(list.length)))
            .when(this.open.skills, (el) =>
                el
                    .child(
                        div()
                            .px(14)
                            .pb(4)
                            .text_size(11)
                            .text_color(t.dim)
                            .child("Off: left out of the model's skill list from the next turn, in this session only."),
                    )
                    .when(list.length === 0, (x) =>
                        x.child(div().px(14).text_size(12).text_color(t.dim).child("No skills loaded.")),
                    )
                    .children(
                        list.map((x, i) => {
                            const shown = shownOn(this.pending, "skills", x.name, x.on);
                            return h_flex()
                                .h(24)
                                .px(14)
                                .gap(8)
                                .items_center()
                                .text_size(12)
                                .child(
                                    div()
                                        .min_w(0)
                                        .truncate()
                                        .text_color(shown ? t.foreground : t.dim)
                                        .child(x.name),
                                )
                                .when(!x.listed, (r) =>
                                    r.child(
                                        div()
                                            .flex_none()
                                            .text_size(11)
                                            .text_color(t.dim)
                                            .tooltip("Pi never lists it to the model: /skill:name only")
                                            .child("command only"),
                                    ),
                                )
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .flex_none()
                                        .text_size(11)
                                        .text_color(t.dim)
                                        .child(`≈${short(x.tokens)}`),
                                )
                                .child(
                                    this.toggle(
                                        t,
                                        `jc-skill-${i}`,
                                        shown,
                                        shown !== x.on,
                                        (_e, cx) => this.send(cx, session, "skills", x.name, !shown),
                                        `Turn ${x.name} ${shown ? "off" : "on"} for this session's next turn`,
                                    ),
                                );
                        }),
                    ),
            );
    }

    files(t, detail) {
        const list = detail.files ?? [];
        return v_flex()
            .child(this.section(t, "files", "CONTEXT FILES", String(list.length)))
            .when(this.open.files, (el) =>
                el
                    .when(list.length === 0, (x) =>
                        x.child(div().px(14).text_size(12).text_color(t.dim).child("No context files in the prompt.")),
                    )
                    .children(
                        list.map((f, i) => {
                            const { dir, name } = splitPath(f.path);
                            return h_flex()
                                .id(`jc-file-${i}`)
                                .h(24)
                                .px(14)
                                .gap(8)
                                .items_center()
                                .text_size(12)
                                .tooltip(f.path)
                                .child(div().flex_none().text_color(t.foreground).child(name))
                                .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .flex_none()
                                        .text_size(11)
                                        .text_color(t.dim)
                                        .child(`≈${short(f.tokens)}`),
                                );
                        }),
                    ),
            );
    }

    empty(t) {
        if (!this.loaded && !this.error)
            return v_flex()
                .p(14)
                .gap(6)
                .text_size(12.5)
                .text_color(t.dim)
                .child(div().text_color(t.muted).child("Reading Pi sessions…"));
        const where = this.machine() ?? "this computer";
        return v_flex()
            .p(14)
            .gap(6)
            .text_size(12.5)
            .text_color(t.dim)
            .child(
                div()
                    .text_color(t.muted)
                    .child(this.error ? "Cannot read the Pi sessions" : "No Pi session with Jig running"),
            )
            .child(div().child(this.error ?? `Looked in ${this.dir ?? "the Jig state folder"} on ${where}.`));
    }

    render(cx) {
        this.lastRenderAt = Date.now();
        const t = theme();
        const { session, by } = this.current();
        const live = this.sessions.filter((s) => s.alive);
        const root = v_flex()
            .id("jig-context")
            .size_full()
            .min_h(0)
            .bg(t.chrome)
            .text_color(t.foreground)
            .on_size_change((size, cx) => {
                if (Math.round(size.width) === Math.round(this.width)) return;
                this.width = size.width;
                cx.notify();
            });
        if (!session)
            return root
                .child(
                    h_flex()
                        .h(42)
                        .flex_none()
                        .px(12)
                        .gap(7)
                        .items_center()
                        .border_b(1)
                        .border_color(t.border)
                        .child(div().flex_none().text_color(t.accent).font_semibold().child("π"))
                        .child(div().flex_1().min_w(0).truncate().font_semibold().child("Context")),
                )
                .child(this.empty(t));
        const st = session.status;
        const detail = st.contextDetail;
        const answer = this.answer(t, st);
        const body = v_flex().id("jc-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar();
        return root
            .child(this.topBar(t, cx, session, by))
            .child(this.infoBar(t, session, by))
            .when(this.pickerOpen && live.length > 1, (el) => el.child(this.picker(t, live, session)))
            .child(
                detail && typeof detail === "object"
                    ? body
                          .child(this.summary(t, detail))
                          .when(answer !== null, (el) => el.child(answer))
                          .child(this.tools(t, session, detail))
                          .child(this.skills(t, session, detail))
                          .child(this.files(t, detail))
                    : div()
                          .p(14)
                          .text_size(12)
                          .text_color(t.dim)
                          .child(
                              "This session writes no context figures: its jig-session is older. Update Jig, then /reload.",
                          ),
            );
    }
}
