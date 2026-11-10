import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support.ts";

type Lib = Record<string, any>;

test("the review message asks for the work, names the repo and uses old/new ranges", async () => {
    const { buildReviewMessage } = await load<Lib>("mods/jig-review/lib.js");
    assert.equal(
        buildReviewMessage({
            repo: "/work/app",
            scope: "working changes",
            comments: [
                {
                    file: "src/a.ts",
                    side: "new",
                    startLine: 12,
                    endLine: 14,
                    quote: ["const a = 1;", "const b = 2;"],
                    note: "Use one name.",
                },
                {
                    file: "src/b.ts",
                    side: "old",
                    startLine: 8,
                    endLine: 9,
                    quote: ["old();"],
                    note: "This was needed.",
                },
                {
                    file: "src/c.ts",
                    side: "new",
                    startLine: 3,
                    endLine: 3,
                    quote: ["gone();"],
                    note: "Check this.",
                    outdated: true,
                },
            ],
        }),
        "Please address these review comments on app (working changes). Each quotes the lines it is about; reply with what you changed.\nRepository: /work/app\n\nsrc/a.ts:12–14\n> const a = 1;\n> const b = 2;\nNote: Use one name.\n\nsrc/b.ts (removed lines 8–9)\n> old();\nNote: This was needed.\n\nsrc/c.ts:3 (outdated)\n> gone();\nNote: Check this.",
    );
});

test("comments are stored per repo and scope, parsed defensively, and added or removed by id", async () => {
    const { commentsKey, parseComments, addComment, removeComment, commentsInFile } =
        await load<Lib>("mods/jig-review/lib.js");
    assert.equal(commentsKey("/w", "branch:main"), "review.comments|/w|branch:main");
    assert.deepEqual(parseComments("not json"), []);
    assert.deepEqual(parseComments(JSON.stringify({ nope: true })), []);
    const valid = { id: "1", file: "a.ts", side: "new", startLine: 1, endLine: 1, quote: ["x"], note: "x" };
    const list = addComment(parseComments(JSON.stringify([valid, { bad: true }])), {
        ...valid,
        id: "2",
        file: "b.ts",
    });
    assert.deepEqual(
        list.map((c: any) => c.id),
        ["1", "2"],
    );
    assert.deepEqual(
        commentsInFile(list, "a.ts").map((c: any) => c.id),
        ["1"],
    );
    assert.deepEqual(
        removeComment(list, "1").map((c: any) => c.id),
        ["2"],
    );
});

test("comments follow their quote when lines shift and go outdated when the quote is gone", async () => {
    const { placeComments } = await load<Lib>("mods/jig-review/lib.js");
    const rows = [
        { kind: "+", number: 1, text: "one" },
        { kind: "+", number: 2, text: "two" },
        { kind: "-", number: 8, text: "old" },
        { kind: " ", number: 3, text: "three" },
    ];
    const comment = { file: "a", side: "new", startLine: 2, endLine: 2, quote: ["two"], note: "n" };
    const shifted = placeComments([comment], [{ kind: " ", number: 1, text: "zero" }, ...rows]);
    assert.equal(shifted[0].outdated, false);
    assert.equal(shifted[0].rowStart, 2);
    const deleted = placeComments([{ ...comment, side: "old", startLine: 8, endLine: 8, quote: ["old"] }], rows);
    assert.equal(deleted[0].outdated, false);
    assert.equal(deleted[0].rowStart, 2);
    const gone = placeComments([{ ...comment, quote: ["missing"] }], rows);
    assert.equal(gone[0].outdated, true);
});
test("comments are stored per repo and scope, parsed defensively, and added or removed by id", async () => {
    const { commentsKey, parseComments, addComment, removeComment, commentsInFile } =
        await load<Lib>("mods/jig-review/lib.js");
    assert.equal(commentsKey("/w", "branch:main"), "review.comments|/w|branch:main");
    assert.deepEqual(parseComments("not json"), []);
    assert.deepEqual(parseComments(JSON.stringify({ nope: true })), []);
    const valid = {
        id: "1",
        file: "a.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        quote: ["x"],
        note: "x",
    };
    const list = addComment(parseComments(JSON.stringify([valid, { bad: true }])), {
        ...valid,
        id: "2",
        file: "b.ts",
    });
    assert.deepEqual(
        list.map((c: any) => c.id),
        ["1", "2"],
    );
    assert.deepEqual(
        commentsInFile(list, "a.ts").map((c: any) => c.id),
        ["1"],
    );
    assert.deepEqual(
        removeComment(list, "1").map((c: any) => c.id),
        ["2"],
    );
});

test("Review stacks and splits its toolbar at the side-panel widths", async () => {
    const { reviewLayout } = await load<Lib>("mods/jig-review/lib.js");
    assert.deepEqual(reviewLayout(0), { stacked: false, toolbarRows: false, listHeight: 240 });
    assert.equal(reviewLayout(379).stacked, true);
    assert.equal(reviewLayout(479).toolbarRows, true);
    assert.equal(reviewLayout(480).toolbarRows, false);
    assert.equal(reviewLayout(639).stacked, true);
    assert.equal(reviewLayout(640).stacked, false);
});
