// Copies the layout, mods, themes and keys of herdr/ into a Herdr config folder:
// `node herdr/scripts/install.ts [folder] [--force] [--dry-run] [--remove-old]`.
//
// Files are copied, never linked (the Windows app cannot follow a link made in WSL). A file is written when it is new, and
// updated when this script wrote it earlier and nobody has changed it since. Any other file already there is left alone and
// reported, unless --force. keys.json is merged: only the sections herdr/keys.json has are touched, and a key you already use
// for something else is kept. config.json files are yours: written once, never updated.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The files in herdr/ that are the person's to edit: copied when missing, never updated. */
const OWN = new Set(["config.json"]);
/** Where this script records what it wrote, with a hash of each file, so a later run can tell your edits from its own files. */
const MANIFEST = ".jig-herdr-install.json";
/** The folders of herdr/ that are copied. RECIPE.md, preview.png, docs, scripts and tests are not for a Herdr folder. */
const FOLDERS = ["themes", "mods", "layouts"];
/** The 0.1.2 mod names and the names this version gives them. Their config.json is the person's. */
const RENAMED: ReadonlyArray<[string, string]> = [
    ["repo-changes", "jig-repos"],
    ["repo-history", "jig-history"],
    ["repo-prs", "jig-prs"],
    ["repo-worktrees", "jig-worktrees"],
    ["repo-review", "jig-review"],
    ["keep-awake", "jig-keep-awake"],
    ["file-view", "jig-file-view"],
];
const SOURCE = path.resolve(import.meta.dirname, "..");
/** Files the Herdr app writes into every mod folder for editors. A folder left with only these is a removed mod's. */
const APP_WRITTEN = new Set(["gpui-kit.d.ts", "jsconfig.json"]);

export interface Options {
    /** Replace files that are not this script's (never a config.json), and take over keys.json keys that differ. */
    force?: boolean;
    /** Remove an old mod folder after its config has been fully carried over. */
    removeOld?: boolean;
    /** Report what would happen and write nothing. */
    dryRun?: boolean;
    /** The folder to copy from; this herdr/ folder by default. */
    source?: string;
}

export interface Report {
    /** Files written for the first time. */
    added: string[];
    /** Files this script wrote before, rewritten with a newer version. */
    updated: string[];
    /** Files that were already identical. */
    same: string[];
    /** Files you edited or that came from elsewhere, replaced because of --force. */
    replaced: string[];
    /** Files left alone, with the reason. Any of these means the install is not complete. */
    skipped: { file: string; reason: string }[];
    /** Files an earlier version installed that this one no longer has, removed. */
    removed: string[];
    /** keys.json: keys added, keys migrated from an old mod action, and keys kept because the file binds that key to
     *  something else. */
    keys: { added: string[]; migrated: string[]; kept: string[]; error?: string };
    /** Old mod configs copied to their new names (the default values fill anything missing). */
    migrated: string[];
    /** Old mod folders left in place after a migration changed their config. */
    oldKept: string[];
    /** Old mod folders removed with --remove-old after their config was fully carried over. */
    oldRemoved: string[];
}

type Manifest = { version: 1; files: Record<string, string> };

const hash = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** Files under a folder, as paths relative to the source, in install order: mod.json before any other file of its mod. */
function filesUnder(source: string, folder: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        const names = readdirSync(dir).sort((a, b) =>
            a === "mod.json" ? -1 : b === "mod.json" ? 1 : a.localeCompare(b),
        );
        for (const name of names) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else out.push(path.relative(source, full).split(path.sep).join("/"));
        }
    };
    if (existsSync(path.join(source, folder))) walk(path.join(source, folder));
    return out;
}

/** Herdr docks a mod folder it has never seen where its mod.json says, and a folder without one gets a default place. So a mod's mod.json is written first. */
function installOrder(source: string): string[] {
    return FOLDERS.flatMap((folder) => filesUnder(source, folder));
}

function readManifest(target: string): Manifest {
    try {
        const raw = JSON.parse(readFileSync(path.join(target, MANIFEST), "utf8")) as Manifest;
        if (raw.version === 1 && raw.files && typeof raw.files === "object") return raw;
    } catch {
        // none yet, or unreadable: every file already there then counts as not ours
    }
    return { version: 1, files: {} };
}

/** The new action when `action` is an old mod action this installer wrote, and only then. */
function migratedAction(action: string, wanted: string): string | undefined {
    for (const [oldName, newName] of RENAMED) {
        if (action !== oldName && !action.startsWith(`${oldName}.`)) continue;
        const candidate = `${newName}${action.slice(oldName.length)}`;
        if (candidate === wanted) return candidate;
    }
    return undefined;
}

