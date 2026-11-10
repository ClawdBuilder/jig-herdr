import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

const flush = async (n = 8) => {
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

for (const [mod, tickMs] of [
    ["jig-prs", 1000],
    ["jig-history", 1000],
    ["jig-review", 500],
    ["jig-worktrees", 1000],
] as const) {
    test(`${mod}: a hidden loaded panel makes no exec calls`, async () => {
        const ctx = context(`/tmp/idle-${mod}`);
        let calls = 0;
        ctx.exec = async () => {
            calls++;
            return { code: 0, stdout: "", stderr: "" };
        };
        const { cx, timers } = await load(mod);
        await flush();
        calls = 0;
        const ticks = timers.filter((timer: any) => timer.ms === tickMs);
        const seconds = 180;
        for (let i = 0; i < (seconds * 1000) / tickMs; i++) {
            for (const tick of ticks) tick.fn(cx);
            await flush(2);
        }
        assert.equal(calls, 0, `${mod} made ${calls} exec calls while hidden`);
    });
}

for (const [mod, tickMs, expected] of [
    ["jig-prs", 1000, 1],
    ["jig-history", 1000, 2],
    ["jig-review", 500, 36],
    ["jig-worktrees", 1000, 3],
] as const) {
    test(`${mod}: a shown idle panel makes only its backstop reads`, async () => {
        const ctx = context(`/tmp/shown-${mod}`);
        ctx.shown = mod;
        let calls = 0;
        ctx.exec = async () => {
            calls++;
            return { code: 0, stdout: "", stderr: "" };
        };
        const realNow = Date.now;
        let clock = 1_800_000_000_000;
        Date.now = () => clock;
        try {
            const { cx, timers } = await load(mod);
            await flush(20);
            calls = 0;
            const ticks = timers.filter((timer: any) => timer.ms === tickMs);
            for (let i = 0; i <= 180_000 / tickMs; i++) {
                clock += tickMs;
                for (const tick of ticks) tick.fn(cx);
                await flush(1);
            }
            assert.equal(calls, expected, `${mod} made ${calls} exec calls while shown`);
        } finally {
            Date.now = realNow;
        }
    });
}
