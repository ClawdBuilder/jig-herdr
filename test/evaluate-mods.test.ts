// Every mod's main.js is imported and its init path runs in a child process with Herdr and the GPUI modules stubbed and
// the JS timer/Node globals the Herdr runtime lacks removed. A missing read helper, a setTimeout or a Node API that only
// appears on load/read fails here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const mods = [
    "jig-file-view",
    "jig-activity",
    "jig-context",
    "jig-files",
    "jig-tabs",
    "jig-theme-sync",
    "jig-work",
    "jig-keep-awake",
    "jig-git",
    "jig-history",
    "jig-prs",
    "jig-review",
    "jig-worktrees",
];

for (const name of mods) {
    test(`${name}/main.js loads and initialises without JS timers or Node APIs`, { timeout: 30_000 }, async () => {
        const child = spawn(process.execPath, ["test/support/evaluate-one.mjs", name], {
            cwd: new URL("..", import.meta.url),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", resolve);
            });
            assert.equal(code, 0, `${name}: ${stdout}${stderr}`);
        } finally {
            clearTimeout(timeout);
            if (child.exitCode === null) child.kill("SIGKILL");
        }
    });
}
