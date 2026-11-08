// Pure helpers of the Worktrees panel. They live apart from main.js so the tests can load them outside Herdr.

// Run with `sh -c SCRIPT sh <root>` on the space's machine, once per load. Read-only: git reads, no fetch.
// Output: an optional first line "@single" (root is inside one git repo: only that repo is looked at), then
// one line per linked worktree, separated by tabs:
//   W main path branch head locked dirty ahead behind baseAhead upstream gone unpushed base date subject
// main = the main checkout; branch is empty when detached; dirty = `git status --porcelain` lines;
// ahead/behind = against the upstream, else against base; baseAhead = commits not in base;
// gone = 1 when the upstream branch was deleted on the remote; unpushed = commits on no remote branch;
// base = origin/HEAD, else origin/main|master|develop, else the local one. A "?" or empty number = git failed.
// Without a repo around root, repos are the folders with a .git (a folder for a clone, a file for a worktree)
// up to three levels down. A repo is read once however many of its checkouts are found, and only if it has
// linked worktrees. Up to 8 worktrees are read at a time.
// (No dollar-brace in here except the escaped one: this is a JS template string.)
export const SCRIPT = `root=$1
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
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/stat.sh" <<'STAT'
#!/bin/sh
main=$1; p=$2; h=$3; b=$4; l=$5; base=$6
[ -d "$p" ] || exit 0
if [ -n "$b" ]; then ref=$b; else ref=$h; fi
if out=$(git -C "$p" --no-optional-locks -c core.fsmonitor=false status --porcelain 2>/dev/null); then
  d=$(printf '%s' "$out" | awk 'NF { n++ } END { print n + 0 }')
else d='?'; fi
up=; tr=
if [ -n "$b" ]; then
  info=$(git -C "$p" for-each-ref --format='%(upstream:short)|%(upstream:track,nobracket)' "refs/heads/$b" 2>/dev/null)
  up=$(printf '%s' "$info" | cut -d'|' -f1); tr=$(printf '%s' "$info" | cut -d'|' -f2)
fi
gone=0; [ "$tr" = gone ] && gone=1
ba=; bb=0
if [ -n "$base" ]; then
  set -- $(git -C "$p" rev-list --left-right --count "$base...$ref" 2>/dev/null)
  bb=$1; [ -n "$bb" ] || bb=0; ba=$2
fi
behind=$bb; ahead=$ba; [ -n "$ahead" ] || ahead=0
if [ -n "$up" ] && [ "$gone" = 0 ]; then
  set -- $(git -C "$p" rev-list --left-right --count "$up...$ref" 2>/dev/null)
  behind=$1; [ -n "$behind" ] || behind=0; ahead=$2; [ -n "$ahead" ] || ahead=0
fi
un=$(git -C "$p" rev-list --count "$ref" --not --remotes 2>/dev/null)
lc=$(git -C "$p" log -1 --format='%cI' "$ref" 2>/dev/null)
sub=$(git -C "$p" log -1 --pretty=%s "$ref" 2>/dev/null)
cr=$(git -C "$p" reflog show --format=%H "$ref" 2>/dev/null | tail -1)
short=$(printf %s "$h" | cut -c1-8)
# Every field is NUL-terminated; the free-text subject is last.
printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' \
  "$main" "$p" "$b" "$short" "$l" "$d" "$ahead" "$behind" "$ba" "$up" "$gone" "$un" "$base" "$lc" "$cr" "$sub"
STAT
chmod +x "$tmp/stat.sh"
if [ -n "$top" ]; then echo "$top" > "$tmp/repos"; printf '@single\\0'; else find_repos > "$tmp/repos"; fi
: > "$tmp/jobs"
while IFS= read -r r; do
  r=$(printf '%s' "$r" | sed 's:/*$::')
  if [ -d "$r/.git" ]; then c="$r/.git"; else c=$(git -C "$r" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue; fi
  [ -n "$(ls -A "$c/worktrees" 2>/dev/null)" ] || continue
  k=$(printf %s "$c" | cksum | cut -d' ' -f1)
  [ -e "$tmp/seen$k" ] && continue
  : > "$tmp/seen$k"
  base=$(git --git-dir="$c" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -z "$base" ]; then
    for x in main master develop; do
      if git --git-dir="$c" show-ref -q --verify "refs/remotes/origin/$x"; then base=origin/$x; break; fi
      if git --git-dir="$c" show-ref -q --verify "refs/heads/$x"; then base=$x; break; fi
    done
  fi
  git --git-dir="$c" worktree list --porcelain -z 2>/dev/null | awk -v base="$base" '
    BEGIN { RS = "\\0"; main = ""; p = ""; h = ""; b = ""; l = 0; pr = 0; first = 1 }
    {
      if ($0 ~ /^worktree /) {
        if (p != "" && !pr) { if (first) { main = p; first = 0 }; printf "%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0", main, p, h, b, l, base }
        p = substr($0, 10); h = ""; b = ""; l = 0; pr = 0
      } else if ($0 ~ /^HEAD /) h = substr($0, 6)
      else if ($0 ~ /^branch /) { b = substr($0, 8); sub(/^refs\\/heads\\//, "", b) }
      else if ($0 ~ /^locked/) l = 1
      else if ($0 ~ /^prunable/) pr = 1
    }
    END { if (p != "" && !pr) { if (first) main = p; printf "%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0", main, p, h, b, l, base } }' >> "$tmp/jobs"
done < "$tmp/repos"
if [ -s "$tmp/jobs" ]; then xargs -0 -n 6 sh "$tmp/stat.sh" < "$tmp/jobs"; fi`;
/** A number from the script's output; empty, "?" (git failed) and missing all give null. */
const num = (text) => (text === "" || text === "?" || text === undefined ? null : Number(text));

