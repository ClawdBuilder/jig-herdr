// Commit history with lanes. Inside one git repository: that repository's graph. On a folder that holds many repositories:
// a picker of the repositories (and worktrees) found under it, then the graph of the chosen one. A click on a commit shows
// its message and files; a file, or "Open diff", shows the diff in a terminal beside. Read-only: `git log`, `git show` and
// `git status` on the space's machine (`on`).

import { View, div, svg } from "gpui-kit";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { exec, focused, layout, panes, run, settings, spaces, theme } from "herdr";
import {
    colourSeed,
    commitMatches,
    FORMAT,
    initialsOf,
    isOnScreen,
    layoutGraph,
    parseCommitDetail,
    parseLog,
    parseRepos,
    readSubject,
    relName,
    SCRIPT,
    since,
} from "./lib.js";

const onScreen = () => isOnScreen(layout(), "repo-history");
const PAGE = 100; // commits per page
const ROW_H = 28;
const MID = ROW_H / 2;
const LANE_W = 14;
const MAX_LANES = 8;
const STROKE = 2;
const DOT = 10;
const FILES_SHOWN = 12;
const REPOS_EVERY_MS = 60000;
const LOG_EVERY_MS = 10000;

/** Colours for lanes, authors and chips. A theme's ANSI colours are tuned for text on a terminal, not for lines that run
 * next to each other, so the graph has its own. */
const HUES = {
    dark: ["#5eb1ef", "#b794f6", "#f2848f", "#e6c15c", "#6fd3a0", "#4fd1c5", "#f4a261"],
    light: ["#2563c9", "#7c3fc4", "#c63f55", "#9a6b00", "#23844f", "#12818f", "#c25a0c"],
};
/** The hue (an index into HUES) of each conventional-commit type. */
const TYPE_HUE = { feat: 4, fix: 2, docs: 0, refactor: 1, perf: 6, test: 3, build: 5, ci: 5, revert: 2 };
/** Which commits `git log` is asked for: the checked-out branch, or every branch, remote and tag. */
const SCOPE_ARGS = { branch: [], all: ["--branches", "--remotes", "--tags", "HEAD"] };

const storage = {
    read(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    write(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // not remembered: the panel works the same
        }
    },
};

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

/** A pill of text: a branch, a tag, a pull request number or a commit type. */
function pill(text, color, fill, outline) {
    return div()
        .flex_none()
        .max_w(130)
        .h(17)
        .px(5)
        .flex()
        .items_center()
        .rounded(5)
        .truncate()
        .text_size(10.5)
        .text_color(color)
        .when(Boolean(fill), (el) => el.bg(fill))
        .when(Boolean(outline), (el) => el.border_1().border_color(outline))
        .child(text);
}

/** A straight piece of a lane: a 2 px wide box from `top` down `height`. */
function bar(lane, color, top, height) {
    return div()
        .absolute()
        .left(lane * LANE_W + LANE_W / 2 - STROKE / 2)
        .top(top)
        .w(STROKE)
        .h(height)
        .bg(color);
}

/** The curve between the commit's lane and a lane at its side: into the commit from above (`outgoing` false) or from the
 * commit down to a parent's lane (`outgoing` true). It is a box with two borders and one rounded corner, so it scales with
 * the zoom like the text. */
function elbow(fromLane, toLane, color, outgoing) {
    const toRight = toLane > fromLane;
    const centre = (lane) => lane * LANE_W + LANE_W / 2;
    const span = Math.abs(centre(toLane) - centre(fromLane));
    const radius = Math.min(MID, span);
    const box = div()
        .absolute()
        .left(toRight ? centre(fromLane) : centre(toLane) - STROKE / 2)
        .w(span + STROKE / 2)
        .h(MID + STROKE / 2)
        .top(outgoing ? MID - STROKE / 2 : 0)
        .border_color(color);
    const horizontal = outgoing ? "border_t" : "border_b";
    const vertical = toRight ? "border_r" : "border_l";
    const corner = `rounded_${outgoing ? "t" : "b"}${toRight ? "r" : "l"}`;
    return box[horizontal](STROKE)[vertical](STROKE)[corner](radius);
}

