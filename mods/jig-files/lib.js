// Pure helpers of jig-files, kept apart from main.js so they can be tested outside Herdr: its config, the deleted paths
// that git status knows but the folder listing does not, and the flat filter over a bounded find.

import { refreshSeconds } from "./refresh.js";

export const DEFAULTS = { refreshSeconds: 60 };

/** config.json as { refreshSeconds, problems }. Images and order are not settings. */
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
    if (raw.refreshSeconds != null) {
        if (Number.isInteger(raw.refreshSeconds) && raw.refreshSeconds >= 15 && raw.refreshSeconds <= 86_400)
            config.refreshSeconds = raw.refreshSeconds;
        else config.problems.push('"refreshSeconds" must be a whole number from 15 to 86400');
    }
    return config;
}

/** Whether a mod's block is on screen: nothing hidden on the way down, every stack showing the right child. */
export function isShown(root, mod) {
    const chain = (node) => {
        if (!node) return null;
        if (node.content?.mod === mod) return [node];
        for (const child of node.children ?? []) {
            const rest = chain(child);
            if (rest) return [node, ...rest];
        }
        return null;
    };
    const path = chain(root);
    if (!path) return true;
    return path.every((node, i) => {
        if (node.hidden) return false;
        if (node.type !== "stack") return true;
        return (node.active ?? node.children?.[0]?.id) === path[i + 1]?.id;
    });
}

/** Run with `sh -c FIND sh <root>`: every file under root (no .git, no node_modules, six levels), one path per line. */
export const FIND = `find "$1" -mindepth 1 -maxdepth 6 \\( -name .git -o -name node_modules \\) -prune -o -type f -print 2>/dev/null | head -n 5000`;

/**
 * Deleted paths from `git status --porcelain=v1 -z --no-renames` in `root`: the entries whose worktree or index side is
 * D. The folder listing cannot show a file that is gone, so the panel adds these rows from git instead.
 */
export function deletedPaths(status, root) {
    const out = [];
    for (const entry of String(status ?? "").split("\0")) {
        if (entry.length < 4) continue;
        const xy = entry.slice(0, 2);
        if (!xy.includes("D")) continue;
        out.push(`${String(root).replace(/\/+$/, "")}/${entry.slice(3)}`);
    }
    return out;
}

/** File paths from FIND output that match `query` on their path, case aside, relative to root; at most `limit`. */
export function filterPaths(stdout, root, query, limit = 500) {
    const base = String(root ?? "").replace(/\/+$/, ""),
        wanted = String(query ?? "")
            .trim()
            .toLowerCase();
    if (!wanted) return [];
    const out = [];
    for (const line of String(stdout ?? "").split("\n")) {
        const path = line.trim();
        if (!path.startsWith(`${base}/`)) continue;
        const rel = path.slice(base.length + 1);
        if (!rel.toLowerCase().includes(wanted)) continue;
        out.push(rel);
        if (out.length >= limit) break;
    }
    return out;
}
