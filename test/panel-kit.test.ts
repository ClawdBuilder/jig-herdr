// The kit's copies stay byte-identical; the grouping helpers stay pure and testable without Herdr.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { load } from "./support.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const mods = path.join(ROOT, "mods");

test("every panel-kit.js is byte-identical and imported", () => {
    const files = readdirSync(mods).flatMap((mod) => {
        try {
            return [{ mod, text: readFileSync(path.join(mods, mod, "panel-kit.js"), "utf8") }];
        } catch {
            return [];
        }
    });
    assert.equal(files.length, 3);
    for (const file of files) {
        assert.equal(file.text, files[0].text, `${file.mod}/panel-kit.js differs`);
        assert.match(readFileSync(path.join(mods, file.mod, "main.js"), "utf8"), /from "\.\/panel-kit\.js"/, file.mod);
    }
});

test("Git groups a checkout into needs, changed, ahead or clean", async () => {
    const { groupCheckouts } = await load<{ groupCheckouts(repos: any[]): Record<string, any[]> }>(
        "mods/jig-git/lib.js",
    );
    const groups = groupCheckouts([
        { path: "needs", files: [{ status: "U" }] },
        { path: "changed", files: [{ status: "M" }] },
        { path: "ahead", files: [], ahead: 1 },
        { path: "detached", files: [], detached: true, ahead: 1 },
        { path: "clean", files: [] },
    ]);
    assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((r) => r.path)])), {
        needs: ["needs"],
        changed: ["changed"],
        ahead: ["ahead"],
        clean: ["detached", "clean"],
    });
});

test("Worktrees separates ready, in progress and main", async () => {
    const { groupWorktrees } = await load<{ groupWorktrees(rows: any[]): Record<string, any[]> }>(
        "mods/jig-worktrees/lib.js",
    );
    const groups = groupWorktrees([
        { path: "/r", main: "/r" },
        { path: "/r/a", main: "/r", ready: true },
        { path: "/r/b", main: "/r", ready: false },
    ]);
    assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((r) => r.path)])), {
        ready: ["/r/a"],
        progress: ["/r/b"],
        main: ["/r"],
    });
});

test("Git render maps the cached view and does not regroup", () => {
    const source = readFileSync(path.join(mods, "jig-git/main.js"), "utf8");
    const render = source.slice(source.indexOf("render(cx) {"));
    assert.doesNotMatch(render, /groupRepos\(|groupCheckouts\(/);
    assert.match(source, /rebuildView\(\)/);
    assert.match(source, /this\.view\.states/);
});

test("detail reasons match the ahead group: only arrows or not published", async () => {
    const { checkoutDetail, groupCheckouts } = await load<Record<string, any>>("mods/jig-git/lib.js");
    const repo = (extra: any) => ({ path: "/w/r", name: "r", branch: "feature/X", files: [], total: 0, ...extra });
    const ahead = repo({ upstream: "origin/X", ahead: 2 });
    assert.equal(checkoutDetail(ahead), "feature/X · ↑2");
    assert.deepEqual(
        groupCheckouts([ahead]).ahead.map((r: any) => r.path),
        ["/w/r"],
    );
    assert.equal(checkoutDetail(repo({ upstream: "origin/X", behind: 3 })), "feature/X · ↓3");
    assert.equal(checkoutDetail(repo({ upstream: "origin/X", ahead: 1, behind: 2 })), "feature/X · ↑1 ↓2");
    const unpublished = repo({ upstream: null, base: { count: 2 } });
    assert.equal(checkoutDetail(unpublished), "feature/X · not published");
    assert.equal(groupCheckouts([unpublished]).ahead.length, 1);
    const quiet = repo({ upstream: null, base: null });
    assert.equal(checkoutDetail(quiet), "feature/X · no upstream");
    assert.equal(groupCheckouts([quiet]).clean.length, 1);
    const detached = repo({ detached: true, branch: "(detached)", upstream: null, base: { count: 2 } });
    assert.equal(checkoutDetail(detached), "detached");
    assert.equal(groupCheckouts([detached]).clean.length, 1);
});

test("two same-named repositories get their shortest parent tag", async () => {
    const { disambiguators } = await load<Record<string, any>>("mods/jig-git/lib.js");
    const tags = disambiguators([
        { path: "/w/apps/orders-web", name: "orders-web" },
        { path: "/w/old/orders-web", name: "orders-web" },
    ]);
    assert.equal(tags.get("/w/apps/orders-web"), "apps");
    assert.equal(tags.get("/w/old/orders-web"), "old");
});

test("a changed context shows the skeleton; same-key refreshes keep rows and old reads are dropped", async () => {
    const { viewForContext } = await load<Record<string, any>>("mods/jig-git/lib.js");
    const rows = [{ path: "/old" }];
    assert.deepEqual(viewForContext("new", "old", rows), { rows: [], pending: true });
    assert.deepEqual(viewForContext("same", "same", rows), { rows, pending: false });
    assert.deepEqual(viewForContext("new", "other", rows), { rows: [], pending: true });
    assert.deepEqual(viewForContext("new", "old", rows, { error: "boom" }), { rows: [], pending: false, error: true });
    assert.deepEqual(viewForContext("same", "same", rows, { error: "boom" }), { rows, pending: false, error: true });
    assert.deepEqual(viewForContext("new", "old", rows, { noFolder: true }), {
        rows: [],
        pending: false,
        noFolder: true,
    });
    assert.deepEqual(viewForContext("same", "same", []), { rows: [], pending: false });
});

test("the context key includes machine, folder and follow mode", async () => {
    const { contextKeyOf } = await load<Record<string, any>>("mods/jig-git/lib.js");
    const base = { root: "/w/a", on: null, follow: true };
    assert.equal(contextKeyOf(base), contextKeyOf({ ...base }));
    assert.notEqual(contextKeyOf(base), contextKeyOf({ ...base, root: "/w/b" }));
    assert.notEqual(contextKeyOf(base), contextKeyOf({ ...base, on: "box" }));
    assert.notEqual(contextKeyOf(base), contextKeyOf({ ...base, follow: false }));
});

test("a foldable group opens when it is the only group", () => {
    const source = readFileSync(path.join(mods, "jig-git/panel-kit.js"), "utf8");
    assert.match(source, /export function groupOpen\(open, groupCount\) \{\s*return groupCount <= 1 \|\| open;/);
});
