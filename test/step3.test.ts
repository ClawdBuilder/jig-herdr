// Step 3 fixes from the independent review: a failing-first check for each one. Pure helpers run here; the wiring that
// has no unit seam (mount reads, watch debounce, refresh flags) is checked in the source.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { load } from "./support.ts";

type Sessions = {
    MTIMES: string;
    READ: string;
    parseMtimes(text: string): Record<string, string>;
    changedSince(previous: Record<string, string>, next: Record<string, string>): string[];
    shownAgain(previous: boolean | undefined, current: boolean): boolean;
};
type Files = { searchDue(o: Record<string, unknown>): boolean };
type Work = { detailsNote(n: number): string };

const mods = new URL("../mods/", import.meta.url);
const source = (p: string) => readFileSync(new URL(p, mods), "utf8");
function temp(t: TestContext): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-step3-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const sh = (script: string, ...args: string[]) =>
    execFileSync("sh", ["-c", script, "sh", ...args], { encoding: "utf8" });

test("1: a filtered Files search runs once per change, not on every tick", async () => {
    const files = await load<Files>("mods/jig-files/lib.js");
    const now = 10_000;
    assert.equal(files.searchDue({ filter: "x", dirty: true, loading: false, at: now - 600, now }), true);
    assert.equal(files.searchDue({ filter: "x", dirty: true, loading: false, at: now - 100, now }), false);
    assert.equal(files.searchDue({ filter: "x", dirty: false, loading: false, at: now - 600, now }), false);
    assert.equal(files.searchDue({ filter: "x", dirty: true, loading: true, at: now - 600, now }), false);
    const src = source("jig-files/main.js");
    assert.match(src, /searchDue\(/, "the tick asks searchDue");
    assert.doesNotMatch(src, /Date\.now\(\) - this\.filterAt > 500/, "no per-tick time check that re-runs find");
});

test("2: Context, Files and file-view read once on mount too", () => {
    for (const [mod, call] of [
        ["jig-context", "this.readAll(cx"],
        ["jig-files", "this.refresh(cx"],
        ["file-view", "this.load(cx"],
    ]) {
        const match = /init\([^)]*\) \{([\s\S]*?)\n {4}\}/.exec(source(`${mod}/main.js`));
        assert.ok(match, `${mod}: an init block`);
        const init = match[1];
        assert.match(init, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${mod}: a read in init`);
    }
});

test("3: the panels use exec and no timer-based deadline", async () => {
    for (const mod of ["jig-work", "jig-context", "jig-files", "file-view"]) {
        const src = source(`${mod}/main.js`);
        assert.doesNotMatch(src, /readDeadline\(/, `${mod}: no readDeadline call`);
        assert.doesNotMatch(src, /readTimeoutSeconds/, `${mod}: no read-timeout setting`);
        assert.doesNotMatch(src, /deadline\.js/, `${mod}: no private deadline helper`);
    }
    // The first read must take its machine from the config it just read, not the empty config from init.
    for (const mod of ["jig-work", "jig-context"]) {
        const src = source(`${mod}/main.js`);
        assert.ok(
            src.indexOf("const on = this.machine(); // after the config") > src.indexOf("parseConfig(text)") ||
                src.indexOf("const on = this.machine(); // after the config") >
                    src.indexOf("parseConfig(await readTextFile"),
            `${mod}: the machine is chosen after the config`,
        );
    }
});

test("4: a Files watch event debounces through the scheduler, never a direct refresh", () => {
    const src = source("jig-files/main.js");
    assert.match(src, /watchFolder\(root\)/);
    assert.match(src, /this\.refreshScheduler\.trigger\(\)/, "the watcher triggers the scheduler");
    assert.doesNotMatch(
        src,
        /if \(this\.current\(context\)\) this\.refresh\(cx\)/,
        "the watcher does not read directly",
    );
});

test("5: mtime detection uses time and size, caps at 64, and keeps the old map when READ fails", async (t) => {
    const sessions = await load<Sessions>("mods/jig-work/sessions.js");
    assert.match(sessions.MTIMES, /stat -c %Y/, "mtime seconds");
    assert.match(sessions.MTIMES, /wc -c|stat -c %s/, "and size (or a full-precision time)");
    assert.match(sessions.MTIMES, /n -gt 64/, "MTIMES caps at 64");
    assert.match(sessions.READ, /i -gt 64|n -gt 64/, "READ caps at 64");
    const root = temp(t);
    const dir = path.join(root, "sessions");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "a.json");
    writeFileSync(file, JSON.stringify({ schema: 1, session: "a" }));
    const at = new Date(2026, 0, 2, 10, 0, 0);
    utimesSync(file, at, at);
    const first = sessions.parseMtimes(sh(sessions.MTIMES, root));
    writeFileSync(file, JSON.stringify({ schema: 1, session: "a", more: "x" }));
    utimesSync(file, at, at); // the same second, a new size
    const second = sessions.parseMtimes(sh(sessions.MTIMES, root));
    assert.notDeepEqual(first, second, "a same-second write with another size is a change");
    assert.equal(sessions.changedSince(first, second).length, 1);
    const many = temp(t);
    mkdirSync(path.join(many, "sessions"));
    for (let i = 0; i < 70; i++)
        writeFileSync(path.join(many, "sessions", `s${i}.json`), JSON.stringify({ schema: 1, session: `s${i}` }));
    assert.equal(Object.keys(sessions.parseMtimes(sh(sessions.MTIMES, many))).length, 64);
    assert.equal(sessions.shownAgain(false, true), true);
    assert.equal(sessions.shownAgain(true, true), false);
    const work = source("jig-work/main.js");
    assert.match(work, /this\.mtimes = next/, "READ records the mtimes");
    assert.match(
        work,
        /if \(read\?\.code !== 0(?: \|\| run !== this\.readGeneration)?\) return;[\s\S]{0,100}this\.mtimes = next/,
        "only after READ succeeds",
    );
});

test("6: Work and Context read again when the panel is shown after being hidden", () => {
    for (const mod of ["jig-work", "jig-context"]) {
        const src = source(`${mod}/main.js`);
        assert.match(src, /shownAgain\(/, `${mod}: a shown-again trigger`);
    }
});

test("7: no busy on a backstop after an error; file-view queues clicks and keeps hidden tabs quiet", () => {
    for (const mod of ["jig-work", "jig-context", "jig-files", "file-view"]) {
        const src = source(`${mod}/main.js`);
        assert.doesNotMatch(src, /first: !this\.loaded/, `${mod}: first is not every unloaded backstop`);
        assert.match(src, /first: !this\.started/, `${mod}: first only before the first read`);
    }
    for (const mod of ["jig-work", "jig-context"]) {
        assert.doesNotMatch(source(`${mod}/main.js`), /!this\.loaded && !this\.loading/, `${mod}: no retry every tick`);
    }
    const view = source("file-view/main.js");
    assert.doesNotMatch(view, /if \(this\.loading \|\| !this\.path\) return;/, "a click during a load is queued");
    const tick = view.slice(view.indexOf("tick(cx) {"), view.indexOf("tick(cx) {") + 600);
    assert.ok(tick.indexOf("shown") < tick.indexOf("loadConfig"), "a hidden tab does not read its config");
    const work = source("jig-work/main.js");
    assert.match(work, /this\.prUser && this\.prLoading/, "automatic PR loads do not dim the button");
    assert.match(work, /detailsNote\(/, "singular/plural through one helper");
});

test("8: file-view keeps its refresh button at 300 px, and the PR note is proper English", async () => {
    for (const mod of ["jig-work", "jig-context"]) {
        assert.doesNotMatch(source(`${mod}/main.js`), /!this\.loaded && !this\.loading/, `${mod}: no retry every tick`);
    }
    const view = source("file-view/main.js");
    assert.match(view, /narrow \?/, "narrow labels");
    const work = await load<Work>("mods/jig-work/lib.js");
    assert.equal(work.detailsNote(1), "Details unavailable for 1 pull request.");
    assert.equal(work.detailsNote(2), "Details unavailable for 2 pull requests.");
});

test("3b: the mount read counts as the shown read, so the first tick does not read again", () => {
    for (const [mod, mount, flag] of [
        ["jig-work", "this.readAll(cx, false);", "this.wasSeen = true;"],
        ["jig-context", "this.readAll(cx, false);", "this.wasSeen = true;"],
        ["jig-files", "this.refresh(cx, false);", "this.seen = true;"],
        ["file-view", "this.load(cx);", "this.wasShown = true;"],
    ]) {
        const match = /init\([^)]*\) \{([\s\S]*?)\n    \}/.exec(source(`${mod}/main.js`));
        assert.ok(match, `${mod}: init`);
        const init = match[1];
        assert.ok(init.includes(mount), `${mod}: mount read`);
        assert.ok(init.indexOf(flag) > init.indexOf(mount), `${mod}: the mount read counts as shown`);
    }
});

test("4b: checkMtimes cannot overwrite a newer full read", () => {
    for (const mod of ["jig-work", "jig-context"]) {
        const src = source(`${mod}/main.js`),
            start = src.indexOf("checkMtimes(cx, session) {"),
            body = src.slice(start, src.indexOf("\n    }", start));
        assert.ok(start > 0, `${mod}: checkMtimes`);
        assert.match(body, /const run = this\.readGeneration;/, `${mod}: captures the generation`);
        assert.match(body, /run !== this\.readGeneration/, `${mod}: drops its result if a full read took over`);
    }
});
