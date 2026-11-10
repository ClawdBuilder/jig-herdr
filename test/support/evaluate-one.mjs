// Imports one mod with Herdr and GPUI stubbed, removes the JS timer and Node globals the Herdr runtime lacks, then calls
// its init path. Run in a child process by evaluate-mods.test.ts so one broken mod cannot affect the test runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const methods = JSON.parse(readFileSync(new URL("./element-methods.json", import.meta.url), "utf8"));
/** A fluent chain that only knows the methods Herdr really exposes on elements. */
function chainFor(allowed) {
    const names = new Set(allowed);
    const chain = new Proxy(() => chain, {
        get: (_target, key) => {
            if (key === "then") return undefined;
            if (typeof key !== "string") return undefined;
            if (!names.has(key)) throw new TypeError(`${key} is not a function`);
            return chain;
        },
        apply: () => chain,
    });
    return chain;
}
const chain = chainFor(methods.NativeElement);

const source = `
const allowedElements = new Set(${JSON.stringify(methods.NativeElement)});
const chain = new Proxy(function () {}, {
    get: (_t, k) => {
        if (k === "then") return undefined;
        if (typeof k !== "string") return undefined;
        if (!allowedElements.has(k)) throw new TypeError(k + " is not a function");
        return chain;
    },
    apply: () => chain,
});
export const h_flex = chain, v_flex = chain, h_resizable = chain, resizable_panel = chain, v_virtual_list = chain;
export const div = chain, svg = chain, image = chain;
export class View { constructor() {} }
function stateFor(allowed) {
    return new Proxy({}, {
        get: (_t, k) => {
            if (k === "then") return undefined;
            if (typeof k !== "string") return undefined;
            if (k === "value") return () => "";
            if (k === "is_focused") return () => true;
            if (!allowed.includes(k)) throw new TypeError(k + " is not a function");
            return () => stateFor(allowed);
        },
    });
}
export class Input { static new() { return chain; } }
export class Textarea { static new() { return chain; } }
export class TextareaState { static new() { return stateFor(${JSON.stringify(methods.TextareaState)}); } }
export class InputState { static new() { return stateFor(${JSON.stringify(methods.InputState)}); } }
export class Editor {}
export class EditorState { static new() { return stateFor(${JSON.stringify(methods.EditorState)}); } }
export class Scrollbar { static vertical() { return chain; } }
export class TextView { static markdown() { return chain; } }
const noop = () => {};
const empty = () => [];
const stub = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : chain), apply: () => chain });
export const agents = empty, appHome = () => "/tmp", closeOverlay = noop;
export const exec = async (_cmd, _args, options = {}) => {
    globalThis.__jigExecCalls = (globalThis.__jigExecCalls ?? 0) + 1;
    globalThis.__jigExecOptions = options;
    return { code: 0, stdout: "", stderr: "" };
};
export const hc = async () => ({ code: 0, stdout: "", stderr: "" }), focused = () => ({ cwd: "/tmp/jig-eval" }), home = "/tmp", layout = () => ({ children: [] });
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
    assert.equal(typeof view.render, "function", `${name}: render`);
    view.render(cx);
    if (name === "jig-review") {
        view.fixed = true;
        view.repo = "/tmp/jig-eval";
        view.name = "jig-eval";
        view.loaded = true;
        view.files = [{ path: "a.ts", xy: " M", staged: false }];
        view.sel = "a.ts";
        view.rows = [{ kind: "+", number: 1, text: "one" }];
        view.comments = [
            { id: "c1", file: "a.ts", side: "new", startLine: 1, endLine: 1, quote: ["one"], note: "note" },
        ];
        view.draft = { side: "new", startLine: 1, endLine: 1, quote: ["one"], note: "" };
        view.render(cx);
    }
    if (["jig-git", "jig-history", "jig-prs", "jig-worktrees"].includes(name)) {
        for (let i = 0; i < 20 && globalThis.__jigExecCalls === 0; i++) await new Promise((r) => sleep(r, 10));
        assert.ok(globalThis.__jigExecCalls > 0, `${name}: started a read`);
    }
} finally {
    for (const [global, value] of saved) globalThis[global] = value;
}
