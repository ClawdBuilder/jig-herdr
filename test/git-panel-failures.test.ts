// The real Git panel path against local repositories: failed Pull/Fetch/commit reasons and lock release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        encoding: "utf8",
        timeout: 20_000,
    }).trim();
const flush = async (n = 40) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
function context(root: string) {
    const ctx: any = (globalThis as any).__CTX ?? {};
    (globalThis as any).__CTX = ctx;
    ctx.folder = root;
    ctx.focused = { pane: "p", cwd: root, terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: root }];
    ctx.agents = [];
    ctx.shared = {};
    ctx.exec = async (cmd: string, args: string[], options: any = {}) => {
        try {
            return { code: 0, stdout: execFileSync(cmd, args, { ...options, encoding: "utf8" }), stderr: "" };
        } catch (error: any) {
            return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
        }
    };
    return ctx;
}
function pair(t: any) {
    const root = mkdtempSync(path.join(tmpdir(), "jig-panel-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const remote = path.join(root, "remote.git");
    git(root, "init", "--bare", "-q", "-b", "main", remote);
    const other = path.join(root, "other");
    git(root, "clone", "-q", remote, other);
    writeFileSync(path.join(other, "seed.txt"), "seed\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "seed");
    git(other, "push", "-q", "origin", "main");
    const local = path.join(root, "local");
    git(root, "clone", "-q", remote, local);
    return { root, remote, other, local };
}
async function panel(local: string) {
    const ctx = context(local);
    const { view, cx } = await load("jig-git");
    await flush();
    const repo = view.repos.find((r: any) => r.path === local) ?? view.repos[0];
    view.refresh = async () => {};
    return { ctx, view, cx, repo };
}
test("a diverged per-repo Pull shows a real reason and keeps it", async (t) => {
    const { local, other } = pair(t);
    writeFileSync(path.join(other, "remote.txt"), "remote\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "remote");
    git(other, "push", "-q", "origin", "main");
    writeFileSync(path.join(local, "local.txt"), "local\n");
    git(local, "add", "-A");
    git(local, "commit", "-qm", "local");
    const { view, cx, repo } = await panel(local);
    view.syncNow(cx, repo, "pull");
    await flush();
    const message = view.notes[repo.path]?.message ?? "";
    assert.match(message, /^Not possible to fast-forward, aborting\. It cannot fast-forward/i);
    assert.doesNotMatch(message, /^From /);
    assert.match(`${repo.name}: ${message}`, new RegExp(`^${repo.name}:`));
    assert.equal(view.notes[repo.path].ok, false);
});
test("a Fetch after the remote disappears shows its reason", async (t) => {
    const { local, remote } = pair(t);
    const { view, cx, repo } = await panel(local);
    rmSync(remote, { recursive: true, force: true });
    view.syncNow(cx, repo, "fetch");
    await flush();
    const message = view.notes[repo.path]?.message ?? "";
    assert.match(message, /does not appear|not a git|repository|fatal|error/i);
});
test("a pre-commit hook's reason wins over hint lines", async (t) => {
    const { local } = pair(t);
    const hook = path.join(local, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'hint: run the formatter'\necho 'error: hook says NO'\nexit 1\n");
    chmodSync(hook, 0o755);
    const { view, cx, repo } = await panel(local);
    writeFileSync(path.join(local, "staged.txt"), "x\n");
    git(local, "add", "staged.txt");
    view.act(cx, repo, (exec: any) =>
        import("../mods/jig-git/lib.js").then((m) => m.commit(exec, { checkout: repo.path, message: "try" })),
    );
    await flush();
    const message = view.notes[repo.path]?.message ?? "";
    assert.match(message, /hook says NO/);
    assert.doesNotMatch(message, /^hint:/);
    assert.equal(view.notes[repo.path].ok, false);
});
test("an action that throws releases the lock and shows the error", async (t) => {
    const { local } = pair(t);
    const { ctx, view, cx, repo } = await panel(local);
    view.act(cx, repo, async () => {
        throw new Error("boom from action");
    });
    await flush();
    assert.match(view.notes[repo.path]?.message ?? "", /boom from action/);
    assert.equal(ctx.shared["jig-git.running"]?.[""]?.[repo.path], undefined);
});
