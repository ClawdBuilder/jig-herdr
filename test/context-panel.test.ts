// The Context panel (mods/jig-context): its session finding, the bar and its legend, and the request it writes, which the
// jig-session plugin must read as its contract says.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { parseRequest, takeRequest } from "../../plugins/jig-session/src/requests.ts";
import { HERDR, load } from "./support.ts";

type Pending = { tools: Record<string, boolean>; skills: Record<string, boolean>; reload: boolean };
type Segment = { key: string; label: string; color: string; tokens: number | null; share: number; estimate: boolean };
type Context = {
    SCRIPT: string;
    WRITE: string;
    parseConfig(text: string | null): { machine: string | null; stateDir: string | null; problems: string[] };
    parseSessions(stdout: string): { file: string; alive: boolean; status: Record<string, unknown> }[];
    pickSession(
        sessions: unknown[],
        o: { machine?: string | null; focused?: string | null; agent?: string | null },
    ): { session: { status: { session: string } } | null; by: string | null };
    isShown(root: unknown, mod: string): boolean;
    requestPath(file: string): string | null;
    short(n: number): string;
    percent(tokens: number, window: number | null): string;
    segments(detail: unknown): Segment[];
    headline(detail: unknown): string;
    addSwitch(pending: Pending | null, kind: string, name?: string, on?: boolean): Pending;
    requestJson(id: string, pending: Pending): string;
    shownOn(pending: Pending | null, kind: string, name: string, on: boolean): boolean;
};
type Work = Pick<Context, "SCRIPT" | "parseSessions" | "pickSession" | "isShown">;

function temp(t: TestContext): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jig-herdr-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const detail = {
    window: 200_000,
    used: 124_000,
    usedFrom: "pi",
    reserve: 16_384,
    free: 59_616,
    parts: { messages: 100_000, tools: 12_000, system: 4_000, skills: 1_000, contextFiles: 7_000 },
    tools: [],
    skills: [],
    files: [],
};

test("jig-context finds sessions as jig-work does: the same script and the same choice", async (t) => {
    const ctx = await load<Context>("mods/jig-context/lib.js");
    const work = await load<Work>("mods/jig-work/lib.js");
    assert.equal(ctx.SCRIPT, work.SCRIPT, "the copy of the script is jig-work's");
    const root = temp(t);
    const dir = path.join(root, "sessions");
    mkdirSync(dir, { recursive: true });
    const status = (session: string, extra: Record<string, unknown>) => ({
        schema: 1,
        session,
        pid: process.pid,
        terminal: null,
        terminalFrom: null,
        ...extra,
    });
    writeFileSync(
        path.join(dir, "a.json"),
        JSON.stringify(status("a", { terminal: "t1", terminalFrom: "HC_TERMINAL_ID" })),
    );
    writeFileSync(path.join(dir, "b.json"), JSON.stringify(status("b", { updatedAt: "2026-01-01T00:00:09Z" })));
    const out = execFileSync("sh", ["-c", ctx.SCRIPT, "sh", root], { encoding: "utf8" });
    const sessions = ctx.parseSessions(out);
    assert.deepEqual(sessions, work.parseSessions(out));
    for (const o of [{ focused: "t1" }, { focused: "t9" }, { machine: "box", focused: "box/t1" }, {}]) {
        assert.equal(
            ctx.pickSession(sessions, o).session?.status.session,
            work.pickSession(sessions, o).session?.status.session,
        );
    }
    const layout = {
        id: "r",
        children: [
            {
                id: "s",
                type: "stack",
                active: "w",
                children: [{ id: "w" }, { id: "c", content: { mod: "jig-context" } }],
            },
        ],
    };
    assert.equal(ctx.isShown(layout, "jig-context"), false);
    assert.equal(work.isShown(layout, "jig-context"), false);
    assert.deepEqual(ctx.parseConfig('{ "machine": "dev-box", "stateDir": "~/state", "prOwners": [] }'), {
        machine: "dev-box",
        stateDir: "~/state",
        problems: [],
    });
    assert.equal(ctx.parseConfig("{").problems.length, 1);
});

