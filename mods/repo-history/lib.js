// Pure helpers of the History panel. They live apart from main.js so the tests can load them outside Herdr.

// Run with `sh -c SCRIPT sh <root>` on the space's machine. Read-only: git reads, no fetch.
// Output: an optional first line "@single" (root is inside one git repo: only that repo is listed), then one
// line per repo: path, kind (m = a clone, w = a linked worktree), branch, uncommitted (0 or 1), separated by tabs.
// Without a repo around root, the repos are the folders with a .git (a folder for a clone, a file for a worktree)
// up to three levels down, so worktrees/<ticket>/<repo> is found too. Looking stops at a repo and skips
// node_modules. Up to 8 repos are read at a time.
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

/** The script's output as `{ single, repos: [{ path, linked, branch, dirty }] }`, clones before linked worktrees. */
export function parseRepos(stdout) {
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

/** A repository's path below root; its last folder when it is not below it (or there is no root). */
export function relName(path, root) {
    const prefix = `${(root ?? "").replace(/\/+$/, "")}/`;
    return prefix !== "/" && path.startsWith(prefix) ? path.slice(prefix.length) : path.split("/").pop();
}

/** The repository that holds a path: the deepest one whose path is the path itself or a parent of it. */
export function repoOf(repos, path) {
    if (!path) return null;
    const holders = repos.filter((repo) => path === repo.path || path.startsWith(`${repo.path}/`));
    return holders.reduce(
        (deepest, repo) => (!deepest || repo.path.length > deepest.path.length ? repo : deepest),
        null,
    );
}

/** What `git log` is asked to print for each commit, fields split by the unit separator \x1f. */
export const FORMAT = ["%H", "%P", "%an", "%aI", "%D", "%s"].join("%x1f");

/** One decoration of `git log --decorate=full`, as `{ name, kind }`: kind is local, remote or tag. The full ref names are
 * what tell a local branch called `a/b` from the remote branch `a`'s `b`. */
export function readRef(text) {
    const bare = text.startsWith("HEAD -> ") ? text.slice("HEAD -> ".length) : text;
    if (bare.startsWith("refs/heads/")) return { name: bare.slice("refs/heads/".length), kind: "local" };
    if (text.startsWith("refs/remotes/")) return { name: text.slice("refs/remotes/".length), kind: "remote" };
    if (text.startsWith("tag: refs/tags/")) return { name: text.slice("tag: refs/tags/".length), kind: "tag" };
    return null;
}

/** The output of `git log --decorate=full --format=FORMAT`, one commit per line. A subject that holds the separator keeps it. */
export function parseLog(stdout) {
    const commits = [];
    for (const line of stdout.split("\n")) {
        if (!line) continue;
        const [hash, parents, author, date, decorations = "", ...subject] = line.split("\x1f");
        commits.push({
            hash,
            author,
            date,
            subject: subject.join("\x1f"),
            parents: parents ? parents.split(" ") : [],
            refs: decorations ? decorations.split(", ").map(readRef).filter(Boolean) : [],
            head: decorations === "HEAD" || decorations.startsWith("HEAD -> "),
        });
    }
    return commits;
}

/** Puts commits (newest first) on lanes, like `git log --graph` but as data. A lane is a line that waits for the commit it
 * leads to; it keeps one colour from where it starts to where it ends. Each row says:
 *   lane, color   where the commit sits
 *   top           lanes drawn in the upper half (the ones that lead into this commit, and the ones passing by)
 *   ins           lanes that end in this commit from the side, because it is a parent of several children
 *   bottom        lanes drawn in the lower half
 *   outs          lanes that this merge commit starts for its other parents, drawn as curves to the side
 *   width         how many lanes the row needs */
export function layoutGraph(commits) {
    // tracks[i] is the lane at position i: the commit it waits for and its colour, or null when the position is free.
    const tracks = [];
    let colours = 0;
    const freePosition = () => {
        const free = tracks.indexOf(null);
        return free === -1 ? tracks.length : free;
    };
    const describe = (list, skip = new Set()) =>
        list.flatMap((track, lane) => (track && !skip.has(lane) ? [{ lane, color: track.color }] : []));

    return commits.map((commit) => {
        const waiting = [];
        tracks.forEach((track, lane) => {
            if (track?.hash === commit.hash) waiting.push(lane);
        });
        const lane = waiting.length > 0 ? waiting[0] : freePosition();
        const color = waiting.length > 0 ? tracks[lane].color : colours++;
        const joining = new Set(waiting.slice(1));
        const ins = [...joining].map((at) => ({ lane: at, color: tracks[at].color }));
        const top = describe(tracks, joining);

        for (const at of joining) tracks[at] = null;
        tracks[lane] = commit.parents[0] ? { hash: commit.parents[0], color } : null;

        const outs = [];
        const started = new Set();
        for (const parent of commit.parents.slice(1)) {
            let at = tracks.findIndex((track) => track?.hash === parent);
            if (at === -1) {
                at = freePosition();
                tracks[at] = { hash: parent, color: colours++ };
                started.add(at);
            }
            outs.push({ lane: at, color: tracks[at].color });
        }
        while (tracks.length > 0 && tracks[tracks.length - 1] === null) tracks.pop();

        const bottom = describe(tracks, started);
        const used = [lane, ...[...top, ...ins, ...bottom, ...outs].map((entry) => entry.lane)];
        return { lane, color, top, ins, bottom, outs, width: Math.max(...used) + 1 };
    });
}

/** What a subject line says: a conventional-commit type, scope and `!`, a pull request number, and the text.
 * "feat(api)!: add x" gives type, scope and breaking; "Merge pull request #12 from o/b" and "fix: y (#12)" give pr. */
export function readSubject(subject) {
    const merge = /^Merge pull request #(\d+) from (\S+)/.exec(subject);
    if (merge) return { pr: Number(merge[1]), text: merge[2].split("/").slice(1).join("/") || merge[2] };
    const squashed = /\(#(\d+)\)\s*$/.exec(subject);
    const pr = squashed ? Number(squashed[1]) : undefined;
    const typed = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<text>.+)$/.exec(subject);
    if (!typed) return { text: subject, pr };
    const { type, scope, bang, text } = typed.groups;
    return { type, scope: scope ?? null, breaking: bang === "!", text, pr };
}

/** Up to two letters for an avatar: the first letters of the first and last word of a name. */
export function initialsOf(name) {
    const words = (name ?? "").split(/[\s._-]+/).filter(Boolean);
    if (words.length === 0) return "?";
    const last = words.length > 1 ? words[words.length - 1][0] : "";
    return (words[0][0] + last).toUpperCase();
}

/** A number that depends only on the text (FNV-1a), so the same author always gets the same colour. */
export function colourSeed(text) {
    let hash = 2166136261;
    for (const ch of text ?? "") hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
    return hash;
}

/** The output of `git show --numstat --format=%B%x1e <commit>`: the message, a record separator, then
 * "added<TAB>removed<TAB>path" per file, with "-" for a binary one. Returns the message body (without its first line) and the files. */
export function parseCommitDetail(stdout) {
    const cut = stdout.indexOf("\x1e");
    const message = cut === -1 ? stdout : stdout.slice(0, cut);
    const stat = cut === -1 ? "" : stdout.slice(cut + 1);
    const files = [];
    for (const line of stat.split("\n")) {
        if (!line) continue;
        const [added, removed, ...path] = line.split("\t");
        files.push({
            path: path.join("\t"),
            add: added === "-" ? null : Number(added),
            del: removed === "-" ? null : Number(removed),
        });
    }
    const [, ...rest] = message.trim().split("\n");
    return { body: rest.join("\n").trim(), files };
}

/** Whether a commit shows under a filter: the text is in its subject, author, hash or one of its branch and tag names. */
export function commitMatches(commit, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [commit.subject, commit.author, commit.hash, ...commit.refs.map((ref) => ref.name)].some((field) =>
        field.toLowerCase().includes(needle),
    );
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
