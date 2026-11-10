// Pure helpers for the review tab, kept apart from main.js so they can be tested outside Herdr.
// Copied from jig-git/lib.js (mods cannot import each other), cut down to one repo and the file actions.

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
        // text is drawn (an empty line shows as a space so the row keeps its height); raw is what a copy takes.
        const kind = line[0];
        if (kind === "-") return { kind, number: old++, text: line.slice(1) || " ", raw: line.slice(1) };
        if (kind === "+") return { kind, number: next++, text: line.slice(1) || " ", raw: line.slice(1) };
        if (kind === " ") {
            old++;
            return { kind, number: next++, text: line.slice(1) || " ", raw: line.slice(1) };
        }
        return { kind: "", text: line };
    });
}

// ---- The three views of a file: Diff, File, Patch ----

/** The views the header switch offers; Diff is the default. */
export const PANES = ["diff", "file", "patch"];

/** A remembered or requested view, or "diff" when it is none of the three. */
export const reviewPane = (value) => (PANES.includes(value) ? value : "diff");

// Extensions the editor's highlighter names differently (the same map as jig-file-view; mods cannot import each other).
const LANG = {
    ts: "js",
    tsx: "js",
    mts: "js",
    cts: "js",
    jsx: "js",
    mjs: "js",
    toml: "yaml",
    jsonc: "json",
    svelte: "html",
    vue: "html",
};

/** The editor language for a file path: its extension, mapped where the highlighter calls it something else. */
export function langFor(path) {
    const name = path.split("/").pop() ?? "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
    return LANG[ext] ?? ext;
}

/** Text cut at `max` characters with a note, or whole when it fits. */
export const capText = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text);

// ---- Selecting lines to copy ----
// A selection is null or { anchor, end }: row indexes into diffRows' result, in click order (end may be before anchor).

/** A line of code, as opposed to a hunk header or a note. */
export const isCodeRow = (row) => row?.kind === "+" || row?.kind === "-" || row?.kind === " ";

/** The selection after a click on row `index`: a plain click selects that line, or clears the selection when that line is
 * all that was selected; with `extend` (shift) the range runs from the old anchor to `index`. A header row changes nothing. */
export function selectLine(rows, sel, index, extend) {
    if (!isCodeRow(rows[index])) return sel;
    if (extend && sel) return { anchor: sel.anchor, end: index };
    if (!extend && sel && sel.anchor === index && sel.end === index) return null;
    return { anchor: index, end: index };
}

/** Is row `index` inside the selection? */
export const inSelection = (sel, index) =>
    Boolean(sel) && index >= Math.min(sel.anchor, sel.end) && index <= Math.max(sel.anchor, sel.end);

/** What a selection copies: { text, lines }, or null when it holds no code line. The code only, with no +/- marker and no line
 * number, joined by "\n". Added and context lines are the new side of the file, so deleted lines in the range are left out;
 * a range of nothing but deleted lines copies those instead. */
export function selectionCopy(rows, sel) {
    if (!sel) return null;
    const lo = Math.min(sel.anchor, sel.end),
        hi = Math.max(sel.anchor, sel.end);
    const code = rows.slice(lo, hi + 1).filter(isCodeRow);
    if (!code.length) return null;
    const keep = code.every((r) => r.kind === "-") ? code : code.filter((r) => r.kind !== "-");
    return { text: keep.map((r) => r.raw ?? r.text).join("\n"), lines: keep.length };
}

// ---- Stage, unstage and discard the shown file ----
// Copied from jig-git/lib.js, which documents them; a test runs both copies on the same repositories.
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

/** The base branch a checkout is compared with, as in jig-git' scan script: the closest of the candidates that exist
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

/** Finds git repositories under a folder, and their branch, for the side panel's repository chooser. */
export const REPO_SCRIPT = `root=$1
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)
find_repos() {
  for a in "$root"/*/; do
    case $a in */node_modules/) continue;; esac
    if [ -e "$a.git" ]; then echo "$a"; continue; fi
    for b in "$a"*/; do
      case $b in */node_modules/) continue;; esac
      if [ -e "$b.git" ]; then echo "$b"; continue; fi
      for c in "$b"*/; do
        case $c in */node_modules/) continue;; esac
        [ -e "$c.git" ] && echo "$c"
      done
    done
  done
}
info() {
  br=$(git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null || echo "(detached)")
  if [ -d "$1/.git" ]; then kind=m; else kind=w; fi
  if [ -n "$(git -C "$1" --no-optional-locks -c core.fsmonitor=false status --porcelain 2>/dev/null | head -n1)" ]; then dirty=1; else dirty=0; fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$kind" "$br" "$dirty"
}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
if [ -n "$top" ]; then echo "$top" > "$tmp/list"; echo "@single"; else find_repos > "$tmp/list"; fi
n=0
while IFS= read -r repo; do
  repo=\${repo%/}
  info "$repo" > "$tmp/$n.out" &
  n=$((n + 1))
  [ $((n % 8)) -eq 0 ] && wait
done < "$tmp/list"
wait
i=0
while [ $i -lt $n ]; do cat "$tmp/$i.out"; i=$((i + 1)); done`;

/** `REPO_SCRIPT` output as `{ single, repos: [{ path, linked, branch, dirty }] }`. */
export function parseRepoList(stdout) {
    const lines = stdout.split("\n").filter(Boolean);
    const repos = lines
        .filter((line) => !line.startsWith("@"))
        .map((line) => {
            const [path, kind, branch, dirty] = line.split("\t");
            return { path, linked: kind === "w", branch, dirty: dirty === "1" };
        });
    repos.sort((a, b) => Number(a.linked) - Number(b.linked));
    return { single: lines[0] === "@single", repos };
}

/** Keep the repository on screen, else the remembered one, else one with changes, else the first. */
export function chooseRepo(repos, current, remembered) {
    const known = (path) => repos.find((repo) => repo.path === path)?.path;
    return known(current) ?? known(remembered) ?? repos.find((repo) => repo.dirty)?.path ?? repos[0]?.path ?? null;
}

/** A tab keeps the repository it was opened for; the side panel uses the followed one. */
export const repositoryFor = (props, followed) => props?.repo || followed || "";
