// The pure parts of the mods (their lib.js files), and the shell scripts of repo-changes and jig-work run on real files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "./support.ts";

type Repo = {
    path: string;
    name: string;
    branch: string;
    ahead: number;
    behind: number;
    files: { status: string; path: string; fresh: boolean }[];
    total: number;
    error: string | null;
};
type Changes = {
    SCRIPT: string;
    parseRepos(stdout: string, root: string): Repo[];
    filterRepos(repos: Repo[], text: string): Repo[];
    splitPath(path: string): { dir: string; name: string };
};

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        encoding: "utf8",
    });

function repo(root: string, name: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), text);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "first");
    return dir;
}

test("repo-changes lists every repository under a folder, nested ones too, with their changes", async () => {
    const { SCRIPT, parseRepos } = await load<Changes>("mods/repo-changes/lib.js");
    const root = mkdtempSync(path.join(tmpdir(), "jig-herdr-"));
    try {
        const orders = repo(root, "orders-api", { "src/a.ts": "one\n", "README.md": "x\n" });
        repo(root, "worktrees/PROJ-123/billing", { "b.ts": "one\n" });
        mkdirSync(path.join(root, "node_modules/lib/.git"), { recursive: true });
        mkdirSync(path.join(root, "not-a-repo"));
        git(orders, "checkout", "-qb", "feature/PROJ-123");
        writeFileSync(path.join(orders, "src/a.ts"), "two\n");
        writeFileSync(path.join(orders, "new.ts"), "new\n");

        const out = execFileSync("sh", ["-c", SCRIPT, "sh", root], { encoding: "utf8" });
        const repos = parseRepos(out, root);
        assert.deepEqual(repos.map((r) => r.name).sort(), ["orders-api", "worktrees/PROJ-123/billing"]);
        const changed = repos.find((r) => r.name === "orders-api");
        assert.equal(changed?.branch, "feature/PROJ-123");
        assert.equal(changed?.total, 2);
        assert.deepEqual(changed?.files.map((f) => `${f.status} ${f.path}`).sort(), ["?? new.ts", "M src/a.ts"]);
        assert.equal(repos.find((r) => r.name.startsWith("worktrees"))?.total, 0);

        // Inside a repository, only that repository is listed.
        const inside = parseRepos(
            execFileSync("sh", ["-c", SCRIPT, "sh", path.join(orders, "src")], { encoding: "utf8" }),
            orders,
        );
        assert.deepEqual(
            inside.map((r) => r.path),
            [orders],
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("repo-changes reads a branch with a dot, ahead and behind, a detached head and an error", async () => {
    const { parseRepos } = await load<Changes>("mods/repo-changes/lib.js");
    const out = [
        "@@repo /w/a",
        "## release/1.2...origin/release/1.2 [ahead 2, behind 1]",
        ' M "sp ace.ts"',
        "=1",
        "@@repo /w/b",
        "## HEAD (no branch)",
        "=0",
        "@@repo /w/c",
        "fatal: not a git repository",
        "=0",
    ].join("\n");
    const [a, b, c] = parseRepos(out, "/w");
    assert.deepEqual([a?.branch, a?.ahead, a?.behind, a?.files[0]?.path], ["release/1.2", 2, 1, "sp ace.ts"]);
    assert.equal(b?.branch, "(detached)");
    assert.equal(c?.error, "fatal: not a git repository");
});

test("repo-changes filters by repository name or file, and splits a path", async () => {
    const { parseRepos, filterRepos, splitPath } = await load<Changes>("mods/repo-changes/lib.js");
    const repos = parseRepos(
        [
            "@@repo /w/orders",
            "## main",
            " M src/a.ts",
            " M b.md",
            "=2",
            "@@repo /w/billing",
            "## main",
            " M c.ts",
            "=1",
        ].join("\n"),
        "/w",
    );
    assert.deepEqual(
        filterRepos(repos, "orders").map((r) => [r.name, r.files.length]),
        [["orders", 2]],
    );
    assert.deepEqual(
        filterRepos(repos, "c.ts").map((r) => [r.name, r.files.length]),
        [["billing", 1]],
    );
    assert.equal(filterRepos(repos, "  ").length, 2);
    assert.deepEqual(splitPath("src/deep/a.ts"), { dir: "src/deep/", name: "a.ts" });
    assert.deepEqual(splitPath("a.ts"), { dir: "", name: "a.ts" });
});

test("repo-review numbers the lines of a diff and reads a status", async () => {
    const lib = await load<{
        diffRows(lines: string[]): { kind: string; number?: number; text: string }[];
        parseStatus(out: string): { branch: string; files: { status: string }[]; total: number };
    }>("mods/repo-review/lib.js");
    const rows = lib.diffRows(["@@ -3,2 +3,3 @@", " keep", "-gone", "+new", "+more"]);
    assert.deepEqual(
        rows.map((r) => [r.kind, r.number]),
        [
            ["@", undefined],
            [" ", 3],
            ["-", 4],
            ["+", 4],
            ["+", 5],
        ],
    );
    const status = lib.parseStatus("## main\nUU x.ts\n D y.ts\n?? z.ts\n");
    assert.deepEqual(
        status.files.map((f) => f.status),
        ["U", "D", "??"],
    );
    assert.throws(() => lib.parseStatus("fatal: no"), /fatal: no/);
});

test("jig-activity lists the stack's buttons from the layout, leaves out missing mods and puts 'end' last", async () => {
    const lib = await load<{
        buttons(
            stack: unknown,
            present?: Map<string, boolean>,
        ): { id: string; icon: string | null; end: boolean; active: boolean }[];
        find(node: unknown, id: string): unknown;
        initial(title: string): string;
    }>("mods/jig-activity/lib.js");
    const stack = {
        id: "body",
        type: "stack",
        active: "b",
        children: [
            { id: "a", title: "Alpha", content: { mod: "alpha", props: { activity: { icon: "mods/x/a.svg" } } } },
            { id: "b", title: "Beta", content: { mod: "beta" } },
            { id: "c", title: "Gamma", content: { mod: "gamma", props: { activity: { end: true } } } },
            { id: "d", content: {} },
        ],
    };
    const all = lib.buttons(stack);
    assert.deepEqual(
        all.map((b) => [b.id, b.icon, b.end, b.active]),
        [
            ["a", "mods/x/a.svg", false, false],
            ["b", null, false, true],
            ["c", null, true, false],
        ],
    );
    assert.deepEqual(
        lib.buttons(stack, new Map([["alpha", false]])).map((b) => b.id),
        ["b", "c"],
    );
    assert.equal(lib.initial("beta"), "B");
    assert.equal(lib.find({ id: "r", children: [stack] }, "body"), stack);
    assert.equal(lib.find(null, "x"), null);
});

test("jig-theme-sync reads its config, the agent folder and the theme name", async () => {
    const lib = await load<{
        parseConfig(text: string | null): {
            machine: string | null;
            agentDir: string | null;
            themeFolders: string[];
            problems: string[];
        };
        agentFolder(config: { agentDir: string | null }, home: string, env: string | null): string;
        inHome(folder: string, home: string): string;
        themeName(text: string | null): string | null;
    }>("mods/jig-theme-sync/lib.js");
    const none = lib.parseConfig(null);
    assert.deepEqual([none.machine, none.agentDir, none.themeFolders, none.problems], [null, null, [], []]);
    const set = lib.parseConfig(
        '{ "machine": "dev-box", "agentDir": ".pi/work", "themeFolders": ["~/palettes", "/srv/p"] }',
    );
    assert.deepEqual([set.machine, set.agentDir, set.themeFolders], ["dev-box", ".pi/work", ["~/palettes", "/srv/p"]]);
    assert.match(lib.parseConfig("{ nope").problems[0] ?? "", /not valid JSON/);
    assert.equal(lib.parseConfig('{ "machine": 3, "themeFolders": "x" }').problems.length, 2);
    assert.match(lib.parseConfig("[]").problems[0] ?? "", /object/);

    assert.equal(lib.inHome("~/palettes", "/home/ann"), "/home/ann/palettes");
    assert.equal(lib.inHome(".pi/work", "/home/ann/"), "/home/ann/.pi/work");
    assert.equal(lib.inHome("/srv/p", "/home/ann"), "/srv/p");
    assert.equal(lib.inHome("C:\\p", "/home/ann"), "C:\\p");
    assert.equal(lib.agentFolder({ agentDir: null }, "/home/ann", null), "/home/ann/.pi/agent");
    assert.equal(lib.agentFolder({ agentDir: null }, "/home/ann", "/data/pi"), "/data/pi");
    assert.equal(lib.agentFolder({ agentDir: ".pi/work" }, "/home/ann", "/data/pi"), "/home/ann/.pi/work");

    assert.equal(lib.themeName('{ "theme": "jig-lime" }'), "jig-lime");
    assert.equal(lib.themeName('{ "theme": "../x" }'), null);
    assert.equal(lib.themeName('{ "theme": 3 }'), null);
    assert.equal(lib.themeName("{ nope"), null);
    assert.equal(lib.themeName(null), null);
});

type Work = {
    SCRIPT: string;
    REPO_SCRIPT: string;
    parseConfig(text: string | null): {
        machine: string | null;
        stateDir: string | null;
        prOwners: string[];
        problems: string[];
    };
    searchArgs(key: string, owners: string[], fields: string): string[];
    parseSessions(stdout: string): { file: string; alive: boolean; status: any }[];
    addressOf(status: unknown, machine: string | null): string | null;
    pickSession(
        sessions: { alive: boolean; status: any }[],
        options: { machine?: string | null; focused?: string | null; agent?: string | null; picked?: string | null },
    ): { session: { status: any } | null; by: string | null };
    stageLine(workflow: unknown): { id: string; state: string }[];
    prRows(prs: unknown, searched: unknown, details: unknown): any[];
    parseRepoInfo(stdout: string): Record<string, { repo: string | null; status: string }>;
    reviewTarget(file: string, info: unknown): { repo: string; name: string; file: string } | null;
    splitOutputs(outputs: unknown): { files: { path: string }[]; inRepos: number };
    reposLine(count: number): string;
    decisionText(r: unknown): string;
    isShown(root: unknown, mod: string): boolean;
    folderName(cwd: string, home: string | null): string;
};

const status = (session: string, extra: Record<string, unknown> = {}) => ({
    schema: 1,
    session,
    pid: process.pid,
    terminal: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
});

test("jig-work's script reads the status files and says which Pi still runs", async () => {
    const lib = await load<Work>("mods/jig-work/lib.js");
    const root = mkdtempSync(path.join(tmpdir(), "jig-herdr-"));
    try {
        const dir = path.join(root, "sessions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "a.json"), JSON.stringify(status("a", { terminal: "t7" }), null, 2));
        writeFileSync(path.join(dir, "b.json"), JSON.stringify(status("b", { pid: 999_999_991 }), null, 2));
        writeFileSync(path.join(dir, "c.json"), "half a fi");
        writeFileSync(path.join(dir, "d.json.123.ab.tmp"), "{}");
        const out = execFileSync("sh", ["-c", lib.SCRIPT, "sh", root], { encoding: "utf8" });
        const sessions = lib.parseSessions(out);
        assert.deepEqual(
            sessions.map((s) => [s.status.session, s.alive]),
            [
                ["a", true],
                ["b", false],
            ],
        );
        assert.equal(sessions[0]?.file, path.join(dir, "a.json"));
        // With no folder, jig-core's rule: $JIG_STATE_DIR/sessions.
        const viaEnv = execFileSync("sh", ["-c", lib.SCRIPT, "sh", ""], {
            encoding: "utf8",
            env: { ...process.env, JIG_STATE_DIR: root },
        });
        assert.equal(lib.parseSessions(viaEnv).length, 2);
        assert.match(viaEnv, new RegExp(`^@@dir ${dir}$`, "m"));
        // A folder from config.json may start at the home folder.
        const viaHome = execFileSync("sh", ["-c", lib.SCRIPT, "sh", "~/"], {
            encoding: "utf8",
            env: { ...process.env, HOME: root },
        });
        assert.equal(lib.parseSessions(viaHome).length, 2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("jig-work shows the focused terminal's session, else the one picked, else the one updated last", async () => {
    const lib = await load<Work>("mods/jig-work/lib.js");
    const sessions = [
        { alive: true, status: status("a", { terminal: "t1", updatedAt: "2026-01-01T00:00:05Z" }) },
        { alive: true, status: status("b", { terminal: "t2", updatedAt: "2026-01-01T00:00:09Z" }) },
        { alive: false, status: status("c", { terminal: "t3", updatedAt: "2026-01-01T00:00:59Z" }) },
    ];
    assert.equal(lib.addressOf(sessions[0]?.status, "dev-box"), "dev-box/t1");
    assert.equal(lib.addressOf(sessions[0]?.status, null), "t1");
    // A terminal another host named (a tmux pane) has no address in Herdr.
    assert.equal(lib.addressOf({ terminal: "%3", terminalFrom: "TMUX_PANE" }, null), null);
    assert.equal(lib.addressOf({ terminal: "t1", terminalFrom: "HC_TERMINAL_ID" }, "dev-box"), "dev-box/t1");
    const pick = (o: Parameters<Work["pickSession"]>[1]) => {
        const r = lib.pickSession(sessions, o);
        return [r.session?.status.session ?? null, r.by];
    };
    assert.deepEqual(pick({ machine: "dev-box", focused: "dev-box/t1" }), ["a", "focus"]);
    assert.deepEqual(pick({ machine: null, focused: "t9", agent: "t2" }), ["b", "focus"]);
    assert.deepEqual(pick({ machine: "dev-box", focused: "t1" }), ["b", "recent"], "another machine's t1 is not ours");
    assert.deepEqual(
        pick({ machine: null, focused: "t3", picked: "a" }),
        ["a", "picked"],
        "an ended Pi is never shown",
    );
    assert.deepEqual(pick({}), ["b", "recent"]);
    assert.deepEqual(lib.pickSession([], {}), { session: null, by: null });
});

test("jig-work draws the stages as a line, and lists pull requests with the failing ones first", async () => {
    const lib = await load<Work>("mods/jig-work/lib.js");
    assert.deepEqual(
        lib
            .stageLine({ stages: [{ id: "understand" }, { id: "plan" }, { id: "build" }], current: "plan" })
            .map((s) => `${s.id}:${s.state}`),
        ["understand:done", "plan:current", "build:todo"],
    );
    assert.deepEqual(
        lib.stageLine({ stages: [], current: "plan" }).map((s) => `${s.id}:${s.state}`),
        ["plan:current"],
    );
    assert.deepEqual(lib.stageLine(null), []);

    const rows = lib.prRows(
        [
            { repo: "/w/billing", url: "https://github.com/acme/billing/pull/3", number: 3, state: "OPEN" },
            {
                repo: "/w/orders-api",
                url: "https://github.com/acme/orders-api/pull/7",
                number: 7,
                state: "OPEN",
                checks: { pass: 2, fail: 1, pending: 0, total: 3 },
            },
            { repo: "/w/none", error: "no pull request" },
        ],
        [],
        {
            "https://github.com/acme/billing/pull/3": {
                title: "Bill it",
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "PENDING" }, { conclusion: "SKIPPED" }],
            },
        },
    );
    assert.deepEqual(
        rows.map((r) => [r.number, r.repo, r.review, r.checks?.fail ?? null]),
        [
            [7, "acme/orders-api", null, 1],
            [3, "acme/billing", "APPROVED", 0],
        ],
    );
    assert.equal(rows[1].title, "Bill it");
    assert.deepEqual([rows[1].checks.pass, rows[1].checks.pending], [1, 1]);
    // No readings from the workflow: what gh's search found.
    const searched = lib.prRows(
        [],
        [
            {
                url: "https://github.com/acme/x/pull/1",
                number: 1,
                state: "MERGED",
                repository: { nameWithOwner: "acme/x" },
            },
        ],
        {},
    );
    assert.deepEqual(
        searched.map((r) => [r.number, r.repo, r.state]),
        [[1, "acme/x", "MERGED"]],
    );
});

test("jig-work finds which outputs are in a repository with changes, for the Review tab", async () => {
    const lib = await load<Work>("mods/jig-work/lib.js");
    const root = mkdtempSync(path.join(tmpdir(), "jig-herdr-"));
    try {
        const orders = repo(root, "orders-api", { "src/a.ts": "one\n", "b.ts": "same\n" });
        writeFileSync(path.join(orders, "src/a.ts"), "two\n");
        const loose = path.join(root, "loose.md");
        writeFileSync(loose, "x\n");
        const files = [path.join(orders, "src/a.ts"), path.join(orders, "b.ts"), loose];
        const info = lib.parseRepoInfo(
            execFileSync("sh", ["-c", lib.REPO_SCRIPT, "sh", ...files], { encoding: "utf8" }),
        );
        const real = execFileSync("git", ["-C", orders, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
        assert.deepEqual(info[files[0] ?? ""], { repo: real, status: "M" });
        assert.deepEqual(info[files[1] ?? ""], { repo: real, status: "" });
        assert.deepEqual(info[loose], { repo: null, status: "" });
        assert.deepEqual(lib.reviewTarget(`${real}/src/a.ts`, { repo: real }), {
            repo: real,
            name: "orders-api",
            file: "src/a.ts",
        });
        assert.equal(lib.reviewTarget(loose, { repo: null }), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("jig-work lists only outputs outside repositories, and counts the rest for the Changes line", async () => {
    const lib = await load<Work>("mods/jig-work/lib.js");
    const at = "2026-01-02T10:00:00.000Z";
    const out = (p: string, repo?: string | null) => ({
        path: p,
        action: "edited",
        at,
        ...(repo === undefined ? {} : { repo }),
    });
    const { files, inRepos } = lib.splitOutputs([
        out("/t/PROJ-1/plan.md", null),
        out("/r/src/a.ts", "/r"),
        out("/r/src/b.ts", "/r"),
        out("/old/session.md"), // an older status file: no repo field, still listed
        { action: "edited" },
    ]);
    assert.deepEqual(
        files.map((f) => f.path),
        ["/t/PROJ-1/plan.md", "/old/session.md"],
    );
    assert.equal(inRepos, 2);
    assert.deepEqual(lib.splitOutputs(undefined), { files: [], inRepos: 0 });
    assert.equal(lib.reposLine(0), "");
    assert.equal(lib.reposLine(1), "1 file changed in a repository → Changes");
    assert.equal(lib.reposLine(12), "12 files changed in repositories → Changes");
});

test("jig-work reads its config, words decisions, and knows when it is on screen", async () => {
    const lib = await load<Work>("mods/jig-work/lib.js");
    assert.deepEqual(lib.parseConfig(null), { machine: null, stateDir: null, prOwners: [], problems: [] });
    assert.deepEqual(lib.parseConfig('{ "machine": "dev-box", "stateDir": "~/state", "prOwners": ["acme"] }'), {
        machine: "dev-box",
        stateDir: "~/state",
        prOwners: ["acme"],
        problems: [],
    });
    assert.equal(lib.parseConfig('{ "prOwners": "acme" }').problems.length, 1);
    // The pull request search never covers all of GitHub: your owners, else the ones that involve you.
    assert.deepEqual(lib.searchArgs("PROJ-123", [], "url"), [
        "search",
        "prs",
        "PROJ-123",
        "--involves=@me",
        "--json",
        "url",
        "--limit",
        "10",
    ]);
    assert.deepEqual(lib.searchArgs("PROJ-123", ["acme", "acme-labs"], "url").slice(3, 7), [
        "--owner",
        "acme",
        "--owner",
        "acme-labs",
    ]);
    assert.equal(lib.parseConfig('{ "machine": 3 }').problems.length, 1);
    assert.match(lib.parseConfig("{").problems[0] ?? "", /not valid JSON/);

    assert.equal(lib.decisionText({ decision: "allow" }), "allowed");
    assert.equal(lib.decisionText({ decision: "ask", answer: "allow" }), "asked · allowed");
    assert.equal(lib.decisionText({ decision: "ask", answer: "decline" }), "asked · declined");
    assert.equal(lib.decisionText({ decision: "deny" }), "denied");
    assert.equal(lib.decisionText({}), "");
    assert.equal(lib.folderName("/home/ann/orders-api/", "/home/ann"), "orders-api");
    assert.equal(lib.folderName("/home/ann", "/home/ann"), "~");

    const layout = {
        id: "root",
        children: [
            {
                id: "panel",
                children: [
                    {
                        id: "body",
                        type: "stack",
                        active: "changes",
                        children: [
                            { id: "jig-work", content: { mod: "jig-work" } },
                            { id: "changes", content: { mod: "repo-changes" } },
                        ],
                    },
                ],
            },
        ],
    };
    assert.equal(lib.isShown(layout, "jig-work"), false);
    assert.equal(lib.isShown(layout, "repo-changes"), true);
    (layout.children[0] as { hidden?: boolean }).hidden = true;
    assert.equal(lib.isShown(layout, "repo-changes"), false);
    assert.equal(lib.isShown(layout, "file-view"), true, "a mod in a tab of its own counts as shown");
});

test("jig-activity draws a divider after a button that asks for one", async () => {
    const lib = await load<{ buttons(stack: unknown): { id: string; divider: boolean }[] }>("mods/jig-activity/lib.js");
    const stack = {
        id: "body",
        children: [
            { id: "jig-work", content: { mod: "jig-work", props: { activity: { divider: true } } } },
            { id: "changes", content: { mod: "repo-changes" } },
        ],
    };
    assert.deepEqual(
        lib.buttons(stack).map((b) => [b.id, b.divider]),
        [
            ["jig-work", true],
            ["changes", false],
        ],
    );
});
