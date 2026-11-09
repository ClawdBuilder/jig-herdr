// The main git panel is jig-git. Only CHANGELOG history and the installer's RENAMED chain may mention the old name.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP = new Set([".git", "node_modules", "share"]);
const OLD = "jig-" + "repos";

test(`no ${OLD} name survives outside CHANGELOG and the installer rename table`, () => {
    const failures: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name !== "CHANGELOG.md") {
                const text = readFileSync(full, "utf8");
                for (const [i, line] of text.split("\n").entries()) {
                    if (!line.includes(OLD)) continue;
                    if (full === path.join(ROOT, "scripts/install.ts") && line.includes(`["${OLD}", "jig-git"]`))
                        continue;
                    failures.push(`${path.relative(ROOT, full)}:${i + 1}`);
                }
            }
        }
    };
    walk(ROOT);
    assert.deepEqual(failures, []);
});
