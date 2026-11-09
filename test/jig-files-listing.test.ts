// The Files listing path the Step 3 build broke: listDirectory is a lib function with the runner passed in, and this test
// runs the real POSIX script over a temp folder instead of stubbing the listing away.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { load } from "./support.ts";

type Entry = { name: string; dir: boolean };
type Lib = {
    FIND: string;
    listDirectory(
        path: string,
        on: string | null,
        run: (cmd: string, args: string[], opts: unknown) => Promise<{ code: number; stdout: string; stderr: string }>,
        platform?: string | null,
    ): Promise<Entry[]>;
};

const temp = (t: TestContext) => {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-listing-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

test("listDirectory lists a real temp folder, with no view bound to it", async (t) => {
    const root = temp(t);
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(root, "README.md"), "# hi\n");
    writeFileSync(path.join(root, ".hidden"), "x\n");
    const lib = await load<Lib>("mods/jig-files/lib.js");
    const run = async (cmd: string, args: string[]) => {
        try {
            return { code: 0, stdout: execFileSync(cmd, args, { timeout: 30_000, encoding: "utf8" }), stderr: "" };
        } catch (e) {
            const err = e as { status?: number; stdout?: string; stderr?: string };
            return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: String(err.stderr ?? e) };
        }
    };
    const entries = await lib.listDirectory(root, null, run);
    const byName = new Map(entries.map((e) => [e.name, e.dir]));
    assert.equal(byName.get("src"), true);
    assert.equal(byName.get("README.md"), false);
    assert.equal(byName.get(".hidden"), false);
    assert.equal(byName.has(".git"), false, "the git folder is skipped");
    // A missing folder is an error, not an empty listing.
    await assert.rejects(lib.listDirectory(path.join(root, "nope"), null, run), /Cannot list this folder/);
});

test("the filter's find has a short timeout inside its script", async () => {
    const lib = await load<Lib>("mods/jig-files/lib.js");
    assert.match(lib.FIND, /timeout 10 find/);
    execFileSync("sh", ["-n", "-c", lib.FIND], { timeout: 30_000, encoding: "utf8" });
});

test("the find script runs when timeout and gtimeout are absent", async (t) => {
    const root = temp(t);
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    symlinkSync("/usr/bin/find", path.join(bin, "find"));
    symlinkSync("/usr/bin/head", path.join(bin, "head"));
    writeFileSync(path.join(root, "kept.txt"), "x");
    const lib = await load<Lib>("mods/jig-files/lib.js");
    const output = execFileSync("/bin/sh", ["-c", lib.FIND, "sh", root], {
        timeout: 30_000,
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
    });
    assert.match(output, /kept\.txt/);
});
