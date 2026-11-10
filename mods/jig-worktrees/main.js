// The linked worktrees of the space's folder. Inside one git repository: that repository's worktrees. On a folder that
// holds many repositories: the worktrees of every repository found under it, grouped by repository, each marked "Ready
// to remove" or "In progress". Everything is read with git on the space's machine (`on`); nothing is fetched and no remote
// is contacted. The one write is Remove, on a ready row, after an inline confirm: `git worktree remove` without --force,
// then `git branch -d` (never -D), so git itself refuses to lose anything.

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import {
    appHome,
    exec,
    focused,
    layout,
    panes,
    readTextFile,
    run,
    setShared,
    shared,
    spaces,
    terminals,
    theme,
    window,
} from "herdr";
import { location, readFollow, writeFollow } from "./follow.js";
import {
    cancelPrune,
    dangerousIgnored,
    groupWorktrees,
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
    worktreeTitle,
} from "./lib.js";
import { panelError, panelHeader } from "./panel-header.js";
import {
    contextCard,
    dangerButton,
    footer,
    groupHeader,
    moveActive,
    primaryButton,
    row,
    secondaryButton,
    statusLine,
} from "./panel-kit.js";
import {
    focusRegained,
    friendlyError,
    GIT_READ,
    parseRefreshConfig,
    RefreshScheduler,
    RefreshState,
    refreshSeconds,
    run as runCommand,
    terminalFinished,
} from "./refresh.js";

const onScreen = () => isOnScreen(layout(), "jig-worktrees");
const WORKING = new Set(["working", "blocked"]);

/** Git's raw failures as a line a person can act on. */
function friendly(text) {
    const line = String(text ?? "")
        .trim()
        .split("\n")[0];
    if (/not a git repository/i.test(line))
        return "No git repo in this folder. Open a terminal in one, or switch to Space.";
    return line;
}

