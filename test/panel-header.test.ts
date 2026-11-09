import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const HERDR = path.resolve(import.meta.dirname, "..");
const mods = path.join(HERDR, "mods");
const source = (file: string) => readFileSync(file, "utf8");

test("every panel-header.js is byte-identical, and every copy is imported", () => {
    const reference = path.join(mods, "jig-git/panel-header.js");
    const expected = source(reference);
    const users = readdirSync(mods).filter((mod) => existsSync(path.join(mods, mod, "panel-header.js")));
    assert.ok(users.length >= 5);
    for (const mod of users)
        assert.equal(source(path.join(mods, mod, "panel-header.js")), expected, `${mod}/panel-header.js differs`);
    for (const mod of readdirSync(mods)) {
        const main = path.join(mods, mod, "main.js");
        if (!existsSync(main)) continue;
        if (!source(main).includes('from "./panel-header.js"'))
            assert.equal(
                existsSync(path.join(mods, mod, "panel-header.js")),
                false,
                `${mod}/panel-header.js is unused`,
            );
    }
});

test("the header constants and readAgo match the spec", async () => {
    const text = source(path.join(mods, "jig-git/panel-header.js"));
    for (const line of ["HEADER_HEIGHT = 42", "ROW_HEIGHT = 24", "ROW_FONT = 11.5", "META_FONT = 10.5"])
        assert.match(text, new RegExp(line), line);
    const { readAgo } = await import(`../mods/jig-git/refresh.js`);
    assert.equal(readAgo(10_000, 0), "");
    assert.equal(readAgo(14_000, 10_000), "just now");
    assert.equal(readAgo(75_000, 10_000), "1m");
    assert.equal(readAgo(10_000 + 3 * 3_600_000, 10_000), "3h");
    assert.equal(readAgo(10_000 + 2 * 86_400_000, 10_000), "2d");
});

test("only the five header panels import panelHeader; Files and File view do not", () => {
    for (const mod of ["jig-git", "jig-history", "jig-prs", "jig-worktrees", "jig-review"])
        assert.match(source(path.join(mods, mod, "main.js")), /panelHeader\(/, mod);
    for (const mod of ["jig-files", "jig-file-view"]) {
        const text = source(path.join(mods, mod, "main.js"));
        assert.doesNotMatch(text, /panelHeader\(/, mod);
        assert.doesNotMatch(text, /panel-refresh|onRefresh:/, mod);
    }
});

test("follow is only on Repos, History, PR & CI and Worktrees", () => {
    for (const mod of ["jig-git", "jig-history", "jig-prs", "jig-worktrees"])
        assert.match(source(path.join(mods, mod, "main.js")), /follow:/, mod);
    for (const mod of ["jig-review", "jig-files", "jig-file-view"])
        assert.doesNotMatch(source(path.join(mods, mod, "main.js")), /follow:/, mod);
});

test("PR & CI puts its tabs in the header's lead slot", () => {
    const pr = source(path.join(mods, "jig-prs/main.js"));
    assert.match(pr, /lead: h_flex\(\)[\s\S]{0,200}tabChip\("main"/);
    assert.doesNotMatch(pr, /extra: \[tabChip/);
    assert.match(source(path.join(mods, "jig-prs/panel-header.js")), /lead !== undefined/);
});
