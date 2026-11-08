// Every file path a mod's JS names under mods/<mod>/ must exist in the source. Runtime-written files are listed here;
// the test failed on main when jig-keep-awake.ps1 was renamed away from keep-awake.ps1.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME = [/^config\.json$/, /\.helper\.json$/, /\.stop$/];

test("every source file named by a mod exists", () => {
    const failures: string[] = [];
    for (const mod of readdirSync(path.join(ROOT, "mods"), { withFileTypes: true })) {
        if (!mod.isDirectory()) continue;
        const dir = path.join(ROOT, "mods", mod.name);
        const files = (folder: string, prefix = ""): string[] =>
            readdirSync(folder).flatMap((name) => {
                const full = path.join(folder, name);
                return statSync(full).isDirectory() ? files(full, path.join(prefix, name)) : [path.join(prefix, name)];
            });
        for (const relative of files(dir)) {
            if (!relative.endsWith(".js")) continue;
            const name = relative;
            const text = readFileSync(path.join(dir, relative), "utf8");
            for (const match of text.matchAll(/mods\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)/g)) {
                const [, namedMod, file] = match;
                if (!namedMod || !file) continue;
                if (!existsSync(path.join(ROOT, "mods", namedMod))) continue; // a shipped mod
                if (RUNTIME.some((pattern) => pattern.test(file))) continue;
                if (!existsSync(path.join(ROOT, "mods", namedMod, file)))
                    failures.push(`${mod.name}/${name}: mods/${namedMod}/${file}`);
            }
        }
    }
    assert.deepEqual(failures, []);
});
