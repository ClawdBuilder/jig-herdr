// One refresh state for the panels' lists. An automatic refresh is silent: the rows stay and the controls do not change.
// A user-started refresh shows its busy state only after BUSY_AFTER_MS, so a quick read never blinks. A click while a
// refresh is running queues one more run instead of being dropped.
export const BUSY_AFTER_MS = 400;

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
