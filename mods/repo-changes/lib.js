// Helpers of the Changes panel that need no Herdr: the read script and its parsing, how checkouts nest, and the git
// actions. They live apart from main.js so the tests can load them outside Herdr and run the actions on real repositories.

// Most changed files listed per checkout; the rest become "+N more".
export const CAP = 200;

// Run with `sh -c SCRIPT sh <root>` on the space's machine, once per refresh.
// Output: "@@root <root as a physical path>", then per checkout a line "@@repo <absolute path>", a line
// "@@git <common git dir><tab><own git dir>" (the same for a main checkout, different for a linked worktree), a line
// "@@remote origin" when the checkout has that remote, a line "@@head <short hash><unit separator><subject><unit
// separator><commit time in seconds>" (nothing before the first commit), then `git status --porcelain=v1 -b` (branch
// line, then one line per changed file, at most CAP), then "=<changed file count>".
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
  git -C "$1" remote get-url origin >/dev/null 2>&1 && printf '@@remote origin\\n'
  head=$(git -C "$1" log -1 --format='%h%x1f%s%x1f%ct' 2>/dev/null) && printf '@@head %s\\n' "$head"
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

// "## main...origin/main [ahead 1, behind 2]", "## HEAD (no branch)", "## No commits yet on main". `upstream` is null
// without one (a branch nobody published yet), and `gone` says origin no longer has it.
function parseBranch(line) {
    const text = line.slice(3);
    if (text.startsWith("HEAD (no branch)"))
        return {
            branch: "(detached)",
            detached: true,
            ahead: 0,
            behind: 0,
            unborn: false,
            upstream: null,
            gone: false,
        };
    const unborn = text.startsWith("No commits yet on ");
    const [name, rest] = text.replace(/^No commits yet on /, "").split("...");
    const track = /\[(.*)\]\s*$/.exec(rest ?? "")?.[1] ?? "";
    return {
        branch: name,
        detached: false,
        unborn,
        upstream: (rest ?? "").replace(/\s*\[.*\]\s*$/, "").trim() || null,
        gone: track.includes("gone"),
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

// The script's output as checkouts: { path, name, folder, common, linked, branch, detached, upstream, gone, ahead,
// behind, unborn, head, remote, files, total, staged, base, error }. `base` is null, or { ref, name, mergeBase, count }:
// the commits this checkout has over its base branch. `head` is null, or { hash, subject, at } (at in ms). `remote` is
// "origin" when the checkout has that remote. `name` is the path below root (the folder name when it is root or outside it).
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
        const headLine = rest.find((l) => l.startsWith("@@head "));
        const [sha, subject, seconds] = (headLine?.slice(7) ?? "").split("\x1f");
        const remote =
            rest
                .find((l) => l.startsWith("@@remote "))
                ?.slice(9)
                .trim() || null;
        const lines = rest.filter(
            (l) =>
                !l.startsWith("@@git ") &&
                !l.startsWith("@@base ") &&
                !l.startsWith("@@head ") &&
                !l.startsWith("@@remote "),
        );
        const repo = {
            path,
            name,
            folder,
            common,
            linked: Boolean(common && own && common !== own),
            branch: "?",
            detached: false,
            upstream: null,
            gone: false,
            ahead: 0,
            behind: 0,
            unborn: false,
            head: sha ? { hash: sha, subject: subject ?? "", at: Number(seconds) * 1000 || null } : null,
            remote,
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

// ---- The list's look: short names, folded repos, badges and the one commit line ----

/** Shared state: `{ "<main checkout path>": true }` for the repos whose worktrees are folded away. */
export const FOLD_KEY = "repo-changes.folded";

const segmentsOf = (path) =>
    String(path ?? "")
        .split(/[\\/]+/)
        .filter(Boolean);
const folderOf = (path) => segmentsOf(path).pop() ?? "";
const parentOf = (path) => segmentsOf(path).slice(0, -1).join("/") || "/";

/**
 * How one checkout is named in the list: its folder; a worktree drops its main checkout's name ("jig-dark" -> "dark",
 * "orders-api-42" -> "42") when something is left, and takes its parent folder when the folder is the main's name again
 * ("worktrees/PROJ-42/orders-api" -> "PROJ-42"); `dir` is the caller's tag for two rows that would otherwise read the
 * same.
 */
export function rowName(repo, { main = null, dir = null } = {}) {
    const path = repo?.path ?? repo?.name ?? "",
        folder = folderOf(path);
    let name = folder;
    if (main) {
        const prefix = folderOf(main.path ?? main.name),
            rest =
                prefix && folder.toLowerCase().startsWith(prefix.toLowerCase())
                    ? folder.slice(prefix.length).replace(/^[-_.]/, "")
                    : "";
        if (rest) name = rest;
        else if (prefix && folder.toLowerCase() === prefix.toLowerCase()) {
            const parent = folderOf(parentOf(path));
            if (parent && parent !== folder) name = parent;
        }
    }
    return { name: name || folder || "/", dir };
}

/**
 * The shortest parent-folder suffix that tells same-named rows apart: `[{ path, name }]` -> Map(path -> tag). Rows whose
 * names are unique get no tag.
 */
export function disambiguators(rows) {
    const out = new Map(),
        byName = new Map();
    for (const row of rows ?? []) {
        const list = byName.get(row.name) ?? [];
        list.push(row);
        byName.set(row.name, list);
    }
    const parents = (path) => segmentsOf(parentOf(path));
    for (const list of byName.values()) {
        if (list.length < 2) continue;
        for (const row of list) {
            const mine = parents(row.path),
                others = list.filter((r) => r.path !== row.path).map((r) => parents(r.path));
            let tag = mine.slice(-1).join("/") || folderOf(row.path);
            for (let n = 1; n <= 3 && tag; n++) {
                const suffix = mine.slice(-n).join("/");
                if (suffix && others.every((other) => other.slice(-n).join("/") !== suffix)) {
                    tag = suffix;
                    break;
                }
                if (n === 3) tag = mine.slice(-2).join("/") || tag;
            }
            out.set(row.path, tag);
        }
    }
    return out;
}

/** The branch as a chip shows it: optionally the conventional prefix apart, and the rest whole — the chip's layout cuts
 * the start when space runs out, so the end (the ticket number) survives without a fixed character budget. */
export function branchLabel(branch, { lead = true } = {}) {
    const said = String(branch ?? ""),
        prefix = /^(feature|bugfix|hotfix|release)\//.exec(said)?.[1] ?? null;
    return { lead: lead && prefix ? `${prefix}/` : null, text: prefix ? said.slice(prefix.length + 1) : said };
}

/** Whether a branch is the name a row already shows (its last part, case aside): then the chip is only its icon. */
export function branchMatchesName(name, branch) {
    const said =
            String(branch ?? "")
                .split("/")
                .pop() ?? "",
        shown = String(name ?? "");
    return Boolean(said) && Boolean(shown) && said.toLowerCase() === shown.toLowerCase();
}

/** What a folded worktree still reports without a line of its own: changes, commits, trouble. */
export const worktreeSignal = (repo) =>
    Boolean(repo) &&
    ((repo.files?.length ?? 0) > 0 || repo.ahead > 0 || repo.behind > 0 || repo.detached || Boolean(repo.error));

/** Whether a group starts folded: unless one of its worktrees is the focused folder or has something to report. */
export function foldedByDefault(group, focused = "") {
    const contains = (dir) =>
        Boolean(focused) && (focused === dir || focused.startsWith(`${String(dir).replace(/\/+$/, "")}/`));
    return !(group?.worktrees ?? []).some((w) => contains(w.path) || worktreeSignal(w));
}

/** The shared fold map (main path -> folded), ignoring anything that is not a boolean. */
export function foldMap(raw) {
    const out = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw))
        for (const [path, value] of Object.entries(raw)) if (typeof value === "boolean") out[path] = value;
    return out;
}

/** Whether a group is folded now: the person's stored choice, else the default for this group and focus. */
export function isFolded(map, group, focused = "") {
    const folds = foldMap(map);
    return typeof folds[group?.main?.path] === "boolean" ? folds[group.main.path] : foldedByDefault(group, focused);
}

/** The fold map with this group's chosen state. */
export const withFold = (map, group, folded) => ({ ...foldMap(map), [group.main.path]: Boolean(folded) });

/** The fold map with every group's chosen state (the header's fold-all). */
export function withAllFolds(groups, folded) {
    const out = {};
    for (const group of groups ?? []) if (group?.main?.path) out[group.main.path] = Boolean(folded);
    return out;
}

/** The checkout the focused folder belongs to (the deepest), or null. */
export function focusedCheckout(repos, folder) {
    let best = null;
    for (const repo of repos ?? []) {
        if (!repo?.path) continue;
        const path = repo.path.replace(/\/+$/, "");
        if (folder === path || String(folder ?? "").startsWith(`${path}/`))
            if (!best || path.length > best.length) best = path;
    }
    return best;
}

/** Whether a row shows its last commit: the focused one, or every row when the person asks for the full look. */
export const showsCommit = (repo, focusedPath, detail = "compact") =>
    detail === "full" || (Boolean(repo?.path) && repo.path === focusedPath);

/** The ahead/behind text ("↑9 ↓17"), empty when level. */
export const badgeText = (repo) =>
    [repo?.ahead ? `↑${repo.ahead}` : null, repo?.behind ? `↓${repo.behind}` : null].filter(Boolean).join(" ");

/** A checkout is diverged when it has commits of its own and commits to take. */
export const isDiverged = (repo) => Boolean(repo) && repo.ahead > 0 && repo.behind > 0;

/** The changed-file count shown as a badge, or null. */
export const changedBadge = (repo) => ((repo?.total ?? 0) > 0 ? String(repo.total) : null);

/** The chip beside a checkout's branch: "3 commits vs develop" ("3 vs develop" compact), or null when it has no commit
 * over its base. */
export const aheadChip = (repo, compact = false) =>
    repo.base
        ? compact
            ? `${repo.base.count} vs ${repo.base.name}`
            : `${repo.base.count} commit${repo.base.count === 1 ? "" : "s"} vs ${repo.base.name}`
        : null;

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

// ---- Where to look ----

/** The folder the panel lists. Following the terminal (`follow`) prefers where the focused terminal is now, then the
 * space's folder, then the space's first terminal; otherwise the space's folder comes first. */
export function pickRoot({ follow, focusedCwd, spaceFolder, first }) {
    if (follow) return focusedCwd || spaceFolder || first || null;
    return spaceFolder || first || focusedCwd || null;
}

/** The panes of terminals on a machine, as busyAgents takes them. Panes belong to tabs, and a tab to a space on the
 * machine where it lives. */
export function panesOn(panes, spaces, on) {
    const machineOf = new Map(spaces.flatMap((s) => s.tabs.map((tab) => [tab.id, s.machine ?? null])));
    return panes
        .filter((p) => p.terminal && machineOf.get(p.tab) === (on ?? null))
        .map((p) => ({ cwd: p.cwd, status: p.status, name: p.program?.name || p.title }));
}

/** A past time in words: "just now", "5m ago", "3h ago", "2d ago", "3w ago", "5mo ago", "2y ago". */
export function ago(at, now = Date.now()) {
    if (!Number.isFinite(at)) return "";
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400 / 7)}w ago`;
    if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo ago`;
    return `${Math.floor(s / 86400 / 365)}y ago`;
}

