// The screenshot demo data is deterministic and has the branches, worktree and file states the panels need.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("demo-repos makes the four repos, branches and worktree with fixed identities", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-demo-test-"));
    try {
        execFileSync("sh", [path.join(root, "scripts", "demo-repos.sh")], {
            env: { ...process.env, JIG_DEMO_ROOT: dir },
            stdio: "pipe",
        });
        for (const name of ["orders-api", "billing-web", "docs-site", "notifications-svc", "orders-api-worktree"]) {
            assert.ok(existsSync(path.join(dir, name)), name);
        }
        const branch = execFileSync("git", ["-C", path.join(dir, "orders-api"), "branch", "--show-current"], {
            encoding: "utf8",
        }).trim();
        assert.equal(branch, "feature/PROJ-123");
        const log = execFileSync("git", ["-C", path.join(dir, "orders-api"), "log", "-1", "--format=%an <%ae>"], {
            encoding: "utf8",
        }).trim();
        assert.equal(log, "Demo Dev <demo@example.com>");
        const status = execFileSync("git", ["-C", path.join(dir, "orders-api"), "status", "--short"], {
            encoding: "utf8",
        });
        assert.match(status, /^A {2}staged\.txt/m);
        assert.match(status, /^\?\? scratch\.txt/m);
        assert.match(
            execFileSync("git", ["-C", path.join(dir, "billing-web"), "status", "-sb"], { encoding: "utf8" }),
            /behind 1/,
        );
        assert.match(
            execFileSync("git", ["-C", path.join(dir, "orders-api-worktree"), "rev-parse", "--show-toplevel"], {
                encoding: "utf8",
            }),
            /orders-api-worktree/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
