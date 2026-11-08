// Validates a built share/ tree or the gallery repository. It needs no Herdr: listing shape, recipes, previews, layout
// dependencies, no stray/dev files, and the private word list when one is present.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || "share");
const LISTINGS = new Set([
    "jig-workbench",
    "jig-repos",
    "jig-history",
    "jig-prs",
    "jig-worktrees",
    "jig-review",
    "jig-keep-awake",
]);
const LAYOUT = "jig-workbench";
const SHIPPED = new Set(["workspace-chrome", "spaces", "agents", "tabs", "pane"]);
const SECTIONS = ["What you see:", "How it behaves:", "Built from:", "Watch out:", "Done when:"];
const failures = [];
const fail = (message) => failures.push(message);
const exists = (file) => {
    try {
        return statSync(file).isFile();
    } catch {
        return false;
    }
};
const tree = (root, prefix = "") =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(prefix, entry.name);
        return entry.isDirectory() ? tree(path.join(root, entry.name), relative) : [relative];
    });

let top;
try {
    top = readdirSync(ROOT, { withFileTypes: true });
} catch {
    console.error(`gallery: ${ROOT} is not readable`);
    process.exit(1);
}
for (const entry of top) {
    if (!entry.isDirectory() || !LISTINGS.has(entry.name)) fail(`${entry.name}: not a known listing folder`);
}
for (const id of LISTINGS) {
    const dir = path.join(ROOT, id);
    if (!statSync(dir).isDirectory()) {
        fail(`${id}: missing`);
        continue;
    }
    const recipe = path.join(dir, "RECIPE.md");
    if (!exists(recipe)) fail(`${id}: RECIPE.md missing`);
    else {
        const text = readFileSync(recipe, "utf8");
        if (!/^# \S/m.test(text)) fail(`${id}: RECIPE.md needs a # name`);
        let at = -1;
        for (const section of SECTIONS) {
            const next = text.indexOf(`**${section}**`);
            if (next < 0) fail(`${id}: RECIPE missing ${section}`);
            else if (next < at) fail(`${id}: RECIPE sections out of order at ${section}`);
            else at = next;
        }
    }
    const preview = path.join(dir, "preview.png");
    if (!exists(preview)) fail(`${id}: preview.png missing`);
    else {
        const bytes = readFileSync(preview);
        if (
            bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
            bytes.length < 1000 ||
            bytes.length > 5_000_000
        )
            fail(`${id}: preview.png is not a sane PNG`);
    }
    if (!statSync(path.join(dir, "mods")).isDirectory()) fail(`${id}: mods/ missing`);
    for (const file of tree(dir)) {
        if (path.basename(file) === "gpui-kit.d.ts" || path.basename(file) === "jsconfig.json")
            fail(`${id}: dev file ${file}`);
        if (/(^|\/)test\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file)) fail(`${id}: test file ${file}`);
    }
    const mods = exists(path.join(dir, "mods")) ? readdirSync(path.join(dir, "mods"), { withFileTypes: true }) : [];
    for (const mod of mods) {
        if (!mod.isDirectory() || !exists(path.join(dir, "mods", mod.name, "mod.json")))
            fail(`${id}: mods/${mod.name} has no mod.json`);
    }
    if (id === LAYOUT) {
        const layouts = readdirSync(path.join(dir, "layouts")).filter((name) => name.endsWith(".json"));
        if (layouts.length !== 1) fail(`${id}: exactly one layouts/*.json is required`);
        for (const layout of layouts) {
            const nodes = JSON.parse(readFileSync(path.join(dir, "layouts", layout), "utf8"));
            const visit = (node) => {
                const mod = node?.content?.mod;
                if (typeof mod === "string" && !SHIPPED.has(mod) && !exists(path.join(dir, "mods", mod, "mod.json")))
                    fail(`${id}: layout names missing mod ${mod}`);
                for (const child of node?.children ?? []) visit(child);
            };
            visit(nodes);
        }
    } else {
        const own = path.join(dir, "mods", id);
        if (!exists(path.join(own, "mod.json"))) fail(`${id}: its own mod is missing`);
        for (const mod of mods) if (mod.name !== id) fail(`${id}: stray mod ${mod.name}`);
    }
}
const wordFile = process.env.JIG_SCAN_WORDS || path.join(homedir(), ".config", "jig", "scan-words.txt");
let words = [];
try {
    words = readFileSync(wordFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
} catch {}
if (words.length) {
    const blocked = new RegExp(
        `\\b(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
        "i",
    );
    for (const file of tree(ROOT))
        if (/\.(md|json|js|mjs|txt|svg)$/.test(file) && blocked.test(readFileSync(path.join(ROOT, file), "utf8")))
            fail(`${file}: matches a private word`);
}
if (failures.length) {
    for (const failure of failures) console.error(`gallery: ${failure}`);
    process.exit(1);
}
console.log(`gallery: ${LISTINGS.size} listings clean`);
