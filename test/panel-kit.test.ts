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
