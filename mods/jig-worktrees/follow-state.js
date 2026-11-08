// The per-space Terminal/Space choice, kept apart from the herdr calls so it can be unit-tested without the app.
export function readFollow(spaceId) {
    try {
        return localStorage.getItem(`follow.${spaceId ?? "none"}`) !== "space";
    } catch {
        return true;
    }
}

export function writeFollow(spaceId, follow) {
    try {
        localStorage.setItem(`follow.${spaceId ?? "none"}`, follow ? "terminal" : "space");
    } catch {
        // storage full or unavailable: the panel just starts in Terminal next time
    }
}

/** Follow the focused terminal by default, the space's folder when not. */
export function pickRoot({ follow, focusedCwd, spaceFolder, first }) {
    if (follow) return focusedCwd || spaceFolder || first || null;
    return spaceFolder || first || focusedCwd || null;
}

/** The toggle handler: write the choice, then reload. */
export function followReload(follow, spaceId, write, reload) {
    write(spaceId, !follow);
    reload();
    return !follow;
}
