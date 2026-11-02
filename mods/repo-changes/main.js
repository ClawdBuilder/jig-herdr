// Every git checkout under the space's folder, with their changes: a VS Code-style source control list. A main checkout
// shows its linked worktrees under it as "↳ <folder>" rows. One shell script per refresh reads them all (see lib.js);
// a click on a file opens it in a full-size Review tab (see ../repo-review).
// Git actions, all in lib.js and each refreshing the list at once: a checkbox per file stages or unstages it, hover
// buttons stage or unstage a checkout's files and discard one file (after an inline confirm), a message box commits the
// staged files, and the branch chip opens the branch picker (picker.js, a popup of this same mod).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
    spaces,
    panes,
    focused,
    terminals,
    exec,
    run,
    theme,
    layout,
    shared,
    setShared,
    openOverlay,
    props as modProps,
} from "herdr";
import {
    SCRIPT,
    CAP,
    parseRepos,
    groupRepos,
    filterGroups,
    isClean,
    splitPath,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardFile,
    discardKind,
    commit,
} from "./lib.js";
import { shown } from "./layout.js";
import { BranchPicker, DONE } from "./picker.js";

// Herdr can only watch folders on this computer, so a space on another machine is polled. All repos
// take well under a second, so poll often, and at once when a terminal or agent changes state
// (an agent finishing a turn, a command ending): that's when files change.
const EVERY = 5000; // refresh period while the panel is in view
const NOTE_MS = 12000; // how long an action's result stays under its checkout
const visible = () => shown(layout(), "repo-changes");
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

/** A small square icon or glyph button that stops the click from reaching the row under it. */
function iconButton(t, id, content, tip, onClick) {
    return div()
        .id(id)
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
        .tooltip(tip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
        })
        .child(typeof content === "string" ? svg(ICON(content)).size(13) : content);
}

function textButton(t, id, label, onClick, danger = false) {
    return div()
        .id(id)
        .flex_none()
        .h(22)
        .px(8)
        .flex()
        .items_center()
        .rounded(6)
        .text_size(11.5)
        .cursor_pointer()
        .bg(danger ? t.blocked : t.raised)
        .text_color(danger ? t.background : t.foreground)
        .hover((s) => s.opacity(0.85))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
        })
        .child(label);
}

