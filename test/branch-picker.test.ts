import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support.ts";

type Lib = Record<string, any>;

const branches = [
    { name: "feature/PROJ-1234", remote: false, current: true },
    { name: "feature/PROJ-12345", remote: false, current: false },
    { name: "fix/PROJ-1234-old", remote: false, current: false, inUse: "PROJ-9" },
    { name: "PROJ-1234", remote: false, current: false },
    { name: "feature/PROJ-9999", remote: true, current: false },
    { name: "zzz/PROJ-1234", remote: true, current: false },
];

test("Repos filters exact, prefix, last segment prefix, then substring, locals before origin-only", async () => {
    const { filterBranches } = await load<Lib>("mods/jig-repos/lib.js");
    assert.deepEqual(
        filterBranches(branches, "proj-1234").map((b: any) => b.name),
        ["PROJ-1234", "feature/PROJ-1234", "feature/PROJ-12345", "fix/PROJ-1234-old", "zzz/PROJ-1234"],
    );
    assert.deepEqual(
        filterBranches(branches, "feature").map((b: any) => b.name),
        ["feature/PROJ-1234", "feature/PROJ-12345", "feature/PROJ-9999"],
    );
    assert.deepEqual(
        filterBranches(branches, "1234-old").map((b: any) => b.name),
        ["fix/PROJ-1234-old"],
    );
    assert.deepEqual(filterBranches(branches, ""), branches);
});

test("Repos active defaults to the best pickable row, skips current/in-use, and clamps", async () => {
    const { defaultActive, moveActive, branchKey } = await load<Lib>("mods/jig-repos/lib.js");
    assert.equal(defaultActive(branches, ""), branchKey(branches[1]));
    assert.equal(defaultActive(branches, "proj-1234"), branchKey(branches[3]));
    let active = defaultActive(branches, "");
    active = moveActive(branches, "", active, -1);
    assert.equal(active, branchKey(branches[1]), "up at the first pickable row clamps");
    active = moveActive(branches, "", active, 1);
    assert.equal(active, branchKey(branches[3]));
    assert.equal(moveActive(branches, "no-such-branch", active, 1), null);
    assert.equal(defaultActive(branches, "no-such-branch"), null, "Enter has nothing to pick");
    assert.equal(defaultActive(branches, "PROJ-1234"), branchKey(branches[3]), "a filter resets the active row");
});

test("History uses the same ranking and keys, with current ticked", async () => {
    const { filterBranches, branchKey, moveBranch } = await load<Lib>("mods/jig-history/lib.js");
    assert.deepEqual(
        filterBranches(branches, "proj-1234", "feature/PROJ-1234").map((b: any) => [b.name, b.current]),
        [
            ["PROJ-1234", false],
            ["feature/PROJ-1234", true],
            ["feature/PROJ-12345", false],
            ["fix/PROJ-1234-old", false],
            ["zzz/PROJ-1234", false],
            ["feature/PROJ-9999", false],
        ].filter(([name]) => name.includes("PROJ-1234")),
    );
    assert.equal(moveBranch(branches, branchKey(branches[0]), 1), branchKey(branches[1]));
    assert.equal(moveBranch(branches, branchKey(branches[0]), -1), branchKey(branches[0]));
});

test("locals stay before an exact origin-only match, and down reaches it last", async () => {
    const repos = await load<Lib>("mods/jig-repos/lib.js");
    const history = await load<Lib>("mods/jig-history/lib.js");
    const rows = [
        { name: "feature/PROJ-1234", remote: false, current: false },
        { name: "PROJ-1234", remote: true, current: false },
    ];
    assert.deepEqual(
        repos.filterBranches(rows, "PROJ-1234").map((b: any) => b.name),
        ["feature/PROJ-1234", "PROJ-1234"],
    );
    assert.equal(repos.defaultActive(rows, "PROJ-1234"), repos.branchKey(rows[0]));
    assert.equal(
        repos.moveActive(rows, "PROJ-1234", repos.defaultActive(rows, "PROJ-1234"), 1),
        repos.branchKey(rows[1]),
    );
    assert.deepEqual(
        history.filterBranches(rows, "PROJ-1234", null).map((b: any) => b.name),
        ["feature/PROJ-1234", "PROJ-1234"],
    );
});
