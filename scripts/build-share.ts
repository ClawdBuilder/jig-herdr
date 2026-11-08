// Builds the six herdr.dev listings in share/ from the source tree and gallery/<listing>/ recipes and previews. `--check`
// compares the result with a fresh build, so a source change without rebuilding the gallery fails CI.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LAYOUT = "jig-workbench";
const DEPENDENCIES: Record<string, string[]> = {
    "jig-workbench": [
        "jig-repos",
        "jig-history",
        "jig-prs",
        "jig-worktrees",
        "jig-review",
        "jig-files",
        "jig-file-view",
        "jig-keep-awake",
        "jig-activity",
    ],
};
const LISTINGS = [
    "jig-workbench",
    "jig-repos",
    "jig-history",
    "jig-prs",
    "jig-worktrees",
    "jig-review",
    "jig-keep-awake",
];
const EXCLUDED = new Set([
    "gpui-kit.d.ts",
    "jsconfig.json",
    "RECIPE.md",
    "preview.png",
    "test",
    "node_modules",
    ".DS_Store",
]);
const DERIVED = new Set(["jig-files", "jig-file-view"]);

function copy(source: string, target: string): void {
    if (!existsSync(source)) throw new Error(`missing source ${source}`);
    if (statSync(source).isDirectory()) {
        cpSync(source, target, {
            recursive: true,
            filter: (file) => !EXCLUDED.has(path.basename(file)),
        });
    } else cpSync(source, target);
}

function copyListing(id: string, out: string): void {
    const target = path.join(out, id);
    cpSync(path.join(ROOT, "gallery", id, "RECIPE.md"), path.join(target, "RECIPE.md"));
    cpSync(path.join(ROOT, "gallery", id, "preview.png"), path.join(target, "preview.png"));
    cpSync(path.join(ROOT, "LICENSE"), path.join(target, "LICENSE"));
    if (id === LAYOUT) {
        copy(path.join(ROOT, "layouts", "jig-workbench.json"), path.join(target, "layouts", "jig-workbench.json"));
        copy(path.join(ROOT, "layouts", "jig-workbench.svg"), path.join(target, "layouts", "jig-workbench.svg"));
    } else copy(path.join(ROOT, "mods", id), path.join(target, "mods", id));
    const dependencies = DEPENDENCIES[id] ?? [];
    for (const mod of dependencies) copy(path.join(ROOT, "mods", mod), path.join(target, "mods", mod));
    const keys = JSON.parse(readFileSync(path.join(ROOT, "keys.json"), "utf8")) as Record<string, unknown>;
    if (id === "jig-keep-awake") {
        writeFileSync(path.join(target, "keys.json"), `${JSON.stringify({ global: keys.global }, null, 4)}\n`);
    } else if (id === LAYOUT) {
        writeFileSync(
            path.join(target, "keys.json"),
            `${JSON.stringify(
                { global: keys.global, "layout:jig-workbench": { "ctrl-shift-r": "layout.toggle:panel" } },
                null,
                4,
            )}\n`,
        );
    }
    if ([id, ...dependencies].some((one) => DERIVED.has(one))) {
        cpSync(path.join(ROOT, "licenses", "Apache-2.0.txt"), path.join(target, "LICENSE-APACHE"));
        writeFileSync(
            path.join(target, "NOTICE"),
            [
                "Herdr authors, Copyright Herdr authors.",
                "",
                "This folder includes `files` 0.1.11 and `file-view` from the Herdr app, licensed under the Apache",
                "License, Version 2.0 (LICENSE-APACHE). Changes: the mods are named `jig-files` and",
                "`jig-file-view`, the tab/selection bookkeeping uses the jig- prefixes, and Files opens a file in a",
                "jig-file-view tab instead of previewing it inside the panel. The upstream source headers are kept.",
                "",
            ].join("\n"),
        );
    }
}

export function buildShare(out = path.join(ROOT, "share")): void {
    rmSync(out, { recursive: true, force: true });
    for (const id of LISTINGS) copyListing(id, out);
}

function files(root: string, prefix = ""): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(prefix, entry.name);
        return entry.isDirectory() ? files(path.join(root, entry.name), relative) : [relative];
    });
}

export function compareShare(expected: string, actual: string): string[] {
    const expectedFiles = new Set(files(expected));
    const actualFiles = new Set(files(actual));
    const differences: string[] = [];
    for (const file of expectedFiles)
        if (!actualFiles.has(file)) differences.push(`missing ${file}`);
        else if (!readFileSync(path.join(expected, file)).equals(readFileSync(path.join(actual, file))))
            differences.push(`changed ${file}`);
    for (const file of actualFiles) if (!expectedFiles.has(file)) differences.push(`stray ${file}`);
    return differences;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.includes("--check")) {
        const fresh = mkdtempSync(path.join(tmpdir(), "jig-share-"));
        try {
            buildShare(fresh);
            const differences = compareShare(fresh, path.join(ROOT, "share"));
            if (differences.length) {
                console.error("share/ is not current:");
                for (const difference of differences) console.error(`  ${difference}`);
                process.exitCode = 1;
            } else console.log("share/ is current");
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    } else {
        buildShare();
        console.log(`built ${LISTINGS.length} listings in share/`);
    }
}
