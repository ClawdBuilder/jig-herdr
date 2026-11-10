// Loads a mod with Herdr/GPUI stubs whose live data, exec replies and timer/notify are driven by the test.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const methods = JSON.parse(readFileSync(new URL("./element-methods.json", import.meta.url), "utf8"));
const source = `
const chain = ${JSON.stringify(methods.NativeElement)}.reduce((c, k) => c, null);
const allowed = new Set(${JSON.stringify(methods.NativeElement)});
const element = new Proxy(function () {}, {
    get: (_t, k) => {
        if (k === "then") return undefined;
        if (typeof k !== "string") return undefined;
        if (!allowed.has(k)) throw new TypeError(k + " is not a function");
        return element;
    },
    apply: () => element,
});
export const h_flex = element, v_flex = element, h_resizable = element, resizable_panel = element, v_virtual_list = element;
export const div = element, svg = element, image = element;
const state = (allowed) => new Proxy({}, { get: (_t, k) => {
    if (k === "then") return undefined;
    if (typeof k !== "string") return undefined;
    if (k === "value") return () => "";
    if (k === "is_focused") return () => true;
    if (!allowed.includes(k)) throw new TypeError(k + " is not a function");
    return () => state(allowed);
}});
export class View { constructor() {} }
export class Input { static new() { return element; } }
export class Textarea { static new() { return element; } }
export class InputState { static new() { return state(${JSON.stringify(methods.InputState)}); } }
export class TextareaState { static new() { return state(${JSON.stringify(methods.TextareaState)}); } }
export class Editor { static new() { return element; } }
export class EditorState { static new() { return state(${JSON.stringify(methods.EditorState)}); } }
export class Scrollbar { static vertical() { return element; } }
export class TextView { static markdown() { return element; } }
const noop = () => {};
const empty = () => [];
const C = globalThis.__CTX;
export const agents = () => C.agents ?? [];
export const appHome = () => "/tmp";
export const closeOverlay = noop;
export const exec = (cmd, args, options) => C.exec(cmd, args, options);
export const focused = () => C.focused;
export const hc = async () => ({ code: 0, stdout: "", stderr: "" });
export const home = "/tmp";
export const layout = () =>
    C.shown
        ? {
              type: "stack",
              id: "panel-body",
              active: C.shown,
              children: [{ id: C.shown, type: "block", content: { mod: C.shown } }],
          }
        : { children: [] };
export const nextCommand = () => new Promise(() => {});
export const notify = noop;
export const openOverlay = noop;
export const panes = () => C.panes;
export const props = () => ({});
export const readTextFile = async () => null;
export const run = async () => ({});
export const setShared = (key, value) => {
    C.shared = C.shared ?? {};
    C.shared[key] = value;
};
export const settings = () => ({ ui_font_size: 13 });
export const shared = (key) => C.shared?.[key];
export const spaces = () => [{ active: true, id: "s", folder: C.folder, machine: null, tabs: [] }];
export const terminals = empty;
export const theme = () => new Proxy(() => {}, { get: (_t, k) => (k === "then" ? undefined : "#808080") });
export const window = () => ({ active: true, platform: "linux" });
export const writeTextFile = async () => {};
`;
const url = `data:text/javascript,${encodeURIComponent(source)}`;
const bare = new Set(["herdr", "gpui-base", "gpui-kit"]);
registerHooks({
    resolve(specifier, context, next) {
        return bare.has(specifier) ? { url, shortCircuit: true } : next(specifier, context);
    },
});
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export async function load(name, props = {}) {
    const mod = await import(new URL(`../../mods/${name}/main.js?ctx=${Math.random()}`, import.meta.url));
    const timers = [];
    const notifies = { count: 0 };
    const cx = {
        timer: { every: (ms, fn) => timers.push({ ms, fn }), after: (ms, fn) => timers.push({ ms, fn }) },
        spawn: (fn) =>
            void Promise.resolve()
                .then(() => fn(cx))
                .catch((e) => {
                    throw e;
                }),
        notify: () => notifies.count++,
        focus_handle: () => ({ focus() {}, blur() {}, is_focused: () => true }),
        write_to_clipboard: () => {},
    };
    const view = new mod.default(props, cx);
    await view.init(props, cx);
    return { view, cx, timers, notifies };
}
