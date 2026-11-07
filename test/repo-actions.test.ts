// The Changes panel's nesting of worktrees and its git actions (repo-changes/lib.js, and the file actions copied into
// repo-review/lib.js), run on real git repositories in temporary folders, with a bare repository as their origin.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HERDR, load } from "./support.ts";

// The lib is plain JavaScript; each test says which of its functions it uses.
type Lib = Record<string, any>;
type Result = { ok: boolean; message: string; hash?: string };
type ExecOptions = { cwd?: string; env?: Record<string, string>; timeout?: number };
type Exec = (
    cmd: string,
    args: string[],
    opts?: ExecOptions,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Every command the actions ran, to check that none of them ever forces anything. */
const ran: string[][] = [];
/** Every command with the options it ran with: the environment and timeout of a network command. */
const calls: { argv: string[]; options?: ExecOptions }[] = [];

/** Herdr's exec, as child_process: never rejects for a non-zero exit, gives the code and both outputs. */
const exec: Exec = (cmd, args, opts) =>
    new Promise((resolve) => {
        ran.push([cmd, ...args]);
        calls.push({ argv: [cmd, ...args], options: opts });
        execFile(cmd, args, { cwd: opts?.cwd, encoding: "utf8" }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            resolve({ code, stdout, stderr });
        });
    });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function scratch(t: { after(fn: () => void): void }): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-herdr-actions-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A bare origin with `main` (one commit) and `feature/remote-only`, and a clone of it called orders-api. */
