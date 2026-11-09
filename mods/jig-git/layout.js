// Whether a mod's block is on screen in the shown layout. A block that is hidden, or sits behind another child of a stack,
// is not. It is in its own file so the tests can load it outside Herdr; mods cannot import each other.

/** The chain of nodes from the layout's root down to the block that holds `mod`, or null when no block does. */
function chainTo(node, mod) {
    if (!node) return null;
    if (node.content?.mod === mod) return [node];
    for (const child of node.children ?? []) {
        const rest = chainTo(child, mod);
        if (rest) return [node, ...rest];
    }
    return null;
}

/** A mod with no block in the layout lives in a pane or tab of its own, which counts as on screen. */
export function shown(root, mod) {
    const chain = chainTo(root, mod);
    if (!chain) return true;
    return chain.every((node, i) => {
        if (node.hidden) return false;
        if (node.type !== "stack") return true;
        return (node.active ?? node.children?.[0]?.id) === chain[i + 1]?.id;
    });
}
