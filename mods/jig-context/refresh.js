// One refresh policy for the panels' lists. Automatic triggers debounce into one sweep; the backstop is a slow fallback
// (60 s, or refreshSeconds in config.json, never under 15 s). The busy state is silent for automatic runs and appears only
// after BUSY_AFTER_MS for a click, so a quick read never blinks.
export const BUSY_AFTER_MS = 400;
export const DEBOUNCE_MS = 500;
export const MIN_REFRESH_SECONDS = 15;
export const DEFAULT_REFRESH_SECONDS = 60;

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
        this.timer = undefined;
    }

    /** Starts a run, or queues one when a user clicked during a run. `first` is a panel with no rows yet, which may show
     *  its loading state at once. Returns whether this call started the run. */
    start({ user = false, first = false, notify = () => {} } = {}) {
        if (this.loading) {
            if (user) this.again = true;
            return false;
        }
        this.loading = true;
        this.busy = first;
        if (user && !first) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                if (!this.loading) return;
                this.busy = true;
                notify();
            }, BUSY_AFTER_MS);
        }
        return true;
    }

    /** Ends a run and answers whether a user click queued one more. The caller starts that run; this helper never starts
     *  work on its own. */
    finish() {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
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
