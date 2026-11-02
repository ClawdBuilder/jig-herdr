// Pure helpers of the PR & CI panel. They live apart from main.js so the tests can load them outside Herdr.

// Run with `sh -c SCRIPT sh <root>` on the space's machine, once per load. It reads local git config only: no fetch,
// no network. Output: an optional first line "@single" (root is inside one repository, so only that one is listed),
// then one tab-separated line per repository: path, branch, remote url, origin's default branch.
// With no repository around root, the repositories are the folders that hold a `.git` (a folder in a clone, a file in a
// linked worktree), up to three levels down, so `worktrees/<ticket>/<repo>` is found too. The search does not go into a
// repository and skips `node_modules`. Eight repositories are read at a time.
// (This is a JS template string: the only dollar-brace in it is escaped.)
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
describe() {
  branch=$(git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null || echo "(detached)")
  remote=$(git -C "$1" config --get remote.origin.url 2>/dev/null)
  [ -n "$remote" ] || remote=$(git -C "$1" config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | head -n1 | cut -d' ' -f2)
  default=$(git -C "$1" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$branch" "$remote" "$default"
}
work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
if [ -n "$top" ]; then echo "$top" > "$work/list"; echo "@single"; else find_repos > "$work/list"; fi
count=0
while IFS= read -r repo; do
  repo=\${repo%/}
  describe "$repo" > "$work/$count.out" &
  count=$((count + 1))
  [ $((count % 8)) -eq 0 ] && wait
done < "$work/list"
wait
i=0
while [ $i -lt $count ]; do cat "$work/$i.out"; i=$((i + 1)); done`;

/** "owner/repo" from a remote url, whatever its form: https, scp-style with a host alias, or ssh://. Null when there is none. */
export function slugOf(url) {
    const match = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/*$/.exec((url ?? "").trim());
    return match ? `${match[1]}/${match[2]}` : null;
}

const TRUNKS = new Set(["main", "master", "develop"]);

/** The script's output as `{ single, repos: [{ path, branch, remote, slug, onDefault }] }`. */
export function parseRepos(stdout) {
    const lines = stdout.split("\n").filter(Boolean);
    const repos = lines
        .filter((line) => !line.startsWith("@"))
        .map((line) => {
            const [path, branch, remote = "", originHead = ""] = line.split("\t");
            const onDefault = TRUNKS.has(branch) || branch === originHead;
            return { path, branch, remote, slug: slugOf(remote), onDefault };
        });
    return { single: lines[0] === "@single", repos };
}

/** A repository's path below root; its own folder name when it is not below it. */
export function relName(path, root) {
    const prefix = `${root.replace(/\/+$/, "")}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path.split("/").pop();
}

const AGE_UNITS = [
    ["d", 1440],
    ["h", 60],
    ["m", 1],
];

/** "now", "5m", "3h" or "2d": how long ago a timestamp was. */
export function since(iso, now = Date.now()) {
    const minutes = (now - Date.parse(iso)) / 60000;
    if (!(minutes >= 1)) return "now";
    const [unit, size] = AGE_UNITS.find(([, size]) => minutes >= size);
    return `${Math.floor(minutes / size)}${unit}`;
}

/** What a check's result means for the person: failed, still going, passed or not worth a look. A cancelled run is
 * usually one that a newer push replaced, so it counts with the skipped rather than as a failure. */
const BUCKET_OF = {
    FAILURE: "fail",
    ERROR: "fail",
    TIMED_OUT: "fail",
    ACTION_REQUIRED: "fail",
    STARTUP_FAILURE: "fail",
    NEUTRAL: "skip",
    SKIPPED: "skip",
    STALE: "skip",
    CANCELLED: "skip",
    SUCCESS: "pass",
};
export const bucketOf = (result) => BUCKET_OF[result] ?? "pending";
/** The order checks are listed in. */
export const BUCKETS = ["fail", "pending", "pass", "skip"];

/** The checks of a `statusCheckRollup` (check runs and commit statuses alike) as `{ name, bucket, url }`, failures first. */
export function checksOf(rollup) {
    const checks = (rollup ?? []).map((entry) => ({
        name:
            entry.workflowName && entry.name
                ? `${entry.workflowName} / ${entry.name}`
                : entry.name || entry.context || "check",
        bucket: bucketOf(entry.conclusion || entry.state || ""),
        url: entry.detailsUrl || entry.targetUrl || null,
    }));
    return checks.sort((a, b) => BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));
}

/** How many of a pull request's checks are in a bucket. */
export const countOf = (pr, bucket) => (pr?.checks ?? []).filter((check) => check.bucket === bucket).length;

/** A pull request from `gh` json in the small shape the panel keeps and caches. `checks` stays null until the rollup is
 * known, since `gh search` does not return it. */
export function shapePr(raw, slug) {
    return {
        n: raw.number,
        title: raw.title,
        url: raw.url,
        draft: Boolean(raw.isDraft),
        state: raw.state ?? "OPEN",
        review: raw.reviewDecision ?? "",
        branch: raw.headRefName ?? "",
        updated: raw.updatedAt ?? null,
        author: raw.author?.login ?? null,
        slug: slug ?? raw.repository?.nameWithOwner ?? null,
        checks: Array.isArray(raw.statusCheckRollup) ? checksOf(raw.statusCheckRollup) : null,
    };
}

export const REVIEW = {
    APPROVED: "Approved",
    CHANGES_REQUESTED: "Changes requested",
    REVIEW_REQUIRED: "Review required",
};

/** What `gh` said when it failed, as one line. Sign-in and network problems are flagged so the panel stops asking. */
export function ghError(stderr) {
    const text = (stderr ?? "").trim();
    const first = text.split("\n").find(Boolean) ?? "gh failed";
    if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(text))
        return { auth: true, message: "gh is not logged in on this machine (run gh auth login)." };
    if (/rate limit/i.test(text)) return { net: true, message: "GitHub rate limit reached; try again later." };
    if (
        /could not resolve host|dial tcp|timed out|timeout|network is unreachable|connection (refused|reset)|TLS handshake/i.test(
            text,
        )
    )
        return { net: true, message: `Network error: ${first}` };
    return { message: first };
}

/** Runs `task` over `items`, no more than `limit` at a time. */
export async function inParallel(items, limit, task) {
    let next = 0;
    const lane = async () => {
        while (next < items.length) await task(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Puts `value` in the cache under `key` and drops all but the `keep` newest entries. Returns the cache. */
export function remember(cache, key, value, keep = 12) {
    cache[key] = { at: Date.now(), data: value };
    const newest = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    for (const old of newest.slice(keep)) delete cache[old];
    return cache;
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
