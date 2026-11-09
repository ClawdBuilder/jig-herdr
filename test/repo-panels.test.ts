// The pure parts of the PR & CI, Worktrees and History panels (their lib.js files), and their shell scripts run on real
// git repositories made in temporary folders.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "./support.ts";

// The libs are plain JavaScript; each test says which of their functions it uses.
type Lib = Record<string, any>;

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        timeout: 30_000,
        cwd,
        encoding: "utf8",
    }).trim();

/** A temporary folder that is removed when the test ends. */
function scratch(t: { after(fn: () => void): void }): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-herdr-panels-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A repository with one commit on `main`. */
function repo(root: string, name: string): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "README.md"), "# demo\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "first");
    return dir;
}

const commitFile = (dir: string, file: string, message: string) => {
    writeFileSync(path.join(dir, file), "content\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", message);
};

const runScript = (script: string, root: string) =>
    execFileSync("sh", ["-c", script, "sh", root], { timeout: 30_000, encoding: "utf8" });

// ---- the three panels share how they see the layout ----

test("each panel knows whether its block is on screen: hidden nodes and other stack children hide it", async () => {
    const stackChildren = [
        { id: "pr", content: { mod: "jig-prs" } },
        { id: "wt", content: { mod: "jig-worktrees" } },
        { id: "hist", content: { mod: "jig-history" } },
    ];
    const layout = { id: "root", children: [{ id: "stack", type: "stack", active: "pr", children: stackChildren }] };
    const hidden = { id: "root", children: [{ id: "stack", type: "stack", hidden: true, children: stackChildren }] };
    const first = { id: "root", children: [{ id: "stack", type: "stack", children: stackChildren }] };
    for (const [file, name] of [
        ["mods/jig-prs/lib.js", "isOnScreen"],
        ["mods/jig-worktrees/lib.js", "isOnScreen"],
        ["mods/jig-history/lib.js", "isOnScreen"],
        ["mods/jig-git/layout.js", "shown"],
    ] as const) {
        const onScreen = (await load<Lib>(file))[name] as (root: unknown, mod: string) => boolean;
        assert.equal(onScreen(layout, "jig-prs"), true, `${file}: the active child`);
        assert.equal(onScreen(layout, "jig-worktrees"), false, `${file}: another child of the stack`);
        assert.equal(onScreen(first, "jig-prs"), true, `${file}: a stack with no active child shows its first`);
        assert.equal(onScreen(first, "jig-history"), false, file);
        assert.equal(onScreen(hidden, "jig-prs"), false, `${file}: a hidden stack hides what is in it`);
        assert.equal(onScreen(layout, "in-a-tab"), true, `${file}: a mod with no block lives in a tab of its own`);
        assert.equal(onScreen(null, "jig-prs"), true, `${file}: no layout`);
    }
});

test("every panel words an age the same way", async () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    for (const file of ["mods/jig-prs/lib.js", "mods/jig-worktrees/lib.js", "mods/jig-history/lib.js"]) {
        const { since } = await load<Lib>(file);
        assert.equal(since("2026-01-10T11:59:40Z", now), "now");
        assert.equal(since("2026-01-10T11:55:00Z", now), "5m");
        assert.equal(since("2026-01-10T09:00:00Z", now), "3h");
        assert.equal(since("2026-01-08T12:00:00Z", now), "2d");
        assert.equal(since("not a date", now), "now", "an unreadable date is not an error");
    }
});

// ---- PR & CI ----

test("jig-prs reads the owner and name from every form of remote url", async () => {
    const { slugOf } = await load<Lib>("mods/jig-prs/lib.js");
    assert.equal(slugOf("https://github.com/acme/orders-api.git"), "acme/orders-api");
    assert.equal(slugOf("https://github.com/acme/orders-api"), "acme/orders-api");
    assert.equal(slugOf("git@github.com:acme/orders-api.git"), "acme/orders-api");
    assert.equal(slugOf("git@github.com-work:acme/orders-api.git"), "acme/orders-api");
    assert.equal(slugOf("ssh://git@github.com/acme/orders-api/"), "acme/orders-api");
    assert.equal(slugOf(""), null);
    assert.equal(slugOf(undefined), null);
});

test("jig-prs sorts checks into fail, pending, pass and skip, and a cancelled run is skipped, not failed", async () => {
    const { checksOf, countOf, bucketOf } = await load<Lib>("mods/jig-prs/lib.js");
    for (const [result, bucket] of [
        ["FAILURE", "fail"],
        ["ERROR", "fail"],
        ["TIMED_OUT", "fail"],
        ["ACTION_REQUIRED", "fail"],
        ["STARTUP_FAILURE", "fail"],
        ["CANCELLED", "skip"],
        ["SKIPPED", "skip"],
        ["NEUTRAL", "skip"],
        ["STALE", "skip"],
        ["SUCCESS", "pass"],
        ["", "pending"],
        ["PENDING", "pending"],
        ["IN_PROGRESS", "pending"],
    ]) {
        assert.equal(bucketOf(result), bucket, result || "(no result yet)");
    }
    const checks = checksOf([
        { name: "lint", workflowName: "CI", conclusion: "SUCCESS", detailsUrl: "https://ci.example.com/1" },
        { name: "build", workflowName: "CI", conclusion: "CANCELLED" },
        { name: "test", workflowName: "CI", conclusion: "FAILURE", detailsUrl: "https://ci.example.com/3" },
        { context: "deploy-preview", state: "PENDING", targetUrl: "https://ci.example.com/4" },
        { name: "docs", conclusion: "" },
    ]);
    assert.deepEqual(
        checks.map((c: { name: string; bucket: string }) => [c.name, c.bucket]),
        [
            ["CI / test", "fail"],
            ["deploy-preview", "pending"],
            ["docs", "pending"],
            ["CI / lint", "pass"],
            ["CI / build", "skip"],
        ],
        "failures first, then pending, passed, skipped; a workflow name leads its check",
    );
    assert.equal(checks[1].url, "https://ci.example.com/4", "a commit status keeps its target url");
    const pr = { checks };
    assert.deepEqual(
        ["fail", "pending", "pass", "skip"].map((b) => countOf(pr, b)),
        [1, 2, 1, 1],
    );
    assert.equal(countOf({ checks: null }, "fail"), 0);
    assert.deepEqual(checksOf(null), []);
});

