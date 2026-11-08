// Every mod's main.js is imported and its init path runs with Herdr and the GPUI modules stubbed. A ReferenceError that
// only appears when the mod loads or constructs a view (as the missing readTimeoutSeconds import did) fails here.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const chain = new Proxy(function () {}, {
    get: (_target, name) => (name === "then" ? undefined : chain),
    apply: () => chain,
});
const source = `
const chain = new Proxy(function () {}, {
    get: (_target, name) => (name === "then" ? undefined : chain),
    apply: () => chain,
});
export const h_flex = chain, v_flex = chain, h_resizable = chain, resizable_panel = chain, v_virtual_list = chain;
export const div = chain, svg = chain, image = chain;
export class View { constructor() {} }
export class Input {}
export class InputState { static new() { return { on() {}, value() { return ""; }, focus() {}, blur() {} }; } }
export class Editor {}
export class EditorState { static new() { return { on() {} }; } }
export class Scrollbar {}
export class TextView { static markdown() { return chain; } }
const noop = () => {};
const empty = () => [];
const stub = new Proxy(function () {}, { get: (_t, name) => (name === "then" ? undefined : chain), apply: () => chain });
export const agents = empty, appHome = () => "/tmp", closeOverlay = noop, exec = async () => ({ code: 1, stdout: "", stderr: "stub" });
export const focused = () => null, home = "/tmp", layout = () => ({ children: [] }), nextCommand = () => new Promise(() => {});
export const notify = noop, openOverlay = noop, panes = empty, props = () => ({}), readTextFile = async () => null;
export const run = async () => ({}), setShared = noop, settings = () => ({}), shared = () => undefined, spaces = empty;
export const terminals = empty, theme = () => stub, watchFolder = () => new Promise(() => {}), window = () => ({ active: true, platform: "linux" });
export const writeTextFile = async () => {};
`;
const bare = new Set(["herdr", "gpui-base", "gpui-kit"]);
const url = `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
    resolve(specifier, context, next) {
        return bare.has(specifier) ? { url, shortCircuit: true } : next(specifier, context);
    },
});

const mods = [
    "file-view",
    "jig-activity",
    "jig-context",
    "jig-files",
    "jig-tabs",
    "jig-theme-sync",
    "jig-work",
    "keep-awake",
    "repo-changes",
    "repo-history",
    "repo-prs",
    "repo-review",
    "repo-worktrees",
];

Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

for (const name of mods) {
    test(`${name}/main.js loads and initialises`, async () => {
        const module = await import(new URL(`../mods/${name}/main.js?evaluate`, import.meta.url));
        assert.equal(typeof module.default, "function", `${name}: default export`);
        const cx = {
            timer: { every: () => () => {}, after: () => () => {} },
            spawn: (fn: (cx: unknown) => unknown) => {
                void Promise.resolve()
                    .then(() => fn(cx))
                    .catch(() => {});
            },
            notify: () => {},
            focus_handle: () => ({ focus: () => {}, blur: () => {} }),
            write_to_clipboard: () => {},
        };
        const view = new module.default({}, cx);
        await view.init({}, cx);
    });
}
