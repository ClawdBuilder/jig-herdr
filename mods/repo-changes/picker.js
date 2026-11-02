// The branch picker: a popup the Changes panel opens on a checkout's branch chip (openOverlay of this same mod, with
// `props().picker`). A search box, the local branches (the current one ticked, one checked out in another worktree greyed
// and not pickable), then origin's branches that have no local one, and "New branch…". The git work is in lib.js; this
// file only draws and passes Herdr's exec with the space's machine. A refusal is shown here and the popup stays open.

import { div, svg } from "gpui-kit";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { appHome, closeOverlay, exec, panes, readTextFile, setShared, spaces, theme } from "herdr";
import {
    busyAgents,
    defaultBase,
    filterBranches,
    listBranches,
    newBranch,
    parseConfig,
    switchBranch,
    switchRefusal,
} from "./lib.js";

/** Shared key the picker sets after a switch, so the panel says so and reads the checkouts again at once. */
export const DONE = "repo-changes.done";
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const pickable = (b) => !b.current && !b.inUse;

/** The panes of terminals on a machine, as busyAgents takes them. */
function panesOn(on) {
    const machineOf = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, s.machine ?? null])));
    return panes()
        .filter((p) => p.terminal && machineOf.get(p.tab) === (on ?? null))
        .map((p) => ({ cwd: p.cwd, status: p.status, name: p.program?.name || p.title }));
}

/** A box around an Input, as the panel's filter is drawn. */
function field(t, id, state) {
    return div()
        .id(id)
        .h(30)
        .flex_none()
        .px(10)
        .flex()
        .items_center()
        .rounded(8)
        .border_1()
        .border_color(t.input ?? t.border)
        .cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground));
}

function button(t, id, label, onClick, solid = false) {
    return div()
        .id(id)
        .flex_none()
        .h(26)
        .px(10)
        .flex()
        .items_center()
        .rounded(6)
        .text_size(12)
        .cursor_pointer()
        .bg(solid ? (t.solid ?? t.accent) : t.raised)
        .text_color(solid ? (t.solid_foreground ?? t.accent_foreground) : t.foreground)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
        })
        .child(label);
}

export class BranchPicker {
    constructor(props, cx) {
        const p = props.picker ?? {};
        this.overlay = props.overlay;
        this.on = p.on ?? null;
        this.path = p.path ?? "";
        this.name = p.name ?? this.path.split("/").pop();
        this.others = p.others ?? [];
        this.branches = null;
        this.config = parseConfig(null);
        this.base = null;
        this.filter = "";
        this.warning = null; // why a switch would be refused now, shown before anything is picked
        this.message = null; // the last refusal or git error
        this.creating = false;
        this.working = false;
        this.search = InputState.new({ placeholder: "Find a branch" });
        this.search.on("change", (_e, cx) => {
            this.filter = this.search.value();
            cx.notify();
        });
        this.search.on("submit", (_e, cx) => {
            const first = filterBranches(this.branches ?? [], this.filter).find(pickable);
            if (first) this.pick(cx, first);
        });
        this.nameInput = InputState.new({ placeholder: "feature/PROJ-123" });
        this.nameInput.on("submit", (_e, cx) => this.create(cx));
        this.search.focus();
        cx.spawn(async (cx) => {
            await this.load();
            cx.notify();
        });
    }

    /** Herdr's exec on the checkout's machine. */
    exec() {
        const on = this.on;
        return (cmd, args, options) => exec(cmd, args, { ...options, on });
    }

    busyHere() {
        return busyAgents(this.path, panesOn(this.on), this.others);
    }

    async load() {
        try {
            const text = await readTextFile(`${appHome()}/mods/repo-changes/config.json`).catch(() => null);
            this.config = parseConfig(text);
            const list = await listBranches(this.exec(), this.path);
            if (!list.ok) throw new Error(list.message);
            this.branches = list.branches;
            this.base = await defaultBase(this.exec(), this.path, this.config);
            this.nameInput.set_value(this.config.newBranchPrefix);
            this.warning = await switchRefusal(this.exec(), this.path, this.busyHere());
        } catch (e) {
            this.message = String(e?.message ?? e).split("\n")[0];
        }
    }

    /** Runs a switch or a new branch; on success closes the popup and tells the panel, else shows why here. */
    act(cx, fn) {
        if (this.working) return;
        this.working = true;
        this.message = null;
        cx.spawn(async (cx) => {
            let r;
            try {
                r = await fn();
            } catch (e) {
                r = { ok: false, message: String(e?.message ?? e).split("\n")[0] };
            }
            this.working = false;
            if (r.ok) {
                setShared(DONE, { path: this.path, message: r.message, at: Date.now() });
                closeOverlay(this.overlay);
                return;
            }
            this.message = r.message;
            cx.notify();
        });
        cx.notify();
    }

