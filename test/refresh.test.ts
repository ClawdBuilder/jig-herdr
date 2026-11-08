import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    BUSY_AFTER_MS,
    DEBOUNCE_MS,
    focusRegained,
    MIN_REFRESH_SECONDS,
    RefreshScheduler,
    RefreshState,
    refreshSeconds,
    terminalFinished,
} from "../mods/repo-changes/refresh.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a background refresh never shows its busy state", () => {
    const state = new RefreshState();
    let notices = 0;
    assert.equal(state.start(), true);
    assert.equal(state.busy, false);
    state.tick(Date.now() + BUSY_AFTER_MS + 50, () => notices++);
    assert.equal(state.busy, false);
    assert.equal(notices, 0);
    assert.equal(state.finish(), false);
});

test("a user refresh shows busy only after the delay", () => {
    const state = new RefreshState();
    state.start({ user: true });
    assert.equal(state.busy, false);
    state.tick(state.startedAt + BUSY_AFTER_MS - 1);
    assert.equal(state.busy, false);
    state.tick(state.startedAt + BUSY_AFTER_MS);
    assert.equal(state.busy, true);
    state.finish();
    assert.equal(state.busy, false);
});

test("a user refresh shorter than the delay never shows busy", () => {
    const state = new RefreshState();
    state.start({ user: true });
    state.tick(state.startedAt + BUSY_AFTER_MS / 2);
    assert.equal(state.busy, false);
    state.finish();
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
        assert.match(source, /new RefreshScheduler\(/, `${mod}: scheduler`);
        assert.match(source, /this\.refreshScheduler\.trigger\(/, `${mod}: trigger`);
        assert.match(source, /this\.refreshScheduler\.due\(/, `${mod}: due`);
        assert.match(source, /refreshSeconds\(this\.config/, `${mod}: config`);
        assert.match(source, /timeout/, `${mod}: shell timeout`);
        assert.match(source, /refreshState\.finish\(\)/, `${mod}: finish`);
        const finish = source.indexOf("refreshState.finish()");
        assert.ok(source.indexOf("refreshScheduler.trigger()", finish) > finish, `${mod}: queued trigger`);
        assert.doesNotMatch(source, /EVERY\s*=\s*5000|BUSY_AFTER_MS|setTimeout\([^)]*400/, `${mod}: inline timer`);
    }
});

test("every panel starts its first read from the constructor, not the timer", () => {
    const root = new URL("../mods/", import.meta.url);
    for (const mod of ["repo-changes", "repo-history", "repo-prs", "repo-worktrees"]) {
        const source = readFileSync(new URL(`${mod}/main.js`, root), "utf8");
        assert.match(source, /this\.initialRead\(cx\);/, `${mod}: constructor call`);
        assert.match(source, /initialRead\(cx\)\s*\{[\s\S]*?cx\.spawn\(/, `${mod}: spawn`);
        assert.match(source, /this\.seen = true;/, `${mod}: no second shown trigger`);
    }
});

test("every panel starts its first read from the constructor, not the timer", () => {
    const root = new URL("../mods/", import.meta.url);
    const source = readFileSync(new URL("repo-changes/refresh.js", root), "utf8");
    for (const mod of [
        "repo-history",
        "repo-prs",
        "repo-worktrees",
        "jig-work",
        "jig-context",
        "jig-files",
        "file-view",
    ])
        assert.equal(readFileSync(new URL(`${mod}/refresh.js`, root), "utf8"), source, mod);
});

test("no sweep happens without a trigger before the backstop, and the backstop sweeps once", () => {
    const now = 0;
    const scheduler = new RefreshScheduler({ seconds: 60, now: () => now });
    assert.equal(scheduler.due(59_000), false);
    assert.equal(scheduler.due(60_000), true);
    scheduler.sweep(60_000);
    assert.equal(scheduler.due(119_000), false);
});

test("a burst of five triggers inside the debounce makes one sweep", () => {
    const now = 0;
    const scheduler = new RefreshScheduler({ seconds: 60, now: () => now });
    for (const at of [0, 100, 200, 300, 400]) scheduler.trigger(at);
    assert.equal(scheduler.due(DEBOUNCE_MS - 1), false);
    assert.equal(scheduler.due(DEBOUNCE_MS), true);
    scheduler.sweep(DEBOUNCE_MS);
    assert.equal(scheduler.due(DEBOUNCE_MS + 1), false);
});

test("a terminal outside the folder is ignored; one inside that goes working to idle or done sweeps", () => {
    const outside = [{ address: "other", cwd: "/elsewhere", status: "working" }];
    assert.equal(terminalFinished(outside, [{ address: "other", cwd: "/elsewhere", status: "idle" }], "/repo"), false);
    const inside = [{ address: "here", cwd: "/repo/worktree", status: "working" }];
    assert.equal(terminalFinished(inside, [{ address: "here", cwd: "/repo/worktree", status: "idle" }], "/repo"), true);
    assert.equal(terminalFinished(inside, [{ address: "here", cwd: "/repo/worktree", status: "done" }], "/repo"), true);
    assert.equal(
        terminalFinished(
            [{ address: "here", cwd: "/repo", status: "working" }],
            [{ address: "here", cwd: "/repo", status: "blocked" }],
            "/repo",
        ),
        false,
    );
});

test("focus regained is one trigger", () => {
    assert.equal(focusRegained(false, true), true);
    assert.equal(focusRegained(true, true), false);
    assert.equal(focusRegained(true, false), false);
});

test("refreshSeconds clamps at 15 and reads the config object", () => {
    assert.equal(refreshSeconds(9), MIN_REFRESH_SECONDS);
    assert.equal(refreshSeconds({ refreshSeconds: 20 }), 20);
    assert.equal(refreshSeconds({}), 60);
    assert.equal(refreshSeconds({ refreshSeconds: 1 }, 180), 15);
});
