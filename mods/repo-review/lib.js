// Pure helpers for the review tab, kept apart from main.js so they can be tested outside Herdr.
// Copied from repo-changes/lib.js (mods cannot import each other), cut down to one repo and the file actions.

// Most changed files listed; a bigger change set is cut here.
export const CAP = 500;

// Git writes a path with a quote or backslash in "quotes" with backslash escapes.
function unquote(path) {
    if (!path.startsWith('"') || !path.endsWith('"')) return path;
    return path.slice(1, -1).replace(/\\(["\\tn])/g, (_m, c) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

// "## main...origin/main [ahead 1, behind 2]", "## HEAD (no branch)", "## No commits yet on main".
function parseBranch(line) {
    const text = line.slice(3);
    if (text.startsWith("HEAD (no branch)")) return { branch: "(detached)", ahead: 0, behind: 0, unborn: false };
    const unborn = text.startsWith("No commits yet on ");
    const [name, rest] = text.replace(/^No commits yet on /, "").split("...");
    const track = /\[(.*)\]\s*$/.exec(rest ?? "")?.[1] ?? "";
    return {
        branch: name,
        unborn,
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    };
}

// One changed file: the letter to show, whether it is untracked, and its staged state (X of porcelain's XY).
function parseFile(line) {
    const xy = line.slice(0, 2),
        fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const status = conflict
        ? "U"
        : fresh
          ? "??"
          : xy.includes("D")
            ? "D"
            : xy.includes("R")
              ? "R"
              : xy.includes("A")
                ? "A"
                : "M";
    return {
        status,
        fresh,
        xy,
        staged: !fresh && xy[0] !== " ",
        path: unquote(line.slice(3)),
    };
}

// `git status --porcelain=v1 -b` output as { branch, ahead, behind, unborn, files, total }.
export function parseStatus(stdout) {
    const lines = stdout.split("\n").filter(Boolean);
    if (!lines.length || !lines[0].startsWith("## ")) throw new Error(lines[0] || "git status failed");
    const files = lines.slice(1).map(parseFile);
    return {
        ...parseBranch(lines[0]),
        files: files.slice(0, CAP),
        total: files.length,
    };
}

// A file path as its folders (dimmed) and its name.
export function splitPath(path) {
    const parts = path.split("/"),
        name = parts.pop();
    return { dir: parts.length ? `${parts.join("/")}/` : "", name };
}

// Numbers each diff line once, so a frame only draws the rows on screen (as the shipped changes mod does).
export function diffRows(lines) {
    let old = 0,
        next = 0;
    return lines.map((line) => {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
        if (match) {
            old = +match[1];
            next = +match[2];
            return { kind: "@", text: line };
        }
        const kind = line[0];
        if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
        if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
        if (kind === " ") {
            old++;
            return { kind, number: next++, text: line.slice(1) || " " };
        }
        return { kind: "", text: line };
    });
}

// ---- Stage, unstage and discard the shown file ----
// Copied from repo-changes/lib.js, which documents them; a test runs both copies on the same repositories.
// Each takes `exec(cmd, args, { cwd })` and returns { ok, message }. No --force, no reset, no "discard all".

const firstLine = (r) => (r.stderr || r.stdout || `git exited with ${r.code}`).trim().split("\n")[0];
const git = (exec, cwd) => (args) => exec("git", args, { cwd });
const LITERAL = "--literal-pathspecs";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const unborn = async (run) => (await run(["rev-parse", "--verify", "-q", "HEAD"])).code !== 0;

/** `git add -- <file>`. */
export async function stageFile(exec, { checkout, file }) {
    const r = await git(exec, checkout)([LITERAL, "add", "--", file]);
    return r.code === 0 ? { ok: true, message: `Staged ${file}.` } : { ok: false, message: firstLine(r) };
}

/** `git restore --staged -- <file>`, or `git rm --cached -- <file>` before the first commit. */
export async function unstageFile(exec, { checkout, file }) {
    const run = git(exec, checkout);
    const args = (await unborn(run))
        ? [LITERAL, "rm", "--cached", "-q", "--", file]
        : [LITERAL, "restore", "--staged", "--", file];
    const r = await run(args);
    return r.code === 0 ? { ok: true, message: `Unstaged ${file}.` } : { ok: false, message: firstLine(r) };
}

/** "delete" for an untracked or newly added file, else "restore". */
export const discardKind = (xy) => (xy === "??" || xy[0] === "A" ? "delete" : "restore");

/** Tracked: `git restore --worktree --staged -- <file>`; untracked: `git clean -f -- <file>`. Never a folder. */
export async function discardFile(exec, { checkout, file, expect }) {
    if (!file || file.endsWith("/"))
        return {
            ok: false,
            message: `${file || "That"} is a folder; discard its files one by one.`,
        };
    const run = git(exec, checkout);
    const st = await run([...READ, LITERAL, "status", "--porcelain=v1", "-z", "--no-renames", "-uall", "--", file]);
    if (st.code !== 0) return { ok: false, message: firstLine(st) };
    const entries = st.stdout.split("\0").filter(Boolean);
    const entry = entries.find((e) => e.slice(3) === file);
    if (!entry || entries.length !== 1)
        return {
            ok: false,
            message: entries.length ? `${file} is not a single file.` : `${file} has no changes.`,
        };
    const kind = discardKind(entry.slice(0, 2));
    if (expect && kind !== expect)
        return {
            ok: false,
            message: `${file} changed since; look again before discarding.`,
        };
    if (entry.startsWith("??")) {
        const r = await run([LITERAL, "clean", "-f", "--", file]);
        return r.code === 0 ? { ok: true, message: `Deleted ${file}.` } : { ok: false, message: firstLine(r) };
    }
    const r = await run([LITERAL, "restore", "--worktree", "--staged", "--", file]);
    if (r.code !== 0) return { ok: false, message: firstLine(r) };
    return {
        ok: true,
        message: kind === "delete" ? `Deleted ${file}.` : `Discarded the changes to ${file}.`,
    };
}

// ---- Branch mode: the whole branch against its base ----
// The tab shows either the working changes (`git diff HEAD`) or the branch (`git diff <merge base>`: the commits ahead of
// the base branch plus whatever is uncommitted). Branch mode never writes.

const BASES = ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"];

/** What a request to open the tab means for its mode: only "branch" is branch mode; an older request has no mode. */
export const openMode = (request) => (request?.mode === "branch" ? "branch" : "working");

/** The mode to draw: the wanted one when it has anything to show, else the other. */
export function effectiveMode(wanted, hasWorking, hasBranch) {
    if (wanted === "branch") return hasBranch ? "branch" : "working";
    return hasWorking || !hasBranch ? "working" : "branch";
}

/** Stage, unstage and discard only make sense for working changes. */
export const canWrite = (mode) => mode !== "branch";

/** The base branch a checkout is compared with, as in repo-changes' scan script: the closest of the candidates that exist
 * (origin/develop, origin's HEAD branch, origin/main, origin/master, develop, main, master), meaning the one whose merge
 * base with HEAD leaves the fewest commits, the earlier one on a tie; a local branch whose origin/ twin is the same commit
 * is skipped. Null when none exists, when the checkout is on develop, main, master or origin's HEAD branch, or when
 * nothing is ahead. Otherwise { ref, name, mergeBase, count, commits, more } (commits: the short `git log --oneline`
 * lines, newest first, at most `limit`; more: how many were left out). No fetch, no network. */
export async function findBase(exec, cwd, limit = 8) {
    const run = git(exec, cwd);
    const cur = await run(["symbolic-ref", "-q", "--short", "HEAD"]);
    const current = cur.code === 0 ? cur.stdout.trim() : "";
    const head = await run(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
    const headRef = head.code === 0 ? head.stdout.trim() : "";
    if (current && (["develop", "main", "master"].includes(current) || current === headRef.replace(/^origin\//, "")))
        return null;
    let best = null;
    for (const ref of [...new Set([BASES[0], headRef, ...BASES.slice(1)])].filter(Boolean)) {
        const sha = await run(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
        if (sha.code !== 0) continue;
        if (!ref.startsWith("origin/")) {
            const twin = await run(["rev-parse", "--verify", "-q", `origin/${ref}^{commit}`]);
            if (twin.code === 0 && twin.stdout === sha.stdout) continue;
        }
        const mb = await run(["merge-base", ref, "HEAD"]);
        if (mb.code !== 0) continue;
        const mergeBase = mb.stdout.trim();
        const n = await run(["rev-list", "--count", `${mergeBase}..HEAD`]);
        if (n.code !== 0) continue;
        const count = Number(n.stdout.trim()) || 0;
        if (!best || count < best.count) best = { ref, mergeBase, count };
    }
    if (!best || !best.count) return null;
    const log = await run(["log", "--oneline", "--no-decorate", `--max-count=${limit}`, `${best.mergeBase}..HEAD`]);
    const commits = log.stdout.split("\n").filter(Boolean);
    return {
        ...best,
        name: best.ref.replace(/^origin\//, ""),
        commits,
        more: Math.max(0, best.count - commits.length),
    };
}

/** `git diff --name-status --no-renames <merge base>` as files like the working list's: { status, fresh, xy, staged, path }.
 * A type change counts as a modification. */
export function parseNameStatus(stdout) {
    return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [code, ...rest] = line.split("\t");
            const letter = code[0];
            const status = "AMD".includes(letter) ? letter : letter === "U" ? "U" : "M";
            return {
                status,
                fresh: false,
                xy: "  ",
                staged: false,
                path: unquote(rest.join("\t")),
            };
        });
}

/** The branch's file list: what differs from the merge base, then untracked files (which `git diff` does not list). */
export function branchFiles(committed, working) {
    const seen = new Set(committed.map((f) => f.path));
    return [...committed, ...working.filter((f) => f.fresh && !seen.has(f.path))].slice(0, CAP);
}
