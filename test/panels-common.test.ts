// Shared groundwork of the Work, Context, Files and jig-file-view panels: the one session reader both session panels use, its
// cheap mtime check, and the config parsing of the new refreshSeconds setting. No Herdr needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { load } from "./support.ts";

type Sessions = {
    SCRIPT: string;
    MTIMES: string;
    READ: string;
    parseSessions(text: string): { file: string; alive: boolean; status: Record<string, unknown> }[];
    parseMtimes(text: string): Record<string, number>;
    changedSince(previous: Record<string, number>, next: Record<string, number>): string[];
    mergeSessions(previous: { file: string }[], incoming: { file: string }[], present: string[]): { file: string }[];
    terminalStateChanged(
        previous: { address: string; status: string }[],
        current: { address: string; status: string }[],
        address: string | null,
    ): boolean;
};

type Config = { refreshSeconds: number; problems: string[] };
type FilesLib = {
    FIND: string;
    parseConfig(text: string | null): Config;
    deletedPaths(status: string, root: string): string[];
    filterPaths(stdout: string, root: string, query: string, limit?: number): string[];
};
type ViewLib = {
    parseConfig(text: string | null): Config;
    splitPath(p: string): { name: string; dir: string };
    wrapDefault(p: string, stored?: string | null): boolean;
    isMarkdown(p: string): boolean;
};

function temp(t: TestContext): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-herdr-common-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const status = (id: string) =>
    JSON.stringify({ schema: 1, session: id, status: "busy", updatedAt: "2026-01-02T10:00:00.000Z" });

test("Work and Context share one session reader (the same file), and its three scripts are real shell", async () => {
    const work = await load<Sessions>("mods/jig-work/sessions.js");
    const ctx = await load<Sessions>("mods/jig-context/sessions.js");
    const root = new URL("../mods/", import.meta.url);
    assert.equal(
        readFileSync(new URL("jig-context/sessions.js", root), "utf8"),
        readFileSync(new URL("jig-work/sessions.js", root), "utf8"),
        "identical copies",
    );
    for (const script of [work.SCRIPT, work.MTIMES, work.READ]) {
        execFileSync("sh", ["-n", "-c", script], { encoding: "utf8" });
    }
    assert.equal(work.SCRIPT, ctx.SCRIPT);
});

test("the mtime check finds only the files that moved, and merges their sessions", async (t) => {
    const { MTIMES, READ, SCRIPT, parseSessions, parseMtimes, changedSince, mergeSessions, terminalStateChanged } =
        await load<Sessions>("mods/jig-work/sessions.js");
    const root = temp(t);
    const dir = path.join(root, "sessions");
    const sh = (script: string, ...args: string[]) =>
        execFileSync("sh", ["-c", script, "sh", ...args], { encoding: "utf8" });
    // the scripts want a state folder; make one with two session files
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(path.join(dir, "a.json"), status("a"));
    writeFileSync(path.join(dir, "b.json"), status("b"));
    const first = sh(MTIMES, root);
    const mtimes = parseMtimes(first);
    assert.deepEqual(Object.keys(mtimes).sort(), [path.join(dir, "a.json"), path.join(dir, "b.json")].sort());
    assert.deepEqual(changedSince({}, mtimes).length, 2);
    assert.deepEqual(changedSince(mtimes, mtimes), []);
    // a changed body reads through READ, and the merge keeps the other session
    writeFileSync(path.join(dir, "a.json"), status("a2"));
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(dir, "a.json"), later, later);
    const changed = changedSince(mtimes, parseMtimes(sh(MTIMES, root)));
    assert.deepEqual(changed, [path.join(dir, "a.json")]);
    const read = parseSessions(sh(READ, ...changed));
    assert.equal(read.length, 1);
    assert.equal(read[0].status.session, "a2");
    const merged = mergeSessions([{ file: path.join(dir, "a.json") }, { file: path.join(dir, "b.json") }], read, [
        path.join(dir, "a.json"),
        path.join(dir, "b.json"),
    ]);
    assert.deepEqual(merged.map((s) => s.file).sort(), [path.join(dir, "a.json"), path.join(dir, "b.json")].sort());
    // a file that vanished is dropped
    assert.deepEqual(
        mergeSessions(
            [{ file: path.join(dir, "a.json") }, { file: path.join(dir, "b.json") }],
            [],
            [path.join(dir, "a.json")],
        ),
        [{ file: path.join(dir, "a.json") }],
    );
    // the full read still works
    const all = sh(SCRIPT, root);
    assert.equal(parseSessions(all).length, 2);

    const terminals = [
        { address: "t7", status: "working" },
        { address: "t8", status: "working" },
    ];
    assert.equal(terminalStateChanged(terminals, [{ address: "t7", status: "idle" }], "t7"), true);
    assert.equal(terminalStateChanged(terminals, [{ address: "t7", status: "working" }], "t7"), false);
    assert.equal(terminalStateChanged(terminals, terminals, null), false);
});

