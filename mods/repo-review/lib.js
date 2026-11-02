// Pure helpers for the review tab, kept apart from main.js so they can be tested outside Herdr.
// Copied from repo-changes/lib.js (mods cannot import each other), cut down to one repo.

// Most changed files listed; a bigger change set is cut here.
export const CAP = 500;

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

// `git status --porcelain=v1 -b` output as { branch, ahead, behind, unborn, files, total }.
export function parseStatus(stdout) {
    const lines = stdout.split("\n").filter(Boolean);
    if (!lines.length || !lines[0].startsWith("## ")) throw new Error(lines[0] || "git status failed");
    const files = lines.slice(1).map(parseFile);
    return { ...parseBranch(lines[0]), files: files.slice(0, CAP), total: files.length };
}

// A file path as its folders (dimmed) and its name.
export function splitPath(path) {
    const parts = path.split("/"),
        name = parts.pop();
    return { dir: parts.length ? `${parts.join("/")}/` : "", name };
}

// Numbers each diff line once, so a frame only draws the rows on screen (as the shipped changes mod does).
export function diffRows(lines) {
    let old = 0,
        next = 0;
    return lines.map((line) => {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
        if (match) {
            old = +match[1];
            next = +match[2];
            return { kind: "@", text: line };
        }
        const kind = line[0];
        if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
        if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
        if (kind === " ") {
            old++;
            return { kind, number: next++, text: line.slice(1) || " " };
        }
        return { kind: "", text: line };
    });
}
