// The install script, run into temporary folders that stand for a Herdr config folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const OLD_REPOS = "jig-" + "repos";

import { install } from "../scripts/install.ts";
import { HERDR } from "./support.ts";

function folder(t: { after(fn: () => void): void }): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-herdr-install-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const read = (target: string, file: string) => readFileSync(path.join(target, file), "utf8");
const readJson = (target: string, file: string) =>
    JSON.parse(read(target, file)) as Record<string, Record<string, string>>;

test("a first install copies the layout, the mods and the themes, and adds the keys", (t) => {
    const target = folder(t);
    const report = install(target);
    assert.deepEqual(report.skipped, []);
    for (const file of [
        "layouts/jig.json",
        "layouts/jig.svg",
        "mods/jig-activity/icons/jig.svg",
        "mods/jig-theme-sync/config.json",
        "mods/jig-work/main.js",
        "mods/jig-work/config.json",
        "mods/jig-context/main.js",
        "mods/jig-activity/icons/context.svg",
        "mods/jig-tabs/main.js",
        "mods/jig-keep-awake/main.js",
        "mods/jig-keep-awake/config.json",
        "mods/jig-file-view/main.js",
        "mods/jig-git/main.js",
        "mods/jig-review/main.js",
        "mods/jig-prs/main.js",
        "mods/jig-worktrees/main.js",
        "mods/jig-history/main.js",
        "mods/jig-files/main.js",
        "themes/jig-lime.json",
    ]) {
        assert.equal(read(target, file), readFileSync(path.join(HERDR, file), "utf8"), file);
    }
    for (const file of ["RECIPE.md", "preview.png"]) assert.equal(existsSync(path.join(target, file)), false, file);
    assert.deepEqual(readJson(target, "keys.json")["layout:jig"], readJson(HERDR, "keys.json")["layout:jig"]);
});

test("a mod's mod.json is written before its other files, so Herdr never docks a stray copy", (t) => {
    const report = install(folder(t));
    for (const mod of [
        "jig-activity",
        "jig-theme-sync",
        "jig-work",
        "jig-context",
        "jig-tabs",
        "jig-keep-awake",
        "jig-file-view",
        "jig-git",
        "jig-review",
        "jig-prs",
        "jig-worktrees",
        "jig-history",
        "jig-files",
    ]) {
        const mine = report.added.filter((f) => f.startsWith(`mods/${mod}/`));
        assert.equal(mine[0], `mods/${mod}/mod.json`);
    }
    // And the layout comes after the mods it names.
    assert.equal(report.added.at(-1)?.startsWith("layouts/"), true);
});

test("running it again changes nothing", (t) => {
    const target = folder(t);
    install(target);
    const again = install(target);
    assert.deepEqual([again.added, again.updated, again.replaced, again.removed, again.skipped], [[], [], [], [], []]);
    assert.deepEqual(again.keys, { added: [], migrated: [], kept: [] });
});

test("a file it installed is updated, unless you changed it", (t) => {
    const target = folder(t);
    const source = folder(t);
    for (const [file, text] of [
        ["mods/m/mod.json", "{}"],
        ["mods/m/main.js", "one"],
        ["mods/m/lib.js", "one"],
    ] as const) {
        mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        writeFileSync(path.join(source, file), text);
    }
    install(target, { source });
    writeFileSync(path.join(source, "mods/m/main.js"), "two");
    writeFileSync(path.join(source, "mods/m/lib.js"), "two");
    writeFileSync(path.join(target, "mods/m/lib.js"), "mine");
    const report = install(target, { source });
    assert.deepEqual(report.updated, ["mods/m/main.js"]);
    assert.equal(read(target, "mods/m/main.js"), "two");
    assert.deepEqual(
        report.skipped.map((s) => [s.file, s.reason]),
        [["mods/m/lib.js", "you changed it since it was installed"]],
    );
    assert.equal(read(target, "mods/m/lib.js"), "mine");
    assert.equal(install(target, { source, force: true }).replaced[0], "mods/m/lib.js");
    assert.equal(read(target, "mods/m/lib.js"), "two");
});

