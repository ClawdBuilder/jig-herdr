import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const files = [
    "README.md",
    "AGENTS.md",
    ...readdirSync(path.join(ROOT, "docs")).map((name) => `docs/${name}`),
    ...readdirSync(path.join(ROOT, "gallery")).flatMap((id) => {
        const file = `gallery/${id}/RECIPE.md`;
        return existsSync(path.join(ROOT, file)) ? [file] : [];
    }),
];

test("every relative Markdown link and image resolves", () => {
    const failures: string[] = [];
    for (const file of files) {
        const text = readFileSync(path.join(ROOT, file), "utf8");
        for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
            const target = match[1];
            if (/^(?:https?:|mailto:|#)/.test(target)) continue;
            const rel = target.split("#")[0];
            if (rel === "") continue;
            const resolved = path.resolve(path.dirname(path.join(ROOT, file)), decodeURIComponent(rel));
            if (!existsSync(resolved)) failures.push(`${file}: ${target}`);
        }
    }
    assert.deepEqual(failures, []);
});
