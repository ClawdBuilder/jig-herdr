import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const GALLERY = path.resolve(import.meta.dirname, "../gallery");

/** The shared Header paragraph, from its marker through the following blank line. */
function header(text: string): string | null {
    const start = text.indexOf("**Header:**");
    if (start < 0) return null;
    const end = text.indexOf("\n\n", start);
    return text.slice(start, end < 0 ? text.length : end);
}

test("every listed recipe carries the same Header paragraph", () => {
    const copies = readdirSync(GALLERY)
        .map((id) => ({ id, text: readFileSync(path.join(GALLERY, id, "RECIPE.md"), "utf8") }))
        .map(({ id, text }) => ({ id, header: header(text) }))
        .filter(({ header }) => header !== null);
    assert.equal(copies.length, 5, "the five Git-derived recipes");
    const first = copies[0];
    for (const copy of copies) assert.equal(copy.header, first.header, `${copy.id}/RECIPE.md Header paragraph differs`);
});
