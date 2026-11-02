// Copies the layout, mods, themes and keys of herdr/ into a Herdr config folder:
// `node herdr/scripts/install.ts [folder] [--force] [--dry-run]`.
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
const SOURCE = path.resolve(import.meta.dirname, "..");
/** Files the Herdr app writes into every mod folder for editors. A folder left with only these is a removed mod's. */
const APP_WRITTEN = new Set(["gpui-kit.d.ts", "jsconfig.json"]);

export interface Options {
    /** Replace files that are not this script's (never a config.json), and take over keys.json keys that differ. */
    force?: boolean;
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
    /** keys.json: keys added, and keys kept because the file already binds that key to something else. */
    keys: { added: string[]; kept: string[]; error?: string };
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
        keys: { added: [], kept: [] },
    };
    const manifest = readManifest(target);
    const next: Manifest = { version: 1, files: { ...manifest.files } };
    const write = (rel: string, data: Buffer) => {
        if (options.dryRun) return;
        const dest = path.join(target, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, data);
    };

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
    const unknown = flags.filter((f) => f !== "--force" && f !== "--dry-run");
    if (unknown.length || names.length > 1) {
        console.error("usage: node install.ts [herdr config folder] [--force] [--dry-run]");
        return 2;
    }
    const target = path.resolve(names[0] ?? process.env.HERDR_APP_HOME ?? path.join(homedir(), ".config", "herdr-app"));
    const dryRun = flags.includes("--dry-run");
    let report: Report;
    try {
        report = install(target, { force: flags.includes("--force"), dryRun });
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
    say("keys.json, added", report.keys.added);
    say("keys.json, kept as yours", report.keys.kept);
    for (const s of report.skipped) console.log(`LEFT ALONE ${s.file}: ${s.reason}`);
    if (report.keys.error) console.log(`keys.json NOT MERGED: ${report.keys.error}`);
    if (report.skipped.length)
        console.log("Some files were left alone: run again with --force to replace them with this version.");
    return report.skipped.length || report.keys.error ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