test("jig-prs keeps the small shape of a pull request, with checks unknown until the rollup is", async () => {
    const { shapePr } = await load<Lib>("mods/jig-prs/lib.js");
    const searched = shapePr(
        {
            number: 7,
            title: "Add retries",
            url: "https://github.com/acme/orders-api/pull/7",
            isDraft: true,
            repository: { nameWithOwner: "acme/orders-api" },
        },
        null,
    );
    assert.equal(searched.checks, null);
    assert.deepEqual([searched.n, searched.draft, searched.state, searched.slug], [7, true, "OPEN", "acme/orders-api"]);
    const viewed = shapePr(
        {
            number: 8,
            title: "x",
            url: "u",
            statusCheckRollup: [{ name: "a", conclusion: "SUCCESS" }],
            reviewDecision: "APPROVED",
        },
        "acme/billing-web",
    );
    assert.deepEqual([viewed.checks.length, viewed.review, viewed.slug], [1, "APPROVED", "acme/billing-web"]);
});

test("jig-prs words gh's failures: sign-in and network problems are flagged", async () => {
    const { ghError } = await load<Lib>("mods/jig-prs/lib.js");
    assert.equal(ghError("To get started with GitHub CLI, please run:  gh auth login").auth, true);
    assert.equal(ghError("HTTP 401: Bad credentials").auth, true);
    assert.equal(
        ghError("error connecting to api.github.com: dial tcp: lookup api.github.com: could not resolve host").net,
        true,
    );
    assert.equal(ghError("API rate limit exceeded for user").message, "GitHub rate limit reached; try again later.");
    assert.deepEqual(ghError("GraphQL: Could not resolve to a Repository"), {
        message: "GraphQL: Could not resolve to a Repository",
    });
    assert.equal(ghError("").message, "gh failed");
});

test("jig-prs runs at most the asked number of calls at once, and all of them", async () => {
    const { inParallel } = await load<Lib>("mods/jig-prs/lib.js");
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    await inParallel([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n: number) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(n);
        running--;
    });
    assert.equal(most, 3);
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await inParallel([], 4, async () => assert.fail("nothing to do"));
});

test("jig-prs keeps the newest twelve cache entries", async () => {
    const { remember } = await load<Lib>("mods/jig-prs/lib.js");
    const cache: Record<string, { at: number; data: unknown }> = {};
    const real = Date.now;
    try {
        for (let i = 0; i < 15; i++) {
            Date.now = () => 1_000 + i;
            remember(cache, `k${i}`, i);
        }
    } finally {
        Date.now = real;
    }
    assert.equal(Object.keys(cache).length, 12);
    assert.equal("k0" in cache, false);
    assert.equal(cache.k14?.data, 14);
});

test("jig-prs finds repositories, their branch, remote and default branch, on real repositories", async (t) => {
    const { SCRIPT, parseRepos, relName } = await load<Lib>("mods/jig-prs/lib.js");
    const root = scratch(t);
    const orders = repo(root, "orders-api");
    git(orders, "remote", "add", "origin", "git@github.com:acme/orders-api.git");
    git(orders, "checkout", "-qb", "feature/PROJ-123");
    const billing = repo(root, "billing-web");
    git(billing, "remote", "add", "origin", "https://github.com/acme/billing-web.git");
    repo(root, "worktrees/PROJ-123/docs-site");
    mkdirSync(path.join(root, "node_modules/lib/.git"), { recursive: true });
    mkdirSync(path.join(root, "plain-folder"));

    const found = parseRepos(runScript(SCRIPT, root));
    assert.equal(found.single, false);
    const byName = Object.fromEntries(found.repos.map((r: { path: string }) => [relName(r.path, root), r]));
    assert.deepEqual(Object.keys(byName).sort(), ["billing-web", "orders-api", "worktrees/PROJ-123/docs-site"]);
    assert.deepEqual(
        [byName["orders-api"].branch, byName["orders-api"].slug, byName["orders-api"].onDefault],
        ["feature/PROJ-123", "acme/orders-api", false],
    );
    assert.deepEqual([byName["billing-web"].branch, byName["billing-web"].onDefault], ["main", true]);
    assert.equal(byName["worktrees/PROJ-123/docs-site"].slug, null, "no remote: no slug");

    // Inside a repository, only that one is listed.
    mkdirSync(path.join(orders, "src"));
    const real = parseRepos(runScript(SCRIPT, path.join(orders, "src")));
    assert.deepEqual(
        real.repos.map((r: { path: string }) => r.path),
        [orders],
    );
    assert.equal(real.single, true);
});

// ---- Worktrees ----

test("jig-worktrees is ready only when the work is in the base and nothing is at risk", async () => {
    const { readiness } = await load<Lib>("mods/jig-worktrees/lib.js");
    const clean = {
        path: "/w/orders-api-feature",
        main: "/w/orders-api",
        locked: false,
        dirty: 0,
        unpushed: 1,
        created: "a".repeat(40),
        head: "bbb",
        upstream: "",
        base: "origin/main",
        baseAhead: 0,
        gone: false,
    };
    assert.equal(readiness(clean, false), "in base");
    assert.equal(readiness({ ...clean, baseAhead: 3, gone: true, unpushed: 0 }, false), "upstream gone");
    assert.equal(
        readiness({ ...clean, baseAhead: 3 }, false),
        null,
        "work not in base and the remote branch still there",
    );
    assert.equal(readiness({ ...clean, unpushed: 25 }, false), "in base", "merged locally, no upstream needed");
    assert.equal(
        readiness({ ...clean, unpushed: 0, main: clean.path }, false),
        null,
        "the main checkout is not removable",
    );
    assert.equal(
        readiness({ ...clean, baseAhead: 3, gone: true, unpushed: 2 }, false),
        null,
        "gone, but its commits are nowhere else",
    );
    assert.equal(readiness({ ...clean, dirty: 1 }, false), null, "uncommitted changes");
    assert.equal(readiness({ ...clean, locked: true }, false), null, "locked");
    assert.equal(readiness(clean, true), null, "an agent is working there");
    // What git could not tell is never ready.
    assert.equal(readiness({ ...clean, dirty: null }, false), null);
    assert.equal(readiness({ ...clean, unpushed: null }, false), null);
    assert.equal(readiness({ ...clean, base: "" }, false), null);
    assert.equal(readiness({ ...clean, baseAhead: null }, false), null);
});

test("the Worktrees header title says 0, 1 or n", async () => {
    const { worktreeTitle } = await load<Lib>("mods/jig-worktrees/lib.js");
    assert.equal(worktreeTitle(0), "Worktrees");
    assert.equal(worktreeTitle(1), "1 worktree");
    assert.equal(worktreeTitle(15), "15 worktrees");
});

