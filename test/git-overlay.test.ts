import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFile } from "./support/overlay-harness.mjs";

const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};
const state = (dirty: number) => `@@top /r
@@current main
@@ref refs/heads/main\t/r
@@ref refs/remotes/origin/feature\t
@@originhead origin/main
@@has-main
@@dirty ${dirty}
`;

test("a refused switch renders its reason in the picker", async () => {
    const ctx: any = (globalThis as any).__CTX ?? {};
    (globalThis as any).__CTX = ctx;
    ctx.folder = "/r";
    ctx.focused = { pane: "p", cwd: "/r", terminal: "t", space: "s" };
    ctx.panes = [{ pane: "p", cwd: "/r" }];
    ctx.agents = [];
    ctx.shared = {};
    ctx.exec = async (cmd: string, args: string[]) => ({ code: 0, stdout: cmd === "sh" ? state(1) : "", stderr: "" });
    const { view, cx } = await loadFile("jig-git/picker.js", { overlay: {}, picker: { path: "/r", name: "r" } });
    await flush();
    assert.match(String(view.warning), /1 file with uncommitted changes/);
    const feature = view.branches.find((b: any) => b.remote);
    view.pick(cx, feature);
    await flush();
    assert.match(String(view.message), /uncommitted changes/);
    view.render(cx);
});