test("a file that was already there is left alone, and replaced only with force", (t) => {
    const target = folder(t);
    mkdirSync(path.join(target, "mods/jig-git"), { recursive: true });
    writeFileSync(path.join(target, "mods/jig-git/main.js"), "// my own");
    const report = install(target);
    assert.deepEqual(report.skipped, [{ file: "mods/jig-git/main.js", reason: "it was not installed by this script" }]);
    assert.equal(read(target, "mods/jig-git/main.js"), "// my own");
    assert.ok(report.added.length > 10, "everything else was installed");

    const forced = install(target, { force: true });
    assert.deepEqual(forced.replaced, ["mods/jig-git/main.js"]);
    assert.notEqual(read(target, "mods/jig-git/main.js"), "// my own");
});

test("the old keep-awake helper file is kept for a running helper", (t) => {
    const target = folder(t);
    mkdirSync(path.join(target, "mods/jig-keep-awake"), { recursive: true });
    writeFileSync(path.join(target, "mods/jig-keep-awake/keep-awake.ps1"), "# old helper\n");
    const report = install(target);
    assert.ok(existsSync(path.join(target, "mods/jig-keep-awake/keep-awake.ps1")));
    assert.deepEqual(report.preserved, ["mods/jig-keep-awake/keep-awake.ps1"]);
});

test("config.json is yours: written once, and kept even with force", (t) => {
    const target = folder(t);
    install(target);
    const config = path.join(target, "mods/jig-theme-sync/config.json");
    writeFileSync(config, '{ "machine": "dev-box" }');
    install(target);
    install(target, { force: true });
    assert.equal(readFileSync(config, "utf8"), '{ "machine": "dev-box" }');
});

test("keys.json: other sections and keys stay, a key you bound differently is kept unless force", (t) => {
    const target = folder(t);
    writeFileSync(
        path.join(target, "keys.json"),
        JSON.stringify({
            global: { "alt-1": "space.select:1", "ctrl-shift-alt-k": "keep-awake.cycle" },
            "layout:jig": { "ctrl-shift-r": "tab.next", "ctrl-shift-y": "tab.prev" },
        }),
    );
    const report = install(target);
    const keys = readJson(target, "keys.json");
    assert.deepEqual(keys.global, { "alt-1": "space.select:1", "ctrl-shift-alt-k": "jig-keep-awake.cycle" });
    assert.equal(keys["layout:jig"]?.["ctrl-shift-r"], "tab.next");
    assert.equal(keys["layout:jig"]?.["ctrl-shift-y"], "tab.prev");
    assert.deepEqual(report.keys.kept, ["layout:jig ctrl-shift-r (yours: tab.next)"]);
    assert.deepEqual(report.keys.migrated, ["global ctrl-shift-alt-k (keep-awake.cycle -> jig-keep-awake.cycle)"]);
    assert.deepEqual(report.keys.added, []);

    install(target, { force: true });
    assert.equal(readJson(target, "keys.json")["layout:jig"]?.["ctrl-shift-r"], "layout.toggle:panel");
    assert.equal(readJson(target, "keys.json")["layout:jig"]?.["ctrl-shift-y"], "tab.prev");
    assert.deepEqual(readJson(target, "keys.json").global, {
        "alt-1": "space.select:1",
        "ctrl-shift-alt-k": "jig-keep-awake.cycle",
    });
});

