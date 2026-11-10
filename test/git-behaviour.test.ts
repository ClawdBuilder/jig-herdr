// The real Git mod path: the scan, filter, action notes, row buttons and an idle panel's exec count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

const flush = async (n = 12) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const scan = (root: string) => `@@root ${root}
@@repo ${root}/orders-api
@@git ${root}/orders-api/.git\t${root}/orders-api/.git
@@remote origin
@@head abc1234\x1ffeature work\x1f1700000000
## feature/PROJ-123...origin/feature/PROJ-123 [ahead 1, behind 2]
 M src/app.ts
=1
@@repo ${root}/billing-web
@@git ${root}/billing-web/.git\t${root}/billing-web/.git
@@head def5678\x1fmain\x1f1700000000
## main
?? notes.txt
=1
`;
function scanFor(root: string, targets: string) {
    const all = scan(root);
    if (!targets) return all;
    const wanted = new Set(targets.split("\n"));
    const [head, ...blocks] = all.split("@@repo ");
    return (
        head +
        blocks
            .filter((block) => wanted.has(block.split("\n")[0].trim()))
            .map((block) => `@@repo ${block}`)
            .join("")
    );
}
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
test("Git filters rows and counts through the view", async () => {
    const root = "/tmp/git-harness";
    const ctx = context(root);
    const calls: string[][] = [];
    ctx.exec = async (cmd: string, args: string[]) => {
        calls.push(args);
        return cmd === "sh" ? { code: 0, stdout: scan(root), stderr: "" } : { code: 0, stdout: "", stderr: "" };
    };
    const { view, cx } = await load("jig-git");
    await flush();
    assert.equal(view.view.states.changed.length, 1);
    assert.equal(view.view.states.needs.length, 1);
    view.filter = "billing";
    view.rebuildView();
    assert.deepEqual(
        view.view.states.changed.map((r: any) => r.name),
        ["billing-web"],
    );
    view.filter = "absent";
    view.rebuildView();
    assert.equal(Object.values(view.view.states).flat().length, 0);
    view.render(cx);
});

test("Git renders a failed action and clears a passing one", async () => {
    const root = "/tmp/git-harness-actions";
    const ctx = context(root);
    ctx.exec = async (cmd: string) =>
        cmd === "sh" ? { code: 0, stdout: scan(root), stderr: "" } : { code: 0, stdout: "", stderr: "" };
    const { view, cx, timers } = await load("jig-git");
    await flush();
    const repo = view.repos[0];
    view.hold = async () => "token";
    view.release = () => {};
    view.refresh = async () => {};
    await view.act(cx, repo, async () => ({ ok: false, message: "Push refused: no" }));
    await flush();
    assert.equal(view.notes[repo.path].message, "Push refused: no");
    view.render(cx);
    delete view.notes[repo.path];
    await view.act(cx, repo, async () => ({ ok: true, message: "Staged." }));
    await flush();
    assert.equal(view.notes[repo.path].message, "Staged.");
    const clear = timers.find((t: any) => t.ms === 4000);
    assert.ok(clear);
    clear.fn(cx);
    assert.equal(view.notes[repo.path], undefined);
});

test("Git repoActions covers behind, ahead, diverged, unpublished and detached", async () => {
    const { repoActions } = await import("../mods/jig-git/lib.js");
    assert.deepEqual(repoActions({ behind: 1, upstream: "origin/x", remote: "origin" }), ["pull", "fetch"]);
    assert.deepEqual(repoActions({ ahead: 1, upstream: "origin/x", remote: "origin" }), ["push", "fetch"]);
    assert.deepEqual(repoActions({ ahead: 1, behind: 1, upstream: "origin/x", remote: "origin" }), [
        "pull",
        "push",
        "fetch",
    ]);
    assert.deepEqual(repoActions({ ahead: 0, upstream: null, remote: "origin" }), ["publish", "fetch"]);
    assert.deepEqual(repoActions({ ahead: 2, upstream: "origin/x", gone: true, remote: "origin" }), [
        "publish",
        "fetch",
    ]);
    assert.deepEqual(repoActions({ ahead: 0, upstream: null, remote: null }), []);
    assert.deepEqual(repoActions({ detached: true, remote: "origin" }), ["fetch"]);
});

