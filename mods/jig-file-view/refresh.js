// One refresh policy for the panels' lists. Automatic triggers debounce into one sweep; the backstop is a slow fallback
// (60 s, or refreshSeconds in config.json, never under 15 s). The busy state is silent for automatic runs and appears only
// after BUSY_AFTER_MS for a click, so a quick read never blinks.
export const BUSY_AFTER_MS = 400;
export const DEBOUNCE_MS = 500;
export const MIN_REFRESH_SECONDS = 15;
export const DEFAULT_REFRESH_SECONDS = 60;

/** Flags every read-only git command uses: no optional locks and no fsmonitor side effects. */
export const GIT_READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

/** Herdr 0.1.14 caps exec at 10 minutes; keep the shell below it and the outer deadline just after, so the shell's own
 *  timeout fires first and the result can say what happened. */
export function execBudget(timeoutMs) {
    const shellSeconds = Math.min(Math.max(1, Math.round((timeoutMs ?? 20_000) / 1000)), 595);
    const shellTimeoutMs = shellSeconds * 1000;
    return { shellSeconds, shellTimeoutMs, herdrTimeoutMs: Math.min(600_000, shellTimeoutMs + 5000) };
}

/** Quote one POSIX shell word. */
function quoteOne(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The shell wrapper: the caller's variables, then timeout/gtimeout, then the command. */
function runnerScript(env, seconds) {
    const exports = Object.entries({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...(env ?? {}) })
        .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .map(([key, value]) => `export ${key}=${quoteOne(value)}`)
        .join("; ");
    return `${exports}; if command -v timeout >/dev/null 2>&1; then exec timeout ${seconds} "$@"; elif command -v gtimeout >/dev/null 2>&1; then exec gtimeout ${seconds} "$@"; fi; exec "$@"`;
}

/** Run one command for a panel. Without env, git is run directly; with env, a shell wrapper supplies the variables and
 *  timeout/gtimeout. A timeout is returned as code 124 and every result carries the command name. */
export async function run(exec, cmd, args, { cwd, on, seconds = 20, env } = {}) {
    const budget = execBudget(seconds * 1000);
    const started = Date.now();
    if (!env) {
        try {
            const result = await exec(cmd, args, { cwd, on, timeout: budget.shellTimeoutMs });
            return { ...result, cmd, seconds: budget.shellSeconds, timedOut: result.code === 124 };
        } catch (error) {
            const message = String(error?.message ?? error);
            const elapsed = Date.now() - started;
            const timedOut = elapsed >= budget.shellTimeoutMs;
            return {
                code: timedOut
                    ? 124
                    : /could not (?:start|find)|not found|no such file|ENOENT|not installed/i.test(message)
                      ? 127
                      : 1,
                cmd,
                stdout: "",
                stderr: message,
                seconds: budget.shellSeconds,
                timedOut,
            };
        }
    }
    const script = runnerScript(env, budget.shellSeconds);
    try {
        const result = await exec("sh", ["-c", script, "sh", cmd, ...args], {
            cwd,
            on,
            timeout: budget.herdrTimeoutMs,
        });
        return { ...result, cmd, seconds: budget.shellSeconds, timedOut: result.code === 124 };
    } catch (error) {
        const message = String(error?.message ?? error);
        const timedOut = /tim(e|ed) out|timeout|took too long|abort|cancel/i.test(message);
        return {
            code: timedOut ? 124 : /spawn sh ENOENT|sh: (?:command )?not found/i.test(message) ? 127 : 1,
            cmd,
            stdout: "",
            stderr: message,
            seconds: budget.shellSeconds,
            timedOut,
        };
    }
}

/** Parse refreshSeconds from raw config JSON with a 15 s minimum and no maximum. */
export function parseRefreshConfig(raw, fallback = DEFAULT_REFRESH_SECONDS) {
    let value = raw;
    let problems = [];
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            value = parsed && typeof parsed === "object" ? parsed.refreshSeconds : undefined;
        } catch (error) {
            return {
                seconds: Math.max(MIN_REFRESH_SECONDS, fallback),
                problems: [`config.json is not valid JSON: ${error.message}`],
            };
        }
    } else if (raw && typeof raw === "object") value = raw.refreshSeconds;
    if (value === undefined || value === null) {
        return { seconds: Math.max(MIN_REFRESH_SECONDS, fallback), problems };
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
        problems = ['"refreshSeconds" must be a whole number'];
        return { seconds: Math.max(MIN_REFRESH_SECONDS, fallback), problems };
    }
    if (seconds < MIN_REFRESH_SECONDS) problems = ["refreshSeconds must be at least 15"];
    return { seconds: Math.max(MIN_REFRESH_SECONDS, seconds), problems };
}

/** `refreshSeconds` from a config object or number, clamped to at least 15 s. */
export function refreshSeconds(value, fallback = DEFAULT_REFRESH_SECONDS) {
    const wanted = typeof value === "object" && value !== null ? value.refreshSeconds : value;
    const seconds = Number(wanted);
    return Number.isFinite(seconds) ? Math.max(MIN_REFRESH_SECONDS, seconds) : Math.max(MIN_REFRESH_SECONDS, fallback);
}

