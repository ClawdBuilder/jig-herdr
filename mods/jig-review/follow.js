// Shared by every repo panel: which folder to show. `jig-git` owns the rule; the others import this rather than copy it.
// Follow the focused terminal by default, or the space's folder when the header says Space. The choice is per space.
import { focused, panes, spaces } from "herdr";

import { pickRoot } from "./follow-state.js";

export function location(follow) {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const on =
        f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
    const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
    const first = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const root = pickRoot({
        follow,
        focusedCwd: pane?.cwd || f?.cwd || null,
        spaceFolder: space?.folder || null,
        first,
    });
    return { root, on, space: space?.id, follow };
}

export { readFollow, writeFollow } from "./follow-state.js";
