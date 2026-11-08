// The linked worktrees of the space's folder. Inside one git repository: that repository's worktrees. On a folder that
// holds many repositories: the worktrees of every repository found under it, grouped by repository, each marked "Ready
// to remove" or "In progress". Everything is read with git on the space's machine (`on`); nothing is fetched and no remote
// is contacted. The one write is Remove, on a ready row, after an inline confirm: `git worktree remove` without --force,
// then `git branch -d` (never -D), so git itself refuses to lose anything.

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { exec, focused, layout, panes, run, setShared, shared, spaces, theme } from "herdr";
import { location, readFollow, writeFollow } from "./follow.js";
import { followReload } from "./follow-state.js";
import {
    cancelPrune,
    dangerousIgnored,
    isOnScreen,
    liveReady,
    nameOf,
    parseTrees,
    parseWorktreeListZ,
    pruneAll,
    prunePlan,
    REASON,
    readiness,
    relName,
    removalRefusal,
    SCRIPT,
    sameOrInside,
    since,
    terminalsInsideWorktree,
} from "./lib.js";

const onScreen = () => isOnScreen(layout(), "repo-worktrees");
const REUSE_MS = 30000; // a load is reused this long; Refresh asks again
const WORKING = new Set(["working", "blocked"]);

/** Git's raw failures as a line a person can act on. */
function friendly(text) {
    const line = String(text ?? "")
        .trim()
        .split("\n")[0];
    if (/not a git repository/i.test(line)) return "Not a git repository here — cd into one.";
    return line;
}

/** The folder to look at and the machine it is on: the shown space's folder, else where its first terminal is. */
function whereToLook() {
    const space = spaces().find((s) => s.active);
    return location(readFollow(space?.id));
}

/** The Terminal/Space switch: what this panel follows, per space. */
function followButton(t, reload) {
    const space = spaces().find((s) => s.active);
    const follow = readFollow(space?.id);
    return div()
        .id("follow")
        .ml(4)
        .text_size(11)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((st) => st.text_color(t.foreground))
        .tooltip(
            follow
                ? "Following the focused terminal — click to use the space folder"
                : "Using the space folder — click to follow the focused terminal",
        )
        .on_click((_e, cx) => {
            followReload(
                follow,
                space?.id,
                (id, value) => writeFollow(id, value),
                () => reload(cx),
            );
        })
        .child(follow ? "Terminal" : "Space");
}

/** Who is at a checkout: the space that was opened on it, any other space with a terminal in it, and whether an agent
 * there is working or blocked (a pane's own state, or its space's when the space was made there). */