export class RefreshState {
    constructor() {
        this.loading = false;
        this.busy = false;
        this.again = false;
        this.user = false;
        this.first = false;
        this.startedAt = 0;
    }

    /** Starts a run, or queues one when a user clicked during a run. `first` is a panel with no rows yet, which may show
     *  its loading state at once. Returns whether this call started the run. */
    start({ user = false, first = false } = {}) {
        if (this.loading) {
            if (user) this.again = true;
            return false;
        }
        this.loading = true;
        this.user = user;
        this.first = first;
        this.startedAt = Date.now();
        this.busy = first;
        return true;
    }

    /** Called from a panel's existing tick. A user-started run shows busy after BUSY_AFTER_MS; automatic runs never do. */
    tick(now = Date.now(), notify = () => {}) {
        if (!this.loading || !this.user || this.busy || this.first) return;
        if (now - this.startedAt < BUSY_AFTER_MS) return;
        this.busy = true;
        notify();
    }

    /** Ends a run and answers whether a user click queued one more. The caller starts that run; this helper never starts
     *  work on its own. */
    finish() {
        this.loading = false;
        this.busy = false;
        const again = this.again;
        this.again = false;
        return again;
    }
}

/** Event-driven timing: a trigger debounces for 500 ms, and a sweep resets the backstop. No other loop is needed. */
export class RefreshScheduler {
    constructor({ seconds = DEFAULT_REFRESH_SECONDS, now = Date.now } = {}) {
        this.now = now;
        this.seconds = refreshSeconds(seconds);
        this.pendingUntil = 0;
        this.backstopAt = now() + this.seconds * 1000;
    }

    /** A trigger inside the debounce window is covered by the same sweep. */
    trigger(at = this.now()) {
        this.pendingUntil ||= at + DEBOUNCE_MS;
    }

    /** True at the debounced trigger, or at the backstop when nothing has triggered. */
    due(at = this.now()) {
        return this.pendingUntil ? at >= this.pendingUntil : at >= this.backstopAt;
    }

    /** Whether this due time is the backstop rather than an event. */
    isBackstop(at = this.now()) {
        return !this.pendingUntil && at >= this.backstopAt;
    }

    /** A sweep started now: reset the backstop and forget a pending trigger. */
    sweep(at = this.now()) {
        this.pendingUntil = 0;
        this.backstopAt = at + this.seconds * 1000;
    }

    setSeconds(value, at = this.now()) {
        const seconds = refreshSeconds(value, this.seconds);
        if (seconds === this.seconds) return;
        this.seconds = seconds;
        this.backstopAt = at + seconds * 1000;
        if (this.pendingUntil) this.pendingUntil = Math.min(this.pendingUntil, at + DEBOUNCE_MS);
    }
}

/** One sentence for a failed git/gh read. `follow` adds the folder-panel switch hint. */
export function friendlyError(result, { what = "Reading", follow = false } = {}) {
    const text = String(result?.stderr ?? result?.stdout ?? result?.message ?? result ?? "").trim();
    const first = text.split("\n").find(Boolean) ?? "";
    const seconds = Number(result?.seconds) || 20;
    const cmd = result?.cmd;
    if (result?.timedOut || result?.code === 124)
        return `${what} took too long and was stopped (${seconds} s). Check the connection, or try in a terminal.`;
    if (result?.code === 127 && cmd === "git") return "git isn't installed on this machine.";
    if (result?.code === 127 && cmd === "gh")
        return "The GitHub CLI (gh) isn't installed here. Install it, then run gh auth login.";
    if (result?.code === 127 && cmd) return `${cmd} isn't installed on this machine.`;
    if (/not a git repository|not a git repo/i.test(text))
        return follow
            ? "No git repo in this folder. Open a terminal in one, or switch to Space."
            : "No git repo in this folder.";
    if (cmd === "gh" && /gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(text))
        return "gh is not logged in on this machine (run gh auth login).";
    if (cmd === "git" && /authentication|HTTP 401|bad credentials/i.test(text))
        return "Sign-in to the remote failed. Check your credentials in a terminal.";
    if (cmd === "gh" && /rate limit/i.test(text)) return "GitHub rate limit reached; try again later.";
    if (
        /could not resolve host|dial tcp|timed out|timeout|network is unreachable|connection (refused|reset)|TLS handshake/i.test(
            text,
        )
    )
        return `Network error: ${first}`;
    return first;
}

/** Whether `path` is the folder `root` or inside it. */
export function insideFolder(path, root) {
    if (typeof path !== "string" || typeof root !== "string" || root === "") return false;
    const base = root.replace(/\/+$/, "");
    return path === base || path.startsWith(`${base}/`);
}

/** Whether a terminal inside `root` went from working to idle or done since the previous reading. */
export function terminalFinished(previous, current, root) {
    if (!Array.isArray(previous) || !Array.isArray(current)) return false;
    const before = new Map(previous.map((terminal) => [terminal.address, terminal.status]));
    return current.some(
        (terminal) =>
            insideFolder(terminal.cwd, root) &&
            before.get(terminal.address) === "working" &&
            (terminal.status === "idle" || terminal.status === "done"),
    );
}

/** The window going from inactive to active is a focus trigger. */
export function focusRegained(previous, active) {
    return previous === false && active === true;
}
