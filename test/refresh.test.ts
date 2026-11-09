import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
    timedCommand,
} from "../mods/jig-repos/refresh.js";

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

test("timedCommand runs without timeout or gtimeout", () => {
    const [program, args] = timedCommand("/bin/echo", ["portable"]);
    const output = execFileSync("/bin/sh", args, { encoding: "utf8", env: { PATH: "/definitely/missing" } });
    assert.equal(output.trim(), "portable");
});

test("every panel calls the shared refresh helper, with no inline copy", () => {
    const root = new URL("../mods/", import.meta.url);
    for (const mod of ["jig-repos", "jig-history", "jig-prs", "jig-worktrees"]) {
        const source = readFileSync(new URL(`${mod}/main.js`, root), "utf8");
        assert.match(source, /from "\.\/refresh\.js"/, `${mod}: import`);
        assert.match(source, /this\.refreshState = new RefreshState\(\)/, `${mod}: state`);
        assert.match(source, /this\.refreshState\.start\(/, `${mod}: start`);
        assert.match(source, /this\.refreshState\.busy/, `${mod}: busy`);
        assert.match(source, /new RefreshScheduler\(/, `${mod}: scheduler`);
        assert.match(source, /this\.refreshScheduler\.trigger\(/, `${mod}: trigger`);
        assert.match(source, /this\.refreshScheduler\.due\(/, `${mod}: due`);
        assert.match(source, /refreshSeconds\(this\.config/, `${mod}: config`);
        assert.match(source, /timeout|timedCommand|runCommand/, `${mod}: shell timeout`);
        assert.match(source, /refreshState\.finish\(\)/, `${mod}: finish`);
        const finish = source.indexOf("refreshState.finish()");
        assert.ok(source.indexOf("refreshScheduler.trigger()", finish) > finish, `${mod}: queued trigger`);
        assert.doesNotMatch(source, /EVERY\s*=\s*5000|BUSY_AFTER_MS|setTimeout\([^)]*400/, `${mod}: inline timer`);
    }
});

test("every panel starts its first read from the constructor, not the timer", () => {
    const root = new URL("../mods/", import.meta.url);
    for (const mod of ["jig-repos", "jig-history", "jig-prs", "jig-worktrees"]) {
        const source = readFileSync(new URL(`${mod}/main.js`, root), "utf8");
        assert.match(source, /this\.initialRead\(cx\);/, `${mod}: constructor call`);
        assert.match(source, /initialRead\(cx\)\s*\{[\s\S]*?cx\.spawn\(/, `${mod}: spawn`);
        assert.match(source, /this\.seen = true;/, `${mod}: no second shown trigger`);
    }
});

test("every panel starts its first read from the constructor, not the timer", () => {
    const root = new URL("../mods/", import.meta.url);
    const source = readFileSync(new URL("jig-repos/refresh.js", root), "utf8");
    const mods = readdirSync(root).filter((mod) => {
        try {
            return readFileSync(new URL(`${mod}/refresh.js`, root)).length > 0;
        } catch {
            return false;
        }
    });
    for (const mod of mods)
        assert.equal(
            readFileSync(new URL(`${mod}/refresh.js`, root), "utf8"),
            source,
            `${mod}/refresh.js is the odd one out`,
        );
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

test("run passes env, a shell timeout and a later Herdr timeout, and recognises 124", async () => {
    const { run } = await import("../mods/jig-repos/refresh.js");
    const calls: Array<{ args: string[]; options: any }> = [];
    const fake = async (_cmd: string, args: string[], options: any) => {
        calls.push({ args, options });
        return { code: 0, stdout: "", stderr: "" };
    };
    const result = await run(fake, "git", ["status"], { on: "box", seconds: 60, env: { FOO: "bar" } });
    assert.equal(result.timedOut, false);
    assert.equal(result.cmd, "git");
    assert.equal(calls[0].options.timeout, 65000);
    assert.match(calls[0].args[1], /export GIT_TERMINAL_PROMPT='0'/);
    assert.match(calls[0].args[1], /export GH_PROMPT_DISABLED='1'/);
    assert.match(calls[0].args[1], /export FOO='bar'/);
    assert.match(calls[0].args[1], /timeout 60/);
    assert.deepEqual(calls[0].args.slice(-2), ["git", "status"]);
    const timed = await run(async () => ({ code: 124, stdout: "", stderr: "" }), "git", ["fetch"]);
    assert.equal(timed.timedOut, true);
    const rejected = await run(
        async () => {
            throw new Error("exec timed out");
        },
        "git",
        ["fetch"],
    );
    assert.equal(rejected.code, 124);
    assert.equal(rejected.timedOut, true);
});

test("friendlyError maps timeout, no repo, missing tools and gh classes", async () => {
    const { friendlyError } = await import("../mods/jig-repos/refresh.js");
    assert.equal(
        friendlyError({ code: 124, seconds: 60 }),
        "Reading took too long and was stopped (60 s). Check the connection, or try in a terminal.",
    );
    assert.equal(
        friendlyError({ stderr: "fatal: not a git repository (or any of the parent directories)" }, { follow: true }),
        "No git repo in this folder. Open a terminal in one, or switch to Space.",
    );
    assert.equal(friendlyError({ code: 127, cmd: "git" }), "git isn't installed on this machine.");
    assert.equal(
        friendlyError({ code: 127, cmd: "gh" }),
        "The GitHub CLI (gh) isn't installed here. Install it, then run gh auth login.",
    );
    assert.equal(friendlyError({ code: 127, cmd: "rg" }), "rg isn't installed on this machine.");
    assert.equal(
        friendlyError({ cmd: "git", stderr: "fatal: repository 'https://github.com/x/y' not found" }),
        "fatal: repository 'https://github.com/x/y' not found",
    );
    assert.equal(
        friendlyError({ cmd: "git", stderr: "ssh: connect to host example.com port 22: Connection timed out" }),
        "Network error: ssh: connect to host example.com port 22: Connection timed out",
    );
    assert.equal(
        friendlyError({ cmd: "git", stderr: "fatal: Authentication failed for 'https://example.com/x/y'" }),
        "Sign-in to the remote failed. Check your credentials in a terminal.",
    );
    assert.equal(
        friendlyError({ cmd: "gh", stderr: "gh auth login required" }),
        "gh is not logged in on this machine (run gh auth login).",
    );
    assert.equal(
        friendlyError({ cmd: "gh", stderr: "API rate limit exceeded" }),
        "GitHub rate limit reached; try again later.",
    );
    assert.match(friendlyError({ stderr: "could not resolve host: github.com" }), /^Network error: /);
    assert.equal(friendlyError({ stderr: "fatal: bad revision" }), "fatal: bad revision");
});

test("parseRefreshConfig has a 15 s minimum and no maximum", async () => {
    const { parseRefreshConfig } = await import("../mods/jig-repos/refresh.js");
    assert.deepEqual(parseRefreshConfig('{ "refreshSeconds": 10 }', 60).seconds, 15);
    assert.match(parseRefreshConfig('{ "refreshSeconds": 10 }', 60).problems[0], /15/);
    assert.equal(parseRefreshConfig('{ "refreshSeconds": 1000000 }', 60).seconds, 1000000);
    assert.equal(parseRefreshConfig("{", 60).seconds, 60);
    assert.match(parseRefreshConfig("{", 60).problems[0], /not valid JSON/);
});
