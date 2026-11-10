// The screenshot demo data is deterministic in shape: four authors, 15 orders-api commits with a tag and merges, ages
// relative to the run, and a clean merged worktree the Worktrees panel can mark ready.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const AUTHORS = [
    "Maya Chen <maya.chen@example.com>",
    "Leo Park <leo.park@example.com>",
    "Sam Rivera <sam.rivera@example.com>",
    "Priya Nair <priya.nair@example.com>",
];

test("demo-repos makes the four repos, branches, relative history and ready worktree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-demo-test-"));
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", path.join(dir, "orders-api"), ...args], {
            timeout: 30_000,
            encoding: "utf8",
        }).trim();
    try {
        execFileSync("sh", [path.join(root, "scripts", "demo-repos.sh")], {
            timeout: 30_000,
            env: { ...process.env, JIG_DEMO_ROOT: dir },
            stdio: "pipe",
        });
        for (const name of [
            "orders-api",
            "billing-web",
            "docs-site",
            "notifications-svc",
            "orders-api-worktree",
            "orders-api-ready",
        ])
            assert.ok(existsSync(path.join(dir, name)), name);

        assert.equal(git("branch", "--show-current"), "feature/PROJ-123");
        assert.equal(git("rev-list", "--all", "--count"), "15");
        assert.equal(git("tag", "--list", "v1.2.0"), "v1.2.0");
        assert.equal(git("rev-list", "--all", "--merges", "--count"), "2");

        const authors = new Set(git("log", "--all", "--format=%an <%ae>").split("\n"));
        assert.deepEqual([...authors].sort(), [...AUTHORS].sort());

        const rows = git("rev-list", "--all", "--timestamp", "--parents").split("\n");
        const when = new Map(
            rows.map((line) => line.split(" ").slice(1, 2).concat(line.split(" ")[0]) as [string, string]),
        );
        for (const line of rows) {
            const [seconds, , ...parents] = line.split(" ");
            for (const parent of parents)
                assert.ok(Number(when.get(parent)) <= Number(seconds), `${line}: child older than ${parent}`);
        }
        const dates = rows.map((line) => Number(line.split(" ")[0]));
        const now = Math.floor(Date.now() / 1000);
        assert.ok(now - Math.max(...dates) < 6 * 3600, "newest commit is recent");
        assert.ok(now - Math.min(...dates) > 10 * 86400, "oldest commit is old");

        const status = execFileSync("git", ["-C", path.join(dir, "orders-api"), "status", "--short"], {
            timeout: 30_000,
            encoding: "utf8",
        });
        assert.match(status, /^A {2}staged\.txt/m);
        assert.match(status, /^\?\? scratch\.txt/m);
        assert.match(status, /^ M src\/index\.js/m);
        assert.match(
            execFileSync("git", ["-C", path.join(dir, "billing-web"), "status", "-sb"], {
                timeout: 30_000,
                encoding: "utf8",
            }),
            /behind 1/,
        );
        assert.match(
            execFileSync("git", ["-C", path.join(dir, "notifications-svc"), "status", "-sb"], {
                timeout: 30_000,
                encoding: "utf8",
            }),
            /ahead 1/,
        );
        assert.equal(
            execFileSync("git", ["-C", path.join(dir, "orders-api-ready"), "status", "--porcelain"], {
                timeout: 30_000,
                encoding: "utf8",
            }),
            "",
        );
        assert.equal(git("merge-base", "--is-ancestor", "feature/orders-ready", "origin/main"), "");
        assert.match(
            git("rev-parse", "--abbrev-ref", "feature/orders-ready@{upstream}"),
            /^origin\/feature\/orders-ready$/,
        );
        assert.match(
            execFileSync("git", ["-C", path.join(dir, "orders-api-worktree"), "rev-parse", "--show-toplevel"], {
                timeout: 30_000,
                encoding: "utf8",
            }),
            /orders-api-worktree/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