export default class RepoHistory extends View {
    init(_props, cx) {
        this.scope = storage.read("scope") === "all" ? "all" : "branch";
        this.picking = false;
        this.pickBox = InputState.new({ placeholder: "Find a repo" });
        this.pickBox.on("change", (_e, cx) => cx.notify());
        this.filterBox = InputState.new({ placeholder: "Filter by message, author, hash or branch" });
        this.filterBox.on("change", (_e, cx) => cx.notify());
        this.enter(whereToLook());
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    /** A new folder or machine: forget what was shown. */
    enter(where) {
        this.where = where;
        this.contextKey = JSON.stringify([where.root, where.on]);
        this.repos = null;
        this.single = false;
        this.reposAt = 0;
        this.repo = null;
        this.reposError = null;
        this.clearLog();
    }

    clearLog() {
        this.commits = null;
        this.rows = null;
        this.error = null;
        this.uncommitted = 0;
        this.selected = null;
        this.limit = PAGE;
        this.details = {};
        this.logAt = 0;
        this.logFor = null;
    }

    /** Runs every second and is cheap; the git work only starts while the panel is on screen. Not called from `render`,
     * since loading notifies and `render` may not. */
    tick(cx) {
        const where = whereToLook();
        if (JSON.stringify([where.root, where.on]) !== this.contextKey) {
            this.enter(where);
            cx.notify();
        }
        if (!onScreen() || !this.where.root) return;
        if (!this.loadingRepos && Date.now() - this.reposAt > REPOS_EVERY_MS) this.loadRepos(cx);
        const stale = this.logFor !== this.logKey() || Date.now() - this.logAt > LOG_EVERY_MS;
        if (this.repo && !this.loading && stale) this.loadLog(cx);
    }

    logKey() {
        return `${this.repo}|${this.scope}|${this.limit}`;
    }

    rememberedKey() {
        return `repo|${this.where.on}|${this.where.root}`;
    }

    loadRepos(cx) {
        if (this.loadingRepos || !this.where?.root) return;
        const { root, on } = this.where;
        const contextKey = this.contextKey;
        this.loadingRepos = true;
        this.reposAt = Date.now();
        cx.spawn(async (cx) => {
            try {
                const result = await exec("sh", ["-c", SCRIPT, "sh", root], { on });
                if (contextKey !== this.contextKey) return;
                if (result.code !== 0) throw new Error((result.stderr || `exit ${result.code}`).trim().split("\n")[0]);
                const { single, repos } = parseRepos(result.stdout);
                this.single = single;
                this.repos = repos;
                this.reposError = null;
                this.reposAt = Date.now();
                // Keep the repository on screen, else the one chosen last time, else one with changes, else the first.
                const known = (path) => repos.find((r) => r.path === path)?.path;
                const choice =
                    known(this.repo) ??
                    known(storage.read(this.rememberedKey())) ??
                    repos.find((r) => r.dirty)?.path ??
                    repos[0]?.path ??
                    null;
                if (choice !== this.repo) this.show(choice, false);
            } catch (e) {
                if (contextKey === this.contextKey) this.reposError = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loadingRepos = false;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** Shows a repository's history, and remembers the choice when the person made it. */
    show(path, chosen) {
        this.repo = path;
        if (chosen && path) storage.write(this.rememberedKey(), path);
        this.clearLog();
    }

    loadLog(cx) {
        if (this.loading || !this.repo) return;
        const cwd = this.repo;
        const on = this.where.on;
        const key = this.logKey();
        const logArgs = [
            "--no-optional-locks",
            "log",
            "--date-order",
            "--decorate=full",
            `-n${this.limit}`,
            `--format=${FORMAT}`,
            ...SCOPE_ARGS[this.scope],
        ];
        const statusArgs = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"];
        this.loading = true;
        cx.spawn(async (cx) => {
            try {
                const [log, status] = await Promise.all([
                    exec("git", logArgs, { cwd, on }),
                    exec("git", statusArgs, { cwd, on }),
                ]);
                if (key !== this.logKey()) return;
                if (log.code !== 0) {
                    this.commits = null;
                    this.error = (log.stderr ?? "").trim().split("\n")[0] || "git log failed.";
                    return;
                }
                this.error = null;
                this.commits = parseLog(log.stdout);
                this.rows = layoutGraph(this.commits);
                this.uncommitted = status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
                this.logAt = Date.now();
                this.logFor = key;
            } catch (e) {
                this.error = String(e?.message ?? e);
                this.logAt = Date.now();
                this.logFor = key;
            } finally {
                this.loading = false;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** Opens or closes a commit's detail, reading its message and files the first time. */
    toggleCommit(cx, commit) {
        this.selected = this.selected === commit.hash ? null : commit.hash;
        if (!this.selected || this.details[commit.hash]) return cx.notify();
        const cwd = this.repo;
        const on = this.where.on;
        cx.spawn(async (cx) => {
            const result = await exec(
                "git",
                ["--no-optional-locks", "show", "--numstat", "--format=%B%x1e", commit.hash],
                { cwd, on },
            );
            this.details[commit.hash] =
                result.code === 0
                    ? parseCommitDetail(result.stdout)
                    : { body: (result.stderr ?? "").trim(), files: [] };
            cx.notify();
        });
        cx.notify();
    }

    /** A terminal beside, in the repository's folder, showing the commit, or one file of it. */
    openDiff(commit, file) {
        const argv = ["git", "show", "--stat", "--patch", commit.hash, ...(file ? ["--", file] : [])];
        run("terminal.open", { argv, folder: this.repo, place: "right" });
    }

    // ---- drawing ----

    /** The graph part of a row: the lanes, the curves and the commit's dot. With `tall` it is the plain continuation shown
     * beside an opened commit's detail. */
    gutter(row, { isHead, width, hue, tall }) {
        const background = theme().background;
        const own = hue(row.color);
        const parts = tall
            ? row.bottom.map((entry) => bar(entry.lane, hue(entry.color), 0, 2000))
            : [
                  ...row.top.map((entry) => bar(entry.lane, hue(entry.color), 0, MID)),
                  ...row.bottom.map((entry) => bar(entry.lane, hue(entry.color), MID, MID)),
                  ...row.ins.map((entry) => elbow(row.lane, entry.lane, hue(entry.color), false)),
                  ...row.outs.map((entry) => elbow(row.lane, entry.lane, hue(entry.color), true)),
                  div()
                      .absolute()
                      .left(row.lane * LANE_W + LANE_W / 2 - DOT / 2)
                      .top(MID - DOT / 2)
                      .w(DOT)
                      .h(DOT)
                      .rounded(DOT)
                      // the checked-out commit is a ring, every other commit a filled dot
                      .when(isHead, (el) => el.bg(background).border(2.5).border_color(own))
                      .when(!isHead, (el) => el.bg(own)),
              ];
        return div()
            .relative()
            .flex_none()
            .w(width * LANE_W)
            .when(!tall, (el) => el.h(ROW_H))
            .overflow_hidden()
            .children(parts);
    }

    /** The branch, tag and remote labels of a commit (two at most), in the lane's colour. */
    refPills(commit, own, hue) {
        return commit.refs.slice(0, 2).map((ref) => {
            if (ref.kind === "tag") return pill(ref.name, hue(3), `${hue(3)}26`);
            if (ref.kind === "remote") return pill(ref.name, own, null, `${own}66`);
            return pill(ref.name, own, `${own}2e`);
        });
    }

    commitRow(t, commit, row, { width, hue, flat }) {
        const subject = readSubject(commit.subject);
        const own = hue(row.color);
        const author = hue(colourSeed(commit.author));
        const typeColor = subject.type
            ? TYPE_HUE[subject.type] === undefined
                ? t.muted
                : hue(TYPE_HUE[subject.type])
            : null;
        const opened = this.selected === commit.hash;
        const isMerge = commit.parents.length > 1;
        const isPrMerge = subject.type === undefined && subject.pr !== undefined && /^Merge/.test(commit.subject);
        const when = commit.date.slice(0, 16).replace("T", " ");
        return h_flex()
            .id(`c-${commit.hash}`)
            .flex_none()
            .h(ROW_H)
            .pr(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .when(opened, (el) => el.bg(t.selected))
            .hover((s) => s.bg(opened ? t.selected : t.hover))
            .tooltip(`${commit.hash.slice(0, 7)} · ${commit.author} · ${when}\n${commit.subject}`)
            .on_click((_e, cx) => this.toggleCommit(cx, commit))
            .child(
                flat
                    ? div().flex_none().ml(4).w(8).h(8).rounded(8).bg(own)
                    : this.gutter(row, { isHead: commit.head, width, hue }),
            )
            .child(
                div()
                    .flex_none()
                    .w(18)
                    .h(18)
                    .rounded(18)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(8.5)
                    .font_semibold()
                    .bg(`${author}33`)
                    .text_color(author)
                    .child(initialsOf(commit.author)),
            )
            .children(this.refPills(commit, own, hue))
            .when(subject.pr !== undefined, (el) => el.child(pill(`#${subject.pr}`, hue(0), `${hue(0)}26`)))
            .when(Boolean(subject.type), (el) =>
                el.child(pill(`${subject.type}${subject.breaking ? "!" : ""}`, typeColor, `${typeColor}22`)),
            )
            .when(Boolean(subject.scope), (el) =>
                el.child(div().flex_none().max_w(80).truncate().text_size(11.5).text_color(t.dim).child(subject.scope)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_color(isMerge ? t.muted : t.foreground)
                    .child(isPrMerge ? `Merge ${subject.text}` : subject.text),
            )
            .child(div().flex_none().w(28).text_size(10.5).text_color(t.dim).text_right().child(since(commit.date)));
    }

    /** The card under an opened commit: author, message, its files with their line counts, and "Open diff". */
    commitDetail(t, commit, row, { width, hue, flat }) {
        const detail = this.details[commit.hash];
        const files = detail?.files ?? [];
        const added = files.reduce((sum, f) => sum + (f.add ?? 0), 0);
        const removed = files.reduce((sum, f) => sum + (f.del ?? 0), 0);
        const fileRow = (file, i) =>
            h_flex()
                .id(`f-${commit.hash}-${i}`)
                .h(20)
                .px(4)
                .gap(8)
                .items_center()
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.openDiff(commit, file.path))
                .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(file.path))
                .child(
                    div()
                        .flex_none()
                        .text_size(11)
                        .text_color(hue(4))
                        .child(file.add === null ? "bin" : `+${file.add}`),
                )
                .child(
                    div()
                        .flex_none()
                        .text_size(11)
                        .text_color(hue(2))
                        .child(file.del === null ? "" : `−${file.del}`),
                );
        const openDiff = div()
            .id(`diff-${commit.hash}`)
            .h(22)
            .px(8)
            .flex()
            .items_center()
            .rounded(6)
            .text_size(11.5)
            .bg(t.raised)
            .text_color(t.foreground)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.openDiff(commit))
            .child("Open diff");
        const card = v_flex()
            .flex_1()
            .min_w(0)
            .ml(6)
            .mr(8)
            .mb(6)
            .p(10)
            .gap(8)
            .rounded(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .text_size(12)
            .child(
                h_flex()
                    .gap(6)
                    .text_size(11)
                    .text_color(t.dim)
                    .child(div().font_semibold().text_color(t.muted).child(commit.hash.slice(0, 10)))
                    .child(`${commit.author} · ${new Date(commit.date).toLocaleString()}`),
            )
            .child(div().text_color(t.foreground).child(commit.subject))
            .when(Boolean(detail?.body), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(detail.body)))
            .when(!detail, (el) => el.child(div().text_color(t.dim).child("Loading…")))
            .when(files.length > 0, (el) =>
                el.child(
                    v_flex()
                        .gap(2)
                        .children(files.slice(0, FILES_SHOWN).map(fileRow))
                        .when(files.length > FILES_SHOWN, (list) =>
                            list.child(
                                div()
                                    .px(4)
                                    .text_size(11)
                                    .text_color(t.dim)
                                    .child(`and ${files.length - FILES_SHOWN} more`),
                            ),
                        ),
                ),
            )
            .child(
                h_flex()
                    .gap(6)
                    .child(openDiff)
                    .when(files.length > 0, (el) =>
                        el.child(
                            div()
                                .text_size(11)
                                .text_color(t.dim)
                                .child(`${files.length} file${files.length === 1 ? "" : "s"} · +${added} −${removed}`),
                        ),
                    ),
            );
        return div()
            .flex()
            .flex_row()
            .flex_none()
            .child(flat ? div().w(16) : this.gutter(row, { isHead: false, width, hue, tall: true }))
            .child(card);
    }

    /** The repository chooser's button, and, while it is open, a search box under it. */
    chooser(t, hue) {
        const current = this.repos?.find((r) => r.path === this.repo);
        const button = h_flex()
            .id("repo-pick")
            .h(26)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .bg(t.surface)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip("Choose the repo")
            .on_click((_e, cx) => {
                this.picking = !this.picking;
                cx.notify();
            })
            .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.muted))
            .child(
                div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .font_semibold()
                    .child(current ? relName(current.path, this.where.root) : (this.reposError ?? "No repo")),
            )
            .when(Boolean(current?.dirty), (el) => el.child(div().flex_none().w(8).h(8).rounded(8).bg(hue(3))))
            .child(
                svg(`mods/workspace-chrome/chevron-${this.picking ? "down" : "right"}.svg`)
                    .size(12)
                    .flex_none()
                    .text_color(t.dim),
            );
        const search = div()
            .id("pick-q")
            .h(28)
            .px(8)
            .flex()
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .bg(t.surface)
            .cursor_text()
            .child(Input.new(this.pickBox).w_full().text_size(12).text_color(t.foreground));
        return v_flex()
            .gap(6)
            .child(button)
            .when(this.picking, (el) => el.child(search));
    }

    /** While the chooser is open this list takes the place of the graph: a long list and a long graph together are too much to draw. */
    repoList(t, hue) {
        const needle = this.pickBox.value().trim().toLowerCase();
        const shown = (this.repos ?? []).filter(
            (r) =>
                !needle ||
                relName(r.path, this.where.root).toLowerCase().includes(needle) ||
                r.branch.toLowerCase().includes(needle),
        );
        const row = (repo) => {
            const current = repo.path === this.repo;
            return h_flex()
                .id(`pick-${repo.path}`)
                .flex_none()
                .h(26)
                .px(8)
                .gap(8)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .when(current, (el) => el.bg(t.selected))
                .hover((s) => s.bg(current ? t.selected : t.hover))
                .on_click((_e, cx) => {
                    this.show(repo.path, true);
                    this.picking = false;
                    this.pickBox.set_value("");
                    cx.notify();
                })
                .child(div().flex_1().min_w(0).truncate().child(relName(repo.path, this.where.root)))
                .child(div().flex_none().max_w(130).truncate().text_size(10.5).text_color(t.dim).child(repo.branch))
                .child(
                    div()
                        .flex_none()
                        .w(8)
                        .h(8)
                        .rounded(8)
                        .when(repo.dirty, (el) => el.bg(hue(3))),
                );
        };
        return v_flex()
            .id("pick-list")
            .flex_1()
            .min_h(0)
            .p(6)
            .overflow_y_scrollbar()
            .when(shown.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No repo matches.")))
            .children(shown.map(row));
    }

    /** The top part: the repository chooser (when there are several), the branch with the Branch/All switch and Refresh, and the filter. */
    header(t, hue, hasChooser) {
        const headBranch = this.commits?.find((c) => c.head)?.refs.find((r) => r.kind === "local")?.name;
        const scopeButton = (id, label) =>
            div()
                .id(`s-${id}`)
                .h(22)
                .px(8)
                .flex()
                .items_center()
                .rounded(6)
                .text_size(11.5)
                .cursor_pointer()
                .text_color(this.scope === id ? t.foreground : t.muted)
                .when(this.scope === id, (el) => el.bg(t.raised))
                .on_click((_e, cx) => {
                    if (this.scope === id) return;
                    this.scope = id;
                    storage.write("scope", id);
                    this.selected = null;
                    cx.notify();
                })
                .child(label);
        return v_flex()
            .flex_none()
            .px(10)
            .py(8)
            .gap(8)
            .border_b(1)
            .border_color(t.border)
            .when(hasChooser, (el) => el.child(this.chooser(t, hue)))
            .child(
                h_flex()
                    .h(24)
                    .gap(6)
                    .items_center()
                    .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
                    .child(
                        div()
                            .min_w(0)
                            .truncate()
                            .font_semibold()
                            .child(headBranch ?? (this.commits ? "Detached HEAD" : "")),
                    )
                    .child(div().flex_1())
                    .child(scopeButton("branch", "Branch"))
                    .child(scopeButton("all", "All"))
                    .child(
                        div()
                            .id("refresh")
                            .ml(4)
                            .text_size(11)
                            .text_color(t.dim)
                            .cursor_pointer()
                            .hover((s) => s.text_color(t.foreground))
                            .tooltip("Read the history again")
                            .on_click((_e, cx) => {
                                this.logAt = 0;
                                this.reposAt = 0;
                                this.loadLog(cx);
                            })
                            .child(this.loading ? "Loading…" : "Refresh"),
                    ),
            )
            .child(
                div()
                    .id("query")
                    .h(28)
                    .px(8)
                    .flex()
                    .items_center()
                    .rounded(7)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.surface)
                    .cursor_text()
                    .child(Input.new(this.filterBox).w_full().text_size(12).text_color(t.foreground)),
            );
    }

    /** The commits (or why there are none), then "Load more" while a full page came back. */
    commitList(t, ctx, query) {
        const { flat } = ctx;
        const shown = (this.commits ?? [])
            .map((commit, i) => [commit, this.rows[i]])
            .filter(([commit]) => commitMatches(commit, query));
        const waiting = !this.error && !this.commits;
        let waitingText = "Loading…";
        if (!this.where.root) waitingText = "No folder.";
        else if (this.repos && !this.repo) waitingText = "No git repository found here.";
        const message = (text) => div().p(8).text_color(t.dim).child(text);
        const emptyText = flat
            ? `No commit matches “${query.trim()}” in the last ${this.commits?.length}.`
            : "No commits yet.";
        return v_flex()
            .id("commits")
            .flex_1()
            .min_h(0)
            .p(6)
            .overflow_y_scrollbar()
            .when(Boolean(this.error), (el) => el.child(message(this.error)))
            .when(waiting && Boolean(this.reposError) && !this.repo, (el) => el.child(message(this.reposError)))
            .when(waiting && !this.reposError, (el) => el.child(message(waitingText)))
            .when(Boolean(this.commits), (el) =>
                el
                    .when(shown.length === 0, (list) => list.child(message(emptyText)))
                    .children(
                        shown.flatMap(([commit, row]) => [
                            this.commitRow(t, commit, row, ctx),
                            ...(this.selected === commit.hash ? [this.commitDetail(t, commit, row, ctx)] : []),
                        ]),
                    )
                    .when(this.commits.length >= this.limit, (list) =>
                        list.child(
                            div()
                                .id("history-more")
                                .h(26)
                                .mx(8)
                                .my(6)
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(7)
                                .text_size(11.5)
                                .text_color(t.muted)
                                .bg(t.raised)
                                .cursor_pointer()
                                .hover((s) => s.text_color(t.foreground))
                                .on_click((_e, cx) => {
                                    if (this.loading) return;
                                    this.limit += PAGE;
                                    this.loadLog(cx);
                                })
                                .child(this.loading ? "Loading…" : "Load more"),
                        ),
                    ),
            );
    }

    render(_cx) {
        const t = theme();
        const palette = HUES[settings()?.dark === false ? "light" : "dark"];
        const hue = (i) => (i === null ? t.muted : palette[i % palette.length]);
        const query = this.filterBox.value();
        const width = Math.min(Math.max(1, ...(this.rows ?? []).map((r) => r.width)), MAX_LANES);
        const hasChooser = !this.single && (this.repos?.length ?? 0) > 0;
        const choosing = hasChooser && this.picking;
        const banner = h_flex()
            .flex_none()
            .h(28)
            .mx(6)
            .mt(6)
            .px(10)
            .gap(8)
            .items_center()
            .rounded(7)
            .bg(`${hue(3)}1f`)
            .text_size(12)
            .child(div().w(DOT).h(DOT).rounded(DOT).border(2).border_color(hue(3)))
            .child(div().flex_1().text_color(t.foreground).child("Uncommitted changes"))
            .child(div().font_semibold().text_color(hue(3)).child(`±${this.uncommitted}`));
        return v_flex()
            .id("history")
            .size_full()
            .min_h(0)
            .rounded(10)
            .overflow_hidden()
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .text_size(13)
            .child(this.header(t, hue, hasChooser))
            .when(choosing, (el) => el.child(this.repoList(t, hue)))
            .when(!choosing && this.uncommitted > 0, (el) => el.child(banner))
            .when(!choosing, (el) => el.child(this.commitList(t, { width, hue, flat: query.trim() !== "" }, query)));
    }
}
