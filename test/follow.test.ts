import assert from "node:assert/strict";
import { test } from "node:test";
import { readFollow, writeFollow } from "../mods/repo-changes/follow-state.js";

test("the follow choice is per space and defaults to Terminal", () => {
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    assert.equal(readFollow("s1"), true);
    writeFollow("s1", false);
    assert.equal(readFollow("s1"), false);
    assert.equal(readFollow("s2"), true);
});

import { readFileSync } from "node:fs";

test("every panel carries the same checked copy of the follow helper", () => {
    const root = new URL("../mods/", import.meta.url);
    const source = readFileSync(new URL("repo-changes/follow.js", root), "utf8");
    for (const mod of ["repo-history", "repo-prs", "repo-worktrees"])
        assert.equal(readFileSync(new URL(`${mod}/follow.js`, root), "utf8"), source, mod);
});
