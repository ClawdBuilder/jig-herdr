// The real push dialog against local git remotes: failures keep the reason and always release the lock.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadFile } from "./support/overlay-harness.mjs";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        encoding: "utf8",
        timeout: 20_000,
    }).trim();
const flush = async (n = 30) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const context = (root: string) => {
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
};
function repositories(t: any) {
    const root = mkdtempSync(path.join(tmpdir(), "jig-push-"));
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
const props = (local: string) => ({
    push: {
        on: null,
        path: local,
        name: "local",
        branch: "main",
        remote: "origin",
        target: "origin/main",
        mode: "push",
        expect: { branch: "main", remote: "origin", target: "origin/main", mode: "push" },
    },
});
test("Push dialog: a rejected push shows git's reason, stays open and releases the lock", async (t) => {
    const { local, other } = repositories(t);
    writeFileSync(path.join(local, "local.txt"), "local\n");
    git(local, "add", "-A");
    git(local, "commit", "-qm", "local work");
    writeFileSync(path.join(other, "remote.txt"), "remote\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "remote work");
    git(other, "push", "-q", "origin", "main");
    const ctx = context(local);
    const { view, cx } = await loadFile("jig-git/push.js", props(local));
    view.run(cx);
    await flush();
    assert.match(view.message ?? "", /rejected|fetch first|non-fast-forward/i);
    assert.equal(view.running, false);
    assert.equal(ctx.shared["jig-git.running"]?.[""]?.[local], undefined);
    view.render(cx);
});
test("Push dialog: a successful push writes DONE and releases the lock", async (t) => {
    const { local } = repositories(t);
    writeFileSync(path.join(local, "new.txt"), "new\n");
    git(local, "add", "-A");
    git(local, "commit", "-qm", "new");
    const ctx = context(local);
    const { view, cx } = await loadFile("jig-git/push.js", props(local));
    view.run(cx);
    await flush();
    assert.equal(view.running, false);
    assert.ok(ctx.shared["jig-git.done"]?.path === local);
    assert.equal(ctx.shared["jig-git.running"]?.[""]?.[local], undefined);
});
