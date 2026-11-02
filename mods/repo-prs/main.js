// PR & CI for the space's folder. Inside one git repository: that repository's pull requests. On a folder that holds
// many repositories (and worktrees): the open pull request of every repository that is on a feature branch, and, on the
// second tab, all of yours. Read-only: only `gh` reads and `git config` reads. Everything runs on the space's machine
// (`on`), except opening a link, which goes to this computer's browser.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, layout, panes, setShared, shared, spaces, theme, window } from "herdr";
import {
    countOf,
    ghError,
    inParallel,
    isOnScreen,
    parseRepos,
    relName,
    REVIEW,
    remember,
    SCRIPT,
    shapePr,
    since,
    checksOf,
} from "./lib.js";

const onScreen = () => isOnScreen(layout(), "repo-prs");
const REUSE_MS = 5 * 60000; // a result is reused this long; Refresh asks again
const GH_AT_ONCE = 4;
const MINE_UP_FRONT = 15; // "Mine": pull requests whose checks load without a click
const OPEN_PAGE = 30;
const JSON_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,updatedAt,author";
const icon = (name) => `mods/workspace-chrome/${name}.svg`;
const lastSegment = (path) => path.replace(/\/+$/, "").split("/").pop();
const MARK = { fail: "×", pending: "•", pass: "✓", skip: "–" };

/** The cache lives in the mod's own localStorage, so a restart shows the last result at once. */
function loadCache() {
    try {
        return JSON.parse(localStorage.getItem("cache") ?? "{}");
    } catch {
        return {};
    }
}
function saveCache(cache) {
    try {
        localStorage.setItem("cache", JSON.stringify(cache));
    } catch {
        // storage full or unavailable: the panel just loads again next time
    }
}

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

/** Links open on this computer, not on the machine that holds the repositories, so there is no `on`. */
function openLink(url) {
    if (!url) return;
    const platform = window()?.platform;
    const opener = platform === "windows" ? "explorer.exe" : platform === "macos" ? "open" : "xdg-open";
    exec(opener, [url]).catch(() => {});
}

/** `gh` with json output: `{ data }` or `{ err, auth, net, none }`. "No pull request for this branch" is `none`. */
async function gh(args, on) {
    const result = await exec("gh", args, { on });
    if (result.code !== 0) {
        const failure = ghError(result.stderr);
        return {
            err: failure.message,
            auth: failure.auth,
            net: failure.net,
            none: /no pull requests found/i.test(result.stderr),
        };
    }
    try {
        return { data: JSON.parse(result.stdout || "null") };
    } catch {
        return { err: "gh returned something unreadable." };
    }
}

/** The count on this panel's icon: open pull requests with a failing check. Set only on a change, since setting shared
 * state redraws every mod. */
function publishBadge(count) {
    const next = { count, tone: "blocked" };
    if (JSON.stringify(shared("badge.repo-prs")) !== JSON.stringify(next)) setShared("badge.repo-prs", next);
}

/** A small clickable text link, like "Refresh". */
const link = (t, id, label, onClick) =>
    div()
        .id(id)
        .flex_none()
        .text_size(11)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click(onClick)
        .child(label);

