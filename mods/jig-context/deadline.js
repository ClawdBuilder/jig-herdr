// A deadline for a command the panels run on another machine: a hung `sh`, `git` or `gh` rejects instead of holding the
// panel's loading state (and its scheduler) forever. The reject message is what the panel shows as its error.
export const EXEC_DEADLINE_MS = 20_000;

export function withDeadline(promise, ms = EXEC_DEADLINE_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
