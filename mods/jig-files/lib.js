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

/** The POSIX listing script: one NUL-separated kind/name pair per entry, `.git` skipped, 500 entries at most. */
export const LIST_SCRIPT = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"`;

/** Parse LIST_SCRIPT output as [{ name, dir }] (the order is the folder's). */
export function parseDirectory(stdout) {
    const fields = String(stdout ?? "").split("\0"),
        out = [];
    for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
    return out;
}

/**
 * List a folder through `run(cmd, args, opts)`. The runner is passed in: a module function has no view, and calling
 * `view.exec` as `this.exec` was the Step 4 blocker. On Windows without a machine, PowerShell lists it; elsewhere the
 * POSIX script runs on `on`.
 */
export async function listDirectory(path, on, run, platform = null) {
    if (!on && platform === "windows") {
        const r = await run("powershell", [
            "-NoProfile",
            "-Command",
            "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" +
                path.replaceAll("'", "''") +
                "'",
        ]);
        if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
        const result = JSON.parse(r.stdout || "[]");
        return Array.isArray(result) ? result : [result];
    }
    const r = await run("sh", ["-c", LIST_SCRIPT, "files", path], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    return parseDirectory(r.stdout);
}

/** Run with `sh -c FIND sh <root>`: every file under root (no .git, no node_modules, six levels), one path per line. */
export const FIND = `if command -v timeout >/dev/null 2>&1; then F="timeout 10 find"; elif command -v gtimeout >/dev/null 2>&1; then F="gtimeout 10 find"; else F=find; fi; $F "$1" -mindepth 1 -maxdepth 6 \\( -name .git -o -name node_modules \\) -prune -o -type f -print 2>/dev/null | head -n 5000`;

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

/** Whether a filter search should start now: one per filter change, 500 ms after the last keystroke, never per tick. */
export function searchDue({ filter, dirty, loading, at, now, debounce = 500 }) {
    return Boolean(String(filter ?? "").trim()) && Boolean(dirty) && !loading && (!at || now - at >= debounce);
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
