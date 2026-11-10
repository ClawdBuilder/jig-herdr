// A small static check: every method on a panel's View must be reachable from init/render/tick/close.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODS = ["jig-git", "jig-prs", "jig-history", "jig-review", "jig-worktrees"];
const ENTRY = new Set(["init", "render", "tick", "close"]);

const BUILTINS = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "JSON",
    "Math",
    "Promise",
    "Date",
    "Error",
    "RegExp",
    "Set",
    "Map",
]);
function classText(text: string) {
    const at = text.lastIndexOf("export default class");
    return at < 0 ? text : text.slice(at);
}
function methods(text: string) {
    const names = new Set<string>();
    for (const line of classText(text).split("\n")) {
        const found = /^    (?:async )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
        if (found && found[1] !== "constructor" && !BUILTINS.has(found[1])) names.add(found[1]);
    }
    return names;
}
function references(text: string, name: string) {
    return new RegExp(`this\\.${name}\\b`).test(text);
}
function unreachable(text: string) {
    const names = methods(text);
    const seen = new Set([...ENTRY].filter((name) => names.has(name)));
    const queue = [...seen];
    while (queue.length) {
        const name = queue.pop()!;
        for (const other of names) {
            if (!seen.has(other) && references(text, other)) {
                seen.add(other);
                queue.push(other);
            }
        }
    }
    return [...names].filter((name) => !seen.has(name)).sort();
}

test("Git has no unreachable View methods", () => {
    const text = readFileSync(path.join(ROOT, "mods", "jig-git", "main.js"), "utf8");
    assert.deepEqual(unreachable(text), []);
});

test("the other panels' reachability report", () => {
    const report = Object.fromEntries(
        MODS.filter((mod) => mod !== "jig-git").map((mod) => {
            const text = readFileSync(path.join(ROOT, "mods", mod, "main.js"), "utf8");
            return [mod, unreachable(text)];
        }),
    );
    console.log(JSON.stringify(report));
});
