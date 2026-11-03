// Helpers of the Changes panel that need no Herdr: the read script and its parsing, how checkouts nest, and the git
// actions. They live apart from main.js so the tests can load them outside Herdr and run the actions on real repositories.

// Most changed files listed per checkout; the rest become "+N more".
export const CAP = 200;

// Run with `sh -c SCRIPT sh <root>` on the space's machine, once per refresh.
// Output: "@@root <root as a physical path>", then per checkout a line "@@repo <absolute path>", a line
// "@@git <common git dir><tab><own git dir>" (the same for a main checkout, different for a linked worktree), then
// `git status --porcelain=v1 -b` (branch line, then one line per changed file, at most CAP), then "=<changed file count>".
// A checkout with commits its base branch lacks also has "@@base <base ref><tab><merge base><tab><commit count>" after
// its "@@git" line. The base is the closest of the candidates that exist (origin/develop, origin's HEAD branch,
// origin/main, origin/master, develop, main, master): the one whose merge base with HEAD leaves the fewest commits, the
// earlier one on a tie; a local branch is skipped when its origin/ twin is the same commit. Nothing is printed for a
// checkout on develop, main, master or origin's HEAD branch, or with no commit ahead.
// No fetch and no network: each checkout is read from its own disk, up to 8 at a time.
// (No dollar-brace in here except escaped ones: this is a JS template string.)
export const SCRIPT = `root=$(cd "$1" 2>/dev/null && pwd -P) || root=$1
printf '@@root %s\\n' "$root"
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
with_worktrees() {
  while IFS= read -r repo; do
    repo=$(cd "$repo" 2>/dev/null && pwd -P) || continue
    echo "$repo"
    [ -d "$repo/.git" ] || continue
    git -C "$repo" worktree list --porcelain 2>/dev/null | awk '/^worktree / { if (n++) print substr($0, 10) }'
  done
}
branch_base() {
  cur=$(git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null)
  hd=$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  hb=$(printf %s "$hd" | sed 's|^origin/||')
  case $cur in develop|main|master) return 0;; esac
  [ -n "$hb" ] && [ "$cur" = "$hb" ] && return 0
  bn=
  for c in origin/develop "$hd" origin/main origin/master develop main master; do
    [ -n "$c" ] || continue
    sha=$(git -C "$1" rev-parse --verify -q "$c^{commit}" 2>/dev/null) || continue
    case $c in origin/*) ;; *) tw=$(git -C "$1" rev-parse --verify -q "origin/$c^{commit}" 2>/dev/null) && [ "$tw" = "$sha" ] && continue;; esac
    mb=$(git -C "$1" merge-base "$c" HEAD 2>/dev/null) || continue
    n=$(git -C "$1" rev-list --count "$mb..HEAD" 2>/dev/null) || continue
    if [ -z "$bn" ] || [ "$n" -lt "$bn" ]; then best=$c; bmb=$mb; bn=$n; fi
  done
  [ -n "$bn" ] && [ "$bn" -gt 0 ] && printf '@@base %s\\t%s\\t%s\\n' "$best" "$bmb" "$bn"
  return 0
}
scan() {
  printf '@@git %s\\n' "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir --absolute-git-dir 2>/dev/null | tr '\\n' '\\t')"
  branch_base "$1"
  git -C "$1" --no-optional-locks -c core.fsmonitor=false -c core.quotePath=false status --porcelain=v1 -b --no-renames 2>&1 \\
    | awk -v cap=${CAP} 'NR <= cap + 1 { print } END { print "=" (NR > 0 ? NR - 1 : 0) }'
}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
if [ -n "$top" ]; then echo "$top"; else find_repos; fi | with_worktrees | awk '!seen[$0]++' > "$tmp/list"
n=0
while IFS= read -r repo; do
  [ -d "$repo" ] || continue
  printf '%s' "$repo" > "$tmp/$n.path"
  scan "$repo" > "$tmp/$n.out" &
  n=$((n + 1))
  [ $((n % 8)) -eq 0 ] && wait
done < "$tmp/list"
wait
i=0
while [ $i -lt $n ]; do
  printf '@@repo %s\\n' "$(cat "$tmp/$i.path")"
  cat "$tmp/$i.out"
  i=$((i + 1))
done`;

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

