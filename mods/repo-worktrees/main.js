// The linked worktrees of the space's folder. Inside one git repository: that repository's worktrees. On a folder that
// holds many repositories: the worktrees of every repository found under it, grouped by repository, each marked "Ready
// to remove" or "In progress". Everything is read with git on the space's machine (`on`); nothing is fetched and no remote
// is contacted. The one write is Remove, on a ready row, after an inline confirm: `git worktree remove` without --force,
// then `git branch -d` (never -D), so git itself refuses to lose anything.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, layout, panes, run, setShared, shared, spaces, theme } from "herdr";
import { isOnScreen, nameOf, parseTrees, REASON, readiness, relName, SCRIPT, since } from "./lib.js";

const onScreen = () => isOnScreen(layout(), "repo-worktrees");
const REUSE_MS = 30000; // a load is reused this long; Refresh asks again
const WORKING = new Set(["working", "blocked"]);

/** The folder to look at and the machine it is on: the shown space's folder, else where its first terminal is. */
function whereToLook() {
    const space = spaces().find((s) => s.active);
    const here = focused();
    let machine = space?.machine ?? null;
    if (here?.pane === null) machine = here.terminal?.includes("/") ? here.terminal.split("/")[0] : null;
    const tabIds = new Set((space?.tabs ?? []).map((tab) => tab.id));
    const firstCwd = panes().find((p) => tabIds.has(p.tab) && p.cwd)?.cwd;
    const focusedPane = here?.pane ? panes().find((p) => p.pane === here.pane) : null;
    return { root: space?.folder || firstCwd || focusedPane?.cwd || here?.cwd, on: machine };
}

/** Who is at a checkout: the space that was opened on it, any other space with a terminal in it, and whether an agent
 * there is working or blocked (a pane's own state, or its space's when the space was made there). */
function whoIsAt(path, machine) {
    const within = (cwd) => Boolean(cwd) && (cwd === path || cwd.startsWith(`${path}/`));
    const spacesHere = spaces().filter((s) => (s.machine ?? null) === (machine ?? null));
    const hasTerminalThere = (space) =>
        space.tabs.some((tab) => panes().some((p) => p.tab === tab.id && within(p.cwd)));
    const openedThere = spacesHere.find((s) => within(s.folder));
    const otherSpace = spacesHere.find((s) => !s.active && hasTerminalThere(s));
    const busy = spacesHere.some(
        (s) =>
            (within(s.folder) && WORKING.has(s.status)) ||
            panes().some((p) => within(p.cwd) && WORKING.has(p.status) && s.tabs.some((tab) => tab.id === p.tab)),
    );
    const anyone = openedThere || spacesHere.find(hasTerminalThere);
    return { space: openedThere ?? otherSpace ?? null, open: Boolean(anyone), busy };
}

/** A small filled button; `danger` is for the one that removes something. */
function button(t, id, label, onClick, danger = false) {
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
            cx.notify();
        })
        .child(label);
}

