import { parseRefreshConfig } from "./refresh.js";

// Pure helpers of jig-work, kept apart from main.js so they can be tested outside Herdr.

export {
    addressOf,
    changedSince,
    MTIMES,
    mergeSessions,
    parseMtimes,
    parseSessions,
    pickSession,
    READ,
    SCRIPT,
    shownAgain,
    terminalStateChanged,
} from "./sessions.js";

// Run with `sh -c REPO_SCRIPT sh <path>...`: for each path, a line "path<TAB>repository root<TAB>git status letters".
// The root is empty outside a repository, the letters empty for a file without changes. Reads only, no locks.
export const REPO_SCRIPT = `for f in "$@"; do
  top=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$top" ]; then printf '%s\\t\\t\\n' "$f"; continue; fi
  st=$(git -C "$top" --no-optional-locks -c core.fsmonitor=false status --porcelain -- "$f" 2>/dev/null | head -n 1 | cut -c1-2)
  printf '%s\\t%s\\t%s\\n' "$f" "$top" "$st"
done`;

export const DEFAULTS = { machine: null, stateDir: null, prOwners: [], refreshSeconds: 60 };

// config.json as { machine, stateDir, prOwners, refreshSeconds, problems }. Anything missing or of the wrong kind takes
// its default.
export function parseConfig(text) {
    const config = { ...DEFAULTS, prOwners: [], problems: [] };
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
    for (const key of ["machine", "stateDir"]) {
        if (raw[key] == null) continue;
        if (typeof raw[key] === "string" && raw[key].trim() !== "") config[key] = raw[key].trim();
        else config.problems.push(`"${key}" must be a non-empty string or null`);
    }
    const refresh = parseRefreshConfig(raw, DEFAULTS.refreshSeconds);
    config.refreshSeconds = refresh.seconds;
    config.problems.push(...refresh.problems);
    if (raw.prOwners != null) {
        const ok =
            Array.isArray(raw.prOwners) && raw.prOwners.every((o) => typeof o === "string" && /^[\w.-]+$/.test(o));
        if (ok) config.prOwners = raw.prOwners;
        else config.problems.push('"prOwners" must be a list of GitHub owners, such as ["acme"]');
    }
    return config;
}

// The script's output as [{ file, alive, status }]; a file that is not a status of schema 1 is left out.

// The address Herdr gives the session's terminal: "t7" here, "<machine>/t7" on another machine. Only a terminal named by
// herdr-core (`terminalFrom` HC_TERMINAL_ID) has one; a tmux pane inside it does not.

const updated = (s) => Date.parse(s.status.updatedAt ?? "") || 0;

// The session to show: the one whose terminal is focused (or is the agent shown), else the one picked before while it
// lives, else the one updated last. `live` sessions only; returns { session, by } with by "focus", "picked" or "recent".

// The stages as a progress line: [{ id, goal, state: "done" | "current" | "todo" }]. A current stage the workflow does not
// list is added at the end, so the line always shows where the work is.
export function stageLine(workflow) {
    if (!workflow) return [];
    const stages = Array.isArray(workflow.stages) ? workflow.stages : [];
    const at = stages.findIndex((s) => s.id === workflow.current);
    const line = stages.map((s, i) => ({
        id: s.id,
        goal: s.goal ?? null,
        state: at < 0 ? "todo" : i < at ? "done" : i === at ? "current" : "todo",
    }));
    if (at < 0 && workflow.current) line.push({ id: workflow.current, goal: null, state: "current" });
    return line;
}

// gh's search for a ticket's pull requests: in the owners config.json names, else the ones that involve you (a search of
// all of GitHub would find strangers' pull requests that name the same key).
export function searchArgs(key, owners, fields) {
    const scope = owners?.length ? owners.flatMap((o) => ["--owner", o]) : ["--involves=@me"];
    return ["search", "prs", key, ...scope, "--json", fields, "--limit", "10"];
}

// "owner/repo" from a pull request's address.
export function slugOf(url) {
    const m = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url ?? "");
    return m ? `${m[1]}/${m[2]}` : null;
}

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SKIP = new Set(["NEUTRAL", "SKIPPED", "STALE", "CANCELLED"]);