test("a binding for an old renamed mod action is migrated without force", (t) => {
    const target = folder(t);
    writeFileSync(
        path.join(target, "keys.json"),
        JSON.stringify({ global: { "ctrl-shift-alt-k": "keep-awake.cycle" } }),
    );
    const report = install(target);
    assert.equal(readJson(target, "keys.json").global["ctrl-shift-alt-k"], "jig-keep-awake.cycle");
    assert.deepEqual(report.keys.migrated, ["global ctrl-shift-alt-k (keep-awake.cycle -> jig-keep-awake.cycle)"]);
    assert.equal(report.keys.kept.length, 0);
});

test("a keys.json that is not JSON is not touched", (t) => {
    const target = folder(t);
    writeFileSync(path.join(target, "keys.json"), "{ nope");
    const report = install(target);
    assert.match(report.keys.error ?? "", /not valid JSON/);
    assert.equal(read(target, "keys.json"), "{ nope");
});

test("other layouts, mods, programs and settings are never touched", (t) => {
    const target = folder(t);
    const mine: Record<string, string> = {
        "layouts/mine.json": "{}",
        "mods/other-mod/main.js": "// not ours",
        "programs.json": '{ "programs": {} }',
        "settings.json": '{ "zoom": 1 }',
    };
    for (const [file, text] of Object.entries(mine)) {
        mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
        writeFileSync(path.join(target, file), text);
    }
    install(target, { force: true });
    for (const [file, text] of Object.entries(mine)) assert.equal(read(target, file), text, file);
});

test("a file a newer version no longer ships is removed, unless you changed it", (t) => {
    const target = folder(t);
    const source = folder(t);
    for (const file of ["mods/m/mod.json", "mods/m/old.js", "mods/m/mine.js"]) {
        mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        writeFileSync(path.join(source, file), file);
    }
    install(target, { source });
    writeFileSync(path.join(target, "mods/m/mine.js"), "edited");
    rmSync(path.join(source, "mods/m/old.js"));
    rmSync(path.join(source, "mods/m/mine.js"));
    const report = install(target, { source });
    assert.deepEqual(report.removed, ["mods/m/old.js"]);
    assert.equal(existsSync(path.join(target, "mods/m/old.js")), false);
    assert.equal(read(target, "mods/m/mine.js"), "edited");
});

test("a mod a newer version no longer ships goes with its folder, once only the app's own files are left", (t) => {
    const target = folder(t);
    const source = folder(t);
    for (const file of ["mods/gone/mod.json", "mods/gone/main.js", "mods/kept/mod.json"]) {
        mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        writeFileSync(path.join(source, file), file);
    }
    install(target, { source });
    writeFileSync(path.join(target, "mods/gone/jsconfig.json"), "{}"); // the app writes these
    writeFileSync(path.join(target, "mods/gone/gpui-kit.d.ts"), "");
    rmSync(path.join(source, "mods/gone"), { recursive: true });
    assert.deepEqual(install(target, { source }).removed, ["mods/gone/mod.json", "mods/gone/main.js"]);
    assert.equal(existsSync(path.join(target, "mods/gone")), false);
    assert.ok(existsSync(path.join(target, "mods/kept/mod.json")));
});

test("a dry run writes nothing", (t) => {
    const target = folder(t);
    const report = install(target, { dryRun: true });
    assert.ok(report.added.length > 10);
    assert.deepEqual(readdirSync(target), []);
});

test("a folder that does not exist is an error", (t) => {
    assert.throws(() => install(path.join(folder(t), "nope")), /not a folder/);
});

test("an old mod's config.json moves to its new name, and the old folder is kept", (t) => {
    const target = folder(t);
    mkdirSync(path.join(target, "mods/repo-changes"), { recursive: true });
    writeFileSync(
        path.join(target, "mods/repo-changes/config.json"),
        JSON.stringify({ newBranchPrefix: "old/", rowDetail: "full" }),
    );
    const report = install(target);
    const moved = JSON.parse(read(target, "mods/jig-git/config.json")) as Record<string, unknown>;
    assert.equal(moved.newBranchPrefix, "old/");
    assert.equal(moved.rowDetail, "full");
    assert.deepEqual(report.migrated, [
        "mods/repo-changes/config.json -> mods/jig-git/config.json (newBranchPrefix, rowDetail)",
    ]);
    assert.deepEqual(report.oldKept, ["mods/repo-changes"]);
    assert.ok(existsSync(path.join(target, "mods/repo-changes/config.json")), "the old file stays");
    const again = install(target);
    assert.deepEqual(again.migrated, []);
    assert.deepEqual(again.oldKept, []);
});