// ---- Settings ----

const DEFAULTS = {
    newBranchPrefix: "feature/",
    baseBranch: null,
    remote: "origin",
    networkTimeoutSeconds: 60,
    rowDetail: "compact",
};

/** config.json next to the mod: `{ newBranchPrefix, baseBranch, remote, networkTimeoutSeconds, rowDetail }`. A wrong
 * field keeps its default and is reported. `rowDetail` is "compact" (one line per checkout) or "full" (a commit line for
 * every row, as the panel looked before). */
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
    if (raw.remote != null) {
        if (
            typeof raw.remote === "string" &&
            raw.remote.trim() &&
            !/\s/.test(raw.remote) &&
            !raw.remote.startsWith("-")
        )
            config.remote = raw.remote.trim();
        else config.problems.push('"remote" must be a remote name, such as "origin"');
    }
    if (raw.rowDetail != null) {
        if (raw.rowDetail === "compact" || raw.rowDetail === "full") config.rowDetail = raw.rowDetail;
        else config.problems.push('"rowDetail" must be "compact" or "full"');
    }
    if (raw.networkTimeoutSeconds != null) {
        if (
            Number.isInteger(raw.networkTimeoutSeconds) &&
            raw.networkTimeoutSeconds >= 5 &&
            raw.networkTimeoutSeconds <= 600
        )
            config.networkTimeoutSeconds = raw.networkTimeoutSeconds;
        else config.problems.push('"networkTimeoutSeconds" must be a whole number from 5 to 600');
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
const git = (exec, cwd, extra) => (args) => exec("git", args, { cwd, ...extra });
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

// ---- Network actions: fetch, pull, push, publish ----
// The same shape as the others, with `{ cwd, env?, timeout? }`: no prompt (git fails instead of asking for a password or
// a host key), and a command still running after the timeout is stopped and reported. None of them forces anything: a
// push git refuses to fast-forward is git's own answer, and a pull that cannot fast-forward says so and suggests a
// terminal. Each checks the same refusals as a switch first (an agent working there, a detached HEAD) and reads the
// branch and its push target again just before the command, never trusting what the panel showed.

/** How long a network command may run, unless config.json says otherwise. */
export const NETWORK_TIMEOUT = 60000;
/** What a network command needs so it never waits for an answer. */
export const NETWORK_ENV = { GIT_TERMINAL_PROMPT: "0" };

/** The environment of a network command: no terminal prompt, and whatever the caller knows of the person's own (a
 * GIT_SSH_COMMAND here wins). The shell wrapper adds the BatchMode ssh command only when the machine has neither one. */
export const networkEnv = (existing = {}) => ({ ...NETWORK_ENV, ...(existing ?? {}) });

/** The seconds a timeout stands for, at least one. */
const timeoutSeconds = (timeout) => Math.max(1, Math.round((timeout ?? NETWORK_TIMEOUT) / 1000));

/** What a stopped command says: never git's bare exit code. */
export const timeoutMessage = (timeout = NETWORK_TIMEOUT) =>
    `Timed out after ${timeoutSeconds(timeout)} s — check your network or sign-in, then try in a terminal.`;

/** `value` as one POSIX shell word. */
export function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The `sh -c` script that runs a command the way a network command needs it:
 * - the variables passed in, quoted;
 * - `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` only when the machine has no GIT_SSH_COMMAND and the repository has no
 *   `core.sshCommand`, so the person's own ssh setup is never replaced;
 * - the command under `timeout` when the machine has it, else under a watchdog — a background `sleep`, a flag file in
 *   the temp folder, then `kill` of the command and its children — that stops it and exits 124, so a machine without
 *   `timeout` (macOS) still cannot hang the panel.
 * The command and its arguments arrive as `$@` (`sh -c SCRIPT sh <cmd> <args...>`), so nothing is re-quoted.
 */
export function wrapperScript(env, timeout = NETWORK_TIMEOUT) {
    const lines = [];
    for (const [key, value] of Object.entries(env ?? {}))
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) lines.push(`export ${key}=${shQuote(value)}`);
    lines.push(
        `if [ -z "\${GIT_SSH_COMMAND+set}" ] && [ -z "\${GIT_SSH+set}" ] && ! git config --get core.sshCommand >/dev/null 2>&1; then export GIT_SSH_COMMAND=${shQuote("ssh -o BatchMode=yes")}; fi`,
    );
    const seconds = timeoutSeconds(timeout);
    lines.push(`if command -v timeout >/dev/null 2>&1; then exec timeout ${seconds} "$@"; fi`);
    lines.push(
        `flag=\${TMPDIR:-/tmp}/repo-changes-timeout-$$`,
        `done=\${TMPDIR:-/tmp}/repo-changes-done-$$`,
        'rm -f "$flag" "$done"',
        "start=$(date +%s 2>/dev/null || echo 0)",
        '"$@" & pid=$!',
        // The watchdog exits on its own once the command is done (the done file), so killing its sleep first cannot
        // race it into writing the timeout flag for a command that already succeeded.
        `( sleep ${seconds}; [ -e "$done" ] && exit; : > "$flag"; pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; sleep 1; pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 & watchdog=$!`,
        'wait "$pid"; code=$?',
        ': > "$done"',
        'pkill -TERM -P "$watchdog" 2>/dev/null',
        'kill -TERM "$watchdog" 2>/dev/null',
        'pkill -KILL -P "$watchdog" 2>/dev/null',
        'wait "$watchdog" 2>/dev/null',
        'rm -f "$done"',
        "end=$(date +%s 2>/dev/null || echo 0)",
        `if [ -e "$flag" ] || { [ "$code" -ge 128 ] && [ $((end - start)) -ge ${seconds} ]; }; then rm -f "$flag" "$done"; exit 124; fi`,
        'rm -f "$flag" "$done"',
        'exit "$code"',
    );
    return lines.join("\n");
}

