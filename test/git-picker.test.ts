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
