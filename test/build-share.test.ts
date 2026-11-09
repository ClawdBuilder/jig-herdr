// The generated share tree has the gallery's shape and --check notices a stale file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildShare, compareShare } from "../scripts/build-share.ts";

const root = path.resolve(import.meta.dirname, "..");

test("build-share writes every listing with its recipe, preview, mods and licenses", () => {
    const out = mkdtempSync(path.join(tmpdir(), "jig-share-test-"));
    try {
        buildShare(out);
        for (const id of [
            "jig-workbench",
            "jig-git",
            "jig-history",
            "jig-prs",
            "jig-worktrees",
            "jig-review",
            "jig-keep-awake",
        ]) {
            assert.ok(existsSync(path.join(out, id, "RECIPE.md")), id);
            assert.ok(existsSync(path.join(out, id, "preview.png")), id);
            assert.ok(existsSync(path.join(out, id, "LICENSE")), id);
        }
        assert.ok(existsSync(path.join(out, "jig-workbench", "layouts", "jig-workbench.json")));
        assert.ok(existsSync(path.join(out, "jig-workbench", "mods", "jig-files", "main.js")));
        assert.ok(existsSync(path.join(out, "jig-workbench", "LICENSE-APACHE")));
        assert.match(readFileSync(path.join(out, "jig-workbench", "NOTICE"), "utf8"), /Herdr authors/);
        assert.ok(!existsSync(path.join(out, "jig-workbench", "mods", "jig-files", "gpui-kit.d.ts")));
        assert.deepEqual(compareShare(out, out), []);
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});

test("--check fails when a generated file is stale", () => {
    const out = mkdtempSync(path.join(tmpdir(), "jig-share-check-"));
    try {
        buildShare(out);
        const recipe = path.join(out, "jig-git", "RECIPE.md");
        writeFileSync(recipe, `${readFileSync(recipe, "utf8")}stale\n`);
        assert.ok(compareShare(out, out).length === 0);
        // compareShare is called by the CLI as (fresh, share): a changed share file is the difference.
        const fresh = mkdtempSync(path.join(tmpdir(), "jig-share-fresh-"));
        try {
            buildShare(fresh);
            assert.deepEqual(compareShare(fresh, out), ["changed jig-git/RECIPE.md"]);
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});

test("check-gallery accepts the built tree and refuses a broken listing", () => {
    const out = mkdtempSync(path.join(tmpdir(), "jig-gallery-test-"));
    try {
        buildShare(out);
        execFileSync(process.execPath, [path.join(root, "scripts", "check-gallery.mjs"), out], {
            timeout: 30_000,
            stdio: "pipe",
        });
        rmSync(path.join(out, "jig-git", "RECIPE.md"));
        assert.throws(() =>
            execFileSync(process.execPath, [path.join(root, "scripts", "check-gallery.mjs"), out], {
                timeout: 30_000,
                stdio: "pipe",
            }),
        );
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});