test("jig-worktrees reads the script's lines, keeping what git could not tell as null", async () => {
    const { parseTrees, nameOf, relName } = await load<Lib>("mods/jig-worktrees/lib.js");
    const line = (...f: string[]) => ["W", ...f].join("\t");
    const out = [
        "@single",
        line(
            "/w/orders-api",
            "/w/orders-api-wt",
            "feature/a",
            "abc12345",
            "0",
            "2",
            "1",
            "0",
            "1",
            "origin/feature/a",
            "0",
            "0",
            "origin/main",
            "2026-01-02T03:04:05+00:00",
            "abc12345",
            "fix: a\tb",
        ),
        line("/w/orders-api", "/w/orders-api-gone", "", "def67890", "1", "?", "", "", "", "", "1", "?", "", "", ""),
    ].join("\n");
    const { single, trees } = parseTrees(out);
    assert.equal(single, true);
    assert.deepEqual(
        [
            trees[0].branch,
            trees[0].dirty,
            trees[0].ahead,
            trees[0].behind,
            trees[0].baseAhead,
            trees[0].unpushed,
            trees[0].subject,
        ],
        ["feature/a", 2, 1, 0, 1, 0, "fix: a\tb"],
    );
    assert.deepEqual(
        [
            trees[1].branch,
            trees[1].locked,
            trees[1].dirty,
            trees[1].baseAhead,
            trees[1].unpushed,
            trees[1].gone,
            trees[1].date,
        ],
        ["", true, null, null, null, true, null],
    );
    assert.equal(nameOf("/w/orders-api/"), "orders-api");
    assert.equal(relName("/w/a/b", "/w"), "a/b");
    assert.equal(relName("/elsewhere/b", "/w"), "b");
});

test("jig-worktrees reads worktree paths with tabs and newlines and a subject with tabs", async (t) => {
    const { SCRIPT, parseTrees } = await load<Lib>("mods/jig-worktrees/lib.js");
    const root = scratch(t);
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const repoDir = repo(root, "seed");
    git(repoDir, "remote", "add", "origin", origin);
    git(repoDir, "push", "-q", "origin", "main");
    const main = path.join(root, "orders-api");
    git(root, "clone", "-q", origin, "orders-api");

    const cases = [
        { branch: "feature/tab", name: "with\t tab" },
        { branch: "feature/newline", name: "with\nnewline" },
    ];
    const made: Array<{ path: string; branch: string }> = [];
    for (const one of cases) {
        const worktree = path.join(root, one.name);
        try {
            git(main, "worktree", "add", "-q", "-b", one.branch, worktree);
        } catch (error) {
            t.skip(`filesystem refused a ${JSON.stringify(one.name)} worktree: ${error}`);
            return;
        }
        made.push({ path: worktree, branch: one.branch });
        writeFileSync(path.join(worktree, "change.txt"), `${one.branch}\n`);
        git(worktree, "add", "change.txt");
        git(worktree, "commit", "-qm", "fix: a subject\twith tabs");
    }
    const parsed = parseTrees(runScript(SCRIPT, root));
    for (const expected of made) {
        const found = parsed.trees.find((row: { path: string }) => row.path === expected.path);
        assert.ok(found, expected.path);
        assert.equal(found.branch, expected.branch);
        assert.match(found.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
        assert.match(found.created ?? "", /^[0-9a-f]{40}$/);
        assert.equal(found.subject, "fix: a subject\twith tabs");
    }
});

test("jig-worktrees tells ready from in-progress worktrees on real repositories", async (t) => {
    const { SCRIPT, parseTrees, readiness } = await load<Lib>("mods/jig-worktrees/lib.js");
    const root = scratch(t);
    // A remote, and a clone of it that holds the worktrees.
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const seed = repo(root, "seed");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    git(root, "clone", "-q", origin, "orders-api");
    const main = path.join(root, "orders-api");
    const trees = path.join(root, "trees");
    const add = (name: string, ...extra: string[]) => {
        git(main, "worktree", "add", "-q", ...extra, path.join(trees, name));
        return path.join(trees, name);
    };

    add("merged", "-b", "feature/merged"); // at main: its work is in base
    const wip = add("wip", "-b", "feature/wip"); // a commit nobody has seen
    commitFile(wip, "wip.txt", "wip");
    const pushed = add("pushed", "-b", "feature/pushed"); // pushed, branch still on the remote
    commitFile(pushed, "pushed.txt", "pushed");
    git(pushed, "push", "-q", "-u", "origin", "feature/pushed");
    const gone = add("gone", "-b", "feature/gone"); // pushed, copied to another branch, own remote branch deleted
    commitFile(gone, "gone.txt", "gone");
    git(gone, "push", "-q", "-u", "origin", "feature/gone");
    git(gone, "push", "-q", "origin", "feature/gone:refs/heads/release/keep");
    git(gone, "push", "-q", "origin", "--delete", "feature/gone");
    git(main, "fetch", "-q", "--prune");
    const dirty = add("dirty", "-b", "feature/dirty");
    writeFileSync(path.join(dirty, "scratch.txt"), "not committed\n");
    const locked = add("locked", "-b", "feature/locked");
    git(main, "worktree", "lock", locked);
    mkdirSync(path.join(root, "no-worktrees"));
    repo(root, "no-worktrees/solo"); // a repository without linked worktrees is not listed

    const parsed = parseTrees(runScript(SCRIPT, root));
    assert.equal(parsed.single, false);
    const byBranch = Object.fromEntries(parsed.trees.map((w: { branch: string }) => [w.branch, w]));
    assert.deepEqual(Object.keys(byBranch).sort(), [
        "feature/dirty",
        "feature/gone",
        "feature/locked",
        "feature/merged",
        "feature/pushed",
        "feature/wip",
        "main",
    ]);
    const ready = (branch: string) => readiness(byBranch[branch], false);
    assert.equal(ready("feature/merged"), null, "a fresh branch with no commits of its own is not ready");
    assert.equal(ready("feature/gone"), "upstream gone");
    assert.equal(ready("feature/wip"), null);
    assert.equal(byBranch["feature/wip"].unpushed, 1);
    assert.equal(ready("feature/pushed"), null);
    assert.deepEqual([byBranch["feature/pushed"].unpushed, byBranch["feature/pushed"].baseAhead], [0, 1]);
    assert.equal(ready("feature/dirty"), null);
    assert.equal(byBranch["feature/dirty"].dirty, 1);
    assert.equal(ready("feature/locked"), null);
    assert.equal(byBranch["feature/locked"].locked, true);
    assert.equal(byBranch["feature/gone"].gone, true);
    assert.equal(byBranch["feature/merged"].base, "origin/main");
    assert.equal(byBranch["feature/merged"].main, main);

    // Inside a worktree, the same repository's worktrees are read, and the result says it was a single repository.
    const inside = parseTrees(runScript(SCRIPT, wip));
    assert.equal(inside.single, true);
    assert.equal(inside.trees.length, 7);
});

// ---- History ----

test("jig-history lists repositories with their kind, branch and uncommitted state, clones before worktrees", async (t) => {
    const { SCRIPT, parseRepos, relName } = await load<Lib>("mods/jig-history/lib.js");
    const root = scratch(t);
    const orders = repo(root, "orders-api");
    git(orders, "worktree", "add", "-q", "-b", "feature/PROJ-123", path.join(root, "worktrees/PROJ-123"));
    writeFileSync(path.join(orders, "change.txt"), "x\n");
    repo(root, "billing-web");
    mkdirSync(path.join(root, "node_modules/lib/.git"), { recursive: true });

    const { single, repos } = parseRepos(runScript(SCRIPT, root));
    assert.equal(single, false);
    assert.deepEqual(
        repos.map((r: { path: string; linked: boolean; branch: string; dirty: boolean }) => [
            relName(r.path, root),
            r.linked,
            r.branch,
            r.dirty,
        ]),
        [
            ["billing-web", false, "main", false],
            ["orders-api", false, "main", true],
            ["worktrees/PROJ-123", true, "feature/PROJ-123", false],
        ],
    );
    assert.equal(parseRepos(runScript(SCRIPT, orders)).single, true);
});

test("jig-history picks the deepest repository that holds a path", async () => {
    const { repoOf } = await load<Lib>("mods/jig-history/lib.js");
    const repos = [{ path: "/w/a" }, { path: "/w/a/nested" }, { path: "/w/ab" }];
    assert.equal(repoOf(repos, "/w/a/nested/src/x.ts").path, "/w/a/nested");
    assert.equal(repoOf(repos, "/w/a/src").path, "/w/a");
    assert.equal(repoOf(repos, "/w/abc/x"), null, "a name that merely starts the same is not a parent");
    assert.equal(repoOf(repos, "/w/ab").path, "/w/ab");
    assert.equal(repoOf(repos, null), null);
});

test("jig-history reads git log's decorations, so a branch called a/b is not mistaken for a remote", async (t) => {
    const { FORMAT, parseLog } = await load<Lib>("mods/jig-history/lib.js");
    const root = scratch(t);
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const dir = repo(root, "orders-api");
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "-u", "origin", "main");
    git(dir, "tag", "v1.0.0");
    git(dir, "checkout", "-qb", "origin/lookalike");
    commitFile(dir, "b.txt", "fix(api)!: handle: colons\u001fand a separator (#12)");

    const commits = parseLog(
        git(
            dir,
            "log",
            "--date-order",
            "--decorate=full",
            `--format=${FORMAT}`,
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
        ),
    );
    assert.equal(commits.length, 2);
    const [tip, first] = commits;
    assert.deepEqual(tip.refs, [{ name: "origin/lookalike", kind: "local" }]);
    assert.equal(tip.head, true);
    assert.equal(
        tip.subject,
        "fix(api)!: handle: colons\u001fand a separator (#12)",
        "a subject keeps a separator in it",
    );
    assert.deepEqual(tip.parents, [first.hash]);
    assert.equal(first.head, false);
    assert.deepEqual(
        [...first.refs].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
        [
            { name: "main", kind: "local" },
            { name: "origin/main", kind: "remote" },
            { name: "v1.0.0", kind: "tag" },
        ],
    );
    assert.equal(first.author, "Jig Tests");
    assert.deepEqual(parseLog(""), []);
});

