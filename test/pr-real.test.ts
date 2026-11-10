// The real PR & CI mod path: a four-repo demo where main has no PR and three branches have merged PRs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support/context-harness.mjs";

const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};
const URL = "https://github.com/ClawdBuilder/jig-herdr.git";
const scan = [
    `/tmp/jig-herdr-pr-demo/jig-herdr\tmain\t${URL}\tmain\torigin/main`,
    `/tmp/jig-herdr-pr-demo/jig-herdr-git-main-checkouts\tfeat/git-main-checkouts\t${URL}\tmain\t`,
    `/tmp/jig-herdr-pr-demo/jig-herdr-kit-prs-history\tfeat/kit-prs-history\t${URL}\tmain\t`,
    `/tmp/jig-herdr-pr-demo/jig-herdr-listings-after-kit\tdocs/listings-after-kit\t${URL}\tmain\t`,
].join("\n");

test("PR & CI through the harness: main is No PR and merged branches are not parked", async () => {
    const ctx: any = (globalThis as any).__CTX ?? {};
    (globalThis as any).__CTX = ctx;
    ctx.folder = "/tmp/jig-herdr-pr-demo";
    ctx.focused = { pane: "p", cwd: ctx.folder, terminal: "t3z", space: "s" };
    ctx.panes = [{ pane: "p", cwd: ctx.folder }];
    ctx.agents = [];
    ctx.shared = undefined;
    ctx.exec = async (cmd: string, args: string[]) => {
        if (cmd === "sh" && args[3] === "gh") {
            const head = args[args.indexOf("--head") + 1];
            const state = "MERGED";
            return {
                code: 0,
                stdout: JSON.stringify([
                    {
                        number: head === "feat/git-main-checkouts" ? 33 : head === "feat/kit-prs-history" ? 34 : 35,
                        title: head,
                        url: `https://github.com/ClawdBuilder/jig-herdr/pull/33`,
                        state,
                        headRefName: head,
                        updatedAt: "2026-11-10T12:00:00Z",
                    },
                ]),
                stderr: "",
            };
        }
        if (cmd === "sh") return { code: 0, stdout: scan, stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
    };
    const { view } = await load("jig-prs");
    await flush();
    await flush();
    const repos = view.data.main.repos;
    assert.deepEqual(
        repos.map((r: any) => r.status),
        ["nopr", "merged", "merged", "merged"],
    );
    assert.equal(repos.filter((r: any) => r.status === "parked").length, 0);
});

test("the kit opens folded groups only when no group is unfolded", async () => {
    const { groupOpen } = await import("../mods/jig-prs/panel-kit.js?group");
    assert.equal(groupOpen(false, 0), true);
    assert.equal(groupOpen(false, 1), false);
    assert.equal(groupOpen(true, 1), true);
});