// gh's statusCheckRollup as counts, and the names of the failing checks with their links.
export function rollup(list) {
    const out = { pass: 0, fail: 0, pending: 0, total: 0, failing: [] };
    for (const c of list ?? []) {
        const result = c.conclusion || c.state || ""; // a check run has a conclusion, a commit status a state
        out.total++;
        if (FAIL.has(result)) {
            out.fail++;
            const name = c.workflowName && c.name ? `${c.workflowName} / ${c.name}` : c.name || c.context || "check";
            out.failing.push({ name, url: c.detailsUrl || c.targetUrl || null });
        } else if (result === "SUCCESS") out.pass++;
        else if (!SKIP.has(result)) out.pending++;
    }
    return out;
}

export const REVIEW = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "changes requested",
    REVIEW_REQUIRED: "review required",
};

// The pull requests to show, one per address: the workflow's readings, laid under what gh said (`details` by url), and the
// ones gh's search found when the workflow has none. Failing ones first, then open ones, then by number.
export function prRows(workflowPrs, searched, details) {
    const byUrl = new Map();
    for (const pr of workflowPrs ?? []) {
        if (!pr.url) continue;
        byUrl.set(pr.url, {
            url: pr.url,
            number: pr.number ?? null,
            title: null,
            repo: slugOf(pr.url) ?? (pr.repo ?? "").split("/").pop(),
            state: pr.state ?? "OPEN",
            draft: pr.draft === true,
            review: null,
            checks: pr.checks ? { ...pr.checks, failing: [] } : null,
        });
    }
    if (byUrl.size === 0) {
        for (const pr of searched ?? []) {
            if (!pr.url) continue;
            byUrl.set(pr.url, {
                url: pr.url,
                number: pr.number ?? null,
                title: pr.title ?? null,
                repo: pr.repository?.nameWithOwner ?? slugOf(pr.url),
                state: pr.state ?? "OPEN",
                draft: pr.isDraft === true,
                review: null,
                checks: null,
            });
        }
    }
    for (const [url, row] of byUrl) {
        const d = details?.[url];
        if (!d) continue;
        if (d.title) row.title = d.title;
        if (d.state) row.state = d.state;
        if (typeof d.isDraft === "boolean") row.draft = d.isDraft;
        if (d.reviewDecision) row.review = d.reviewDecision;
        if (Array.isArray(d.statusCheckRollup)) row.checks = rollup(d.statusCheckRollup);
    }
    const open = (r) => (String(r.state).toUpperCase() === "OPEN" ? 0 : 1);
    const failing = (r) => (r.checks?.fail > 0 ? 0 : 1);
    return [...byUrl.values()].sort(
        (a, b) => failing(a) - failing(b) || open(a) - open(b) || (b.number ?? 0) - (a.number ?? 0),
    );
}

// REPO_SCRIPT's output as a map of path to { repo, status }.
export function parseRepoInfo(stdout) {
    const info = {};
    for (const line of stdout.split("\n")) {
        if (!line) continue;
        const [file, repo = "", status = ""] = line.split("\t");
        info[file] = { repo: repo || null, status: status.trim() };
    }
    return info;
}

// The status file's outputs split for the Outputs list: `files` are the ones outside any git repository (`repo` null), and
// those of an older status file that has no `repo` field at all, which keep showing as before; `inRepos` counts the ones in a
// repository, which belong to the Git panel.

/** The ticket's workflow as one compact chip at narrow widths: "build · 3 of 5", with every stage and goal in `title`. */
export function stageSummary(workflow, line = stageLine(workflow)) {
    if (!workflow || line.length === 0) return null;
    const at = line.findIndex((s) => s.state === "current"),
        current = line[at]?.id ?? workflow.current;
    if (!current) return null;
    const title = line
        .map(
            (s) =>
                `${s.state === "done" ? "✓ " : s.state === "current" ? "▸ " : "  "}${s.id}${s.goal ? ` — ${s.goal}` : ""}`,
        )
        .join("\n");
    return { text: `${current} · ${at + 1} of ${line.length}`, title };
}

/** The folder shown beside an Output: the last two segments of its parent (a full path would repeat and truncate). */
export function shortFolder(dir) {
    const parts = String(dir ?? "")
        .split(/[\\/]+/)
        .filter(Boolean);
    return parts.slice(-2).join("/");
}

