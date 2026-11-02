// Is a mod's block on screen in the shown layout? A block hidden, or behind another child of a
// stack, is not. Kept in its own file so it can be tested outside Herdr; mods cannot import each other.

// The nodes from the root down to the first that passes test, or null.
export function pathTo(node, test) {
    if (!node) return null;
    if (test(node)) return [node];
    for (const c of node.children ?? []) {
        const p = pathTo(c, test);
        if (p) return [node, ...p];
    }
    return null;
}

// A mod with no block in the layout is in a pane or tab of its own, so it counts as shown.
export function shown(root, mod) {
    const path = pathTo(root, (n) => n.content?.mod === mod);
    return (
        !path ||
        path.every((n, i) => !n.hidden && (n.type !== "stack" || (n.active ?? n.children?.[0]?.id) === path[i + 1]?.id))
    );
}
