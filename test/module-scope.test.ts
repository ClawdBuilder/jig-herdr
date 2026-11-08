// Herdr 0.1.14 shares a module instance between copies. Keep module scope pure: no top-level let/var and no host call
// while the module is being evaluated; instance state and host calls belong in init/constructor.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Source-level guard: top-level code is the unindented part of these formatted mods. */
export function moduleScopeProblems(file: string, text: string): string[] {
    const problems: string[] = [];
    const host = new Set<string>();
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']herdr["']/g))
        for (const part of (match[1] ?? "").split(","))
            for (const name of part.trim().split(/\s+as\s+/)) if (name) host.add(name);
    host.add("localStorage");
    for (const line of text.split("\n")) {
        if (/^\s/.test(line) || /^\s*(?:\/\/|\*|\/\*)/.test(line)) continue; // inside a class, function, object or comment
        if (/^(?:export\s+)?(?:let|var)\b/.test(line)) {
            problems.push(`${file}: top-level ${line.startsWith("var") ? "var" : "let"}`);
            continue;
        }
        if (/^(?:import|export)\b/.test(line)) continue; // bindings, not calls
        if (line.includes("=>")) continue; // a module-scope function value; its body runs when called
        for (const name of host) {
            if (new RegExp(`\\b${name.replace(/\W/g, "\\$&")}\\s*[.(]`).test(line))
                problems.push(`${file}: top-level ${name}() call`);
        }
    }
    return [...new Set(problems)];
}

test("mods keep no mutable or host-calling state at module scope", () => {
    const failures: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js"))
                failures.push(...moduleScopeProblems(full, readFileSync(full, "utf8")));
        }
    };
    walk(path.join(ROOT, "mods"));
    assert.deepEqual(failures, []);
});

test("the guard rejects a scratch top-level let and host call", () => {
    assert.deepEqual(moduleScopeProblems("scratch.js", "let x = 1;\n"), ["scratch.js: top-level let"]);
    assert.deepEqual(moduleScopeProblems("scratch.js", "var x = 1;\n"), ["scratch.js: top-level var"]);
    assert.deepEqual(moduleScopeProblems("scratch.js", 'import { spaces } from "herdr";\nspaces();\n'), [
        "scratch.js: top-level spaces() call",
    ]);
    assert.deepEqual(moduleScopeProblems("scratch.js", 'localStorage.getItem("x");\n'), [
        "scratch.js: top-level localStorage() call",
    ]);
});