/** A Recent call's target, short: the last segment of a path or the first words of an action. */
export function recentTarget(r, max = 32) {
    const said = String(r?.action ?? "").trim();
    if (!said) return "";
    const base = said.split(/[\\/]+/).pop() ?? said;
    return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

/** The decision to show on a Recent row: nothing for the default allow, else the ask/deny (and a declined answer). */
export function recentDecision(r) {
    if (!r) return "";
    if (r.answer === "decline" || r.decision === "deny") return r.answer === "decline" ? "declined" : "denied";
    if (r.decision === "ask") return r.answer ? `asked · ${r.answer}` : "asked";
    return "";
}

/** A Recent row's full text for its tooltip: tool, target, decision/answer and outcome. */
export function recentTooltip(r) {
    let bits = [String(r?.tool ?? ""), String(r?.action ?? "")].filter(Boolean).join(" ");
    if (r?.decision) bits += ` · ${r.decision}${r.answer ? ` (${r.answer})` : ""}`;
    if (r?.outcome) bits += ` · ${r.outcome}`;
    return bits;
}

/** The note under the pull requests when their details could not be read, in proper English. */
export function detailsNote(count) {
    return count === 1 ? "Details unavailable for 1 pull request." : `Details unavailable for ${count} pull requests.`;
}

/** How many of the ticket's pull requests have no details yet (the workflow listed them, gh did not answer). */
export function missingDetails(workflowPrs, cached) {
    const known = (workflowPrs ?? []).map((p) => p.url).filter(Boolean);
    if (!cached?.at || known.length === 0) return 0;
    return known.filter((url) => !cached.details?.[url]).length;
}

export function splitOutputs(outputs) {
    const files = [];
    let inRepos = 0;
    for (const o of Array.isArray(outputs) ? outputs : []) {
        if (typeof o?.path !== "string") continue;
        if (typeof o.repo === "string" && o.repo !== "") inRepos += 1;
        else files.push(o);
    }
    return { files, inRepos };
}

// The dim line under the list: "3 files changed in repositories → Changes", or "" when none.
export function reposLine(count) {
    if (!(count > 0)) return "";
    return `${count} ${count === 1 ? "file" : "files"} changed in ${count === 1 ? "a repository" : "repositories"} → Changes`;
}

// A file's place in its repository, for the Review tab: { repo, name, file } or null when it is not in one.
export function reviewTarget(file, info) {
    const repo = info?.repo;
    if (!repo || !file.startsWith(`${repo}/`)) return null;
    return { repo, name: repo.split("/").pop(), file: file.slice(repo.length + 1) };
}

// "/a/b/c.md" as { dir: "/a/b/", name: "c.md" }.
export function splitPath(p) {
    const cut = p.lastIndexOf("/");
    return { dir: cut < 0 ? "" : p.slice(0, cut + 1), name: cut < 0 ? p : p.slice(cut + 1) };
}

// A folder's last part, for the header ("~" for the home folder).
export function folderName(cwd, home) {
    if (!cwd) return "?";
    if (home && cwd.replace(/\/+$/, "") === home.replace(/\/+$/, "")) return "~";
    return cwd.replace(/\/+$/, "").split("/").pop() || "/";
}

// "12:04:31" in this computer's time.
export function clock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

// What the panel says about a call's decision: "allowed", "asked · allowed", "asked · declined", "denied", or "".
export function decisionText(r) {
    if (r.decision === "deny") return "denied";
    if (r.decision === "ask") {
        if (r.answer === "decline") return "asked · declined";
        if (r.answer) return r.answer === "allow-session" ? "asked · for session" : "asked · allowed";
        return "asked";
    }
    return r.decision === "allow" ? "allowed" : "";
}

// Tokens as "12k", "1.2M".
export function short(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "?";
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return String(Math.round(n));
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
 * A mod that has no block (it lives in a pane or tab of its own) counts as on screen. */
export function isShown(root, mod) {
    const chain = chainTo(root, mod);
    if (!chain) return true;
    return chain.every((node, i) => {
        if (node.hidden) return false;
        if (node.type !== "stack") return true;
        return (node.active ?? node.children?.[0]?.id) === chain[i + 1]?.id;
    });
}