    pick(cx, branch) {
        if (!pickable(branch)) return;
        this.act(cx, () =>
            switchBranch(this.exec(), { checkout: this.path, branch: branch.name, busy: this.busyHere() }),
        );
    }

    create(cx) {
        const name = this.nameInput.value().trim();
        this.act(cx, () =>
            newBranch(this.exec(), { checkout: this.path, name, base: this.base, busy: this.busyHere() }),
        );
    }

    row(t, b) {
        const can = pickable(b) && !this.working;
        return h_flex()
            .id(`pick-${b.remote ? "r" : "l"}-${b.name}`)
            .h(26)
            .flex_none()
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .text_size(12.5)
            .text_color(b.inUse ? t.dim : t.foreground)
            .when(can, (el) =>
                el
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.pick(cx, b)),
            )
            .child(
                div()
                    .w(12)
                    .flex_none()
                    .text_color(t.accent)
                    .child(b.current ? svg(ICON("check")).size(12) : ""),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .child(b.remote ? `origin/${b.name}` : b.name),
            )
            .when(Boolean(b.inUse), (el) =>
                el.child(div().flex_none().text_size(11).text_color(t.dim).child(`in use by ${b.inUse}`)),
            )
            .when(b.current, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("current")));
    }

    list(t) {
        if (!this.branches)
            return [
                div()
                    .p(8)
                    .text_color(t.dim)
                    .child(this.message ? "" : "Reading branches…"),
            ];
        const shown = filterBranches(this.branches, this.filter);
        const local = shown.filter((b) => !b.remote),
            remote = shown.filter((b) => b.remote);
        const heading = (text) =>
            div().flex_none().px(8).pt(8).pb(2).text_size(10.5).font_semibold().text_color(t.dim).child(text);
        return [
            ...local.map((b) => this.row(t, b)),
            ...(remote.length ? [heading("ON ORIGIN ONLY"), ...remote.map((b) => this.row(t, b))] : []),
            ...(shown.length ? [] : [div().p(8).text_color(t.dim).child("No branch matches")]),
        ];
    }

    footer(t) {
        if (!this.creating)
            return h_flex()
                .id("new-branch")
                .h(28)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .rounded(6)
                .text_size(12.5)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                    this.creating = true;
                    this.nameInput.focus();
                    cx.notify();
                })
                .child(svg(ICON("plus")).size(12).flex_none())
                .child(div().child("New branch…"));
        return v_flex()
            .flex_none()
            .gap(6)
            .child(
                div()
                    .text_size(11.5)
                    .text_color(t.muted)
                    .child(`New branch from origin/${this.base ?? "…"}, fetched first`),
            )
            .child(field(t, "new-name", this.nameInput))
            .child(
                h_flex()
                    .gap(6)
                    .justify_end()
                    .child(
                        button(t, "new-cancel", "Cancel", (cx) => {
                            this.creating = false;
                            cx.notify();
                        }),
                    )
                    .child(
                        button(t, "new-create", this.working ? "Working…" : "Create", (cx) => this.create(cx), true),
                    ),
            );
    }

    render(_cx) {
        const t = theme();
        return v_flex()
            .id("branch-picker")
            .size_full()
            .min_h(0)
            .p(10)
            .gap(8)
            .bg(t.popover)
            .text_color(t.foreground)
            .text_size(13)
            .child(
                h_flex()
                    .flex_none()
                    .gap(6)
                    .items_center()
                    .child(svg(ICON("branch")).size(13).flex_none())
                    .child(div().flex_none().font_semibold().child("Switch branch"))
                    .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.name)),
            )
            .when(Boolean(this.warning), (el) =>
                el.child(
                    div().flex_none().text_size(11.5).text_color(t.blocked).child(`Refused for now: ${this.warning}`),
                ),
            )
            .child(field(t, "branch-search", this.search))
            .child(v_flex().id("branch-list").flex_1().min_h(0).overflow_y_scrollbar().children(this.list(t)))
            .when(Boolean(this.message), (el) =>
                el.child(div().flex_none().text_size(11.5).text_color(t.blocked).child(this.message)),
            )
            .when(this.working && !this.creating, (el) =>
                el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Working…")),
            )
            .child(div().flex_none().h(1).bg(t.border))
            .child(this.footer(t));
    }
}