function whoIsAt(path, machine) {
    const within = (cwd) => sameOrInside(path, cwd);
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
        this.generation = (this.generation ?? 0) + 1;
        this.trees = null;
        this.single = false;
        this.error = null;
        this.tookMs = null;
        this.confirming = null; // the path whose Remove is waiting for a second click
        this.menu = null; // the row whose ⋯ actions are open
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
        this.generation = (this.generation ?? 0) + 1;
        this.trees = null;
        this.error = null;
        this.confirming = null;
        this.pruning = null;
        this.menu = null;
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
        const generation = ++this.generation;
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
                if (contextKey === this.contextKey) this.error = friendly(e?.message ?? e);
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
    remove(cx, tree, onDone, ctx) {
        if (this.removing) {
            if (onDone) onDone("A removal was already running; the rest were not removed.");
            return;
        }
        this.removing = tree.path;
        this.confirming = null;
        delete this.rowErrors[tree.path];
        const on = ctx?.on ?? this.where.on;
        const contextKey = ctx?.contextKey ?? this.contextKey;
        cx.spawn(async (cx) => {
            try {
                const git = (args, cwd) => exec("git", args, { cwd, on });
                const cwds = panes().map((p) => p.cwd);
                if (
                    await terminalsInsideWorktree(
                        (cmd, args, opts) => exec(cmd, args, { ...opts, on }),
                        tree.path,
                        cwds,
                    )
                )
                    throw new Error("A terminal is inside this worktree. Nothing was removed.");
                const list = await git(["worktree", "list", "--porcelain", "-z"], tree.main);
                const refusal = removalRefusal(tree, parseWorktreeListZ(list.stdout ?? ""));
                if (list.code !== 0 || refusal)
                    throw new Error(`${refusal ?? "the worktree list failed"}. Nothing was removed.`);
                const status = await git(["--no-optional-locks", "status", "--porcelain", "--ignored"], tree.path);
                const changed = (status.stdout ?? "").split("\n").filter((line) => line && !line.startsWith("!! "));
                const ignored = dangerousIgnored(status.stdout);
                if (status.code !== 0 || changed.length > 0 || ignored.length > 0)
                    throw new Error(
                        ignored.length > 0
                            ? `It has ignored data files (${ignored.slice(0, 3).join(", ")}). Nothing was removed.`
                            : "It has uncommitted changes now. Nothing was removed.",
                    );
                const ref = tree.branch || "HEAD";
                const [ahead, unpushed, upstream, created] = await Promise.all([
                    git(["rev-list", "--count", `${tree.base ?? "HEAD"}..${ref}`], tree.path),
                    git(["rev-list", "--count", ref, "--not", "--remotes"], tree.path),
                    git(["for-each-ref", "--format=%(upstream:short)", `refs/heads/${ref}`], tree.path),
                    git(["reflog", "show", "--format=%H", ref], tree.path),
                ]);
                const live = parseWorktreeListZ(list.stdout ?? "").find((entry) => entry.path === tree.path);
                const facts = {
                    ...tree,
                    locked: Boolean(live?.locked),
                    branch: live?.branch ?? tree.branch,
                    head: live?.head?.slice(0, 8) ?? tree.head,
                    baseAhead: ahead.code === 0 ? Number(ahead.stdout.trim()) : null,
                    unpushed: unpushed.code === 0 ? Number(unpushed.stdout.trim()) : null,
                    upstream: (upstream.stdout ?? "").trim(),
                    created: (created.stdout ?? "").trim().split("\n").pop() || null,
                };
                if (!liveReady(tree, facts)) throw new Error("It is not ready to remove now. Nothing was removed.");
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
                if (typeof onDone === "function") onDone(null);
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
        if (tree.unpushed && tree.upstream) facts.push(div().text_color(t.blocked).child(`${tree.unpushed} unpushed`));
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
                    .tooltip(tree.path)
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
                    .child(
                        tree.path === tree.main
                            ? "main checkout"
                            : tree.ready
                              ? "Ready to remove"
                              : tree.baseAhead === 0 && !tree.unpushed && !tree.upstream
                                ? "no commits yet"
                                : "In progress",
                    ),
            )
            .when(canAsk, (el) =>
                el.child(
                    button(t, `rm-${tree.path}`, "Remove", () => {
                        this.confirming = tree.path;
                    }),
                ),
            )
            .when(inProgress, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Removing…")))
            .child(
                div()
                    .id(`menu-${tree.path}`)
                    .flex_none()
                    .w(18)
                    .h(18)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(5)
                    .cursor_pointer()
                    .hover((st) => st.bg(t.raised).text_color(t.foreground))
                    .tooltip("Actions")
                    .on_click((_e, cx) => {
                        cx.stop_propagation();
                        this.menu = this.menu === tree.path ? null : tree.path;
                        cx.notify();
                    })
                    .child("⋯"),
            );
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
            .when(this.menu === tree.path, (el) =>
                el.child(
                    h_flex()
                        .id(`actions-${tree.path}`)
                        .gap(6)
                        .pl(20)
                        .child(button(t, `open-${tree.path}`, "Open", () => this.openRow(tree)))
                        .when(tree.ready && tree.path !== tree.main, (row) =>
                            row.child(
                                button(t, `rm-${tree.path}`, "Remove", () => {
                                    this.confirming = tree.path;
                                    this.menu = null;
                                }),
                            ),
                        ),
                ),
            )
            .child(
                h_flex()
                    .gap(8)
                    .items_center()
                    .text_size(10.5)
                    .text_color(t.muted)
                    .child(div().flex_1().min_w(0).truncate().text_color(t.dim).tooltip(tree.path).child(where))
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
            .child(followButton(t, (cx) => this.load(cx)))
            .when(this.rows().filter((row) => row.ready && row.path !== row.main).length > 0, (el) =>
                el.child(
                    div()
                        .id("wt-prune")
                        .flex_none()
                        .text_size(11)
                        .text_color(t.dim)
                        .cursor_pointer()
                        .hover((st) => st.text_color(t.foreground))
                        .on_click((_e, cx) => {
                            this.pruning = this.rows()
                                .filter((row) => row.ready && row.path !== row.main)
                                .map((tree) => ({ tree, on: this.where.on, contextKey: this.contextKey }));
                            cx.notify();
                        })
                        .child(
                            `Prune merged (${this.rows().filter((row) => row.ready && row.path !== row.main).length})`,
                        ),
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
        const pruneBanner = this.pruning
            ? v_flex()
                  .id("prune-confirm")
                  .flex_none()
                  .px(10)
                  .py(8)
                  .gap(4)
                  .border_b(1)
                  .border_color(t.border)
                  .child(div().text_size(11.5).child(`Remove ${this.pruning.length} merged worktree(s)?`))
                  .children(this.pruning.map((entry) => div().text_size(11).text_color(t.dim).child(entry.tree.path)))
                  .child(
                      h_flex()
                          .gap(8)
                          .child(
                              button(
                                  t,
                                  "prune-yes",
                                  "Prune",
                                  (cx) => {
                                      const list = this.pruning ?? [];
                                      this.pruning = null;
                                      const run = pruneAll(
                                          list,
                                          this.contextKey,
                                          this.where.on,
                                          (tree, entry) => new Promise((done) => this.remove(cx, tree, done, entry)),
                                      );
                                      run.then((result) => {
                                          if (result.refused) this.error = result.refused;
                                          cx.notify();
                                      });
                                  },
                                  true,
                              ),
                          )
                          .child(
                              button(t, "prune-cancel", "Cancel", (cx) => {
                                  this.pruning = cancelPrune();
                                  cx.notify();
                              }),
                          ),
                  )
            : null;
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
            .when(Boolean(pruneBanner), (el) => el.child(pruneBanner))
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
