import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedBranches, PICKER_ROW_CAP, visibleBranches } from "../mods/jig-git/lib.js";

test("the picker caps 1,000 origin matches at 50 rows", () => {
    const branches = Array.from({ length: 1000 }, (_, i) => ({
        name: `feature/thing-${i}`,
        remote: true,
        current: false,
        inUse: null,
    }));
    assert.equal(visibleBranches(branches, "thing").length, 1000);
    assert.equal(cappedBranches(branches, "thing").length, PICKER_ROW_CAP);
    assert.equal(PICKER_ROW_CAP, 50);
});

test("locals stay ahead of origin in the capped rows", () => {
    const branches = [
        { name: "feature/local", remote: false, current: false, inUse: null },
        ...Array.from({ length: 200 }, (_, i) => ({
            name: `feature/r-${i}`,
            remote: true,
            current: false,
            inUse: null,
        })),
    ];
    const rows = cappedBranches(branches, "feature");
    assert.equal(rows[0].name, "feature/local");
    assert.equal(rows.length, 50);
});