/** Merges the sections of source/keys.json into target/keys.json; every other section and key is left as it is. */
function mergeKeys(source: string, target: string, options: Options, report: Report): void {
    const from = path.join(source, "keys.json");
    if (!existsSync(from)) return;
    const wanted = JSON.parse(readFileSync(from, "utf8")) as Record<string, Record<string, string>>;
    const file = path.join(target, "keys.json");
    let current: Record<string, Record<string, string>> = {};
    if (existsSync(file)) {
        try {
            current = JSON.parse(readFileSync(file, "utf8")) as typeof current;
        } catch (e) {
            report.keys.error = `keys.json is not valid JSON (${(e as Error).message}); fix it and run again`;
            return;
        }
    }
    let changed = false;
    for (const [section, keys] of Object.entries(wanted)) {
        current[section] ??= {};
        const have = current[section];
        for (const [key, action] of Object.entries(keys)) {
            const label = `${section} ${key}`;
            if (have[key] === action) continue;
            if (have[key] !== undefined && !options.force) {
                const migrated = migratedAction(have[key], action);
                if (migrated !== undefined) {
                    report.keys.migrated.push(`${label} (${have[key]} -> ${migrated})`);
                    have[key] = migrated;
                    changed = true;
                    continue;
                }
                report.keys.kept.push(`${label} (yours: ${have[key]})`);
                continue;
            }
            have[key] = action;
            report.keys.added.push(label);
            changed = true;
        }
    }
    if (changed && !options.dryRun) writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}

/** A mod this version no longer ships: its folder goes too once only the app's own files are left in it. */
function removeEmptiedMods(target: string, removed: readonly string[]): void {
    for (const dir of new Set(removed.filter((rel) => rel.startsWith("mods/")).map(path.dirname))) {
        const full = path.join(target, dir);
        if (existsSync(full) && readdirSync(full).every((name) => APP_WRITTEN.has(name)))
            rmSync(full, { recursive: true, force: true });
    }
}

/** Copy an old mod's missing config keys to its new folder. Runs before the new mod files land. */
function migrateConfigs(target: string, options: Options, report: Report): void {
    for (const [oldName, newName] of RENAMED) {
        const oldFolder = path.join(target, "mods", oldName);
        const oldFile = path.join(oldFolder, "config.json");
        if (!existsSync(oldFile)) continue;
        const newFile = path.join(target, "mods", newName, "config.json");
        let old: unknown;
        try {
            old = JSON.parse(readFileSync(oldFile, "utf8"));
        } catch {
            report.skipped.push({ file: `mods/${oldName}/config.json`, reason: "not valid JSON; left as it is" });
            report.oldKept.push(`mods/${oldName}`);
            continue;
        }
        if (typeof old !== "object" || old === null || Array.isArray(old)) {
            report.skipped.push({ file: `mods/${oldName}/config.json`, reason: "not an object; left as it is" });
            report.oldKept.push(`mods/${oldName}`);
            continue;
        }
        let current: Record<string, unknown> = {};
        if (existsSync(newFile)) {
            try {
                const parsed = JSON.parse(readFileSync(newFile, "utf8")) as unknown;
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
                current = parsed as Record<string, unknown>;
            } catch {
                report.skipped.push({ file: `mods/${newName}/config.json`, reason: "not valid JSON; not merged" });
                report.oldKept.push(`mods/${oldName}`);
                continue;
            }
        }
        const missing = Object.keys(old as Record<string, unknown>).filter((key) => !(key in current));
        if (missing.length > 0) {
            const next = { ...(old as Record<string, unknown>), ...current };
            current = next;
            if (!options.dryRun) {
                mkdirSync(path.dirname(newFile), { recursive: true });
                writeFileSync(newFile, `${JSON.stringify(next, null, 2)}\n`);
            }
            report.migrated.push(`mods/${oldName}/config.json -> mods/${newName}/config.json (${missing.join(", ")})`);
            if (!options.removeOld) report.oldKept.push(`mods/${oldName}`);
        }
        if (options.removeOld) {
            // The old config is fully carried over only when every one of its keys is now in the new file. A key the old
            // file has and the new one does not is still a reason to keep the folder.
            const stillMissing = Object.keys(old as Record<string, unknown>).some((key) => !(key in current));
            if (!stillMissing) {
                if (!options.dryRun) rmSync(oldFolder, { recursive: true, force: true });
                report.oldRemoved.push(`mods/${oldName}`);
            } else if (!options.dryRun) report.oldKept.push(`mods/${oldName}`);
        }
    }
}

