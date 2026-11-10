// A loose render bench: catches accidental quadratic work, not machine speed. The ceiling is deliberately far above the
// measured milliseconds so a slow CI runner does not flake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const CEILING_MS = 25;
for (const name of ["jig-worktrees", "jig-review", "jig-history", "jig-prs", "jig-keep-awake"]) {
    test(`${name}: render stays under the loose bench ceiling`, () => {
        const result = spawnSync(process.execPath, ["test/support/evaluate-one.mjs", name], {
            cwd: new URL("..", import.meta.url),
            encoding: "utf8",
            env: { ...process.env, JIG_BENCH: "1" },
        });
        assert.equal(result.status, 0, result.stderr);
        const line = result.stdout.split("\n").find((line) => line.startsWith(`BENCH ${name} `));
        assert.ok(line, result.stdout);
        const ms = Number(line.split(" ").pop());
        assert.ok(Number.isFinite(ms), line);
        assert.ok(ms < CEILING_MS, `${name}: ${ms.toFixed(2)} ms`);
    });
}

test("a context switch drops old rows and shows pending until the matching read lands", async () => {
    const { contextKeyOf, viewForContext } = await import("../mods/jig-worktrees/lib.js");
    const a = { root: "/a", on: null, follow: true };
    const b = { root: "/b", on: null, follow: true };
    const ka = contextKeyOf(a),
        kb = contextKeyOf(b);
    assert.equal(viewForContext(ka, ka, ["a"]).rows.length, 1);
    assert.equal(viewForContext(kb, ka, ["a"]).pending, true);
    assert.equal(viewForContext(kb, ka, ["a"]).rows.length, 0);
    assert.equal(viewForContext(ka, ka, ["a"]).rows[0], "a");
});

test("jig-git: 50 rows and one open 200-file repo stay bounded", () => {
    const result = spawnSync(process.execPath, ["test/support/evaluate-one.mjs", "jig-git"], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, JIG_BENCH: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((line) => line.startsWith("BENCHEL jig-git "));
    assert.ok(line, result.stdout);
    const calls = Number(line.split(" ").pop());
    assert.ok(calls > 0);
    assert.ok(calls < 5200, `jig-git: ${calls} element calls per render`);
});
