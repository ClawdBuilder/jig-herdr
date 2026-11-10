import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};
const repoScan =
    "@@root /r\n@@repo /r/app\n@@git /r/app/.git\t/r/app/.git\n@@remote origin\n@@head abc1234\x1fmain\x1f1700000000\n## main\n M a.ts\n=1\n";

test("a reread moves a comment with its quoted line, then marks it outdated", async () => {
    const ctx: any = (globalThis as any).__CTX ?? {};
    (globalThis as any).__CTX = ctx;
    ctx.folder = "/r";
    ctx.focused = { pane: "p", cwd: "/r", terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: "/r" }];
    ctx.agents = [];
    ctx.shared = {};
    ctx.exec = async (cmd: string) => ({ code: 0, stdout: cmd === "sh" ? repoScan : "", stderr: "" });
    const { view } = await load("jig-review");
    await flush();
    view.files = [{ path: "a.ts", xy: " M", staged: false }];
    view.sel = "a.ts";
    view.loaded = true;
    view.view = "working";
    view.mode = "working";
    view.comments = [{ id: "c1", file: "a.ts", side: "new", startLine: 2, endLine: 2, quote: ["two"], note: "keep" }];
    const diff = (lines: string[]) => {
        view.diffLines = async () => lines;
    };
    diff(["@@ -1,2 +1,2 @@", " one", " two"]);
    await view.loadRows();
    assert.equal(view.comments[0].rowStart, 2);
    assert.equal(view.comments[0].outdated, false);

    diff(["@@ -1,3 +1,3 @@", " zero", " one", " two"]);
    await view.loadRows();
    assert.equal(view.comments[0].rowStart, 3);
    assert.equal(view.comments[0].outdated, false);

    diff(["@@ -1,2 +1,2 @@", " one", " three"]);
    await view.loadRows();
    assert.equal(view.comments[0].outdated, true);
});
