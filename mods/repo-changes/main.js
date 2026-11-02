// Every git repo under the space's folder, with their changes: a VS Code-style source control list.
// One shell script per refresh reads all repos (see lib.js); a click on a file opens it in a full-size Review tab (see ../repo-review).
// Read-only: no commit, stage or fetch here.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, terminals, exec, run, theme, layout, shared, setShared } from "herdr";
import { SCRIPT, CAP, parseRepos, filterRepos, splitPath } from "./lib.js";
import { shown } from "./layout.js";

// Herdr can only watch folders on this computer, so a space on another machine is polled. All repos
// take well under a second, so poll often, and at once when a terminal or agent changes state
// (an agent finishing a turn, a command ending): that's when files change.
const EVERY = 5000; // refresh period while the panel is in view
const visible = () => shown(layout(), "repo-changes");
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// Where to look: the machine, and the space's folder (else where its first terminal is now).
function location() {
    const space = spaces().find((s) => s.active),
        f = focused();
    const on =
        f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
    const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
    const first = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { root: space?.folder || first || pane?.cwd || f?.cwd, on, space: space?.id };
}

// Count for the panel's icon on jig-activity's bar; only on change, since setting re-renders every mod.
function badge(count) {
    const value = { count, tone: "accent" };
    if (JSON.stringify(shared("badge.repo-changes")) !== JSON.stringify(value)) setShared("badge.repo-changes", value);
}

export default class RepoChanges extends View {
    init(_props, cx) {
        this.repos = [];
        this.error = null;
        this.loaded = false;
        this.last = 0;
        this.filter = "";
        this.folded = new Set();
        this.cleanOpen = false;
        this.hover = null;
        this.input = InputState.new({ placeholder: "Filter repos and files" });
        this.input.on("change", (_e, cx) => {
            this.filter = this.input.value();
            cx.notify();
        });
        this.input.on("focus", (_e, cx) => {
            this.typing = true;
            cx.notify();
        });
        this.input.on("blur", (_e, cx) => {
            this.typing = false;
            cx.notify();
        });
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    // Cheap check every second; the git work only runs while the panel is in view.
    // Not from render: refresh notifies, and render may not.
    tick(cx) {
        const seen = Boolean(this.loc) && visible(),
            appeared = seen && !this.seen;
        this.seen = seen;
        if (!seen) return;
        const states = terminals()
            .map((t) => `${t.address}:${t.status}`)
            .join(" ");
        const changed = this.states !== undefined && states !== this.states;
        this.states = states;
        if (!this.loaded || appeared || changed || Date.now() - this.last >= EVERY) this.refresh(cx);
    }

    refresh(cx) {
        if (this.loading) return;
        const { root, on } = this.loc,
            context = this.context;
        if (!root) {
            this.error = "No folder";
            return;
        }
        this.loading = true;
        cx.spawn(async (cx) => {
            try {
                const r = await exec("sh", ["-c", SCRIPT, "sh", root], { on });
                if (context !== this.context) return;
                if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().split("\n")[0]);
                this.repos = parseRepos(r.stdout, root);
                this.error = null;
                this.loaded = true;
                badge(this.repos.filter((x) => x.files.length).length);
            } catch (e) {
                if (context === this.context) this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loading = false;
                this.last = Date.now();
                cx.notify();
            }
        });
        cx.notify();
    }

    // A click on a file: show it in the repo's Review tab, which is made on the first click and
    // retargeted (shared state, then selected) on the next ones.
    review(repo, file) {
        const { space, on } = this.loc,
            name = `Review · ${repo.name}`;
        const tab = spaces()
            .find((s) => s.id === space)
            ?.tabs.find((t) => t.name === name);
        if (!tab)
            return run("tab.new", {
                space,
                name,
                mod: "repo-review",
                props: { on, repo: repo.path, name: repo.name, file: file.path },
            });
        setShared("repo-review.open", { repo: repo.path, file: file.path, at: Date.now() });
        run("tab.select", { id: tab.id });
    }

    fold(path, cx) {
        if (!this.folded.delete(path)) this.folded.add(path);
        cx.notify();
    }

