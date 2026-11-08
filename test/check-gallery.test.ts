// A focused check of the gallery validator's stray-file and recipe rules.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildShare } from "../scripts/build-share.ts";

const root = path.resolve(import.meta.dirname, "..");

test("check-gallery refuses a stray top-level file and a malformed recipe", () => {
    const out = mkdtempSync(path.join(tmpdir(), "jig-gallery-rules-"));
    try {
        buildShare(out);
        writeFileSync(path.join(out, "stray.txt"), "x");
        assert.throws(() =>
            execFileSync(process.execPath, [path.join(root, "scripts", "check-gallery.mjs"), out], { stdio: "pipe" }),
        );
        rmSync(path.join(out, "stray.txt"));
        writeFileSync(path.join(out, "jig-repos", "RECIPE.md"), "# Repos\n\nTODO\n");
        assert.throws(() =>
            execFileSync(process.execPath, [path.join(root, "scripts", "check-gallery.mjs"), out], { stdio: "pipe" }),
        );
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});