// One changed file: the letter to show, whether it is untracked, and its staged state from porcelain's XY:
// X (the index) says what is staged, Y (the working tree) what is not.
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
        unstaged: fresh || xy[1] !== " ",
        path: unquote(line.slice(3)),
    };
}

// The script's output as checkouts: { path, name, folder, common, linked, branch, ahead, behind, unborn, files, total,
// staged, base, error }. `base` is null, or { ref, name, mergeBase, count }: the commits this checkout has over its base branch. `name` is the path below root (the folder name when it is root or outside it).
export function parseRepos(stdout, root) {
    const [head, ...blocks] = stdout.split("@@repo ");
    const said = /^@@root (.*)$/m.exec(head ?? "")?.[1];
    const base = (said || root || "").replace(/\/+$/, "");
    return blocks.map((block) => {
        const [first, ...rest] = block.split("\n");
        const path = first.trim(),
            folder = path.split("/").pop();
        const name = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : folder;
        const gitLine = rest.find((l) => l.startsWith("@@git "));
        const [common = null, own = null] = (gitLine?.slice(6) ?? "").split("\t").filter(Boolean);
        const baseLine = rest.find((l) => l.startsWith("@@base "));
        const [ref, mergeBase, count] = (baseLine?.slice(7) ?? "").split("\t");
        const lines = rest.filter((l) => !l.startsWith("@@git ") && !l.startsWith("@@base "));
        const repo = {
            path,
            name,
            folder,
            common,
            linked: Boolean(common && own && common !== own),
            branch: "?",
            ahead: 0,
            behind: 0,
            unborn: false,
            files: [],
            total: 0,
            staged: 0,
            base:
                ref && mergeBase && Number(count) > 0
                    ? {
                          ref,
                          name: ref.replace(/^origin\//, ""),
                          mergeBase,
                          count: Number(count),
                      }
                    : null,
            error: null,
        };
        const counted = lines.filter((l) => l.startsWith("=")).pop();
        const body = lines.filter((l) => l && !l.startsWith("="));
        if (!body.length || !body[0].startsWith("## ")) {
            repo.error = body[0] || "git status failed";
            return repo;
        }
        Object.assign(repo, parseBranch(body[0]));
        repo.files = body.slice(1).map(parseFile);
        repo.total = Number(counted?.slice(1) ?? repo.files.length);
        repo.staged = repo.files.filter((f) => f.staged).length;
        return repo;
    });
}

// Checkouts as groups: a main checkout with its linked worktrees under it ({ main, worktrees }). A worktree whose main
// checkout is not in the list is a group of its own. Groups keep the order of their main checkout; worktrees go by path.
export function groupRepos(repos) {
    const mains = new Set(repos.filter((r) => r.common && !r.linked).map((r) => r.common));
    const under = new Map();
    const groups = [];
    for (const r of repos) {
        if (r.linked && mains.has(r.common)) {
            if (!under.has(r.common)) under.set(r.common, []);
            under.get(r.common).push(r);
        } else groups.push({ main: r, worktrees: [] });
    }
    for (const g of groups) {
        if (!g.main.linked && g.main.common)
            g.worktrees = (under.get(g.main.common) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    }
    return groups;
}

/** The checkouts of a group, main first. */
export const checkoutsOf = (group) => [group.main, ...group.worktrees];

/** A group is clean when its main checkout and every worktree has no change, no error and no commit over its base branch. */
export const isClean = (group) => checkoutsOf(group).every((r) => !r.error && !r.files.length && !r.base);

/** The chip beside a checkout's branch: "3 commits vs develop", or null when it has no commit over its base. */
export const aheadChip = (repo) =>
    repo.base ? `${repo.base.count} commit${repo.base.count === 1 ? "" : "s"} vs ${repo.base.name}` : null;

// Repos that match a filter by name or by one of their files; a repo matched by name keeps all its files.
export function filterRepos(repos, text) {
    const q = text.trim().toLowerCase();
    if (!q) return repos;
    return repos.flatMap((r) => {
        if (r.name.toLowerCase().includes(q)) return [r];
        const files = r.files.filter((f) => f.path.toLowerCase().includes(q));
        return files.length ? [{ ...r, files }] : [];
    });
}

// Groups that match a filter: a main checkout matched by name keeps its whole group; otherwise the matching worktrees
// stay under their main checkout, which keeps only its own matching files.
export function filterGroups(groups, text) {
    if (!text.trim()) return groups;
    return groups.flatMap((g) => {
        const [main] = filterRepos([g.main], text);
        if (main === g.main) return [g];
        const worktrees = filterRepos(g.worktrees, text);
        if (!main && !worktrees.length) return [];
        return [{ main: main ?? { ...g.main, files: [] }, worktrees }];
    });
}

// A file path as its folders (dimmed) and its name.
export function splitPath(path) {
    const parts = path.split("/"),
        name = parts.pop();
    return { dir: parts.length ? `${parts.join("/")}/` : "", name };
}

// ---- Settings ----

const DEFAULTS = { newBranchPrefix: "feature/", baseBranch: null };

/** config.json next to the mod: `{ newBranchPrefix, baseBranch }`. A wrong field keeps its default and is reported. */
export function parseConfig(text) {
    const config = { ...DEFAULTS, problems: [] };
    if (text == null || text.trim() === "") return config;
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        config.problems.push(`config.json is not valid JSON: ${e.message}`);
        return config;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        config.problems.push("config.json must hold an object");
        return config;
    }
    if (raw.newBranchPrefix != null) {
        if (typeof raw.newBranchPrefix === "string") config.newBranchPrefix = raw.newBranchPrefix;
        else config.problems.push('"newBranchPrefix" must be a string, such as "feature/"');
    }
    if (raw.baseBranch != null) {
        if (typeof raw.baseBranch === "string" && raw.baseBranch.trim())
            config.baseBranch = raw.baseBranch.trim().replace(/^origin\//, "");
        else config.problems.push('"baseBranch" must be a branch name, such as "main", or null');
    }
    return config;
}

// ---- Who is working where ----

const WORKING = new Set(["working", "blocked"]);
const inside = (dir, path) => Boolean(path) && (path === dir || path.startsWith(`${dir.replace(/\/+$/, "")}/`));

/** The panes (`{ cwd, status, name }`, on the checkout's machine) where an agent is working or blocked inside a
 * checkout. A pane inside another checkout nested in this one (a worktree in a subfolder) is that one's, not this one's. */
export function busyAgents(checkout, panes, others = []) {
    const nested = others.filter((o) => o !== checkout && inside(checkout, o));
    return panes.filter(
        (p) => WORKING.has(p.status) && inside(checkout, p.cwd) && !nested.some((n) => inside(n, p.cwd)),
    );
}

// ---- Git actions ----
// Each takes `exec(cmd, args, { cwd })` (Herdr's exec, or child_process in the tests) and returns { ok, message }.
// None of them uses --force, -D, reset, --discard-changes, --amend, --no-verify or push; a refusal runs no write.

const firstLine = (r) => (r.stderr || r.stdout || `git exited with ${r.code}`).trim().split("\n")[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const git = (exec, cwd) => (args) => exec("git", args, { cwd });
/** File names are never patterns: `*.ts` names the file called `*.ts`. */
const LITERAL = "--literal-pathspecs";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

/** Why a branch name is not acceptable, or null. `git check-ref-format --branch` decides, after a few refusals of
 * our own: an option-looking name, `@{...}` shorthands it would expand, and HEAD. */
export async function invalidBranchName(exec, cwd, name) {
    if (!name?.trim()) return "Give the branch a name.";
    if (name.startsWith("-") || name.startsWith("+") || name.includes("@{") || name === "HEAD")
        return `"${name}" is not a valid branch name.`;
    const r = await git(exec, cwd)(["check-ref-format", "--branch", name]);
    if (r.code !== 0 || r.stdout.trim() !== name) return `"${name}" is not a valid branch name.`;
    return null;
}

/** The reason not to change branch now, or null: an agent working in the checkout, or uncommitted changes there. */
export async function switchRefusal(exec, checkout, busy) {
    if (busy?.length) {
        const who = busy[0];
        return `${who.name || "An agent"} is ${who.status} in ${who.cwd}: wait until it stops before changing branch.`;
    }
    const st = await git(exec, checkout)([...READ, "status", "--porcelain"]);
    if (st.code !== 0) return `Cannot read the checkout's status: ${firstLine(st)}`;
    const n = st.stdout.split("\n").filter(Boolean).length;
    if (n) return `${plural(n, "file")} with uncommitted changes here: commit or discard them before changing branch.`;
    return null;
}

/** The branches a checkout can switch to: local ones (the current one marked, ones checked out in another worktree
 * marked with that worktree's folder), then origin's branches that have no local branch. */
export async function listBranches(exec, checkout) {
    const run = git(exec, checkout);
    const top = await run(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return { ok: false, message: firstLine(top), branches: [] };
    const here = top.stdout.trim();
    const head = await run(["symbolic-ref", "-q", "--short", "HEAD"]);
    const current = head.code === 0 ? head.stdout.trim() : null;
    const refs = await run([
        "for-each-ref",
        "--format=%(refname)%09%(worktreepath)",
        "refs/heads",
        "refs/remotes/origin",
    ]);
    if (refs.code !== 0) return { ok: false, message: firstLine(refs), branches: [] };
    const local = [],
        remote = [];
    for (const line of refs.stdout.split("\n").filter(Boolean)) {
        const [ref, worktree = ""] = line.split("\t");
        if (ref.startsWith("refs/heads/")) {
            const name = ref.slice(11);
            const elsewhere = worktree && worktree !== here ? worktree.split("/").pop() : null;
            local.push({
                name,
                remote: false,
                current: name === current,
                inUse: elsewhere,
            });
        } else {
            const name = ref.slice("refs/remotes/origin/".length);
            if (name !== "HEAD") remote.push(name);
        }
    }
    const names = new Set(local.map((b) => b.name));
    local.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    const branches = [
        ...local,
        ...remote
            .filter((n) => !names.has(n))
            .sort()
            .map((name) => ({ name, remote: true, current: false, inUse: null })),
    ];
    return { ok: true, message: "", current, branches };
}

/** Branches whose name holds the text, in the same order. */
export function filterBranches(branches, text) {
    const q = text.trim().toLowerCase();
    return q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
}

/** `git switch <branch>`, or `git switch --track origin/<branch>` for a branch only origin has. Refused (no switch run)
 * when an agent is busy there, when there are uncommitted changes, or when another worktree has the branch. */
export async function switchBranch(exec, { checkout, branch, busy = [] }) {
    const refused = await switchRefusal(exec, checkout, busy);
    if (refused) return { ok: false, message: refused };
    const bad = await invalidBranchName(exec, checkout, branch);
    if (bad) return { ok: false, message: bad };
    const list = await listBranches(exec, checkout);
    if (!list.ok) return list;
    const target = list.branches.find((b) => b.name === branch);
    if (!target) return { ok: false, message: `No branch ${branch} here or on origin.` };
    if (target.current) return { ok: false, message: `Already on ${branch}.` };
    if (target.inUse)
        return {
            ok: false,
            message: `${branch} is checked out in ${target.inUse}; switch there instead.`,
        };
    const args = target.remote ? ["switch", "--track", `origin/${branch}`] : ["switch", branch];
    const r = await git(exec, checkout)(args);
    if (r.code !== 0) return { ok: false, message: firstLine(r) };
    return {
        ok: true,
        message: `Switched to ${branch}${target.remote ? `, tracking origin/${branch}` : ""}.`,
    };
}

/** The base for a new branch: config `baseBranch`, else origin's HEAD branch, else origin's main or master, else main. */
export async function defaultBase(exec, checkout, config = DEFAULTS) {
    if (config.baseBranch) return config.baseBranch;
    const run = git(exec, checkout);
    const head = await run(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
    if (head.code === 0 && head.stdout.trim().startsWith("origin/")) return head.stdout.trim().slice(7);
    for (const name of ["main", "master"]) {
        if ((await run(["show-ref", "--verify", "-q", `refs/remotes/origin/${name}`])).code === 0) return name;
    }
    return "main";
}

/** `git fetch origin <base>`, then `git switch --no-track -c <name> origin/<base>`. The same refusals as a switch, and
 * a name git would not accept, a branch that exists already, or a base origin does not have. --no-track keeps the new
 * branch from pushing to the base by mistake: it gets its own upstream on its first push. */
export async function newBranch(exec, { checkout, name, base, busy = [] }) {
    const refused = await switchRefusal(exec, checkout, busy);
    if (refused) return { ok: false, message: refused };
    const bad = await invalidBranchName(exec, checkout, name);
    if (bad) return { ok: false, message: bad };
    const from = (base ?? "").replace(/^origin\//, "");
    if (await invalidBranchName(exec, checkout, from)) return { ok: false, message: `"${base}" is not a valid base.` };
    const run = git(exec, checkout);
    if ((await run(["show-ref", "--verify", "-q", `refs/heads/${name}`])).code === 0)
        return {
            ok: false,
            message: `A branch ${name} exists already; pick it from the list.`,
        };
    const fetched = await run(["fetch", "origin", from]);
    if (fetched.code !== 0)
        return {
            ok: false,
            message: `git fetch origin ${from} failed: ${firstLine(fetched)}`,
        };
    if ((await run(["show-ref", "--verify", "-q", `refs/remotes/origin/${from}`])).code !== 0)
        return { ok: false, message: `origin has no branch ${from}.` };
    const r = await run(["switch", "--no-track", "-c", name, `origin/${from}`]);
    if (r.code !== 0) return { ok: false, message: firstLine(r) };
    return {
        ok: true,
        message: `Created ${name} from origin/${from} and switched to it.`,
    };
}

const unborn = async (run) => (await run(["rev-parse", "--verify", "-q", "HEAD"])).code !== 0;

/** `git add -- <file>`. */
export async function stageFile(exec, { checkout, file }) {
    const r = await git(exec, checkout)([LITERAL, "add", "--", file]);
    return r.code === 0 ? { ok: true, message: `Staged ${file}.` } : { ok: false, message: firstLine(r) };
}

/** `git restore --staged -- <file>`; before the first commit (no HEAD to restore from), `git rm --cached -- <file>`,
 * as git's own hint says. Either way the file on disk is left as it is. */
export async function unstageFile(exec, { checkout, file }) {
    const run = git(exec, checkout);
    const args = (await unborn(run))
        ? [LITERAL, "rm", "--cached", "-q", "--", file]
        : [LITERAL, "restore", "--staged", "--", file];
    const r = await run(args);
    return r.code === 0 ? { ok: true, message: `Unstaged ${file}.` } : { ok: false, message: firstLine(r) };
}

/** `git add -A`: every change of the checkout. */
export async function stageAll(exec, { checkout }) {
    const r = await git(exec, checkout)(["add", "-A"]);
    return r.code === 0 ? { ok: true, message: "Staged every change." } : { ok: false, message: firstLine(r) };
}

/** `git restore --staged -- .` (before the first commit, `git rm -r --cached -q -- .`). Files on disk stay as they are. */
export async function unstageAll(exec, { checkout }) {
    const run = git(exec, checkout);
    const args = (await unborn(run))
        ? [LITERAL, "rm", "-r", "--cached", "-q", "--", "."]
        : [LITERAL, "restore", "--staged", "--", "."];
    const r = await run(args);
    return r.code === 0 ? { ok: true, message: "Unstaged everything." } : { ok: false, message: firstLine(r) };
}

/** What discarding a file with this porcelain XY does: "delete" an untracked or newly added file (nothing in HEAD to go
 * back to), else "restore" it to HEAD. The confirm says which, and the action refuses when it is no longer so. */
export const discardKind = (xy) => (xy === "??" || xy[0] === "A" ? "delete" : "restore");

/** Discards one file's changes, after reading its status again. Tracked: `git restore --worktree --staged -- <file>`.
 * Untracked: `git clean -f -- <file>`, never -d or -x. Refused for a folder, for a path that is not one changed file,
 * and when the file is no longer what the confirm said (`expect`: "delete" or "restore"). There is no "discard all". */
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

/** `git commit -m <message>`: the staged files only, with the hooks. Refused with an empty message or nothing staged.
 * Says the new commit's short hash, or git's first line of error. */
export async function commit(exec, { checkout, message }) {
    if (!message?.trim()) return { ok: false, message: "Write a commit message first." };
    const run = git(exec, checkout);
    if ((await run(["diff", "--cached", "--quiet"])).code === 0)
        return {
            ok: false,
            message: "Nothing is staged: tick the files to commit first.",
        };
    const r = await run(["commit", "-m", message]);
    if (r.code !== 0) return { ok: false, message: firstLine(r) };
    const hash = await run(["rev-parse", "--short", "HEAD"]);
    return {
        ok: true,
        message: `Committed ${hash.stdout.trim()}.`,
        hash: hash.stdout.trim(),
    };
}