export default class RepoWorktrees extends View {
    init(_props, cx) {
        this.trees = null;
        this.single = false;
        this.error = null;
        this.tookMs = null;
        this.confirming = null; // the path whose Remove is waiting for a second click
        this.removing = null; // the path being removed now
        this.notices = [];
        this.rowErrors = {};
        this.loadedAt = 0;
        this.triedAt = 0;
        this.enter(whereToLook());
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    /** A new folder or machine: forget what was shown. */
    enter(where) {
        this.where = where;
        this.contextKey = JSON.stringify([where.root, where.on]);
        this.trees = null;
        this.error = null;
        this.confirming = null;
        this.rowErrors = {};
        this.loadedAt = 0;
        this.triedAt = 0;
        this.tookMs = null;
    }

    /** Runs every second and is cheap; the git work only starts while the panel is on screen. Not called from `render`,
     * since loading notifies and `render` may not. */
    tick(cx) {
        const where = whereToLook();
        if (JSON.stringify([where.root, where.on]) !== this.contextKey) {
            this.enter(where);
            cx.notify();
        }
        this.updateBadge();
        if (!onScreen() || this.loading || this.removing || !this.where.root) return;
        if (Date.now() - Math.max(this.loadedAt, this.triedAt) > REUSE_MS) this.load(cx);
    }

    load(cx) {
        if (this.loading || !this.where?.root) return;
        const { root, on } = this.where;
        const contextKey = this.contextKey;
        const started = Date.now();
        this.loading = true;
        this.triedAt = started;
        cx.spawn(async (cx) => {
            try {
                const result = await exec("sh", ["-c", SCRIPT, "sh", root], { on });
                if (contextKey !== this.contextKey) return;
                if (result.code !== 0) throw new Error((result.stderr || `exit ${result.code}`).trim().split("\n")[0]);
                const parsed = parseTrees(result.stdout);
                this.single = parsed.single;
                this.trees = parsed.trees;
                this.error = null;
                this.loadedAt = Date.now();
                this.tookMs = this.loadedAt - started;
            } catch (e) {
                if (contextKey === this.contextKey) this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loading = false;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** The loaded worktrees with who is at each and whether it is ready, newest commit first. Worked out on every call, so a
     * row stops being ready the moment an agent starts working there. */
    rows() {
        const machine = this.where?.on;
        const withState = (this.trees ?? []).map((tree) => {
            const presence = whoIsAt(tree.path, machine);
            return { ...tree, ...presence, ready: readiness(tree, presence.busy) };
        });
        return withState.sort((a, b) => Date.parse(b.date ?? 0) - Date.parse(a.date ?? 0));
    }

    /** The count on this panel's icon: worktrees ready to remove. Set only on a change, since setting shared state
     * redraws every mod. */
    updateBadge() {
        const next = { count: this.rows().filter((row) => row.ready).length, tone: "done" };
        if (JSON.stringify(shared("badge.repo-worktrees")) !== JSON.stringify(next))
            setShared("badge.repo-worktrees", next);
    }

    /** A click on a row: the space open at that folder, else a new tab there. */
    openRow(tree) {
        const presence = whoIsAt(tree.path, this.where.on);
        if (presence.space) return run("space.select", { id: presence.space.id });
        const space = spaces().find((s) => s.active)?.id;
        run("tab.new", { space, folder: tree.path });
    }

    /** Removes one worktree. The list may be 30 seconds old, so everything that makes it safe is checked again first. */
    remove(cx, tree) {
        if (this.removing) return;
        this.removing = tree.path;
        this.confirming = null;
        delete this.rowErrors[tree.path];
        const { on } = this.where;
        const contextKey = this.contextKey;
        cx.spawn(async (cx) => {
            try {
                const git = (args, cwd) => exec("git", args, { cwd, on });
                const status = await git(["--no-optional-locks", "status", "--porcelain"], tree.path);
                if (status.code !== 0 || status.stdout.trim())
                    throw new Error("It has uncommitted changes now. Nothing was removed.");
                const ref = tree.branch || "HEAD";
                const unpushed = await git(["rev-list", "--count", ref, "--not", "--remotes"], tree.path);
                if (unpushed.code !== 0 || Number(unpushed.stdout.trim()) !== 0)
                    throw new Error("It has commits on no remote now. Nothing was removed.");
                if (whoIsAt(tree.path, on).busy) throw new Error("An agent is working there now. Nothing was removed.");
                // No --force: git refuses a locked worktree or one with changes.
                const removal = await git(["worktree", "remove", tree.path], tree.main);
                if (removal.code !== 0)
                    throw new Error((removal.stderr || "git worktree remove failed.").trim().split("\n")[0]);
                let text = `Removed ${relName(tree.path, this.where.root)}.`;
                if (tree.branch) {
                    // -d, not -D: git keeps a branch that is not fully merged.
                    const branch = await git(["branch", "-d", tree.branch], tree.main);
                    text +=
                        branch.code === 0
                            ? ` Branch ${tree.branch} deleted.`
                            : ` Branch ${tree.branch} kept: ${(branch.stderr || "git branch -d refused").trim().split("\n")[0]}`;
                }
                this.notices.unshift({ id: `${Date.now()}`, text });
                if (contextKey === this.contextKey && this.trees)
                    this.trees = this.trees.filter((x) => x.path !== tree.path);
            } catch (e) {
                this.rowErrors[tree.path] = String(e?.message ?? e);
            } finally {
                this.removing = null;
                this.loadedAt = 0;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** The facts under a row's name, as small coloured fragments. */
    facts(t, tree) {
        const facts = [];
        if (tree.locked) facts.push(div().text_color(t.blocked).child("locked"));
        if (tree.ahead) facts.push(div().text_color(t.foreground).child(`↑${tree.ahead}`));
        if (tree.behind) facts.push(div().child(`↓${tree.behind}`));
        if (tree.dirty === null) facts.push(div().text_color(t.dim).child("status unknown"));
        else if (tree.dirty > 0) facts.push(div().text_color(t.done).child(`±${tree.dirty}`));
        if (tree.unpushed) facts.push(div().text_color(t.blocked).child(`${tree.unpushed} unpushed`));
        if (tree.gone) facts.push(div().text_color(t.dim).child("remote gone"));
        if (!tree.upstream && !tree.gone) facts.push(div().text_color(t.dim).child("no upstream"));
        if (tree.date) facts.push(div().text_color(t.dim).child(since(tree.date)));
        return facts;
    }

    row(t, tree) {
        const asking = this.confirming === tree.path;
        const inProgress = this.removing === tree.path;
        const dot = tree.busy ? t.working : tree.open ? t.dim : null;
        const where = relName(tree.path, this.where.root);
        const canAsk = Boolean(tree.ready) && !asking && !inProgress && !this.removing;
        const title = h_flex()
            .gap(8)
            .items_center()
            .child(
                div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .child(tree.branch || `(detached ${tree.head})`),
            )
            .when(dot !== null, (el) => el.child(div().flex_none().text_color(dot).child("●")))
            .child(
                div()
                    .flex_none()
                    .h(17)
                    .px(6)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .text_size(10.5)
                    .text_color(tree.ready ? t.done : t.dim)
                    .when(Boolean(tree.ready), (el) => el.bg(t.raised))
                    .child(tree.ready ? "Ready to remove" : "In progress"),
            )
            .when(canAsk, (el) =>
                el.child(
                    button(t, `rm-${tree.path}`, "Remove", () => {
                        this.confirming = tree.path;
                    }),
                ),
            )
            .when(inProgress, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Removing…")));
        const confirmText = `Remove worktree ${tree.path}? Branch ${tree.branch || "(none)"} is deleted only if fully merged.${tree.open ? " A space is open there; it stays open." : ""}`;
        return v_flex()
            .id(`wt-${tree.path}`)
            .flex_none()
            .px(8)
            .py(5)
            .gap(3)
            .rounded(7)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.openRow(tree))
            .tooltip(`${tree.path}\n${tree.subject || ""}`)
            .child(title)
            .child(
                h_flex()
                    .gap(8)
                    .items_center()
                    .text_size(10.5)
                    .text_color(t.muted)
                    .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(where))
                    .children(this.facts(t, tree).map((fact) => fact.flex_none())),
            )
            .when(Boolean(tree.ready), (el) =>
                el.child(div().text_size(10.5).text_color(t.dim).truncate().child(REASON[tree.ready])),
            )
            .when(asking, (el) =>
                el.child(
                    v_flex()
                        .pt(4)
                        .gap(6)
                        .text_size(11.5)
                        .child(div().text_color(t.muted).child(confirmText))
                        .child(
                            h_flex()
                                .gap(6)
                                .justify_end()
                                .child(
                                    button(t, `no-${tree.path}`, "Cancel", () => {
                                        this.confirming = null;
                                    }),
                                )
                                .child(button(t, `yes-${tree.path}`, "Remove", (cx) => this.remove(cx, tree), true)),
                        ),
                ),
            )
            .when(Boolean(this.rowErrors[tree.path]), (el) =>
                el.child(div().text_size(11).text_color(t.blocked).child(this.rowErrors[tree.path])),
            );
    }

    /** One line per repository, then its worktrees. */
    groupRows(t, rows) {
        const names = new Map(rows.map((row) => [row.main, nameOf(row.main)]));
        const groups = [...names]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([main, name]) => ({ name, rows: rows.filter((row) => row.main === main) }));
        return groups.flatMap((group) => {
            const ready = group.rows.filter((row) => row.ready).length;
            const heading = h_flex()
                .flex_none()
                .px(8)
                .pt(10)
                .pb(4)
                .gap(6)
                .items_center()
                .text_size(10.5)
                .font_semibold()
                .text_color(t.dim)
                .child(div().child(group.name))
                .child(
                    div()
                        .font_normal()
                        .child(ready ? `${group.rows.length} · ${ready} ready` : `${group.rows.length}`),
                );
            return [...(this.single ? [] : [heading]), ...group.rows.map((row) => this.row(t, row))];
        });
    }

    render(_cx) {
        const t = theme();
        const rows = this.rows();
        const ready = rows.filter((row) => row.ready).length;
        const firstName = rows[0] ? nameOf(rows[0].main) : null;
        const title = this.single && firstName ? firstName : "Worktrees";
        const count = `${rows.length} worktree${rows.length === 1 ? "" : "s"}`;
        const header = h_flex()
            .h(42)
            .flex_none()
            .px(12)
            .gap(8)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(`${title} · ${count}`))
            .when(this.tookMs !== null && !this.loading, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(`${(this.tookMs / 1000).toFixed(1)}s`),
                ),
            )
            .child(
                div()
                    .id("wt-refresh")
                    .flex_none()
                    .text_size(11)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => this.load(cx))
                    .child(this.loading ? "Loading…" : "Refresh"),
            );
        const notices = this.notices.map((notice) =>
            h_flex()
                .id(`res-${notice.id}`)
                .flex_none()
                .px(8)
                .py(5)
                .gap(8)
                .items_center()
                .rounded(7)
                .bg(t.surface)
                .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.muted).child(notice.text))
                .child(
                    button(t, `dismiss-${notice.id}`, "Dismiss", () => {
                        this.notices = this.notices.filter((x) => x !== notice);
                    }),
                ),
        );
        const message = (text) => div().p(8).text_color(t.dim).child(text);
        return v_flex()
            .id("worktrees")
            .size_full()
            .min_h(0)
            .rounded(10)
            .overflow_hidden()
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .text_size(13)
            .child(header)
            .child(
                v_flex()
                    .id("wt-list")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
                    .children(notices)
                    .when(Boolean(this.error), (el) => el.child(message(this.error)))
                    .when(!this.error && !this.trees, (el) =>
                        el.child(message(this.where?.root ? "Loading…" : "No folder.")),
                    )
                    .when(Boolean(this.trees) && rows.length === 0, (el) =>
                        el.child(message("No linked worktrees found.")),
                    )
                    .when(rows.length > 0 && ready === 0, (el) =>
                        el.child(
                            div().px(8).pt(6).text_size(11).text_color(t.dim).child("Nothing is ready to remove."),
                        ),
                    )
                    .children(this.groupRows(t, rows)),
            );
    }
}