test("the new config files parse refreshSeconds, and Files knows deleted and filtered paths", async () => {
    const files = await load<FilesLib>("mods/jig-files/lib.js");
    const view = await load<ViewLib>("mods/jig-file-view/lib.js");
    for (const lib of [files, view]) {
        assert.equal(lib.parseConfig(null).refreshSeconds, 60);
        assert.equal(lib.parseConfig('{ "refreshSeconds": 30 }').refreshSeconds, 30);
        assert.equal(lib.parseConfig('{ "refreshSeconds": 10 }').refreshSeconds, 60);
        assert.match(lib.parseConfig('{ "refreshSeconds": 10 }').problems[0], /15/);
        assert.match(lib.parseConfig("{").problems[0], /not valid JSON/);
    }
    assert.match(files.FIND, /-name \.git/);
    execFileSync("sh", ["-n", "-c", files.FIND], { encoding: "utf8" });
    assert.deepEqual(files.deletedPaths(" D src/a.ts\0 M src/b.ts\0D  old.ts\0", "/w"), ["/w/src/a.ts", "/w/old.ts"]);
    const listing = ["/w/src/a.ts", "/w/docs/plan.md", "/w/src/deep/b.ts", "/w/other.txt", "/elsewhere/x.ts"];
    assert.deepEqual(files.filterPaths(listing.join("\n"), "/w", "src"), ["src/a.ts", "src/deep/b.ts"]);
    assert.deepEqual(files.filterPaths(listing.join("\n"), "/w", "PLAN"), ["docs/plan.md"]);
    assert.deepEqual(files.filterPaths(listing.join("\n"), "/w", "nothing-here"), []);

    assert.deepEqual(view.splitPath("/a/b/c.ts"), { name: "c.ts", dir: "/a/b" });
    assert.deepEqual(view.splitPath("C:\\a\\b.ts"), { name: "b.ts", dir: "C:\\a" });
    assert.equal(view.wrapDefault("notes.md"), true);
    assert.equal(view.wrapDefault("a.ts"), false);
    assert.equal(view.wrapDefault("a.ts", "on"), true);
    assert.equal(view.wrapDefault("notes.md", "off"), false);
    assert.equal(view.isMarkdown("README.MD"), true);
    assert.equal(view.isMarkdown("a.ts"), false);
});

test("Work's config knows refreshSeconds, and its default is 60", async () => {
    const work = await load<{ parseConfig(text: string | null): Config }>("mods/jig-work/lib.js");
    assert.equal(work.parseConfig(null).refreshSeconds, 60);
    assert.equal(work.parseConfig('{ "refreshSeconds": 15 }').refreshSeconds, 15);
    assert.equal(work.parseConfig('{ "refreshSeconds": 1 }').refreshSeconds, 60);
    assert.match(work.parseConfig('{ "refreshSeconds": 1 }').problems[0], /15/);
});
