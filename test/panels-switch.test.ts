// Real-mod switch tests: a new context must never keep the old folder's rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

const flush = async (n = 20) => {
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
    return ctx;
}
const worktrees = (root: string) =>
    `W\t${root}/orders-api\t${root}/orders-api\tmain\tabc\t0\t0\t0\t0\t\torigin/main\t0\t0\tmain\t2026-01-01\t\tFirst\n` +
    `W\t${root}/orders-api\t${root}/orders-api-worktree\tfeat/x\tabc\t0\t0\t0\t0\t\t\t0\t0\tmain\t2026-01-02\t\tSecond\n`;
const switchTo = (ctx: any, root: string) => {
    ctx.folder = root;
    ctx.focused = { pane: "p", cwd: root, terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: root }];
};
const runKick = (view: any, cx: any, timers: any[]) => {
    const kick = timers.find((t: any) => t.ms === 0);
    assert.ok(kick, "render scheduled the new read");
    kick.fn(cx);
};

test("Worktrees: A to B drops A and reads B", async () => {
    const a = "/tmp/wt-a";
    const b = "/tmp/wt-b";
    const ctx = context(a);
    const calls: string[][] = [];
    let resolveB: ((value: any) => void) | null = null;
    ctx.exec = async (cmd: string, args: string[]) => {
        calls.push(args);
        if (cmd === "sh" && args[3] === b)
            return new Promise((resolve) => {
                resolveB = resolve;
            });
        return { code: 0, stdout: cmd === "sh" ? worktrees(args[3] ?? ctx.folder) : "", stderr: "" };
    };
    const { view, cx, timers } = await load("jig-worktrees");
    await flush();
    switchTo(ctx, b);
    view.render(cx);
    runKick(view, cx, timers);
    await flush();
    assert.equal(view.trees, null, "the old rows are dropped before B lands");
    resolveB!({ code: 0, stdout: worktrees(b), stderr: "" });
    await flush();
    assert.equal(view.loadedContext, view.contextKey);
    assert.equal(
        view.trees.every((tree: any) => tree.path.startsWith(b)),
        true,
    );
    assert.equal(JSON.stringify(view.trees).includes(a), false);
    assert.equal(
        calls.some((args) => args[3] === b),
        true,
    );
});

test("Worktrees: a late A result cannot replace B", async () => {
    const a = "/tmp/wt-late-a";
    const b = "/tmp/wt-late-b";
    const ctx = context(a);
    let resolveA: ((value: any) => void) | null = null;
    let resolveB: ((value: any) => void) | null = null;
    ctx.exec = async (_cmd: string, args: string[]) =>
        new Promise((resolve) => {
            if (args[3] === a) resolveA = resolve;
            else resolveB = resolve;
        });
    const { view, cx, timers } = await load("jig-worktrees");
    await flush();
    assert.ok(resolveA);
    resolveA!({ code: 0, stdout: worktrees(a), stderr: "" });
    await flush();
    switchTo(ctx, b);
    view.render(cx);
    runKick(view, cx, timers);
    await flush();
    assert.ok(resolveB);
    resolveB!({ code: 0, stdout: worktrees(b), stderr: "" });
    await flush();
    assert.equal(
        view.trees.every((tree: any) => tree.path.startsWith(b)),
        true,
    );
});

test("Worktrees: five renders start one read and identical reads do not notify", async () => {
    const root = "/tmp/wt-same";
    const ctx = context(root);
    let reads = 0;
    ctx.exec = async (_cmd: string, args: string[]) => {
        reads++;
        return { code: 0, stdout: worktrees(args[3] ?? root), stderr: "" };
    };
    const { view, cx, timers, notifies } = await load("jig-worktrees");
    await flush();
    reads = 0;
    switchTo(ctx, "/tmp/wt-five-b");
    for (let i = 0; i < 5; i++) view.render(cx);
    assert.equal(timers.filter((t: any) => t.ms === 0).length, 1);
    runKick(view, cx, timers);
    await flush();
    assert.equal(reads, 1);
    const before = notifies.count;
    view.load(cx);
    await flush();
    assert.equal(notifies.count, before);
});

const histLog = (subject: string) => `aaaa\x1f\x1fAnn\x1f2026-01-01T00:00:00Z\x1f\x1f${subject}\n`;
const histRepo = (root: string) => `${root}\tmain\tmain\t0`;
test("History: A to B drops A and reads B", async () => {
    const a = "/tmp/hist-a";
    const b = "/tmp/hist-b";
    const ctx = context(a);
    const calls: string[][] = [];
    let bLog: ((value: any) => void) | null = null;
    ctx.exec = async (cmd: string, args: string[], options: any = {}) => {
        calls.push(args);
        if (cmd === "sh") return { code: 0, stdout: `@single\n${histRepo(args[3] ?? a)}`, stderr: "" };
        if (args.includes("log")) {
            if ((options.cwd ?? "").includes("hist-b")) return new Promise((resolve) => (bLog = resolve));
            return { code: 0, stdout: histLog("A commit"), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
    };
    const { view, cx, timers } = await load("jig-history");
    await flush();
    switchTo(ctx, b);
    view.render(cx);
    runKick(view, cx, timers);
    await flush();
    assert.equal(view.repo?.startsWith(a), false);
    assert.equal(view.commits, null, "A's commits are dropped before B lands");
    assert.ok(bLog, "History asked for B");
    bLog!({ code: 0, stdout: histLog("B commit"), stderr: "" });
    await flush();
    assert.equal(JSON.stringify(view.commits).includes("A commit"), false);
    assert.equal(JSON.stringify(view.commits).includes("B commit"), true);
});

const prDiscovery = (root: string) =>
    `@single\n${root}/repo\tfeat/${root.includes("pr-b") ? "b" : "a"}\thttps://github.com/o/r.git\tmain\t`;
const prReply = (title: string) =>
    JSON.stringify([{ number: 1, title, url: "https://github.com/o/r/pull/1", state: "OPEN", headRefName: "feat/x" }]);
test("PR & CI: A to B drops A and reads B", async () => {
    const a = "/tmp/pr-a";
    const b = "/tmp/pr-b";
    const ctx = context(a);
    let resolveB: ((value: any) => void) | null = null;
    ctx.exec = async (cmd: string, args: string[]) => {
        if (cmd === "sh" && args[3] === "gh") {
            if (args.includes("feat/b")) return new Promise((resolve) => (resolveB = resolve));
            return { code: 0, stdout: prReply("A PR"), stderr: "" };
        }
        return { code: 0, stdout: prDiscovery(args[3] ?? a), stderr: "" };
    };
    const { view, cx, timers } = await load("jig-prs");
    await flush();
    switchTo(ctx, b);
    view.render(cx);
    runKick(view, cx, timers);
    await flush();
    assert.equal(JSON.stringify(view.data).includes("A PR"), false);
    assert.ok(resolveB, "PR & CI asked for B");
    resolveB!({ code: 0, stdout: prReply("B PR"), stderr: "" });
    await flush();
    assert.equal(JSON.stringify(view.data).includes("B PR"), true);
    assert.equal(JSON.stringify(view.data).includes("A PR"), false);
});