export default class RepoPullRequests extends View {
    init(_props, cx) {
        this.cache = loadCache();
        this.tab = "main";
        this.expanded = new Set();
        this.folded = new Set();
        this.showDefaults = false;
        this.fetching = new Set();
        this.enter(whereToLook());
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    /** A new folder or machine: forget what was shown and take what the cache has for it. */
    enter(where) {
        this.where = where;
        this.contextKey = JSON.stringify([where.root, where.on]);
        this.error = null;
        this.data = {};
        this.loadedAt = {};
        this.triedAt = {};
        this.single = this.cache[`${where.on}|${where.root}|kind`]?.data ?? null;
        if (this.single === null) return;
        for (const tab of ["main", "mine"]) {
            const cached = this.cache[this.cacheKey(tab)];
            if (cached) {
                this.data[tab] = cached.data;
                this.loadedAt[tab] = cached.at;
            }
        }
    }

    cacheKey(tab) {
        return ["v2", this.where.on, this.where.root, this.single ? "s" : "w", tab].join("|");
    }

    /** Runs every second and is cheap; the `gh` work only starts while the panel is on screen. Not called from `render`,
     * since loading notifies and `render` may not. */
    tick(cx) {
        const where = whereToLook();
        if (JSON.stringify([where.root, where.on]) !== this.contextKey) {
            this.enter(where);
            cx.notify();
        }
        this.updateBadge();
        if (!onScreen() || this.loading) return;
        const lastTry = Math.max(this.loadedAt[this.tab] ?? 0, this.triedAt[this.tab] ?? 0);
        if (Date.now() - lastTry > REUSE_MS) this.load(cx);
    }

    updateBadge() {
        const failing = new Set();
        for (const d of Object.values(this.data)) {
            const prs = [...(d?.repos?.map((r) => r.pr) ?? []), ...(d?.prs ?? []), d?.here, ...(d?.list ?? [])];
            for (const pr of prs) if (pr?.state === "OPEN" && countOf(pr, "fail")) failing.add(pr.url);
        }
        publishBadge(failing.size);
    }

    /** One load of the shown tab: never two at once, and a result for a folder that is no longer shown is dropped. */
    load(cx) {
        if (this.loading || !this.where?.root) return;
        const { root, on } = this.where;
        const contextKey = this.contextKey;
        const tab = this.tab;
        this.loading = true;
        this.triedAt[tab] = Date.now();
        cx.spawn(async (cx) => {
            try {
                const found = await exec("sh", ["-c", SCRIPT, "sh", root], { on });
                if (found.code !== 0) throw new Error((found.stderr || `exit ${found.code}`).trim().split("\n")[0]);
                if (contextKey !== this.contextKey) return;
                const discovery = parseRepos(found.stdout);
                this.single = discovery.single;
                saveCache(remember(this.cache, `${on}|${root}|kind`, discovery.single));
                let data;
                if (discovery.single) data = await this.loadOne(discovery, tab);
                else if (tab === "mine") data = await this.loadMine(cx, contextKey);
                else data = await this.loadWorkspace(cx, discovery, root, contextKey);
                if (contextKey !== this.contextKey) return;
                this.error = null;
                this.data[tab] = data;
                this.loadedAt[tab] = Date.now();
                saveCache(remember(this.cache, this.cacheKey(tab), data));
            } catch (e) {
                if (contextKey === this.contextKey) this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loading = false;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** The pull request of one branch: `{ pr }`, `{ none }` or `{ err, auth, net }`. */
    async lookup(slug, branch, on) {
        const reply = await gh(["pr", "view", branch, "--repo", slug, "--json", JSON_FIELDS], on);
        if (reply.data) return { pr: shapePr(reply.data, slug) };
        return reply.none ? { none: true } : { err: reply.err, auth: reply.auth, net: reply.net };
    }

    /** Workspace tab: each repository on a feature branch gets its branch's pull request and checks. The rows appear at
     * once as "Looking up…" and fill in as the calls return. */
    async loadWorkspace(cx, discovery, root, contextKey) {
        const repos = discovery.repos.map((repo) => {
            let status = "loading";
            if (!repo.slug) status = "noremote";
            else if (repo.onDefault) status = "default";
            return { ...repo, name: relName(repo.path, root), status, pr: null, err: null };
        });
        const data = { repos };
        this.data.main = data;
        cx.notify();
        // Worktrees of one branch share a lookup.
        const jobs = new Map();
        for (const repo of repos) if (repo.status === "loading") jobs.set(`${repo.slug}#${repo.branch}`, repo);
        let fatal = null;
        await inParallel([...jobs.values()], GH_AT_ONCE, async (job) => {
            if (fatal || contextKey !== this.contextKey) return;
            const found = await this.lookup(job.slug, job.branch, this.where.on);
            if ((found.auth || found.net) && !fatal) fatal = found.err;
            for (const repo of repos) {
                if (repo.slug !== job.slug || repo.branch !== job.branch) continue;
                repo.status = found.pr ? "pr" : found.none ? "nopr" : "error";
                repo.pr = found.pr ?? null;
                repo.err = found.err ?? null;
            }
            cx.notify();
        });
        if (fatal) throw new Error(fatal);
        return data;
    }

    /** Mine tab: one search for every open pull request of the user, then the checks of the first ones. */
    async loadMine(cx, contextKey) {
        const fields = "repository,number,title,url,isDraft,updatedAt";
        const reply = await gh(
            ["search", "prs", "--author=@me", "--state=open", "--json", fields, "--limit", "50"],
            this.where.on,
        );
        if (!reply.data) throw new Error(reply.err);
        const prs = reply.data
            .map((raw) => shapePr(raw, null))
            .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
        const data = { prs };
        this.data.mine = data;
        cx.notify();
        let fatal = null;
        const upFront = this.byRepo(prs)
            .flatMap((group) => group.prs)
            .slice(0, MINE_UP_FRONT);
        await inParallel(upFront, GH_AT_ONCE, async (pr) => {
            if (fatal || contextKey !== this.contextKey) return;
            const failure = await this.fetchChecks(pr, cx);
            if (failure && (failure.auth || failure.net)) fatal = failure.message;
        });
        if (fatal) throw new Error(fatal);
        return data;
    }

    /** The checks and review state of one pull request, by url. Returns an error object, or null when it worked. */
    async fetchChecks(pr, cx) {
        if (this.fetching.has(pr.url)) return null;
        this.fetching.add(pr.url);
        cx.notify();
        try {
            const reply = await gh(
                ["pr", "view", pr.url, "--json", "statusCheckRollup,reviewDecision,headRefName,state"],
                this.where.on,
            );
            if (!reply.data) return { message: reply.err, auth: reply.auth, net: reply.net };
            pr.checks = checksOf(reply.data.statusCheckRollup);
            pr.review = reply.data.reviewDecision ?? "";
            pr.branch = reply.data.headRefName ?? pr.branch;
            return null;
        } catch (e) {
            return { message: String(e?.message ?? e) };
        } finally {
            this.fetching.delete(pr.url);
            cx.notify();
        }
    }

    /** Inside one repository: the current branch's pull request, then the open ones (or only yours on the second tab). */
    async loadOne(discovery, tab) {
        const repo = discovery.repos[0];
        const on = this.where.on;
        if (!repo?.slug) throw new Error("No GitHub remote.");
        const listArgs = [
            "pr",
            "list",
            "--repo",
            repo.slug,
            "--state",
            "open",
            "--limit",
            String(OPEN_PAGE),
            "--json",
            JSON_FIELDS,
        ];
        if (tab === "mine") listArgs.push("--author", "@me");
        const skipHere = repo.onDefault || repo.branch === "(detached)";
        const [here, list] = await Promise.all([
            skipHere ? { none: true } : this.lookup(repo.slug, repo.branch, on),
            gh(listArgs, on),
        ]);
        if (!list.data) throw new Error(list.err);
        if (here.err && !here.none) throw new Error(here.err);
        const prs = list.data.map((raw) => shapePr(raw, repo.slug));
        const inTab = here.pr && (tab !== "mine" || prs.some((p) => p.n === here.pr.n));
        const current = inTab ? here.pr : null;
        return {
            slug: repo.slug,
            branch: repo.branch,
            name: lastSegment(repo.path),
            here: current,
            list: prs.filter((p) => p.n !== current?.n),
        };
    }

    byRepo(prs) {
        const groups = new Map();
        for (const pr of prs) groups.set(pr.slug, [...(groups.get(pr.slug) ?? []), pr]);
        return [...groups].map(([slug, list]) => ({ slug, prs: list }));
    }

    flip(set, key, cx) {
        if (!set.delete(key)) set.add(key);
        cx.notify();
    }

    // ---- drawing ----

    /** One pull request: a title row that opens it, then a summary row (branch, state, counts, review) that opens the check
     * list, then the checks that need attention, or all of them once expanded. */
    prBlock(t, pr, key, { showBranch = true } = {}) {
        const tint = { fail: t.blocked, pending: t.working, pass: t.done, skip: t.dim };
        const expanded = this.expanded.has(pr.url);
        const checks = pr.checks;
        const counts = ["fail", "pending", "pass"].filter((bucket) => countOf(pr, bucket));
        const attention = checks?.filter((c) => c.bucket === "fail" || c.bucket === "pending") ?? [];
        const listed = !checks ? [] : expanded ? checks : attention.slice(0, 5);
        const unlisted = checks ? checks.length - listed.length : 0;
        let state = null;
        if (pr.state === "MERGED") state = "Merged";
        else if (pr.state !== "OPEN") state = "Closed";
        else if (pr.draft) state = "Draft";
        const checksLabel = this.fetching.has(pr.url) ? "Loading checks…" : "Checks";

        const title = h_flex()
            .id(`pr-${key}`)
            .flex_none()
            .h(24)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip("Open in browser")
            .on_click(() => openLink(pr.url))
            .child(
                div()
                    .flex_none()
                    .text_size(11.5)
                    .text_color(pr.draft ? t.dim : t.accent)
                    .child(`#${pr.n}`),
            )
            .child(div().flex_1().min_w(0).truncate().child(pr.title))
            .child(
                div()
                    .flex_none()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(pr.updated ? since(pr.updated) : ""),
            );

        const summary = h_flex()
            .id(`sum-${key}`)
            .flex_none()
            .h(20)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .text_size(10.5)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.toggleChecks(pr, cx))
            .child(
                div()
                    .flex_none()
                    .text_color(t.dim)
                    .child(svg(icon(expanded ? "chevron-down" : "chevron-right")).size(11)),
            )
            .when(showBranch && Boolean(pr.branch), (el) =>
                el.child(div().min_w(0).max_w(150).truncate().text_color(t.dim).child(pr.branch)),
            )
            .when(state !== null, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_color(state === "Draft" ? t.dim : t.muted)
                        .child(state),
                ),
            )
            .children(
                counts.map((bucket) =>
                    div()
                        .flex_none()
                        .text_color(tint[bucket])
                        .child(`${MARK[bucket]}${countOf(pr, bucket)}`),
                ),
            )
            .when(checks && checks.length === 0, (el) =>
                el.child(div().flex_none().text_color(t.dim).child("No checks")),
            )
            .when(!checks, (el) => el.child(div().flex_none().text_color(t.dim).child(checksLabel)))
            .when(Boolean(REVIEW[pr.review]), (el) =>
                el.child(div().min_w(0).truncate().text_color(t.dim).child(REVIEW[pr.review])),
            );

        const rows = listed.map((check, i) =>
            h_flex()
                .id(`ck-${key}-${i}`)
                .flex_none()
                .h(22)
                .pl(26)
                .pr(8)
                .gap(6)
                .items_center()
                .rounded(6)
                .text_size(11.5)
                .when(Boolean(check.url), (el) =>
                    el
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover))
                        .tooltip("Open check")
                        .on_click(() => openLink(check.url)),
                )
                .child(div().w(10).flex_none().text_color(tint[check.bucket]).child(MARK[check.bucket]))
                .child(
                    div()
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .text_color(check.bucket === "skip" ? t.dim : check.bucket === "fail" ? t.foreground : t.muted)
                        .child(check.name),
                ),
        );
        return v_flex()
            .flex_none()
            .gap(1)
            .child(title)
            .child(summary)
            .children(rows)
            .when(unlisted > 0, (el) =>
                el.child(div().pl(26).h(18).text_size(10.5).text_color(t.dim).child(`+${unlisted} more`)),
            );
    }

    /** Opens or closes a pull request's check list; on "Mine", checks beyond the first ones load when asked for. */
    toggleChecks(pr, cx) {
        if (!this.expanded.delete(pr.url)) this.expanded.add(pr.url);
        cx.notify();
        if (pr.checks || this.fetching.has(pr.url)) return;
        cx.spawn(async (cx) => {
            const failure = await this.fetchChecks(pr, cx);
            if (failure) {
                this.error = failure.message;
                cx.notify();
            }
        });
    }

    /** A repository's name, with the folders above it dimmed after it. */
    repoName(t, repo) {
        const name = lastSegment(repo.name);
        const above = repo.name.slice(0, repo.name.length - name.length).replace(/\/$/, "");
        return h_flex()
            .flex_1()
            .min_w(0)
            .gap(6)
            .items_baseline()
            .child(div().flex_none().max_w(190).truncate().font_semibold().child(name))
            .when(Boolean(above), (el) =>
                el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(above)),
            );
    }

