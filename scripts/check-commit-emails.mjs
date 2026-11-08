// Fails when an author or committer email in the checked range contains a word from the private scan list. Without that
// list (as in public CI) it skips: the list is never in this repository.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const wordFile = process.env.JIG_SCAN_WORDS || path.join(homedir(), ".config", "jig", "scan-words.txt");
let words = [];
try {
    words = readFileSync(wordFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
} catch {
    console.log("commit emails: skipped (no private word list)");
    process.exit(0);
}
if (words.length === 0) {
    console.log("commit emails: skipped (empty private word list)");
    process.exit(0);
}
const range =
    process.env.JIG_COMMIT_RANGE ||
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}..HEAD` : "origin/main..HEAD");
let output;
try {
    output = execFileSync("git", ["log", "--format=%H%x1f%ae%x1f%ce", range], { encoding: "utf8" });
} catch {
    console.log(`commit emails: skipped (range ${range} is unavailable)`);
    process.exit(0);
}
const blocked = new RegExp(
    `\\b(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "i",
);
let bad = 0;
for (const line of output.split("\n")) {
    if (!line) continue;
    const [sha, author, committer] = line.split("\x1f");
    for (const [kind, email] of [
        ["author", author],
        ["committer", committer],
    ]) {
        if (blocked.test(email ?? "")) {
            console.log(`${sha?.slice(0, 12)} ${kind} email matches the private list`);
            bad++;
        }
    }
}
if (bad > 0) {
    console.log(`commit emails: ${bad} match(es) in ${range}`);
    process.exit(1);
}
console.log(`commit emails: clean in ${range}`);
