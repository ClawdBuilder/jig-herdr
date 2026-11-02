// A Jig palette as a Herdr theme. Pure, so the mod, the script that writes themes/ and the tests all
// use this one function.
//
// A palette (the "vars" of a jig-theme file) names 17 colours; Herdr wants a terminal theme plus
// panel colours. Dark palettes keep a black window, like Pi in a black terminal, and only the
// highlights (accent, selection, states, terminal colours) come from the palette.

const HEX = /^#[0-9a-fA-F]{6}$/;

// The colours of a palette that the conversion reads. A palette without all of them, as plain
// #rrggbb, is not converted (Pi accepts other forms, such as oklch(), that Herdr's themes do not).
export const NEEDED = [
    "bg",
    "panel",
    "selected",
    "text",
    "soft",
    "muted",
    "dim",
    "border",
    "borderMuted",
    "accent",
    "link",
    "heading",
    "info",
    "success",
    "warning",
    "error",
];

const BLACK = { bg: "#0A0A0A", frame: "#000000", raised: "#111111", line: "#262626" };

// vars: a palette's named colours. appearance: "dark" (default) or "light". Returns null when a colour is missing.
export function toHerdr(vars, appearance) {
    if (!NEEDED.every((k) => HEX.test(vars?.[k] ?? ""))) return null;
    const v = vars;
    const dark = appearance !== "light";
    const bg = dark ? BLACK.bg : v.bg;
    const frame = dark ? BLACK.frame : v.panel;
    const raised = dark ? BLACK.raised : v.panel;
    const line = dark ? BLACK.line : v.border;
    return {
        background: bg,
        foreground: v.soft,
        selection: v.selected,
        cursor: v.accent,
        ansi: [
            dark ? line : v.borderMuted,
            v.error,
            v.success,
            v.warning,
            v.info,
            v.heading,
            v.link,
            v.soft,
            v.dim,
            v.error,
            v.success,
            v.warning,
            v.info,
            v.heading,
            v.link,
            v.text,
        ],
        colors: {
            canvas: frame,
            chrome: frame,
            surface: raised,
            popover: raised,
            selected: v.selected,
            border: line,
            muted: v.muted,
            dim: v.dim,
            accent: v.accent,
            accent_foreground: bg,
            solid: v.accent,
            solid_foreground: bg,
            working: v.info,
            blocked: v.warning,
            done: v.success,
            idle: v.dim,
        },
    };
}

// The text of a theme file: what the mod and the script both write, so they never disagree.
export function themeText(herdrTheme) {
    return `${JSON.stringify(herdrTheme, null, 2)}\n`;
}