test("jig-history lays out a branch and its merge on lanes", async () => {
    const { layoutGraph } = await load<Lib>("mods/jig-history/lib.js");
    const commit = (hash: string, ...parents: string[]) => ({ hash, parents });
    // Newest first:  M merges B (first parent) and C; both are children of A.
    const rows = layoutGraph([commit("M", "B", "C"), commit("C", "A"), commit("B", "A"), commit("A")]);
    assert.deepEqual(rows[0], {
        lane: 0,
        color: 0,
        top: [],
        ins: [],
        bottom: [{ lane: 0, color: 0 }],
        outs: [{ lane: 1, color: 1 }],
        width: 2,
    });
    assert.deepEqual(rows[1], {
        lane: 1,
        color: 1,
        top: [
            { lane: 0, color: 0 },
            { lane: 1, color: 1 },
        ],
        ins: [],
        bottom: [
            { lane: 0, color: 0 },
            { lane: 1, color: 1 },
        ],
        outs: [],
        width: 2,
    });
    assert.deepEqual([rows[2]?.lane, rows[2]?.color], [0, 0]);
    // A is the parent of both lanes: the side lane ends in it from the side.
    assert.deepEqual(rows[3], {
        lane: 0,
        color: 0,
        top: [{ lane: 0, color: 0 }],
        ins: [{ lane: 1, color: 1 }],
        bottom: [],
        outs: [],
        width: 2,
    });

    // A straight history stays on one lane with one colour.
    const straight = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")]);
    assert.deepEqual(
        straight.map((r: { lane: number; color: number; width: number }) => [r.lane, r.color, r.width]),
        [
            [0, 0, 1],
            [0, 0, 1],
            [0, 0, 1],
        ],
    );
    // A commit that nothing waits for starts a new lane, in a free place.
    const two = layoutGraph([commit("x", "p"), commit("y", "q"), commit("p"), commit("q")]);
    assert.deepEqual([two[0]?.lane, two[1]?.lane, two[2]?.lane, two[3]?.lane], [0, 1, 0, 1]);
    assert.deepEqual(layoutGraph([]), []);
});

test("jig-history reads a subject's type, scope, breaking mark and pull request number", async () => {
    const { readSubject } = await load<Lib>("mods/jig-history/lib.js");
    assert.deepEqual(readSubject("feat(api)!: add retries"), {
        type: "feat",
        scope: "api",
        breaking: true,
        text: "add retries",
        pr: undefined,
    });
    assert.deepEqual(readSubject("fix: stop the loop (#42)"), {
        type: "fix",
        scope: null,
        breaking: false,
        text: "stop the loop (#42)",
        pr: 42,
    });
    assert.deepEqual(readSubject("Merge pull request #12 from acme/feature/PROJ-1"), {
        pr: 12,
        text: "feature/PROJ-1",
    });
    assert.deepEqual(readSubject("Update the readme"), { text: "Update the readme", pr: undefined });
    assert.equal(readSubject("Fix: capital letter is not a type").type, undefined);
});