    branchTag(t, branch) {
        return h_flex()
            .flex_none()
            .max_w(150)
            .gap(4)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(svg(icon("branch")).size(11).flex_none())
            .child(div().min_w(0).truncate().child(branch));
    }

    /** A heading row; with `onClick` it also folds a group. */
    heading(t, label, id, { folded, onClick } = {}) {
        return h_flex()
            .id(id)
            .flex_none()
            .h(26)
            .mt(6)
            .px(6)
            .gap(6)
            .items_center()
            .rounded(6)
            .text_size(11)
            .font_semibold()
            .text_color(t.dim)
            .when(Boolean(onClick), (el) =>
                el
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => onClick(cx)),
            )
            .when(folded !== undefined, (el) => el.child(svg(icon(folded ? "chevron-right" : "chevron-down")).size(12)))
            .child(label);
    }

    note(t, text, color) {
        return div()
            .flex_none()
            .px(8)
            .py(3)
            .text_size(11.5)
            .text_color(color ?? t.dim)
            .child(text);
    }

    /** Workspace tab: repositories with a pull request first (failing ones on top), then those without, then a folded
     * group for the ones on a default branch. */
    workspaceRows(t) {
        const data = this.data.main;
        if (!data) return [this.note(t, this.error ? "" : "Looking for repos…")];
        const urgency = (repo) => {
            if (repo.pr) return countOf(repo.pr, "fail") ? 0 : countOf(repo.pr, "pending") ? 1 : 2;
            return { error: 3, nopr: 4 }[repo.status] ?? 5;
        };
        const featured = data.repos
            .filter((r) => ["pr", "nopr", "error", "loading"].includes(r.status))
            .sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name));
        const parked = data.repos.filter((r) => r.status === "default" || r.status === "noremote");
        const rows = featured.map((repo) => {
            const head = h_flex()
                .id(`repo-${repo.path}`)
                .flex_none()
                .h(28)
                .mt(4)
                .px(8)
                .gap(8)
                .items_center()
                .child(this.repoName(t, repo))
                .child(this.branchTag(t, repo.branch));
            if (repo.status === "pr")
                return v_flex()
                    .flex_none()
                    .child(head)
                    .child(this.prBlock(t, repo.pr, repo.path, { showBranch: false }));
            const line = repo.status === "nopr" ? "No PR" : repo.status === "loading" ? "Looking up…" : repo.err;
            const tone = repo.status === "error" ? t.blocked : t.dim;
            return v_flex()
                .flex_none()
                .child(head)
                .child(div().pl(8).pb(2).truncate().text_size(11.5).text_color(tone).child(line));
        });
        if (parked.length) {
            const toggle = (cx) => {
                this.showDefaults = !this.showDefaults;
                cx.notify();
            };
            rows.push(
                this.heading(t, `On default branch (${parked.length})`, "default-group", {
                    folded: !this.showDefaults,
                    onClick: toggle,
                }),
            );
            if (this.showDefaults) {
                for (const repo of parked) {
                    rows.push(
                        h_flex()
                            .id(`def-${repo.path}`)
                            .flex_none()
                            .h(24)
                            .pl(24)
                            .pr(8)
                            .gap(8)
                            .items_center()
                            .text_color(t.muted)
                            .child(this.repoName(t, repo))
                            .child(this.branchTag(t, repo.branch))
                            .when(repo.status === "noremote", (el) =>
                                el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("no remote")),
                            ),
                    );
                }
            }
        }
        if (!data.repos.length) rows.push(this.note(t, "No git repositories here."));
        return rows;
    }

    /** Mine tab: your open pull requests, grouped by repository. */
    mineRows(t) {
        const data = this.data.mine;
        if (!data) return [this.note(t, this.error ? "" : "Searching…")];
        if (!data.prs.length) return [this.note(t, "No open pull requests of yours.")];
        return this.byRepo(data.prs).flatMap((group) => {
            const folded = this.folded.has(group.slug);
            const head = this.heading(t, `${group.slug}  ${group.prs.length}`, `grp-${group.slug}`, {
                folded,
                onClick: (cx) => this.flip(this.folded, group.slug, cx),
            });
            return folded ? [head] : [head, ...group.prs.map((pr) => this.prBlock(t, pr, pr.url))];
        });
    }

    /** Inside one repository: this branch's pull request, then the others. */
    oneRepoRows(t) {
        const data = this.data[this.tab];
        if (!data) return [this.note(t, this.error ? "" : "Loading…")];
        const rows = [];
        if (data.here)
            rows.push(
                this.heading(t, "This branch", "here"),
                this.prBlock(t, data.here, "here", { showBranch: false }),
            );
        else if (data.branch && this.tab === "main")
            rows.push(this.heading(t, "This branch", "here"), this.note(t, `No PR for ${data.branch}.`));
        rows.push(this.heading(t, this.tab === "mine" ? "Mine" : "Open", "open-list"));
        if (!data.list.length)
            rows.push(
                this.note(
                    t,
                    this.tab === "mine" ? "No other open pull requests of yours." : "No other open pull requests.",
                ),
            );
        rows.push(...data.list.map((pr) => this.prBlock(t, pr, pr.url)));
        return rows;
    }

    /** The grey line in the header. */
    summaryText() {
        if (this.single) return this.data[this.tab]?.name ?? "";
        if (this.tab === "mine") return this.data.mine ? `${this.data.mine.prs.length} open` : "";
        const data = this.data.main;
        if (!data) return "";
        const withPr = data.repos.filter((r) => r.pr).length;
        const onBranch = data.repos.filter((r) => ["pr", "nopr", "error", "loading"].includes(r.status)).length;
        return `${data.repos.length} repos · ${onBranch} on branches · ${withPr} PRs`;
    }

    pickTab(id, cx) {
        if (this.tab === id) return;
        this.tab = id;
        cx.notify();
        const lastTry = Math.max(this.loadedAt[id] ?? 0, this.triedAt[id] ?? 0);
        if (onScreen() && Date.now() - lastTry > REUSE_MS) this.load(cx);
    }

    render(_cx) {
        const t = theme();
        const tabChip = (id, label) => {
            const active = this.tab === id;
            return div()
                .id(`tab-${id}`)
                .h(24)
                .px(9)
                .flex()
                .items_center()
                .rounded(6)
                .text_size(12)
                .cursor_pointer()
                .text_color(active ? t.foreground : t.muted)
                .when(active, (el) => el.bg(t.raised).font_semibold())
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.pickTab(id, cx))
                .child(label);
        };
        let rows;
        if (!this.where.root) rows = [this.note(t, "No folder.")];
        else if (this.single) rows = this.oneRepoRows(t);
        else rows = this.tab === "mine" ? this.mineRows(t) : this.workspaceRows(t);

        const header = h_flex()
            .h(42)
            .flex_none()
            .px(10)
            .gap(4)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(tabChip("main", this.single ? "Open" : "Workspace"))
            .child(tabChip("mine", "Mine"))
            .child(div().flex_1().min_w(0).truncate().pl(6).text_size(11).text_color(t.dim).child(this.summaryText()))
            .child(link(t, "prs-refresh", this.loading ? "Loading…" : "Refresh", (_e, cx) => this.load(cx)));
        return v_flex()
            .id("repo-prs")
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
            .when(Boolean(this.error), (el) =>
                el.child(
                    div().flex_none().px(12).py(4).truncate().text_size(11).text_color(t.blocked).child(this.error),
                ),
            )
            .child(v_flex().id("prs-list").flex_1().min_h(0).p(6).overflow_y_scrollbar().children(rows));
    }
}
