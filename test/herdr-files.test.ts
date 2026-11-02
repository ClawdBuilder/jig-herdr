// What herdr/ holds is a layout and its mods in Herdr's sharing format, and it must stay generic and self-contained.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HERDR, PLUGIN } from "./support.ts";

type Node = {
    id: string;
    type: string;
    content?: { mod?: string; props?: { activity?: { icon?: string } } };
    children?: Node[];
    active?: string;
    preview?: string;
};

const MODS = readdirSync(path.join(HERDR, "mods")).sort();
/** Mods that Herdr ships, which the layout uses as they are. */
const HERDR_OWN = ["workspace-chrome", "spaces", "agents", "tabs", "pane", "files"];
/** Panels from the third-party Triage mods: not part of this plugin, named in the README. */
const TRIAGE = ["triage-history", "triage-pr", "triage-worktrees", "triage-launch"];

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}
const nodes = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(nodes)];
const layout = JSON.parse(readFileSync(path.join(HERDR, "layouts/jig.json"), "utf8")) as Node;

test("the mods are the seven this plugin ships, and none is one of Triage's", () => {
    assert.deepEqual(MODS, [
        "file-view",
        "jig-activity",
        "jig-tabs",
        "jig-theme-sync",
        "jig-work",
        "repo-changes",
        "repo-review",
    ]);
    assert.deepEqual(
        walk(HERDR).filter((f) => /triage-/.test(f)),
        [],
    );
});

test("every mod has a mod.json that places it nowhere by itself, and a main.js with a default export", () => {
    for (const mod of MODS) {
        const place = JSON.parse(readFileSync(path.join(HERDR, "mods", mod, "mod.json"), "utf8")) as { place: string };
        assert.equal(place.place, "none", `${mod}: a mod placed by itself would be docked into the shown layout`);
        assert.match(
            readFileSync(path.join(HERDR, "mods", mod, "main.js"), "utf8"),
            /export default class \w+ extends View/,
        );
    }
});

test("every mod the layout names is one of ours, one of Herdr's, or one of Triage's", () => {
    const named = new Set(nodes(layout).flatMap((n) => (n.content?.mod ? [n.content.mod] : [])));
    for (const mod of named) assert.ok([...MODS, ...HERDR_OWN, ...TRIAGE].includes(mod), `${mod} is not known`);
    // repo-review and file-view open as tabs, so no block of the layout names them.
    for (const mod of MODS)
        assert.ok(named.has(mod) || ["repo-review", "file-view"].includes(mod), `${mod} is in no block of the layout`);
    assert.equal(named.has("triage-status") || named.has("triage-activity") || named.has("triage-reply"), false);
    assert.equal(named.has("tabs"), false, "the tab bar is jig-tabs, with the Panel and Jig buttons");
});

test("the layout's side panel gives each child an icon that exists, and ids are unique", () => {
    const all = nodes(layout);
    assert.equal(new Set(all.map((n) => n.id)).size, all.length, "node ids are unique");
    const stack = all.find((n) => n.id === "panel-body");
    assert.equal(stack?.type, "stack");
    assert.ok(stack?.children?.some((c) => c.id === "changes" && c.content?.mod === "repo-changes"));
    // The Jig section sits at the top, with a divider under its button, and shows first.
    const first = stack?.children?.[0] as Node & { content?: { props?: { activity?: { divider?: boolean } } } };
    assert.equal(first?.id, "jig-work");
    assert.equal(first?.content?.mod, "jig-work");
    assert.equal(first?.content?.props?.activity?.divider, true);
    assert.equal(stack?.active, "jig-work");
    for (const child of stack?.children ?? []) {
        const icon = child.content?.props?.activity?.icon;
        assert.ok(icon, `${child.id} has an icon`);
        if (icon.startsWith("mods/jig-activity/")) assert.ok(existsSync(path.join(HERDR, icon)), icon);
    }
    const bar = all.find((n) => n.content?.mod === "jig-activity");
    assert.deepEqual(bar?.content && "props" in bar.content ? bar.content.props : null, { stack: "panel-body" });
    assert.ok(
        layout.preview && existsSync(path.join(HERDR, layout.preview)),
        "the preview picture of the layout exists",
    );
});

test("keys.json binds keys for the jig layout only, to commands that exist", () => {
    const keys = JSON.parse(readFileSync(path.join(HERDR, "keys.json"), "utf8")) as Record<
        string,
        Record<string, string>
    >;
    assert.deepEqual(keys, { "layout:jig": { "ctrl-shift-r": "layout.toggle:panel" } });
});

