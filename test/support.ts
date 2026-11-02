import path from "node:path";
import { pathToFileURL } from "node:url";

/** The herdr/ folder: what the install script copies (layouts, mods, themes, keys.json) and its own scripts, docs and tests. */
export const HERDR = path.resolve(import.meta.dirname, "..");
export const PLUGIN = HERDR;

/** Loads a file of herdr/ that has no imports from the Herdr app, such as a mod's lib.js. The mods are plain JavaScript, so
 * the result is typed by the test that asks for it. */
export async function load<T>(relative: string): Promise<T> {
    return (await import(pathToFileURL(path.join(HERDR, relative)).href)) as T;
}
