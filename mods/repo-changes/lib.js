// Pure helpers of the Changes panel. They live apart from main.js so the tests can load them outside Herdr.

// Most changed files listed per repo; the rest become "+N more".
export const CAP = 200;

// Run with `sh -c SCRIPT sh <root>` on the space's machine, once per refresh.
// Output, per repo: a line "@@repo <absolute path>", then `git status --porcelain=v1 -b`
// (branch line, then one line per changed file, at most CAP), then "=<changed file count>".
// If root is inside a git repo, only that repo is listed. Otherwise the repos are the folders
// with a .git (a folder for a clone, a file for a worktree) up to three levels down, so
// worktrees/<ticket>/<repo> is found too. Looking stops at a repo and skips node_modules.
// No fetch and no network: each repo is read from its own disk, up to 8 at a time.
// (No dollar-brace in here: this is a JS template string.)
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
scan() {
  git -C "$1" --no-optional-locks -c core.fsmonitor=false -c core.quotePath=false status --porcelain=v1 -b --no-renames 2>&1 \\
    | awk -v cap=${CAP} 'NR <= cap + 1 { print } END { print "=" (NR > 0 ? NR - 1 : 0) }'
}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
if [ -n "$top" ]; then echo "$top" > "$tmp/list"; else find_repos > "$tmp/list"; fi
n=0
while IFS= read -r repo; do
  repo=\${repo%/}
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

// One changed file: the letter to show, and whether it is untracked.
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
    return { status, fresh, path: unquote(line.slice(3)) };
}

// The script's output as repos: { path, name, branch, ahead, behind, files, total, error }.
// `name` is the path below root (the repo's own folder name when it is root or above it).
export function parseRepos(stdout, root) {
    const base = root.replace(/\/+$/, "");
    return stdout
        .split("@@repo ")
        .slice(1)
        .map((block) => {
            const [first, ...lines] = block.split("\n");
            const path = first.trim(),
                name = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path.split("/").pop();
            const repo = {
                path,
                name,
                branch: "?",
                ahead: 0,
                behind: 0,
                unborn: false,
                files: [],
                total: 0,
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
            return repo;
        });
}

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

// A file path as its folders (dimmed) and its name.
export function splitPath(path) {
    const parts = path.split("/"),
        name = parts.pop();
    return { dir: parts.length ? `${parts.join("/")}/` : "", name };
}
