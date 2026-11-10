// Imports one mod with Herdr and GPUI stubbed, removes the JS timer and Node globals the Herdr runtime lacks, then calls
// its init path. Run in a child process by evaluate-mods.test.ts so one broken mod cannot affect the test runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const name = process.argv[2];
const bench = process.env.JIG_BENCH === "1";
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
const source = `
const allowedElements = new Set(${JSON.stringify(methods.NativeElement)});
const chain = new Proxy(function () {}, {
    get: (_t, k) => {
        if (k === "then") return undefined;
        if (typeof k !== "string") return undefined;
        if (!allowedElements.has(k)) throw new TypeError(k + " is not a function");
        if (globalThis.__elCalls !== undefined) globalThis.__elCalls++;
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
export const spaces = () => [{ active: true, id: "s1", folder: "/tmp/jig-eval", machine: null, tabs: [] }];
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
    if (bench) {
        const date = new Date().toISOString();
        const commits = Array.from({ length: 500 }, (_, i) => ({
            hash: String(i).padStart(40, "0"),
            subject: `Commit ${i}`,
            author: `Author ${i % 5}`,
            date,
            parents: i % 7 ? [String(i - 1).padStart(40, "0")] : [],
            refs: [],
            head: i === 0,
        }));
        const rows = Array.from({ length: 2000 }, (_, i) => ({
            kind: i % 9 ? " " : "+",
            number: i + 1,
            text: `line ${i}`,
        }));
        const trees = Array.from({ length: 30 }, (_, i) => ({
            main: "/work/main",
            path: i === 0 ? "/work/main" : `/work/trees/${i}`,
            branch: `feature/${i}`,
            head: String(i).padStart(40, "0"),
            locked: null,
            dirty: 0,
            ahead: 0,
            behind: 0,
            baseAhead: i % 2,
            upstream: "origin/main",
            gone: false,
            unpushed: 0,
            base: "main",
            date,
            created: null,
            subject: `Tree ${i}`,
        }));
        const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/file-${i}.ts`, xy: " M", staged: false }));
        if (name === "jig-worktrees") {
            view.where = { root: "/work", on: null };
            view.trees = trees;
            view.single = true;
            view.loadedAt = Date.now();
        } else if (name === "jig-review") {
            view.fixed = true;
            view.repo = "/work/app";
            view.name = "app";
            view.width = 900;
            view.loaded = true;
            view.files = files;
            view.sel = files[0].path;
            view.rows = rows;
        } else if (name === "jig-history") {
            view.where = { root: "/work", on: null };
            view.repo = "/work/app";
            view.single = true;
            view.commits = commits;
            view.rows = commits.map((c, i) => ({ ...c, width: 1, lane: 0, color: i % 3 }));
            view.loadedAt = Date.now();
        } else if (name === "jig-git") {
            view.locate = () => "bench";
            view.context = "bench";
            view.loadedContext = "bench";
            view.loc = { root: "/work", on: null, space: "s1", follow: true };
            view.where = view.loc;
            view.loaded = true;
            view.width = 544;
            view.repos = Array.from({ length: 50 }, (_, i) => ({
                path: `/work/repo-${i}`,
                name: `repo-${i}`,
                folder: `repo-${i}`,
                common: `/work/repo-${i}/.git`,
                linked: false,
                branch: i % 3 ? `feature/${i}` : "main",
                detached: false,
                upstream: "origin/main",
                gone: false,
                ahead: i % 3 === 0 ? 1 : 0,
                behind: 0,
                unborn: false,
                head: { hash: "abc1234", subject: "s", at: Date.now() },
                remote: "origin",
                files: Array.from({ length: i === 0 ? 200 : 4 }, (_, j) => ({
                    path: `src/file-${j}.ts`,
                    status: "M",
                    staged: i === 0 && j < 2,
                    unstaged: true,
                    xy: " M",
                })),
                total: i === 0 ? 200 : 4,
                staged: i === 0 ? 2 : 0,
                base: null,
                error: null,
            }));
            view.opened.add("/work/repo-0");
            view.rebuildView();
        } else if (name === "jig-prs") {
            view.where = { root: "/work", on: null };
            view.loadedAt.main = Date.now();
            view.data.main = {
                repos: Array.from({ length: 40 }, (_, i) => ({
                    path: `/work/repo-${i}`,
                    name: `repo-${i}`,
                    branch: `feature/${i}`,
                    status: "pr",
                    pr: {
                        url: `https://github.com/x/y/pull/${i}`,
                        number: i,
                        title: `PR ${i}`,
                        state: "OPEN",
                        checks: [{ bucket: i % 2 ? "pending" : "pass", name: "test" }],
                        additions: 3,
                        deletions: 1,
                    },
                })),
            };
        }
        for (let i = 0; i < 3; i++) view.render(cx);
        globalThis.__elCalls = 0;
        const start = performance.now();
        for (let i = 0; i < 20; i++) view.render(cx);
        console.log(`BENCH ${name} ${(performance.now() - start) / 20}`);
        console.log(`BENCHEL ${name} ${globalThis.__elCalls / 20}`);
        saved.get("process").exit(0);
    }
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