    // A new terminal tab in that repo, in the shown space (so on its machine).
    terminal(repo) {
        run("tab.new", { space: this.loc.space, folder: repo.path });
    }

    // The small terminal button that appears while the pointer is on a repo's row.
    terminalButton(t, repo) {
        return div()
            .id(`term-${repo.path}`)
            .flex_none()
            .w(22)
            .h(20)
            .flex()
            .items_center()
            .justify_center()
            .rounded(5)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .tooltip("Open a terminal here")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
                cx.stop_propagation();
                this.terminal(repo);
            })
            .child(svg(ICON("terminal")).size(13));
    }

    // Name (folder name, then the folders above it dimmed), shared by changed and clean rows.
    repoName(t, repo) {
        const name = base(repo.name),
            dir = repo.name.slice(0, repo.name.length - name.length).replace(/\/$/, "");
        return h_flex()
            .flex_1()
            .min_w(0)
            .gap(6)
            .items_baseline()
            .child(div().flex_none().max_w(200).truncate().font_semibold().child(name))
            .when(Boolean(dir), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)));
    }

    // Branch and ahead/behind, shown after the name.
    branchInfo(t, repo) {
        return [
            h_flex()
                .flex_none()
                .max_w(130)
                .gap(4)
                .items_center()
                .text_size(11)
                .text_color(t.muted)
                .child(svg(ICON("branch")).size(11).flex_none())
                .child(div().min_w(0).truncate().child(repo.branch)),
            repo.ahead ? div().flex_none().text_size(11).text_color(t.foreground).child(`↑${repo.ahead}`) : null,
            repo.behind ? div().flex_none().text_size(11).text_color(t.blocked).child(`↓${repo.behind}`) : null,
        ].filter(Boolean);
    }

    // A repo with changes: a folding header, then its files.
    changedRepo(t, repo, q) {
        const open = q || !this.folded.has(repo.path);
        const header = h_flex()
            .id(`repo-${repo.path}`)
            .h(28)
            .flex_none()
            .px(6)
            .gap(6)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.fold(repo.path, cx))
            .on_hover((on, cx) => {
                this.hover = on ? repo.path : this.hover === repo.path ? null : this.hover;
                cx.notify();
            })
            .child(
                div()
                    .flex_none()
                    .text_color(t.dim)
                    .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12)),
            )
            .child(this.repoName(t, repo))
            .children(this.branchInfo(t, repo))
            .when(this.hover === repo.path, (el) => el.child(this.terminalButton(t, repo)))
            .child(
                div()
                    .flex_none()
                    .px(5)
                    .rounded(4)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .child(String(repo.total)),
            );
        const more = repo.total - repo.files.length;
        return v_flex()
            .flex_none()
            .child(header)
            .when(open, (el) =>
                el
                    .children(repo.files.map((f) => this.fileRow(t, repo, f)))
                    .when(more > 0, (e) =>
                        e.child(
                            div()
                                .pl(32)
                                .py(3)
                                .text_size(11)
                                .text_color(t.dim)
                                .child(`+${more} more (first ${CAP} shown)`),
                        ),
                    ),
            );
    }

    fileRow(t, repo, f) {
        const { dir, name } = splitPath(f.path);
        const color =
            f.status === "A" || f.status === "??"
                ? t.ansi2
                : f.status === "D" || f.status === "U"
                  ? t.ansi1
                  : f.status === "R"
                    ? t.ansi5
                    : t.blocked;
        return h_flex()
            .id(`file-${repo.path}/${f.path}`)
            .h(24)
            .flex_none()
            .pl(24)
            .pr(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.review(repo, f))
            .child(div().w(18).flex_none().text_size(11).text_color(color).child(f.status))
            .child(
                h_flex()
                    .flex_1()
                    .min_w(0)
                    .text_size(12.5)
                    .child(div().min_w(0).truncate().text_color(t.dim).child(dir))
                    .child(div().flex_none().max_w(260).truncate().child(name)),
            );
    }

    cleanRow(t, repo) {
        return h_flex()
            .id(`clean-${repo.path}`)
            .h(26)
            .flex_none()
            .pl(24)
            .pr(6)
            .gap(6)
            .items_center()
            .rounded(6)
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover))
            .on_hover((on, cx) => {
                this.hover = on ? repo.path : this.hover === repo.path ? null : this.hover;
                cx.notify();
            })
            .child(this.repoName(t, repo))
            .children(this.branchInfo(t, repo))
            .when(this.hover === repo.path, (el) => el.child(this.terminalButton(t, repo)));
    }

    // The list: changed repos first, unreadable ones, then the clean group.
    list(t) {
        const q = this.filter.trim() !== "",
            all = filterRepos(this.repos, this.filter);
        const changed = all.filter((r) => !r.error && r.files.length),
            clean = all.filter((r) => !r.error && !r.files.length);
        const broken = all.filter((r) => r.error),
            open = q || this.cleanOpen;
        const items = [
            ...changed.map((r) => this.changedRepo(t, r, q)),
            ...broken.map((r) =>
                div()
                    .flex_none()
                    .px(8)
                    .py(3)
                    .text_size(11)
                    .text_color(t.blocked)
                    .truncate()
                    .child(`${r.name}: ${r.error}`),
            ),
        ];
        if (clean.length) {
            items.push(
                h_flex()
                    .id("clean-group")
                    .h(28)
                    .flex_none()
                    .mt(6)
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                        this.cleanOpen = !this.cleanOpen;
                        cx.notify();
                    })
                    .child(
                        div()
                            .flex_none()
                            .text_color(t.dim)
                            .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12)),
                    )
                    .child(div().font_semibold().child(`Clean (${clean.length})`)),
            );
            if (open) items.push(...clean.map((r) => this.cleanRow(t, r)));
        }
        return items;
    }

    render() {
        const t = theme(),
            loc = location(),
            context = JSON.stringify([loc.root, loc.on]);
        if (context !== this.context) {
            // Another space or folder: forget the old repos, load the new ones when in view.
            Object.assign(this, { context, loc, repos: [], error: null, loaded: false, folded: new Set() });
        }
        this.loc = loc;

        const changed = this.repos.filter((r) => r.files.length).length;
        const summary = this.loaded
            ? `${this.repos.length} repo${this.repos.length === 1 ? "" : "s"} · ${changed} changed`
            : "";
        const items = this.list(t);
        const empty =
            this.loaded && !this.repos.length
                ? "No git repositories here"
                : this.loaded && !items.length
                  ? "No matches"
                  : !this.loaded && !this.error
                    ? "Loading repos…"
                    : null;
        return v_flex()
            .id("repo-changes")
            .size_full()
            .min_h(0)
            .rounded(10)
            .overflow_hidden()
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .text_size(13)
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
                            .min_w(0)
                            .truncate()
                            .font_semibold()
                            .child(loc.root ? base(loc.root) || "/" : "Repos"),
                    )
                    .child(div().flex_none().text_size(11).text_color(t.muted).child(summary))
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("repos-refresh")
                            .flex_none()
                            .text_size(11)
                            .text_color(t.dim)
                            .cursor_pointer()
                            .hover((s) => s.text_color(t.foreground))
                            .on_click((_e, cx) => this.refresh(cx))
                            .child(this.loading ? "Loading…" : "Refresh"),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .p(8)
                    .pb(4)
                    .child(
                        div()
                            .id("repos-filter")
                            .h(30)
                            .px(10)
                            .flex()
                            .items_center()
                            .rounded(8)
                            .border_1()
                            .border_color(this.typing ? t.accent : t.border)
                            .cursor_text()
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .child(Input.new(this.input).h_full().w_full().text_size(12).text_color(t.foreground)),
                    ),
            )
            .when(Boolean(this.error), (el) =>
                el.child(
                    div().flex_none().px(12).py(3).truncate().text_size(11).text_color(t.blocked).child(this.error),
                ),
            )
            .child(
                v_flex()
                    .id("repos-list")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
                    .when(Boolean(empty), (el) => el.child(div().p(8).text_color(t.dim).child(empty)))
                    .children(items),
            );
    }
}
