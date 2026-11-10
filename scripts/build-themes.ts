// Writes one Herdr theme for each built-in Jig palette into herdr/themes/: `node herdr/scripts/build-themes.ts`.
// The files are committed. A test compares them with what this makes, so a change to a palette or to the conversion
// that was not followed by a run of this script fails there.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The palettes from the published Jig package, never a relative path into Jig. */
export const PALETTES = path.join(
    path.dirname(fileURLToPath(import.meta.resolve("@clawdbuilder/jig/package.json"))),
    "contracts/palettes.json",
);
/** Where the Herdr themes go, and the conversion the mod uses. */
export const THEMES = path.resolve(import.meta.dirname, "../themes");
const CONVERT = path.resolve(import.meta.dirname, "../mods/jig-theme-sync/convert.js");

interface Converter {
    toHerdr(vars: unknown, appearance: unknown): unknown;
    themeText(theme: unknown): string;
}

/** Every built-in palette as the text of its Herdr theme, by file name (`jig-lime.json`). */
export async function herdrThemes(): Promise<Record<string, string>> {
    const convert = (await import(pathToFileURL(CONVERT).href)) as Converter;
    const out: Record<string, string> = {};
    const all = JSON.parse(readFileSync(PALETTES, "utf8")) as Record<string, unknown>;
    for (const file of Object.keys(all).sort()) {
        const palette = all[file] as {
            vars: unknown;
            appearance: unknown;
        };
        const theme = convert.toHerdr(palette.vars, palette.appearance);
        if (theme === null) throw new Error(`${file}: a colour the conversion needs is missing or is not #rrggbb`);
        out[file] = convert.themeText(theme);
    }
    return out;
}

if (import.meta.main) {
    mkdirSync(THEMES, { recursive: true });
    const themes = await herdrThemes();
    for (const [file, text] of Object.entries(themes)) writeFileSync(path.join(THEMES, file), text);
    console.log(`${Object.keys(themes).length} themes written to ${THEMES}`);
}
