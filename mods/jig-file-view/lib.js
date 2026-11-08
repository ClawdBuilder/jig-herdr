// Pure helpers of jig-file-view, kept apart from main.js so they can be tested outside Herdr: its config and the header's
// name/folder split (Windows and Unix paths), and whether a file starts wrapped.

import { refreshSeconds } from "./refresh.js";

export const DEFAULTS = { refreshSeconds: 60 };

/** config.json as { refreshSeconds, problems }. */
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

/** `splitPath("/a/b/c.ts")` -> { name: "c.ts", dir: "/a/b" }, for both separators. */
export function splitPath(path) {
    const said = String(path ?? ""),
        cut = Math.max(said.lastIndexOf("/"), said.lastIndexOf("\\"));
    return { name: said.slice(cut + 1), dir: cut > 0 ? said.slice(0, cut) : cut === 0 ? "/" : "" };
}

/** Whether a file starts soft-wrapped: markdown and plain text yes, code no, unless the person toggled it before. */
export function wrapDefault(path, stored) {
    if (stored === "on") return true;
    if (stored === "off") return false;
    const ext = (
        String(path ?? "")
            .split(".")
            .pop() ?? ""
    ).toLowerCase();
    return ["md", "markdown", "mdx", "txt", "log"].includes(ext);
}

/** Whether a file is markdown (rendered first, with a Source toggle). */
export const isMarkdown = (path) =>
    ["md", "markdown", "mdx"].includes(
        (
            String(path ?? "")
                .split(".")
                .pop() ?? ""
        ).toLowerCase(),
    );
