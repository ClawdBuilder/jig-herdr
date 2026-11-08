// A full-tab, read-only viewer for one file, opened with tab.new { mod: "file-view", props: { on, path } }.
// jig-work opens one from its Outputs list; any mod may.
//
// props: { on: "<machine, or null for this computer>", path: "<absolute path on that machine>" }
// A mod that opens these tabs may keep shared("file-view.tabs"), a map of "<on>|<path>" to the tab id, so that a second
// click selects the tab instead of opening another, and so that this copy knows which tab is its own.

import { Editor, EditorState, h_flex, TextView, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { appHome, props as modProps, panes, readTextFile, settings, shared, spaces, theme, window } from "herdr";
import { isMarkdown, parseConfig, splitPath, wrapDefault } from "./lib.js";
import { focusRegained, RefreshScheduler, RefreshState, refreshSeconds } from "./refresh.js";

// Same extension mapping and limits as the shipped Files preview.
const LANG = {
    ts: "js",
    tsx: "js",
    mts: "js",
    cts: "js",
    jsx: "js",
    mjs: "js",
    toml: "yaml",
    jsonc: "json",
    svelte: "html",
    vue: "html",
};
const MAX = 400000;
const OWN = (name) => `mods/file-view/${name}.svg`;

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
// Markdown is shown rendered first; the header's Source button shows the text.

export default class FileView extends View {
    init(_props, cx) {
        const props = modProps() ?? {}; // what tab.new gave this copy; none under herdr-app check
        this.path = props.path ?? "";
        this.on = props.on ?? null;
        this.text = null;
        this.code = null;
        this.lines = 0;
        this.fileError = null;
        this.copied = false;
        this.loading = false;
        this.last = 0;
        this.wasShown = false;
        this.seq = 0;
        this.markdown = isMarkdown(this.path);
        this.preview = this.markdown;
        this.config = parseConfig(null);
        this.configAt = 0;
        this.wrap = wrapDefault(this.path, localStorage.getItem("wrap"));
        this.refreshState = new RefreshState();
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config) });
        this.windowActive = window()?.active === true;
        this.loaded = false;
        this.loadConfig(cx);
        this.refreshScheduler.trigger();
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    // Is this copy's tab the one on screen? The path -> tab map in shared("file-view.tabs") says which tab is ours;
    // without it (a tab opened another way) any file-view tab on screen counts.
    shown() {
        const tab = spaces()
            .find((s) => s.active)
            ?.tabs.find((t) => t.active);
        if (!tab) return false;
        const mine = shared("file-view.tabs")?.[`${this.on ?? ""}|${this.path}`];
        if (mine) return mine === tab.id;
        return panes().some((p) => p.tab === tab.id && p.mod === "file-view");
    }

    // Once a second: read when the tab comes back, on focus/session change, on the backstop, or when clicked. No 5 s loop.
    tick(cx) {
        const shown = this.shown(),
            back = shown && !this.wasShown;
        this.wasShown = shown;
        this.loadConfig(cx);
        if (!shown) return;
        const active = window()?.active === true;
        if (back || focusRegained(this.windowActive, active) || this.refreshScheduler.due()) this.load(cx);
        this.windowActive = active;
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < 5000) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/file-view/config.json`).catch(() => null);
            this.config = parseConfig(text);
            this.refreshScheduler.setSeconds(refreshSeconds(this.config));
            cx.notify();
        });
    }

    load(cx, user = false) {
        if (this.loading || !this.path) return;
        if (!this.refreshState.start({ user, first: !this.loaded, notify: () => cx.notify() })) return;
        this.refreshScheduler.sweep();
        this.loading = true;
        const seq = ++this.seq;
        cx.spawn(async (cx) => {
            try {
                const text = await readTextFile(this.path, { on: this.on });
                if (seq !== this.seq) return;
                if (text === null) {
                    this.setError("This file is no longer available");
                    return;
                }
                if (text.includes("\0")) {
                    this.setError("Binary file · no text preview");
                    return;
                }
                if (text === this.text && this.code) return; // unchanged: keep the editor (and its scroll)
                const t = theme(),
                    ext = this.path.includes(".") ? this.path.split(".").pop() : "txt";
                const shownText = text.length > MAX ? `${text.slice(0, MAX)}\n… (file truncated)` : text;
                const state = EditorState.new({
                    language: LANG[ext] ?? ext,
                    readonly: true,
                    soft_wrap: this.wrap,
                    value: shownText,
                    font_family: settings().font_family,
                    font_size: 13,
                    syntax: {
                        keyword: t.ansi5,
                        string: t.ansi2,
                        comment: t.dim,
                        function: t.ansi4,
                        type: t.ansi3,
                        number: t.ansi1,
                        constant: t.ansi6,
                    },
                });
                this.code?.release();
                this.code = state;
                this.text = text;
                this.shownText = shownText;
                this.fileError = null;
                this.lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
                this.loaded = true;
            } catch {
                this.setError("Cannot preview this file (binary, too large, or unreadable)");
            } finally {
                if (seq === this.seq) this.loading = false;
                const again = this.refreshState.finish();
                if (again) this.refreshScheduler.trigger();
                this.last = Date.now();
                cx.notify();
            }
        });
    }

    setError(message) {
        this.code?.release();
        this.code = null;
        this.text = null;
        this.lines = 0;
        this.fileError = message;
    }

    button(t, id, label, onClick, tip = "") {
        return div()
            .id(id)
            .flex_none()
            .h(22)
            .px(8)
            .flex()
            .items_center()
            .rounded(5)
            .text_size(12)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .when(Boolean(tip), (el) => el.tooltip(tip))
            .on_click(onClick)
            .child(label);
    }

    render(_cx) {
        const t = theme(),
            { name, dir } = splitPath(this.path),
            narrow = this.width > 0 && this.width < 420;
        return v_flex()
            .id("file-view")
            .size_full()
            .min_h(0)
            .bg(t.background)
            .text_color(t.foreground)
            .text_size(13)
            .on_size_change((size, cx) => {
                if (Math.round(size.width) === Math.round(this.width)) return;
                this.width = size.width;
                cx.notify();
            })
            .child(
                h_flex()
                    .h(42)
                    .flex_none()
                    .px(12)
                    .gap(8)
                    .items_center()
                    .border_b(1)
                    .border_color(t.border)
                    .child(
                        div()
                            .flex_none()
                            .max_w(narrow ? 120 : 260)
                            .truncate()
                            .font_semibold()
                            .tooltip(this.path || "No file")
                            .child(name || "File"),
                    )
                    .when(!narrow && Boolean(dir), (el) =>
                        el.child(
                            div()
                                .flex_1()
                                .min_w(0)
                                .truncate()
                                .text_size(12)
                                .text_color(t.dim)
                                .tooltip(this.path)
                                .child(dir),
                        ),
                    )
                    .when(narrow, (el) => el.child(div().flex_1()))
                    .when(this.lines > 0 && !narrow, (el) =>
                        el.child(
                            div()
                                .flex_none()
                                .text_size(12)
                                .text_color(t.dim)
                                .child(`${this.lines.toLocaleString("en-US")} line${this.lines === 1 ? "" : "s"}`),
                        ),
                    )
                    .when(this.markdown && Boolean(this.code), (el) =>
                        el.child(
                            this.button(t, "fv-mode", this.preview ? "Source" : "Preview", (_e, cx) => {
                                this.preview = !this.preview;
                                cx.notify();
                            }),
                        ),
                    )
                    .when(Boolean(this.code), (el) =>
                        el.child(
                            this.button(
                                t,
                                "fv-wrap",
                                this.wrap ? "Wrap on" : "Wrap off",
                                (_e, cx) => {
                                    this.wrap = !this.wrap;
                                    this.code?.set_soft_wrap(this.wrap);
                                    try {
                                        localStorage.setItem("wrap", this.wrap ? "on" : "off");
                                    } catch {}
                                    cx.notify();
                                },
                                this.wrap
                                    ? "Soft wrap is on: click to turn it off"
                                    : "Soft wrap is off: click to turn it on",
                            ),
                        ),
                    )
                    .child(
                        this.button(
                            t,
                            "fv-copy",
                            narrow ? "Copy" : "Copy path",
                            (_e, cx) => {
                                cx.write_to_clipboard(this.path);
                                this.copied = true;
                                cx.notify();
                                cx.timer.after(1500, (cx) => {
                                    this.copied = false;
                                    cx.notify();
                                });
                            },
                            "Copy the file's full path",
                        ),
                    )
                    .child(
                        iconButton(
                            t,
                            "fv-refresh",
                            OWN("refresh"),
                            this.refreshState.busy ? "Reading the file…" : "Read the file again",
                            (_e, cx) => this.load(cx, true),
                            this.refreshState.busy,
                        ),
                    ),
            )
            .child(
                this.code && this.preview
                    ? div()
                          .id("fv-md-scroll")
                          .flex_1()
                          .min_h(0)
                          .overflow_y_scroll()
                          .px(24)
                          .py(16)
                          .child(TextView.markdown("fv-md", this.shownText).w_full().selectable())
                    : this.code
                      ? Editor.new(this.code).flex_1().min_h(0)
                      : div()
                            .p(12)
                            .text_color(t.dim)
                            .child(
                                this.fileError ??
                                    (!this.path
                                        ? "Open a file from Files or Work."
                                        : this.loading || !this.loaded
                                          ? "Reading file…"
                                          : "No file"),
                            ),
            );
    }
}
