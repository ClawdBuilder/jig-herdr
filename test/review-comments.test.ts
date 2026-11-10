import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support.ts";

type Lib = Record<string, any>;

test("the review message names the repo, scope, file, range, quoted lines and note", async () => {
    const { buildReviewMessage } = await load<Lib>("mods/jig-review/lib.js");
    assert.equal(
        buildReviewMessage({
            repo: "/work/app",
            scope: "working changes",
            comments: [
                {
                    file: "src/a.ts",
                    startLine: 12,
                    endLine: 14,
                    quote: ["const a = 1;", "const b = 2;"],
                    note: "Use one name.",
                },
                { file: "src/b.ts", startLine: 3, endLine: 3, quote: ["return;"], note: "Early return." },
            ],
        }),
        "Review comments for /work/app\nScope: working changes\n\nsrc/a.ts:12–14\n> const a = 1;\n> const b = 2;\nNote: Use one name.\n\nsrc/b.ts:3\n> return;\nNote: Early return.",
    );
});

test("comments are stored per repo and scope, parsed defensively, and added or removed by id", async () => {
    const { commentsKey, parseComments, addComment, removeComment, commentsInFile } =
        await load<Lib>("mods/jig-review/lib.js");
    assert.equal(commentsKey("/w", "branch:main"), "review.comments|/w|branch:main");
    assert.deepEqual(parseComments("not json"), []);
    assert.deepEqual(parseComments(JSON.stringify({ nope: true })), []);
    const valid = { id: "1", file: "a.ts", rowStart: 1, rowEnd: 1, note: "x" };
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
