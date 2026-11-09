// The one header and error line for the git panels. Pure: no module state, no timers, no host calls, no stored `cx`.
// Every copy is byte-identical (the copy guard checks it) and must be imported by its mod's main.js.
import { h_flex } from "gpui-base";
import { div, svg } from "gpui-kit";
import { readAgo } from "./refresh.js";

export const HEADER_HEIGHT = 42;
export const ROW_HEIGHT = 24;
export const ROW_FONT = 11.5;
export const META_FONT = 10.5;
export const MAX_PATH_WIDTH = 220;
export const MAX_BRANCH_WIDTH = 180;

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

/** The follow switch: same widget and place in Repos, History, PR & CI and Worktrees. */
function followSwitch(t, follow, onFollow) {
    return h_flex()
        .id("panel-follow")
        .flex_none()
        .h(22)
        .px(6)
        .gap(5)
        .items_center()
        .rounded(6)
        .border_1()
        .border_color(t.border)
        .when(follow, (el) => el.bg(t.raised))
        .text_size(META_FONT)
        .text_color(follow ? t.foreground : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(
            follow
                ? "Following the focused terminal — click to use the space's folder instead"
                : "Using the space's folder — click to follow the focused terminal",
        )
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
            cx.stop_propagation();
            onFollow(cx);
        })
        .child(
            svg(ICON(follow ? "terminal" : "folder"))
                .size(12)
                .flex_none()
                .text_color(follow ? t.accent : t.muted),
        )
        .child(div().child(follow ? "Terminal" : "Space"));
}

function refreshButton(t, busy, readAt, onRefresh, icon) {
    const tip = busy ? "Reading…" : readAt > 0 ? `Refresh · read ${readAgo(Date.now(), readAt)} ago` : "Refresh";
    return div()
        .id("panel-refresh")
        .flex_none()
        .w(22)
        .h(20)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(busy ? t.dim : t.muted)
        .when(busy, (el) => el.opacity(0.45))
        .when(!busy, (el) =>
            el
                .cursor_pointer()
                .hover((s) => s.bg(t.raised).text_color(t.foreground))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => {
                    cx.stop_propagation();
                    onRefresh(cx);
                }),
        )
        .tooltip(tip)
        .child(svg(icon).size(13));
}

/** The header row. `title` flexes; `extra` sits after it; then follow and Refresh. */
export function panelHeader(t, options) {
    const {
        title,
        titleTooltip,
        lead,
        extra = [],
        follow,
        onFollow,
        readAt = 0,
        busy = false,
        onRefresh,
        onTitleClick,
        refreshIcon,
    } = options;
    return h_flex()
        .id("panel-header")
        .h(HEADER_HEIGHT)
        .flex_none()
        .px(12)
        .gap(7)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .child(
            lead !== undefined
                ? div().flex_1().min_w(0).child(lead)
                : div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .font_semibold()
                      .tooltip(titleTooltip ?? title)
                      .when(onTitleClick !== undefined, (el) =>
                          el
                              .cursor_pointer()
                              .hover((style) => style.text_color(t.accent))
                              .on_click((_e, cx) => onTitleClick(cx)),
                      )
                      .child(title),
        )
        .children(extra.map((child) => div().flex_none().child(child)))
        .when(follow !== undefined, (el) => el.child(followSwitch(t, follow, onFollow)))
        .when(onRefresh !== undefined, (el) => el.child(refreshButton(t, busy, readAt, onRefresh, refreshIcon)));
}

/** The one error line: under the header, above the kept rows. */
export function panelError(t, message) {
    if (!message) return null;
    return div()
        .flex_none()
        .px(12)
        .py(4)
        .truncate()
        .text_size(11)
        .text_color(t.blocked)
        .tooltip(message)
        .child(message);
}