test("Git idle loaded panel makes only backstop reads", async () => {
    const root = "/tmp/git-harness-idle";
    const ctx = context(root);
    let reads = 0;
    ctx.exec = async (cmd: string) => {
        reads++;
        return { code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" };
    };
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    try {
        const { view, cx, timers } = await load("jig-git");
        await flush();
        reads = 0;
        const ticks = timers.filter((t: any) => t.ms === 1000);
        for (let i = 0; i < 120; i++) {
            clock += 1000;
            for (const tick of ticks) tick.fn(cx);
            await flush(2);
        }
        assert.equal(reads, 2, `120 s idle should make only the 60 s and 120 s backstop reads, made ${reads}`);
    } finally {
        Date.now = realNow;
    }
});

test("Git preview props pre-open a repo and pre-fill the filter", async () => {
    const root = "/tmp/git-harness-props";
    const ctx = context(root);
    ctx.exec = async (cmd: string) => ({ code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" });
    const { view, cx } = await load("jig-git", { open: ["orders-api"], filter: "billing" });
    await flush();
    assert.equal(view.filter, "billing");
    assert.equal(view.opened.has(`${root}/orders-api`), true);
    assert.equal(view.view.states.changed[0].name, "billing-web");
    view.render(cx);
});

test("stage click flips at once and re-reads only that checkout", async () => {
    const root = "/tmp/git-harness-stage";
    const ctx = context(root);
    const calls: { cmd: string; args: string[] }[] = [];
    ctx.exec = async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" };
    };
    const { view, cx } = await load("jig-git");
    await flush();
    calls.length = 0;
    const repo = view.repos[0];
    const file = repo.files[0];
    view.stageClick(cx, repo, file, true);
    assert.equal(view.repos[0].files.find((f: any) => f.path === file.path).staged, true);
    await flush();
    const git = calls.filter((c) => c.cmd === "git");
    const scans = calls.filter((c) => c.cmd === "sh");
    assert.equal(git.length, 1);
    assert.equal(scans.length, 1);
    assert.equal(scans[0].args.at(-1), repo.path);
    assert.equal(
        calls.some((c) => c.args.includes("sleep")),
        false,
    );
});

test("Git starts a context read from render without waiting for tick", async () => {
    const root = "/tmp/git-harness-a";
    const ctx = context(root);
    let reads = 0;
    ctx.exec = async (cmd: string) => {
        if (cmd === "sh") reads++;
        return { code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" };
    };
    const { view, cx, timers } = await load("jig-git");
    await flush();
    reads = 0;
    ctx.folder = "/tmp/git-harness-b";
    ctx.focused = { pane: "p", cwd: ctx.folder, terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: ctx.folder }];
    for (let i = 0; i < 5; i++) view.render(cx);
    const kicks = timers.filter((t: any) => t.ms === 0);
    assert.equal(kicks.length, 1, "five renders before the timer fire schedule one read");
    kicks[0].fn(cx);
    await flush();
    assert.equal(reads, 1, "exactly one context read starts without a tick");
});

test("two trigger refreshes with identical output do not notify", async () => {
    const root = "/tmp/git-harness-same";
    const ctx = context(root);
    ctx.exec = async (cmd: string) => ({ code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" });
    const { view, cx, notifies } = await load("jig-git");
    view.refresh(cx, false, false);
    await flush();
    for (let i = 0; i < 100 && !view.loaded; i++) await flush(1);
    assert.equal(view.loaded, true);
    view.lastRead = { targets: view.visibleTargets(), stdout: scan(root) };
    notifies.count = 0;
    view.refresh(cx, false, false);
    await flush();
    assert.equal(notifies.count, 0, "first identical trigger read does not notify");
    notifies.count = 0;
    view.refresh(cx, false, false);
    await flush();
    assert.equal(notifies.count, 0, "second identical trigger read does not notify");
});

test("a same-output read after an error clears it", async () => {
    const root = "/tmp/git-harness-error-same";
    const ctx = context(root);
    ctx.exec = async (cmd: string) => ({ code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" });
    const { view, cx } = await load("jig-git");
    await flush();
    view.error = "old error";
    view.lastRead = { targets: "", stdout: scan(root) };
    view.refresh(cx, false, true);
    await flush();
    assert.equal(view.error, null);
    assert.equal(view.loaded, true);
});

test("follow toggle with the same root ends the skeleton", async () => {
    const root = "/tmp/git-harness-follow";
    const ctx = context(root);
    ctx.exec = async (cmd: string) => ({ code: 0, stdout: cmd === "sh" ? scan(root) : "", stderr: "" });
    const { view, cx, timers } = await load("jig-git");
    await flush();
    view.setFollow(false, cx);
    view.render(cx);
    const kick = timers.find((t: any) => t.ms === 0);
    assert.ok(kick);
    kick.fn(cx);
    await flush();
    assert.equal(view.loadedContext, view.context);
    assert.equal(view.loaded, true);
});

test("a context switch never passes the old rows' target list", async () => {
    const a = "/tmp/git-harness-switch-a";
    const b = "/tmp/git-harness-switch-b";
    const ctx = context(a);
    const calls: string[][] = [];
    ctx.exec = async (cmd: string, args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: cmd === "sh" ? scanFor(ctx.folder, args[4] ?? "") : "", stderr: "" };
    };
    const { view, cx, timers } = await load("jig-git");
    for (let i = 0; i < 100 && !view.loaded; i++) await flush(1);
    assert.equal(view.repos[0].path.startsWith(a), true);
    ctx.folder = b;
    ctx.focused = { pane: "p", cwd: b, terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: b }];
    for (let i = 0; i < 5; i++) view.render(cx);
    const kick = timers.find((t: any) => t.ms === 0);
    assert.ok(kick);
    kick.fn(cx);
    await flush();
    assert.equal(
        view.repos.every((repo: any) => repo.path.startsWith(b)),
        true,
    );
    assert.equal(
        view.repos.some((repo: any) => repo.path.startsWith(a)),
        false,
    );
    const last = calls.filter((args) => args[1] !== undefined).at(-1);
    assert.equal(last?.at(-1), "");
});
