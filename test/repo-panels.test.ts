// The pure parts of the PR & CI, Worktrees and History panels (their lib.js files), and their shell scripts run on real
// git repositories made in temporary folders.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "./support.ts";

// The libs are plain JavaScript; each test says which of their functions it uses.
type Lib = Record<string, any>;

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
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
    execFileSync("sh", ["-c", script, "sh", root], { encoding: "utf8" });

// ---- the three panels share how they see the layout ----

test("each panel knows whether its block is on screen: hidden nodes and other stack children hide it", async () => {
    const stackChildren = [
        { id: "pr", content: { mod: "repo-prs" } },
        { id: "wt", content: { mod: "repo-worktrees" } },
        { id: "hist", content: { mod: "repo-history" } },
    ];
    const layout = { id: "root", children: [{ id: "stack", type: "stack", active: "pr", children: stackChildren }] };
    const hidden = { id: "root", children: [{ id: "stack", type: "stack", hidden: true, children: stackChildren }] };
    const first = { id: "root", children: [{ id: "stack", type: "stack", children: stackChildren }] };
    for (const [file, name] of [
        ["mods/repo-prs/lib.js", "isOnScreen"],
        ["mods/repo-worktrees/lib.js", "isOnScreen"],
        ["mods/repo-history/lib.js", "isOnScreen"],
        ["mods/repo-changes/layout.js", "shown"],
    ] as const) {
        const onScreen = (await load<Lib>(file))[name] as (root: unknown, mod: string) => boolean;
        assert.equal(onScreen(layout, "repo-prs"), true, `${file}: the active child`);
        assert.equal(onScreen(layout, "repo-worktrees"), false, `${file}: another child of the stack`);
        assert.equal(onScreen(first, "repo-prs"), true, `${file}: a stack with no active child shows its first`);
        assert.equal(onScreen(first, "repo-history"), false, file);
        assert.equal(onScreen(hidden, "repo-prs"), false, `${file}: a hidden stack hides what is in it`);
        assert.equal(onScreen(layout, "in-a-tab"), true, `${file}: a mod with no block lives in a tab of its own`);
        assert.equal(onScreen(null, "repo-prs"), true, `${file}: no layout`);
    }
});

test("every panel words an age the same way", async () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    for (const file of ["mods/repo-prs/lib.js", "mods/repo-worktrees/lib.js", "mods/repo-history/lib.js"]) {
        const { since } = await load<Lib>(file);
        assert.equal(since("2026-01-10T11:59:40Z", now), "now");
        assert.equal(since("2026-01-10T11:55:00Z", now), "5m");
        assert.equal(since("2026-01-10T09:00:00Z", now), "3h");
        assert.equal(since("2026-01-08T12:00:00Z", now), "2d");
        assert.equal(since("not a date", now), "now", "an unreadable date is not an error");
    }
});

// ---- PR & CI ----

test("repo-prs reads the owner and name from every form of remote url", async () => {
    const { slugOf } = await load<Lib>("mods/repo-prs/lib.js");
    assert.equal(slugOf("https://github.com/acme/orders-api.git"), "acme/orders-api");
    assert.equal(slugOf("https://github.com/acme/orders-api"), "acme/orders-api");
    assert.equal(slugOf("git@github.com:acme/orders-api.git"), "acme/orders-api");
    assert.equal(slugOf("git@github.com-work:acme/orders-api.git"), "acme/orders-api");
    assert.equal(slugOf("ssh://git@github.com/acme/orders-api/"), "acme/orders-api");
    assert.equal(slugOf(""), null);
    assert.equal(slugOf(undefined), null);
});