/** The options a network command runs with: the environment that never asks, and the timeout. */
const networkOptions = ({ env, timeout }) => ({ env: networkEnv(env), timeout: timeout ?? NETWORK_TIMEOUT });

/** A failed network command as one line: a timeout says so instead of exposing exit code 124. */
const networkFailure = (r, timeout, what) => (r.code === 124 ? timeoutMessage(timeout) : `${what}: ${firstLine(r)}`);

/** The reason not to touch a branch now, or null: an agent working or blocked in the checkout, or a detached HEAD. */
export async function branchRefusal(exec, checkout, busy) {
    if (busy?.length) {
        const who = busy[0];
        return `${who.name || "An agent"} is ${who.status} in ${who.cwd}: wait until it stops.`;
    }
    const run = git(exec, checkout);
    if ((await run(["symbolic-ref", "-q", "--short", "HEAD"])).code !== 0)
        return "HEAD is detached here: switch to a branch first.";
    return null;
}

/** The branch checked out here, or null. */
async function branchOf(run) {
    const r = await run(["symbolic-ref", "-q", "--short", "HEAD"]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** One git config value, or null. */
async function configOf(run, key) {
    const r = await run(["config", "--get", key]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The branch's upstream (`origin/feature/x`), or null. A configured upstream whose branch was deleted is null too. */
async function upstreamOf(run) {
    const r = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Commits this checkout has over its upstream and the other way round, or null when git cannot count them. */
async function aheadBehind(run, upstream) {
    const r = await run(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (r.code !== 0) return null;
    const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
}

/**
 * Where a push of this checkout would go, by git's own settings rather than by the panel's guess: `branch.<b>.pushRemote`,
 * `remote.pushDefault`, `branch.<b>.remote` and `push.default`. `mode` is "push" when that destination is the branch
 * itself, so `git push <remote> HEAD:refs/heads/<branch>` is exactly that push; it is "publish" when git has no single
 * same-named destination (no upstream, `push.default` matching or nothing, an upstream under another name, an upstream
 * that is gone, or no such remote), with `reason` saying why. The panel never pushes a branch onto a differently named
 * one, and never pushes with `push.default=matching` (which would send branches the dialog did not list).
 */
export async function pushTarget(exec, { checkout, remote = "origin" }) {
    const run = git(exec, checkout);
    const branch = await branchOf(run);
    if (!branch) return { ok: false, message: "HEAD is detached here: switch to a branch first." };
    const [pushRemote, defaultRemote, trackingRemote, merge, pushDefault] = await Promise.all([
        configOf(run, `branch.${branch}.pushRemote`),
        configOf(run, "remote.pushDefault"),
        configOf(run, `branch.${branch}.remote`),
        configOf(run, `branch.${branch}.merge`),
        configOf(run, "push.default"),
    ]);
    const chosen = pushRemote || defaultRemote || trackingRemote || remote;
    const publishRemote = pushRemote || defaultRemote || remote;
    const mergeName = merge ? merge.replace(/^refs\/heads\//, "") : null;
    const kind = pushDefault || "simple";
    let targetBranch = null;
    let reason = null;
    if (kind === "matching" || kind === "nothing") {
        reason = `push.default is ${kind}: there is no single branch to push.`;
    } else if (kind === "current") {
        targetBranch = branch;
    } else if (kind === "upstream") {
        targetBranch = mergeName;
        if (!targetBranch) reason = "This branch has no upstream to push to.";
    } else {
        // simple, git's default: the upstream branch, and only while it has this branch's own name.
        targetBranch = mergeName === branch ? branch : null;
        if (!targetBranch)
            reason = mergeName
                ? `Its upstream is ${trackingRemote ?? chosen}/${mergeName}; publishing it as ${publishRemote}/${branch} instead.`
                : "This branch has no upstream to push to.";
    }
    if (targetBranch && mergeName && (await run(["rev-parse", "--verify", "-q", "@{upstream}"])).code !== 0) {
        // Configured, but its remote branch is gone: publish it again instead of recreating it silently here.
        reason = `${trackingRemote ?? chosen}/${mergeName} is gone.`;
        targetBranch = null;
    }
    if (targetBranch && (await run(["remote", "get-url", chosen])).code !== 0) {
        reason = `${chosen} is not a remote of this checkout.`;
        targetBranch = null;
    }
    // Publish where git would push (pushRemote, then remote.pushDefault, then the configured remote), under this
    // branch's own name: never onto another branch. A missing push remote falls back, and says so.
    let to = publishRemote;
    if ((await run(["remote", "get-url", publishRemote])).code !== 0) {
        if (publishRemote !== remote) reason = `${publishRemote} is not a remote of this checkout.`;
        to = remote;
    }
    const publish = {
        ok: true,
        branch,
        remote: to,
        target: `${to}/${branch}`,
        targetBranch: branch,
        mode: "publish",
        reason,
    };
    if (!targetBranch) return publish;
    if (targetBranch !== branch)
        return {
            ...publish,
            reason: `Its upstream is ${trackingRemote ?? chosen}/${targetBranch}; publishing it as ${to}/${branch} instead.`,
        };
    return {
        ok: true,
        branch,
        remote: chosen,
        target: `${chosen}/${branch}`,
        targetBranch: branch,
        mode: "push",
        reason: null,
    };
}

/** What changed since the dialog opened, or null. The dialog's snapshot is checked against git again, so a `git switch`
 * in a terminal cannot make it push something it did not show. */
function expectChange(expect, target) {
    if (!expect) return null;
    if (expect.branch !== target.branch)
        return `The branch changed since this confirm opened (${expect.branch} → ${target.branch}); look again.`;
    if (expect.target && (expect.mode !== target.mode || expect.target !== target.target))
        return `The push target changed since this confirm opened (${expect.target} → ${target.target}); look again.`;
    return null;
}

/** `git fetch --prune <remote>`: reads the remote and updates the remote-tracking branches. Allowed while an agent works
 * here: it changes no file and no branch. Reported are the branches that moved. */
export async function fetchRemote(exec, { checkout, remote = "origin", env, timeout = NETWORK_TIMEOUT }) {
    const run = git(exec, checkout);
    if ((await run(["remote", "get-url", remote])).code !== 0)
        return { ok: false, message: `This checkout has no remote ${remote}.` };
    const r = await git(exec, checkout, networkOptions({ env, timeout }))(["fetch", "--prune", remote]);
    if (r.code !== 0) return { ok: false, message: networkFailure(r, timeout, "Fetch failed") };
    const moved = `${r.stderr}\n${r.stdout}`.split("\n").filter((l) => /\s->\s|\s\[deleted\]/.test(l)).length;
    return {
        ok: true,
        message: moved ? `Fetched ${remote}: ${plural(moved, "branch")} moved.` : `Fetched ${remote}: nothing new.`,
    };
}

/** `git pull --ff-only`: the upstream's commits, only when they can be added on top. Refused while an agent works here,
 * on a detached HEAD, and without an upstream (a gone one included). A branch that has diverged is not merged: git's
 * message says why, and the result points at a terminal. */
export async function pullFastForward(exec, { checkout, busy = [], env, timeout = NETWORK_TIMEOUT }) {
    const refused = await branchRefusal(exec, checkout, busy);
    if (refused) return { ok: false, message: refused };
    const run = git(exec, checkout);
    const upstream = await upstreamOf(run);
    if (!upstream) return { ok: false, message: "This branch has no upstream: publish it before pulling." };
    const r = await git(exec, checkout, networkOptions({ env, timeout }))(["pull", "--ff-only"]);
    if (r.code !== 0) {
        const said = `${r.stderr}\n${r.stdout}`;
        if (/not possible to fast-forward|would be overwritten|would be overwritten by merge|diverg/i.test(said))
            return {
                ok: false,
                message: `${firstLine(r)}. It cannot fast-forward: merge in a terminal, then pull again.`,
            };
        return { ok: false, message: networkFailure(r, timeout, "Pull failed") };
    }
    if (/Already up to date/i.test(`${r.stdout}\n${r.stderr}`))
        return { ok: true, message: `Already up to date with ${upstream}.` };
    const head = await run(["rev-parse", "--short", "HEAD"]);
    return { ok: true, message: `Pulled ${upstream}: now at ${head.stdout.trim() || "HEAD"}.` };
}

/**
 * `git push <remote> HEAD:refs/heads/<branch>`: exactly the destination `pushTarget` names, never bare `git push` (which
 * follows `push.default`, `pushRemote` and `remote.pushDefault` and can send something else). Refused while an agent works
 * here, on a detached HEAD, when the destination is not the branch itself (publish instead), when the branch or target
 * changed since the dialog opened, and with nothing ahead. `requireAhead` false is for Sync, which pushes after its pull.
 */
export async function pushBranch(
    exec,
    { checkout, busy = [], env, timeout = NETWORK_TIMEOUT, remote = "origin", expect = null, requireAhead = true },
) {
    const refused = await branchRefusal(exec, checkout, busy);
    if (refused) return { ok: false, message: refused };
    const target = await pushTarget(exec, { checkout, remote });
    if (!target.ok) return { ok: false, message: target.message };
    const changed = expectChange(expect, target);
    if (changed) return { ok: false, message: changed };
    if (target.mode !== "push")
        return {
            ok: false,
            message: target.reason ?? "This branch has no push target: publish it instead.",
        };
    const run = git(exec, checkout);
    // The destination may not exist yet on a remote this clone has not fetched (a first push to a fork): git then decides
    // what is new, and there is nothing to compare. Everything below the branch's own upstream is still comparable.
    const counts = await aheadBehind(run, target.target);
    if (counts && counts.ahead === 0) {
        const message = `Nothing to push: ${target.target} has every commit already.`;
        return { ok: !requireAhead, message };
    }
    const r = await git(
        exec,
        checkout,
        networkOptions({ env, timeout }),
    )(["push", target.remote, `HEAD:refs/heads/${target.targetBranch}`]);
    if (r.code !== 0) return { ok: false, message: networkFailure(r, timeout, "Push failed") };
    if (/Everything up-to-date/i.test(`${r.stderr}\n${r.stdout}`))
        return { ok: true, message: `Already up to date with ${target.target}.` };
    if (!counts?.ahead) return { ok: true, message: `Pushed to ${target.target}.` };
    return { ok: true, message: `Pushed ${plural(counts.ahead, "commit")} to ${target.target}.` };
}

/** `git push -u <remote> HEAD`: publishes the branch under its own name and makes it track its new remote branch. The
 * way out of every "no safe push target" case: no upstream, a gone one, a different push branch, `push.default=matching`.
 * Refused while an agent works here, on a detached HEAD, with no commit, without that remote, and when the branch or
 * target changed since the dialog opened. */
export async function publishBranch(
    exec,
    { checkout, busy = [], env, remote = "origin", timeout = NETWORK_TIMEOUT, expect = null },
) {
    const refused = await branchRefusal(exec, checkout, busy);
    if (refused) return { ok: false, message: refused };
    const run = git(exec, checkout);
    const branch = await branchOf(run);
    if (!branch) return { ok: false, message: "HEAD is detached here: switch to a branch first." };
    if ((await run(["rev-parse", "--verify", "-q", "HEAD"])).code !== 0)
        return { ok: false, message: "The branch has no commit yet: commit something first." };
    const target = await pushTarget(exec, { checkout, remote });
    if (!target.ok) return target;
    if ((await run(["remote", "get-url", target.remote])).code !== 0)
        return { ok: false, message: `This checkout has no remote ${target.remote}.` };
    const changed = expectChange(expect, target);
    if (changed) return { ok: false, message: changed };
    if (target.mode === "push")
        return { ok: false, message: `This branch already pushes to ${target.target}: push it instead.` };
    const r = await git(exec, checkout, networkOptions({ env, timeout }))(["push", "-u", target.remote, "HEAD"]);
    if (r.code !== 0) return { ok: false, message: networkFailure(r, timeout, "Publish failed") };
    return { ok: true, message: `Published ${branch} to ${target.target}; it tracks it now.` };
}

/** The state of a branch that has diverged from its upstream, or null: `git pull --ff-only` cannot help there. */
export const divergedText = (repo) =>
    repo && repo.ahead > 0 && repo.behind > 0
        ? `diverged — ↑${repo.ahead} ↓${repo.behind}: rebase or merge in a terminal`
        : null;

/**
 * The network buttons a checkout's row shows, in order: "pull", "push" or "publish", "fetch". There is no Sync: it could
 * only appear when a branch is both ahead and behind, which is exactly where a fast-forward pull always fails. The caller
 * still disables Push with nothing ahead and Publish on a detached HEAD or before the first commit.
 */
export function rowActions({ hover = false, ahead = 0, behind = 0, publish = false }) {
    const actions = [];
    if (hover || behind) actions.push("pull");
    if (hover || publish || ahead) actions.push(publish ? "publish" : "push");
    if (hover) actions.push("fetch");
    return actions;
}

/**
 * The commits a push (or a first publish) would send, with the destination it would send them to, read locally:
 * `{ ok, branch, remote, target, targetBranch, mode, reason, base, commits: [{ hash, subject }], count, more }`, newest
 * first and at most `limit` of them. The base is the destination's remote branch when the clone has it; else the branch's
 * upstream (a first push to another remote); else the remote's default branch; else the whole branch. A detached HEAD is
 * refused.
 */
export async function commitsToPush(exec, { checkout, limit = 10, remote = "origin" }) {
    const target = await pushTarget(exec, { checkout, remote });
    if (!target.ok) return target;
    const run = git(exec, checkout);
    const exists = async (ref) => (await run(["rev-parse", "--verify", "-q", `refs/remotes/${ref}`])).code === 0;
    let base = target.target;
    if (!(await exists(base))) {
        const upstream = await upstreamOf(run);
        if (upstream && (await exists(upstream))) base = upstream;
        else base = (await exists(`${remote}/HEAD`)) ? `${remote}/HEAD` : null;
    }
    const range = base ? `${base}..HEAD` : "HEAD";
    const log = await run(["log", "-n", String(limit + 1), "--format=%h\x1f%s", range]);
    if (log.code !== 0) return { ok: false, message: firstLine(log) };
    const commits = log.stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
            const [hash, subject] = line.split("\x1f");
            return { hash, subject: subject ?? "" };
        });
    const counted = await run(["rev-list", "--count", range]);
    const count = Number(counted.stdout.trim() || 0);
    return {
        ...target,
        ok: true,
        message: "",
        base,
        commits,
        count,
        more: Math.max(0, count - commits.length),
    };
}

// ---- One action per checkout ----
// The panel and the push dialog are two copies of this mod, so an action's lock is shared state, keyed by the checkout
// (machine and path): a Pull from the panel cannot run while a Push from the dialog holds the same checkout, and a lock
// on one checkout never disables another.

/** Shared state: `{ "<machine>|<path>": { what, at } }`, what is running in each checkout now. */
export const RUNNING_KEY = "repo-changes.running";
/** A lock older than this is stale: a mod that was reloaded mid-action cannot hold a checkout for ever. */
export const RUNNING_TTL = 15 * 60 * 1000;

/** The lock's key for one checkout. */
export const runningKey = (on, path) => `${on ?? ""}|${path}`;

/** The lock map without entries older than `ttl`; never mutates the map it is given. */
export function liveLocks(map, now = Date.now(), ttl = RUNNING_TTL) {
    const out = {};
    for (const [key, value] of Object.entries(map ?? {}))
        if (value && Number.isFinite(value.at) && now - value.at < ttl) out[key] = value;
    return out;
}

/** What is running in this checkout now, `{ what, at }`, or null. */
export function lockOf(map, on, path, now = Date.now(), ttl = RUNNING_TTL) {
    return liveLocks(map, now, ttl)[runningKey(on, path)] ?? null;
}

/** The lock map with this checkout's entry added, carrying the claim's token. */
export function withLock(map, on, path, what, now = Date.now(), token = null) {
    return { ...liveLocks(map, now), [runningKey(on, path)]: { what, at: now, token } };
}

/** The lock map without this checkout's entry, only when it is still the caller's claim: a null or wrong token releases
 * nothing, so a fetch-all or a reloaded copy cannot drop an action it does not own. */
export function withoutLock(map, on, path, now = Date.now(), token = null) {
    const key = runningKey(on, path),
        entry = liveLocks(map, now)[key],
        next = { ...liveLocks(map, now) };
    if (entry && token !== null && entry.token === token) delete next[key];
    return next;
}

/** Whether this checkout's lock belongs to this claim (used after claiming, before acting). */
export const holdsLock = (map, on, path, token, now = Date.now()) => {
    const entry = lockOf(map, on, path, now);
    return Boolean(entry) && entry.token === token;
};

/** Whether the panel should offer Publish on a checkout: no upstream, a gone one, or one under another branch's name. */
export const needsPublish = (repo) =>
    !repo?.upstream || Boolean(repo.gone) || !repo.upstream.endsWith(`/${repo.branch}`);

/** Whether an action may start: the rows must belong to the folder on screen, and the checkout must be free. */
export const canRun = (switching, lock) => !switching && !lock;

/** Whether the commit box puts its message above its buttons (a narrow panel) rather than beside them. */
export const commitRowStacked = (width) => width > 0 && width < 360;
