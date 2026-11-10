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

/** Split workspace repositories: PR/error/loading stay in the list, "no PR" and default/remote-less get folded groups. */
export function workspaceSplit(repos) {
    return {
        featured: (repos ?? []).filter((repo) => ["pr", "error", "loading"].includes(repo.status)),
        noPr: (repos ?? []).filter((repo) => repo.status === "nopr"),
        parked: (repos ?? []).filter(
            (repo) => repo.status === "default" || repo.status === "noremote" || repo.status === "notgithub",
        ),
    };
}

/** The PR list groups: a PR with a failure needs fixing; pending or unapproved waits; green+approved is ready. */
export function prGroups(repos) {
    const groups = { needs: [], waiting: [], ready: [], noPr: [], parked: [] };
    for (const repo of repos ?? []) {
        if (repo.status === "nopr") groups.noPr.push(repo);
        else if (repo.status === "default" || repo.status === "noremote" || repo.status === "notgithub")
            groups.parked.push(repo);
        else if (repo.status === "error" || countOf(repo.pr, "fail") || repo.pr?.review === "CHANGES_REQUESTED")
            groups.needs.push(repo);
        else if (repo.status === "loading" || countOf(repo.pr, "pending") || repo.pr?.review !== "APPROVED")
            groups.waiting.push(repo);
        else groups.ready.push(repo);
    }
    return groups;
}

/** Hosts known not to be GitHub. Everything else is asked, including GitHub Enterprise and scp aliases. */
const NOT_GITHUB = new Set([
    "gitlab.com",
    "bitbucket.org",
    "dev.azure.com",
    "ssh.dev.azure.com",
    "vs-ssh.visualstudio.com",
]);

const cleanSlug = (value) => value.replace(/\.git$/, "").replace(/\/+$/, "");

/** "owner/repo" from a GitHub remote URL or scp alias. A local path, or a known non-GitHub host, has no slug. */
export function slugOf(url) {
    const said = String(url ?? "").trim();
    if (!said) return null;
    if (/^(?:file:|\/|\.\.?[\\/]|~[\\/]|[A-Za-z]:[\\/]|\\\\)/i.test(said)) return null;
    let host;
    let pathname;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(said)) {
        let parsed;
        try {
            parsed = new URL(said);
        } catch {
            return null;
        }
        if (parsed.protocol === "file:") return null;
        host = parsed.hostname.toLowerCase();
        pathname = parsed.pathname;
    } else {
        const scp = /^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/.exec(said);
        if (!scp) return null; // a bare relative path, such as origins/billing-web.git
        host = scp[1].toLowerCase();
        pathname = scp[2];
    }
    if (NOT_GITHUB.has(host)) return null;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return cleanSlug(`${parts[0]}/${parts[1]}`);
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
        mergeable: raw.mergeable ?? null,
        slug: slug ?? raw.repository?.nameWithOwner ?? null,
        checks: Array.isArray(raw.statusCheckRollup) ? checksOf(raw.statusCheckRollup) : null,
        additions: Number(raw.additions) || 0,
        deletions: Number(raw.deletions) || 0,
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
    if (/could not resolve to a repository/i.test(text)) return { notgithub: true, message: "not on GitHub" };
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

/** The current branch's latest CI runs from `gh run list --json`. */
export function shapeRuns(raw) {
    return (raw ?? []).map((run) => ({
        name: run.workflowName || run.name || "CI",
        status: run.status ?? "",
        conclusion: run.conclusion ?? "",
        url: run.url ?? null,
        at: run.createdAt ?? run.updatedAt ?? null,
    }));
}

/** The latest runs reply for a branch with no PR: shaped, or null when gh failed. */
export function branchRuns(reply) {
    return reply?.data ? shapeRuns(reply.data) : null;
}

/** "1 check", "3 checks". */
export const checkCount = (n) => `${n} check${n === 1 ? "" : "s"}`;

/** What a check list holds, in the order that matters: "3 failing, 1 pending, 2 passed". */
export function checkSummary(checks) {
    const order = [
        ["fail", "failing"],
        ["pending", "pending"],
        ["pass", "passed"],
        ["skip", "skipped"],
    ];
    return order
        .map(([bucket, word]) => [checks.filter((c) => c.bucket === bucket).length, word])
        .filter(([n]) => n > 0)
        .map(([n, word]) => `${n} ${word}`)
        .join(", ");
}

/** Loads a branch's latest runs through a caller-supplied `gh`, with the exact argv the live panel uses. */
export async function loadRuns(ghImpl, slug, branch, on) {
    const reply = await ghImpl(
        [
            "run",
            "list",
            "--repo",
            slug,
            "--branch",
            branch,
            "--limit",
            "5",
            "--json",
            "workflowName,status,conclusion,url,createdAt",
        ],
        on,
    );
    return { runs: reply.data ? shapeRuns(reply.data) : null, error: reply.data ? null : (reply.err ?? "gh failed") };
}

/** Only GitHub links may reach the browser. */
export const githubUrl = (url) => (/^https:\/\/github\.com\//.test(url ?? "") ? url : null);

/** Run timeout after the given scheduler unless the returned cancel is called first. */
export function watchdog(after, timeout) {
    let done = false;
    after(() => {
        if (!done) timeout();
    });
    return () => {
        done = true;
    };
}

/** A stale load may not write: only the current generation wins. */
export const currentGeneration = (started, current) => started === current;