function cloned(root: string): { origin: string; repo: string } {
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(root, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(path.join(seed, "README.md"), "# orders\n");
    writeFileSync(path.join(seed, "app.ts"), "one\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "first");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    git(seed, "push", "-q", "origin", "main:feature/remote-only");
    git(root, "clone", "-q", origin, "orders-api");
    return { origin, repo: path.join(root, "orders-api") };
}

const branchOf = (dir: string) => git(dir, "symbolic-ref", "--short", "HEAD");
/** `git status --porcelain`, keeping the leading space of a first " M" line. */
const porcelain = (dir: string) =>
    execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).replace(/\n$/, "");

test("checkouts nest under their main repository; a worktree whose main is outside the root stands alone", async (t) => {
    const { SCRIPT, parseRepos, groupRepos, isClean, checkoutsOf, filterGroups } =
        await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    git(repo, "worktree", "add", "-q", "-b", "feature/PROJ-1", path.join(root, "worktrees/PROJ-1/orders-api"));
    git(repo, "worktree", "add", "-q", "-b", "feature/PROJ-2", path.join(repo, ".trees/PROJ-2")); // inside the main
    writeFileSync(path.join(repo, ".git/info/exclude"), ".trees/\n");
    writeFileSync(path.join(root, "worktrees/PROJ-1/orders-api/new.ts"), "x\n");
    const billing = path.join(root, "billing");
    mkdirSync(billing);
    git(billing, "init", "-q", "-b", "main");
    git(billing, "commit", "-q", "--allow-empty", "-m", "first");
    // A worktree under the root whose main checkout is outside it.
    const outside = scratch(t);
    git(outside, "init", "-q", "-b", "main", "docs-site");
    git(path.join(outside, "docs-site"), "commit", "-q", "--allow-empty", "-m", "first");
    git(path.join(outside, "docs-site"), "worktree", "add", "-q", "-b", "fix/typo", path.join(root, "docs-typo"));

    const repos = parseRepos(execFileSync("sh", ["-c", SCRIPT, "sh", root], { encoding: "utf8" }), root);
    const groups = groupRepos(repos);
    const shape = groups.map((g: any) => [g.main.name, g.main.linked, g.worktrees.map((w: any) => w.name)]);
    assert.deepEqual(
        shape.sort((a: any, b: any) => a[0].localeCompare(b[0])),
        [
            ["billing", false, []],
            ["docs-typo", true, []],
            ["orders-api", false, ["orders-api/.trees/PROJ-2", "worktrees/PROJ-1/orders-api"]],
            ["seed", false, []],
        ],
    );
    const orders = groups.find((g: any) => g.main.name === "orders-api");
    assert.deepEqual(
        orders.worktrees.map((w: any) => [w.folder, w.branch, w.files.length]),
        [
            ["PROJ-2", "feature/PROJ-2", 0],
            ["orders-api", "feature/PROJ-1", 1],
        ],
    );
    assert.equal(isClean(orders), false, "a group with one changed worktree is not clean");
    assert.equal(isClean(groups.find((g: any) => g.main.name === "billing")), true);
    // Each checkout with changes counts once.
    assert.equal(repos.filter((r: any) => r.files.length).length, 1);
    assert.equal(checkoutsOf(orders).length, 3);
    // A filter that matches a worktree's file keeps the group, with the main's own files left out.
    const found = filterGroups(groups, "new.ts");
    assert.deepEqual(
        found.map((g: any) => [g.main.name, g.main.files.length, g.worktrees.map((w: any) => w.folder)]),
        [["orders-api", 0, ["orders-api"]]],
    );

    // Inside the main checkout: it and its worktrees. Inside a worktree: that worktree.
    const inMain = parseRepos(execFileSync("sh", ["-c", SCRIPT, "sh", repo], { encoding: "utf8" }), repo);
    assert.equal(inMain.length, 3);
    const inTree = parseRepos(
        execFileSync("sh", ["-c", SCRIPT, "sh", path.join(root, "docs-typo")], { encoding: "utf8" }),
        root,
    );
    assert.deepEqual(
        inTree.map((r: any) => [r.folder, r.linked]),
        [["docs-typo", true]],
    );
});

test("a file's staged state comes from porcelain's XY", async () => {
    const { parseRepos } = await load<Lib>("mods/repo-changes/lib.js");
    const [repo] = parseRepos(
        [
            "@@repo /w/a",
            "@@git /w/a/.git\t/w/a/.git\t",
            "## main",
            "M  a.ts",
            "MM b.ts",
            " M c.ts",
            "?? d.ts",
            "=4",
        ].join("\n"),
        "/w",
    );
    assert.deepEqual(
        repo.files.map((f: any) => [f.path, f.staged, f.unstaged]),
        [
            ["a.ts", true, false],
            ["b.ts", true, true],
            ["c.ts", false, true],
            ["d.ts", false, true],
        ],
    );
    assert.equal(repo.staged, 2);
    assert.equal(repo.linked, false);
});

test("a branch switch is refused while an agent works in the checkout, and only for that checkout", async () => {
    const { busyAgents } = await load<Lib>("mods/repo-changes/lib.js");
    const panes = [
        { cwd: "/w/orders-api/src", status: "working", name: "Pi" },
        { cwd: "/w/orders-api/.trees/PROJ-2", status: "blocked", name: "Claude Code" },
        { cwd: "/w/orders-api-old", status: "working", name: "Pi" },
        { cwd: "/w/billing", status: "idle", name: "Pi" },
        { cwd: null, status: "working", name: "Pi" },
    ];
    const others = ["/w/orders-api/.trees/PROJ-2", "/w/billing"];
    assert.deepEqual(
        busyAgents("/w/orders-api", panes, others).map((p: { cwd: string }) => p.cwd),
        ["/w/orders-api/src"],
        "a worktree nested in the main checkout is its own, and a folder that only starts the same is another",
    );
    assert.deepEqual(
        busyAgents("/w/orders-api/.trees/PROJ-2", panes, others).map((p: { name: string }) => p.name),
        ["Claude Code"],
    );
    assert.deepEqual(busyAgents("/w/billing", panes, others), [], "an idle agent does not block");

    const { switchBranch, newBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const before = ran.length;
    const busy = [{ cwd: "/w/orders-api/src", status: "working", name: "Pi" }];
    const refused: Result = await switchBranch(exec, { checkout: "/nonexistent", branch: "main", busy });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /Pi is working in \/w\/orders-api\/src/);
    const refusedNew: Result = await newBranch(exec, {
        checkout: "/nonexistent",
        name: "feature/x",
        base: "main",
        busy,
    });
    assert.equal(refusedNew.ok, false);
    assert.equal(ran.length, before, "no command at all is run for a busy checkout");
});

test("a dirty checkout keeps its branch: the switch is refused, naming how many files changed", async (t) => {
    const { switchBranch, newBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    git(repo, "branch", "other");
    writeFileSync(path.join(repo, "app.ts"), "two\n");
    writeFileSync(path.join(repo, "untracked.ts"), "x\n");
    const before = ran.length;
    const r: Result = await switchBranch(exec, { checkout: repo, branch: "other" });
    assert.equal(r.ok, false);
    assert.match(r.message, /^2 files with uncommitted changes/);
    assert.equal(branchOf(repo), "main");
    const n: Result = await newBranch(exec, { checkout: repo, name: "feature/x", base: "main" });
    assert.match(n.message, /^2 files with uncommitted changes/);
    const commands = ran.slice(before).map((c) => c[1]);
    assert.ok(!commands.includes("switch") && !commands.includes("fetch"), "no switch or fetch was run");
});

test("branches: local first with the current marked, a branch in another worktree not pickable, then origin's", async (t) => {
    const { listBranches, switchBranch, filterBranches } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    git(repo, "branch", "release/1.2");
    const tree = path.join(root, "trees/PROJ-7");
    git(repo, "worktree", "add", "-q", "-b", "feature/PROJ-7", tree);

    const list = await listBranches(exec, repo);
    assert.equal(list.ok, true);
    assert.deepEqual(
        list.branches.map((b: any) => [b.name, b.current, b.remote, b.inUse]),
        [
            ["main", true, false, null],
            ["feature/PROJ-7", false, false, "PROJ-7"],
            ["release/1.2", false, false, null],
            ["feature/remote-only", false, true, null],
        ],
    );
    assert.deepEqual(
        filterBranches(list.branches, "REMOTE").map((b: any) => b.name),
        ["feature/remote-only"],
    );
    // From the worktree, main is the one in use elsewhere.
    const fromTree = await listBranches(exec, tree);
    assert.equal(fromTree.branches.find((b: any) => b.name === "main").inUse, "orders-api");

    const r: Result = await switchBranch(exec, { checkout: repo, branch: "feature/PROJ-7" });
    assert.equal(r.ok, false);
    assert.match(r.message, /checked out in PROJ-7/);
    assert.equal(branchOf(repo), "main");
});

test("a switch to a local branch, and to a branch only origin has, which then tracks it", async (t) => {
    const { switchBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    git(repo, "branch", "release/1.2");

    const local: Result = await switchBranch(exec, { checkout: repo, branch: "release/1.2" });
    assert.deepEqual([local.ok, branchOf(repo)], [true, "release/1.2"]);
    const remote: Result = await switchBranch(exec, { checkout: repo, branch: "feature/remote-only" });
    assert.equal(remote.ok, true, remote.message);
    assert.equal(branchOf(repo), "feature/remote-only");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/remote-only");
    assert.equal((await switchBranch(exec, { checkout: repo, branch: "nope" })).ok, false);
    assert.match((await switchBranch(exec, { checkout: repo, branch: "feature/remote-only" })).message, /Already on/);
});

test("a new branch starts from origin's base after a fetch, and a bad name is refused before anything runs", async (t) => {
    const { newBranch, defaultBase, parseConfig } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    // origin moves on after the clone: the new branch must start from the fetched tip.
    const other = path.join(root, "other");
    git(root, "clone", "-q", origin, other);
    writeFileSync(path.join(other, "later.ts"), "later\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "later");
    git(other, "push", "-q", "origin", "main");
    const tip = git(other, "rev-parse", "HEAD");

    assert.equal(await defaultBase(exec, repo, parseConfig(null)), "main", "origin's HEAD branch");
    assert.equal(await defaultBase(exec, repo, parseConfig('{ "baseBranch": "origin/develop" }')), "develop");

    for (const name of ["feature/has space", "-x", "feature/a..b", "feature/x.lock", "@{-1}", "HEAD", ""]) {
        const before = ran.length;
        const bad: Result = await newBranch(exec, { checkout: repo, name, base: "main" });
        assert.equal(bad.ok, false, name);
        assert.ok(!ran.slice(before).some((c) => c[1] === "fetch" || c[1] === "switch"), `${name}: no fetch or switch`);
    }
    assert.match((await newBranch(exec, { checkout: repo, name: "main", base: "main" })).message, /exists already/);
    assert.match(
        (await newBranch(exec, { checkout: repo, name: "feature/y", base: "nope" })).message,
        /fetch|no branch/,
    );

    const made: Result = await newBranch(exec, { checkout: repo, name: "feature/PROJ-9", base: "main" });
    assert.equal(made.ok, true, made.message);
    assert.equal(branchOf(repo), "feature/PROJ-9");
    assert.equal(git(repo, "rev-parse", "HEAD"), tip, "it starts at origin's tip, fetched just before");
    assert.throws(() => git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "no upstream until its first push");
});

test("stage, unstage and discard a tracked and an untracked file, in both panels' copies", async (t) => {
    for (const file of ["mods/repo-changes/lib.js", "mods/repo-review/lib.js"]) {
        const { stageFile, unstageFile, discardFile, discardKind } = await load<Lib>(file);
        const root = scratch(t);
        const { repo } = cloned(root);
        writeFileSync(path.join(repo, "app.ts"), "two\n");
        writeFileSync(path.join(repo, "new.ts"), "new\n");
        writeFileSync(path.join(repo, "*.ts"), "a star in the name\n");

        assert.equal((await stageFile(exec, { checkout: repo, file: "app.ts" })).ok, true);
        assert.equal((await stageFile(exec, { checkout: repo, file: "new.ts" })).ok, true);
        assert.deepEqual(porcelain(repo).split("\n").sort(), ["?? *.ts", "A  new.ts", "M  app.ts"].sort(), file);
        assert.equal((await unstageFile(exec, { checkout: repo, file: "app.ts" })).ok, true);
        assert.equal((await unstageFile(exec, { checkout: repo, file: "new.ts" })).ok, true);
        assert.deepEqual(porcelain(repo).split("\n").sort(), ["?? *.ts", "?? new.ts", " M app.ts"].sort(), file);

        // A file whose name is a pattern only ever means that file.
        assert.equal((await stageFile(exec, { checkout: repo, file: "*.ts" })).ok, true);
        assert.deepEqual(porcelain(repo).split("\n").sort(), ["?? new.ts", "A  *.ts", " M app.ts"].sort(), file);
        assert.equal((await unstageFile(exec, { checkout: repo, file: "*.ts" })).ok, true);

        assert.equal(discardKind(" M"), "restore");
        assert.equal(discardKind("??"), "delete");
        assert.equal(discardKind("A "), "delete");
        // The confirm said "restore", but the file is untracked: refused.
        assert.match(
            (await discardFile(exec, { checkout: repo, file: "new.ts", expect: "restore" })).message,
            /changed since/,
        );
        assert.equal(existsSync(path.join(repo, "new.ts")), true);

        const tracked: Result = await discardFile(exec, { checkout: repo, file: "app.ts", expect: "restore" });
        assert.equal(tracked.ok, true, tracked.message);
        assert.equal(readFileSync(path.join(repo, "app.ts"), "utf8"), "one\n");
        const untracked: Result = await discardFile(exec, { checkout: repo, file: "*.ts", expect: "delete" });
        assert.equal(untracked.ok, true, untracked.message);
        assert.equal(existsSync(path.join(repo, "*.ts")), false);
        assert.equal(existsSync(path.join(repo, "new.ts")), true, "only the named file is deleted");
        assert.match((await discardFile(exec, { checkout: repo, file: "app.ts" })).message, /no changes/);

        // A folder is never discarded.
        mkdirSync(path.join(repo, "scratch"));
        writeFileSync(path.join(repo, "scratch/a.txt"), "a\n");
        assert.equal((await discardFile(exec, { checkout: repo, file: "scratch/", expect: "delete" })).ok, false);
        assert.equal((await discardFile(exec, { checkout: repo, file: "scratch", expect: "delete" })).ok, false);
        assert.deepEqual(readdirSync(path.join(repo, "scratch")), ["a.txt"]);
    }
});

test("stage all and unstage all, also before the first commit", async (t) => {
    const { stageAll, unstageAll, unstageFile } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    writeFileSync(path.join(repo, "app.ts"), "two\n");
    writeFileSync(path.join(repo, "new.ts"), "new\n");
    assert.equal((await stageAll(exec, { checkout: repo })).ok, true);
    assert.deepEqual(porcelain(repo).split("\n").sort(), ["A  new.ts", "M  app.ts"].sort());
    assert.equal((await unstageAll(exec, { checkout: repo })).ok, true);
    assert.deepEqual(porcelain(repo).split("\n").sort(), ["?? new.ts", " M app.ts"].sort());

    const fresh = path.join(root, "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "main");
    writeFileSync(path.join(fresh, "a.ts"), "a\n");
    writeFileSync(path.join(fresh, "b.ts"), "b\n");
    await stageAll(exec, { checkout: fresh });
    assert.equal((await unstageFile(exec, { checkout: fresh, file: "a.ts" })).ok, true, "git rm --cached with no HEAD");
    assert.deepEqual(porcelain(fresh).split("\n").sort(), ["?? a.ts", "A  b.ts"].sort());
    assert.equal((await unstageAll(exec, { checkout: fresh })).ok, true);
    assert.deepEqual(porcelain(fresh).split("\n").sort(), ["?? a.ts", "?? b.ts"].sort());
    assert.equal(existsSync(path.join(fresh, "a.ts")) && existsSync(path.join(fresh, "b.ts")), true);
});

test("a commit takes the staged files only and says its hash; an empty message or nothing staged is refused", async (t) => {
    const { commit, stageFile } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    writeFileSync(path.join(repo, "app.ts"), "two\n");
    writeFileSync(path.join(repo, "README.md"), "# changed, not staged\n");

    const before = ran.length;
    assert.match((await commit(exec, { checkout: repo, message: "  " })).message, /message/);
    assert.equal(ran.length, before, "an empty message runs nothing");
    assert.match((await commit(exec, { checkout: repo, message: "fix: x" })).message, /Nothing is staged/);

    await stageFile(exec, { checkout: repo, file: "app.ts" });
    const done: Result = await commit(exec, { checkout: repo, message: "fix: change the app" });
    assert.equal(done.ok, true, done.message);
    assert.equal(done.hash, git(repo, "rev-parse", "--short", "HEAD"));
    assert.equal(git(repo, "log", "-1", "--format=%s"), "fix: change the app");
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n"), ["app.ts"]);
    assert.equal(porcelain(repo), " M README.md");
});

// ---- Sync: fetch, pull, push, publish ----

/** A commit of `file` in `dir`; returns its full hash. */
const writeCommit = (dir: string, file: string, message = `add ${file}`) => {
    writeFileSync(path.join(dir, file), "content\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", message);
    return git(dir, "rev-parse", "HEAD");
};

test("a fetch moves the remote-tracking branches, a pull fast-forwards, a push sends the commits and a publish sets the upstream", async (t) => {
    const { fetchRemote, pullFastForward, pushBranch, publishBranch, commitsToPush } =
        await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    const other = path.join(root, "other");
    git(root, "clone", "-q", origin, other);
    const later = writeCommit(other, "later.ts");
    git(other, "push", "-q", "origin", "main");
    assert.notEqual(git(repo, "rev-parse", "origin/main"), later);

    const fetched: Result = await fetchRemote(exec, { checkout: repo });
    assert.equal(fetched.ok, true, fetched.message);
    assert.equal(git(repo, "rev-parse", "origin/main"), later, "the fetch moved origin/main");
    assert.match(fetched.message, /^Fetched origin:/);

    const pulled: Result = await pullFastForward(exec, { checkout: repo });
    assert.equal(pulled.ok, true, pulled.message);
    assert.equal(git(repo, "rev-parse", "HEAD"), later, "a fast-forward pull took origin's commit");
    assert.match(pulled.message, /^Pulled origin\/main: now at /);
    assert.match((await pullFastForward(exec, { checkout: repo })).message, /Already up to date/);

    const mine = writeCommit(repo, "mine.ts");
    const counts = await commitsToPush(exec, { checkout: repo });
    assert.deepEqual([counts.branch, counts.base, counts.count, counts.more], ["main", "origin/main", 1, 0]);
    assert.deepEqual(counts.commits, [{ hash: git(repo, "rev-parse", "--short", "HEAD"), subject: "add mine.ts" }]);
    const pushed: Result = await pushBranch(exec, { checkout: repo });
    assert.equal(pushed.ok, true, pushed.message);
    assert.equal(git(origin, "rev-parse", "main"), mine);
    assert.match(pushed.message, /^Pushed 1 commit to origin\/main/);
    assert.match((await pushBranch(exec, { checkout: repo })).message, /Nothing to push/);

    git(repo, "switch", "-q", "-c", "feature/PROJ-9");
    writeCommit(repo, "ticket.ts");
    const toPublish = await commitsToPush(exec, { checkout: repo });
    assert.deepEqual([toPublish.base, toPublish.count], ["origin/HEAD", 1], "a publish lists the branch's own work");
    const published: Result = await publishBranch(exec, { checkout: repo });
    assert.equal(published.ok, true, published.message);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/PROJ-9");
    assert.equal(git(origin, "rev-parse", "feature/PROJ-9"), git(repo, "rev-parse", "HEAD"));
    assert.match((await publishBranch(exec, { checkout: repo })).message, /already pushes to origin\/feature\/PROJ-9/);
    assert.match((await pushBranch(exec, { checkout: repo })).message, /Nothing to push/);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "feature/PROJ-9");
});

test("a publish goes to the push remote, so a fork branch never lands in the shared origin", async (t) => {
    const { pushTarget, publishBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    const fork = path.join(root, "fork.git");
    git(root, "init", "-q", "--bare", "-b", "main", fork);
    git(repo, "remote", "add", "fork", fork);

    // A ticket branch cut from origin/main, with the fork as its push remote: publish to the fork, not origin.
    git(repo, "switch", "-q", "-c", "feature/PROJ-88", "origin/main");
    git(repo, "config", "branch.feature/PROJ-88.pushRemote", "fork");
    writeCommit(repo, "ticket.ts");
    const first = await pushTarget(exec, { checkout: repo });
    assert.deepEqual([first.mode, first.remote, first.target], ["publish", "fork", "fork/feature/PROJ-88"]);
    assert.match(first.reason, /origin\/main/, "it says why publishing is the safe way");
    const published: Result = await publishBranch(exec, { checkout: repo });
    assert.equal(published.ok, true, published.message);
    assert.equal(git(fork, "rev-parse", "feature/PROJ-88"), git(repo, "rev-parse", "HEAD"));
    assert.throws(() => git(origin, "rev-parse", "feature/PROJ-88"), "origin never saw the branch");

    // remote.pushDefault does the same for a branch with no upstream at all.
    git(repo, "switch", "-q", "-c", "feature/no-upstream");
    git(repo, "config", "remote.pushDefault", "fork");
    writeCommit(repo, "second.ts");
    const second = await pushTarget(exec, { checkout: repo });
    assert.deepEqual([second.mode, second.remote, second.target], ["publish", "fork", "fork/feature/no-upstream"]);
    const again: Result = await publishBranch(exec, { checkout: repo });
    assert.equal(again.ok, true, again.message);
    assert.equal(git(fork, "rev-parse", "feature/no-upstream"), git(repo, "rev-parse", "HEAD"));
    assert.throws(() => git(origin, "rev-parse", "feature/no-upstream"));
});

test("a push git calls up to date says so, instead of Pushed to X", async () => {
    const { pushBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const fake = async (_cmd: string, args: string[]) => {
        if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "config") {
            const key = args[2] ?? "";
            if (key === "branch.main.remote") return { code: 0, stdout: "origin\n", stderr: "" };
            if (key === "branch.main.merge") return { code: 0, stdout: "refs/heads/main\n", stderr: "" };
            return { code: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") return { code: 0, stdout: "@{upstream}\n", stderr: "" };
        if (args[0] === "rev-list") return { code: 1, stdout: "", stderr: "" }; // not comparable
        if (args[0] === "remote") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "push") return { code: 0, stdout: "", stderr: "Everything up-to-date\n" };
        return { code: 1, stdout: "", stderr: "" };
    };
    const r: Result = await pushBranch(fake, { checkout: "/w/a" });
    assert.equal(r.ok, true);
    assert.equal(r.message, "Already up to date with origin/main.");
});

test("a pull that cannot fast-forward is refused with git's message and merges nothing", async (t) => {
    const { pullFastForward } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    writeCommit(repo, "app.ts", "local work");
    const other = path.join(root, "other");
    git(root, "clone", "-q", origin, other);
    writeCommit(other, "later.ts");
    git(other, "push", "-q", "origin", "main");
    const here = git(repo, "rev-parse", "HEAD");
    const pulled: Result = await pullFastForward(exec, { checkout: repo });
    assert.equal(pulled.ok, false);
    assert.match(pulled.message, /fast-forward|merge/i);
    assert.match(pulled.message, /terminal/, "it points at a terminal for the merge");
    assert.equal(git(repo, "rev-parse", "HEAD"), here, "nothing was merged");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
    assert.equal(git(repo, "rev-list", "--count", "HEAD..origin/main"), "1", "the pull did not take their commit");
});

test("a detached HEAD and an agent at work refuse pull, push and publish before any command runs", async (t) => {
    const { fetchRemote, pullFastForward, pushBranch, publishBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    git(repo, "checkout", "-q", "--detach", "HEAD");
    for (const [name, action] of [
        ["pull", () => pullFastForward(exec, { checkout: repo })],
        ["push", () => pushBranch(exec, { checkout: repo })],
        ["publish", () => publishBranch(exec, { checkout: repo })],
    ] as const) {
        const r: Result = await action();
        assert.equal(r.ok, false, name);
        assert.match(r.message, /detached/, name);
    }
    const fetched: Result = await fetchRemote(exec, { checkout: repo });
    assert.equal(fetched.ok, true, "a fetch on a detached HEAD is fine: it touches no branch");

    git(repo, "switch", "-q", "main");
    const before = ran.length;
    const busy = [{ cwd: `${repo}/src`, status: "working", name: "Pi" }];
    for (const [name, action] of [
        ["pull", () => pullFastForward(exec, { checkout: repo, busy })],
        ["push", () => pushBranch(exec, { checkout: repo, busy })],
        ["publish", () => publishBranch(exec, { checkout: repo, busy })],
    ] as const) {
        const r: Result = await action();
        assert.equal(r.ok, false, name);
        assert.match(r.message, /Pi is working/, name);
    }
    assert.equal(ran.length, before, "no command at all is run while an agent works there");
});

test("a network command runs with no prompt, the person's own ssh command and a timeout", async (t) => {
    const { fetchRemote, networkEnv, shQuote, wrapperScript } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    calls.length = 0;
    await fetchRemote(exec, { checkout: repo, env: { GIT_SSH_COMMAND: "ssh -i /tmp/work-key" } });
    const custom = calls.find((c) => c.argv.includes("fetch"));
    assert.equal(custom?.options?.env?.GIT_TERMINAL_PROMPT, "0", "git can never ask for a password");
    assert.equal(custom?.options?.env?.GIT_SSH_COMMAND, "ssh -i /tmp/work-key", "the person's ssh command wins");
    assert.equal(custom?.options?.timeout, 60000);

    await fetchRemote(exec, { checkout: repo, timeout: 30000 });
    const plain = calls[calls.length - 1]!;
    assert.equal(
        plain.options?.env?.GIT_SSH_COMMAND,
        undefined,
        "without one given, the machine's own ssh command is kept, not replaced",
    );
    assert.equal(plain.options?.timeout, 30000, "config.json's timeout reaches the command");

    assert.deepEqual(networkEnv({ GIT_TERMINAL_PROMPT: "1" }), { GIT_TERMINAL_PROMPT: "1" });
    assert.equal(shQuote("it's"), `'it'\\''s'`);
    const script = wrapperScript({ GIT_TERMINAL_PROMPT: "0", "no key": "x" }, 30000);
    assert.match(script, /^export GIT_TERMINAL_PROMPT='0'$/m, "a value is quoted");
    assert.doesNotMatch(script, /no key/, "a name that is not a variable is skipped");
    assert.match(script, /GIT_SSH_COMMAND\+set/, "an ssh command already set stays");
    assert.match(script, /core\.sshCommand/, "a repository's own ssh command is respected");
    assert.match(script, /if command -v timeout/, "timeout when the machine has it");
    assert.ok(script.includes('sleep 30; [ -e "$done" ] && exit; : > "$flag"'), "a watchdog when it has not");
    assert.ok(script.includes('pkill -TERM -P "$pid"'), "the watchdog stops the command's children too");
    assert.ok(
        script.indexOf('pkill -TERM -P "$watchdog"') >= 0 &&
            script.indexOf('pkill -TERM -P "$watchdog"') < script.indexOf('kill -TERM "$watchdog"'),
        "and its own sleep, before the subshell that owns it goes",
    );
    assert.ok(script.includes('"$@" & pid=$!'), "the command runs in the background, for the watchdog");
});

test("the scan tells a checkout's upstream, remote and last commit, and a gone upstream", async (t) => {
    const { SCRIPT, parseRepos } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    writeCommit(repo, "app.ts", "fix(app): keep the last commit");
    const [read] = parseRepos(execFileSync("sh", ["-c", SCRIPT, "sh", repo], { encoding: "utf8" }), repo);
    assert.deepEqual([read.upstream, read.detached, read.remote], ["origin/main", false, "origin"]);
    assert.deepEqual(
        [read.head.hash, read.head.subject],
        [git(repo, "rev-parse", "--short", "HEAD"), "fix(app): keep the last commit"],
    );
    assert.ok(read.head.at > Date.now() - 120000 && read.head.at <= Date.now(), "the commit's own time");

    git(repo, "checkout", "-q", "--detach", "HEAD");
    const [detached] = parseRepos(execFileSync("sh", ["-c", SCRIPT, "sh", repo], { encoding: "utf8" }), repo);
    assert.deepEqual([detached.branch, detached.detached, detached.upstream], ["(detached)", true, null]);

    const [gone] = parseRepos(
        ["@@repo /w/a", "@@git /w/a/.git\t/w/a/.git", "@@remote origin", "## main...origin/main [gone]", "=0"].join(
            "\n",
        ),
        "/w",
    );
    assert.deepEqual([gone.upstream, gone.gone, gone.remote], ["origin/main", true, "origin"]);
});

test("the push confirm lists at most ten commits, newest first, and says how many more there are", async (t) => {
    const { commitsToPush } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { repo } = cloned(root);
    for (let i = 0; i < 12; i++) writeCommit(repo, `file-${i}.ts`, `change ${i}`);
    const r = await commitsToPush(exec, { checkout: repo, limit: 10 });
    assert.deepEqual([r.ok, r.count, r.commits.length, r.more, r.base], [true, 12, 10, 2, "origin/main"]);
    assert.deepEqual(r.commits[0], { hash: git(repo, "rev-parse", "--short", "HEAD"), subject: "change 11" });
    assert.equal(r.commits[9].subject, "change 2");
});

test("the panel follows the focused terminal, then the space folder, then the space's first terminal", async () => {
    const { pickRoot, panesOn } = await load<Lib>("mods/repo-changes/lib.js");
    const cases: [{ [key: string]: unknown }, string | null][] = [
        [{ follow: true, focusedCwd: "/w/orders-api", spaceFolder: "/w", first: "/w/first" }, "/w/orders-api"],
        [{ follow: true, focusedCwd: null, spaceFolder: "/w", first: "/w/first" }, "/w"],
        [{ follow: true, focusedCwd: null, spaceFolder: "", first: "/w/first" }, "/w/first"],
        [{ follow: true, focusedCwd: null, spaceFolder: "", first: null }, null],
        [{ follow: false, focusedCwd: "/w/orders-api", spaceFolder: "/w", first: "/w/first" }, "/w"],
        [{ follow: false, focusedCwd: "/w/orders-api", spaceFolder: "", first: "/w/first" }, "/w/first"],
        [{ follow: false, focusedCwd: "/w/orders-api" }, "/w/orders-api"],
    ];
    for (const [where, root] of cases) assert.equal(pickRoot(where), root, JSON.stringify(where));

    const panes = [
        { terminal: "t1", tab: "tab1", cwd: "/w/a", status: "working", program: { name: "Pi" }, title: "pi" },
        { terminal: null, tab: "tab1", cwd: null, title: "Changes" },
        { terminal: "t2", tab: "tab2", cwd: "/w/b", status: "idle", title: "zsh" },
    ];
    const spaces = [
        { id: "s1", machine: null, tabs: [{ id: "tab1" }] },
        { id: "s2", machine: "wsl", tabs: [{ id: "tab2" }] },
    ];
    assert.deepEqual(
        panesOn(panes, spaces, null).map((p: Lib) => [p.cwd, p.status, p.name]),
        [["/w/a", "working", "Pi"]],
        "a mod pane has no terminal, and another machine's terminal is not here",
    );
    assert.deepEqual(
        panesOn(panes, spaces, "wsl").map((p: Lib) => p.cwd),
        ["/w/b"],
    );
});

test("an age reads as words, like the other panels", async () => {
    const { ago } = await load<Lib>("mods/repo-changes/lib.js");
    const now = Date.parse("2026-01-10T12:00:00Z");
    assert.equal(ago(now - 10_000, now), "just now");
    assert.equal(ago(now - 5 * 60_000, now), "5m ago");
    assert.equal(ago(now - 3 * 3600_000, now), "3h ago");
    assert.equal(ago(now - 2 * 86400_000, now), "2d ago");
    assert.equal(ago(now - 3 * 7 * 86400_000, now), "3w ago");
    assert.equal(ago(now - 5 * 30 * 86400_000, now), "5mo ago");
    assert.equal(ago(now - 2 * 365 * 86400_000, now), "2y ago");
    assert.equal(ago(NaN, now), "", "a commit with no readable time says nothing");
});

// ---- Round 2: the real push target, one lock per checkout, and shells without `timeout` ----

test("a push goes exactly where git's own settings send it (pushRemote), never to another branch", async (t) => {
    const { pushTarget, pushBranch, commitsToPush } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    const fork = path.join(root, "fork.git");
    git(root, "init", "-q", "--bare", "-b", "main", fork);
    git(repo, "remote", "add", "fork", fork);
    git(repo, "config", "branch.main.pushRemote", "fork");

    const target = await pushTarget(exec, { checkout: repo });
    assert.deepEqual([target.mode, target.remote, target.target], ["push", "fork", "fork/main"]);
    const toSend = await commitsToPush(exec, { checkout: repo });
    assert.deepEqual([toSend.target, toSend.mode], ["fork/main", "push"]);

    const mine = writeCommit(repo, "mine.ts");
    const pushed: Result = await pushBranch(exec, { checkout: repo });
    assert.equal(pushed.ok, true, pushed.message);
    assert.equal(git(fork, "rev-parse", "main"), mine, "it went to the fork, as pushRemote says");
    assert.notEqual(git(origin, "rev-parse", "main"), mine, "and not to origin");
    const argv = calls.filter((c) => c.argv[1] === "push").at(-1)?.argv ?? [];
    assert.deepEqual(argv.slice(1), ["push", "fork", "HEAD:refs/heads/main"], "the destination is named in full");

    // push.default=matching would send branches the dialog did not list: never push it.
    git(repo, "config", "push.default", "matching");
    const matching = await pushTarget(exec, { checkout: repo });
    assert.deepEqual([matching.mode, matching.target], ["publish", "fork/main"], "the push remote still decides");
    assert.match(matching.reason, /matching/);
    const before = ran.length;
    const refused: Result = await pushBranch(exec, { checkout: repo });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /matching/);
    assert.deepEqual(
        ran.slice(before).filter((c) => c[1] === "push"),
        [],
        "no push command at all",
    );
});

test("a branch whose push target is another branch is published as itself, and that branch is left alone", async (t) => {
    const { pushTarget, pushBranch, publishBranch, commitsToPush } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    const main = git(origin, "rev-parse", "main");
    git(repo, "switch", "-q", "-c", "feature/x", "origin/main"); // tracks origin/main
    writeCommit(repo, "ticket.ts");

    const target = await pushTarget(exec, { checkout: repo });
    assert.deepEqual([target.mode, target.target], ["publish", "origin/feature/x"]);
    assert.match(target.reason, /origin\/main/);
    const toPublish = await commitsToPush(exec, { checkout: repo });
    assert.deepEqual([toPublish.mode, toPublish.target, toPublish.count], ["publish", "origin/feature/x", 1]);

    const refused: Result = await pushBranch(exec, { checkout: repo });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /origin\/main/);
    assert.equal(git(origin, "rev-parse", "main"), main, "main was not touched");

    const published: Result = await publishBranch(exec, { checkout: repo });
    assert.equal(published.ok, true, published.message);
    assert.equal(git(origin, "rev-parse", "feature/x"), git(repo, "rev-parse", "HEAD"));
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/x");
    assert.equal(git(origin, "rev-parse", "main"), main);
});

test("a branch or a push target that changed after the dialog opened is refused, and nothing is sent", async (t) => {
    const { pushBranch, publishBranch } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    writeCommit(repo, "mine.ts");
    const main = git(origin, "rev-parse", "main");
    const expect = { branch: "main", remote: "origin", target: "origin/main", mode: "push" };

    git(repo, "switch", "-q", "-c", "other");
    const changed: Result = await pushBranch(exec, { checkout: repo, expect });
    assert.equal(changed.ok, false);
    assert.match(changed.message, /branch changed since this confirm opened/);

    git(repo, "switch", "-q", "main");
    const fork = path.join(root, "fork.git");
    git(root, "init", "-q", "--bare", "-b", "main", fork);
    git(repo, "remote", "add", "fork", fork);
    git(repo, "config", "branch.main.pushRemote", "fork");
    const moved: Result = await pushBranch(exec, { checkout: repo, expect });
    assert.equal(moved.ok, false);
    assert.match(moved.message, /push target changed since this confirm opened/);
    const published: Result = await publishBranch(exec, { checkout: repo, expect });
    assert.equal(published.ok, false, "a publish also re-checks what the dialog showed");
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.throws(() => git(fork, "rev-parse", "main"), "nothing reached the fork either");
});

test("the sh wrapper keeps the person's ssh command and adds BatchMode only when there is none", async (t) => {
    const { wrapperScript } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    const script = wrapperScript({}, 5000);
    const read = (env: NodeJS.ProcessEnv = {}) =>
        execFileSync("/bin/sh", ["-c", script, "sh", "/bin/sh", "-c", `printf %s "\${GIT_SSH_COMMAND-}"`], {
            cwd: repo,
            env: { ...process.env, ...env },
            encoding: "utf8",
        });

    assert.equal(read(), "ssh -o BatchMode=yes", "no ssh setup anywhere: no prompt, and no host key question");
    git(repo, "config", "core.sshCommand", "ssh -i /tmp/person-key");
    assert.equal(read(), "", "the repository's own core.sshCommand is not replaced");
    git(repo, "config", "--unset", "core.sshCommand");
    assert.equal(read({ GIT_SSH_COMMAND: "ssh -i /tmp/env-key" }), "ssh -i /tmp/env-key", "GIT_SSH_COMMAND wins");
    assert.equal(read({ GIT_SSH_COMMAND: "" }), "", "a GIT_SSH_COMMAND set to empty is still the person's choice");
    assert.equal(
        read({ GIT_SSH: "/usr/bin/ssh" }),
        "",
        "GIT_SSH would be overridden by a GIT_SSH_COMMAND, so it is left alone",
    );
});

test("without `timeout`, the wrapper still stops a slow command and exits 124", async (t) => {
    const { wrapperScript } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const name of ["sleep", "date", "pkill", "rm", "git"]) {
        const pathOf = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
        symlinkSync(pathOf, path.join(bin, name));
    }
    // A real git for the wrapper's core.sshCommand check: this repository sets one, so BatchMode is not added.
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "core.sshCommand", "ssh -i /tmp/repo-key");
    const script = wrapperScript({}, 1000);
    const relaxed = wrapperScript({}, 5000); // git can take a moment on a busy machine
    const viaGit = execFileSync("/bin/sh", ["-c", relaxed, "sh", "git", "config", "--get", "core.sshCommand"], {
        cwd: repo,
        env: { PATH: bin, HOME: process.env.HOME ?? "/tmp", TMPDIR: root },
        encoding: "utf8",
    });
    assert.equal(
        viaGit.trim(),
        "ssh -i /tmp/repo-key",
        "the watchdog run reaches git, so the guard saw a real repository",
    );
    const started = Date.now();
    const slow = spawnSync("/bin/sh", ["-c", script, "sh", "/bin/sh", "-c", "sleep 5"], {
        cwd: repo,
        env: { PATH: bin, HOME: process.env.HOME ?? "/tmp", TMPDIR: root },
        encoding: "utf8",
    });
    assert.equal(slow.status, 124, "a watchdog, not a hang");
    assert.ok(Date.now() - started < 4000, "stopped at about the timeout");
    assert.deepEqual(
        readdirSync(root).filter((f) => f.startsWith("repo-changes-timeout-")),
        [],
        "no flag left",
    );
    const fast = spawnSync("/bin/sh", ["-c", script, "sh", "/bin/sh", "-c", "sleep 5"], {
        cwd: repo,
        env: process.env,
        encoding: "utf8",
    });
    assert.equal(fast.status, 124, "and `timeout`, where the machine has it");
});

test("a timed-out command says so, never `git exited with 124`", async () => {
    const { fetchRemote, pullFastForward, timeoutMessage, NETWORK_TIMEOUT } =
        await load<Lib>("mods/repo-changes/lib.js");
    const fake = (code: number) => async (_cmd: string, args: string[]) =>
        args.includes("get-url") ? { code: 0, stdout: "", stderr: "" } : { code, stdout: "", stderr: "" };
    const fetched: Result = await fetchRemote(fake(124), { checkout: "/w/a" });
    assert.equal(fetched.ok, false);
    assert.equal(fetched.message, timeoutMessage(NETWORK_TIMEOUT));
    assert.equal(
        timeoutMessage(NETWORK_TIMEOUT),
        "Timed out after 60 s — check your network or sign-in, then try in a terminal.",
    );
    assert.equal(
        timeoutMessage(30000),
        "Timed out after 30 s — check your network or sign-in, then try in a terminal.",
    );
    // A pull that timed out: the same answer instead of git's exit code.
    const upstreamFake = async (_cmd: string, args: string[]) => {
        if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "origin/main\n", stderr: "" };
        return { code: 124, stdout: "", stderr: "" };
    };
    const pulled: Result = await pullFastForward(upstreamFake, { checkout: "/w/a" });
    assert.equal(pulled.ok, false);
    assert.equal(pulled.message, timeoutMessage(NETWORK_TIMEOUT));
});

test("one lock per checkout: the panel and its dialog share it, and it expires", async () => {
    const lib = await load<Lib>("mods/repo-changes/lib.js");
    const {
        runningKey,
        liveLocks,
        lockOf,
        withLock,
        withoutLock,
        holdsLock,
        canRun,
        needsPublish,
        commitRowStacked,
        RUNNING_TTL,
    } = lib;
    assert.equal(runningKey("wsl", "/w/a"), "wsl|/w/a");
    assert.equal(runningKey(null, "/w/a"), "|/w/a");
    const now = 1_000_000;
    const one = withLock({}, "wsl", "/w/a", "Pushing", now, "tok-a");
    assert.deepEqual(lockOf(one, "wsl", "/w/a", now + 1), { what: "Pushing", at: now, token: "tok-a" });
    assert.equal(lockOf(one, "wsl", "/w/b", now + 1), null, "another checkout is not locked");
    assert.equal(lockOf(one, null, "/w/a", now + 1), null, "nor the same path on another machine");
    const two = withLock(one, "wsl", "/w/b", "Pulling", now + 2, "tok-b");
    assert.deepEqual(Object.keys(two).sort(), ["wsl|/w/a", "wsl|/w/b"]);
    assert.deepEqual(withoutLock(two, "wsl", "/w/a", now + 3), two, "no token releases nothing");
    assert.deepEqual(withoutLock(two, "wsl", "/w/a", now + 3, "tok-a"), {
        "wsl|/w/b": { what: "Pulling", at: now + 2, token: "tok-b" },
    });
    // A claim's token: only its owner releases it.
    const claimed = withLock({}, "wsl", "/w/a", "Pushing", now, "mine");
    assert.equal(lockOf(claimed, "wsl", "/w/a", now + 1).token, "mine");
    assert.equal(holdsLock(claimed, "wsl", "/w/a", "mine", now + 1), true);
    assert.equal(holdsLock(claimed, "wsl", "/w/a", "theirs", now + 1), false);
    assert.deepEqual(
        withoutLock(claimed, "wsl", "/w/a", now + 1, "theirs"),
        claimed,
        "another claim cannot release it",
    );
    assert.deepEqual(withoutLock(claimed, "wsl", "/w/a", now + 1, "mine"), {});
    assert.deepEqual(liveLocks(two, now + RUNNING_TTL + 10), {}, "a stuck lock does not last for ever");

    assert.equal(canRun(false, null), true);
    assert.equal(canRun(true, null), false, "a stale row cannot act, open a review or the branch picker either");
    assert.equal(canRun(true, null), false, "rows from the previous folder cannot be acted on");
    assert.equal(canRun(false, { what: "Pushing", at: now }), false);

    assert.equal(needsPublish({ upstream: null, branch: "main" }), true);
    assert.equal(needsPublish({ upstream: "origin/main", gone: true, branch: "feature/x" }), true);
    assert.equal(needsPublish({ upstream: "origin/main", gone: false, branch: "feature/x" }), true, "another name");
    assert.equal(needsPublish({ upstream: "origin/feature/x", gone: false, branch: "feature/x" }), false);

    // The row's buttons: no Sync at all (only diverged branches would offer it, where --ff-only always fails).
    assert.equal("syncBranch" in lib, false, "Sync is gone from the lib too");
    const { rowActions, divergedText } = lib;
    assert.deepEqual(rowActions({ ahead: 0, behind: 0 }), []);
    assert.deepEqual(rowActions({ ahead: 0, behind: 1 }), ["pull"]);
    assert.deepEqual(rowActions({ ahead: 1, behind: 0 }), ["push"]);
    assert.deepEqual(rowActions({ ahead: 1, behind: 1 }), ["pull", "push"], "diverged: pull and push stay separate");
    assert.deepEqual(rowActions({ hover: true, ahead: 1, behind: 1 }), ["pull", "push", "fetch"]);
    assert.deepEqual(rowActions({ publish: true }), ["publish"]);
    assert.equal(rowActions({ ahead: 1, behind: 1 }).includes("sync"), false);
    assert.equal(divergedText({ ahead: 0, behind: 1 }), null);
    assert.equal(divergedText({ ahead: 1, behind: 0 }), null);
    assert.match(divergedText({ ahead: 2, behind: 1 }), /diverged — ↑2 ↓1: rebase or merge in a terminal/);

    assert.equal(commitRowStacked(300), true);
    assert.equal(commitRowStacked(359), true);
    assert.equal(commitRowStacked(420), false);
    assert.equal(commitRowStacked(0), false, "before the first layout, keep one row");
});

test("the actions never force, delete a branch, reset, amend or skip hooks; a push is only ever plain", async () => {
    const forbidden = [
        "--force",
        "--force-with-lease",
        "-D",
        "reset",
        "--discard-changes",
        "--amend",
        "--no-verify",
        "-d",
        "-x",
    ];
    for (const command of ran) {
        if (command[0] !== "git") continue;
        for (const bad of forbidden) assert.ok(!command.includes(bad), `${command.join(" ")} uses ${bad}`);
        if (command.includes("-f"))
            assert.ok(command.includes("clean"), `only git clean takes -f: ${command.join(" ")}`);
        if (command.includes("push")) {
            // Exactly the two pushes the panel offers: the branch's own destination, named in full, and a first publish;
            // never a bare `git push` (which follows push.default) and never anything else.
            const push = command.slice(command.indexOf("push"));
            const explicit = push.length === 3 && push[2]?.startsWith("HEAD:refs/heads/");
            const firstPublish = push.length === 4 && push[1] === "-u" && push[3] === "HEAD";
            assert.ok(explicit || firstPublish, `unexpected push: ${command.join(" ")}`);
        }
    }
    for (const mod of ["repo-changes", "repo-review"]) {
        const code = readdirSync(path.join(HERDR, "mods", mod))
            .filter((f) => f.endsWith(".js"))
            .map((f) => readFileSync(path.join(HERDR, "mods", mod, f), "utf8"))
            .join("\n");
        assert.doesNotMatch(
            code,
            /"--force"|"--force-with-lease"|"-D"|"reset"|"--discard-changes"|"--amend"|"--no-verify"|"-fd"|"-x"/,
            mod,
        );
        assert.doesNotMatch(code, /\["clean", "-d"|"clean", "-[a-z]*d/, mod);
    }
});

test("the list's look: short names, folds per repo, badges and the one commit line", async () => {
    const {
        rowName,
        branchLabel,
        disambiguators,
        branchMatchesName,
        foldMap,
        foldedByDefault,
        isFolded,
        withFold,
        withAllFolds,
        focusedCheckout,
        showsCommit,
        badgeText,
        isDiverged,
        changedBadge,
        worktreeSignal,
        FOLD_KEY,
    } = await load<Lib>("mods/repo-changes/lib.js");

    assert.deepEqual(rowName({ path: "/repos/bss-services" }), { name: "bss-services", dir: null });
    assert.deepEqual(
        rowName({ path: "/repos/jig-dark" }, { main: { path: "/repos/jig" } }),
        { name: "dark", dir: null },
        "a worktree drops the repo prefix",
    );
    assert.deepEqual(rowName({ path: "/repos/orders-api-PROJ-12" }, { main: { path: "/repos/orders-api" } }), {
        name: "PROJ-12",
        dir: null,
    });
    assert.deepEqual(rowName({ path: "/repos/other" }, { main: { path: "/repos/jig" } }), { name: "other", dir: null });
    assert.deepEqual(rowName({ path: "/a/b/other" }, { dir: "b" }), { name: "other", dir: "b" });

    assert.deepEqual(branchLabel("feature/herdr-git-panel"), { lead: "feature/", text: "herdr-git-panel" });
    assert.deepEqual(branchLabel("feature/herdr-git-panel", { lead: false }), { lead: null, text: "herdr-git-panel" });
    assert.deepEqual(branchLabel("main"), { lead: null, text: "main" });
    assert.deepEqual(branchLabel("develop"), { lead: null, text: "develop" });
    assert.deepEqual(branchLabel("feature/develop"), { lead: "feature/", text: "develop" });
    assert.equal(branchMatchesName("PROJ-12", "feature/PROJ-12"), true);
    assert.equal(branchMatchesName("PROJ-12", "feature/PROJ-13"), false);
    assert.equal(branchMatchesName("main", "main"), true);
    assert.deepEqual(branchLabel("feature/thing", { lead: false }), { lead: null, text: "thing" });

    const tags = disambiguators([
        { path: "/a/orders", name: "orders" },
        { path: "/b/orders", name: "orders" },
        { path: "/a/unique", name: "unique" },
    ]);
    assert.equal(tags.get("/a/orders"), "a", "the differing parent folder");
    assert.equal(tags.get("/b/orders"), "b");
    assert.equal(tags.has("/a/unique"), false, "unique names carry no tag");
    const deeper = disambiguators([
        { path: "/x/repos/a/orders", name: "orders" },
        { path: "/x/other/a/orders", name: "orders" },
    ]);
    assert.equal(deeper.get("/x/repos/a/orders"), "repos/a");
    assert.equal(deeper.get("/x/other/a/orders"), "other/a");

    assert.equal(FOLD_KEY, "repo-changes.folded");
    const cleanTree = { path: "/r/jig-dark", files: [], ahead: 0, behind: 0 };
    const dirtyTree = { path: "/r/jig-dirty", files: [{ path: "a" }] };
    const behindTree = { path: "/r/jig-behind", files: [], ahead: 0, behind: 2 };
    const group = { main: { path: "/r/jig" }, worktrees: [cleanTree] };
    const dirtyGroup = { main: { path: "/r/jig" }, worktrees: [cleanTree, dirtyTree] };
    assert.equal(foldedByDefault(group), true, "clean worktrees start folded");
    assert.equal(foldedByDefault(dirtyGroup), false, "a changed worktree keeps the repo open");
    assert.equal(foldedByDefault({ main: { path: "/r/jig" }, worktrees: [behindTree] }), false);
    assert.equal(foldedByDefault(group, "/r/jig-dark"), false, "the focused worktree keeps it open");
    assert.equal(foldedByDefault({ main: { path: "/r/jig" }, worktrees: [] }), true);
    assert.equal(worktreeSignal(dirtyTree), true);
    assert.equal(worktreeSignal(cleanTree), false);

    assert.deepEqual(foldMap({ "/r/jig": true, "/r/x": "no", "/r/y": false }), { "/r/jig": true, "/r/y": false });
    assert.deepEqual(foldMap("not a map"), {});
    assert.equal(isFolded({}, group), true);
    assert.equal(isFolded({}, group, "/r/jig-dark"), false);
    assert.equal(isFolded({ "/r/jig": false }, group), false, "the stored choice wins");
    assert.equal(isFolded({ "/r/jig": true }, group, "/r/jig-dark"), true);
    assert.deepEqual(withFold({}, group, false), { "/r/jig": false });
    assert.deepEqual(withAllFolds([group, { main: { path: "/r/other" } }], true), {
        "/r/jig": true,
        "/r/other": true,
    });

    const repos = [
        { path: "/r/jig", files: [] },
        { path: "/r/jig-dark", files: [] },
        { path: "/r/other", files: [] },
    ];
    assert.equal(focusedCheckout(repos, "/r/jig-dark/src"), "/r/jig-dark", "the deepest checkout wins");
    assert.equal(focusedCheckout(repos, "/r/jig"), "/r/jig");
    assert.equal(focusedCheckout(repos, "/r/none"), null);
    assert.equal(showsCommit({ path: "/r/jig-dark" }, "/r/jig-dark"), true);
    assert.equal(showsCommit({ path: "/r/jig" }, "/r/jig-dark"), false);
    assert.equal(showsCommit({ path: "/r/jig" }, "/r/jig-dark", "full"), true);

    assert.equal(badgeText({ ahead: 9, behind: 17 }), "↑9 ↓17");
    assert.equal(badgeText({}), "");
    assert.equal(isDiverged({ ahead: 9, behind: 17 }), true);
    assert.equal(isDiverged({ ahead: 9, behind: 0 }), false);
    assert.equal(changedBadge({ total: 3 }), "3");
    assert.equal(changedBadge({ total: 0 }), null);
});

test("the Changes panel's config.json has its defaults, and a wrong field is reported", async () => {
    const { parseConfig } = await load<Lib>("mods/repo-changes/lib.js");
    const shipped = parseConfig(readFileSync(path.join(HERDR, "mods/repo-changes/config.json"), "utf8"));
    assert.deepEqual(shipped, {
        newBranchPrefix: "feature/",
        baseBranch: null,
        remote: "origin",
        networkTimeoutSeconds: 60,
        rowDetail: "compact",
        problems: [],
    });
    assert.deepEqual(parseConfig('{ "newBranchPrefix": "", "baseBranch": "develop" }'), {
        newBranchPrefix: "",
        baseBranch: "develop",
        remote: "origin",
        networkTimeoutSeconds: 60,
        rowDetail: "compact",
        problems: [],
    });
    assert.deepEqual(parseConfig('{ "remote": " up ", "networkTimeoutSeconds": 30 }'), {
        newBranchPrefix: "feature/",
        baseBranch: null,
        remote: "origin",
        networkTimeoutSeconds: 30,
        rowDetail: "compact",
        problems: ['"remote" must be a remote name, such as "origin"'],
    });
    assert.deepEqual(parseConfig('{ "remote": "acme", "networkTimeoutSeconds": 1 }'), {
        newBranchPrefix: "feature/",
        baseBranch: null,
        remote: "acme",
        networkTimeoutSeconds: 60,
        rowDetail: "compact",
        problems: ['"networkTimeoutSeconds" must be a whole number from 5 to 600'],
    });
    assert.equal(parseConfig('{ "rowDetail": "full" }').rowDetail, "full");
    assert.deepEqual(parseConfig('{ "rowDetail": "wide" }').problems, ['"rowDetail" must be "compact" or "full"']);
    assert.equal(parseConfig('{ "newBranchPrefix": 3, "baseBranch": "" }').problems.length, 2);
    assert.match(parseConfig("{").problems[0], /not valid JSON/);
});

// ---- Branch review: the base branch, the commits ahead of it, and the branch's files ----

const gitc = (cwd: string, ...args: string[]) =>
    git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.com", ...args);
const commitIn = (dir: string, file: string, text = "x\n") => {
    writeFileSync(path.join(dir, file), text);
    gitc(dir, "add", "-A");
    gitc(dir, "commit", "-qm", `add ${file}`);
};
const scanRoot = (script: string, root: string) => execFileSync("sh", ["-c", script, "sh", root], { encoding: "utf8" });

/** A repository with no remote, one commit on `first` and the other branches made from it. */
function plain(root: string, name: string, first: string, ...others: string[]): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    gitc(dir, "init", "-q", "-b", first);
    commitIn(dir, "README.md");
    for (const b of others) gitc(dir, "branch", b);
    return dir;
}

/** The base both ways: the Changes panel's scan script and the Review tab's findBase must agree. */
async function bases(root: string, dirs: string[]) {
    const { SCRIPT, parseRepos } = await load<Lib>("mods/repo-changes/lib.js");
    const { findBase } = await load<Lib>("mods/repo-review/lib.js");
    const scanned = parseRepos(scanRoot(SCRIPT, root), root);
    return Promise.all(
        dirs.map(async (dir) => {
            const viaScript = scanned.find((r: Lib) => r.path === dir)?.base ?? null;
            const viaReview = await findBase(exec, dir);
            assert.equal(viaScript?.ref ?? null, viaReview?.ref ?? null, dir);
            assert.equal(viaScript?.count ?? 0, viaReview?.count ?? 0, dir);
            return viaReview as Lib | null;
        }),
    );
}

test("the base branch is the closest; on a tie origin/develop, then origin's HEAD, main or master, else a local one", async (t) => {
    const root = realpathSync(scratch(t));
    const work = path.join(root, "work");
    mkdirSync(work);
    const { origin } = cloned(root);
    gitc(path.join(root, "seed"), "push", "-q", "origin", "main:develop");
    const clone = (name: string) => {
        git(root, "clone", "-q", origin, path.join(work, name));
        return path.join(work, name);
    };

    // origin/HEAD is main and origin/develop is the same commit: on the tie develop wins (gitflow work starts there).
    const viaHead = clone("via-head");
    gitc(viaHead, "switch", "-q", "-c", "feature/a");
    commitIn(viaHead, "one.ts");
    commitIn(viaHead, "two.ts");
    // Without origin/HEAD the first of origin/develop, origin/main, origin/master.
    const noHead = clone("no-head");
    git(noHead, "remote", "set-head", "origin", "-d");
    gitc(noHead, "switch", "-q", "-c", "feature/b");
    commitIn(noHead, "one.ts");
    // No remote: local develop beats main, and master is found alone.
    const local = plain(work, "local", "main", "develop");
    gitc(local, "switch", "-q", "-c", "feature/c");
    commitIn(local, "one.ts");
    const master = plain(work, "master-only", "master");
    gitc(master, "switch", "-q", "-c", "feature/d");
    commitIn(master, "one.ts");
    // No base branch at all, a checkout on its base, and nothing ahead.
    const none = plain(work, "none", "trunk");
    gitc(none, "switch", "-q", "-c", "feature/e");
    commitIn(none, "one.ts");
    const onBase = clone("on-base");
    const behind = plain(work, "no-commits", "main", "feature/f");
    gitc(behind, "switch", "-q", "feature/f");
    // Commits that landed on the base after the branch was made do not count.
    const moved = plain(work, "moved", "main");
    gitc(moved, "switch", "-q", "-c", "feature/g");
    commitIn(moved, "mine.ts");
    gitc(moved, "switch", "-q", "main");
    commitIn(moved, "later1.ts");
    commitIn(moved, "later2.ts");
    gitc(moved, "switch", "-q", "feature/g");

    const found = await bases(work, [viaHead, noHead, local, master, none, onBase, behind, moved]);
    const summary = found.map((b) => (b ? `${b.ref} ${b.count}` : null));
    assert.deepEqual(summary, [
        "origin/develop 2",
        "origin/develop 1",
        "develop 1",
        "master 1",
        null,
        null,
        null,
        "main 1",
    ]);
    assert.equal(found[0]?.name, "develop");
    assert.deepEqual(found[0]?.commits.length, 2);
    assert.match(found[0]?.commits[0], /add two\.ts$/);
    assert.equal(found[7]?.mergeBase, git(moved, "merge-base", "main", "HEAD"));
});

test("the closest candidate is the base, and a checkout on a base branch has none", async (t) => {
    const root = realpathSync(scratch(t));
    // origin/HEAD is master, but develop is ahead of it and the work branches start from develop.
    const seed = plain(root, "seed2", "master");
    gitc(seed, "switch", "-q", "-c", "develop");
    commitIn(seed, "d1.ts");
    commitIn(seed, "d2.ts");
    gitc(seed, "switch", "-q", "master");
    const origin = path.join(root, "origin2.git");
    git(root, "clone", "-q", "--bare", seed, origin);
    const work = path.join(root, "work");
    mkdirSync(work);
    git(root, "clone", "-q", origin, path.join(work, "orders-api"));
    const repo = path.join(work, "orders-api");
    gitc(repo, "switch", "-q", "-c", "feature/PROJ-1", "origin/develop");
    commitIn(repo, "mine.ts");
    // A tracking develop checkout: it is a base itself.
    git(root, "clone", "-q", "-b", "develop", origin, path.join(work, "on-develop"));
    const onDevelop = path.join(work, "on-develop");
    commitIn(onDevelop, "unpushed.ts");
    // A local develop equal to origin/develop is the same base, not a second one.
    gitc(repo, "branch", "develop", "origin/develop");

    const [ticket, onDev] = await bases(work, [repo, onDevelop]);
    assert.equal(git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/master");
    assert.equal(ticket?.ref, "origin/develop");
    assert.equal(ticket?.count, 1);
    assert.equal(onDev, null);
});

test("the Changes panel's chip counts commits over the base; a clean checkout with commits is not clean", async (t) => {
    const { SCRIPT, parseRepos, groupRepos, isClean, aheadChip } = await load<Lib>("mods/repo-changes/lib.js");
    const root = realpathSync(scratch(t));
    const ticket = plain(root, "orders-api", "main");
    gitc(ticket, "switch", "-q", "-c", "feature/PROJ-123");
    commitIn(ticket, "a.ts");
    const idle = plain(root, "billing", "main");
    const repos = parseRepos(scanRoot(SCRIPT, root), root);
    const byName = (n: string) => repos.find((r: Lib) => r.name === n);
    assert.equal(aheadChip(byName("orders-api")), "1 commit vs main");
    assert.equal(aheadChip(byName("billing")), null);
    assert.equal(byName("orders-api").files.length, 0);
    const groups = groupRepos(repos);
    assert.deepEqual(
        groups.map((g: Lib) => [g.main.name, isClean(g)]),
        [
            ["billing", true],
            ["orders-api", false],
        ],
    );
    commitIn(ticket, "b.ts");
    assert.equal(
        aheadChip(parseRepos(scanRoot(SCRIPT, root), root).find((r: Lib) => r.name === "orders-api")),
        "2 commits vs main",
    );
    assert.ok(idle);
});

test("the branch view lists the committed files and the uncommitted ones against the merge base, and writes nothing", async (t) => {
    const { findBase, parseNameStatus, branchFiles, canWrite, openMode, effectiveMode, parseStatus } =
        await load<Lib>("mods/repo-review/lib.js");
    const root = realpathSync(scratch(t));
    const repo = plain(root, "orders-api", "main");
    commitIn(repo, "old.ts", "old\n");
    commitIn(repo, "gone.ts", "gone\n");
    gitc(repo, "switch", "-q", "-c", "feature/PROJ-123");
    commitIn(repo, "added.ts", "new\n");
    writeFileSync(path.join(repo, "old.ts"), "changed\n");
    git(repo, "rm", "-q", "gone.ts");
    writeFileSync(path.join(repo, "loose.ts"), "untracked\n");

    const base = await findBase(exec, repo);
    assert.equal(base?.count, 1);
    const diff = await exec("git", ["diff", "--name-status", "--no-renames", base.mergeBase], { cwd: repo });
    const committed = parseNameStatus(diff.stdout);
    assert.deepEqual(committed.map((f: Lib) => `${f.status} ${f.path}`).sort(), [
        "A added.ts",
        "D gone.ts",
        "M old.ts",
    ]);
    const status = parseStatus(git(repo, "status", "--porcelain=v1", "-b", "--no-renames"));
    const files = branchFiles(committed, status.files);
    assert.deepEqual(
        files.map((f: Lib) => `${f.status} ${f.path}`),
        ["A added.ts", "D gone.ts", "M old.ts", "?? loose.ts"],
    );
    // The working view still shows only the uncommitted ones.
    assert.deepEqual(status.files.map((f: Lib) => f.path).sort(), ["gone.ts", "loose.ts", "old.ts"]);
    const patch = git(repo, "diff", base.mergeBase, "--", "added.ts");
    assert.match(patch, /\+new/);

    // Branch mode is read-only; the mode comes from the request, and an older request without one means working changes.
    assert.equal(canWrite("branch"), false);
    assert.equal(canWrite("working"), true);
    assert.equal(openMode({ repo, file: "a.ts", at: 1 }), "working");
    assert.equal(openMode({ repo, file: null, mode: "branch", at: 1 }), "branch");
    assert.equal(openMode(undefined), "working");
    assert.equal(effectiveMode("branch", true, true), "branch");
    assert.equal(effectiveMode("branch", true, false), "working");
    assert.equal(effectiveMode("working", false, true), "branch");
    assert.equal(effectiveMode("working", true, true), "working");
});

test("a gone upstream names the tracking remote, not the push remote", async (t) => {
    const { pushTarget } = await load<Lib>("mods/repo-changes/lib.js");
    const root = scratch(t);
    const { origin, repo } = cloned(root);
    const fork = path.join(root, "fork.git");
    git(root, "init", "-q", "--bare", "-b", "main", fork);
    git(repo, "remote", "add", "fork", fork);
    git(repo, "switch", "-q", "-c", "feature/gone", "origin/main");
    git(repo, "push", "-q", "-u", "origin", "feature/gone");
    git(repo, "config", "branch.feature/gone.pushRemote", "fork");
    git(origin, "update-ref", "-d", "refs/heads/feature/gone");
    git(repo, "fetch", "-q", "--prune", "origin");
    const target = await pushTarget(exec, { checkout: repo });
    assert.equal(target.mode, "publish");
    assert.equal(target.remote, "fork", "publishing still goes to the push remote");
    assert.match(target.reason, /origin\/feature\/gone is gone/, "the remote that lost the branch is named");
});