test(`a ${OLD_REPOS} config migrates directly to jig-git`, (t) => {
    const target = folder(t);
    mkdirSync(path.join(target, "mods", OLD_REPOS), { recursive: true });
    writeFileSync(path.join(target, "mods", OLD_REPOS, "config.json"), JSON.stringify({ baseBranch: "release" }));
    const report = install(target);
    assert.equal(readJson(target, "mods/jig-git/config.json").baseBranch, "release");
    assert.deepEqual(report.migrated, [`mods/${OLD_REPOS}/config.json -> mods/jig-git/config.json (baseBranch)`]);
    install(target);
    // The old file does not overwrite an existing new file either.
    writeFileSync(path.join(target, "mods/jig-git/config.json"), JSON.stringify({ baseBranch: "main" }));
    install(target);
    assert.equal(readJson(target, "mods/jig-git/config.json").baseBranch, "main");
});

test("a partial old config migrates only the missing keys", (t) => {
    const target = folder(t);
    install(target);
    const newFile = path.join(target, "mods/jig-git/config.json");
    const before = JSON.parse(readFileSync(newFile, "utf8")) as Record<string, unknown>;
    mkdirSync(path.join(target, "mods/repo-changes"), { recursive: true });
    writeFileSync(
        path.join(target, "mods/repo-changes/config.json"),
        JSON.stringify({ onlyOld: "kept", newBranchPrefix: "old/" }),
    );
    const report = install(target);
    const after = JSON.parse(readFileSync(newFile, "utf8")) as Record<string, unknown>;
    assert.equal(after.onlyOld, "kept");
    assert.equal(after.newBranchPrefix, before.newBranchPrefix, "the new file's value wins");
    assert.deepEqual(report.migrated, ["mods/repo-changes/config.json -> mods/jig-git/config.json (onlyOld)"]);
});

test("--remove-old removes only a fully carried-over old folder", (t) => {
    const target = folder(t);
    install(target);
    mkdirSync(path.join(target, "mods/repo-changes"), { recursive: true });
    writeFileSync(path.join(target, "mods/repo-changes/config.json"), JSON.stringify({ onlyOld: "carried" }));
    const report = install(target, { removeOld: true });
    assert.deepEqual(report.oldRemoved, ["mods/repo-changes"]);
    assert.ok(!existsSync(path.join(target, "mods/repo-changes")));
    assert.equal(readJson(target, "mods/jig-git/config.json").onlyOld, "carried");

    // A second run has no old folder to report.
    assert.deepEqual(install(target, { removeOld: true }).oldRemoved, []);
});

test("an existing new config wins over the old file, which only fills gaps", (t) => {
    const target = folder(t);
    install(target);
    writeFileSync(
        path.join(target, "mods/jig-git/config.json"),
        JSON.stringify({ newBranchPrefix: "new/", rowDetail: "compact" }),
    );
    mkdirSync(path.join(target, "mods/repo-changes"), { recursive: true });
    writeFileSync(
        path.join(target, "mods/repo-changes/config.json"),
        JSON.stringify({ newBranchPrefix: "old/", baseBranch: "develop" }),
    );
    install(target);
    const merged = JSON.parse(read(target, "mods/jig-git/config.json")) as Record<string, unknown>;
    assert.equal(merged.newBranchPrefix, "new/");
    assert.equal(merged.rowDetail, "compact");
    assert.equal(merged.baseBranch, "develop");
});