export function install(target: string, options: Options = {}): Report {
    const source = options.source ?? SOURCE;
    if (!existsSync(target) || !statSync(target).isDirectory()) {
        throw new Error(
            `${target} is not a folder: start the Herdr app once so that it makes its config folder, or name the right one`,
        );
    }
    const report: Report = {
        added: [],
        updated: [],
        same: [],
        replaced: [],
        skipped: [],
        removed: [],
        keys: { added: [], migrated: [], kept: [] },
        migrated: [],
        oldKept: [],
        oldRemoved: [],
    };
    const manifest = readManifest(target);
    const next: Manifest = { version: 1, files: { ...manifest.files } };
    const write = (rel: string, data: Buffer) => {
        if (options.dryRun) return;
        const dest = path.join(target, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, data);
    };

    // Before the new mod files land: an old user's config must win over the new defaults, while a new config the person
    // already edited wins over the old one.
    migrateConfigs(target, options, report);
    const files = installOrder(source);
    for (const rel of files) {
        const data = readFileSync(path.join(source, rel));
        const dest = path.join(target, rel);
        if (!existsSync(dest)) {
            write(rel, data);
            report.added.push(rel);
            if (!OWN.has(path.basename(rel))) next.files[rel] = hash(data);
            continue;
        }
        const there = hash(readFileSync(dest));
        if (there === hash(data)) {
            report.same.push(rel);
            if (!OWN.has(path.basename(rel))) next.files[rel] = there;
        } else if (OWN.has(path.basename(rel))) {
            report.same.push(rel); // yours: kept as it is, even with --force
        } else if (manifest.files[rel] === there) {
            write(rel, data);
            next.files[rel] = hash(data);
            report.updated.push(rel);
        } else if (options.force) {
            write(rel, data);
            next.files[rel] = hash(data);
            report.replaced.push(rel);
        } else {
            report.skipped.push({
                file: rel,
                reason: manifest.files[rel]
                    ? "you changed it since it was installed"
                    : "it was not installed by this script",
            });
        }
    }

    // A file an earlier version installed, that this version no longer has: removed if you did not change it.
    for (const [rel, was] of Object.entries(manifest.files)) {
        if (files.includes(rel)) continue;
        const dest = path.join(target, rel);
        if (existsSync(dest) && hash(readFileSync(dest)) === was) {
            if (!options.dryRun) rmSync(dest);
            report.removed.push(rel);
        }
        delete next.files[rel];
    }
    if (!options.dryRun) removeEmptiedMods(target, report.removed);

    mergeKeys(source, target, options, report);
    if (!options.dryRun) writeFileSync(path.join(target, MANIFEST), `${JSON.stringify(next, null, 2)}\n`);
    return report;
}

function main(argv: string[]): number {
    const flags = argv.filter((a) => a.startsWith("--"));
    const names = argv.filter((a) => !a.startsWith("--"));
    const unknown = flags.filter((f) => f !== "--force" && f !== "--dry-run" && f !== "--remove-old");
    if (unknown.length || names.length > 1) {
        console.error("usage: node install.ts [herdr config folder] [--force] [--dry-run] [--remove-old]");
        return 2;
    }
    const target = path.resolve(names[0] ?? process.env.HERDR_APP_HOME ?? path.join(homedir(), ".config", "herdr-app"));
    const dryRun = flags.includes("--dry-run");
    let report: Report;
    try {
        report = install(target, {
            force: flags.includes("--force"),
            dryRun,
            removeOld: flags.includes("--remove-old"),
        });
    } catch (e) {
        console.error((e as Error).message);
        return 1;
    }
    const say = (label: string, list: string[]) => {
        if (list.length) console.log(`${label} (${list.length}): ${list.join(", ")}`);
    };
    console.log(`${dryRun ? "Would install" : "Installed"} into ${target}`);
    say(dryRun ? "would add" : "added", report.added);
    say(dryRun ? "would update" : "updated", report.updated);
    say(dryRun ? "would replace" : "replaced", report.replaced);
    say(dryRun ? "would remove" : "removed", report.removed);
    console.log(`unchanged: ${report.same.length}`);
    say(dryRun ? "would migrate" : "migrated", report.migrated);
    if (report.oldKept.length)
        console.log(`old mod folders kept (their config.json is yours): ${report.oldKept.join(", ")}`);
    say(dryRun ? "would remove old mod folder" : "removed old mod folder", report.oldRemoved);
    say("keys.json, added", report.keys.added);
    say("keys.json, migrated", report.keys.migrated);
    say("keys.json, kept as yours", report.keys.kept);
    for (const s of report.skipped) console.log(`LEFT ALONE ${s.file}: ${s.reason}`);
    if (report.keys.error) console.log(`keys.json NOT MERGED: ${report.keys.error}`);
    if (report.skipped.length)
        console.log("Some files were left alone: run again with --force to replace them with this version.");
    return report.skipped.length || report.keys.error ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