export default class RepoChanges extends View {
    init(_props, cx) {
        const p = modProps() ?? {};
        if (p.picker) {
            // This copy is the branch picker popup, not the panel.
            this.picker = new BranchPicker(p, cx);
            return;
        }
        this.repos = [];
        this.error = null;
        this.loaded = false;
        this.last = 0;
        this.filter = "";
        this.folded = new Set();
        this.cleanOpen = false;
        this.hover = null; // the checkout row under the pointer
        this.hoverFile = null; // the file row under the pointer
        this.confirm = null; // { key, repo, file, kind }: a discard waiting for its second click
        this.running = null; // the checkout an action runs in now
        this.notes = {}; // path -> { ok, message, at }: the last action's result there
        this.commits = new Map(); // path -> InputState of its commit message
        this.done = Number(shared(DONE)?.at ?? 0);
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
        const done = shared(DONE);
        if (done && done.at > this.done) {
            // The branch picker switched a checkout: say so under it, and read again now.
            this.done = done.at;
            this.notes[done.path] = { ok: true, message: done.message, at: Date.now() };
            this.last = 0;
            cx.notify();
        }
        const stale = Object.entries(this.notes).filter(([, n]) => Date.now() - n.at > NOTE_MS);
        if (stale.length) {
            for (const [path] of stale) delete this.notes[path];
            cx.notify();
        }
        this.makeCommitBoxes(cx);
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

    // A commit message box for each checkout with staged files. Input states are made here, never in render.
    makeCommitBoxes(cx) {
        let made = false;
        for (const repo of this.repos ?? []) {
            if (!repo.staged || this.commits.has(repo.path)) continue;
            const state = InputState.new({ placeholder: "Commit message" });
            state.on("submit", (_e, cx) => {
                const now = this.repos.find((r) => r.path === repo.path);
                if (now) this.commitNow(cx, now);
            });
            this.commits.set(repo.path, state);
            made = true;
        }
        if (made) cx.notify();
    }

    refresh(cx) {
        if (this.loading) {
            this.again = true;
            return;
        }
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
                this.last = this.again ? 0 : Date.now();
                this.again = false;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** Herdr's exec on the space's machine, as the actions in lib.js take it. */
    git() {
        const on = this.loc.on;
        return (cmd, args, options) => exec(cmd, args, { ...options, on });
    }

    /** Runs one action in a checkout, notes a failure (or, unless quiet, the result) under it, and reads again at once. */
    act(cx, repo, fn, quiet = false) {
        if (this.running) return;
        this.running = repo.path;
        const git = this.git(),
            context = this.context;
        cx.spawn(async (cx) => {
            let r;
            try {
                r = await fn(git);
            } catch (e) {
                r = { ok: false, message: String(e?.message ?? e).split("\n")[0] };
            }
            this.running = null;
            if (context === this.context) {
                if (!r.ok || !quiet) this.notes[repo.path] = { ...r, at: Date.now() };
                else delete this.notes[repo.path];
                this.refresh(cx);
            }
            cx.notify();
        });
        cx.notify();
    }

    commitNow(cx, repo) {
        const state = this.commits.get(repo.path);
        const message = state?.value() ?? "";
        this.act(cx, repo, async (git) => {
            const r = await commit(git, { checkout: repo.path, message });
            if (r.ok) state?.set_value("");
            return r;
        });
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

    /** The branch picker, as a popup at the pointer. */
    openPicker(repo) {
        openOverlay({
            mod: "repo-changes",
            kind: "popup",
            width: 360,
            height: 440,
            props: {
                picker: {
                    on: this.loc.on,
                    path: repo.path,
                    name: repo.name,
                    others: this.repos.map((r) => r.path),
                },
            },
        });
    }

    fold(path, cx) {
        if (!this.folded.delete(path)) this.folded.add(path);
        cx.notify();
    }

    hovering(path) {
        return (on, cx) => {
            this.hover = on ? path : this.hover === path ? null : this.hover;
            cx.notify();
        };
    }

    // Name (folder name, then the folders above it dimmed). A worktree under its main checkout starts with "↳".
    repoName(t, repo, nested) {
        const name = base(repo.name),
            dir = repo.name.slice(0, repo.name.length - name.length).replace(/\/$/, "");
        return h_flex()
            .flex_1()
            .min_w(0)
            .gap(6)
            .items_baseline()
            .when(nested, (el) => el.child(div().flex_none().text_color(t.dim).child("↳")))
            .child(
                div()
                    .flex_none()
                    .max_w(200)
                    .truncate()
                    .when(!nested, (el) => el.font_semibold())
                    .child(name),
            )
            .when(Boolean(dir), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)));
    }

    // The branch chip (a click opens the picker), then ahead and behind.
    branchInfo(t, repo) {
        return [
            h_flex()
                .id(`branch-${repo.path}`)
                .flex_none()
                .max_w(140)
                .h(20)
                .px(4)
                .gap(4)
                .items_center()
                .rounded(5)
                .text_size(11)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.raised).text_color(t.foreground))
                .tooltip("Switch branch")
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.openPicker(repo);
                })
                .child(svg(ICON("branch")).size(11).flex_none())
                .child(div().min_w(0).truncate().child(repo.branch)),
            repo.ahead ? div().flex_none().text_size(11).text_color(t.foreground).child(`↑${repo.ahead}`) : null,
            repo.behind ? div().flex_none().text_size(11).text_color(t.blocked).child(`↓${repo.behind}`) : null,
        ].filter(Boolean);
    }

    // The buttons that appear while the pointer is on a checkout's row.
    rowButtons(t, repo) {
        if (this.hover !== repo.path) return [];
        const buttons = [];
        if (repo.files.some((f) => f.unstaged))
            buttons.push(
                iconButton(t, `stage-all-${repo.path}`, "plus", "Stage all changes", (cx) =>
                    this.act(cx, repo, (git) => stageAll(git, { checkout: repo.path }), true),
                ),
            );
        if (repo.staged)
            buttons.push(
                iconButton(t, `unstage-all-${repo.path}`, "minus", "Unstage all", (cx) =>
                    this.act(cx, repo, (git) => unstageAll(git, { checkout: repo.path }), true),
                ),
            );
        buttons.push(
            iconButton(t, `term-${repo.path}`, "terminal", "Open a terminal here", () =>
                run("tab.new", { space: this.loc.space, folder: repo.path }),
            ),
        );
        return buttons;
    }

    // One checkout: its row, then (unless folded) its files, its commit box and the last action's result.
    checkout(t, repo, q, nested) {
        const has = repo.files.length > 0,
            open = has && (q || !this.folded.has(repo.path));
        const indent = nested ? 18 : 0;
        const header = h_flex()
            .id(`repo-${repo.path}`)
            .h(28)
            .flex_none()
            .pl(6 + indent)
            .pr(6)
            .gap(6)
            .items_center()
            .rounded(7)
            .hover((s) => s.bg(t.hover))
            .on_hover(this.hovering(repo.path))
            .when(has, (el) => el.cursor_pointer().on_click((_e, cx) => this.fold(repo.path, cx)))
            .child(
                div()
                    .w(12)
                    .flex_none()
                    .text_color(t.dim)
                    .when(has, (el) => el.child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12))),
            )
            .child(this.repoName(t, repo, nested))
            .children(this.branchInfo(t, repo))
            .children(this.rowButtons(t, repo))
            .when(this.running === repo.path, (el) =>
                el.child(div().flex_none().text_size(11).text_color(t.dim).child("…")),
            )
            .when(has, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .px(5)
                        .rounded(4)
                        .border_1()
                        .border_color(t.border)
                        .text_size(10)
                        .text_color(t.muted)
                        .child(String(repo.total)),
                ),
            );
        const more = repo.total - repo.files.length,
            note = this.notes[repo.path];
        return v_flex()
            .flex_none()
            .child(header)
            .when(Boolean(repo.error), (el) =>
                el.child(
                    div()
                        .pl(24 + indent)
                        .py(2)
                        .text_size(11)
                        .text_color(t.blocked)
                        .truncate()
                        .child(repo.error),
                ),
            )
            .when(open, (el) =>
                el
                    .children(repo.files.flatMap((f) => this.fileRows(t, repo, f, indent)))
                    .when(more > 0, (e) =>
                        e.child(
                            div()
                                .pl(48 + indent)
                                .py(3)
                                .text_size(11)
                                .text_color(t.dim)
                                .child(`+${more} more (first ${CAP} shown)`),
                        ),
                    )
                    .when(repo.staged > 0 && this.commits.has(repo.path), (e) =>
                        e.child(this.commitBox(t, repo, indent)),
                    ),
            )
            .when(Boolean(note), (el) =>
                el.child(
                    div()
                        .pl(24 + indent)
                        .pr(8)
                        .py(2)
                        .text_size(11)
                        .text_color(note.ok ? t.done : t.blocked)
                        .child(note.message),
                ),
            );
    }

    // The staged state as a box: ticked when staged, a dash when only part of it is.
    checkbox(t, repo, f) {
        const state = f.staged ? (f.unstaged ? "some" : "all") : "none";
        const tip =
            state === "all"
                ? "Staged · click to unstage"
                : state === "some"
                  ? "Partly staged · click to stage the rest"
                  : "Click to stage";
        return div()
            .id(`stage-${repo.path}/${f.path}`)
            .flex_none()
            .w(14)
            .h(14)
            .flex()
            .items_center()
            .justify_center()
            .rounded(3)
            .border_1()
            .border_color(state === "none" ? t.border : t.accent)
            .when(state === "all", (el) => el.bg(t.accent))
            .text_color(state === "all" ? t.accent_foreground : t.accent)
            .text_size(10)
            .cursor_pointer()
            .tooltip(tip)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
                cx.stop_propagation();
                const args = { checkout: repo.path, file: f.path };
                this.act(cx, repo, (git) => (state === "all" ? unstageFile(git, args) : stageFile(git, args)), true);
            })
            .child(state === "all" ? svg(ICON("check")).size(10) : state === "some" ? "–" : "");
    }

    // A file row, and under it the discard confirm when one is waiting.
    fileRows(t, repo, f, indent) {
        const { dir, name } = splitPath(f.path);
        const key = `${repo.path}/${f.path}`;
        const color =
            f.status === "A" || f.status === "??"
                ? t.ansi2
                : f.status === "D" || f.status === "U"
                  ? t.ansi1
                  : f.status === "R"
                    ? t.ansi5
                    : t.blocked;
        const kind = discardKind(f.xy);
        const row = h_flex()
            .id(`file-${key}`)
            .h(24)
            .flex_none()
            .pl(24 + indent)
            .pr(6)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_hover((on, cx) => {
                this.hoverFile = on ? key : this.hoverFile === key ? null : this.hoverFile;
                cx.notify();
            })
            .on_click(() => this.review(repo, f))
            .child(this.checkbox(t, repo, f))
            .child(div().w(18).flex_none().text_size(11).text_color(color).child(f.status))
            .child(
                h_flex()
                    .flex_1()
                    .min_w(0)
                    .text_size(12.5)
                    .child(div().min_w(0).truncate().text_color(t.dim).child(dir))
                    .child(div().flex_none().max_w(260).truncate().child(name)),
            )
            .when(this.hoverFile === key && !f.path.endsWith("/"), (el) =>
                el.child(
                    iconButton(
                        t,
                        `discard-${key}`,
                        div().text_size(13).child("↺"),
                        kind === "delete" ? "Delete this new file…" : "Discard changes…",
                        (cx) => {
                            this.confirm = { key, kind };
                            cx.notify();
                        },
                    ),
                ),
            );
        if (this.confirm?.key !== key) return [row];
        const text =
            kind === "delete"
                ? `${f.path} is not in the last commit: it will be DELETED from disk.`
                : `Discard every change to ${f.path}? It goes back to the last commit.`;
        const confirm = v_flex()
            .flex_none()
            .pl(48 + indent)
            .pr(8)
            .py(4)
            .gap(6)
            .text_size(11.5)
            .child(
                div()
                    .text_color(kind === "delete" ? t.blocked : t.muted)
                    .child(text),
            )
            .child(
                h_flex()
                    .gap(6)
                    .justify_end()
                    .child(
                        textButton(t, `discard-no-${key}`, "Cancel", (cx) => {
                            this.confirm = null;
                            cx.notify();
                        }),
                    )
                    .child(
                        textButton(
                            t,
                            `discard-yes-${key}`,
                            kind === "delete" ? "Delete file" : "Discard",
                            (cx) => {
                                this.confirm = null;
                                this.act(cx, repo, (git) =>
                                    discardFile(git, { checkout: repo.path, file: f.path, expect: kind }),
                                );
                            },
                            true,
                        ),
                    ),
            );
        return [row, confirm];
    }

    commitBox(t, repo, indent) {
        const state = this.commits.get(repo.path);
        return h_flex()
            .flex_none()
            .pl(24 + indent)
            .pr(6)
            .py(4)
            .gap(6)
            .items_center()
            .child(
                div()
                    .id(`message-${repo.path}`)
                    .flex_1()
                    .min_w(0)
                    .h(26)
                    .px(8)
                    .flex()
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(t.border)
                    .cursor_text()
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground)),
            )
            .child(
                textButton(t, `commit-${repo.path}`, `Commit ${repo.staged}`, (cx) => this.commitNow(cx, repo)).tooltip(
                    `Commit the ${plural(repo.staged, "staged file")} (git commit -m)`,
                ),
            );
    }

    // The list: groups with changes first (a main checkout, then its worktrees), then the clean group, folded.
    list(t) {
        const q = this.filter.trim() !== "",
            groups = filterGroups(groupRepos(this.repos), this.filter);
        const changed = groups.filter((g) => !isClean(g)),
            clean = groups.filter((g) => isClean(g));
        const open = q || this.cleanOpen;
        const items = changed.flatMap((g) => [
            this.checkout(t, g.main, q, false),
            ...g.worktrees.map((w) => this.checkout(t, w, q, true)),
        ]);
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
            if (open)
                items.push(
                    ...clean.flatMap((g) => [
                        this.checkout(t, g.main, q, false),
                        ...g.worktrees.map((w) => this.checkout(t, w, q, true)),
                    ]),
                );
        }
        return items;
    }

    render(cx) {
        if (this.picker) return this.picker.render(cx);
        const t = theme(),
            loc = location(),
            context = JSON.stringify([loc.root, loc.on]);
        if (context !== this.context) {
            // Another space or folder: forget the old repos, load the new ones when in view.
            Object.assign(this, {
                context,
                loc,
                repos: [],
                error: null,
                loaded: false,
                folded: new Set(),
                notes: {},
                confirm: null,
            });
        }
        this.loc = loc;

        const groups = groupRepos(this.repos),
            trees = this.repos.length - groups.length;
        const changed = this.repos.filter((r) => r.files.length).length;
        const summary = this.loaded
            ? [plural(groups.length, "repo"), trees ? plural(trees, "worktree") : null, `${changed} changed`]
                  .filter(Boolean)
                  .join(" · ")
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
