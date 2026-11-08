// The commit email guard skips without the private list and fails on a match when one is supplied.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/check-commit-emails.mjs", import.meta.url).pathname;

test("commit emails: no private list skips", () => {
    const result = execFileSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, JIG_SCAN_WORDS: "/definitely/missing", JIG_COMMIT_RANGE: "HEAD^..HEAD" },
    });
    assert.match(result, /skipped \(no private word list\)/);
});

test("commit emails: a matching private word fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-emails-"));
    try {
        const list = join(dir, "scan-words.txt");
        writeFileSync(list, "example\n");
        assert.throws(
            () =>
                execFileSync(process.execPath, [script], {
                    encoding: "utf8",
                    env: { ...process.env, JIG_SCAN_WORDS: list, JIG_COMMIT_RANGE: "HEAD^..HEAD" },
                }),
            (error: unknown) => (error as { status?: number }).status === 1,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