test("jig-context's bar: each part's share of the window, in order, with the estimates marked", async () => {
    const lib = await load<Context>("mods/jig-context/lib.js");
    const parts = lib.segments(detail);
    assert.deepEqual(
        parts.map((p) => [p.key, p.tokens, p.estimate]),
        [
            ["messages", 100_000, true],
            ["tools", 12_000, true],
            ["system", 4_000, true],
            ["skills", 1_000, true],
            ["contextFiles", 7_000, true],
            ["reserve", 16_384, false],
            ["free", 59_616, false],
        ],
    );
    assert.equal(parts[0]?.share, 0.5);
    assert.ok(Math.abs(parts.reduce((n, p) => n + p.share, 0) - 1) < 1e-9, "the parts fill the window");
    assert.equal(lib.headline(detail), "62% used · 124k / 200k");
    // After a compaction Pi does not know the total until the next reply.
    const unknown = { ...detail, used: null, free: null, parts: { ...detail.parts, messages: null } };
    assert.equal(lib.headline(unknown), "Unknown until the next reply · 200k window");
    assert.deepEqual(
        lib.segments(unknown).map((p) => p.tokens === null),
        [true, false, false, false, false, false, true],
    );
    assert.deepEqual(lib.segments(null), []);
    assert.equal(lib.headline(undefined), "No context figures from this session");
    assert.deepEqual(
        [lib.short(950), lib.short(1234), lib.short(12_345), lib.short(1_500_000)],
        ["950", "1.2k", "12k", "1.5M"],
    );
    assert.deepEqual(
        [lib.percent(12_000, 200_000), lib.percent(100, 200_000), lib.percent(0, 200_000), lib.percent(1, null)],
        ["6.0%", "<0.1%", "0%", ""],
    );
});

test("jig-context's switches: every unanswered one rides in the next request, and the panel shows the wish", async () => {
    const lib = await load<Context>("mods/jig-context/lib.js");
    let pending = lib.addSwitch(null, "tools", "bash", false);
    pending = lib.addSwitch(pending, "skills", "pdf-tools", false);
    pending = lib.addSwitch(pending, "tools", "git", true);
    assert.deepEqual(JSON.parse(lib.requestJson("ctx-1", pending)), {
        schema: 1,
        id: "ctx-1",
        tools: { bash: false, git: true },
        skills: { "pdf-tools": false },
    });
    assert.deepEqual(JSON.parse(lib.requestJson("ctx-2", lib.addSwitch(null, "reload"))), {
        schema: 1,
        id: "ctx-2",
        reload: true,
    });
    assert.equal(lib.shownOn(pending, "tools", "bash", true), false);
    assert.equal(lib.shownOn(pending, "tools", "read", true), true);
    assert.equal(lib.shownOn(null, "skills", "x", false), false);
    assert.equal(lib.requestPath("/s/jig/sessions/0193-abc.json"), "/s/jig/requests/0193-abc.json");
    assert.equal(lib.requestPath("/s/jig/other/x.json"), null);
});

test("the request the panel writes is one the session takes and reads as its contract says", async (t) => {
    const lib = await load<Context>("mods/jig-context/lib.js");
    const root = temp(t);
    mkdirSync(path.join(root, "requests"));
    const file = lib.requestPath(path.join(root, "sessions", "0193-abc.json")) ?? "";
    const json = lib.requestJson("ctx-9", lib.addSwitch(null, "tools", "bash", false));
    // The command the panel runs through Herdr's exec, with the path and the JSON as arguments, never in the script.
    execFileSync("sh", ["-c", lib.WRITE, "sh", file, json]);
    assert.deepEqual(readdirSync(path.join(root, "requests")), ["0193-abc.json"], "no temporary file is left");
    assert.equal(readFileSync(file, "utf8"), json);
    const text = takeRequest(file);
    assert.deepEqual(parseRequest(text ?? "").request, {
        schema: 1,
        id: "ctx-9",
        tools: { bash: false },
        skills: {},
        reload: false,
    });
    // A quote or a dollar in the JSON stays text.
    execFileSync("sh", ["-c", lib.WRITE, "sh", file, '{"schema":1,"id":"$(touch x)","tools":{"a\'b":true}}']);
    assert.equal(readFileSync(file, "utf8"), '{"schema":1,"id":"$(touch x)","tools":{"a\'b":true}}');
});

test("jig-context writes only the request file, and approves nothing", () => {
    const code = ["main.js", "lib.js"]
        .map((f) => readFileSync(path.join(HERDR, "mods/jig-context", f), "utf8"))
        .join("\n");
    // Its one write: the request, through WRITE. No program but sh, no app command, no file written another way.
    assert.deepEqual(
        [...code.matchAll(/exec\("([^"]+)"/g)].map((m) => m[1]),
        ["sh", "sh", "sh"],
    );
    assert.doesNotMatch(code, /writeTextFile|\brun\(|\bhc\(|setShared\(/);
    for (const m of code.matchAll(/(?<![.\w])(?:exec|readTextFile)\([^;]*;/gs)) assert.match(m[0], /\{ on/, m[0]);
});
