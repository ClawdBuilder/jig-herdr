// Pure helpers of jig-activity, kept apart from main.js so they can be tested outside Herdr.

// The node with this id, or null.
export function find(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children ?? []) {
        const n = find(c, id);
        if (n) return n;
    }
    return null;
}

// The buttons of a stack: one per child block that has a mod and whose mod is installed.
// `present` maps a mod name to true or false once known; a mod not asked about yet counts as installed.
// Each child says how to draw its button in content.props.activity: { icon: "<svg path>", end: true, divider: true }.
// (Herdr keeps a node's own fields it knows and drops the rest, but it keeps a mod's props whole.)
// A child with "end": true goes below the others, at the bottom of the bar; "divider": true draws a line after its button.
export function buttons(stack, present = new Map()) {
    const tabs = stack?.children ?? [];
    const active = stack?.active ?? tabs[0]?.id;
    return tabs
        .filter((c) => c.content?.mod && present.get(c.content.mod) !== false)
        .map((c) => {
            const look = c.content.props?.activity ?? {};
            return {
                id: c.id,
                mod: c.content.mod,
                title: c.title ?? c.id,
                icon: typeof look.icon === "string" ? look.icon : null,
                end: look.end === true,
                divider: look.divider === true,
                active: c.id === active,
            };
        });
}

// The letter shown when a child has no icon.
export function initial(title) {
    return (title.trim()[0] ?? "?").toUpperCase();
}