test("jig-history gives an author the same initials and colour every time", async () => {
    const { initialsOf, colourSeed } = await load<Lib>("mods/jig-history/lib.js");
    assert.equal(initialsOf("Ada Lovelace"), "AL");
    assert.equal(initialsOf("ada.lovelace.byron"), "AB");
    assert.equal(initialsOf("  grace  "), "G");
    assert.equal(initialsOf(""), "?");
    assert.equal(initialsOf(undefined), "?");
    assert.equal(colourSeed("Ada Lovelace"), colourSeed("Ada Lovelace"));
    assert.notEqual(colourSeed("Ada Lovelace"), colourSeed("Grace Hopper"));
    assert.equal(Number.isInteger(colourSeed("x")) && colourSeed("x") >= 0, true);
});

test("jig-history reads a commit's message and its files, binary ones with no counts", async (t) => {
    const { parseCommitDetail } = await load<Lib>("mods/jig-history/lib.js");
    const detail = parseCommitDetail(
        "feat: add x\n\nBody line one.\nBody line two.\n\u001e\n3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t2\tdir/with\ttab.md\n",
    );
    assert.equal(detail.body, "Body line one.\nBody line two.");
    assert.deepEqual(detail.files, [
        { path: "src/a.ts", oldPath: null, binary: false, add: 3, del: 1 },
        { path: "logo.png", oldPath: null, binary: true, add: null, del: null },
        { path: "dir/with\ttab.md", oldPath: null, binary: false, add: 0, del: 2 },
    ]);
    assert.deepEqual(parseCommitDetail("only a subject\n\u001e"), { body: "", files: [] });

    // And on a real commit.
    const root = scratch(t);
    const dir = repo(root, "orders-api");
    commitFile(dir, "src.txt", "feat: add src\n\nWhy it matters.");
    const real = parseCommitDetail(git(dir, "show", "--numstat", "--format=%B%x1e", "HEAD"));
    assert.equal(real.body, "Why it matters.");
    assert.deepEqual(real.files, [{ path: "src.txt", oldPath: null, binary: false, add: 1, del: 0 }]);
});

test("jig-history filters commits by message, author, hash or branch name", async () => {
    const { commitMatches } = await load<Lib>("mods/jig-history/lib.js");
    const commit = {
        subject: "fix: retry on timeout",
        author: "Ada Lovelace",
        hash: "abc123def",
        refs: [{ name: "release/1.2", kind: "local" }],
    };
    for (const query of ["", "  ", "RETRY", "lovelace", "c123", "release/1"])
        assert.equal(commitMatches(commit, query), true, query);
    assert.equal(commitMatches(commit, "billing"), false);
});

test("jig-history finds repos and worktrees by folder name or branch, for a filter that matched no commit", async () => {
    const { matchRepos } = await load<Lib>("mods/jig-history/lib.js");
    const repos = [
        { path: "/w/orders-api", linked: false, branch: "main", dirty: false },
        { path: "/w/tickets/PROJ-123/orders-api", linked: true, branch: "feature/PROJ-123", dirty: true },
        { path: "/w/billing", linked: false, branch: "feature/PROJ-9", dirty: false },
    ];
    assert.deepEqual(
        matchRepos(repos, "/w", " proj-123 ").map((r: Lib) => r.path),
        ["/w/tickets/PROJ-123/orders-api"],
    );
    assert.deepEqual(
        matchRepos(repos, "/w", "billing").map((r: Lib) => r.path),
        ["/w/billing"],
    );
    assert.equal(matchRepos(repos, "/w", "").length, 3);
    assert.equal(matchRepos(repos, "/w", "nothing").length, 0);
});

