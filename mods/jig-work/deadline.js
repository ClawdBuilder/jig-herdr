// A deadline for a command the panels run on another machine: a hung `sh`, `git` or `gh` rejects instead of holding the
// panel's loading state (and its scheduler) forever. The shell has no setTimeout/clearTimeout; callers pass Herdr's timer
// (`(ms, fn) => cx.timer.after(ms, fn)`), whose Task is cancelled when the command answers first.
export const EXEC_DEADLINE_MS = 20_000;
export function withDeadline(promise, timer, ms = EXEC_DEADLINE_MS) {
    return new Promise((resolve, reject) => {
        let done = false,
            task;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            task?.cancel?.();
            fn(value);
        };
        task = timer(ms, () => finish(reject, new Error(`timed out after ${Math.round(ms / 1000)} s`)));
        Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error),
        );
    });
}
