// Shared look for the jig panels. Pure: no module state, no timers, no host calls, no stored `cx`.
// Patterns adapted from runkids/skillshare (MIT); see NOTICE.
import { h_flex, v_flex } from "gpui-base";
import { div, svg } from "gpui-kit";
import { settings } from "herdr";

/** Herdr's UI font size, zoomed with the window; call during render. */
export const sizes = () => {
    const b = Number(settings().ui_font_size) || 13;
    return { title: b + 1, body: b + 0.5, secondary: b - 0.5, label: b - 1, button: b - 0.5 };
};
const size = () => sizes();

export const dot = (color, hollow = false) =>
    hollow
        ? div().w(8).h(8).flex_none().rounded_full().border(1.5).border_color(color)
        : div().w(8).h(8).flex_none().rounded_full().bg(color);

const stop = (_e, cx) => cx.stop_propagation();

function button(
    t,
    id,
    label,
    onClick,
    { primary = false, danger = false, busy = false, disabled = false, h = 28 } = {},
) {
    return h_flex()
        .id(id)
        .h(h)
        .px(12)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(6)
        .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold())
        .when(!primary && !danger, (el) => el.border_1().border_color(t.border).text_color(t.foreground))
        .when(danger, (el) => el.text_color(t.ansi1))
        .when(busy || disabled, (el) => el.text_color(t.dim).opacity(0.55))
        .text_size(size().button)
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover))))
        .on_mouse_down("left", stop)
        .when(!busy && !disabled, (el) => el.on_click(onClick))
        .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(13).spin(900)))
        .child(label);
}

export const primaryButton = (t, id, label, onClick, opts = {}) =>
    button(t, id, label, onClick, { ...opts, primary: true });
export const secondaryButton = (t, id, label, onClick, opts = {}) => button(t, id, label, onClick, opts);
export const dangerButton = (t, id, label, onClick, opts = {}) =>
    button(t, id, label, onClick, { ...opts, danger: true });
export const busyButton = (t, id, label) => button(t, id, label, () => {}, { busy: true });

export const pill = (text, t) =>
    h_flex()
        .h(20)
        .px(8)
        .flex_none()
        .items_center()
        .rounded(10)
        .bg(t.selected)
        .text_size(size().label)
        .text_color(t.muted)
        .child(text);

export function segmented(t, id, options, value, onPick) {
    return h_flex()
        .id(id)
        .w_full()
        .p(2)
        .gap(2)
        .rounded(8)
        .bg(t.chrome)
        .border_1()
        .border_color(t.border)
        .children(
            options.map(([key, label]) => {
                const on = key === value;
                return h_flex()
                    .id(`${id}-${key}`)
                    .flex_1()
                    .min_w(0)
                    .h(26)
                    .justify_center()
                    .items_center()
                    .rounded(6)
                    .bg(on ? t.raised : t.chrome)
                    .text_size(size().secondary)
                    .text_color(on ? t.foreground : t.muted)
                    .when(on, (el) => el.font_semibold())
                    .cursor_pointer()
                    .hover((s) => s.text_color(t.foreground))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => onPick(key, cx))
                    .child(div().truncate().child(label));
            }),
        );
}

/** A foldable group stays open when it is the only group with rows. */
export function groupOpen(open, groupCount) {
    return groupCount <= 1 || open;
}

export function groupHeader(t, id, label, count, color, action) {
    return h_flex()
        .id(`group-${id}`)
        .min_h(28)
        .flex_none()
        .px(14)
        .pt(10)
        .pb(4)
        .gap(8)
        .items_center()
        .child(div().flex_1().text_size(size().label).font_semibold().text_color(color).child(`${label} · ${count}`))
        .when(Boolean(action), (el) => el.child(action));
}

export function row(t, { id, color, title, detail, chips = [], open = false, active = false, onToggle, details }) {
    const head = h_flex()
        .id(`row-${id}`)
        .min_h(48)
        .px(10)
        .py(6)
        .gap(10)
        .items_center()
        .rounded(8)
        .when(active, (el) => el.bg(t.raised).border_l(2).border_color(t.accent))
        .cursor_pointer()
        .when(!open, (el) => el.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => onToggle(cx))
        .child(dot(color))
        .child(
            v_flex()
                .flex_1()
                .min_w(0)
                .child(
                    h_flex()
                        .gap(6)
                        .items_center()
                        .child(div().min_w(0).truncate().text_size(size().body).font_medium().child(title))
                        .children(chips),
                )
                .when(Boolean(detail), (el) =>
                    el.child(div().truncate().text_size(size().secondary).text_color(t.muted).child(detail)),
                ),
        )
        .child(
            svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`)
                .size(14)
                .flex_none()
                .text_color(t.muted),
        );
    if (!open) return div().mx(8).child(head);
    return v_flex()
        .mx(8)
        .rounded(8)
        .bg(t.raised)
        .child(head)
        .when(Boolean(details), (el) => el.child(details));
}

export function contextCard(t, { name, follow, onFollow, machine }) {
    return h_flex()
        .id("panel-context")
        .h(32)
        .flex_none()
        .px(12)
        .gap(7)
        .items_center()
        .text_size(size().secondary)
        .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().font_semibold().child(name))
        .child(
            div()
                .id("panel-follow")
                .flex_none()
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                    cx.stop_propagation();
                    onFollow(cx);
                })
                .child(follow ? "follows the focused terminal" : "uses the space's folder"),
        )
        .when(Boolean(machine), (el) => el.child(div().flex_1().justify_end().child(pill(machine, t))));
}

export function footer(t, { summary, color, action }) {
    return h_flex()
        .id("panel-footer")
        .h(40)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .border_t(1)
        .border_color(t.border)
        .child(
            div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(size().secondary)
                .text_color(color ?? t.muted)
                .child(summary),
        )
        .when(Boolean(action), (el) => el.child(action));
}

/** Four 48 px placeholder rows with the same two-line shape as a real row; no text and no timers. */
export function skeleton(t, rows = 4) {
    return v_flex()
        .id("panel-skeleton")
        .flex_none()
        .gap(2)
        .p(8)
        .children(
            Array.from({ length: rows }, () =>
                h_flex()
                    .h(48)
                    .px(10)
                    .gap(10)
                    .items_center()
                    .rounded(8)
                    .bg(t.chrome)
                    .child(div().w(8).h(8).flex_none().rounded_full().bg(t.raised))
                    .child(
                        v_flex()
                            .flex_1()
                            .gap(6)
                            .child(div().h(10).w(150).rounded(4).bg(t.raised))
                            .child(div().h(8).w(220).rounded(4).bg(t.raised)),
                    ),
            ),
        );
}

export const emptyLine = (text, t) => div().px(14).py(8).text_size(size().secondary).text_color(t.muted).child(text);

export function statusLine(t, state) {
    if (!state) return null;
    return h_flex()
        .id("panel-status")
        .h(34)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .text_size(size().secondary)
        .text_color(state.tone === "error" ? t.ansi1 : state.tone === "done" ? t.done : t.muted)
        .child(
            state.tone === "working"
                ? svg("mods/workspace-chrome/spinner.svg").size(13).spin(900)
                : dot(state.tone === "error" ? t.ansi1 : t.done),
        )
        .child(div().flex_1().min_w(0).truncate().child(state.text));
}

/** Pure active-row movement for the list keyboard handler. */
export function moveActive(ids, active, delta) {
    if (!ids.length) return null;
    const at = ids.indexOf(active);
    if (at < 0) return ids[delta < 0 ? ids.length - 1 : 0];
    return ids[(at + delta + ids.length) % ids.length];
}