/** The script's output as `{ single, trees }`. A number that git could not give stays null. */
export function parseTrees(stdout) {
    const tree = (f) => {
        const [
            main,
            path,
            branch,
            head,
            locked,
            dirty,
            ahead,
            behind,
            baseAhead,
            upstream,
            gone,
            unpushed,
            base,
            date,
            created,
            subject,
        ] = f;
        return {
            main,
            path,
            branch,
            head,
            locked: locked === "1",
            dirty: num(dirty),
            ahead: num(ahead) ?? 0,
            behind: num(behind) ?? 0,
            baseAhead: num(baseAhead),
            upstream,
            gone: gone === "1",
            unpushed: num(unpushed),
            base,
            date: date || null,
            created: created || null,
            subject: subject ?? "",
        };
    };
    // The scan writes NUL-separated fields: paths and the free-text subject can contain tabs or newlines. The older
    // tab-separated form is still read for tests and for a cached result from an older panel.
    if (stdout.includes("\0")) {
        const fields = stdout.split("\0");
        let single = false;
        let at = 0;
        if ((fields[0] ?? "").trim() === "@single") {
            single = true;
            at = 1;
        }
        const trees = [];
        while (at + 15 < fields.length) {
            const f = fields.slice(at, at + 16);
            if (f[1]) trees.push(tree(f));
            at += 16;
        }
        return { single, trees };
    }
    const lines = stdout.split("\n").filter(Boolean);
    const trees = lines
        .filter((line) => line.startsWith("W\t"))
        .map((line) => {
            const f = line.split("\t").slice(1);
            return tree([...f.slice(0, 15), f.slice(15).join("\t")]);
        });
    return { single: lines[0] === "@single", trees };
}

/** Why removing a worktree would lose nothing, or null when it is not safe to say so.
 * Every one of these must hold: nobody is working there, it is not locked, it has no uncommitted change, no commit that
 * exists on no remote branch, and a base to compare with. Then it is ready when its work is already in the base, or
 * when its remote branch was deleted (what a merged pull request leaves). Anything git could not tell (a null) is not ready. */
