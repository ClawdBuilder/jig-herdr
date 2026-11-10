import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SCRIPT as NEW, parseRepos } from "../mods/jig-git/lib.js";

const OLD = readFileSync(new URL("fixtures/git-scan-old.sh", import.meta.url), "utf8");
const sh = (script: string, root: string) =>
    execFileSync("sh", ["-c", script, "sh", root], { encoding: "utf8", timeout: 30_000 });
const parsed = (script: string, root: string) => parseRepos(sh(script, root), root);
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Scan", "-c", "user.email=scan@example.com", ...args], {
        cwd,
        encoding: "utf8",
    });
const same = (root: string) => assert.deepEqual(parsed(NEW, root), parsed(OLD, root));

test("the new scan parses exactly like the frozen old one", (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "jig-scan-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of ["one", "two"]) {
        const dir = path.join(root, name);
        mkdirSync(path.join(dir, "src"), { recursive: true });
        git(dir, "init", "-q", "-b", "main");
        writeFileSync(path.join(dir, "src/index.js"), "export const a = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "seed");
        git(dir, "init", "--bare", "-q", path.join(root, `${name}.git`));
        git(dir, "remote", "add", "origin", path.join(root, `${name}.git`));
        git(dir, "push", "-q", "-u", "origin", "main");
        if (name === "two") {
            git(dir, "switch", "-qc", "feature/x");
            writeFileSync(path.join(dir, "src/feature.js"), "export const b = 2;\n");
            git(dir, "add", "-A");
            git(dir, "commit", "-qm", "feature");
        }
        writeFileSync(path.join(dir, "untracked.txt"), "x\n");
        writeFileSync(path.join(dir, "src/index.js"), "export const a = 2;\n");
    }
    same(root);
});

test("the new scan parses the demo repositories exactly like the old one", (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "jig-scan-demo-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync("sh", [path.join(import.meta.dirname, "../scripts/demo-repos.sh")], {
        env: { ...process.env, JIG_DEMO_ROOT: root },
        timeout: 30_000,
    });
    same(root);
});
