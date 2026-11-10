import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
    baseFromState,
    cappedBranches,
    defaultBase,
    listBranches,
    PICKER_ROW_CAP,
    readBranchState,
    readSwitchState,
    switchBranch,
    switchRefusal,
    visibleBranches,
} from "../mods/jig-git/lib.js";

const fixture = (t: any) => {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-picker-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: dir });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "a"), "x\n");
    git("add", "a");
    git("commit", "-qm", "seed");
    const refs = [];
    for (let i = 0; i < 1500; i++) refs.push(`create refs/remotes/origin/branch-${i} HEAD`);
    for (let i = 0; i < 60; i++) refs.push(`create refs/heads/local-${i} HEAD`);
    execFileSync("git", ["update-ref", "--stdin"], { cwd: dir, input: `${refs.join("\n")}\n` });
    return dir;
};
const realExec =
    (counter: { n: number }) =>
    async (cmd: string, args: string[], options: any = {}) => {
        counter.n++;
        try {
            const stdout = execFileSync(cmd, args, { cwd: options.cwd, encoding: "utf8", timeout: 30_000 });
            return { code: 0, stdout, stderr: "" };
        } catch (e: any) {
            return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
        }
    };

test("open reads the same branches/base in 1 exec instead of 7, switch in 1 precheck instead of 3", async (t) => {
    const dir = fixture(t);
    const old = { n: 0 };
    const oldExec = realExec(old);
    const before = await listBranches(oldExec, dir);
    const oldBase = await defaultBase(oldExec, dir, {});
    await switchRefusal(oldExec, dir, []);
    assert.equal(old.n, 7);

    const now = { n: 0 };
    const state = await readBranchState(realExec(now), dir);
    assert.equal(now.n, 1);
    assert.equal(state.ok, true);
    assert.equal(baseFromState(state, {}), oldBase);
    assert.deepEqual(state.branches, before.branches);

    const switcher = { n: 0 };
    const precheck = await readSwitchState(realExec(switcher), dir, "local-0");
    assert.equal(switcher.n, 1);
    assert.equal(precheck.ok, true);
});

test("the picker caps 1,000 origin matches at 50 rows", () => {
    const branches = Array.from({ length: 1000 }, (_, i) => ({
        name: `feature/thing-${i}`,
        remote: true,
        current: false,
        inUse: null,
    }));
    assert.equal(visibleBranches(branches, "thing").length, 1000);
    assert.equal(cappedBranches(branches, "thing").length, PICKER_ROW_CAP);
    assert.equal(PICKER_ROW_CAP, 50);
});

test("switch precheck refuses names, dirty trees and unreadable status without reaching git switch", async (t) => {
    const dir = fixture(t);
    const run = realExec({ n: 0 });
    const before = headOf(dir);
    for (const name of ["", "-f", "+x", "@{-1}", "HEAD", "a..b"]) {
        const r = await readSwitchState(run, dir, name);
        assert.equal(r.ok, false, name);
        assert.equal(headOf(dir), before, name);
    }
    writeFileSync(path.join(dir, "dirty.txt"), "x");
    const dirty = await readSwitchState(run, dir, "local-0");
    assert.equal(dirty.ok, false);
    assert.match(dirty.message, /uncommitted/);
    assert.equal(headOf(dir), before);
    writeFileSync(path.join(dir, ".git/index"), "not an index");
    const broken = await readSwitchState(run, dir, "local-0");
    assert.equal(broken.ok, false);
    assert.match(broken.message, /Cannot read the checkout's status/);
    assert.equal(headOf(dir), before);
    const busy = await switchBranch(run, {
        checkout: dir,
        branch: "local-0",
        busy: [{ name: "A", status: "working", cwd: dir }],
    });
    assert.equal(busy.ok, false);
    assert.equal(headOf(dir), before);
});

const headOf = (dir: string) =>
    execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
const gitIn = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
        cwd: dir,
        encoding: "utf8",
    });

test("switchBranch switches clean local and remote-only branches and leaves HEAD on every refusal", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "jig-switch-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(path.join(dir, "a"), "x\n");
    gitIn(dir, "add", "a");
    gitIn(dir, "commit", "-qm", "seed");
    gitIn(dir, "branch", "feature/local");
    const bare = path.join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    gitIn(dir, "remote", "add", "origin", bare);
    gitIn(dir, "push", "-q", "-u", "origin", "main");
    gitIn(dir, "push", "-q", "origin", "main:refs/heads/remote-only");
    const run = realExec({ n: 0 });

    const local = await switchBranch(run, { checkout: dir, branch: "feature/local" });
    assert.equal(local.ok, true, local.message);
    assert.equal(headOf(dir), "feature/local");

    const remote = await switchBranch(run, { checkout: dir, branch: "remote-only" });
    assert.equal(remote.ok, true, remote.message);
    assert.equal(headOf(dir), "remote-only");
    assert.equal(
        gitIn(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
        "origin/remote-only\n",
    );

    const before = headOf(dir);
    const missing = await switchBranch(run, { checkout: dir, branch: "missing" });
    assert.equal(missing.ok, false);
    assert.equal(headOf(dir), before);

    const current = await switchBranch(run, { checkout: dir, branch: "remote-only" });
    assert.equal(current.ok, false);
    assert.equal(headOf(dir), before);

    gitIn(dir, "switch", "-q", "main");
    gitIn(dir, "branch", "feature/in-use");
    gitIn(dir, "worktree", "add", "-q", path.join(root, "other"), "feature/in-use");
    const atMain = headOf(dir);
    const inUse = await switchBranch(run, { checkout: dir, branch: "feature/in-use" });
    assert.equal(inUse.ok, false, inUse.message);
    assert.equal(headOf(dir), atMain);
});
