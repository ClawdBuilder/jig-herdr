// A full-tab, read-only viewer for one file, opened with tab.new { mod: "file-view", props: { on, path } }.
// jig-work opens one from its Outputs list; any mod may.
//
// props: { on: "<machine, or null for this computer>", path: "<absolute path on that machine>" }
// A mod that opens these tabs may keep shared("file-view.tabs"), a map of "<on>|<path>" to the tab id, so that a second
// click selects the tab instead of opening another, and so that this copy knows which tab is its own.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, readTextFile, theme, settings, shared, props as modProps } from "herdr";

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
const MAX = 400000,
    EVERY = 5000;

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
        this.load(cx);
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

    // Once a second: re-read when the tab has just come back, and every 5 s while it is shown.
    // Not from render: load() notifies, and render may not.
    tick(cx) {
        const shown = this.shown(),
            back = shown && !this.wasShown;
        this.wasShown = shown;
        if (shown && (back || Date.now() - this.last >= EVERY)) this.load(cx);
    }

    load(cx) {
        if (this.loading || !this.path) return;
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
                this.fileError = null;
                this.lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
            } catch {
                this.setError("Cannot preview this file (binary, too large, or unreadable)");
            } finally {
                if (seq === this.seq) this.loading = false;
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

    button(t, id, label, onClick) {
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
            .on_click(onClick)
            .child(label);
    }

    render(_cx) {
        const t = theme(),
            cut = Math.max(this.path.lastIndexOf("/"), this.path.lastIndexOf("\\"));
        const name = this.path.slice(cut + 1),
            dir = cut > 0 ? this.path.slice(0, cut) : cut === 0 ? "/" : "";
        return v_flex()
            .id("file-view")
            .size_full()
            .min_h(0)
            .bg(t.background)
            .text_color(t.foreground)
            .text_size(13)
            .child(
                h_flex()
                    .h(32)
                    .flex_none()
                    .px(12)
                    .gap(8)
                    .items_center()
                    .border_b(1)
                    .border_color(t.border)
                    .child(div().flex_none().font_semibold().text_color(t.foreground).child(name))
                    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(dir))
                    .when(this.lines > 0, (el) =>
                        el.child(
                            div()
                                .flex_none()
                                .text_size(12)
                                .text_color(t.dim)
                                .child(`${this.lines.toLocaleString("en-US")} line${this.lines === 1 ? "" : "s"}`),
                        ),
                    )
                    .child(
                        this.button(t, "fv-copy", this.copied ? "Copied" : "Copy path", (_e, cx) => {
                            cx.write_to_clipboard(this.path);
                            this.copied = true;
                            cx.notify();
                            cx.timer.after(1500, (cx) => {
                                this.copied = false;
                                cx.notify();
                            });
                        }),
                    )
                    .child(
                        this.button(t, "fv-refresh", "Refresh", (_e, cx) => {
                            this.last = 0;
                            this.load(cx);
                        }),
                    ),
            )
            .child(
                this.code
                    ? Editor.new(this.code).flex_1().min_h(0)
                    : div()
                          .p(12)
                          .text_color(t.dim)
                          .child(this.fileError || (this.path ? "Loading file…" : "No file")),
            );
    }
}