export function readiness(tree, busy) {
    if (tree.path === tree.main || busy || tree.locked || tree.dirty !== 0 || !tree.base) return null;
    if (tree.unpushed === null) return null;
    const ownWork = Boolean(
        tree.created && /^[0-9a-f]{40}$/.test(tree.created) && tree.head && !tree.created.startsWith(tree.head),
    );

    if (tree.baseAhead === 0 && (ownWork || tree.gone)) return "in base";
    return tree.gone && tree.unpushed === 0 ? "upstream gone" : null;
}

export const REASON = { "in base": "merged into base", "upstream gone": "remote branch deleted" };

/** The folder name of a repository's main checkout. */
export const nameOf = (path) => path.replace(/\/+$/, "").split("/").pop();

/** A path below root; its last folder when it is not below it. */
export function relName(path, root) {
    const prefix = `${(root ?? "").replace(/\/+$/, "")}/`;
    return prefix !== "/" && path.startsWith(prefix) ? path.slice(prefix.length) : path.split("/").pop();
}

const AGE_UNITS = [
    ["y", 525600],
    ["d", 1440],
    ["h", 60],
    ["m", 1],
];

/** "now", "5m", "3h", "2d" or "1y": how long ago a timestamp was. */
export function since(iso, now = Date.now()) {
    const minutes = (now - Date.parse(iso)) / 60000;
    if (!(minutes >= 1)) return "now";
    const [unit, size] = AGE_UNITS.find(([, size]) => minutes >= size);
    return `${Math.floor(minutes / size)}${unit}`;
}

/** The chain of nodes from the layout's root down to the block that holds `mod`, or null when no block does. */
function chainTo(node, mod) {
    if (!node) return null;
    if (node.content?.mod === mod) return [node];
    for (const child of node.children ?? []) {
        const rest = chainTo(child, mod);
        if (rest) return [node, ...rest];
    }
    return null;
}

/** Whether a mod's block is on screen: nothing hidden on the way down, and every stack on the way showing the right child.
 * A mod that has no block lives in a pane or tab of its own, which counts as on screen. */
export function isOnScreen(root, mod) {
    const chain = chainTo(root, mod);
    if (!chain) return true;
    return chain.every((node, i) => {
        if (node.hidden) return false;
        if (node.type !== "stack") return true;
        return (node.active ?? node.children?.[0]?.id) === chain[i + 1]?.id;
    });
}

/** The worktrees the header's Prune merged (N) would remove: ready, and never the main checkout. */
export function pruneCandidates(rows) {
    return (rows ?? []).filter((tree) => tree.ready && tree.path !== tree.main);
}

/** The per-row action labels, so a narrow panel can put them in one menu and a test can keep them stable. */
export function rowActions(tree) {
    return [...(tree.open ? [] : ["Open"]), ...(tree.ready && tree.path !== tree.main ? ["Remove"] : [])];
}

/** Ignored paths a removal would delete, except build output that a checkout can regenerate. */
export function dangerousIgnored(output) {
    return (output ?? "")
        .split("\n")
        .filter((line) => line.startsWith("!! "))
        .map((line) => line.slice(3).trim())
        .filter((path) => {
            if (!path) return false;
            if (/(^|\/)\.env([.][^/]*)?$/.test(path)) return true;
            return !/^(node_modules|dist|build|target)\//.test(path);
        });
}

/** `git worktree list --porcelain -z`, as one entry per worktree: path, head, branch, locked. */
export function parseWorktreeListZ(stdout) {
    const entries = [];
    for (const block of (stdout ?? "").split("\0\0")) {
        if (!block.trim()) continue;
        const lines = block.split("\0");
        const entry = { path: "", head: "", branch: "", locked: false };
        for (const line of lines) {
            if (line.startsWith("worktree ")) entry.path = line.slice(9);
            else if (line.startsWith("HEAD ")) entry.head = line.slice(5);
            else if (line.startsWith("branch ")) entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
            else if (line === "locked" || line.startsWith("locked ")) entry.locked = true;
        }
        if (entry.path) entries.push(entry);
    }
    return entries;
}