/** The folder to look at and the machine it is on: the shown space's folder, else where its first terminal is. */
function whereToLook() {
    const space = spaces().find((s) => s.active);
    return location(readFollow(space?.id));
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
        this.opened = new Set();
        this.activeTree = null;
        this.keys = cx.focus_handle();
        this.removing = null; // the path being removed now
        this.notices = [];
        this.rowErrors = {};
        this.loadedAt = 0;
        this.triedAt = 0;
        this.refreshState = new RefreshState();
        this.configAt = 0;
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config) });
        this.readGeneration = 0;
        this.seen = false;
        this.lastTerminals = terminals();
        this.windowActive = window()?.active === true;
        this.enter(whereToLook());
        this.initialRead(cx);
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    /** A first read that does not wait for the one-second timer. */
    initialRead(cx) {
        if (!this.where?.root) return;
        this.seen = true;
        cx.spawn(async (cx) => {
            if (this.where?.root) this.load(cx);
        });
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
        this.refreshState.tick(Date.now(), () => cx.notify());
        const where = whereToLook();
        if (JSON.stringify([where.root, where.on]) !== this.contextKey) {
            this.enter(where);
            this.refreshScheduler.trigger();
            cx.notify();
        }
        this.updateBadge();
        const seen = onScreen();
        const appeared = seen && !this.seen;
        this.seen = seen;
        if (!seen || !this.where.root) return;
        if (appeared) this.refreshScheduler.trigger();
        this.loadConfig(cx);
        this.refreshScheduler.setSeconds(refreshSeconds(this.config));
        const active = window()?.active === true;
        if (focusRegained(this.windowActive, active)) this.refreshScheduler.trigger();
        this.windowActive = active;
        const currentTerminals = terminals();
        if (terminalFinished(this.lastTerminals, currentTerminals, this.where.root)) this.refreshScheduler.trigger();
        this.lastTerminals = currentTerminals;
        if (!this.loading && !this.removing && this.refreshScheduler.due()) this.load(cx);
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < 60000) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/jig-worktrees/config.json`).catch(() => null);
            const refresh = parseRefreshConfig(text ?? "", 60);
            this.config = (() => {
                try {
                    return text ? JSON.parse(text) : {};
                } catch {
                    return {};
                }
            })();
            this.refreshProblem = refresh.problems[0] ?? null;
            this.refreshScheduler.setSeconds(refresh.seconds);
            cx.notify();
        });
    }

    load(cx, user = false) {
        if (!this.where?.root) return;
        const { root, on } = this.where;
        const contextKey = this.contextKey;
        const started = Date.now();
        const generation = ++this.generation;
        if (!this.refreshState.start({ user, first: this.trees === null, notify: () => cx.notify() })) return;
        this.refreshScheduler.sweep();
        this.loading = true;
        this.triedAt = started;
        const run = ++this.readGeneration;
        cx.spawn(async (cx) => {
            try {
                const work = (async () => {
                    const result = await runCommand(exec, "sh", ["-c", SCRIPT, "sh", root], { on });
                    if (run !== this.readGeneration || contextKey !== this.contextKey) return;
                    if (result.code !== 0)
                        throw Object.assign(new Error(result.stderr || `exit ${result.code}`), result);
                    const parsed = parseTrees(result.stdout);
                    this.single = parsed.single;
                    this.trees = parsed.trees;
                    this.error = null;
                    this.loadedAt = Date.now();
                    this.tookMs = this.loadedAt - started;
                })();
                await work;
            } catch (e) {
                if (run === this.readGeneration && contextKey === this.contextKey)
                    this.error = friendlyError(e, { what: "Reading", follow: true });
            } finally {
                if (run === this.readGeneration) {
                    this.loading = false;
                    if (this.refreshState.finish()) {
                        this.triedAt = 0;
                        this.refreshScheduler.trigger();
                    }
                    cx.notify();
                }
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
        if (JSON.stringify(shared("badge.jig-worktrees")) !== JSON.stringify(next))
            setShared("badge.jig-worktrees", next);
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
                const git = (args, cwd) => runCommand(exec, "git", args, { cwd, on });
                const cwds = panes().map((p) => p.cwd);
                if (
                    await terminalsInsideWorktree(
                        (cmd, args, opts) => runCommand(exec, cmd, args, { ...opts, on }),
                        tree.path,
                        cwds,
                    )
                )
                    throw new Error("A terminal is inside this worktree. Nothing was removed.");
                const list = await git([...GIT_READ, "worktree", "list", "--porcelain", "-z"], tree.main);
                const refusal = removalRefusal(tree, parseWorktreeListZ(list.stdout ?? ""));
                if (list.code !== 0 || refusal)
                    throw new Error(`${refusal ?? "the worktree list failed"}. Nothing was removed.`);
                const status = await git([...GIT_READ, "status", "--porcelain", "--ignored"], tree.path);
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
                    git([...GIT_READ, "rev-list", "--count", `${tree.base ?? "HEAD"}..${ref}`], tree.path),
                    git([...GIT_READ, "rev-list", "--count", ref, "--not", "--remotes"], tree.path),
                    git([...GIT_READ, "for-each-ref", "--format=%(upstream:short)", `refs/heads/${ref}`], tree.path),
                    git([...GIT_READ, "reflog", "show", "--format=%H", ref], tree.path),
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

    openTab(tree) {
        const space = spaces().find((s) => s.active)?.id;
        run("tab.new", { space, folder: tree.path });
    }

    row(t, tree, color) {
        const asking = this.confirming === tree.path;
        const main = tree.path === tree.main;
        const open = this.opened.has(tree.path);
        const detail = [
            nameOf(tree.main),
            tree.ahead ? `↑${tree.ahead}` : null,
            tree.behind ? `↓${tree.behind}` : null,
            tree.unpushed && tree.upstream ? `${tree.unpushed} unpushed` : null,
            tree.date ? since(tree.date) : null,
        ]
            .filter(Boolean)
            .join(" · ");
        const details = v_flex()
            .p(8)
            .gap(6)
            .child(div().text_size(12).text_color(t.muted).child(tree.path))
            .when(Boolean(tree.ready), (el) =>
                el.child(div().text_size(12).text_color(t.muted).child(REASON[tree.ready])),
            )
            .when(Boolean(tree.subject), (el) =>
                el.child(div().text_size(12).text_color(t.muted).truncate().child(tree.subject)),
            )
            .child(
                h_flex()
                    .gap(6)
                    .justify_end()
                    .child(primaryButton(t, `open-${tree.path}`, "Open space", () => this.openRow(tree), { h: 26 }))
                    .child(
                        secondaryButton(t, `tab-${tree.path}`, "Open in new tab", () => this.openTab(tree), { h: 26 }),
                    )
                    .when(!main, (el) =>
                        el.child(
                            dangerButton(
                                t,
                                `rm-${tree.path}`,
                                "Remove…",
                                () => {
                                    if (!tree.ready) return;
                                    this.confirming = tree.path;
                                },
                                { h: 26, disabled: !tree.ready },
                            ),
                        ),
                    ),
            )
            .when(asking, (el) =>
                el
                    .child(
                        div()
                            .text_size(12)
                            .text_color(t.blocked)
                            .child(
                                `Remove worktree ${tree.path}? Branch ${tree.branch || "(none)"} is deleted only if fully merged.${tree.open ? " A space is open there; it stays open." : ""}`,
                            ),
                    )
                    .child(
                        h_flex()
                            .gap(6)
                            .justify_end()
                            .child(
                                secondaryButton(
                                    t,
                                    `no-${tree.path}`,
                                    "Cancel",
                                    (cx) => {
                                        this.confirming = null;
                                        cx.notify();
                                    },
                                    { h: 26 },
                                ),
                            )
                            .child(
                                dangerButton(t, `yes-${tree.path}`, "Remove", (cx) => this.remove(cx, tree), { h: 26 }),
                            ),
                    ),
            )
            .when(Boolean(this.rowErrors[tree.path]), (el) =>
                el.child(div().text_size(12).text_color(t.blocked).child(this.rowErrors[tree.path])),
            );
        return row(t, {
            id: tree.path,
            color,
            active: this.activeTree === tree.path,
            title: tree.branch || `detached ${String(tree.head ?? "").slice(0, 7)}`,
            detail,
            open,
            onToggle: (cx) => {
                if (open) this.opened.delete(tree.path);
                else this.opened.add(tree.path);
                cx.notify();
            },
            details,
        });
    }

    /** Ready, in progress, then main: one kit header per group. */
    groupRows(t, rows) {
        const groups = groupWorktrees(rows);
        const sections = [
            ["ready", "Ready to remove", t.ansi2],
            ["progress", "In progress", t.accent],
            ["main", "Main checkout", t.muted],
        ];
        return sections.flatMap(([key, label, color]) =>
            groups[key].length
                ? [
                      groupHeader(t, `wt-${key}`, label, groups[key].length, color),
                      ...groups[key].map((tree) => this.row(t, tree, color)),
                  ]
                : [],
        );
    }

    render(_cx) {
        const t = theme();
        const rows = this.rows();
        const ready = rows.filter((row) => row.ready).length;
        const firstName = rows[0] ? nameOf(rows[0].main) : null;
        const title = this.single && firstName ? firstName : "Worktrees";
        const count = `${rows.length} worktree${rows.length === 1 ? "" : "s"}`;
        const space = spaces().find((s) => s.active);
        const follow = readFollow(space?.id);
        const header = panelHeader(t, {
            title: "Worktrees",
            titleTooltip: `${title} · ${count}`,
            readAt: this.loadedAt,
            busy: this.refreshState.busy,
            onRefresh: (cx) => this.load(cx, true),
            refreshIcon: "mods/jig-worktrees/refresh.svg",
            extra: [
                rows.filter((row) => row.ready && row.path !== row.main).length > 0
                    ? div()
                          .id("wt-prune")
                          .flex_none()
                          .text_size(11)
                          .text_color(t.dim)
                          .cursor_pointer()
                          .hover((st) => st.text_color(t.foreground))
                          .on_click((_e, cx) => {
                              this.pruning = rows
                                  .filter((row) => row.ready && row.path !== row.main)
                                  .map((tree) => ({ tree, on: this.where.on, contextKey: this.contextKey }));
                              cx.notify();
                          })
                          .child(`Prune merged (${rows.filter((row) => row.ready && row.path !== row.main).length})`)
                    : null,
            ].filter(Boolean),
        });
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
            .child(
                contextCard(t, {
                    name: this.where?.root
                        ? (this.where.root.split(/[\\/]/).filter(Boolean).pop() ?? "No folder")
                        : "No folder",
                    follow,
                    onFollow: (cx) => {
                        writeFollow(space?.id, !follow);
                        this.load(cx, true);
                    },
                    machine: this.where?.on ?? null,
                }),
            )
            .when(Boolean(pruneBanner), (el) => el.child(pruneBanner))
            .child(
                v_flex()
                    .id("wt-list")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
                    .track_focus(this.keys)
                    .on_key_down((e, cx) => {
                        const ids = (() => {
                            const groups = groupWorktrees(rows);
                            return [...groups.ready, ...groups.progress, ...groups.main].map((tree) => tree.path);
                        })();
                        if (e.key === "up" || e.key === "down") {
                            this.activeTree = moveActive(ids, this.activeTree, e.key === "up" ? -1 : 1);
                            cx.stop_propagation();
                            cx.notify();
                        } else if ((e.key === "enter" || e.key === "space") && this.activeTree) {
                            if (this.opened.has(this.activeTree)) this.opened.delete(this.activeTree);
                            else this.opened.add(this.activeTree);
                            cx.stop_propagation();
                            cx.notify();
                        } else if (e.key === "escape") {
                            this.opened.clear();
                            this.activeTree = null;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    })
                    .children(notices)
                    .when(Boolean(this.error), (el) => el.child(panelError(t, this.error)))
                    .when(Boolean(this.refreshProblem), (el) => el.child(message(this.refreshProblem, t.muted)))
                    .when(!this.error && !this.trees, (el) =>
                        el.child(message(this.where?.root ? "Reading…" : "No folder.")),
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
            )
            .when(Boolean(this.error), (el) => el.child(statusLine(t, { text: this.error, tone: "error" })))
            .child(footer(t, { summary: `${rows.length} worktree${rows.length === 1 ? "" : "s"} · ${ready} ready` }));
    }
}
