import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

type Deferred = { promise: Promise<any>; resolve: (v: any) => void };
const defer = (): Deferred => {
    let resolve!: (v: any) => void;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
};
const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
type Call = { cmd: string; args: string[]; cwd: string; deferred?: Deferred; result?: any };

function fakeExec() {
    const calls: Call[] = [];
    let hold: ((call: Call) => boolean) | null = null;
    const exec = async (cmd: string, args: string[], options: any = {}) => {
        const call: Call = { cmd, args, cwd: options.cwd ?? args[3] ?? "" };
        calls.push(call);
        if (hold?.(call)) {
            call.deferred = defer();
            return call.deferred.promise;
        }
        if (cmd === "sh") {
            if (call.cwd === "/A") return { code: 0, stdout: "/A/repo\tm\tmain\t1\n" };
            if (call.cwd === "/B") return { code: 0, stdout: "/B/repo\tm\tmain\t1\n" };
            return { code: 0, stdout: "" };
        }
        if (args.includes("status")) return { code: 0, stdout: "## main\n M file.txt\n" };
        if (args.includes("rev-parse")) return { code: 0, stdout: "abc123\n" };
        if (args.includes("diff")) return { code: 0, stdout: "" };
        return { code: 1, stdout: "", stderr: "" };
    };
    return { exec, calls, hold: (fn: ((call: Call) => boolean) | null) => (hold = fn) };
}

function live(exec: any, folder: string) {
    let ctx: any = (globalThis as any).__CTX;
    if (!ctx) ctx = (globalThis as any).__CTX = {};
    ctx.exec = exec;
    ctx.folder = folder;
    ctx.focused = { pane: "p", cwd: folder, terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: folder }];
    ctx.agents = [];
}
const focus = (folder: string) => {
    let ctx: any = (globalThis as any).__CTX;
    if (!ctx) ctx = (globalThis as any).__CTX = {};
    ctx.folder = folder;
    ctx.focused = { pane: "p", cwd: folder, terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: folder }];
};
const tick = async (timers: any[], cx: any) => {
    for (const t of timers) t.fn(cx);
    await flush();
};
const release = async (calls: Call[], folder: string) => {
    for (const c of calls.filter((c) => c.deferred && c.cwd === folder))
        c.deferred!.resolve({ code: 0, stdout: `/late\n` });
    await flush();
};

for (const mod of ["jig-review", "jig-worktrees"]) {
    test(`${mod}: a late result is dropped and B wins`, async () => {
        const fake = fakeExec();
        live(fake.exec, "/A");
        fake.hold((c) => c.cmd === "sh");
        const { view, cx, timers } = await load(mod);
        await flush();
        focus("/B");
        await tick(timers, cx);
        await release(fake.calls, "/B");
        await release(fake.calls, "/A");
        assert.equal(view.contextKey, view.loadedContext);
        assert.equal(view.where.root, "/B");
        assert.ok(!String(view.error ?? "").includes("Reading"));
    });

    test(`${mod}: A to B to A ends on A`, async () => {
        const fake = fakeExec();
        live(fake.exec, "/A");
        fake.hold((c) => c.cmd === "sh");
        const { view, cx, timers } = await load(mod);
        await flush();
        focus("/B");
        await tick(timers, cx);
        focus("/A");
        await tick(timers, cx);
        await release(fake.calls, "/B");
        await release(fake.calls, "/A");
        assert.equal(view.contextKey, view.loadedContext);
        assert.equal(view.where.root, "/A");
    });

    test(`${mod}: the landed key is the shown key`, async () => {
        const fake = fakeExec();
        live(fake.exec, "/A");
        const { view, cx, timers } = await load(mod);
        await flush();
        await tick(timers, cx);
        await flush();
        assert.equal(view.loadedContext, view.contextKey);
    });
}

test("jig-review: a refresh requested in flight runs once afterwards", async () => {
    const fake = fakeExec();
    live(fake.exec, "/A");
    fake.hold((c) => c.cmd === "git" && c.args.includes("status"));
    const { view, cx, timers } = await load("jig-review");
    await flush();
    // The first status read is held; ask twice while it runs.
    const before = fake.calls.filter((c) => c.cmd === "git" && c.args.includes("status")).length;
    view.refresh(cx);
    view.refresh(cx);
    await flush();
    const held = fake.calls.filter((c) => c.deferred && c.cmd === "git");
    assert.ok(held.length >= 1);
    for (const call of held) call.deferred!.resolve({ code: 0, stdout: "## main\n M file.txt\n" });
    fake.hold(null);
    await flush();
    await tick(timers, cx);
    await flush();
    const after = fake.calls.filter((c) => c.cmd === "git" && c.args.includes("status")).length;
    assert.equal(after, before + 1, `exactly one queued read: before=${before} after=${after}`);
});