/** Why a removal must be refused now, or null. It re-checks the live worktree list, not the cached row. */
export function removalRefusal(row, entries) {
    if (row.path === row.main) return "the main checkout is never removed";
    const live = entries.find((entry) => entry.path === row.path);
    if (!live) return "the worktree is gone";
    if (live.path === row.main) return "the main checkout is never removed";
    if (live.locked) return "the worktree is locked";
    if (live.branch !== (row.branch ?? "")) return "the branch changed";
    if (row.head && live.head && !live.head.startsWith(row.head)) return "the head changed";
    return null;
}

/** The Prune click: the list in order, or a refusal when the folder/machine changed after the banner opened. */
export function prunePlan(entries, contextKey, on) {
    const list = entries ?? [];
    if (list.length === 0) return { list: [] };
    if (list.some((entry) => entry.contextKey !== contextKey || entry.on !== on))
        return { refused: "The folder or machine changed; nothing was removed." };
    return { list };
}

/** Cancel closes the banner and runs nothing. */
export function cancelPrune() {
    return null;
}

/** The follow toggle: reload only after the choice is written. */
export function followReload(follow, spaceId, write, reload) {
    write(spaceId, !follow);
    reload();
    return !follow;
}

/** A watchdog: after `after` ms, run `timeout` unless `done()` was called. The clock is injected for tests. */
export function watchdog(after, timeout) {
    let done = false;
    after(() => {
        if (!done) timeout();
    });
    return () => {
        done = true;
    };
}

/** Whether `cwd` is `path` or below it, after resolving symlinks with the supplied canonicaliser. */
export function sameOrInside(path, cwd, canonical = (p) => p) {
    if (!path || !cwd) return false;
    const target = canonical(path).replace(/\/+$/, "");
    const here = canonical(cwd);
    return here === target || here.startsWith(`${target}/`);
}

/** A terminal cwd inside a worktree, after canonicalising both sides. */
export function terminalInside(realTree, cwds, canonical = (p) => p) {
    return (cwds ?? []).some((cwd) => Boolean(cwd) && sameOrInside(realTree, cwd, canonical));
}

/** Resolve each path with `pwd -P` through the injected exec; a failure keeps the original path. */
export async function canonicalPaths(exec, paths) {
    const out = {};
    await Promise.all(
        [...new Set(paths.filter(Boolean))].map(async (path) => {
            const result = await exec("sh", ["-c", 'cd "$1" && pwd -P', "sh", path]);
            out[path] = result.code === 0 ? (result.stdout ?? "").trim() || path : path;
        }),
    );
    return out;
}

/** True when any pane cwd really lies inside the worktree, after canonicalising both. */
export async function terminalsInsideWorktree(exec, tree, cwds) {
    const wanted = [tree, ...cwds.filter(Boolean)];
    const map = await canonicalPaths(exec, wanted);
    for (const cwd of cwds.filter(Boolean)) {
        const result = await exec("sh", ["-c", 'cd "$1" && pwd -P', "sh", cwd]);
        if (result.code !== 0) return true;
    }
    return terminalInside(
        map[tree],
        cwds.map((cwd) => map[cwd]),
    );
}

/** A stale load may not write: only the current generation wins. */
export const currentGeneration = (started, current) => started === current;

/** The live removal gate: the same readiness decision as the row, from freshly read facts. */
export function liveReady(row, facts) {
    return readiness({ ...row, ...facts }, false);
}

/** The Prune chain: entries in order, stopping at a stale context, calling remove for each. */
export async function pruneAll(entries, contextKey, on, remove) {
    const key = typeof contextKey === "function" ? contextKey : () => contextKey;
    const machine = typeof on === "function" ? on : () => on;
    const plan = prunePlan(entries, key(), machine());
    if (plan.refused) return { refused: plan.refused, removed: 0 };
    let removed = 0;
    for (const entry of plan.list) {
        if (entry.contextKey !== key() || entry.on !== machine())
            return { refused: "The folder or machine changed; the rest were not removed.", removed };
        const problem = await remove(entry.tree, entry);
        if (problem) return { refused: problem, removed };
        removed++;
    }
    return { removed };
}