test("PR & CI folds every No PR repository into one group", async () => {
    const { workspaceSplit } = await load<Lib>("mods/jig-prs/lib.js");
    const split = workspaceSplit([
        { status: "pr", name: "a" },
        { status: "nopr", name: "b" },
        { status: "nopr", name: "c" },
        { status: "default", name: "d" },
        { status: "noremote", name: "e" },
        { status: "error", name: "f" },
    ]);
    assert.deepEqual(
        split.featured.map((r: any) => r.name),
        ["a", "f"],
    );
    assert.deepEqual(
        split.noPr.map((r: any) => r.name),
        ["b", "c"],
    );
    assert.deepEqual(
        split.parked.map((r: any) => r.name),
        ["d", "e"],
    );
    const source = readFileSync(new URL("../mods/jig-prs/main.js", import.meta.url), "utf8");
    assert.match(source, /group\("No PR", "nopr-group"/);
    assert.match(source, /showNoPr/);
});

test("jig-prs keeps the author and merge conflicts from gh json", async () => {
    const { shapePr } = await load<{ shapePr: (raw: unknown, slug: string) => Record<string, unknown> }>(
        "mods/jig-prs/lib.js",
    );
    const pr = shapePr(
        { number: 1, title: "x", url: "u", author: { login: "demo" }, mergeable: "CONFLICTING" },
        "demo/repo",
    );
    assert.equal(pr.author, "demo");
    assert.equal(pr.mergeable, "CONFLICTING");
});

test("jig-prs reads the public Jig fixture in one list shape, failing checks first", async () => {
    const { shapePr } = await load<{ shapePr: (raw: unknown, slug: string) => Record<string, any> }>(
        "mods/jig-prs/lib.js",
    );
    const fixture = JSON.parse(readFileSync("test/fixtures/jig-prs.json", "utf8")) as unknown[];
    const pr = shapePr(fixture[0] as unknown, "ClawdBuilder/jig");
    assert.equal(typeof pr.n, "number");
    assert.ok(pr.author);
    assert.ok(["", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(pr.review));
    assert.ok(["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(pr.mergeable));
    const buckets = (pr.checks ?? []).map((c: { bucket: string }) => c.bucket);
    const first = buckets.findIndex((b: string) => b === "fail");
    if (first >= 0) assert.equal(first, 0, "a failing check is first");
});

test("jig-prs shapes the branch's latest CI runs", async () => {
    const { shapeRuns } = await load<{ shapeRuns: (raw: unknown) => Array<Record<string, any>> }>(
        "mods/jig-prs/lib.js",
    );
    const runs = shapeRuns(JSON.parse(readFileSync("test/fixtures/jig-runs.json", "utf8")));
    assert.ok(runs.length > 0);
    for (const run of runs) {
        assert.ok(run.name);
        assert.ok("status" in run);
        assert.ok("conclusion" in run);
        assert.ok("url" in run);
    }
});

test("jig-prs turns gh errors into one actionable line", async () => {
    const { ghError } = await load<{ ghError: (text: string) => Record<string, unknown> }>("mods/jig-prs/lib.js");
    assert.match(String(ghError("gh: not logged in").message), /not logged in/);
    assert.equal(ghError("gh: not logged in").auth, true);
    assert.match(String(ghError("dial tcp: connection refused").message), /Network error/);
    assert.match(String(ghError("something odd").message), /something odd/);
});

test("jig-prs orders a failing check first and shapes a no-PR branch's runs", async () => {
    const { checksOf, branchRuns } = await load<{
        checksOf: (rollup: unknown[]) => Array<{ bucket: string }>;
        branchRuns: (reply: unknown) => Array<Record<string, unknown>> | null;
    }>("mods/jig-prs/lib.js");
    const checks = checksOf([
        { name: "ok", conclusion: "SUCCESS" },
        { name: "bad", conclusion: "FAILURE", detailsUrl: "https://example.test/1" },
        { name: "wait", status: "IN_PROGRESS" },
    ]);
    assert.deepEqual(
        checks.map((c) => c.bucket),
        ["fail", "pending", "pass"],
    );
    const runs = branchRuns({ data: JSON.parse(readFileSync("test/fixtures/jig-runs.json", "utf8")) });
    assert.ok((runs ?? []).length > 0);
    assert.equal(branchRuns({ err: "no" }), null);
});

test("jig-history reads parents, renames, binaries, branches and caps lanes for a 300 px row", async (t) => {
    const { parseCommitDetail, parseLog, parseBranches, laneColumns } = await load<Lib>("mods/jig-history/lib.js");
    const root = scratch(t);
    const dir = repo(root, "orders-api");
    commitFile(dir, "old-name.txt", "one");
    git(dir, "mv", "old-name.txt", "new-name.txt");
    git(dir, "commit", "-qm", "refactor: rename");
    writeFileSync(path.join(dir, "logo.bin"), Buffer.from([0, 1, 2]));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "chore: binary");
    git(dir, "checkout", "-qb", "side");
    commitFile(dir, "side.txt", "side");
    git(dir, "checkout", "-q", "main");
    commitFile(dir, "main.txt", "main");
    git(dir, "merge", "-q", "--no-ff", "side", "-m", "merge: side");

    const log = parseLog(git(dir, "log", "--decorate=full", "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s"));
    assert.equal(log[0].parents.length, 2, "the merge has two parents");
    const renameCommit = git(dir, "log", "--format=%H", "--grep=refactor: rename", "-1").trim();
    const renamed = parseCommitDetail(git(dir, "show", "--numstat", "--find-renames", "--format=%B%x1e", renameCommit));
    assert.equal(renamed.files[0].oldPath, "old-name.txt");
    assert.equal(renamed.files[0].path, "new-name.txt");
    const binaryCommit = git(dir, "log", "--format=%H", "--grep=chore: binary", "-1").trim();
    const binary = parseCommitDetail(git(dir, "show", "--numstat", "--format=%B%x1e", binaryCommit));
    assert.equal(binary.files[0].binary, true);
    const branches = parseBranches("main\trefs/heads/main\norigin/main\trefs/remotes/origin/main\n");
    assert.deepEqual(
        branches.map((b: { remote: boolean }) => b.remote),
        [false, true],
    );
    assert.equal(laneColumns(10), 4, "capped so the subject keeps 60%");
    assert.equal(laneColumns(2), 2);
});

test("jig-history filters branches, local first, with the current one marked", async () => {
    const { filterBranches } = await load<Lib>("mods/jig-history/lib.js");
    const list = [
        { name: "origin/main", remote: true },
        { name: "main", remote: false },
        { name: "feature/a", remote: false },
    ];
    assert.deepEqual(
        filterBranches(list, "a", "main").map((b: { name: string; current: boolean }) => [b.name, b.current]),
        [
            ["feature/a", false],
            ["main", true],
            ["origin/main", false],
        ],
    );
    assert.equal(filterBranches(list, "", "main")[0].name, "main");
});

test("jig-worktrees lists prune candidates and row actions without the main checkout", async () => {
    const { pruneCandidates, rowActions } = await load<Lib>("mods/jig-worktrees/lib.js");
    const rows = [
        { path: "/w/main", main: "/w/main", ready: true },
        { path: "/w/a", main: "/w/main", ready: true },
        { path: "/w/b", main: "/w/main", ready: false },
    ];
    assert.deepEqual(
        pruneCandidates(rows).map((r: { path: string }) => r.path),
        ["/w/a"],
    );
    assert.deepEqual(rowActions({ open: false, ready: true, path: "/w/a", main: "/w/a" }), ["Open"]);
    assert.deepEqual(rowActions({ open: true, ready: true, path: "/w/a", main: "/w/main" }), ["Remove"]);
});

test("jig-prs counts checks in words and singular", async () => {
    const { checkCount, checkSummary } = await load<Lib>("mods/jig-prs/lib.js");
    assert.equal(checkCount(1), "1 check");
    assert.equal(checkCount(3), "3 checks");
    const checks = [
        { bucket: "fail" },
        { bucket: "fail" },
        { bucket: "pending" },
        { bucket: "pass" },
        { bucket: "pass" },
    ];
    assert.equal(checkSummary(checks), "2 failing, 1 pending, 2 passed");
    assert.equal(checkSummary([]), "");
});

test("jig-prs loads a no-PR branch's runs with --repo and keeps gh's error", async () => {
    const { loadRuns } = await load<Lib>("mods/jig-prs/lib.js");
    let seen: string[] = [];
    const ok = await loadRuns(
        async (args: string[]) => {
            seen = args;
            return { data: JSON.parse(readFileSync("test/fixtures/jig-runs.json", "utf8")) };
        },
        "ClawdBuilder/jig",
        "main",
        null,
    );
    assert.deepEqual(seen.slice(0, 5), ["run", "list", "--repo", "ClawdBuilder/jig", "--branch"]);
    assert.ok((ok.runs ?? []).length > 0);
    assert.equal(ok.error, null);
    const bad = await loadRuns(async () => ({ err: "gh is not logged in on this machine" }), "o/r", "main", null);
    assert.equal(bad.runs, null);
    assert.match(String(bad.error), /not logged in/);
});

test("jig-history's branch header handler toggles the list", async () => {
    const { toggleBranchPicker } = await load<Lib>("mods/jig-history/lib.js");
    assert.equal(toggleBranchPicker(false), true);
    assert.equal(toggleBranchPicker(true), false);
});

test("jig-worktrees refuses ignored data files but allows build output", async () => {
    const { dangerousIgnored } = await load<Lib>("mods/jig-worktrees/lib.js");
    assert.deepEqual(dangerousIgnored("!! .env\n!! local/config.json\n!! node_modules/x\n!! dist/y\n"), [
        ".env",
        "local/config.json",
    ]);
});

test("jig-prs opens only GitHub links", async () => {
    const { githubUrl } = await load<Lib>("mods/jig-prs/lib.js");
    assert.equal(githubUrl("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1");
    assert.equal(githubUrl("https://example.com/x"), null);
    assert.equal(githubUrl("javascript:alert(1)"), null);
});

test("the follow-state copies agree and pickRoot follows the focused terminal first", async () => {
    const root = new URL("../mods/", import.meta.url);
    const source = readFileSync(new URL("jig-git/follow-state.js", root), "utf8");
    for (const mod of ["jig-history", "jig-prs", "jig-worktrees"])
        assert.equal(
            readFileSync(new URL(`${mod}/follow-state.js`, root), "utf8"),
            source,
            `${mod}/follow-state.js is the odd one out`,
        );
    const { pickRoot } = await load<Lib>("mods/jig-git/follow-state.js");
    assert.equal(pickRoot({ follow: true, focusedCwd: "/f", spaceFolder: "/s", first: "/1" }), "/f");
    assert.equal(pickRoot({ follow: false, focusedCwd: "/f", spaceFolder: "/s", first: "/1" }), "/s");
    assert.equal(pickRoot({ follow: true, focusedCwd: null, spaceFolder: null, first: "/1" }), "/1");
    assert.equal(pickRoot({ follow: true }), null);
});

test("jig-worktrees parses -z worktree lists with spaces and tabs, and refuses a changed row", async () => {
    const { parseWorktreeListZ, removalRefusal } = await load<Lib>("mods/jig-worktrees/lib.js");
    const z =
        "worktree /w/main\0HEAD abc\0branch refs/heads/main\0\0worktree /w/a b\tc\0HEAD def\0branch refs/heads/f\0\0";
    const entries = parseWorktreeListZ(z);
    assert.deepEqual(
        entries.map((e: { path: string }) => e.path),
        ["/w/main", "/w/a b\tc"],
    );
    const row = { path: "/w/a b\tc", main: "/w/main", branch: "f", head: "def" };
    assert.equal(removalRefusal(row, entries), null);
    assert.match(String(removalRefusal({ ...row, branch: "g" }, entries)), /branch changed/);
    assert.match(String(removalRefusal({ ...row, main: row.path }, entries)), /main checkout/);
    entries[1].locked = true;
    assert.match(String(removalRefusal(row, entries)), /locked/);
});

test("prune plan removes two in order, refuses a stale banner and cancel runs nothing", async () => {
    const { prunePlan, cancelPrune } = await load<Lib>("mods/jig-worktrees/lib.js");
    const entries = [
        { tree: { path: "/w/a" }, on: "wsl", contextKey: "ctx" },
        { tree: { path: "/w/b" }, on: "wsl", contextKey: "ctx" },
    ];
    assert.deepEqual(
        prunePlan(entries, "ctx", "wsl").list.map((e: { tree: { path: string } }) => e.tree.path),
        ["/w/a", "/w/b"],
    );
    assert.match(String(prunePlan(entries, "other", "wsl").refused), /changed/);
    let calls = 0;
    const exec = () => calls++;
    cancelPrune();
    assert.equal(calls, 0);
});

test("follow reload writes the choice then reloads", async () => {
    const { followReload } = await load<Lib>("mods/jig-worktrees/lib.js");
    let written = null,
        reloaded = 0;
    followReload(
        true,
        "s",
        (id, value) => (written = [id, value]),
        () => reloaded++,
    );
    assert.deepEqual(written, ["s", false]);
    assert.equal(reloaded, 1);
});

test("the watchdog times out a never-resolving task and not a finished one", async () => {
    const { watchdog } = await load<Lib>("mods/jig-worktrees/lib.js");
    let callback = null,
        timedOut = 0;
    const cancel = watchdog(
        (fn) => (callback = fn),
        () => timedOut++,
    );
    callback();
    assert.equal(timedOut, 1, "never resolved");
    const cancel2 = watchdog(
        (fn) => (callback = fn),
        () => timedOut++,
    );
    cancel2();
    callback();
    assert.equal(timedOut, 1, "finished first");
});

test("realpath comparison sees a terminal inside a symlinked folder", async (t) => {
    const { sameOrInside } = await load<Lib>("mods/jig-worktrees/lib.js");
    const root = scratch(t);
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    mkdirSync(path.join(real, "sub"), { recursive: true });
    symlinkSync(real, link);
    assert.equal(
        sameOrInside(real, link, (p: string) => realpathSync(p)),
        true,
    );
    assert.equal(
        sameOrInside(real, path.join(link, "sub"), (p: string) => realpathSync(p)),
        true,
    );
});

test("the live panel files call the tested seams, not inline copies", () => {
    const read = (name: string) => readFileSync(new URL(`../mods/${name}/main.js`, import.meta.url), "utf8");
    for (const name of ["jig-history", "jig-prs", "jig-worktrees"]) assert.match(read(name), /writeFollow\(/, name);
    const wt = read("jig-worktrees");
    for (const seam of [
        "pruneAll(",
        "liveReady(",
        "cancelPrune(",
        "sameOrInside(",
        "removalRefusal(",
        "parseWorktreeListZ(",
    ])
        assert.ok(wt.includes(seam), seam);
    assert.doesNotMatch(wt, /list\.some\(\s*\(entry\)\s*=>\s*entry\.contextKey/);
    assert.match(read("jig-prs"), /runCommand\(/);
});

test("the changed read and destructive commands keep their exact argv", () => {
    const repo = readFileSync(new URL("../mods/jig-git/main.js", import.meta.url), "utf8");
    assert.match(repo, /runCommand\(exec, "sh", \["-c", SCRIPT, "sh", root, targets\]/);
    const pr = readFileSync(new URL("../mods/jig-prs/main.js", import.meta.url), "utf8");
    assert.match(pr, /runCommand\(exec, "sh", \["-c", SCRIPT, "sh", root\]/);
    const wt = readFileSync(new URL("../mods/jig-worktrees/main.js", import.meta.url), "utf8");
    assert.match(wt, /"worktree", "remove"/);
    assert.match(wt, /"branch", "-d", tree\.branch/);
    const hist = readFileSync(new URL("../mods/jig-history/main.js", import.meta.url), "utf8");
    assert.match(hist, /runCommand\(exec, "git", logArgs/);
    assert.match(hist, /runCommand\(exec, "git", statusArgs/);
});

test("History keeps its last good rows when a log read fails", () => {
    const source = readFileSync(new URL("../mods/jig-history/main.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /log\.code !== 0[\s\S]{0,120}this\.commits = null/);
    assert.match(source, /this\.error = friendlyError\(log/);
});

test("a fresh branch from base and one from origin/develop are not ready; a merged one is", async () => {
    const { readiness, terminalInside } = await load<Lib>("mods/jig-worktrees/lib.js");
    const base = {
        path: "/w/f",
        main: "/w/main",
        locked: false,
        dirty: 0,
        baseAhead: 0,
        base: "origin/main",
        gone: false,
        unpushed: 0,
        upstream: "origin/main",
        head: "aaaa",
        created: "a".repeat(40),
    };
    assert.equal(readiness(base, false), null, "created at its tip");
    const develop = { ...base, upstream: "origin/develop" };
    assert.equal(readiness(develop, false), null, "upstream is not evidence of work");
    assert.equal(readiness({ ...base, head: "bbbb", unpushed: 1 }, false), "in base", "has its own commit");
    assert.equal(
        terminalInside("/w/real", ["/w/link/sub"], (p) => p.replace("link", "real")),
        true,
    );
});

test("ignored allowlist is root-anchored and never allows .env", async () => {
    const { dangerousIgnored } = await load<Lib>("mods/jig-worktrees/lib.js");
    assert.deepEqual(dangerousIgnored("!! build/.env\n!! packages/a/dist/x\n!! node_modules/x\n!! build/y\n"), [
        "build/.env",
        "packages/a/dist/x",
    ]);
});

test("terminals inside a worktree use realpath through a fake exec", async () => {
    const { terminalsInsideWorktree } = await load<Lib>("mods/jig-worktrees/lib.js");
    const exec = async (_cmd: string, args: string[]) => {
        const path = args[3];
        return { code: 0, stdout: path.replace("/link", "/real") };
    };
    assert.equal(await terminalsInsideWorktree(exec as never, "/real/wt", ["/link/wt/sub"]), true);
    assert.equal(await terminalsInsideWorktree(exec as never, "/real/wt", ["/link/other"]), false);
});

test("a late load generation is stale", async () => {
    const { currentGeneration } = await load<Lib>("mods/jig-worktrees/lib.js");
    assert.equal(currentGeneration(1, 2), false);
    assert.equal(currentGeneration(2, 2), true);
});

test("the real prune chain removes two entries in order and both kinds of ready row pass liveReady", async () => {
    const { pruneAll, liveReady } = await load<Lib>("mods/jig-worktrees/lib.js");
    const entries = [
        { tree: { path: "/w/a", branch: "a" }, on: "wsl", contextKey: "ctx" },
        { tree: { path: "/w/b", branch: "b" }, on: "wsl", contextKey: "ctx" },
    ];
    const order: string[] = [];
    const result = await pruneAll(entries, "ctx", "wsl", async (tree: { path: string }) => {
        order.push(tree.path);
    });
    assert.deepEqual(order, ["/w/a", "/w/b"]);
    assert.equal(result.removed, 2);
    const base = {
        path: "/w/a",
        main: "/w/main",
        branch: "a",
        head: "newhash",
        created: "a".repeat(40),
        locked: false,
        dirty: 0,
        unpushed: 1,
        baseAhead: 0,
        upstream: "",
        base: "origin/main",
        gone: false,
    };
    assert.equal(liveReady(base, {}), "in base");
    assert.equal(liveReady({ ...base, baseAhead: 3, unpushed: 0, gone: true }, {}), "upstream gone");
});

test("an unresolved pane cwd fails closed", async () => {
    const { terminalsInsideWorktree } = await load<Lib>("mods/jig-worktrees/lib.js");
    const exec = async (_cmd: string, args: string[]) => ({ code: args[3] === "/real/wt" ? 0 : 1, stdout: args[3] });
    assert.equal(await terminalsInsideWorktree(exec as never, "/real/wt", ["/missing"]), true);
});

test("pruneAll stops when the live context changes after item one", async () => {
    const { pruneAll } = await load<Lib>("mods/jig-worktrees/lib.js");
    const entries = [
        { tree: { path: "/w/a" }, on: "wsl", contextKey: "ctx1" },
        { tree: { path: "/w/b" }, on: "wsl", contextKey: "ctx1" },
    ];
    let key = "ctx1";
    const removed: string[] = [];
    const result = await pruneAll(
        entries,
        () => key,
        () => "wsl",
        async (tree: { path: string }) => {
            removed.push(tree.path);
            key = "ctx2";
            return null;
        },
    );
    assert.deepEqual(removed, ["/w/a"]);
    assert.match(String(result.refused), /changed/);
});

test("pruneAll reports a removal already running", async () => {
    const { pruneAll } = await load<Lib>("mods/jig-worktrees/lib.js");
    const result = await pruneAll(
        [{ tree: { path: "/w/a" }, on: "wsl", contextKey: "ctx" }],
        "ctx",
        "wsl",
        async () => "A removal was already running; the rest were not removed.",
    );
    assert.equal(result.removed, 0);
    assert.match(String(result.refused), /already running/);
});

test("the real worktree scan keeps a path, branch, date, creation and a subject with a space", async (t) => {
    const { SCRIPT, parseTrees } = await load<Lib>("mods/jig-worktrees/lib.js");
    const root = scratch(t);
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const seed = repo(root, "seed");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    git(root, "clone", "-q", origin, "orders-api");
    const main = path.join(root, "orders-api");
    const wt = path.join(root, "orders-extra");
    git(main, "worktree", "add", "-q", "-b", "feature/extra", wt);
    writeFileSync(path.join(wt, "extra.txt"), "x");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "fix: a subject with a space");
    const tree = parseTrees(runScript(SCRIPT, root)).trees.find((row: { path: string }) => row.path === wt) as Record<
        string,
        any
    >;
    assert.ok(tree, "the extra worktree is listed");
    assert.equal(tree.branch, "feature/extra");
    assert.equal(tree.subject, "fix: a subject with a space");
    assert.equal(tree.path, wt);
    assert.match(String(tree.date), /^\d{4}-\d\d-\d\dT/);
    assert.ok(tree.created, "the creation commit is read");
});
