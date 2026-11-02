// The Jig Context panel: what fills the context of the Pi session in focus, from the status file the jig-session Pi plugin
// writes for each session (its format: ../../../plugins/jig-session/README.md). A bar and a legend (messages, tools, system
// prompt, skills, context files, the compaction buffer, free space), then the tools and skills with a switch each, and the
// context files.
//
// While the panel is on screen it reads the status files every 2 seconds with one `sh` on the machine where Pi runs (the
// Work panel's config.json: `machine`, else the shown space's machine). A switch or Reload writes one request file next to
// the session's status file, by a temporary file and a rename; the session applies it and answers in its status file
// (`lastRequest`). A request can only switch a tool or a skill for that session, or reload it when idle: it approves
// nothing, and jig-core's rules still decide every call of a tool switched on.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec, focused, layout, readTextFile, spaces, theme } from "herdr";
import {
    SCRIPT,
    WRITE,
    addSwitch,
    folderName,
    headline,
    isShown,
    parseConfig,
    parseSessions,
    percent,
    pickSession,
    requestJson,
    requestPath,
    segments,
    short,
    shownOn,
    splitPath,
} from "./lib.js";

const EVERY_MS = 2000; // status files, while on screen
const ANSWER_MS = 10000; // how long a request may wait before the panel says the session does not answer

// Which lists are open, remembered in the mod's own storage.
function readOpen() {
    try {
        return JSON.parse(localStorage.getItem("open") ?? "{}");
    } catch {
        return {};
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
        this.home = null;
        this.open = { tools: false, skills: false, files: false, ...readOpen() };
        this.pending = null; // switches sent and not answered yet: { tools, skills, reload }
        this.pendingFor = null; // the session they were sent to
        this.sentId = null;
        this.sentAt = 0;
        this.sendError = null;
        this.seq = 0;
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    machine() {
        return this.config.machine ?? spaces().find((s) => s.active)?.machine ?? null;
    }

    current() {
        const f = focused();
        return pickSession(this.sessions, {
            machine: this.machine(),
            focused: f?.terminal ?? null,
            agent: f?.agent ?? null,
        });
    }

    // Once a second, never from render: load only while the panel is on screen.
    tick(cx) {
        if (!isShown(layout(), "jig-context")) return;
        if (!this.loading && Date.now() - this.loadedAt >= EVERY_MS) this.load(cx);
        else if (this.sentId && Date.now() - this.sentAt > ANSWER_MS) cx.notify(); // the "no answer" line
    }

    load(cx) {
        this.loading = true;
        cx.spawn(async (cx) => {
            try {
                const text = await readTextFile(`${appHome()}/mods/jig-work/config.json`, { on: null });
                this.config = parseConfig(text);
                const on = this.machine();
                const r = await exec("sh", ["-c", SCRIPT, "sh", this.config.stateDir ?? ""], { on });
                if (this.home === null) {
                    const h = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
                    this.home = h?.stdout ?? "";
                }
                if (r.stdout === this.raw && this.error === null) return;
                this.raw = r.stdout;
                this.dir = /^@@dir (.*)$/m.exec(r.stdout)?.[1] ?? null;
                this.sessions = parseSessions(r.stdout);
                this.error = null;
                this.settle();
                cx.notify();
            } catch (e) {
                const message = String(e?.message ?? e);
                if (message !== this.error) {
                    this.error = message;
                    cx.notify();
                }
            } finally {
                this.loading = false;
                this.loadedAt = Date.now();
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
            this.loadedAt = 0; // read the answer soon
            cx.notify();
        });
        cx.notify();
    }

    // ---- drawing ---------------------------------------------------------------------------------------------------

    toggle(t, id, on, waiting, onClick) {
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
            .on_click(onClick)
            .child(
                div()
                    .size(10)
                    .rounded_full()
                    .bg(on ? t.accent_foreground : t.dim),
            );
    }

    header(t, session, by) {
        const st = session.status;
        const model = st.model?.name ?? st.model?.id ?? "no model";
        const reloading = this.pending?.reload || st.lastRequest?.reload === "waiting";
        return v_flex()
            .px(14)
            .py(10)
            .gap(6)
            .border_b(1)
            .border_color(t.border)
            .child(
                h_flex()
                    .gap(8)
                    .items_center()
                    .text_size(13)
                    .child(div().text_color(t.accent).font_semibold().child("π"))
                    .child(
                        div().flex_none().font_semibold().text_color(t.foreground).child(folderName(st.cwd, this.home)),
                    )
                    .child(div().text_color(t.dim).child("·"))
                    .child(div().min_w(0).truncate().text_color(t.muted).child(model))
                    .child(div().flex_1())
                    .when(by !== "focus", (el) =>
                        el.child(div().flex_none().text_size(11).text_color(t.dim).child("last active")),
                    )
                    .child(
                        div()
                            .id("jc-reload")
                            .flex_none()
                            .px(8)
                            .h(22)
                            .flex()
                            .items_center()
                            .rounded(4)
                            .border(1)
                            .border_color(t.border)
                            .text_size(11.5)
                            .text_color(reloading ? t.working : t.muted)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                            .tooltip("Reload Pi's extensions, skills, prompts and context files once the agent is idle")
                            .on_click((_e, cx) => this.send(cx, session, "reload"))
                            .child(reloading ? "Reloading…" : "Reload"),
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
                    .child(
                        detail.usedFrom === "parts"
                            ? "≈ counted as characters / 4. No reply yet: the total adds up the parts."
                            : "≈ counted as characters / 4. Messages: Pi's total less the other parts.",
                    ),
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
                try {
                    localStorage.setItem("open", JSON.stringify(this.open));
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
                                    this.toggle(t, `jc-tool-${i}`, shown, waiting, (_e, cx) =>
                                        this.send(cx, session, "tools", x.name, !shown),
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
                                    this.toggle(t, `jc-skill-${i}`, shown, shown !== x.on, (_e, cx) =>
                                        this.send(cx, session, "skills", x.name, !shown),
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

    render(_cx) {
        const t = theme();
        const { session, by } = this.current();
        const root = v_flex().id("jig-context").size_full().min_h(0).bg(t.chrome).text_color(t.foreground);
        if (!session) return root.child(this.empty(t));
        const st = session.status;
        const detail = st.contextDetail;
        const body = v_flex().id("jc-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar();
        if (!detail || typeof detail !== "object")
            return root
                .child(this.header(t, session, by))
                .child(
                    div()
                        .p(14)
                        .text_size(12)
                        .text_color(t.dim)
                        .child(
                            "This session writes no context figures: its jig-session is older. Update Jig, then /reload.",
                        ),
                );
        const answer = this.answer(t, st);
        return root.child(this.header(t, session, by)).child(
            body
                .child(this.summary(t, detail))
                .when(answer !== null, (el) => el.child(answer))
                .child(this.tools(t, session, detail))
                .child(this.skills(t, session, detail))
                .child(this.files(t, detail)),
        );
    }
}