test("repo-prs sorts checks into fail, pending, pass and skip, and a cancelled run is skipped, not failed", async () => {
    const { checksOf, countOf, bucketOf } = await load<Lib>("mods/repo-prs/lib.js");
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

test("repo-prs keeps the small shape of a pull request, with checks unknown until the rollup is", async () => {
    const { shapePr } = await load<Lib>("mods/repo-prs/lib.js");
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

test("repo-prs words gh's failures: sign-in and network problems are flagged", async () => {
    const { ghError } = await load<Lib>("mods/repo-prs/lib.js");
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

test("repo-prs runs at most the asked number of calls at once, and all of them", async () => {
    const { inParallel } = await load<Lib>("mods/repo-prs/lib.js");
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

test("repo-prs keeps the newest twelve cache entries", async () => {
    const { remember } = await load<Lib>("mods/repo-prs/lib.js");
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

test("repo-prs finds repositories, their branch, remote and default branch, on real repositories", async (t) => {
    const { SCRIPT, parseRepos, relName } = await load<Lib>("mods/repo-prs/lib.js");
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

test("repo-worktrees is ready only when nothing would be lost: unpushed commits are never ready", async () => {
    const { readiness } = await load<Lib>("mods/repo-worktrees/lib.js");
    const clean = { locked: false, dirty: 0, unpushed: 0, base: "origin/main", baseAhead: 0, gone: false };
    assert.equal(readiness(clean, false), "in base");
    assert.equal(readiness({ ...clean, baseAhead: 3, gone: true }, false), "upstream gone");
    assert.equal(
        readiness({ ...clean, baseAhead: 3 }, false),
        null,
        "work not in base and the remote branch still there",
    );
    assert.equal(readiness({ ...clean, unpushed: 1 }, false), null, "a commit on no remote");
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

test("repo-worktrees reads the script's lines, keeping what git could not tell as null", async () => {
    const { parseTrees, nameOf, relName } = await load<Lib>("mods/repo-worktrees/lib.js");
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

test("repo-worktrees tells ready from in-progress worktrees on real repositories", async (t) => {
    const { SCRIPT, parseTrees, readiness } = await load<Lib>("mods/repo-worktrees/lib.js");
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
    ]);
    const ready = (branch: string) => readiness(byBranch[branch], false);
    assert.equal(ready("feature/merged"), "in base");
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
    assert.equal(inside.trees.length, 6);
});

// ---- History ----

test("repo-history lists repositories with their kind, branch and uncommitted state, clones before worktrees", async (t) => {
    const { SCRIPT, parseRepos, relName } = await load<Lib>("mods/repo-history/lib.js");
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

test("repo-history picks the deepest repository that holds a path", async () => {
    const { repoOf } = await load<Lib>("mods/repo-history/lib.js");
    const repos = [{ path: "/w/a" }, { path: "/w/a/nested" }, { path: "/w/ab" }];
    assert.equal(repoOf(repos, "/w/a/nested/src/x.ts").path, "/w/a/nested");
    assert.equal(repoOf(repos, "/w/a/src").path, "/w/a");
    assert.equal(repoOf(repos, "/w/abc/x"), null, "a name that merely starts the same is not a parent");
    assert.equal(repoOf(repos, "/w/ab").path, "/w/ab");
    assert.equal(repoOf(repos, null), null);
});

test("repo-history reads git log's decorations, so a branch called a/b is not mistaken for a remote", async (t) => {
    const { FORMAT, parseLog } = await load<Lib>("mods/repo-history/lib.js");
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
    assert.equal(first.author, "Test");
    assert.deepEqual(parseLog(""), []);
});

test("repo-history lays out a branch and its merge on lanes", async () => {
    const { layoutGraph } = await load<Lib>("mods/repo-history/lib.js");
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

test("repo-history reads a subject's type, scope, breaking mark and pull request number", async () => {
    const { readSubject } = await load<Lib>("mods/repo-history/lib.js");
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

test("repo-history gives an author the same initials and colour every time", async () => {
    const { initialsOf, colourSeed } = await load<Lib>("mods/repo-history/lib.js");
    assert.equal(initialsOf("Ada Lovelace"), "AL");
    assert.equal(initialsOf("ada.lovelace.byron"), "AB");
    assert.equal(initialsOf("  grace  "), "G");
    assert.equal(initialsOf(""), "?");
    assert.equal(initialsOf(undefined), "?");
    assert.equal(colourSeed("Ada Lovelace"), colourSeed("Ada Lovelace"));
    assert.notEqual(colourSeed("Ada Lovelace"), colourSeed("Grace Hopper"));
    assert.equal(Number.isInteger(colourSeed("x")) && colourSeed("x") >= 0, true);
});

test("repo-history reads a commit's message and its files, binary ones with no counts", async (t) => {
    const { parseCommitDetail } = await load<Lib>("mods/repo-history/lib.js");
    const detail = parseCommitDetail(
        "feat: add x\n\nBody line one.\nBody line two.\n\u001e\n3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t2\tdir/with\ttab.md\n",
    );
    assert.equal(detail.body, "Body line one.\nBody line two.");
    assert.deepEqual(detail.files, [
        { path: "src/a.ts", add: 3, del: 1 },
        { path: "logo.png", add: null, del: null },
        { path: "dir/with\ttab.md", add: 0, del: 2 },
    ]);
    assert.deepEqual(parseCommitDetail("only a subject\n\u001e"), { body: "", files: [] });

    // And on a real commit.
    const root = scratch(t);
    const dir = repo(root, "orders-api");
    commitFile(dir, "src.txt", "feat: add src\n\nWhy it matters.");
    const real = parseCommitDetail(git(dir, "show", "--numstat", "--format=%B%x1e", "HEAD"));
    assert.equal(real.body, "Why it matters.");
    assert.deepEqual(real.files, [{ path: "src.txt", add: 1, del: 0 }]);
});

test("repo-history filters commits by message, author, hash or branch name", async () => {
    const { commitMatches } = await load<Lib>("mods/repo-history/lib.js");
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
