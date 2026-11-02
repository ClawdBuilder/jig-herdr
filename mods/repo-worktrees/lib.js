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
us=$(printf '\\037')
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
stat() {
  main=$1; p=$2; h=$3; b=$4; l=$5; base=$6
  [ -d "$p" ] || return
  ref=\${b:-$h}
  if out=$(git -C "$p" --no-optional-locks -c core.fsmonitor=false status --porcelain 2>/dev/null); then
    d=$(printf '%s' "$out" | awk 'NF { n++ } END { print n + 0 }')
  else d='?'; fi
  up=; tr=
  if [ -n "$b" ]; then
    info=$(git -C "$p" for-each-ref --format='%(upstream:short)|%(upstream:track,nobracket)' "refs/heads/$b" 2>/dev/null)
    up=\${info%%|*}; tr=\${info#*|}
  fi
  gone=0; [ "$tr" = gone ] && gone=1
  ba=; bb=0
  if [ -n "$base" ]; then
    set -- $(git -C "$p" rev-list --left-right --count "$base...$ref" 2>/dev/null); bb=\${1:-0}; ba=\${2:-}
  fi
  behind=$bb; ahead=\${ba:-0}
  if [ -n "$up" ] && [ "$gone" = 0 ]; then
    set -- $(git -C "$p" rev-list --left-right --count "$up...$ref" 2>/dev/null); behind=\${1:-0}; ahead=\${2:-0}
  fi
  un=$(git -C "$p" rev-list --count "$ref" --not --remotes 2>/dev/null)
  lc=$(git -C "$p" log -1 --format='%cI%x09%s' "$ref" 2>/dev/null)
  printf 'W\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$main" "$p" "$b" "$(printf %s "$h" | cut -c1-8)" "$l" "$d" "$ahead" "$behind" "$ba" "$up" "$gone" "$un" "$base" "$lc"
}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
if [ -n "$top" ]; then echo "$top" > "$tmp/repos"; echo "@single"; else find_repos > "$tmp/repos"; fi
: > "$tmp/jobs"
while IFS= read -r r; do
  r=\${r%/}
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
  git --git-dir="$c" worktree list --porcelain 2>/dev/null | awk -v base="$base" 'BEGIN { RS = ""; FS = "\\n"; OFS = "\\037" }
    { p = ""; h = ""; b = ""; l = 0; pr = 0
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^worktree /) p = substr($i, 10)
        else if ($i ~ /^HEAD /) h = substr($i, 6)
        else if ($i ~ /^branch /) { b = substr($i, 8); sub(/^refs\\/heads\\//, "", b) }
        else if ($i ~ /^locked/) l = 1
        else if ($i ~ /^prunable/) pr = 1
      }
      if (NR == 1) main = p
      else if (!pr) print main, p, h, b, l, base }' >> "$tmp/jobs"
done < "$tmp/repos"
n=0
while IFS="$us" read -r main p h b l base; do
  stat "$main" "$p" "$h" "$b" "$l" "$base" > "$tmp/$n.out" &
  n=$((n + 1))
  [ $((n % 8)) -eq 0 ] && wait
done < "$tmp/jobs"
wait
i=0
while [ $i -lt $n ]; do cat "$tmp/$i.out"; i=$((i + 1)); done`;

/** A number from the script's output; empty, "?" (git failed) and missing all give null. */
const num = (text) => (text === "" || text === "?" || text === undefined ? null : Number(text));

/** The script's output as `{ single, trees }`. A number that git could not give stays null. */
export function parseTrees(stdout) {
    const lines = stdout.split("\n").filter(Boolean);
    const trees = lines
        .filter((line) => line.startsWith("W\t"))
        .map((line) => {
            const [
                ,
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
                ...subject
            ] = line.split("\t");
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
                subject: subject.join("\t"),
            };
        });
    return { single: lines[0] === "@single", trees };
}

/** Why removing a worktree would lose nothing, or null when it is not safe to say so.
 * Every one of these must hold: nobody is working there, it is not locked, it has no uncommitted change, no commit that
 * exists on no remote branch, and a base to compare with. Then it is ready when its work is already in the base, or
 * when its remote branch was deleted (what a merged pull request leaves). Anything git could not tell (a null) is not ready. */
export function readiness(tree, busy) {
    if (busy || tree.locked || tree.dirty !== 0 || tree.unpushed !== 0 || !tree.base) return null;
    if (tree.baseAhead === 0) return "in base";
    return tree.gone ? "upstream gone" : null;
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
