import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUSY_AFTER_MS, RefreshState } from "../mods/repo-changes/refresh.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a background refresh never shows its busy state", async () => {
    const state = new RefreshState();
    let notices = 0;
    assert.equal(state.start({ notify: () => notices++ }), true);
    assert.equal(state.busy, false);
    await wait(BUSY_AFTER_MS + 50);
    assert.equal(state.busy, false);
    assert.equal(notices, 0);
    assert.equal(state.finish(), false);
});

test("a user refresh shows busy only after the delay", async () => {
    const state = new RefreshState();
    state.start({ user: true });
    assert.equal(state.busy, false);
    await wait(BUSY_AFTER_MS - 100);
    assert.equal(state.busy, false);
    await wait(150);
    assert.equal(state.busy, true);
    state.finish();
    assert.equal(state.busy, false);
});

test("a user refresh shorter than the delay never shows busy", async () => {
    const state = new RefreshState();
    state.start({ user: true });
    await wait(BUSY_AFTER_MS / 2);
    assert.equal(state.busy, false);
    state.finish();
    await wait(BUSY_AFTER_MS);
    assert.equal(state.busy, false);
});

test("a click during a refresh queues exactly one more run", () => {
    const state = new RefreshState();
    state.start({ user: true });
    assert.equal(state.start({ user: true }), false);
    assert.equal(state.start({ user: true }), false);
    assert.equal(state.finish(), true);
    assert.equal(state.finish(), false);
});

test("every panel calls the shared refresh helper, with no inline copy", () => {
    const root = new URL("../mods/", import.meta.url);
    for (const mod of ["repo-changes", "repo-history", "repo-prs", "repo-worktrees"]) {
        const source = readFileSync(new URL(`${mod}/main.js`, root), "utf8");
        assert.match(source, /from "\.\/refresh\.js"/, `${mod}: import`);
        assert.match(source, /this\.refreshState = new RefreshState\(\)/, `${mod}: state`);
        assert.match(source, /this\.refreshState\.start\(/, `${mod}: start`);
        assert.match(source, /this\.refreshState\.busy/, `${mod}: busy`);
        assert.doesNotMatch(source, /BUSY_AFTER_MS|setTimeout\([^)]*400/, `${mod}: inline delay`);
    }
});

test("every panel carries the same checked copy of the refresh helper", () => {
    const root = new URL("../mods/", import.meta.url);
    const source = readFileSync(new URL("repo-changes/refresh.js", root), "utf8");
    for (const mod of ["repo-history", "repo-prs", "repo-worktrees"])
        assert.equal(readFileSync(new URL(`${mod}/refresh.js`, root), "utf8"), source, mod);
});