test("there is no status bar: the palette follower sits unseen, in a 0 px block above the sidebar's footer", () => {
    const sidebar = layout.children?.find((n) => n.id === "sidebar");
    assert.deepEqual(
        sidebar?.children?.map((n) => n.id),
        ["brand", "sidebar-lists", "jig-theme", "sidebar-footer"],
    );
    assert.equal(sidebar?.children?.[2]?.content?.mod, "jig-theme-sync");
    assert.deepEqual((sidebar?.children?.[2] as { size?: unknown } | undefined)?.size, { px: 0 });
    // Pane headers stay on screen: on hover they would cover the terminal's prompt line.
    const main = nodes(layout).find((n) => n.id === "main") as {
        content?: { pane?: { header?: { reveal?: string } } };
    };
    assert.equal(main?.content?.pane?.header?.reveal, "always");
    assert.equal(
        nodes(layout).some((n) => n.id === "status-row" || n.content?.mod === "jig-status"),
        false,
    );
});

test("the sharing files are there: a recipe and a picture", () => {
    assert.ok(existsSync(path.join(HERDR, "RECIPE.md")));
    assert.ok(statSync(path.join(HERDR, "preview.png")).size > 10_000);
    assert.match(readFileSync(path.join(HERDR, "RECIPE.md"), "utf8"), /!\[[^\]]*\]\(preview\.png\)/);
});

test("nothing personal or company-specific is in the plugin", () => {
    // Built from parts so that this file does not match itself.
    const forbidden = [
        new RegExp(["/home", "/\\w"].join("")),
        new RegExp(["/mnt", "/c/(?!Users/<name>/)"].join("")),
        new RegExp(["Users", "[\\\\/]\\w"].join("")),
        new RegExp(["github", "repos"].join("")),
        new RegExp(["vo", "nage"].join(""), "i"),
        new RegExp(["jig-", "agent\\b"].join("")),
    ];
    const files = [...walk(PLUGIN)].filter(
        (f) =>
            /\.(js|ts|json|md|svg)$/.test(f) &&
            !f.includes("node_modules") &&
            !f.includes(`${path.sep}test${path.sep}`),
    );
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const bad of forbidden) {
            if (file.endsWith("herdr-files.test.ts")) continue;
            assert.equal(bad.test(text), false, `${path.relative(PLUGIN, file)} matches ${bad}`);
        }
    }
});

test("the shipped config.json files name no machine, folder or palette of anyone", () => {
    const config = JSON.parse(readFileSync(path.join(HERDR, "mods/jig-theme-sync/config.json"), "utf8")) as unknown;
    assert.deepEqual(config, { machine: null, agentDir: null, themeFolders: [] });
    const work = JSON.parse(readFileSync(path.join(HERDR, "mods/jig-work/config.json"), "utf8")) as unknown;
    assert.deepEqual(work, { machine: null, stateDir: null, prOwners: [] });
});

test("jig-tabs credits Herdr's tabs mod and its licence, and has the Panel and Jig buttons in place of Files and Changes", () => {
    const text = readFileSync(path.join(HERDR, "mods/jig-tabs/main.js"), "utf8");
    assert.match(text.slice(0, 1200), /Derived from the `tabs` mod shipped with the Herdr app/);
    assert.match(text.slice(0, 1200), /Apache License, Version 2\.0/);
    assert.match(text, /"Panel"/);
    assert.match(text, /"Jig"/);
    assert.doesNotMatch(text, /"Files"|"Changes"/);
    assert.ok(existsSync(path.join(HERDR, "mods/jig-tabs/jig.svg")));
});

test("the Jig icon is one monochrome glyph drawn in the text colour", () => {
    for (const file of ["mods/jig-tabs/jig.svg", "mods/jig-activity/icons/jig.svg"]) {
        const text = readFileSync(path.join(HERDR, file), "utf8");
        assert.match(text, /stroke="currentColor"/);
        assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}/, `${file} has a colour of its own`);
    }
});

test("every mod's imports are Herdr's own modules or its own files", () => {
    for (const file of walk(path.join(HERDR, "mods")).filter((f) => f.endsWith(".js"))) {
        for (const [, spec] of readFileSync(file, "utf8").matchAll(/^import .* from "([^"]+)";/gm)) {
            const ok = ["gpui-kit", "gpui-base", "herdr"].includes(spec ?? "") || spec?.startsWith("./");
            assert.ok(ok, `${path.relative(PLUGIN, file)} imports ${spec}`);
            if (spec?.startsWith("./")) assert.ok(existsSync(path.join(path.dirname(file), spec)), `${file}: ${spec}`);
        }
    }
});
