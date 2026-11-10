// PR & CI for the space's folder. Inside one git repository: that repository's pull requests. On a folder that holds
// many repositories (and worktrees): the open pull request of every repository that is on a feature branch, and, on the
// second tab, all of yours. Read-only: only `gh` reads and `git config` reads. Everything runs on the space's machine
// (`on`), except opening a link, which goes to this computer's browser.

import { h_flex, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import {
    appHome,
    exec,
    focused,
    layout,
    panes,
    readTextFile,
    setShared,
    shared,
    spaces,
    terminals,
    theme,
    window,
} from "herdr";
import { location, readFollow, writeFollow } from "./follow.js";
import {
    checkCount,
    checkSummary,
    checksOf,
    contextKeyOf,
    countOf,
    currentGeneration,
    ghError,
    githubUrl,
    inParallel,
    isOnScreen,
    loadRuns,
    parseRepos,
    prGroups,
    prRowDetail,
    REVIEW,
    relName,
    remember,
    SCRIPT,
    shapePr,
    shapeRuns,
    since,
    viewForContext,
    watchdog,
    workspaceRowsFor,
    workspaceSplit,
} from "./lib.js";
import { panelError, panelHeader } from "./panel-header.js";
import {
    contextCard,
    footer,
    groupHeader,
    groupOpen,
    moveActive,
    pill,
    primaryButton,
    row,
    secondaryButton,
    segmented,
    skeleton,
} from "./panel-kit.js";
import {
    focusRegained,
    friendlyError,
    parseRefreshConfig,
    RefreshScheduler,
    RefreshState,
    refreshSeconds,
    run as runCommand,
    terminalFinished,
} from "./refresh.js";

const onScreen = () => isOnScreen(layout(), "jig-prs");
const GH_AT_ONCE = 4;
const MINE_UP_FRONT = 15; // "Mine": pull requests whose checks load without a click
const OPEN_PAGE = 30;
const JSON_FIELDS =
    "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,updatedAt,author,mergeable,additions,deletions,changedFiles";
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

/** Git's raw failures as a line a person can act on. */
function friendly(text) {
    const line = String(text ?? "")
        .trim()
        .split("\n")[0];
    if (/not a git repository/i.test(line))
        return "No git repo in this folder. Open a terminal in one, or switch to Space.";
    if (/does not have any commits yet/i.test(line)) return "This repository has no commits yet.";
    return line;
}

/** The folder to look at and the machine it is on: the shown space's folder, else where its first terminal is. */
function whereToLook() {
    const space = spaces().find((s) => s.active);
    return location(readFollow(space?.id));
}

/** Links open on this computer, not on the machine that holds the repositories, so there is no `on`. */
function openLink(url) {
    if (!githubUrl(url)) return;
    const platform = window()?.platform;
    const opener = platform === "windows" ? "explorer.exe" : platform === "macos" ? "open" : "xdg-open";
    exec(opener, [url]).catch(() => {});
}

/** `gh` with json output: `{ data }` or `{ err, auth, net, none }`. "No pull request for this branch" is `none`. */
async function gh(args, on) {
    const result = await runCommand(exec, "gh", args, {
        on,
        env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    if (result.code !== 0) {
        if (result.timedOut || result.code === 124)
            return { err: friendlyError(result, { what: "Reading GitHub" }), auth: false, net: true, none: false };
        const failure = ghError(result.stderr);
        return {
            err: failure.message,
            auth: failure.auth,
            net: failure.net,
            notgithub: failure.notgithub,
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
    if (JSON.stringify(shared("badge.jig-prs")) !== JSON.stringify(next)) setShared("badge.jig-prs", next);
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
        this.generation = 0;
        this.tab = "main";
        this.expanded = new Set();
        this.folded = new Set();
        this.showDefaults = false;
        this.showNoPr = false;
        this.showParked = false;
        this.opened = new Set();
        this.activePr = null;
        this.keys = cx.focus_handle();
        this.fetching = new Set();
        this.refreshState = new RefreshState();
        this.configAt = 0;
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config, 180) });
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

    /** A new folder or machine: forget what was shown and take what the cache has for it. */
    enter(where) {
        this.where = where;
        this.contextKey = contextKeyOf(where);
        this.loadedContext = null;
        this.readGeneration++;
        this.refreshState.cancel();
        this.loading = false;
        this.contextChanged = true;
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
        if (Object.keys(this.data).length) this.loadedContext = this.contextKey;
    }

    cacheKey(tab) {
        return ["v2", this.where.on, this.where.root, this.single ? "s" : "w", tab].join("|");
    }

    /** Runs every second and is cheap; the `gh` work only starts while the panel is on screen. Not called from `render`,
     * since loading notifies and `render` may not. */
    tick(cx) {
        this.refreshState.tick(Date.now(), () => cx.notify());
        const where = whereToLook();
        if (contextKeyOf(where) !== this.contextKey) {
            this.enter(where);
            this.refreshScheduler.trigger();
            this.load(cx);
            cx.notify();
        }
        this.updateBadge();
        const seen = onScreen();
        const appeared = seen && !this.seen;
        this.seen = seen;
        if (!seen || !this.where?.root) return;
        if (appeared) this.refreshScheduler.trigger();
        this.loadConfig(cx);
        this.refreshScheduler.setSeconds(refreshSeconds(this.config, 180));
        const active = window()?.active === true;
        if (focusRegained(this.windowActive, active)) this.refreshScheduler.trigger();
        this.windowActive = active;
        const currentTerminals = terminals();
        if (terminalFinished(this.lastTerminals, currentTerminals, this.where.root)) this.refreshScheduler.trigger();
        this.lastTerminals = currentTerminals;
        if (!this.loading && this.refreshScheduler.due()) this.load(cx);
    }

    updateBadge() {
        const failing = new Set();
        for (const d of Object.values(this.data)) {
            const prs = [...(d?.repos?.map((r) => r.pr) ?? []), ...(d?.prs ?? []), d?.here, ...(d?.list ?? [])];
            for (const pr of prs) if (pr?.state === "OPEN" && countOf(pr, "fail")) failing.add(pr.url);
        }
        publishBadge(failing.size);
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < 60000) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/jig-prs/config.json`).catch(() => null);
            const refresh = parseRefreshConfig(text ?? "", 180);
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

    /** One load of the shown tab: never two at once, and a result for a folder that is no longer shown is dropped. */
    load(cx, user = false) {
        if (!this.where?.root) return;
        const { root, on } = this.where;
        const contextKey = this.contextKey;
        const tab = this.tab;
        const generation = ++this.generation;
        if (!this.refreshState.start({ user, first: this.data[tab] === undefined, notify: () => cx.notify() })) return;
        this.refreshScheduler.sweep();
        this.loading = true;
        this.triedAt[tab] = Date.now();
        const run = ++this.readGeneration;
        cx.spawn(async (cx) => {
            try {
                const work = (async () => {
                    const found = await runCommand(exec, "sh", ["-c", SCRIPT, "sh", root], { on });
                    if (run !== this.readGeneration) return;
                    if (found.code !== 0) throw Object.assign(new Error(found.stderr || `exit ${found.code}`), found);
                    if (contextKey !== this.contextKey) return;
                    const discovery = parseRepos(found.stdout);
                    this.single = discovery.single;
                    saveCache(remember(this.cache, `${on}|${root}|kind`, discovery.single));
                    let data;
                    if (discovery.single) data = await this.loadOne(discovery, tab);
                    else if (tab === "mine") data = await this.loadMine(cx, contextKey);
                    else data = await this.loadWorkspace(cx, discovery, root, contextKey);
                    if (run !== this.readGeneration || contextKey !== this.contextKey) return;
                    this.error = null;
                    if (!currentGeneration(generation, this.generation)) return;
                    this.data[tab] = data;
                    this.loadedContext = contextKey;
                    this.loadedAt[tab] = Date.now();
                    saveCache(remember(this.cache, this.cacheKey(tab), data));
                })();
                await work;
            } catch (e) {
                if (run === this.readGeneration && contextKey === this.contextKey) {
                    this.error = friendlyError(e, { what: "Reading", follow: true });
                    this.loading = false;
                }
            } finally {
                if (run === this.readGeneration) {
                    this.loading = false;
                    if (this.refreshState.finish()) {
                        this.triedAt[tab] = 0;
                        this.refreshScheduler.trigger();
                    }
                    cx.notify();
                }
            }
        });
        cx.notify();
    }

    /** The pull request of one branch: `{ pr }`, `{ none }` or `{ err, auth, net }`. */
    async lookup(slug, branch, on) {
        const reply = await gh(
            ["pr", "list", "--repo", slug, "--head", branch, "--state", "open", "--limit", "1", "--json", JSON_FIELDS],
            on,
        );
        if (reply.data) return reply.data[0] ? { pr: shapePr(reply.data[0], slug) } : { none: true };
        return reply.none
            ? { none: true }
            : { err: reply.err, auth: reply.auth, net: reply.net, notgithub: reply.notgithub };
    }

    /** Workspace tab: each repository on a feature branch gets its branch's pull request and checks. The rows appear at
     * once as "Looking up…" and fill in as the calls return. */
    async loadWorkspace(cx, discovery, root, contextKey) {
        const repos = workspaceRowsFor(discovery, root);
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
                repo.status = found.pr ? "pr" : found.none ? "nopr" : found.notgithub ? "notgithub" : "error";
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
                ["pr", "view", pr.url, "--json", "statusCheckRollup,reviewDecision,headRefName,state,mergeable"],
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
        let runs = null,
            runsError = null;
        if (!current && repo.branch && repo.branch !== "(detached)") {
            const loaded = await loadRuns(gh, repo.slug, repo.branch, on);
            runs = loaded.runs;
            runsError = loaded.error;
        }
        return {
            slug: repo.slug,
            branch: repo.branch,
            name: lastSegment(repo.path),
            here: current,
            runs,
            runsError,
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
            .child(div().flex_1().min_w(0).truncate().tooltip(pr.title).child(pr.title))
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
            .when(Boolean(pr.author), (el) => el.child(div().flex_none().text_color(t.dim).child(`@${pr.author}`)))
            .when(pr.mergeable === "CONFLICTING", (el) =>
                el.child(div().flex_none().text_color(t.blocked).child("conflicts")),
            )
            .children(
                counts.map((bucket) =>
                    div()
                        .flex_none()
                        .text_color(tint[bucket])
                        .when(bucket === "pass", (el) =>
                            el.tooltip(
                                (checks ?? [])
                                    .filter((c) => c.bucket === "pass")
                                    .map((c) => c.name)
                                    .join("\n"),
                            ),
                        )
                        .child(`${MARK[bucket]}${countOf(pr, bucket)}`),
                ),
            )
            .when(Boolean(checks && checks.length > 0), (el) => {
                const text = checkSummary(checks);
                return el.child(div().flex_none().text_color(t.muted).child(text));
            })
            .when(Boolean(checks?.find((c) => c.bucket === "fail")), (el) => {
                const first = checks.find((c) => c.bucket === "fail");
                return el.child(
                    div()
                        .min_w(0)
                        .truncate()
                        .text_color(t.blocked)
                        .when(Boolean(first.url), (st) => st.cursor_pointer().on_click(() => openLink(first.url)))
                        .tooltip("Failing check")
                        .child(first.name),
                );
            })
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
                el.child(
                    div()
                        .pl(26)
                        .h(18)
                        .text_size(10.5)
                        .text_color(t.dim)
                        .cursor_pointer()
                        .hover((st) => st.text_color(t.foreground))
                        .on_click((_e, cx) => this.toggleChecks(pr, cx))
                        .child(`${checkCount(unlisted)} not shown`),
                ),
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

    /** Workspace tab: the PRs by urgency, then folded No PR / parked groups. */
    workspaceRows(t) {
        const data = this.data.main;
        if (!data) return [this.note(t, this.error ? "" : "Looking for repos…")];
        const groups = prGroups(data.repos);
        const items = [];
        const groupsShown = [groups.needs, groups.waiting, groups.ready, groups.noPr, groups.parked].filter(
            (list) => list.length,
        ).length;
        const section = (key, label, color, rows, shown, toggle) => {
            if (!rows.length) return;
            const open = groupOpen(shown, groupsShown);
            const action =
                rows.length && groupsShown > 1 && key !== "needs" && key !== "waiting" && key !== "ready"
                    ? secondaryButton(
                          t,
                          `toggle-${key}`,
                          open ? "Hide" : "Show",
                          (cx) => {
                              toggle(cx);
                          },
                          { h: 26 },
                      )
                    : null;
            items.push(groupHeader(t, key, label, rows.length, color, action));
            if (!open) return;
            for (const repo of rows) items.push(this.prKitRow(t, repo));
        };
        section("needs", "Needs fixing", t.ansi1, groups.needs, true, () => {});
        section("waiting", "Waiting", t.blocked, groups.waiting, true, () => {});
        section("ready", "Ready", t.ansi2, groups.ready, true, () => {});
        section("noPr", "No PR", t.muted, groups.noPr, this.showNoPr, (cx) => {
            this.showNoPr = !this.showNoPr;
            cx.notify();
        });
        section("parked", "No remote / not on GitHub", t.muted, groups.parked, this.showParked, (cx) => {
            this.showParked = !this.showParked;
            cx.notify();
        });
        if (!data.repos.length) items.push(this.note(t, "No git repositories here."));
        return items;
    }

    /** One repository as a kit row; opening shows the failing checks and read-only links. */
    prKitRow(t, repo) {
        const pr = repo.pr;
        const open = this.opened.has(repo.path);
        const title = pr?.title ?? repo.name;
        const detail = prRowDetail(repo);
        const chips = pr
            ? [
                  pill(checkSummary(pr.checks ?? []), t),
                  pr.review ? pill(pr.review, t) : null,
                  pr.additions || pr.deletions ? pill(`+${pr.additions} −${pr.deletions}`, t) : null,
              ].filter(Boolean)
            : [];
        const fails = (pr?.checks ?? []).filter((c) => c.bucket === "fail");
        const details = v_flex()
            .p(8)
            .gap(6)
            .children(fails.map((check) => div().text_size(12).text_color(t.ansi1).truncate().child(`× ${check.name}`)))
            .when(Boolean(pr?.url), (el) =>
                el.child(
                    h_flex()
                        .gap(6)
                        .justify_end()
                        .child(
                            primaryButton(t, `open-${repo.path}`, "Open on GitHub", () => openLink(pr.url), { h: 26 }),
                        )
                        .child(
                            secondaryButton(
                                t,
                                `copy-${repo.path}`,
                                "Copy link",
                                (cx) => cx.write_to_clipboard(pr.url),
                                { h: 26 },
                            ),
                        ),
                ),
            );
        return row(t, {
            id: repo.path,
            color:
                repo.status === "error"
                    ? t.ansi1
                    : pr
                      ? countOf(pr, "fail")
                          ? t.ansi1
                          : countOf(pr, "pending")
                            ? t.blocked
                            : t.ansi2
                      : t.muted,
            title,
            detail,
            chips,
            open,
            active: this.activePr === repo.path,
            onToggle: (cx) => {
                if (!pr) return;
                if (open) this.opened.delete(repo.path);
                else this.opened.add(repo.path);
                cx.notify();
            },
            details: pr ? details : null,
        });
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
        if (!data) return [this.note(t, this.error ? "" : "Reading…")];
        const rows = [];
        if (data.here)
            rows.push(
                this.heading(t, "This branch", "here"),
                this.prBlock(t, data.here, "here", { showBranch: false }),
            );
        else if (data.branch && this.tab === "main") {
            rows.push(this.heading(t, "This branch", "here"), this.note(t, `No PR for ${data.branch}.`));
            rows.push(this.heading(t, "Latest CI runs", "runs"));
            if (data.runsError) rows.push(this.note(t, `CI runs unavailable: ${data.runsError}`));
            else if (data.runs) {
                const runs = data.runs;
                if (runs.length === 0) rows.push(this.note(t, "No CI runs on this branch."));
                for (const [i, run] of runs.entries())
                    rows.push(
                        h_flex()
                            .id(`run-${i}`)
                            .h(22)
                            .px(8)
                            .gap(8)
                            .items_center()
                            .text_size(11.5)
                            .when(Boolean(run.url), (el) =>
                                el
                                    .cursor_pointer()
                                    .hover((st) => st.bg(t.hover))
                                    .on_click(() => openLink(run.url)),
                            )
                            .child(
                                div()
                                    .w(10)
                                    .text_color(
                                        run.conclusion === "success" ? t.done : run.conclusion ? t.blocked : t.dim,
                                    )
                                    .child(run.conclusion === "success" ? "✓" : run.conclusion ? "✕" : "•"),
                            )
                            .child(div().flex_1().min_w(0).truncate().child(run.name))
                            .child(
                                div()
                                    .text_color(t.dim)
                                    .child(run.status || run.conclusion || ""),
                            )
                            .child(
                                div()
                                    .text_color(t.dim)
                                    .child(run.at ? since(run.at) : ""),
                            ),
                    );
            }
        }
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
        const onBranch = data.repos.filter((r) => !r.onDefault).length;
        return `${data.repos.length} repos · ${onBranch} non-default branches · ${withPr} PRs`;
    }

    pickTab(id, cx) {
        if (this.tab === id) return;
        this.tab = id;
        cx.notify();
        if (onScreen() && this.data[id] === undefined) this.load(cx, true);
    }

    render(_cx) {
        const t = theme();
        let rows;
        const state = viewForContext(this.contextKey, this.loadedContext, this.data[this.tab]?.repos ?? [], {
            error: this.error,
            noFolder: !this.where.root,
        });
        if (state.pending) rows = [skeleton(t)];
        else if (!this.where.root) rows = [this.note(t, "No folder.")];
        else if (state.error && state.rows.length === 0) rows = [];
        else if (this.single) rows = this.oneRepoRows(t);
        else rows = this.tab === "mine" ? this.mineRows(t) : this.workspaceRows(t);

        const space = spaces().find((s) => s.active);
        const follow = readFollow(space?.id);
        const header = panelHeader(t, {
            title: "PR & CI",
            titleTooltip: this.where.root || "PR & CI",
            readAt: this.loadedAt[this.tab] ?? 0,
            busy: this.refreshState.busy,
            onRefresh: (cx) => this.load(cx, true),
            refreshIcon: "mods/jig-prs/refresh.svg",
        });
        return v_flex()
            .id("jig-prs")
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
                    name: this.where.root
                        ? (this.where.root.split(/[\\/]/).filter(Boolean).pop() ?? "PR & CI")
                        : "PR & CI",
                    follow,
                    onFollow: (cx) => {
                        writeFollow(space?.id, !follow);
                        this.load(cx, true);
                    },
                    machine: this.where.on ?? null,
                }),
            )
            .child(
                segmented(
                    t,
                    "prs-tabs",
                    [
                        ["main", `Workspace ${this.data.main?.repos?.filter((r) => r.pr).length ?? 0}`],
                        ["mine", `Mine ${this.data.mine?.prs?.length ?? 0}`],
                    ],
                    this.tab,
                    (key, cx) => this.pickTab(key, cx),
                ),
            )
            .when(Boolean(this.error), (el) => el.child(panelError(t, this.error)))
            .when(Boolean(this.summaryText()), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .px(12)
                        .py(2)
                        .truncate()
                        .text_size(10.5)
                        .text_color(t.muted)
                        .child(this.summaryText()),
                ),
            )
            .when(Boolean(this.refreshProblem), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .px(12)
                        .py(2)
                        .truncate()
                        .text_size(10.5)
                        .text_color(t.muted)
                        .child(this.refreshProblem),
                ),
            )
            .child(
                v_flex()
                    .id("prs-list")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
                    .track_focus(this.keys)
                    .on_key_down((e, cx) => {
                        const ids = (this.data.main?.repos ?? []).map((r) => r.path);
                        if (e.key === "up" || e.key === "down") {
                            this.activePr = moveActive(ids, this.activePr, e.key === "up" ? -1 : 1);
                            cx.stop_propagation();
                            cx.notify();
                        } else if ((e.key === "enter" || e.key === "space") && this.activePr) {
                            if (this.opened.has(this.activePr)) this.opened.delete(this.activePr);
                            else this.opened.add(this.activePr);
                            cx.stop_propagation();
                            cx.notify();
                        } else if (e.key === "escape") {
                            this.opened.clear();
                            this.activePr = null;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    })
                    .children(rows),
            )
            .child(
                footer(t, {
                    summary: `${this.data.main?.repos?.filter((r) => r.pr).length ?? 0} PRs · ${
                        this.data.main?.repos?.filter((r) => countOf(r.pr, "fail")).length ?? 0
                    } failing`,
                    action: null,
                }),
            );
    }
}
