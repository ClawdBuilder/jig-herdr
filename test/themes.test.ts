// The Herdr themes shipped in herdr/themes/ are what the conversion makes from jig-theme's palettes, one each.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { herdrThemes, PALETTES, THEMES } from "../scripts/build-themes.ts";
import { load } from "./support.ts";

type Theme = { background: string; foreground: string; ansi: string[]; colors: Record<string, string> };
type Convert = { toHerdr(vars: unknown, appearance?: string): Theme | null; NEEDED: string[] };

test("herdr/themes has one theme for each palette of jig-theme and nothing else", () => {
    assert.deepEqual(readdirSync(THEMES).sort(), readdirSync(PALETTES).sort());
    assert.equal(readdirSync(THEMES).length, 6);
});

test("each committed theme is what the conversion makes now: run scripts/build-themes.ts after a change", async () => {
    for (const [file, text] of Object.entries(await herdrThemes())) {
        assert.equal(readFileSync(path.join(THEMES, file), "utf8"), text, `${file} is out of date`);
    }
});

test("a theme has the 16 terminal colours and the panel colours, all #rrggbb", async () => {
    for (const file of readdirSync(THEMES)) {
        const theme = JSON.parse(readFileSync(path.join(THEMES, file), "utf8")) as Theme;
        assert.equal(theme.ansi.length, 16, file);
        const all = [theme.background, theme.foreground, ...theme.ansi, ...Object.values(theme.colors)];
        for (const colour of all) assert.match(colour, /^#[0-9A-Fa-f]{6}$/, `${file}: ${colour}`);
        for (const name of ["canvas", "chrome", "surface", "accent", "working", "blocked", "done", "idle"]) {
            assert.ok(theme.colors[name], `${file} has ${name}`);
        }
    }
});

test("a dark palette keeps a black window and a light one takes the palette's own backgrounds", async () => {
    const { toHerdr } = await load<Convert>("mods/jig-theme-sync/convert.js");
    const palette = (name: string) =>
        JSON.parse(readFileSync(path.join(PALETTES, `${name}.json`), "utf8")) as {
            vars: Record<string, string>;
            appearance: string;
        };
    const lime = palette("jig-lime");
    assert.equal(toHerdr(lime.vars, lime.appearance)?.colors.canvas, "#000000");
    const paper = palette("jig-paper");
    assert.equal(paper.appearance, "light");
    assert.equal(toHerdr(paper.vars, paper.appearance)?.colors.chrome, paper.vars.panel);
});

test("a palette that lacks a colour, or has one that is not #rrggbb, is not converted", async () => {
    const { toHerdr, NEEDED } = await load<Convert>("mods/jig-theme-sync/convert.js");
    const lime = JSON.parse(readFileSync(path.join(PALETTES, "jig-lime.json"), "utf8")) as {
        vars: Record<string, string>;
    };
    assert.ok(toHerdr(lime.vars));
    assert.equal(toHerdr({ ...lime.vars, accent: "oklch(0.8 0.2 130)" }), null);
    for (const name of NEEDED) assert.equal(toHerdr({ ...lime.vars, [name]: "" }), null, name);
    assert.equal(toHerdr(undefined), null);
});
