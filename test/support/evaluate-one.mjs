// Imports one mod with Herdr and GPUI stubbed, removes the JS timer and Node globals the Herdr runtime lacks, then calls
// its init path. Run in a child process by evaluate-mods.test.ts so one broken mod cannot affect the test runner.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const name = process.argv[2];
const saved = new Map();
for (const global of [
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "setImmediate",
    "process",
    "require",
    "Buffer",
]) {
    if (global in globalThis) {
        saved.set(global, globalThis[global]);
        delete globalThis[global];
    }
}
const sleep = saved.get("setTimeout");

const chain = new Proxy(() => {}, {
    get: (_target, key) => (key === "then" ? undefined : chain),
    apply: () => chain,
});
const source = `
const chain = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : chain), apply: () => chain });
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
const stub = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : chain), apply: () => chain });
export const agents = empty, appHome = () => "/tmp", closeOverlay = noop;
export const exec = async () => { globalThis.__jigExecCalls = (globalThis.__jigExecCalls ?? 0) + 1; return { code: 0, stdout: "", stderr: "" }; };
export const focused = () => ({ cwd: "/tmp/jig-eval" }), home = "/tmp", layout = () => ({ children: [] });
export const nextCommand = () => new Promise(() => {});
export const notify = noop, openOverlay = noop, panes = empty, props = () => ({}), readTextFile = async () => null;
export const run = async () => ({}), setShared = noop, settings = () => ({}), shared = () => undefined;
export const spaces = () => [{ active: true, id: "s1", folder: "/tmp/jig-eval", machine: null }];
export const terminals = empty, theme = () => stub, watchFolder = () => new Promise(() => {});
export const window = () => ({ active: true, platform: "linux" }), writeTextFile = async () => {};
`;
const bare = new Set(["herdr", "gpui-base", "gpui-kit"]);
const url = `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
    resolve(specifier, context, next) {
        return bare.has(specifier) ? { url, shortCircuit: true } : next(specifier, context);
    },
});
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.__jigExecCalls = 0;
try {
    const module = await import(new URL(`../../mods/${name}/main.js?evaluate`, import.meta.url));
    assert.equal(typeof module.default, "function", `${name}: default export`);
    const cx = {
        timer: { every: () => () => {}, after: () => () => {} },
        spawn: (fn) => {
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
    if (["jig-repos", "jig-history", "jig-prs", "jig-worktrees"].includes(name)) {
        for (let i = 0; i < 20 && globalThis.__jigExecCalls === 0; i++) await new Promise((r) => sleep(r, 10));
        assert.ok(globalThis.__jigExecCalls > 0, `${name}: started a read`);
    }
} finally {
    for (const [global, value] of saved) globalThis[global] = value;
}
