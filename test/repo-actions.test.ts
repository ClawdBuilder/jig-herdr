// The Changes panel's nesting of worktrees and its git actions (repo-changes/lib.js, and the file actions copied into
// repo-review/lib.js), run on real git repositories in temporary folders, with a bare repository as their origin.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HERDR, load } from "./support.ts";

// The lib is plain JavaScript; each test says which of its functions it uses.
type Lib = Record<string, any>;
type Result = { ok: boolean; message: string; hash?: string };
type Exec = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Every command the actions ran, to check that none of them ever forces anything. */
const ran: string[][] = [];

/** Herdr's exec, as child_process: never rejects for a non-zero exit, gives the code and both outputs. */
const exec: Exec = (cmd, args, opts) =>
    new Promise((resolve) => {
        ran.push([cmd, ...args]);
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

test("the actions never force, delete a branch, reset, amend, skip hooks or push", async () => {
    const forbidden = ["--force", "-D", "reset", "--discard-changes", "--amend", "--no-verify", "push", "-d", "-x"];
    for (const command of ran) {
        if (command[0] !== "git") continue;
        for (const bad of forbidden) assert.ok(!command.includes(bad), `${command.join(" ")} uses ${bad}`);
        if (command.includes("-f"))
            assert.ok(command.includes("clean"), `only git clean takes -f: ${command.join(" ")}`);
    }
    for (const mod of ["repo-changes", "repo-review"]) {
        const code = readdirSync(path.join(HERDR, "mods", mod))
            .filter((f) => f.endsWith(".js"))
            .map((f) => readFileSync(path.join(HERDR, "mods", mod, f), "utf8"))
            .join("\n");
        assert.doesNotMatch(
            code,
            /"--force"|"-D"|"reset"|"--discard-changes"|"--amend"|"--no-verify"|"push"|"-fd"|"-x"/,
            mod,
        );
        assert.doesNotMatch(code, /\["clean", "-d"|"clean", "-[a-z]*d/, mod);
    }
});

test("the Changes panel's config.json has its defaults, and a wrong field is reported", async () => {
    const { parseConfig } = await load<Lib>("mods/repo-changes/lib.js");
    const shipped = parseConfig(readFileSync(path.join(HERDR, "mods/repo-changes/config.json"), "utf8"));
    assert.deepEqual(shipped, { newBranchPrefix: "feature/", baseBranch: null, problems: [] });
    assert.deepEqual(parseConfig('{ "newBranchPrefix": "", "baseBranch": "develop" }'), {
        newBranchPrefix: "",
        baseBranch: "develop",
        problems: [],
    });
    assert.equal(parseConfig('{ "newBranchPrefix": 3, "baseBranch": "" }').problems.length, 2);
    assert.match(parseConfig("{").problems[0], /not valid JSON/);
});
